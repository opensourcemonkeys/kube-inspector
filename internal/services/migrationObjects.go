package services_k8sclient

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"kube-ins/internal/models"
)

const (
	// migrationLabel marks what a migration in progress created on the target,
	// so a retry does not take its own half-finished objects for conflicts. It
	// is removed by the final apply: left behind, a later migration would take
	// a production disk for a half-finished one of its own.
	migrationLabel = "kube-ins/migration"
	// moverLabel marks the temporary workers, which are all a cleanup deletes.
	moverLabel = "kube-ins/mover"

	// These record on a stopped source workload what it was, so it can be
	// started again from any machine, whatever happened to the local record.
	migrationReplicasAnnotation  = "kube-ins/migration-replicas"
	migrationSuspendedAnnotation = "kube-ins/migration-suspended"
)

// Why an object is not carried over, as codes the frontend translates.
const (
	MigrationSkipGenerated     = "generated"
	MigrationSkipOwned         = "owned"
	MigrationSkipStandaloneJob = "standaloneJob"
	MigrationSkipServiceToken  = "serviceAccountToken"
	MigrationSkipClusterLocal  = "clusterLocal"
	MigrationSkipNoCRD         = "noCrd"
	MigrationSkipUserChoice    = "userChoice"
)

// MigrationCluster is one side of a migration.
type MigrationCluster struct {
	Name   string
	Client kubernetes.Interface
	Dyn    dynamic.Interface
	Disc   discovery.DiscoveryInterface
	Mapper meta.RESTMapper
	// resources replaces discovery in tests: the fake discovery client does
	// not implement the preferred-version call.
	resources func() ([]migrationResource, error)
}

type migrationResource struct {
	GVR  schema.GroupVersionResource
	Kind string
}

// namespacedResources lists what can be listed and created in a namespace. A
// partial answer (an aggregated API that is down) is returned with its error.
func (c MigrationCluster) namespacedResources() ([]migrationResource, error) {
	if c.resources != nil {
		return c.resources()
	}
	lists, err := discovery.ServerPreferredNamespacedResources(c.Disc)
	if err != nil && !discovery.IsGroupDiscoveryFailedError(err) {
		return nil, err
	}
	var out []migrationResource
	for _, list := range lists {
		gv, perr := schema.ParseGroupVersion(list.GroupVersion)
		if perr != nil {
			continue
		}
		for _, r := range list.APIResources {
			if strings.Contains(r.Name, "/") || !hasVerbs(r.Verbs, "list", "create") {
				continue
			}
			out = append(out, migrationResource{GVR: gv.WithResource(r.Name), Kind: r.Kind})
		}
	}
	return out, err
}

func hasVerbs(have metav1.Verbs, want ...string) bool {
	for _, w := range want {
		found := false
		for _, h := range have {
			found = found || h == w
		}
		if !found {
			return false
		}
	}
	return true
}

// migrationSkipReason says why an object is not carried over, "" when it is:
// what the cluster generates, what a controller owns (its owner recreates it),
// and what only means something on this cluster.
func migrationSkipReason(u *unstructured.Unstructured) string {
	gk := u.GroupVersionKind().GroupKind()
	if u.GetLabels()[moverLabel] != "" {
		return MigrationSkipGenerated
	}
	switch gk {
	case schema.GroupKind{Kind: "Pod"},
		schema.GroupKind{Group: "apps", Kind: "ReplicaSet"},
		schema.GroupKind{Group: "apps", Kind: "ControllerRevision"},
		schema.GroupKind{Kind: "Endpoints"},
		schema.GroupKind{Group: "discovery.k8s.io", Kind: "EndpointSlice"},
		schema.GroupKind{Kind: "Event"},
		schema.GroupKind{Group: "events.k8s.io", Kind: "Event"},
		schema.GroupKind{Group: "coordination.k8s.io", Kind: "Lease"}:
		return MigrationSkipGenerated
	}
	if gk == (schema.GroupKind{Kind: "ConfigMap"}) && u.GetName() == "kube-root-ca.crt" {
		return MigrationSkipGenerated
	}
	if len(u.GetOwnerReferences()) > 0 {
		return MigrationSkipOwned
	}
	if gk.Group == "metrics.k8s.io" || gk.Group == "snapshot.storage.k8s.io" {
		return MigrationSkipClusterLocal
	}
	if gk == (schema.GroupKind{Group: "batch", Kind: "Job"}) {
		return MigrationSkipStandaloneJob
	}
	if gk == (schema.GroupKind{Kind: "Secret"}) {
		if t, _, _ := unstructured.NestedString(u.Object, "type"); t == "kubernetes.io/service-account-token" {
			return MigrationSkipServiceToken
		}
	}
	return ""
}

