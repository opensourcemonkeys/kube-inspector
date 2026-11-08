package services_k8sclient

import (
	"context"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	authv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	storagev1 "k8s.io/api/storage/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"kube-ins/internal/models"
)

var migTestResources = []migrationResource{
	{schema.GroupVersionResource{Version: "v1", Resource: "configmaps"}, "ConfigMap"},
	{schema.GroupVersionResource{Version: "v1", Resource: "secrets"}, "Secret"},
	{schema.GroupVersionResource{Version: "v1", Resource: "serviceaccounts"}, "ServiceAccount"},
	{schema.GroupVersionResource{Version: "v1", Resource: "services"}, "Service"},
	{schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}, "PersistentVolumeClaim"},
	{schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}, "Deployment"},
	{schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "statefulsets"}, "StatefulSet"},
	{schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "daemonsets"}, "DaemonSet"},
	{schema.GroupVersionResource{Group: "batch", Version: "v1", Resource: "cronjobs"}, "CronJob"},
	{schema.GroupVersionResource{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"}, "Ingress"},
	{schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}, "Widget"},
}

func migMapper(withWidgets bool) meta.RESTMapper {
	m := meta.NewDefaultRESTMapper(nil)
	for _, r := range migTestResources {
		if r.Kind == "Widget" && !withWidgets {
			continue
		}
		m.Add(r.GVR.GroupVersion().WithKind(r.Kind), meta.RESTScopeNamespace)
	}
	m.Add(schema.GroupVersionKind{Version: "v1", Kind: "Namespace"}, meta.RESTScopeRoot)
	return m
}

type migSide struct {
	typed   []runtime.Object
	dyn     []runtime.Object
	widgets bool
	deny    string // "verb resource" the access review refuses
}

func migFakeCluster(name string, s migSide) (MigrationCluster, *fake.Clientset, *dynamicfake.FakeDynamicClient) {
	cs := fake.NewClientset(s.typed...)
	cs.PrependReactor("create", "selfsubjectaccessreviews", func(a k8stesting.Action) (bool, runtime.Object, error) {
		r := a.(k8stesting.CreateAction).GetObject().(*authv1.SelfSubjectAccessReview)
		attr := r.Spec.ResourceAttributes
		r.Status.Allowed = attr.Verb+" "+attr.Resource != s.deny
		return true, r, nil
	})
	kinds := map[schema.GroupVersionResource]string{{Version: "v1", Resource: "namespaces"}: "NamespaceList"}
	for _, r := range migTestResources {
		kinds[r.GVR] = r.Kind + "List"
	}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), kinds, s.dyn...)
	return MigrationCluster{Name: name, Client: cs, Dyn: dyn, Mapper: migMapper(s.widgets),
		resources: func() ([]migrationResource, error) { return migTestResources, nil }}, cs, dyn
}

func migNS(name string, labels map[string]string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: labels}}
}

func migPVC(ns, name, class, phase string, modes ...any) *unstructured.Unstructured {
	return migObj("v1", "PersistentVolumeClaim", ns, name, map[string]any{
		"spec":   map[string]any{"storageClassName": class, "accessModes": modes, "resources": map[string]any{"requests": map[string]any{"storage": "10Gi"}}},
		"status": map[string]any{"phase": phase},
	})
}

func migSC(name string, isDefault bool) *storagev1.StorageClass {
	sc := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: name}, Provisioner: "x"}
	if isDefault {
		sc.Annotations = map[string]string{"storageclass.kubernetes.io/is-default-class": "true"}
	}
	return sc
}

func migPodUsing(ns, name, claim string, owners ...metav1.OwnerReference) *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, OwnerReferences: owners},
		Spec: corev1.PodSpec{NodeName: "n1", Volumes: []corev1.Volume{{Name: "v", VolumeSource: corev1.VolumeSource{
			PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: claim}}}}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning}}
}

