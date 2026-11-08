package services_k8sclient

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"kube-ins/internal/models"
)

func int32p(v int32) *int32 { return &v }
func boolp(v bool) *bool    { return &v }

type appliedObject struct {
	u      *unstructured.Unstructured
	dryRun bool
}

// recordApplies captures server-side applies, which the fake client refuses.
func recordApplies(dyn *dynamicfake.FakeDynamicClient, failDryRun error) *[]appliedObject {
	var got []appliedObject
	dyn.PrependReactor("patch", "*", func(a k8stesting.Action) (bool, runtime.Object, error) {
		p := a.(k8stesting.PatchActionImpl)
		u := &unstructured.Unstructured{}
		if err := json.Unmarshal(p.GetPatch(), &u.Object); err != nil {
			return true, nil, err
		}
		dry := len(p.PatchOptions.DryRun) > 0
		if dry && failDryRun != nil {
			return true, nil, failDryRun
		}
		got = append(got, appliedObject{u, dry})
		return true, u, nil
	})
	return &got
}

// finishJobs makes every created Job complete at once, with the given outcome.
func finishJobs(cs *fake.Clientset, succeed bool) {
	cs.PrependReactor("create", "jobs", func(a k8stesting.Action) (bool, runtime.Object, error) {
		j := a.(k8stesting.CreateAction).GetObject().(*batchv1.Job)
		if succeed {
			j.Status.Succeeded = 1
		} else {
			j.Status.Failed = 1
		}
		return false, nil, nil
	})
}

type cutoverFixture struct {
	src, dst   MigrationCluster
	srcC, dstC *fake.Clientset
	applied    *[]appliedObject
	rec        *models.MigrationRecord
	saves      int
}

func newCutoverFixture(t *testing.T, srcExtra ...runtime.Object) *cutoverFixture {
	t.Helper()
	d := testDisk()
	rec := &models.MigrationRecord{ID: "abcd1234", Source: "source", Target: "target", MoverImage: "i", Namespaces: []string{"a"},
		Phase: models.MigrationReady, Disks: []models.MigrationDiskRun{d}}
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "a"}, Spec: appsv1.DeploymentSpec{Replicas: int32p(3)}}
	held := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "held", Namespace: "a"}, Spec: batchv1.CronJobSpec{Suspend: boolp(true)}}
	live := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "live", Namespace: "a"}}
	typed := append([]runtime.Object{migNS("a", nil), dep, held, live}, srcExtra...)
	secret := moverSourceSecret(rec.ID, "a", moverKeys{})

	srcSide := migSide{typed: append(typed, secret), dyn: []runtime.Object{
		migObj("apps/v1", "Deployment", "a", "web", map[string]any{"spec": map[string]any{"replicas": int64(0)}}),
		migObj("apps/v1", "DaemonSet", "a", "agent", nil),
		migObj("batch/v1", "CronJob", "a", "held", map[string]any{"spec": map[string]any{"suspend": true}}),
		migObj("batch/v1", "CronJob", "a", "live", map[string]any{"spec": map[string]any{"suspend": true}}),
		migObj("v1", "ConfigMap", "a", "conf", nil),
		migObj("v1", "ConfigMap", "a", "kept-by-user", nil),
		migPVC("a", "data", "ssd", "Bound", "ReadWriteOnce"),
	}}
	src, srcC, _ := migFakeCluster("source", srcSide)
	dst, dstC, dyn := migFakeCluster("target", migSide{typed: runningReceiver(rec, d)})
	rec.Decisions = map[string]string{"/ConfigMap/a/kept-by-user": "skip"}
	return &cutoverFixture{src: src, dst: dst, srcC: srcC, dstC: dstC, applied: recordApplies(dyn, nil), rec: rec}
}

func (f *cutoverFixture) run() error {
	return RunMigrationCutover(context.Background(), f.src, f.dst, f.rec, MigrationCutoverOptions{
		Save: func() error { f.saves++; return nil }, Poll: time.Millisecond, DrainTimeout: 30 * time.Millisecond,
	})
}

func (f *cutoverFixture) appliedNamed(name string) *unstructured.Unstructured {
	for _, a := range *f.applied {
		if a.u.GetName() == name && a.u.GetKind() != "Namespace" {
			return a.u
		}
	}
	return nil
}

