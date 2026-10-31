package services_k8sclient

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

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

// ---- Task 6: view, fix plan, diff ----

var viewNow = time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)

func vuln(id, pkg, installed, fixed, sev string) models.TrivyVulnerability {
	return models.TrivyVulnerability{VulnerabilityID: id, PkgName: pkg, InstalledVersion: installed, FixedVersion: fixed, Severity: sev}
}

func wref(ns, kind, name string) models.TrivyWorkloadRef {
	return models.TrivyWorkloadRef{Kind: kind, Name: name, Namespace: ns}
}

// scanOf builds a scan where each image is scanned and used by the given workloads.
func scanOf(id string, images map[string][]models.TrivyWorkloadRef, targets map[string][]models.TrivyTarget, workloads []models.TrivyWorkload) *models.TrivyClusterScan {
	s := &models.TrivyClusterScan{SchemaVersion: models.TrivyScanSchemaVersion, ID: id, ImageTargets: targets, Workloads: workloads}
	names := make([]string, 0, len(images))
	for img := range images {
		names = append(names, img)
	}
	sort.Strings(names)
	for _, img := range names {
		s.Images = append(s.Images, models.TrivyImageCoverage{Image: img, Status: "scanned", Workloads: images[img]})
	}
	return s
}

func noAccept(models.TrivyVulnRow) bool         { return false }
func noAcceptMis(models.TrivyMisconfigRow) bool { return false }

