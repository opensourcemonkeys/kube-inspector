// Package logging is the process-wide log sink: one logstash json_event line
// per record, appended to a daily file shared by every kube-ins process under
// ~/.kube-ins/logs.
//
// Three rules govern this package, and all three are load-bearing.
//
//  1. It imports only the standard library. safego -> logging is the single
//     intra-project edge pointing here, and every other layer (business,
//     repository, ipc, controller, tui, main) depends on it. Any kube-ins
//     import risks a cycle back through safego.
//
//  2. Nothing here ever writes to os.Stdout. Stdout is a private pipe to the
//     Electron shell carrying the RPC URL and the shell token (see main.go);
//     one stray byte there desynchronises the handshake and the app never
//     starts. The optional development tee goes to stderr, and is forced off
//     for the CLI role because the terminal UI owns the screen.
//
//  3. It never calls slog.SetDefault. That is precisely the mechanism by which
//     Trivy's pkg/log init() silently swallowed every log.Print in this binary:
//     since Go 1.21 slog.SetDefault also reroutes the standard log package
//     through the default handler. We own a *slog.Logger instead and hand the
//     standard logger an explicit io.Writer (see StdlibWriter).
//
// Record shape (logstash json_event v1):
//
//	{"@timestamp":"2026-08-08T14:03:11.482Z","@version":"1","level":"ERROR",
//	 "message":"list pods failed","logger":"business.pod",
//	 "fields":{"service":"kube-inspector","version":"0.16.0","role":"backend",
//	           "pid":48213,"cluster":"prod","err":"..."}}
//
// Every caller-supplied attribute lands inside "fields"; the five top-level
// keys are reserved and cannot be overwritten from a call site.
package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Roles. fields.role is the only way to tell three concurrently appending
// processes apart in a shared file.
const (
	RoleBackend = "backend" // GUI sidecar, `--serve`, and the Wails window
	RoleCLI     = "cli"     // `--tui` and cmd/tui
	RoleShell   = "shell"   // written by electron/logfile.cjs, never by Go
)

const (
	serviceName      = "kube-inspector"
	jsonEventVersion = "1"
	fieldsGroup      = "fields"

	// timeLayout renders UTC with exactly three fractional digits and a
	// trailing Z, byte-identical to JavaScript's Date.toISOString() so the Go
	// and Node writers produce the same shape in the same file.
	timeLayout = "2006-01-02T15:04:05.000Z07:00"

	levelFile = ".level"

	envLogDir    = "KUBE_INS_LOG_DIR"
	envLogLevel  = "KUBE_INS_LOG_LEVEL"
	envLogStderr = "KUBE_INS_LOG_STDERR"
)

// state is swapped in atomically by Init so L() and With() stay lock-free.
type state struct {
	base  slog.Handler
	fixed []any // service/version/role/pid, bound inside the "fields" group
}

var (
	lvl = new(slog.LevelVar)

	st    atomic.Pointer[state]
	root  atomic.Pointer[slog.Logger]
	named sync.Map // string -> *slog.Logger

	writer atomic.Pointer[dayWriter]

	initOnce sync.Once
	initErr  error
)

func init() {
	// Before Init, every call is a real no-op: DiscardHandler reports
	// Enabled() == false for all levels, so arguments are not even evaluated.
	root.Store(slog.New(slog.DiscardHandler))
}

// Init opens ~/.kube-ins/logs/kube-inspector-<local date>.log and installs the
// process logger. role is one of the Role* constants; version is the app
// version reported in fields.version.
//
// It is idempotent: a second call returns the first call's result unchanged.
func Init(role, version string) error {
	initOnce.Do(func() { initErr = doInit(role, version) })
	return initErr
}