func TestCutoverStopsTheSourceAndStartsTheTarget(t *testing.T) {
	f := newCutoverFixture(t)
	finishJobs(f.srcC, true)
	if err := f.run(); err != nil {
		t.Fatal(err)
	}
	if f.rec.Phase != models.MigrationDone || f.rec.Step != "" || f.rec.CutoverStartedAt == "" || f.rec.CutoverEndedAt == "" {
		t.Fatalf("record = %+v", f.rec)
	}

	dep, _ := f.srcC.AppsV1().Deployments("a").Get(context.Background(), "web", metav1.GetOptions{})
	if *dep.Spec.Replicas != 0 || dep.Annotations[migrationReplicasAnnotation] != "3" {
		t.Fatalf("source deployment = %+v", dep)
	}
	live, _ := f.srcC.BatchV1().CronJobs("a").Get(context.Background(), "live", metav1.GetOptions{})
	if live.Spec.Suspend == nil || !*live.Spec.Suspend {
		t.Fatal("the source's CronJob must be suspended")
	}

	web := f.appliedNamed("web")
	if web == nil || web.Object["spec"].(map[string]any)["replicas"] != float64(3) {
		t.Fatalf("target deployment = %+v", web)
	}
	if _, ok := web.GetLabels()[migrationLabel]; ok {
		t.Fatal("the migration label would make a later migration take this for its own")
	}
	if f.appliedNamed("agent") == nil {
		t.Fatal("a DaemonSet starts only in the final apply")
	}
	if f.appliedNamed("kept-by-user") != nil {
		t.Fatal("an object the user chose to skip was written")
	}
	if h := f.appliedNamed("held"); h.Object["spec"].(map[string]any)["suspend"] != true {
		t.Fatalf("held = %+v", h)
	}
	if l := f.appliedNamed("live"); l.Object["spec"].(map[string]any)["suspend"] != false {
		t.Fatalf("live = %+v", l)
	}

	if _, err := f.dstC.CoreV1().Pods("a").Get(context.Background(), moverReceiverName(f.rec.ID, 1), metav1.GetOptions{}); err == nil {
		t.Fatal("the receiver must be gone before the workload needs its volume")
	}
	if secrets, _ := f.srcC.CoreV1().Secrets("a").List(context.Background(), metav1.ListOptions{}); len(secrets.Items) != 0 {
		t.Fatalf("keys left on the source: %+v", secrets.Items)
	}
}

func TestCutoverNeverCopiesWhileAPodStillWrites(t *testing.T) {
	f := newCutoverFixture(t, migPodUsing("a", "stubborn", "data"))
	finishJobs(f.srcC, true)
	err := f.run()
	if err == nil || !strings.Contains(err.Error(), "a/stubborn") {
		t.Fatalf("err = %v", err)
	}
	if f.rec.Phase != models.MigrationCutover || f.rec.Step != migrationStepDrain || f.rec.Error == "" {
		t.Fatalf("record = %+v", f.rec)
	}
	if n := countCreates(f.srcC, "jobs"); n != 0 {
		t.Fatalf("%d copy jobs started with a writer still there", n)
	}
	if len(*f.applied) != 0 {
		t.Fatalf("the target was touched: %+v", *f.applied)
	}
}

func TestCutoverFailedFinalCopyStartsNothing(t *testing.T) {
	f := newCutoverFixture(t)
	finishJobs(f.srcC, false)
	if err := f.run(); err == nil {
		t.Fatal("no error")
	}
	if f.rec.Step != migrationStepFinalSync || len(*f.applied) != 0 {
		t.Fatalf("step = %q applied = %d", f.rec.Step, len(*f.applied))
	}
	if _, err := f.dstC.CoreV1().Pods("a").Get(context.Background(), moverReceiverName(f.rec.ID, 1), metav1.GetOptions{}); err != nil {
		t.Fatalf("the receiver is needed for the retry: %v", err)
	}
}

