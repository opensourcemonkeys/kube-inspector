//go:build !tui
// +build !tui

package business

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"kube-ins/internal/models"
	services "kube-ins/internal/services"
)

// scanRecorder captures what the fake dependencies were asked to do.
type scanRecorder struct {
	mu        sync.Mutex
	scanned   []string
	saved     []*models.TrivyClusterScan
	metas     []models.TrivyScanMeta
	progress  []models.TrivyScanProgress
	deadlines []bool
}

func (r *scanRecorder) onProgress(p models.TrivyScanProgress) {
	r.mu.Lock()
	r.progress = append(r.progress, p)
	r.mu.Unlock()
}

func vuln(id, pkg, path, sev string) models.TrivyVulnerability {
	return models.TrivyVulnerability{VulnerabilityID: id, PkgName: pkg, PkgPath: path, Severity: sev}
}

func wl(ns, kind, name string) models.TrivyWorkloadRef {
	return models.TrivyWorkloadRef{Namespace: ns, Kind: kind, Name: name}
}

// fakeScanDeps returns deps over the given targets. results maps image →
// result or error; images missing from both are scanned clean.
func fakeScanDeps(r *scanRecorder, targets []services.ScanTarget, results map[string]*models.TrivyScanResult, errs map[string]error) clusterScanDeps {
	t0 := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	return clusterScanDeps{
		listTargets: func(ctx context.Context) ([]services.ScanTarget, []models.TrivyWorkload, error) {
			return targets, []models.TrivyWorkload{{Kind: "Deployment", Name: "a", Namespace: "ns"}}, nil
		},
		scanMisconfig: func(ctx context.Context, onProgress func(string, int, int, string)) (*models.TrivyK8sScanResult, error) {
			onProgress("fetch", 0, 1, "fetching")
			return &models.TrivyK8sScanResult{
				Misconfigs:    []models.TrivyK8sMisconfigFinding{{CheckID: "KSV001", Severity: "HIGH"}},
				Secrets:       []models.TrivyK8sSecretFinding{{RuleID: "aws-key"}},
				ResourceCount: 7,
			}, nil
		},
		scanImage: func(ctx context.Context, image string, cred *services.RegistryCredential) (*models.TrivyScanResult, error) {
			_, hasDeadline := ctx.Deadline()
			r.mu.Lock()
			r.scanned = append(r.scanned, image)
			r.deadlines = append(r.deadlines, hasDeadline)
			r.mu.Unlock()
			if err := errs[image]; err != nil {
				return nil, err
			}
			if res := results[image]; res != nil {
				return res, nil
			}
			return &models.TrivyScanResult{Kind: "image", ArtifactRef: image}, nil
		},
		enrich: func(ctx context.Context, scan *models.TrivyClusterScan) {},
		resolveCred: func(ctx context.Context, t services.ScanTarget) (*services.RegistryCredential, string, string) {
			return nil, "", ""
		},
		meta: func(ctx context.Context) (string, string, string, string) {
			return "v0.76.1", "2026-10-30T00:00:00Z", "https://api:6443", "v1.31.0"
		},
		save: func(s *models.TrivyClusterScan, m models.TrivyScanMeta) error {
			r.mu.Lock()
			r.saved = append(r.saved, s)
			r.metas = append(r.metas, m)
			r.mu.Unlock()
			return nil
		},
		now: func() time.Time { return t0 },
	}
}

