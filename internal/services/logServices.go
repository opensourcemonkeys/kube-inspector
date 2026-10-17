package services_k8sclient

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"unicode/utf8"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"kube-ins/internal/models"
	"kube-ins/internal/safego"
)

type logSession struct {
	cancel context.CancelFunc
}

var (
	logMu       sync.Mutex
	logSessions = make(map[string]*logSession)
)

func GetPodContainers(namespace, name string, client *kubernetes.Clientset) ([]string, error) {
	pod, err := client.CoreV1().Pods(namespace).Get(context.TODO(), name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(pod.Spec.Containers))
	for _, c := range pod.Spec.Containers {
		names = append(names, c.Name)
	}
	return names, nil
}

// GetPodLogContainers lists every container of a pod that has a log: init,
// regular and ephemeral (debug) containers, in that order. GetPodContainers
// stays regular-only because exec uses it, and an init container has
// usually exited by the time anyone wants a shell in it.
func GetPodLogContainers(namespace, name string, client *kubernetes.Clientset) ([]models.LogContainerInfo, error) {
	pod, err := client.CoreV1().Pods(namespace).Get(context.TODO(), name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]models.LogContainerInfo, 0,
		len(pod.Spec.InitContainers)+len(pod.Spec.Containers)+len(pod.Spec.EphemeralContainers))
	for _, c := range pod.Spec.InitContainers {
		out = append(out, models.LogContainerInfo{Name: c.Name, Kind: "init"})
	}
	for _, c := range pod.Spec.Containers {
		out = append(out, models.LogContainerInfo{Name: c.Name, Kind: "container"})
	}
	for _, c := range pod.Spec.EphemeralContainers {
		out = append(out, models.LogContainerInfo{Name: c.Name, Kind: "ephemeral"})
	}
	return out, nil
}

