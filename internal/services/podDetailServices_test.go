package services_k8sclient

import (
	"kube-ins/internal/models"
	"reflect"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func ctrlRef(kind, name string) []metav1.OwnerReference {
	yes := true
	return []metav1.OwnerReference{{Kind: kind, Name: name, Controller: &yes}}
}

func detailTestPod() *corev1.Pod {
	optional := true
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "api-7d9f-x", Namespace: "shop",
			Labels: map[string]string{"app": "api", "tier": "web"}, OwnerReferences: ctrlRef("ReplicaSet", "api-7d9f")},
		Spec: corev1.PodSpec{
			NodeName:           "worker-1",
			ServiceAccountName: "api-sa",
			ImagePullSecrets:   []corev1.LocalObjectReference{{Name: "regcred"}},
			InitContainers: []corev1.Container{{Name: "migrate", Image: "api:1.2",
				VolumeMounts: []corev1.VolumeMount{{Name: "cfg", MountPath: "/cfg"}}}},
			Containers: []corev1.Container{{
				Name: "api", Image: "api:1.2",
				Ports: []corev1.ContainerPort{{ContainerPort: 8080, Name: "http"}},
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("128Mi"), corev1.ResourceCPU: resource.MustParse("100m")},
				},
				LivenessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstr.FromInt(8080)}}},
				EnvFrom:       []corev1.EnvFromSource{{Prefix: "APP_", ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "api-env"}}}},
				Env: []corev1.EnvVar{
					{Name: "PLAIN", Value: "x"},
					{Name: "DB_PASS", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
						LocalObjectReference: corev1.LocalObjectReference{Name: "db"}, Key: "password", Optional: &optional}}},
				},
				VolumeMounts: []corev1.VolumeMount{{Name: "cfg", MountPath: "/etc/api", ReadOnly: true}, {Name: "data", MountPath: "/data"}},
			}},
			Volumes: []corev1.Volume{
				{Name: "cfg", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
					LocalObjectReference: corev1.LocalObjectReference{Name: "api-config"}, Items: []corev1.KeyToPath{{Key: "app.yaml", Path: "app.yaml"}}}}},
				{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "api-data"}}},
				{Name: "tls", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: "api-tls"}}},
				{Name: "bundle", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{Sources: []corev1.VolumeProjection{
					{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "ca"}}},
					{Secret: &corev1.SecretProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "token"}}},
					{ServiceAccountToken: &corev1.ServiceAccountTokenProjection{Path: "t"}},
				}}}},
				{Name: "scratch", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory}}},
				{Name: "host", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/var/log"}}},
				{Name: "eph", VolumeSource: corev1.VolumeSource{Ephemeral: &corev1.EphemeralVolumeSource{}}},
			},
		},
	}
}

func TestBuildPodDetail(t *testing.T) {
	d := buildPodDetail(detailTestPod())

	if len(d.Containers) != 2 || d.Containers[0].Name != "migrate" || !d.Containers[0].Init || d.Containers[1].Init {
		t.Fatalf("containers = %+v, want init container first", d.Containers)
	}
	api := d.Containers[1]
	if !reflect.DeepEqual(api.Ports, []string{"8080/TCP (http)"}) {
		t.Errorf("ports = %v", api.Ports)
	}
	if api.Requests != "cpu 100m · memory 128Mi" || api.Limits != "" {
		t.Errorf("requests = %q, limits = %q", api.Requests, api.Limits)
	}
	if !reflect.DeepEqual(api.Probes, []string{"liveness: http :8080/healthz"}) {
		t.Errorf("probes = %v", api.Probes)
	}

	wantVolumes := map[string]struct {
		typ    string
		refs   []models.ObjectRef
		detail string
	}{
		"cfg":     {"configMap", []models.ObjectRef{{Kind: "ConfigMap", Name: "api-config", Namespace: "shop"}}, "keys: app.yaml"},
		"data":    {"persistentVolumeClaim", []models.ObjectRef{{Kind: "PersistentVolumeClaim", Name: "api-data", Namespace: "shop"}}, ""},
		"tls":     {"secret", []models.ObjectRef{{Kind: "Secret", Name: "api-tls", Namespace: "shop"}}, ""},
		"bundle":  {"projected", []models.ObjectRef{{Kind: "ConfigMap", Name: "ca", Namespace: "shop"}, {Kind: "Secret", Name: "token", Namespace: "shop"}}, "serviceAccountToken"},
		"scratch": {"emptyDir", []models.ObjectRef{}, "medium Memory"},
		"host":    {"hostPath", []models.ObjectRef{}, "/var/log"},
		"eph":     {"ephemeral", []models.ObjectRef{{Kind: "PersistentVolumeClaim", Name: "api-7d9f-x-eph", Namespace: "shop"}}, ""},
	}
	if len(d.Volumes) != len(wantVolumes) {
		t.Fatalf("got %d volumes, want %d", len(d.Volumes), len(wantVolumes))
	}
	for _, v := range d.Volumes {
		w := wantVolumes[v.Name]
		if v.Type != w.typ || v.Detail != w.detail || !reflect.DeepEqual(v.Refs, w.refs) {
			t.Errorf("volume %s = {%s %v %q}, want {%s %v %q}", v.Name, v.Type, v.Refs, v.Detail, w.typ, w.refs, w.detail)
		}
	}
	// Mounts are gathered across init and regular containers.
	wantCfgMounts := []models.PodVolumeMount{{Container: "migrate", MountPath: "/cfg"}, {Container: "api", MountPath: "/etc/api", ReadOnly: true}}
	if !reflect.DeepEqual(d.Volumes[0].Mounts, wantCfgMounts) {
		t.Errorf("cfg mounts = %+v", d.Volumes[0].Mounts)
	}

	wantEnv := []models.PodEnvRef{
		{Container: "api", Prefix: "APP_", Ref: models.ObjectRef{Kind: "ConfigMap", Name: "api-env", Namespace: "shop"}},
		{Container: "api", Variable: "DB_PASS", Key: "password", Ref: models.ObjectRef{Kind: "Secret", Name: "db", Namespace: "shop"}, Optional: true},
	}
	if !reflect.DeepEqual(d.EnvRefs, wantEnv) {
		t.Errorf("env refs = %+v", d.EnvRefs)
	}

	if d.ServiceAccount == nil || *d.ServiceAccount != (models.ObjectRef{Kind: "ServiceAccount", Name: "api-sa", Namespace: "shop"}) {
		t.Errorf("service account = %+v", d.ServiceAccount)
	}
	if d.Node == nil || *d.Node != (models.ObjectRef{Kind: "Node", Name: "worker-1"}) {
		t.Errorf("node = %+v", d.Node)
	}
	if !reflect.DeepEqual(d.ImagePullSecrets, []models.ObjectRef{{Kind: "Secret", Name: "regcred", Namespace: "shop"}}) {
		t.Errorf("image pull secrets = %+v", d.ImagePullSecrets)
	}
}