func TestRunClusterScanScansEachImageOnce(t *testing.T) {
	r := &scanRecorder{}
	targets := []services.ScanTarget{
		{Image: "nginx:1", Workloads: []models.TrivyWorkloadRef{wl("a", "Deployment", "web"), wl("b", "Deployment", "web"), wl("c", "DaemonSet", "edge")}},
		{Image: "redis:7", Workloads: []models.TrivyWorkloadRef{wl("a", "StatefulSet", "cache")}},
	}
	results := map[string]*models.TrivyScanResult{
		"nginx:1": {Targets: []models.TrivyTarget{{Target: "debian", Class: "os-pkgs", Vulnerabilities: []models.TrivyVulnerability{vuln("CVE-1", "openssl", "", "HIGH")}}}, OS: &models.TrivyOSInfo{Family: "debian", Name: "12"}},
	}
	scan, err := runClusterScan(context.Background(), "id-1", "c1", fakeScanDeps(r, targets, results, nil), r.onProgress)
	if err != nil {
		t.Fatalf("runClusterScan: %v", err)
	}
	if len(r.scanned) != 2 {
		t.Fatalf("scanImage called %d times (%v), want 2", len(r.scanned), r.scanned)
	}
	for i, ok := range r.deadlines {
		if !ok {
			t.Errorf("scan %d ran without a per-image deadline", i)
		}
	}
	if len(scan.Images) != 2 {
		t.Fatalf("len(Images) = %d, want 2", len(scan.Images))
	}
	for _, img := range scan.Images {
		if img.Status != "scanned" {
			t.Errorf("%s status = %q, want scanned", img.Image, img.Status)
		}
	}
	if got := len(scan.Images[0].Workloads); got != 3 {
		t.Errorf("nginx workloads = %d, want 3", got)
	}
	if scan.Images[0].OS == nil || scan.Images[0].OS.Family != "debian" {
		t.Errorf("nginx OS = %+v, want debian", scan.Images[0].OS)
	}
	if len(scan.ImageTargets["nginx:1"]) != 1 {
		t.Errorf("ImageTargets[nginx:1] = %+v", scan.ImageTargets["nginx:1"])
	}
	if _, ok := scan.ImageTargets["redis:7"]; !ok {
		t.Error("ImageTargets has no entry for the clean image")
	}
	if len(r.saved) != 1 {
		t.Fatalf("save called %d times, want 1", len(r.saved))
	}
	if scan.ID != "id-1" || scan.ClusterName != "c1" || scan.SchemaVersion != models.TrivyScanSchemaVersion {
		t.Errorf("identity = %q/%q/v%d", scan.ID, scan.ClusterName, scan.SchemaVersion)
	}
	if scan.TrivyVersion != "v0.76.1" || scan.APIServer != "https://api:6443" || scan.ServerVersion != "v1.31.0" || scan.DBUpdatedAt == "" {
		t.Errorf("meta fields not filled: %+v", scan)
	}
	if scan.ResourceCount != 7 || len(scan.Misconfigs) != 1 || len(scan.Secrets) != 1 || len(scan.Workloads) != 1 {
		t.Errorf("misconfig/workload fields not filled: rc=%d mc=%d sec=%d wl=%d", scan.ResourceCount, len(scan.Misconfigs), len(scan.Secrets), len(scan.Workloads))
	}
	if scan.StartedAt == "" || scan.FinishedAt == "" {
		t.Errorf("timestamps empty: %q %q", scan.StartedAt, scan.FinishedAt)
	}
}

func TestRunClusterScanRecordsFailures(t *testing.T) {
	r := &scanRecorder{}
	targets := []services.ScanTarget{{Image: "private/app:1"}, {Image: "nginx:1"}}
	errs := map[string]error{"private/app:1": errors.New("GET https://r/v2/private/app/manifests/1: UNAUTHORIZED: authentication required")}
	scan, err := runClusterScan(context.Background(), "id-2", "c1", fakeScanDeps(r, targets, nil, errs), r.onProgress)
	if err != nil {
		t.Fatalf("runClusterScan: %v", err)
	}
	if len(r.saved) != 1 {
		t.Fatalf("save called %d times, want 1", len(r.saved))
	}
	var failed *models.TrivyImageCoverage
	for i := range scan.Images {
		if scan.Images[i].Image == "private/app:1" {
			failed = &scan.Images[i]
		}
	}
	if failed == nil {
		t.Fatal("failed image missing from coverage")
	}
	if failed.Status != "failed" || failed.Reason != "auth" || failed.Message == "" {
		t.Errorf("coverage = %+v, want failed/auth with message", *failed)
	}
	if _, ok := scan.ImageTargets["private/app:1"]; ok {
		t.Error("failed image has ImageTargets entry")
	}
	if len(r.scanned) != 2 {
		t.Errorf("a failure stopped the run: scanned %v", r.scanned)
	}
	if r.metas[0].ImagesFailed != 1 {
		t.Errorf("meta ImagesFailed = %d, want 1", r.metas[0].ImagesFailed)
	}
}

