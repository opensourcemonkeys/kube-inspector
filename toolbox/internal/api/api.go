// Package api serves the REST API Kube Inspector (and the bundled UI) reads
// change history from. Every endpoint is a GET over the store; nothing here
// writes.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/kubeinspector/toolbox/internal/model"
	"github.com/kubeinspector/toolbox/internal/store"
)

// TokenHeader carries the API token. Not Authorization: Kube Inspector reaches
// the API through the API server's service proxy with the user's own
// credentials, and the proxy consumes Authorization for itself.
const TokenHeader = "X-Toolbox-Token"

// Store is what the API reads; *store.Store implements it.
type Store interface {
	ListChanges(ctx context.Context, f store.ChangeFilter) ([]model.Change, string, error)
	GetChange(ctx context.Context, id uuid.UUID) (*model.Change, error)
	ListAttempts(ctx context.Context, f store.AttemptFilter) ([]model.AuditRecord, error)
	Stats(ctx context.Context, cluster string, since time.Time, bucket time.Duration) (*store.Stats, error)
	Users(ctx context.Context, cluster string, since time.Time, limit int) ([]store.UserSummary, error)
}

type Server struct {
	Store   Store
	Cluster string // the default for ?cluster=; "*" in a request means all clusters
	Token   string // empty disables authentication
	Version string
	Now     func() time.Time
}

// Routes registers the API under /api/v1 on mux.
func (s *Server) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/info", s.auth(s.info))
	mux.Handle("GET /api/v1/changes", s.auth(s.listChanges))
	mux.Handle("GET /api/v1/changes/{id}", s.auth(s.getChange))
	mux.Handle("GET /api/v1/objects/{group}/{version}/{resource}/{namespace}/{name}/history", s.auth(s.history))
	mux.Handle("GET /api/v1/attempts", s.auth(s.attempts))
	mux.Handle("GET /api/v1/stats", s.auth(s.stats))
	mux.Handle("GET /api/v1/users", s.auth(s.users))
}

type handlerFunc func(w http.ResponseWriter, r *http.Request) error

// httpError is an error with a status code a handler wants returned as is.
type httpError struct {
	code int
	msg  string
}

func (e *httpError) Error() string { return e.msg }

func badRequest(msg string) error { return &httpError{http.StatusBadRequest, msg} }

func (s *Server) auth(h handlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Token != "" {
			got := r.Header.Get(TokenHeader)
			if got == "" {
				got = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			}
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.Token)) != 1 {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing or invalid " + TokenHeader})
				return
			}
		}
		if err := h(w, r); err != nil {
			var he *httpError
			switch {
			case errors.As(err, &he):
				writeJSON(w, he.code, map[string]string{"error": he.msg})
			case errors.Is(err, store.ErrNotFound):
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			default:
				slog.Error("api request failed", "path", r.URL.Path, "err", err)
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			}
		}
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) info(w http.ResponseWriter, _ *http.Request) error {
	writeJSON(w, http.StatusOK, map[string]string{"cluster": s.Cluster, "version": s.Version})
	return nil
}

// cluster resolves ?cluster=: absent means this cluster, "*" means all.
func (s *Server) cluster(r *http.Request) string {
	switch c := r.URL.Query().Get("cluster"); c {
	case "":
		return s.Cluster
	case "*":
		return ""
	default:
		return c
	}
}

// parseTime accepts RFC 3339 or a duration meaning "that long ago" ("24h").
func (s *Server) parseTime(v string) (time.Time, error) {
	if v == "" {
		return time.Time{}, nil
	}
	if d, err := time.ParseDuration(v); err == nil {
		return s.now().Add(-d), nil
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return time.Time{}, badRequest("time must be RFC 3339 or a duration like 24h: " + v)
	}
	return t, nil
}

func parseLimit(v string) (int, error) {
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > 1000 {
		return 0, badRequest("limit must be 1..1000")
	}
	return n, nil
}

// group maps the history path's placeholder "core" to the empty API group.
func group(v string) string {
	if v == "core" {
		return ""
	}
	return v
}

type changeList struct {
	Items      []model.Change `json:"items"`
	NextCursor string         `json:"nextCursor,omitempty"`
}

