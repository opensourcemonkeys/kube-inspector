package services_k8sclient

import (
	"context"
	"fmt"
	"kube-ins/internal/models"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

type podLiveUsage struct{ cpu, mem int64 }

func GetPods(namespace string, repoK8sClient *kubernetes.Clientset, mc *metricsclient.Clientset) ([]models.PodInfo, error) {

	pods, err := repoK8sClient.CoreV1().Pods(namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	// ReplicaSet -> Deployment map so pods roll up to their Deployment.
	rsToDeploy := map[string]string{}
	if rsl, e := repoK8sClient.AppsV1().ReplicaSets("").List(context.Background(), metav1.ListOptions{}); e == nil {
		for _, rs := range rsl.Items {
			if owner := controllerRef(rs.OwnerReferences); owner != nil && owner.Kind == "Deployment" {
				rsToDeploy[rs.Namespace+"/"+rs.Name] = owner.Name
			}
		}
	}

	// Live per-pod usage from metrics-server, keyed by namespace/name.
	metricsAvailable := false
	podUsage := map[string]podLiveUsage{}
	if mc != nil {
		if pm, e := mc.MetricsV1beta1().PodMetricses("").List(context.Background(), metav1.ListOptions{}); e == nil {
			metricsAvailable = true
			for _, p := range pm.Items {
				var u podLiveUsage
				for _, c := range p.Containers {
					u.cpu += c.Usage.Cpu().MilliValue()
					u.mem += c.Usage.Memory().Value() / miDivisor
				}
				podUsage[p.Namespace+"/"+p.Name] = u
			}
		}
	}

	podInfos := make([]models.PodInfo, 0, len(pods.Items))
	for _, pod := range pods.Items {
		podInfos = append(podInfos, podToInfo(pod, rsToDeploy, podUsage, metricsAvailable))
	}

	return podInfos, nil
}

func DeletePod(namespace string, name string, repoK8sClient *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return fmt.Errorf("namespace and pod name are required")
	}

	return repoK8sClient.CoreV1().Pods(namespace).Delete(context.Background(), name, metav1.DeleteOptions{})
}

func GetPodYaml(namespace string, name string, repoK8sClient *kubernetes.Clientset) (string, error) {
	if namespace == "" || name == "" {
		return "", fmt.Errorf("namespace and pod name are required")
	}

	pod, err := repoK8sClient.CoreV1().Pods(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}

	return toApplyYaml(pod)
}

func podToInfo(pod corev1.Pod, rsToDeploy map[string]string, podUsage map[string]podLiveUsage, metricsAvailable bool) models.PodInfo {
	containers := make([]string, 0, len(pod.Spec.Containers))
	for _, c := range pod.Spec.Containers {
		containers = append(containers, c.Name)
	}

	// Per-container live status: init containers first, then regular ones (kubectl order).
	containerStatuses := make([]models.ContainerStatusInfo, 0, len(pod.Status.InitContainerStatuses)+len(pod.Status.ContainerStatuses))
	var restarts int32
	var lastRestartAt time.Time
	for _, cs := range pod.Status.InitContainerStatuses {
		info := mapContainerStatus(cs, true)
		containerStatuses = append(containerStatuses, info)
		restarts += cs.RestartCount
		lastRestartAt = latestRestart(lastRestartAt, info.LastRestartAt)
	}
	for _, cs := range pod.Status.ContainerStatuses {
		info := mapContainerStatus(cs, false)
		containerStatuses = append(containerStatuses, info)
		restarts += cs.RestartCount
		lastRestartAt = latestRestart(lastRestartAt, info.LastRestartAt)
	}

	ownerKind, _ := resolveOwner(pod.OwnerReferences, pod.Namespace, rsToDeploy)

	cpuUsage, memUsage := int64(-1), int64(-1)
	if metricsAvailable {
		if u, ok := podUsage[pod.Namespace+"/"+pod.Name]; ok {
			cpuUsage, memUsage = u.cpu, u.mem
		} else {
			cpuUsage, memUsage = 0, 0
		}
	}

	lastRestartAtStr := ""
	if !lastRestartAt.IsZero() {
		lastRestartAtStr = lastRestartAt.Format(time.RFC3339)
	}

	readyCount, totalCount := readyCounts(pod)

	return models.PodInfo{
		Name:              pod.Name,
		ReadyCount:        readyCount,
		TotalCount:        totalCount,
		NodeName:          pod.Spec.NodeName,
		Namespace:         pod.Namespace,
		Status:            getPodStatus(pod),
		Warnings:          podWarnings(pod, time.Now()),
		Containers:        containers,
		ContainerStatuses: containerStatuses,
		Restarts:          restarts,
		LastRestartAt:     lastRestartAtStr,
		CreatedAt:         pod.CreationTimestamp.Time.Format(time.RFC3339),
		PodIP:             pod.Status.PodIP,
		OwnerKind:         ownerKind,
		CpuMillis:         cpuUsage,
		MemMi:             memUsage,
	}
}

// latestRestart returns the later of the running max and a container's
// LastRestartAt (RFC3339, "" if the container never restarted).
func latestRestart(max time.Time, candidate string) time.Time {
	if candidate == "" {
		return max
	}
	t, err := time.Parse(time.RFC3339, candidate)
	if err != nil || t.Before(max) {
		return max
	}
	return t
}

// getPodStatus mirrors kubectl's STATUS column (printPod in
// k8s.io/kubernetes/pkg/printers/internalversion): the phase alone says
// "Running" for a pod whose only container is in CrashLoopBackOff, so the most
// telling init/container reason wins over it.
func getPodStatus(pod corev1.Pod) models.PodStatus {
	if pod.DeletionTimestamp != nil {
		if pod.Status.Reason == "NodeLost" {
			return "Unknown"
		}
		return models.PodStatusTerminating
	}

	reason := string(pod.Status.Phase)
	if pod.Status.Reason != "" {
		reason = pod.Status.Reason // Evicted, NodeAffinity, ...
	}

	sidecars := map[string]bool{}
	for _, c := range pod.Spec.InitContainers {
		if c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways {
			sidecars[c.Name] = true
		}
	}

	initializing := false
	for i, cs := range pod.Status.InitContainerStatuses {
		switch {
		case cs.State.Terminated != nil && cs.State.Terminated.ExitCode == 0:
			continue
		case sidecars[cs.Name] && cs.Started != nil && *cs.Started:
			// A native sidecar that has started is doing its job, not blocking init.
			continue
		case cs.State.Terminated != nil:
			if cs.State.Terminated.Reason != "" {
				reason = "Init:" + cs.State.Terminated.Reason
			} else {
				reason = fmt.Sprintf("Init:ExitCode:%d", cs.State.Terminated.ExitCode)
			}
		case cs.State.Waiting != nil && cs.State.Waiting.Reason != "" && cs.State.Waiting.Reason != "PodInitializing":
			reason = "Init:" + cs.State.Waiting.Reason
		default:
			reason = fmt.Sprintf("Init:%d/%d", i, len(pod.Spec.InitContainers))
		}
		initializing = true
		break
	}

	if !initializing {
		hasRunning := false
		// Reverse order, like kubectl, so the first container's reason wins.
		for i := len(pod.Status.ContainerStatuses) - 1; i >= 0; i-- {
			cs := pod.Status.ContainerStatuses[i]
			switch {
			case cs.State.Waiting != nil && cs.State.Waiting.Reason != "":
				reason = cs.State.Waiting.Reason
			case cs.State.Terminated != nil && cs.State.Terminated.Reason != "":
				reason = cs.State.Terminated.Reason
			case cs.State.Terminated != nil:
				reason = fmt.Sprintf("ExitCode:%d", cs.State.Terminated.ExitCode)
			case cs.Ready && cs.State.Running != nil:
				hasRunning = true
			}
		}
		// Some containers finished, others still serve: the pod is running.
		if reason == "Completed" && hasRunning {
			reason = string(corev1.PodRunning)
		}
	}

	return models.PodStatus(reason)
}

// How long a container may run without passing readiness before it is flagged,
// how recent a crash must be to still count, and how far past its deletion
// deadline a terminating pod may go before it is called stuck.
const (
	notReadyGrace       = 30 * time.Second
	recentCrashWindow   = time.Hour
	stuckTerminateGrace = time.Minute
)

// benignWaiting are waiting reasons that mean "on its way", not "broken".
var benignWaiting = map[string]bool{"": true, "ContainerCreating": true, "PodInitializing": true}

// podWarnings lists why a pod is not running healthily. Codes:
//
//	podReason        pod-level reason set by the kubelet/controller (Evicted, NodeLost, ...)
//	unschedulable    PodScheduled=False
//	stuckTerminating deletion deadline passed a minute ago and the pod is still here
//	waiting          container waiting on a fault (CrashLoopBackOff, ImagePullBackOff, ...)
//	failed           container terminated with a non-zero exit
//	recentCrash      container restarted within the last hour after a failure (OOMKilled, Error)
//	notReady         container running for a while but failing readiness
func podWarnings(pod corev1.Pod, now time.Time) []models.PodWarning {
	warnings := []models.PodWarning{}
	succeeded := pod.Status.Phase == corev1.PodSucceeded

	if pod.Status.Reason != "" {
		warnings = append(warnings, models.PodWarning{Code: "podReason", Reason: pod.Status.Reason, Message: pod.Status.Message})
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse {
			warnings = append(warnings, models.PodWarning{Code: "unschedulable", Reason: c.Reason, Message: c.Message})
		}
	}
	if dt := pod.DeletionTimestamp; dt != nil && now.Sub(dt.Time) > stuckTerminateGrace {
		warnings = append(warnings, models.PodWarning{Code: "stuckTerminating"})
	}

	check := func(cs corev1.ContainerStatus, init bool) {
		switch {
		case cs.State.Waiting != nil && !benignWaiting[cs.State.Waiting.Reason]:
			warnings = append(warnings, models.PodWarning{Code: "waiting", Container: cs.Name, Reason: cs.State.Waiting.Reason, Message: cs.State.Waiting.Message})
		case cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0:
			t := cs.State.Terminated
			msg := t.Message
			if msg == "" {
				msg = fmt.Sprintf("exit code %d", t.ExitCode)
			}
			warnings = append(warnings, models.PodWarning{Code: "failed", Container: cs.Name, Reason: t.Reason, Message: msg})
		case !init && !succeeded && pod.DeletionTimestamp == nil && cs.State.Running != nil && !cs.Ready &&
			now.Sub(cs.State.Running.StartedAt.Time) > notReadyGrace:
			warnings = append(warnings, models.PodWarning{Code: "notReady", Container: cs.Name})
		}
		if last := cs.LastTerminationState.Terminated; last != nil && last.ExitCode != 0 &&
			now.Sub(last.FinishedAt.Time) < recentCrashWindow {
			warnings = append(warnings, models.PodWarning{Code: "recentCrash", Container: cs.Name, Reason: last.Reason, Message: fmt.Sprintf("exit code %d", last.ExitCode)})
		}
	}
	for _, cs := range pod.Status.InitContainerStatuses {
		check(cs, true)
	}
	for _, cs := range pod.Status.ContainerStatuses {
		check(cs, false)
	}
	return warnings
}

// readyCounts is kubectl's READY column: ready / total regular containers.
func readyCounts(pod corev1.Pod) (ready, total int32) {
	total = int32(len(pod.Spec.Containers))
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Ready {
			ready++
		}
	}
	return ready, total
}

// mapContainerStatus flattens a k8s ContainerStatus into the frontend model,
// resolving the current State ("Running"/"Waiting"/"Terminated") and its reason.
func mapContainerStatus(cs corev1.ContainerStatus, init bool) models.ContainerStatusInfo {
	info := models.ContainerStatusInfo{
		Name:         cs.Name,
		Ready:        cs.Ready,
		RestartCount: cs.RestartCount,
		Init:         init,
	}
	switch {
	case cs.State.Running != nil:
		info.State = "Running"
	case cs.State.Waiting != nil:
		info.State = "Waiting"
		info.Reason = cs.State.Waiting.Reason
	case cs.State.Terminated != nil:
		info.State = "Terminated"
		info.Reason = cs.State.Terminated.Reason
	}

	switch {
	case cs.LastTerminationState.Terminated != nil:
		info.LastRestartAt = cs.LastTerminationState.Terminated.FinishedAt.Time.Format(time.RFC3339)
	case cs.RestartCount > 0 && cs.State.Running != nil:
		// kubelet can drop LastTerminationState after a while; the current
		// container's start time is still a reasonable stand-in.
		info.LastRestartAt = cs.State.Running.StartedAt.Time.Format(time.RFC3339)
	}
	return info
}
