package business

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"kube-ins/internal/logging"
	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	"kube-ins/internal/safego"
	services "kube-ins/internal/services"
)

const (
	// migrationHistoryKeep is how many finished migrations are kept per source.
	migrationHistoryKeep = 20
	// A preflight reads every object of the namespaces on both clusters.
	migrationPreflightTimeout = 3 * time.Minute
	migrationTickTimeout      = 60 * time.Second
	migrationResultTimeout    = 30 * time.Second
	migrationRestartTimeout   = 60 * time.Second
)

// One migration is driven by one process: two would overwrite each other's
// record, and one could start a copy under the other's final switch. Several
// instances of the app are a feature, so this is a file both can see, kept
// fresh while held rather than tied to a platform's file locking; a holder that
// died simply stops touching it.
var (
	migrationLockStale = 30 * time.Second
	migrationLockBeat  = 5 * time.Second
)

// errMigrationElsewhere answers a request for a migration another window of
// Kube Inspector is running.
var errMigrationElsewhere = errors.New("another Kube Inspector window is running this migration; use that window")

func migrationLockPath(id string) (string, error) {
	base, err := kubeInsDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "migrations")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return filepath.Join(dir, ".lock-"+id), nil
}

func migrationLockFresh(path string) bool {
	info, err := os.Stat(path)
	return err == nil && time.Since(info.ModTime()) < migrationLockStale
}

// acquireMigrationLock takes the migration for this process, or says it cannot.
// The returned func keeps it fresh until called, and then releases it.
func acquireMigrationLock(id string) (func(), bool) {
	path, err := migrationLockPath(id)
	if err != nil {
		return nil, false
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		if migrationLockFresh(path) {
			return nil, false
		}
		// Left by a process that died.
		_ = os.Remove(path)
		if f, err = os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600); err != nil {
			return nil, false
		}
	}
	_ = f.Close()
	done := make(chan struct{})
	safego.Go("business.migrationLock", func() {
		t := time.NewTicker(migrationLockBeat)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case now := <-t.C:
				_ = os.Chtimes(path, now, now)
			}
		}
	})
	return func() {
		close(done)
		_ = os.Remove(path)
	}, true
}

// migrationRunElsewhere says another process holds the migration.
func migrationRunElsewhere(id string) bool {
	migrationRuns.Lock()
	_, ours := migrationRuns.m[id]
	migrationRuns.Unlock()
	if ours {
		return false
	}
	path, err := migrationLockPath(id)
	return err == nil && migrationLockFresh(path)
}

// migrationTickInterval is how often a running migration looks at its copies.
var migrationTickInterval = 3 * time.Second

// migrationOps is everything a run does to the clusters; a seam for the tests
// of the state machine below.
type migrationOps struct {
	clusters func(source, target string) (services.MigrationCluster, services.MigrationCluster, error)
	prepare  func(ctx context.Context, src, dst services.MigrationCluster, rec *models.MigrationRecord, save func() error) error
	tick     func(ctx context.Context, src, dst services.MigrationCluster, rec *models.MigrationRecord, now time.Time) ([]models.MigrationDiskProgress, error)
	cutover  func(ctx context.Context, src, dst services.MigrationCluster, rec *models.MigrationRecord, opts services.MigrationCutoverOptions) error
	cleanup  func(ctx context.Context, src, dst services.MigrationCluster, rec *models.MigrationRecord) error
	restart  func(ctx context.Context, src services.MigrationCluster, rec *models.MigrationRecord) error
}

var migrationBackend = migrationOps{
	clusters: migrationClusters,
	prepare:  services.PrepareMigration,
	tick:     services.TickMigrationCopy,
	cutover:  services.RunMigrationCutover,
	cleanup:  services.CleanupMigrationWorkers,
	restart:  services.RestartMigrationSource,
}

