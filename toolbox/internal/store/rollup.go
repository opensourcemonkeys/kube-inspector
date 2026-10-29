package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

// The overview reads whole hours from changes_hourly and only the partial
// hours at either end from changes. A window shorter than this, or charted in
// columns narrower than an hour, is read from changes alone: it is cheap
// enough, and the hourly rollup cannot draw it.
const rollupMinSpan = 24 * time.Hour

// rollupSpan is the run of whole hours in [since, until) that the rollup can
// answer for, and whether to use it. It is used only when the rollup covers
// the whole window: a window reaching back before the rollup started would
// leave a raw remainder of any size, which would cost more than it saves.
func (s *Store) rollupSpan(since, until time.Time, bucket time.Duration) (from, to time.Time, ok bool) {
	if s.rollupSince.IsZero() || until.Sub(since) < rollupMinSpan || bucket < time.Hour || bucket%time.Hour != 0 {
		return time.Time{}, time.Time{}, false
	}
	ceil := func(t time.Time) time.Time {
		if h := t.UTC().Truncate(time.Hour); h.Equal(t) {
			return h
		} else {
			return h.Add(time.Hour)
		}
	}
	from, to = ceil(since), until.UTC().Truncate(time.Hour)
	if ceil(s.rollupSince).After(from) || !from.Before(to) {
		return time.Time{}, time.Time{}, false
	}
	return from, to, true
}

// tally adds up a summary from both sources before it is shaped into Stats.
type tally struct {
	buckets              map[bucketKey]uint64
	resource, actor, ns  map[string]uint64
	changes, deletes, na uint64
}

type bucketKey struct {
	t    int64 // unix ms
	verb string
}

func newTally() *tally {
	return &tally{buckets: map[bucketKey]uint64{}, resource: map[string]uint64{}, actor: map[string]uint64{}, ns: map[string]uint64{}}
}

func (t *tally) add(bt time.Time, verb, attribution, resource, ns, actor string, n uint64) {
	t.buckets[bucketKey{bt.UnixMilli(), verb}] += n
	t.resource[resource] += n
	t.actor[actor] += n
	t.ns[ns] += n
	t.changes += n
	if verb == "delete" {
		t.deletes += n
	}
	if attribution == "none" {
		t.na += n
	}
}

