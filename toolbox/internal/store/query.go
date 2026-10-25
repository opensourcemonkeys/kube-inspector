package store

import (
	"context"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/google/uuid"

	"github.com/kubeinspector/toolbox/internal/model"
)

// ErrNotFound is returned by single-row lookups that match nothing.
var ErrNotFound = errors.New("not found")

// ErrBadCursor is returned for a pagination cursor this store did not issue.
var ErrBadCursor = errors.New("bad cursor")

// where accumulates AND-ed conditions with their positional arguments.
type where struct {
	conds []string
	args  []any
}

func (w *where) add(cond string, args ...any) {
	w.conds = append(w.conds, cond)
	w.args = append(w.args, args...)
}

func (w *where) eq(col, v string) {
	if v != "" {
		w.add(col+" = ?", v)
	}
}

func (w *where) String() string {
	if len(w.conds) == 0 {
		return ""
	}
	return " WHERE " + strings.Join(w.conds, " AND ")
}

func groupSet(vals []string) clickhouse.GroupSet {
	g := clickhouse.GroupSet{Value: make([]any, len(vals))}
	for i, v := range vals {
		g.Value[i] = v
	}
	return g
}

// HintsFor returns the hints for objects named in names, between from and to.
// The empty name is always included: a create by generateName that was only
// audited at Metadata level carries no name.
func (s *Store) HintsFor(ctx context.Context, cluster string, names []string, from, to time.Time) ([]model.Hint, error) {
	set := map[string]bool{"": true}
	for _, n := range names {
		set[n] = true
	}
	uniq := make([]string, 0, len(set))
	for n := range set {
		uniq = append(uniq, n)
	}
	rows, err := s.conn.Query(ctx, `SELECT hint_id, source, ts, verb, api_group, resource, subresource, namespace, name,
		object_uid, resource_version, content_hash, username, user_uid, groups, extra, impersonated_by,
		source_ips, user_agent, audit_id
		FROM actor_hints WHERE cluster = ? AND name IN ? AND ts BETWEEN ? AND ?`,
		cluster, groupSet(uniq), from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Hint
	for rows.Next() {
		var h model.Hint
		var source, verb, extra string
		if err := rows.Scan(&h.ID, &source, &h.Time, &verb, &h.Key.Group, &h.Key.Resource, &h.Subresource,
			&h.Key.Namespace, &h.Key.Name, &h.ObjectUID, &h.ResourceVersion, &h.ContentHash,
			&h.Actor.Username, &h.Actor.UserUID, &h.Actor.Groups, &extra, &h.Actor.ImpersonatedBy,
			&h.Actor.SourceIPs, &h.Actor.UserAgent, &h.Actor.AuditID); err != nil {
			return nil, err
		}
		h.Source, h.Verb, h.Cluster = model.HintSource(source), model.Verb(verb), cluster
		h.Actor.Extra = parseExtra(extra)
		out = append(out, h)
	}
	return out, rows.Err()
}

// ChangeFilter selects changes. Empty fields do not filter; Group is a pointer
// because the core group is the empty string.
type ChangeFilter struct {
	Cluster     string
	Group       *string
	Resource    string
	Kind        string
	Namespace   string
	Name        string
	ObjectUID   string
	User        string
	Verb        string
	Attribution string
	// Path matches changes that touched this JSON pointer or anything below it.
	Path string
	// Q is a case-insensitive substring of name, namespace, user or kind.
	Q            string
	Since, Until time.Time
	Limit        int
	Cursor       string
	WithObjects  bool
}

const changeCols = `event_id, version, event_time, cluster, verb, api_group, api_version, resource, kind, namespace,
	name, object_uid, resource_version, username, user_uid, groups, extra, impersonated_by, source_ips,
	user_agent, audit_id, field_manager, attribution, changed_paths, patch`

// ListChanges returns changes newest first, and a cursor for the next page
// ("" when there is none).
func (s *Store) ListChanges(ctx context.Context, f ChangeFilter) ([]model.Change, string, error) {
	var w where
	w.eq("cluster", f.Cluster)
	if f.Group != nil {
		w.add("api_group = ?", *f.Group)
	}
	w.eq("resource", f.Resource)
	w.eq("kind", f.Kind)
	w.eq("namespace", f.Namespace)
	w.eq("name", f.Name)
	w.eq("object_uid", f.ObjectUID)
	w.eq("username", f.User)
	w.eq("verb", f.Verb)
	w.eq("attribution", f.Attribution)
	if f.Path != "" {
		w.add("arrayExists(p -> p = ? OR startsWith(p, ?), changed_paths)", f.Path, strings.TrimSuffix(f.Path, "/")+"/")
	}
	if f.Q != "" {
		w.add(`(positionCaseInsensitive(name, ?) > 0 OR positionCaseInsensitive(namespace, ?) > 0
			OR positionCaseInsensitive(username, ?) > 0 OR positionCaseInsensitive(kind, ?) > 0)`, f.Q, f.Q, f.Q, f.Q)
	}
	if !f.Since.IsZero() {
		w.add("event_time >= ?", f.Since)
	}
	if !f.Until.IsZero() {
		w.add("event_time < ?", f.Until)
	}
	if f.Cursor != "" {
		t, id, err := decodeCursor(f.Cursor)
		if err != nil {
			return nil, "", err
		}
		w.add("(event_time, event_id) < (fromUnixTimestamp64Milli(?, 'UTC'), toUUID(?))", t, id.String())
	}
	limit := f.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	cols := changeCols
	if f.WithObjects {
		cols += ", object_before, object_after"
	}
	q := "SELECT " + cols + " FROM changes FINAL" + w.String() +
		" ORDER BY event_time DESC, event_id DESC LIMIT " + strconv.Itoa(limit+1)
	out, err := s.queryChanges(ctx, q, f.WithObjects, w.args...)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(out) > limit {
		out = out[:limit]
		last := out[len(out)-1]
		next = encodeCursor(last.Time, last.EventID)
	}
	return out, next, nil
}

// GetChange returns one change with both object versions.
func (s *Store) GetChange(ctx context.Context, id uuid.UUID) (*model.Change, error) {
	q := "SELECT " + changeCols + ", object_before, object_after FROM changes FINAL WHERE event_id = ? LIMIT 1"
	out, err := s.queryChanges(ctx, q, true, id.String())
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return &out[0], nil
}

func (s *Store) queryChanges(ctx context.Context, q string, withObjects bool, args ...any) ([]model.Change, error) {
	rows, err := s.conn.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Change
	for rows.Next() {
		var c model.Change
		var verb, attr, extra string
		dst := []any{&c.EventID, &c.Version, &c.Time, &c.Cluster, &verb, &c.Group, &c.APIVersion, &c.Resource,
			&c.Kind, &c.Namespace, &c.Name, &c.ObjectUID, &c.ResourceVersion, &c.Actor.Username, &c.Actor.UserUID,
			&c.Actor.Groups, &extra, &c.Actor.ImpersonatedBy, &c.Actor.SourceIPs, &c.Actor.UserAgent,
			&c.Actor.AuditID, &c.FieldManager, &attr, &c.ChangedPaths, &c.Patch}
		if withObjects {
			dst = append(dst, &c.Before, &c.After)
		}
		if err := rows.Scan(dst...); err != nil {
			return nil, err
		}
		c.Verb, c.Attribution = model.Verb(verb), model.Attribution(attr)
		c.Actor.Extra = parseExtra(extra)
		out = append(out, c)
	}
	return out, rows.Err()
}

func encodeCursor(t time.Time, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(t.UnixMilli(), 10) + ":" + id.String()))
}

