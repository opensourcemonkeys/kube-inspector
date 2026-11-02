package business

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ollama/ollama/api"
	"k8s.io/client-go/rest"
	"kube-ins/internal/ai"
	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	"kube-ins/internal/safego"
	services "kube-ins/internal/services"
)

// ListAiModels returns the models available on the given Ollama host.
func ListAiModels(host string) ([]string, error) {
	return ai.ListModels(host)
}

// AiAvailable reports whether an Ollama server is reachable at host.
func AiAvailable(host string) bool {
	return ai.IsAvailable(context.Background(), host)
}

// ListAiModelCatalog returns downloadable + installed models for the model manager.
func ListAiModelCatalog(host string) ([]models.OllamaModelInfo, error) {
	return ai.ModelCatalog(host)
}

// AiModelSupportsTools reports whether the model can do function calling.
func AiModelSupportsTools(host, model string) bool {
	return ai.SupportsTools(host, model)
}

// ListAiModelTags returns the registry tags (size variants) of a base model.
func ListAiModelTags(name string) ([]string, error) {
	return ai.ModelTags(name)
}

// PullAiModel downloads a model, reporting progress via onProgress.
func PullAiModel(ctx context.Context, host, model string, onProgress func(status string, total, completed int64)) error {
	return ai.PullModel(ctx, host, model, onProgress)
}

// chatMsg is the shape the frontend sends for each turn of the history. An
// assistant turn carries the tool calls it made, with each result already cut to
// ai.HistoryResultLimit, so later turns can be told what was learned.
type chatMsg struct {
	Role    string        `json:"role"`
	Content string        `json:"content"`
	Tools   []chatToolMsg `json:"tools,omitempty"`
}

type chatToolMsg struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Args   map[string]any `json:"args,omitempty"`
	Status string         `json:"status"`
	Result string         `json:"result,omitempty"`
}

const aiSystemPrompt = `You are the built-in assistant for Kube Inspector, a Kubernetes desktop client.
You help the user inspect and manage ONE cluster — named below — using the provided tools.
Every tool runs against that cluster only; never assume anything about other clusters.
Guidelines:
- Only call a tool when you actually need cluster data or must perform an action.
  For greetings, small talk, or general questions, just reply normally — do NOT call a tool.
- When you do call a tool, use the function-calling mechanism. NEVER write a tool call as
  JSON text in your reply (e.g. do not output {"name": ...}); the user must never see that.
- Only call tools from the provided list; never invent tool names.
- Use the read tools (list_*, get_*, describe_object) to gather facts before answering.
  Narrow list calls with a namespace when you know it; results may be truncated.
- When you mention a specific object, write it in backticks as kind/namespace/name
  (e.g. ` + "`deployment/shop/api`" + `), or kind/name for a cluster-scoped object
  (e.g. ` + "`node/worker-1`" + `). The user can click these to open the object.
- After tools return, answer the user in plain language. Be concise. Prefer real data
  from tools over guessing.`

const aiWritePrompt = `- Mutating tools (delete_object, apply_yaml, scale_workload, restart_workload) are dry-run
  against the API server and then shown to the user for approval; call them when
  appropriate and explain what you intend to do. A rejected dry run comes back as the
  tool's error — fix the request rather than retrying it unchanged.`

// The read-only line says first what the model CAN do: worded as "you cannot
// change anything", small models (phi4-mini) took it to mean they could not
// call tools at all and refused to list pods.
const aiReadOnlyPrompt = `- Every tool you have only READS the cluster: use them freely to answer. There is no
  tool that changes this cluster, because the user keeps it read-only for you. If the
  user asks for a change, show them how to do it themselves (the kubectl command or the
  YAML) and mention they can allow changes from the assistant's toolbar.`

