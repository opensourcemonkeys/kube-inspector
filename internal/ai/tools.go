package ai

import (
	"encoding/json"
	"fmt"

	"github.com/ollama/ollama/api"
	"kube-ins/internal/models"
)

// Tool is a callable the model can invoke. Schema is the JSON Schema for the
// tool's parameters (an object schema). Run executes the tool against the
// cluster the chat is pinned to. Mutating tools require user confirmation
// before Run is called.
//
// Preview, when set on a mutating tool, runs the action as a server-side dry
// run first. A rejected dry run goes straight back to the model as the tool's
// error — the user is never asked to approve something the API server would
// refuse — and an accepted one is shown on the confirm card as a diff.
type Tool struct {
	Name        string
	Description string
	Mutating    bool
	Schema      string
	Run         func(clusterName string, args map[string]any) (string, error)
	Preview     func(clusterName string, args map[string]any) (models.AiActionPreview, error)
}

// ReadOnly returns the tools that do not change the cluster. A read-only chat
// is given only these, so the model is never offered a write it may not make.
func ReadOnly(tools []Tool) []Tool {
	out := make([]Tool, 0, len(tools))
	for _, t := range tools {
		if !t.Mutating {
			out = append(out, t)
		}
	}
	return out
}

// toAPITool converts a Tool into the ollama api.Tool wire format by marshalling a
// function-tool envelope and unmarshalling it back (so the ordered-map based
// parameter types are populated correctly from the JSON schema).
func toAPITool(t Tool) (api.Tool, error) {
	schema := t.Schema
	if schema == "" {
		schema = `{"type":"object","properties":{}}`
	}
	envelope := fmt.Sprintf(
		`{"type":"function","function":{"name":%q,"description":%q,"parameters":%s}}`,
		t.Name, t.Description, schema,
	)
	var out api.Tool
	if err := json.Unmarshal([]byte(envelope), &out); err != nil {
		return api.Tool{}, fmt.Errorf("tool %s schema invalid: %w", t.Name, err)
	}
	return out, nil
}

// buildAPITools converts the registry into ollama tools and a name lookup map.
func buildAPITools(tools []Tool) (api.Tools, map[string]Tool, error) {
	apiTools := make(api.Tools, 0, len(tools))
	byName := make(map[string]Tool, len(tools))
	for _, t := range tools {
		at, err := toAPITool(t)
		if err != nil {
			return nil, nil, err
		}
		apiTools = append(apiTools, at)
		byName[t.Name] = t
	}
	return apiTools, byName, nil
}
