package auditsink

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kubeinspector/toolbox/internal/config"
	"github.com/kubeinspector/toolbox/internal/model"
)

// A trimmed EventList as the API server's webhook backend sends it.
const batch = `{"kind":"EventList","apiVersion":"audit.k8s.io/v1","items":[
 {"level":"RequestResponse","auditID":"a-patch","stage":"ResponseComplete",
  "requestURI":"/apis/apps/v1/namespaces/ns/deployments/web","verb":"patch",
  "user":{"username":"alice","uid":"u-a","groups":["devs","system:authenticated"]},
  "impersonatedUser":{"username":"bob","groups":["ops"]},
  "sourceIPs":["10.1.2.3"],"userAgent":"kubectl/v1.36.0 (linux/amd64)",
  "objectRef":{"resource":"deployments","namespace":"ns","name":"web","apiGroup":"apps","apiVersion":"v1"},
  "responseStatus":{"metadata":{},"code":200},
  "responseObject":{"kind":"Deployment","metadata":{"name":"web","uid":"obj-1","resourceVersion":"777"}},
  "requestReceivedTimestamp":"2026-10-25T10:00:00.123456Z","stageTimestamp":"2026-10-25T10:00:00.200000Z"},
 {"level":"Metadata","auditID":"a-create","stage":"ResponseComplete",
  "requestURI":"/api/v1/namespaces/ns/configmaps","verb":"create",
  "user":{"username":"carol"},"sourceIPs":["10.9.9.9"],"userAgent":"helm",
  "objectRef":{"resource":"configmaps","namespace":"ns","apiVersion":"v1"},
  "responseStatus":{"code":201},"requestReceivedTimestamp":"2026-10-25T10:00:01Z"},
 {"level":"Metadata","auditID":"a-denied","stage":"ResponseComplete",
  "requestURI":"/api/v1/namespaces/ns/secrets/s","verb":"delete",
  "user":{"username":"mallory"},"sourceIPs":["6.6.6.6"],
  "objectRef":{"resource":"secrets","namespace":"ns","name":"s","apiVersion":"v1"},
  "responseStatus":{"code":403,"reason":"Forbidden","message":"nope"},"requestReceivedTimestamp":"2026-10-25T10:00:02Z"},
 {"level":"Metadata","auditID":"a-started","stage":"ResponseStarted","verb":"create",
  "objectRef":{"resource":"pods"},"responseStatus":{"code":201}},
 {"level":"Metadata","auditID":"a-get","stage":"ResponseComplete","verb":"get",
  "objectRef":{"resource":"pods"},"responseStatus":{"code":200}},
 {"level":"Metadata","auditID":"a-dry","stage":"ResponseComplete","verb":"create",
  "requestURI":"/api/v1/namespaces/ns/pods?dryRun=All",
  "objectRef":{"resource":"pods","namespace":"ns"},"responseStatus":{"code":201}},
 {"level":"Metadata","auditID":"a-lease","stage":"ResponseComplete","verb":"update",
  "objectRef":{"resource":"leases","apiGroup":"coordination.k8s.io","name":"x"},"responseStatus":{"code":200}}
]}`

func TestBatch(t *testing.T) {
	var hints []model.Hint
	var audits []model.AuditRecord
	h := &Handler{
		Cluster:  "c1",
		Filter:   config.Default().Watch.Filter(),
		Token:    "secret",
		PutHint:  func(x model.Hint) bool { hints = append(hints, x); return true },
		PutAudit: func(x model.AuditRecord) bool { audits = append(audits, x); return true },
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/audit", bytes.NewBufferString(batch)))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing token accepted: %d", rec.Code)
	}

	req := httptest.NewRequest(http.MethodPost, "/audit", bytes.NewBufferString(batch))
	req.Header.Set("Authorization", "Bearer secret")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}

	if len(audits) != 3 {
		t.Fatalf("audit records = %+v", audits)
	}
	if audits[2].ResponseCode != 403 || audits[2].Username != "mallory" || audits[2].ResponseReason != "Forbidden" {
		t.Fatalf("denied record = %+v", audits[2])
	}
	if len(hints) != 2 {
		t.Fatalf("hints = %+v", hints)
	}
	p := hints[0]
	if p.ID != "a-patch" || p.Verb != model.VerbUpdate || p.ResourceVersion != "777" || p.ObjectUID != "obj-1" ||
		p.Actor.Username != "bob" || p.Actor.ImpersonatedBy != "alice" || p.Actor.SourceIPs[0] != "10.1.2.3" ||
		p.Actor.UserAgent == "" || p.Time.Nanosecond() != 123456000 {
		t.Fatalf("patch hint = %+v", p)
	}
	c := hints[1]
	if c.Verb != model.VerbCreate || c.Key.Name != "" || c.ResourceVersion != "" || c.Actor.Username != "carol" {
		t.Fatalf("metadata-level create hint = %+v", c)
	}
}

func TestSubresourceCreateIsAParentUpdate(t *testing.T) {
	for sub, want := range map[string]model.Verb{"binding": model.VerbUpdate, "eviction": model.VerbDelete, "": model.VerbCreate} {
		if got := parentVerb(model.VerbCreate, sub); got != want {
			t.Errorf("create on %q: got %s want %s", sub, got, want)
		}
	}
	if parentVerb(model.VerbUpdate, "status") != model.VerbUpdate {
		t.Error("update on a subresource must stay an update")
	}
}

func TestUndecodableBatchIsAcknowledged(t *testing.T) {
	h := &Handler{Filter: config.Default().Watch.Filter()}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/audit", bytes.NewBufferString("not json")))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d; the API server would resend this forever", rec.Code)
	}
}
