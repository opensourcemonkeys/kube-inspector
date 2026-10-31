package services_k8sclient

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"kube-ins/internal/models"

	"github.com/google/go-containerregistry/pkg/name"
)

// This file computes the scan view (BuildScanView) from a saved scan: the
// summary, finding rows, comparison and exceptions. The fix plan is in
// trivyFixPlan.go. Everything here is pure; no cluster access.
//
// A vulnerability *finding* is a distinct (image, VulnerabilityID, PkgName,
// PkgPath) over the images that were scanned (eachFinding). Counts and the fix
// plan count findings; table rows and the comparison are kept per workload.

// eachFinding calls fn once per vulnerability finding of the scanned images,
// in image order then target order. Targets of images that failed, or that are
// not in the coverage list, are ignored.
func eachFinding(targets map[string][]models.TrivyTarget, images []models.TrivyImageCoverage, fn func(img models.TrivyImageCoverage, t models.TrivyTarget, v models.TrivyVulnerability)) {
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
				fn(img, t, v)
			}
		}
	}
}

// VulnSeverityCounts counts vulnerability findings by severity over the images
// that were scanned. The same CVE reported by two targets of one image counts
// once, the same CVE in another image or another pkgPath counts again.
// Severity is upper-cased; an empty one is "UNKNOWN".
func VulnSeverityCounts(targets map[string][]models.TrivyTarget, images []models.TrivyImageCoverage) map[string]int {
	counts := map[string]int{}
	eachFinding(targets, images, func(_ models.TrivyImageCoverage, _ models.TrivyTarget, v models.TrivyVulnerability) {
		counts[normSeverity(v.Severity)]++
	})
	return counts
}

func normSeverity(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	if s == "" {
		return "UNKNOWN"
	}
	return s
}

// severityRank orders severities; unknown values rank lowest.
func severityRank(s string) int {
	switch normSeverity(s) {
	case "CRITICAL":
		return 4
	case "HIGH":
		return 3
	case "MEDIUM":
		return 2
	case "LOW":
		return 1
	}
	return 0
}

// ImageRepo is an image reference without its tag or digest, the scope a
// vulnerability is accepted for: "nginx:1.27" → "index.docker.io/library/nginx".
func ImageRepo(image string) string {
	if ref, err := name.ParseReference(image, name.WeakValidation); err == nil {
		return ref.Context().Name()
	}
	s := image
	if i := strings.Index(s, "@"); i >= 0 {
		s = s[:i]
	}
	if i := strings.LastIndex(s, ":"); i > strings.LastIndex(s, "/") {
		s = s[:i]
	}
	return s
}

func workloadKey(r models.TrivyWorkloadRef) string {
	return r.Namespace + "/" + r.Kind + "/" + r.Name
}

func lessRef(a, b models.TrivyWorkloadRef) bool {
	if a.Namespace != b.Namespace {
		return a.Namespace < b.Namespace
	}
	if a.Kind != b.Kind {
		return a.Kind < b.Kind
	}
	return a.Name < b.Name
}

func sortRefs(refs []models.TrivyWorkloadRef) {
	sort.Slice(refs, func(i, j int) bool { return lessRef(refs[i], refs[j]) })
}

// Comparison keys (global constraints): vuln ns/kind/name|CVE|pkg|pkgPath,
// misconfig ns/kind/name|normalized checkID, secret ns/kind/name|ruleID.
func vulnDiffKey(w models.TrivyWorkloadRef, v models.TrivyVulnerability) string {
	return workloadKey(w) + "|" + v.VulnerabilityID + "|" + v.PkgName + "|" + v.PkgPath
}

func misconfigRef(m models.TrivyK8sMisconfigFinding) models.TrivyWorkloadRef {
	return models.TrivyWorkloadRef{Kind: m.ResourceKind, Name: m.ResourceName, Namespace: m.Namespace}
}