func migrationCluster(name string) (services.MigrationCluster, error) {
	client, config, err := repository.NewK8sClientAndConfigForCluster(name)
	if err != nil {
		return services.MigrationCluster{}, fmt.Errorf("connect to cluster %q: %w", name, err)
	}
	return services.NewMigrationCluster(name, client, config)
}

func migrationClusters(source, target string) (services.MigrationCluster, services.MigrationCluster, error) {
	src, err := migrationCluster(source)
	if err != nil {
		return src, src, err
	}
	dst, err := migrationCluster(target)
	return src, dst, err
}

func migrationHistoryDir(source string) (string, error) {
	base, err := kubeInsDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "migrations", trivySanitize(source))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return dir, nil
}

func migrationFileName(rec *models.MigrationRecord) string {
	stamp := rec.CreatedAt
	if t, err := time.Parse(time.RFC3339, rec.CreatedAt); err == nil {
		stamp = t.UTC().Format("20060102T150405Z")
	}
	return stamp + "-" + rec.ID + ".json"
}

func migrationIsFinished(phase string) bool {
	return phase == models.MigrationDone || phase == models.MigrationFailed || phase == models.MigrationCancelled
}

func saveMigrationRecord(rec *models.MigrationRecord) error {
	if !trivySafeID.MatchString(rec.ID) {
		return fmt.Errorf("invalid migration id %q", rec.ID)
	}
	dir, err := migrationHistoryDir(rec.Source)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(dir, migrationFileName(rec)), data); err != nil {
		return err
	}
	pruneMigrationHistory(dir)
	return nil
}

// pruneMigrationHistory drops the oldest finished migrations. One still under
// way is never dropped: its record is what can restart its source.
func pruneMigrationHistory(dir string) {
	records := readMigrationDir(dir)
	finished := 0
	for _, r := range records {
		if !migrationIsFinished(r.rec.Phase) {
			continue
		}
		finished++
		if finished > migrationHistoryKeep {
			_ = os.Remove(r.path)
		}
	}
}

type migrationFile struct {
	path string
	rec  *models.MigrationRecord
}

// readMigrationDir returns the directory's records, newest first.
func readMigrationDir(dir string) []migrationFile {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil
	}
	sort.Sort(sort.Reverse(sort.StringSlice(files)))
	out := make([]migrationFile, 0, len(files))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var rec models.MigrationRecord
		if err := json.Unmarshal(b, &rec); err != nil {
			logging.With("business.migration").Warn("unreadable migration record", "file", f, "err", err)
			continue
		}
		out = append(out, migrationFile{f, &rec})
	}
	return out
}

