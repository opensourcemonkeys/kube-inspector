package services_k8sclient

import (
	"context"
	"errors"
	"fmt"
	"sort"

	authv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/yaml"

	"kube-ins/internal/models"
)

const (
	migrationDecisionOverwrite = "overwrite"
	migrationDefaultClassAnno  = "storageclass.kubernetes.io/is-default-class"
	migrationPodSecurityLabel  = "pod-security.kubernetes.io/enforce"
)

var migrationSystemNamespaces = map[string]bool{"kube-system": true, "kube-public": true, "kube-node-lease": true}

// planMigrationObjects is what a migration carries over from the namespaces:
// everything that is not skipped and whose kind the target knows.
func planMigrationObjects(ctx context.Context, src, dst MigrationCluster, namespaces []string) (collectedObjects, []models.MigrationMissing, error) {
	col, err := collectMigrationObjects(ctx, src, namespaces)
	if err != nil {
		return col, nil, err
	}
	var missing []models.MigrationMissing
	kept := make([]*unstructured.Unstructured, 0, len(col.Keep))
	for _, u := range col.Keep {
		gvk := u.GroupVersionKind()
		if _, err := dst.Mapper.RESTMapping(gvk.GroupKind(), gvk.Version); meta.IsNoMatchError(err) {
			missing = append(missing, models.MigrationMissing{Kind: "CustomResourceDefinition", Name: gvk.GroupKind().String(), UsedBy: u.GetNamespace() + "/" + u.GetName()})
			col.Skipped = append(col.Skipped, models.MigrationSkipped{Kind: u.GetKind(), Namespace: u.GetNamespace(), Name: u.GetName(), Reason: MigrationSkipNoCRD})
			continue
		}
		kept = append(kept, u)
	}
	col.Keep = kept
	return col, missing, nil
}

