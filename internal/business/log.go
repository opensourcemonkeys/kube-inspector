package business

import (
	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"
)

func GetPodContainers(clusterName string, name, namespace string) ([]string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.GetPodContainers(namespace, name, client)
}

func GetPodLogContainers(clusterName string, name, namespace string) ([]models.LogContainerInfo, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.GetPodLogContainers(namespace, name, client)
}

func GetDeploymentPods(clusterName string, name, namespace string) ([]string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.GetDeploymentPods(namespace, name, client)
}

func GetStatefulSetPods(clusterName string, name, namespace string) ([]string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.GetStatefulSetPods(namespace, name, client)
}

func GetReplicaSetPods(clusterName string, name, namespace string) ([]string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.GetReplicaSetPods(namespace, name, client)
}

func GetDaemonSetPods(clusterName string, name, namespace string) ([]string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.GetDaemonSetPods(namespace, name, client)
}

func GetJobPods(clusterName string, name, namespace string) ([]string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.GetJobPods(namespace, name, client)
}

func GetCronJobPods(clusterName string, name, namespace string) ([]string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.GetCronJobPods(namespace, name, client)
}

// StartLogStream follows one container's log. onClose fires only when the
// stream ends on its own; see services.StartLogStream.
func StartLogStream(clusterName string, sessionId, podName, namespace, container string, opts models.LogStreamOptions, onData func(string), onClose func(reason string)) error {
	// Streaming client: a followed log stream must outlive the shared request timeout.
	client, err := repository.NewK8sClientForClusterStreaming(clusterName)
	if err != nil {
		return err
	}
	return services.StartLogStream(sessionId, namespace, podName, container, opts, client, onData, onClose)
}

func StopLogStream(sessionId string) {
	services.StopLogStream(sessionId)
}

// GetPodLogsTail returns the last `tail` lines of a pod/container's logs in one read.
func GetPodLogsTail(clusterName, namespace, podName, container string, tail int64) (string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return "", err
	}
	return services.GetPodLogsTail(namespace, podName, container, tail, client)
}
