package services_k8sclient

import (
	"context"
	"fmt"
	"kube-ins/internal/logging"
	"kube-ins/internal/models"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/kubernetes"
)

// GetPodDetail returns what the pod list's expanded row shows: container specs,
// volumes, env references and the objects the pod is related to.
//
// Only the pod itself is required. The owner chain and the matching Services
// need further reads that an RBAC-restricted user may not be allowed; those
// failures leave their section empty rather than failing the whole detail.
func GetPodDetail(namespace, name string, client kubernetes.Interface) (models.PodDetailInfo, error) {
	ctx := context.Background()
	pod, err := client.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return models.PodDetailInfo{}, fmt.Errorf("get pod %s/%s: %w", namespace, name, err)
	}

	detail := buildPodDetail(pod)
	detail.Owners = podOwnerChain(ctx, client, pod)

	svcs, err := client.CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		logging.With("services.podDetail").Debug("list services for pod detail",
			"namespace", namespace, "pod", name, "err", err)
	} else {
		detail.Services = servicesSelecting(pod, svcs.Items)
	}
	return detail, nil
}

// buildPodDetail covers everything that can be read off the pod object alone.
func buildPodDetail(pod *corev1.Pod) models.PodDetailInfo {
	d := models.PodDetailInfo{
		Containers:       []models.PodContainerDetail{},
		Volumes:          []models.PodVolumeInfo{},
		EnvRefs:          []models.PodEnvRef{},
		Owners:           []models.ObjectRef{},
		ImagePullSecrets: []models.ObjectRef{},
		Services:         []models.ObjectRef{},
	}
	ns := pod.Namespace

	// Init containers first, kubectl order.
	type specContainer struct {
		c    corev1.Container
		init bool
	}
	all := make([]specContainer, 0, len(pod.Spec.InitContainers)+len(pod.Spec.Containers))
	for _, c := range pod.Spec.InitContainers {
		all = append(all, specContainer{c, true})
	}
	for _, c := range pod.Spec.Containers {
		all = append(all, specContainer{c, false})
	}

	mounts := map[string][]models.PodVolumeMount{}
	for _, e := range all {
		c := e.c
		d.Containers = append(d.Containers, models.PodContainerDetail{
			Name:     c.Name,
			Image:    c.Image,
			Init:     e.init,
			Ports:    containerPorts(c.Ports),
			Requests: resourceList(c.Resources.Requests),
			Limits:   resourceList(c.Resources.Limits),
			Probes:   containerProbes(c),
		})
		for _, m := range c.VolumeMounts {
			mounts[m.Name] = append(mounts[m.Name], models.PodVolumeMount{
				Container: c.Name, MountPath: m.MountPath, SubPath: m.SubPath, ReadOnly: m.ReadOnly,
			})
		}
		d.EnvRefs = append(d.EnvRefs, containerEnvRefs(c, ns)...)
	}

	for _, v := range pod.Spec.Volumes {
		info := podVolume(v, pod.Name, ns)
		info.Mounts = mounts[v.Name]
		if info.Mounts == nil {
			info.Mounts = []models.PodVolumeMount{}
		}
		d.Volumes = append(d.Volumes, info)
	}

	if sa := pod.Spec.ServiceAccountName; sa != "" {
		d.ServiceAccount = &models.ObjectRef{Kind: "ServiceAccount", Name: sa, Namespace: ns}
	}
	if n := pod.Spec.NodeName; n != "" {
		d.Node = &models.ObjectRef{Kind: "Node", Name: n}
	}
	for _, s := range pod.Spec.ImagePullSecrets {
		if s.Name != "" {
			d.ImagePullSecrets = append(d.ImagePullSecrets, models.ObjectRef{Kind: "Secret", Name: s.Name, Namespace: ns})
		}
	}
	return d
}

func containerPorts(ports []corev1.ContainerPort) []string {
	out := make([]string, 0, len(ports))
	for _, p := range ports {
		proto := string(p.Protocol)
		if proto == "" {
			proto = "TCP"
		}
		s := fmt.Sprintf("%d/%s", p.ContainerPort, proto)
		if p.Name != "" {
			s += " (" + p.Name + ")"
		}
		out = append(out, s)
	}
	return out
}

