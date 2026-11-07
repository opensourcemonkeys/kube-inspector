package main

import (
	"context"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/signal"
	"syscall"

	"kube-ins/internal/business"
	app_controller "kube-ins/internal/controller"
	"kube-ins/internal/logging"
	"kube-ins/internal/tui"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

//go:embed all:frontend/dist
var assets embed.FS

// serve runs the shell-agnostic RPC server and blocks. The frontend is the same
// embedded bundle Wails uses, so the app behaves identically in a browser tab
// apart from the native-only bits (window chrome, save dialog).
func serve(shellChannel bool) error {
	dist, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		return err
	}

	srv, err := app_controller.NewServer(dist)
	if err != nil {
		return err
	}
	srv.Bootstrap(context.Background())

	// These two lines are a protocol, not output: electron/main.cjs line-parses
	// stdout for them and hangs for 30s if either fails to arrive intact. This
	// is why internal/logging is file-only and never touches os.Stdout.
	fmt.Println("kube-ins serving at", srv.URL())

	// The shell's main process needs the token to open /shell, and it cannot
	// read the copy injected into index.html. stdout is a private pipe to our
	// parent, which is why the token goes here rather than argv (world-readable
	// via /proc) or a temp file (cleanup and TOCTOU).
	//
	// Do not redirect this stream to a log file.
	if shellChannel {
		fmt.Println("kube-ins shell token", srv.Token())
	}

	// The URL is safe to record; the token above never is.
	logging.With("main").Debug("rpc server bound", "url", srv.URL())

	// Orphan guard: our parent closes stdin when it dies, including on SIGKILL
	// where no signal reaches us. Without this a 262MB process holding live
	// Kubernetes watches would survive the shell. Skipped when stdin is a
	// terminal so `kube-ins --serve` from a shell prompt is unaffected.
	stop := make(chan struct{}, 1)
	if fi, err := os.Stdin.Stat(); err == nil && fi.Mode()&os.ModeCharDevice == 0 {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop <- struct{}{}
		}()
	}

	// Block until interrupted so the k8s streams stay alive.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
	case <-stop:
	}

	// Tunnels outlive the panels that opened them, so nothing else closes them.
	// Skipped on SIGKILL, where the kernel reclaims the listeners instead.
	business.StopAllPortForwards()
	return srv.Close()
}

func main() {
	// --licenses prints the third-party notices and exits, before anything
	// else starts: no log file, no cluster, no window, nothing on stdout but
	// the notices.
	for _, arg := range os.Args[1:] {
		if arg == "--licenses" {
			os.Exit(business.PrintLicenses(os.Stdout, os.Stderr))
		}
	}

	// CLI mode: when launched with --tui (used both by `kube-ins --tui` and by
	// the GUI's "CLI mode", which re-execs this binary in a pty), run the
	// terminal UI instead of bootstrapping Wails/webview.
	for _, arg := range os.Args[1:] {
		if arg == "--tui" || arg == "tui" {
			version := business.GetAppInfo().AppVersion
			// File-only, and Init forces the stderr tee off for this role:
			// tview owns the screen. This branch returns before the
			// log.SetOutput below, so without this the CLI's standard log
			// output goes nowhere at all — and on the failure path it must be
			// discarded rather than left at its stderr default, which would
			// scramble the terminal.
			log.SetFlags(0)
			if err := logging.Init(logging.RoleCLI, version); err == nil {
				log.SetOutput(logging.StdlibWriter())
			} else {
				log.SetOutput(io.Discard)
			}
			logging.With("main").Info("kube-ins starting", "mode", "tui", "binary", "gui")
			if err := tui.Run(context.Background(), version); err != nil {
				fmt.Fprintln(os.Stderr, "kube-ins:", err)
				os.Exit(1)
			}
			_ = logging.Close()
			return
		}
	}

	// Open the log file and take the standard logger back.
	//
	// Trivy's pkg/log has an init() that calls slog.SetDefault with a handler
	// which only buffers records into a slice until Trivy initialises its own
	// logger — and since Go 1.21 slog.SetDefault also reroutes the standard log
	// package through that handler. Importing the scanner therefore silently
	// swallowed every log.Print in the binary; the output reappears in test
	// binaries, which never link Trivy, so it looked like the logging worked.
	//
	// internal/logging owns its own *slog.Logger and never calls
	// slog.SetDefault, precisely so it cannot be captured the same way; pointing
	// the standard logger at its writer is what pulls third-party log.Print
	// output into the same file. Flags go to 0 because our handler owns the
	// timestamp.
	//
	// Deliberately after the --tui branch, which sets this up for itself: the
	// terminal UI owns the screen.
	version := business.GetAppInfo().AppVersion
	if err := logging.Init(logging.RoleBackend, version); err != nil {
		// Nothing is on disk, but the app is still usable. Say so on stderr —
		// never stdout, which is the Electron sidecar protocol (see serve()).
		fmt.Fprintln(os.Stderr, "kube-ins: file logging disabled:", err)
	}
	log.SetOutput(logging.StdlibWriter())
	log.SetFlags(0)
	defer func() { _ = logging.Close() }()

	// Serve mode: expose the controller over loopback HTTP/WebSocket and print
	// the URL instead of opening a window. This is how the Electron shell runs
	// the backend (as a sidecar), and it also lets the whole app be exercised
	// in a plain Chromium tab. --shell-channel additionally prints the token so
	// a native shell's main process can attach to /shell for save dialogs.
	var serveMode, shellChannel bool
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--serve":
			serveMode = true
		case "--shell-channel":
			shellChannel = true
		}
	}
	if serveMode {
		logging.With("main").Info("kube-ins starting", "mode", "serve", "shellChannel", shellChannel)
		if err := serve(shellChannel); err != nil {
			logging.With("main").Error("serve failed", "err", err)
			fmt.Fprintln(os.Stderr, "kube-ins:", err)
			os.Exit(1)
		}
		return
	}

	logging.With("main").Info("kube-ins starting", "mode", "wails")

	// Create an instance of the app structure
	app := app_controller.NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:     "Kube Inspector",
		Width:     1024,
		Height:    768,
		Frameless: true,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 6, G: 14, B: 32, A: 1},
		OnStartup:        app.Startup,
		// Not a method on App: Wails binds every exported method into the
		// generated TypeScript, and closing every tunnel is not part of the
		// frontend API.
		OnShutdown: func(context.Context) { business.StopAllPortForwards() },
		Linux: &linux.Options{
			WebviewGpuPolicy: linux.WebviewGpuPolicyAlways,
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
