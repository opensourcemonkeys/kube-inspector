package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"

	"github.com/ollama/ollama/api"
	"kube-ins/internal/models"
)

// maxIterations caps the number of model<->tool round-trips per user message so a
// misbehaving model cannot loop forever.
const maxIterations = 8

// ErrToolLimit ends a turn that hit maxIterations. It is not a failure — the
// text so far stands — so the controller reports it as a done reason, which
// the frontend words in the user's language.
var ErrToolLimit = errors.New("reached the tool-call limit")

// ConfirmFunc asks the user to approve a mutating call. preview is nil for a
// tool without a dry run.
type ConfirmFunc func(id, name string, args map[string]any, preview *models.AiActionPreview) bool

const toolResultPrefix = "TOOL RESULT ("

// ToolEvent is emitted to the frontend so it can render a tool-activity line.
type ToolEvent struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Args     map[string]any `json:"args,omitempty"`
	Status   string         `json:"status"` // running | done | declined | error
	Result   string         `json:"result,omitempty"`
	Mutating bool           `json:"mutating"`
}

type normalizedCall struct {
	id   string
	name string
	args map[string]any
}

// RunChat runs the chat + tool loop until the model produces a final answer with
// no further tool calls (or the iteration cap is hit). Read tools run immediately;
// mutating tools are dry-run through their Preview and then gated through
// awaitConfirm.
//
// Many local models emit tool calls as plain text — JSON ({"name":...,"arguments":...})
// or a tool name followed by its arguments (`list_pods {"namespace":"x"}`) —
// instead of the native tool_calls field, so the reply is streamed with a guard:
// prose goes out token by token, but from the first '{' or code fence on the
// rest of that iteration is held back until the reply is complete and it is
// known whether it was a tool call. When it was, whatever of that iteration had
// already streamed (a tool name before its '{') is taken back with
// emitRetract, so a raw tool call never stays on the user's screen.
//
// nativeTools selects how tools are offered to the model: when true the ollama
// native tool-calling field is used; when false (model lacks the "tools"
// capability, or its template garbles tools) the tools are described in the
// system prompt instead and replies are parsed as JSON — avoiding broken templates.
func RunChat(
	ctx context.Context,
	host, model, clusterName string,
	msgs []api.Message,
	tools []Tool,
	nativeTools bool,
	emitToken func(string),
	emitRetract func(n int),
	emitTool func(ToolEvent),
	awaitConfirm ConfirmFunc,
) error {
	client, err := newClient(host)
	if err != nil {
		return err
	}
	apiTools, byName, err := buildAPITools(tools)
	if err != nil {
		return err
	}

	numCtx := facts(ctx, host, model).numCtx
	budget := numCtx - replyReserve
	if nativeTools {
		// The tool schemas ride along with every request, outside msgs.
		b, _ := json.Marshal(apiTools)
		budget -= len(b) / charsPerToken
	}

	stream := true
	emitted := false

	for iter := 0; iter < maxIterations; iter++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		var assistant api.Message
		assistant.Role = "assistant"

		req := &api.ChatRequest{
			Model:    model,
			Messages: FitHistory(msgs, budget),
			Stream:   &stream,
			Options:  map[string]any{"num_ctx": numCtx},
		}
		if nativeTools {
			req.Tools = apiTools
		}

		emittedBefore := emitted
		g := streamGuard{emit: func(s string) {
			emitted = true
			emitToken(s)
		}, separate: emitted}
		if err := client.Chat(ctx, req, func(resp api.ChatResponse) error {
			assistant.ToolCalls = append(assistant.ToolCalls, resp.Message.ToolCalls...)
			g.write(resp.Message.Content)
			return nil
		}); err != nil {
			return err
		}
		assistant.Content = g.all.String()

		// Normalize tool calls from the native field, or fall back to parsing
		// tool-call JSON the model wrote into its text content.
		var calls []normalizedCall
		textCalls := false
		if len(assistant.ToolCalls) > 0 {
			for _, tc := range assistant.ToolCalls {
				argsObj := tc.Function.Arguments
				args := map[string]any{}
				_ = json.Unmarshal([]byte(argsObj.String()), &args)
				id := tc.ID
				if id == "" {
					id = fmt.Sprintf("%s-%d-%d", tc.Function.Name, iter, tc.Function.Index)
				}
				calls = append(calls, normalizedCall{id, tc.Function.Name, args})
			}
		} else if parsed := parseTextToolCalls(assistant.Content, byName); len(parsed) > 0 {
			// Rewrite the assistant turn into proper tool calls and drop the raw
			// JSON content so it never reaches the UI / history as prose.
			textCalls = true
			if n := g.streamed(); n > 0 {
				emitRetract(n)
				emitted = emittedBefore
			}
			assistant.Content = ""
			assistant.ToolCalls = nil
			for i, p := range parsed {
				assistant.ToolCalls = append(assistant.ToolCalls, api.ToolCall{
					Function: api.ToolCallFunction{Name: p.name, Arguments: argsToAPI(p.args)},
				})
				calls = append(calls, normalizedCall{fmt.Sprintf("text-%d-%d", iter, i), p.name, p.args})
			}
		}

		// Whatever was held back was prose after all, unless it was the
		// tool call itself.
		if !textCalls {
			g.flush()
		}
		msgs = append(msgs, assistant)

		// No tool calls => final answer.
		if len(calls) == 0 {
			return nil
		}

		for _, c := range calls {
			msgs = append(msgs, runCall(ctx, clusterName, c, byName, nativeTools, emitTool, awaitConfirm))
		}
	}

	return ErrToolLimit
}

