package models

type ResourceNode struct {
	ID        string            `json:"id"`
	Kind      string            `json:"kind"`
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Labels    map[string]string `json:"labels"`
	Selector  map[string]string `json:"selector,omitempty"`
	Status    string            `json:"status,omitempty"`
	// Issues: what is wrong with this object, worst first. Codes, not text —
	// the frontend translates panels:resourceGraph.issue.<code>.
	Issues []GraphIssue `json:"issues"`
	// Missing: a placeholder for an object something references but that
	// does not exist. Only drawn for kinds that could be listed.
	Missing bool `json:"missing,omitempty"`
	// Details: kind-specific facts the frontend reasons about, e.g. a
	// PersistentVolume's reclaimPolicy (whether deleting it loses data).
	Details map[string]string `json:"details,omitempty"`
}

type GraphIssue struct {
	Level  string            `json:"level"` // "warn" | "err"
	Code   string            `json:"code"`
	Params map[string]string `json:"params,omitempty"`
}

type ResourceEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
	Kind   string `json:"kind"` // "owner", "selector", "ingress", "config", "storage"
	// Label: what the edge carries (host/path, port mapping, mount path).
	// The frontend shows it only along the selected chain.
	Label string `json:"label,omitempty"`
	// Issue: set when the edge is broken — its target is missing, or the
	// port it routes to does not exist.
	Issue *GraphIssue `json:"issue,omitempty"`
	// Optional: the source tolerates the target being absent (an optional
	// ConfigMap/Secret, a pull secret) — losing it breaks nothing.
	Optional bool `json:"optional,omitempty"`
}

// GraphWarning names a kind the graph was drawn without. Config and storage
// kinds are best-effort: a user who may not list Secrets still gets a graph.
type GraphWarning struct {
	Kind   string `json:"kind"`   // e.g. "Secret"
	Reason string `json:"reason"` // "forbidden" or "error"
	Detail string `json:"detail,omitempty"`
}

// GraphHost is a Kubernetes Node the graph's pods run on. It is not a graph
// node: the frontend draws it as a frame around its pods.
type GraphHost struct {
	Name  string `json:"name"`
	Ready bool   `json:"ready"`
	// Issues: NotReady, a pressure condition, cordoned. Same codes-not-text
	// rule as ResourceNode.Issues.
	Issues []GraphIssue `json:"issues"`
}

type ClusterGraph struct {
	Nodes    []ResourceNode `json:"nodes"`
	Edges    []ResourceEdge `json:"edges"`
	Warnings []GraphWarning `json:"warnings"`
	// Hosts: the cluster's Nodes, for grouping pods by where they run.
	Hosts []GraphHost `json:"hosts"`
}

// GraphPodUsage is one pod's live usage, from metrics-server.
type GraphPodUsage struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	CpuMillis int64  `json:"cpuMillis"`
	MemMi     int64  `json:"memMi"`
}

// GraphUsage is the resource graph's usage overlay. It is fetched apart from
// the graph, so a cluster without metrics-server still gets its graph.
type GraphUsage struct {
	// Available is false when metrics-server cannot be read; Reason then
	// says why: "unavailable" (not installed, not ready) or "forbidden".
	Available bool            `json:"available"`
	Reason    string          `json:"reason,omitempty"`
	Pods      []GraphPodUsage `json:"pods"`
	// Hosts: each Node's usage; Namespace is empty.
	Hosts []GraphPodUsage `json:"hosts"`
}
