package services_k8sclient

import (
	"context"

	"kube-ins/internal/models"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

// GetGraphUsage lists the live usage of every pod in the given namespaces (an
// empty list means every namespace) for the resource graph's overlay. The
// graph sums it up its owner chain itself, so only pods are returned.
//
// A missing or unreadable metrics-server is not an error: the overlay is
// optional, and the result says why it is empty.
func GetGraphUsage(mc metricsclient.Interface, namespaces []string) models.GraphUsage {
	out := models.GraphUsage{Pods: []models.GraphPodUsage{}, Hosts: []models.GraphPodUsage{}}
	if mc == nil {
		out.Reason = "unavailable"
		return out
	}
	ctx := context.Background()
	for _, ns := range scopeNamespaces(namespaces) {
		l, err := mc.MetricsV1beta1().PodMetricses(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			out.Reason = "unavailable"
			if apierrors.IsForbidden(err) {
				out.Reason = "forbidden"
			}
			out.Pods = []models.GraphPodUsage{}
			return out
		}
		for _, pm := range l.Items {
			u := models.GraphPodUsage{Namespace: pm.Namespace, Name: pm.Name}
			for _, c := range pm.Containers {
				u.CpuMillis += c.Usage.Cpu().MilliValue()
				u.MemMi += c.Usage.Memory().Value() / miDivisor
			}
			out.Pods = append(out.Pods, u)
		}
	}
	out.Available = true
	// Node usage is a bonus for the group-by-node frames: a user who may read
	// pod metrics but not node metrics still gets the pods.
	if l, err := mc.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{}); err == nil {
		for _, nm := range l.Items {
			out.Hosts = append(out.Hosts, models.GraphPodUsage{
				Name: nm.Name, CpuMillis: nm.Usage.Cpu().MilliValue(), MemMi: nm.Usage.Memory().Value() / miDivisor,
			})
		}
	}
	return out
}
