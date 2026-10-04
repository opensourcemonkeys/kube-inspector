package services_k8sclient

import (
	"fmt"
	"sync"
	"time"

	"kube-ins/internal/safego"
)

// Moving a pod exec or node shell panel to another window of this process.
//
// Same idea as DetachTerminalSession: every window talks to this one backend,
// so the stream stays where it is and only the panel is re-created. The source
// window detaches before it sends the panel; the receiving one attaches and
// replays the session's history. A detach nobody picks up within the grace
// period closes the session — for a node shell that is what deletes the
// privileged helper pod, which must never be left behind.
//
// Unlike a terminal, the session may not exist in the exec registry yet: a node
// shell spends up to nodeShellTimeout waiting for its pod, with only a
// nodeShells entry. Both registries carry the same *terminalHistory for one
// node shell, so the history pointer identifies "this session" across them and
// is what the grace timer checks before it tears anything down.

type execDetach struct {
	history *terminalHistory
	timer   *time.Timer
}

var (
	execDetachMu sync.Mutex
	execDetached = make(map[string]*execDetach)
)

// execHistory resolves id to its session's history, looking at the exec
// registry first and at a node shell still starting second.
func execHistory(id string) *terminalHistory {
	execMu.Lock()
	sess, ok := execSessions[id]
	execMu.Unlock()
	if ok && sess.history != nil {
		return sess.history
	}

	nodeShellMu.Lock()
	ns, ok := nodeShells[id]
	nodeShellMu.Unlock()
	if ok && ns.history != nil {
		return ns.history
	}
	return nil
}

// releaseExecByHistory closes whatever under id still belongs to the session
// that owns history, in either registry. A session that has since taken the id
// carries a different history and is left alone.
func releaseExecByHistory(id string, history *terminalHistory) {
	nodeShellMu.Lock()
	ns, ok := nodeShells[id]
	nodeShellMu.Unlock()
	if ok && ns.history == history {
		releaseNodeShell(id, ns)
	}

	execMu.Lock()
	sess, ok := execSessions[id]
	execMu.Unlock()
	if ok && sess.history == history {
		releaseExecSession(id, sess)
	}
}

// DetachExecSession keeps a pod exec or node shell alive while its panel moves
// to another window, and closes it if nothing attaches within grace. It fails
// for an unknown id, so the caller knows to close the panel the normal way.
func DetachExecSession(id string, grace time.Duration) error {
	history := execHistory(id)
	if history == nil {
		return fmt.Errorf("exec session %s not found", id)
	}

	execDetachMu.Lock()
	defer execDetachMu.Unlock()

	if prev, ok := execDetached[id]; ok {
		prev.timer.Stop()
	}
	pending := &execDetach{history: history}
	execDetached[id] = pending
	// Assigned under execDetachMu, which the callback takes before it reads
	// anything — and the entry's pointer is the token: an attach that lands
	// while the timer waits on the lock removes it, and the timer backs off.
	pending.timer = time.AfterFunc(grace, func() {
		defer safego.Recover("services.exec.detachGrace")
		execDetachMu.Lock()
		if execDetached[id] != pending {
			execDetachMu.Unlock()
			return
		}
		delete(execDetached, id)
		execDetachMu.Unlock()
		releaseExecByHistory(id, history)
	})
	return nil
}

// AttachExecSession cancels a pending detach and returns the session's recent
// output with the stream offset it ends at.
func AttachExecSession(id string) (string, int64, error) {
	history := execHistory(id)
	if history == nil {
		return "", 0, fmt.Errorf("exec session %s not found", id)
	}

	execDetachMu.Lock()
	if pending, ok := execDetached[id]; ok && pending.history == history {
		pending.timer.Stop()
		delete(execDetached, id)
	}
	execDetachMu.Unlock()

	data, end := history.snapshot()
	return data, end, nil
}
