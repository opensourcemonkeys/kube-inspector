package controller_app

import (
	"context"
	"sync"
)

// cancelRegistry tracks the cancel func of one in-flight background job per key
// (a chat session id, a scan id, a model name). Starting a new job for a key
// cancels the old one.
//
// Entries are removed by *identity*, never by key. The obvious version —
// `defer delete(m, key)` — deletes whatever is under the key by the time the
// job finishes, which after a restart is the *replacement* job's entry. The job
// then runs unregistered: nothing can cancel it, and anything that looks the
// session up finds nothing. That is what left AI chat hanging forever on the
// tool-approval dialog when a second turn was started before the first ended —
// ConfirmToolCall could not find the session, so the agent loop stayed parked
// on its channel until the context died.
type cancelRegistry struct {
	mu sync.Mutex
	m  map[string]*cancelToken
}

// cancelToken exists so entries are comparable. Go function values are not, so
// a map[string]context.CancelFunc cannot support the identity check above.
type cancelToken struct{ cancel context.CancelFunc }

func newCancelRegistry() *cancelRegistry {
	return &cancelRegistry{m: map[string]*cancelToken{}}
}

// begin cancels any job already running under key and registers cancel as its
// replacement. The returned token must be handed back to done.
func (r *cancelRegistry) begin(key string, cancel context.CancelFunc) *cancelToken {
	tok := &cancelToken{cancel: cancel}
	r.mu.Lock()
	if old, ok := r.m[key]; ok {
		old.cancel()
	}
	r.m[key] = tok
	r.mu.Unlock()
	return tok
}

// done deregisters tok — but only while it is still the current entry for key —
// and releases its context. It reports whether tok was still current, i.e.
// whether the job may still speak for key (emit its end event).
func (r *cancelRegistry) done(key string, tok *cancelToken) bool {
	r.mu.Lock()
	cur, ok := r.m[key]
	owned := ok && cur == tok
	if owned {
		delete(r.m, key)
	}
	r.mu.Unlock()
	tok.cancel()
	return owned
}

// cancel stops the job currently registered under key, if any.
func (r *cancelRegistry) cancel(key string) {
	r.mu.Lock()
	tok, ok := r.m[key]
	r.mu.Unlock()
	if ok {
		tok.cancel()
	}
}

// has reports whether a job is currently registered under key.
func (r *cancelRegistry) has(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.m[key]
	return ok
}