// RunAiChat builds the tool registry + system context and runs the agent loop.
// readOnly withholds every mutating tool from the model, so a read-only chat
// cannot even propose a change the user would have to refuse.
func RunAiChat(
	ctx context.Context,
	host, model, clusterName, messagesJSON, contextJSON string,
	readOnly bool,
	emitToken func(string),
	emitRetract func(n int),
	emitTool func(ai.ToolEvent),
	awaitConfirm ai.ConfirmFunc,
) error {
	var incoming []chatMsg
	if err := json.Unmarshal([]byte(messagesJSON), &incoming); err != nil {
		return fmt.Errorf("invalid messages: %w", err)
	}

	tools := aiTools(clusterName)
	if readOnly {
		tools = ai.ReadOnly(tools)
	}

	// Use native tool calling only when the model advertises the capability;
	// otherwise describe the tools in the prompt and parse JSON replies — this
	// avoids broken/garbled tool templates on non-tool-capable models.
	native := ai.SupportsTools(host, model)

	system := aiSystemPrompt + "\n"
	if readOnly {
		system += aiReadOnlyPrompt
	} else {
		system += aiWritePrompt
	}
	system += "\n\nCluster: " + clusterName + "\nCurrent UI context (this cluster's open tabs, and objects the user pointed at):\n" + contextJSON
	if !native {
		system += "\n\n" + ai.ToolSpec(tools)
	}

	msgs := []api.Message{{Role: "system", Content: system}}
	for _, m := range incoming {
		msgs = append(msgs, historyMessages(native, m)...)
	}

	return ai.RunChat(ctx, host, model, clusterName, msgs, tools, native, emitToken, emitRetract, emitTool, awaitConfirm)
}

// historyMessages turns one frontend turn into chat messages: a user turn as
// it is, an assistant turn as its tool calls and their results followed by its
// prose. A turn that produced nothing (a stopped or failed one) is dropped —
// an empty assistant message teaches some models to answer with nothing.
func historyMessages(native bool, m chatMsg) []api.Message {
	if m.Role != "assistant" {
		return []api.Message{{Role: m.Role, Content: m.Content}}
	}
	calls := make([]ai.ReplayedCall, 0, len(m.Tools))
	for _, t := range m.Tools {
		calls = append(calls, ai.ReplayedCall{ID: t.ID, Name: t.Name, Args: t.Args, Status: t.Status, Result: t.Result})
	}
	out := ai.ReplayToolCalls(native, calls)
	if m.Content != "" {
		out = append(out, api.Message{Role: "assistant", Content: m.Content})
	}
	return out
}

func argStr(args map[string]any, key string) string {
	if v, ok := args[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func argInt(args map[string]any, key string, def int64) int64 {
	if v, ok := args[key]; ok {
		switch n := v.(type) {
		case float64:
			return int64(n)
		case string:
			// Prompt-mode models often quote numbers.
			var i int64
			if _, err := fmt.Sscan(n, &i); err == nil {
				return i
			}
		}
	}
	return def
}

// argKind normalises a workload kind the way the scale/restart services spell
// it: "Deployment", "deployments" and "deploy" all become "deployment".
func argKind(args map[string]any) string {
	k := strings.ToLower(strings.TrimSpace(argStr(args, "kind")))
	switch k {
	case "deploy", "deployments":
		return "deployment"
	case "sts", "statefulsets":
		return "statefulset"
	case "ds", "daemonsets":
		return "daemonset"
	case "rs", "replicasets":
		return "replicaset"
	}
	return k
}

// asJSON is compact on purpose: every byte of a tool result is context window.
func asJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("error encoding result: %v", err)
	}
	return string(b)
}

// Compact projections of the list endpoints. The full structs carry what the
// UI needs (per-container statuses, raw timestamps, metrics placeholders);
// the model needs the columns kubectl would print.
type aiPod struct {
	Name      string   `json:"name"`
	Namespace string   `json:"ns"`
	Status    string   `json:"status"`
	Ready     string   `json:"ready"`
	Restarts  int32    `json:"restarts,omitempty"`
	Node      string   `json:"node,omitempty"`
	Owner     string   `json:"owner,omitempty"`
	Problems  []string `json:"problems,omitempty"`
	Created   string   `json:"created,omitempty"`
}

type aiDeployment struct {
	Name      string `json:"name"`
	Namespace string `json:"ns"`
	Ready     string `json:"ready"`
	Available int32  `json:"available"`
	Status    string `json:"status,omitempty"`
}

type aiEvent struct {
	Type    string `json:"type"`
	Reason  string `json:"reason"`
	Object  string `json:"object"`
	NS      string `json:"ns,omitempty"`
	Message string `json:"message"`
	Count   int32  `json:"count,omitempty"`
	Last    string `json:"last,omitempty"`
}

