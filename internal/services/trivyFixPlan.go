package services_k8sclient

import (
	"sort"
	"strings"

	"kube-ins/internal/models"
)

// fixAcc accumulates one fix-plan item while findings are grouped.
type fixAcc struct {
	item      models.TrivyFixItem
	vulnIDs   map[string]struct{}
	images    map[string]struct{}
	workloads map[models.TrivyWorkloadRef]struct{}
	fixed     map[string]struct{}
}

func newFixAcc(item models.TrivyFixItem) *fixAcc {
	item.Closes = map[string]int{}
	return &fixAcc{item: item, vulnIDs: map[string]struct{}{}, images: map[string]struct{}{},
		workloads: map[models.TrivyWorkloadRef]struct{}{}, fixed: map[string]struct{}{}}
}

// BuildFixPlan groups the scan's unaccepted findings into actions:
//   - a fixable finding in the os-pkgs class of an image whose OS is known
//     becomes that image's "baseOS" item (rebuild on a newer base);
//   - any other fixable finding is grouped by (package, installed version)
//     into a "package" item, across images;
//   - misconfigurations are grouped by normalized check ID into "misconfig".
//
// Findings with no fixed version are not in the plan; their number is
// returned as unfixable. Items are ordered by CRITICAL closed ↓, HIGH closed ↓,
// exposed workloads affected ↓, ID ↑.
func BuildFixPlan(cur *models.TrivyClusterScan, accepted func(models.TrivyVulnRow) bool, acceptedMis func(models.TrivyMisconfigRow) bool) ([]models.TrivyFixItem, int) {
	items := map[string]*fixAcc{}
	unfixable := 0

	eachFinding(cur.ImageTargets, cur.Images, func(img models.TrivyImageCoverage, t models.TrivyTarget, v models.TrivyVulnerability) {
		row := models.TrivyVulnRow{Image: img.Image, Target: t.Target, Class: t.Class,
			VulnerabilityID: v.VulnerabilityID, PkgName: v.PkgName, PkgPath: v.PkgPath,
			InstalledVersion: v.InstalledVersion, FixedVersion: v.FixedVersion, Severity: normSeverity(v.Severity)}
		if accepted != nil && accepted(row) {
			return
		}
		fixed := splitFixedVersions(v.FixedVersion)
		if len(fixed) == 0 {
			unfixable++
			return
		}
		var id string
		var mk func() models.TrivyFixItem
		if t.Class == "os-pkgs" && img.OS != nil {
			id = "os:" + img.Image
			osInfo := *img.OS
			mk = func() models.TrivyFixItem {
				return models.TrivyFixItem{ID: id, Kind: "baseOS", Image: img.Image, OS: &osInfo}
			}
		} else {
			id = "pkg:" + v.PkgName + "@" + v.InstalledVersion
			mk = func() models.TrivyFixItem {
				return models.TrivyFixItem{ID: id, Kind: "package", Package: v.PkgName, InstalledVersion: v.InstalledVersion}
			}
		}
		acc := items[id]
		if acc == nil {
			acc = newFixAcc(mk())
			items[id] = acc
		}
		acc.item.Closes[row.Severity]++
		acc.vulnIDs[v.VulnerabilityID] = struct{}{}
		acc.images[img.Image] = struct{}{}
		for _, w := range img.Workloads {
			acc.workloads[w] = struct{}{}
		}
		if acc.item.Kind == "package" {
			for _, f := range fixed {
				acc.fixed[f] = struct{}{}
			}
		}
	})

	// Rows come sorted (severity ↓, key ↑), so the item's CheckID is that of
	// its worst row; Title and Resolution come from the first row that has one.
	for _, r := range misconfigRows(cur, nil, func(string, string) bool { return false }) {
		if acceptedMis != nil && acceptedMis(r) {
			continue
		}
		id := "check:" + NormalizeCheckID(r.CheckID)
		acc := items[id]
		if acc == nil {
			acc = newFixAcc(models.TrivyFixItem{ID: id, Kind: "misconfig", CheckID: r.CheckID})
			items[id] = acc
		}
		if acc.item.Title == "" {
			acc.item.Title = r.Title
		}
		if acc.item.Resolution == "" {
			acc.item.Resolution = r.Resolution
		}
		acc.item.Closes[r.Severity]++
		acc.workloads[models.TrivyWorkloadRef{Kind: r.ResourceKind, Name: r.ResourceName, Namespace: r.Namespace}] = struct{}{}
	}

	exposed := map[models.TrivyWorkloadRef]bool{}
	for _, w := range cur.Workloads {
		if len(w.Exposure) > 0 {
			exposed[w.Ref()] = true
		}
	}

	plan := make([]models.TrivyFixItem, 0, len(items))
	for _, acc := range items {
		it := acc.item
		it.VulnIDs = sortedSet(acc.vulnIDs)
		it.Images = sortedSet(acc.images)
		it.Workloads = make([]models.TrivyWorkloadRef, 0, len(acc.workloads))
		for w := range acc.workloads {
			it.Workloads = append(it.Workloads, w)
			if exposed[w] {
				it.ExposedWorkloads++
			}
		}
		sortRefs(it.Workloads)
		it.FixedVersions = make([]string, 0, len(acc.fixed))
		for f := range acc.fixed {
			it.FixedVersions = append(it.FixedVersions, f)
		}
		sort.Slice(it.FixedVersions, func(i, j int) bool { return lessVersion(it.FixedVersions[i], it.FixedVersions[j]) })
		if n := len(it.FixedVersions); n > 0 {
			it.FixedVersion = it.FixedVersions[n-1]
		}
		for sev := range it.Closes {
			if it.Severity == "" || severityRank(sev) > severityRank(it.Severity) {
				it.Severity = sev
			}
		}
		plan = append(plan, it)
	}
	sort.Slice(plan, func(i, j int) bool {
		a, b := plan[i], plan[j]
		if a.Closes["CRITICAL"] != b.Closes["CRITICAL"] {
			return a.Closes["CRITICAL"] > b.Closes["CRITICAL"]
		}
		if a.Closes["HIGH"] != b.Closes["HIGH"] {
			return a.Closes["HIGH"] > b.Closes["HIGH"]
		}
		if a.ExposedWorkloads != b.ExposedWorkloads {
			return a.ExposedWorkloads > b.ExposedWorkloads
		}
		return a.ID < b.ID
	})
	return plan, unfixable
}

