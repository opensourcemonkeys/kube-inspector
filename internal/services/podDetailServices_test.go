package services_k8sclient

import (
	"kube-ins/internal/models"
	"reflect"
	"strings"
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
	metricsv1beta1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	metricsfake "k8s.io/metrics/pkg/client/clientset/versioned/fake"
)

func ctrlRef(kind, name string) []metav1.OwnerReference {
	yes := true
	return []metav1.OwnerReference{{Kind: kind, Name: name, Controller: &yes}}
}

func ptrInt64(v int64) *int64 { return &v }

func terminatedOK(name string) corev1.ContainerStatus {
	return corev1.ContainerStatus{Name: name, Ready: true,
		State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}}
}

func detailTestPod() *corev1.Pod {
	optional := true
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "api-7d9f-x", Namespace: "shop",
			Labels: map[string]string{"app": "api", "tier": "web"}, OwnerReferences: ctrlRef("ReplicaSet", "api-7d9f")},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning, QOSClass: corev1.PodQOSBurstable, PodIP: "10.0.0.7",
			Conditions:            []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionFalse, Reason: "ContainersNotReady"}},
			InitContainerStatuses: []corev1.ContainerStatus{terminatedOK("migrate")},
			ContainerStatuses: []corev1.ContainerStatus{{Name: "api", RestartCount: 2,
				State:                corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff", Message: "back-off 40s"}},
				LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1}}}},
		},
		Spec: corev1.PodSpec{
			PriorityClassName:  "high",
			Tolerations:        []corev1.Toleration{{Key: "node.kubernetes.io/not-ready", Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoExecute, TolerationSeconds: ptrInt64(300)}},
			Affinity:           &corev1.Affinity{NodeAffinity: &corev1.NodeAffinity{}, PodAntiAffinity: &corev1.PodAntiAffinity{}},
			NodeName:           "worker-1",
			ServiceAccountName: "api-sa",
			ImagePullSecrets:   []corev1.LocalObjectReference{{Name: "regcred"}},
			InitContainers: []corev1.Container{{Name: "migrate", Image: "api:1.2",
				VolumeMounts: []corev1.VolumeMount{{Name: "cfg", MountPath: "/cfg"}}}},
			Containers: []corev1.Container{{
				Name: "api", Image: "api:1.2",
				Ports: []corev1.ContainerPort{{ContainerPort: 8080, Name: "http"}},
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("128Mi"), corev1.ResourceCPU: resource.MustParse("100m"),
						corev1.ResourceEphemeralStorage: resource.MustParse("1Gi")},
					Limits: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("256Mi"), "nvidia.com/gpu": resource.MustParse("1")},
				},
				LivenessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstr.FromInt(8080)}}},
				EnvFrom:       []corev1.EnvFromSource{{Prefix: "APP_", ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "api-env"}}}},
				Env: []corev1.EnvVar{
					{Name: "PLAIN", Value: "x"},
					{Name: "NODE", ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "spec.nodeName"}}},
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

	if d.Name != "api-7d9f-x" || d.Namespace != "shop" || d.Status != "CrashLoopBackOff" || d.PriorityClass != "high" || d.QosClass != "Burstable" {
		t.Errorf("identity = %s/%s status %q priority %q qos %q", d.Namespace, d.Name, d.Status, d.PriorityClass, d.QosClass)
	}
	if !reflect.DeepEqual(d.PodIPs, []string{"10.0.0.7"}) {
		t.Errorf("pod IPs = %v, want the singular podIP as a fallback", d.PodIPs)
	}
	if d.Annotations == nil {
		t.Error("annotations must be an empty map, not null, so the UI can iterate it")
	}
	if want := []models.PodCondition{{Type: "Ready", Status: "False", Reason: "ContainersNotReady"}}; !reflect.DeepEqual(d.Conditions, want) {
		t.Errorf("conditions = %+v", d.Conditions)
	}
	if want := []models.PodToleration{{Key: "node.kubernetes.io/not-ready", Operator: "Exists", Effect: "NoExecute", Seconds: "300"}}; !reflect.DeepEqual(d.Tolerations, want) {
		t.Errorf("tolerations = %+v", d.Tolerations)
	}
	if d.AffinityCount != 2 || !strings.Contains(d.Affinity, "podAntiAffinity") {
		t.Errorf("affinity count %d, yaml %q", d.AffinityCount, d.Affinity)
	}

	if len(d.Containers) != 2 || d.Containers[0].Name != "migrate" || !d.Containers[0].Init || d.Containers[1].Init {
		t.Fatalf("containers = %+v, want init container first", d.Containers)
	}
	// Init and regular statuses are matched separately, by kind as well as name.
	if st := d.Containers[0].Status; st == nil || st.Reason != "Completed" || !st.Init {
		t.Errorf("init status = %+v", st)
	}
	api := d.Containers[1]
	if api.Status == nil || api.Status.Reason != "CrashLoopBackOff" || api.StateMessage != "back-off 40s" {
		t.Errorf("api status = %+v, message %q", api.Status, api.StateMessage)
	}
	if api.LastState != "Terminated: Error (exit 1)" {
		t.Errorf("last state = %q", api.LastState)
	}
	if !reflect.DeepEqual(api.Ports, []string{"8080/TCP (http)"}) {
		t.Errorf("ports = %v", api.Ports)
	}
	// No CPU limit is a real 0, not a missing field: the UI draws CPU against the request.
	if api.CpuRequestMillis != 100 || api.CpuLimitMillis != 0 || api.MemRequestMi != 128 || api.MemLimitMi != 256 {
		t.Errorf("cpu %d/%d mem %d/%d, want 100/0 128/256", api.CpuRequestMillis, api.CpuLimitMillis, api.MemRequestMi, api.MemLimitMi)
	}
	if want := []string{"ephemeral-storage 1Gi / –", "nvidia.com/gpu – / 1"}; !reflect.DeepEqual(api.OtherResources, want) {
		t.Errorf("other resources = %v, want %v", api.OtherResources, want)
	}
	wantProbe := models.PodProbe{Kind: "liveness", Handler: "http-get http://:8080/healthz", Timing: "delay=0s timeout=1s period=10s #success=1 #failure=3"}
	if !reflect.DeepEqual(api.Probes, []models.PodProbe{wantProbe}) {
		t.Errorf("probes = %+v", api.Probes)
	}
	wantEnv := []models.PodEnvVar{
		{Name: "PLAIN", Value: "x"},
		{Name: "NODE", Source: "field", Key: "spec.nodeName"},
		{Name: "DB_PASS", Source: "secret", Key: "password", Optional: true, Ref: &models.ObjectRef{Kind: "Secret", Name: "db", Namespace: "shop"}},
	}
	if !reflect.DeepEqual(api.Env, wantEnv) {
		t.Errorf("env = %+v", api.Env)
	}
	if want := []models.PodEnvFrom{{Ref: models.ObjectRef{Kind: "ConfigMap", Name: "api-env", Namespace: "shop"}, Prefix: "APP_"}}; !reflect.DeepEqual(api.EnvFrom, want) {
		t.Errorf("envFrom = %+v", api.EnvFrom)
	}
	if want := []models.PodContainerMount{{Volume: "cfg", MountPath: "/etc/api", ReadOnly: true}, {Volume: "data", MountPath: "/data"}}; !reflect.DeepEqual(api.Mounts, want) {
		t.Errorf("mounts = %+v", api.Mounts)
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

	// Every reference, from volumes, env, envFrom and imagePullSecrets, once per name.
	names := func(refs []models.ObjectRef) []string {
		out := []string{}
		for _, r := range refs {
			out = append(out, r.Name)
		}
		return out
	}
	if got, want := names(d.Secrets), []string{"api-tls", "db", "regcred", "token"}; !reflect.DeepEqual(got, want) {
		t.Errorf("secrets = %v, want %v", got, want)
	}
	if got, want := names(d.ConfigMaps), []string{"api-config", "api-env", "ca"}; !reflect.DeepEqual(got, want) {
		t.Errorf("config maps = %v, want %v", got, want)
	}
	if got, want := names(d.PersistentVolumeClaims), []string{"api-7d9f-x-eph", "api-data"}; !reflect.DeepEqual(got, want) {
		t.Errorf("PVCs = %v, want %v", got, want)
	}

	if d.ServiceAccount == nil || *d.ServiceAccount != (models.ObjectRef{Kind: "ServiceAccount", Name: "api-sa", Namespace: "shop"}) {
		t.Errorf("service account = %+v", d.ServiceAccount)
	}
	if d.Node == nil || *d.Node != (models.ObjectRef{Kind: "Node", Name: "worker-1"}) {
		t.Errorf("node = %+v", d.Node)
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

func TestGetPodContainerUsage(t *testing.T) {
	sample := &metricsv1beta1.PodMetrics{
		ObjectMeta: metav1.ObjectMeta{Name: "api-7d9f-x", Namespace: "shop"},
		Containers: []metricsv1beta1.ContainerMetrics{
			{Name: "api", Usage: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("42m"), corev1.ResourceMemory: resource.MustParse("180Mi")}},
		},
	}
	// The fake's object tracker files PodMetrics under "podmetricses" while the
	// typed client asks for "pods", so seeding it never matches: answer directly.
	mc := metricsfake.NewSimpleClientset()
	mc.PrependReactor("get", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		get := a.(k8stesting.GetAction)
		if get.GetNamespace() == sample.Namespace && get.GetName() == sample.Name {
			return true, sample, nil
		}
		return true, nil, apierrors.NewNotFound(schema.GroupResource{Group: "metrics.k8s.io", Resource: "pods"}, get.GetName())
	})

	got, err := GetPodContainerUsage("shop", "api-7d9f-x", mc)
	if err != nil {
		t.Fatal(err)
	}
	if want := []models.ContainerUsage{{Name: "api", CpuMillis: 42, MemMi: 180}}; !reflect.DeepEqual(got, want) {
		t.Errorf("usage = %+v, want %+v", got, want)
	}

	// A pod metrics-server has not sampled yet must read as "unavailable", not as zero usage.
	if _, err := GetPodContainerUsage("shop", "fresh-pod", mc); err == nil {
		t.Error("want an error for a pod with no metrics sample")
	}
}
