package services_k8sclient

import (
	"strings"

	"kube-ins/internal/models"
)

// VulnSeverityCounts counts vulnerability findings by severity over the images
// that were scanned. A finding is a distinct (image, VulnerabilityID, PkgName,
// PkgPath): the same CVE reported by two targets of one image counts once, the
// same CVE in another image or another pkgPath counts again. Severity is
// upper-cased; an empty one is "UNKNOWN".
func VulnSeverityCounts(targets map[string][]models.TrivyTarget, images []models.TrivyImageCoverage) map[string]int {
	counts := map[string]int{}
	seen := map[[4]string]struct{}{}
	for _, img := range images {
		if img.Status != "scanned" {
			continue
		}
		for _, t := range targets[img.Image] {
			for _, v := range t.Vulnerabilities {
				key := [4]string{img.Image, v.VulnerabilityID, v.PkgName, v.PkgPath}
				if _, ok := seen[key]; ok {
					continue
				}
				seen[key] = struct{}{}
				sev := strings.ToUpper(v.Severity)
				if sev == "" {
					sev = "UNKNOWN"
				}
				counts[sev]++
			}
		}
	}
	return counts
}
