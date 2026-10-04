package services_k8sclient

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"

	"kube-ins/internal/safego"
)

type terminalSession struct {
	ptmx *os.File
	cmd  *exec.Cmd
	// kubeconfigPath is this session's private kubeconfig. The shell's env
	// cannot be changed once it is running, so retargeting a terminal to
	// another cluster rewrites the *contents* of this file instead.
	kubeconfigPath string
	// history is what a panel attaching to this session in another window
	// replays — see AttachTerminalSession.
	history *terminalHistory
	// detach is set while the session is between windows. Guarded by termMu,
	// like the registry it eventually deletes from.
	detach *detachGrace
}

// detachGrace is a pending close. Its pointer is the token the timer checks: an
// attach that lands while the timer is already waiting on termMu replaces or
// clears it, and the timer then finds it no longer current and backs off.
type detachGrace struct {
	timer *time.Timer
}

// cancelDetach drops a pending close. Caller holds termMu.
func (s *terminalSession) cancelDetach() {
	if s.detach != nil {
		s.detach.timer.Stop()
		s.detach = nil
	}
}

// terminalHistoryLimit is comfortably above what xterm keeps itself (3500 lines
// of scrollback), so a moved tab loses nothing it was still showing.
const terminalHistoryLimit = 512 << 10

// terminalHistory is the tail of a session's output plus the total number of
// bytes it has ever produced. The total is the stream offset: every emitted
// chunk carries its end offset, and a snapshot carries the offset it ends at,
// so a panel that subscribed before attaching can tell which chunks the
// snapshot already contains.
type terminalHistory struct {
	mu    sync.Mutex
	limit int
	buf   []byte
	end   int64
}

// record appends a chunk and emits it under the same lock, which is what makes
// "snapshot ends at offset N" and "chunk ends at offset M" comparable: no chunk
// can be half in a snapshot.
func (h *terminalHistory) record(data string, emit func(data string, end int64)) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.buf = append(h.buf, data...)
	h.end += int64(len(data))
	if over := len(h.buf) - h.limit; over > 0 {
		// Cut at a line start where there is one: replaying from the middle of
		// a line, or worse of an escape sequence, paints garbage at the top.
		if nl := bytes.IndexByte(h.buf[over:], '\n'); nl >= 0 && over+nl+1 < len(h.buf) {
			over += nl + 1
		}
		h.buf = append(h.buf[:0:0], h.buf[over:]...)
	}
	emit(data, h.end)
}

func newTerminalHistory() *terminalHistory {
	return &terminalHistory{limit: terminalHistoryLimit}
}

func (h *terminalHistory) snapshot() (string, int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return string(h.buf), h.end
}

var (
	termMu       sync.Mutex
	termSessions = make(map[string]*terminalSession)
)

var (
	termDirOnce sync.Once
	termDir     string
	termDirErr  error
)

// terminalKubeconfigDir is a 0700 directory created once per process. Keeping
// the session kubeconfigs out of ~/.kube-ins matters twice: that directory is
// scanned by ListClusters, and a second kube-ins instance must not be able to
// clobber this process' session files.
func terminalKubeconfigDir() (string, error) {
	termDirOnce.Do(func() {
		termDir, termDirErr = os.MkdirTemp("", "kube-ins-term-")
	})
	return termDir, termDirErr
}