func TestRunClusterScanMisconfigFailureKeepsImages(t *testing.T) {
	r := &scanRecorder{}
	targets := []services.ScanTarget{{Image: "nginx:1"}}
	results := map[string]*models.TrivyScanResult{
		"nginx:1": {Targets: []models.TrivyTarget{{Target: "debian", Vulnerabilities: []models.TrivyVulnerability{vuln("CVE-1", "openssl", "", "HIGH")}}}},
	}
	d := fakeScanDeps(r, targets, results, nil)
	d.scanMisconfig = func(ctx context.Context, onProgress func(string, int, int, string)) (*models.TrivyK8sScanResult, error) {
		return nil, errors.New("fetch resources: forbidden")
	}
	scan, err := runClusterScan(context.Background(), "id-3", "c1", d, r.onProgress)
	if err != nil {
		t.Fatalf("runClusterScan: %v", err)
	}
	if scan.MisconfigError == "" {
		t.Error("MisconfigError empty")
	}
	if len(scan.ImageTargets["nginx:1"]) != 1 {
		t.Errorf("ImageTargets lost: %+v", scan.ImageTargets)
	}
	if len(r.saved) != 1 {
		t.Errorf("save called %d times, want 1", len(r.saved))
	}
}

func TestRunClusterScanCancelledIsNotSaved(t *testing.T) {
	r := &scanRecorder{}
	targets := []services.ScanTarget{{Image: "a:1"}, {Image: "b:1"}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d := fakeScanDeps(r, targets, nil, nil)
	inner := d.scanImage
	d.scanImage = func(c context.Context, image string, cred *services.RegistryCredential) (*models.TrivyScanResult, error) {
		_, _ = inner(c, image, cred)
		cancel()
		return nil, c.Err()
	}
	scan, err := runClusterScan(ctx, "id-4", "c1", d, r.onProgress)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if scan != nil {
		t.Errorf("cancelled run returned a scan")
	}
	if len(r.scanned) != 1 {
		t.Errorf("scanned %v after cancel, want only the first image", r.scanned)
	}
	if len(r.saved) != 0 {
		t.Errorf("cancelled scan was saved")
	}
}

func TestRunClusterScanMetaCounts(t *testing.T) {
	r := &scanRecorder{}
	targets := []services.ScanTarget{{Image: "a:1"}, {Image: "b:1"}, {Image: "c:1"}}
	results := map[string]*models.TrivyScanResult{
		// The same CVE+pkg reported by two targets of one image counts once;
		// the same CVE in a different pkgPath is a separate finding.
		"a:1": {Targets: []models.TrivyTarget{
			{Target: "os", Vulnerabilities: []models.TrivyVulnerability{vuln("CVE-1", "openssl", "", "CRITICAL"), vuln("CVE-2", "zlib", "", "HIGH")}},
			{Target: "dup", Vulnerabilities: []models.TrivyVulnerability{vuln("CVE-1", "openssl", "", "CRITICAL")}},
			{Target: "jar", Vulnerabilities: []models.TrivyVulnerability{vuln("CVE-3", "log4j", "app/a.jar", "CRITICAL"), vuln("CVE-3", "log4j", "app/b.jar", "CRITICAL"), vuln("CVE-4", "x", "", "LOW")}},
		}},
		// The same CVE in another image is another finding.
		"b:1": {Targets: []models.TrivyTarget{{Target: "os", Vulnerabilities: []models.TrivyVulnerability{vuln("CVE-1", "openssl", "", "CRITICAL")}}}},
	}
	errs := map[string]error{"c:1": errors.New("manifest unknown")}
	if _, err := runClusterScan(context.Background(), "id-5", "c1", fakeScanDeps(r, targets, results, errs), r.onProgress); err != nil {
		t.Fatalf("runClusterScan: %v", err)
	}
	m := r.metas[0]
	if m.Critical != 4 || m.High != 1 || m.ImagesFailed != 1 {
		t.Errorf("meta = %+v, want critical 4, high 1, failed 1", m)
	}
	if m.ID != "id-5" || m.StartedAt == "" || m.FinishedAt == "" {
		t.Errorf("meta identity = %+v", m)
	}
}

// A cache held by another scan is reported as waitingCache, and the per-image
// deadline only starts once the lock is ours.
func TestRunClusterScanReportsWaitingCache(t *testing.T) {
	r := &scanRecorder{}
	d := fakeScanDeps(r, []services.ScanTarget{{Image: "a:1"}}, nil, nil)
	d.imageCacheDir = "test-waiting-cache-" + t.Name()
	unlock := lockTrivyCache(d.imageCacheDir)

	done := make(chan error, 1)
	go func() {
		_, err := runClusterScan(context.Background(), "id-6", "c1", d, r.onProgress)
		done <- err
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		r.mu.Lock()
		waiting := false
		for _, p := range r.progress {
			waiting = waiting || p.Phase == "waitingCache"
		}
		started := len(r.scanned) > 0
		r.mu.Unlock()
		if started {
			unlock()
			t.Fatal("image scanned while the cache was locked")
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			unlock()
			t.Fatal("no waitingCache progress while the cache was locked")
		}
		time.Sleep(10 * time.Millisecond)
	}
	unlock()
	if err := <-done; err != nil {
		t.Fatalf("runClusterScan: %v", err)
	}
	if len(r.scanned) != 1 {
		t.Errorf("scanned %v, want a:1 once", r.scanned)
	}
}

// Stop while waiting for the cache must not hang until the other scan ends.
func TestRunClusterScanCancelWhileWaitingCache(t *testing.T) {
	r := &scanRecorder{}
	d := fakeScanDeps(r, []services.ScanTarget{{Image: "a:1"}}, nil, nil)
	d.imageCacheDir = "test-cancel-cache-" + t.Name()
	unlock := lockTrivyCache(d.imageCacheDir)
	defer unlock()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := runClusterScan(ctx, "id-7", "c1", d, r.onProgress)
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not end a run waiting for the cache")
	}
	if len(r.saved) != 0 || len(r.scanned) != 0 {
		t.Errorf("saved %d, scanned %v after cancel", len(r.saved), r.scanned)
	}
}