// runCall runs one tool call and returns the message that carries its result
// back to the model.
func runCall(
	ctx context.Context,
	clusterName string,
	c normalizedCall,
	byName map[string]Tool,
	nativeTools bool,
	emitTool func(ToolEvent),
	awaitConfirm ConfirmFunc,
) api.Message {
	tool, ok := byName[c.name]
	if !ok {
		emitTool(ToolEvent{ID: c.id, Name: c.name, Args: c.args, Status: "error", Result: "unknown tool"})
		return ToolResultMessage(nativeTools, c.id, c.name, "error: unknown tool '"+c.name+"'. Only call tools from the provided list; otherwise answer the user directly.")
	}

	if tool.Mutating {
		var preview *models.AiActionPreview
		if tool.Preview != nil {
			emitTool(ToolEvent{ID: c.id, Name: c.name, Args: c.args, Status: "running", Mutating: true})
			p, err := tool.Preview(clusterName, c.args)
			if err != nil {
				// The API server would refuse this; the model gets the
				// reason and can correct itself without bothering the user.
				msg := "dry run rejected: " + err.Error()
				emitTool(ToolEvent{ID: c.id, Name: c.name, Args: c.args, Status: "error", Result: TruncateResult(msg, HistoryResultLimit), Mutating: true})
				return ToolResultMessage(nativeTools, c.id, c.name, "error: the API server rejected a dry run of this action, nothing was changed: "+err.Error())
			}
			preview = &p
		} else {
			emitTool(ToolEvent{ID: c.id, Name: c.name, Args: c.args, Status: "running", Mutating: true})
		}
		if ctx.Err() != nil || !awaitConfirm(c.id, c.name, c.args, preview) {
			emitTool(ToolEvent{ID: c.id, Name: c.name, Args: c.args, Status: "declined", Mutating: true})
			return ToolResultMessage(nativeTools, c.id, c.name, DeclinedResult)
		}
	} else {
		emitTool(ToolEvent{ID: c.id, Name: c.name, Args: c.args, Status: "running"})
	}

	result, runErr := tool.Run(clusterName, c.args)
	if runErr != nil {
		emitTool(ToolEvent{ID: c.id, Name: c.name, Args: c.args, Status: "error", Result: TruncateResult(runErr.Error(), HistoryResultLimit), Mutating: tool.Mutating})
		return ToolResultMessage(nativeTools, c.id, c.name, "error: "+runErr.Error())
	}
	emitTool(ToolEvent{ID: c.id, Name: c.name, Args: c.args, Status: "done", Result: TruncateResult(result, HistoryResultLimit), Mutating: tool.Mutating})
	return ToolResultMessage(nativeTools, c.id, c.name, TruncateResult(result, ModelResultLimit))
}

