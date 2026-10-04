package business

import (
	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"
)

func CreatePodExecSession(clusterName string, id, namespace, podName, container string, onOutput func(data string, end int64), onClosed func()) error {
	// Streaming client: the SPDY exec session must outlive the shared request timeout.
	client, config, err := repository.NewK8sClientAndConfigForClusterStreaming(clusterName)
	if err != nil {
		return err
	}
	return services.CreatePodExecSession(id, namespace, podName, container, onOutput, onClosed, client, config)
}

func WriteToPodExecSession(id, data string) error {
	return services.WriteToPodExecSession(id, data)
}

func ResizePodExecSession(id string, cols, rows int) error {
	return services.ResizePodExecSession(id, uint16(cols), uint16(rows))
}

func ClosePodExecSession(id string) error {
	return services.ClosePodExecSession(id)
}

// DetachPodExecSession keeps a pod exec or node shell running while its panel
// moves to another window — see services.DetachExecSession.
func DetachPodExecSession(id string) error {
	return services.DetachExecSession(id, detachGrace)
}

// AttachPodExecSession picks a moved pod exec or node shell up in its new
// window.
func AttachPodExecSession(id string) (models.TerminalSnapshot, error) {
	data, offset, err := services.AttachExecSession(id)
	if err != nil {
		return models.TerminalSnapshot{}, err
	}
	return models.TerminalSnapshot{Data: data, Offset: offset}, nil
}
