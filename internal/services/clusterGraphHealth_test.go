package services_k8sclient

import (
	"testing"

	"kube-ins/internal/models"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// assembleGraph is pure, so health is tested on hand-built inputs.

const hns = "app"

func objMeta(name string) metav1.ObjectMeta { return metav1.ObjectMeta{Name: name, Namespace: hns} }

func namedMeta(kind, name string) metav1.PartialObjectMetadata {
	return metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{Kind: kind}, ObjectMeta: objMeta(name)}
}

// readyPod is a running pod whose one container serves port "http".
func readyPod(name string, labels map[string]string) corev1.Pod {
	m := objMeta(name)
	m.Labels = labels
	return corev1.Pod{
		ObjectMeta: m,
		Spec: corev1.PodSpec{Containers: []corev1.Container{{
			Name: "app", Ports: []corev1.ContainerPort{{Name: "http", ContainerPort: 8080}},
		}}},
		Status: corev1.PodStatus{
			Phase:      corev1.PodRunning,
			Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
			ContainerStatuses: []corev1.ContainerStatus{{
				Name: "app", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
			}},
		},
	}
}

func unreadyPod(name string, labels map[string]string) corev1.Pod {
	p := readyPod(name, labels)
	p.Status.Conditions[0].Status = corev1.ConditionFalse
	p.Status.ContainerStatuses[0].Ready = false
	return p
}

func service(name string, selector map[string]string, ports ...corev1.ServicePort) corev1.Service {
	return corev1.Service{ObjectMeta: objMeta(name), Spec: corev1.ServiceSpec{Selector: selector, Ports: ports}}
}

func ingressTo(name string, backends ...networkingv1.IngressServiceBackend) networkingv1.Ingress {
	var paths []networkingv1.HTTPIngressPath
	for i := range backends {
		paths = append(paths, networkingv1.HTTPIngressPath{Path: "/" + backends[i].Name, Backend: networkingv1.IngressBackend{Service: &backends[i]}})
	}
	return networkingv1.Ingress{ObjectMeta: objMeta(name), Spec: networkingv1.IngressSpec{Rules: []networkingv1.IngressRule{{
		Host: "example.com", IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: paths}},
	}}}}
}

func port80(name string) networkingv1.IngressServiceBackend {
	return networkingv1.IngressServiceBackend{Name: name, Port: networkingv1.ServiceBackendPort{Number: 80}}
}

func deployment(name string) appsv1.Deployment { return appsv1.Deployment{ObjectMeta: objMeta(name)} }

func replicaSet(name, deploymentName string) appsv1.ReplicaSet {
	m := objMeta(name)
	m.OwnerReferences = []metav1.OwnerReference{{Kind: "Deployment", Name: deploymentName}}
	return appsv1.ReplicaSet{ObjectMeta: m}
}

var svcPort80 = corev1.ServicePort{Port: 80, TargetPort: intstr.FromInt32(8080)}

type built struct {
	nodes map[string]models.ResourceNode
	edges map[string]models.ResourceEdge
}

func build(t *testing.T, in *graphInputs) built {
	t.Helper()
	g := assembleGraph(in)
	b := built{nodes: map[string]models.ResourceNode{}, edges: map[string]models.ResourceEdge{}}
	for _, n := range g.Nodes {
		b.nodes[n.ID] = n
	}
	for _, e := range g.Edges {
		b.edges[e.ID] = e
	}
	return b
}

// codes is "level:code" for each of a node's issues.
func (b built) codes(t *testing.T, id string) []string {
	t.Helper()
	n, ok := b.nodes[id]
	if !ok {
		t.Fatalf("node %s not in graph", id)
	}
	out := []string{}
	for _, is := range n.Issues {
		out = append(out, is.Level+":"+is.Code)
	}
	return out
}

func hasCode(codes []string, want string) bool {
	for _, c := range codes {
		if c == want {
			return true
		}
	}
	return false
}

