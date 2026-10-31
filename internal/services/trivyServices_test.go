//go:build !tui
// +build !tui

package services_k8sclient

import (
	"context"
	"errors"
	"testing"

	"github.com/aquasecurity/trivy/pkg/flag"
	"github.com/aquasecurity/trivy/pkg/types"
)

func TestImageScanOptionsWithCredential(t *testing.T) {
	opts := imageScanOptions("/cache", "quay.io/p/app:1", &RegistryCredential{Username: "u", Password: "p"})
	if opts.ScanOptions.Target != "quay.io/p/app:1" || opts.GlobalOptions.CacheDir != "/cache" {
		t.Fatalf("target/cache = %q %q", opts.ScanOptions.Target, opts.GlobalOptions.CacheDir)
	}
	c := opts.RegistryOptions.Credentials
	if len(c) != 1 || c[0].Username != "u" || c[0].Password != "p" {
		t.Fatalf("credentials = %d entries, want exactly the one", len(c))
	}
	// The DB repositories live on other registries; a run that may contact
	// them must not carry this credential.
	if !opts.DBOptions.SkipDBUpdate || !opts.DBOptions.SkipJavaDBUpdate {
		t.Fatalf("SkipDBUpdate=%v SkipJavaDBUpdate=%v, want both true", opts.DBOptions.SkipDBUpdate, opts.DBOptions.SkipJavaDBUpdate)
	}
	// Misconfig scanning would download the checks bundle with RegistryOpts().
	if opts.Scanners.Enabled(types.MisconfigScanner) || opts.ImageConfigScanners.Enabled(types.MisconfigScanner) {
		t.Fatal("misconfig scanning enabled on a credentialed scan")
	}
	if len(opts.RegistryOptions.RegistryMirrors) != 0 || opts.RegistryOptions.RegistryToken != "" {
		t.Fatal("mirrors or a token would send the credential elsewhere")
	}
}

func TestImageScanOptionsWithoutCredential(t *testing.T) {
	opts := imageScanOptions("/cache", "nginx:1", nil)
	if len(opts.RegistryOptions.Credentials) != 0 {
		t.Fatal("credentials set without a pull secret")
	}
	if opts.DBOptions.SkipDBUpdate || opts.DBOptions.SkipJavaDBUpdate {
		t.Fatal("an uncredentialed scan must keep updating its DBs")
	}
}

func stubScan(t *testing.T, refreshErr error) (*[]string, *flag.Options) {
	t.Helper()
	var calls []string
	var got flag.Options
	oldRefresh, oldRun := refreshDBs, runImageScan
	t.Cleanup(func() { refreshDBs, runImageScan = oldRefresh, oldRun })
	refreshDBs = func(ctx context.Context, cacheDir string) error {
		calls = append(calls, "refresh:"+cacheDir)
		return refreshErr
	}
	runImageScan = func(ctx context.Context, opts flag.Options) (types.Report, error) {
		calls = append(calls, "scan")
		got = opts
		return types.Report{}, nil
	}
	return &calls, &got
}

func TestScanImageRefreshesDBsCredentialFreeFirst(t *testing.T) {
	calls, got := stubScan(t, nil)
	if _, err := ScanImage(context.Background(), "quay.io/p/app:1", "/cache", &RegistryCredential{Username: "u", Password: "p"}); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 2 || (*calls)[0] != "refresh:/cache" || (*calls)[1] != "scan" {
		t.Fatalf("calls = %v, want refresh then scan", *calls)
	}
	if !got.SkipDBUpdate || !got.SkipJavaDBUpdate || len(got.RegistryOptions.Credentials) != 1 {
		t.Fatal("credentialed scan ran with DB updates enabled")
	}
}

func TestScanImageWithoutCredentialDoesNotPreRefresh(t *testing.T) {
	calls, got := stubScan(t, nil)
	if _, err := ScanImage(context.Background(), "nginx:1", "/cache", nil); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0] != "scan" || got.SkipDBUpdate {
		t.Fatalf("calls = %v, skip = %v", *calls, got.SkipDBUpdate)
	}
}

func TestScanImageRefreshFailureStillSkipsUpdates(t *testing.T) {
	calls, got := stubScan(t, errors.New("offline"))
	_, _ = ScanImage(context.Background(), "quay.io/p/app:1", "/cache", &RegistryCredential{Username: "u", Password: "p"})
	for _, c := range *calls {
		if c == "scan" && (!got.SkipDBUpdate || !got.SkipJavaDBUpdate) {
			t.Fatal("refresh failed and the credentialed scan ran with DB updates enabled")
		}
	}
}
