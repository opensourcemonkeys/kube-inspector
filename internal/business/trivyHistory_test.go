package business

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"kube-ins/internal/models"
)

func histHome(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("kubeInsDir uses os.UserHomeDir, which reads the registry on Windows")
	}
	t.Setenv("HOME", t.TempDir())
}

func mkScan(id string, at time.Time) (*models.TrivyClusterScan, models.TrivyScanMeta) {
	s := at.UTC().Format(time.RFC3339)
	return &models.TrivyClusterScan{SchemaVersion: 1, ID: id, ClusterName: "c1", StartedAt: s, FinishedAt: s},
		models.TrivyScanMeta{ID: id, StartedAt: s, FinishedAt: s, Critical: 1}
}

func TestSaveListLoadTrivyScan(t *testing.T) {
	histHome(t)
	sc, m := mkScan("abc-123", time.Now())
	if err := SaveTrivyScan(sc, m); err != nil {
		t.Fatal(err)
	}
	metas, err := ListTrivyScans("c1")
	if err != nil || len(metas) != 1 || metas[0].ID != "abc-123" {
		t.Fatalf("list: %v %v", metas, err)
	}
	got, err := LoadTrivyScan("c1", "abc-123")
	if err != nil || got.ID != "abc-123" {
		t.Fatalf("load: %v %v", got, err)
	}
	dir, _ := trivyHistoryDir("c1")
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0700 {
		t.Errorf("dir mode %v", fi.Mode().Perm())
	}
	files, _ := os.ReadDir(dir)
	for _, f := range files {
		if fi, _ := f.Info(); fi.Mode().Perm() != 0600 {
			t.Errorf("%s mode %v", f.Name(), fi.Mode().Perm())
		}
	}
	if _, err := LoadTrivyScan("c1", "../x"); err == nil {
		t.Error("unsafe id accepted")
	}
}

func TestTrivyHistoryRetention(t *testing.T) {
	histHome(t)
	base := time.Now().Add(-time.Hour)
	for i := 0; i < trivyHistoryKeep+1; i++ {
		sc, m := mkScan("id"+string(rune('a'+i)), base.Add(time.Duration(i)*time.Second))
		if err := SaveTrivyScan(sc, m); err != nil {
			t.Fatal(err)
		}
	}
	metas, _ := ListTrivyScans("c1")
	if len(metas) != trivyHistoryKeep {
		t.Fatalf("len %d", len(metas))
	}
	dir, _ := trivyHistoryDir("c1")
	files, _ := os.ReadDir(dir)
	if len(files) != 2*trivyHistoryKeep {
		t.Errorf("files %d", len(files))
	}
	for _, f := range files {
		if strings.Contains(f.Name(), "-ida.") {
			t.Errorf("oldest not deleted: %s", f.Name())
		}
	}
}

func TestListScansSkipsCorruptMeta(t *testing.T) {
	histHome(t)
	sc, m := mkScan("good", time.Now())
	if err := SaveTrivyScan(sc, m); err != nil {
		t.Fatal(err)
	}
	dir, _ := trivyHistoryDir("c1")
	os.WriteFile(filepath.Join(dir, "20200101T000000Z-bad.meta.json"), []byte("{"), 0600)
	metas, err := ListTrivyScans("c1")
	if err != nil || len(metas) != 1 || metas[0].ID != "good" {
		t.Fatalf("%v %v", metas, err)
	}
}

func TestHistoryDirStaysInside(t *testing.T) {
	histHome(t)
	root, _ := kubeInsDir()
	root = filepath.Join(root, "trivy-history")
	for _, in := range []string{"../../etc", "a/b", "..", ""} {
		dir, err := trivyHistoryDir(in)
		if err != nil {
			t.Fatal(err)
		}
		rel, err := filepath.Rel(root, dir)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.ContainsRune(rel, filepath.Separator) {
			t.Errorf("%q -> %q (%v)", in, rel, err)
		}
	}
}

