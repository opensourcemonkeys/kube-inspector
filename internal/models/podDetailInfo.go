package models

// ObjectRef points at another object the pod depends on or belongs to. Kind is
// the Kubernetes Kind ("ConfigMap", "Deployment", ...); the frontend maps it to
// the panel that opens it. Namespace is "" for cluster-scoped kinds (Node).
type ObjectRef struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

// PodContainerDetail is one container's spec, as shown in the pod list's
// expanded row. Init covers both classic and sidecar init containers.
type PodContainerDetail struct {
	Name     string   `json:"name"`
	Image    string   `json:"image"`
	Init     bool     `json:"init"`
	Ports    []string `json:"ports"`    // "8080/TCP (http)"
	Requests string   `json:"requests"` // "cpu 100m · memory 128Mi"; "" if none
	Limits   string   `json:"limits"`
	Probes   []string `json:"probes"` // "liveness: http :8080/healthz"
}

// PodVolumeMount is where one container mounts a volume.
type PodVolumeMount struct {
	Container string `json:"container"`
	MountPath string `json:"mount_path"`
	SubPath   string `json:"sub_path"`
	ReadOnly  bool   `json:"read_only"`
}

// PodVolumeInfo is one pod volume and every place it is mounted. Refs is a list
// because a projected volume gathers several ConfigMaps and Secrets.
type PodVolumeInfo struct {
	Name   string           `json:"name"`
	Type   string           `json:"type"`   // "configMap", "secret", "persistentVolumeClaim", "projected", "emptyDir", ...
	Refs   []ObjectRef      `json:"refs"`   // objects the volume is built from
	Detail string           `json:"detail"` // type-specific summary: host path, emptyDir medium, ...
	Mounts []PodVolumeMount `json:"mounts"`
}

// PodEnvRef is a ConfigMap or Secret a container reads its environment from.
// Variable is "" for envFrom, which imports every key (with Prefix).
type PodEnvRef struct {
	Container string    `json:"container"`
	Variable  string    `json:"variable"`
	Key       string    `json:"key"`
	Prefix    string    `json:"prefix"`
	Ref       ObjectRef `json:"ref"`
	Optional  bool      `json:"optional"`
}

// PodDetailInfo is what the pod list's expanded row shows. It is fetched on
// demand rather than carried by PodInfo, which is re-polled every two seconds.
type PodDetailInfo struct {
	Containers []PodContainerDetail `json:"containers"`
	Volumes    []PodVolumeInfo      `json:"volumes"`
	EnvRefs    []PodEnvRef          `json:"env_refs"`

	// Controller chain, nearest first: ReplicaSet → Deployment, Job → CronJob.
	Owners           []ObjectRef `json:"owners"`
	ServiceAccount   *ObjectRef  `json:"service_account"`
	Node             *ObjectRef  `json:"node"`
	ImagePullSecrets []ObjectRef `json:"image_pull_secrets"`
	// Services whose selector matches the pod's labels.
	Services []ObjectRef `json:"services"`
}
