package store

import (
	"context"
	"testing"
	"time"
)

func TestCoverageFindsGaps(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	beat := func(off time.Duration) {
		t.Helper()
		if err := s.WriteHeartbeat(ctx, Heartbeat{Time: t0.Add(off), Cluster: "prod", Identity: "toolbox-0", WatchedResources: 40}); err != nil {
			t.Fatal(err)
		}
	}
	// Every 15s for 2 minutes, then silence for 5 minutes, then 2 more minutes.
	for off := time.Duration(0); off <= 2*time.Minute; off += 15 * time.Second {
		beat(off)
	}
	for off := 7 * time.Minute; off <= 9*time.Minute; off += 15 * time.Second {
		beat(off)
	}
	// Another cluster's leader must not fill this cluster's gap.
	if err := s.WriteHeartbeat(ctx, Heartbeat{Time: t0.Add(4 * time.Minute), Cluster: "other", Identity: "x"}); err != nil {
		t.Fatal(err)
	}

	cov, err := s.Coverage(ctx, "prod", t0.Add(-time.Hour), t0.Add(9*time.Minute), 45*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// The window starts at the first heartbeat ever kept, not an hour back.
	if !cov.HasData || !cov.Since.Equal(t0) {
		t.Fatalf("since = %v hasData = %v", cov.Since, cov.HasData)
	}
	if len(cov.Gaps) != 1 || !cov.Gaps[0].From.Equal(t0.Add(2*time.Minute)) || !cov.Gaps[0].To.Equal(t0.Add(7*time.Minute)) || cov.Gaps[0].Open {
		t.Fatalf("gaps = %+v", cov.Gaps)
	}
	if cov.GapSeconds != 300 || cov.Ratio < 0.44 || cov.Ratio > 0.45 {
		t.Fatalf("gapSeconds = %v ratio = %v", cov.GapSeconds, cov.Ratio)
	}

	// Asked about a later moment, the leader has been silent since 12:09.
	cov, err = s.Coverage(ctx, "prod", t0, t0.Add(20*time.Minute), 45*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(cov.Gaps); n != 2 || !cov.Gaps[1].Open || !cov.Gaps[1].From.Equal(t0.Add(9*time.Minute)) {
		t.Fatalf("gaps = %+v", cov.Gaps)
	}

	// A window that starts inside the gap still sees it.
	cov, err = s.Coverage(ctx, "prod", t0.Add(4*time.Minute), t0.Add(9*time.Minute), 45*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(cov.Gaps) != 1 || cov.GapSeconds != 180 {
		t.Fatalf("gaps = %+v seconds = %v", cov.Gaps, cov.GapSeconds)
	}

	last, err := s.LastHeartbeat(ctx, "prod")
	if err != nil || last == nil || !last.Time.Equal(t0.Add(9*time.Minute)) || last.WatchedResources != 40 {
		t.Fatalf("last = %+v err = %v", last, err)
	}
}

func TestCoverageWithoutHeartbeats(t *testing.T) {
	s := testStore(t)
	cov, err := s.Coverage(context.Background(), "prod", time.Now().Add(-time.Hour), time.Now(), 45*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if cov.HasData || len(cov.Gaps) != 0 {
		t.Fatalf("cov = %+v", cov)
	}
	if last, err := (s.LastHeartbeat(context.Background(), "prod")); err != nil || last != nil {
		t.Fatalf("last = %v err = %v", last, err)
	}
}

func TestCoverageCountsEveryTermChange(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	beat := func(off time.Duration, term string) {
		t.Helper()
		if err := s.WriteHeartbeat(ctx, Heartbeat{Time: t0.Add(off), Cluster: "prod", Identity: "toolbox-0", Term: term}); err != nil {
			t.Fatal(err)
		}
	}
	// Term a every 15s for a minute; then, 20s later — under the 45s
	// threshold, a container restart in the same pod — term b takes over.
	for off := time.Duration(0); off <= time.Minute; off += 15 * time.Second {
		beat(off, "a")
	}
	for off := 80 * time.Second; off <= 2*time.Minute; off += 15 * time.Second {
		beat(off+250*time.Millisecond, "b")
	}
	cov, err := s.Coverage(ctx, "prod", t0, t0.Add(2*time.Minute+time.Second), 45*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	want := Gap{From: t0.Add(time.Minute), To: t0.Add(80*time.Second + 250*time.Millisecond)}
	if len(cov.Gaps) != 1 || !cov.Gaps[0].From.Equal(want.From) || !cov.Gaps[0].To.Equal(want.To) {
		t.Fatalf("gaps = %+v, want the term change %+v", cov.Gaps, want)
	}
	// Milliseconds survive the round trip (they were bound at second precision).
	last, err := s.LastHeartbeat(ctx, "prod")
	if err != nil || last.Time.Nanosecond() == 0 || last.Term != "b" {
		t.Fatalf("last = %+v err = %v", last, err)
	}
}