func TestAddTrivyExceptionValidates(t *testing.T) {
	histHome(t)
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	wl := models.TrivyWorkloadRef{Kind: "Deployment", Name: "a", Namespace: "n"}
	bad := []models.TrivyException{
		{Kind: "secret", Reason: "x"},
		{Kind: "vuln", VulnerabilityID: "CVE-1", Reason: "x"},
		{Kind: "misconfig", CheckID: "KSV1", Reason: "x"},
		{Kind: "vuln", VulnerabilityID: "CVE-1", ImageRepo: "r", Reason: "  "},
		{Kind: "vuln", VulnerabilityID: "CVE-1", ImageRepo: "r", Reason: "x", ExpiresAt: past},
		{Kind: "vuln", VulnerabilityID: "CVE-1", ImageRepo: "r", Reason: "x"},
		{Kind: "vuln", VulnerabilityID: "CVE-1", ImageRepo: "r", Reason: "x", ExpiresAt: "tomorrow"},
	}
	for i, e := range bad {
		if _, err := AddTrivyException("c1", e); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	got, err := AddTrivyException("c1", models.TrivyException{Kind: "misconfig", CheckID: "KSV1", Workload: wl, Reason: "ok", ExpiresAt: future})
	if err != nil || got.ID == "" || got.CreatedAt == "" {
		t.Fatalf("%v %v", got, err)
	}
	if l, _ := ListTrivyExceptions("c1"); len(l) != 1 {
		t.Errorf("list %d", len(l))
	}
}

func TestRemoveTrivyException(t *testing.T) {
	histHome(t)
	e, err := AddTrivyException("c1", models.TrivyException{Kind: "vuln", VulnerabilityID: "CVE-1", ImageRepo: "r", Reason: "x", ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	if err != nil {
		t.Fatal(err)
	}
	if err := RemoveTrivyException("c1", e.ID); err != nil {
		t.Fatal(err)
	}
	if l, _ := ListTrivyExceptions("c1"); len(l) != 0 {
		t.Errorf("list %d", len(l))
	}
	if err := RemoveTrivyException("c1", "nope"); err == nil {
		t.Error("unknown id accepted")
	}
}

func TestLoadTrivyScanExactID(t *testing.T) {
	histHome(t)
	now := time.Now()
	a, am := mkScan("abc-123", now)
	b, bm := mkScan("123", now.Add(time.Second))
	for i, p := range []struct {
		s *models.TrivyClusterScan
		m models.TrivyScanMeta
	}{{a, am}, {b, bm}} {
		if err := SaveTrivyScan(p.s, p.m); err != nil {
			t.Fatal(i, err)
		}
	}
	for _, id := range []string{"abc-123", "123"} {
		got, err := LoadTrivyScan("c1", id)
		if err != nil || got.ID != id {
			t.Fatalf("%s: %v %v", id, got, err)
		}
	}
	if _, err := LoadTrivyScan("c1", "23"); err == nil {
		t.Error("partial id matched")
	}
}

func TestGetTrivyScanView(t *testing.T) {
	histHome(t)
	base := time.Now().Add(-time.Hour)
	prev, pm := mkScan("prev-1", base)
	cur, cm := mkScan("cur-1", base.Add(time.Minute))
	cur.SchemaVersion = models.TrivyScanSchemaVersion
	img := models.TrivyImageCoverage{Image: "nginx:1.27", Status: "scanned",
		Workloads: []models.TrivyWorkloadRef{{Kind: "Deployment", Name: "front", Namespace: "web"}}}
	cur.Images = []models.TrivyImageCoverage{img}
	cur.ImageTargets = map[string][]models.TrivyTarget{"nginx:1.27": {{Class: "os-pkgs", Vulnerabilities: []models.TrivyVulnerability{
		{VulnerabilityID: "CVE-A", PkgName: "openssl", Severity: "CRITICAL", FixedVersion: "3.1"},
		{VulnerabilityID: "CVE-B", PkgName: "zlib", Severity: "HIGH"},
	}}}}
	for _, s := range []struct {
		scan *models.TrivyClusterScan
		meta models.TrivyScanMeta
	}{{prev, pm}, {cur, cm}} {
		if err := SaveTrivyScan(s.scan, s.meta); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := AddTrivyException("c1", models.TrivyException{Kind: "vuln", VulnerabilityID: "CVE-A", ImageRepo: "nginx",
		Reason: "r", ExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}); err != nil {
		t.Fatal(err)
	}

	v, err := GetTrivyScanView("c1", "cur-1", "prev-1")
	if err != nil {
		t.Fatal(err)
	}
	if v.ScanID != "cur-1" || v.CompareID != "prev-1" || v.Changes == nil || len(v.Changes.New) != 2 {
		t.Errorf("compare view = id %q compare %q changes %+v", v.ScanID, v.CompareID, v.Changes)
	}
	if v.Summary.Vulns["CRITICAL"] != 0 || v.Summary.Vulns["HIGH"] != 1 || len(v.Exceptions) != 1 || v.Exceptions[0].Matches != 1 {
		t.Errorf("exceptions not applied: summary %v exceptions %+v", v.Summary.Vulns, v.Exceptions)
	}

	v, err = GetTrivyScanView("c1", "cur-1", "")
	if err != nil || v.Changes != nil || v.Summary.PrevVulns != nil {
		t.Errorf("no-compare view = %+v, %v", v, err)
	}
	if _, err := GetTrivyScanView("c1", "missing", ""); err == nil {
		t.Error("missing scan: want an error")
	}
	if _, err := GetTrivyScanView("c1", "cur-1", "missing"); err == nil {
		t.Error("missing compare scan: want an error")
	}
}
