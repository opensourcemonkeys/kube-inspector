package store

import (
	"context"
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kubeinspector/toolbox/internal/model"
)

// The hourly rollup with raw edges must give exactly what scanning changes
// gives, for windows that start and end mid-hour, with and without a
// namespace filter.
func TestStatsRollupMatchesRaw(t *testing.T) {
	s := testStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cw := s.ChangeWriter()
	go cw.Run(ctx)

	now := time.Now().UTC()
	rng := rand.New(rand.NewSource(7))
	verbs := []model.Verb{model.VerbCreate, model.VerbUpdate, model.VerbUpdate, model.VerbDelete, model.VerbFinalized}
	attrs := []model.Attribution{model.AttrAudit, model.AttrAdmission, model.AttrManagedFields, model.AttrNone}
	for i := 0; i < 3000; i++ {
		at := now.Add(-time.Duration(rng.Int63n(int64(8 * 24 * time.Hour)))).Truncate(time.Millisecond)
		user := ""
		if rng.Intn(4) > 0 {
			user = fmt.Sprintf("user-%d", rng.Intn(6))
		}
		group := []string{"", "apps", "batch"}[rng.Intn(3)]
		cw.Put(model.Change{
			EventID: uuid.New(), Version: 1, Time: at, Cluster: "c1", Verb: verbs[rng.Intn(len(verbs))],
			Group: group, APIVersion: "v1", Resource: []string{"pods", "deployments", "jobs"}[rng.Intn(3)], Kind: "K",
			Namespace: fmt.Sprintf("ns-%d", rng.Intn(4)), Name: fmt.Sprintf("o-%d", rng.Intn(50)),
			Actor: model.Actor{Username: user}, FieldManager: []string{"kubectl", "helm"}[rng.Intn(2)],
			Attribution: attrs[rng.Intn(len(attrs))],
		})
	}
	cancel()
	<-cw.Done()
	// The rows above are in the rollup (the view runs on insert); say it has
	// been filling all along.
	s.rollupSince = now.Add(-30 * 24 * time.Hour)
	ctx = context.Background()

	for _, f := range []StatsFilter{
		{Cluster: "c1", Since: now.Add(-7*24*time.Hour + 17*time.Minute), Until: now.Add(-23 * time.Minute), Bucket: 6 * time.Hour},
		{Cluster: "c1", Since: now.Add(-3 * 24 * time.Hour), Until: now, Bucket: time.Hour},
		{Cluster: "c1", Namespace: "ns-2", Since: now.Add(-2 * 24 * time.Hour), Until: now, Bucket: 24 * time.Hour},
	} {
		if _, _, ok := s.rollupSpan(f.Since, f.Until, f.Bucket); !ok {
			t.Fatalf("%+v: rollup not used", f)
		}
		raw, err := s.statsRaw(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		got, err := s.Stats(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		for _, st := range []*Stats{raw, got} {
			sort.Slice(st.Buckets, func(i, j int) bool {
				if !st.Buckets[i].Time.Equal(st.Buckets[j].Time) {
					return st.Buckets[i].Time.Before(st.Buckets[j].Time)
				}
				return st.Buckets[i].Verb < st.Buckets[j].Verb
			})
			for i := range st.Buckets {
				st.Buckets[i].Time = st.Buckets[i].Time.UTC()
			}
		}
		if raw.Totals.Changes == 0 {
			t.Fatalf("%+v: empty window proves nothing", f)
		}
		if !reflect.DeepEqual(raw, got) {
			t.Fatalf("%+v:\nraw    %+v\nrollup %+v", f, raw, got)
		}
	}

	// Shorter than a day, narrower than an hour, or reaching back before the
	// rollup started: read from changes alone.
	for _, c := range []struct {
		since  time.Time
		bucket time.Duration
	}{
		{now.Add(-12 * time.Hour), time.Hour},
		{now.Add(-7 * 24 * time.Hour), 30 * time.Minute},
		{now.Add(-60 * 24 * time.Hour), 24 * time.Hour},
	} {
		if _, _, ok := s.rollupSpan(c.since, now, c.bucket); ok {
			t.Fatalf("rollup used for since=%v bucket=%v", c.since, c.bucket)
		}
	}
	s.rollupSince = time.Time{}
	if _, _, ok := s.rollupSpan(now.Add(-7*24*time.Hour), now, time.Hour); ok {
		t.Fatal("rollup used before it exists")
	}
}

func TestRollupStartIsRecorded(t *testing.T) {
	s := testStore(t)
	if s.rollupSince.IsZero() || time.Since(s.rollupSince) > time.Minute {
		t.Fatalf("rollupSince = %v", s.rollupSince)
	}
}
