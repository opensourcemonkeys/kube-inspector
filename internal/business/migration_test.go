package business

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"kube-ins/internal/models"
	services "kube-ins/internal/services"
)

// migrationHarness replaces what talks to the clusters.
type migrationHarness struct {
	mu         sync.Mutex
	reports    []models.MigrationProgress
	cleaned    int
	cutovers   int
	prepErr    error
	cutErr     error
	tickReady  bool
	restarted  int
	restartErr error
}

func installHarness(t *testing.T) *migrationHarness {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	h := &migrationHarness{tickReady: true}
	old, oldTick := migrationBackend, migrationTickInterval
	migrationTickInterval = time.Millisecond
	migrationBackend = migrationOps{
		clusters: func(string, string) (services.MigrationCluster, services.MigrationCluster, error) {
			return services.MigrationCluster{}, services.MigrationCluster{}, nil
		},
		prepare: func(_ context.Context, _, _ services.MigrationCluster, rec *models.MigrationRecord, save func() error) error {
			if h.prepErr != nil {
				return h.prepErr
			}
			rec.Phase = models.MigrationCopying
			return save()
		},
		tick: func(_ context.Context, _, _ services.MigrationCluster, rec *models.MigrationRecord, _ time.Time) ([]models.MigrationDiskProgress, error) {
			if h.ready() {
				for i := range rec.Disks {
					rec.Disks[i].Passes = 1
				}
			}
			return nil, nil
		},
		cutover: func(_ context.Context, _, _ services.MigrationCluster, rec *models.MigrationRecord, opts services.MigrationCutoverOptions) error {
			h.mu.Lock()
			h.cutovers++
			h.mu.Unlock()
			if h.cutErr != nil {
				rec.Phase, rec.Step, rec.Error = models.MigrationCutover, "drain", h.cutErr.Error()
				return h.cutErr
			}
			rec.Phase, rec.Step = models.MigrationDone, ""
			return opts.Save()
		},
		restart: func(context.Context, services.MigrationCluster, *models.MigrationRecord) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.restartErr != nil {
				return h.restartErr
			}
			h.restarted++
			return nil
		},
		cleanup: func(context.Context, services.MigrationCluster, services.MigrationCluster, *models.MigrationRecord) error {
			h.mu.Lock()
			h.cleaned++
			h.mu.Unlock()
			return nil
		},
	}
	t.Cleanup(func() {
		waitForNoMigrationRuns(t)
		migrationBackend, migrationTickInterval = old, oldTick
	})
	return h
}

func (h *migrationHarness) ready() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tickReady
}

func (h *migrationHarness) report(p models.MigrationProgress) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.reports = append(h.reports, p)
}

func (h *migrationHarness) cutoverCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.cutovers
}

func waitForNoMigrationRuns(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		migrationRuns.Lock()
		n := len(migrationRuns.m)
		migrationRuns.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("a migration run did not end")
}

func newTestRecord(t *testing.T, phase string) *models.MigrationRecord {
	t.Helper()
	rec := &models.MigrationRecord{SchemaVersion: models.MigrationSchemaVersion, ID: "11111111-aaaa", Source: "prod/a", Target: "b", Namespaces: []string{"x"},
		Phase: phase, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		Disks: []models.MigrationDiskRun{{Index: 0, MigrationDisk: models.MigrationDisk{Namespace: "x", Name: "d", Copy: true, LiveCopy: true}}}}
	if err := saveMigrationRecord(rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

func waitPhase(t *testing.T, id, want string) *models.MigrationRecord {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if rec, err := loadMigrationRecord(id); err == nil && rec.Phase == want {
			return rec
		}
		time.Sleep(time.Millisecond)
	}
	rec, _ := loadMigrationRecord(id)
	t.Fatalf("phase never became %q: %+v", want, rec)
	return nil
}

func TestMigrationRunGoesFromPreparingToReadyAndWaitsForTheUser(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationPreparing)
	ensureMigrationRun(rec.ID, h.report, nil)
	waitPhase(t, rec.ID, models.MigrationReady)
	time.Sleep(20 * time.Millisecond)
	if h.cutoverCount() != 0 {
		t.Fatal("the switch-over started without the user")
	}
	if err := StartMigrationCutover(rec.ID, h.report); err != nil {
		t.Fatal(err)
	}
	waitPhase(t, rec.ID, models.MigrationDone)
	if h.cutoverCount() != 1 {
		t.Fatalf("cutovers = %d", h.cutoverCount())
	}
}