// RunMigrationPreflight says what a migration would do and what stands in its
// way. It writes nothing to either cluster.
func RunMigrationPreflight(ctx context.Context, src, dst MigrationCluster, req models.MigrationRequest) (models.MigrationPreflight, error) {
	out := models.MigrationPreflight{Objects: []models.MigrationObject{}, Disks: []models.MigrationDisk{}, Conflicts: []models.MigrationConflict{},
		Issues: []models.MigrationIssue{}, Skipped: []models.MigrationSkipped{}, Missing: []models.MigrationMissing{}, TargetClasses: []string{}}
	if req.Source == "" || req.Target == "" || req.Source == req.Target {
		return out, errors.New("choose two different clusters")
	}
	if len(req.Namespaces) == 0 {
		return out, errors.New("choose at least one namespace")
	}

	targetHasNS := map[string]bool{}
	var namespaces []string
	for _, ns := range req.Namespaces {
		if migrationSystemNamespaces[ns] {
			out.Issues = append(out.Issues, models.MigrationIssue{Code: "systemNamespace", Blocker: true, Namespace: ns})
			continue
		}
		live, err := src.Client.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			out.Issues = append(out.Issues, models.MigrationIssue{Code: "namespaceMissing", Blocker: true, Namespace: ns})
			continue
		}
		if err != nil {
			return out, fmt.Errorf("read namespace %s: %w", ns, err)
		}
		namespaces = append(namespaces, ns)
		restricted := live.Labels[migrationPodSecurityLabel] == "restricted"

		remote, err := dst.Client.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{})
		switch {
		case err == nil:
			targetHasNS[ns] = true
			restricted = restricted || remote.Labels[migrationPodSecurityLabel] == "restricted"
		case !apierrors.IsNotFound(err):
			return out, fmt.Errorf("read namespace %s on %s: %w", ns, dst.Name, err)
		}
		if restricted {
			out.Issues = append(out.Issues, models.MigrationIssue{Code: "podSecurityRestricted", Blocker: true, Namespace: ns})
		}
	}

	col, missing, err := planMigrationObjects(ctx, src, dst, namespaces)
	if err != nil {
		return out, err
	}
	out.Issues = append(out.Issues, col.Issues...)
	out.Skipped = append(out.Skipped, col.Skipped...)
	out.Missing = append(out.Missing, missing...)
	for _, u := range col.Keep {
		out.Objects = append(out.Objects, models.MigrationObject{Kind: u.GetKind(), Namespace: u.GetNamespace(), Name: u.GetName()})
	}

	conflicting := map[string]bool{}
	for _, u := range col.Keep {
		if !targetHasNS[u.GetNamespace()] {
			continue
		}
		c, err := migrationConflict(ctx, dst, u, req.StorageClasses)
		if err != nil {
			return out, err
		}
		if c != nil {
			out.Conflicts = append(out.Conflicts, *c)
			conflicting[c.Key] = true
		}
	}

	classes, defaultClass, err := targetStorageClasses(ctx, dst)
	if err != nil {
		return out, err
	}
	out.TargetClasses = classes

	pods := map[string][]corev1.Pod{}
	for _, ns := range namespaces {
		list, err := src.Client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return out, fmt.Errorf("list pods in %s: %w", ns, err)
		}
		pods[ns] = list.Items
	}

	for _, u := range col.Keep {
		if !isClaim(u) {
			continue
		}
		d := migrationDiskFor(u, req.StorageClasses, classes, defaultClass, conflicting[migrationKey(u)])
		phase, _, _ := unstructured.NestedString(u.Object, "status", "phase")
		if phase != string(corev1.ClaimBound) {
			d.Copy = false
			out.Issues = append(out.Issues, models.MigrationIssue{Code: "diskNotBound", Namespace: d.Namespace, Name: d.Name, Detail: phase})
		}
		if !conflicting[migrationKey(u)] && !containsString(classes, d.TargetClass) {
			out.Issues = append(out.Issues, models.MigrationIssue{Code: "storageClassMissing", Blocker: true, Namespace: d.Namespace, Name: d.Name, Detail: d.TargetClass})
		}
		if d.Copy {
			inUse := false
			for i := range pods[d.Namespace] {
				p := &pods[d.Namespace][i]
				if p.Labels[moverLabel] != "" || !podIsActive(p) || !podMountsClaim(p, d.Name) {
					continue
				}
				inUse = true
				owner, err := unstoppableOwner(ctx, src, p)
				if err != nil {
					return out, err
				}
				if owner != "" {
					out.Issues = append(out.Issues, models.MigrationIssue{Code: "unstoppableWriter", Blocker: true, Namespace: d.Namespace, Name: p.Name, Detail: owner})
				}
			}
			if inUse && containsString(d.AccessModes, string(corev1.ReadWriteOncePod)) {
				d.LiveCopy = false
				out.Issues = append(out.Issues, models.MigrationIssue{Code: "rwopDisk", Namespace: d.Namespace, Name: d.Name})
			}
		}
		out.Disks = append(out.Disks, d)
	}

	for _, ns := range namespaces {
		for _, c := range []MigrationCluster{src, dst} {
			present, err := moverWorkersPresent(ctx, c, ns)
			if err != nil {
				return out, err
			}
			if present {
				out.Issues = append(out.Issues, models.MigrationIssue{Code: "moverPresent", Blocker: true, Namespace: ns, Detail: c.Name})
			}
		}
		if migrationNamespaceUsesGitOps(col.Keep, ns) {
			out.Issues = append(out.Issues, models.MigrationIssue{Code: "gitOps", Namespace: ns})
		}
	}

	accessIssues, err := migrationAccessIssues(ctx, src, dst, namespaces, targetHasNS)
	if err != nil {
		return out, err
	}
	out.Issues = append(out.Issues, accessIssues...)

	clusterMissing, err := missingClusterObjects(ctx, src, dst, namespaces, col.Keep)
	if err != nil {
		return out, err
	}
	out.Missing = dedupMissing(append(out.Missing, clusterMissing...))
	return out, nil
}

// MigrationDecisions settles every conflict: overwritten only when the user
// said so, and a disk never, because replacing its data could not be undone.
func MigrationDecisions(pf models.MigrationPreflight, chosen map[string]string) map[string]string {
	out := make(map[string]string, len(pf.Conflicts))
	for _, c := range pf.Conflicts {
		if !c.IsPVC && chosen[c.Key] == migrationDecisionOverwrite {
			out[c.Key] = migrationDecisionOverwrite
		} else {
			out[c.Key] = migrationDecisionSkip
		}
	}
	return out
}

