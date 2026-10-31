package controller_app

import (
	"context"
	"sync"

	"github.com/google/uuid"

	"kube-ins/internal/models"
)

// trivyScanRegistry tracks the one running cluster scan per cluster. Unlike
// cancelRegistry, starting a scan for a cluster that already has one does not
// replace it: begin hands back the running scan's id, so a second panel (or a
// panel reopened mid-scan) attaches to it instead of starting another.
//
// The entry is still the ownership token (see cancelRegistry): finish removes
// it only while it is the token begin handed out, and only the goroutine whose
// finish returned true may emit the scan's end event.
type trivyScanRegistry struct {
	mu        sync.Mutex
	byCluster map[string]*trivyScanEntry
	byID      map[string]string // scanId → cluster
}

type trivyScanEntry struct {
	id       string
	tok      *cancelToken
	last     models.TrivyScanProgress
	stopping bool
}

func newTrivyScanRegistry() *trivyScanRegistry {
	return &trivyScanRegistry{
		byCluster: map[string]*trivyScanEntry{},
		byID:      map[string]string{},
	}
}

// begin registers a new scan for cluster and returns its id, context and token
// with started = true — or, when one is already running, that scan's id with
// started = false (and no context or token).
func (r *trivyScanRegistry) begin(cluster string) (id string, started bool, ctx context.Context, tok *cancelToken) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.byCluster[cluster]; ok {
		return e.id, false, nil, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	tok = &cancelToken{cancel: cancel}
	id = uuid.NewString()
	r.byCluster[cluster] = &trivyScanEntry{id: id, tok: tok, last: models.TrivyScanProgress{Phase: "targets"}}
	r.byID[id] = cluster
	return id, true, ctx, tok
}

// entry returns the live entry for id. Callers hold r.mu.
func (r *trivyScanRegistry) entry(id string) *trivyScanEntry {
	cluster, ok := r.byID[id]
	if !ok {
		return nil
	}
	e := r.byCluster[cluster]
	if e == nil || e.id != id {
		return nil
	}
	return e
}

// progress records p as the scan's latest progress. It reports false — and
// the caller must not emit p — once the scan has finished or been stopped, so
// a late line cannot replace "stopping".
func (r *trivyScanRegistry) progress(id string, p models.TrivyScanProgress) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.entry(id)
	if e == nil || e.stopping {
		return false
	}
	e.last = p
	return true
}

// finish deregisters the scan — only while tok is still its entry — and
// releases its context. It reports whether tok was current.
func (r *trivyScanRegistry) finish(id string, tok *cancelToken) bool {
	r.mu.Lock()
	e := r.entry(id)
	owned := e != nil && e.tok == tok
	if owned {
		delete(r.byCluster, r.byID[id])
		delete(r.byID, id)
	}
	r.mu.Unlock()
	if tok != nil {
		tok.cancel()
	}
	return owned
}

// running returns the cluster's running scan with its last progress, or nil.
func (r *trivyScanRegistry) running(cluster string) *models.TrivyRunningScan {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.byCluster[cluster]
	if !ok {
		return nil
	}
	return &models.TrivyRunningScan{ScanID: e.id, Progress: e.last}
}

// cancel stops the scan with this id, marking it "stopping" until it ends. It
// reports whether such a scan was running.
func (r *trivyScanRegistry) cancel(id string) bool {
	r.mu.Lock()
	e := r.entry(id)
	if e == nil {
		r.mu.Unlock()
		return false
	}
	e.stopping = true
	e.last = models.TrivyScanProgress{Phase: "stopping", Current: e.last.Current, Total: e.last.Total, Message: e.last.Message}
	tok := e.tok
	r.mu.Unlock()
	tok.cancel()
	return true
}

// lastProgress returns the scan's latest progress ("stopping" once cancelled).
func (r *trivyScanRegistry) lastProgress(id string) (models.TrivyScanProgress, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.entry(id)
	if e == nil {
		return models.TrivyScanProgress{}, false
	}
	return e.last, true
}