func doInit(role, version string) error {
	dir, err := Dir()
	if err != nil {
		return err
	}

	lvl.Set(initialLevel(dir))

	w, err := newDayWriter(dir, time.Now)
	if err != nil {
		return err
	}
	writer.Store(w)

	var out io.Writer = w
	// Development tee. Never stdout — that is the Electron protocol pipe — and
	// never for the CLI role, whose tview screen a stray line corrupts. The
	// guard lives here rather than at the three call sites so that no caller
	// can get it wrong.
	if role != RoleCLI && (devTeeStderr || os.Getenv(envLogStderr) == "1") {
		out = io.MultiWriter(w, os.Stderr)
	}

	s := &state{
		base: slog.NewJSONHandler(out, &slog.HandlerOptions{
			Level:       lvl,
			ReplaceAttr: replaceAttr,
		}),
		fixed: []any{
			slog.String("service", serviceName),
			slog.String("version", version),
			slog.String("role", role),
			slog.Int("pid", os.Getpid()),
		},
	}
	st.Store(s)
	root.Store(loggerFor(s, ""))

	sweepAsync(dir, time.Now())
	With("logging").Info("logger started", "level", Level(), "file", w.Path())
	return nil
}

// L is the process logger. It is never nil; before Init it discards everything.
//
// Note that L() already has the "fields" group open, so L().With("logger", x)
// produces fields.logger, not a top-level logger name. Use With(name) instead.
func L() *slog.Logger { return root.Load() }

// With returns the process logger bound to a top-level "logger" name, e.g.
// "business.pod" or "ipc.hub". Loggers are cached per name.
//
// Call it at the log site, not in a package-level var: a package var is
// initialised before Init runs and would capture the discard logger forever.
func With(name string) *slog.Logger {
	if name == "" {
		return L()
	}
	if v, ok := named.Load(name); ok {
		return v.(*slog.Logger)
	}
	s := st.Load()
	if s == nil {
		// Init has not run. Return the discard logger without caching it, so
		// the name binds for real once Init lands.
		return L()
	}
	actual, _ := named.LoadOrStore(name, loggerFor(s, name))
	return actual.(*slog.Logger)
}

// loggerFor is the one place that knows the layering order, and the order is
// what produces the json_event shape:
//
//   - "@version" and "logger" are bound BEFORE the group, so they preformat at
//     the top level;
//   - WithGroup("fields") then opens the group, so the fixed attrs and every
//     subsequent caller attr nest inside it.
//
// Because the fixed attrs are always present, "fields" can never be elided as
// an empty group.
func loggerFor(s *state, name string) *slog.Logger {
	l := slog.New(s.base).With(slog.String("@version", jsonEventVersion))
	if name != "" {
		l = l.With(slog.String("logger", name))
	}
	return l.WithGroup(fieldsGroup).With(s.fixed...)
}

// replaceAttr renames slog's built-ins to the json_event keys.
//
// The len(groups) != 0 guard is the whole trick: slog emits the built-ins
// before it opens any group and calls ReplaceAttr for them with a nil group
// path, while every caller attribute arrives inside "fields". So the guard is
// an exact discriminator, and a caller attribute literally named "level" or
// "msg" cannot reach — let alone overwrite — the top-level key.
func replaceAttr(groups []string, a slog.Attr) slog.Attr {
	if len(groups) != 0 {
		return a
	}
	switch a.Key {
	case slog.TimeKey:
		if t, ok := a.Value.Any().(time.Time); ok {
			return slog.String("@timestamp", t.UTC().Format(timeLayout))
		}
	case slog.LevelKey:
		if l, ok := a.Value.Any().(slog.Level); ok {
			return slog.String("level", levelName(l))
		}
	case slog.MessageKey:
		return slog.String("message", a.Value.String())
	case slog.SourceKey:
		return slog.Attr{}
	}
	return a
}

// levelName pins the four json_event level strings. slog.Level.String() is not
// usable here: it renders non-canonical levels as "INFO+2".
func levelName(l slog.Level) string {
	switch {
	case l < slog.LevelInfo:
		return "DEBUG"
	case l < slog.LevelWarn:
		return "INFO"
	case l < slog.LevelError:
		return "WARN"
	default:
		return "ERROR"
	}
}

