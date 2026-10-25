package correlate

import (
	"context"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/kubeinspector/toolbox/internal/diff"
	"github.com/kubeinspector/toolbox/internal/discovery"
	"github.com/kubeinspector/toolbox/internal/model"
	"github.com/kubeinspector/toolbox/internal/watcher"
)

var deployments = discovery.Resource{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}, Kind: "Deployment", Namespaced: true}

func deploy(rv string, replicas int64, mutate ...func(*unstructured.Unstructured)) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": "web", "namespace": "ns", "uid": "uid-1", "resourceVersion": rv,
			"managedFields": []any{map[string]any{"manager": "kubectl-edit", "operation": "Update", "time": "2026-10-25T10:00:00Z"}}},
		"spec": map[string]any{"replicas": replicas},
	}}
	for _, m := range mutate {
		m(u)
	}
	return u
}

type fakeHints struct {
	hints []model.Hint
	err   error
}

func (f *fakeHints) HintsFor(_ context.Context, _ string, _ []string, from, to time.Time) ([]model.Hint, error) {
	var out []model.Hint
	for _, h := range f.hints {
		if !h.Time.Before(from) && !h.Time.After(to) {
			out = append(out, h)
		}
	}
	return out, f.err
}

type harness struct {
	c       *Correlator
	hints   *fakeHints
	written []model.Change
	now     time.Time
}

func newHarness() *harness {
	h := &harness{hints: &fakeHints{}, now: time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)}
	h.c = &Correlator{
		Cluster: "c1", Hints: h.hints, Delay: 15 * time.Second, RetryAfter: 90 * time.Second, Window: 2 * time.Minute,
		Put: func(ch model.Change) bool { h.written = append(h.written, ch); return true },
		Now: func() time.Time { return h.now },
	}
	return h
}

func (h *harness) update(old, new *unstructured.Unstructured) {
	h.c.Observe(watcher.Event{Type: watcher.Updated, Resource: deployments, Old: old, New: new, Observed: h.now})
}

func (h *harness) advance(d time.Duration) {
	h.now = h.now.Add(d)
	h.c.Step(context.Background(), false)
}

func key() model.ObjectKey {
	return model.ObjectKey{Group: "apps", Resource: "deployments", Namespace: "ns", Name: "web"}
}

func TestAuditExactResourceVersion(t *testing.T) {
	h := newHarness()
	h.update(deploy("1", 1), deploy("2", 3))
	h.hints.hints = []model.Hint{
		// A Metadata-level hint for the same object is a worse match.
		{ID: "a-other", Source: model.HintAudit, Time: h.now, Verb: model.VerbUpdate, Key: key(), Actor: model.Actor{Username: "wrong"}},
		{ID: "a1", Source: model.HintAudit, Time: h.now.Add(-time.Second), Verb: model.VerbUpdate, Key: key(),
			ObjectUID: "uid-1", ResourceVersion: "2", Actor: model.Actor{Username: "alice", SourceIPs: []string{"10.0.0.1"}}},
	}
	h.advance(10 * time.Second)
	if len(h.written) != 0 {
		t.Fatal("written before the delay")
	}
	h.advance(5 * time.Second)
	if len(h.written) != 1 {
		t.Fatalf("written = %d", len(h.written))
	}
	ch := h.written[0]
	if ch.Attribution != model.AttrAudit || ch.Actor.Username != "alice" || ch.Actor.SourceIPs[0] != "10.0.0.1" ||
		ch.Verb != model.VerbUpdate || ch.FieldManager != "kubectl-edit" || ch.ChangedPaths[0] != "/spec/replicas" {
		t.Fatalf("change = %+v", ch)
	}
}

func TestAdmissionHashMergedWithAudit(t *testing.T) {
	h := newHarness()
	newObj := deploy("2", 3)
	h.update(deploy("1", 1), newObj)
	h.hints.hints = []model.Hint{
		{ID: "adm", Source: model.HintAdmission, Time: h.now.Add(-time.Second), Verb: model.VerbUpdate, Key: key(),
			ObjectUID: "uid-1", ContentHash: diff.ContentHash(deploy("1", 3).Object), // admission saw the old RV
			Actor: model.Actor{Username: "alice", Groups: []string{"devs"}}},
		{ID: "aud", Source: model.HintAudit, Time: h.now.Add(-time.Second), Verb: model.VerbUpdate, Key: key(),
			Actor: model.Actor{Username: "alice", SourceIPs: []string{"10.0.0.9"}, UserAgent: "kubectl"}},
	}
	h.advance(15 * time.Second)
	ch := h.written[0]
	if ch.Attribution != model.AttrAudit || ch.Actor.Groups[0] != "devs" || ch.Actor.SourceIPs[0] != "10.0.0.9" || ch.Actor.UserAgent != "kubectl" {
		t.Fatalf("change = %+v", ch)
	}
}

