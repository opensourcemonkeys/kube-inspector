package services_k8sclient

import (
	"testing"
	"time"
)

func registerTestExec(t *testing.T, id string) *podExecSession {
	t.Helper()
	sess := newTestExecSession()
	sess.history = newTerminalHistory()
	execMu.Lock()
	execSessions[id] = sess
	execMu.Unlock()
	t.Cleanup(func() {
		execMu.Lock()
		delete(execSessions, id)
		execMu.Unlock()
	})
	return sess
}

func execRegistered(id string, want *podExecSession) bool {
	execMu.Lock()
	defer execMu.Unlock()
	return execSessions[id] == want
}

// A moved exec panel replays what the old one showed, with the offset the
// streamed chunks are measured against.
func TestExecAttachReplaysHistory(t *testing.T) {
	sess := registerTestExec(t, "exec-attach")
	sess.history.record("$ ls\r\nREADME\r\n", func(string, int64) {})

	data, offset, err := AttachExecSession("exec-attach")
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if data != "$ ls\r\nREADME\r\n" || offset != int64(len(data)) {
		t.Fatalf("snapshot %q at %d", data, offset)
	}
}

// Nothing attached in time: the session is torn down, the same as a close.
func TestExecDetachedSessionClosesWithoutAttach(t *testing.T) {
	sess := registerTestExec(t, "exec-orphan")
	if err := DetachExecSession("exec-orphan", 50*time.Millisecond); err != nil {
		t.Fatalf("detach: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for execRegistered("exec-orphan", sess) {
		if time.Now().After(deadline) {
			t.Fatal("a detached exec session nobody attached to was never closed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, ok := <-sess.sizeQueue.ch; ok {
		t.Fatal("expired session was dropped from the registry but not torn down")
	}
}

func TestExecAttachCancelsDetachGrace(t *testing.T) {
	sess := registerTestExec(t, "exec-moved")
	if err := DetachExecSession("exec-moved", 50*time.Millisecond); err != nil {
		t.Fatalf("detach: %v", err)
	}
	if _, _, err := AttachExecSession("exec-moved"); err != nil {
		t.Fatalf("attach: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	if !execRegistered("exec-moved", sess) {
		t.Fatal("attached exec session was closed by the detach grace timer")
	}
}

// The grace timer is bound to the session it was started for: a session that
// has since taken the same id survives it.
func TestExecDetachGraceSparesAReplacement(t *testing.T) {
	registerTestExec(t, "exec-replaced")
	if err := DetachExecSession("exec-replaced", 50*time.Millisecond); err != nil {
		t.Fatalf("detach: %v", err)
	}
	fresh := registerTestExec(t, "exec-replaced")
	time.Sleep(200 * time.Millisecond)
	if !execRegistered("exec-replaced", fresh) {
		t.Fatal("the replaced session's grace timer closed its replacement")
	}
}

// A node shell is movable while its helper pod is still starting — there is no
// exec session yet, only the node shell entry and the progress it has printed.
// Expiring that detach must delete the privileged pod.
func TestNodeShellDetachedDuringStartup(t *testing.T) {
	sess, client := newTestNodeShell(t, "ns-starting", "kube-ins-nodeshell-starting")
	sess.history = newTerminalHistory()
	sess.history.record("Waiting for pod...\r\n", func(string, int64) {})

	data, _, err := AttachExecSession("ns-starting")
	if err != nil || data != "Waiting for pod...\r\n" {
		t.Fatalf("attach during startup: %q, %v", data, err)
	}

	if err := DetachExecSession("ns-starting", 50*time.Millisecond); err != nil {
		t.Fatalf("detach during startup: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for podExists(t, client, sess.podName) {
		if time.Now().After(deadline) {
			t.Fatal("helper pod survived an expired detach — a privileged pod leaked")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestExecDetachUnknownSession(t *testing.T) {
	if err := DetachExecSession("exec-missing", time.Second); err == nil {
		t.Fatal("detaching a session that does not exist must fail, so the source closes it instead")
	}
	if _, _, err := AttachExecSession("exec-missing"); err == nil {
		t.Fatal("attaching to a session that does not exist must fail")
	}
}