// migratable is an object in the form the target should receive: restorable,
// minus everything the source cluster assigned to it. The input is not changed.
func migratable(src *unstructured.Unstructured, classes map[string]string) *unstructured.Unstructured {
	u := src.DeepCopy()
	size := migrationClaimSize(u)
	restorable(u.Object)
	// A controller adds its finalizer again where it runs. Copied to a cluster
	// without that controller, the object could never be deleted.
	unstructured.RemoveNestedField(u.Object, "metadata", "finalizers")

	switch u.GroupVersionKind().GroupKind() {
	case schema.GroupKind{Kind: "Service"}:
		if ip, _, _ := unstructured.NestedString(u.Object, "spec", "clusterIP"); ip != "None" {
			unstructured.RemoveNestedField(u.Object, "spec", "clusterIP")
			unstructured.RemoveNestedField(u.Object, "spec", "clusterIPs")
		}
		unstructured.RemoveNestedField(u.Object, "spec", "healthCheckNodePort")
		if ports, ok, _ := unstructured.NestedSlice(u.Object, "spec", "ports"); ok {
			for _, p := range ports {
				if m, ok := p.(map[string]any); ok {
					delete(m, "nodePort")
				}
			}
			_ = unstructured.SetNestedSlice(u.Object, ports, "spec", "ports")
		}
	case schema.GroupKind{Kind: "PersistentVolumeClaim"}:
		unstructured.RemoveNestedField(u.Object, "spec", "volumeName")
		unstructured.RemoveNestedField(u.Object, "spec", "dataSource")
		unstructured.RemoveNestedField(u.Object, "spec", "dataSourceRef")
		dropAnnotations(u, func(k string) bool {
			return strings.HasPrefix(k, "pv.kubernetes.io/") || strings.HasPrefix(k, "volume.kubernetes.io/") ||
				strings.HasPrefix(k, "volume.beta.kubernetes.io/")
		})
		class, _, _ := unstructured.NestedString(u.Object, "spec", "storageClassName")
		if mapped, ok := classes[class]; ok {
			if mapped == "" {
				unstructured.RemoveNestedField(u.Object, "spec", "storageClassName")
			} else {
				_ = unstructured.SetNestedField(u.Object, mapped, "spec", "storageClassName")
			}
		}
		if size != "" {
			_ = unstructured.SetNestedField(u.Object, size, "spec", "resources", "requests", "storage")
		}
	case schema.GroupKind{Kind: "ServiceAccount"}:
		unstructured.RemoveNestedField(u.Object, "secrets")
	case schema.GroupKind{Group: "apps", Kind: "Deployment"}:
		dropAnnotations(u, func(k string) bool { return k == "deployment.kubernetes.io/revision" })
	}
	return u
}