func compactPods(pods []models.PodInfo, ns string) []aiPod {
	out := make([]aiPod, 0, len(pods))
	for _, p := range pods {
		if ns != "" && p.Namespace != ns {
			continue
		}
		var problems []string
		for _, w := range p.Warnings {
			s := w.Reason
			if w.Container != "" {
				s += " (" + w.Container + ")"
			}
			problems = append(problems, s)
		}
		out = append(out, aiPod{
			Name: p.Name, Namespace: p.Namespace, Status: string(p.Status),
			Ready:    fmt.Sprintf("%d/%d", p.ReadyCount, p.TotalCount),
			Restarts: p.Restarts, Node: p.NodeName, Owner: p.OwnerKind,
			Problems: problems, Created: p.CreatedAt,
		})
	}
	return out
}

func compactDeployments(deps []models.DeploymentInfo, ns string) []aiDeployment {
	out := make([]aiDeployment, 0, len(deps))
	for _, d := range deps {
		if ns != "" && d.Namespace != ns {
			continue
		}
		out = append(out, aiDeployment{
			Name: d.Name, Namespace: d.Namespace,
			Ready:     fmt.Sprintf("%d/%d", d.ReadyReplicas, d.Replicas),
			Available: d.AvailableReplicas, Status: d.Status,
		})
	}
	return out
}

