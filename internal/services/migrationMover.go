package services_k8sclient

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	"kube-ins/internal/models"
)

const (
	// DefaultMigrationMoverImage is built from toolbox/mover and published on
	// the toolbox-v* tags; it has to exist before an app release refers to it.
	DefaultMigrationMoverImage = "ghcr.io/opensourcemonkeys/kube-inspector-toolbox-migrator:1.0.0-beta.2"

	moverPodLabel = "kube-ins/mover-pod"
	moverPort     = 2222
	moverKeysPath = "/mover-keys"
	// A backstop against workers outliving a machine that never came back. A
	// migration may wait days for its switch-over window.
	moverDeadlineSeconds = int64(14 * 24 * 3600)
	moverLogTailLines    = int64(60)

	// How many volumes are copied at once on a source that is still serving.
	migrationMaxParallelPasses = 3
	// The pause between two passes over a volume, which is what keeps the
	// final difference small.
	migrationPassInterval = 5 * time.Minute
	moverReceiverWait     = 5 * time.Minute
	moverPoll             = 2 * time.Second
	moverCleanupTimeout   = 60 * time.Second

	// MigrationDiskUnreachable is MigrationDiskRun.Error when the sender could
	// not reach the receiver on any address.
	MigrationDiskUnreachable = "unreachable"
)

func moverShort(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func moverSecretName(id string) string { return "kube-ins-mover-" + moverShort(id) }

func moverReceiverName(id string, index int) string {
	return fmt.Sprintf("kube-ins-recv-%s-%d", moverShort(id), index)
}

func moverSendName(id string, index, pass int) string {
	return fmt.Sprintf("kube-ins-send-%s-%d-%d", moverShort(id), index, pass)
}

func moverFinalName(id string, index int) string {
	return fmt.Sprintf("kube-ins-final-%s-%d", moverShort(id), index)
}

func moverLabels(id string) map[string]string {
	return map[string]string{"app.kubernetes.io/managed-by": "kube-inspector", migrationLabel: id, moverLabel: "true"}
}

func moverSelector(id string) string { return moverLabel + "=true," + migrationLabel + "=" + id }

// moverKeys are generated per migration and live only in the two Secrets.
type moverKeys struct {
	clientPrivate, clientPublic, hostPrivate, hostPublic []byte
}

func newMoverKeys() (moverKeys, error) {
	gen := func() (private, public []byte, err error) {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, nil, err
		}
		block, err := ssh.MarshalPrivateKey(priv, "")
		if err != nil {
			return nil, nil, err
		}
		sshPub, err := ssh.NewPublicKey(pub)
		if err != nil {
			return nil, nil, err
		}
		return pem.EncodeToMemory(block), ssh.MarshalAuthorizedKey(sshPub), nil
	}
	var k moverKeys
	var err error
	if k.clientPrivate, k.clientPublic, err = gen(); err != nil {
		return k, err
	}
	k.hostPrivate, k.hostPublic, err = gen()
	return k, err
}

func moverSecretMeta(id, namespace string) metav1.ObjectMeta {
	return metav1.ObjectMeta{Name: moverSecretName(id), Namespace: namespace, Labels: moverLabels(id)}
}

// moverTargetSecret holds what the receiver needs: its host key and the public
// half of the client key, limited to running rsync.
func moverTargetSecret(id, namespace string, k moverKeys) *corev1.Secret {
	authorized := `command="/mover.sh rsync-only",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ` + string(k.clientPublic)
	return &corev1.Secret{ObjectMeta: moverSecretMeta(id, namespace), Data: map[string][]byte{
		"host_key": k.hostPrivate, "authorized_keys": []byte(authorized),
	}}
}

// moverSourceSecret holds what the sender needs: the client key and which host
// key to accept.
func moverSourceSecret(id, namespace string, k moverKeys) *corev1.Secret {
	return &corev1.Secret{ObjectMeta: moverSecretMeta(id, namespace), Data: map[string][]byte{
		"id_key": k.clientPrivate, "known_hosts": []byte("kube-ins-mover " + string(k.hostPublic)),
	}}
}

