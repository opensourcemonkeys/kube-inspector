package services_k8sclient

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"
	k8stesting "k8s.io/client-go/testing"
)

// One small app per namespace: Ingress → Service → Pod ← ReplicaSet ← Deployment,
// plus an Ingress whose default backend names a Service that does not exist.
func graphFixture(ns string) []runtime.Object {
	isTrue := true
	owner := func(kind, name string) []metav1.OwnerReference {
		return []metav1.OwnerReference{{Kind: kind, Name: name, Controller: &isTrue}}
	}
	return []runtime.Object{
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: ns}},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: ns, OwnerReferences: owner("Deployment", "web")}},
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "web-1-a", Namespace: ns, Labels: map[string]string{"app": "web"}, OwnerReferences: owner("ReplicaSet", "web-1")},
			Spec: corev1.PodSpec{
				ServiceAccountName: "web-sa",
				Containers: []corev1.Container{{
					Name:    "app",
					EnvFrom: []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "web-config"}}}},
					Env: []corev1.EnvVar{{Name: "PW", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
						LocalObjectReference: corev1.LocalObjectReference{Name: "web-db"}, Key: "pw",
					}}}},
				}},
				Volumes: []corev1.Volume{
					{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "web-data"}}},
					// The automatic service-account volume: its kube-root-ca.crt must not become a node.
					{Name: "kube-api-access-x", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{Sources: []corev1.VolumeProjection{
						{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "kube-root-ca.crt"}}},
					}}}},
				},
			},
		},
		&corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: "web-sa", Namespace: ns}, ImagePullSecrets: []corev1.LocalObjectReference{{Name: "regcred"}}},
		&corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{Name: "web-data", Namespace: ns},
			Spec:       corev1.PersistentVolumeClaimSpec{VolumeName: "pv-" + ns, StorageClassName: ptrTo("fast")},
			Status: corev1.PersistentVolumeClaimStatus{
				Phase:    corev1.ClaimBound,
				Capacity: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("10Gi")},
			},
		},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "stray", Namespace: ns, Labels: map[string]string{"app": "other"}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: ns}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "web"}}},
		&networkingv1.Ingress{
			ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: ns},
			Spec: networkingv1.IngressSpec{
				DefaultBackend: &networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "web"}},
				TLS:            []networkingv1.IngressTLS{{SecretName: "web-tls"}},
			},
		},
		&networkingv1.Ingress{
			ObjectMeta: metav1.ObjectMeta{Name: "dangling", Namespace: ns},
			Spec: networkingv1.IngressSpec{
				DefaultBackend: &networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "missing"}},
			},
		},
	}
}

func ptrTo[T any](v T) *T { return &v }

// Cluster-scoped storage: one PV per namespace's claim, a StorageClass both
// use, and one nobody uses.
func clusterStorage() []runtime.Object {
	return []runtime.Object{
		&corev1.PersistentVolume{ObjectMeta: metav1.ObjectMeta{Name: "pv-team-a"}, Status: corev1.PersistentVolumeStatus{Phase: corev1.VolumeBound}},
		&corev1.PersistentVolume{ObjectMeta: metav1.ObjectMeta{Name: "pv-team-b"}, Status: corev1.PersistentVolumeStatus{Phase: corev1.VolumeBound}},
		&storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "fast", Annotations: map[string]string{"storageclass.kubernetes.io/is-default-class": "true"}}},
		&storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "slow"}},
	}
}

// ConfigMaps and Secrets as the metadata client returns them: names only.
func metaFixture(ns string) []runtime.Object {
	obj := func(kind, name string, labels map[string]string) runtime.Object {
		return &metav1.PartialObjectMetadata{
			TypeMeta:   metav1.TypeMeta{APIVersion: "v1", Kind: kind},
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: labels},
		}
	}
	return []runtime.Object{
		obj("ConfigMap", "web-config", nil),
		obj("ConfigMap", "unused-config", nil),
		obj("ConfigMap", "kube-root-ca.crt", nil),
		obj("Secret", "web-db", nil),
		obj("Secret", "web-tls", nil),
		obj("Secret", "regcred", nil),
		obj("Secret", "sh.helm.release.v1.web.v3", map[string]string{"owner": "helm"}),
	}
}

func newGraphClient() *fake.Clientset {
	objs := append(graphFixture("team-a"), graphFixture("team-b")...)
	return fake.NewSimpleClientset(append(objs, clusterStorage()...)...)
}

func newMetaClient() *metadatafake.FakeMetadataClient {
	scheme := metadatafake.NewTestScheme()
	if err := metav1.AddMetaToScheme(scheme); err != nil {
		panic(err)
	}
	objs := append(metaFixture("team-a"), metaFixture("team-b")...)
	return metadatafake.NewSimpleMetadataClient(scheme, objs...)
}

func edgeSet(t *testing.T, client *fake.Clientset, namespaces []string) (map[string]string, map[string]bool) {
	t.Helper()
	g, err := GetClusterGraph(client, newMetaClient(), namespaces)
	if err != nil {
		t.Fatalf("GetClusterGraph: %v", err)
	}
	edges := make(map[string]string)
	for _, e := range g.Edges {
		edges[e.ID] = e.Kind
	}
	nodes := make(map[string]bool)
	for _, n := range g.Nodes {
		nodes[n.ID] = true
	}
	return edges, nodes
}