func (s *Server) changeFilter(r *http.Request) (store.ChangeFilter, error) {
	q := r.URL.Query()
	f := store.ChangeFilter{
		Cluster: s.cluster(r), Resource: q.Get("resource"), Kind: q.Get("kind"), Namespace: q.Get("namespace"),
		Name: q.Get("name"), ObjectUID: q.Get("uid"), User: q.Get("user"), Verb: q.Get("verb"),
		Attribution: q.Get("attribution"), Path: q.Get("path"), Q: q.Get("q"), Cursor: q.Get("cursor"),
		WithObjects: q.Get("objects") == "true",
	}
	if q.Has("group") {
		g := group(q.Get("group"))
		f.Group = &g
	}
	var err error
	if f.Since, err = s.parseTime(q.Get("since")); err != nil {
		return f, err
	}
	if f.Until, err = s.parseTime(q.Get("until")); err != nil {
		return f, err
	}
	if f.Limit, err = parseLimit(q.Get("limit")); err != nil {
		return f, err
	}
	return f, nil
}

func (s *Server) listChanges(w http.ResponseWriter, r *http.Request) error {
	f, err := s.changeFilter(r)
	if err != nil {
		return err
	}
	return s.writeChanges(w, r, f)
}

func (s *Server) writeChanges(w http.ResponseWriter, r *http.Request, f store.ChangeFilter) error {
	items, next, err := s.Store.ListChanges(r.Context(), f)
	if err != nil {
		if errors.Is(err, store.ErrBadCursor) {
			return badRequest("bad cursor")
		}
		return err
	}
	if items == nil {
		items = []model.Change{}
	}
	writeJSON(w, http.StatusOK, changeList{Items: items, NextCursor: next})
	return nil
}

func (s *Server) getChange(w http.ResponseWriter, r *http.Request) error {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		return badRequest("id must be a UUID")
	}
	c, err := s.Store.GetChange(r.Context(), id)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, c)
	return nil
}

// history is one object's timeline, oldest changes last like every list.
func (s *Server) history(w http.ResponseWriter, r *http.Request) error {
	f, err := s.changeFilter(r)
	if err != nil {
		return err
	}
	g := group(r.PathValue("group"))
	f.Group = &g
	f.Resource = r.PathValue("resource")
	f.Namespace = r.PathValue("namespace")
	if f.Namespace == "_" {
		f.Namespace = "" // cluster-scoped: no namespace filter needed
	}
	f.Name = r.PathValue("name")
	return s.writeChanges(w, r, f)
}

func (s *Server) attempts(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	f := store.AttemptFilter{
		Cluster: s.cluster(r), Namespace: q.Get("namespace"), Resource: q.Get("resource"),
		Name: q.Get("name"), User: q.Get("user"), MinCode: 400,
	}
	if v := q.Get("minCode"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			return badRequest("minCode must be a number")
		}
		f.MinCode = int32(n)
	}
	var err error
	if f.Since, err = s.parseTime(q.Get("since")); err != nil {
		return err
	}
	if f.Until, err = s.parseTime(q.Get("until")); err != nil {
		return err
	}
	if f.Limit, err = parseLimit(q.Get("limit")); err != nil {
		return err
	}
	items, err := s.Store.ListAttempts(r.Context(), f)
	if err != nil {
		return err
	}
	if items == nil {
		items = []model.AuditRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
	return nil
}

func (s *Server) sinceOr(r *http.Request, def time.Duration) (time.Time, error) {
	v := r.URL.Query().Get("since")
	if v == "" {
		return s.now().Add(-def), nil
	}
	return s.parseTime(v)
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request) error {
	since, err := s.sinceOr(r, 24*time.Hour)
	if err != nil {
		return err
	}
	bucket := time.Hour
	if v := r.URL.Query().Get("bucket"); v != "" {
		if bucket, err = time.ParseDuration(v); err != nil || bucket < time.Minute {
			return badRequest("bucket must be a duration of at least 1m")
		}
	}
	st, err := s.Store.Stats(r.Context(), s.cluster(r), since, bucket)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, st)
	return nil
}

func (s *Server) users(w http.ResponseWriter, r *http.Request) error {
	since, err := s.sinceOr(r, 7*24*time.Hour)
	if err != nil {
		return err
	}
	limit, err := parseLimit(r.URL.Query().Get("limit"))
	if err != nil {
		return err
	}
	us, err := s.Store.Users(r.Context(), s.cluster(r), since, limit)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": us})
	return nil
}