func TestCutoverRemovesSendersBeforeTheFinalCopy(t *testing.T) {
	f := newCutoverFixture(t)
	running := moverSendJob(moverSendSpec{ID: f.rec.ID, Image: "i", Disk: f.rec.Disks[0], Pass: 2, Addrs: []string{"x:1"}})
	if _, err := f.srcC.BatchV1().Jobs("a").Create(context.Background(), running, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	finishJobs(f.srcC, true)
	if err := f.run(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.srcC.BatchV1().Jobs("a").Get(context.Background(), running.Name, metav1.GetOptions{}); err == nil {
		t.Fatal("a live sender survived the switch-over")
	}
}

func TestCutoverResumesFromItsStep(t *testing.T) {
	f := newCutoverFixture(t)
	f.rec.Phase, f.rec.Step = models.MigrationCutover, MigrationStepApply
	f.rec.Workloads = []models.MigrationWorkload{{Kind: "Deployment", Namespace: "a", Name: "web", Replicas: 3}}
	if err := f.run(); err != nil {
		t.Fatal(err)
	}
	if n := countCreates(f.srcC, "jobs"); n != 0 {
		t.Fatalf("%d copy jobs on resume", n)
	}
	dep, _ := f.srcC.AppsV1().Deployments("a").Get(context.Background(), "web", metav1.GetOptions{})
	if *dep.Spec.Replicas != 3 {
		t.Fatal("a resumed apply must not stop the source again")
	}
	if f.appliedNamed("web") == nil || f.rec.Phase != models.MigrationDone {
		t.Fatalf("record = %+v", f.rec)
	}
}

func TestCutoverStopKeepsTheOriginalReplicasWhenRepeated(t *testing.T) {
	stopped := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "a",
		Annotations: map[string]string{migrationReplicasAnnotation: "5"}}, Spec: appsv1.DeploymentSpec{Replicas: int32p(0)}}
	f := newCutoverFixture(t, stopped)
	finishJobs(f.srcC, true)
	if err := f.run(); err != nil {
		t.Fatal(err)
	}
	var got int32 = -1
	for _, w := range f.rec.Workloads {
		if w.Name == "api" {
			got = w.Replicas
		}
	}
	if got != 5 {
		t.Fatalf("recorded replicas = %d: a retried stop must not record the 0 it set", got)
	}
}

func TestCutoverLeavesAWorkloadOwnedBySomethingElse(t *testing.T) {
	owned := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "managed", Namespace: "a", OwnerReferences: []metav1.OwnerReference{ownerRefForTest()}},
		Spec: appsv1.DeploymentSpec{Replicas: int32p(2)}}
	f := newCutoverFixture(t, owned)
	finishJobs(f.srcC, true)
	if err := f.run(); err != nil {
		t.Fatal(err)
	}
	dep, _ := f.srcC.AppsV1().Deployments("a").Get(context.Background(), "managed", metav1.GetOptions{})
	if *dep.Spec.Replicas != 2 {
		t.Fatal("its owner would only scale it back")
	}
}

func TestRestartSourceRestoresWhatItHad(t *testing.T) {
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "a", Annotations: map[string]string{migrationReplicasAnnotation: "3"}},
		Spec: appsv1.DeploymentSpec{Replicas: int32p(0)}}
	held := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "held", Namespace: "a", Annotations: map[string]string{migrationSuspendedAnnotation: "true"}},
		Spec: batchv1.CronJobSpec{Suspend: boolp(true)}}
	live := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "live", Namespace: "a", Annotations: map[string]string{migrationSuspendedAnnotation: "false"}},
		Spec: batchv1.CronJobSpec{Suspend: boolp(true)}}
	src, cs := migClusterWith(dep, held, live)
	rec := &models.MigrationRecord{
		Workloads: []models.MigrationWorkload{{Kind: "Deployment", Namespace: "a", Name: "web", Replicas: 3}},
		CronJobs:  []models.MigrationCronJob{{Namespace: "a", Name: "held", WasSuspended: true}, {Namespace: "a", Name: "live"}},
	}
	if err := RestartMigrationSource(context.Background(), src, rec); err != nil {
		t.Fatal(err)
	}
	d, _ := cs.AppsV1().Deployments("a").Get(context.Background(), "web", metav1.GetOptions{})
	if *d.Spec.Replicas != 3 {
		t.Errorf("replicas = %d", *d.Spec.Replicas)
	}
	if _, ok := d.Annotations[migrationReplicasAnnotation]; ok {
		t.Error("annotation left behind")
	}
	h, _ := cs.BatchV1().CronJobs("a").Get(context.Background(), "held", metav1.GetOptions{})
	if !*h.Spec.Suspend {
		t.Error("a CronJob suspended before the migration was started")
	}
	l, _ := cs.BatchV1().CronJobs("a").Get(context.Background(), "live", metav1.GetOptions{})
	if *l.Spec.Suspend {
		t.Error("a running CronJob stayed suspended")
	}
}

