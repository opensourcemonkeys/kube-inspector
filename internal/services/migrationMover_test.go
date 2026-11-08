package services_k8sclient

import (
	"context"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"kube-ins/internal/models"
)

func TestParseMoverLogRunningPass(t *testing.T) {
	got := parseMoverLog("KUBE_INS_ADDR 10.0.0.5:2222\n  1,234,567  45%   12.34MB/s    0:00:10 (xfr#3, to-chk=5/10)\n  2,000,000  73%   11.00MB/s    0:00:05 (xfr#4, to-chk=2/10)\n")
	if got.Percent != 73 || got.Rate != "11.00MB/s" || got.Done || got.Unreachable {
		t.Fatalf("state = %+v", got)
	}
}

func TestParseMoverLogFinishedPass(t *testing.T) {
	got := parseMoverLog("  2,000,000 100%   11.00MB/s    0:00:05 (xfr#4, to-chk=0/10)\n\nNumber of files: 10\nTotal file size: 9,876,543 bytes\nTotal transferred file size: 2,000,000 bytes\nKUBE_INS_PASS_DONE rc=0\n")
	if !got.Done || got.RC != 0 || got.TotalBytes != 9876543 || got.Percent != 100 {
		t.Fatalf("state = %+v", got)
	}
}

func TestParseMoverLogFailures(t *testing.T) {
	if got := parseMoverLog("KUBE_INS_UNREACHABLE 10.0.0.5:2222 1.1.1.1:31000\n"); !got.Unreachable {
		t.Fatalf("state = %+v", got)
	}
	got := parseMoverLog("rsync: connection unexpectedly closed (0 bytes received so far)\nrsync error: error in rsync protocol data stream (code 12) at io.c(232)\nKUBE_INS_PASS_DONE rc=12\n")
	if !got.Done || got.RC != 12 || !strings.Contains(got.ErrorLine, "code 12") {
		t.Fatalf("state = %+v", got)
	}
}

func testDisk() models.MigrationDiskRun {
	return models.MigrationDiskRun{Index: 1, MigrationDisk: models.MigrationDisk{
		Namespace: "a", Name: "data", AccessModes: []string{"ReadWriteOnce"}, Copy: true, LiveCopy: true}}
}

func TestSendJobWhileTheApplicationRuns(t *testing.T) {
	job := moverSendJob(moverSendSpec{ID: "abcd1234-ffff", Image: "img:1", Disk: testDisk(), Pass: 2, Node: "n1",
		Addrs: []string{"10.0.0.5:2222", "192.168.1.2:31000"}, BandwidthKBps: 500})
	pod := job.Spec.Template.Spec
	if pod.NodeName != "n1" {
		t.Errorf("nodeName = %q: a ReadWriteOnce volume can only be read on its node", pod.NodeName)
	}
	var claim *corev1.PersistentVolumeClaimVolumeSource
	for _, v := range pod.Volumes {
		if v.PersistentVolumeClaim != nil {
			claim = v.PersistentVolumeClaim
		}
	}
	if claim == nil || claim.ClaimName != "data" || !claim.ReadOnly {
		t.Errorf("claim = %+v: the sender must never be able to write to the source", claim)
	}
	env := map[string]string{}
	for _, e := range pod.Containers[0].Env {
		env[e.Name] = e.Value
	}
	if env["MOVER_ADDRS"] != "10.0.0.5:2222 192.168.1.2:31000" || env["MOVER_BWLIMIT"] != "500" {
		t.Errorf("env = %v", env)
	}
	if _, ok := env["MOVER_FINAL"]; ok {
		t.Error("a live pass must not delete on the target")
	}
	if job.Spec.ActiveDeadlineSeconds == nil || *job.Spec.BackoffLimit != 0 {
		t.Errorf("spec = %+v", job.Spec)
	}
	if job.Labels[moverLabel] == "" || job.Labels[migrationLabel] != "abcd1234-ffff" {
		t.Errorf("labels = %v", job.Labels)
	}
}

func TestFinalSendJobIsFreeToScheduleAndDeletes(t *testing.T) {
	job := moverSendJob(moverSendSpec{ID: "abcd1234", Image: "i", Disk: testDisk(), Final: true, Addrs: []string{"x:1"}})
	if job.Spec.Template.Spec.NodeName != "" {
		t.Error("nothing mounts the volume in the final pass; it must not be pinned")
	}
	var final bool
	for _, e := range job.Spec.Template.Spec.Containers[0].Env {
		final = final || (e.Name == "MOVER_FINAL" && e.Value == "1")
	}
	if !final {
		t.Error("MOVER_FINAL not set")
	}
}

