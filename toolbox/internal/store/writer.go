package store

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/kubeinspector/toolbox/internal/metrics"
	"github.com/kubeinspector/toolbox/internal/model"
)

const (
	flushEvery = time.Second
	maxBatch   = 1000
	queueSize  = 50000
	attempts   = 4
)

// Writer batches rows for one table. Put never blocks: the admission webhook
// calls it on the API server's request path, and a slow ClickHouse must cost
// us rows, not the cluster latency.
type Writer[T any] struct {
	table  string
	conn   driver.Conn
	append func(driver.Batch, T) error
	ch     chan T
	done   chan struct{}
}

func newWriter[T any](conn driver.Conn, table string, appendFn func(driver.Batch, T) error) *Writer[T] {
	return &Writer[T]{table: table, conn: conn, append: appendFn, ch: make(chan T, queueSize), done: make(chan struct{})}
}

// Put queues v and reports whether there was room.
func (w *Writer[T]) Put(v T) bool {
	select {
	case w.ch <- v:
		return true
	default:
		metrics.RowsDropped.WithLabelValues(w.table, "queue_full").Inc()
		return false
	}
}

// Run flushes until ctx is cancelled, then drains what is queued. Done is
// closed when the drain has finished.
func (w *Writer[T]) Run(ctx context.Context) {
	defer close(w.done)
	t := time.NewTicker(flushEvery)
	defer t.Stop()
	buf := make([]T, 0, maxBatch)
	for {
		select {
		case v := <-w.ch:
			buf = append(buf, v)
			if len(buf) >= maxBatch {
				w.flush(buf)
				buf = buf[:0]
			}
		case <-t.C:
			if len(buf) > 0 {
				w.flush(buf)
				buf = buf[:0]
			}
		case <-ctx.Done():
			for {
				select {
				case v := <-w.ch:
					buf = append(buf, v)
				default:
					if len(buf) > 0 {
						w.flush(buf)
					}
					return
				}
			}
		}
	}
}

// Done is closed once Run has drained its queue after cancellation.
func (w *Writer[T]) Done() <-chan struct{} { return w.done }

func (w *Writer[T]) flush(rows []T) {
	backoff := 500 * time.Millisecond
	var err error
	for i := 0; i < attempts; i++ {
		if err = w.send(rows); err == nil {
			metrics.RowsWritten.WithLabelValues(w.table).Add(float64(len(rows)))
			return
		}
		slog.Warn("clickhouse write failed", "table", w.table, "rows", len(rows), "attempt", i+1, "err", err)
		time.Sleep(backoff)
		backoff *= 2
	}
	metrics.RowsDropped.WithLabelValues(w.table, "write_failed").Add(float64(len(rows)))
	slog.Error("dropping rows after repeated write failures", "table", w.table, "rows", len(rows), "err", err)
}

func (w *Writer[T]) send(rows []T) error {
	// The flush runs detached from Run's ctx so a shutdown can still drain.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	b, err := w.conn.PrepareBatch(ctx, "INSERT INTO "+w.table)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if err := w.append(b, r); err != nil {
			_ = b.Abort()
			return err
		}
	}
	return b.Send()
}

func (s *Store) ChangeWriter() *Writer[model.Change] {
	return newWriter(s.conn, "changes", func(b driver.Batch, c model.Change) error {
		return b.Append(
			c.EventID, c.Version, c.Time, c.Cluster, string(c.Verb),
			c.Group, c.APIVersion, c.Resource, c.Kind, c.Namespace, c.Name,
			c.ObjectUID, c.ResourceVersion,
			c.Actor.Username, c.Actor.UserUID, nonNil(c.Actor.Groups), extraJSON(c.Actor.Extra),
			c.Actor.ImpersonatedBy, nonNil(c.Actor.SourceIPs), c.Actor.UserAgent, c.Actor.AuditID,
			c.FieldManager, string(c.Attribution), nonNil(c.ChangedPaths),
			c.Patch, c.Before, c.After,
		)
	})
}

func (s *Store) HintWriter() *Writer[model.Hint] {
	return newWriter(s.conn, "actor_hints", func(b driver.Batch, h model.Hint) error {
		return b.Append(
			h.ID, string(h.Source), h.Time, h.Cluster, string(h.Verb),
			h.Key.Group, h.Key.Resource, h.Subresource, h.Key.Namespace, h.Key.Name,
			h.ObjectUID, h.ResourceVersion, h.ContentHash,
			h.Actor.Username, h.Actor.UserUID, nonNil(h.Actor.Groups), extraJSON(h.Actor.Extra),
			h.Actor.ImpersonatedBy, nonNil(h.Actor.SourceIPs), h.Actor.UserAgent, h.Actor.AuditID,
		)
	})
}

func (s *Store) AuditWriter() *Writer[model.AuditRecord] {
	return newWriter(s.conn, "audit_raw", func(b driver.Batch, a model.AuditRecord) error {
		return b.Append(
			a.Time, a.Cluster, a.AuditID, a.Verb, a.Group, a.APIVersion, a.Resource, a.Subresource,
			a.Namespace, a.Name, a.Username, nonNil(a.Groups), a.ImpersonatedBy, nonNil(a.SourceIPs),
			a.UserAgent, a.RequestURI, a.ResponseCode, a.ResponseReason, a.ResponseMessage,
		)
	})
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func extraJSON(m map[string][]string) string {
	if len(m) == 0 {
		return ""
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func parseExtra(s string) map[string][]string {
	if s == "" {
		return nil
	}
	var m map[string][]string
	_ = json.Unmarshal([]byte(s), &m)
	return m
}
