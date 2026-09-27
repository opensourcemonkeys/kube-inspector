package services_k8sclient

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"kube-ins/internal/logging"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// Kubernetes has no node-exec API, so a shell "on a node" is really a shell in a
// privileged helper pod pinned to that node which has then entered PID 1's
// namespaces. This is what kubectl debug, k9s and Lens all do.
const (
	nodeShellNamespace = "kube-system"
	nodeShellImage     = "alpine:latest"

	// Scheduling plus a cold image pull on a slow registry. Generous because the
	// alternative is telling the user the node is broken when it was just busy.
	nodeShellTimeout = 90 * time.Second
	nodeShellPoll    = time.Second

	// A backstop, not a feature: every normal exit deletes the pod, but a hard
	// crash of this process cannot, and a leaked pod here is host root.
	nodeShellDeadlineSeconds int64 = 8 * 60 * 60

	// Longer than the deadline above, so the container never exits on its own
	// and take the session with it. Plain seconds — busybox sleep does not
	// understand "infinity".
	nodeShellSleepSeconds = "86400"
)

// Short flags on purpose: busybox provides nsenter as an applet and its long
// options are not always compiled in. Entering the mount, uts, ipc, net and pid
// namespaces of PID 1 is what makes `ps`, `ss`, `systemctl` and the host's own
// binaries work — a chroot into the host filesystem would not.
//
// The profile is sourced by hand instead of running a login shell (`sh -l`),
// because a login shell is *interactive* and the host's profile may act on that.
// Fedora's /etc/profile.d/gnupg2.sh does exactly that: `case "$-" in *i*)
// export GPG_TTY=$(tty)`. After nsenter -m the exec's pty lives in the
// container's devpts instance, which no longer exists in the mount namespace we
// just entered, so `tty` fails and every session opened with
// "tty: ttyname error: No such device". Sourcing non-interactively skips those
// branches while still picking up what a root shell on a node actually needs —
// /usr/sbin and /sbin on PATH, and LANG — and `exec sh -i` then starts the
// interactive shell without re-reading the profile. stderr is dropped for the
// sourcing only, never for the shell.
var nodeShellCommand = []string{"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
	"sh", "-c", "[ -r /etc/profile ] && . /etc/profile 2>/dev/null; exec sh -i"}

type nodeShellSession struct {
	// kubernetes.Interface rather than the concrete *Clientset every other
	// service takes: deleting this pod exactly once is the invariant worth a
	// test, and a test needs a fake client to watch it happen.
	client  kubernetes.Interface
	podName string
	cancel  context.CancelFunc
}

var (
	nodeShellMu sync.Mutex
	nodeShells  = make(map[string]*nodeShellSession)
)

// releaseNodeShell removes id from the registry and deletes its helper pod.
//
// Same idiom as releaseExecSession: the map entry is the ownership token, so
// exactly one caller wins the delete and the pod is removed once no matter which
// path got here first — the panel closing, the remote shell exiting, or the
// setup below failing half-way. When want is non-nil the entry must still be
// that session, so a shell started later under the same id is left alone.
func releaseNodeShell(id string, want *nodeShellSession) bool {
	nodeShellMu.Lock()
	sess, ok := nodeShells[id]
	if ok && (want == nil || sess == want) {
		delete(nodeShells, id)
	} else {
		ok = false
	}
	nodeShellMu.Unlock()

	if !ok {
		return false
	}
	sess.cancel()
	if sess.podName == "" {
		// Cancelled before Create returned; the creator deletes it when it sees
		// it no longer owns the entry.
		return true
	}
	logging.With("services.nodeshell").Info("deleting node shell helper pod", "pod", sess.podName)
	deleteNodeShellPod(sess.client, sess.podName)
	return true
}

// deleteNodeShellPod runs on a context that is deliberately not the session's:
// the delete is usually triggered *by* that cancellation, and a privileged pod
// must not survive because the call that removes it was cancelled with it.
func deleteNodeShellPod(client kubernetes.Interface, podName string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), 30*time.Second)
	defer cancel()
	grace := int64(0)
	_ = client.CoreV1().Pods(nodeShellNamespace).Delete(ctx, podName, metav1.DeleteOptions{
		GracePeriodSeconds: &grace,
	})
}

