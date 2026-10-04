package business

import (
	"fmt"
	"kube-ins/internal/logging"
	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"
)

// GetPods exposes pod data to the Wails app context.
func GetPods(clusterName string) ([]models.PodInfo, error) {

	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}
	// metrics-server is optional: a nil client makes the service report usage as
	// unavailable rather than failing the whole listing.
	mc, err := repository.NewMetricsClientForCluster(clusterName)
	if err != nil {
		logging.With("business.pod").Debug("metrics-server unavailable",
			"cluster", clusterName, "err", err)
	}
	podItem, err := services.GetPods("", client, mc)
	if err != nil {
		return nil, fmt.Errorf("list pods in cluster %q: %w", clusterName, err)
	}
	return podItem, nil
}

func DeletePod(clusterName string, name string, namespace string) error {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return err
	}

	return services.DeletePod(namespace, name, client)
}

func GetPodYaml(clusterName string, name string, namespace string) (string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return "", err
	}

	return services.GetPodYaml(namespace, name, client)
}

// GetPodDetail backs the pod list's expanded row; see services.GetPodDetail.
func GetPodDetail(clusterName string, name string, namespace string) (models.PodDetailInfo, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return models.PodDetailInfo{}, fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}

	return services.GetPodDetail(namespace, name, client)
}

// GetPodContainerUsage is the expanded row's live per-container usage.
func GetPodContainerUsage(clusterName string, name string, namespace string) ([]models.ContainerUsage, error) {
	mc, err := repository.NewMetricsClientForCluster(clusterName)
	if err != nil {
		return nil, fmt.Errorf("metrics-server unavailable for cluster %q: %w", clusterName, err)
	}

	return services.GetPodContainerUsage(namespace, name, mc)
}
