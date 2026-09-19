package services_k8sclient

import (
	"fmt"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func running(ready bool) corev1.ContainerStatus {
	return corev1.ContainerStatus{Ready: ready, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}
}

func waiting(reason string) corev1.ContainerStatus {
	return corev1.ContainerStatus{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}}
}

func terminated(reason string, code int32) corev1.ContainerStatus {
	return corev1.ContainerStatus{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: reason, ExitCode: code}}}
}

func TestGetPodStatus(t *testing.T) {
	now := metav1.Now()
	always := corev1.ContainerRestartPolicyAlways
	started := true

	cases := []struct {
		name string
		pod  corev1.Pod
		want string
	}{
		{
			name: "running",
			pod: corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning,
				ContainerStatuses: []corev1.ContainerStatus{running(true)}}},
			want: "Running",
		},
		{
			name: "crashloop hides behind Running phase",
			pod: corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning,
				ContainerStatuses: []corev1.ContainerStatus{running(true), waiting("CrashLoopBackOff")}}},
			want: "CrashLoopBackOff",
		},
		{
			name: "image pull failure while pending",
			pod: corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodPending,
				ContainerStatuses: []corev1.ContainerStatus{waiting("ImagePullBackOff")}}},
			want: "ImagePullBackOff",
		},
		{
			name: "init container still running",
			pod: corev1.Pod{
				Spec: corev1.PodSpec{InitContainers: []corev1.Container{{Name: "a"}, {Name: "b"}}},
				Status: corev1.PodStatus{Phase: corev1.PodPending,
					InitContainerStatuses: []corev1.ContainerStatus{terminated("Completed", 0), running(false)},
					ContainerStatuses:     []corev1.ContainerStatus{waiting("PodInitializing")}}},
			want: "Init:1/2",
		},
		{
			name: "init container crashing",
			pod: corev1.Pod{
				Spec: corev1.PodSpec{InitContainers: []corev1.Container{{Name: "a"}}},
				Status: corev1.PodStatus{Phase: corev1.PodPending,
					InitContainerStatuses: []corev1.ContainerStatus{waiting("CrashLoopBackOff")}}},
			want: "Init:CrashLoopBackOff",
		},
		{
			name: "started native sidecar does not block",
			pod: corev1.Pod{
				Spec: corev1.PodSpec{InitContainers: []corev1.Container{{Name: "proxy", RestartPolicy: &always}}},
				Status: corev1.PodStatus{Phase: corev1.PodRunning,
					InitContainerStatuses: []corev1.ContainerStatus{func() corev1.ContainerStatus {
						cs := running(true)
						cs.Name, cs.Started = "proxy", &started
						return cs
					}()},
					ContainerStatuses: []corev1.ContainerStatus{running(true)}}},
			want: "Running",
		},
		{
			name: "job pod completed",
			pod: corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodSucceeded,
				ContainerStatuses: []corev1.ContainerStatus{terminated("Completed", 0)}}},
			want: "Completed",
		},
		{
			name: "one container done, another serving",
			pod: corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning,
				ContainerStatuses: []corev1.ContainerStatus{running(true), terminated("Completed", 0)}}},
			want: "Running",
		},
		{
			name: "terminated without reason",
			pod: corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodFailed,
				ContainerStatuses: []corev1.ContainerStatus{terminated("", 137)}}},
			want: "ExitCode:137",
		},
		{
			name: "evicted",
			pod:  corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodFailed, Reason: "Evicted"}},
			want: "Evicted",
		},
		{
			name: "terminating wins",
			pod: corev1.Pod{ObjectMeta: metav1.ObjectMeta{DeletionTimestamp: &now},
				Status: corev1.PodStatus{Phase: corev1.PodRunning,
					ContainerStatuses: []corev1.ContainerStatus{waiting("CrashLoopBackOff")}}},
			want: "Terminating",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(getPodStatus(tc.pod)); got != tc.want {
				t.Fatalf("getPodStatus() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestReadyCounts(t *testing.T) {
	pod := corev1.Pod{
		Spec: corev1.PodSpec{
			InitContainers: []corev1.Container{{Name: "init"}},
			Containers:     []corev1.Container{{Name: "a"}, {Name: "b"}, {Name: "c"}},
		},
		Status: corev1.PodStatus{
			InitContainerStatuses: []corev1.ContainerStatus{running(true)},
			ContainerStatuses:     []corev1.ContainerStatus{running(true), running(false)},
		},
	}
	ready, total := readyCounts(pod)
	if ready != 1 || total != 3 {
		t.Fatalf("readyCounts() = %d/%d, want 1/3", ready, total)
	}
}

func TestPodWarnings(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) metav1.Time { return metav1.NewTime(now.Add(-d)) }
	runningSince := func(ready bool, d time.Duration) corev1.ContainerStatus {
		return corev1.ContainerStatus{Name: "app", Ready: ready, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: ago(d)}}}
	}
	crashed := func(d time.Duration) corev1.ContainerStatus {
		cs := runningSince(true, time.Minute)
		cs.RestartCount = 1
		cs.LastTerminationState.Terminated = &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137, FinishedAt: ago(d)}
		return cs
	}
	deleting := ago(5 * time.Minute)
	deletingSoon := ago(10 * time.Second)

	cases := []struct {
		name string
		pod  corev1.Pod
		want []string
	}{
		{"healthy", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{runningSince(true, time.Hour)}}}, nil},
		{"container creating is benign", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodPending,
			ContainerStatuses: []corev1.ContainerStatus{waiting("ContainerCreating")}}}, nil},
		{"crashloop", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{waiting("CrashLoopBackOff")}}}, []string{"waiting"}},
		{"failed container", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodFailed,
			ContainerStatuses: []corev1.ContainerStatus{terminated("Error", 1)}}}, []string{"failed"}},
		{"completed is fine", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodSucceeded,
			ContainerStatuses: []corev1.ContainerStatus{terminated("Completed", 0)}}}, nil},
		{"not ready past grace", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{runningSince(false, time.Minute)}}}, []string{"notReady"}},
		{"not ready while warming up", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{runningSince(false, 5*time.Second)}}}, nil},
		{"recent crash", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{crashed(10 * time.Minute)}}}, []string{"recentCrash"}},
		{"old crash is forgotten", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{crashed(2 * time.Hour)}}}, nil},
		{"unschedulable", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodPending,
			Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable"}}}}, []string{"unschedulable"}},
		{"evicted", corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodFailed, Reason: "Evicted"}}, []string{"podReason"}},
		{"stuck terminating", corev1.Pod{ObjectMeta: metav1.ObjectMeta{DeletionTimestamp: &deleting},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{runningSince(false, time.Hour)}}}, []string{"stuckTerminating"}},
		{"terminating within grace", corev1.Pod{ObjectMeta: metav1.ObjectMeta{DeletionTimestamp: &deletingSoon},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{runningSince(false, time.Hour)}}}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			for _, w := range podWarnings(tc.pod, now) {
				got = append(got, w.Code)
			}
			if fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Errorf("podWarnings = %v, want %v", got, tc.want)
			}
		})
	}
}