func TestClusterGraphScopesToSelectedNamespaces(t *testing.T) {
	_, nodes := edgeSet(t, newGraphClient(), []string{"team-a"})
	if !nodes["pod/team-a/web-1-a"] {
		t.Fatal("pod in the selected namespace is missing")
	}
	if nodes["pod/team-b/web-1-a"] || nodes["service/team-b/web"] {
		t.Fatal("objects from an unselected namespace leaked in")
	}
}

func TestClusterGraphEmptySelectionMeansAllNamespaces(t *testing.T) {
	_, nodes := edgeSet(t, newGraphClient(), nil)
	if !nodes["pod/team-a/web-1-a"] || !nodes["pod/team-b/web-1-a"] {
		t.Fatal("an empty selection must list every namespace")
	}
}

func TestClusterGraphEdges(t *testing.T) {
	edges, _ := edgeSet(t, newGraphClient(), []string{"team-a", "team-a"})
	want := map[string]string{
		"deployment/team-a/web->replicaset/team-a/web-1": "owner",
		"replicaset/team-a/web-1->pod/team-a/web-1-a":    "owner",
		"service/team-a/web->pod/team-a/web-1-a":         "selector",
		"ingress/team-a/web->service/team-a/web":         "ingress", // default backend
		// config
		"pod/team-a/web-1-a->serviceaccount/team-a/web-sa":    "config",
		"pod/team-a/web-1-a->configmap/team-a/web-config":     "config",
		"pod/team-a/web-1-a->secret/team-a/web-db":            "config",
		"serviceaccount/team-a/web-sa->secret/team-a/regcred": "config",
		"ingress/team-a/web->secret/team-a/web-tls":           "config",
		// storage
		"pod/team-a/web-1-a->persistentvolumeclaim/team-a/web-data":          "storage",
		"persistentvolumeclaim/team-a/web-data->persistentvolume//pv-team-a": "storage",
		"persistentvolumeclaim/team-a/web-data->storageclass//fast":          "storage",
		// Broken, to a placeholder: the Service does not exist (see TestClusterGraphMissingReferences).
		"ingress/team-a/dangling->service/team-a/missing": "ingress",
	}
	for id, kind := range want {
		if edges[id] != kind {
			t.Errorf("edge %s: kind = %q, want %q", id, edges[id], kind)
		}
	}
	if len(edges) != len(want) {
		t.Errorf("got %d edges, want %d: %v", len(edges), len(want), edges)
	}
	if _, ok := edges["service/team-a/web->pod/team-a/stray"]; ok {
		t.Error("selector edge to a pod whose labels do not match")
	}
}

func TestClusterGraphConfigAndStorageNodes(t *testing.T) {
	g, err := GetClusterGraph(newGraphClient(), newMetaClient(), []string{"team-a"})
	if err != nil {
		t.Fatalf("GetClusterGraph: %v", err)
	}
	nodes := map[string]string{}
	for _, n := range g.Nodes {
		nodes[n.ID] = n.Status
	}
	for _, id := range []string{"configmap/team-a/unused-config", "secret/team-a/web-db", "storageclass//fast"} {
		if _, ok := nodes[id]; !ok {
			t.Errorf("missing node %s", id)
		}
	}
	for _, id := range []string{
		"configmap/team-a/kube-root-ca.crt",       // in every namespace, mounted by every pod
		"secret/team-a/sh.helm.release.v1.web.v3", // one per Helm revision
		"persistentvolume//pv-team-b",             // claimed from an unselected namespace
		"storageclass//slow",                      // no listed claim uses it
	} {
		if _, ok := nodes[id]; ok {
			t.Errorf("node %s should have been left out", id)
		}
	}
	if got := nodes["persistentvolumeclaim/team-a/web-data"]; got != "Bound · 10Gi" {
		t.Errorf("PVC status = %q, want %q", got, "Bound · 10Gi")
	}
	if got := nodes["storageclass//fast"]; got != "default" {
		t.Errorf("StorageClass status = %q, want default", got)
	}
	if len(g.Warnings) != 0 {
		t.Errorf("unexpected warnings: %v", g.Warnings)
	}
}

func TestClusterGraphAllNamespacesDrawsEveryVolume(t *testing.T) {
	_, nodes := edgeSet(t, newGraphClient(), nil)
	if !nodes["persistentvolume//pv-team-b"] || !nodes["storageclass//slow"] {
		t.Fatal("with every namespace selected, cluster-scoped storage is drawn in full")
	}
}

func TestClusterGraphForbiddenSecretsIsAWarning(t *testing.T) {
	meta := newMetaClient()
	meta.PrependReactor("list", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "secrets"}, "", nil)
	})
	g, err := GetClusterGraph(newGraphClient(), meta, []string{"team-a"})
	if err != nil {
		t.Fatalf("a forbidden optional kind must not fail the graph: %v", err)
	}
	if len(g.Warnings) != 1 || g.Warnings[0].Kind != "Secret" || g.Warnings[0].Reason != "forbidden" {
		t.Fatalf("warnings = %+v, want one forbidden Secret", g.Warnings)
	}
	for _, n := range g.Nodes {
		if n.Kind == "Secret" {
			t.Fatalf("Secret node %s drawn without a Secret list", n.ID)
		}
	}
}

func TestClusterGraphForbiddenPodsFailsTheGraph(t *testing.T) {
	client := newGraphClient()
	client.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "", nil)
	})
	if _, err := GetClusterGraph(client, newMetaClient(), []string{"team-a"}); err == nil {
		t.Fatal("pods are not optional: the graph has nothing to show without them")
	}
}
