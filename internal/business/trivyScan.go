//go:build !tui
// +build !tui

package business

import (
	"context"
	"runtime/debug"
	"sync"
	"time"

	"github.com/aquasecurity/trivy-db/pkg/metadata"
	"github.com/aquasecurity/trivy/pkg/db"

	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	"kube-ins/internal/safego"
	services "kube-ins/internal/services"
)

// clusterScanDeps is everything runClusterScan touches outside itself, so the
// orchestration can be tested without a cluster or Trivy.
type clusterScanDeps struct {
	listTargets   func(ctx context.Context) ([]services.ScanTarget, []models.TrivyWorkload, error)
	scanMisconfig func(ctx context.Context, onProgress func(phase string, cur, total int, msg string)) (*models.TrivyK8sScanResult, error)
	scanImage     func(ctx context.Context, image string, cred *services.RegistryCredential) (*models.TrivyScanResult, error)
	enrich        func(ctx context.Context, scan *models.TrivyClusterScan)                                                              // Task 5: exposure; no-op for now
	resolveCred   func(ctx context.Context, t services.ScanTarget) (*services.RegistryCredential, string /*secret*/, string /*reason*/) // Task 9; nil for now
	meta          func(ctx context.Context) (trivyVersion, dbUpdatedAt, apiServer, serverVersion string)
	save          func(*models.TrivyClusterScan, models.TrivyScanMeta) error
	now           func() time.Time

	// imageCacheDir keys the in-process cache lock the image scans queue on
	// (see lockTrivyCache). It is only a lock key here; scanImage owns the dir.
	imageCacheDir string
}

// cacheWaitPoll is how often a scan blocked on the image cache re-checks the
// lock. Polling rather than a blocking Lock keeps Stop responsive: a single
// image scan in another panel can hold the cache for minutes.
const cacheWaitPoll = 200 * time.Millisecond

// scanProgress serialises progress from the image loop and the parallel
// misconfig scan, and drops everything once the run has returned — the
// misconfig goroutine can outlive a cancelled run, and a progress event after
// "cancelled" would put the screen back into a running state.
type scanProgress struct {
	mu           sync.Mutex
	fn           func(models.TrivyScanProgress)
	closed       bool
	imagesActive bool
}

func (g *scanProgress) send(phase string, cur, total int, msg string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed || g.fn == nil {
		return
	}
	g.fn(models.TrivyScanProgress{Phase: phase, Current: cur, Total: total, Message: msg})
}

// misconfig forwards the misconfig scan's own progress, but not while images
// are being scanned: it finishes long before them, and its last line would
// otherwise replace "scanning image 3 of 40" for as long as that image takes.
func (g *scanProgress) misconfig(_ string, cur, total int, msg string) {
	g.mu.Lock()
	active := g.imagesActive
	g.mu.Unlock()
	if !active {
		g.send("misconfig", cur, total, msg)
	}
}

func (g *scanProgress) setImagesActive(v bool) {
	g.mu.Lock()
	g.imagesActive = v
	g.mu.Unlock()
}

func (g *scanProgress) close() {
	g.mu.Lock()
	g.closed = true
	g.mu.Unlock()
}

type misconfigOutcome struct {
	res *models.TrivyK8sScanResult
	err error
}

