package diff

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func obj(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSanitizeRedactsSecretsOnly(t *testing.T) {
	in := obj(t, `{"metadata":{"name":"s","managedFields":[{"manager":"kubectl"}],
		"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"data\":{\"pw\":\"aHVudGVyMg==\"}}"}},
		"data":{"pw":"aHVudGVyMg=="},"stringData":{"token":"plain"}}`)

	s := Sanitize(in, "", "secrets")
	b, _ := json.Marshal(s)
	for _, leak := range []string{"aHVudGVyMg==", "plain", "managedFields"} {
		if strings.Contains(string(b), leak) {
			t.Fatalf("sanitised secret still contains %q: %s", leak, b)
		}
	}
	if !strings.HasPrefix(s["data"].(map[string]any)["pw"].(string), "sha256:") {
		t.Fatalf("data not redacted to a hash: %v", s["data"])
	}
	if _, ok := in["metadata"].(map[string]any)["managedFields"]; !ok {
		t.Fatal("Sanitize modified its input")
	}

	cm := Sanitize(obj(t, `{"data":{"k":"v"}}`), "", "configmaps")
	if cm["data"].(map[string]any)["k"] != "v" {
		t.Fatal("configmap data must not be redacted")
	}
	// A CRD that happens to be called "secrets" in another group is not a Secret.
	other := Sanitize(obj(t, `{"data":{"k":"v"}}`), "example.com", "secrets")
	if other["data"].(map[string]any)["k"] != "v" {
		t.Fatal("non-core secrets must not be redacted")
	}
}

func TestSecretValueChangeStillShowsInDiff(t *testing.T) {
	a := Sanitize(obj(t, `{"data":{"pw":"b2xk"}}`), "", "secrets")
	b := Sanitize(obj(t, `{"data":{"pw":"bmV3"}}`), "", "secrets")
	r, err := Compute(a, b)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.ChangedPaths, []string{"/data/pw"}) {
		t.Fatalf("paths = %v", r.ChangedPaths)
	}
}

func TestCompute(t *testing.T) {
	before := obj(t, `{"metadata":{"name":"d","resourceVersion":"1","generation":1},
		"spec":{"replicas":1,"paused":false},"status":{"ready":1}}`)

	t.Run("spec change, noise ignored, old value kept", func(t *testing.T) {
		after := obj(t, `{"metadata":{"name":"d","resourceVersion":"2","generation":2},
			"spec":{"replicas":3,"paused":false},"status":{"ready":1}}`)
		r, err := Compute(before, after)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(r.ChangedPaths, []string{"/spec/replicas"}) || r.StatusOnly || r.Empty {
			t.Fatalf("got %+v", r)
		}
		var ops []map[string]any
		_ = json.Unmarshal([]byte(r.Patch), &ops)
		if len(ops) != 2 || ops[0]["op"] != "test" || ops[0]["value"] != float64(1) {
			t.Fatalf("patch should carry the old value as a test op: %s", r.Patch)
		}
	})

	t.Run("status only", func(t *testing.T) {
		after := obj(t, `{"metadata":{"name":"d","resourceVersion":"3"},"spec":{"replicas":1,"paused":false},"status":{"ready":0}}`)
		r, _ := Compute(before, after)
		if !r.StatusOnly {
			t.Fatalf("got %+v", r)
		}
	})

	t.Run("only noise", func(t *testing.T) {
		after := obj(t, `{"metadata":{"name":"d","resourceVersion":"9","generation":5},"spec":{"replicas":1,"paused":false},"status":{"ready":1}}`)
		r, _ := Compute(before, after)
		if !r.Empty {
			t.Fatalf("got %+v", r)
		}
	})

	t.Run("create and delete", func(t *testing.T) {
		r, _ := Compute(nil, before)
		if len(r.ChangedPaths) == 0 || r.Empty {
			t.Fatalf("create: %+v", r)
		}
		r, _ = Compute(before, nil)
		if len(r.ChangedPaths) == 0 || r.Empty {
			t.Fatalf("delete: %+v", r)
		}
	})
}

func TestContentHashIgnoresServerAssignedFields(t *testing.T) {
	admitted := obj(t, `{"metadata":{"name":"x","uid":"u","resourceVersion":"10","managedFields":[{"manager":"a"}]},
		"spec":{"a":1},"status":{"old":true}}`)
	persisted := obj(t, `{"metadata":{"name":"x","uid":"u","resourceVersion":"11"},
		"spec":{"a":1},"status":{"new":true}}`)
	if ContentHash(admitted) != ContentHash(persisted) {
		t.Fatal("hashes differ for the same write")
	}
	persisted["spec"].(map[string]any)["a"] = 2.0
	if ContentHash(admitted) == ContentHash(persisted) {
		t.Fatal("hashes equal for different content")
	}
	if ContentHash(nil) != "" {
		t.Fatal("nil object must hash to empty")
	}
}

func TestWriter(t *testing.T) {
	before := obj(t, `{"metadata":{"managedFields":[
		{"manager":"kubectl-create","operation":"Update","time":"2026-01-01T00:00:00Z"},
		{"manager":"kube-controller-manager","operation":"Update","subresource":"status","time":"2026-01-01T00:00:00Z"}]}}`)
	statusWrite := obj(t, `{"metadata":{"managedFields":[
		{"manager":"kubectl-create","operation":"Update","time":"2026-01-01T00:00:00Z"},
		{"manager":"kube-controller-manager","operation":"Update","subresource":"status","time":"2026-01-01T00:00:02Z"}]}}`)
	if got := Writer(before, statusWrite); got != "kube-controller-manager" {
		t.Fatalf("status write: got %q", got)
	}
	// A new manager appearing with an older timestamp than the newest entry
	// is still the writer.
	scaled := obj(t, `{"metadata":{"managedFields":[
		{"manager":"kubectl-create","operation":"Update","time":"2026-01-01T00:00:00Z"},
		{"manager":"kube-controller-manager","operation":"Update","subresource":"status","time":"2026-01-01T00:00:02Z"},
		{"manager":"kubectl","operation":"Update","subresource":"scale","time":"2026-01-01T00:00:01Z"}]}}`)
	if got := Writer(statusWrite, scaled); got != "kubectl" {
		t.Fatalf("scale: got %q", got)
	}
	if got := Writer(scaled, scaled); got != "kube-controller-manager" {
		t.Fatalf("nothing re-stamped falls back to the newest: got %q", got)
	}
	if got := Writer(nil, before); got != "kube-controller-manager" && got != "kubectl-create" {
		t.Fatalf("create: got %q", got)
	}
	if Writer(nil, obj(t, `{}`)) != "" {
		t.Fatal("expected empty")
	}
}