// sessionKubeconfigPath resolves the session file for id. The id comes from the
// frontend, so it must not be able to escape the directory.
func sessionKubeconfigPath(id string) (string, error) {
	if id == "" || id != filepath.Base(id) || strings.ContainsAny(id, `/\`) || strings.HasPrefix(id, ".") {
		return "", fmt.Errorf("invalid terminal session id %q", id)
	}
	dir, err := terminalKubeconfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, id+".yaml"), nil
}

// writeSessionKubeconfig replaces path atomically, so a kubectl run in the
// terminal can never read a half-written config.
func writeSessionKubeconfig(path string, content string) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	tmpName = ""
	return nil
}

// terminalKubeconfigEnv builds the KUBECONFIG value for a session: the private
// file first, the user's own kubeconfig second. kubectl merges the list and the
// first file wins on conflicts, so the selected cluster's current-context takes
// over — and when the session file is empty (no cluster selected) the terminal
// silently falls back to the user's own config, which is what it did before
// this feature existed.
func terminalKubeconfigEnv(sessionPath string) string {
	paths := []string{sessionPath}

	if inherited := os.Getenv("KUBECONFIG"); inherited != "" {
		paths = append(paths, inherited)
	} else if home, err := os.UserHomeDir(); err == nil {
		def := filepath.Join(home, ".kube", "config")
		if _, err := os.Stat(def); err == nil {
			paths = append(paths, def)
		}
	}

	return "KUBECONFIG=" + strings.Join(paths, string(os.PathListSeparator))
}

// CreateTerminalSession starts a shell in a pty. onExit fires when the shell
// goes away on its own — the user typing `exit`, or the process being killed —
// so the frontend can tell a dead terminal from a quiet one. onOutput receives
// each chunk with the stream offset it ends at (see terminalHistory).
func CreateTerminalSession(id string, kubeconfigContent string, onOutput func(data string, end int64), onExit func()) error {
	termMu.Lock()
	defer termMu.Unlock()

	kubeconfigPath, err := sessionKubeconfigPath(id)
	if err != nil {
		return err
	}

	if existing, exists := termSessions[id]; exists {
		delete(termSessions, id)
		existing.cancelDetach()
		existing.stop()
	}

	if err := writeSessionKubeconfig(kubeconfigPath, kubeconfigContent); err != nil {
		return fmt.Errorf("failed to write terminal kubeconfig: %w", err)
	}

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}

	cmd := exec.Command(shell)
	// os/exec keeps the last occurrence of a duplicated key, so this overrides
	// any KUBECONFIG inherited from the environment.
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", terminalKubeconfigEnv(kubeconfigPath))

	ptmx, err := pty.Start(cmd)
	if err != nil {
		_ = os.Remove(kubeconfigPath)
		return fmt.Errorf("failed to start pty: %w", err)
	}

	history := newTerminalHistory()
	termSessions[id] = &terminalSession{ptmx: ptmx, cmd: cmd, kubeconfigPath: kubeconfigPath, history: history}

	safego.Go("services.terminal.reader", func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				history.record(string(buf[:n]), onOutput)
			}
			if err != nil {
				break
			}
		}

		// The pty is done: either the shell exited by itself or Close killed
		// it. Reap the child here and only here — without cmd.Wait every
		// closed terminal panel leaves a zombie — and drop the registry entry,
		// which CloseTerminalSession alone would never do for a shell that
		// exited on its own.
		//
		// The map entry is the ownership token. Losing it means Close already
		// ran or a new session took this id, and onExit must stay silent: the
		// event is keyed by id alone, so firing it here tells the *replacement*
		// panel that its live shell died. React StrictMode does exactly this on
		// every mount (create → close → create).
		termMu.Lock()
		owned := false
		if s, ok := termSessions[id]; ok && s.ptmx == ptmx {
			delete(termSessions, id)
			s.cancelDetach()
			owned = true
		}
		termMu.Unlock()
		_ = cmd.Wait()
		if owned {
			// Also gated on ownership: the path is derived from the id, so a
			// replacement session is using this exact file by now — Close and
			// the next session's own cleanup take care of the other cases.
			_ = os.Remove(kubeconfigPath)
			if onExit != nil {
				onExit()
			}
		}
	})

	return nil
}

// SetTerminalSessionKubeconfig retargets a running session at another cluster
// by rewriting its private kubeconfig. The shell is left alone, so scrollback
// and running commands survive; the next kubectl invocation picks up the new
// config.
func SetTerminalSessionKubeconfig(id string, kubeconfigContent string) error {
	termMu.Lock()
	session, ok := termSessions[id]
	termMu.Unlock()

	if !ok {
		return fmt.Errorf("terminal session %s not found", id)
	}

	return writeSessionKubeconfig(session.kubeconfigPath, kubeconfigContent)
}

func WriteToTerminalSession(id string, data string) error {
	termMu.Lock()
	session, ok := termSessions[id]
	termMu.Unlock()

	if !ok {
		return fmt.Errorf("terminal session %s not found", id)
	}

	_, err := session.ptmx.WriteString(data)
	return err
}

func ResizeTerminalSession(id string, cols uint16, rows uint16) error {
	termMu.Lock()
	session, ok := termSessions[id]
	termMu.Unlock()

	if !ok {
		return fmt.Errorf("terminal session %s not found", id)
	}

	return pty.Setsize(session.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

func CloseTerminalSession(id string) error {
	releaseTerminalSession(id, nil)
	return nil
}

// releaseTerminalSession removes id from the registry and kills its shell.
// Same ownership-token idiom as releaseExecSession: when want is non-nil the
// entry must still be that session, so a timer started for an old session
// cannot kill the one that has since taken its id.
func releaseTerminalSession(id string, want *terminalSession) {
	termMu.Lock()
	session, ok := termSessions[id]
	if ok && (want == nil || session == want) {
		delete(termSessions, id)
		session.cancelDetach()
	} else {
		ok = false
	}
	termMu.Unlock()

	if ok {
		session.stop()
	}
}

// stop tears the session down. The caller must already have removed it from
// the registry. Killing the shell ends the pty, which wakes the reader
// goroutine — that is where cmd.Wait happens, so the child is reaped exactly
// once whichever side ended the session.
func (s *terminalSession) stop() {
	_ = s.cmd.Process.Kill()
	_ = s.ptmx.Close()
	_ = os.Remove(s.kubeconfigPath)
}

// DetachTerminalSession keeps a session alive while its panel moves to another
// window of this process. Every window talks to this same backend, so the pty
// does not have to move — only the panel is re-created on the other side, and
// it picks the session up again with AttachTerminalSession.
//
// The session is closed if nothing attaches within grace. The source window
// detaches *before* it sends the panel, so a send that never arrives (the new
// window failed to load) would otherwise leave a shell running that no panel
// can reach or close.
func DetachTerminalSession(id string, grace time.Duration) error {
	termMu.Lock()
	defer termMu.Unlock()

	session, ok := termSessions[id]
	if !ok {
		return fmt.Errorf("terminal session %s not found", id)
	}
	session.cancelDetach()
	pending := &detachGrace{}
	session.detach = pending
	// Assigned under termMu, which the callback takes before it reads anything.
	pending.timer = time.AfterFunc(grace, func() {
		defer safego.Recover("services.terminal.detachGrace")
		termMu.Lock()
		current, ok := termSessions[id]
		if !ok || current != session || session.detach != pending {
			termMu.Unlock()
			return
		}
		delete(termSessions, id)
		session.detach = nil
		termMu.Unlock()
		session.stop()
	})
	return nil
}

// AttachTerminalSession cancels a pending detach and returns the session's
// recent output with the stream offset it ends at. The panel writes the
// history first and then only the streamed chunks whose end offset is past it.
func AttachTerminalSession(id string) (string, int64, error) {
	termMu.Lock()
	session, ok := termSessions[id]
	if ok {
		session.cancelDetach()
	}
	termMu.Unlock()

	if !ok {
		return "", 0, fmt.Errorf("terminal session %s not found", id)
	}
	data, end := session.history.snapshot()
	return data, end, nil
}
