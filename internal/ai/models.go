package ai

import (
	"context"
	"sort"
	"time"

	"github.com/ollama/ollama/api"
	"kube-ins/internal/models"
)

// curatedModels is a broad base catalog (merged with the registry recommendations
// and local models). Each entry is a base model; the UI expands it to all its tags
// (size variants) via ModelTags. Tool-capable models are noted; tiny variants are
// reachable by expanding (e.g. qwen2.5:0.5b) or via free-text pull.
var curatedModels = []models.OllamaModelInfo{
	{Name: "llama3.1", Description: "Meta Llama 3.1 — tool calling. Sizes: 8b, 70b, 405b."},
	{Name: "llama3.2", Description: "Meta Llama 3.2 — small & fast, tool calling. Sizes: 1b, 3b."},
	{Name: "llama3.3", Description: "Meta Llama 3.3 70b — tool calling."},
	{Name: "qwen2.5", Description: "Qwen2.5 — strong reasoning + tools. Sizes: 0.5b–72b."},
	{Name: "qwen2.5-coder", Description: "Qwen2.5 Coder — code-focused, tools. Sizes: 0.5b–32b."},
	{Name: "qwen3", Description: "Qwen3 — latest Qwen, tool calling. Many sizes incl. 0.6b."},
	{Name: "mistral", Description: "Mistral 7B — general purpose, tools."},
	{Name: "mistral-nemo", Description: "Mistral Nemo 12B — tool-capable, good quality."},
	{Name: "gemma2", Description: "Google Gemma 2. Sizes: 2b, 9b, 27b."},
	{Name: "gemma3", Description: "Google Gemma 3. Sizes: 1b, 4b, 12b, 27b."},
	{Name: "phi3", Description: "Microsoft Phi-3 — small, capable. Sizes: 3.8b (mini), 14b."},
	{Name: "phi4", Description: "Microsoft Phi-4 14B — strong small model."},
	{Name: "smollm2", Description: "SmolLM2 — very small. Sizes: 135m, 360m, 1.7b."},
	{Name: "tinyllama", Description: "TinyLlama 1.1B — tiny and fast."},
	{Name: "deepseek-r1", Description: "DeepSeek-R1 — reasoning. Sizes: 1.5b–70b."},
	{Name: "llava", Description: "LLaVA — vision + language. Sizes: 7b, 13b, 34b."},
	{Name: "nomic-embed-text", Description: "Embeddings model (not for chat)."},
}

// IsAvailable reports whether an Ollama server is reachable at host. It takes a
// context so a caller that already has a deadline — the diagnostics panel runs
// its health checks under one — is not made to wait out the 2s probe after it
// has given up.
func IsAvailable(ctx context.Context, host string) bool {
	client, err := newClient(host)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return client.Heartbeat(ctx) == nil
}

// SupportsTools reports whether a local model advertises the "tools" capability.
// Models without it cannot do function calling, so the assistant's actions won't work.
// The answer is cached per process (see facts), so the frontend's check and
// the loop's own check cost one Show between them.
func SupportsTools(host, model string) bool {
	return facts(context.Background(), host, model).tools
}

// ModelCatalog returns the downloadable model catalog (registry recommendations,
// falling back to a curated list) merged with locally-installed models. Installed
// models are marked so the UI can show "installed" vs "download".
func ModelCatalog(host string) ([]models.OllamaModelInfo, error) {
	client, err := newClient(host)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Local models (source of truth for "installed").
	installed := map[string]bool{}
	var localOnly []models.OllamaModelInfo
	if list, err := client.List(ctx); err == nil {
		for _, m := range list.Models {
			installed[baseName(m.Name)] = true
			localOnly = append(localOnly, models.OllamaModelInfo{Name: m.Name, Installed: true})
		}
	}

	// Catalog = registry recommendations merged with the curated base list
	// (recommendations win on description when both have an entry).
	catalog := make([]models.OllamaModelInfo, 0, len(curatedModels)+8)
	if rec, err := client.ModelRecommendationsExperimental(ctx); err == nil && rec != nil {
		for _, r := range rec.Recommendations {
			catalog = append(catalog, models.OllamaModelInfo{
				Name:          r.Model,
				Description:   r.Description,
				ContextLength: r.ContextLength,
				VramBytes:     r.VRAMBytes,
			})
		}
	}
	catalog = append(catalog, curatedModels...)

	seen := map[string]bool{}
	out := make([]models.OllamaModelInfo, 0, len(catalog)+len(localOnly))
	for _, c := range catalog {
		bn := baseName(c.Name)
		if seen[bn] {
			continue
		}
		c.Installed = installed[bn]
		seen[bn] = true
		out = append(out, c)
	}
	// Add locally-installed models that aren't in the catalog.
	for _, l := range localOnly {
		if !seen[baseName(l.Name)] {
			out = append(out, l)
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Installed != out[j].Installed {
			return out[i].Installed // installed first
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// PullModel downloads a model, reporting streamed progress via onProgress.
func PullModel(ctx context.Context, host, model string, onProgress func(status string, total, completed int64)) error {
	client, err := newClient(host)
	if err != nil {
		return err
	}
	stream := true
	return client.Pull(ctx, &api.PullRequest{Model: model, Stream: &stream}, func(p api.ProgressResponse) error {
		onProgress(p.Status, p.Total, p.Completed)
		return nil
	})
}

// baseName strips a tag (e.g. "llama3.1:latest" -> "llama3.1") for matching.
func baseName(name string) string {
	for i := 0; i < len(name); i++ {
		if name[i] == ':' {
			return name[:i]
		}
	}
	return name
}