func TestHealthMissingReferences(t *testing.T) {
	pod := readyPod("web", nil)
	pod.Spec.Containers[0].EnvFrom = []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "gone-config"}}}}
	optional := true
	pod.Spec.Containers[0].Env = []corev1.EnvVar{{Name: "X", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: "gone-optional"}, Key: "k", Optional: &optional,
	}}}}
	pod.Spec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: "gone-pull"}}
	pod.Spec.Volumes = []corev1.Volume{{Name: "kube-api-access-x", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{
		Sources: []corev1.VolumeProjection{{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: kubeRootCA}}}},
	}}}}

	b := build(t, &graphInputs{pods: []corev1.Pod{pod}})
	podID := "pod/app/web"

	cm := b.nodes["configmap/app/gone-config"]
	if !cm.Missing || cm.Issues[0].Level != levelErr || cm.Issues[0].Code != "notFound" {
		t.Errorf("required missing ConfigMap: got %+v", cm)
	}
	if e := b.edges[podID+"->configmap/app/gone-config"]; e.Issue == nil || e.Issue.Level != levelErr {
		t.Errorf("edge to a missing required ConfigMap must be broken (err), got %+v", e.Issue)
	}
	if !hasCode(b.codes(t, podID), "err:missingRef") {
		t.Errorf("pod issues %v lack err:missingRef", b.codes(t, podID))
	}
	for _, sec := range []string{"secret/app/gone-optional", "secret/app/gone-pull"} {
		if n := b.nodes[sec]; !n.Missing || n.Issues[0].Level != levelWarn {
			t.Errorf("%s: optional or pull-secret reference must be a warning placeholder, got %+v", sec, n)
		}
	}
	if !hasCode(b.codes(t, podID), "warn:optionalRefMissing") {
		t.Errorf("pod issues %v lack warn:optionalRefMissing", b.codes(t, podID))
	}
	if _, ok := b.nodes["configmap/app/"+kubeRootCA]; ok {
		t.Error("kube-root-ca.crt is filtered on purpose and must never be drawn as missing")
	}
}

func TestHealthUnlistableKindIsNeverMissing(t *testing.T) {
	pod := readyPod("web", nil)
	pod.Spec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: "regcred"}}
	b := build(t, &graphInputs{
		pods:     []corev1.Pod{pod},
		warnings: []models.GraphWarning{{Kind: "Secret", Reason: "forbidden"}},
	})
	if _, ok := b.nodes["secret/app/regcred"]; ok {
		t.Error("without permission to list Secrets, a referenced Secret cannot be called missing")
	}
	if len(b.codes(t, "pod/app/web")) != 0 {
		t.Errorf("pod issues = %v, want none", b.codes(t, "pod/app/web"))
	}
}

func TestHealthServiceEndpoints(t *testing.T) {
	app := map[string]string{"app": "web"}
	half := map[string]string{"app": "half"}
	in := &graphInputs{
		pods: []corev1.Pod{
			readyPod("web-1", app),
			readyPod("half-1", half), unreadyPod("half-2", half),
			unreadyPod("down-1", map[string]string{"app": "down"}),
		},
		services: []corev1.Service{
			service("web", app, svcPort80),
			service("half", half, svcPort80),
			service("down", map[string]string{"app": "down"}, svcPort80),
			service("nothing", map[string]string{"app": "nobody"}, svcPort80),
			service("manual", nil, svcPort80), // endpoints managed by hand
		},
	}
	b := build(t, in)
	cases := map[string]string{
		"service/app/web":     "",
		"service/app/half":    "warn:someNotReady",
		"service/app/down":    "err:noReadyEndpoints",
		"service/app/nothing": "err:noMatchingPods",
		"service/app/manual":  "",
	}
	for id, want := range cases {
		got := b.codes(t, id)
		if want == "" && len(got) != 0 || want != "" && !hasCode(got, want) {
			t.Errorf("%s issues = %v, want %q", id, got, want)
		}
	}
	if got := b.edges["service/app/web->pod/app/web-1"].Label; got != "80→8080" {
		t.Errorf("selector edge label = %q, want 80→8080", got)
	}
}