func TestAdmissionOnly(t *testing.T) {
	h := newHarness()
	h.update(deploy("1", 1), deploy("2", 3))
	h.hints.hints = []model.Hint{
		{ID: "stale", Source: model.HintAdmission, Time: h.now, Verb: model.VerbUpdate, Key: key(),
			ObjectUID: "uid-1", ContentHash: diff.ContentHash(deploy("1", 7).Object), Actor: model.Actor{Username: "bob"}},
		{ID: "adm", Source: model.HintAdmission, Time: h.now, Verb: model.VerbUpdate, Key: key(),
			ObjectUID: "uid-1", ContentHash: diff.ContentHash(deploy("1", 3).Object), Actor: model.Actor{Username: "alice"}},
	}
	h.advance(15 * time.Second)
	if ch := h.written[0]; ch.Attribution != model.AttrAdmission || ch.Actor.Username != "alice" {
		t.Fatalf("change = %+v", ch)
	}
}

func TestMetadataLevelAuditByTimeAndHintsAreSpentOnce(t *testing.T) {
	h := newHarness()
	h.update(deploy("1", 1), deploy("2", 2))
	h.now = h.now.Add(time.Second)
	h.update(deploy("2", 2), deploy("3", 3))
	h.hints.hints = []model.Hint{
		{ID: "only", Source: model.HintAudit, Time: h.now.Add(-200 * time.Millisecond), Verb: model.VerbUpdate, Key: key(), Actor: model.Actor{Username: "alice"}},
	}
	h.advance(15 * time.Second)
	if len(h.written) != 2 {
		t.Fatalf("written = %d", len(h.written))
	}
	var attributed int
	for _, ch := range h.written {
		if ch.Attribution == model.AttrAudit {
			attributed++
			if ch.ResourceVersion != "3" {
				t.Fatalf("hint went to the farther change: %+v", ch)
			}
		}
	}
	if attributed != 1 {
		t.Fatalf("one hint attributed %d changes", attributed)
	}
}

// A controller's write through a subresource the webhook does not see
// (deployments/status) has no hint of its own. A kubectl scale two seconds
// later must not lend it its hint just because the earlier change came due
// first.
func TestTimeMatchWaitsForLaterChangesStillPending(t *testing.T) {
	h := newHarness()
	h.update(deploy("1", 1), deploy("2", 1, func(u *unstructured.Unstructured) {
		u.SetAnnotations(map[string]string{"deployment.kubernetes.io/revision": "1"})
	}))
	h.now = h.now.Add(2300 * time.Millisecond)
	h.update(deploy("2", 1), deploy("3", 2))
	h.hints.hints = []model.Hint{{ID: "scale", Source: model.HintAdmission, Subresource: "scale",
		Time: h.now.Add(-7 * time.Millisecond), Verb: model.VerbUpdate, Key: key(), Actor: model.Actor{Username: "alice"}}}

	h.advance(12700 * time.Millisecond) // only the controller's change is due
	if len(h.written) != 1 || h.written[0].Actor.Username != "" {
		t.Fatalf("earlier change took the later change's hint: %+v", h.written)
	}
	h.advance(3 * time.Second)
	if len(h.written) != 2 || h.written[1].ResourceVersion != "3" || h.written[1].Actor.Username != "alice" {
		t.Fatalf("scale not attributed: %+v", h.written)
	}
}

func TestFallbackThenLateHintRewrites(t *testing.T) {
	h := newHarness()
	h.update(deploy("1", 1), deploy("2", 3))
	h.advance(15 * time.Second)
	if ch := h.written[0]; ch.Attribution != model.AttrManagedFields || ch.Version != 1 || ch.Actor.Username != "" {
		t.Fatalf("first write = %+v", ch)
	}
	first := h.written[0]

	h.hints.hints = []model.Hint{{ID: "late", Source: model.HintAudit, Time: first.Time.Add(-time.Second),
		Verb: model.VerbUpdate, Key: key(), ResourceVersion: "2", Actor: model.Actor{Username: "alice"}}}
	h.advance(80 * time.Second)
	if len(h.written) != 2 {
		t.Fatalf("written = %d", len(h.written))
	}
	re := h.written[1]
	if re.EventID != first.EventID || re.Time != first.Time || re.Version != 2 || re.Actor.Username != "alice" {
		t.Fatalf("rewrite must keep the row key and bump the version: %+v", re)
	}
	h.advance(5 * time.Minute)
	if len(h.written) != 2 {
		t.Fatal("retried more than once")
	}
}

