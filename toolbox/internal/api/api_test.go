package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kubeinspector/toolbox/internal/model"
	"github.com/kubeinspector/toolbox/internal/store"
)

type fakeStore struct {
	lastFilter store.ChangeFilter
	cursorErr  bool
	// health
	coverageArgs []any
	lastStats    store.StatsFilter
	lastAttempts store.AttemptFilter
	// stream
	mu          sync.Mutex
	recent      []model.Change
	streamSince time.Time
	hintsErr    error
}

func (f *fakeStore) ListChanges(_ context.Context, cf store.ChangeFilter) ([]model.Change, string, error) {
	f.lastFilter = cf
	if f.cursorErr {
		return nil, "", store.ErrBadCursor
	}
	return []model.Change{{Name: "web"}}, "next", nil
}

func (f *fakeStore) GetChange(context.Context, uuid.UUID) (*model.Change, error) {
	return nil, store.ErrNotFound
}

func (f *fakeStore) ListAttempts(_ context.Context, af store.AttemptFilter) ([]model.AuditRecord, string, error) {
	f.lastAttempts = af
	if af.Cursor == "bad" {
		return nil, "", store.ErrBadCursor
	}
	return []model.AuditRecord{{Name: "p"}}, "next", nil
}

func (f *fakeStore) Stats(_ context.Context, sf store.StatsFilter) (*store.Stats, error) {
	f.lastStats = sf
	return &store.Stats{}, nil
}

func (f *fakeStore) Users(context.Context, string, time.Time, int) ([]store.UserSummary, error) {
	return nil, nil
}

func (f *fakeStore) Coverage(_ context.Context, cluster string, since, until time.Time, threshold time.Duration) (*store.Coverage, error) {
	f.coverageArgs = []any{cluster, since, until, threshold}
	return &store.Coverage{Since: since, Until: until, HasData: true, Ratio: 1, Gaps: []store.Gap{}}, nil
}

func (f *fakeStore) LastHeartbeat(context.Context, string) (*store.Heartbeat, error) {
	return &store.Heartbeat{Identity: "toolbox-0", WatchedResources: 12}, nil
}

func (f *fakeStore) LastHints(context.Context, string) (map[string]time.Time, error) {
	if f.hintsErr != nil {
		return nil, f.hintsErr
	}
	return map[string]time.Time{"admission": time.Date(2026, 10, 25, 11, 59, 0, 0, time.UTC)}, nil
}

func (f *fakeStore) AttributionCounts(context.Context, string, time.Time) ([]store.Count, error) {
	return []store.Count{{Key: "admission", Count: 3}}, nil
}

func (f *fakeStore) RecentChanges(_ context.Context, cf store.ChangeFilter, since time.Time, seen map[uuid.UUID]time.Time, _ int) ([]model.Change, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastFilter, f.streamSince = cf, since
	var out []model.Change
	for _, c := range f.recent {
		if _, ok := seen[c.EventID]; !ok {
			out = append(out, c)
		}
	}
	return out, nil
}

func setup() (*fakeStore, http.Handler) {
	fs := &fakeStore{}
	s := &Server{Store: fs, Cluster: "prod", Token: "t0k", Now: func() time.Time { return time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC) },
		Recording: Recording{AdmissionWebhook: true, AuditWebhook: true, GapThreshold: time.Minute, ChangesDays: 90},
		Leader:    func(context.Context) (*LeaderInfo, error) { return &LeaderInfo{Identity: "toolbox-0"}, nil }}
	mux := http.NewServeMux()
	s.Routes(mux)
	return fs, mux
}

