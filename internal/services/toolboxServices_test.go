package services_k8sclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
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
			if r.URL.Query().Get("since") == "bogus" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"since must be RFC 3339 or a duration"}`))
				return
			}
			_, _ = w.Write([]byte(`{"items":[{"eventId":"` + testEventID + `","verb":"update","kind":"ConfigMap","name":"app","actor":{"username":"alice"}}],"nextCursor":"c2"}`))
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