func loadMigrationRecord(id string) (*models.MigrationRecord, error) {
	if !trivySafeID.MatchString(id) {
		return nil, fmt.Errorf("invalid migration id %q", id)
	}
	base, err := kubeInsDir()
	if err != nil {
		return nil, err
	}
	matches, err := filepath.Glob(filepath.Join(base, "migrations", "*", "*-"+id+".json"))
	if err != nil {
		return nil, err
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("migration %s not found", id)
	}
	b, err := os.ReadFile(matches[0])
	if err != nil {
		return nil, err
	}
	var rec models.MigrationRecord
	if err := json.Unmarshal(b, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// ListMigrations returns a source cluster's migrations, newest first.
func ListMigrations(source string) ([]models.MigrationMeta, error) {
	dir, err := migrationHistoryDir(source)
	if err != nil {
		return nil, err
	}
	out := []models.MigrationMeta{}
	for _, r := range readMigrationDir(dir) {
		out = append(out, models.MigrationMeta{ID: r.rec.ID, Source: r.rec.Source, Target: r.rec.Target, Namespaces: r.rec.Namespaces, Phase: r.rec.Phase, CreatedAt: r.rec.CreatedAt})
	}
	return out, nil
}

// GetMigrationPreflight says what a migration would do. It writes nothing.
func GetMigrationPreflight(req models.MigrationRequest) (models.MigrationPreflight, error) {
	src, dst, err := migrationBackend.clusters(req.Source, req.Target)
	if err != nil {
		return models.MigrationPreflight{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), migrationPreflightTimeout)
	defer cancel()
	return services.RunMigrationPreflight(ctx, src, dst, req)
}

// migrationRun is a migration being driven by this process.
type migrationRun struct {
	cancel    context.CancelFunc
	cutover   atomic.Bool
	cancelled atomic.Bool
	switching atomic.Bool
}

var migrationRuns = struct {
	sync.Mutex
	m map[string]*migrationRun
}{m: map[string]*migrationRun{}}

// ensureMigrationRun drives a migration unless this process already does. set
// runs under the registry's lock, so a request cannot miss a loop just starting.
func ensureMigrationRun(id string, report func(models.MigrationProgress), set func(*migrationRun)) {
	migrationRuns.Lock()
	defer migrationRuns.Unlock()
	if r, ok := migrationRuns.m[id]; ok {
		if set != nil {
			set(r)
		}
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &migrationRun{cancel: cancel}
	if set != nil {
		set(r)
	}
	migrationRuns.m[id] = r
	safego.Go("business.migration", func() {
		defer cancel()
		// Whatever ended the loop, it has to leave the registry, or this
		// migration could never be driven again.
		defer removeMigrationRun(id, r)
		driveMigration(ctx, r, id, report)
	})
}

func removeMigrationRun(id string, r *migrationRun) {
	migrationRuns.Lock()
	defer migrationRuns.Unlock()
	if migrationRuns.m[id] == r {
		delete(migrationRuns.m, id)
	}
}

func migrationProgressOf(rec *models.MigrationRecord, disks []models.MigrationDiskProgress, interrupted bool) models.MigrationProgress {
	if disks == nil {
		disks = make([]models.MigrationDiskProgress, 0, len(rec.Disks))
		for _, d := range rec.Disks {
			disks = append(disks, models.MigrationDiskProgress{MigrationDiskRun: d})
		}
	}
	return models.MigrationProgress{ID: rec.ID, Source: rec.Source, Target: rec.Target, Phase: rec.Phase, Step: rec.Step, Error: rec.Error, Interrupted: interrupted, Disks: disks}
}

// driveMigration is the state machine of one migration. It owns the record
// while it runs: requests only set flags, so two writers can never race.
func driveMigration(ctx context.Context, r *migrationRun, id string, report func(models.MigrationProgress)) {
	log := logging.With("business.migration")
	release, ok := acquireMigrationLock(id)
	if !ok {
		return
	}
	defer release()
	rec, err := loadMigrationRecord(id)
	if err != nil {
		log.Error("cannot load migration", "id", id, "err", err)
		return
	}
	save := func() error { return saveMigrationRecord(rec) }
	// finish reports after leaving the registry, so a user who reacts to the
	// report always starts a new run rather than flagging this finished one.
	finish := func(interrupted bool) {
		removeMigrationRun(id, r)
		report(migrationProgressOf(rec, nil, interrupted))
	}
	src, dst, err := migrationBackend.clusters(rec.Source, rec.Target)
	if err != nil {
		rec.Error = err.Error()
		finish(rec.Phase == models.MigrationCutover)
		return
	}
	stopForCancel := func() {
		if rec.Phase == models.MigrationCutover {
			// An abandoned switch: the source was stopped by it, and leaving
			// it stopped would leave the application down.
			if err := migrationBackend.restart(context.WithoutCancel(ctx), src, rec); err != nil {
				log.Error("restarting the source of an abandoned switch", "id", id, "err", err)
				rec.Error = err.Error()
				_ = save()
				finish(true)
				return
			}
		}
		if err := migrationBackend.cleanup(context.WithoutCancel(ctx), src, dst, rec); err != nil {
			log.Error("cleaning up after a cancelled migration", "id", id, "err", err)
			rec.Error = err.Error()
		} else {
			rec.Error = ""
		}
		rec.Phase = models.MigrationCancelled
		if err := save(); err != nil {
			log.Error("saving migration", "id", id, "err", err)
		}
		finish(false)
	}
	runSwitch := func() {
		r.switching.Store(true)
		defer r.switching.Store(false)
		err := migrationBackend.cutover(ctx, src, dst, rec, services.MigrationCutoverOptions{
			Save:   save,
			Report: func() { report(migrationProgressOf(rec, nil, false)) },
		})
		if err != nil {
			log.Error("final switch stopped", "id", id, "step", rec.Step, "err", err)
			_ = save()
		}
		finish(err != nil)
	}

	if rec.Phase == models.MigrationPreparing {
		report(migrationProgressOf(rec, nil, false))
		err := migrationBackend.prepare(ctx, src, dst, rec, save)
		if r.cancelled.Load() {
			stopForCancel()
			return
		}
		if err != nil {
			log.Error("preparing migration", "id", id, "err", err)
			rec.Phase, rec.Error = models.MigrationFailed, err.Error()
			if cerr := migrationBackend.cleanup(context.WithoutCancel(ctx), src, dst, rec); cerr != nil {
				log.Error("cleaning up a failed migration", "id", id, "err", cerr)
			}
			_ = save()
			finish(false)
			return
		}
	}

	for {
		if r.cancelled.Load() {
			stopForCancel()
			return
		}
		switch rec.Phase {
		case models.MigrationCopying, models.MigrationReady:
			if r.cutover.Load() && rec.Phase == models.MigrationReady {
				runSwitch()
				return
			}
			tctx, cancel := context.WithTimeout(ctx, migrationTickTimeout)
			disks, err := migrationBackend.tick(tctx, src, dst, rec, time.Now().UTC())
			cancel()
			switch {
			case err != nil && ctx.Err() == nil:
				// The cluster may only be away for a moment; the workers go on.
				rec.Error = err.Error()
			case err == nil:
				rec.Error = ""
				if rec.Phase == models.MigrationCopying && services.MigrationCopyReady(rec) {
					rec.Phase = models.MigrationReady
				}
			}
			if err := save(); err != nil {
				log.Error("saving migration", "id", id, "err", err)
			}
			report(migrationProgressOf(rec, disks, false))
			select {
			case <-ctx.Done():
			case <-time.After(migrationTickInterval):
			}
		case models.MigrationCutover:
			if r.cutover.Load() {
				runSwitch()
				return
			}
			finish(true)
			return
		default:
			finish(false)
			return
		}
	}
}

// StartMigration runs the preflight once more, so a screen left open cannot
// start past a blocker that appeared since, and starts the migration.
func StartMigration(req models.MigrationRequest, report func(models.MigrationProgress)) (string, error) {
	if p := GetRunningMigration(req.Source, report); p != nil {
		return "", fmt.Errorf("a migration from %s is already running", req.Source)
	}
	pf, err := GetMigrationPreflight(req)
	if err != nil {
		return "", err
	}
	if services.MigrationBlocked(pf) {
		return "", errors.New("the preflight reports a blocker; check again and resolve it first")
	}
	image := req.MoverImage
	if image == "" {
		image = services.DefaultMigrationMoverImage
	}
	rec := &models.MigrationRecord{
		SchemaVersion: models.MigrationSchemaVersion, ID: uuid.NewString(), Source: req.Source, Target: req.Target, Namespaces: req.Namespaces,
		Phase: models.MigrationPreparing, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		StorageClasses: migrationChosenClasses(pf), Decisions: services.MigrationDecisions(pf, req.Decisions),
		BandwidthKBps: req.BandwidthKBps, MoverImage: image, Objects: pf.Objects, Skipped: pf.Skipped,
		Disks: services.MigrationDiskRuns(pf.Disks), Workloads: []models.MigrationWorkload{}, CronJobs: []models.MigrationCronJob{},
	}
	if err := saveMigrationRecord(rec); err != nil {
		return "", err
	}
	ensureMigrationRun(rec.ID, report, nil)
	return rec.ID, nil
}

// migrationChosenClasses is the class each disk ended up with in the preflight.
func migrationChosenClasses(pf models.MigrationPreflight) map[string]string {
	out := map[string]string{}
	for _, d := range pf.Disks {
		out[d.SourceClass] = d.TargetClass
	}
	return out
}

// GetRunningMigration returns the source's unfinished migration, or nil, and
// takes it up again if this process is not driving it (after a restart).
func GetRunningMigration(source string, report func(models.MigrationProgress)) *models.MigrationProgress {
	dir, err := migrationHistoryDir(source)
	if err != nil {
		return nil
	}
	for _, r := range readMigrationDir(dir) {
		if migrationIsFinished(r.rec.Phase) {
			continue
		}
		switching := migrationRunElsewhere(r.rec.ID)
		ensureMigrationRun(r.rec.ID, report, func(run *migrationRun) { switching = switching || run.switching.Load() })
		p := migrationProgressOf(r.rec, nil, r.rec.Phase == models.MigrationCutover && !switching)
		return &p
	}
	return nil
}

// StartMigrationCutover begins the final switch, or continues one that stopped.
func StartMigrationCutover(id string, report func(models.MigrationProgress)) error {
	rec, err := loadMigrationRecord(id)
	if err != nil {
		return err
	}
	if rec.Phase != models.MigrationReady && rec.Phase != models.MigrationCutover {
		return fmt.Errorf("this migration is not ready to switch (%s)", rec.Phase)
	}
	if migrationRunElsewhere(id) {
		return errMigrationElsewhere
	}
	ensureMigrationRun(id, report, func(r *migrationRun) { r.cutover.Store(true) })
	return nil
}

// CancelMigration stops a migration and removes its workers. What it created on
// the target stays, marked as its own, so another attempt continues from there.
// A final switch that has stopped can be abandoned too, which starts the source
// again, until the step that starts the target: from there it only goes forward.
func CancelMigration(id string, report func(models.MigrationProgress)) error {
	rec, err := loadMigrationRecord(id)
	if err != nil {
		return err
	}
	if migrationIsFinished(rec.Phase) {
		return nil
	}
	if rec.Phase == models.MigrationCutover && rec.Step == services.MigrationStepApply {
		return errors.New("the target may already be starting; this switch can only continue")
	}
	if migrationRunElsewhere(id) {
		return errMigrationElsewhere
	}
	var refused error
	ensureMigrationRun(id, report, func(r *migrationRun) {
		if r.switching.Load() {
			refused = errors.New("the final switch is running; it can be abandoned only once it has stopped")
			return
		}
		r.cancelled.Store(true)
		r.cancel()
	})
	return refused
}

// GetMigrationResult is the status screen. The record answers even when a
// cluster cannot be reached.
func GetMigrationResult(id string) (models.MigrationResult, error) {
	rec, err := loadMigrationRecord(id)
	if err != nil {
		return models.MigrationResult{}, err
	}
	src, dst, err := migrationBackend.clusters(rec.Source, rec.Target)
	if err != nil {
		out := services.MigrationResultFromRecord(rec)
		out.LiveError = err.Error()
		return out, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), migrationResultTimeout)
	defer cancel()
	return services.BuildMigrationResult(ctx, src, dst, rec), nil
}

// RestartMigrationSource starts the stopped source with what it had before.
func RestartMigrationSource(id string) error {
	rec, err := loadMigrationRecord(id)
	if err != nil {
		return err
	}
	src, err := migrationCluster(rec.Source)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), migrationRestartTimeout)
	defer cancel()
	return services.RestartMigrationSource(ctx, src, rec)
}