// compactEvents puts warnings first: they are what a diagnosis is after, and
// what would otherwise be cut off when the list is truncated.
func compactEvents(events []models.EventInfo, ns, typ string) []aiEvent {
	out := make([]aiEvent, 0, len(events))
	for _, e := range events {
		if ns != "" && e.Namespace != ns {
			continue
		}
		if typ != "" && !strings.EqualFold(e.Type, typ) {
			continue
		}
		out = append(out, aiEvent{
			Type: e.Type, Reason: e.Reason, Object: strings.ToLower(e.ObjectKind) + "/" + e.Object,
			NS: e.Namespace, Message: e.Message, Count: e.Count, Last: e.LastTimestamp,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Type == "Warning" && out[j].Type != "Warning" })
	return out
}

// resourceTableText renders a kubectl-style table as tab-separated lines,
// which costs far fewer tokens than the same rows as JSON objects.
func resourceTableText(t models.ResourceTable) string {
	var b strings.Builder
	b.WriteString("NAMESPACE")
	for _, c := range t.Columns {
		if c.Priority > 0 {
			continue
		}
		b.WriteString("\t" + strings.ToUpper(c.Name))
	}
	b.WriteByte('\n')
	for _, r := range t.Rows {
		b.WriteString(r.Namespace)
		for i, c := range t.Columns {
			if c.Priority > 0 || i >= len(r.Cells) {
				continue
			}
			b.WriteString("\t" + r.Cells[i])
		}
		b.WriteByte('\n')
	}
	if len(t.Rows) == 0 {
		return "no objects found"
	}
	return b.String()
}

type aiUsage struct {
	Name      string `json:"name"`
	Namespace string `json:"ns,omitempty"`
	CPU       string `json:"cpu"`
	Memory    string `json:"memory"`
	Node      string `json:"node,omitempty"`
}

func usageOf(u models.ResourceUsage) aiUsage {
	cpu := fmt.Sprintf("%dm", u.CpuMillis)
	mem := fmt.Sprintf("%dMi", u.MemMi)
	if u.CpuCapMillis > 0 {
		cpu += fmt.Sprintf(" of %dm", u.CpuCapMillis)
	}
	if u.MemCapMi > 0 {
		mem += fmt.Sprintf(" of %dMi", u.MemCapMi)
	}
	return aiUsage{Name: u.Name, Namespace: u.Namespace, CPU: cpu, Memory: mem, Node: u.Node}
}

// metricsSummary is the cluster, every node, and the heaviest pods by CPU and
// by memory — the questions "what is using my cluster" actually asks.
func metricsSummary(s models.MetricsSnapshot, ns string, top int) string {
	if !s.MetricsAvailable {
		return "metrics-server is not available in this cluster, so live CPU/memory usage cannot be read."
	}
	pods := make([]models.ResourceUsage, 0, len(s.Pods))
	for _, p := range s.Pods {
		if ns == "" || p.Namespace == ns {
			pods = append(pods, p)
		}
	}
	pick := func(less func(a, b models.ResourceUsage) bool) []aiUsage {
		sorted := append([]models.ResourceUsage(nil), pods...)
		sort.Slice(sorted, func(i, j int) bool { return less(sorted[i], sorted[j]) })
		if len(sorted) > top {
			sorted = sorted[:top]
		}
		out := make([]aiUsage, 0, len(sorted))
		for _, p := range sorted {
			out = append(out, usageOf(p))
		}
		return out
	}
	nodes := make([]aiUsage, 0, len(s.Nodes))
	for _, n := range s.Nodes {
		nodes = append(nodes, usageOf(n))
	}
	return asJSON(map[string]any{
		"cluster":         usageOf(s.Cluster),
		"nodes":           nodes,
		"topPodsByCpu":    pick(func(a, b models.ResourceUsage) bool { return a.CpuMillis > b.CpuMillis }),
		"topPodsByMemory": pick(func(a, b models.ResourceUsage) bool { return a.MemMi > b.MemMi }),
	})
}

type aiChange struct {
	Time    string   `json:"time"`
	Verb    string   `json:"verb"`
	Object  string   `json:"object"`
	NS      string   `json:"ns,omitempty"`
	User    string   `json:"user,omitempty"`
	Via     string   `json:"via,omitempty"`
	Changed []string `json:"changedPaths,omitempty"`
}

// The change-history tool depends on toolbox answering. Its status check can
// take toolboxTimeout on a cluster that is down, which no chat turn should
// wait for, so the answer is cached per cluster and a check that has not come
// back within toolboxWait simply leaves the tool out of this turn.
const (
	toolboxWait     = 2 * time.Second
	toolboxCacheTTL = 60 * time.Second
)

type toolboxReadiness struct {
	ok bool
	at time.Time
}

var (
	toolboxReadyMu sync.Mutex
	toolboxReady   = map[string]toolboxReadiness{}
)

func toolboxReadyForAi(clusterName string) bool {
	toolboxReadyMu.Lock()
	r, ok := toolboxReady[clusterName]
	toolboxReadyMu.Unlock()
	if ok && time.Since(r.at) < toolboxCacheTTL {
		return r.ok
	}
	done := make(chan bool, 1)
	safego.Go("business.aiToolboxStatus", func() {
		ready := GetToolboxStatus(clusterName).State == services.ToolboxOK
		toolboxReadyMu.Lock()
		toolboxReady[clusterName] = toolboxReadiness{ok: ready, at: time.Now()}
		toolboxReadyMu.Unlock()
		done <- ready
	})
	select {
	case ready := <-done:
		return ready
	case <-time.After(toolboxWait):
		return false
	}
}

func clusterConfig(clusterName string) (*rest.Config, error) {
	_, config, err := repository.NewK8sClientAndConfigForCluster(clusterName)
	return config, err
}

// aiTools is the registry exposed to the model. Read tools run immediately;
// mutating tools are dry-run through Preview, then gated behind user
// confirmation by the agent loop. The change-history tool is offered only
// while toolbox answers for this cluster, so the model is never handed a tool
// that can only fail.
func aiTools(clusterName string) []ai.Tool {
	tools := []ai.Tool{
		{
			Name:        "list_pods",
			Description: "List pods (status, ready, restarts, node, problems such as CrashLoopBackOff), optionally in one namespace.",
			Schema:      `{"type":"object","properties":{"namespace":{"type":"string","description":"Filter to this namespace; omit for all namespaces"}}}`,
			Run: func(clusterName string, args map[string]any) (string, error) {
				pods, err := GetPods(clusterName)
				if err != nil {
					return "", err
				}
				return asJSON(compactPods(pods, argStr(args, "namespace"))), nil
			},
		},
		{
			Name:        "list_deployments",
			Description: "List deployments with their ready/available replicas, optionally in one namespace.",
			Schema:      `{"type":"object","properties":{"namespace":{"type":"string"}}}`,
			Run: func(clusterName string, args map[string]any) (string, error) {
				deps, err := GetDeployments(clusterName)
				if err != nil {
					return "", err
				}
				return asJSON(compactDeployments(deps, argStr(args, "namespace"))), nil
			},
		},
		{
			Name:        "list_events",
			Description: "List recent Kubernetes events, warnings first (useful for diagnosing problems).",
			Schema:      `{"type":"object","properties":{"namespace":{"type":"string"},"type":{"type":"string","description":"Warning or Normal; omit for both"}}}`,
			Run: func(clusterName string, args map[string]any) (string, error) {
				events, err := GetEvents(clusterName)
				if err != nil {
					return "", err
				}
				return asJSON(compactEvents(events, argStr(args, "namespace"), argStr(args, "type"))), nil
			},
		},
		{
			Name:        "list_resources",
			Description: "List objects of any resource type the way `kubectl get` prints them (services, ingresses, nodes, configmaps, statefulsets, CRDs, ...).",
			Schema:      `{"type":"object","properties":{"resource":{"type":"string","description":"Plural resource name, e.g. services, nodes, ingresses"},"group":{"type":"string","description":"API group; omit to let it be resolved"},"namespace":{"type":"string","description":"Omit for all namespaces"}},"required":["resource"]}`,
			Run: func(clusterName string, args map[string]any) (string, error) {
				t, err := GetResourceTable(clusterName, argStr(args, "group"), argStr(args, "resource"), argStr(args, "namespace"))
				if err != nil {
					return "", err
				}
				return resourceTableText(t), nil
			},
		},
		{
			Name:        "get_object_yaml",
			Description: "Get the YAML manifest of one object of any resource type. Secret values are hashed.",
			Schema:      `{"type":"object","properties":{"resource":{"type":"string","description":"Plural resource name, e.g. pods, deployments, services"},"group":{"type":"string"},"namespace":{"type":"string","description":"Omit for cluster-scoped objects"},"name":{"type":"string"}},"required":["resource","name"]}`,
			Run: func(clusterName string, args map[string]any) (string, error) {
				config, err := clusterConfig(clusterName)
				if err != nil {
					return "", err
				}
				return services.RedactedObjectYaml(config, argStr(args, "group"), argStr(args, "resource"), argStr(args, "namespace"), argStr(args, "name"))
			},
		},
		{
			Name:        "describe_object",
			Description: "Get `kubectl describe` output for one object, including its recent events. Best first step when diagnosing a specific object.",
			Schema:      `{"type":"object","properties":{"resource":{"type":"string","description":"Plural resource name, e.g. pods"},"namespace":{"type":"string"},"name":{"type":"string"}},"required":["resource","name"]}`,
			Run: func(clusterName string, args map[string]any) (string, error) {
				return GetObjectDescribe(clusterName, argStr(args, "resource"), argStr(args, "namespace"), argStr(args, "name"))
			},
		},
		{
			Name:        "get_pod_logs",
			Description: "Get the most recent log lines of a pod container.",
			Schema:      `{"type":"object","properties":{"namespace":{"type":"string"},"pod":{"type":"string"},"container":{"type":"string","description":"Container name; omit for the first container"},"tail":{"type":"integer","description":"Number of lines from the end (default 100)"}},"required":["namespace","pod"]}`,
			Run: func(clusterName string, args map[string]any) (string, error) {
				return GetPodLogsTail(clusterName, argStr(args, "namespace"), argStr(args, "pod"), argStr(args, "container"), argInt(args, "tail", 100))
			},
		},
		{
			Name:        "get_metrics",
			Description: "Get live CPU/memory usage: cluster totals, every node, and the heaviest pods (needs metrics-server).",
			Schema:      `{"type":"object","properties":{"namespace":{"type":"string","description":"Only rank pods in this namespace"}}}`,
			Run: func(clusterName string, args map[string]any) (string, error) {
				s, err := GetMetricsSnapshot(clusterName)
				if err != nil {
					return "", err
				}
				return metricsSummary(s, argStr(args, "namespace"), 10), nil
			},
		},
		{
			Name:        "delete_object",
			Description: "Delete one object of any resource type. Mutating: dry-run, then requires user confirmation.",
			Mutating:    true,
			Schema:      `{"type":"object","properties":{"resource":{"type":"string","description":"Plural resource name, e.g. pods"},"group":{"type":"string"},"namespace":{"type":"string"},"name":{"type":"string"}},"required":["resource","name"]}`,
			Preview: func(clusterName string, args map[string]any) (models.AiActionPreview, error) {
				config, err := clusterConfig(clusterName)
				if err != nil {
					return models.AiActionPreview{}, err
				}
				return services.PreviewDelete(config, argStr(args, "group"), argStr(args, "resource"), argStr(args, "namespace"), argStr(args, "name"))
			},
			Run: func(clusterName string, args map[string]any) (string, error) {
				if err := DeleteObject(clusterName, argStr(args, "group"), argStr(args, "resource"), argStr(args, "namespace"), argStr(args, "name")); err != nil {
					return "", err
				}
				return fmt.Sprintf("Deleted %s %s/%s", argStr(args, "resource"), argStr(args, "namespace"), argStr(args, "name")), nil
			},
		},
		{
			Name:        "scale_workload",
			Description: "Set the replica count of a deployment, statefulset or replicaset. Mutating: dry-run, then requires user confirmation.",
			Mutating:    true,
			Schema:      `{"type":"object","properties":{"kind":{"type":"string","enum":["deployment","statefulset","replicaset"]},"namespace":{"type":"string"},"name":{"type":"string"},"replicas":{"type":"integer"}},"required":["kind","namespace","name","replicas"]}`,
			Preview: func(clusterName string, args map[string]any) (models.AiActionPreview, error) {
				config, err := clusterConfig(clusterName)
				if err != nil {
					return models.AiActionPreview{}, err
				}
				return services.PreviewScale(config, argKind(args), argStr(args, "namespace"), argStr(args, "name"), int32(argInt(args, "replicas", -1)))
			},
			Run: func(clusterName string, args map[string]any) (string, error) {
				replicas := int32(argInt(args, "replicas", -1))
				if err := ScaleWorkload(clusterName, argKind(args), argStr(args, "name"), argStr(args, "namespace"), replicas); err != nil {
					return "", err
				}
				return fmt.Sprintf("Scaled %s %s/%s to %d replicas", argKind(args), argStr(args, "namespace"), argStr(args, "name"), replicas), nil
			},
		},
		{
			Name:        "restart_workload",
			Description: "Rollout-restart a deployment, statefulset or daemonset (pods are replaced gradually). Mutating: dry-run, then requires user confirmation.",
			Mutating:    true,
			Schema:      `{"type":"object","properties":{"kind":{"type":"string","enum":["deployment","statefulset","daemonset"]},"namespace":{"type":"string"},"name":{"type":"string"}},"required":["kind","namespace","name"]}`,
			Preview: func(clusterName string, args map[string]any) (models.AiActionPreview, error) {
				config, err := clusterConfig(clusterName)
				if err != nil {
					return models.AiActionPreview{}, err
				}
				return services.PreviewRestart(config, argKind(args), argStr(args, "namespace"), argStr(args, "name"))
			},
			Run: func(clusterName string, args map[string]any) (string, error) {
				if err := RestartWorkload(clusterName, argKind(args), argStr(args, "name"), argStr(args, "namespace")); err != nil {
					return "", err
				}
				return fmt.Sprintf("Restarted %s %s/%s", argKind(args), argStr(args, "namespace"), argStr(args, "name")), nil
			},
		},
		{
			Name:        "apply_yaml",
			Description: "Apply a Kubernetes YAML manifest (create or update, server-side apply). Mutating: dry-run, then requires user confirmation.",
			Mutating:    true,
			Schema:      `{"type":"object","properties":{"yaml":{"type":"string","description":"The full YAML manifest"}},"required":["yaml"]}`,
			Preview: func(clusterName string, args map[string]any) (models.AiActionPreview, error) {
				config, err := clusterConfig(clusterName)
				if err != nil {
					return models.AiActionPreview{}, err
				}
				return services.PreviewApply(config, argStr(args, "yaml"))
			},
			Run: func(clusterName string, args map[string]any) (string, error) {
				return ApplyYaml(clusterName, argStr(args, "yaml"))
			},
		},
	}

	if toolboxReadyForAi(clusterName) {
		tools = append(tools, ai.Tool{
			Name:        "list_recent_changes",
			Description: "List recorded changes to objects (who changed what, when, which fields), newest first. Use it to answer 'what changed' / 'why did this break'.",
			Schema:      `{"type":"object","properties":{"since":{"type":"string","description":"How far back, e.g. 30m, 6h, 2d (default 1h)"},"namespace":{"type":"string"},"kind":{"type":"string","description":"e.g. Deployment"},"name":{"type":"string"}}}`,
			Run: func(clusterName string, args map[string]any) (string, error) {
				since := argStr(args, "since")
				if since == "" {
					since = "1h"
				}
				page, err := GetToolboxChanges(clusterName, models.ToolboxChangeFilter{
					Since: since, Namespace: argStr(args, "namespace"), Kind: argStr(args, "kind"),
					Name: argStr(args, "name"), Limit: 50,
				})
				if err != nil {
					return "", err
				}
				out := make([]aiChange, 0, len(page.Items))
				for _, c := range page.Items {
					out = append(out, aiChange{
						Time: c.Time, Verb: c.Verb, Object: strings.ToLower(c.Kind) + "/" + c.Name, NS: c.Namespace,
						User: c.Actor.Username, Via: c.FieldManager, Changed: c.ChangedPaths,
					})
				}
				if len(out) == 0 {
					return "no recorded changes in that window", nil
				}
				return asJSON(out), nil
			},
		})
	}
	return tools
}