func TestHealthNamedTargetPort(t *testing.T) {
	app := map[string]string{"app": "web"}
	in := &graphInputs{
		pods: []corev1.Pod{readyPod("web-1", app)},
		services: []corev1.Service{
			service("named-ok", app, corev1.ServicePort{Port: 80, TargetPort: intstr.FromString("http")}),
			service("named-bad", app, corev1.ServicePort{Port: 80, TargetPort: intstr.FromString("grpc")}),
			// A numeric target need not be declared as a containerPort.
			service("numeric", app, corev1.ServicePort{Port: 80, TargetPort: intstr.FromInt32(9999)}),
		},
	}
	b := build(t, in)
	if !hasCode(b.codes(t, "service/app/named-bad"), "err:targetPortMissing") {
		t.Errorf("named-bad issues = %v", b.codes(t, "service/app/named-bad"))
	}
	if e := b.edges["service/app/named-bad->pod/app/web-1"]; e.Issue == nil || e.Issue.Code != "targetPortMissing" {
		t.Errorf("edge to a pod without the named port must be broken, got %+v", e.Issue)
	}
	for _, id := range []string{"service/app/named-ok", "service/app/numeric"} {
		if got := b.codes(t, id); len(got) != 0 {
			t.Errorf("%s issues = %v, want none", id, got)
		}
	}
}

func TestHealthIngressPropagation(t *testing.T) {
	app := map[string]string{"app": "web"}
	in := &graphInputs{
		pods: []corev1.Pod{readyPod("web-1", app)},
		services: []corev1.Service{
			service("good", app, svcPort80),
			service("empty", map[string]string{"app": "nobody"}, svcPort80),
		},
		ingresses: []networkingv1.Ingress{
			ingressTo("all-good", port80("good")),
			ingressTo("mixed", port80("good"), port80("empty")),
			ingressTo("all-down", port80("empty"), port80("missing")),
			ingressTo("wrong-port", networkingv1.IngressServiceBackend{Name: "good", Port: networkingv1.ServiceBackendPort{Number: 443}}),
		},
	}
	b := build(t, in)
	cases := map[string]string{
		"ingress/app/all-good":   "",
		"ingress/app/mixed":      "warn:backendsDegraded",
		"ingress/app/all-down":   "err:backendsDown",
		"ingress/app/wrong-port": "err:ingressPortMissing",
	}
	for id, want := range cases {
		got := b.codes(t, id)
		if want == "" && len(got) != 0 || want != "" && !hasCode(got, want) {
			t.Errorf("%s issues = %v, want %q", id, got, want)
		}
	}
	if !b.nodes["service/app/missing"].Missing {
		t.Error("an Ingress backend that does not exist is drawn as a missing placeholder")
	}
	if e := b.edges["ingress/app/wrong-port->service/app/good"]; e.Issue == nil || e.Issue.Code != "ingressPortMissing" {
		t.Errorf("wrong-port edge issue = %+v", e.Issue)
	}
	if got := b.edges["ingress/app/mixed->service/app/good"].Label; got != "example.com/good" {
		t.Errorf("ingress edge label = %q", got)
	}
}

func TestHealthCrashingPodPropagatesToOwners(t *testing.T) {
	isTrue := true
	crash := readyPod("web-1", nil)
	crash.OwnerReferences = []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "web-rs", Controller: &isTrue}}
	crash.Status.ContainerStatuses[0] = corev1.ContainerStatus{Name: "app", State: corev1.ContainerState{
		Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"},
	}}
	done := readyPod("job-1", nil)
	done.Status.Phase = corev1.PodSucceeded
	done.Status.ContainerStatuses[0] = corev1.ContainerStatus{Name: "app", State: corev1.ContainerState{
		Terminated: &corev1.ContainerStateTerminated{Reason: "Completed", ExitCode: 0},
	}}

	in := &graphInputs{pods: []corev1.Pod{crash, done}}
	in.replicaSets = append(in.replicaSets, replicaSet("web-rs", "web"))
	in.deployments = append(in.deployments, deployment("web"))
	b := build(t, in)

	pod := b.nodes["pod/app/web-1"]
	if len(pod.Issues) == 0 || pod.Issues[0].Code != "pod.waiting" || pod.Issues[0].Params["reason"] != "CrashLoopBackOff" {
		t.Errorf("crashing pod issues = %+v", pod.Issues)
	}
	for _, id := range []string{"replicaset/app/web-rs", "deployment/app/web"} {
		if !hasCode(b.codes(t, id), "warn:podsFailing") {
			t.Errorf("%s issues = %v, want warn:podsFailing", id, b.codes(t, id))
		}
	}
	if got := b.codes(t, "pod/app/job-1"); len(got) != 0 {
		t.Errorf("a completed pod is not a problem, got %v", got)
	}
	if got := b.nodes["pod/app/job-1"].Status; got != "Completed" {
		t.Errorf("pod status = %q, want kubectl's Completed", got)
	}
}