func runMigPreflight(t *testing.T, src, dst migSide, req models.MigrationRequest) models.MigrationPreflight {
	t.Helper()
	s, _, _ := migFakeCluster("source", src)
	d, _, _ := migFakeCluster("target", dst)
	req.Source, req.Target = "source", "target"
	if req.Namespaces == nil {
		req.Namespaces = []string{"a"}
	}
	got, err := RunMigrationPreflight(context.Background(), s, d, req)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func migIssue(p models.MigrationPreflight, code string) *models.MigrationIssue {
	for i := range p.Issues {
		if p.Issues[i].Code == code {
			return &p.Issues[i]
		}
	}
	return nil
}

func wantBlocker(t *testing.T, p models.MigrationPreflight, code string) {
	t.Helper()
	if i := migIssue(p, code); i == nil || !i.Blocker {
		t.Fatalf("no blocker %q in %+v", code, p.Issues)
	}
}

func TestPreflightRejectsTheSameClusterAndNoNamespace(t *testing.T) {
	s, _, _ := migFakeCluster("x", migSide{})
	if _, err := RunMigrationPreflight(context.Background(), s, s, models.MigrationRequest{Source: "x", Target: "x", Namespaces: []string{"a"}}); err == nil {
		t.Error("source and target are the same cluster")
	}
	if _, err := RunMigrationPreflight(context.Background(), s, s, models.MigrationRequest{Source: "x", Target: "y"}); err == nil {
		t.Error("no namespace chosen")
	}
}

func TestPreflightPlansObjectsAndDisks(t *testing.T) {
	p := runMigPreflight(t,
		migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{
			migObj("v1", "ConfigMap", "a", "conf", nil), migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce")}},
		migSide{typed: []runtime.Object{migSC("gp3", true), migSC("slow", false)}},
		models.MigrationRequest{})

	if len(p.Objects) != 2 {
		t.Fatalf("objects = %+v", p.Objects)
	}
	if len(p.Disks) != 1 {
		t.Fatalf("disks = %+v", p.Disks)
	}
	d := p.Disks[0]
	if d.SourceClass != "ssd" || d.TargetClass != "gp3" || !d.Copy || !d.LiveCopy || d.Size != "10Gi" {
		t.Fatalf("disk = %+v: a class the target lacks falls back to its default", d)
	}
	if len(p.TargetClasses) != 2 {
		t.Fatalf("classes = %v", p.TargetClasses)
	}
	if len(p.Issues) != 0 {
		t.Fatalf("issues = %+v", p.Issues)
	}
}

func TestPreflightKeepsTheSameClassWhenTheTargetHasIt(t *testing.T) {
	p := runMigPreflight(t,
		migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce")}},
		migSide{typed: []runtime.Object{migSC("ssd", false), migSC("gp3", true)}}, models.MigrationRequest{})
	if p.Disks[0].TargetClass != "ssd" {
		t.Fatalf("disk = %+v", p.Disks[0])
	}
}

func TestPreflightUsesTheChosenClass(t *testing.T) {
	p := runMigPreflight(t,
		migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce")}},
		migSide{typed: []runtime.Object{migSC("ssd", false), migSC("gp3", true)}},
		models.MigrationRequest{StorageClasses: map[string]string{"ssd": "gp3"}})
	if p.Disks[0].TargetClass != "gp3" {
		t.Fatalf("disk = %+v", p.Disks[0])
	}
}

func TestPreflightBlocksWhenNoClassCanHoldTheDisk(t *testing.T) {
	p := runMigPreflight(t,
		migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce")}},
		migSide{typed: []runtime.Object{migSC("slow", false)}}, models.MigrationRequest{})
	wantBlocker(t, p, "storageClassMissing")
}

func TestPreflightConflicts(t *testing.T) {
	own := migObj("v1", "ConfigMap", "a", "half-done", nil)
	own.SetLabels(map[string]string{migrationLabel: "old-id"})
	p := runMigPreflight(t,
		migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{
			migObj("v1", "ConfigMap", "a", "conf", map[string]any{"data": map[string]any{"k": "from-source"}}),
			migObj("v1", "ConfigMap", "a", "half-done", nil),
			migObj("v1", "ServiceAccount", "a", "default", nil),
			migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce"),
		}},
		migSide{typed: []runtime.Object{migNS("a", nil), migSC("ssd", true)}, dyn: []runtime.Object{
			migObj("v1", "ConfigMap", "a", "conf", map[string]any{"data": map[string]any{"k": "from-target"}}),
			own,
			migObj("v1", "ServiceAccount", "a", "default", nil),
			migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce"),
		}},
		models.MigrationRequest{Decisions: map[string]string{"/PersistentVolumeClaim/a/data": "overwrite"}})

	if len(p.Conflicts) != 2 {
		t.Fatalf("conflicts = %+v", p.Conflicts)
	}
	var conf, disk models.MigrationConflict
	for _, c := range p.Conflicts {
		if c.IsPVC {
			disk = c
		} else {
			conf = c
		}
	}
	if conf.Key != "/ConfigMap/a/conf" || !strings.Contains(conf.SourceYaml, "from-source") || !strings.Contains(conf.TargetYaml, "from-target") {
		t.Fatalf("conflict = %+v", conf)
	}
	if disk.Name != "data" {
		t.Fatalf("conflict = %+v", disk)
	}
	if p.Disks[0].Copy {
		t.Fatal("an existing PVC is only ever skipped: its data must not be replaced, whatever the request says")
	}
}

func TestPreflightOwnHalfFinishedDiskIsCopiedAgain(t *testing.T) {
	own := migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce")
	own.SetLabels(map[string]string{migrationLabel: "old-id"})
	p := runMigPreflight(t,
		migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce")}},
		migSide{typed: []runtime.Object{migNS("a", nil), migSC("ssd", true)}, dyn: []runtime.Object{own}},
		models.MigrationRequest{})
	if len(p.Conflicts) != 0 || !p.Disks[0].Copy {
		t.Fatalf("conflicts = %+v disks = %+v", p.Conflicts, p.Disks)
	}
}

func TestPreflightHashesSecretsInConflicts(t *testing.T) {
	secret := func(v string) *unstructured.Unstructured {
		return migObj("v1", "Secret", "a", "s", map[string]any{"type": "Opaque", "data": map[string]any{"k": v}})
	}
	p := runMigPreflight(t,
		migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{secret("c291cmNlLXZhbHVl")}},
		migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{secret("dGFyZ2V0LXZhbHVl")}},
		models.MigrationRequest{})
	if len(p.Conflicts) != 1 {
		t.Fatalf("conflicts = %+v", p.Conflicts)
	}
	all := p.Conflicts[0].SourceYaml + p.Conflicts[0].TargetYaml
	if strings.Contains(all, "c291cmNlLXZhbHVl") || strings.Contains(all, "dGFyZ2V0LXZhbHVl") || !strings.Contains(all, "sha256:") {
		t.Fatalf("yaml = %s", all)
	}
}

