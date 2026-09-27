package services_k8sclient

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// newTestNodeShell registers a session holding a real pod in a fake cluster, so
// a release either deletes it or does not — nothing to mock.
func newTestNodeShell(t *testing.T, id, podName string) (*nodeShellSession, *fake.Clientset) {
	t.Helper()
	client := fake.NewClientset(&corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: podName, Namespace: nodeShellNamespace},
	})
	_, cancel := context.WithCancel(context.Background())
	sess := &nodeShellSession{client: client, podName: podName, cancel: cancel}

	nodeShellMu.Lock()
	nodeShells[id] = sess
	nodeShellMu.Unlock()
	t.Cleanup(func() {
		nodeShellMu.Lock()
		delete(nodeShells, id)
		nodeShellMu.Unlock()
	})
	return sess, client
}

func podExists(t *testing.T, client *fake.Clientset, name string) bool {
	t.Helper()
	_, err := client.CoreV1().Pods(nodeShellNamespace).Get(context.Background(), name, metav1.GetOptions{})
	return err == nil
}

// The helper pod is host root, so exactly one of the three paths that can end a
// node shell — the panel closing, the remote shell exiting, setup failing
// half-way — must own the delete, and it must actually happen.
func TestReleaseNodeShellDeletesPodOnce(t *testing.T) {
	sess, client := newTestNodeShell(t, "once", "kube-ins-nodeshell-once")

	if !releaseNodeShell("once", sess) {
		t.Fatal("first release did not take ownership")
	}
	if podExists(t, client, sess.podName) {
		t.Fatal("helper pod survived its release — a privileged pod leaked")
	}
	if releaseNodeShell("once", sess) {
		t.Fatal("second release took ownership of an already-released session")
	}
	if releaseNodeShell("once", nil) {
		t.Fatal("keyed release took ownership of an already-released session")
	}
}

// A shell reopened on the same node reuses the panel id, so the previous
// session's late cleanup must not delete the new session's pod.
func TestReleaseNodeShellSparesNewerSession(t *testing.T) {
	fresh, client := newTestNodeShell(t, "reused", "kube-ins-nodeshell-fresh")
	stale := &nodeShellSession{client: client, podName: "kube-ins-nodeshell-stale", cancel: func() {}}

	if releaseNodeShell("reused", stale) {
		t.Fatal("stale cleanup claimed the newer session")
	}

	nodeShellMu.Lock()
	got := nodeShells["reused"]
	nodeShellMu.Unlock()
	if got != fresh {
		t.Fatal("stale cleanup evicted the newer session from the registry")
	}
	if !podExists(t, client, fresh.podName) {
		t.Fatal("stale cleanup deleted the newer session's pod")
	}
}

// Cancelled between registration and Create returning: there is no pod name yet,
// and the creator — not this path — deletes the pod it is holding.
func TestReleaseNodeShellWithoutPodName(t *testing.T) {
	client := fake.NewClientset()
	cancelled := false
	sess := &nodeShellSession{client: client, cancel: func() { cancelled = true }}

	nodeShellMu.Lock()
	nodeShells["pending"] = sess
	nodeShellMu.Unlock()
	t.Cleanup(func() {
		nodeShellMu.Lock()
		delete(nodeShells, "pending")
		nodeShellMu.Unlock()
	})

	if !releaseNodeShell("pending", sess) {
		t.Fatal("release did not take ownership of a pending session")
	}
	if !cancelled {
		t.Fatal("release did not cancel the in-flight creation")
	}
	nodeShellMu.Lock()
	_, still := nodeShells["pending"]
	nodeShellMu.Unlock()
	if still {
		t.Fatal("pending session stayed in the registry, so nothing will clean it up")
	}
}