func moverContainer(id, image, claim string, readOnly bool, args []string, env []corev1.EnvVar) ([]corev1.Container, []corev1.Volume) {
	root := int64(0)
	mode := int32(0400)
	return []corev1.Container{{
		Name:            "mover",
		Image:           image,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Args:            args,
		Env:             env,
		// The owner of every file has to survive the copy.
		SecurityContext: &corev1.SecurityContext{RunAsUser: &root},
		Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{
			corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("128Mi"),
		}},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "data", MountPath: "/data", ReadOnly: readOnly},
			{Name: "keys", MountPath: moverKeysPath, ReadOnly: true},
		},
	}}, []corev1.Volume{
		{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: claim, ReadOnly: readOnly}}},
		{Name: "keys", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: moverSecretName(id), DefaultMode: &mode}}},
	}
}

func moverReceiverPod(id, image string, d models.MigrationDiskRun) *corev1.Pod {
	name := moverReceiverName(id, d.Index)
	labels := moverLabels(id)
	labels[moverPodLabel] = name
	deadline := moverDeadlineSeconds
	containers, volumes := moverContainer(id, image, d.Name, false, []string{"receive"}, nil)
	containers[0].Ports = []corev1.ContainerPort{{Name: "ssh", ContainerPort: moverPort}}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.Namespace, Labels: labels},
		Spec: corev1.PodSpec{RestartPolicy: corev1.RestartPolicyNever, ActiveDeadlineSeconds: &deadline,
			Containers: containers, Volumes: volumes},
	}
}

// moverReceiverService exposes the receiver on a node port, the second address
// the sender tries when pod IPs do not route between the clusters.
func moverReceiverService(id string, d models.MigrationDiskRun) *corev1.Service {
	name := moverReceiverName(id, d.Index)
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.Namespace, Labels: moverLabels(id)},
		Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeNodePort, Selector: map[string]string{moverPodLabel: name},
			Ports: []corev1.ServicePort{{Name: "ssh", Port: moverPort, TargetPort: intstr.FromInt(moverPort)}}},
	}
}

type moverSendSpec struct {
	ID, Image     string
	Disk          models.MigrationDiskRun
	Pass          int
	Final         bool
	Node          string
	Addrs         []string
	BandwidthKBps int
}

// moverSendJob copies a volume once. It runs one pass and ends rather than
// looping, so it never keeps a ReadWriteOnce volume on a node between passes,
// where it would stop a rescheduled application pod from attaching it.
func moverSendJob(s moverSendSpec) *batchv1.Job {
	name := moverSendName(s.ID, s.Disk.Index, s.Pass)
	if s.Final {
		name = moverFinalName(s.ID, s.Disk.Index)
	}
	env := []corev1.EnvVar{{Name: "MOVER_ADDRS", Value: strings.Join(s.Addrs, " ")}}
	if s.BandwidthKBps > 0 {
		env = append(env, corev1.EnvVar{Name: "MOVER_BWLIMIT", Value: strconv.Itoa(s.BandwidthKBps)})
	}
	if s.Final {
		env = append(env, corev1.EnvVar{Name: "MOVER_FINAL", Value: "1"})
	}
	containers, volumes := moverContainer(s.ID, s.Image, s.Disk.Name, true, []string{"send"}, env)
	pod := corev1.PodSpec{RestartPolicy: corev1.RestartPolicyNever, Containers: containers, Volumes: volumes, NodeName: s.Node}
	if s.Node != "" {
		// Pinned to the application's node, whose taints it has to accept too.
		pod.Tolerations = []corev1.Toleration{{Operator: corev1.TolerationOpExists}}
	}
	backoff, deadline := int32(0), moverDeadlineSeconds
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: s.Disk.Namespace, Labels: moverLabels(s.ID)},
		Spec: batchv1.JobSpec{BackoffLimit: &backoff, ActiveDeadlineSeconds: &deadline,
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: moverLabels(s.ID)}, Spec: pod}},
	}
}

// moverLogState is what the sender's log says.
type moverLogState struct {
	Percent     int
	Rate        string
	TotalBytes  int64
	Done        bool
	RC          int
	Unreachable bool
	ErrorLine   string
}

var (
	moverProgressRe = regexp.MustCompile(`^\s*[\d,]+\s+(\d+)%\s+(\S+/s)`)
	moverTotalRe    = regexp.MustCompile(`^Total file size: ([\d,]+) bytes`)
	moverDoneRe     = regexp.MustCompile(`^KUBE_INS_PASS_DONE rc=(\d+)`)
)