func misconfigDiffKey(m models.TrivyK8sMisconfigFinding) string {
	return workloadKey(misconfigRef(m)) + "|" + NormalizeCheckID(m.CheckID)
}

func secretRef(s models.TrivyK8sSecretFinding) models.TrivyWorkloadRef {
	return models.TrivyWorkloadRef{Kind: s.ResourceKind, Name: s.ResourceName, Namespace: s.Namespace}
}

func secretDiffKey(s models.TrivyK8sSecretFinding) string {
	return workloadKey(secretRef(s)) + "|" + s.RuleID
}

// imageWorkloads is the workloads an image's findings are attributed to. An
// image without any (a synthetic single-image scan) gets one empty ref so its
// findings still produce rows.
func imageWorkloads(img models.TrivyImageCoverage) []models.TrivyWorkloadRef {
	if len(img.Workloads) == 0 {
		return []models.TrivyWorkloadRef{{}}
	}
	return img.Workloads
}

// ---- exceptions ----

type exceptionSet struct {
	list    []models.TrivyException
	expired []bool
	repo    []string
	check   []string
	repoOf  map[string]string // image → ImageRepo cache
}

func newExceptionSet(exc []models.TrivyException, now time.Time) *exceptionSet {
	s := &exceptionSet{list: exc, repoOf: map[string]string{}}
	for _, e := range exc {
		t, err := time.Parse(time.RFC3339, e.ExpiresAt)
		s.expired = append(s.expired, err != nil || !t.After(now))
		repo := ""
		if e.ImageRepo != "" {
			repo = ImageRepo(e.ImageRepo)
		}
		s.repo = append(s.repo, repo)
		s.check = append(s.check, NormalizeCheckID(e.CheckID))
	}
	return s
}

func (s *exceptionSet) imageRepo(image string) string {
	r, ok := s.repoOf[image]
	if !ok {
		r = ImageRepo(image)
		s.repoOf[image] = r
	}
	return r
}

// vulnMatches returns the indexes of the exceptions, expired or not, that
// cover a vulnerability in an image. Both sides go through ImageRepo, so an
// exception matches whatever tag or digest it was created from.
func (s *exceptionSet) vulnMatches(id, image string) []int {
	var out []int
	for i, e := range s.list {
		if e.Kind == "vuln" && e.VulnerabilityID == id && s.repo[i] != "" && s.repo[i] == s.imageRepo(image) {
			out = append(out, i)
		}
	}
	return out
}

func (s *exceptionSet) misconfigMatches(checkID string, w models.TrivyWorkloadRef) []int {
	var out []int
	norm := NormalizeCheckID(checkID)
	for i, e := range s.list {
		if e.Kind == "misconfig" && s.check[i] == norm && e.Workload == w {
			out = append(out, i)
		}
	}
	return out
}

// accepts reports whether any of the matched exceptions is still in force.
func (s *exceptionSet) accepts(idx []int) bool {
	for _, i := range idx {
		if !s.expired[i] {
			return true
		}
	}
	return false
}

func (s *exceptionSet) acceptVuln(r models.TrivyVulnRow) bool {
	return s.accepts(s.vulnMatches(r.VulnerabilityID, r.Image))
}

func (s *exceptionSet) acceptMisconfig(r models.TrivyMisconfigRow) bool {
	return s.accepts(s.misconfigMatches(r.CheckID, models.TrivyWorkloadRef{Kind: r.ResourceKind, Name: r.ResourceName, Namespace: r.Namespace}))
}

// ---- rows ----

