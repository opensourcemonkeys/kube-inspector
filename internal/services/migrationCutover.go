package services_k8sclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/types"

	"kube-ins/internal/models"
)

// The steps of the final switch, in order. MigrationRecord.Step holds the one
// running, and each can be repeated: a switch that stopped part-way continues
// from there.
const (
	migrationStepStop      = "stop"
	migrationStepDrain     = "drain"
	migrationStepFinalSync = "finalSync"
	migrationStepCleanup   = "cleanup"
	// MigrationStepApply starts the target, so a switch cannot be abandoned from it.
	MigrationStepApply = "apply"

	// MigrationDecisionSkip is a conflict the user left as it is on the target.
	migrationDecisionSkip   = "skip"
	migrationDefaultDrain   = 5 * time.Minute
	migrationSendersTimeout = 2 * time.Minute
)

// MigrationCutoverOptions are the seams of the final switch.
type MigrationCutoverOptions struct {
	Save         func() error
	Report       func()
	Poll         time.Duration
	DrainTimeout time.Duration
}

// RunMigrationCutover stops the source, copies what changed since the last pass
// and starts the target. Nothing on the target starts until no pod writes to
// the copied volumes and the last copy has finished.
func RunMigrationCutover(ctx context.Context, src, dst MigrationCluster, rec *models.MigrationRecord, opts MigrationCutoverOptions) error {
	if opts.Poll == 0 {
		opts.Poll = moverPoll
	}
	if opts.DrainTimeout == 0 {
		opts.DrainTimeout = migrationDefaultDrain
	}
	if opts.Report == nil {
		opts.Report = func() {}
	}
	if rec.CutoverStartedAt == "" {
		rec.CutoverStartedAt = time.Now().UTC().Format(time.RFC3339)
	}
	rec.Phase = models.MigrationCutover

	steps := []struct {
		name string
		run  func() error
	}{
		{migrationStepStop, func() error { return stopMigrationSource(ctx, src, rec, opts.Save) }},
		{migrationStepDrain, func() error { return waitForNoWriters(ctx, src, rec, opts) }},
		{migrationStepFinalSync, func() error { return runFinalSync(ctx, src, dst, rec, opts) }},
		{migrationStepCleanup, func() error {
			return errors.Join(deleteMoverObjects(ctx, src, rec), deleteMoverObjects(ctx, dst, rec))
		}},
		{MigrationStepApply, func() error { return applyFinalObjects(ctx, src, dst, rec) }},
	}
	first := 0
	for i, s := range steps {
		if s.name == rec.Step {
			first = i
		}
	}
	for _, s := range steps[first:] {
		rec.Step, rec.Error = s.name, ""
		if err := opts.Save(); err != nil {
			return err
		}
		opts.Report()
		if err := s.run(); err != nil {
			rec.Error = err.Error()
			_ = opts.Save()
			opts.Report()
			return err
		}
	}
	rec.Phase, rec.Step, rec.Error = models.MigrationDone, "", ""
	rec.CutoverEndedAt = time.Now().UTC().Format(time.RFC3339)
	err := opts.Save()
	opts.Report()
	return err
}

func migrationPatch(annotation, value string, spec map[string]any) ([]byte, error) {
	return json.Marshal(map[string]any{
		"metadata": map[string]any{"annotations": map[string]any{annotation: value}},
		"spec":     spec,
	})
}