func TestMigrationCutoverRefusedUntilEveryDiskHasBeenCopied(t *testing.T) {
	h := installHarness(t)
	h.tickReady = false
	rec := newTestRecord(t, models.MigrationCopying)
	ensureMigrationRun(rec.ID, h.report, nil)
	if err := StartMigrationCutover(rec.ID, h.report); err == nil {
		t.Fatal("no error")
	}
	if err := CancelMigration(rec.ID, h.report); err != nil {
		t.Fatal(err)
	}
	waitPhase(t, rec.ID, models.MigrationCancelled)
}

func TestMigrationPrepareFailureCleansUpAndEnds(t *testing.T) {
	h := installHarness(t)
	h.prepErr = errors.New("dry run rejected")
	rec := newTestRecord(t, models.MigrationPreparing)
	ensureMigrationRun(rec.ID, h.report, nil)
	got := waitPhase(t, rec.ID, models.MigrationFailed)
	if !strings.Contains(got.Error, "dry run rejected") {
		t.Fatalf("record = %+v", got)
	}
	waitForNoMigrationRuns(t)
	if h.cleaned != 1 {
		t.Fatalf("cleaned = %d", h.cleaned)
	}
}

func TestMigrationCancelCleansUpTheWorkers(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationCopying)
	ensureMigrationRun(rec.ID, h.report, nil)
	waitPhase(t, rec.ID, models.MigrationReady)
	if err := CancelMigration(rec.ID, h.report); err != nil {
		t.Fatal(err)
	}
	waitPhase(t, rec.ID, models.MigrationCancelled)
	waitForNoMigrationRuns(t)
	if h.cleaned != 1 {
		t.Fatalf("cleaned = %d", h.cleaned)
	}
}

func TestMigrationCancelRefusedOnceTheSwitchHasBegun(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationCutover)
	rec.Step = "apply"
	if err := saveMigrationRecord(rec); err != nil {
		t.Fatal(err)
	}
	if err := CancelMigration(rec.ID, h.report); err == nil {
		t.Fatal("the target may already be starting: it can only go forward")
	}
}

func TestMigrationCancelRefusedWhileTheSwitchIsRunning(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationCutover)
	rec.Step = "drain"
	if err := saveMigrationRecord(rec); err != nil {
		t.Fatal(err)
	}
	migrationRuns.Lock()
	run := &migrationRun{cancel: func() {}}
	run.switching.Store(true)
	migrationRuns.m[rec.ID] = run
	migrationRuns.Unlock()
	defer removeMigrationRun(rec.ID, run)
	if err := CancelMigration(rec.ID, h.report); err == nil {
		t.Fatal("no error")
	}
}

func TestAStoppedSwitchCanBeAbandonedAndTheSourceStartsAgain(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationCutover)
	rec.Step = "finalSync"
	if err := saveMigrationRecord(rec); err != nil {
		t.Fatal(err)
	}
	if err := CancelMigration(rec.ID, h.report); err != nil {
		t.Fatal(err)
	}
	waitPhase(t, rec.ID, models.MigrationCancelled)
	waitForNoMigrationRuns(t)
	if h.restarted != 1 || h.cleaned != 1 {
		t.Fatalf("restarted = %d cleaned = %d", h.restarted, h.cleaned)
	}
}

func TestAFailedRestartLeavesTheSwitchToDecideAgain(t *testing.T) {
	h := installHarness(t)
	h.restartErr = errors.New("source unreachable")
	rec := newTestRecord(t, models.MigrationCutover)
	rec.Step = "drain"
	if err := saveMigrationRecord(rec); err != nil {
		t.Fatal(err)
	}
	if err := CancelMigration(rec.ID, h.report); err != nil {
		t.Fatal(err)
	}
	waitForNoMigrationRuns(t)
	got, _ := loadMigrationRecord(rec.ID)
	if got.Phase != models.MigrationCutover || !strings.Contains(got.Error, "source unreachable") {
		t.Fatalf("record = %+v", got)
	}
}

func TestInterruptedCutoverWaitsAndContinuesFromTheRecord(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationCutover)
	rec.Step = "finalSync"
	if err := saveMigrationRecord(rec); err != nil {
		t.Fatal(err)
	}

	p := GetRunningMigration(rec.Source, h.report)
	if p == nil || !p.Interrupted || p.Phase != models.MigrationCutover {
		t.Fatalf("progress = %+v", p)
	}
	waitForNoMigrationRuns(t)
	if h.cutoverCount() != 0 {
		t.Fatal("an interrupted switch must wait for the user")
	}

	if err := StartMigrationCutover(rec.ID, h.report); err != nil {
		t.Fatal(err)
	}
	waitPhase(t, rec.ID, models.MigrationDone)
}

