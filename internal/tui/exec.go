package tui

import (
	"bytes"
	"fmt"
	"os"
	"time"

	"golang.org/x/term"

	"kube-ins/internal/business"
)

// disconnectKey ends an interactive exec session (ASCII GS, Ctrl-]) — the same
// escape telnet uses, since tview has no embedded terminal emulator and we hand
// the raw tty to the remote shell while suspended.
const disconnectKey = 0x1d

// execPod opens an interactive shell in a pod container. It picks the container
// first (prompting when there is more than one), then suspends tview and bridges
// the raw terminal to the remote exec session.
func (a *App) execPod(row rowData, view string) {
	containers, err := business.GetPodContainers(a.cluster, row.name, row.namespace)
	if err != nil {
		a.flash("Error", err.Error(), colDanger)
		return
	}
	switch len(containers) {
	case 0:
		a.flash("Exec", "pod has no containers", colWarn)
	case 1:
		a.runExec(row, containers[0])
	default:
		a.pickContainer(containers, func(c string) { a.runExec(row, c) })
	}
}

func (a *App) runExec(row rowData, container string) {
	id := fmt.Sprintf("tui-exec-%d", time.Now().UnixNano())

	// Suspend tview: tcell restores the terminal so the remote shell owns the
	// tty in raw mode. The callback blocks the UI until exec ends.
	a.app.Suspend(func() {
		fd := int(os.Stdin.Fd())
		oldState, rawErr := term.MakeRaw(fd)
		if rawErr == nil {
			defer func() { _ = term.Restore(fd, oldState) }()
		}

		fmt.Print("\033[2J\033[H")
		fmt.Printf("Connected to %s/%s [%s]. Press Ctrl-] to disconnect.\r\n\r\n", row.namespace, row.name, container)

		onOutput := func(s string, _ int64) { _, _ = os.Stdout.WriteString(s) }
		// No onClosed: the loop below owns the screen and prints
		// "[disconnected]" itself once the user presses Ctrl-].
		if err := business.CreatePodExecSession(a.cluster, id, row.namespace, row.name, container, onOutput, nil); err != nil {
			fmt.Printf("exec error: %v\r\n", err)
			time.Sleep(2 * time.Second)
			return
		}
		defer func() { _ = business.ClosePodExecSession(id) }()

		if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil {
			_ = business.ResizePodExecSession(id, w, h)
		}

		buf := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				if i := bytes.IndexByte(buf[:n], disconnectKey); i >= 0 {
					if i > 0 {
						_ = business.WriteToPodExecSession(id, string(buf[:i]))
					}
					break
				}
				_ = business.WriteToPodExecSession(id, string(buf[:n]))
			}
			if err != nil {
				break
			}
		}
		fmt.Print("\r\n[disconnected]\r\n")
		time.Sleep(300 * time.Millisecond)
	})

	if a.resourceBody != nil {
		a.app.SetFocus(a.resourceBody)
	}
}
