package tui

import (
	"testing"

	"kube-ins/internal/models"
)

func TestParseHistoryFilter(t *testing.T) {
	f, err := parseHistoryFilter("ns=prod user=alice verb=update since=7d")
	if err != nil || f.Namespace != "prod" || f.User != "alice" || f.Verb != "update" || f.Since != "168h" || f.Limit != historyPage {
		t.Fatalf("f = %+v err = %v", f, err)
	}
	// Round trip through the prompt's text.
	if g, err := parseHistoryFilter(historyFilterText(f)); err != nil || g != f {
		t.Fatalf("round trip: %+v vs %+v (%v)", g, f, err)
	}
	if f, _ := parseHistoryFilter(""); f.Since != "24h" || f.Namespace != "" {
		t.Fatalf("empty line must reset to the default: %+v", f)
	}
	if f, _ := parseHistoryFilter("since=all"); f.Since != "" {
		t.Fatalf("since=all: %+v", f)
	}
	for _, bad := range []string{"verb=patch", "since=soon", "since=0d", "color=red", "namespace"} {
		if _, err := parseHistoryFilter(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestHistoryRow(t *testing.T) {
	r := historyRow(models.ToolboxChange{EventID: "e", Verb: "update", Kind: "Deployment", Namespace: "ns", Name: "web",
		FieldManager: "helm", Attribution: "managedFields", ChangedPaths: []string{"/a", "/b", "/c", "/d"}})
	if r.name != "web" || r.namespace != "ns" || r.cells[5] != "(helm)" || r.cells[7] != "/a /b /c …" {
		t.Fatalf("row = %+v", r)
	}
	if _, ok := r.ref.(models.ToolboxChange); !ok {
		t.Fatal("row does not carry its change for the undo")
	}
}