// DeclinedResult is what the model is told when the user says no.
const DeclinedResult = "The user declined to run this action."

// streamGuard forwards streamed prose and holds back anything from the first
// '{' or code fence on, which may turn out to be a tool call written as text.
// Inline `code` is not held: it is common in answers, and holding at every
// backtick would stop most replies streaming at their first identifier.
type streamGuard struct {
	emit     func(string)
	separate bool // an earlier iteration already emitted text
	all      strings.Builder
	sent     strings.Builder // what this iteration has emitted
	held     strings.Builder
	ticks    string // trailing backticks that may be the start of a fence
	holding  bool
	started  bool
}

func (g *streamGuard) write(chunk string) {
	if chunk == "" {
		return
	}
	g.all.WriteString(chunk)
	if g.holding {
		g.held.WriteString(chunk)
		return
	}
	chunk = g.ticks + chunk
	g.ticks = ""
	cut := strings.IndexByte(chunk, '{')
	if f := strings.Index(chunk, "```"); f >= 0 && (cut < 0 || f < cut) {
		cut = f
	}
	if cut >= 0 {
		g.holding = true
		g.held.WriteString(chunk[cut:])
		chunk = chunk[:cut]
	} else if t := len(chunk) - len(strings.TrimRight(chunk, "`")); t > 0 {
		// One or two backticks at the end may be the start of a fence
		// split across chunks; they go out with the next chunk.
		g.ticks = chunk[len(chunk)-t:]
		chunk = chunk[:len(chunk)-t]
	}
	g.out(chunk)
}

// out emits prose, dropping leading whitespace and putting a paragraph break
// between iterations.
func (g *streamGuard) out(s string) {
	if !g.started {
		s = strings.TrimLeft(s, " \t\r\n")
		if s == "" {
			return
		}
		g.started = true
		if g.separate {
			s = "\n\n" + s
		}
	}
	if s != "" {
		g.sent.WriteString(s)
		g.emit(s)
	}
}

// streamed is the length of what this iteration emitted, in UTF-16 code
// units: the frontend takes it back with String.prototype.slice.
func (g *streamGuard) streamed() int {
	return len(utf16.Encode([]rune(g.sent.String())))
}

// flush releases the held text as prose.
func (g *streamGuard) flush() {
	rest := g.ticks + g.held.String()
	g.ticks = ""
	g.held.Reset()
	g.holding = false
	g.out(rest)
}

// ToolResultMessage formats a tool result as a chat message. Native mode uses the
// "tool" role; prompt mode (no native tools) feeds it back as a user message so
// templates that don't understand the tool role still see it.
func ToolResultMessage(native bool, id, name, content string) api.Message {
	if native {
		return api.Message{Role: "tool", ToolName: name, ToolCallID: id, Content: content}
	}
	return api.Message{Role: "user", Content: toolResultPrefix + name + "):\n" + content + "\n\nUsing this, continue: call another tool the same way, or give your final answer in plain text."}
}

// ReplayedCall is a tool call from an earlier turn, as the frontend kept it.
type ReplayedCall struct {
	ID     string
	Name   string
	Args   map[string]any
	Status string // done | error | declined
	Result string
}

// ReplayToolCalls rebuilds the messages an earlier turn's tool calls produced,
// so the model still sees what it learned then instead of calling the same
// tools again — or worse, answering from memory. Calls that never finished
// (status running, from a turn that was stopped) are left out.
func ReplayToolCalls(native bool, calls []ReplayedCall) []api.Message {
	var out []api.Message
	var nativeCalls []api.ToolCall
	var results []api.Message
	for _, c := range calls {
		var content string
		switch c.Status {
		case "done":
			content = c.Result
		case "error":
			content = "error: " + c.Result
		case "declined":
			content = DeclinedResult
		default:
			continue
		}
		if native {
			nativeCalls = append(nativeCalls, api.ToolCall{ID: c.ID, Function: api.ToolCallFunction{Name: c.Name, Arguments: argsToAPI(c.Args)}})
			results = append(results, ToolResultMessage(true, c.ID, c.Name, content))
			continue
		}
		call, _ := json.Marshal(map[string]any{"tool": c.Name, "arguments": c.Args})
		out = append(out,
			api.Message{Role: "assistant", Content: string(call)},
			ToolResultMessage(false, c.ID, c.Name, content),
		)
	}
	if native && len(nativeCalls) > 0 {
		out = append(out, api.Message{Role: "assistant", ToolCalls: nativeCalls})
		out = append(out, results...)
	}
	return out
}