func TestMigrationCutoverErrorStaysInterrupted(t *testing.T) {
	h := installHarness(t)
	h.cutErr = errors.New("pods still use a volume")
	rec := newTestRecord(t, models.MigrationReady)
	if err := StartMigrationCutover(rec.ID, h.report); err != nil {
		t.Fatal(err)
	}
	waitForNoMigrationRuns(t)
	got, _ := loadMigrationRecord(rec.ID)
	if got.Phase != models.MigrationCutover || got.Error == "" {
		t.Fatalf("record = %+v", got)
	}
	h.mu.Lock()
	last := h.reports[len(h.reports)-1]
	h.mu.Unlock()
	if !last.Interrupted {
		t.Fatalf("last report = %+v", last)
	}
}

func TestGetRunningMigrationIgnoresFinishedOnes(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationDone)
	if p := GetRunningMigration(rec.Source, h.report); p != nil {
		t.Fatalf("progress = %+v", p)
	}
}

func TestMigrationHistoryFilesAndRetention(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	running := &models.MigrationRecord{ID: "aaaaaaaa", Source: "s", Target: "t", Phase: models.MigrationCopying, CreatedAt: "2026-01-01T00:00:00Z"}
	if err := saveMigrationRecord(running); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < migrationHistoryKeep+3; i++ {
		rec := &models.MigrationRecord{ID: "bbbbbbbb-" + string(rune('a'+i)), Source: "s", Target: "t", Phase: models.MigrationDone,
			CreatedAt: time.Date(2026, 2, 1, 0, 0, i, 0, time.UTC).Format(time.RFC3339)}
		if err := saveMigrationRecord(rec); err != nil {
			t.Fatal(err)
		}
	}
	list, err := ListMigrations("s")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != migrationHistoryKeep+1 {
		t.Fatalf("kept %d", len(list))
	}
	if list[0].ID != "bbbbbbbb-"+string(rune('a'+migrationHistoryKeep+2)) {
		t.Fatalf("newest first, got %s", list[0].ID)
	}
	var sawRunning bool
	for _, m := range list {
		sawRunning = sawRunning || m.ID == "aaaaaaaa"
	}
	if !sawRunning {
		t.Fatal("a migration still running was pruned")
	}

	dir, _ := migrationHistoryDir("s")
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	info, _ := os.Stat(files[0])
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode = %v", info.Mode())
	}
	if d, _ := os.Stat(dir); d.Mode().Perm() != 0700 {
		t.Fatalf("dir mode = %v", d.Mode())
	}
}

func TestLoadMigrationRecordRejectsAPathInTheID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if _, err := loadMigrationRecord("../../etc/passwd"); err == nil {
		t.Fatal("no error")
	}
}

func writeMigrationLock(t *testing.T, id string, age time.Duration) string {
	t.Helper()
	path, err := migrationLockPath(id)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	then := time.Now().Add(-age)
	if err := os.Chtimes(path, then, then); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAnotherProcessesMigrationIsNotDrivenHere(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationCopying)
	writeMigrationLock(t, rec.ID, 0)

	p := GetRunningMigration(rec.Source, h.report)
	if p == nil || p.Phase != models.MigrationCopying {
		t.Fatalf("progress = %+v", p)
	}
	waitForNoMigrationRuns(t)
	got, _ := loadMigrationRecord(rec.ID)
	if got.Phase != models.MigrationCopying {
		t.Fatalf("a second driver advanced the record: %+v", got)
	}
	if err := StartMigrationCutover(rec.ID, h.report); err == nil {
		t.Fatal("a switch must be refused while another process drives it")
	}
	if err := CancelMigration(rec.ID, h.report); err == nil {
		t.Fatal("a cancel must be refused while another process drives it")
	}
}

func TestAnInterruptedSwitchRunningElsewhereIsNotOffered(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationCutover)
	writeMigrationLock(t, rec.ID, 0)
	if p := GetRunningMigration(rec.Source, h.report); p == nil || p.Interrupted {
		t.Fatalf("progress = %+v", p)
	}
}

func TestAStaleLockIsTakenOverAndReleased(t *testing.T) {
	h := installHarness(t)
	rec := newTestRecord(t, models.MigrationReady)
	path := writeMigrationLock(t, rec.ID, 10*migrationLockStale)
	ensureMigrationRun(rec.ID, h.report, func(r *migrationRun) { r.cutover.Store(true) })
	waitPhase(t, rec.ID, models.MigrationDone)
	waitForNoMigrationRuns(t)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("lock left behind: %v", err)
	}
}
