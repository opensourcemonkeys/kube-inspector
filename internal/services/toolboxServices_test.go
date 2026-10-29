package services_k8sclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
	"sigs.k8s.io/yaml"

	"kube-ins/internal/models"
)

const testEventID = "6f1c1f9e-6d3a-4a52-9d55-2f6b1e0c1a11"

// fakeAPIServer is just enough of an API server for toolbox discovery and the
// service proxy.
type fakeAPIServer struct {
	token            string // what the Secret holds
	accept           string // what the proxied toolbox accepts
	forbidClusterLS  bool
	forbidSecret     bool
	noService        bool
	missingNamespace bool // ns1 has been deleted
	noHealth         bool // a toolbox from before /api/v1/health
	pagedChanges     int  // > 0: /changes answers that many one-item pages
	discoveries      atomic.Int32
	lastProxiedQuery string
	change           map[string]any
}

func (f *fakeAPIServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	status := func(code int, reason string) {
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"},
			Status: "Failure", Code: int32(code), Reason: metav1.StatusReason(reason)})
	}
	svcList := func() {
		f.discoveries.Add(1)
		if !strings.Contains(r.URL.Query().Get("labelSelector"), "app.kubernetes.io/name=toolbox") {
			status(http.StatusBadRequest, "BadRequest")
			return
		}
		list := corev1.ServiceList{TypeMeta: metav1.TypeMeta{Kind: "ServiceList", APIVersion: "v1"}}
		if !f.noService {
			list.Items = []corev1.Service{{
				ObjectMeta: metav1.ObjectMeta{Name: "toolbox", Namespace: "toolbox"},
				Spec:       corev1.ServiceSpec{Ports: []corev1.ServicePort{{Name: "http", Port: 8080}, {Name: "webhook", Port: 443}}},
			}}
		}
		_ = json.NewEncoder(w).Encode(list)
	}
	const proxy = "/api/v1/namespaces/toolbox/services/toolbox:http/proxy/"
	switch {
	case r.URL.Path == "/api/v1/services":
		if f.forbidClusterLS {
			status(http.StatusForbidden, "Forbidden")
			return
		}
		svcList()
	case r.URL.Path == "/api/v1/namespaces/toolbox/services":
		svcList()
	case r.URL.Path == "/api/v1/namespaces/toolbox/secrets/toolbox":
		if f.forbidSecret {
			status(http.StatusForbidden, "Forbidden")
			return
		}
		_ = json.NewEncoder(w).Encode(corev1.Secret{TypeMeta: metav1.TypeMeta{Kind: "Secret", APIVersion: "v1"},
			ObjectMeta: metav1.ObjectMeta{Name: "toolbox", Namespace: "toolbox"},
			Data:       map[string][]byte{"api-token": []byte(f.token)}})
	case r.URL.Path == "/api/v1/namespaces/ns1":
		if f.missingNamespace {
			status(http.StatusNotFound, "NotFound")
			return
		}
		_ = json.NewEncoder(w).Encode(corev1.Namespace{TypeMeta: metav1.TypeMeta{Kind: "Namespace", APIVersion: "v1"},
			ObjectMeta: metav1.ObjectMeta{Name: "ns1"}})
	case strings.HasPrefix(r.URL.Path, proxy):
		if r.Header.Get("X-Toolbox-Token") != f.accept {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		f.lastProxiedQuery = r.URL.RawQuery
		switch strings.TrimPrefix(r.URL.Path, proxy) {
		case "api/v1/info":
			_, _ = w.Write([]byte(`{"cluster":"local-k3s","version":"1.2.3"}`))
		case "api/v1/changes":
			if f.pagedChanges > 0 {
				// Page n of pagedChanges, one change each, cursors "1", "2", ...
				n, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
				next := ""
				if n+1 < f.pagedChanges {
					next = strconv.Itoa(n + 1)
				}
				name := "app"
				if n == 0 {
					name = "=HYPERLINK(\"http://x\")" // a spreadsheet formula in an object name
				}
				_, _ = w.Write([]byte(`{"items":[{"eventId":"e` + strconv.Itoa(n) + `","verb":"update","kind":"ConfigMap","name":` +
					strconv.Quote(name) + `,"changedPaths":["/data/a","/data/b"],"patch":"[]","actor":{"username":"alice"}}],"nextCursor":"` + next + `"}`))
				return
			}
			if r.URL.Query().Get("since") == "bogus" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"since must be RFC 3339 or a duration"}`))
				return
			}
			_, _ = w.Write([]byte(`{"items":[{"eventId":"` + testEventID + `","verb":"update","kind":"ConfigMap","name":"app","actor":{"username":"alice"}}],"nextCursor":"c2"}`))
		case "api/v1/changes/stream":
			if f.noHealth {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte(": keepalive\n\n" +
				"event: change\ndata: {\"eventId\":\"e1\",\"verb\":\"create\",\"name\":\"a\"}\n\n" +
				"event: change\ndata: {\"eventId\":\"e2\",\"verb\":\"update\",\"name\":\"b\"}\n\n"))
		case "api/v1/health":
			if f.noHealth {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte("404 page not found"))
				return
			}
			_, _ = w.Write([]byte(`{"sources":{"admission":{"enabled":true,"lastSeen":"2026-10-25T12:00:00Z"},"audit":{"enabled":false}},` +
				`"leader":{"identity":"toolbox-0"},"coverage":{"hasData":true,"ratio":0.99,"gaps":[{"from":"2026-10-25T10:00:00Z","to":"2026-10-25T10:05:00Z"}]},` +
				`"attribution":[{"key":"admission","count":3}],"recording":{"changesRetentionDays":90}}`))
		case "api/v1/stats":
			if f.noHealth { // an older toolbox: no totals, no previous
				_, _ = w.Write([]byte(`{"buckets":[{"time":"2026-10-25T12:00:00Z","verb":"update","count":4}],"byResource":null,"byUser":[],"byNamespace":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"buckets":[],"byResource":[{"key":"deployments.apps","count":4}],"byUser":[],"byNamespace":[],` +
				`"totals":{"changes":4,"deletes":1,"unattributed":0,"attempts":2},"previous":{"changes":2,"deletes":0,"unattributed":0,"attempts":0}}`))
		case "api/v1/gaps":
			if f.noHealth {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write([]byte(`{"hasData":true,"ratio":1,"gaps":null}`))
		case "api/v1/changes/" + testEventID:
			_ = json.NewEncoder(w).Encode(f.change)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	default:
		status(http.StatusNotFound, "NotFound")
	}
}

func newToolboxFixture(t *testing.T, f *fakeAPIServer) Toolbox {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	client, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	tb := Toolbox{Key: t.Name(), Client: client}
	t.Cleanup(tb.forget)
	return tb
}

func TestToolboxStatusThroughServiceProxy(t *testing.T) {
	f := &fakeAPIServer{token: "s3cret", accept: "s3cret"}
	tb := newToolboxFixture(t, f)
	st := GetToolboxStatus(context.Background(), tb)
	if st.State != ToolboxOK || st.Version != "1.2.3" || st.Cluster != "local-k3s" || st.Namespace != "toolbox" || st.Service != "toolbox" {
		t.Fatalf("status = %+v", st)
	}
	// The endpoint is cached: a second call does not rediscover.
	GetToolboxStatus(context.Background(), tb)
	if n := f.discoveries.Load(); n != 1 {
		t.Fatalf("discoveries = %d", n)
	}
}

func TestToolboxStates(t *testing.T) {
	for name, tc := range map[string]struct {
		f    *fakeAPIServer
		want string
	}{
		"not installed":             {&fakeAPIServer{noService: true}, ToolboxNotInstalled},
		"secret forbidden":          {&fakeAPIServer{token: "x", accept: "x", forbidSecret: true}, ToolboxForbidden},
		"namespace-only listing ok": {&fakeAPIServer{token: "x", accept: "x", forbidClusterLS: true}, ToolboxOK},
		"token rejected twice":      {&fakeAPIServer{token: "x", accept: "y"}, ToolboxUnreachable},
	} {
		t.Run(name, func(t *testing.T) {
			if st := GetToolboxStatus(context.Background(), newToolboxFixture(t, tc.f)); st.State != tc.want {
				t.Fatalf("state = %q (%s), want %q", st.State, st.Detail, tc.want)
			}
		})
	}
}

func TestToolboxRediscoversOnUnauthorized(t *testing.T) {
	f := &fakeAPIServer{token: "new", accept: "new"}
	tb := newToolboxFixture(t, f)
	// A token from before a reinstall.
	toolboxCache.Lock()
	toolboxCache.m[tb.Key] = toolboxEndpoint{namespace: "toolbox", service: "toolbox", token: "old", fetched: time.Now()}
	toolboxCache.Unlock()

	if st := GetToolboxStatus(context.Background(), tb); st.State != ToolboxOK {
		t.Fatalf("status = %+v", st)
	}
	if n := f.discoveries.Load(); n != 1 {
		t.Fatalf("discoveries = %d", n)
	}
}

func TestListToolboxChangesPassesFilters(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x"}
	tb := newToolboxFixture(t, f)
	page, err := ListToolboxChanges(context.Background(), tb, toolboxFilter("ns1", "24h"))
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Actor.Username != "alice" || page.NextCursor != "c2" {
		t.Fatalf("page = %+v", page)
	}
	if !strings.Contains(f.lastProxiedQuery, "namespace=ns1") || !strings.Contains(f.lastProxiedQuery, "since=24h") ||
		strings.Contains(f.lastProxiedQuery, "user=") {
		t.Fatalf("query = %q", f.lastProxiedQuery)
	}
	_, err = ListToolboxChanges(context.Background(), tb, toolboxFilter("", "bogus"))
	if err == nil || !strings.Contains(err.Error(), "since must be") {
		t.Fatalf("toolbox's own message not surfaced: %v", err)
	}
}

func TestChangeParams(t *testing.T) {
	f := models.ToolboxChangeFilter{
		Kind: "Deployment", Attribution: "audit", Path: "/spec/replicas",
		Since: "2026-10-28T14:00:00Z", Until: "2026-10-28T15:00:00Z", Name: "api",
	}
	got := changeParams(f)
	for k, want := range map[string]string{
		"kind": "Deployment", "attribution": "audit", "path": "/spec/replicas",
		"since": "2026-10-28T14:00:00Z", "until": "2026-10-28T15:00:00Z", "name": "api",
	} {
		if v := got.Get(k); v != want {
			t.Errorf("%s = %q, want %q", k, v, want)
		}
	}
	// Empty fields are not sent: toolbox would read q= as a filter.
	for _, k := range []string{"q", "namespace", "user", "verb", "cursor", "limit"} {
		if got.Has(k) {
			t.Errorf("%s sent though empty", k)
		}
	}
}

func TestAttemptsDropChangeOnlyFilters(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x"}
	tb := newToolboxFixture(t, f)
	filter := toolboxFilter("ns1", "24h")
	filter.Kind, filter.Attribution, filter.Path, filter.Until = "Deployment", "audit", "/spec", "1h"
	_, _ = ListToolboxAttempts(context.Background(), tb, filter)
	for _, k := range []string{"kind=", "attribution=", "path="} {
		if strings.Contains(f.lastProxiedQuery, k) {
			t.Fatalf("attempts query carries %s: %q", k, f.lastProxiedQuery)
		}
	}
	if !strings.Contains(f.lastProxiedQuery, "until=1h") {
		t.Fatalf("attempts query lost until: %q", f.lastProxiedQuery)
	}
}

func TestChangeDetailAndRestorable(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x", change: recordedChange("configmaps", "")}
	tb := newToolboxFixture(t, f)
	d, err := GetToolboxChangeDetail(context.Background(), tb, testEventID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d.BeforeYaml, "resourceVersion") || !strings.Contains(d.BeforeYaml, "status") {
		t.Fatalf("full before lost fields:\n%s", d.BeforeYaml)
	}
	for _, gone := range []string{"resourceVersion", "uid", "creationTimestamp", "status", "deletionTimestamp"} {
		if strings.Contains(d.BeforeRestorable, gone) {
			t.Fatalf("restorable keeps %s:\n%s", gone, d.BeforeRestorable)
		}
	}
	if !strings.Contains(d.BeforeRestorable, "mode: blue") || !strings.Contains(d.AfterRestorable, "mode: green") {
		t.Fatalf("restorable = %q / %q", d.BeforeRestorable, d.AfterRestorable)
	}
	if d.RollbackBlocked != "" {
		t.Fatalf("blocked = %q", d.RollbackBlocked)
	}
	if _, err := GetToolboxChangeDetail(context.Background(), tb, "../../secrets"); err == nil {
		t.Fatal("a non-UUID id reached the proxied path")
	}
}

func TestRedactSecretMatchesToolbox(t *testing.T) {
	obj := map[string]any{"data": map[string]any{"pw": "aHVudGVyMg=="}}
	redactSecret(obj)
	// The value toolbox/internal/diff stores for the same input.
	if got := obj["data"].(map[string]any)["pw"]; got != "sha256:fb9ef43059be" {
		t.Fatalf("got %v", got)
	}
}

var cmGVR = schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}

func TestRollbackReplacesWithLiveResourceVersion(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x", change: recordedChange("configmaps", "")}
	tb := newToolboxFixture(t, f)
	live := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": map[string]any{"name": "app", "namespace": "ns1", "resourceVersion": "99",
			"labels": map[string]any{"added": "later"}},
		"data": map[string]any{"mode": "red", "extra": "added later"},
	}}
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), live)

	out, err := RollbackToolboxChange(context.Background(), tb, dyn, testEventID, "before")
	if err != nil {
		t.Fatal(err)
	}
	if out != "ConfigMap/app rolled back" {
		t.Fatalf("out = %q", out)
	}
	got, _ := dyn.Resource(cmGVR).Namespace("ns1").Get(context.Background(), "app", metav1.GetOptions{})
	data, _, _ := unstructured.NestedStringMap(got.Object, "data")
	if data["mode"] != "blue" || data["extra"] != "" || got.GetLabels()["added"] != "" {
		t.Fatalf("not replaced: %v labels=%v", data, got.GetLabels())
	}
}

func TestRollbackRecreatesDeletedObject(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x", change: recordedChange("configmaps", "")}
	tb := newToolboxFixture(t, f)
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	out, err := RollbackToolboxChange(context.Background(), tb, dyn, testEventID, "after")
	if err != nil || out != "ConfigMap/app re-created" {
		t.Fatalf("out = %q err = %v", out, err)
	}
	got, err := dyn.Resource(cmGVR).Namespace("ns1").Get(context.Background(), "app", metav1.GetOptions{})
	if err != nil || got.GetUID() != "" {
		t.Fatalf("got = %v err = %v", got, err)
	}
}

func TestRollbackNamesMissingNamespace(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x", change: recordedChange("configmaps", ""), missingNamespace: true}
	tb := newToolboxFixture(t, f)
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	for _, run := range []func(context.Context, Toolbox, dynamic.Interface, string, string) (string, error){
		RollbackToolboxChange, DryRunToolboxRollback,
	} {
		_, err := run(context.Background(), tb, dyn, testEventID, "after")
		if err == nil || !strings.Contains(err.Error(), "namespace ns1 no longer exists") {
			t.Fatalf("err = %v", err)
		}
	}
	if n := len(dyn.Actions()); n != 2 { // the two Gets, no Create
		t.Fatalf("actions = %d", n)
	}
}

func TestDryRunRollbackWritesNothing(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x", change: recordedChange("configmaps", "")}
	tb := newToolboxFixture(t, f)
	live := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": map[string]any{"name": "app", "namespace": "ns1", "resourceVersion": "99"},
	}}
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), live)
	out, err := DryRunToolboxRollback(context.Background(), tb, dyn, testEventID, "before")
	if err != nil || out != "ConfigMap/app can be rolled back" {
		t.Fatalf("out = %q err = %v", out, err)
	}
	var update *k8stesting.UpdateActionImpl
	for _, a := range dyn.Actions() {
		if u, ok := a.(k8stesting.UpdateActionImpl); ok {
			update = &u
		}
	}
	if update == nil || len(update.UpdateOptions.DryRun) != 1 || update.UpdateOptions.DryRun[0] != metav1.DryRunAll {
		t.Fatalf("update = %+v", update)
	}
}

func TestChangeParamsGroup(t *testing.T) {
	if changeParams(models.ToolboxChangeFilter{}).Has("group") {
		t.Fatal("empty group sent: toolbox would filter to the core group")
	}
	if g := changeParams(models.ToolboxChangeFilter{Group: "core"}).Get("group"); g != "core" {
		t.Fatalf("group = %q", g)
	}
}

func TestRollbackRefusals(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x", change: recordedChange("secrets", "")}
	tb := newToolboxFixture(t, f)
	dyn := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme())
	if _, err := RollbackToolboxChange(context.Background(), tb, dyn, testEventID, "before"); err == nil {
		t.Fatal("secret rolled back")
	}
	f.change = recordedChange("configmaps", "create")
	if _, err := RollbackToolboxChange(context.Background(), tb, dyn, testEventID, "before"); err == nil ||
		!strings.Contains(err.Error(), "no before version") {
		t.Fatalf("create has no before: %v", err)
	}
}

func toolboxFilter(ns, since string) models.ToolboxChangeFilter {
	return models.ToolboxChangeFilter{Namespace: ns, Since: since, Limit: 100}
}

// recordedChange is a change as toolbox's /changes/{id} returns it. verb
// "create" leaves out the before side.
func recordedChange(resource, verb string) map[string]any {
	obj := func(mode, rv string) string {
		b, _ := yaml.YAMLToJSON([]byte(`
apiVersion: v1
kind: ConfigMap
metadata:
  name: app
  namespace: ns1
  uid: u-1
  resourceVersion: "` + rv + `"
  creationTimestamp: "2026-10-25T10:00:00Z"
  deletionTimestamp: "2026-10-25T10:00:00Z"
data:
  mode: ` + mode + `
status:
  phase: x
`))
		return string(b)
	}
	if verb == "" {
		verb = "update"
	}
	ch := map[string]any{"eventId": testEventID, "verb": verb, "group": "", "apiVersion": "v1",
		"resource": resource, "kind": "ConfigMap", "namespace": "ns1", "name": "app",
		"after": obj("green", "2")}
	if verb != "create" {
		ch["before"] = obj("blue", "1")
	}
	return ch
}

func TestToolboxHealth(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x"}
	tb := newToolboxFixture(t, f)
	h, err := GetToolboxHealth(context.Background(), tb)
	if err != nil {
		t.Fatal(err)
	}
	if !h.Supported || h.Sources.Admission.LastSeen == "" || h.Sources.Audit.Enabled || h.Leader == nil ||
		len(h.Coverage.Gaps) != 1 || h.Recording.ChangesRetentionDays != 90 {
		t.Fatalf("health = %+v", h)
	}
	cov, err := ListToolboxGaps(context.Background(), tb, "168h", "")
	if err != nil || cov.Gaps == nil || !strings.Contains(f.lastProxiedQuery, "since=168h") {
		t.Fatalf("cov = %+v err = %v query = %q", cov, err, f.lastProxiedQuery)
	}
}

func TestToolboxHealthOnOldToolbox(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x", noHealth: true}
	tb := newToolboxFixture(t, f)
	h, err := GetToolboxHealth(context.Background(), tb)
	if err != nil || h.Supported {
		t.Fatalf("health = %+v err = %v", h, err)
	}
	cov, err := ListToolboxGaps(context.Background(), tb, "", "")
	if err != nil || len(cov.Gaps) != 0 {
		t.Fatalf("cov = %+v err = %v", cov, err)
	}
}

func TestToolboxStats(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x"}
	tb := newToolboxFixture(t, f)
	st, err := GetToolboxStats(context.Background(), tb, models.ToolboxStatsFilter{Since: "24h", Namespace: "prod", Bucket: "1h"})
	if err != nil || st.Totals == nil || st.Totals.Attempts != 2 || st.Previous.Changes != 2 {
		t.Fatalf("stats = %+v err = %v", st, err)
	}
	for _, k := range []string{"since=24h", "namespace=prod", "bucket=1h"} {
		if !strings.Contains(f.lastProxiedQuery, k) {
			t.Fatalf("query %q lacks %s", f.lastProxiedQuery, k)
		}
	}
	f.noHealth = true
	st, err = GetToolboxStats(context.Background(), tb, models.ToolboxStatsFilter{})
	if err != nil || st.Totals != nil || st.ByResource == nil || len(st.Buckets) != 1 {
		t.Fatalf("old toolbox stats = %+v err = %v", st, err)
	}
}

func TestExportPagesAndLimits(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x", pagedChanges: 3}
	tb := newToolboxFixture(t, f)
	out, err := ExportToolboxHistory(context.Background(), tb, "changes", models.ToolboxChangeFilter{Namespace: "ns1"}, "csv", 100)
	if err != nil || out.Rows != 3 || out.Truncated {
		t.Fatalf("out = %+v err = %v", out, err)
	}
	if !strings.Contains(f.lastProxiedQuery, "limit=1000") || !strings.Contains(f.lastProxiedQuery, "namespace=ns1") {
		t.Fatalf("query = %q", f.lastProxiedQuery)
	}
	lines := strings.Split(strings.TrimSpace(string(out.Data)), "\n")
	if len(lines) != 4 || !strings.HasPrefix(lines[0], "time,verb,") {
		t.Fatalf("csv = %q", out.Data)
	}
	// The formula is defused, and a multi-value cell stays one cell.
	if !strings.Contains(lines[1], `"'=HYPERLINK(""http://x"")"`) || !strings.Contains(lines[1], "/data/a /data/b") {
		t.Fatalf("row = %q", lines[1])
	}

	out, err = ExportToolboxHistory(context.Background(), tb, "changes", models.ToolboxChangeFilter{}, "json", 2)
	if err != nil || out.Rows != 2 || !out.Truncated {
		t.Fatalf("limited out = %+v err = %v", out, err)
	}
	var doc struct {
		Truncated bool             `json:"truncated"`
		Items     []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(out.Data, &doc); err != nil || !doc.Truncated || len(doc.Items) != 2 || doc.Items[0]["patch"] != "[]" {
		t.Fatalf("json = %s err = %v", out.Data, err)
	}

	if _, err := ExportToolboxHistory(context.Background(), tb, "secrets", models.ToolboxChangeFilter{}, "csv", 10); err == nil {
		t.Fatal("unknown view accepted")
	}
}

func TestCSVCell(t *testing.T) {
	for in, want := range map[string]string{"=1+1": "'=1+1", "+x": "'+x", "-x": "'-x", "@x": "'@x", "web": "web", "": ""} {
		if got := csvCell(in); got != want {
			t.Errorf("csvCell(%q) = %q", in, got)
		}
	}
}

func TestStreamToolboxChanges(t *testing.T) {
	f := &fakeAPIServer{token: "x", accept: "x"}
	tb := newToolboxFixture(t, f)
	var got []string
	err := StreamToolboxChanges(context.Background(), tb, models.ToolboxChangeFilter{Namespace: "ns1", Since: "24h", Cursor: "c"}, func(c models.ToolboxChange) {
		got = append(got, c.EventID)
	})
	if strings.Join(got, ",") != "e1,e2" {
		t.Fatalf("got = %v", got)
	}
	// The server closing the stream is an end the panel must hear about.
	if err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("err = %v", err)
	}
	// Filters pass through; paging and time bounds mean nothing to a stream.
	if !strings.Contains(f.lastProxiedQuery, "namespace=ns1") || strings.Contains(f.lastProxiedQuery, "since=") || strings.Contains(f.lastProxiedQuery, "cursor=") {
		t.Fatalf("query = %q", f.lastProxiedQuery)
	}

	f.noHealth = true
	err = StreamToolboxChanges(context.Background(), tb, models.ToolboxChangeFilter{}, func(models.ToolboxChange) {})
	if !isToolboxNotFound(err) {
		t.Fatalf("older toolbox: %v", err)
	}
}