func TestPreflightNamespaceBlockers(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		wantBlocker(t, runMigPreflight(t, migSide{}, migSide{}, models.MigrationRequest{}), "namespaceMissing")
	})
	t.Run("system", func(t *testing.T) {
		wantBlocker(t, runMigPreflight(t, migSide{typed: []runtime.Object{migNS("kube-system", nil)}}, migSide{},
			models.MigrationRequest{Namespaces: []string{"kube-system"}}), "systemNamespace")
	})
	restricted := map[string]string{"pod-security.kubernetes.io/enforce": "restricted"}
	t.Run("source restricted", func(t *testing.T) {
		wantBlocker(t, runMigPreflight(t, migSide{typed: []runtime.Object{migNS("a", restricted)}}, migSide{}, models.MigrationRequest{}), "podSecurityRestricted")
	})
	t.Run("target restricted", func(t *testing.T) {
		wantBlocker(t, runMigPreflight(t, migSide{typed: []runtime.Object{migNS("a", nil)}}, migSide{typed: []runtime.Object{migNS("a", restricted)}}, models.MigrationRequest{}), "podSecurityRestricted")
	})
}

func TestPreflightWriters(t *testing.T) {
	ctl := func(kind, name string) metav1.OwnerReference {
		c := true
		return metav1.OwnerReference{APIVersion: "apps/v1", Kind: kind, Name: name, UID: "1", Controller: &c}
	}
	claim := migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce")
	base := func(extra ...runtime.Object) migSide {
		return migSide{typed: append([]runtime.Object{migNS("a", nil)}, extra...), dyn: []runtime.Object{claim.DeepCopy()}}
	}
	dst := migSide{typed: []runtime.Object{migSC("ssd", true)}}

	t.Run("bare pod", func(t *testing.T) {
		wantBlocker(t, runMigPreflight(t, base(migPodUsing("a", "p", "data")), dst, models.MigrationRequest{}), "unstoppableWriter")
	})
	t.Run("daemonset", func(t *testing.T) {
		wantBlocker(t, runMigPreflight(t, base(migPodUsing("a", "p", "data", ctl("DaemonSet", "d"))), dst, models.MigrationRequest{}), "unstoppableWriter")
	})
	t.Run("deployment", func(t *testing.T) {
		rs := &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "a", OwnerReferences: []metav1.OwnerReference{ctl("Deployment", "web")}}}
		dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "a"}}
		p := runMigPreflight(t, base(rs, dep, migPodUsing("a", "p", "data", ctl("ReplicaSet", "web-1"))), dst, models.MigrationRequest{})
		if migIssue(p, "unstoppableWriter") != nil {
			t.Fatalf("issues = %+v", p.Issues)
		}
	})
	t.Run("operator owned statefulset", func(t *testing.T) {
		sts := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "a", OwnerReferences: []metav1.OwnerReference{ctl("Cluster", "c")}}}
		wantBlocker(t, runMigPreflight(t, base(sts, migPodUsing("a", "p", "data", ctl("StatefulSet", "db"))), dst, models.MigrationRequest{}), "unstoppableWriter")
	})
	t.Run("a mounted disk that is not copied does not matter", func(t *testing.T) {
		kept := migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce")
		kept.Object["status"] = map[string]any{"phase": "Pending"}
		p := runMigPreflight(t, migSide{typed: []runtime.Object{migNS("a", nil), migPodUsing("a", "p", "data")}, dyn: []runtime.Object{kept}}, dst, models.MigrationRequest{})
		if migIssue(p, "unstoppableWriter") != nil {
			t.Fatalf("issues = %+v", p.Issues)
		}
		if i := migIssue(p, "diskNotBound"); i == nil || i.Blocker {
			t.Fatalf("issues = %+v", p.Issues)
		}
	})
}

