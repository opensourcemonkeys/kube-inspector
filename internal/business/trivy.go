//go:build !tui
// +build !tui

package business

import (
	"context"
	"os"
	"path/filepath"
	"sync"

	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"
)

var (
	trivyCacheLocksMu sync.Mutex
	trivyCacheLocks   = map[string]*sync.Mutex{}
)

// lockTrivyCache serializes access to a single Trivy cache directory. Trivy's
// "fs" cache backend holds an exclusive BoltDB file lock, so two runners that
// share a cache dir cannot run at once — the second fails with "cache may be in
// use by another process: timeout". Image scans and the per-image vuln loop of
// a K8s scan share one cache dir, so we queue them on an in-process mutex keyed
// by the directory instead of letting them collide on the file lock. Different
// cache dirs (e.g. "image" vs "k8s") get different mutexes and still run in
// parallel.
func lockTrivyCache(cacheDir string) func() {
	mu := trivyCacheMutex(cacheDir)
	mu.Lock()
	return mu.Unlock
}

// tryLockTrivyCache is lockTrivyCache without waiting: ok is false (and unlock
// nil) when another scan holds the cache. The cluster scan uses it to report
// "waitingCache" before it blocks.
func tryLockTrivyCache(cacheDir string) (unlock func(), ok bool) {
	mu := trivyCacheMutex(cacheDir)
	if !mu.TryLock() {
		return nil, false
	}
	return mu.Unlock, true
}

func trivyCacheMutex(cacheDir string) *sync.Mutex {
	trivyCacheLocksMu.Lock()
	defer trivyCacheLocksMu.Unlock()
	mu, ok := trivyCacheLocks[cacheDir]
	if !ok {
		mu = &sync.Mutex{}
		trivyCacheLocks[cacheDir] = mu
	}
	return mu
}

// trivyCacheSubdir returns a Trivy cache directory scoped to a specific scan
// type (e.g. "image" or "k8s"). Keeping them separate avoids exclusive-lock
// conflicts when an image scan and a K8s filesystem scan run concurrently —
// both need a write lock on their fanal artifact cache, but they never share
// artifact entries, so sharing the directory buys nothing.
func trivyCacheSubdir(sub string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".kube-ins", "trivy-cache", sub)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// TrivyScanImage scans a single container image for vulnerabilities. The first
// scan downloads the vulnerability DB into the cache, so it can take a while.
func TrivyScanImage(clusterName, imageRef string) (*models.TrivyScanResult, error) {
	cacheDir, err := trivyCacheSubdir("image")
	if err != nil {
		return nil, err
	}
	unlock := lockTrivyCache(cacheDir)
	defer unlock()
	ctx, cancel := context.WithTimeout(context.Background(), services.ImageScanTimeout)
	defer cancel()
	return services.ScanImage(ctx, imageRef, cacheDir, nil)
}

// TrivyListPodImages returns the distinct images used by pods in the given
// namespace (empty namespace = all namespaces) of the given cluster. The
// frontend feeds these into TrivyScanImage one by one for cluster/namespace
// scans.
func TrivyListPodImages(clusterName, namespace string) ([]string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.ListPodImages(client, namespace)
}

// TrivyScanK8sResources fetches Kubernetes resource YAMLs and runs Trivy's
// misconfig + secret scanners on them. No vulnerability DB download is needed.
// Progress is reported via onProgress so the controller can stream events.
func TrivyScanK8sResources(
	ctx context.Context,
	clusterName, namespace string,
	onProgress func(phase string, current, total int, msg string),
) (*models.TrivyK8sScanResult, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	cacheDir, err := trivyCacheSubdir("k8s")
	if err != nil {
		return nil, err
	}
	unlock := lockTrivyCache(cacheDir)
	defer unlock()
	return services.ScanK8sFilesystem(ctx, client, clusterName, namespace, cacheDir, onProgress)
}

// TrivyListPodImagesWithContext returns pod images together with the top-level
// owner resource (Deployment, StatefulSet, DaemonSet, Job, CronJob, or Pod)
// for use in the vulnerability tab's resource-context columns.
func TrivyListPodImagesWithContext(clusterName, namespace string) ([]models.TrivyK8sImageInfo, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, err
	}
	return services.ListPodImagesWithContext(client, namespace)
}
