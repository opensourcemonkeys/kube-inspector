package store

import (
	"context"
	"time"
)

// Heartbeat is one row of the leader's heartbeat.
type Heartbeat struct {
	Time             time.Time `json:"time"`
	Cluster          string    `json:"-"`
	Identity         string    `json:"identity"`
	Term             string    `json:"term,omitempty"`
	WatchedResources uint32    `json:"watchedResources"`
	Pending          uint32    `json:"pending"`
}

// WriteHeartbeat inserts one heartbeat directly rather than through a batched
// Writer: it is one row every few seconds, and a heartbeat that sat in a
// queue would claim the leader was alive later than it was.
//
// The time goes in as Unix milliseconds: clickhouse-go binds a time.Time
// parameter at second precision, which stored every heartbeat as hh:mm:ss.000.
func (s *Store) WriteHeartbeat(ctx context.Context, h Heartbeat) error {
	return s.conn.Exec(ctx, `INSERT INTO recorder_heartbeats (ts, cluster, identity, term, watched_resources, pending)
		VALUES (fromUnixTimestamp64Milli(?, 'UTC'), ?, ?, ?, ?, ?)`, h.Time.UnixMilli(), h.Cluster, h.Identity, h.Term, h.WatchedResources, h.Pending)
}

// LastHeartbeat returns the newest heartbeat, or nil when there is none
// (a toolbox from before heartbeats, or one whose leader never started).
func (s *Store) LastHeartbeat(ctx context.Context, cluster string) (*Heartbeat, error) {
	var w where
	w.eq("cluster", cluster)
	rows, err := s.conn.Query(ctx, "SELECT ts, cluster, identity, term, watched_resources, pending FROM recorder_heartbeats"+
		w.String()+" ORDER BY ts DESC LIMIT 1", w.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var h Heartbeat
	if err := rows.Scan(&h.Time, &h.Cluster, &h.Identity, &h.Term, &h.WatchedResources, &h.Pending); err != nil {
		return nil, err
	}
	return &h, nil
}

// Gap is a stretch with no leader heartbeat: changes made then were missed.
// Open means it is still going on (no heartbeat since From).
type Gap struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
	Open bool      `json:"open"`
}

// Coverage is how much of [Since, Until] was recorded. Since is moved forward
// to the first heartbeat ever kept when that is later: before it there is
// nothing to say either way, which is not the same as a gap. HasData is false
// when there has never been a heartbeat.
type Coverage struct {
	Since      time.Time `json:"since"`
	Until      time.Time `json:"until"`
	HasData    bool      `json:"hasData"`
	Gaps       []Gap     `json:"gaps"`
	GapSeconds float64   `json:"gapSeconds"`
	// Ratio is the recorded share of the window, 0..1.
	Ratio float64 `json:"ratio"`
}

// Coverage finds the gaps in [since, until]:
//   - between consecutive heartbeats of different leader terms, however close:
//     a new term lists every object afresh and records nothing from before
//     its first heartbeat, so the time in between was not recorded;
//   - between heartbeats of one term further apart than threshold (a leader
//     that stalled or could not reach ClickHouse);
//   - and a trailing one when the newest heartbeat is older than threshold.
func (s *Store) Coverage(ctx context.Context, cluster string, since, until time.Time, threshold time.Duration) (*Coverage, error) {
	cov := &Coverage{Since: since, Until: until, Gaps: []Gap{}, Ratio: 1}
	var w where
	w.eq("cluster", cluster)
	var first time.Time
	var n uint64
	if err := s.conn.QueryRow(ctx, "SELECT min(ts), count() FROM recorder_heartbeats"+w.String(), w.args...).Scan(&first, &n); err != nil {
		return nil, err
	}
	if n == 0 {
		cov.Ratio = 0
		return cov, nil
	}
	cov.HasData = true
	if first.After(cov.Since) {
		cov.Since = first
	}
	if !cov.Until.After(cov.Since) {
		return cov, nil
	}

	// Each heartbeat with the one before it; the earliest row in range has
	// no predecessor and comes back with the zero time. A heartbeat from just
	// before the window is included so a gap that started outside it is seen.
	w.add("ts >= ?", cov.Since.Add(-threshold))
	w.add("ts <= ?", cov.Until)
	rows, err := s.conn.Query(ctx, `SELECT prev, prev_term, ts, term FROM (
		SELECT ts, term,
			lagInFrame(ts, 1) OVER (ORDER BY ts ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS prev,
			lagInFrame(term, 1) OVER (ORDER BY ts ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS prev_term
		FROM recorder_heartbeats`+w.String()+`
	) ORDER BY ts`, w.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var last time.Time
	for rows.Next() {
		var prev, ts time.Time
		var prevTerm, term string
		if err := rows.Scan(&prev, &prevTerm, &ts, &term); err != nil {
			return nil, err
		}
		switch {
		case last.IsZero() && ts.Sub(cov.Since) > threshold:
			// Nothing from the start of the window to the first heartbeat in it.
			cov.Gaps = append(cov.Gaps, Gap{From: cov.Since, To: ts})
		case prev.Unix() > 0 && (term != prevTerm || ts.Sub(prev) > threshold):
			cov.Gaps = append(cov.Gaps, Gap{From: prev, To: ts})
		}
		last = ts
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	switch {
	case last.IsZero():
		cov.Gaps = append(cov.Gaps, Gap{From: cov.Since, To: cov.Until, Open: true})
	case cov.Until.Sub(last) > threshold:
		cov.Gaps = append(cov.Gaps, Gap{From: last, To: cov.Until, Open: true})
	}
	for _, g := range cov.Gaps {
		from, to := g.From, g.To
		if from.Before(cov.Since) {
			from = cov.Since
		}
		cov.GapSeconds += to.Sub(from).Seconds()
	}
	if span := cov.Until.Sub(cov.Since).Seconds(); span > 0 {
		cov.Ratio = max(0, 1-cov.GapSeconds/span)
	}
	return cov, nil
}

// LastHints returns, per collector ("admission", "audit"), when it last sent a
// hint. Hints are kept a day, so a source quiet for longer is simply absent.
func (s *Store) LastHints(ctx context.Context, cluster string) (map[string]time.Time, error) {
	var w where
	w.eq("cluster", cluster)
	rows, err := s.conn.Query(ctx, "SELECT source, max(ts) FROM actor_hints"+w.String()+" GROUP BY source", w.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var src string
		var ts time.Time
		if err := rows.Scan(&src, &ts); err != nil {
			return nil, err
		}
		out[src] = ts
	}
	return out, rows.Err()
}

// AttributionCounts counts changes since a point in time by how their actor
// was found.
func (s *Store) AttributionCounts(ctx context.Context, cluster string, since time.Time) ([]Count, error) {
	var w where
	w.eq("cluster", cluster)
	w.add("event_time >= ?", since)
	return s.topN(ctx, "attribution", w, 10)
}
