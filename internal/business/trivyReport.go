package business

import (
	"bytes"
	_ "embed"
	"fmt"
	"html/template"
	"sort"
	"strings"
	"time"

	"kube-ins/internal/models"
	services "kube-ins/internal/services"
)

// The report is a standalone, static HTML document: no script, no external
// request. html/template (never text/template) escapes every scan-derived
// string, because workload names and CVE titles come from outside.
//
//go:embed assets/trivy-report.html.tmpl
var trivyReportTmpl string

var severityOrder = []string{"CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"}

var severityMarks = map[string]string{
	"CRITICAL": "■", "HIGH": "▲", "MEDIUM": "◆", "LOW": "○", "UNKNOWN": "◇",
}

// reportCountRow is one severity line of the summary table.
type reportCountRow struct {
	Severity                   string
	Vulns, Misconfigs, Secrets int
	Total                      int
	Delta                      int
	HasDelta                   bool
}

type reportData struct {
	V         models.TrivyScanView
	L         map[string]string
	ImageMode bool
	Generated string
	Counts    []reportCountRow
	Compared  bool
	Failed    []models.TrivyImageCoverage
	FixablePc string
}

// BuildImageReportScan wraps the results of the single-image tab in a
// workload-less synthetic scan so the report can reuse BuildScanView.
func BuildImageReportScan(clusterName string, results []models.TrivyScanResult, now time.Time) *models.TrivyClusterScan {
	scan := &models.TrivyClusterScan{
		ID:           "image",
		ClusterName:  clusterName,
		Scope:        "image",
		StartedAt:    now.Format(time.RFC3339),
		FinishedAt:   now.Format(time.RFC3339),
		ImageTargets: map[string][]models.TrivyTarget{},
	}
	for _, r := range results {
		cov := models.TrivyImageCoverage{Image: r.ArtifactRef, Status: "scanned", OS: r.OS}
		if r.Error != "" {
			cov.Status, cov.Reason, cov.Message = "failed", "other", r.Error
		} else {
			scan.ImageTargets[r.ArtifactRef] = r.Targets
		}
		scan.Images = append(scan.Images, cov)
	}
	return scan
}

// RenderTrivyReport renders the three-section report (Summary, Fix plan,
// Audit appendix). labels carries every static string; a missing key prints
// the key itself so a gap is visible rather than blank.
func RenderTrivyReport(v models.TrivyScanView, labels map[string]string, imageMode bool, generatedAt time.Time) (string, error) {
	if labels == nil {
		labels = map[string]string{}
	}
	d := reportData{V: v, L: labels, ImageMode: imageMode, Generated: generatedAt.Format("2006-01-02 15:04 MST")}
	s := v.Summary
	d.Compared = s.PrevVulns != nil || s.PrevMisconfigs != nil || s.PrevSecrets != nil
	for _, sev := range severityOrder {
		r := reportCountRow{Severity: sev, Vulns: s.Vulns[sev], Misconfigs: s.Misconfigs[sev], Secrets: s.Secrets[sev]}
		r.Total = r.Vulns + r.Misconfigs + r.Secrets
		if d.Compared {
			r.HasDelta = true
			r.Delta = r.Total - (s.PrevVulns[sev] + s.PrevMisconfigs[sev] + s.PrevSecrets[sev])
		}
		d.Counts = append(d.Counts, r)
	}
	for _, c := range v.Coverage {
		if c.Status != "scanned" {
			d.Failed = append(d.Failed, c)
		}
	}
	if s.FixableRatio >= 0 {
		d.FixablePc = fmt.Sprintf("%d%%", int(s.FixableRatio*100+0.5))
	}

	funcs := template.FuncMap{
		"label": func(k string) string {
			if x, ok := labels[k]; ok {
				return x
			}
			return k
		},
		"sevMark": func(sev string) string {
			if m, ok := severityMarks[strings.ToUpper(sev)]; ok {
				return m
			}
			return "◇"
		},
		"sevLabel": func(sev string) string {
			k := "sev" + strings.Title(strings.ToLower(sev)) //nolint:staticcheck // ASCII severity names
			if x, ok := labels[k]; ok {
				return x
			}
			return sev
		},
		"reason": func(code string) string {
			if code == "" {
				return "—"
			}
			if x, ok := labels["reason"+strings.ToUpper(code[:1])+code[1:]]; ok {
				return x
			}
			return code
		},
		"when": func(ts string) string {
			if ts == "" {
				return "—"
			}
			if t, err := time.Parse(time.RFC3339, ts); err == nil {
				return t.UTC().Format("2006-01-02 15:04 UTC")
			}
			return ts
		},
		"dash": func(s string) string {
			if s == "" {
				return "—"
			}
			return s
		},
		"ref": func(w models.TrivyWorkloadRef) string {
			if w.Name == "" {
				return "—"
			}
			if w.Namespace == "" {
				return w.Kind + "/" + w.Name
			}
			return w.Namespace + "/" + w.Kind + "/" + w.Name
		},
		"sevCounts": func(m map[string]int) []string {
			var out []string
			for _, sev := range severityOrder {
				if n := m[sev]; n > 0 {
					out = append(out, fmt.Sprintf("%s %s %d", severityMarks[sev], labels["sev"+strings.Title(strings.ToLower(sev))], n)) //nolint:staticcheck
				}
			}
			return out
		},
		"keys": func(m map[string]int) []string {
			ks := make([]string, 0, len(m))
			for k := range m {
				ks = append(ks, k)
			}
			sort.Strings(ks)
			return ks
		},
		"lower": strings.ToLower,
		"join":  strings.Join,
		"add":   func(a, b int) int { return a + b },
		"absInt": func(n int) int {
			if n < 0 {
				return -n
			}
			return n
		},
		"osName": func(o *models.TrivyOSInfo) string {
			if o == nil {
				return ""
			}
			return strings.TrimSpace(o.Family + " " + o.Name)
		},
	}
	t, err := template.New("report").Funcs(funcs).Parse(trivyReportTmpl)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, d); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// RenderTrivyImageReport builds the report for the single-image tab: the
// summary has no workloads or comparison, the fix plan and appendix as usual.
func RenderTrivyImageReport(clusterName string, results []models.TrivyScanResult, labels map[string]string, now time.Time) (string, error) {
	v := services.BuildScanView(BuildImageReportScan(clusterName, results, now), nil, nil, now)
	return RenderTrivyReport(v, labels, true, now)
}

// ExportTrivyReport renders the saved scan's report; compareId may be empty.
func ExportTrivyReport(clusterName, scanId, compareId string, labels map[string]string, now time.Time) (string, error) {
	v, err := GetTrivyScanView(clusterName, scanId, compareId)
	if err != nil {
		return "", err
	}
	return RenderTrivyReport(*v, labels, false, now)
}
