package services_k8sclient

import (
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	k8stesting "k8s.io/client-go/testing"
	metricsv1beta1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	metricsfake "k8s.io/metrics/pkg/client/clientset/versioned/fake"
)

var liveNow = time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

func warning(kind, name, reason string, ago time.Duration, count int32) corev1.Event {
	return corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: name + "." + reason, Namespace: hns},
		InvolvedObject: corev1.ObjectReference{Kind: kind, Namespace: hns, Name: name},
		Type:           corev1.EventTypeWarning, Reason: reason, Message: reason + " on " + name,
		LastTimestamp: metav1.NewTime(liveNow.Add(-ago)), Count: count,
	}
}

func TestEventsBecomeIssuesOnTheirObject(t *testing.T) {
	in := &graphInputs{
		now:         liveNow,
		pods:        []corev1.Pod{readyPod("web", nil)},
		replicaSets: []appsv1.ReplicaSet{replicaSet("web-rs", "web")},
		events: []corev1.Event{
			warning("Pod", "web", "BackOff", 2*time.Minute, 3),
			warning("Pod", "web", "Unhealthy", time.Minute, 2),
			warning("ReplicaSet", "web-rs", "FailedCreate", 30*time.Second, 1),
			warning("Pod", "gone", "BackOff", time.Minute, 1),           // not drawn
			warning("Node", "worker-1", "NodeNotReady", time.Minute, 1), // not a graph kind
		},
	}
	b := build(t, in)
	pod := b.nodes[resourceID("Pod", hns, "web")]
	var got map[string]string
	for _, is := range pod.Issues {
		if is.Code == "recentWarnings" {
			if is.Level != levelWarn {
				t.Fatalf("event issue level = %s, want warn", is.Level)
			}
			got = is.Params
		}
	}
	if got == nil {
		t.Fatalf("pod issues = %v, want recentWarnings", b.codes(t, pod.ID))
	}
	if got["count"] != "5" || got["reason"] != "Unhealthy" || got["message"] != "Unhealthy on web" {
		t.Fatalf("params = %v, want count 5 and the latest event's reason and message", got)
	}
	if !hasCode(b.codes(t, resourceID("ReplicaSet", hns, "web-rs")), "warn:recentWarnings") {
		t.Fatal("a ReplicaSet's FailedCreate belongs on the ReplicaSet")
	}
}

func TestOldEventsAreHistory(t *testing.T) {
	in := &graphInputs{
		now:    liveNow,
		pods:   []corev1.Pod{readyPod("web", nil)},
		events: []corev1.Event{warning("Pod", "web", "BackOff", 16*time.Minute, 9)},
	}
	if codes := build(t, in).codes(t, resourceID("Pod", hns, "web")); len(codes) != 0 {
		t.Fatalf("an event older than the window still raised %v", codes)
	}
}

func TestEventTimePrefersTheLatestField(t *testing.T) {
	ev := warning("Pod", "web", "BackOff", time.Hour, 1)
	ev.Series = &corev1.EventSeries{Count: 40, LastObservedTime: metav1.NewMicroTime(liveNow.Add(-time.Minute))}
	in := &graphInputs{now: liveNow, pods: []corev1.Pod{readyPod("web", nil)}, events: []corev1.Event{ev}}
	pod := build(t, in).nodes[resourceID("Pod", hns, "web")]
	if len(pod.Issues) != 1 || pod.Issues[0].Params["count"] != "40" {
		t.Fatalf("issues = %+v, want one recentWarnings counted from the series", pod.Issues)
	}
}

func TestLongEventMessagesAreCapped(t *testing.T) {
	ev := warning("Pod", "web", "Failed", time.Minute, 1)
	ev.Message = strings.Repeat("x", 1000)
	in := &graphInputs{now: liveNow, pods: []corev1.Pod{readyPod("web", nil)}, events: []corev1.Event{ev}}
	msg := build(t, in).nodes[resourceID("Pod", hns, "web")].Issues[0].Params["message"]
	if n := len([]rune(msg)); n != maxEventMessage+1 {
		t.Fatalf("message is %d runes, want %d plus an ellipsis", n, maxEventMessage)
	}
}

func TestForbiddenEventsIsAWarning(t *testing.T) {
	client := newGraphClient()
	client.PrependReactor("list", "events", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "events"}, "", nil)
	})
	g, err := GetClusterGraph(client, newMetaClient(), []string{"team-a"})
	if err != nil {
		t.Fatalf("events are optional: %v", err)
	}
	if len(g.Warnings) != 1 || g.Warnings[0].Kind != "Event" || g.Warnings[0].Reason != "forbidden" {
		t.Fatalf("warnings = %+v, want one forbidden Event", g.Warnings)
	}
}

func TestPodRestartsAreADetail(t *testing.T) {
	p := readyPod("web", nil)
	p.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "init", RestartCount: 1}}
	p.Status.ContainerStatuses[0].RestartCount = 4
	calm := readyPod("calm", nil)
	b := build(t, &graphInputs{now: liveNow, pods: []corev1.Pod{p, calm}})
	if got := b.nodes[resourceID("Pod", hns, "web")].Details["restarts"]; got != "5" {
		t.Fatalf("restarts = %q, want 5 (init + regular)", got)
	}
	if d := b.nodes[resourceID("Pod", hns, "calm")].Details; d != nil {
		t.Fatalf("a pod that never restarted carries details %v", d)
	}
}

func podMetrics(ns, name string, containers ...[2]string) *metricsv1beta1.PodMetrics {
	pm := &metricsv1beta1.PodMetrics{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}}
	for i, c := range containers {
		pm.Containers = append(pm.Containers, metricsv1beta1.ContainerMetrics{
			Name: string(rune('a' + i)),
			Usage: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse(c[0]),
				corev1.ResourceMemory: resource.MustParse(c[1]),
			},
		})
	}
	return pm
}