func TestReceiverPodAndService(t *testing.T) {
	pod := moverReceiverPod("abcd1234", "img", testDisk())
	if pod.Spec.ActiveDeadlineSeconds == nil || pod.Labels[moverLabel] == "" {
		t.Errorf("pod = %+v", pod.ObjectMeta)
	}
	for _, v := range pod.Spec.Volumes {
		if v.PersistentVolumeClaim != nil && v.PersistentVolumeClaim.ReadOnly {
			t.Error("the receiver has to write")
		}
	}
	svc := moverReceiverService("abcd1234", testDisk())
	if svc.Spec.Type != corev1.ServiceTypeNodePort || svc.Spec.Selector[moverPodLabel] != pod.Labels[moverPodLabel] {
		t.Errorf("service = %+v / %v", svc.Spec, pod.Labels)
	}
}

func TestMoverSecretsSplitTheKeys(t *testing.T) {
	k, err := newMoverKeys()
	if err != nil {
		t.Fatal(err)
	}
	dst := moverTargetSecret("abcd1234", "a", k)
	src := moverSourceSecret("abcd1234", "a", k)
	if _, ok := dst.Data["id_key"]; ok {
		t.Error("the target must not hold the client key")
	}
	if _, ok := src.Data["host_key"]; ok {
		t.Error("the source must not hold the host key")
	}
	if !strings.HasPrefix(string(dst.Data["authorized_keys"]), `command="/mover.sh rsync-only",`) {
		t.Errorf("authorized_keys = %s", dst.Data["authorized_keys"])
	}
	if !strings.HasPrefix(string(src.Data["known_hosts"]), "kube-ins-mover ssh-ed25519 ") {
		t.Errorf("known_hosts = %s", src.Data["known_hosts"])
	}
}

func migClusterWith(objs ...runtime.Object) (MigrationCluster, *fake.Clientset) {
	c := fake.NewClientset(objs...)
	return MigrationCluster{Name: "c", Client: c}, c
}

func runningReceiver(rec *models.MigrationRecord, d models.MigrationDiskRun) []runtime.Object {
	pod := moverReceiverPod(rec.ID, "i", d)
	pod.Status = corev1.PodStatus{Phase: corev1.PodRunning, PodIP: "10.0.0.5"}
	svc := moverReceiverService(rec.ID, d)
	svc.Spec.Ports[0].NodePort = 31000
	node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "t1"}, Status: corev1.NodeStatus{
		Addresses: []corev1.NodeAddress{{Type: corev1.NodeInternalIP, Address: "192.168.1.2"}}}}
	return []runtime.Object{pod, svc, node}
}

func TestTickStartsTheFirstPassOnTheApplicationsNode(t *testing.T) {
	d := testDisk()
	rec := &models.MigrationRecord{ID: "abcd1234", MoverImage: "i", Disks: []models.MigrationDiskRun{d}}
	appPod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "web-0", Namespace: "a"},
		Spec: corev1.PodSpec{NodeName: "n7", Volumes: []corev1.Volume{{Name: "v", VolumeSource: corev1.VolumeSource{
			PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "data"}}}}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning}}
	src, srcC := migClusterWith(appPod)
	dst, _ := migClusterWith(runningReceiver(rec, d)...)

	if _, err := TickMigrationCopy(context.Background(), src, dst, rec, time.Now()); err != nil {
		t.Fatal(err)
	}
	job, err := srcC.BatchV1().Jobs("a").Get(context.Background(), moverSendName(rec.ID, 1, 1), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if job.Spec.Template.Spec.NodeName != "n7" {
		t.Errorf("nodeName = %q", job.Spec.Template.Spec.NodeName)
	}
	var addrs string
	for _, e := range job.Spec.Template.Spec.Containers[0].Env {
		if e.Name == "MOVER_ADDRS" {
			addrs = e.Value
		}
	}
	if addrs != "10.0.0.5:2222 192.168.1.2:31000" {
		t.Errorf("addrs = %q: pod IP first, then the NodePort", addrs)
	}
}

