package business

import (
	"strings"
	"testing"

	"kube-ins/internal/models"
)

func TestHistoryMessagesReplaysToolsAndDropsEmptyTurns(t *testing.T) {
	turn := chatMsg{Role: "assistant", Content: "Two pods.", Tools: []chatToolMsg{
		{ID: "1", Name: "list_pods", Status: "done", Result: `[{"name":"a"}]`},
	}}
	got := historyMessages(true, turn)
	if len(got) != 3 || len(got[0].ToolCalls) != 1 || got[1].Role != "tool" || got[2].Content != "Two pods." {
		t.Fatalf("native = %+v", got)
	}
	if empty := historyMessages(true, chatMsg{Role: "assistant"}); len(empty) != 0 {
		t.Fatalf("an empty turn produced %+v", empty)
	}
	if u := historyMessages(false, chatMsg{Role: "user", Content: "hi"}); len(u) != 1 || u[0].Content != "hi" {
		t.Fatalf("user = %+v", u)
	}
}

func TestCompactEventsPutsWarningsFirst(t *testing.T) {
	got := compactEvents([]models.EventInfo{
		{Type: "Normal", Reason: "Pulled", Namespace: "a"},
		{Type: "Warning", Reason: "BackOff", Namespace: "a", ObjectKind: "Pod", Object: "web"},
		{Type: "Warning", Reason: "Other", Namespace: "b"},
	}, "a", "")
	if len(got) != 2 || got[0].Reason != "BackOff" || got[0].Object != "pod/web" {
		t.Fatalf("compactEvents = %+v", got)
	}
}

func TestArgKindAndInt(t *testing.T) {
	for in, want := range map[string]string{"Deployment": "deployment", "deploy": "deployment", "sts": "statefulset", "DaemonSets": "daemonset"} {
		if got := argKind(map[string]any{"kind": in}); got != want {
			t.Errorf("argKind(%q) = %q, want %q", in, got, want)
		}
	}
	if argInt(map[string]any{"n": "3"}, "n", -1) != 3 || argInt(map[string]any{"n": 4.0}, "n", -1) != 4 || argInt(nil, "n", -1) != -1 {
		t.Error("argInt")
	}
}

func TestResourceTableTextSkipsWideColumns(t *testing.T) {
	got := resourceTableText(models.ResourceTable{
		Columns: []models.ResourceTableColumn{{Name: "Name"}, {Name: "IP", Priority: 1}, {Name: "Age"}},
		Rows:    []models.ResourceTableRow{{Namespace: "shop", Cells: []string{"api", "10.0.0.1", "3d"}}},
	})
	if want := "NAMESPACE\tNAME\tAGE\nshop\tapi\t3d\n"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if !strings.Contains(resourceTableText(models.ResourceTable{}), "no objects") {
		t.Fatal("empty table")
	}
}

func TestMetricsSummaryWithoutMetricsServer(t *testing.T) {
	if got := metricsSummary(models.MetricsSnapshot{}, "", 5); !strings.Contains(got, "metrics-server") {
		t.Fatalf("got %q", got)
	}
}
