package services_k8sclient

import (
	"context"
	"sort"
	"strings"

	"kube-ins/internal/models"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/kubernetes"
)

// WorkloadExposure maps each workload reachable from outside the cluster to the
// objects exposing it: "LoadBalancer <ns>/<svc>", "NodePort <ns>/<svc>" and
// "Ingress <ns>/<ing>" (via the Services the Ingress routes to). Sorted, unique.
// An Ingress list that is Forbidden is skipped and reported as partial = true:
// the result then shows what the Services expose, but a workload missing from
// it may still be reachable through an Ingress. Other errors are returned.
func WorkloadExposure(ctx context.Context, client kubernetes.Interface, namespace string) (exposure map[models.TrivyWorkloadRef][]string, partial bool, err error) {
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, false, err
	}
	svcs, err := client.CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, false, err
	}
	jobs, err := client.BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, false, err
	}
	var ings []networkingv1.Ingress
	il, err := client.NetworkingV1().Ingresses(namespace).List(ctx, metav1.ListOptions{})
	switch {
	case err == nil:
		ings = il.Items
	case apierrors.IsForbidden(err):
		partial = true
	default:
		return nil, false, err
	}

	jobOwner := cronJobOwners(jobs.Items)
	svcByKey := map[string]*corev1.Service{}
	for i := range svcs.Items {
		s := &svcs.Items[i]
		svcByKey[s.Namespace+"/"+s.Name] = s
	}
	// workloadsOf: the workloads of the pods a Service selects.
	workloadsOf := func(s *corev1.Service) []models.TrivyWorkloadRef {
		if len(s.Spec.Selector) == 0 {
			return nil
		}
		sel := labels.SelectorFromSet(s.Spec.Selector)
		set := map[models.TrivyWorkloadRef]struct{}{}
		for i := range pods.Items {
			p := &pods.Items[i]
			if p.Namespace == s.Namespace && sel.Matches(labels.Set(p.Labels)) {
				set[workloadRefForPod(p, jobOwner)] = struct{}{}
			}
		}
		out := make([]models.TrivyWorkloadRef, 0, len(set))
		for r := range set {
			out = append(out, r)
		}
		return out
	}

	acc := map[models.TrivyWorkloadRef]map[string]struct{}{}
	mark := func(refs []models.TrivyWorkloadRef, fact string) {
		for _, r := range refs {
			if acc[r] == nil {
				acc[r] = map[string]struct{}{}
			}
			acc[r][fact] = struct{}{}
		}
	}
	for i := range svcs.Items {
		s := &svcs.Items[i]
		switch s.Spec.Type {
		case corev1.ServiceTypeLoadBalancer, corev1.ServiceTypeNodePort:
			mark(workloadsOf(s), string(s.Spec.Type)+" "+s.Namespace+"/"+s.Name)
		}
	}
	for _, ing := range ings {
		names := map[string]struct{}{}
		if b := ing.Spec.DefaultBackend; b != nil && b.Service != nil {
			names[b.Service.Name] = struct{}{}
		}
		for _, rule := range ing.Spec.Rules {
			if rule.HTTP == nil {
				continue
			}
			for _, p := range rule.HTTP.Paths {
				if p.Backend.Service != nil {
					names[p.Backend.Service.Name] = struct{}{}
				}
			}
		}
		for n := range names {
			if s := svcByKey[ing.Namespace+"/"+n]; s != nil {
				mark(workloadsOf(s), "Ingress "+ing.Namespace+"/"+ing.Name)
			}
		}
	}
	return sortedFacts(acc), partial, nil
}

func sortedFacts(acc map[models.TrivyWorkloadRef]map[string]struct{}) map[models.TrivyWorkloadRef][]string {
	out := make(map[models.TrivyWorkloadRef][]string, len(acc))
	for r, set := range acc {
		facts := make([]string, 0, len(set))
		for f := range set {
			facts = append(facts, f)
		}
		sort.Strings(facts)
		out[r] = facts
	}
	return out
}

// NormalizeCheckID reduces "AVD-KSV-0012", "KSV-0012" and "KSV012" to "KSV12".
func NormalizeCheckID(id string) string {
	id = strings.ToUpper(strings.TrimSpace(id))
	id = strings.TrimPrefix(id, "AVD-")
	id = strings.ReplaceAll(id, "-", "")
	i := len(id)
	for i > 0 && id[i-1] >= '0' && id[i-1] <= '9' {
		i--
	}
	prefix, num := id[:i], strings.TrimLeft(id[i:], "0")
	if num == "" && i < len(id) {
		num = "0"
	}
	return prefix + num
}

var privilegeChecks = map[string]string{
	"KSV12": "root", "KSV17": "privileged", "KSV23": "hostPath", "KSV9": "hostNetwork",
}

// WorkloadPrivileges derives per-workload privilege facts from misconfig findings.
func WorkloadPrivileges(ms []models.TrivyK8sMisconfigFinding) map[models.TrivyWorkloadRef][]string {
	acc := map[models.TrivyWorkloadRef]map[string]struct{}{}
	for _, m := range ms {
		fact, ok := privilegeChecks[NormalizeCheckID(m.CheckID)]
		if !ok {
			continue
		}
		r := models.TrivyWorkloadRef{Kind: m.ResourceKind, Name: m.ResourceName, Namespace: m.Namespace}
		if acc[r] == nil {
			acc[r] = map[string]struct{}{}
		}
		acc[r][fact] = struct{}{}
	}
	return sortedFacts(acc)
}
