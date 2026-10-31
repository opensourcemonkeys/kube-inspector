package services_k8sclient

import (
	"testing"

	"kube-ins/internal/models"
)

func TestVulnSeverityCountsDistinctOverScannedImages(t *testing.T) {
	v := func(id, pkg, path, sev string) models.TrivyVulnerability {
		return models.TrivyVulnerability{VulnerabilityID: id, PkgName: pkg, PkgPath: path, Severity: sev}
	}
	targets := map[string][]models.TrivyTarget{
		"a:1": {
			{Target: "os", Vulnerabilities: []models.TrivyVulnerability{v("CVE-1", "openssl", "", "CRITICAL"), v("CVE-2", "zlib", "", "high")}},
			{Target: "dup", Vulnerabilities: []models.TrivyVulnerability{v("CVE-1", "openssl", "", "CRITICAL")}},
			{Target: "jar", Vulnerabilities: []models.TrivyVulnerability{v("CVE-3", "log4j", "a.jar", "CRITICAL"), v("CVE-3", "log4j", "b.jar", "CRITICAL"), v("CVE-4", "x", "", "")}},
		},
		"b:1": {{Target: "os", Vulnerabilities: []models.TrivyVulnerability{v("CVE-1", "openssl", "", "CRITICAL")}}},
		// Targets of an image that failed (or is not in the coverage list) are ignored.
		"c:1": {{Target: "os", Vulnerabilities: []models.TrivyVulnerability{v("CVE-9", "y", "", "CRITICAL")}}},
		"d:1": {{Target: "os", Vulnerabilities: []models.TrivyVulnerability{v("CVE-8", "y", "", "CRITICAL")}}},
	}
	images := []models.TrivyImageCoverage{
		{Image: "a:1", Status: "scanned"},
		{Image: "b:1", Status: "scanned"},
		{Image: "c:1", Status: "failed"},
	}
	got := VulnSeverityCounts(targets, images)
	want := map[string]int{"CRITICAL": 4, "HIGH": 1, "UNKNOWN": 1}
	if len(got) != len(want) {
		t.Fatalf("counts = %v, want %v", got, want)
	}
	for k, n := range want {
		if got[k] != n {
			t.Errorf("counts[%s] = %d, want %d (all: %v)", k, got[k], n, got)
		}
	}
}