// resourceList renders requests or limits as "cpu 100m · memory 128Mi", keys
// sorted so the text does not reshuffle between fetches.
func resourceList(rl corev1.ResourceList) string {
	keys := make([]string, 0, len(rl))
	for k := range rl {
		keys = append(keys, string(k))
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		q := rl[corev1.ResourceName(k)]
		parts = append(parts, k+" "+q.String())
	}
	return strings.Join(parts, " · ")
}

func containerProbes(c corev1.Container) []string {
	out := []string{}
	for _, p := range []struct {
		kind  string
		probe *corev1.Probe
	}{{"startup", c.StartupProbe}, {"liveness", c.LivenessProbe}, {"readiness", c.ReadinessProbe}} {
		if p.probe != nil {
			out = append(out, p.kind+": "+probeHandler(p.probe.ProbeHandler))
		}
	}
	return out
}

func probeHandler(h corev1.ProbeHandler) string {
	switch {
	case h.HTTPGet != nil:
		return fmt.Sprintf("http :%s%s", h.HTTPGet.Port.String(), h.HTTPGet.Path)
	case h.TCPSocket != nil:
		return "tcp :" + h.TCPSocket.Port.String()
	case h.GRPC != nil:
		return fmt.Sprintf("grpc :%d", h.GRPC.Port)
	case h.Exec != nil:
		return "exec " + strings.Join(h.Exec.Command, " ")
	}
	return "unknown"
}

func containerEnvRefs(c corev1.Container, ns string) []models.PodEnvRef {
	out := []models.PodEnvRef{}
	for _, ef := range c.EnvFrom {
		switch {
		case ef.ConfigMapRef != nil:
			out = append(out, models.PodEnvRef{Container: c.Name, Prefix: ef.Prefix,
				Ref:      models.ObjectRef{Kind: "ConfigMap", Name: ef.ConfigMapRef.Name, Namespace: ns},
				Optional: isTrue(ef.ConfigMapRef.Optional)})
		case ef.SecretRef != nil:
			out = append(out, models.PodEnvRef{Container: c.Name, Prefix: ef.Prefix,
				Ref:      models.ObjectRef{Kind: "Secret", Name: ef.SecretRef.Name, Namespace: ns},
				Optional: isTrue(ef.SecretRef.Optional)})
		}
	}
	for _, e := range c.Env {
		if e.ValueFrom == nil {
			continue
		}
		switch {
		case e.ValueFrom.ConfigMapKeyRef != nil:
			r := e.ValueFrom.ConfigMapKeyRef
			out = append(out, models.PodEnvRef{Container: c.Name, Variable: e.Name, Key: r.Key,
				Ref: models.ObjectRef{Kind: "ConfigMap", Name: r.Name, Namespace: ns}, Optional: isTrue(r.Optional)})
		case e.ValueFrom.SecretKeyRef != nil:
			r := e.ValueFrom.SecretKeyRef
			out = append(out, models.PodEnvRef{Container: c.Name, Variable: e.Name, Key: r.Key,
				Ref: models.ObjectRef{Kind: "Secret", Name: r.Name, Namespace: ns}, Optional: isTrue(r.Optional)})
		}
	}
	return out
}

func isTrue(b *bool) bool { return b != nil && *b }