func prepareFixture(t *testing.T, failDryRun error) (*cutoverFixture, error) {
	f := newCutoverFixture(t)
	f.rec.Phase = models.MigrationPreparing
	_, _, dyn := migFakeCluster("target", migSide{})
	f.dst.Dyn, f.applied = dyn, recordApplies(dyn, failDryRun)
	// The fake receiver has to look running for Prepare to go on.
	f.dstC.PrependReactor("create", "pods", func(a k8stesting.Action) (bool, runtime.Object, error) {
		p := a.(k8stesting.CreateAction).GetObject().(*corev1.Pod)
		p.Status = corev1.PodStatus{Phase: corev1.PodRunning, PodIP: "10.0.0.9"}
		return false, nil, nil
	})
	err := PrepareMigration(context.Background(), f.src, f.dst, f.rec, func() error { return nil })
	return f, err
}

func TestPrepareDryRunsThenCreatesEverythingHeldBack(t *testing.T) {
	f, err := prepareFixture(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	if f.rec.Phase != models.MigrationCopying {
		t.Fatalf("phase = %s", f.rec.Phase)
	}
	var sawDry, sawRealAfterDry bool
	for _, a := range *f.applied {
		if a.dryRun {
			sawDry = true
		} else if sawDry {
			sawRealAfterDry = true
		}
		if a.u.GetKind() == "DaemonSet" {
			t.Fatal("a DaemonSet would start running at once; it waits for the final apply")
		}
		if a.u.GetName() == "kept-by-user" {
			t.Fatal("skipped by the user")
		}
		if a.u.GetKind() != "Namespace" && a.u.GetLabels()[migrationLabel] != f.rec.ID {
			t.Fatalf("no migration label on %s", a.u.GetName())
		}
	}
	if !sawDry || !sawRealAfterDry {
		t.Fatalf("dry=%v real=%v", sawDry, sawRealAfterDry)
	}
	web := f.appliedNamed("web")
	if web.Object["spec"].(map[string]any)["replicas"] != float64(0) {
		t.Fatalf("web = %+v", web)
	}
	if len(f.rec.Objects) == 0 {
		t.Fatal("the record lists what moves")
	}
	if _, err := f.dstC.CoreV1().Pods("a").Get(context.Background(), moverReceiverName(f.rec.ID, 1), metav1.GetOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareStopsOnARejectedDryRun(t *testing.T) {
	f, err := prepareFixture(t, errors.New("admission said no"))
	if err == nil || !strings.Contains(err.Error(), "admission said no") {
		t.Fatalf("err = %v", err)
	}
	for _, a := range *f.applied {
		if a.u.GetKind() != "Namespace" {
			t.Fatalf("%s was written after a rejected dry run", a.u.GetName())
		}
	}
}

func TestMigrationResultJoinsTheRecordWithTheClusters(t *testing.T) {
	rec := &models.MigrationRecord{ID: "abcd1234", Source: "s", Target: "t", Phase: models.MigrationDone, Namespaces: []string{"a"},
		CutoverStartedAt: "2026-11-08T10:00:00Z", CutoverEndedAt: "2026-11-08T10:04:12Z",
		Objects:   []models.MigrationObject{{Kind: "ConfigMap", Namespace: "a", Name: "c"}, {Kind: "Deployment", Namespace: "a", Name: "web"}},
		Disks:     []models.MigrationDiskRun{{BytesCopied: 1000, MigrationDisk: models.MigrationDisk{Namespace: "a", Name: "data", SourceClass: "ssd", TargetClass: "gp3", Size: "10Gi", Copy: true}}},
		Workloads: []models.MigrationWorkload{{Kind: "Deployment", Namespace: "a", Name: "web", Replicas: 2}, {Kind: "StatefulSet", Namespace: "a", Name: "gone", Replicas: 1}}}

	sel := &metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}}
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "a"}, Spec: appsv1.DeploymentSpec{Replicas: int32p(2), Selector: sel}, Status: appsv1.DeploymentStatus{ReadyReplicas: 1}}
	crash := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "a", Labels: map[string]string{"app": "web"}}, Status: corev1.PodStatus{
		ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}}}}
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "data", Namespace: "a"}, Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound}}
	lb := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "edge", Namespace: "a"}, Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeLoadBalancer},
		Status: corev1.ServiceStatus{LoadBalancer: corev1.LoadBalancerStatus{Ingress: []corev1.LoadBalancerIngress{{IP: "203.0.113.10"}}}}}
	ing := &networkingv1.Ingress{ObjectMeta: metav1.ObjectMeta{Name: "site", Namespace: "a"},
		Spec:   networkingv1.IngressSpec{Rules: []networkingv1.IngressRule{{Host: "shop.example.com"}}},
		Status: networkingv1.IngressStatus{LoadBalancer: networkingv1.IngressLoadBalancerStatus{Ingress: []networkingv1.IngressLoadBalancerIngress{{Hostname: "lb.example.com"}}}}}
	stopped := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "a"}, Spec: appsv1.DeploymentSpec{Replicas: int32p(0)}}

	src, _ := migClusterWith(stopped)
	dst, _ := migClusterWith(dep, crash, pvc, lb, ing)
	got := BuildMigrationResult(context.Background(), src, dst, rec)

	if got.ObjectCount != 2 || got.BytesCopied != 1000 || got.DowntimeSeconds != 252 {
		t.Fatalf("summary = %+v", got)
	}
	if got.Workloads[0].Ready != 1 || got.Workloads[0].Desired != 2 || got.Workloads[0].Reason != "CrashLoopBackOff" {
		t.Fatalf("workload = %+v", got.Workloads[0])
	}
	if got.Workloads[1].Reason != "NotFound" || got.Workloads[1].Desired != 1 {
		t.Fatalf("workload = %+v", got.Workloads[1])
	}
	if d := got.Disks[0]; d.Status != "Bound" || d.TargetClass != "gp3" || !d.Copied || d.BytesCopied != 1000 {
		t.Fatalf("disk = %+v", d)
	}
	addr := map[string]string{}
	for _, a := range got.Addresses {
		addr[a.Name] = a.Host + "|" + a.Address
	}
	if addr["edge"] != "|203.0.113.10" || addr["site"] != "shop.example.com|lb.example.com" {
		t.Fatalf("addresses = %+v", got.Addresses)
	}
	if !got.SourceStopped {
		t.Fatalf("source = %+v", got)
	}
}

