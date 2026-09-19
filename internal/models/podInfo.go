package models

type PodStatus string

const (
	PodStatusRunning     PodStatus = "Running"
	PodStatusPending     PodStatus = "Pending"
	PodStatusTerminating PodStatus = "Terminating"
)

// PodInfo.Status is not limited to the constants above: like kubectl's STATUS
// column it surfaces the most telling container reason (CrashLoopBackOff,
// ImagePullBackOff, Init:0/2, Completed, OOMKilled, Evicted, ...).

// ContainerStatusInfo is one container's live status, used by the pod list's
// per-container status dots. Covers both init and regular containers.
type ContainerStatusInfo struct {
	Name          string `json:"name"`
	Ready         bool   `json:"ready"`
	State         string `json:"state"`  // "Running" | "Waiting" | "Terminated"
	Reason        string `json:"reason"` // e.g. CrashLoopBackOff, ImagePullBackOff, Completed
	RestartCount  int32  `json:"restart_count"`
	Init          bool   `json:"init"`            // true for init containers
	LastRestartAt string `json:"last_restart_at"` // RFC3339; "" if never restarted
}

// PodWarning is one reason the pod is not running healthily, shown in the pod
// list's warning column. Code is a stable identifier the frontend translates;
// Reason and Message come verbatim from the cluster and may be empty.
type PodWarning struct {
	Code      string `json:"code"`      // see services.podWarnings for the set
	Container string `json:"container"` // "" for pod-level warnings
	Reason    string `json:"reason"`    // e.g. CrashLoopBackOff, OOMKilled, Unschedulable
	Message   string `json:"message"`   // cluster-supplied detail
}

type PodInfo struct {
	Name       string    `json:"name"`
	Namespace  string    `json:"namespace"`
	Status     PodStatus `json:"status"`
	Containers []string  `json:"containers"`
	CreatedAt  string    `json:"created_at"`

	// Per-container live status (init containers first, then regular). Empty when
	// the pod has not been scheduled/started yet.
	ContainerStatuses []ContainerStatusInfo `json:"container_statuses"`
	Restarts          int32                 `json:"restarts"`        // sum across all containers (init + regular)
	LastRestartAt     string                `json:"last_restart_at"` // latest restart across all containers; "" if none

	// kubectl's READY column: ready / total over regular (non-init) containers.
	ReadyCount int32 `json:"ready_count"`
	TotalCount int32 `json:"total_count"`

	// Conditions that keep the pod from running healthily; empty when it is fine.
	Warnings []PodWarning `json:"warnings"`

	PodIP     string `json:"pod_ip"`
	NodeName  string `json:"node_name"`  // "" while unscheduled
	OwnerKind string `json:"owner_kind"` // "Deployment"/"StatefulSet"/"DaemonSet"/"Job"/... ("" = bare pod)

	// Live usage from metrics-server; -1 means metrics unavailable (distinct from a real 0).
	CpuMillis int64 `json:"cpu_millis"`
	MemMi     int64 `json:"mem_mi"`
}