// stopMigrationSource records what each workload had and stops it. Written to
// be repeated: an annotation already there is what the workload had, the
// replicas on it now are the 0 of an earlier attempt.
func stopMigrationSource(ctx context.Context, src MigrationCluster, rec *models.MigrationRecord, save func() error) error {
	type stop struct {
		patch func([]byte) error
		body  []byte
	}
	var stops []stop
	rec.Workloads, rec.CronJobs = []models.MigrationWorkload{}, []models.MigrationCronJob{}
	opts := metav1.PatchOptions{FieldManager: fieldManager}
	for _, ns := range rec.Namespaces {
		deployments, err := src.Client.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return fmt.Errorf("list deployments in %s: %w", ns, err)
		}
		for i := range deployments.Items {
			d := &deployments.Items[i]
			if len(d.OwnerReferences) > 0 {
				continue
			}
			replicas := migrationOriginalReplicas(d.Annotations, d.Spec.Replicas)
			rec.Workloads = append(rec.Workloads, models.MigrationWorkload{Kind: "Deployment", Namespace: ns, Name: d.Name, Replicas: replicas})
			body, err := migrationPatch(migrationReplicasAnnotation, strconv.Itoa(int(replicas)), map[string]any{"replicas": 0})
			if err != nil {
				return err
			}
			name, api := d.Name, src.Client.AppsV1().Deployments(ns)
			stops = append(stops, stop{func(b []byte) error {
				_, err := api.Patch(ctx, name, types.MergePatchType, b, opts)
				return err
			}, body})
		}
		statefulSets, err := src.Client.AppsV1().StatefulSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return fmt.Errorf("list statefulsets in %s: %w", ns, err)
		}
		for i := range statefulSets.Items {
			s := &statefulSets.Items[i]
			if len(s.OwnerReferences) > 0 {
				continue
			}
			replicas := migrationOriginalReplicas(s.Annotations, s.Spec.Replicas)
			rec.Workloads = append(rec.Workloads, models.MigrationWorkload{Kind: "StatefulSet", Namespace: ns, Name: s.Name, Replicas: replicas})
			body, err := migrationPatch(migrationReplicasAnnotation, strconv.Itoa(int(replicas)), map[string]any{"replicas": 0})
			if err != nil {
				return err
			}
			name, api := s.Name, src.Client.AppsV1().StatefulSets(ns)
			stops = append(stops, stop{func(b []byte) error {
				_, err := api.Patch(ctx, name, types.MergePatchType, b, opts)
				return err
			}, body})
		}
		cronJobs, err := src.Client.BatchV1().CronJobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return fmt.Errorf("list cronjobs in %s: %w", ns, err)
		}
		for i := range cronJobs.Items {
			c := &cronJobs.Items[i]
			if len(c.OwnerReferences) > 0 {
				continue
			}
			was := c.Spec.Suspend != nil && *c.Spec.Suspend
			if v, ok := c.Annotations[migrationSuspendedAnnotation]; ok {
				was = v == "true"
			}
			rec.CronJobs = append(rec.CronJobs, models.MigrationCronJob{Namespace: ns, Name: c.Name, WasSuspended: was})
			body, err := migrationPatch(migrationSuspendedAnnotation, strconv.FormatBool(was), map[string]any{"suspend": true})
			if err != nil {
				return err
			}
			name, api := c.Name, src.Client.BatchV1().CronJobs(ns)
			stops = append(stops, stop{func(b []byte) error {
				_, err := api.Patch(ctx, name, types.MergePatchType, b, opts)
				return err
			}, body})
		}
	}
	// Saved first: losing track of a workload this is about to stop is the one
	// mistake that could not be repaired afterwards.
	if err := save(); err != nil {
		return err
	}
	for _, s := range stops {
		if err := s.patch(s.body); err != nil {
			return fmt.Errorf("stop the source: %w", err)
		}
	}
	return nil
}

func migrationOriginalReplicas(annotations map[string]string, spec *int32) int32 {
	if v, ok := annotations[migrationReplicasAnnotation]; ok {
		if n, err := strconv.ParseInt(v, 10, 32); err == nil {
			return int32(n)
		}
	}
	if spec != nil {
		return *spec
	}
	return 1
}

func copiedDisks(rec *models.MigrationRecord) []*models.MigrationDiskRun {
	var out []*models.MigrationDiskRun
	for i := range rec.Disks {
		if rec.Disks[i].Copy {
			out = append(out, &rec.Disks[i])
		}
	}
	return out
}