func vulnRows(scan *models.TrivyClusterScan, accepted func(models.TrivyVulnRow) bool, isNew func(kind, key string) bool) []models.TrivyVulnRow {
	rows := []models.TrivyVulnRow{}
	seen := map[string]struct{}{}
	repos := map[string]string{}
	eachFinding(scan.ImageTargets, scan.Images, func(img models.TrivyImageCoverage, t models.TrivyTarget, v models.TrivyVulnerability) {
		for _, w := range imageWorkloads(img) {
			diffKey := vulnDiffKey(w, v)
			key := diffKey + "|" + img.Image
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			repo, ok := repos[img.Image]
			if !ok {
				repo = ImageRepo(img.Image)
				repos[img.Image] = repo
			}
			r := models.TrivyVulnRow{
				Key: key, Workload: w, Image: img.Image, ImageRepo: repo,
				Target: t.Target, Class: t.Class,
				VulnerabilityID: v.VulnerabilityID, PkgName: v.PkgName, PkgPath: v.PkgPath,
				InstalledVersion: v.InstalledVersion, FixedVersion: v.FixedVersion,
				Severity: normSeverity(v.Severity), Title: v.Title, Description: v.Description,
				PrimaryURL: v.PrimaryURL, PublishedDate: v.PublishedDate, References: v.References,
				IsNew: isNew("vuln", diffKey),
			}
			r.Accepted = accepted(r)
			rows = append(rows, r)
		}
	})
	sort.SliceStable(rows, func(i, j int) bool {
		if a, b := severityRank(rows[i].Severity), severityRank(rows[j].Severity); a != b {
			return a > b
		}
		return rows[i].Key < rows[j].Key
	})
	return rows
}

// misconfigRows keys rows by their comparison key; the rare duplicates (one
// check failing for two containers of a workload) get a "#n" suffix so the key
// stays unique for the table.
func misconfigRows(scan *models.TrivyClusterScan, accepted func(models.TrivyMisconfigRow) bool, isNew func(kind, key string) bool) []models.TrivyMisconfigRow {
	rows := make([]models.TrivyMisconfigRow, 0, len(scan.Misconfigs))
	for _, m := range scan.Misconfigs {
		key := misconfigDiffKey(m)
		r := models.TrivyMisconfigRow{
			Key: key, ResourceKind: m.ResourceKind, ResourceName: m.ResourceName, Namespace: m.Namespace,
			CheckID: m.CheckID, Severity: normSeverity(m.Severity), Title: m.Title, Message: m.Message,
			Description: m.Description, Resolution: m.Resolution, PrimaryURL: m.PrimaryURL,
			References: m.References, Status: m.Status, IsNew: isNew("misconfig", key),
		}
		if accepted != nil {
			r.Accepted = accepted(r)
		}
		rows = append(rows, r)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if a, b := severityRank(rows[i].Severity), severityRank(rows[j].Severity); a != b {
			return a > b
		}
		if rows[i].Key != rows[j].Key {
			return rows[i].Key < rows[j].Key
		}
		return rows[i].Message < rows[j].Message
	})
	uniqueKeys(len(rows), func(i int) *string { return &rows[i].Key })
	return rows
}

func secretRows(scan *models.TrivyClusterScan, isNew func(kind, key string) bool) []models.TrivySecretRow {
	rows := make([]models.TrivySecretRow, 0, len(scan.Secrets))
	for _, s := range scan.Secrets {
		key := secretDiffKey(s)
		rows = append(rows, models.TrivySecretRow{
			Key: key, ResourceKind: s.ResourceKind, ResourceName: s.ResourceName, Namespace: s.Namespace,
			RuleID: s.RuleID, Category: s.Category, Severity: normSeverity(s.Severity), Title: s.Title,
			Match: s.Match, IsNew: isNew("secret", key),
		})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if a, b := severityRank(rows[i].Severity), severityRank(rows[j].Severity); a != b {
			return a > b
		}
		if rows[i].Key != rows[j].Key {
			return rows[i].Key < rows[j].Key
		}
		return rows[i].Match < rows[j].Match
	})
	uniqueKeys(len(rows), func(i int) *string { return &rows[i].Key })
	return rows
}

func uniqueKeys(n int, key func(int) *string) {
	count := map[string]int{}
	for i := 0; i < n; i++ {
		k := key(i)
		count[*k]++
		if c := count[*k]; c > 1 {
			*k = *k + "#" + strconv.Itoa(c)
		}
	}
}