func sortedSet(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// splitFixedVersions splits Trivy's "0.30.0, 0.33.0" into its versions.
func splitFixedVersions(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// lessVersion orders by compareVersions, falling back to the string so
// versions that compare equal ("1.0" and "1-0") still sort deterministically.
func lessVersion(a, b string) bool {
	if c := compareVersions(a, b); c != 0 {
		return c < 0
	}
	return a < b
}

// compareVersions compares two version strings segment by segment. Segments
// are split on '.', '-', '+' and '_'; two numeric segments compare as numbers,
// anything else compares as text. On a common prefix the version with more
// segments is higher.
func compareVersions(a, b string) int {
	sep := func(r rune) bool { return r == '.' || r == '-' || r == '+' || r == '_' }
	as, bs := strings.FieldsFunc(a, sep), strings.FieldsFunc(b, sep)
	for i := 0; i < len(as) && i < len(bs); i++ {
		if c := compareSegment(as[i], bs[i]); c != 0 {
			return c
		}
	}
	switch {
	case len(as) < len(bs):
		return -1
	case len(as) > len(bs):
		return 1
	}
	return 0
}

func compareSegment(a, b string) int {
	if isDigits(a) && isDigits(b) {
		// Compare as numbers without parsing, so arbitrarily long ones work.
		a, b = trimZeros(a), trimZeros(b)
		if len(a) != len(b) {
			if len(a) < len(b) {
				return -1
			}
			return 1
		}
	}
	return strings.Compare(a, b)
}

func isDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

func trimZeros(s string) string {
	t := strings.TrimLeft(s, "0")
	if t == "" {
		return "0"
	}
	return t
}