// MigrationDiskRuns numbers the disks of a preflight for a new record.
func MigrationDiskRuns(disks []models.MigrationDisk) []models.MigrationDiskRun {
	out := make([]models.MigrationDiskRun, len(disks))
	for i, d := range disks {
		out[i] = models.MigrationDiskRun{MigrationDisk: d, Index: i}
	}
	return out
}

// MigrationBlocked says whether the preflight has a blocker.
func MigrationBlocked(pf models.MigrationPreflight) bool {
	for _, i := range pf.Issues {
		if i.Blocker {
			return true
		}
	}
	return false
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// migrationConflict reports an object the target already has and that this
// feature did not put there. The namespace's default ServiceAccount exists on
// any namespace and is not a conflict.
func migrationConflict(ctx context.Context, dst MigrationCluster, u *unstructured.Unstructured, classes map[string]string) (*models.MigrationConflict, error) {
	if u.GetKind() == "ServiceAccount" && u.GetName() == "default" {
		return nil, nil
	}
	gvk := u.GroupVersionKind()
	mapping, err := dst.Mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return nil, err
	}
	live, err := dst.Dyn.Resource(mapping.Resource).Namespace(u.GetNamespace()).Get(ctx, u.GetName(), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s %s/%s on %s: %w", u.GetKind(), u.GetNamespace(), u.GetName(), dst.Name, err)
	}
	if live.GetLabels()[migrationLabel] != "" {
		return nil, nil
	}
	sourceYaml, err := migrationYaml(migratable(u, classes))
	if err != nil {
		return nil, err
	}
	target := live.DeepCopy()
	restorable(target.Object)
	targetYaml, err := migrationYaml(target)
	if err != nil {
		return nil, err
	}
	return &models.MigrationConflict{Key: migrationKey(u), Kind: u.GetKind(), Namespace: u.GetNamespace(), Name: u.GetName(),
		IsPVC: isClaim(u), SourceYaml: sourceYaml, TargetYaml: targetYaml}, nil
}

func migrationYaml(u *unstructured.Unstructured) (string, error) {
	if u.GetKind() == "Secret" && u.GroupVersionKind().Group == "" {
		redactSecret(u.Object)
	}
	b, err := yaml.Marshal(u.Object)
	return string(b), err
}

func targetStorageClasses(ctx context.Context, dst MigrationCluster) ([]string, string, error) {
	list, err := dst.Client.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, "", fmt.Errorf("list storage classes on %s: %w", dst.Name, err)
	}
	names, def := make([]string, 0, len(list.Items)), ""
	for _, sc := range list.Items {
		names = append(names, sc.Name)
		if sc.Annotations[migrationDefaultClassAnno] == "true" {
			def = sc.Name
		}
	}
	sort.Strings(names)
	return names, def, nil
}

// migrationDiskFor builds a claim's plan. A claim that already exists on the
// target is never copied over: replacing its data could not be undone.
func migrationDiskFor(u *unstructured.Unstructured, chosen map[string]string, classes []string, defaultClass string, conflicting bool) models.MigrationDisk {
	class, _, _ := unstructured.NestedString(u.Object, "spec", "storageClassName")
	target, picked := chosen[class]
	switch {
	case picked && target != "":
	case containsString(classes, class):
		target = class
	default:
		target = defaultClass
	}
	modes, _, _ := unstructured.NestedStringSlice(u.Object, "spec", "accessModes")
	return models.MigrationDisk{Namespace: u.GetNamespace(), Name: u.GetName(), Size: migrationClaimSize(u),
		SourceClass: class, TargetClass: target, AccessModes: modes, Copy: !conflicting, LiveCopy: true}
}

