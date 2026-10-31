package controller_app

import (
	"testing"

	"kube-ins/internal/models"
)

func TestClusterScanRegistryReturnsRunning(t *testing.T) {
	r := newTrivyScanRegistry()

	id1, started, ctx1, tok1 := r.begin("c1")
	if !started || id1 == "" {
		t.Fatalf("first begin = %q, %v; want a new id, true", id1, started)
	}

	again, started, _, _ := r.begin("c1")
	if started || again != id1 {
		t.Fatalf("second begin = %q, %v; want %q, false", again, started, id1)
	}

	other, started, _, tokOther := r.begin("c2")
	if !started || other == id1 {
		t.Fatalf("other cluster begin = %q, %v", other, started)
	}
	defer r.finish(other, tokOther)

	if !r.finish(id1, tok1) {
		t.Fatal("finish of the current scan reported not owned")
	}
	if ctx1.Err() == nil {
		t.Error("finish did not release the scan's context")
	}
	if r.running("c1") != nil {
		t.Error("finished scan still running")
	}

	id2, started, _, tok2 := r.begin("c1")
	if !started || id2 == id1 {
		t.Fatalf("begin after finish = %q, %v; want a new id", id2, started)
	}
	// A stale token never removes the scan that replaced it.
	if r.finish(id1, tok1) {
		t.Error("stale finish reported owned")
	}
	if got := r.running("c1"); got == nil || got.ScanID != id2 {
		t.Errorf("running(c1) = %+v, want %q", got, id2)
	}
	r.finish(id2, tok2)
}

func TestClusterScanRegistryProgressAndCancel(t *testing.T) {
	r := newTrivyScanRegistry()
	id, _, ctx, tok := r.begin("c1")

	if !r.progress(id, models.TrivyScanProgress{Phase: "images", Current: 1, Total: 3}) {
		t.Fatal("progress of a running scan rejected")
	}
	if got := r.running("c1"); got == nil || got.Progress.Phase != "images" || got.Progress.Current != 1 {
		t.Fatalf("running = %+v, want last progress", got)
	}

	if !r.cancel(id) {
		t.Fatal("cancel of a running scan reported not found")
	}
	if ctx.Err() == nil {
		t.Error("cancel did not cancel the scan's context")
	}
	if got := r.running("c1"); got == nil || got.Progress.Phase != "stopping" {
		t.Fatalf("running after cancel = %+v, want phase stopping", got)
	}
	// Progress that arrives after Stop must not overwrite "stopping".
	if r.progress(id, models.TrivyScanProgress{Phase: "images", Current: 2, Total: 3}) {
		t.Error("progress accepted after cancel")
	}
	if r.running("c1").Progress.Phase != "stopping" {
		t.Error("late progress overwrote stopping")
	}

	if r.cancel("no-such-id") {
		t.Error("cancel of an unknown id reported found")
	}
	if !r.finish(id, tok) {
		t.Error("finish after cancel reported not owned")
	}
	if r.progress(id, models.TrivyScanProgress{Phase: "images"}) {
		t.Error("progress accepted after finish")
	}
}