// ---- comparison ----

// scanBlindSpots is what a scan could not see: the images it failed on and the
// workloads running one of them. A workload whose image failed is blind as a
// whole, because a vulnerability's key names the workload, not the image — a
// workload that moved from a scanned image to one that failed would otherwise
// "close" everything the old image had.
type scanBlindSpots struct {
	images    map[string]bool
	workloads map[models.TrivyWorkloadRef]bool
}

func blindSpots(s *models.TrivyClusterScan) scanBlindSpots {
	b := scanBlindSpots{images: map[string]bool{}, workloads: map[models.TrivyWorkloadRef]bool{}}
	for _, img := range s.Images {
		if img.Status == "scanned" {
			continue
		}
		b.images[img.Image] = true
		for _, w := range img.Workloads {
			if w != (models.TrivyWorkloadRef{}) {
				b.workloads[w] = true
			}
		}
	}
	return b
}

// DiffScans lists the findings that appeared in cur and disappeared from prev,
// by the comparison keys, plus the workloads cur has and prev did not.
// A finding is not reported against a scan that could not have seen it: a
// vulnerability of an image that failed in the other scan or of a workload
// whose image failed there, or a misconfig or secret when the other scan's
// misconfiguration scan failed.
func DiffScans(cur, prev *models.TrivyClusterScan) models.TrivyChanges {
	curC, prevC := changeSet(cur), changeSet(prev)
	curBlind, prevBlind := blindSpots(cur), blindSpots(prev)
	visible := func(c change, other scanBlindSpots, misconfigError string) bool {
		if c.Kind == "vuln" {
			return !other.images[c.image] && !other.workloads[c.Workload]
		}
		return misconfigError == ""
	}
	out := models.TrivyChanges{New: []models.TrivyChange{}, Closed: []models.TrivyChange{}, NewWorkloads: []models.TrivyWorkloadRef{}}
	for k, c := range curC {
		if _, ok := prevC[k]; !ok && visible(c, prevBlind, prev.MisconfigError) {
			out.New = append(out.New, c.TrivyChange)
		}
	}
	for k, c := range prevC {
		if _, ok := curC[k]; !ok && visible(c, curBlind, cur.MisconfigError) {
			out.Closed = append(out.Closed, c.TrivyChange)
		}
	}
	sortChanges(out.New)
	sortChanges(out.Closed)
	had := map[models.TrivyWorkloadRef]bool{}
	for _, w := range prev.Workloads {
		had[w.Ref()] = true
	}
	for _, w := range cur.Workloads {
		if !had[w.Ref()] {
			out.NewWorkloads = append(out.NewWorkloads, w.Ref())
			had[w.Ref()] = true
		}
	}
	sortRefs(out.NewWorkloads)
	return out
}

type change struct {
	models.TrivyChange
	image string // vulns only: the image the finding was first seen in
}

// changeSet maps kind+key to the first finding with that key.
func changeSet(s *models.TrivyClusterScan) map[string]change {
	out := map[string]change{}
	add := func(c change) {
		k := c.Kind + "\x00" + c.Key
		if _, ok := out[k]; !ok {
			out[k] = c
		}
	}
	eachFinding(s.ImageTargets, s.Images, func(img models.TrivyImageCoverage, _ models.TrivyTarget, v models.TrivyVulnerability) {
		for _, w := range imageWorkloads(img) {
			add(change{TrivyChange: models.TrivyChange{Kind: "vuln", Key: vulnDiffKey(w, v), ID: v.VulnerabilityID,
				Severity: normSeverity(v.Severity), Title: v.Title, Workload: w}, image: img.Image})
		}
	})
	for _, m := range s.Misconfigs {
		add(change{TrivyChange: models.TrivyChange{Kind: "misconfig", Key: misconfigDiffKey(m), ID: m.CheckID,
			Severity: normSeverity(m.Severity), Title: m.Title, Workload: misconfigRef(m)}})
	}
	for _, sec := range s.Secrets {
		add(change{TrivyChange: models.TrivyChange{Kind: "secret", Key: secretDiffKey(sec), ID: sec.RuleID,
			Severity: normSeverity(sec.Severity), Title: sec.Title, Workload: secretRef(sec)}})
	}
	return out
}

