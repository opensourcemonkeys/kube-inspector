// Package correlate joins what the informers saw change with who the webhooks
// saw make the request. Informer events are held back for a short delay — the
// API server ships audit batches seconds after the fact — then attributed in
// batches against the hints stored in ClickHouse, which every replica writes
// to while only the leader runs this.
package correlate

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/kubeinspector/toolbox/internal/config"
	"github.com/kubeinspector/toolbox/internal/metrics"
	"github.com/kubeinspector/toolbox/internal/model"
	"github.com/kubeinspector/toolbox/internal/watcher"
)

// HintSource is the part of the store the correlator reads.
type HintSource interface {
	HintsFor(ctx context.Context, cluster string, names []string, from, to time.Time) ([]model.Hint, error)
}

// usedTTL is how long a spent hint ID is remembered: well past the point any
// change it could match has been through its retry.
const usedTTL = 30 * time.Minute

type item struct {
	change model.Change
	hash   string
	due    time.Time
}

type Correlator struct {
	Cluster      string
	Hints        HintSource
	Put          func(model.Change) bool
	Delay        time.Duration
	RetryAfter   time.Duration
	Window       time.Duration
	RecordStatus bool
	Now          func() time.Time

	mu      sync.Mutex
	pending []*item // first pass, in arrival order
	retry   []*item // written unattributed, one more try
	used    map[string]time.Time
}

func New(cluster string, hints HintSource, put func(model.Change) bool, e config.Enrich, recordStatus bool) *Correlator {
	return &Correlator{
		Cluster: cluster, Hints: hints, Put: put, RecordStatus: recordStatus,
		Delay: e.Delay.Duration, RetryAfter: e.RetryAfter.Duration, Window: e.Window.Duration,
	}
}

func (c *Correlator) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Observe is the watcher's handler. It must stay cheap: it runs on the
// informer's delivery goroutine.
func (c *Correlator) Observe(ev watcher.Event) {
	ch, hash, ok := Build(ev, c.Cluster, c.RecordStatus)
	if !ok {
		return
	}
	metrics.ChangesObserved.WithLabelValues(string(ch.Verb)).Inc()
	c.mu.Lock()
	c.pending = append(c.pending, &item{change: ch, hash: hash, due: ev.Observed.Add(c.Delay)})
	metrics.PendingChanges.Set(float64(len(c.pending) + len(c.retry)))
	c.mu.Unlock()
}

// Pending is how many changes are waiting for (another try at) attribution.
func (c *Correlator) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending) + len(c.retry)
}

// Run processes due changes every second until ctx ends, then attributes
// whatever is still pending as best it can right away rather than lose it.
func (c *Correlator) Run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			c.Step(flushCtx, true)
			cancel()
			return
		case <-t.C:
			c.Step(ctx, false)
		}
	}
}

// Step runs one pass: first attribution of due pending changes, then the
// retry of due unattributed ones. all ignores due times (shutdown).
func (c *Correlator) Step(ctx context.Context, all bool) {
	now := c.now()
	c.mu.Lock()
	first := takeDue(&c.pending, now, all)
	second := takeDue(&c.retry, now, all)
	upcoming := append([]*item(nil), c.pending...)
	c.pruneUsed(now)
	c.mu.Unlock()

	if len(first) > 0 {
		c.attribute(ctx, first, upcoming, false, all)
	}
	if len(second) > 0 {
		c.attribute(ctx, second, upcoming, true, all)
	}
	c.mu.Lock()
	metrics.PendingChanges.Set(float64(len(c.pending) + len(c.retry)))
	c.mu.Unlock()
}

func takeDue(q *[]*item, now time.Time, all bool) []*item {
	var due, keep []*item
	for _, it := range *q {
		if all || !it.due.After(now) {
			due = append(due, it)
		} else {
			keep = append(keep, it)
		}
	}
	*q = keep
	return due
}

// attribute matches items to hints and writes them. Each change is written
// exactly once: one that finds no hint on its first pass is held for the
// retry rather than written unattributed and re-written later, so a row never
// has a second version and the hourly rollup (a materialized view over the
// inserts) counts it once. final (shutdown) writes everything now.
func (c *Correlator) attribute(ctx context.Context, items, upcoming []*item, isRetry, final bool) {
	sort.Slice(items, func(i, j int) bool { return items[i].change.Time.Before(items[j].change.Time) })

	names := make([]string, 0, len(items))
	from, to := items[0].change.Time, items[0].change.Time
	for _, it := range items {
		names = append(names, it.change.Name)
		if it.change.Time.Before(from) {
			from = it.change.Time
		}
		if it.change.Time.After(to) {
			to = it.change.Time
		}
	}
	hints, err := c.Hints.HintsFor(ctx, c.Cluster, names, from.Add(-c.Window), to.Add(c.Window))
	if err != nil {
		slog.Warn("hint lookup failed; writing changes unattributed for now", "changes", len(items), "err", err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.used == nil {
		c.used = map[string]time.Time{}
	}
	results := matchAll(items, upcoming, hints, c.used, c.Window, c.now())
	for i, it := range items {
		ch := &it.change
		if r := results[i]; r != nil {
			ch.Actor, ch.Attribution = r.actor, r.attr
		} else {
			// A final removal has no request of its own to wait for.
			if !isRetry && !final && ch.Verb != model.VerbFinalized {
				c.retry = append(c.retry, &item{change: *ch, hash: it.hash, due: ch.Time.Add(c.RetryAfter)})
				continue
			}
			ch.Attribution = model.AttrNone
			if ch.FieldManager != "" {
				ch.Attribution = model.AttrManagedFields
			}
		}
		metrics.ChangesAttributed.WithLabelValues(string(ch.Attribution)).Inc()
		c.Put(*ch)
	}
}

func (c *Correlator) pruneUsed(now time.Time) {
	for id, t := range c.used {
		if now.Sub(t) > usedTTL {
			delete(c.used, id)
		}
	}
}
