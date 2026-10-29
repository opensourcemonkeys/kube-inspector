//go:build bench

package store

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"
)

// TestReadLatency loads synthetic changes and times every read the API makes.
// It is a report, not a gate: run it with `make bench-store` (50M rows by
// default, TOOLBOX_BENCH_ROWS to change) and read the log. Set
// TOOLBOX_BENCH_MAX (a duration) to fail when a query is slower.
//
// Rows are spread over 90 days across 10 resources, 200 namespaces and 20,000
// names. As in a real cluster, who writes depends on what is written: the
// user (one of 500, or none for a quarter) follows from the resource and
// namespace, and the attribution from the user. Uniformly random actors
// would make every hourly rollup row unique, which no cluster does.
func TestReadLatency(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	rows := 50_000_000
	if v := os.Getenv("TOOLBOX_BENCH_ROWS"); v != "" {
		rows, _ = strconv.Atoi(v)
	}
	start := time.Now()
	// In chunks: with the rollup's view on every insert, one 50M-row insert
	// outlasts the driver's 5-minute read timeout.
	const chunk = 5_000_000
	for done := 0; done < rows; done += chunk {
		n := min(chunk, rows-done)
		if err := s.loadSynthetic(ctx, n); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("loaded %d rows in %s", rows, time.Since(start).Round(time.Second))
	// Background merges right after a bulk load take every core; timing
	// against them measures the merges. A running toolbox is past them.
	start = time.Now()
	for {
		var merging uint64
		if err := s.conn.QueryRow(ctx, "SELECT count() FROM system.merges WHERE database = ?", s.db).Scan(&merging); err != nil {
			t.Fatal(err)
		}
		if merging == 0 {
			break
		}
		time.Sleep(2 * time.Second)
	}
	t.Logf("merges settled in %s", time.Since(start).Round(time.Second))
	var rollupRows uint64
	if err := s.conn.QueryRow(ctx, "SELECT count() FROM changes_hourly").Scan(&rollupRows); err != nil {
		t.Fatal(err)
	}
	t.Logf("rollup holds %d rows", rollupRows)
	// The load went through the materialized view; it has covered it all.
	s.rollupSince = time.Now().Add(-100 * 24 * time.Hour)

	now := time.Now()
	ago := func(d time.Duration) time.Time { return now.Add(-d) }
	day := 24 * time.Hour
	list := func(f ChangeFilter) func() error {
		return func() error { f.Cluster, f.Limit = "prod", 100; _, _, err := s.ListChanges(ctx, f); return err }
	}
	deployments := ""
	cases := []struct {
		name string
		run  func() error
	}{
		{"list 24h", list(ChangeFilter{Since: ago(day)})},
		{"list 30d", list(ChangeFilter{Since: ago(30 * day)})},
		{"list all time", list(ChangeFilter{})},
		{"search q 30d", list(ChangeFilter{Q: "obj-1234", Since: ago(30 * day)})},
		{"user, all time", list(ChangeFilter{User: "user-42"})},
		{"path 7d", list(ChangeFilter{Path: "/spec/replicas", Since: ago(7 * day)})},
		{"object history", list(ChangeFilter{Group: &deployments, Resource: "deployments", Namespace: "ns-7", Name: "obj-777"})},
		{"stats 7d (rollup)", func() error {
			_, err := s.Stats(ctx, StatsFilter{Cluster: "prod", Since: ago(7 * day), Until: now, Bucket: 6 * time.Hour})
			return err
		}},
		{"stats 90d (rollup)", func() error {
			_, err := s.Stats(ctx, StatsFilter{Cluster: "prod", Since: ago(90 * day), Until: now, Bucket: day})
			return err
		}},
		{"stats 7d, changes only", func() error {
			_, err := s.statsRaw(ctx, StatsFilter{Cluster: "prod", Since: ago(7 * day), Until: now, Bucket: 6 * time.Hour})
			return err
		}},
		{"stats 90d, changes only", func() error {
			_, err := s.statsRaw(ctx, StatsFilter{Cluster: "prod", Since: ago(90 * day), Until: now, Bucket: day})
			return err
		}},
		{"users 7d", func() error { _, err := s.Users(ctx, "prod", ago(7*day), 100); return err }},
	}
	var limit time.Duration
	if v := os.Getenv("TOOLBOX_BENCH_MAX"); v != "" {
		limit, _ = time.ParseDuration(v)
	}
	for _, c := range cases {
		best := time.Duration(1<<63 - 1)
		for i := 0; i < 3; i++ {
			t0 := time.Now()
			if err := c.run(); err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
			best = min(best, time.Since(t0))
		}
		t.Logf("%-22s %8s", c.name, best.Round(time.Millisecond))
		if limit > 0 && best > limit {
			t.Errorf("%s took %s, over TOOLBOX_BENCH_MAX %s", c.name, best, limit)
		}
	}
}

// loadSynthetic inserts n generated changes (see TestReadLatency).
func (s *Store) loadSynthetic(ctx context.Context, n int) error {
	return s.conn.Exec(ctx, `INSERT INTO changes (event_id, version, event_time, cluster, verb, api_group, api_version,
		resource, kind, namespace, name, object_uid, resource_version, username, groups, source_ips, user_agent,
		field_manager, attribution, changed_paths, patch)
	SELECT generateUUIDv4(), 1, now64(3) - toIntervalMillisecond(rand(1) % (90*86400000)), 'prod',
		['create','update','update','update','update','delete','finalized'][1 + rand(2) % 7],
		['', 'apps', 'batch', 'networking.k8s.io', 'rbac.authorization.k8s.io'][1 + r % 5], 'v1',
		['pods','deployments','replicasets','configmaps','secrets','services','jobs','ingresses','roles','statefulsets'][1 + r],
		'Kind', concat('ns-', toString(n)), concat('obj-', toString(rand(6) % 20000)),
		toString(generateUUIDv4()), toString(number), user, ['system:authenticated'], ['10.0.0.1'], 'kubectl/v1.31',
		'kubectl-client-side-apply', ['audit','admission','managedFields','none'][1 + cityHash64(user) % 4],
		['/spec/replicas', '/metadata/labels/app'],
		'[{"op":"test","path":"/spec/replicas","value":2},{"op":"replace","path":"/spec/replicas","value":3}]'
	FROM (
		SELECT number, r, n,
			if(cityHash64(r, n) % 4 = 0, '', concat('user-', toString(cityHash64(r, n, rand(8) % 3) % 500))) AS user
		FROM (SELECT number, rand(4) % 10 AS r, rand(5) % 200 AS n FROM numbers(`+strconv.Itoa(n)+`))
	) SETTINGS max_insert_threads = 8, max_partitions_per_insert_block = 1000`)
}
