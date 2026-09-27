package business

import (
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"
)

// CreateNodeShellSession opens a root shell on a node by way of a privileged
// helper pod. Blocks until the pod is running and the shell is attached.
func CreateNodeShellSession(clusterName string, id, nodeName string, onOutput func(string), onClosed func()) error {
	// Streaming client: like a pod exec, the SPDY session must outlive the
	// shared request timeout — and so must the pod-startup wait.
	client, config, err := repository.NewK8sClientAndConfigForClusterStreaming(clusterName)
	if err != nil {
		return err
	}
	return services.CreateNodeShellSession(id, nodeName, onOutput, onClosed, client, config)
}

func CloseNodeShellSession(id string) error {
	return services.CloseNodeShellSession(id)
}