// migrationClaimSize is the larger of what a claim asked for and what it got:
// a volume that was expanded holds more than its original request.
func migrationClaimSize(u *unstructured.Unstructured) string {
	if u.GroupVersionKind().GroupKind() != (schema.GroupKind{Kind: "PersistentVolumeClaim"}) {
		return ""
	}
	req, _, _ := unstructured.NestedString(u.Object, "spec", "resources", "requests", "storage")
	got, _, _ := unstructured.NestedString(u.Object, "status", "capacity", "storage")
	if got == "" {
		return req
	}
	r, rerr := resource.ParseQuantity(req)
	g, gerr := resource.ParseQuantity(got)
	if rerr != nil || (gerr == nil && g.Cmp(r) > 0) {
		return got
	}
	return req
}

func dropAnnotations(u *unstructured.Unstructured, drop func(string) bool) {
	a := u.GetAnnotations()
	for k := range a {
		if drop(k) {
			delete(a, k)
		}
	}
	u.SetAnnotations(a)
}

func addLabel(u *unstructured.Unstructured, key, value string) {
	l := u.GetLabels()
	if l == nil {
		l = map[string]string{}
	}
	l[key] = value
	u.SetLabels(l)
}

func isScaledWorkload(u *unstructured.Unstructured) bool {
	gk := u.GroupVersionKind().GroupKind()
	return gk == schema.GroupKind{Group: "apps", Kind: "Deployment"} || gk == schema.GroupKind{Group: "apps", Kind: "StatefulSet"}
}

func isCronJob(u *unstructured.Unstructured) bool {
	return u.GroupVersionKind().GroupKind() == schema.GroupKind{Group: "batch", Kind: "CronJob"}
}

func isDaemonSet(u *unstructured.Unstructured) bool {
	return u.GroupVersionKind().GroupKind() == schema.GroupKind{Group: "apps", Kind: "DaemonSet"}
}

func isClaim(u *unstructured.Unstructured) bool {
	return u.GroupVersionKind().GroupKind() == schema.GroupKind{Kind: "PersistentVolumeClaim"}
}

// shapeForPrepare holds an object back: created on the target but not running,
// so a rejected manifest shows up before anything on the source has stopped.
func shapeForPrepare(u *unstructured.Unstructured, id string) {
	addLabel(u, migrationLabel, id)
	if isScaledWorkload(u) {
		_ = unstructured.SetNestedField(u.Object, int64(0), "spec", "replicas")
	}
	if isCronJob(u) {
		_ = unstructured.SetNestedField(u.Object, true, "spec", "suspend")
	}
}

// shapeForFinal gives an object what it had on the source before the
// migration stopped it. Its migration label is absent, so the server-side apply
// removes it from the target.
func shapeForFinal(u *unstructured.Unstructured, rec *models.MigrationRecord) {
	if isScaledWorkload(u) {
		for _, w := range rec.Workloads {
			if w.Kind == u.GetKind() && w.Namespace == u.GetNamespace() && w.Name == u.GetName() {
				_ = unstructured.SetNestedField(u.Object, int64(w.Replicas), "spec", "replicas")
			}
		}
	}
	if isCronJob(u) {
		for _, c := range rec.CronJobs {
			if c.Namespace == u.GetNamespace() && c.Name == u.GetName() {
				_ = unstructured.SetNestedField(u.Object, c.WasSuspended, "spec", "suspend")
			}
		}
	}
}

func migrationApplyRank(kind string) int {
	switch kind {
	case "Namespace":
		return 0
	case "ServiceAccount", "ResourceQuota", "LimitRange":
		return 1
	case "Role":
		return 2
	case "RoleBinding":
		return 3
	case "ConfigMap", "Secret":
		return 4
	case "PersistentVolumeClaim":
		return 5
	case "Service":
		return 6
	case "Deployment", "StatefulSet", "DaemonSet", "CronJob":
		return 7
	}
	return 8
}

// sortForApply puts what others refer to first.
func sortForApply(objs []*unstructured.Unstructured) {
	sort.SliceStable(objs, func(i, j int) bool {
		ri, rj := migrationApplyRank(objs[i].GetKind()), migrationApplyRank(objs[j].GetKind())
		if ri != rj {
			return ri < rj
		}
		if objs[i].GetNamespace() != objs[j].GetNamespace() {
			return objs[i].GetNamespace() < objs[j].GetNamespace()
		}
		return objs[i].GetName() < objs[j].GetName()
	})
}