func TestMigrationDecisionsNeverOverwriteADisk(t *testing.T) {
	pf := models.MigrationPreflight{Conflicts: []models.MigrationConflict{
		{Key: "cm-ow"}, {Key: "cm-none"}, {Key: "disk", IsPVC: true},
	}}
	got := MigrationDecisions(pf, map[string]string{"cm-ow": "overwrite", "disk": "overwrite"})
	if got["cm-ow"] != "overwrite" || got["cm-none"] != "skip" || got["disk"] != "skip" {
		t.Fatalf("decisions = %v", got)
	}
}

func TestMigrationRecordHoldsNoSecretValues(t *testing.T) {
	f := newCutoverFixture(t)
	secret := migObj("v1", "Secret", "a", "db-pass", map[string]any{"type": "Opaque", "data": map[string]any{"password": "dG9wLXNlY3JldA=="}})
	src, _, _ := migFakeCluster("source", migSide{typed: []runtime.Object{migNS("a", nil)}, dyn: []runtime.Object{secret}})
	f.rec.Phase = models.MigrationPreparing
	f.rec.Disks = nil
	_, _, dyn := migFakeCluster("target", migSide{})
	f.dst.Dyn, f.applied = dyn, recordApplies(dyn, nil)
	if err := PrepareMigration(context.Background(), src, f.dst, f.rec, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if f.appliedNamed("db-pass") == nil {
		t.Fatal("the secret has to reach the target")
	}
	raw, err := json.Marshal(f.rec)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "dG9wLXNlY3JldA==") {
		t.Fatalf("record = %s", raw)
	}
}
