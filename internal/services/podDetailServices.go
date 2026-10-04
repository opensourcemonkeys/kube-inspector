package services_k8sclient

import (
	"context"
	"fmt"
	"kube-ins/internal/logging"
	"kube-ins/internal/models"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/kubernetes"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
	"sigs.k8s.io/yaml"
)

// GetPodDetail returns what the pod detail panel shows: the pod's metadata and
// status, container specs and state, volumes, and the objects it is related to.
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

// GetPodContainerUsage reads one pod's per-container usage from metrics-server,
// polled by the pod detail panel while it is on screen. No metrics-server, or no
// sample for this pod yet, is an error: the caller shows usage as unavailable.
func GetPodContainerUsage(namespace, name string, mc metricsclient.Interface) ([]models.ContainerUsage, error) {
	if mc == nil {
		return nil, fmt.Errorf("metrics-server unavailable")
	}
	pm, err := mc.MetricsV1beta1().PodMetricses(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get metrics for pod %s/%s: %w", namespace, name, err)
	}
	out := make([]models.ContainerUsage, 0, len(pm.Containers))
	for _, c := range pm.Containers {
		out = append(out, models.ContainerUsage{Name: c.Name, CpuMillis: c.Usage.Cpu().MilliValue(), MemMi: c.Usage.Memory().Value() / miDivisor})
	}
	return out, nil
}

// buildPodDetail covers everything that can be read off the pod object alone.
func buildPodDetail(pod *corev1.Pod) models.PodDetailInfo {
	ns := pod.Namespace
	d := models.PodDetailInfo{
		Name:          pod.Name,
		Namespace:     ns,
		CreatedAt:     pod.CreationTimestamp.Time.Format(time.RFC3339),
		Labels:        nonNilMap(pod.Labels),
		Annotations:   nonNilMap(pod.Annotations),
		Status:        string(getPodStatus(*pod)),
		PodIPs:        podIPs(pod),
		HostIP:        pod.Status.HostIP,
		PriorityClass: pod.Spec.PriorityClassName,
		QosClass:      string(pod.Status.QOSClass),
		Conditions:    []models.PodCondition{},
		Tolerations:   []models.PodToleration{},
		Owners:        []models.ObjectRef{},
		Services:      []models.ObjectRef{},
		Containers:    []models.PodContainerDetail{},
		Volumes:       []models.PodVolumeInfo{},
	}
	for _, c := range pod.Status.Conditions {
		d.Conditions = append(d.Conditions, models.PodCondition{Type: string(c.Type), Status: string(c.Status), Reason: c.Reason, Message: c.Message})
	}
	for _, t := range pod.Spec.Tolerations {
		d.Tolerations = append(d.Tolerations, toleration(t))
	}
	d.Affinity, d.AffinityCount = affinity(pod.Spec.Affinity)

	refs := newRefSet(ns)

	statuses := map[string]corev1.ContainerStatus{}
	for _, cs := range pod.Status.InitContainerStatuses {
		statuses["init:"+cs.Name] = cs
	}
	for _, cs := range pod.Status.ContainerStatuses {
		statuses[cs.Name] = cs
	}

	// Init containers first, kubectl order.
	for _, c := range pod.Spec.InitContainers {
		cs, ok := statuses["init:"+c.Name]
		d.Containers = append(d.Containers, containerDetail(c, true, cs, ok, ns, refs))
	}
	for _, c := range pod.Spec.Containers {
		cs, ok := statuses[c.Name]
		d.Containers = append(d.Containers, containerDetail(c, false, cs, ok, ns, refs))
	}

	for _, v := range pod.Spec.Volumes {
		info := podVolume(v, pod.Name, ns)
		refs.add(info.Refs...)
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
			refs.add(models.ObjectRef{Kind: "Secret", Name: s.Name, Namespace: ns})
		}
	}
	d.Secrets = refs.sorted("Secret")
	d.ConfigMaps = refs.sorted("ConfigMap")
	d.PersistentVolumeClaims = refs.sorted("PersistentVolumeClaim")
	return d
}