func decodeCursor(c string) (int64, uuid.UUID, error) {
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return 0, uuid.Nil, ErrBadCursor
	}
	ms, idStr, ok := strings.Cut(string(b), ":")
	if !ok {
		return 0, uuid.Nil, ErrBadCursor
	}
	t, err := strconv.ParseInt(ms, 10, 64)
	if err != nil {
		return 0, uuid.Nil, ErrBadCursor
	}
	id, err := uuid.Parse(idStr)
	if err != nil {
		return 0, uuid.Nil, ErrBadCursor
	}
	return t, id, nil
}

// AttemptFilter selects audited requests.
type AttemptFilter struct {
	Cluster, Namespace, Resource, Name, User string
	// MinCode is the lowest response code returned; 400 lists only failures.
	MinCode      int32
	Since, Until time.Time
	Limit        int
}

func (s *Store) ListAttempts(ctx context.Context, f AttemptFilter) ([]model.AuditRecord, error) {
	var w where
	w.eq("cluster", f.Cluster)
	w.eq("namespace", f.Namespace)
	w.eq("resource", f.Resource)
	w.eq("name", f.Name)
	w.eq("username", f.User)
	w.add("response_code >= ?", f.MinCode)
	if !f.Since.IsZero() {
		w.add("ts >= ?", f.Since)
	}
	if !f.Until.IsZero() {
		w.add("ts < ?", f.Until)
	}
	limit := f.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.conn.Query(ctx, `SELECT ts, cluster, audit_id, verb, api_group, api_version, resource, subresource,
		namespace, name, username, groups, impersonated_by, source_ips, user_agent, request_uri, response_code,
		response_reason, response_message FROM audit_raw FINAL`+w.String()+
		" ORDER BY ts DESC LIMIT "+strconv.Itoa(limit), w.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.AuditRecord
	for rows.Next() {
		var a model.AuditRecord
		if err := rows.Scan(&a.Time, &a.Cluster, &a.AuditID, &a.Verb, &a.Group, &a.APIVersion, &a.Resource,
			&a.Subresource, &a.Namespace, &a.Name, &a.Username, &a.Groups, &a.ImpersonatedBy, &a.SourceIPs,
			&a.UserAgent, &a.RequestURI, &a.ResponseCode, &a.ResponseReason, &a.ResponseMessage); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

type Bucket struct {
	Time  time.Time `json:"time"`
	Verb  string    `json:"verb"`
	Count uint64    `json:"count"`
}

type Count struct {
	Key   string `json:"key"`
	Count uint64 `json:"count"`
}

type Stats struct {
	Buckets     []Bucket `json:"buckets"`
	ByResource  []Count  `json:"byResource"`
	ByUser      []Count  `json:"byUser"`
	ByNamespace []Count  `json:"byNamespace"`
}

// Stats summarises changes since a point in time, in buckets of the given width.
func (s *Store) Stats(ctx context.Context, cluster string, since time.Time, bucket time.Duration) (*Stats, error) {
	var w where
	w.eq("cluster", cluster)
	w.add("event_time >= ?", since)
	st := &Stats{Buckets: []Bucket{}}

	rows, err := s.conn.Query(ctx, "SELECT toStartOfInterval(event_time, toIntervalSecond(?)) AS b, verb, count() FROM changes FINAL"+
		w.String()+" GROUP BY b, verb ORDER BY b", append([]any{int64(bucket.Seconds())}, w.args...)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var b Bucket
		if err := rows.Scan(&b.Time, &b.Verb, &b.Count); err != nil {
			rows.Close()
			return nil, err
		}
		st.Buckets = append(st.Buckets, b)
	}
	rows.Close()

	for _, g := range []struct {
		expr string
		dst  *[]Count
	}{
		{"if(api_group = '', resource, concat(resource, '.', api_group))", &st.ByResource},
		{"if(username = '', concat('(', field_manager, ')'), username)", &st.ByUser},
		{"namespace", &st.ByNamespace},
	} {
		if *g.dst, err = s.topN(ctx, g.expr, w, 10); err != nil {
			return nil, err
		}
	}
	return st, nil
}

func (s *Store) topN(ctx context.Context, expr string, w where, n int) ([]Count, error) {
	rows, err := s.conn.Query(ctx, "SELECT "+expr+" AS k, count() AS c FROM changes FINAL"+w.String()+
		" GROUP BY k ORDER BY c DESC LIMIT "+strconv.Itoa(n), w.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Count{}
	for rows.Next() {
		var c Count
		if err := rows.Scan(&c.Key, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

type UserSummary struct {
	Username string    `json:"username"`
	Changes  uint64    `json:"changes"`
	LastSeen time.Time `json:"lastSeen"`
	Agents   []string  `json:"userAgents"`
	IPs      []string  `json:"sourceIPs"`
}

// Users lists the actors seen since a point in time, most active first.
func (s *Store) Users(ctx context.Context, cluster string, since time.Time, limit int) ([]UserSummary, error) {
	var w where
	w.eq("cluster", cluster)
	w.add("event_time >= ?", since)
	w.add("username != ''")
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.conn.Query(ctx, `SELECT username, count(), max(event_time),
		arraySlice(groupUniqArray(user_agent), 1, 10), arraySlice(groupUniqArrayArray(source_ips), 1, 10)
		FROM changes FINAL`+w.String()+" GROUP BY username ORDER BY count() DESC LIMIT "+strconv.Itoa(limit), w.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserSummary{}
	for rows.Next() {
		var u UserSummary
		if err := rows.Scan(&u.Username, &u.Changes, &u.LastSeen, &u.Agents, &u.IPs); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