func GetDeploymentPods(namespace, name string, client *kubernetes.Clientset) ([]string, error) {
	dep, err := client.AppsV1().Deployments(namespace).Get(context.TODO(), name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if dep.Spec.Selector == nil {
		return nil, fmt.Errorf("deployment %s/%s has no selector", namespace, name)
	}
	return podsByLabelSelector(namespace, dep.Spec.Selector, client)
}

func GetStatefulSetPods(namespace, name string, client *kubernetes.Clientset) ([]string, error) {
	ss, err := client.AppsV1().StatefulSets(namespace).Get(context.TODO(), name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if ss.Spec.Selector == nil {
		return nil, fmt.Errorf("statefulset %s/%s has no selector", namespace, name)
	}
	return podsByLabelSelector(namespace, ss.Spec.Selector, client)
}

func GetReplicaSetPods(namespace, name string, client *kubernetes.Clientset) ([]string, error) {
	rs, err := client.AppsV1().ReplicaSets(namespace).Get(context.TODO(), name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if rs.Spec.Selector == nil {
		return nil, fmt.Errorf("replicaset %s/%s has no selector", namespace, name)
	}
	return podsByLabelSelector(namespace, rs.Spec.Selector, client)
}

func GetDaemonSetPods(namespace, name string, client *kubernetes.Clientset) ([]string, error) {
	ds, err := client.AppsV1().DaemonSets(namespace).Get(context.TODO(), name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if ds.Spec.Selector == nil {
		return nil, fmt.Errorf("daemonset %s/%s has no selector", namespace, name)
	}
	return podsByLabelSelector(namespace, ds.Spec.Selector, client)
}

func GetJobPods(namespace, name string, client *kubernetes.Clientset) ([]string, error) {
	pods, err := client.CoreV1().Pods(namespace).List(context.TODO(), metav1.ListOptions{
		LabelSelector: "batch.kubernetes.io/job-name=" + name,
	})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(pods.Items))
	for _, p := range pods.Items {
		names = append(names, p.Name)
	}
	return names, nil
}

func GetCronJobPods(namespace, name string, client *kubernetes.Clientset) ([]string, error) {
	jobs, err := client.BatchV1().Jobs(namespace).List(context.TODO(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	var podNames []string
	for _, job := range jobs.Items {
		if !ownedByCronJob(job.OwnerReferences, name) {
			continue
		}
		jobPods, err := client.CoreV1().Pods(namespace).List(context.TODO(), metav1.ListOptions{
			LabelSelector: "batch.kubernetes.io/job-name=" + job.Name,
		})
		if err != nil {
			continue
		}
		for _, p := range jobPods.Items {
			podNames = append(podNames, p.Name)
		}
	}
	return podNames, nil
}

func ownedByCronJob(refs []metav1.OwnerReference, cronJobName string) bool {
	for _, ref := range refs {
		if ref.Kind == "CronJob" && ref.Name == cronJobName {
			return true
		}
	}
	return false
}

// labelSelectorString renders matchLabels as an equality selector. Shared with
// the port-forward target resolver, which needs the same selector but the pod
// objects rather than their names.
func labelSelectorString(matchLabels map[string]string) string {
	parts := make([]string, 0, len(matchLabels))
	for k, v := range matchLabels {
		parts = append(parts, fmt.Sprintf("%s=%s", k, v))
	}
	return strings.Join(parts, ",")
}

// podsByLabelSelector honours the whole selector, matchExpressions included:
// rendering only matchLabels listed pods the workload does not own whenever
// it narrowed its selector with an expression.
func podsByLabelSelector(namespace string, selector *metav1.LabelSelector, client *kubernetes.Clientset) ([]string, error) {
	sel, err := metav1.LabelSelectorAsSelector(selector)
	if err != nil {
		return nil, fmt.Errorf("invalid selector: %w", err)
	}
	pods, err := client.CoreV1().Pods(namespace).List(context.TODO(), metav1.ListOptions{
		LabelSelector: sel.String(),
	})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(pods.Items))
	for _, p := range pods.Items {
		names = append(names, p.Name)
	}
	return names, nil
}

// StartLogStream streams one container's log to onData until the stream ends
// or StopLogStream is called. onClose fires when the stream ends on its own —
// the pod was deleted, the container restarted, a Previous log was read to the
// end — with "" for a clean end or the read error. It does not fire after
// StopLogStream, nor when a newer stream has taken over the same session id:
// the event is keyed by session id alone, so firing it then would report the
// replacement as dead.
func StartLogStream(sessionId, namespace, podName, container string, opts models.LogStreamOptions, client *kubernetes.Clientset, onData func(string), onClose func(reason string)) error {
	ctx, cancel := context.WithCancel(context.Background())
	s := &logSession{cancel: cancel}

	logMu.Lock()
	if existing, ok := logSessions[sessionId]; ok {
		existing.cancel()
	}
	logSessions[sessionId] = s
	logMu.Unlock()

	logOpts := &corev1.PodLogOptions{
		Container:  container,
		Follow:     !opts.Previous,
		Previous:   opts.Previous,
		Timestamps: opts.Timestamps,
	}
	if opts.TailLines > 0 {
		tail := opts.TailLines
		logOpts.TailLines = &tail
	}
	if opts.SinceSeconds > 0 {
		since := opts.SinceSeconds
		logOpts.SinceSeconds = &since
	}

	stream, err := client.CoreV1().Pods(namespace).GetLogs(podName, logOpts).Stream(ctx)
	if err != nil {
		cancel()
		releaseLogSession(sessionId, s)
		return fmt.Errorf("failed to open log stream: %w", err)
	}

	safego.Go("services.log.stream", func() {
		err := pumpLogStream(ctx, stream, onData)
		stream.Close()
		cancel()
		if releaseLogSession(sessionId, s) && onClose != nil {
			reason := ""
			if err != nil {
				reason = err.Error()
			}
			onClose(reason)
		}
	})

	return nil
}

// releaseLogSession removes s from the registry if it still owns sessionId,
// and reports whether it did. Deleting by key alone would remove a newer
// stream that reused the id.
func releaseLogSession(sessionId string, s *logSession) bool {
	logMu.Lock()
	defer logMu.Unlock()
	if logSessions[sessionId] != s {
		return false
	}
	delete(logSessions, sessionId)
	return true
}

const (
	logReadSize = 32 * 1024
	// logMaxPending bounds a partial line held back waiting for its newline.
	// A longer line is passed on in pieces rather than buffered without limit.
	logMaxPending = 64 * 1024
)

// pumpLogStream copies r to emit in chunks that end on a line boundary, so a
// burst of output is one event rather than one per line — which matters once
// a panel follows every pod of a workload at once. It used to be a
// bufio.Scanner with a 64KB limit, which ended the stream — silently — on the
// first longer line. A line longer than logMaxPending is emitted in pieces cut
// on a rune boundary, so a piece is always valid UTF-8. Returns nil on EOF or
// cancellation, the read error otherwise.
func pumpLogStream(ctx context.Context, r io.Reader, emit func(string)) error {
	buf := make([]byte, logReadSize)
	var pending []byte
	for {
		n, err := r.Read(buf)
		if ctx.Err() != nil {
			return nil
		}
		if n > 0 {
			pending = append(pending, buf[:n]...)
			if i := bytes.LastIndexByte(pending, '\n'); i >= 0 {
				emit(string(pending[:i+1]))
				pending = append(pending[:0], pending[i+1:]...)
			} else if len(pending) >= logMaxPending {
				cut := runeBoundary(pending)
				emit(string(pending[:cut]))
				pending = append(pending[:0], pending[cut:]...)
			}
		}
		if err != nil {
			if len(pending) > 0 {
				emit(string(pending))
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

// runeBoundary returns the length of the longest prefix of b that does not
// end in the middle of a multi-byte rune.
func runeBoundary(b []byte) int {
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
		if utf8.RuneStart(b[i]) {
			if utf8.FullRune(b[i:]) {
				return len(b)
			}
			return i
		}
	}
	return len(b)
}

// GetPodLogsTail fetches the last `tail` lines of a pod/container's logs in a
// single (non-streaming) read. Used by the AI assistant's get_pod_logs tool.
func GetPodLogsTail(namespace, podName, container string, tail int64, client *kubernetes.Clientset) (string, error) {
	if tail <= 0 {
		tail = 200
	}
	req := client.CoreV1().Pods(namespace).GetLogs(podName, &corev1.PodLogOptions{
		Container: container,
		TailLines: &tail,
	})
	stream, err := req.Stream(context.Background())
	if err != nil {
		return "", fmt.Errorf("failed to read logs: %w", err)
	}
	defer stream.Close()

	var sb strings.Builder
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		sb.WriteString(scanner.Text())
		sb.WriteByte('\n')
	}
	return sb.String(), nil
}

func StopLogStream(sessionId string) {
	logMu.Lock()
	defer logMu.Unlock()
	if s, ok := logSessions[sessionId]; ok {
		s.cancel()
		delete(logSessions, sessionId)
	}
}
