package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kubeinspector/toolbox/internal/model"
	"github.com/kubeinspector/toolbox/internal/store"
)

type fakeStore struct {
	lastFilter store.ChangeFilter
	cursorErr  bool
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

func (f *fakeStore) ListAttempts(context.Context, store.AttemptFilter) ([]model.AuditRecord, error) {
	return nil, nil
}

func (f *fakeStore) Stats(context.Context, string, time.Time, time.Duration) (*store.Stats, error) {
	return &store.Stats{}, nil
}

func (f *fakeStore) Users(context.Context, string, time.Time, int) ([]store.UserSummary, error) {
	return nil, nil
}

func setup() (*fakeStore, http.Handler) {
	fs := &fakeStore{}
	s := &Server{Store: fs, Cluster: "prod", Token: "t0k", Now: func() time.Time { return time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC) }}
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