func TestHealthStorage(t *testing.T) {
	pvc := func(name string, phase corev1.PersistentVolumeClaimPhase) corev1.PersistentVolumeClaim {
		return corev1.PersistentVolumeClaim{ObjectMeta: objMeta(name), Status: corev1.PersistentVolumeClaimStatus{Phase: phase}}
	}
	in := &graphInputs{
		allNamespaces: true,
		pvcs:          []corev1.PersistentVolumeClaim{pvc("pending", corev1.ClaimPending), pvc("lost", corev1.ClaimLost), pvc("bound", corev1.ClaimBound)},
		pvs: []corev1.PersistentVolume{
			{ObjectMeta: metav1.ObjectMeta{Name: "released"}, Status: corev1.PersistentVolumeStatus{Phase: corev1.VolumeReleased}},
		},
	}
	in.pvcs[2].Spec.StorageClassName = ptrTo("no-such-class")
	b := build(t, in)
	cases := map[string]string{
		"persistentvolumeclaim/app/pending": "warn:pvcPending",
		"persistentvolumeclaim/app/lost":    "err:pvcLost",
		"persistentvolumeclaim/app/bound":   "err:missingRef",
		"persistentvolume//released":        "warn:pvReleased",
	}
	for id, want := range cases {
		if !hasCode(b.codes(t, id), want) {
			t.Errorf("%s issues = %v, want %s", id, b.codes(t, id), want)
		}
	}
}

func TestHealthMountLabels(t *testing.T) {
	pod := readyPod("web", nil)
	pod.Spec.Volumes = []corev1.Volume{{Name: "cfg", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
		LocalObjectReference: corev1.LocalObjectReference{Name: "app-config"},
	}}}}
	pod.Spec.Containers[0].VolumeMounts = []corev1.VolumeMount{{Name: "cfg", MountPath: "/etc/app"}}
	pod.Spec.Containers[0].EnvFrom = []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "app-config"}}}}
	b := build(t, &graphInputs{pods: []corev1.Pod{pod}, configMaps: []metav1.PartialObjectMetadata{namedMeta("ConfigMap", "app-config")}})
	e := b.edges["pod/app/web->configmap/app/app-config"]
	if e.Label != "envFrom, /etc/app" || e.Issue != nil {
		t.Errorf("edge = %+v, want label \"envFrom, /etc/app\" and no issue", e)
	}
}

func TestGraphCarriesImpactFacts(t *testing.T) {
	optional := true
	pod := readyPod("web", nil)
	pod.Spec.Containers[0].Env = []corev1.EnvVar{{Name: "X", ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: "opt"}, Key: "k", Optional: &optional,
	}}}}
	pod.Spec.Containers[0].EnvFrom = []corev1.EnvFromSource{{ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "req"}}}}
	b := build(t, &graphInputs{
		allNamespaces: true,
		pods:          []corev1.Pod{pod},
		configMaps:    []metav1.PartialObjectMetadata{namedMeta("ConfigMap", "opt"), namedMeta("ConfigMap", "req")},
		pvs: []corev1.PersistentVolume{{
			ObjectMeta: metav1.ObjectMeta{Name: "data"},
			Spec:       corev1.PersistentVolumeSpec{PersistentVolumeReclaimPolicy: corev1.PersistentVolumeReclaimDelete},
		}},
	})
	if !b.edges["pod/app/web->configmap/app/opt"].Optional {
		t.Error("an optional reference must be marked on its edge")
	}
	if b.edges["pod/app/web->configmap/app/req"].Optional {
		t.Error("a required reference must not be marked optional")
	}
	if got := b.nodes["persistentvolume//data"].Details["reclaimPolicy"]; got != "Delete" {
		t.Errorf("PV reclaimPolicy = %q, want Delete", got)
	}
}