func parseMoverLog(log string) moverLogState {
	var s moverLogState
	for _, line := range strings.Split(log, "\n") {
		switch {
		case strings.HasPrefix(line, "KUBE_INS_UNREACHABLE"):
			s.Unreachable = true
		case strings.HasPrefix(line, "rsync error:"):
			s.ErrorLine = line
		}
		if m := moverProgressRe.FindStringSubmatch(line); m != nil {
			s.Percent, _ = strconv.Atoi(m[1])
			s.Rate = m[2]
		}
		if m := moverTotalRe.FindStringSubmatch(line); m != nil {
			s.TotalBytes, _ = strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64)
		}
		if m := moverDoneRe.FindStringSubmatch(line); m != nil {
			s.Done = true
			s.RC, _ = strconv.Atoi(m[1])
		}
	}
	return s
}

func readMoverLog(ctx context.Context, c MigrationCluster, namespace, job string) string {
	pods, err := c.Client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: "job-name=" + job})
	if err != nil || len(pods.Items) == 0 {
		return ""
	}
	tail := moverLogTailLines
	raw, err := c.Client.CoreV1().Pods(namespace).GetLogs(pods.Items[0].Name, &corev1.PodLogOptions{TailLines: &tail}).DoRaw(ctx)
	if err != nil {
		return ""
	}
	return string(raw)
}

func podMountsClaim(p *corev1.Pod, claim string) bool {
	for _, v := range p.Spec.Volumes {
		if v.PersistentVolumeClaim != nil && v.PersistentVolumeClaim.ClaimName == claim {
			return true
		}
	}
	return false
}

func podIsActive(p *corev1.Pod) bool {
	return p.Status.Phase != corev1.PodSucceeded && p.Status.Phase != corev1.PodFailed
}

func isReadWriteOnce(modes []string) bool {
	for _, m := range modes {
		if m == string(corev1.ReadWriteOnce) {
			return true
		}
	}
	return false
}

// moverNodeFor says where a sender has to run: on the node of the application
// using a ReadWriteOnce volume, which is the only node that can mount it.
func moverNodeFor(ctx context.Context, src MigrationCluster, d models.MigrationDiskRun) (string, error) {
	if !isReadWriteOnce(d.AccessModes) {
		return "", nil
	}
	pods, err := src.Client.CoreV1().Pods(d.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", err
	}
	for i := range pods.Items {
		p := &pods.Items[i]
		if p.Labels[moverLabel] == "" && podIsActive(p) && p.Spec.NodeName != "" && podMountsClaim(p, d.Name) {
			return p.Spec.NodeName, nil
		}
	}
	return "", nil
}

