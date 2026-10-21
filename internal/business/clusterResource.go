package business

import (
	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"

	"k8s.io/client-go/metadata"
)

// GetClusterGraph returns the workload graph for the given namespaces; an
// empty list means every namespace.
func GetClusterGraph(clusterName string, namespaces []string) (*models.ClusterGraph, error) {
	// The rest config is for the metadata client: ConfigMaps and Secrets are
	// listed by name only, so no Secret data is ever fetched for the graph.
	client, config, err := repository.NewK8sClientAndConfigForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	meta, err := metadata.NewForConfig(config)
	if err != nil {
		return nil, err
	}
	return services.GetClusterGraph(client, meta, namespaces)
}

// GetGraphUsage returns the live pod usage behind the resource graph's
// overlay. It never fails: without metrics-server the result is marked
// unavailable instead.
func GetGraphUsage(clusterName string, namespaces []string) models.GraphUsage {
	mc, err := repository.NewMetricsClientForCluster(clusterName)
	if err != nil || mc == nil {
		// An untyped nil: a nil *Clientset in the interface would not compare
		// equal to nil inside the service.
		return services.GetGraphUsage(nil, namespaces)
	}
	return services.GetGraphUsage(mc, namespaces)
}
