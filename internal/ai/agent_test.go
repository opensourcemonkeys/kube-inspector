package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/ollama/ollama/api"
	"kube-ins/internal/models"
)

// fakeOllama serves /api/show and a scripted /api/chat: each request pops the
// next reply, streamed as the given chunks.
type fakeOllama struct {
	mu       sync.Mutex
	tools    bool
	ctxLen   int
	replies  [][]api.ChatResponse
	requests []api.ChatRequest
}

func (f *fakeOllama) server(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/show":
			caps := []string{"completion"}
			if f.tools {
				caps = append(caps, "tools")
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"capabilities": caps,
				"model_info":   map[string]any{"llama.context_length": f.ctxLen},
			})
		case "/api/chat":
			var req api.ChatRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			f.mu.Lock()
			f.requests = append(f.requests, req)
			var reply []api.ChatResponse
			if len(f.replies) > 0 {
				reply, f.replies = f.replies[0], f.replies[1:]
			}
			f.mu.Unlock()
			w.Header().Set("Content-Type", "application/x-ndjson")
			for i, c := range reply {
				c.Done = i == len(reply)-1
				_ = json.NewEncoder(w).Encode(c)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func chunk(s string) api.ChatResponse {
	return api.ChatResponse{Message: api.Message{Role: "assistant", Content: s}}
}

func resetFacts() {
	factsMu.Lock()
	factsCache = map[string]modelFacts{}
	factsMu.Unlock()
}

type run struct {
	tokens    []string
	screen    string // what the frontend shows: tokens applied, retractions too
	retracted int
	tools     []ToolEvent
	asked     []*models.AiActionPreview
}

// text is what the user is left with (the tests use ASCII, so bytes and
// UTF-16 units agree).
func (r *run) text() string { return r.screen }

func runChat(t *testing.T, f *fakeOllama, tools []Tool, approve bool) (*run, error) {
	t.Helper()
	resetFacts()
	srv := f.server(t)
	r := &run{}
	native := SupportsTools(srv.URL, "m")
	err := RunChat(context.Background(), srv.URL, "m", "c1",
		[]api.Message{{Role: "system", Content: "sys"}, {Role: "user", Content: "hi"}},
		tools, native,
		func(s string) { r.tokens = append(r.tokens, s); r.screen += s },
		func(n int) { r.retracted += n; r.screen = r.screen[:len(r.screen)-n] },
		func(ev ToolEvent) { r.tools = append(r.tools, ev) },
		func(id, name string, args map[string]any, p *models.AiActionPreview) bool {
			r.asked = append(r.asked, p)
			return approve
		})
	return r, err
}

func TestRunChatStreamsProseAndSetsNumCtx(t *testing.T) {
	f := &fakeOllama{ctxLen: 131072, replies: [][]api.ChatResponse{{chunk("Hel"), chunk("lo "), chunk("there")}}}
	r, err := runChat(t, f, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.tokens) != 3 || r.text() != "Hello there" {
		t.Fatalf("tokens = %q", r.tokens)
	}
	if got := f.requests[0].Options["num_ctx"]; got != float64(maxNumCtx) {
		t.Fatalf("num_ctx = %v, want the %d cap", got, maxNumCtx)
	}
}

func TestRunChatNeverShowsTextToolCall(t *testing.T) {
	listed := false
	tools := []Tool{{Name: "list_pods", Run: func(string, map[string]any) (string, error) { listed = true; return "[]", nil }}}
	f := &fakeOllama{replies: [][]api.ChatResponse{
		{chunk("```json\n{\"name\": \"list_"), chunk("pods\", \"arguments\": {}}\n```")},
		{chunk("No pods.")},
	}}
	r, err := runChat(t, f, tools, false)
	if err != nil {
		t.Fatal(err)
	}
	if !listed {
		t.Fatal("tool was not run")
	}
	if r.text() != "No pods." {
		t.Fatalf("user saw %q", r.text())
	}
}

func TestRunChatRecognisesNamedCallAndRetractsIt(t *testing.T) {
	var got map[string]any
	tools := []Tool{{Name: "list_pods", Run: func(_ string, args map[string]any) (string, error) { got = args; return "[]", nil }}}
	f := &fakeOllama{tools: true, replies: [][]api.ChatResponse{
		{chunk("`list_pods "), chunk(`{"namespace": "kube-system"}`), chunk("`")},
		{chunk("Nothing there.")},
	}}
	r, err := runChat(t, f, tools, false)
	if err != nil {
		t.Fatal(err)
	}
	if got["namespace"] != "kube-system" {
		t.Fatalf("tool ran with %v", got)
	}
	if r.retracted == 0 || r.text() != "Nothing there." {
		t.Fatalf("user saw %q (retracted %d)", r.text(), r.retracted)
	}
}

func TestParseTextToolCallsIgnoresUnknownNames(t *testing.T) {
	known := map[string]Tool{"list_pods": {}}
	if got := parseTextToolCalls(`Example config: {"replicas": 3}`, known); len(got) != 0 {
		t.Fatalf("prose JSON parsed as %+v", got)
	}
	if got := parseTextToolCalls("Run (list_pods: {\"namespace\":\"a\"})", known); len(got) != 1 || got[0].args["namespace"] != "a" {
		t.Fatalf("named call = %+v", got)
	}
}

func TestRunChatReleasesHeldProse(t *testing.T) {
	f := &fakeOllama{replies: [][]api.ChatResponse{{chunk("Use `kubectl` with "), chunk("{braces} and ``"), chunk("` fences")}}}
	r, err := runChat(t, f, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := "Use `kubectl` with {braces} and ``` fences"; r.text() != want {
		t.Fatalf("text = %q, want %q", r.text(), want)
	}
}

func TestRunChatRejectedDryRunSkipsConfirm(t *testing.T) {
	ran := false
	tools := []Tool{{
		Name: "delete_object", Mutating: true,
		Preview: func(string, map[string]any) (models.AiActionPreview, error) {
			return models.AiActionPreview{}, errors.New(`pods "x" not found`)
		},
		Run: func(string, map[string]any) (string, error) { ran = true; return "", nil },
	}}
	f := &fakeOllama{tools: true, replies: [][]api.ChatResponse{
		{{Message: api.Message{Role: "assistant", ToolCalls: []api.ToolCall{{ID: "1", Function: api.ToolCallFunction{Name: "delete_object"}}}}}},
		{chunk("It does not exist.")},
	}}
	r, err := runChat(t, f, tools, true)
	if err != nil {
		t.Fatal(err)
	}
	if ran || len(r.asked) != 0 {
		t.Fatalf("ran=%v asked=%d; a rejected dry run must neither ask nor run", ran, len(r.asked))
	}
	last := r.tools[len(r.tools)-1]
	if last.Status != "error" || !strings.Contains(last.Result, "dry run rejected") {
		t.Fatalf("last event = %+v", last)
	}
	second := f.requests[1].Messages
	if res := second[len(second)-1]; res.Role != "tool" || !strings.Contains(res.Content, "rejected a dry run") {
		t.Fatalf("model was told %+v", res)
	}
}

func TestRunChatAcceptedDryRunIsShownThenRun(t *testing.T) {
	ran := false
	preview := models.AiActionPreview{Items: []models.AiPreviewItem{{Verb: "delete", Name: "x"}}}
	tools := []Tool{{
		Name: "delete_object", Mutating: true,
		Preview: func(string, map[string]any) (models.AiActionPreview, error) { return preview, nil },
		Run:     func(string, map[string]any) (string, error) { ran = true; return "deleted", nil },
	}}
	f := &fakeOllama{tools: true, replies: [][]api.ChatResponse{
		{{Message: api.Message{Role: "assistant", ToolCalls: []api.ToolCall{{ID: "1", Function: api.ToolCallFunction{Name: "delete_object"}}}}}},
		{chunk("Done.")},
	}}
	r, err := runChat(t, f, tools, true)
	if err != nil {
		t.Fatal(err)
	}
	if !ran || len(r.asked) != 1 || r.asked[0] == nil || r.asked[0].Items[0].Name != "x" {
		t.Fatalf("ran=%v asked=%v", ran, r.asked)
	}
}

func TestRunChatToolLimit(t *testing.T) {
	tools := []Tool{{Name: "list_pods", Run: func(string, map[string]any) (string, error) { return "[]", nil }}}
	f := &fakeOllama{tools: true}
	for i := 0; i < maxIterations; i++ {
		f.replies = append(f.replies, []api.ChatResponse{{Message: api.Message{Role: "assistant", ToolCalls: []api.ToolCall{{Function: api.ToolCallFunction{Name: "list_pods"}}}}}})
	}
	if _, err := runChat(t, f, tools, false); !errors.Is(err, ErrToolLimit) {
		t.Fatalf("err = %v, want ErrToolLimit", err)
	}
}

func TestReadOnlyDropsMutatingTools(t *testing.T) {
	got := ReadOnly([]Tool{{Name: "list_pods"}, {Name: "delete_object", Mutating: true}})
	if len(got) != 1 || got[0].Name != "list_pods" {
		t.Fatalf("ReadOnly = %+v", got)
	}
}

func TestFitHistoryKeepsSystemAndNewestTurn(t *testing.T) {
	big := strings.Repeat("x", 3000)
	msgs := []api.Message{
		{Role: "system", Content: "sys"},
		{Role: "user", Content: "old " + big},
		{Role: "assistant", ToolCalls: []api.ToolCall{{Function: api.ToolCallFunction{Name: "list_pods"}}}},
		{Role: "tool", Content: big},
		{Role: "assistant", Content: "old answer"},
		{Role: "user", Content: "new question"},
	}
	got := FitHistory(msgs, 200)
	if len(got) != 2 || got[0].Content != "sys" || got[1].Content != "new question" {
		t.Fatalf("FitHistory kept %+v", got)
	}
	if all := FitHistory(msgs, 1_000_000); len(all) != len(msgs) {
		t.Fatalf("history that fits was cut to %d", len(all))
	}
}

func TestFitHistoryNeverSplitsToolResultsFromTheirCall(t *testing.T) {
	msgs := []api.Message{
		{Role: "system", Content: "sys"},
		{Role: "user", Content: "q1"},
		{Role: "assistant", Content: `{"tool":"list_pods"}`},
		{Role: "user", Content: toolResultPrefix + "list_pods):\n" + strings.Repeat("x", 3000)},
		{Role: "assistant", Content: "a1"},
		{Role: "user", Content: "q2"},
	}
	got := FitHistory(msgs, 300)
	for _, m := range got {
		if strings.HasPrefix(m.Content, toolResultPrefix) {
			t.Fatalf("an orphaned tool result survived: %+v", got)
		}
	}
}

func TestTruncateResult(t *testing.T) {
	s := strings.Repeat("line\n", 100)
	got := TruncateResult(s, 52)
	if !strings.HasPrefix(got, strings.Repeat("line\n", 10)[:49]) || !strings.Contains(got, "truncated") {
		t.Fatalf("TruncateResult = %q", got)
	}
	if TruncateResult("short", 10) != "short" {
		t.Fatal("a short result was changed")
	}
}

func TestReplayToolCalls(t *testing.T) {
	calls := []ReplayedCall{
		{ID: "a", Name: "list_pods", Status: "done", Result: "[]"},
		{ID: "b", Name: "delete_object", Status: "declined"},
		{ID: "c", Name: "list_events", Status: "running"},
	}
	native := ReplayToolCalls(true, calls)
	if len(native) != 3 || len(native[0].ToolCalls) != 2 || native[1].Role != "tool" || native[2].Content != DeclinedResult {
		t.Fatalf("native replay = %+v", native)
	}
	prompt := ReplayToolCalls(false, calls)
	if len(prompt) != 4 || prompt[0].Role != "assistant" || !strings.HasPrefix(prompt[1].Content, toolResultPrefix+"list_pods") {
		t.Fatalf("prompt replay = %+v", prompt)
	}
}