func TestImageRepo(t *testing.T) {
	digest := "sha256:" + strings.Repeat("ab", 32)
	cases := map[string]string{
		"nginx:1.27":            "index.docker.io/library/nginx",
		"localhost:5000/app:1":  "localhost:5000/app",
		"ghcr.io/a/b@" + digest: "ghcr.io/a/b",
	}
	for in, want := range cases {
		if got := ImageRepo(in); got != want {
			t.Errorf("ImageRepo(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFixPlanGroupsPackageAcrossImages(t *testing.T) {
	lang := func(vs ...models.TrivyVulnerability) []models.TrivyTarget {
		return []models.TrivyTarget{{Target: "app", Class: "lang-pkgs", Type: "gomod", Vulnerabilities: vs}}
	}
	scan := scanOf("s1",
		map[string][]models.TrivyWorkloadRef{"a:1": {wref("ns", "Deployment", "a")}, "b:1": {wref("ns", "Deployment", "b")}},
		map[string][]models.TrivyTarget{
			"a:1": lang(vuln("CVE-1", "golang.org/x/net", "v0.23.0", "0.33.0", "CRITICAL"), vuln("CVE-2", "golang.org/x/net", "v0.23.0", "0.33.0", "HIGH")),
			"b:1": lang(vuln("CVE-3", "golang.org/x/net", "v0.23.0", "0.33.0", "HIGH")),
		}, nil)
	plan, unfixable := BuildFixPlan(scan, noAccept, noAcceptMis)
	if unfixable != 0 || len(plan) != 1 {
		t.Fatalf("plan = %+v, unfixable = %d; want one item", plan, unfixable)
	}
	it := plan[0]
	if it.Kind != "package" || it.ID != "pkg:golang.org/x/net@v0.23.0" {
		t.Errorf("item = %s %s", it.Kind, it.ID)
	}
	if it.Closes["CRITICAL"] != 1 || it.Closes["HIGH"] != 2 {
		t.Errorf("Closes = %v", it.Closes)
	}
	if len(it.Images) != 2 || len(it.Workloads) != 2 || len(it.VulnIDs) != 3 {
		t.Errorf("Images=%v Workloads=%v VulnIDs=%v", it.Images, it.Workloads, it.VulnIDs)
	}
}

func TestFixPlanPicksHighestFixedVersion(t *testing.T) {
	scan := scanOf("s1",
		map[string][]models.TrivyWorkloadRef{"a:1": {wref("ns", "Deployment", "a")}},
		map[string][]models.TrivyTarget{"a:1": {{Class: "lang-pkgs", Vulnerabilities: []models.TrivyVulnerability{
			vuln("CVE-1", "x/net", "0.23.0", "0.30.0, 0.33.0", "HIGH"),
			vuln("CVE-2", "x/net", "0.23.0", "0.31.0", "HIGH"),
		}}}}, nil)
	plan, _ := BuildFixPlan(scan, noAccept, noAcceptMis)
	if len(plan) != 1 {
		t.Fatalf("plan = %+v", plan)
	}
	if plan[0].FixedVersion != "0.33.0" {
		t.Errorf("FixedVersion = %q, want 0.33.0", plan[0].FixedVersion)
	}
	want := []string{"0.30.0", "0.31.0", "0.33.0"}
	if strings.Join(plan[0].FixedVersions, ",") != strings.Join(want, ",") {
		t.Errorf("FixedVersions = %v, want %v", plan[0].FixedVersions, want)
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.10.0", "0.9.0", 1},
		{"1.2.3-r1", "1.2.3-r0", 1},
		{"1.2", "1.2.0", -1},
		{"1.2.3", "1.2.3", 0},
		{"v1.10", "v1.9", 1},
		{"3.0.15-r1", "3.0.15-r10", -1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestFixPlanBaseOSItem(t *testing.T) {
	build := func(os *models.TrivyOSInfo) *models.TrivyClusterScan {
		s := scanOf("s1",
			map[string][]models.TrivyWorkloadRef{"a:1": {wref("ns", "Deployment", "a")}},
			map[string][]models.TrivyTarget{"a:1": {{Class: "os-pkgs", Type: "alpine", Vulnerabilities: []models.TrivyVulnerability{
				vuln("CVE-1", "openssl", "3.1.4-r0", "3.1.4-r5", "CRITICAL"),
			}}}}, nil)
		s.Images[0].OS = os
		return s
	}
	plan, _ := BuildFixPlan(build(&models.TrivyOSInfo{Family: "alpine", Name: "3.19", EOSL: true}), noAccept, noAcceptMis)
	if len(plan) != 1 || plan[0].Kind != "baseOS" || plan[0].ID != "os:a:1" {
		t.Fatalf("plan = %+v; want one baseOS item os:a:1", plan)
	}
	if plan[0].OS == nil || !plan[0].OS.EOSL || plan[0].Image != "a:1" {
		t.Errorf("baseOS item = %+v", plan[0])
	}
	plan, _ = BuildFixPlan(build(nil), noAccept, noAcceptMis)
	if len(plan) != 1 || plan[0].Kind != "package" || plan[0].ID != "pkg:openssl@3.1.4-r0" {
		t.Fatalf("plan without OS = %+v; want one package item", plan)
	}
}

func TestFixPlanOrdering(t *testing.T) {
	lang := func(pkg string, sevs ...string) []models.TrivyTarget {
		var vs []models.TrivyVulnerability
		for i, s := range sevs {
			vs = append(vs, vuln(fmt.Sprintf("CVE-%s-%d", pkg, i), pkg, "1.0", "2.0", s))
		}
		return []models.TrivyTarget{{Class: "lang-pkgs", Vulnerabilities: vs}}
	}
	scan := scanOf("s1",
		map[string][]models.TrivyWorkloadRef{
			"a:1": {wref("ns", "Deployment", "internal")},
			"b:1": {wref("ns", "Deployment", "public")},
			"c:1": {wref("ns", "Deployment", "internal")},
			"d:1": {wref("ns", "Deployment", "internal")},
		},
		map[string][]models.TrivyTarget{
			"a:1": lang("aaa", "CRITICAL"),         // 1 critical, not exposed
			"b:1": lang("bbb", "CRITICAL"),         // 1 critical, exposed
			"c:1": lang("ccc", "CRITICAL", "HIGH"), // 1 critical + 1 high
			"d:1": lang("ddd", "HIGH", "HIGH"),     // no critical
		},
		[]models.TrivyWorkload{
			{Kind: "Deployment", Name: "internal", Namespace: "ns"},
			{Kind: "Deployment", Name: "public", Namespace: "ns", Exposure: []string{"LoadBalancer"}},
		})
	plan, _ := BuildFixPlan(scan, noAccept, noAcceptMis)
	var ids []string
	for _, it := range plan {
		ids = append(ids, it.ID)
	}
	want := []string{"pkg:ccc@1.0", "pkg:bbb@1.0", "pkg:aaa@1.0", "pkg:ddd@1.0"}
	if strings.Join(ids, " ") != strings.Join(want, " ") {
		t.Errorf("order = %v, want %v", ids, want)
	}
	if plan[1].ExposedWorkloads != 1 || plan[2].ExposedWorkloads != 0 {
		t.Errorf("ExposedWorkloads = %d, %d", plan[1].ExposedWorkloads, plan[2].ExposedWorkloads)
	}
}

func TestFixPlanUnfixableCount(t *testing.T) {
	scan := scanOf("s1",
		map[string][]models.TrivyWorkloadRef{"a:1": {wref("ns", "Deployment", "a")}},
		map[string][]models.TrivyTarget{"a:1": {{Class: "lang-pkgs", Vulnerabilities: []models.TrivyVulnerability{
			vuln("CVE-1", "p", "1", "", "CRITICAL"), vuln("CVE-2", "p", "1", "", "HIGH"), vuln("CVE-3", "q", "1", "", "LOW"),
		}}}}, nil)
	plan, unfixable := BuildFixPlan(scan, noAccept, noAcceptMis)
	if unfixable != 3 || len(plan) != 0 {
		t.Errorf("plan = %+v, unfixable = %d; want empty plan, 3", plan, unfixable)
	}
}

func TestFixPlanMisconfigGroupedByNormalizedCheck(t *testing.T) {
	scan := scanOf("s1", nil, nil, []models.TrivyWorkload{
		{Kind: "Deployment", Name: "a", Namespace: "ns", Exposure: []string{"Ingress"}},
	})
	scan.Misconfigs = []models.TrivyK8sMisconfigFinding{
		{ResourceKind: "Deployment", ResourceName: "a", Namespace: "ns", CheckID: "KSV-0017", Severity: "HIGH", Title: "Privileged", Resolution: "drop it"},
		{ResourceKind: "DaemonSet", ResourceName: "b", Namespace: "ns", CheckID: "AVD-KSV-0017", Severity: "HIGH", Title: "Privileged"},
	}
	plan, _ := BuildFixPlan(scan, noAccept, noAcceptMis)
	if len(plan) != 1 || plan[0].Kind != "misconfig" || plan[0].ID != "check:KSV17" {
		t.Fatalf("plan = %+v; want one misconfig item check:KSV17", plan)
	}
	if plan[0].Closes["HIGH"] != 2 || len(plan[0].Workloads) != 2 || plan[0].ExposedWorkloads != 1 || plan[0].Resolution != "drop it" {
		t.Errorf("item = %+v", plan[0])
	}
}

func acceptedFixture() (*models.TrivyClusterScan, []models.TrivyException) {
	scan := scanOf("s1",
		map[string][]models.TrivyWorkloadRef{"nginx:1.27": {wref("web", "Deployment", "front")}},
		map[string][]models.TrivyTarget{"nginx:1.27": {{Class: "os-pkgs", Vulnerabilities: []models.TrivyVulnerability{
			vuln("CVE-A", "openssl", "3.0", "3.1", "CRITICAL"),
			vuln("CVE-B", "zlib", "1.2", "1.3", "HIGH"),
		}}}},
		[]models.TrivyWorkload{{Kind: "Deployment", Name: "front", Namespace: "web", Images: []string{"nginx:1.27"}}})
	exc := []models.TrivyException{{
		ID: "e1", Kind: "vuln", VulnerabilityID: "CVE-A",
		ImageRepo: "index.docker.io/library/nginx", // accepted on another tag
		Reason:    "not reachable", ExpiresAt: viewNow.Add(24 * time.Hour).Format(time.RFC3339),
	}}
	return scan, exc
}

func TestViewAcceptedVulnExcluded(t *testing.T) {
	scan, exc := acceptedFixture()
	v := BuildScanView(scan, nil, exc, viewNow)
	if v.Summary.Vulns["CRITICAL"] != 0 || v.Summary.Vulns["HIGH"] != 1 {
		t.Errorf("Summary.Vulns = %v; want CVE-A excluded", v.Summary.Vulns)
	}
	var acceptedA bool
	for _, r := range v.Vulns {
		if r.VulnerabilityID == "CVE-A" {
			acceptedA = r.Accepted
		} else if r.Accepted {
			t.Errorf("row %s accepted", r.VulnerabilityID)
		}
	}
	if !acceptedA {
		t.Errorf("CVE-A row not marked Accepted: %+v", v.Vulns)
	}
	if len(v.Exceptions) != 1 || v.Exceptions[0].Matches != 1 || v.Exceptions[0].Expired {
		t.Errorf("Exceptions = %+v", v.Exceptions)
	}
	for _, it := range v.FixPlan {
		for _, id := range it.VulnIDs {
			if id == "CVE-A" {
				t.Errorf("accepted CVE-A in fix plan item %s", it.ID)
			}
		}
	}
	// Only HIGH remains, it is fixable → ratio 1.
	if v.Summary.FixableRatio != 1 {
		t.Errorf("FixableRatio = %v", v.Summary.FixableRatio)
	}
}

func TestViewExpiredExceptionCountsAgain(t *testing.T) {
	scan, exc := acceptedFixture()
	exc[0].ExpiresAt = viewNow.Add(-time.Hour).Format(time.RFC3339)
	v := BuildScanView(scan, nil, exc, viewNow)
	for _, r := range v.Vulns {
		if r.Accepted {
			t.Errorf("row %s accepted by an expired exception", r.VulnerabilityID)
		}
	}
	if v.Summary.Vulns["CRITICAL"] != 1 {
		t.Errorf("Summary.Vulns = %v; want CVE-A counted again", v.Summary.Vulns)
	}
	if !v.Exceptions[0].Expired {
		t.Errorf("Exceptions[0] = %+v; want Expired", v.Exceptions[0])
	}
}

func TestViewAcceptedMisconfigScopedToWorkload(t *testing.T) {
	scan := scanOf("s1", nil, nil, nil)
	scan.Misconfigs = []models.TrivyK8sMisconfigFinding{
		{ResourceKind: "DaemonSet", ResourceName: "log-agent", Namespace: "ops", CheckID: "KSV017", Severity: "HIGH"},
		{ResourceKind: "Deployment", ResourceName: "api", Namespace: "web", CheckID: "KSV017", Severity: "HIGH"},
	}
	exc := []models.TrivyException{{ID: "e1", Kind: "misconfig", CheckID: "KSV-0017", Workload: wref("ops", "DaemonSet", "log-agent"),
		Reason: "needs host", ExpiresAt: viewNow.Add(time.Hour).Format(time.RFC3339)}}
	v := BuildScanView(scan, nil, exc, viewNow)
	if v.Summary.Misconfigs["HIGH"] != 1 {
		t.Errorf("Summary.Misconfigs = %v; want 1 HIGH", v.Summary.Misconfigs)
	}
	for _, r := range v.Misconfigs {
		if r.Accepted != (r.ResourceName == "log-agent") {
			t.Errorf("row %s Accepted = %v", r.ResourceName, r.Accepted)
		}
	}
	if v.Exceptions[0].Matches != 1 {
		t.Errorf("Matches = %d", v.Exceptions[0].Matches)
	}
	if len(v.FixPlan) != 1 || len(v.FixPlan[0].Workloads) != 1 || v.FixPlan[0].Workloads[0].Name != "api" {
		t.Errorf("FixPlan = %+v; want KSV17 for api only", v.FixPlan)
	}
}

func TestDiffScans(t *testing.T) {
	front := wref("web", "Deployment", "front")
	batch := wref("jobs", "CronJob", "batch")
	osT := func(vs ...models.TrivyVulnerability) []models.TrivyTarget {
		return []models.TrivyTarget{{Class: "os-pkgs", Vulnerabilities: vs}}
	}
	prev := scanOf("p",
		map[string][]models.TrivyWorkloadRef{"app:1": {front}},
		map[string][]models.TrivyTarget{"app:1": osT(vuln("CVE-A", "openssl", "1", "2", "HIGH"))},
		[]models.TrivyWorkload{{Kind: "Deployment", Name: "front", Namespace: "web"}})
	cur := scanOf("c",
		map[string][]models.TrivyWorkloadRef{"app:2": {front}, "job:1": {batch}},
		map[string][]models.TrivyTarget{"app:2": osT(vuln("CVE-B", "openssl", "1", "2", "CRITICAL"))},
		[]models.TrivyWorkload{{Kind: "Deployment", Name: "front", Namespace: "web"}, {Kind: "CronJob", Name: "batch", Namespace: "jobs"}})
	d := DiffScans(cur, prev)
	if len(d.New) != 1 || d.New[0].ID != "CVE-B" || d.New[0].Key != "web/Deployment/front|CVE-B|openssl|" || d.New[0].Kind != "vuln" {
		t.Errorf("New = %+v", d.New)
	}
	if len(d.Closed) != 1 || d.Closed[0].ID != "CVE-A" || d.Closed[0].Severity != "HIGH" {
		t.Errorf("Closed = %+v", d.Closed)
	}
	if len(d.NewWorkloads) != 1 || d.NewWorkloads[0] != batch {
		t.Errorf("NewWorkloads = %+v", d.NewWorkloads)
	}
	v := BuildScanView(cur, prev, nil, viewNow)
	if v.Changes == nil || len(v.Changes.New) != 1 || v.CompareID != "p" {
		t.Fatalf("view changes = %+v, compare %q", v.Changes, v.CompareID)
	}
	if len(v.Vulns) != 1 || !v.Vulns[0].IsNew {
		t.Errorf("Vulns = %+v; want the CVE-B row marked new", v.Vulns)
	}
	if v.Summary.PrevVulns["HIGH"] != 1 || v.Summary.Vulns["CRITICAL"] != 1 {
		t.Errorf("Summary = %+v", v.Summary)
	}
}

func TestViewWithoutCompare(t *testing.T) {
	scan, _ := acceptedFixture()
	v := BuildScanView(scan, nil, nil, viewNow)
	if v.Changes != nil || v.Summary.PrevVulns != nil || v.Summary.PrevMisconfigs != nil || v.Summary.PrevSecrets != nil {
		t.Errorf("Changes=%v Prev=%v/%v/%v; want all nil", v.Changes, v.Summary.PrevVulns, v.Summary.PrevMisconfigs, v.Summary.PrevSecrets)
	}
	for _, r := range v.Vulns {
		if r.IsNew {
			t.Errorf("row %s IsNew without a comparison", r.Key)
		}
	}
	if v.CompareID != "" || !v.ExposureKnown || v.ScanID != "s1" {
		t.Errorf("view meta = %q %v %q", v.CompareID, v.ExposureKnown, v.ScanID)
	}
}

func TestViewTopWorkloads(t *testing.T) {
	osT := func(vs ...models.TrivyVulnerability) []models.TrivyTarget {
		return []models.TrivyTarget{{Class: "os-pkgs", Vulnerabilities: vs}}
	}
	scan := scanOf("s1",
		map[string][]models.TrivyWorkloadRef{
			"a:1": {wref("ns", "Deployment", "crit2")},
			"b:1": {wref("ns", "Deployment", "exposed")},
			"c:1": {wref("ns", "Deployment", "crit2priv")},
		},
		map[string][]models.TrivyTarget{
			"a:1": osT(vuln("CVE-1", "p", "1", "2", "CRITICAL"), vuln("CVE-2", "p", "1", "2", "CRITICAL")),
			"b:1": osT(vuln("CVE-3", "p", "1", "2", "LOW")),
			"c:1": osT(vuln("CVE-1", "p", "1", "2", "CRITICAL"), vuln("CVE-2", "p", "1", "2", "CRITICAL")),
		},
		[]models.TrivyWorkload{
			{Kind: "Deployment", Name: "crit2", Namespace: "ns"},
			{Kind: "Deployment", Name: "exposed", Namespace: "ns", Exposure: []string{"NodePort"}},
			{Kind: "Deployment", Name: "crit2priv", Namespace: "ns", Privileges: []string{"root"}},
			{Kind: "Deployment", Name: "clean", Namespace: "ns"},
			{Kind: "Deployment", Name: "privonly", Namespace: "ns", Privileges: []string{"hostPath"}},
		})
	v := BuildScanView(scan, nil, nil, viewNow)
	var names []string
	for _, w := range v.TopWorkloads {
		names = append(names, w.Workload.Name)
	}
	want := []string{"exposed", "crit2priv", "crit2", "privonly"}
	if strings.Join(names, " ") != strings.Join(want, " ") {
		t.Errorf("TopWorkloads = %v, want %v", names, want)
	}
	if v.TopWorkloads[1].Counts["CRITICAL"] != 2 {
		t.Errorf("Counts = %v", v.TopWorkloads[1].Counts)
	}
}

func TestDiffScansIgnoresWhatTheOtherScanCouldNotSee(t *testing.T) {
	front := wref("web", "Deployment", "front")
	osT := []models.TrivyTarget{{Class: "os-pkgs", Vulnerabilities: []models.TrivyVulnerability{vuln("CVE-A", "openssl", "1", "2", "HIGH")}}}
	mis := []models.TrivyK8sMisconfigFinding{{ResourceKind: "Deployment", ResourceName: "front", Namespace: "web", CheckID: "KSV012", Severity: "MEDIUM"}}
	prev := scanOf("p", map[string][]models.TrivyWorkloadRef{"app:1": {front}}, map[string][]models.TrivyTarget{"app:1": osT}, nil)
	prev.Misconfigs = mis
	cur := scanOf("c", map[string][]models.TrivyWorkloadRef{"app:1": {front}}, nil, nil)
	cur.Images[0].Status, cur.Images[0].Reason = "failed", "timeout"
	cur.MisconfigError = "forbidden"
	if d := DiffScans(cur, prev); len(d.Closed) != 0 {
		t.Errorf("Closed = %+v; an image that failed and a misconfig scan that failed close nothing", d.Closed)
	}
	// The other direction: findings are not "new" against a scan that could not see them.
	if d := DiffScans(prev, cur); len(d.New) != 0 {
		t.Errorf("New = %+v; want none against a scan that failed to see them", d.New)
	}
}

func TestViewExposedCriticalNotTruncatedAndDistinct(t *testing.T) {
	// 12 exposed workloads share one image (more than the 10 ranked
	// workloads), plus one internal workload with its own image.
	var exposedRefs []models.TrivyWorkloadRef
	var workloads []models.TrivyWorkload
	for i := 0; i < 12; i++ {
		ref := wref("prod", "Deployment", fmt.Sprintf("web-%02d", i))
		exposedRefs = append(exposedRefs, ref)
		workloads = append(workloads, models.TrivyWorkload{Kind: ref.Kind, Name: ref.Name, Namespace: ref.Namespace,
			Images: []string{"shared:1"}, Exposure: []string{"LoadBalancer prod/" + ref.Name}})
	}
	internal := wref("prod", "Deployment", "worker")
	workloads = append(workloads, models.TrivyWorkload{Kind: internal.Kind, Name: internal.Name, Namespace: internal.Namespace, Images: []string{"internal:1"}})

	// The last 12 exposed workloads each carry a distinct critical vuln, so
	// the ranked list (capped at 10) cannot see them all.
	targets := map[string][]models.TrivyTarget{
		"shared:1": {{Target: "os", Vulnerabilities: []models.TrivyVulnerability{
			vuln("CVE-1", "openssl", "1", "2", "CRITICAL"),
			vuln("CVE-2", "zlib", "1", "", "CRITICAL"),
			vuln("CVE-3", "curl", "1", "2", "HIGH"),
			vuln("CVE-4", "acc", "1", "2", "CRITICAL"),
		}}},
		"internal:1": {{Target: "os", Vulnerabilities: []models.TrivyVulnerability{vuln("CVE-9", "x", "1", "2", "CRITICAL")}}},
	}
	s := scanOf("s1", map[string][]models.TrivyWorkloadRef{"shared:1": exposedRefs, "internal:1": {internal}}, targets, workloads)
	s.Misconfigs = []models.TrivyK8sMisconfigFinding{
		{ResourceKind: "Deployment", ResourceName: "web-00", Namespace: "prod", CheckID: "KSV017", Severity: "CRITICAL"},
		{ResourceKind: "Deployment", ResourceName: "web-11", Namespace: "prod", CheckID: "KSV017", Severity: "CRITICAL"},
		{ResourceKind: "Deployment", ResourceName: "web-01", Namespace: "prod", CheckID: "KSV012", Severity: "CRITICAL"}, // accepted below
		{ResourceKind: "Deployment", ResourceName: "worker", Namespace: "prod", CheckID: "KSV017", Severity: "CRITICAL"},
		{ResourceKind: "Deployment", ResourceName: "web-02", Namespace: "prod", CheckID: "KSV020", Severity: "HIGH"},
	}
	s.Secrets = []models.TrivyK8sSecretFinding{
		{ResourceKind: "Deployment", ResourceName: "web-05", Namespace: "prod", RuleID: "aws", Severity: "CRITICAL"},
		{ResourceKind: "Deployment", ResourceName: "worker", Namespace: "prod", RuleID: "aws", Severity: "CRITICAL"},
	}
	exc := []models.TrivyException{
		{ID: "e1", Kind: "vuln", VulnerabilityID: "CVE-4", ImageRepo: ImageRepo("shared:1"), ExpiresAt: "2027-01-01T00:00:00Z"},
		{ID: "e2", Kind: "misconfig", CheckID: "KSV012", Workload: wref("prod", "Deployment", "web-01"), ExpiresAt: "2027-01-01T00:00:00Z"},
	}

	v := BuildScanView(s, nil, exc, viewNow)
	// vulns: CVE-1 + CVE-2 once each for the shared image (not ×12), CVE-4
	// accepted, CVE-9 internal → 2; misconfigs: web-00, web-11 → 2;
	// secrets: web-05 → 1.
	if got, want := v.Summary.ExposedCritical, 5; got != want {
		t.Fatalf("ExposedCritical = %d, want %d", got, want)
	}
	if len(v.TopWorkloads) != 10 {
		t.Fatalf("fixture must exceed the ranked list: %d top workloads", len(v.TopWorkloads))
	}
}
