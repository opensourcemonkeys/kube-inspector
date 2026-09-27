package services_k8sclient

import (
	"context"
	"fmt"
	"io"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"

	"kube-ins/internal/safego"
)

type podExecSession struct {
	stdinWriter *io.PipeWriter
	sizeQueue   *execSizeQueue
	cancel      context.CancelFunc
}

type execSizeQueue struct {
	ch chan remotecommand.TerminalSize
}

func (q *execSizeQueue) Next() *remotecommand.TerminalSize {
	size, ok := <-q.ch
	if !ok {
		return nil
	}
	return &size
}

var (
	execMu       sync.Mutex
	execSessions = make(map[string]*podExecSession)
)

// releaseExecSession removes id from the registry and tears its session down.
//
// The map entry is the ownership token: exactly one caller wins the delete, so
// stdinWriter and sizeQueue.ch are closed exactly once no matter whether the
// panel closed the session, a new session replaced it, or the remote shell
// exited first. When want is non-nil the entry must still be that session — a
// session started later under the same id is left alone. Reports whether this
// call was the one that owned the teardown.
func releaseExecSession(id string, want *podExecSession) bool {
	execMu.Lock()
	sess, ok := execSessions[id]
	if ok && (want == nil || sess == want) {
		delete(execSessions, id)
	} else {
		ok = false
	}
	execMu.Unlock()

	if !ok {
		return false
	}
	sess.cancel()
	_ = sess.stdinWriter.Close()
	// Closing the queue unblocks the remotecommand goroutine parked in Next(),
	// which otherwise leaks for the lifetime of the process.
	close(sess.sizeQueue.ch)
	return true
}

// CreatePodExecSession opens an interactive shell in a pod container. onClosed
// fires when the session ends on its own — the remote shell exiting, the pod
// going away, the stream breaking — but not when the caller closed it, so the
// frontend can tell a dead terminal from one it shut down itself.
func CreatePodExecSession(id, namespace, podName, container string, onOutput func(string), onClosed func(), client *kubernetes.Clientset, config *rest.Config) error {
	if container == "" {
		pod, err := client.CoreV1().Pods(namespace).Get(context.TODO(), podName, metav1.GetOptions{})
		if err != nil {
			return fmt.Errorf("could not get pod: %w", err)
		}
		if len(pod.Spec.Containers) > 0 {
			container = pod.Spec.Containers[0].Name
		}
	}
	return startExecSession(id, namespace, podName, container, []string{"/bin/sh"}, onOutput, onClosed, client, config)
}

// startExecSession is the exec machinery shared by a pod shell and a node shell
// (nodeShellServices.go): one registry, one stdin pipe, one terminal size queue.
// The two differ only in the command run inside the container — "/bin/sh" for a
// pod, nsenter into PID 1's namespaces for a node — so `command` is the seam
// rather than a second copy of everything below.
func startExecSession(id, namespace, podName, container string, command []string, onOutput func(string), onClosed func(), client *kubernetes.Clientset, config *rest.Config) error {
	releaseExecSession(id, nil)

	req := client.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(podName).
		Namespace(namespace).
		SubResource("exec")

	req.VersionedParams(&corev1.PodExecOptions{
		Container: container,
		Command:   command,
		Stdin:     true,
		Stdout:    true,
		Stderr:    true,
		TTY:       true,
	}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(config, "POST", req.URL())
	if err != nil {
		return fmt.Errorf("failed to create executor: %w", err)
	}

	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()

	sq := &execSizeQueue{ch: make(chan remotecommand.TerminalSize, 4)}
	ctx, cancel := context.WithCancel(context.Background())

	sess := &podExecSession{
		stdinWriter: stdinWriter,
		sizeQueue:   sq,
		cancel:      cancel,
	}

	execMu.Lock()
	execSessions[id] = sess
	execMu.Unlock()

	safego.Go("services.podexec.stream", func() {
		defer func() {
			// The stream is over. Closing the write end ends the reader
			// goroutine below; releasing the session drops the registry entry
			// and unblocks the size queue. Without this the session stayed in
			// execSessions forever and the panel just went quiet.
			_ = stdoutWriter.Close()
			if releaseExecSession(id, sess) && onClosed != nil {
				onClosed()
			}
		}()
		_ = executor.StreamWithContext(ctx, remotecommand.StreamOptions{
			Stdin:             stdinReader,
			Stdout:            stdoutWriter,
			Stderr:            stdoutWriter,
			Tty:               true,
			TerminalSizeQueue: sq,
		})
	})

	safego.Go("services.podexec.reader", func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdoutReader.Read(buf)
			if n > 0 {
				onOutput(string(buf[:n]))
			}
			if err != nil {
				break
			}
		}
	})

	return nil
}

func WriteToPodExecSession(id, data string) error {
	execMu.Lock()
	session, ok := execSessions[id]
	execMu.Unlock()
	if !ok {
		return fmt.Errorf("exec session %s not found", id)
	}
	_, err := io.WriteString(session.stdinWriter, data)
	return err
}

func ResizePodExecSession(id string, cols, rows uint16) error {
	execMu.Lock()
	session, ok := execSessions[id]
	execMu.Unlock()
	if !ok {
		return fmt.Errorf("exec session %s not found", id)
	}
	select {
	case session.sizeQueue.ch <- remotecommand.TerminalSize{Width: cols, Height: rows}:
	default:
	}
	return nil
}

func ClosePodExecSession(id string) error {
	releaseExecSession(id, nil)
	return nil
}