func TestTickFinishedPassReleasesTheVolumeAndCounts(t *testing.T) {
	d := testDisk()
	rec := &models.MigrationRecord{ID: "abcd1234", MoverImage: "i", Disks: []models.MigrationDiskRun{d}}
	job := moverSendJob(moverSendSpec{ID: rec.ID, Image: "i", Disk: d, Pass: 1, Addrs: []string{"x:1"}})
	job.Status = batchv1.JobStatus{Succeeded: 1}
	src, srcC := migClusterWith(job)
	dst, _ := migClusterWith(runningReceiver(rec, d)...)
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)

	if _, err := TickMigrationCopy(context.Background(), src, dst, rec, now); err != nil {
		t.Fatal(err)
	}
	if rec.Disks[0].Passes != 1 || rec.Disks[0].LastPassAt == "" {
		t.Fatalf("disk = %+v", rec.Disks[0])
	}
	if _, err := srcC.BatchV1().Jobs("a").Get(context.Background(), job.Name, metav1.GetOptions{}); err == nil {
		t.Error("a finished sender must go, or it keeps a ReadWriteOnce volume on its node")
	}
	if !MigrationCopyReady(rec) {
		t.Error("one pass of every disk makes the migration ready")
	}
}

func TestTickWaitsBetweenPasses(t *testing.T) {
	d := testDisk()
	now := time.Date(2026, 11, 8, 10, 0, 0, 0, time.UTC)
	d.Passes, d.LastPassAt = 1, now.Add(-time.Minute).Format(time.RFC3339)
	rec := &models.MigrationRecord{ID: "abcd1234", MoverImage: "i", Disks: []models.MigrationDiskRun{d}}
	src, srcC := migClusterWith()
	dst, _ := migClusterWith(runningReceiver(rec, d)...)
	if _, err := TickMigrationCopy(context.Background(), src, dst, rec, now); err != nil {
		t.Fatal(err)
	}
	if n := countCreates(srcC, "jobs"); n != 0 {
		t.Fatalf("created %d jobs before the interval", n)
	}
	if _, err := TickMigrationCopy(context.Background(), src, dst, rec, now.Add(migrationPassInterval)); err != nil {
		t.Fatal(err)
	}
	if n := countCreates(srcC, "jobs"); n != 1 {
		t.Fatalf("created %d jobs after the interval", n)
	}
}

func TestTickLeavesADiskThatCannotBeReadLive(t *testing.T) {
	d := testDisk()
	d.LiveCopy = false
	rec := &models.MigrationRecord{ID: "abcd1234", MoverImage: "i", Disks: []models.MigrationDiskRun{d}}
	src, srcC := migClusterWith()
	dst, _ := migClusterWith(runningReceiver(rec, d)...)
	if _, err := TickMigrationCopy(context.Background(), src, dst, rec, time.Now()); err != nil {
		t.Fatal(err)
	}
	if n := countCreates(srcC, "jobs"); n != 0 {
		t.Fatalf("created %d jobs", n)
	}
	if !MigrationCopyReady(rec) {
		t.Error("a disk that waits for the final pass must not hold the migration back")
	}
}

func countCreates(c *fake.Clientset, resource string) int {
	n := 0
	for _, a := range c.Actions() {
		if ca, ok := a.(k8stesting.CreateAction); ok && a.GetVerb() == "create" && ca.GetResource().Resource == resource {
			n++
		}
	}
	return n
}

func TestDeleteMoverObjectsLeavesMigratedObjects(t *testing.T) {
	d := testDisk()
	rec := &models.MigrationRecord{ID: "abcd1234", Namespaces: []string{"a"}, Disks: []models.MigrationDiskRun{d}}
	keep := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "a", Labels: map[string]string{migrationLabel: rec.ID}}}
	c, cs := migClusterWith(append(runningReceiver(rec, d), keep)...)
	if err := deleteMoverObjects(context.Background(), c, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := cs.CoreV1().Services("a").Get(context.Background(), "web", metav1.GetOptions{}); err != nil {
		t.Errorf("a migrated object was deleted: %v", err)
	}
	if _, err := cs.CoreV1().Pods("a").Get(context.Background(), moverReceiverName(rec.ID, 1), metav1.GetOptions{}); err == nil {
		t.Error("the receiver is still there")
	}
}
