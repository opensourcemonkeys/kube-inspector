package ai

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ollama/ollama/api"
)

// Ollama's own default context window is small, and a prompt that overflows it
// is cut from the *front* without an error — which is where the system prompt
// and, in prompt mode, the whole tool protocol live. So the window is always
// set explicitly and the history is fitted to it before it is sent.
const (
	defaultNumCtx = 8192
	// maxNumCtx caps the window even for models that advertise 128K: the KV
	// cache grows with it, and on a CPU-only machine a 3.8B model at 16K took
	// minutes per turn where 8K took seconds. 8K still fits the system
	// prompt, the tool protocol and a truncated list result.
	maxNumCtx = 8192
	// replyReserve is kept free for the model's answer.
	replyReserve = 1024
	// charsPerToken is a deliberately pessimistic estimate; JSON and YAML
	// tokenise worse than prose.
	charsPerToken = 3

	// ModelResultLimit caps a tool result the model sees within the turn that
	// produced it; HistoryResultLimit caps the copy the frontend keeps and sends
	// back on later turns.
	ModelResultLimit   = 6000
	HistoryResultLimit = 2000
)

// modelFacts is what Show tells us about a model that the loop needs.
type modelFacts struct {
	tools  bool
	numCtx int
}

var (
	factsMu    sync.Mutex
	factsCache = map[string]modelFacts{}
)

// facts returns the cached capabilities of host/model, asking Ollama once per
// process. A failed Show is not cached, so a model pulled later is picked up.
func facts(ctx context.Context, host, model string) modelFacts {
	if model == "" {
		return modelFacts{numCtx: defaultNumCtx}
	}
	key := host + "|" + model
	factsMu.Lock()
	f, ok := factsCache[key]
	factsMu.Unlock()
	if ok {
		return f
	}

	f = modelFacts{numCtx: defaultNumCtx}
	client, err := newClient(host)
	if err != nil {
		return f
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := client.Show(ctx, &api.ShowRequest{Model: model})
	if err != nil || resp == nil {
		return f
	}
	for _, c := range resp.Capabilities {
		if string(c) == "tools" {
			f.tools = true
		}
	}
	f.numCtx = numCtxFor(contextLength(resp.ModelInfo))

	factsMu.Lock()
	factsCache[key] = f
	factsMu.Unlock()
	return f
}

// contextLength reads "<arch>.context_length" from a model's info map.
func contextLength(info map[string]any) int {
	for k, v := range info {
		if !strings.HasSuffix(k, ".context_length") {
			continue
		}
		switch n := v.(type) {
		case float64:
			return int(n)
		case int:
			return n
		case int64:
			return int(n)
		}
	}
	return 0
}

func numCtxFor(advertised int) int {
	if advertised <= 0 {
		return defaultNumCtx
	}
	if advertised > maxNumCtx {
		return maxNumCtx
	}
	return advertised
}

// estimateTokens is a rough size of one message as the model will see it.
func estimateTokens(m api.Message) int {
	n := len(m.Content)
	for _, tc := range m.ToolCalls {
		n += len(tc.Function.Name) + len(tc.Function.Arguments.String())
	}
	return n/charsPerToken + 4
}

// FitHistory drops the oldest turns until msgs fits in budget tokens. msgs[0]
// must be the system prompt; it and the newest user turn are always kept. A
// turn is a user message and everything after it up to the next user message,
// so an assistant tool call is never separated from its tool results.
func FitHistory(msgs []api.Message, budget int) []api.Message {
	if len(msgs) <= 2 {
		return msgs
	}
	total := 0
	for _, m := range msgs {
		total += estimateTokens(m)
	}
	if total <= budget {
		return msgs
	}

	// Turn boundaries: indexes of user messages after the system prompt.
	// Prompt-mode tool results are user messages too, but they are prefixed
	// and belong to the turn before them.
	var starts []int
	for i := 1; i < len(msgs); i++ {
		if msgs[i].Role == "user" && !strings.HasPrefix(msgs[i].Content, toolResultPrefix) {
			starts = append(starts, i)
		}
	}
	if len(starts) == 0 {
		return msgs
	}
	last := starts[len(starts)-1]

	cut := 1
	for _, s := range starts {
		if total <= budget || s >= last {
			break
		}
		for _, m := range msgs[cut:s] {
			total -= estimateTokens(m)
		}
		cut = s
	}
	// Still too big with only the newest turn left: drop it from the front
	// too, keeping its user message, so the request at least fits.
	if total > budget && cut < last {
		for _, m := range msgs[cut:last] {
			total -= estimateTokens(m)
		}
		cut = last
	}
	out := make([]api.Message, 0, len(msgs)-cut+1)
	out = append(out, msgs[0])
	return append(out, msgs[cut:]...)
}

// TruncateResult cuts a tool result to at most limit bytes on a line boundary
// and says how much was left out, so the model can ask for less instead of
// reasoning over a list that silently ends half way.
func TruncateResult(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := strings.LastIndexByte(s[:limit], '\n')
	if cut < limit/2 {
		cut = limit
	}
	dropped := strings.Count(s[cut:], "\n") + 1
	return s[:cut] + fmt.Sprintf("\n… (%d more lines truncated; narrow the request, e.g. by namespace)", dropped)
}