// Every field here is load-bearing: drop one and the shell either lands on the
// wrong node, cannot see PID 1, or refuses to schedule on the node you need it on.
func TestNodeShellPodSpec(t *testing.T) {
	pod := nodeShellPod("worker-1")

	if pod.Namespace != nodeShellNamespace {
		t.Errorf("namespace = %q, want %q", pod.Namespace, nodeShellNamespace)
	}
	if pod.GenerateName == "" || pod.Name != "" {
		t.Error("pod must use GenerateName: node names can exceed the 63-char label limit")
	}
	if pod.Spec.NodeName != "worker-1" {
		t.Errorf("NodeName = %q, want the target node", pod.Spec.NodeName)
	}
	if !pod.Spec.HostPID {
		t.Error("HostPID is off, so nsenter --target 1 cannot reach the host's init")
	}
	if !pod.Spec.HostIPC || !pod.Spec.HostNetwork {
		t.Error("HostIPC/HostNetwork are off, so the shell sees the pod's namespaces")
	}
	if pod.Spec.RestartPolicy != corev1.RestartPolicyNever {
		t.Errorf("RestartPolicy = %q, want Never", pod.Spec.RestartPolicy)
	}
	if pod.Spec.ActiveDeadlineSeconds == nil || *pod.Spec.ActiveDeadlineSeconds != nodeShellDeadlineSeconds {
		t.Error("no ActiveDeadlineSeconds backstop: a crash of this app leaks host root")
	}

	// A node worth opening a shell on is usually cordoned or tainted.
	tolerated := false
	for _, tol := range pod.Spec.Tolerations {
		if tol.Operator == corev1.TolerationOpExists && tol.Key == "" && tol.Value == "" {
			tolerated = true
		}
	}
	if !tolerated {
		t.Error("no blanket Exists toleration, so a tainted node rejects the helper pod")
	}

	if len(pod.Spec.Containers) != 1 {
		t.Fatalf("containers = %d, want 1", len(pod.Spec.Containers))
	}
	c := pod.Spec.Containers[0]
	if c.Name != nodeShellContainer {
		t.Errorf("container name = %q, want %q — the exec targets it by name", c.Name, nodeShellContainer)
	}
	if c.SecurityContext == nil || c.SecurityContext.Privileged == nil || !*c.SecurityContext.Privileged {
		t.Error("container is not privileged, so nsenter is denied")
	}
	if len(c.Command) == 0 || c.Command[0] != "sleep" {
		t.Errorf("command = %v, want the container to idle while the shell arrives over exec", c.Command)
	}
	if pod.Labels["kube-ins/node-shell"] != "true" {
		t.Error("missing kube-ins/node-shell label, so a leaked pod cannot be found")
	}
	if pod.Annotations["kube-ins/node"] != "worker-1" {
		t.Error("node name belongs in an annotation: it need not be a valid label value")
	}
}

// nsenter's long options are not always compiled into busybox's applet.
func TestNodeShellCommandUsesShortFlags(t *testing.T) {
	if len(nodeShellCommand) == 0 || nodeShellCommand[0] != "nsenter" {
		t.Fatalf("command = %v, want nsenter first", nodeShellCommand)
	}
	for _, arg := range nodeShellCommand {
		if len(arg) > 2 && arg[0] == '-' && arg[1] == '-' && arg != "--" {
			t.Errorf("long option %q: busybox nsenter may not understand it", arg)
		}
	}
	// A login shell is what pulled in Fedora's gnupg2 profile script and its
	// `tty` call, which fails once nsenter -m has left the container's devpts.
	for _, arg := range nodeShellCommand {
		if arg == "-l" {
			t.Error("-l starts an interactive login shell; the profile is sourced non-interactively instead")
		}
	}
	joined := strings.Join(nodeShellCommand, " ")
	if !strings.Contains(joined, "/etc/profile") {
		t.Error("the host profile is no longer sourced, so PATH loses /usr/sbin and /sbin")
	}
	if !strings.Contains(joined, "exec sh -i") {
		t.Error("the interactive shell must replace the sourcing shell, or the session exits with it")
	}

	for _, want := range []string{"-t", "1", "-m", "-u", "-i", "-n", "-p", "--"} {
		found := false
		for _, arg := range nodeShellCommand {
			if arg == want {
				found = true
			}
		}
		if !found {
			t.Errorf("command %v is missing %q", nodeShellCommand, want)
		}
	}
}

func TestIsTerminalWaitReason(t *testing.T) {
	// These the kubelet reports forever without help, so waiting out the full
	// startup timeout on one just looks like a hang.
	for _, r := range []string{"ImagePullBackOff", "ErrImagePull", "InvalidImageName",
		"CreateContainerError", "CreateContainerConfigError", "RunContainerError", "CrashLoopBackOff"} {
		if !isTerminalWaitReason(r) {
			t.Errorf("%q should fail fast", r)
		}
	}
	// These resolve on their own.
	for _, r := range []string{"ContainerCreating", "PodInitializing", ""} {
		if isTerminalWaitReason(r) {
			t.Errorf("%q should be waited out", r)
		}
	}
}