func TestGraphUsageSumsContainersPerPod(t *testing.T) {
	// The tracker would file PodMetrics under the guessed resource
	// "podmetricses"; the client lists "pods", so they go in by hand.
	mc := metricsfake.NewSimpleClientset()
	gvr := metricsv1beta1.SchemeGroupVersion.WithResource("pods")
	for _, pm := range []*metricsv1beta1.PodMetrics{
		podMetrics("team-a", "web", [2]string{"100m", "64Mi"}, [2]string{"25m", "16Mi"}),
		podMetrics("team-b", "db", [2]string{"1", "1Gi"}),
	} {
		if err := mc.Tracker().Create(gvr, pm, pm.Namespace); err != nil {
			t.Fatal(err)
		}
	}
	u := GetGraphUsage(mc, []string{"team-a"})
	if !u.Available || len(u.Pods) != 1 {
		t.Fatalf("usage = %+v, want team-a's one pod", u)
	}
	if p := u.Pods[0]; p.Name != "web" || p.CpuMillis != 125 || p.MemMi != 80 {
		t.Fatalf("pod usage = %+v, want 125m / 80Mi", p)
	}
}

func TestGraphUsageWithoutMetricsServer(t *testing.T) {
	if u := GetGraphUsage(nil, nil); u.Available || u.Reason != "unavailable" || u.Pods == nil {
		t.Fatalf("no client: %+v", u)
	}
	mc := metricsfake.NewSimpleClientset()
	mc.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Group: "metrics.k8s.io", Resource: "pods"}, "", nil)
	})
	if u := GetGraphUsage(mc, []string{"team-a"}); u.Available || u.Reason != "forbidden" {
		t.Fatalf("forbidden: %+v", u)
	}
}

func TestHostsCarryReadinessAndConditions(t *testing.T) {
	cond := func(ty corev1.NodeConditionType, st corev1.ConditionStatus) corev1.NodeCondition {
		return corev1.NodeCondition{Type: ty, Status: st}
	}
	in := &graphInputs{now: liveNow, hosts: []corev1.Node{
		{ObjectMeta: metav1.ObjectMeta{Name: "worker-b"}, Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
			cond(corev1.NodeReady, corev1.ConditionFalse), cond(corev1.NodeMemoryPressure, corev1.ConditionTrue),
		}}},
		{ObjectMeta: metav1.ObjectMeta{Name: "worker-a"}, Spec: corev1.NodeSpec{Unschedulable: true}, Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{
			cond(corev1.NodeReady, corev1.ConditionTrue), cond(corev1.NodeDiskPressure, corev1.ConditionFalse),
		}}},
	}}
	hosts := assembleGraph(in).Hosts
	if len(hosts) != 2 || hosts[0].Name != "worker-a" {
		t.Fatalf("hosts = %+v, want both, sorted by name", hosts)
	}
	codes := func(i int) []string {
		var out []string
		for _, is := range hosts[i].Issues {
			out = append(out, is.Level+":"+is.Code)
		}
		return out
	}
	if !hosts[0].Ready || strings.Join(codes(0), ",") != "warn:host.cordoned" {
		t.Fatalf("worker-a = %+v, want ready and cordoned only", hosts[0])
	}
	if hosts[1].Ready || strings.Join(codes(1), ",") != "err:host.notReady,warn:host.memoryPressure" {
		t.Fatalf("worker-b issues = %v, want NotReady first, then the pressure", codes(1))
	}
}

func TestPodsKnowTheirNode(t *testing.T) {
	p := readyPod("web", nil)
	p.Spec.NodeName = "worker-a"
	pending := readyPod("waiting", nil)
	b := build(t, &graphInputs{now: liveNow, pods: []corev1.Pod{p, pending}})
	if got := b.nodes[resourceID("Pod", hns, "web")].Details["node"]; got != "worker-a" {
		t.Fatalf("node = %q", got)
	}
	if _, ok := b.nodes[resourceID("Pod", hns, "waiting")].Details["node"]; ok {
		t.Fatal("an unscheduled pod has no node")
	}
}

func TestForbiddenNodesIsAWarning(t *testing.T) {
	client := newGraphClient()
	client.PrependReactor("list", "nodes", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "nodes"}, "", nil)
	})
	g, err := GetClusterGraph(client, newMetaClient(), []string{"team-a"})
	if err != nil {
		t.Fatalf("nodes are optional: %v", err)
	}
	if len(g.Warnings) != 1 || g.Warnings[0].Kind != "Node" || len(g.Hosts) != 0 {
		t.Fatalf("warnings = %+v hosts = %+v", g.Warnings, g.Hosts)
	}
}

func TestGraphUsageIncludesNodes(t *testing.T) {
	mc := metricsfake.NewSimpleClientset()
	nm := &metricsv1beta1.NodeMetrics{
		ObjectMeta: metav1.ObjectMeta{Name: "worker-a"},
		Usage:      corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("750m"), corev1.ResourceMemory: resource.MustParse("2Gi")},
	}
	if err := mc.Tracker().Create(metricsv1beta1.SchemeGroupVersion.WithResource("nodes"), nm, ""); err != nil {
		t.Fatal(err)
	}
	u := GetGraphUsage(mc, []string{"team-a"})
	if len(u.Hosts) != 1 || u.Hosts[0].Name != "worker-a" || u.Hosts[0].CpuMillis != 750 || u.Hosts[0].MemMi != 2048 {
		t.Fatalf("hosts = %+v", u.Hosts)
	}
}