// CreateNodeShellSession opens a root shell in the node's own namespaces.
//
// It blocks until the helper pod is running and the exec stream is up — pod
// scheduling and an image pull can take tens of seconds — and reports progress
// through onOutput so the terminal shows what it is waiting on rather than
// nothing. Once connected the session lives in the ordinary exec registry, so
// WriteToPodExecSession / ResizePodExecSession work on it unchanged.
func CreateNodeShellSession(id, nodeName string, onOutput func(string), onClosed func(), client *kubernetes.Clientset, config *rest.Config) error {
	releaseNodeShell(id, nil)

	say := func(format string, args ...any) {
		if onOutput != nil {
			onOutput(fmt.Sprintf(format, args...) + "\r\n")
		}
	}

	// Cheap existence check first: a node that is gone or misspelled otherwise
	// becomes a pod that silently never schedules.
	if _, err := client.CoreV1().Nodes().Get(context.TODO(), nodeName, metav1.GetOptions{}); err != nil {
		return fmt.Errorf("node %q: %w", nodeName, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	sess := &nodeShellSession{client: client, cancel: cancel}

	// Registered before the pod exists. A panel closed during the wait below has
	// to have something to cancel, and an entry that only appears once the pod
	// is Running leaks a privileged pod on every impatient close.
	nodeShellMu.Lock()
	nodeShells[id] = sess
	nodeShellMu.Unlock()

	say("Creating privileged helper pod on node %s (namespace %s, image %s)...", nodeName, nodeShellNamespace, nodeShellImage)

	created, err := client.CoreV1().Pods(nodeShellNamespace).Create(ctx, nodeShellPod(nodeName), metav1.CreateOptions{})
	if err != nil {
		releaseNodeShell(id, sess)
		return fmt.Errorf("create node shell pod on %q: %w", nodeName, err)
	}

	// Record the name so teardown can find the pod, unless we already lost the
	// entry while Create was in flight — then nothing else will ever delete it.
	nodeShellMu.Lock()
	stillOurs := nodeShells[id] == sess
	if stillOurs {
		sess.podName = created.Name
	}
	nodeShellMu.Unlock()
	if !stillOurs {
		deleteNodeShellPod(client, created.Name)
		return fmt.Errorf("node shell session %s was closed during startup", id)
	}

	logging.With("services.nodeshell").Info("created node shell helper pod",
		"node", nodeName, "pod", created.Name, "namespace", nodeShellNamespace, "image", nodeShellImage)

	say("Waiting for pod %s/%s to start...", nodeShellNamespace, created.Name)
	if err := waitForNodeShellPod(ctx, client, created.Name, say); err != nil {
		releaseNodeShell(id, sess)
		return err
	}

	say("Entering host namespaces on %s...", nodeName)
	err = startExecSession(id, nodeShellNamespace, created.Name, nodeShellContainer, nodeShellCommand, onOutput,
		func() {
			// The stream ended on its own. Drop the pod before telling the
			// frontend, so a user who reopens the tab immediately does not race
			// the cleanup.
			releaseNodeShell(id, sess)
			if onClosed != nil {
				onClosed()
			}
		}, client, config)
	if err != nil {
		releaseNodeShell(id, sess)
		return err
	}
	return nil
}

// CloseNodeShellSession tears down a node shell the caller opened. Deliberately
// silent about an unknown id: the frontend calls this from panel cleanup, which
// also runs for a session that never came up.
func CloseNodeShellSession(id string) error {
	releaseNodeShell(id, nil)
	return ClosePodExecSession(id)
}

// waitForNodeShellPod blocks until the pod is Running, or fails fast on a state
// that will not resolve — an image that cannot be pulled, a pod that cannot be
// scheduled, admission rejecting the privileged container. Waiting out the full
// timeout on any of those reads as a hang.
func waitForNodeShellPod(ctx context.Context, client *kubernetes.Clientset, podName string, say func(string, ...any)) error {
	lastNote := ""
	note := func(msg string) {
		if msg != "" && msg != lastNote {
			lastNote = msg
			say("  %s", msg)
		}
	}

	err := wait.PollUntilContextTimeout(ctx, nodeShellPoll, nodeShellTimeout, true, func(ctx context.Context) (bool, error) {
		pod, err := client.CoreV1().Pods(nodeShellNamespace).Get(ctx, podName, metav1.GetOptions{})
		if err != nil {
			return false, err
		}

		switch pod.Status.Phase {
		case corev1.PodRunning:
			return true, nil
		case corev1.PodFailed, corev1.PodSucceeded:
			return false, fmt.Errorf("helper pod %s: %s", pod.Status.Phase, firstNonEmpty(pod.Status.Reason, pod.Status.Message, "container exited during startup"))
		}

		for _, cond := range pod.Status.Conditions {
			if cond.Type == corev1.PodScheduled && cond.Status == corev1.ConditionFalse {
				if cond.Reason == corev1.PodReasonUnschedulable {
					return false, fmt.Errorf("helper pod cannot be scheduled on this node: %s", cond.Message)
				}
				note(cond.Message)
			}
		}

		for _, cs := range pod.Status.ContainerStatuses {
			w := cs.State.Waiting
			if w == nil {
				continue
			}
			if isTerminalWaitReason(w.Reason) {
				return false, fmt.Errorf("helper pod container %s: %s", w.Reason, w.Message)
			}
			note(w.Reason)
		}
		return false, nil
	})

	if err != nil {
		// wait.Interrupted covers both the deadline and our own cancellation, so
		// check the context first — otherwise a session the user closed after two
		// seconds is reported as a 90-second timeout.
		if ctxErr := ctx.Err(); ctxErr != nil {
			return fmt.Errorf("node shell cancelled while helper pod %s was starting", podName)
		}
		if wait.Interrupted(err) {
			return fmt.Errorf("helper pod %s did not start within %s", podName, nodeShellTimeout)
		}
		return err
	}
	return nil
}

// isTerminalWaitReason reports whether a container's Waiting reason is one the
// kubelet will keep reporting forever without help.
func isTerminalWaitReason(reason string) bool {
	switch reason {
	case "ErrImagePull", "ImagePullBackOff", "InvalidImageName",
		"CreateContainerError", "CreateContainerConfigError",
		"RunContainerError", "CrashLoopBackOff":
		return true
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

const nodeShellContainer = "shell"

func nodeShellPod(nodeName string) *corev1.Pod {
	privileged := true
	grace := int64(0)
	deadline := nodeShellDeadlineSeconds

	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			// GenerateName rather than a name built from the node: node names
			// routinely exceed the 63-character limit for a DNS label.
			GenerateName: "kube-ins-nodeshell-",
			Namespace:    nodeShellNamespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "kube-inspector",
				"kube-ins/node-shell":          "true",
			},
			Annotations: map[string]string{
				// The node name goes in an annotation, not the label above: it
				// is free-form and need not be a valid label value.
				"kube-ins/node": nodeName,
			},
		},
		Spec: corev1.PodSpec{
			// Pinned directly rather than via affinity, so a cordoned node —
			// exactly when a node shell is wanted — still gets the pod.
			NodeName:      nodeName,
			HostPID:       true,
			HostIPC:       true,
			HostNetwork:   true,
			RestartPolicy: corev1.RestartPolicyNever,
			// A node under investigation is usually tainted.
			Tolerations:                   []corev1.Toleration{{Operator: corev1.TolerationOpExists}},
			TerminationGracePeriodSeconds: &grace,
			ActiveDeadlineSeconds:         &deadline,
			Containers: []corev1.Container{{
				Name:            nodeShellContainer,
				Image:           nodeShellImage,
				ImagePullPolicy: corev1.PullIfNotPresent,
				// The shell arrives over exec, so the container itself only has
				// to stay alive.
				Command: []string{"sleep", nodeShellSleepSeconds},
				Stdin:   true,
				TTY:     true,
				Resources: corev1.ResourceRequirements{
					// Requests only, and tiny: a node worth debugging is often a
					// node with nothing left to allocate.
					Requests: corev1.ResourceList{
						corev1.ResourceCPU:    resource.MustParse("10m"),
						corev1.ResourceMemory: resource.MustParse("16Mi"),
					},
				},
				SecurityContext: &corev1.SecurityContext{Privileged: &privileged},
			}},
		},
	}
}
