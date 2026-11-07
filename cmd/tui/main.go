// Command kube-ins-tui is the standalone terminal UI for kube-ins. It links no
// Wails/webview code — it drives the same internal/business functions the
// desktop app uses, so it ships as its own lightweight, webkit-free binary.
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"

	"kube-ins/internal/business"
	"kube-ins/internal/logging"
	"kube-ins/internal/tui"
)

func main() {
	// --licenses prints the third-party notices and exits, before tview takes
	// the screen.
	for _, arg := range os.Args[1:] {
		if arg == "--licenses" {
			os.Exit(business.PrintLicenses(os.Stdout, os.Stderr))
		}
	}

	version := business.GetAppInfo().AppVersion

	// File-only logging, and the standard logger points at the same file.
	//
	// Never stderr on this path: tview owns the screen and a stray line
	// corrupts it. That is also why the failure branch discards rather than
	// leaving the standard logger alone — its default is stderr, and relying on
	// Trivy's init() to have swallowed it is not a guarantee worth betting a
	// scrambled terminal on.
	log.SetFlags(0) // our handler owns the timestamp
	if err := logging.Init(logging.RoleCLI, version); err == nil {
		log.SetOutput(logging.StdlibWriter())
		defer func() { _ = logging.Close() }()
	} else {
		log.SetOutput(io.Discard)
	}
	logging.With("main").Info("kube-ins starting", "mode", "tui", "binary", "cli")

	if err := tui.Run(context.Background(), version); err != nil {
		fmt.Fprintln(os.Stderr, "kube-ins-tui:", err)
		os.Exit(1)
	}
}
