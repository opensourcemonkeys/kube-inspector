package business

import (
	"os"
	"strings"
	"testing"
	"time"

	"kube-ins/internal/models"
	services "kube-ins/internal/services"
)

var reportNow = time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)

func reportLabels() map[string]string {
	return map[string]string{
		"title": "Vulnerability report", "summaryTitle": "Summary", "fixPlanTitle": "Fix plan",
		"auditTitle": "Audit appendix", "topWorkloadsTitle": "Riskiest workloads",
		"reasonAuth": "Registry authentication failed", "reasonOther": "Other error",
		"failedTitle": "Images that could not be scanned", "exceptionsTitle": "Accepted risks",
		"factTrivy": "Trivy version", "factDb": "Vulnerability DB updated", "factApiServer": "API server",
		"sevCritical": "Critical", "sevHigh": "High", "sevMedium": "Medium", "sevLow": "Low",
		"verdict": "Two exposed criticals.",
	}
}

func reportFixture() *models.TrivyClusterScan {
	w := models.TrivyWorkloadRef{Kind: "Deployment", Name: "<script>alert(1)</script>", Namespace: "prod"}
	return &models.TrivyClusterScan{
		SchemaVersion: 2, ID: "s1", ClusterName: "dev", Scope: "all namespaces",
		StartedAt: "2026-10-31T10:00:00Z", FinishedAt: "2026-10-31T10:05:00Z",
		AppVersion: "0.9.0", TrivyVersion: "0.99.1", DBUpdatedAt: "2026-10-30T06:00:00Z",
		APIServer: "https://k8s.example:6443", ServerVersion: "v1.31.0",
		Images: []models.TrivyImageCoverage{
			{Image: "reg.io/app:1", Workloads: []models.TrivyWorkloadRef{w}, Status: "scanned"},
			{Image: "priv.io/x:2", Status: "failed", Reason: "auth", Message: "denied"},
		},
		ImageTargets: map[string][]models.TrivyTarget{"reg.io/app:1": {{Target: "app", Class: "lang-pkgs",
			Vulnerabilities: []models.TrivyVulnerability{{VulnerabilityID: "CVE-1", PkgName: "lib", InstalledVersion: "1", FixedVersion: "2", Severity: "CRITICAL", Title: "bad"}}}}},
		Workloads: []models.TrivyWorkload{{Kind: "Deployment", Name: w.Name, Namespace: "prod", Images: []string{"reg.io/app:1"}, Exposure: []string{"LoadBalancer"}}},
	}
}

func renderFixture(t *testing.T, imageMode bool) string {
	t.Helper()
	exc := []models.TrivyException{{ID: "e1", Kind: "vuln", VulnerabilityID: "CVE-9", ImageRepo: "reg.io/app",
		Reason: "vendor patch pending", CreatedAt: "2026-10-01T00:00:00Z", ExpiresAt: "2026-12-31T00:00:00Z"}}
	v := services.BuildScanView(reportFixture(), nil, exc, reportNow)
	out, err := RenderTrivyReport(v, reportLabels(), imageMode, reportNow)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRenderTrivyReportSections(t *testing.T) {
	out := renderFixture(t, false)
	L := reportLabels()
	last := -1
	for _, k := range []string{"summaryTitle", "fixPlanTitle", "auditTitle"} {
		i := strings.Index(out, ">"+L[k]+"<")
		if i < 0 {
			t.Fatalf("section %q missing", L[k])
		}
		if i <= last {
			t.Fatalf("section %q out of order", L[k])
		}
		last = i
	}
	if !strings.Contains(out, "Two exposed criticals.") {
		t.Error("verdict missing")
	}
}

func TestRenderTrivyReportStatic(t *testing.T) {
	out := renderFixture(t, false)
	for _, bad := range []string{"<script", "<link", "http://", "src="} {
		if strings.Contains(out, bad) {
			t.Errorf("report contains %q", bad)
		}
	}
}

func TestRenderTrivyReportEscapes(t *testing.T) {
	out := renderFixture(t, false)
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Error("workload name not escaped")
	}
	if strings.Contains(out, "<script>alert") {
		t.Error("raw script tag in output")
	}
}

func TestRenderTrivyReportAuditFacts(t *testing.T) {
	out := renderFixture(t, false)
	for _, want := range []string{"0.99.1", "2026-10-30 06:00 UTC", "https://k8s.example:6443", "priv.io/x:2",
		"Registry authentication failed", "vendor patch pending", "2026-12-31 00:00 UTC"} {
		if !strings.Contains(out, want) {
			t.Errorf("audit appendix lacks %q", want)
		}
	}
}

func TestRenderTrivyReportImageMode(t *testing.T) {
	if out := renderFixture(t, true); strings.Contains(out, "Riskiest workloads") {
		t.Error("image mode must not print the top-workloads block")
	}
	if out := renderFixture(t, false); !strings.Contains(out, "Riskiest workloads") {
		t.Error("cluster mode lost the top-workloads block")
	}
}

func TestRenderTrivyReportMissingLabelPrintsKey(t *testing.T) {
	v := services.BuildScanView(reportFixture(), nil, nil, reportNow)
	out, err := RenderTrivyReport(v, nil, false, reportNow)
	if err != nil || !strings.Contains(out, "summaryTitle") {
		t.Fatalf("err=%v, key not printed", err)
	}
}

func TestBuildImageReportScan(t *testing.T) {
	results := []models.TrivyScanResult{
		{ArtifactRef: "nginx:1", OS: &models.TrivyOSInfo{Family: "debian", Name: "12"},
			Targets: []models.TrivyTarget{{Target: "nginx", Class: "os-pkgs", Vulnerabilities: []models.TrivyVulnerability{{VulnerabilityID: "CVE-2", Severity: "HIGH"}}}}},
		{ArtifactRef: "gone:1", Error: "not found"},
	}
	s := BuildImageReportScan("dev", results, reportNow)
	if len(s.Images) != 2 || s.Images[0].Status != "scanned" || s.Images[0].OS == nil || len(s.Images[0].Workloads) != 0 {
		t.Fatalf("scanned image wrong: %+v", s.Images)
	}
	if f := s.Images[1]; f.Status != "failed" || f.Reason != "other" || f.Message != "not found" {
		t.Fatalf("failed image wrong: %+v", f)
	}
	if len(s.ImageTargets["nginx:1"]) != 1 || s.ImageTargets["gone:1"] != nil {
		t.Fatalf("targets wrong: %+v", s.ImageTargets)
	}
	v := services.BuildScanView(s, nil, nil, reportNow)
	if v.Summary.Vulns["HIGH"] != 1 || v.Summary.ImagesScanned != 1 || v.Summary.ImagesTotal != 2 {
		t.Fatalf("view wrong: %+v", v.Summary)
	}
}

// TestWriteSampleReport renders a sample for eyeballing when asked to.
func TestWriteSampleReport(t *testing.T) {
	p := os.Getenv("KUBE_INS_SAMPLE_REPORT")
	if p == "" {
		t.Skip("set KUBE_INS_SAMPLE_REPORT to write a sample")
	}
	if err := os.WriteFile(p, []byte(renderFixture(t, false)), 0o600); err != nil {
		t.Fatal(err)
	}
}
