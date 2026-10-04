package services_k8sclient

import (
	"context"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"kube-ins/internal/models"
)

func GetNamespaces(k8sClient *kubernetes.Clientset) ([]models.NamespaceInfo, error) {
	nsList, err := k8sClient.CoreV1().Namespaces().List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	result := make([]models.NamespaceInfo, 0, len(nsList.Items))
	for _, ns := range nsList.Items {
		result = append(result, namespaceToInfo(ns, k8sClient))
	}
	return result, nil
}

func namespaceToInfo(ns corev1.Namespace, k8sClient *kubernetes.Clientset) models.NamespaceInfo {
	status := string(ns.Status.Phase)
	if status == "" {
		status = "Unknown"
	}

	info := models.NamespaceInfo{
		Name:           ns.Name,
		Status:         status,
		ResourceQuotas: []models.ResourceQuotaInfo{},
	}

	quotas, err := k8sClient.CoreV1().ResourceQuotas(ns.Name).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return info
	}

	for _, rq := range quotas.Items {
		rqInfo := models.ResourceQuotaInfo{
			Name:    rq.Name,
			Entries: []models.ResourceQuotaEntry{},
		}

		for resourceName, hardQty := range rq.Status.Hard {
			rqInfo.Entries = append(rqInfo.Entries, newQuotaEntry(string(resourceName), hardQty, rq.Status.Used[resourceName]))
		}

		sort.Slice(rqInfo.Entries, func(i, j int) bool {
			return rqInfo.Entries[i].Resource < rqInfo.Entries[j].Resource
		})
		info.ResourceQuotas = append(info.ResourceQuotas, rqInfo)
	}
	return info
}

// CreateNamespace creates a namespace. The name is not validated here beyond
// being non-empty — the API server owns the DNS-1123 rules and returns a far
// better message than a hand-rolled regex would.
func CreateNamespace(name string, labels map[string]string, k8sClient *kubernetes.Clientset) error {
	if name == "" {
		return errNameRequired
	}
	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels},
	}
	_, err := k8sClient.CoreV1().Namespaces().Create(context.Background(), ns, metav1.CreateOptions{})
	return err
}

func DeleteNamespace(name string, k8sClient *kubernetes.Clientset) error {
	return k8sClient.CoreV1().Namespaces().Delete(context.Background(), name, metav1.DeleteOptions{})
}

func GetNamespaceYaml(name string, k8sClient *kubernetes.Clientset) (string, error) {
	ns, err := k8sClient.CoreV1().Namespaces().Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return toApplyYaml(ns)
}

// newQuotaEntry builds one quota row. Remaining is computed on the Quantity,
// not on the comparable numbers, so it keeps the quota's own units ("2500m",
// "5Gi") instead of a raw milli/byte count the frontend would have to format.
func newQuotaEntry(resourceName string, hard, used resource.Quantity) models.ResourceQuotaEntry {
	remaining := hard.DeepCopy()
	remaining.Sub(used)
	return models.ResourceQuotaEntry{
		Resource:  resourceName,
		Hard:      hard.String(),
		Used:      used.String(),
		Remaining: remaining.String(),
		HardNum:   quantityToComparableNum(resourceName, hard),
		UsedNum:   quantityToComparableNum(resourceName, used),
	}
}

func quantityToComparableNum(resourceName string, qty resource.Quantity) int64 {
	if strings.Contains(resourceName, "cpu") {
		return qty.MilliValue()
	}
	return qty.Value()
}
