package services_k8sclient

import (
	"context"
	"sort"

	"kube-ins/internal/models"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// PullSecretRef names an image-pull Secret (namespace/name only; never its content).
type PullSecretRef struct{ Namespace, Name string }

// ScanTarget is one unique image together with the workloads that run it.
type ScanTarget struct {
	Image       string
	Workloads   []models.TrivyWorkloadRef // sorted, unique
	PullSecrets []PullSecretRef           // pod's own, then its ServiceAccount's; first-seen order, unique
}

func wlLess(a, b models.TrivyWorkloadRef) bool {
	if a.Namespace != b.Namespace {
		return a.Namespace < b.Namespace
	}
	if a.Kind != b.Kind {
		return a.Kind < b.Kind
	}
	return a.Name < b.Name
}

// workloadRefForPod resolves the top-level owner of a pod. ReplicaSets become
// Deployments and Jobs owned by a CronJob become that CronJob (jobOwner maps
// "ns/job" to the cronjob name).
func workloadRefForPod(pod *corev1.Pod, jobOwner map[string]string) models.TrivyWorkloadRef {
	kind, name := podOwner(pod.OwnerReferences, pod.Name)
	if kind == "Job" {
		if cj, ok := jobOwner[pod.Namespace+"/"+name]; ok {
			kind, name = "CronJob", cj
		}
	}
	return models.TrivyWorkloadRef{Kind: kind, Name: name, Namespace: pod.Namespace}
}

// cronJobOwners maps "ns/job" to the CronJob that owns it.
func cronJobOwners(jobs []batchv1.Job) map[string]string {
	out := map[string]string{}
	for _, j := range jobs {
		for _, ref := range j.OwnerReferences {
			if ref.Kind == "CronJob" {
				out[j.Namespace+"/"+j.Name] = ref.Name
				break
			}
		}
	}
	return out
}

func podImages(pod *corev1.Pod) []string {
	var out []string
	for _, c := range pod.Spec.InitContainers {
		out = append(out, c.Image)
	}
	for _, c := range pod.Spec.Containers {
		out = append(out, c.Image)
	}
	for _, c := range pod.Spec.EphemeralContainers {
		out = append(out, c.Image)
	}
	return out
}

// ListScanTargets lists pods and jobs once and returns unique images (sorted)
// with their workloads, plus the per-workload image lists. An empty namespace
// covers the whole cluster.
func ListScanTargets(ctx context.Context, client kubernetes.Interface, namespace string) ([]ScanTarget, []models.TrivyWorkload, error) {
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, nil, err
	}
	jobs, err := client.BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, nil, err
	}
	jobOwner := cronJobOwners(jobs.Items)

	sas := &saPullSecrets{client: client, byNS: map[string]map[string][]corev1.LocalObjectReference{}}
	imageSecrets := map[string][]PullSecretRef{}
	imageSecretSeen := map[string]map[PullSecretRef]struct{}{}

	imageWls := map[string]map[models.TrivyWorkloadRef]struct{}{}
	wlImages := map[models.TrivyWorkloadRef]map[string]struct{}{}
	for i := range pods.Items {
		pod := &pods.Items[i]
		ref := workloadRefForPod(pod, jobOwner)
		secrets := podPullSecrets(ctx, pod, sas)
		for _, img := range podImages(pod) {
			if img == "" {
				continue
			}
			if imageSecretSeen[img] == nil {
				imageSecretSeen[img] = map[PullSecretRef]struct{}{}
			}
			for _, s := range secrets {
				if _, dup := imageSecretSeen[img][s]; !dup {
					imageSecretSeen[img][s] = struct{}{}
					imageSecrets[img] = append(imageSecrets[img], s)
				}
			}
			if imageWls[img] == nil {
				imageWls[img] = map[models.TrivyWorkloadRef]struct{}{}
			}
			imageWls[img][ref] = struct{}{}
			if wlImages[ref] == nil {
				wlImages[ref] = map[string]struct{}{}
			}
			wlImages[ref][img] = struct{}{}
		}
	}

	targets := make([]ScanTarget, 0, len(imageWls))
	for img, set := range imageWls {
		refs := make([]models.TrivyWorkloadRef, 0, len(set))
		for r := range set {
			refs = append(refs, r)
		}
		sort.Slice(refs, func(i, j int) bool { return wlLess(refs[i], refs[j]) })
		targets = append(targets, ScanTarget{Image: img, Workloads: refs, PullSecrets: imageSecrets[img]})
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].Image < targets[j].Image })

	wls := make([]models.TrivyWorkload, 0, len(wlImages))
	for ref, set := range wlImages {
		imgs := make([]string, 0, len(set))
		for img := range set {
			imgs = append(imgs, img)
		}
		sort.Strings(imgs)
		wls = append(wls, models.TrivyWorkload{Kind: ref.Kind, Name: ref.Name, Namespace: ref.Namespace, Images: imgs})
	}
	sort.Slice(wls, func(i, j int) bool { return wlLess(wls[i].Ref(), wls[j].Ref()) })
	return targets, wls, nil
}

// ownedBy reports whether any of the given OwnerReferences has the given kind.
func ownedBy(ownerRefs []metav1.OwnerReference, kind string) bool {
	for _, ref := range ownerRefs {
		if ref.Kind == kind {
			return true
		}
	}
	return false
}

// podOwner resolves the top-level owner kind and name from a pod's
// OwnerReferences. ReplicaSets are unwrapped to Deployment.
func podOwner(ownerRefs []metav1.OwnerReference, podName string) (kind, name string) {
	if len(ownerRefs) == 0 {
		return "Pod", podName
	}
	ref := ownerRefs[0]
	k := ref.Kind
	if k == "ReplicaSet" {
		// Strip the hash suffix added by the Deployment controller
		// e.g. "my-deploy-7d6c9b4f5" → "my-deploy"
		n := ref.Name
		if idx := lastHyphenIndex(n); idx >= 0 {
			n = n[:idx]
		}
		return "Deployment", n
	}
	return k, ref.Name
}

// lastHyphenIndex finds the last '-' in s that is followed by a typical
// pod-template hash (alphanumeric, 5-10 chars). Returns -1 if not found.
func lastHyphenIndex(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '-' {
			suffix := s[i+1:]
			if len(suffix) >= 5 && len(suffix) <= 10 && isAlphanumeric(suffix) {
				return i
			}
		}
	}
	return -1
}

func isAlphanumeric(s string) bool {
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}