// unstoppableOwner returns what keeps a pod running if it cannot be stopped by
// scaling a workload this migration controls, "" when it can be. A workload
// owned by something else (an operator) would simply be scaled back up.
func unstoppableOwner(ctx context.Context, src MigrationCluster, p *corev1.Pod) (string, error) {
	ref := metav1.GetControllerOf(p)
	if ref == nil {
		return "Pod", nil
	}
	apps, batch := src.Client.AppsV1(), src.Client.BatchV1()
	notFree := func(owners []metav1.OwnerReference, err error, kind string) (string, error) {
		if apierrors.IsNotFound(err) {
			return kind, nil
		}
		if err != nil {
			return "", err
		}
		if len(owners) > 0 {
			return owners[0].Kind, nil
		}
		return "", nil
	}
	switch ref.Kind {
	case "StatefulSet":
		o, err := apps.StatefulSets(p.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
		if err != nil {
			return notFree(nil, err, ref.Kind)
		}
		return notFree(o.OwnerReferences, nil, ref.Kind)
	case "ReplicaSet":
		rs, err := apps.ReplicaSets(p.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
		if err != nil {
			return notFree(nil, err, ref.Kind)
		}
		owner := metav1.GetControllerOf(rs)
		if owner == nil || owner.Kind != "Deployment" {
			return ref.Kind, nil
		}
		d, err := apps.Deployments(p.Namespace).Get(ctx, owner.Name, metav1.GetOptions{})
		if err != nil {
			return notFree(nil, err, owner.Kind)
		}
		return notFree(d.OwnerReferences, nil, owner.Kind)
	case "Job":
		j, err := batch.Jobs(p.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
		if err != nil {
			return notFree(nil, err, ref.Kind)
		}
		owner := metav1.GetControllerOf(j)
		if owner == nil || owner.Kind != "CronJob" {
			return ref.Kind, nil
		}
		c, err := batch.CronJobs(p.Namespace).Get(ctx, owner.Name, metav1.GetOptions{})
		if err != nil {
			return notFree(nil, err, owner.Kind)
		}
		return notFree(c.OwnerReferences, nil, owner.Kind)
	}
	return ref.Kind, nil
}

func moverWorkersPresent(ctx context.Context, c MigrationCluster, ns string) (bool, error) {
	opts := metav1.ListOptions{LabelSelector: moverLabel + "=true"}
	pods, err := c.Client.CoreV1().Pods(ns).List(ctx, opts)
	if err != nil {
		return false, fmt.Errorf("list workers in %s on %s: %w", ns, c.Name, err)
	}
	if len(pods.Items) > 0 {
		return true, nil
	}
	jobs, err := c.Client.BatchV1().Jobs(ns).List(ctx, opts)
	if err != nil {
		return false, fmt.Errorf("list workers in %s on %s: %w", ns, c.Name, err)
	}
	return len(jobs.Items) > 0, nil
}

func migrationNamespaceUsesGitOps(objs []*unstructured.Unstructured, ns string) bool {
	for _, u := range objs {
		if u.GetNamespace() != ns {
			continue
		}
		l, a := u.GetLabels(), u.GetAnnotations()
		if l["argocd.argoproj.io/instance"] != "" || a["argocd.argoproj.io/tracking-id"] != "" ||
			l["kustomize.toolkit.fluxcd.io/name"] != "" || l["helm.toolkit.fluxcd.io/name"] != "" {
			return true
		}
	}
	return false
}

type migrationAccess struct{ verb, group, resource, sub string }

var (
	migrationSourceAccess = []migrationAccess{
		{"list", "", "pods", ""}, {"get", "", "pods", "log"}, {"create", "", "secrets", ""}, {"delete", "", "secrets", ""},
		{"create", "batch", "jobs", ""}, {"delete", "batch", "jobs", ""},
		{"patch", "apps", "deployments", ""}, {"patch", "apps", "statefulsets", ""}, {"patch", "batch", "cronjobs", ""},
	}
	migrationTargetAccess = []migrationAccess{
		{"create", "", "pods", ""}, {"delete", "", "pods", ""}, {"create", "", "services", ""}, {"delete", "", "services", ""},
		{"create", "", "secrets", ""}, {"delete", "", "secrets", ""}, {"create", "", "persistentvolumeclaims", ""},
		{"patch", "apps", "deployments", ""}, {"patch", "apps", "statefulsets", ""},
	}
)

func migrationAccessIssues(ctx context.Context, src, dst MigrationCluster, namespaces []string, targetHasNS map[string]bool) ([]models.MigrationIssue, error) {
	var out []models.MigrationIssue
	check := func(c MigrationCluster, ns string, a migrationAccess) error {
		r := &authv1.SelfSubjectAccessReview{Spec: authv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authv1.ResourceAttributes{
			Namespace: ns, Verb: a.verb, Group: a.group, Resource: a.resource, Subresource: a.sub}}}
		got, err := c.Client.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, r, metav1.CreateOptions{})
		if err != nil {
			return fmt.Errorf("check access on %s: %w", c.Name, err)
		}
		if !got.Status.Allowed {
			what := a.verb + " " + a.resource
			if a.sub != "" {
				what += "/" + a.sub
			}
			out = append(out, models.MigrationIssue{Code: "accessDenied", Blocker: true, Namespace: ns, Name: c.Name, Detail: what})
		}
		return nil
	}
	createdNS := false
	for _, ns := range namespaces {
		for _, a := range migrationSourceAccess {
			if err := check(src, ns, a); err != nil {
				return nil, err
			}
		}
		for _, a := range migrationTargetAccess {
			if err := check(dst, ns, a); err != nil {
				return nil, err
			}
		}
		if !targetHasNS[ns] && !createdNS {
			createdNS = true
			if err := check(dst, "", migrationAccess{"create", "", "namespaces", ""}); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// missingClusterObjects lists what the namespaces use at cluster level and the
// target lacks. They are reported, never created. A list that is refused says
// nothing, so it is left out rather than reported as missing.
func missingClusterObjects(ctx context.Context, src, dst MigrationCluster, namespaces []string, objs []*unstructured.Unstructured) ([]models.MigrationMissing, error) {
	var out []models.MigrationMissing
	missing := func(err error) bool { return apierrors.IsNotFound(err) }

	for _, u := range objs {
		used := u.GetNamespace() + "/" + u.GetName()
		if class, _, _ := unstructured.NestedString(u.Object, "spec", "ingressClassName"); class != "" && u.GetKind() == "Ingress" {
			if _, err := dst.Client.NetworkingV1().IngressClasses().Get(ctx, class, metav1.GetOptions{}); missing(err) {
				out = append(out, models.MigrationMissing{Kind: "IngressClass", Name: class, UsedBy: used})
			}
		}
		if name := migrationPriorityClass(u); name != "" {
			if _, err := dst.Client.SchedulingV1().PriorityClasses().Get(ctx, name, metav1.GetOptions{}); missing(err) {
				out = append(out, models.MigrationMissing{Kind: "PriorityClass", Name: name, UsedBy: used})
			}
		}
	}

	bindings, err := src.Client.RbacV1().ClusterRoleBindings().List(ctx, metav1.ListOptions{})
	if err != nil {
		if apierrors.IsForbidden(err) {
			return out, nil
		}
		return out, fmt.Errorf("list cluster role bindings on %s: %w", src.Name, err)
	}
	inScope := map[string]bool{}
	for _, ns := range namespaces {
		inScope[ns] = true
	}
	for _, b := range bindings.Items {
		for _, s := range b.Subjects {
			if s.Kind != "ServiceAccount" || !inScope[s.Namespace] {
				continue
			}
			used := s.Namespace + "/" + s.Name
			if _, err := dst.Client.RbacV1().ClusterRoleBindings().Get(ctx, b.Name, metav1.GetOptions{}); missing(err) {
				out = append(out, models.MigrationMissing{Kind: "ClusterRoleBinding", Name: b.Name, UsedBy: used})
			}
			if b.RoleRef.Kind == "ClusterRole" {
				if _, err := dst.Client.RbacV1().ClusterRoles().Get(ctx, b.RoleRef.Name, metav1.GetOptions{}); missing(err) {
					out = append(out, models.MigrationMissing{Kind: "ClusterRole", Name: b.RoleRef.Name, UsedBy: used})
				}
			}
			break
		}
	}
	return out, nil
}

func migrationPriorityClass(u *unstructured.Unstructured) string {
	var path []string
	switch u.GetKind() {
	case "Deployment", "StatefulSet", "DaemonSet":
		path = []string{"spec", "template", "spec", "priorityClassName"}
	case "CronJob":
		path = []string{"spec", "jobTemplate", "spec", "template", "spec", "priorityClassName"}
	default:
		return ""
	}
	name, _, _ := unstructured.NestedString(u.Object, path...)
	return name
}

func dedupMissing(in []models.MigrationMissing) []models.MigrationMissing {
	seen := map[string]bool{}
	out := make([]models.MigrationMissing, 0, len(in))
	for _, m := range in {
		k := m.Kind + "/" + m.Name
		if !seen[k] {
			seen[k] = true
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Name < out[j].Name
	})
	return out
}
