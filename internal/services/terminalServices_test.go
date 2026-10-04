package services_k8sclient

import (
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func skipWithoutPty(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("creack/pty cannot start a shell on Windows")
	}
	t.Setenv("SHELL", "/bin/sh")
}

// The reported bug: opening a terminal immediately printed "[shell exited]" and
// swallowed every keystroke. React StrictMode mounts an effect twice, so the
// panel ran create → close → create under one id; the *closed* session's reader
// goroutine then emitted terminal:exit, which is keyed by id alone and so hit
// the live replacement.
func TestTerminalExitIsSilentForAReplacedSession(t *testing.T) {
	skipWithoutPty(t)

	const id = "strictmode"
	exits := make(chan struct{}, 4)
	onExit := func() { exits <- struct{}{} }

	if err := CreateTerminalSession(id, "", func(string, int64) {}, onExit); err != nil {
		t.Fatalf("first session: %v", err)
	}
	if err := CloseTerminalSession(id); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := CreateTerminalSession(id, "", func(string, int64) {}, onExit); err != nil {
		t.Fatalf("second session: %v", err)
	}
	t.Cleanup(func() { _ = CloseTerminalSession(id) })

	select {
	case <-exits:
		t.Fatal("a closed session reported an exit against the id its replacement now owns")
	case <-time.After(500 * time.Millisecond):
	}

	// The replacement must still be usable — it is the session the panel talks to.
	if err := WriteToTerminalSession(id, "\n"); err != nil {
		t.Fatalf("replacement session is not writable: %v", err)
	}
}

// A shell that exits by itself has to report it: this is the signal that tells
// the panel a dead terminal from a quiet one.
func TestTerminalExitFiresWhenTheShellExits(t *testing.T) {
	skipWithoutPty(t)

	const id = "self-exit"
	exits := make(chan struct{}, 1)

	if err := CreateTerminalSession(id, "", func(string, int64) {}, func() { exits <- struct{}{} }); err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _ = CloseTerminalSession(id) })

	if err := WriteToTerminalSession(id, "exit\n"); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case <-exits:
	case <-time.After(5 * time.Second):
		t.Fatal("shell exited but onExit never fired")
	}

	// Reaped and deregistered, so the id is free for a new session.
	termMu.Lock()
	_, still := termSessions[id]
	termMu.Unlock()
	if still {
		t.Fatal("exited shell left its registry entry behind")
	}
}

// outputLog collects a session's emitted chunks with their end offsets, so a
// test can compare what a moved panel would replay against what was streamed.
type outputLog struct {
	mu   sync.Mutex
	text strings.Builder
	end  int64
}

func (l *outputLog) record(data string, end int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.text.WriteString(data)
	l.end = end
}

func (l *outputLog) snapshot() (string, int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.text.String(), l.end
}

func waitForOutput(t *testing.T, l *outputLog, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if text, _ := l.snapshot(); strings.Contains(text, want) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	text, _ := l.snapshot()
	t.Fatalf("output never contained %q; got %q", want, text)
}

// Moving a terminal tab to another window re-creates the panel there, so the
// new xterm starts empty. Attach hands it the history the old one showed, and
// the offset it returns lines up with the offsets on streamed chunks — that is
// what lets the panel drop the chunks the snapshot already contains.
func TestTerminalAttachReplaysHistoryWithStreamOffsets(t *testing.T) {
	skipWithoutPty(t)

	const id = "attach-history"
	var out outputLog
	if err := CreateTerminalSession(id, "", out.record, nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _ = CloseTerminalSession(id) })

	if err := WriteToTerminalSession(id, "echo handoff-$((40+2))\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	waitForOutput(t, &out, "handoff-42")
	// Let the prompt that follows the command land too, so the stream is idle.
	time.Sleep(200 * time.Millisecond)

	data, offset, err := AttachTerminalSession(id)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	streamed, end := out.snapshot()
	if data != streamed {
		t.Fatalf("snapshot differs from the streamed output:\nsnapshot %q\nstreamed %q", data, streamed)
	}
	if offset != end || offset != int64(len(data)) {
		t.Fatalf("snapshot offset %d, last streamed offset %d, history length %d", offset, end, len(data))
	}
}

// The source window detaches before it sends the panel. If the panel never
// arrives — the new window failed to load — nothing would ever close the pty,
// so a detached session must reap itself after the grace period.
func TestTerminalDetachedSessionClosesWithoutAttach(t *testing.T) {
	skipWithoutPty(t)

	const id = "detach-orphan"
	if err := CreateTerminalSession(id, "", func(string, int64) {}, nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _ = CloseTerminalSession(id) })

	if err := DetachTerminalSession(id, 100*time.Millisecond); err != nil {
		t.Fatalf("detach: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := WriteToTerminalSession(id, "\n"); err != nil {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("a detached session nobody attached to was never closed")
}

// The normal move: the receiving window attaches inside the grace period and
// the shell must keep running long after it would otherwise have expired.
func TestTerminalAttachCancelsDetachGrace(t *testing.T) {
	skipWithoutPty(t)

	const id = "detach-attach"
	if err := CreateTerminalSession(id, "", func(string, int64) {}, nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _ = CloseTerminalSession(id) })

	if err := DetachTerminalSession(id, 100*time.Millisecond); err != nil {
		t.Fatalf("detach: %v", err)
	}
	if _, _, err := AttachTerminalSession(id); err != nil {
		t.Fatalf("attach: %v", err)
	}
	time.Sleep(400 * time.Millisecond)

	if err := WriteToTerminalSession(id, "\n"); err != nil {
		t.Fatalf("attached session was closed by the detach grace timer: %v", err)
	}
}

// A grace timer belongs to the session it was started for. If the id is
// re-created in the meantime, the old timer must not kill the replacement.
func TestTerminalDetachGraceSparesAReplacement(t *testing.T) {
	skipWithoutPty(t)

	const id = "detach-replaced"
	if err := CreateTerminalSession(id, "", func(string, int64) {}, nil); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := DetachTerminalSession(id, 100*time.Millisecond); err != nil {
		t.Fatalf("detach: %v", err)
	}
	if err := CreateTerminalSession(id, "", func(string, int64) {}, nil); err != nil {
		t.Fatalf("re-create: %v", err)
	}
	t.Cleanup(func() { _ = CloseTerminalSession(id) })
	time.Sleep(400 * time.Millisecond)

	if err := WriteToTerminalSession(id, "\n"); err != nil {
		t.Fatalf("the replaced session's grace timer closed its replacement: %v", err)
	}
}

func TestTerminalHistoryKeepsTheTailAtALineBoundary(t *testing.T) {
	h := &terminalHistory{limit: 16}
	h.record("first line\n", func(string, int64) {})
	h.record("second line\nthird\n", func(string, int64) {})

	data, end := h.snapshot()
	if end != int64(len("first line\nsecond line\nthird\n")) {
		t.Fatalf("end offset %d counts trimmed bytes wrongly", end)
	}
	if data != "third\n" {
		t.Fatalf("history %q: want the tail cut at a line start", data)
	}
	if len(data) > h.limit {
		t.Fatalf("history %d bytes exceeds its %d-byte limit", len(data), h.limit)
	}
}