func containerDetail(c corev1.Container, init bool, cs corev1.ContainerStatus, hasStatus bool, ns string, refs *refSet) models.PodContainerDetail {
	req, lim := c.Resources.Requests, c.Resources.Limits
	cd := models.PodContainerDetail{
		Name:             c.Name,
		Image:            c.Image,
		ImagePullPolicy:  string(c.ImagePullPolicy),
		Init:             init,
		Ports:            containerPorts(c.Ports),
		Env:              []models.PodEnvVar{},
		EnvFrom:          []models.PodEnvFrom{},
		Mounts:           []models.PodContainerMount{},
		Probes:           containerProbes(c),
		Command:          nonNilSlice(c.Command),
		Args:             nonNilSlice(c.Args),
		CpuRequestMillis: req.Cpu().MilliValue(),
		CpuLimitMillis:   lim.Cpu().MilliValue(),
		MemRequestMi:     req.Memory().Value() / miDivisor,
		MemLimitMi:       lim.Memory().Value() / miDivisor,
		OtherResources:   otherResources(req, lim),
	}
	if hasStatus {
		st := mapContainerStatus(cs, init)
		cd.Status = &st
		switch {
		case cs.State.Running != nil:
			cd.StartedAt = cs.State.Running.StartedAt.Time.Format(time.RFC3339)
		case cs.State.Waiting != nil:
			cd.StateMessage = cs.State.Waiting.Message
		case cs.State.Terminated != nil:
			cd.StateMessage = cs.State.Terminated.Message
		}
		if t := cs.LastTerminationState.Terminated; t != nil {
			cd.LastState = fmt.Sprintf("Terminated: %s (exit %d)", t.Reason, t.ExitCode)
			cd.LastStateAt = t.FinishedAt.Time.Format(time.RFC3339)
		}
	}
	for _, m := range c.VolumeMounts {
		cd.Mounts = append(cd.Mounts, models.PodContainerMount{Volume: m.Name, MountPath: m.MountPath, SubPath: m.SubPath, ReadOnly: m.ReadOnly})
	}
	for _, ef := range c.EnvFrom {
		var from models.PodEnvFrom
		switch {
		case ef.ConfigMapRef != nil:
			from = models.PodEnvFrom{Ref: models.ObjectRef{Kind: "ConfigMap", Name: ef.ConfigMapRef.Name, Namespace: ns}, Optional: isTrue(ef.ConfigMapRef.Optional)}
		case ef.SecretRef != nil:
			from = models.PodEnvFrom{Ref: models.ObjectRef{Kind: "Secret", Name: ef.SecretRef.Name, Namespace: ns}, Optional: isTrue(ef.SecretRef.Optional)}
		default:
			continue
		}
		from.Prefix = ef.Prefix
		refs.add(from.Ref)
		cd.EnvFrom = append(cd.EnvFrom, from)
	}
	for _, e := range c.Env {
		v := envVar(e, ns)
		if v.Ref != nil {
			refs.add(*v.Ref)
		}
		cd.Env = append(cd.Env, v)
	}
	return cd
}

// envVar describes one env entry. A literal value is shown as written: it is
// already in the pod spec in plain text. Secret values are never resolved —
// only the Secret and key are named.
func envVar(e corev1.EnvVar, ns string) models.PodEnvVar {
	v := models.PodEnvVar{Name: e.Name, Value: e.Value}
	if e.ValueFrom == nil {
		return v
	}
	switch src := e.ValueFrom; {
	case src.ConfigMapKeyRef != nil:
		v.Source, v.Key, v.Optional = "configMap", src.ConfigMapKeyRef.Key, isTrue(src.ConfigMapKeyRef.Optional)
		v.Ref = &models.ObjectRef{Kind: "ConfigMap", Name: src.ConfigMapKeyRef.Name, Namespace: ns}
	case src.SecretKeyRef != nil:
		v.Source, v.Key, v.Optional = "secret", src.SecretKeyRef.Key, isTrue(src.SecretKeyRef.Optional)
		v.Ref = &models.ObjectRef{Kind: "Secret", Name: src.SecretKeyRef.Name, Namespace: ns}
	case src.FieldRef != nil:
		v.Source, v.Key = "field", src.FieldRef.FieldPath
	case src.ResourceFieldRef != nil:
		v.Source, v.Key = "resource", src.ResourceFieldRef.Resource
	}
	return v
}

func toleration(t corev1.Toleration) models.PodToleration {
	out := models.PodToleration{Key: t.Key, Operator: string(t.Operator), Value: t.Value, Effect: string(t.Effect)}
	if t.TolerationSeconds != nil {
		out.Seconds = fmt.Sprintf("%d", *t.TolerationSeconds)
	}
	return out
}

