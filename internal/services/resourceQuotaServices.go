package services_k8sclient

import (
	"context"
	"fmt"
	"sort"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"kube-ins/internal/models"
	"sigs.k8s.io/yaml"
)

// GetResourceQuotas lists quotas across all namespaces with one API call
// (unlike GetNamespaces, which lists quotas per namespace).
func GetResourceQuotas(k8sClient *kubernetes.Clientset) ([]models.NamespacedResourceQuota, error) {
	quotas, err := k8sClient.CoreV1().ResourceQuotas("").List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	result := make([]models.NamespacedResourceQuota, 0, len(quotas.Items))
	for _, rq := range quotas.Items {
		info := models.NamespacedResourceQuota{
			Namespace: rq.Namespace,
			Name:      rq.Name,
			Entries:   []models.ResourceQuotaEntry{},
		}
		for resourceName, hardQty := range rq.Status.Hard {
			info.Entries = append(info.Entries, newQuotaEntry(string(resourceName), hardQty, rq.Status.Used[resourceName]))
		}
		sort.Slice(info.Entries, func(i, j int) bool {
			return info.Entries[i].Resource < info.Entries[j].Resource
		})
		result = append(result, info)
	}
	return result, nil
}

func GetResourceQuotaYaml(name, namespace string, k8sClient *kubernetes.Clientset) (string, error) {
	rq, err := k8sClient.CoreV1().ResourceQuotas(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return toApplyYaml(rq)
}

func UpdateResourceQuotaYaml(name, namespace, yamlContent string, k8sClient *kubernetes.Clientset) error {
	var rq corev1.ResourceQuota
	if err := yaml.Unmarshal([]byte(yamlContent), &rq); err != nil {
		return fmt.Errorf("failed to parse YAML: %w", err)
	}
	rq.Name = name
	rq.Namespace = namespace
	_, err := k8sClient.CoreV1().ResourceQuotas(namespace).Update(context.Background(), &rq, metav1.UpdateOptions{})
	return err
}