func top(m map[string]uint64, n int) []Count {
	out := make([]Count, 0, len(m))
	for k, c := range m {
		out = append(out, Count{Key: k, Count: c})
	}
	// Ties broken by key, as statsRaw's ORDER BY c DESC, k does.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Key < out[j].Key
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// The same dimensions the materialized view stores, for the raw edges.
const rollupDims = `verb, attribution, if(api_group = '', resource, concat(resource, '.', api_group)) AS resource_key,
	namespace, if(username = '', concat('(', field_manager, ')'), username) AS actor`

// addEdges tallies the partial hours at a window's edges from changes, in one
// scan for all of them. It reads exactly what the materialized view would
// have: version 1 rows, without FINAL. The edges lie after the rollup
// started, where the correlator writes each change once, so FINAL would only
// cost a full sort-merge of the table for nothing.
func (s *Store) addEdges(ctx context.Context, t *tally, f StatsFilter, edges [][2]time.Time) error {
	var w where
	w.eq("cluster", f.Cluster)
	w.eq("namespace", f.Namespace)
	w.add("version = 1")
	var spans []string
	var args []any
	for _, e := range edges {
		if e[0].Before(e[1]) {
			spans = append(spans, "(event_time >= ? AND event_time < ?)")
			args = append(args, e[0], e[1])
		}
	}
	if len(spans) == 0 {
		return nil
	}
	w.add("("+strings.Join(spans, " OR ")+")", args...)
	rows, err := s.conn.Query(ctx, "SELECT toStartOfInterval(event_time, toIntervalSecond(?)) AS bt, "+rollupDims+
		", count() FROM changes"+w.String()+" GROUP BY bt, verb, attribution, resource_key, namespace, actor",
		append([]any{int64(f.Bucket.Seconds())}, w.args...)...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var bt time.Time
		var verb, attr, res, ns, actor string
		var n uint64
		if err := rows.Scan(&bt, &verb, &attr, &res, &ns, &actor, &n); err != nil {
			return err
		}
		t.add(bt, verb, attr, res, ns, actor, n)
	}
	return rows.Err()
}

// addRollup tallies whole hours [a, b) from changes_hourly, one small
// aggregate per part of the summary (the table is ordered by hour, so each
// reads only the window). No FINAL: unmerged SummingMergeTree rows add up
// the same under sum().
func (s *Store) addRollup(ctx context.Context, t *tally, f StatsFilter, a, b time.Time, totalsOnly bool) error {
	var w where
	w.eq("cluster", f.Cluster)
	w.eq("namespace", f.Namespace)
	w.add("hour >= ?", a)
	w.add("hour < ?", b)
	if err := s.conn.QueryRow(ctx, "SELECT sum(changes), sumIf(changes, verb = 'delete'), sumIf(changes, attribution = 'none') FROM changes_hourly"+
		w.String(), w.args...).Scan(&t.changes, &t.deletes, &t.na); err != nil {
		return err
	}
	if totalsOnly {
		return nil
	}
	rows, err := s.conn.Query(ctx, "SELECT toStartOfInterval(hour, toIntervalSecond(?)) AS bt, verb, sum(changes) FROM changes_hourly"+
		w.String()+" GROUP BY bt, verb", append([]any{int64(f.Bucket.Seconds())}, w.args...)...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var bt time.Time
		var verb string
		var n uint64
		if err := rows.Scan(&bt, &verb, &n); err != nil {
			rows.Close()
			return err
		}
		t.buckets[bucketKey{bt.UnixMilli(), verb}] += n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, d := range []struct {
		col string
		dst map[string]uint64
	}{{"resource_key", t.resource}, {"actor", t.actor}, {"namespace", t.ns}} {
		// Every key, not the top ten: the edges are added on top, and a key
		// just outside the rollup's ten may overtake one inside.
		rows, err := s.conn.Query(ctx, "SELECT "+d.col+", sum(changes) FROM changes_hourly"+w.String()+" GROUP BY "+d.col, w.args...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var k string
			var n uint64
			if err := rows.Scan(&k, &n); err != nil {
				rows.Close()
				return err
			}
			d.dst[k] += n
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	}
	return nil
}

// windowTally is a window's tally: the rollup for its whole hours, changes
// for the partial ones at either end.
func (s *Store) windowTally(ctx context.Context, f StatsFilter, from, to time.Time, totalsOnly bool) (*tally, error) {
	t := newTally()
	if err := s.addRollup(ctx, t, f, from, to, totalsOnly); err != nil {
		return nil, err
	}
	edge := newTally()
	if err := s.addEdges(ctx, edge, f, [][2]time.Time{{f.Since, from}, {to, f.Until}}); err != nil {
		return nil, err
	}
	t.merge(edge)
	return t, nil
}

func (t *tally) merge(o *tally) {
	for k, n := range o.buckets {
		t.buckets[k] += n
	}
	for _, p := range [][2]map[string]uint64{{t.resource, o.resource}, {t.actor, o.actor}, {t.ns, o.ns}} {
		for k, n := range p[1] {
			p[0][k] += n
		}
	}
	t.changes += o.changes
	t.deletes += o.deletes
	t.na += o.na
}

func (s *Store) statsHybrid(ctx context.Context, f StatsFilter, from, to time.Time) (*Stats, error) {
	t, err := s.windowTally(ctx, f, from, to, false)
	if err != nil {
		return nil, err
	}
	st := &Stats{Buckets: make([]Bucket, 0, len(t.buckets))}
	for k, n := range t.buckets {
		st.Buckets = append(st.Buckets, Bucket{Time: time.UnixMilli(k.t).UTC(), Verb: k.verb, Count: n})
	}
	sort.Slice(st.Buckets, func(i, j int) bool {
		if !st.Buckets[i].Time.Equal(st.Buckets[j].Time) {
			return st.Buckets[i].Time.Before(st.Buckets[j].Time)
		}
		return st.Buckets[i].Verb < st.Buckets[j].Verb
	})
	st.ByResource, st.ByUser, st.ByNamespace = top(t.resource, 10), top(t.actor, 10), top(t.ns, 10)
	st.Totals = Totals{Changes: t.changes, Deletes: t.deletes, Unattributed: t.na}
	if err := s.attemptTotal(ctx, &st.Totals, f.Cluster, f.Namespace, f.Since, f.Until); err != nil {
		return nil, err
	}

	// The period before, the same way when the rollup reaches back that far.
	span := f.Until.Sub(f.Since)
	prev := f
	prev.Since, prev.Until = f.Since.Add(-span), f.Since
	if pfrom, pto, ok := s.rollupSpan(prev.Since, prev.Until, prev.Bucket); ok {
		pt, err := s.windowTally(ctx, prev, pfrom, pto, true)
		if err != nil {
			return nil, err
		}
		st.Previous = Totals{Changes: pt.changes, Deletes: pt.deletes, Unattributed: pt.na}
	} else if err := s.changeTotals(ctx, &st.Previous, f.Cluster, f.Namespace, prev.Since, prev.Until); err != nil {
		return nil, err
	}
	if err := s.attemptTotal(ctx, &st.Previous, f.Cluster, f.Namespace, prev.Since, prev.Until); err != nil {
		return nil, err
	}
	return st, nil
}