func TestGetPodDetailRelations(t *testing.T) {
	pod := detailTestPod()
	client := fake.NewClientset(pod,
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "api-7d9f", Namespace: "shop", OwnerReferences: ctrlRef("Deployment", "api")}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "shop"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "api"}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "api-web", Namespace: "shop"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "api", "tier": "web"}}},
		// Not selecting: wrong label, no selector at all, another namespace.
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "worker", Namespace: "shop"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "worker"}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "external", Namespace: "shop"}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "other"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "api"}}},
	)

	d, err := GetPodDetail("shop", "api-7d9f-x", client)
	if err != nil {
		t.Fatal(err)
	}
	wantOwners := []models.ObjectRef{{Kind: "ReplicaSet", Name: "api-7d9f", Namespace: "shop"}, {Kind: "Deployment", Name: "api", Namespace: "shop"}}
	if !reflect.DeepEqual(d.Owners, wantOwners) {
		t.Errorf("owners = %+v, want %+v", d.Owners, wantOwners)
	}
	wantSvcs := []models.ObjectRef{{Kind: "Service", Name: "api", Namespace: "shop"}, {Kind: "Service", Name: "api-web", Namespace: "shop"}}
	if !reflect.DeepEqual(d.Services, wantSvcs) {
		t.Errorf("services = %+v, want %+v", d.Services, wantSvcs)
	}
}

func TestGetPodDetailJobChain(t *testing.T) {
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "backup-123-abc", Namespace: "ops", OwnerReferences: ctrlRef("Job", "backup-123")}}
	client := fake.NewClientset(pod,
		&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "backup-123", Namespace: "ops", OwnerReferences: ctrlRef("CronJob", "backup")}})

	d, err := GetPodDetail("ops", "backup-123-abc", client)
	if err != nil {
		t.Fatal(err)
	}
	want := []models.ObjectRef{{Kind: "Job", Name: "backup-123", Namespace: "ops"}, {Kind: "CronJob", Name: "backup", Namespace: "ops"}}
	if !reflect.DeepEqual(d.Owners, want) {
		t.Errorf("owners = %+v, want %+v", d.Owners, want)
	}
}

// An RBAC-restricted user may read the pod but not its ReplicaSet or the
// namespace's Services: those sections stay partial, the detail still loads.
func TestGetPodDetailToleratesForbiddenLookups(t *testing.T) {
	client := fake.NewClientset(detailTestPod())
	forbid := func(resource string) k8stesting.ReactionFunc {
		return func(k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: resource}, "", nil)
		}
	}
	client.PrependReactor("get", "replicasets", forbid("replicasets"))
	client.PrependReactor("list", "services", forbid("services"))

	d, err := GetPodDetail("shop", "api-7d9f-x", client)
	if err != nil {
		t.Fatalf("forbidden side lookups failed the detail: %v", err)
	}
	if !reflect.DeepEqual(d.Owners, []models.ObjectRef{{Kind: "ReplicaSet", Name: "api-7d9f", Namespace: "shop"}}) {
		t.Errorf("owners = %+v, want the ReplicaSet the pod names itself", d.Owners)
	}
	if len(d.Services) != 0 {
		t.Errorf("services = %+v, want none", d.Services)
	}
	if len(d.Volumes) == 0 {
		t.Error("pod-local sections went missing")
	}
}

func TestGetPodDetailMissingPod(t *testing.T) {
	if _, err := GetPodDetail("shop", "gone", fake.NewClientset()); err == nil {
		t.Error("want an error for a pod that does not exist")
	}
}