func get(h http.Handler, path string, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set(TokenHeader, token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAuth(t *testing.T) {
	_, h := setup()
	if rec := get(h, "/api/v1/changes", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := get(h, "/api/v1/changes", "wrong"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/changes", nil)
	req.Header.Set("Authorization", "Bearer t0k")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("bearer token: %d", rec.Code)
	}
}

func TestListFilters(t *testing.T) {
	fs, h := setup()
	rec := get(h, "/api/v1/changes?group=core&resource=configmaps&since=1h&limit=5&user=alice", "t0k")
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	f := fs.lastFilter
	if f.Cluster != "prod" || f.Group == nil || *f.Group != "" || f.Resource != "configmaps" || f.Limit != 5 ||
		f.User != "alice" || !f.Since.Equal(time.Date(2026, 10, 25, 11, 0, 0, 0, time.UTC)) {
		t.Fatalf("filter = %+v", f)
	}
	var body changeList
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if len(body.Items) != 1 || body.NextCursor != "next" {
		t.Fatalf("body = %s", rec.Body)
	}

	get(h, "/api/v1/changes?cluster=*", "t0k")
	if fs.lastFilter.Cluster != "" || fs.lastFilter.Group != nil {
		t.Fatalf("cluster=* / absent group: %+v", fs.lastFilter)
	}

	for _, bad := range []string{"limit=0", "limit=x", "since=yesterday"} {
		if rec := get(h, "/api/v1/changes?"+bad, "t0k"); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d", bad, rec.Code)
		}
	}
	fs.cursorErr = true
	if rec := get(h, "/api/v1/changes?cursor=zzz", "t0k"); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad cursor: %d", rec.Code)
	}
}

func TestHistoryPath(t *testing.T) {
	fs, h := setup()
	if rec := get(h, "/api/v1/objects/rbac.authorization.k8s.io/v1/clusterroles/_/admin/history", "t0k"); rec.Code != http.StatusOK {
		t.Fatalf("%d", rec.Code)
	}
	f := fs.lastFilter
	if *f.Group != "rbac.authorization.k8s.io" || f.Resource != "clusterroles" || f.Namespace != "" || f.Name != "admin" {
		t.Fatalf("filter = %+v", f)
	}
	get(h, "/api/v1/objects/core/v1/pods/ns/p/history", "t0k")
	if *fs.lastFilter.Group != "" || fs.lastFilter.Namespace != "ns" {
		t.Fatalf("filter = %+v", fs.lastFilter)
	}
}

func TestGetChange(t *testing.T) {
	_, h := setup()
	if rec := get(h, "/api/v1/changes/not-a-uuid", "t0k"); rec.Code != http.StatusBadRequest {
		t.Fatalf("%d", rec.Code)
	}
	if rec := get(h, "/api/v1/changes/"+uuid.NewString(), "t0k"); rec.Code != http.StatusNotFound {
		t.Fatalf("%d", rec.Code)
	}
}

func TestHealth(t *testing.T) {
	fs, h := setup()
	rec := get(h, "/api/v1/health", "t0k")
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var body struct {
		Sources struct {
			Admission, Audit struct {
				Enabled  bool       `json:"enabled"`
				LastSeen *time.Time `json:"lastSeen"`
			}
		} `json:"sources"`
		Leader      *LeaderInfo      `json:"leader"`
		Recorder    *store.Heartbeat `json:"recorder"`
		Coverage    *store.Coverage  `json:"coverage"`
		Attribution []store.Count    `json:"attribution"`
		Recording   Recording        `json:"recording"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Sources.Admission.LastSeen == nil || body.Sources.Audit.LastSeen != nil || !body.Sources.Audit.Enabled {
		t.Fatalf("sources = %+v", body.Sources)
	}
	if body.Leader == nil || body.Leader.Identity != "toolbox-0" || body.Recorder == nil || body.Recorder.WatchedResources != 12 {
		t.Fatalf("leader/recorder = %+v %+v", body.Leader, body.Recorder)
	}
	if body.Coverage == nil || len(body.Attribution) != 1 || body.Recording.ChangesDays != 90 {
		t.Fatalf("body = %s", rec.Body)
	}
	// Seven days back with the configured threshold.
	if fs.coverageArgs[1] != time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) || fs.coverageArgs[3] != time.Minute {
		t.Fatalf("coverage args = %v", fs.coverageArgs)
	}

	// One part failing leaves it out instead of failing the report.
	fs.hintsErr = context.DeadlineExceeded
	if rec := get(h, "/api/v1/health", "t0k"); rec.Code != http.StatusOK {
		t.Fatalf("partial failure: %d", rec.Code)
	}
}

func TestGaps(t *testing.T) {
	fs, h := setup()
	if rec := get(h, "/api/v1/gaps?since=1h", "t0k"); rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if fs.coverageArgs[1] != time.Date(2026, 10, 25, 11, 0, 0, 0, time.UTC) || fs.coverageArgs[2] != time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC) {
		t.Fatalf("args = %v", fs.coverageArgs)
	}
	if rec := get(h, "/api/v1/gaps?since=1h&until=2h", "t0k"); rec.Code != http.StatusBadRequest {
		t.Fatalf("until before since: %d", rec.Code)
	}
	if rec := get(h, "/api/v1/gaps", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", rec.Code)
	}
}

func TestStatsParams(t *testing.T) {
	fs, h := setup()
	if rec := get(h, "/api/v1/stats?since=2h&until=1h&bucket=5m&namespace=prod", "t0k"); rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	f := fs.lastStats
	if f.Namespace != "prod" || f.Bucket != 5*time.Minute || !f.Since.Equal(time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)) ||
		!f.Until.Equal(time.Date(2026, 10, 25, 11, 0, 0, 0, time.UTC)) {
		t.Fatalf("filter = %+v", f)
	}
	for _, bad := range []string{"since=1h&until=2h", "since=720h&bucket=1m", "bucket=30s"} {
		if rec := get(h, "/api/v1/stats?"+bad, "t0k"); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d", bad, rec.Code)
		}
	}
}

func TestAttemptsPage(t *testing.T) {
	fs, h := setup()
	rec := get(h, "/api/v1/attempts?cursor=abc&limit=10", "t0k")
	if rec.Code != http.StatusOK || fs.lastAttempts.Cursor != "abc" || fs.lastAttempts.Limit != 10 {
		t.Fatalf("%d %+v", rec.Code, fs.lastAttempts)
	}
	var body attemptList
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if len(body.Items) != 1 || body.NextCursor != "next" {
		t.Fatalf("body = %s", rec.Body)
	}
	if rec := get(h, "/api/v1/attempts?cursor=bad", "t0k"); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad cursor: %d", rec.Code)
	}
}

func TestStreamSendsEachChangeOnce(t *testing.T) {
	fs := &fakeStore{}
	srv := &Server{Store: fs, Cluster: "prod", Token: "t0k", StreamPoll: 10 * time.Millisecond, StreamLookback: 3 * time.Minute}
	mux := http.NewServeMux()
	srv.Routes(mux)
	ts := httptest.NewServer(mux)
	defer ts.Close()
	a, b := uuid.New(), uuid.New()
	fs.recent = []model.Change{{EventID: a, Name: "web"}}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/v1/changes/stream?namespace=prod-ns", nil)
	req.Header.Set(TokenHeader, "t0k")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	sc := bufio.NewScanner(res.Body)
	next := func() model.Change {
		t.Helper()
		for sc.Scan() {
			if data, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				var c model.Change
				if err := json.Unmarshal([]byte(data), &c); err != nil {
					t.Fatal(err)
				}
				return c
			}
		}
		t.Fatalf("stream ended: %v", sc.Err())
		return model.Change{}
	}
	if c := next(); c.EventID != a {
		t.Fatalf("first = %+v", c)
	}
	// A later poll sends only what is new.
	fs.mu.Lock()
	fs.recent = append(fs.recent, model.Change{EventID: b, Name: "api"})
	fs.mu.Unlock()
	if c := next(); c.EventID != b {
		t.Fatalf("second = %+v (a resent?)", c)
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if fs.lastFilter.Namespace != "prod-ns" || time.Since(fs.streamSince) < 3*time.Minute-time.Second {
		t.Fatalf("filter = %+v since = %v", fs.lastFilter, fs.streamSince)
	}
}

func TestStreamRouteDoesNotShadowChangeID(t *testing.T) {
	_, h := setup()
	if rec := get(h, "/api/v1/changes/"+uuid.NewString(), "t0k"); rec.Code != http.StatusNotFound {
		t.Fatalf("change by id: %d", rec.Code)
	}
}
