package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
)

const (
	streamBatch     = 500
	streamKeepalive = 15 * time.Second
)

// stream sends changes matching the usual filters (since/until aside) as
// Server-Sent Events while the client stays connected: "event: change" with
// one change as data, and a comment line every 15s so proxies keep the
// connection open.
//
// Every replica serves the API but only the leader writes, so there is no
// in-process feed to subscribe to: each stream polls ClickHouse for the last
// StreamLookback and sends what it has not sent yet. On connecting that
// includes what the client may already have listed; the client de-duplicates
// by eventId, which is safer than guessing where its list ended.
func (s *Server) stream(w http.ResponseWriter, r *http.Request) error {
	f, err := s.changeFilter(r)
	if err != nil {
		return err
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		return errors.New("response writer cannot stream")
	}
	lookback := s.StreamLookback
	if lookback <= 0 {
		lookback = 3 * time.Minute
	}
	every := s.StreamPoll
	if every <= 0 {
		every = 2 * time.Second
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no") // nginx in front: do not buffer
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()
	seen := map[uuid.UUID]time.Time{}
	poll := time.NewTimer(0)
	defer poll.Stop()
	keepalive := time.NewTicker(streamKeepalive)
	defer keepalive.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-keepalive.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return nil
			}
			flusher.Flush()
		case <-poll.C:
			now := s.now()
			items, err := s.Store.RecentChanges(ctx, f, now.Add(-lookback), seen, streamBatch)
			if err != nil {
				if ctx.Err() != nil {
					return nil
				}
				slog.Warn("change stream poll failed", "err", err)
				// Tell the client and end; it falls back to polling the list.
				b, _ := json.Marshal(map[string]string{"error": "poll failed"})
				fmt.Fprintf(w, "event: error\ndata: %s\n\n", b)
				flusher.Flush()
				return nil
			}
			for _, c := range items {
				seen[c.EventID] = now
				b, err := json.Marshal(c)
				if err != nil {
					return nil
				}
				if _, err := fmt.Fprintf(w, "event: change\ndata: %s\n\n", b); err != nil {
					return nil
				}
			}
			if len(items) > 0 {
				flusher.Flush()
			}
			// An ID only needs remembering while it can still fall in the lookback.
			for id, at := range seen {
				if now.Sub(at) > 2*lookback {
					delete(seen, id)
				}
			}
			poll.Reset(every)
		}
	}
}