// A panic in an image scan (recovered further up by safego) must not leave the
// image cache locked: the Image tab and every later cluster scan queue on it.
func TestRunClusterScanPanicReleasesImageCache(t *testing.T) {
	r := &scanRecorder{}
	d := fakeScanDeps(r, []services.ScanTarget{{Image: "a:1"}}, nil, nil)
	d.imageCacheDir = "test-panic-cache-" + t.Name()
	d.scanImage = func(context.Context, string, *services.RegistryCredential) (*models.TrivyScanResult, error) {
		panic("trivy blew up")
	}

	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("scanImage panic did not propagate")
			}
		}()
		_, _ = runClusterScan(context.Background(), "id-8", "c1", d, r.onProgress)
	}()

	unlock, ok := tryLockTrivyCache(d.imageCacheDir)
	if !ok {
		t.Fatal("image cache still locked after a panicking scan")
	}
	unlock()

	// And a following scan of the same cache runs normally.
	r2 := &scanRecorder{}
	d2 := fakeScanDeps(r2, []services.ScanTarget{{Image: "b:1"}}, nil, nil)
	d2.imageCacheDir = d.imageCacheDir
	done := make(chan error, 1)
	go func() {
		_, err := runClusterScan(context.Background(), "id-9", "c1", d2, r2.onProgress)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("second scan: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("second scan blocked on the image cache")
	}
}

// A panic in the misconfig scan is recovered by safego in its goroutine; the
// run must still complete and save, with the failure as MisconfigError.
func TestRunClusterScanMisconfigPanicStillSaves(t *testing.T) {
	r := &scanRecorder{}
	targets := []services.ScanTarget{{Image: "a:1"}, {Image: "b:1"}}
	d := fakeScanDeps(r, targets, nil, nil)
	d.scanMisconfig = func(context.Context, func(string, int, int, string)) (*models.TrivyK8sScanResult, error) {
		panic("misconfig blew up")
	}

	type outcome struct {
		scan *models.TrivyClusterScan
		err  error
	}
	done := make(chan outcome, 1)
	go func() {
		s, err := runClusterScan(context.Background(), "id-10", "c1", d, r.onProgress)
		done <- outcome{s, err}
	}()
	var o outcome
	select {
	case o = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("run hung after the misconfig scan panicked")
	}
	if o.err != nil {
		t.Fatalf("runClusterScan: %v", o.err)
	}
	if o.scan.MisconfigError == "" {
		t.Error("MisconfigError empty after a misconfig panic")
	}
	if len(r.scanned) != 2 || len(o.scan.Images) != 2 {
		t.Errorf("scanned %v, coverage %d; want both images", r.scanned, len(o.scan.Images))
	}
	if len(r.saved) != 1 {
		t.Errorf("save called %d times, want 1", len(r.saved))
	}
}