// receiverAddrs lists where a receiver can be reached: its pod IP, then the
// node port on up to three nodes.
func receiverAddrs(ctx context.Context, dst MigrationCluster, id string, d models.MigrationDiskRun) ([]string, error) {
	name := moverReceiverName(id, d.Index)
	pod, err := dst.Client.CoreV1().Pods(d.Namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	var addrs []string
	if pod.Status.PodIP != "" {
		addrs = append(addrs, fmt.Sprintf("%s:%d", pod.Status.PodIP, moverPort))
	}
	svc, err := dst.Client.CoreV1().Services(d.Namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if len(svc.Spec.Ports) == 0 || svc.Spec.Ports[0].NodePort == 0 {
		return addrs, nil
	}
	nodes, err := dst.Client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range nodes.Items {
		if i == 3 {
			break
		}
		for _, want := range []corev1.NodeAddressType{corev1.NodeInternalIP, corev1.NodeExternalIP} {
			for _, a := range nodes.Items[i].Status.Addresses {
				if a.Type == want {
					addrs = append(addrs, fmt.Sprintf("%s:%d", a.Address, svc.Spec.Ports[0].NodePort))
				}
			}
		}
	}
	return addrs, nil
}

func moverNamespaces(rec *models.MigrationRecord) []string {
	seen := map[string]bool{}
	var out []string
	for _, d := range rec.Disks {
		if d.Copy && !seen[d.Namespace] {
			seen[d.Namespace] = true
			out = append(out, d.Namespace)
		}
	}
	return out
}

// startMoverReceivers creates the keys and one receiver per copied disk on the
// target, and waits until they run.
func startMoverReceivers(ctx context.Context, src, dst MigrationCluster, rec *models.MigrationRecord) error {
	keys, err := newMoverKeys()
	if err != nil {
		return fmt.Errorf("generate migration keys: %w", err)
	}
	for _, ns := range moverNamespaces(rec) {
		if _, err := dst.Client.CoreV1().Secrets(ns).Create(ctx, moverTargetSecret(rec.ID, ns, keys), metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create the receiver keys in %s: %w", ns, err)
		}
		if _, err := src.Client.CoreV1().Secrets(ns).Create(ctx, moverSourceSecret(rec.ID, ns, keys), metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create the sender keys in %s: %w", ns, err)
		}
	}
	for _, d := range rec.Disks {
		if !d.Copy {
			continue
		}
		if _, err := dst.Client.CoreV1().Pods(d.Namespace).Create(ctx, moverReceiverPod(rec.ID, rec.MoverImage, d), metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create the receiver for %s/%s: %w", d.Namespace, d.Name, err)
		}
		if _, err := dst.Client.CoreV1().Services(d.Namespace).Create(ctx, moverReceiverService(rec.ID, d), metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create the receiver service for %s/%s: %w", d.Namespace, d.Name, err)
		}
	}
	deadline := time.Now().Add(moverReceiverWait)
	for _, d := range rec.Disks {
		if !d.Copy {
			continue
		}
		name := moverReceiverName(rec.ID, d.Index)
		for {
			pod, err := dst.Client.CoreV1().Pods(d.Namespace).Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				return err
			}
			if pod.Status.Phase == corev1.PodRunning && pod.Status.PodIP != "" {
				break
			}
			if pod.Status.Phase == corev1.PodFailed || time.Now().After(deadline) {
				return fmt.Errorf("receiver for %s/%s did not start: %s", d.Namespace, d.Name, describePodWait(pod))
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(moverPoll):
			}
		}
	}
	return nil
}

func describePodWait(p *corev1.Pod) string {
	for _, c := range p.Status.ContainerStatuses {
		if c.State.Waiting != nil {
			return strings.TrimSpace(c.State.Waiting.Reason + " " + c.State.Waiting.Message)
		}
	}
	for _, c := range p.Status.Conditions {
		if c.Status == corev1.ConditionFalse && c.Message != "" {
			return c.Message
		}
	}
	return string(p.Status.Phase)
}

// TickMigrationCopy advances the copying of every disk by one look: it collects
// finished passes and starts the ones that are due. rec is updated in place.
func TickMigrationCopy(ctx context.Context, src, dst MigrationCluster, rec *models.MigrationRecord, now time.Time) ([]models.MigrationDiskProgress, error) {
	out := make([]models.MigrationDiskProgress, 0, len(rec.Disks))
	running := 0
	for i := range rec.Disks {
		d := &rec.Disks[i]
		p := models.MigrationDiskProgress{MigrationDiskRun: *d}
		if !d.Copy {
			out = append(out, p)
			continue
		}
		name := moverSendName(rec.ID, d.Index, d.Passes+1)
		job, err := src.Client.BatchV1().Jobs(d.Namespace).Get(ctx, name, metav1.GetOptions{})
		switch {
		case apierrors.IsNotFound(err):
			if !d.LiveCopy || !passIsDue(d, now) || running >= migrationMaxParallelPasses {
				break
			}
			if err := startSendPass(ctx, src, dst, rec, d); err != nil {
				return nil, err
			}
			running++
			p.Running = true
		case err != nil:
			return nil, err
		case job.Status.Succeeded > 0:
			log := parseMoverLog(readMoverLog(ctx, src, d.Namespace, name))
			d.Passes++
			d.LastPassAt, d.Error = now.Format(time.RFC3339), ""
			if log.TotalBytes > 0 {
				d.BytesCopied = log.TotalBytes
			}
			if err := deleteMoverJob(ctx, src, d.Namespace, name); err != nil {
				return nil, err
			}
			p.MigrationDiskRun = *d
		case job.Status.Failed > 0:
			d.Error = moverFailure(parseMoverLog(readMoverLog(ctx, src, d.Namespace, name)), job)
			d.LastPassAt = now.Format(time.RFC3339)
			if err := deleteMoverJob(ctx, src, d.Namespace, name); err != nil {
				return nil, err
			}
			p.MigrationDiskRun = *d
		default:
			log := parseMoverLog(readMoverLog(ctx, src, d.Namespace, name))
			running++
			p.Running, p.Percent, p.Rate = true, log.Percent, log.Rate
		}
		out = append(out, p)
	}
	return out, nil
}

func passIsDue(d *models.MigrationDiskRun, now time.Time) bool {
	if d.LastPassAt == "" {
		return true
	}
	last, err := time.Parse(time.RFC3339, d.LastPassAt)
	return err != nil || now.Sub(last) >= migrationPassInterval
}

func moverFailure(log moverLogState, job *batchv1.Job) string {
	switch {
	case log.Unreachable:
		return MigrationDiskUnreachable
	case log.ErrorLine != "":
		return log.ErrorLine
	}
	for _, c := range job.Status.Conditions {
		if c.Type == batchv1.JobFailed && c.Message != "" {
			return c.Message
		}
	}
	return "the copy ended with an error"
}

func startSendPass(ctx context.Context, src, dst MigrationCluster, rec *models.MigrationRecord, d *models.MigrationDiskRun) error {
	addrs, err := receiverAddrs(ctx, dst, rec.ID, *d)
	if err != nil {
		return fmt.Errorf("find the receiver of %s/%s: %w", d.Namespace, d.Name, err)
	}
	node, err := moverNodeFor(ctx, src, *d)
	if err != nil {
		return err
	}
	job := moverSendJob(moverSendSpec{ID: rec.ID, Image: rec.MoverImage, Disk: *d, Pass: d.Passes + 1, Node: node, Addrs: addrs, BandwidthKBps: rec.BandwidthKBps})
	if _, err := src.Client.BatchV1().Jobs(d.Namespace).Create(ctx, job, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("start copying %s/%s: %w", d.Namespace, d.Name, err)
	}
	return nil
}

func deleteMoverJob(ctx context.Context, c MigrationCluster, namespace, name string) error {
	policy := metav1.DeletePropagationBackground
	err := c.Client.BatchV1().Jobs(namespace).Delete(ctx, name, metav1.DeleteOptions{PropagationPolicy: &policy})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// MigrationCopyReady says every disk that can be copied live has been at least
// once, so the switch-over can be offered.
func MigrationCopyReady(rec *models.MigrationRecord) bool {
	for _, d := range rec.Disks {
		if d.Copy && d.LiveCopy && d.Passes == 0 {
			return false
		}
	}
	return true
}

// deleteMoverObjects removes every worker of a migration from one cluster. It
// runs on a context of its own: a cancellation is usually what triggers it, and
// a root pod with a volume mounted must not survive because of that.
func deleteMoverObjects(ctx context.Context, c MigrationCluster, rec *models.MigrationRecord) error {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), moverCleanupTimeout)
	defer cancel()
	opts := metav1.ListOptions{LabelSelector: moverSelector(rec.ID)}
	policy := metav1.DeletePropagationBackground
	del := metav1.DeleteOptions{PropagationPolicy: &policy}
	var errs []error
	for _, ns := range rec.Namespaces {
		if jobs, err := c.Client.BatchV1().Jobs(ns).List(cctx, opts); err == nil {
			for _, j := range jobs.Items {
				errs = append(errs, ignoreNotFound(c.Client.BatchV1().Jobs(ns).Delete(cctx, j.Name, del)))
			}
		} else {
			errs = append(errs, ignoreNotFound(err))
		}
		if pods, err := c.Client.CoreV1().Pods(ns).List(cctx, opts); err == nil {
			grace := int64(0)
			for _, p := range pods.Items {
				errs = append(errs, ignoreNotFound(c.Client.CoreV1().Pods(ns).Delete(cctx, p.Name, metav1.DeleteOptions{GracePeriodSeconds: &grace})))
			}
		} else {
			errs = append(errs, ignoreNotFound(err))
		}
		if svcs, err := c.Client.CoreV1().Services(ns).List(cctx, opts); err == nil {
			for _, s := range svcs.Items {
				errs = append(errs, ignoreNotFound(c.Client.CoreV1().Services(ns).Delete(cctx, s.Name, metav1.DeleteOptions{})))
			}
		} else {
			errs = append(errs, ignoreNotFound(err))
		}
		if secrets, err := c.Client.CoreV1().Secrets(ns).List(cctx, opts); err == nil {
			for _, s := range secrets.Items {
				errs = append(errs, ignoreNotFound(c.Client.CoreV1().Secrets(ns).Delete(cctx, s.Name, metav1.DeleteOptions{})))
			}
		} else {
			errs = append(errs, ignoreNotFound(err))
		}
	}
	return errors.Join(errs...)
}

func ignoreNotFound(err error) error {
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}
