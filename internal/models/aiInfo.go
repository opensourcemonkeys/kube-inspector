package models

// OllamaModelInfo describes a model in the AI assistant's model manager — either
// already installed locally or available to download from the Ollama registry.
type OllamaModelInfo struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	ContextLength int    `json:"contextLength"`
	VramBytes     int64  `json:"vramBytes"`
	Installed     bool   `json:"installed"`
}

// AiPreviewItem is one object a mutating assistant action would change, as
// the API server answered a dry run of it. Before is the live object and After
// the dry-run result, both cleaned YAML; Before is empty for a create and After
// for a delete. Secret values are redacted on both sides.
type AiPreviewItem struct {
	Verb      string `json:"verb"` // create | update | delete
	Kind      string `json:"kind"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Before    string `json:"before"`
	After     string `json:"after"`
}

// AiActionPreview is what the assistant's confirm card shows: every object the
// action touches, already accepted by a dry run.
type AiActionPreview struct {
	Items []AiPreviewItem `json:"items"`
}
