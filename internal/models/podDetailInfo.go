package models

// ObjectRef points at another object the pod depends on or belongs to. Kind is
// the Kubernetes Kind ("ConfigMap", "Deployment", ...); the frontend maps it to
// the panel that opens it. Namespace is "" for cluster-scoped kinds (Node).
type ObjectRef struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

// PodCondition is one entry of pod.status.conditions.
type PodCondition struct {
	Type    string `json:"type"`
	Status  string `json:"status"` // "True" | "False" | "Unknown"
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

// PodToleration is one entry of pod.spec.tolerations, as display strings.
type PodToleration struct {
	Key      string `json:"key"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
	Effect   string `json:"effect"`
	Seconds  string `json:"seconds"` // tolerationSeconds; "" when unset
}

// PodProbe is one configured probe; Kind is "startup", "liveness" or "readiness".
type PodProbe struct {
	Kind    string `json:"kind"`
	Handler string `json:"handler"` // "http-get http://:8080/healthz", "tcp-socket :5432", "exec [pg_isready]"
	Timing  string `json:"timing"`  // "delay=10s timeout=1s period=10s #success=1 #failure=3"
}

// PodEnvVar is one entry of a container's env. Source says where the value
// comes from: "" (a literal Value), "configMap"/"secret" (Ref + Key),
// "field" (Key is the fieldPath) or "resource" (Key is the resource).
type PodEnvVar struct {
	Name     string     `json:"name"`
	Value    string     `json:"value"`
	Source   string     `json:"source"`
	Ref      *ObjectRef `json:"ref"`
	Key      string     `json:"key"`
	Optional bool       `json:"optional"`
}

// PodEnvFrom is one envFrom source: every key of a ConfigMap or Secret.
type PodEnvFrom struct {
	Ref      ObjectRef `json:"ref"`
	Prefix   string    `json:"prefix"`
	Optional bool      `json:"optional"`
}

// PodContainerMount is one of a container's volumeMounts.
type PodContainerMount struct {
	Volume    string `json:"volume"`
	MountPath string `json:"mount_path"`
	SubPath   string `json:"sub_path"`
	ReadOnly  bool   `json:"read_only"`
}

// PodContainerDetail is one container's spec and live state, as the pod
// detail panel shows it. Init covers both classic and sidecar init containers.
type PodContainerDetail struct {
	Name            string `json:"name"`
	Image           string `json:"image"`
	ImagePullPolicy string `json:"image_pull_policy"`
	Init            bool   `json:"init"`

	// Live state; nil until the kubelet has reported the container.
	Status       *ContainerStatusInfo `json:"status"`
	StateMessage string               `json:"state_message"` // waiting/terminated message, e.g. back-off detail
	StartedAt    string               `json:"started_at"`    // RFC3339 while running
	LastState    string               `json:"last_state"`    // "Terminated: Error (exit 1)"; "" if none
	LastStateAt  string               `json:"last_state_at"` // RFC3339 finish time of the last termination

	Ports   []string            `json:"ports"` // "8080/TCP (http)"
	Env     []PodEnvVar         `json:"env"`
	EnvFrom []PodEnvFrom        `json:"env_from"`
	Mounts  []PodContainerMount `json:"mounts"`
	Probes  []PodProbe          `json:"probes"`
	Command []string            `json:"command"`
	Args    []string            `json:"args"`

	// CPU and memory as numbers so the UI can draw usage against them;
	// 0 means unset.
	CpuRequestMillis int64 `json:"cpu_request_millis"`
	CpuLimitMillis   int64 `json:"cpu_limit_millis"`
	MemRequestMi     int64 `json:"mem_request_mi"`
	MemLimitMi       int64 `json:"mem_limit_mi"`
	// Any other requested resource: "ephemeral-storage 1Gi / 2Gi" (request / limit, "–" if unset).
	OtherResources []string `json:"other_resources"`
}

// PodVolumeInfo is one pod volume. Refs is a list because a projected volume
// gathers several ConfigMaps and Secrets.
type PodVolumeInfo struct {
	Name   string      `json:"name"`
	Type   string      `json:"type"`   // "configMap", "secret", "persistentVolumeClaim", "projected", "emptyDir", ...
	Refs   []ObjectRef `json:"refs"`   // objects the volume is built from
	Detail string      `json:"detail"` // type-specific summary: host path, emptyDir medium, ...
}

// PodDetailInfo is what the pod detail panel shows. It is fetched on demand
// rather than carried by PodInfo, which the list re-polls every two seconds.
type PodDetailInfo struct {
	Name          string            `json:"name"`
	Namespace     string            `json:"namespace"`
	CreatedAt     string            `json:"created_at"` // RFC3339
	Labels        map[string]string `json:"labels"`
	Annotations   map[string]string `json:"annotations"`
	Status        string            `json:"status"` // kubectl's STATUS, as in PodInfo
	PodIPs        []string          `json:"pod_ips"`
	HostIP        string            `json:"host_ip"`
	PriorityClass string            `json:"priority_class"`
	QosClass      string            `json:"qos_class"` // Guaranteed / Burstable / BestEffort
	Conditions    []PodCondition    `json:"conditions"`
	Tolerations   []PodToleration   `json:"tolerations"`
	// spec.affinity as YAML ("" when unset), and how many of node / pod /
	// pod-anti affinity it sets.
	Affinity      string `json:"affinity"`
	AffinityCount int    `json:"affinity_count"`

	// Controller chain, nearest first: ReplicaSet → Deployment, Job → CronJob.
	Owners         []ObjectRef `json:"owners"`
	ServiceAccount *ObjectRef  `json:"service_account"`
	Node           *ObjectRef  `json:"node"`
	// Services whose selector matches the pod's labels.
	Services []ObjectRef `json:"services"`
	// Every object of each kind the pod references anywhere — volumes, env,
	// envFrom, imagePullSecrets — deduplicated and sorted.
	Secrets                []ObjectRef `json:"secrets"`
	ConfigMaps             []ObjectRef `json:"config_maps"`
	PersistentVolumeClaims []ObjectRef `json:"persistent_volume_claims"`

	Containers []PodContainerDetail `json:"containers"`
	Volumes    []PodVolumeInfo      `json:"volumes"`
}
