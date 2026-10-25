package admission

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	admissionv1 "k8s.io/api/admission/v1"

	"github.com/kubeinspector/toolbox/internal/config"
	"github.com/kubeinspector/toolbox/internal/diff"
	"github.com/kubeinspector/toolbox/internal/model"
)

func review(t *testing.T, h *Handler, req string) admissionv1.AdmissionReview {
	t.Helper()
	body := `{"apiVersion":"admission.k8s.io/v1","kind":"AdmissionReview","request":` + req + `}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/admission", bytes.NewBufferString(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var out admissionv1.AdmissionReview
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func newHandler(hints *[]model.Hint) *Handler {
	return &Handler{
		Cluster: "c1",
		Filter:  config.Default().Watch.Filter(),
		Put:     func(h model.Hint) bool { *hints = append(*hints, h); return true },
	}
}

func TestAlwaysAllowsAndRecordsUpdate(t *testing.T) {
	var hints []model.Hint
	h := newHandler(&hints)
	obj := `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web","namespace":"ns","uid":"u1","resourceVersion":"5"},"spec":{"replicas":3}}`
	out := review(t, h, `{"uid":"req-1","operation":"UPDATE","namespace":"ns","name":"web",
		"resource":{"group":"apps","version":"v1","resource":"deployments"},
		"userInfo":{"username":"alice","groups":["devs"],"extra":{"scopes":["a"]}},
		"object":`+obj+`,"oldObject":`+obj+`}`)

	if out.Response == nil || !out.Response.Allowed || out.Response.UID != "req-1" || out.Request != nil {
		t.Fatalf("response = %+v", out.Response)
	}
	if out.APIVersion != "admission.k8s.io/v1" || out.Kind != "AdmissionReview" {
		t.Fatalf("envelope lost: %+v", out.TypeMeta)
	}
	if len(hints) != 1 {
		t.Fatalf("hints = %v", hints)
	}
	got := hints[0]
	var m map[string]any
	_ = json.Unmarshal([]byte(obj), &m)
	if got.ID != "req-1" || got.Verb != model.VerbUpdate || got.ObjectUID != "u1" || got.Actor.Username != "alice" ||
		got.Actor.Extra["scopes"][0] != "a" || got.ContentHash != diff.ContentHash(m) || got.Key.Name != "web" {
		t.Fatalf("hint = %+v", got)
	}
}

func TestSkipsDryRunExcludedAndConnect(t *testing.T) {
	var hints []model.Hint
	h := newHandler(&hints)
	for _, req := range []string{
		`{"uid":"1","operation":"CREATE","dryRun":true,"resource":{"resource":"configmaps"},"object":{}}`,
		`{"uid":"2","operation":"UPDATE","resource":{"group":"coordination.k8s.io","resource":"leases"},"object":{}}`,
		`{"uid":"3","operation":"CONNECT","resource":{"resource":"pods"},"subResource":"exec"}`,
	} {
		if out := review(t, h, req); !out.Response.Allowed {
			t.Fatalf("not allowed: %s", req)
		}
	}
	if len(hints) != 0 {
		t.Fatalf("expected no hints, got %+v", hints)
	}
}

func TestSubresourceAndDeleteCarryNoHash(t *testing.T) {
	var hints []model.Hint
	h := newHandler(&hints)
	review(t, h, `{"uid":"s","operation":"UPDATE","namespace":"ns","name":"web","subResource":"scale",
		"resource":{"group":"apps","resource":"deployments"},"userInfo":{"username":"bob"},
		"object":{"kind":"Scale","metadata":{"name":"web","uid":"u1"},"spec":{"replicas":2}}}`)
	review(t, h, `{"uid":"d","operation":"DELETE","namespace":"ns","name":"web",
		"resource":{"group":"apps","resource":"deployments"},"userInfo":{"username":"bob"},
		"oldObject":{"metadata":{"name":"web","uid":"u1"}}}`)
	if len(hints) != 2 || hints[0].ContentHash != "" || hints[1].ContentHash != "" ||
		hints[1].Verb != model.VerbDelete || hints[1].ObjectUID != "u1" {
		t.Fatalf("hints = %+v", hints)
	}
}

func TestRejectsGarbage(t *testing.T) {
	var hints []model.Hint
	h := newHandler(&hints)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/admission", bytes.NewBufferString("{")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d", rec.Code)
	}
}
