package services_k8sclient

import (
	"fmt"
	"sort"
	"time"

	"kube-ins/internal/models"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// Health of the resource graph. Runs after every node and edge exists, in the
// order problems propagate: pods first, then what owns them, then the
// Services that route to them, then the Ingresses in front of those.
//
// Issues carry a code and parameters, never text: the frontend translates
// panels:resourceGraph.issue.<code>. Pod issues reuse the Pods list's own
// diagnosis (podWarnings) under a "pod." prefix, so the two screens never
// describe one pod differently.

const (
	levelWarn = "warn"
	levelErr  = "err"
)

// podWarningLevel: a pod that cannot run is an error; one that runs but
// recently crashed or fails readiness is a warning.
var podWarningLevel = map[string]string{
	"podReason":        levelErr,
	"unschedulable":    levelErr,
	"stuckTerminating": levelErr,
	"waiting":          levelErr,
	"failed":           levelErr,
	"recentCrash":      levelWarn,
	"notReady":         levelWarn,
}

func (b *graphBuilder) applyHealth(in *graphInputs) {
	edgeAt := map[string]int{}
	owners := map[string][]string{}   // child -> owners, along owner edges
	selected := map[string][]string{} // Service -> pods, along selector edges
	for i, e := range b.graph.Edges {
		edgeAt[e.ID] = i
		switch e.Kind {
		case "owner":
			owners[e.Target] = append(owners[e.Target], e.Source)
		case "selector":
			selected[e.Source] = append(selected[e.Source], e.Target)
		}
	}
	breakEdge := func(id string, is models.GraphIssue) {
		if i, ok := edgeAt[id]; ok && worse(&is, b.graph.Edges[i].Issue) {
			b.graph.Edges[i].Issue = &is
		}
	}

	// Pods.
	now := in.now
	if now.IsZero() {
		now = time.Now()
	}
	pods := map[string]*corev1.Pod{}
	ready := map[string]bool{}
	failing := map[string]bool{}
	for i := range in.pods {
		p := &in.pods[i]
		id := resourceID("Pod", p.Namespace, p.Name)
		pods[id] = p
		ready[id] = podReady(p)
		for _, w := range podWarnings(*p, now) {
			level := podWarningLevel[w.Code]
			if level == "" {
				level = levelWarn
			}
			if level == levelErr {
				failing[id] = true
			}
			b.issue(id, models.GraphIssue{Level: level, Code: "pod." + w.Code, Params: nonEmpty(map[string]string{
				"reason": w.Reason, "container": w.Container,
			})})
		}
	}

	// Controllers: every owner up the chain of a failing pod.
	failingUnder := map[string]int{}
	for pod := range failing {
		seen := map[string]bool{}
		queue := append([]string{}, owners[pod]...)
		for len(queue) > 0 {
			o := queue[0]
			queue = queue[1:]
			if seen[o] {
				continue
			}
			seen[o] = true
			failingUnder[o]++
			queue = append(queue, owners[o]...)
		}
	}
	for id, n := range failingUnder {
		b.issue(id, models.GraphIssue{Level: levelWarn, Code: "podsFailing", Params: map[string]string{"count": fmt.Sprint(n)}})
	}

	// Services: a selector that matches nothing, endpoints that are not
	// ready, a named targetPort no selected pod declares.
	svcByID := map[string]*corev1.Service{}
	for i := range in.services {
		svc := &in.services[i]
		id := resourceID("Service", svc.Namespace, svc.Name)
		svcByID[id] = svc
		if len(svc.Spec.Selector) == 0 || svc.Spec.Type == corev1.ServiceTypeExternalName {
			continue // endpoints managed by hand, or no endpoints at all
		}
		targets := selected[id]
		readyN := 0
		for _, pod := range targets {
			if ready[pod] {
				readyN++
			}
		}
		switch {
		case len(targets) == 0:
			b.issue(id, models.GraphIssue{Level: levelErr, Code: "noMatchingPods"})
		case readyN == 0:
			b.issue(id, models.GraphIssue{Level: levelErr, Code: "noReadyEndpoints"})
		case readyN < len(targets):
			b.issue(id, models.GraphIssue{Level: levelWarn, Code: "someNotReady",
				Params: map[string]string{"ready": fmt.Sprint(readyN), "total": fmt.Sprint(len(targets))}})
		}
		// Only a *named* targetPort is checked: a numeric one need not be
		// declared as a containerPort (that field is informational), so
		// flagging it would be a false alarm. A name has to resolve, or the
		// pod is left out of the endpoints.
		for _, sp := range svc.Spec.Ports {
			if sp.TargetPort.Type != intstr.String || sp.TargetPort.StrVal == "" {
				continue
			}
			name := sp.TargetPort.StrVal
			for _, podID := range targets {
				if p := pods[podID]; p != nil && !declaresPort(p, name) {
					is := models.GraphIssue{Level: levelErr, Code: "targetPortMissing", Params: map[string]string{"port": name}}
					b.issue(id, is)
					breakEdge(id+"->"+podID, is)
				}
			}
		}
	}

	// Ingresses inherit the health of their backends.
	level := func(id string) string {
		i, ok := b.index[id]
		if !ok {
			return levelErr
		}
		return worstIssue(b.graph.Nodes[i].Issues).Level
	}
	for _, ing := range in.ingresses {
		id := resourceID("Ingress", ing.Namespace, ing.Name)
		backends := map[string]string{} // Service id -> worst level seen
		for _, be := range ingressBackends(ing.Spec) {
			svcID := resourceID("Service", ing.Namespace, be.Name)
			l := level(svcID)
			if svc := svcByID[svcID]; svc != nil && !servicePortExists(svc, be.Port) {
				port := be.Port.Name
				if port == "" {
					port = fmt.Sprint(be.Port.Number)
				}
				is := models.GraphIssue{Level: levelErr, Code: "ingressPortMissing", Params: map[string]string{"service": be.Name, "port": port}}
				b.issue(id, is)
				breakEdge(id+"->"+svcID, is)
				l = levelErr
			}
			if rank(l) > rank(backends[svcID]) || backends[svcID] == "" {
				backends[svcID] = l
			}
		}
		bad, down := 0, 0
		for _, l := range backends {
			if l == levelErr {
				down++
			}
			if l != "" {
				bad++
			}
		}
		switch {
		case len(backends) > 0 && down == len(backends):
			b.issue(id, models.GraphIssue{Level: levelErr, Code: "backendsDown"})
		case bad > 0:
			b.issue(id, models.GraphIssue{Level: levelWarn, Code: "backendsDegraded"})
		}
	}

	// Storage.
	for _, pvc := range in.pvcs {
		id := resourceID("PersistentVolumeClaim", pvc.Namespace, pvc.Name)
		switch pvc.Status.Phase {
		case corev1.ClaimPending:
			b.issue(id, models.GraphIssue{Level: levelWarn, Code: "pvcPending"})
		case corev1.ClaimLost:
			b.issue(id, models.GraphIssue{Level: levelErr, Code: "pvcLost"})
		}
	}
	for _, pv := range in.pvs {
		id := resourceID("PersistentVolume", "", pv.Name)
		switch pv.Status.Phase {
		case corev1.VolumeReleased:
			b.issue(id, models.GraphIssue{Level: levelWarn, Code: "pvReleased"})
		case corev1.VolumeFailed:
			b.issue(id, models.GraphIssue{Level: levelErr, Code: "pvFailed"})
		}
	}

	b.eventIssues(in.events, now)

	// Worst first, so the frontend can show issues[0] on the box.
	for i := range b.graph.Nodes {
		issues := b.graph.Nodes[i].Issues
		sort.SliceStable(issues, func(a, c int) bool { return rank(issues[a].Level) > rank(issues[c].Level) })
	}
}

func podReady(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func declaresPort(p *corev1.Pod, name string) bool {
	for _, c := range p.Spec.Containers {
		for _, cp := range c.Ports {
			if cp.Name == name {
				return true
			}
		}
	}
	return false
}

func ingressBackends(spec networkingv1.IngressSpec) []networkingv1.IngressServiceBackend {
	var out []networkingv1.IngressServiceBackend
	if spec.DefaultBackend != nil && spec.DefaultBackend.Service != nil {
		out = append(out, *spec.DefaultBackend.Service)
	}
	for _, rule := range spec.Rules {
		if rule.HTTP == nil {
			continue
		}
		for _, path := range rule.HTTP.Paths {
			if path.Backend.Service != nil {
				out = append(out, *path.Backend.Service)
			}
		}
	}
	return out
}

// servicePortExists: an Ingress backend names a Service port by number or by
// name; either must match one of the Service's ports.
func servicePortExists(svc *corev1.Service, port networkingv1.ServiceBackendPort) bool {
	for _, sp := range svc.Spec.Ports {
		if (port.Name != "" && sp.Name == port.Name) || (port.Name == "" && sp.Port == port.Number) {
			return true
		}
	}
	return false
}

func rank(level string) int {
	switch level {
	case levelErr:
		return 2
	case levelWarn:
		return 1
	}
	return 0
}

// worse reports whether a is a more severe issue than b (nil is none).
func worse(a, b *models.GraphIssue) bool {
	if a == nil {
		return false
	}
	return b == nil || rank(a.Level) > rank(b.Level)
}

// worstIssue is the most severe issue, or the zero issue when there is none.
func worstIssue(issues []models.GraphIssue) models.GraphIssue {
	var w models.GraphIssue
	for _, is := range issues {
		if rank(is.Level) > rank(w.Level) {
			w = is
		}
	}
	return w
}

func nonEmpty(m map[string]string) map[string]string {
	for k, v := range m {
		if v == "" {
			delete(m, k)
		}
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

// eventWindow: how far back a Warning event still says something about the
// object now. A BackOff from yesterday is history, not health.
const eventWindow = 15 * time.Minute

// maxEventMessage caps the message carried to the frontend; it is shown in a
// tooltip, and a few events carry whole stack traces.
const maxEventMessage = 300

// eventIssues: recent Warning events, one issue per drawn object — how many
// there were, and the reason and message of the latest. An event about an
// object the graph does not draw (a Node, an HPA) is dropped.
func (b *graphBuilder) eventIssues(events []corev1.Event, now time.Time) {
	type summary struct {
		count  int32
		last   time.Time
		reason string
		msg    string
	}
	byNode := map[string]*summary{}
	var order []string
	for i := range events {
		ev := &events[i]
		last := eventTime(ev)
		if last.IsZero() || now.Sub(last) > eventWindow {
			continue
		}
		obj := ev.InvolvedObject
		id := resourceID(obj.Kind, obj.Namespace, obj.Name)
		at, ok := b.index[id]
		if !ok || b.graph.Nodes[at].Missing {
			continue
		}
		count := ev.Count
		if ev.Series != nil && ev.Series.Count > count {
			count = ev.Series.Count
		}
		if count < 1 {
			count = 1
		}
		s := byNode[id]
		if s == nil {
			s = &summary{}
			byNode[id] = s
			order = append(order, id)
		}
		s.count += count
		if !last.Before(s.last) {
			s.last, s.reason, s.msg = last, ev.Reason, ev.Message
		}
	}
	for _, id := range order {
		s := byNode[id]
		msg := s.msg
		if r := []rune(msg); len(r) > maxEventMessage {
			msg = string(r[:maxEventMessage]) + "…"
		}
		b.issue(id, models.GraphIssue{Level: levelWarn, Code: "recentWarnings", Params: nonEmpty(map[string]string{
			"count": fmt.Sprint(s.count), "reason": s.reason, "message": msg,
		})})
	}
}

// eventTime is when an event last happened: the series' last observation, the
// legacy lastTimestamp, or the events.k8s.io eventTime, whichever is set.
func eventTime(ev *corev1.Event) time.Time {
	t := ev.LastTimestamp.Time
	if ev.Series != nil && ev.Series.LastObservedTime.After(t) {
		t = ev.Series.LastObservedTime.Time
	}
	if ev.EventTime.After(t) {
		t = ev.EventTime.Time
	}
	if t.IsZero() {
		t = ev.FirstTimestamp.Time
	}
	return t
}
