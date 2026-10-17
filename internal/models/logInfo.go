package models

// LogStreamOptions are the per-stream knobs of a log panel. They map onto
// corev1.PodLogOptions, with zero meaning "not set" so the frontend can send
// the struct as-is.
type LogStreamOptions struct {
	// TailLines is how many existing lines to start from; 0 means the whole log.
	TailLines int64 `json:"tail_lines"`
	// SinceSeconds limits the log to the last N seconds; 0 means no limit.
	SinceSeconds int64 `json:"since_seconds"`
	Timestamps   bool  `json:"timestamps"`
	// Previous reads the last terminated instance of the container. Such a log
	// is finished, so the stream is not followed and ends on its own.
	Previous bool `json:"previous"`
}

// LogContainerInfo is one container a log panel can read from. Kind is
// "init", "container" or "ephemeral": the log panel lists all three, unlike
// GetPodContainers, which exec uses and so returns regular containers only.
type LogContainerInfo struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}