var changeKindOrder = map[string]int{"vuln": 0, "misconfig": 1, "secret": 2}

func sortChanges(cs []models.TrivyChange) {
	sort.Slice(cs, func(i, j int) bool {
		if a, b := changeKindOrder[cs[i].Kind], changeKindOrder[cs[j].Kind]; a != b {
			return a < b
		}
		return cs[i].Key < cs[j].Key
	})
}

// ---- summary ----

type severityCounts struct {
	vulns, misconfigs, secrets map[string]int
	critHigh, critHighFixable  int
}

// countBasis limits countScan to what two scans can both see; the zero value
// counts everything.
type countBasis struct {
	skipImage      func(image string) bool
	skipK8sResults bool // misconfigs and secrets
}

func countScan(s *models.TrivyClusterScan, ex *exceptionSet, basis countBasis) severityCounts {
	c := severityCounts{vulns: map[string]int{}, misconfigs: map[string]int{}, secrets: map[string]int{}}
	eachFinding(s.ImageTargets, s.Images, func(img models.TrivyImageCoverage, _ models.TrivyTarget, v models.TrivyVulnerability) {
		if basis.skipImage != nil && basis.skipImage(img.Image) {
			return
		}
		if ex.accepts(ex.vulnMatches(v.VulnerabilityID, img.Image)) {
			return
		}
		sev := normSeverity(v.Severity)
		c.vulns[sev]++
		if sev == "CRITICAL" || sev == "HIGH" {
			c.critHigh++
			if strings.TrimSpace(v.FixedVersion) != "" {
				c.critHighFixable++
			}
		}
	})
	if basis.skipK8sResults {
		return c
	}
	for _, m := range s.Misconfigs {
		if !ex.accepts(ex.misconfigMatches(m.CheckID, misconfigRef(m))) {
			c.misconfigs[normSeverity(m.Severity)]++
		}
	}
	for _, sec := range s.Secrets {
		c.secrets[normSeverity(sec.Severity)]++
	}
	return c
}

// deltaBasis is what the summary's change figures may count so they agree
// with DiffScans: an image is compared only if neither scan failed on it and
// no workload running it (in either scan) is blind in either scan, and
// misconfigs and secrets only if neither misconfig scan failed. An image that
// only one scan has is a change of the cluster and is counted.
//
// The exclusion is symmetric — the same images drop out of both sides — so a
// coverage difference never shows up as a rise or a fall.
func deltaBasis(cur, prev *models.TrivyClusterScan) countBasis {
	curBlind, prevBlind := blindSpots(cur), blindSpots(prev)
	skip := map[string]bool{}
	for _, s := range []*models.TrivyClusterScan{cur, prev} {
		for _, img := range s.Images {
			if curBlind.images[img.Image] || prevBlind.images[img.Image] {
				skip[img.Image] = true
				continue
			}
			for _, w := range img.Workloads {
				if curBlind.workloads[w] || prevBlind.workloads[w] {
					skip[img.Image] = true
					break
				}
			}
		}
	}
	return countBasis{
		skipImage:      func(image string) bool { return skip[image] },
		skipK8sResults: cur.MisconfigError != "" || prev.MisconfigError != "",
	}
}

// summaryDelta is severity → (cur − prev) over deltaBasis, all three kinds of
// finding together, with a 0 entry for every severity either side has.
func summaryDelta(cur, prev *models.TrivyClusterScan, ex *exceptionSet) map[string]int {
	basis := deltaBasis(cur, prev)
	c, p := countScan(cur, ex, basis), countScan(prev, ex, basis)
	out := map[string]int{}
	for _, m := range []map[string]int{c.vulns, c.misconfigs, c.secrets} {
		for sev, n := range m {
			out[sev] += n
		}
	}
	for _, m := range []map[string]int{p.vulns, p.misconfigs, p.secrets} {
		for sev, n := range m {
			out[sev] -= n
		}
	}
	return out
}