// runClusterScan lists the cluster's unique images, scans each once (with the
// misconfig/secret scan running alongside), then enriches, stamps and saves
// the record. A failed image is recorded in the coverage and the run goes on;
// a cancelled run returns ctx.Err() and saves nothing.
func runClusterScan(ctx context.Context, id, clusterName string, d clusterScanDeps, onProgress func(models.TrivyScanProgress)) (*models.TrivyClusterScan, error) {
	gate := &scanProgress{fn: onProgress}
	defer gate.close()

	scan := &models.TrivyClusterScan{
		SchemaVersion: models.TrivyScanSchemaVersion,
		ID:            id,
		ClusterName:   clusterName,
		Scope:         "cluster",
		StartedAt:     d.now().UTC().Format(time.RFC3339),
		AppVersion:    appVersion,
		Images:        []models.TrivyImageCoverage{},
		ImageTargets:  map[string][]models.TrivyTarget{},
		Misconfigs:    []models.TrivyK8sMisconfigFinding{},
		Secrets:       []models.TrivyK8sSecretFinding{},
		Workloads:     []models.TrivyWorkload{},
	}

	gate.send("targets", 0, 0, "")
	targets, workloads, err := d.listTargets(ctx)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, err
	}
	if workloads != nil {
		scan.Workloads = workloads
	}

	mctx, mcancel := context.WithCancel(ctx)
	defer mcancel()
	misconfigCh := make(chan misconfigOutcome, 1)
	safego.Go("business.trivyMisconfigScan", func() {
		res, err := d.scanMisconfig(mctx, gate.misconfig)
		misconfigCh <- misconfigOutcome{res: res, err: err}
	})

	gate.setImagesActive(true)
	for i, t := range targets {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		cov, res, err := scanOneImage(ctx, d, gate, t, i+1, len(targets))
		if err != nil {
			return nil, err
		}
		scan.Images = append(scan.Images, cov)
		if res != nil {
			tg := res.Targets
			if tg == nil {
				tg = []models.TrivyTarget{}
			}
			scan.ImageTargets[t.Image] = tg
		}
	}
	gate.setImagesActive(false)

	var mo misconfigOutcome
	select {
	case mo = <-misconfigCh:
	default:
		gate.send("misconfig", 0, 0, "")
		select {
		case mo = <-misconfigCh:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	switch {
	case mo.err != nil:
		scan.MisconfigError = mo.err.Error()
	case mo.res != nil:
		if mo.res.Misconfigs != nil {
			scan.Misconfigs = mo.res.Misconfigs
		}
		if mo.res.Secrets != nil {
			scan.Secrets = mo.res.Secrets
		}
		scan.ResourceCount = mo.res.ResourceCount
	}

	gate.send("enrich", 0, 0, "")
	if d.enrich != nil {
		d.enrich(ctx, scan)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	scan.TrivyVersion, scan.DBUpdatedAt, scan.APIServer, scan.ServerVersion = d.meta(ctx)
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	gate.send("saving", 0, 0, "")
	scan.FinishedAt = d.now().UTC().Format(time.RFC3339)
	if err := d.save(scan, scanMeta(scan)); err != nil {
		return nil, err
	}
	return scan, nil
}

// scanOneImage scans one target under its own ImageScanTimeout. The deadline
// starts only once the image cache is ours: waiting behind another scan is
// reported as "waitingCache" and is not counted against it. It returns an
// error only when the run itself is cancelled; a failed image is a coverage
// entry with status "failed".
func scanOneImage(ctx context.Context, d clusterScanDeps, gate *scanProgress, t services.ScanTarget, cur, total int) (models.TrivyImageCoverage, *models.TrivyScanResult, error) {
	cov := models.TrivyImageCoverage{Image: t.Image, Workloads: t.Workloads}
	if cov.Workloads == nil {
		cov.Workloads = []models.TrivyWorkloadRef{}
	}

	var cred *services.RegistryCredential
	if d.resolveCred != nil {
		// The reason (pullSecretForbidden) is applied to a failed scan by Task 9.
		cred, cov.PullSecret, _ = d.resolveCred(ctx, t)
	}

	unlock, err := acquireImageCache(ctx, d.imageCacheDir, func() {
		gate.send("waitingCache", cur, total, t.Image)
	})
	if err != nil {
		return cov, nil, err
	}
	gate.send("images", cur, total, t.Image)
	ictx, cancel := context.WithTimeout(ctx, services.ImageScanTimeout)
	res, err := d.scanImage(ictx, t.Image, cred)
	cancel()
	unlock()

	if ctxErr := ctx.Err(); ctxErr != nil {
		return cov, nil, ctxErr
	}
	if err != nil {
		cov.Status = "failed"
		cov.Reason, cov.Message = services.ClassifyScanError(err)
		return cov, nil, nil
	}
	if res == nil {
		res = &models.TrivyScanResult{}
	}
	cov.Status = "scanned"
	cov.OS = res.OS
	return cov, res, nil
}

// acquireImageCache takes the image cache lock, calling onWait once if it has
// to wait for it. Cancellation ends the wait.
func acquireImageCache(ctx context.Context, dir string, onWait func()) (func(), error) {
	if unlock, ok := tryLockTrivyCache(dir); ok {
		return unlock, nil
	}
	onWait()
	ticker := time.NewTicker(cacheWaitPoll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
			if unlock, ok := tryLockTrivyCache(dir); ok {
				return unlock, nil
			}
		}
	}
}

// scanMeta summarises a finished scan for the history list.
func scanMeta(scan *models.TrivyClusterScan) models.TrivyScanMeta {
	counts := services.VulnSeverityCounts(scan.ImageTargets, scan.Images)
	failed := 0
	for _, img := range scan.Images {
		if img.Status == "failed" {
			failed++
		}
	}
	return models.TrivyScanMeta{
		ID:           scan.ID,
		StartedAt:    scan.StartedAt,
		FinishedAt:   scan.FinishedAt,
		Critical:     counts["CRITICAL"],
		High:         counts["HIGH"],
		ImagesFailed: failed,
	}
}

// RunClusterScan scans every namespace of the cluster — each unique image once
// for vulnerabilities, plus the misconfig/secret scan — and saves the result to
// the cluster's history. A cancelled scan returns ctx.Err() and is not saved.
func RunClusterScan(ctx context.Context, id, clusterName string, onProgress func(models.TrivyScanProgress)) (*models.TrivyClusterScan, error) {
	client, cfg, err := repository.NewK8sClientAndConfigForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	imageCache, err := trivyCacheSubdir("image")
	if err != nil {
		return nil, err
	}
	k8sCache, err := trivyCacheSubdir("k8s")
	if err != nil {
		return nil, err
	}
	d := clusterScanDeps{
		imageCacheDir: imageCache,
		listTargets: func(ctx context.Context) ([]services.ScanTarget, []models.TrivyWorkload, error) {
			return services.ListScanTargets(ctx, client, "")
		},
		scanMisconfig: func(ctx context.Context, onProgress func(string, int, int, string)) (*models.TrivyK8sScanResult, error) {
			unlock := lockTrivyCache(k8sCache)
			defer unlock()
			return services.ScanK8sFilesystem(ctx, client, clusterName, "", k8sCache, onProgress)
		},
		scanImage: func(ctx context.Context, image string, cred *services.RegistryCredential) (*models.TrivyScanResult, error) {
			return services.ScanImage(ctx, image, imageCache, cred)
		},
		enrich: func(context.Context, *models.TrivyClusterScan) {},
		resolveCred: func(context.Context, services.ScanTarget) (*services.RegistryCredential, string, string) {
			return nil, "", ""
		},
		meta: func(context.Context) (string, string, string, string) {
			serverVersion := ""
			if v, err := client.Discovery().ServerVersion(); err == nil {
				serverVersion = v.GitVersion
			}
			return trivyModuleVersion(), trivyDBUpdatedAt(imageCache), cfg.Host, serverVersion
		},
		save: SaveTrivyScan,
		now:  time.Now,
	}
	return runClusterScan(ctx, id, clusterName, d, onProgress)
}

// trivyModuleVersion is the linked Trivy library's module version.
func trivyModuleVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, m := range info.Deps {
		if m.Path == "github.com/aquasecurity/trivy" {
			if m.Replace != nil && m.Replace.Version != "" {
				return m.Replace.Version
			}
			return m.Version
		}
	}
	return ""
}

// trivyDBUpdatedAt is when the vulnerability DB in cacheDir was built, or ""
// when it has not been downloaded yet.
func trivyDBUpdatedAt(cacheDir string) string {
	m, err := metadata.NewClient(db.Dir(cacheDir)).Get()
	if err != nil || m.UpdatedAt.IsZero() {
		return ""
	}
	return m.UpdatedAt.UTC().Format(time.RFC3339)
}