// affinity renders spec.affinity as YAML and counts which of its three parts
// are set — the "Affinities: 2" a user scans for before opening the block.
func affinity(a *corev1.Affinity) (string, int) {
	if a == nil {
		return "", 0
	}
	n := 0
	for _, set := range []bool{a.NodeAffinity != nil, a.PodAffinity != nil, a.PodAntiAffinity != nil} {
		if set {
			n++
		}
	}
	if n == 0 {
		return "", 0
	}
	b, err := yaml.Marshal(a)
	if err != nil {
		return "", n
	}
	return string(b), n
}

func podIPs(pod *corev1.Pod) []string {
	out := []string{}
	for _, ip := range pod.Status.PodIPs {
		out = append(out, ip.IP)
	}
	if len(out) == 0 && pod.Status.PodIP != "" {
		out = append(out, pod.Status.PodIP)
	}
	return out
}

func nonNilMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func nonNilSlice(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// refSet gathers the objects a pod references, deduplicated per kind.
type refSet struct {
	ns   string
	seen map[string]map[string]bool
}

func newRefSet(ns string) *refSet { return &refSet{ns: ns, seen: map[string]map[string]bool{}} }

func (r *refSet) add(refs ...models.ObjectRef) {
	for _, ref := range refs {
		if r.seen[ref.Kind] == nil {
			r.seen[ref.Kind] = map[string]bool{}
		}
		r.seen[ref.Kind][ref.Name] = true
	}
}

func (r *refSet) sorted(kind string) []models.ObjectRef {
	names := make([]string, 0, len(r.seen[kind]))
	for n := range r.seen[kind] {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]models.ObjectRef, 0, len(names))
	for _, n := range names {
		out = append(out, models.ObjectRef{Kind: kind, Name: n, Namespace: r.ns})
	}
	return out
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

// otherResources renders every requested resource besides CPU and memory as
// "name request / limit", sorted so the text does not reshuffle between fetches.
func otherResources(req, lim corev1.ResourceList) []string {
	names := map[corev1.ResourceName]bool{}
	for k := range req {
		names[k] = true
	}
	for k := range lim {
		names[k] = true
	}
	delete(names, corev1.ResourceCPU)
	delete(names, corev1.ResourceMemory)

	keys := make([]string, 0, len(names))
	for k := range names {
		keys = append(keys, string(k))
	}
	sort.Strings(keys)
	quantity := func(rl corev1.ResourceList, k string) string {
		if q, ok := rl[corev1.ResourceName(k)]; ok {
			return q.String()
		}
		return "–"
	}
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+" "+quantity(req, k)+" / "+quantity(lim, k))
	}
	return out
}

func containerProbes(c corev1.Container) []models.PodProbe {
	out := []models.PodProbe{}
	for _, p := range []struct {
		kind  string
		probe *corev1.Probe
	}{{"startup", c.StartupProbe}, {"liveness", c.LivenessProbe}, {"readiness", c.ReadinessProbe}} {
		if p.probe != nil {
			out = append(out, models.PodProbe{Kind: p.kind, Handler: probeHandler(p.probe.ProbeHandler), Timing: probeTiming(p.probe)})
		}
	}
	return out
}

// probeHandler renders a probe's action the way kubectl describe does.
func probeHandler(h corev1.ProbeHandler) string {
	switch {
	case h.HTTPGet != nil:
		scheme := strings.ToLower(string(h.HTTPGet.Scheme))
		if scheme == "" {
			scheme = "http"
		}
		return fmt.Sprintf("http-get %s://%s:%s%s", scheme, h.HTTPGet.Host, h.HTTPGet.Port.String(), h.HTTPGet.Path)
	case h.TCPSocket != nil:
		return fmt.Sprintf("tcp-socket %s:%s", h.TCPSocket.Host, h.TCPSocket.Port.String())
	case h.GRPC != nil:
		return fmt.Sprintf("grpc :%d", h.GRPC.Port)
	case h.Exec != nil:
		return "exec [" + strings.Join(h.Exec.Command, " ") + "]"
	}
	return "unknown"
}

// probeTiming is kubectl describe's timing suffix. Unset fields show the
// API defaults, which is what the kubelet actually uses.
func probeTiming(p *corev1.Probe) string {
	or := func(v, def int32) int32 {
		if v == 0 {
			return def
		}
		return v
	}
	return fmt.Sprintf("delay=%ds timeout=%ds period=%ds #success=%d #failure=%d",
		p.InitialDelaySeconds, or(p.TimeoutSeconds, 1), or(p.PeriodSeconds, 10), or(p.SuccessThreshold, 1), or(p.FailureThreshold, 3))
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