func podVolume(v corev1.Volume, podName, ns string) models.PodVolumeInfo {
	info := models.PodVolumeInfo{Name: v.Name, Refs: []models.ObjectRef{}}
	src := v.VolumeSource
	switch {
	case src.ConfigMap != nil:
		info.Type = "configMap"
		info.Refs = append(info.Refs, models.ObjectRef{Kind: "ConfigMap", Name: src.ConfigMap.Name, Namespace: ns})
		info.Detail = keyItems(src.ConfigMap.Items)
	case src.Secret != nil:
		info.Type = "secret"
		info.Refs = append(info.Refs, models.ObjectRef{Kind: "Secret", Name: src.Secret.SecretName, Namespace: ns})
		info.Detail = keyItems(src.Secret.Items)
	case src.PersistentVolumeClaim != nil:
		info.Type = "persistentVolumeClaim"
		info.Refs = append(info.Refs, models.ObjectRef{Kind: "PersistentVolumeClaim", Name: src.PersistentVolumeClaim.ClaimName, Namespace: ns})
		if src.PersistentVolumeClaim.ReadOnly {
			info.Detail = "read-only"
		}
	case src.Ephemeral != nil:
		// The generic ephemeral volume's claim is named <pod>-<volume>.
		info.Type = "ephemeral"
		info.Refs = append(info.Refs, models.ObjectRef{Kind: "PersistentVolumeClaim", Name: podName + "-" + v.Name, Namespace: ns})
	case src.Projected != nil:
		info.Type = "projected"
		var other []string
		for _, s := range src.Projected.Sources {
			switch {
			case s.ConfigMap != nil:
				info.Refs = append(info.Refs, models.ObjectRef{Kind: "ConfigMap", Name: s.ConfigMap.Name, Namespace: ns})
			case s.Secret != nil:
				info.Refs = append(info.Refs, models.ObjectRef{Kind: "Secret", Name: s.Secret.Name, Namespace: ns})
			case s.ServiceAccountToken != nil:
				other = append(other, "serviceAccountToken")
			case s.DownwardAPI != nil:
				other = append(other, "downwardAPI")
			case s.ClusterTrustBundle != nil:
				other = append(other, "clusterTrustBundle")
			}
		}
		info.Detail = strings.Join(other, ", ")
	case src.EmptyDir != nil:
		info.Type = "emptyDir"
		var parts []string
		if src.EmptyDir.Medium != "" {
			parts = append(parts, "medium "+string(src.EmptyDir.Medium))
		}
		if src.EmptyDir.SizeLimit != nil {
			parts = append(parts, "limit "+src.EmptyDir.SizeLimit.String())
		}
		info.Detail = strings.Join(parts, ", ")
	case src.HostPath != nil:
		info.Type = "hostPath"
		info.Detail = src.HostPath.Path
	case src.DownwardAPI != nil:
		info.Type = "downwardAPI"
	case src.CSI != nil:
		info.Type = "csi"
		info.Detail = src.CSI.Driver
	case src.NFS != nil:
		info.Type = "nfs"
		info.Detail = src.NFS.Server + ":" + src.NFS.Path
	default:
		info.Type = "other"
	}
	return info
}

// keyItems summarises a ConfigMap/Secret volume's `items` projection; "" means
// every key is mounted.
func keyItems(items []corev1.KeyToPath) string {
	if len(items) == 0 {
		return ""
	}
	keys := make([]string, 0, len(items))
	for _, it := range items {
		keys = append(keys, it.Key)
	}
	return "keys: " + strings.Join(keys, ", ")
}

// podOwnerChain walks the controller references up from the pod: a ReplicaSet
// to its Deployment, a Job to its CronJob. A failed lookup stops the walk at
// what is already known instead of failing the detail.
func podOwnerChain(ctx context.Context, client kubernetes.Interface, pod *corev1.Pod) []models.ObjectRef {
	chain := []models.ObjectRef{}
	owner := controllerRef(pod.OwnerReferences)
	if owner == nil {
		return chain
	}
	ns := pod.Namespace
	chain = append(chain, models.ObjectRef{Kind: owner.Kind, Name: owner.Name, Namespace: ns})

	var parentRefs []metav1.OwnerReference
	switch owner.Kind {
	case "ReplicaSet":
		rs, err := client.AppsV1().ReplicaSets(ns).Get(ctx, owner.Name, metav1.GetOptions{})
		if err != nil {
			return chain
		}
		parentRefs = rs.OwnerReferences
	case "Job":
		job, err := client.BatchV1().Jobs(ns).Get(ctx, owner.Name, metav1.GetOptions{})
		if err != nil {
			return chain
		}
		parentRefs = job.OwnerReferences
	default:
		return chain
	}
	if parent := controllerRef(parentRefs); parent != nil {
		chain = append(chain, models.ObjectRef{Kind: parent.Kind, Name: parent.Name, Namespace: ns})
	}
	return chain
}

// servicesSelecting returns the Services whose selector matches the pod. A
// Service without a selector (manually managed endpoints) selects nothing.
func servicesSelecting(pod *corev1.Pod, svcs []corev1.Service) []models.ObjectRef {
	out := []models.ObjectRef{}
	podLabels := labels.Set(pod.Labels)
	for _, s := range svcs {
		if s.Namespace != pod.Namespace || len(s.Spec.Selector) == 0 {
			continue
		}
		if labels.SelectorFromSet(s.Spec.Selector).Matches(podLabels) {
			out = append(out, models.ObjectRef{Kind: "Service", Name: s.Name, Namespace: s.Namespace})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
