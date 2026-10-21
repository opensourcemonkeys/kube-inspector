package services_k8sclient

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"kube-ins/internal/models"
	"kube-ins/internal/safego"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/metadata"
)

// graphInputs is everything the resource graph is drawn from, fetched up front
// so the (deterministic, order-sensitive) node/edge assembly runs on one stack.
type graphInputs struct {
	pods         []corev1.Pod
	deployments  []appsv1.Deployment
	replicaSets  []appsv1.ReplicaSet
	statefulSets []appsv1.StatefulSet
	daemonSets   []appsv1.DaemonSet
	services     []corev1.Service
	ingresses    []networkingv1.Ingress

	// Config and storage. ConfigMaps and Secrets are metadata only: the graph
	// needs their names, and a Secret's data has no business crossing the wire.
	configMaps      []metav1.PartialObjectMetadata
	secrets         []metav1.PartialObjectMetadata
	serviceAccounts []corev1.ServiceAccount
	pvcs            []corev1.PersistentVolumeClaim
	pvs             []corev1.PersistentVolume
	storageClasses  []storagev1.StorageClass

	// Recent Warning events, attached to the objects they are about.
	events []corev1.Event
	// The cluster's Nodes, for the frontend's group-by-node frames.
	hosts []corev1.Node

	// allNamespaces: the cluster-scoped PVs and StorageClasses are drawn in
	// full rather than only where a listed PVC reaches them.
	allNamespaces bool
	warnings      []models.GraphWarning
	// now: when the inputs were read; event age is measured against it.
	now time.Time
}

var (
	configMapsGVR = schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}
	secretsGVR    = schema.GroupVersionResource{Version: "v1", Resource: "secrets"}
)

// kubeRootCA is published into every namespace and mounted into every pod by
// the automatic service-account volume; as a node it would tie every workload
// in the namespace to every other.
const kubeRootCA = "kube-root-ca.crt"

// helmReleaseSecretType is the type Helm stores each release revision under —
// one Secret per upgrade, in every namespace with a chart in it.
const helmReleaseSecretType = "helm.sh/release.v1"

// GetClusterGraph builds the Ingress → Service → controller → ReplicaSet → Pod
// graph for the given namespaces; an empty list means every namespace.
//
// A namespaced list per selected namespace, rather than one cluster-wide list
// filtered here, is the point: on a large cluster it is the difference between
// fetching a few dozen pods and a few thousand, and it keeps working for a user
// whose RBAC stops at their own namespaces.
func GetClusterGraph(client kubernetes.Interface, meta metadata.Interface, namespaces []string) (*models.ClusterGraph, error) {
	in, err := fetchGraphInputs(context.Background(), client, meta, scopeNamespaces(namespaces))
	if err != nil {
		return nil, err
	}
	return assembleGraph(in), nil
}

// scopeNamespaces dedupes and sorts the selection; an empty selection becomes
// [""], which client-go reads as "all namespaces".
func scopeNamespaces(namespaces []string) []string {
	seen := make(map[string]bool)
	var out []string
	for _, ns := range namespaces {
		if ns != "" && !seen[ns] {
			seen[ns] = true
			out = append(out, ns)
		}
	}
	if len(out) == 0 {
		return []string{""}
	}
	sort.Strings(out)
	return out
}

// listAcross runs one namespaced list per namespace and concatenates the result.
func listAcross[T any](namespaces []string, list func(ns string) ([]T, error)) ([]T, error) {
	var all []T
	for _, ns := range namespaces {
		items, err := list(ns)
		if err != nil {
			return nil, err
		}
		all = append(all, items...)
	}
	return all, nil
}