// ToolSpec renders a prompt describing the tools and the JSON call protocol, for
// models that don't support native tool calling.
func ToolSpec(tools []Tool) string {
	var b strings.Builder
	b.WriteString("You can call tools. To call one, reply with ONLY a single JSON object and nothing else (no backticks, no prose):\n")
	b.WriteString(`{"tool": "<tool_name>", "arguments": { ... }}` + "\n")
	b.WriteString("You will then receive a TOOL RESULT message. Call more tools the same way if needed. When done, reply to the user in plain text with NO JSON.\n\n")
	b.WriteString("Available tools:\n")
	for _, t := range tools {
		b.WriteString("- " + t.Name + ": " + t.Description + "\n  parameters: " + t.Schema + "\n")
	}
	return b.String()
}

type textCall struct {
	name string
	args map[string]any
}

// parseTextToolCalls extracts tool calls a model wrote as text instead of using
// native tool calling. Two shapes are recognised: a JSON object carrying a
// "name" (or "tool") plus "arguments"/"parameters" —
// `{"name":"list_pods","arguments":{...}}` — and, failing that, the name of a
// known tool directly followed by a JSON object of its arguments —
// `list_pods {"namespace":"x"}`, which phi and other small models write. The
// second shape only counts for names in known, so prose that happens to
// contain a JSON example is not mistaken for a call.
func parseTextToolCalls(content string, known map[string]Tool) []textCall {
	var out []textCall
	spans := jsonObjectSpans(content)
	for _, sp := range spans {
		obj := content[sp[0]:sp[1]]
		var probe struct {
			Name       string          `json:"name"`
			Tool       string          `json:"tool"`
			Arguments  json.RawMessage `json:"arguments"`
			Parameters json.RawMessage `json:"parameters"`
		}
		if json.Unmarshal([]byte(obj), &probe) != nil {
			continue
		}
		if probe.Name == "" {
			probe.Name = probe.Tool
		}
		if probe.Name == "" {
			continue
		}
		raw := probe.Arguments
		if len(raw) == 0 {
			raw = probe.Parameters
		}
		args := map[string]any{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &args)
		}
		out = append(out, textCall{name: probe.Name, args: args})
	}
	if len(out) > 0 {
		return out
	}

	for _, sp := range spans {
		name := toolNameBefore(content[:sp[0]])
		if _, ok := known[name]; !ok {
			continue
		}
		args := map[string]any{}
		if json.Unmarshal([]byte(content[sp[0]:sp[1]]), &args) != nil {
			continue
		}
		out = append(out, textCall{name: name, args: args})
	}
	return out
}

// toolNameBefore returns the identifier that ends s, ignoring the backticks,
// colons, parentheses and spaces a model puts between a name and its args.
func toolNameBefore(s string) string {
	s = strings.TrimRight(s, " \t\r\n`:(")
	i := len(s)
	for i > 0 {
		c := s[i-1]
		if c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			i--
			continue
		}
		break
	}
	return s[i:]
}

// jsonObjectSpans returns the [start, end) offsets of the top-level balanced
// {...} substrings of s (string-aware, so braces inside quoted strings don't
// unbalance the scan).
func jsonObjectSpans(s string) [][2]int {
	var out [][2]int
	depth, start := 0, -1
	inStr, esc := false, false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{':
			if depth == 0 {
				start = i
			}
			depth++
		case '}':
			if depth > 0 {
				depth--
				if depth == 0 && start >= 0 {
					out = append(out, [2]int{start, i + 1})
					start = -1
				}
			}
		}
	}
	return out
}

// argsToAPI converts a plain args map into the ollama ordered-map arguments type.
func argsToAPI(args map[string]any) api.ToolCallFunctionArguments {
	var a api.ToolCallFunctionArguments
	b, _ := json.Marshal(args)
	_ = json.Unmarshal(b, &a)
	return a
}