func TestNoRetryRewriteWhenStillUnattributed(t *testing.T) {
	h := newHarness()
	h.update(deploy("1", 1), deploy("2", 3))
	h.advance(15 * time.Second)
	h.advance(2 * time.Minute)
	if len(h.written) != 1 {
		t.Fatalf("written = %d", len(h.written))
	}
}

func TestBuildVerbsAndFiltering(t *testing.T) {
	now := time.Now()
	deleting := func(u *unstructured.Unstructured) {
		u.SetDeletionTimestamp(nil)
		u.Object["metadata"].(map[string]any)["deletionTimestamp"] = "2026-10-25T10:00:00Z"
	}
	statusOnly := func(u *unstructured.Unstructured) { u.Object["status"] = map[string]any{"ready": int64(1)} }

	cases := []struct {
		name string
		ev   watcher.Event
		verb model.Verb
		keep bool
	}{
		{"create", watcher.Event{Type: watcher.Added, New: deploy("1", 1)}, model.VerbCreate, true},
		{"update", watcher.Event{Type: watcher.Updated, Old: deploy("1", 1), New: deploy("2", 2)}, model.VerbUpdate, true},
		{"delete requested", watcher.Event{Type: watcher.Updated, Old: deploy("1", 1), New: deploy("2", 1, deleting)}, model.VerbDelete, true},
		{"immediate delete", watcher.Event{Type: watcher.Deleted, Old: deploy("1", 1)}, model.VerbDelete, true},
		{"finalized", watcher.Event{Type: watcher.Deleted, Old: deploy("3", 1, deleting)}, model.VerbFinalized, true},
		{"status only", watcher.Event{Type: watcher.Updated, Old: deploy("1", 1), New: deploy("2", 1, statusOnly)}, "", false},
		{"rv only", watcher.Event{Type: watcher.Updated, Old: deploy("1", 1), New: deploy("2", 1)}, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.ev.Resource, tc.ev.Observed = deployments, now
			ch, _, ok := Build(tc.ev, "c1", false)
			if ok != tc.keep || (ok && ch.Verb != tc.verb) {
				t.Fatalf("ok=%v verb=%q", ok, ch.Verb)
			}
		})
	}
}

// A graceful delete is two requests: the first sets deletionTimestamp, the
// kubelet's later one removes the pod. Only a later one attributes the removal;
// an object whose finalizers ran out has none and stays unattributed.
func TestFinalizedTakesALaterDelete(t *testing.T) {
	deleting := func(u *unstructured.Unstructured) {
		u.Object["metadata"].(map[string]any)["deletionTimestamp"] = "2026-10-25T10:00:00Z"
	}
	del := func(id, user string, at time.Time, src model.HintSource) model.Hint {
		return model.Hint{ID: id, Source: src, Time: at, Verb: model.VerbDelete, Key: key(), ObjectUID: "uid-1",
			Actor: model.Actor{Username: user}}
	}
	finalized := func(h *harness) {
		h.c.Observe(watcher.Event{Type: watcher.Deleted, Resource: deployments, Old: deploy("3", 1, deleting), Observed: h.now})
	}

	h := newHarness()
	start := h.now
	h.hints.hints = []model.Hint{
		del("adm-rs", "replicaset-controller", start, model.HintAdmission),
		del("aud-rs", "replicaset-controller", start.Add(-time.Millisecond), model.HintAudit),
		del("adm-kubelet", "system:node:n1", start.Add(time.Second), model.HintAdmission),
	}
	h.now = start.Add(time.Second + 10*time.Millisecond)
	finalized(h)
	h.advance(15 * time.Second)
	if ch := h.written[0]; ch.Verb != model.VerbFinalized || ch.Actor.Username != "system:node:n1" || ch.Attribution != model.AttrAdmission {
		t.Fatalf("change = %+v", ch)
	}

	h = newHarness()
	h.hints.hints = []model.Hint{
		del("adm-user", "alice", h.now, model.HintAdmission),
		del("aud-user", "alice", h.now.Add(-time.Millisecond), model.HintAudit),
	}
	h.now = h.now.Add(3 * time.Second)
	finalized(h)
	h.advance(15 * time.Second)
	if ch := h.written[0]; ch.Actor.Username != "" || ch.Attribution != model.AttrNone {
		t.Fatalf("the request that only marked it for deletion took the removal: %+v", ch)
	}
}

func TestShutdownFlushesPending(t *testing.T) {
	h := newHarness()
	h.update(deploy("1", 1), deploy("2", 3))
	h.c.Step(context.Background(), true)
	if len(h.written) != 1 {
		t.Fatalf("written = %d", len(h.written))
	}
}