func parseLevel(s string) (slog.Level, error) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "DEBUG":
		return slog.LevelDebug, nil
	case "INFO":
		return slog.LevelInfo, nil
	case "WARN", "WARNING":
		return slog.LevelWarn, nil
	case "ERROR":
		return slog.LevelError, nil
	}
	return slog.LevelInfo, fmt.Errorf("unknown log level %q", s)
}

// levelRank orders the four levels for filtering. An empty name means "no
// floor" and ranks below DEBUG.
func levelRank(name string) int {
	switch strings.ToUpper(strings.TrimSpace(name)) {
	case "DEBUG":
		return 1
	case "INFO":
		return 2
	case "WARN", "WARNING":
		return 3
	case "ERROR":
		return 4
	default:
		return 0
	}
}

// initialLevel resolves the starting level: the environment wins so a support
// session can raise it without touching state, then the level the user last
// picked in the Diagnostics panel, then INFO.
func initialLevel(dir string) slog.Level {
	if v := os.Getenv(envLogLevel); v != "" {
		if l, err := parseLevel(v); err == nil {
			return l
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, levelFile)); err == nil {
		if l, err := parseLevel(string(b)); err == nil {
			return l
		}
	}
	return slog.LevelInfo
}

// SetLevel changes the level of every bound logger immediately — the handler
// holds a *slog.LevelVar, so nothing is rebuilt — and persists the choice so
// processes started later inherit it.
//
// It affects this process only. Windows of one Electron process share a
// sidecar and therefore a level; a second instance does not.
func SetLevel(level string) error {
	l, err := parseLevel(level)
	if err != nil {
		return err
	}
	lvl.Set(l)
	if dir, derr := Dir(); derr == nil {
		_ = os.WriteFile(filepath.Join(dir, levelFile), []byte(levelName(l)), 0600)
	}
	With("logging").Info("log level changed", "level", levelName(l))
	return nil
}

// Level reports the current level as one of DEBUG/INFO/WARN/ERROR.
func Level() string { return levelName(lvl.Level()) }

// Dir returns ~/.kube-ins/logs, creating it 0700 to match the rest of
// ~/.kube-ins. KUBE_INS_LOG_DIR overrides it; that is a test hook, not a
// supported configuration.
//
// The Clean below is normalisation, not a security boundary, and gosec's G703
// taint warning here is noise: the value comes from this process's own
// environment, so anyone who can set it can already run code as this user. It
// is deliberately not validated any further (an absolute-path requirement, say)
// because electron/logfile.cjs reads the same variable and the two must agree
// on what it means.
func Dir() (string, error) {
	if d := os.Getenv(envLogDir); d != "" {
		d = filepath.Clean(d)
		if err := os.MkdirAll(d, 0700); err != nil { //nolint:gosec // G703: see above
			return "", err
		}
		return d, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".kube-ins", "logs")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}

// Files lists the day files currently on disk, newest first.
func Files() ([]string, error) {
	dir, err := Dir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if _, ok := parseDayFileName(e.Name()); ok {
			names = append(names, filepath.Join(dir, e.Name()))
		}
	}
	// Names embed an ISO date, so a reverse lexical sort is newest-first.
	for i, j := 0, len(names)-1; i < j; i, j = i+1, j-1 {
		names[i], names[j] = names[j], names[i]
	}
	return names, nil
}

// CurrentFile is the path records are being appended to right now.
func CurrentFile() (string, error) {
	if w := writer.Load(); w != nil {
		return w.Path(), nil
	}
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, dayFileName(time.Now())), nil
}

// Close releases the log file. Durability does not depend on it: nothing is
// buffered, so every record has already reached the kernel by the time it
// returns. That is why the os.Exit(1) paths in main.go are safe to leave alone.
func Close() error {
	// Wait for the retention sweep Init started. It touches .retention in the
	// log directory when it finishes, so without this the directory keeps
	// changing after Close returned — which is how an arbitrary test in this
	// package kept failing with "TempDir RemoveAll cleanup: directory not
	// empty": t.TempDir()'s removal raced the marker write. Waiting first also
	// means a sweep's own Debug line lands before the writer shuts.
	sweepWG.Wait()
	if w := writer.Load(); w != nil {
		return w.Close()
	}
	return nil
}
