package store

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kubeinspector/toolbox/internal/config"
	"github.com/kubeinspector/toolbox/internal/model"
)

// These tests need a real ClickHouse: set CLICKHOUSE_TEST_ADDR (host:9000) and,
// if needed, CLICKHOUSE_TEST_PASSWORD. e.g.
//
//	docker run -d -p 19000:9000 -e CLICKHOUSE_PASSWORD=test clickhouse/clickhouse-server
//	CLICKHOUSE_TEST_ADDR=localhost:19000 CLICKHOUSE_TEST_PASSWORD=test go test ./internal/store/
func testStore(t *testing.T) *Store {
	t.Helper()
	addr := os.Getenv("CLICKHOUSE_TEST_ADDR")
	if addr == "" {
		t.Skip("CLICKHOUSE_TEST_ADDR not set")
	}
	cfg := config.ClickHouse{
		Addr:     []string{addr},
		Database: fmt.Sprintf("toolbox_test_%d", time.Now().UnixNano()),
		Username: "default",
		Password: os.Getenv("CLICKHOUSE_TEST_PASSWORD"),
	}
	ctx := context.Background()
	s, err := Open(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = s.conn.Exec(ctx, "DROP DATABASE "+quoteIdent(cfg.Database))
		_ = s.Close()
	})
	return s
}

func TestMigrateIsIdempotentAndRetentionApplies(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	if err := s.migrate(ctx); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	if err := s.EnsureRetention(ctx, config.Retention{ChangesDays: 7, AuditRawDays: 3}); err != nil {
		t.Fatal(err)
	}
	var engine string
	if err := s.conn.QueryRow(ctx, "SELECT engine_full FROM system.tables WHERE database = ? AND name = 'changes'", s.db).Scan(&engine); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(engine, "toIntervalDay(7)") {
		t.Fatalf("ttl not applied: %s", engine)
	}
	// Unchanged retention must be a no-op (no error, no ALTER).
	if err := s.EnsureRetention(ctx, config.Retention{ChangesDays: 7, AuditRawDays: 3}); err != nil {
		t.Fatal(err)
	}
}

func TestWriteAndQuery(t *testing.T) {
	s := testStore(t)
	ctx, cancel := context.WithCancel(context.Background())

	cw, hw, aw := s.ChangeWriter(), s.HintWriter(), s.AuditWriter()
	go cw.Run(ctx)
	go hw.Run(ctx)
	go aw.Run(ctx)

	base := time.Now().UTC().Truncate(time.Millisecond)
	id1, id2 := uuid.New(), uuid.New()
	change := func(id uuid.UUID, at time.Time, verb model.Verb, user string, ver uint32) model.Change {
		return model.Change{
			EventID: id, Version: ver, Time: at, Cluster: "c1", Verb: verb, Group: "apps", APIVersion: "v1",
			Resource: "deployments", Kind: "Deployment", Namespace: "ns", Name: "web", ObjectUID: "u1",
			Actor:       model.Actor{Username: user, Groups: []string{"g"}, SourceIPs: []string{"10.0.0.1"}, Extra: map[string][]string{"k": {"v"}}},
			Attribution: model.AttrAudit, ChangedPaths: []string{"/spec/replicas"}, Patch: "[]",
			Before: `{"a":1}`, After: `{"a":2}`,
		}
	}
	cw.Put(change(id1, base, model.VerbCreate, "", 1))
	cw.Put(change(id1, base, model.VerbCreate, "alice", 2)) // re-attribution replaces version 1
	cw.Put(change(id2, base.Add(time.Second), model.VerbUpdate, "bob", 1))
	hw.Put(model.Hint{ID: "h1", Source: model.HintAudit, Time: base, Cluster: "c1", Verb: model.VerbUpdate,
		Key:             model.ObjectKey{Group: "apps", Resource: "deployments", Namespace: "ns", Name: "web"},
		ResourceVersion: "42", Actor: model.Actor{Username: "bob", SourceIPs: []string{"1.2.3.4"}}})
	aw.Put(model.AuditRecord{Time: base, Cluster: "c1", AuditID: "a1", Verb: "delete", Resource: "pods",
		Namespace: "ns", Name: "p", Username: "eve", ResponseCode: 403, ResponseReason: "Forbidden"})

	cancel()
	<-cw.Done()
	<-hw.Done()
	<-aw.Done()
	qctx := context.Background()

	got, next, err := s.ListChanges(qctx, ChangeFilter{Cluster: "c1", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].EventID != id2 || next == "" {
		t.Fatalf("page 1 = %+v next=%q", got, next)
	}
	got, next, err = s.ListChanges(qctx, ChangeFilter{Cluster: "c1", Limit: 1, Cursor: next})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].EventID != id1 || got[0].Actor.Username != "alice" || next != "" {
		t.Fatalf("page 2 = %+v next=%q (FINAL should have kept version 2)", got, next)
	}
	if got[0].Actor.Extra["k"][0] != "v" || got[0].Before != "" {
		t.Fatalf("extra not round-tripped or objects leaked into list: %+v", got[0])
	}

	core := ""
	if got, _, _ := s.ListChanges(qctx, ChangeFilter{Group: &core}); len(got) != 0 {
		t.Fatalf("core group filter matched apps rows: %d", len(got))
	}
	if got, _, _ := s.ListChanges(qctx, ChangeFilter{User: "bob", Path: "/spec"}); len(got) != 1 {
		t.Fatalf("user+path filter: %d", len(got))
	}
	if got, _, _ := s.ListChanges(qctx, ChangeFilter{Q: "WE"}); len(got) != 2 {
		t.Fatalf("q filter: %d", len(got))
	}

	full, err := s.GetChange(qctx, id1)
	if err != nil || full.After != `{"a":2}` {
		t.Fatalf("GetChange = %+v, %v", full, err)
	}
	if _, err := s.GetChange(qctx, uuid.New()); err != ErrNotFound {
		t.Fatalf("missing change: %v", err)
	}

	hints, err := s.HintsFor(qctx, "c1", []string{"web"}, base.Add(-time.Minute), base.Add(time.Minute))
	if err != nil || len(hints) != 1 || hints[0].Actor.SourceIPs[0] != "1.2.3.4" || hints[0].ResourceVersion != "42" {
		t.Fatalf("HintsFor = %+v, %v", hints, err)
	}

	att, err := s.ListAttempts(qctx, AttemptFilter{Cluster: "c1", MinCode: 400})
	if err != nil || len(att) != 1 || att[0].Username != "eve" {
		t.Fatalf("ListAttempts = %+v, %v", att, err)
	}

	st, err := s.Stats(qctx, "c1", base.Add(-time.Hour), time.Hour)
	if err != nil || len(st.Buckets) == 0 || len(st.ByUser) != 2 {
		t.Fatalf("Stats = %+v, %v", st, err)
	}
	users, err := s.Users(qctx, "c1", base.Add(-time.Hour), 10)
	if err != nil || len(users) != 2 {
		t.Fatalf("Users = %+v, %v", users, err)
	}
}