func TestPreflightReadWriteOncePodDiskIsNotLive(t *testing.T) {
	sts := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "a"}}
	c := true
	p := runMigPreflight(t,
		migSide{typed: []runtime.Object{migNS("a", nil), sts, migPodUsing("a", "db-0", "data", metav1.OwnerReference{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "db", UID: "1", Controller: &c})},
			dyn: []runtime.Object{migPVC("a", "data", "ssd", "Bound", "ReadWriteOncePod")}},
		migSide{typed: []runtime.Object{migSC("ssd", true)}}, models.MigrationRequest{})
	if p.Disks[0].LiveCopy {
		t.Fatalf("disk = %+v", p.Disks[0])
	}
	if i := migIssue(p, "rwopDisk"); i == nil || i.Blocker {
		t.Fatalf("issues = %+v", p.Issues)
	}
}

func TestPreflightWarnsAboutGitOps(t *testing.T) {
	d := migObj("apps/v1", "Deployment", "a", "web", nil)
	d.SetLabels(map[string]string{"argocd.argoproj.io/instance": "web"})
	p := runMigPreflight(t, migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{d}}, migSide{}, models.MigrationRequest{})
	if i := migIssue(p, "gitOps"); i == nil || i.Blocker {
		t.Fatalf("issues = %+v", p.Issues)
	}
}

func TestPreflightBlocksOnLeftoverWorkers(t *testing.T) {
	leftover := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "kube-ins-recv-x-0", Namespace: "a", Labels: map[string]string{moverLabel: "true", migrationLabel: "x"}}}
	wantBlocker(t, runMigPreflight(t, migSide{typed: []runtime.Object{migNS("a", nil)}}, migSide{typed: []runtime.Object{migNS("a", nil), leftover}}, models.MigrationRequest{}), "moverPresent")
}

func TestPreflightBlocksWithoutAccess(t *testing.T) {
	wantBlocker(t, runMigPreflight(t, migSide{typed: []runtime.Object{migNS("a", nil)}, deny: "create jobs"}, migSide{}, models.MigrationRequest{}), "accessDenied")
	wantBlocker(t, runMigPreflight(t, migSide{typed: []runtime.Object{migNS("a", nil)}}, migSide{deny: "create namespaces"}, models.MigrationRequest{}), "accessDenied")
}

func TestPreflightReportsMissingClusterObjectsWithoutCopyingThem(t *testing.T) {
	widget := migObj("example.com/v1", "Widget", "a", "w", nil)
	ingress := migObj("networking.k8s.io/v1", "Ingress", "a", "i", map[string]any{"spec": map[string]any{"ingressClassName": "nginx"}})
	dep := migObj("apps/v1", "Deployment", "a", "d", map[string]any{"spec": map[string]any{"template": map[string]any{"spec": map[string]any{"priorityClassName": "high"}}}})
	crb := &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: "app-admin"},
		RoleRef:  rbacv1.RoleRef{Kind: "ClusterRole", Name: "app-role"},
		Subjects: []rbacv1.Subject{{Kind: "ServiceAccount", Namespace: "a", Name: "app"}}}
	unrelated := &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: "other"},
		RoleRef:  rbacv1.RoleRef{Kind: "ClusterRole", Name: "x"},
		Subjects: []rbacv1.Subject{{Kind: "ServiceAccount", Namespace: "b", Name: "app"}}}
	p := runMigPreflight(t,
		migSide{typed: []runtime.Object{migNS("a", nil), crb, unrelated}, dyn: []runtime.Object{widget, ingress, dep}, widgets: true},
		migSide{}, models.MigrationRequest{})

	got := map[string]bool{}
	for _, m := range p.Missing {
		got[m.Kind+"/"+m.Name] = true
	}
	for _, want := range []string{"CustomResourceDefinition/Widget.example.com", "IngressClass/nginx", "PriorityClass/high", "ClusterRoleBinding/app-admin", "ClusterRole/app-role"} {
		if !got[want] {
			t.Errorf("missing %s in %+v", want, p.Missing)
		}
	}
	if got["ClusterRoleBinding/other"] {
		t.Error("a binding of another namespace was reported")
	}
	for _, o := range p.Objects {
		if o.Kind == "Widget" {
			t.Error("a custom resource without its CRD on the target cannot be applied")
		}
	}
	var skipped bool
	for _, s := range p.Skipped {
		skipped = skipped || (s.Kind == "Widget" && s.Reason == MigrationSkipNoCRD)
	}
	if !skipped {
		t.Errorf("skipped = %+v", p.Skipped)
	}
}