// exposedCritical counts the unaccepted CRITICAL findings that touch an
// exposed workload: each distinct vulnerability finding (eachFinding) once if
// any workload running its image is exposed, plus misconfig and secret rows
// on exposed workloads. Exposure comes from every workload, not the ranked
// top list.
func exposedCritical(s *models.TrivyClusterScan, ex *exceptionSet) int {
	exposed := map[models.TrivyWorkloadRef]bool{}
	for _, w := range s.Workloads {
		if len(w.Exposure) > 0 {
			exposed[w.Ref()] = true
		}
	}
	if len(exposed) == 0 {
		return 0
	}
	n := 0
	eachFinding(s.ImageTargets, s.Images, func(img models.TrivyImageCoverage, _ models.TrivyTarget, v models.TrivyVulnerability) {
		if normSeverity(v.Severity) != "CRITICAL" || ex.accepts(ex.vulnMatches(v.VulnerabilityID, img.Image)) {
			return
		}
		for _, w := range img.Workloads {
			if exposed[w] {
				n++
				return
			}
		}
	})
	for _, m := range s.Misconfigs {
		ref := misconfigRef(m)
		if normSeverity(m.Severity) == "CRITICAL" && exposed[ref] && !ex.accepts(ex.misconfigMatches(m.CheckID, ref)) {
			n++
		}
	}
	for _, sec := range s.Secrets {
		if normSeverity(sec.Severity) == "CRITICAL" && exposed[secretRef(sec)] {
			n++
		}
	}
	return n
}

// ---- view ----

const topWorkloadLimit = 10

// BuildScanView computes everything the scan screen and the report show.
// prev may be nil (no comparison). Exceptions are judged against now; an
// expired one accepts nothing and is flagged Expired. The same exceptions
// apply to prev, so a delta reflects the cluster, not an acceptance.
func BuildScanView(cur, prev *models.TrivyClusterScan, exc []models.TrivyException, now time.Time) models.TrivyScanView {
	ex := newExceptionSet(exc, now)
	v := models.TrivyScanView{
		ScanID: cur.ID, ClusterName: cur.ClusterName, Scope: cur.Scope,
		StartedAt: cur.StartedAt, FinishedAt: cur.FinishedAt,
		AppVersion: cur.AppVersion, TrivyVersion: cur.TrivyVersion, DBUpdatedAt: cur.DBUpdatedAt,
		APIServer: cur.APIServer, ServerVersion: cur.ServerVersion, MisconfigError: cur.MisconfigError,
		ResourceCount: cur.ResourceCount, ExposureKnown: cur.SchemaVersion >= 2 && cur.ExposureError == "",
		ExposureError: cur.ExposureError,
	}

	newKeys := map[string]struct{}{}
	if prev != nil {
		d := DiffScans(cur, prev)
		v.Changes = &d
		v.CompareID, v.CompareStartedAt = prev.ID, prev.StartedAt
		for _, c := range d.New {
			newKeys[c.Kind+"\x00"+c.Key] = struct{}{}
		}
	}
	isNew := func(kind, key string) bool {
		_, ok := newKeys[kind+"\x00"+key]
		return ok
	}

	v.Vulns = vulnRows(cur, ex.acceptVuln, isNew)
	v.Misconfigs = misconfigRows(cur, ex.acceptMisconfig, isNew)
	v.Secrets = secretRows(cur, isNew)

	c := countScan(cur, ex, countBasis{})
	v.Summary = models.TrivySummary{Vulns: c.vulns, Misconfigs: c.misconfigs, Secrets: c.secrets, FixableRatio: -1}
	if c.critHigh > 0 {
		v.Summary.FixableRatio = float64(c.critHighFixable) / float64(c.critHigh)
	}
	for _, img := range cur.Images {
		v.Summary.ImagesTotal++
		if img.Status == "scanned" {
			v.Summary.ImagesScanned++
		}
	}
	v.Summary.ExposedCritical = exposedCritical(cur, ex)
	if prev != nil {
		v.Summary.Delta = summaryDelta(cur, prev, ex)
	}

	v.TopWorkloads = topWorkloads(cur, v.Vulns)
	v.FixPlan, v.UnfixableCount = BuildFixPlan(cur, ex.acceptVuln, ex.acceptMisconfig)

	v.Coverage = append([]models.TrivyImageCoverage{}, cur.Images...)
	sort.SliceStable(v.Coverage, func(i, j int) bool { return v.Coverage[i].Image < v.Coverage[j].Image })

	v.Exceptions = exceptionStates(cur, ex)
	return v
}