// fetchGraphInputs lists each kind in its own goroutine. The kinds are
// independent; only the edge assembly needs them together.
func fetchGraphInputs(ctx context.Context, client kubernetes.Interface, meta metadata.Interface, namespaces []string) (*graphInputs, error) {
	in := &graphInputs{allNamespaces: len(namespaces) == 1 && namespaces[0] == "", now: time.Now()}
	opts := metav1.ListOptions{}
	listMeta := func(gvr schema.GroupVersionResource, o metav1.ListOptions) ([]metav1.PartialObjectMetadata, error) {
		return listAcross(namespaces, func(ns string) ([]metav1.PartialObjectMetadata, error) {
			l, err := meta.Resource(gvr).Namespace(ns).List(ctx, o)
			if err != nil {
				return nil, err
			}
			return l.Items, nil
		})
	}
	type fetch struct {
		name string
		kind string // set on optional fetches: a failure becomes a warning
		run  func() error
	}
	fetches := []fetch{
		{"pods", "", func() (err error) {
			in.pods, err = listAcross(namespaces, func(ns string) ([]corev1.Pod, error) {
				l, err := client.CoreV1().Pods(ns).List(ctx, opts)
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"deployments", "", func() (err error) {
			in.deployments, err = listAcross(namespaces, func(ns string) ([]appsv1.Deployment, error) {
				l, err := client.AppsV1().Deployments(ns).List(ctx, opts)
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"replicasets", "", func() (err error) {
			in.replicaSets, err = listAcross(namespaces, func(ns string) ([]appsv1.ReplicaSet, error) {
				l, err := client.AppsV1().ReplicaSets(ns).List(ctx, opts)
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"statefulsets", "", func() (err error) {
			in.statefulSets, err = listAcross(namespaces, func(ns string) ([]appsv1.StatefulSet, error) {
				l, err := client.AppsV1().StatefulSets(ns).List(ctx, opts)
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"daemonsets", "", func() (err error) {
			in.daemonSets, err = listAcross(namespaces, func(ns string) ([]appsv1.DaemonSet, error) {
				l, err := client.AppsV1().DaemonSets(ns).List(ctx, opts)
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"services", "", func() (err error) {
			in.services, err = listAcross(namespaces, func(ns string) ([]corev1.Service, error) {
				l, err := client.CoreV1().Services(ns).List(ctx, opts)
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"ingresses", "", func() (err error) {
			in.ingresses, err = listAcross(namespaces, func(ns string) ([]networkingv1.Ingress, error) {
				l, err := client.NetworkingV1().Ingresses(ns).List(ctx, opts)
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"configmaps", "ConfigMap", func() (err error) {
			in.configMaps, err = listMeta(configMapsGVR, opts)
			return
		}},
		{"secrets", "Secret", func() (err error) {
			in.secrets, err = listMeta(secretsGVR, metav1.ListOptions{FieldSelector: "type!=" + helmReleaseSecretType})
			return
		}},
		{"serviceaccounts", "ServiceAccount", func() (err error) {
			in.serviceAccounts, err = listAcross(namespaces, func(ns string) ([]corev1.ServiceAccount, error) {
				l, err := client.CoreV1().ServiceAccounts(ns).List(ctx, opts)
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"persistentvolumeclaims", "PersistentVolumeClaim", func() (err error) {
			in.pvcs, err = listAcross(namespaces, func(ns string) ([]corev1.PersistentVolumeClaim, error) {
				l, err := client.CoreV1().PersistentVolumeClaims(ns).List(ctx, opts)
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"persistentvolumes", "PersistentVolume", func() error {
			l, err := client.CoreV1().PersistentVolumes().List(ctx, opts)
			if err != nil {
				return err
			}
			in.pvs = l.Items
			return nil
		}},
		// Warning events only: Normal ones (Scheduled, Pulled, Started) are
		// most of the stream and say nothing is wrong.
		{"events", "Event", func() (err error) {
			in.events, err = listAcross(namespaces, func(ns string) ([]corev1.Event, error) {
				l, err := client.CoreV1().Events(ns).List(ctx, metav1.ListOptions{FieldSelector: "type=" + corev1.EventTypeWarning})
				if err != nil {
					return nil, err
				}
				return l.Items, nil
			})
			return
		}},
		{"nodes", "Node", func() error {
			l, err := client.CoreV1().Nodes().List(ctx, opts)
			if err != nil {
				return err
			}
			in.hosts = l.Items
			return nil
		}},
		{"storageclasses", "StorageClass", func() error {
			l, err := client.StorageV1().StorageClasses().List(ctx, opts)
			if err != nil {
				return err
			}
			in.storageClasses = l.Items
			return nil
		}},
	}

	errs := make([]error, len(fetches))
	var wg sync.WaitGroup
	for i, f := range fetches {
		i, f := i, f
		wg.Add(1)
		// Its own defer runs before safego's Recover, so a panicking fetch
		// still releases the WaitGroup.
		safego.Go("services.clustergraph."+f.name, func() {
			defer wg.Done()
			if err := f.run(); err != nil {
				errs[i] = fmt.Errorf("listing %s: %w", f.name, err)
			}
		})
	}
	wg.Wait()

	for i, err := range errs {
		if err == nil {
			continue
		}
		if fetches[i].kind == "" {
			return nil, err
		}
		w := models.GraphWarning{Kind: fetches[i].kind, Reason: "error", Detail: err.Error()}
		if apierrors.IsForbidden(err) {
			w.Reason, w.Detail = "forbidden", ""
		}
		in.warnings = append(in.warnings, w)
	}
	return in, nil
}

// graphBuilder accumulates nodes and not-yet-resolved edges. Edges are kept
// pending until every node exists, because whether an edge is drawn, broken
// or dropped depends on its target.
type graphBuilder struct {
	graph    *models.ClusterGraph
	index    map[string]int // node id -> position in graph.Nodes
	pending  []models.ResourceEdge
	optional map[string]bool // edge id -> its target may legitimately be absent
}

func (b *graphBuilder) node(n models.ResourceNode) {
	if _, ok := b.index[n.ID]; ok {
		return
	}
	if n.Issues == nil {
		n.Issues = []models.GraphIssue{}
	}
	b.index[n.ID] = len(b.graph.Nodes)
	b.graph.Nodes = append(b.graph.Nodes, n)
}

func (b *graphBuilder) edge(edges ...models.ResourceEdge) { b.pending = append(b.pending, edges...) }

func (b *graphBuilder) optionalEdge(e models.ResourceEdge) {
	b.optional[e.ID] = true
	b.pending = append(b.pending, e)
}

// issue records a problem on a node, at most once per code and parameters.
func (b *graphBuilder) issue(id string, is models.GraphIssue) {
	i, ok := b.index[id]
	if !ok {
		return
	}
	n := &b.graph.Nodes[i]
	for _, existing := range n.Issues {
		if existing.Code == is.Code && fmt.Sprint(existing.Params) == fmt.Sprint(is.Params) {
			return
		}
	}
	n.Issues = append(n.Issues, is)
}

func assembleGraph(in *graphInputs) *models.ClusterGraph {
	graph := &models.ClusterGraph{Nodes: []models.ResourceNode{}, Edges: []models.ResourceEdge{}, Warnings: in.warnings, Hosts: graphHosts(in.hosts)}
	if graph.Warnings == nil {
		graph.Warnings = []models.GraphWarning{}
	}
	b := &graphBuilder{graph: graph, index: map[string]int{}, optional: map[string]bool{}}

	for _, p := range in.pods {
		b.node(models.ResourceNode{
			ID: resourceID("Pod", p.Namespace, p.Name), Kind: "Pod",
			Name: p.Name, Namespace: p.Namespace, Labels: p.Labels, Status: string(getPodStatus(p)),
			Details: podDetails(&p),
		})
		for _, ref := range p.OwnerReferences {
			b.edge(ownerEdge(ref.Kind, p.Namespace, ref.Name, "Pod", p.Namespace, p.Name))
		}
		b.podDependencyEdges(&p)
	}

	for _, d := range in.deployments {
		b.node(models.ResourceNode{
			ID: resourceID("Deployment", d.Namespace, d.Name), Kind: "Deployment",
			Name: d.Name, Namespace: d.Namespace, Labels: d.Labels,
			Selector: matchLabels(d.Spec.Selector),
			Status:   fmt.Sprintf("%d/%d", d.Status.ReadyReplicas, d.Status.Replicas),
		})
	}

	for _, rs := range in.replicaSets {
		b.node(models.ResourceNode{
			ID: resourceID("ReplicaSet", rs.Namespace, rs.Name), Kind: "ReplicaSet",
			Name: rs.Name, Namespace: rs.Namespace, Labels: rs.Labels,
			Selector: matchLabels(rs.Spec.Selector),
			Status:   fmt.Sprintf("%d/%d", rs.Status.ReadyReplicas, rs.Status.Replicas),
		})
		for _, ref := range rs.OwnerReferences {
			b.edge(ownerEdge(ref.Kind, rs.Namespace, ref.Name, "ReplicaSet", rs.Namespace, rs.Name))
		}
	}

	for _, ss := range in.statefulSets {
		b.node(models.ResourceNode{
			ID: resourceID("StatefulSet", ss.Namespace, ss.Name), Kind: "StatefulSet",
			Name: ss.Name, Namespace: ss.Namespace, Labels: ss.Labels,
			Selector: matchLabels(ss.Spec.Selector),
			Status:   fmt.Sprintf("%d/%d", ss.Status.ReadyReplicas, ss.Status.Replicas),
		})
	}

	for _, ds := range in.daemonSets {
		b.node(models.ResourceNode{
			ID: resourceID("DaemonSet", ds.Namespace, ds.Name), Kind: "DaemonSet",
			Name: ds.Name, Namespace: ds.Namespace, Labels: ds.Labels,
			Selector: matchLabels(ds.Spec.Selector),
			Status:   fmt.Sprintf("%d ready", ds.Status.NumberReady),
		})
	}

	for i := range in.services {
		svc := &in.services[i]
		b.node(models.ResourceNode{
			ID: resourceID("Service", svc.Namespace, svc.Name), Kind: "Service",
			Name: svc.Name, Namespace: svc.Namespace, Labels: svc.Labels,
			Selector: svc.Spec.Selector, Status: string(svc.Spec.Type),
		})
		b.edge(selectorEdges(svc, in.pods)...)
	}

	for _, ing := range in.ingresses {
		b.node(models.ResourceNode{
			ID: resourceID("Ingress", ing.Namespace, ing.Name), Kind: "Ingress",
			Name: ing.Name, Namespace: ing.Namespace, Labels: ing.Labels,
		})
		b.edge(ingressEdges(ing.Namespace, ing.Name, ing.Spec)...)
		for _, tls := range ing.Spec.TLS {
			if tls.SecretName != "" {
				e := dependencyEdge("config",
					resourceID("Ingress", ing.Namespace, ing.Name), resourceID("Secret", ing.Namespace, tls.SecretName))
				e.Label = "tls"
				b.edge(e)
			}
		}
	}

	b.assembleConfig(in)
	b.assembleStorage(in)

	b.resolveEdges(checkableKinds(in))
	b.applyHealth(in)
	return graph
}

// podDependencyEdges: the pod's service account, and every ConfigMap, Secret
// and claim its spec names (podReferences, shared with the Pod Detail panel),
// labelled with how the pod uses it.
func (b *graphBuilder) podDependencyEdges(p *corev1.Pod) {
	src := resourceID("Pod", p.Namespace, p.Name)
	if sa := p.Spec.ServiceAccountName; sa != "" {
		b.edge(dependencyEdge("config", src, resourceID("ServiceAccount", p.Namespace, sa)))
	}
	refs := podReferences(p)
	for _, kind := range []string{"ConfigMap", "Secret", "PersistentVolumeClaim"} {
		edgeKind := "config"
		if kind == "PersistentVolumeClaim" {
			edgeKind = "storage"
		}
		for _, r := range refs.sorted(kind) {
			e := dependencyEdge(edgeKind, src, resourceID(kind, r.Namespace, r.Name))
			e.Label = capLabel(refs.uses(kind, r.Name))
			if refs.optional(kind, r.Name) {
				b.optionalEdge(e)
			} else {
				b.edge(e)
			}
		}
	}
}

func (b *graphBuilder) assembleConfig(in *graphInputs) {
	for _, cm := range in.configMaps {
		if cm.Name == kubeRootCA {
			continue
		}
		b.node(models.ResourceNode{
			ID: resourceID("ConfigMap", cm.Namespace, cm.Name), Kind: "ConfigMap",
			Name: cm.Name, Namespace: cm.Namespace, Labels: cm.Labels,
		})
	}
	for _, sec := range in.secrets {
		// The field selector already excludes these; a server or fake that
		// ignores field selectors on a metadata list must not bring them back.
		if sec.Labels["owner"] == "helm" && strings.HasPrefix(sec.Name, "sh.helm.release.v1.") {
			continue
		}
		b.node(models.ResourceNode{
			ID: resourceID("Secret", sec.Namespace, sec.Name), Kind: "Secret",
			Name: sec.Name, Namespace: sec.Namespace, Labels: sec.Labels,
		})
	}
	for _, sa := range in.serviceAccounts {
		src := resourceID("ServiceAccount", sa.Namespace, sa.Name)
		b.node(models.ResourceNode{
			ID: src, Kind: "ServiceAccount", Name: sa.Name, Namespace: sa.Namespace, Labels: sa.Labels,
		})
		// Both lists are tolerated when stale: a token Secret may have been
		// cleaned up, and a missing pull secret only means anonymous pulls.
		for _, s := range sa.Secrets {
			b.optionalEdge(dependencyEdge("config", src, resourceID("Secret", sa.Namespace, s.Name)))
		}
		for _, s := range sa.ImagePullSecrets {
			e := dependencyEdge("config", src, resourceID("Secret", sa.Namespace, s.Name))
			e.Label = "imagePull"
			b.optionalEdge(e)
		}
	}
}

// assembleStorage draws PVC → PV and PVC → StorageClass. PVs and StorageClasses
// are cluster-scoped, so with a namespace selection only the ones a listed
// PVC reaches are drawn; otherwise a one-namespace graph would carry every
// volume in the cluster.
func (b *graphBuilder) assembleStorage(in *graphInputs) {
	wantPV := map[string]bool{}
	wantSC := map[string]bool{}
	for _, pvc := range in.pvcs {
		src := resourceID("PersistentVolumeClaim", pvc.Namespace, pvc.Name)
		b.node(models.ResourceNode{
			ID: src, Kind: "PersistentVolumeClaim", Name: pvc.Name, Namespace: pvc.Namespace,
			Labels: pvc.Labels, Status: pvcStatus(&pvc),
		})
		if v := pvc.Spec.VolumeName; v != "" {
			wantPV[v] = true
			b.edge(dependencyEdge("storage", src, resourceID("PersistentVolume", "", v)))
		}
		if sc := pvc.Spec.StorageClassName; sc != nil && *sc != "" {
			wantSC[*sc] = true
			b.edge(dependencyEdge("storage", src, resourceID("StorageClass", "", *sc)))
		}
	}
	for _, pv := range in.pvs {
		if !in.allNamespaces && !wantPV[pv.Name] {
			continue
		}
		b.node(models.ResourceNode{
			ID: resourceID("PersistentVolume", "", pv.Name), Kind: "PersistentVolume",
			Name: pv.Name, Labels: pv.Labels, Status: string(pv.Status.Phase),
			Details: map[string]string{"reclaimPolicy": string(pv.Spec.PersistentVolumeReclaimPolicy)},
		})
	}
	for _, sc := range in.storageClasses {
		if !in.allNamespaces && !wantSC[sc.Name] {
			continue
		}
		status := ""
		if sc.Annotations["storageclass.kubernetes.io/is-default-class"] == "true" {
			status = "default"
		}
		b.node(models.ResourceNode{
			ID: resourceID("StorageClass", "", sc.Name), Kind: "StorageClass",
			Name: sc.Name, Labels: sc.Labels, Status: status,
		})
	}
}

// pvcStatus is the phase, with the bound capacity once there is one.
func pvcStatus(pvc *corev1.PersistentVolumeClaim) string {
	phase := string(pvc.Status.Phase)
	if q, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok && pvc.Status.Phase == corev1.ClaimBound {
		return phase + " · " + q.String()
	}
	return phase
}

// podDetails: the container restart count (init and regular, as the Pods list
// counts it), so the graph can tell a pod that just restarted again. Absent
// while it is zero.
func podDetails(p *corev1.Pod) map[string]string {
	var restarts int32
	for _, cs := range p.Status.InitContainerStatuses {
		restarts += cs.RestartCount
	}
	for _, cs := range p.Status.ContainerStatuses {
		restarts += cs.RestartCount
	}
	d := map[string]string{}
	if restarts > 0 {
		d["restarts"] = fmt.Sprint(restarts)
	}
	if p.Spec.NodeName != "" {
		d["node"] = p.Spec.NodeName
	}
	if len(d) == 0 {
		return nil
	}
	return d
}

// hostConditionIssue: the Node conditions that say something is wrong when
// they are true. Ready is the other way round and handled on its own.
var hostConditionIssue = map[corev1.NodeConditionType]string{
	corev1.NodeMemoryPressure:     "memoryPressure",
	corev1.NodeDiskPressure:       "diskPressure",
	corev1.NodePIDPressure:        "pidPressure",
	corev1.NodeNetworkUnavailable: "networkUnavailable",
}

// graphHosts: each Node with its readiness and what is wrong with it, sorted
// by name. A NotReady node is an error; a pressure condition or a cordon is
// a warning.
func graphHosts(nodes []corev1.Node) []models.GraphHost {
	out := make([]models.GraphHost, 0, len(nodes))
	for _, n := range nodes {
		h := models.GraphHost{Name: n.Name, Issues: []models.GraphIssue{}}
		for _, c := range n.Status.Conditions {
			if c.Type == corev1.NodeReady {
				h.Ready = c.Status == corev1.ConditionTrue
				continue
			}
			if code, ok := hostConditionIssue[c.Type]; ok && c.Status == corev1.ConditionTrue {
				h.Issues = append(h.Issues, models.GraphIssue{Level: levelWarn, Code: "host." + code})
			}
		}
		if !h.Ready {
			h.Issues = append([]models.GraphIssue{{Level: levelErr, Code: "host.notReady"}}, h.Issues...)
		}
		if n.Spec.Unschedulable {
			h.Issues = append(h.Issues, models.GraphIssue{Level: levelWarn, Code: "host.cordoned"})
		}
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func dependencyEdge(kind, src, tgt string) models.ResourceEdge {
	return models.ResourceEdge{ID: src + "->" + tgt, Source: src, Target: tgt, Kind: kind}
}

// selectorEdges links a Service to the pods its selector matches, labelled
// with the Service's port mapping.
func selectorEdges(svc *corev1.Service, pods []corev1.Pod) []models.ResourceEdge {
	if len(svc.Spec.Selector) == 0 {
		return nil
	}
	src := resourceID("Service", svc.Namespace, svc.Name)
	var ports []string
	for _, p := range svc.Spec.Ports {
		target := p.TargetPort.String()
		if p.TargetPort.IntValue() == 0 && p.TargetPort.StrVal == "" {
			target = fmt.Sprint(p.Port) // an unset targetPort defaults to port
		}
		ports = append(ports, fmt.Sprintf("%d→%s", p.Port, target))
	}
	label := capLabel(ports)
	var edges []models.ResourceEdge
	for _, p := range pods {
		if p.Namespace == svc.Namespace && labelsContain(p.Labels, svc.Spec.Selector) {
			tgt := resourceID("Pod", p.Namespace, p.Name)
			edges = append(edges, models.ResourceEdge{ID: src + "->" + tgt, Source: src, Target: tgt, Kind: "selector", Label: label})
		}
	}
	return edges
}

// ingressEdges links an Ingress to every Service it routes to: each rule path
// and the spec-level default backend, each labelled host/path.
func ingressEdges(namespace, ingName string, spec networkingv1.IngressSpec) []models.ResourceEdge {
	src := resourceID("Ingress", namespace, ingName)
	var edges []models.ResourceEdge
	add := func(b *networkingv1.IngressServiceBackend, label string) {
		if b == nil {
			return
		}
		tgt := resourceID("Service", namespace, b.Name)
		edges = append(edges, models.ResourceEdge{ID: src + "->" + tgt, Source: src, Target: tgt, Kind: "ingress", Label: label})
	}
	if spec.DefaultBackend != nil {
		add(spec.DefaultBackend.Service, "default")
	}
	for _, rule := range spec.Rules {
		if rule.HTTP == nil {
			continue
		}
		for _, path := range rule.HTTP.Paths {
			host := rule.Host
			if host == "" {
				host = "*"
			}
			add(path.Backend.Service, host+path.Path)
		}
	}
	return edges
}

// labelLimit: an edge label names at most this many uses, then "+N".
const labelLimit = 2

func capLabel(parts []string) string {
	if len(parts) <= labelLimit {
		return strings.Join(parts, ", ")
	}
	return fmt.Sprintf("%s +%d", strings.Join(parts[:labelLimit], ", "), len(parts)-labelLimit)
}

// missingCheckedEdges: the edge kinds whose target, when absent, is a fault
// worth drawing. An owner outside the listed kinds (a Job, a CronJob) is not.
var missingCheckedEdges = map[string]bool{"config": true, "storage": true, "ingress": true}

// checkableKinds: kinds whose absence can be trusted — every one that was
// listed. A kind the user may not list says nothing about what exists.
func checkableKinds(in *graphInputs) map[string]bool {
	kinds := map[string]bool{"Service": true, "ConfigMap": true, "Secret": true, "ServiceAccount": true,
		"PersistentVolumeClaim": true, "PersistentVolume": true, "StorageClass": true}
	for _, w := range in.warnings {
		delete(kinds, w.Kind)
	}
	return kinds
}

var kindByLower = func() map[string]string {
	m := map[string]string{}
	for _, k := range []string{"Pod", "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Service", "Ingress",
		"ConfigMap", "Secret", "ServiceAccount", "PersistentVolumeClaim", "PersistentVolume", "StorageClass"} {
		m[strings.ToLower(k)] = k
	}
	return m
}()

// parseResourceID splits a resourceID; names and namespaces cannot hold "/".
func parseResourceID(id string) (kind, namespace, name string, ok bool) {
	parts := strings.SplitN(id, "/", 3)
	if len(parts) != 3 {
		return "", "", "", false
	}
	kind, ok = kindByLower[parts[0]]
	return kind, parts[1], parts[2], ok
}

// resolveEdges turns the pending edges into the graph's: duplicates merge
// their labels, an edge from an object that is not drawn is dropped, and an
// edge to one that does not exist either becomes a broken edge to a
// placeholder (missingCheckedEdges, checkable kinds) or is dropped — an owner
// outside the selected namespaces, the deliberately filtered kube-root-ca.crt.
func (b *graphBuilder) resolveEdges(checkable map[string]bool) {
	missing := map[string]bool{}
	at := map[string]int{}          // edge id -> position in graph.Edges
	labels := map[string][]string{} // edge id -> label parts, merged
	for _, e := range b.pending {
		if _, ok := b.index[e.Source]; !ok {
			continue
		}
		if _, exists := b.index[e.Target]; !exists || missing[e.Target] {
			kind, ns, name, ok := parseResourceID(e.Target)
			if !ok || !missingCheckedEdges[e.Kind] || !checkable[kind] || (kind == "ConfigMap" && name == kubeRootCA) {
				continue
			}
			level, code := "err", "missingRef"
			if b.optional[e.ID] {
				level, code = "warn", "optionalRefMissing"
			}
			if !exists {
				missing[e.Target] = true
				b.node(models.ResourceNode{ID: e.Target, Kind: kind, Name: name, Namespace: ns, Missing: true})
			}
			params := map[string]string{"kind": kind, "name": name}
			b.issue(e.Target, models.GraphIssue{Level: level, Code: "notFound"})
			b.issue(e.Source, models.GraphIssue{Level: level, Code: code, Params: params})
			e.Issue = &models.GraphIssue{Level: level, Code: code, Params: params}
		}
		if i, ok := at[e.ID]; ok {
			if e.Label != "" {
				labels[e.ID] = appendUnique(labels[e.ID], e.Label)
			}
			if worse(e.Issue, b.graph.Edges[i].Issue) {
				b.graph.Edges[i].Issue = e.Issue
			}
			continue
		}
		at[e.ID] = len(b.graph.Edges)
		e.Optional = b.optional[e.ID]
		if e.Label != "" {
			labels[e.ID] = []string{e.Label}
		}
		b.graph.Edges = append(b.graph.Edges, e)
	}
	for id, parts := range labels {
		b.graph.Edges[at[id]].Label = capLabel(parts)
	}
	// A placeholder referenced only optionally is a warning; once any
	// reference requires it, its single notFound issue is the error one.
	for id := range missing {
		n := &b.graph.Nodes[b.index[id]]
		n.Issues = []models.GraphIssue{worstIssue(n.Issues)}
	}
}

func appendUnique(parts []string, p string) []string {
	for _, existing := range parts {
		if existing == p {
			return parts
		}
	}
	return append(parts, p)
}

func ownerEdge(srcKind, srcNS, srcName, tgtKind, tgtNS, tgtName string) models.ResourceEdge {
	src := resourceID(srcKind, srcNS, srcName)
	tgt := resourceID(tgtKind, tgtNS, tgtName)
	return models.ResourceEdge{ID: src + "->" + tgt, Source: src, Target: tgt, Kind: "owner"}
}

func resourceID(kind, namespace, name string) string {
	return strings.ToLower(kind) + "/" + namespace + "/" + name
}

func matchLabels(selector *metav1.LabelSelector) map[string]string {
	if selector == nil {
		return nil
	}
	return selector.MatchLabels
}

func labelsContain(labels, selector map[string]string) bool {
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}