// waitForNoWriters holds the final copy back until nothing has a copied volume
// mounted. A pod that keeps coming back (GitOps, an operator) ends the wait
// with its name, before anything on the target has started.
func waitForNoWriters(ctx context.Context, src MigrationCluster, rec *models.MigrationRecord, opts MigrationCutoverOptions) error {
	deadline := time.Now().Add(opts.DrainTimeout)
	for {
		var busy []string
		for _, d := range copiedDisks(rec) {
			pods, err := src.Client.CoreV1().Pods(d.Namespace).List(ctx, metav1.ListOptions{})
			if err != nil {
				return fmt.Errorf("list pods in %s: %w", d.Namespace, err)
			}
			for i := range pods.Items {
				p := &pods.Items[i]
				if p.Labels[moverLabel] == "" && podIsActive(p) && podMountsClaim(p, d.Name) {
					busy = append(busy, p.Namespace+"/"+p.Name)
				}
			}
		}
		if len(busy) == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("these pods still use a copied volume: %s. If something keeps starting them (GitOps, an operator), stop that first, then continue", strings.Join(busy, ", "))
		}
		if err := migrationSleep(ctx, opts.Poll); err != nil {
			return err
		}
	}
}

func migrationSleep(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// removeSenders ends every pass still running and waits for its pod to let go
// of the volume.
func removeSenders(ctx context.Context, src MigrationCluster, rec *models.MigrationRecord, opts MigrationCutoverOptions) error {
	listOpts := metav1.ListOptions{LabelSelector: moverSelector(rec.ID)}
	sendPrefix := "kube-ins-send-" + moverShort(rec.ID) + "-"
	for _, ns := range moverNamespaces(rec) {
		jobs, err := src.Client.BatchV1().Jobs(ns).List(ctx, listOpts)
		if err != nil {
			return fmt.Errorf("list copy jobs in %s: %w", ns, err)
		}
		for i := range jobs.Items {
			if strings.HasPrefix(jobs.Items[i].Name, sendPrefix) {
				if err := deleteMoverJob(ctx, src, ns, jobs.Items[i].Name); err != nil {
					return err
				}
			}
		}
		deadline := time.Now().Add(migrationSendersTimeout)
		for {
			pods, err := src.Client.CoreV1().Pods(ns).List(ctx, listOpts)
			if err != nil {
				return fmt.Errorf("list copy pods in %s: %w", ns, err)
			}
			busy := false
			for i := range pods.Items {
				busy = busy || (strings.HasPrefix(pods.Items[i].Labels["job-name"], sendPrefix) && podIsActive(&pods.Items[i]))
			}
			if !busy {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("the copy pods in %s did not stop in time", ns)
			}
			if err := migrationSleep(ctx, opts.Poll); err != nil {
				return err
			}
		}
	}
	return nil
}

func runFinalSync(ctx context.Context, src, dst MigrationCluster, rec *models.MigrationRecord, opts MigrationCutoverOptions) error {
	if err := removeSenders(ctx, src, rec, opts); err != nil {
		return err
	}
	disks := copiedDisks(rec)
	for _, d := range disks {
		name := moverFinalName(rec.ID, d.Index)
		existing, err := src.Client.BatchV1().Jobs(d.Namespace).Get(ctx, name, metav1.GetOptions{})
		if err == nil && existing.Status.Failed > 0 {
			// A failed attempt from before this one: its log is not this run's.
			if err := deleteMoverJob(ctx, src, d.Namespace, name); err != nil {
				return err
			}
			err = apierrors.NewNotFound(batchv1.Resource("jobs"), name)
		}
		switch {
		case apierrors.IsNotFound(err):
			addrs, err := receiverAddrs(ctx, dst, rec.ID, *d)
			if err != nil {
				return fmt.Errorf("find the receiver of %s/%s: %w", d.Namespace, d.Name, err)
			}
			job := moverSendJob(moverSendSpec{ID: rec.ID, Image: rec.MoverImage, Disk: *d, Final: true, Addrs: addrs, BandwidthKBps: rec.BandwidthKBps})
			if _, err := src.Client.BatchV1().Jobs(d.Namespace).Create(ctx, job, metav1.CreateOptions{}); err != nil {
				return fmt.Errorf("start the last copy of %s/%s: %w", d.Namespace, d.Name, err)
			}
		case err != nil:
			return err
		}
	}
	pending := append([]*models.MigrationDiskRun(nil), disks...)
	for len(pending) > 0 {
		var next []*models.MigrationDiskRun
		for _, d := range pending {
			name := moverFinalName(rec.ID, d.Index)
			job, err := src.Client.BatchV1().Jobs(d.Namespace).Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				return err
			}
			switch {
			case job.Status.Succeeded > 0:
				log := parseMoverLog(readMoverLog(ctx, src, d.Namespace, name))
				d.Passes++
				d.LastPassAt, d.Error = time.Now().UTC().Format(time.RFC3339), ""
				if log.TotalBytes > 0 {
					d.BytesCopied = log.TotalBytes
				}
				if err := deleteMoverJob(ctx, src, d.Namespace, name); err != nil {
					return err
				}
				if err := opts.Save(); err != nil {
					return err
				}
				opts.Report()
			case job.Status.Failed > 0:
				d.Error = moverFailure(parseMoverLog(readMoverLog(ctx, src, d.Namespace, name)), job)
				return fmt.Errorf("the last copy of %s/%s failed: %s", d.Namespace, d.Name, d.Error)
			default:
				next = append(next, d)
			}
		}
		pending = next
		if len(pending) > 0 {
			if err := migrationSleep(ctx, opts.Poll); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrationNamespaceObject(ctx context.Context, src MigrationCluster, ns string, id string) (*unstructured.Unstructured, error) {
	live, err := src.Client.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("read namespace %s: %w", ns, err)
	}
	u := migObjNamespace(ns, live.Labels, live.Annotations)
	if id != "" {
		addLabel(u, migrationLabel, id)
	}
	return u, nil
}

func migObjNamespace(name string, labels, annotations map[string]string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": name}}}
	if len(labels) > 0 {
		u.SetLabels(labels)
	}
	if len(annotations) > 0 {
		u.SetAnnotations(annotations)
	}
	return u
}

func migrationSkippedByUser(rec *models.MigrationRecord, u *unstructured.Unstructured) bool {
	return rec.Decisions[migrationKey(u)] == migrationDecisionSkip
}

// applyFinalObjects writes everything once more in its final form: what changed
// on the source since the preparation, the replicas and CronJobs it had, the
// DaemonSets that had to wait. Leaving the migration label out removes it.
func applyFinalObjects(ctx context.Context, src, dst MigrationCluster, rec *models.MigrationRecord) error {
	for _, ns := range rec.Namespaces {
		u, err := migrationNamespaceObject(ctx, src, ns, "")
		if err != nil {
			return err
		}
		if err := dst.applyObject(ctx, u, false); err != nil {
			return err
		}
	}
	col, _, err := planMigrationObjects(ctx, src, dst, rec.Namespaces)
	if err != nil {
		return err
	}
	var objs []*unstructured.Unstructured
	for _, u := range col.Keep {
		if migrationSkippedByUser(rec, u) {
			continue
		}
		shaped := migratable(u, rec.StorageClasses)
		shapeForFinal(shaped, rec)
		objs = append(objs, shaped)
	}
	sortForApply(objs)
	var errs []error
	for _, u := range objs {
		if err := dst.applyObject(ctx, u, false); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// PrepareMigration creates everything on the target, held back, and starts the
// receivers. Nothing on the source has stopped yet, so whatever goes wrong here
// costs no downtime. It starts from a clean slate, so it can be repeated.
func PrepareMigration(ctx context.Context, src, dst MigrationCluster, rec *models.MigrationRecord, save func() error) error {
	if err := errors.Join(deleteMoverObjects(ctx, src, rec), deleteMoverObjects(ctx, dst, rec)); err != nil {
		return err
	}
	col, _, err := planMigrationObjects(ctx, src, dst, rec.Namespaces)
	if err != nil {
		return err
	}
	rec.Objects, rec.Skipped = []models.MigrationObject{}, col.Skipped
	var objs []*unstructured.Unstructured
	for _, u := range col.Keep {
		if migrationSkippedByUser(rec, u) {
			rec.Skipped = append(rec.Skipped, models.MigrationSkipped{Kind: u.GetKind(), Namespace: u.GetNamespace(), Name: u.GetName(), Reason: MigrationSkipUserChoice})
			continue
		}
		rec.Objects = append(rec.Objects, models.MigrationObject{Kind: u.GetKind(), Namespace: u.GetNamespace(), Name: u.GetName()})
		if isDaemonSet(u) {
			continue // it would start running at once
		}
		shaped := migratable(u, rec.StorageClasses)
		shapeForPrepare(shaped, rec.ID)
		objs = append(objs, shaped)
	}
	sortForApply(objs)
	if err := save(); err != nil {
		return err
	}

	// A dry run of a namespaced object needs its namespace to exist.
	for _, ns := range rec.Namespaces {
		u, err := migrationNamespaceObject(ctx, src, ns, rec.ID)
		if err != nil {
			return err
		}
		if err := dst.applyObject(ctx, u, false); err != nil {
			return err
		}
	}
	var errs []error
	for _, u := range objs {
		if err := dst.applyObject(ctx, u.DeepCopy(), true); err != nil {
			errs = append(errs, err)
		}
	}
	if err := errors.Join(errs...); err != nil {
		return err
	}
	for _, u := range objs {
		if err := dst.applyObject(ctx, u, false); err != nil {
			return err
		}
	}
	if err := startMoverReceivers(ctx, src, dst, rec); err != nil {
		return err
	}
	rec.Phase = models.MigrationCopying
	return save()
}

// RestartMigrationSource starts the stopped source as it was. The annotations
// on the workloads are what it goes by; a workload without one was not stopped
// by this migration.
func RestartMigrationSource(ctx context.Context, src MigrationCluster, rec *models.MigrationRecord) error {
	opts := metav1.PatchOptions{FieldManager: fieldManager}
	body := func(annotation string, spec map[string]any) ([]byte, error) {
		return json.Marshal(map[string]any{"metadata": map[string]any{"annotations": map[string]any{annotation: nil}}, "spec": spec})
	}
	var errs []error
	for _, w := range rec.Workloads {
		var annotations map[string]string
		var err error
		switch w.Kind {
		case "Deployment":
			var d *appsv1.Deployment
			if d, err = src.Client.AppsV1().Deployments(w.Namespace).Get(ctx, w.Name, metav1.GetOptions{}); err == nil {
				annotations = d.Annotations
			}
		case "StatefulSet":
			var s *appsv1.StatefulSet
			if s, err = src.Client.AppsV1().StatefulSets(w.Namespace).Get(ctx, w.Name, metav1.GetOptions{}); err == nil {
				annotations = s.Annotations
			}
		}
		if err != nil {
			errs = append(errs, ignoreNotFound(err))
			continue
		}
		v, ok := annotations[migrationReplicasAnnotation]
		if !ok {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s/%s: %w", w.Namespace, w.Name, err))
			continue
		}
		b, err := body(migrationReplicasAnnotation, map[string]any{"replicas": n})
		if err != nil {
			return err
		}
		if w.Kind == "Deployment" {
			_, err = src.Client.AppsV1().Deployments(w.Namespace).Patch(ctx, w.Name, types.MergePatchType, b, opts)
		} else {
			_, err = src.Client.AppsV1().StatefulSets(w.Namespace).Patch(ctx, w.Name, types.MergePatchType, b, opts)
		}
		errs = append(errs, ignoreNotFound(err))
	}
	for _, c := range rec.CronJobs {
		live, err := src.Client.BatchV1().CronJobs(c.Namespace).Get(ctx, c.Name, metav1.GetOptions{})
		if err != nil {
			errs = append(errs, ignoreNotFound(err))
			continue
		}
		v, ok := live.Annotations[migrationSuspendedAnnotation]
		if !ok {
			continue
		}
		b, err := body(migrationSuspendedAnnotation, map[string]any{"suspend": v == "true"})
		if err != nil {
			return err
		}
		_, err = src.Client.BatchV1().CronJobs(c.Namespace).Patch(ctx, c.Name, types.MergePatchType, b, opts)
		errs = append(errs, ignoreNotFound(err))
	}
	return errors.Join(errs...)
}

// MigrationResultFromRecord is the part of the status screen the record alone
// can answer.
func MigrationResultFromRecord(rec *models.MigrationRecord) models.MigrationResult {
	out := models.MigrationResult{ID: rec.ID, Source: rec.Source, Target: rec.Target, Phase: rec.Phase, Error: rec.Error, Namespaces: rec.Namespaces,
		ObjectCount: len(rec.Objects), Skipped: rec.Skipped, Workloads: []models.MigrationWorkloadState{}, Disks: []models.MigrationDiskState{}, Addresses: []models.MigrationAddress{}}
	if started, err := time.Parse(time.RFC3339, rec.CutoverStartedAt); err == nil {
		if ended, err := time.Parse(time.RFC3339, rec.CutoverEndedAt); err == nil {
			out.DowntimeSeconds = int64(ended.Sub(started).Seconds())
		}
	}
	return out
}

// BuildMigrationResult joins a record with the two clusters as they are now.
// An unreachable cluster leaves LiveError set and the record's facts standing.
func BuildMigrationResult(ctx context.Context, src, dst MigrationCluster, rec *models.MigrationRecord) models.MigrationResult {
	out := MigrationResultFromRecord(rec)
	var live []error
	pods := map[string][]corev1.Pod{}
	for _, ns := range rec.Namespaces {
		list, err := dst.Client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			live = append(live, err)
			continue
		}
		pods[ns] = list.Items
	}
	for _, w := range rec.Workloads {
		st := models.MigrationWorkloadState{Kind: w.Kind, Namespace: w.Namespace, Name: w.Name, Desired: w.Replicas}
		var selector *metav1.LabelSelector
		var err error
		if w.Kind == "Deployment" {
			var d *appsv1.Deployment
			if d, err = dst.Client.AppsV1().Deployments(w.Namespace).Get(ctx, w.Name, metav1.GetOptions{}); err == nil {
				st.Ready, selector = d.Status.ReadyReplicas, d.Spec.Selector
				if d.Spec.Replicas != nil {
					st.Desired = *d.Spec.Replicas
				}
			}
		} else {
			var s *appsv1.StatefulSet
			if s, err = dst.Client.AppsV1().StatefulSets(w.Namespace).Get(ctx, w.Name, metav1.GetOptions{}); err == nil {
				st.Ready, selector = s.Status.ReadyReplicas, s.Spec.Selector
				if s.Spec.Replicas != nil {
					st.Desired = *s.Spec.Replicas
				}
			}
		}
		switch {
		case apierrors.IsNotFound(err):
			st.Reason = "NotFound"
		case err != nil:
			live = append(live, err)
		case st.Ready < st.Desired:
			st.Reason = migrationWaitReason(pods[w.Namespace], selector)
		}
		out.Workloads = append(out.Workloads, st)
	}
	for _, d := range rec.Disks {
		out.BytesCopied += d.BytesCopied
		st := models.MigrationDiskState{Namespace: d.Namespace, Name: d.Name, Size: d.Size, SourceClass: d.SourceClass, TargetClass: d.TargetClass, Copied: d.Copy, BytesCopied: d.BytesCopied}
		pvc, err := dst.Client.CoreV1().PersistentVolumeClaims(d.Namespace).Get(ctx, d.Name, metav1.GetOptions{})
		switch {
		case err == nil:
			st.Status = string(pvc.Status.Phase)
		case apierrors.IsNotFound(err):
			st.Status = "NotFound"
		default:
			live = append(live, err)
		}
		out.Disks = append(out.Disks, st)
	}
	for _, ns := range rec.Namespaces {
		addresses, err := migrationAddresses(ctx, dst, ns)
		if err != nil {
			live = append(live, err)
			continue
		}
		out.Addresses = append(out.Addresses, addresses...)
	}
	out.SourceStopped = true
	for _, w := range rec.Workloads {
		replicas, err := migrationLiveReplicas(ctx, src, w)
		if err != nil {
			if !apierrors.IsNotFound(err) {
				live = append(live, err)
			}
			continue
		}
		out.SourceStopped = out.SourceStopped && replicas == 0
	}
	if err := errors.Join(live...); err != nil {
		out.LiveError = err.Error()
	}
	return out
}

func migrationLiveReplicas(ctx context.Context, c MigrationCluster, w models.MigrationWorkload) (int32, error) {
	var spec *int32
	if w.Kind == "Deployment" {
		d, err := c.Client.AppsV1().Deployments(w.Namespace).Get(ctx, w.Name, metav1.GetOptions{})
		if err != nil {
			return 0, err
		}
		spec = d.Spec.Replicas
	} else {
		s, err := c.Client.AppsV1().StatefulSets(w.Namespace).Get(ctx, w.Name, metav1.GetOptions{})
		if err != nil {
			return 0, err
		}
		spec = s.Spec.Replicas
	}
	if spec == nil {
		return 1, nil
	}
	return *spec, nil
}

// migrationWaitReason names why a workload is not ready, from its pods.
func migrationWaitReason(pods []corev1.Pod, selector *metav1.LabelSelector) string {
	if selector == nil {
		return ""
	}
	s, err := metav1.LabelSelectorAsSelector(selector)
	if err != nil {
		return ""
	}
	for i := range pods {
		if !s.Matches(labels.Set(pods[i].Labels)) {
			continue
		}
		for _, c := range pods[i].Status.ContainerStatuses {
			if c.State.Waiting != nil && c.State.Waiting.Reason != "" {
				return c.State.Waiting.Reason
			}
			if c.State.Terminated != nil && c.State.Terminated.Reason != "" {
				return c.State.Terminated.Reason
			}
		}
		if pods[i].Status.Phase == corev1.PodPending {
			return string(corev1.PodPending)
		}
	}
	return ""
}

func migrationAddresses(ctx context.Context, dst MigrationCluster, ns string) ([]models.MigrationAddress, error) {
	var out []models.MigrationAddress
	services, err := dst.Client.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for _, s := range services.Items {
		if s.Spec.Type != corev1.ServiceTypeLoadBalancer {
			continue
		}
		a := models.MigrationAddress{Kind: "Service", Namespace: ns, Name: s.Name}
		for _, i := range s.Status.LoadBalancer.Ingress {
			a.Address = firstNonEmpty(i.IP, i.Hostname)
			break
		}
		out = append(out, a)
	}
	ingresses, err := dst.Client.NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for _, i := range ingresses.Items {
		address := ""
		for _, lb := range i.Status.LoadBalancer.Ingress {
			address = firstNonEmpty(lb.IP, lb.Hostname)
			break
		}
		if len(i.Spec.Rules) == 0 {
			out = append(out, models.MigrationAddress{Kind: "Ingress", Namespace: ns, Name: i.Name, Address: address})
		}
		for _, r := range i.Spec.Rules {
			out = append(out, models.MigrationAddress{Kind: "Ingress", Namespace: ns, Name: i.Name, Host: r.Host, Address: address})
		}
	}
	return out, nil
}