// exceptionStates reports each exception with how many findings (vulns) or
// rows (misconfigs) of cur it matches, whether or not it has expired.
func exceptionStates(cur *models.TrivyClusterScan, ex *exceptionSet) []models.TrivyExceptionState {
	matches := make([]int, len(ex.list))
	eachFinding(cur.ImageTargets, cur.Images, func(img models.TrivyImageCoverage, _ models.TrivyTarget, v models.TrivyVulnerability) {
		for _, i := range ex.vulnMatches(v.VulnerabilityID, img.Image) {
			matches[i]++
		}
	})
	for _, m := range cur.Misconfigs {
		for _, i := range ex.misconfigMatches(m.CheckID, misconfigRef(m)) {
			matches[i]++
		}
	}
	out := make([]models.TrivyExceptionState, 0, len(ex.list))
	for i, e := range ex.list {
		out = append(out, models.TrivyExceptionState{Exception: e, Expired: ex.expired[i], Matches: matches[i]})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i].Exception, out[j].Exception
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt < b.CreatedAt
		}
		return a.ID < b.ID
	})
	return out
}

// topWorkloads ranks workloads: exposed first, then CRITICAL ↓, HIGH ↓,
// privileged first. Counts are the workload's unaccepted vulnerability rows.
// A workload with no finding and no privilege is left out.
func topWorkloads(cur *models.TrivyClusterScan, rows []models.TrivyVulnRow) []models.TrivyWorkloadRisk {
	counts := map[models.TrivyWorkloadRef]map[string]int{}
	for _, r := range rows {
		if r.Accepted {
			continue
		}
		if counts[r.Workload] == nil {
			counts[r.Workload] = map[string]int{}
		}
		counts[r.Workload][r.Severity]++
	}
	out := []models.TrivyWorkloadRisk{}
	seen := map[models.TrivyWorkloadRef]bool{}
	for _, w := range cur.Workloads {
		ref := w.Ref()
		if seen[ref] {
			continue
		}
		seen[ref] = true
		c := counts[ref]
		if len(c) == 0 && len(w.Privileges) == 0 {
			continue
		}
		if c == nil {
			c = map[string]int{}
		}
		out = append(out, models.TrivyWorkloadRisk{Workload: ref, Exposure: w.Exposure, Privileges: w.Privileges, Counts: c})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if ea, eb := len(a.Exposure) > 0, len(b.Exposure) > 0; ea != eb {
			return ea
		}
		if a.Counts["CRITICAL"] != b.Counts["CRITICAL"] {
			return a.Counts["CRITICAL"] > b.Counts["CRITICAL"]
		}
		if a.Counts["HIGH"] != b.Counts["HIGH"] {
			return a.Counts["HIGH"] > b.Counts["HIGH"]
		}
		if pa, pb := len(a.Privileges) > 0, len(b.Privileges) > 0; pa != pb {
			return pa
		}
		return lessRef(a.Workload, b.Workload)
	})
	if len(out) > topWorkloadLimit {
		out = out[:topWorkloadLimit]
	}
	return out
}