// migrationKey identifies an object in Decisions.
func migrationKey(u *unstructured.Unstructured) string {
	gvk := u.GroupVersionKind()
	return gvk.Group + "/" + gvk.Kind + "/" + u.GetNamespace() + "/" + u.GetName()
}

// collected is the content of the migrated namespaces, sorted out.
type collectedObjects struct {
	Keep    []*unstructured.Unstructured
	Skipped []models.MigrationSkipped
	Issues  []models.MigrationIssue
}

// collectMigrationObjects reads every object of the namespaces. A resource the
// user may not list is a warning: the rest can still move.
func collectMigrationObjects(ctx context.Context, src MigrationCluster, namespaces []string) (collectedObjects, error) {
	var out collectedObjects
	resources, err := src.namespacedResources()
	if err != nil {
		if !discovery.IsGroupDiscoveryFailedError(err) {
			return out, fmt.Errorf("discover resources of %s: %w", src.Name, err)
		}
		out.Issues = append(out.Issues, models.MigrationIssue{Code: "discoveryPartial", Detail: err.Error()})
	}
	for _, ns := range namespaces {
		for _, r := range resources {
			list, err := src.Dyn.Resource(r.GVR).Namespace(ns).List(ctx, metav1.ListOptions{})
			if err != nil {
				if apierrors.IsForbidden(err) || apierrors.IsMethodNotSupported(err) || apierrors.IsNotFound(err) {
					out.Issues = append(out.Issues, models.MigrationIssue{Code: "listForbidden", Namespace: ns, Name: r.GVR.Resource, Detail: err.Error()})
					continue
				}
				return out, fmt.Errorf("list %s in %s: %w", r.GVR.Resource, ns, err)
			}
			for i := range list.Items {
				u := &list.Items[i]
				if reason := migrationSkipReason(u); reason != "" {
					out.Skipped = append(out.Skipped, models.MigrationSkipped{Kind: u.GetKind(), Namespace: ns, Name: u.GetName(), Reason: reason})
					continue
				}
				out.Keep = append(out.Keep, u)
			}
		}
	}
	return out, nil
}

// applyObject writes an object with server-side apply, or dry-runs it.
func (c MigrationCluster) applyObject(ctx context.Context, u *unstructured.Unstructured, dryRun bool) error {
	target, _, err := applyTarget(c.Dyn, c.Mapper, u)
	if err != nil {
		return err
	}
	_, err = target.Apply(ctx, u.GetName(), u, applyOptions(dryRun))
	if err != nil {
		return fmt.Errorf("%s %s/%s: %w", u.GetKind(), u.GetNamespace(), u.GetName(), err)
	}
	return nil
}

// NewMigrationCluster builds one side of a migration from its client and config.
func NewMigrationCluster(name string, client kubernetes.Interface, config *rest.Config) (MigrationCluster, error) {
	dyn, mapper, err := newDynamicAndMapper(config)
	if err != nil {
		return MigrationCluster{}, fmt.Errorf("connect to %s: %w", name, err)
	}
	disc, err := discovery.NewDiscoveryClientForConfig(config)
	if err != nil {
		return MigrationCluster{}, fmt.Errorf("connect to %s: %w", name, err)
	}
	return MigrationCluster{Name: name, Client: client, Dyn: dyn, Disc: disc, Mapper: mapper}, nil
}

// CleanupMigrationWorkers removes the workers of a migration from both clusters.
func CleanupMigrationWorkers(ctx context.Context, src, dst MigrationCluster, rec *models.MigrationRecord) error {
	return errors.Join(deleteMoverObjects(ctx, src, rec), deleteMoverObjects(ctx, dst, rec))
}
