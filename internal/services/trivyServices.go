//go:build !tui
// +build !tui

package services_k8sclient

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"kube-ins/internal/models"

	dbTypes "github.com/aquasecurity/trivy-db/pkg/types"
	"github.com/aquasecurity/trivy/pkg/commands/artifact"
	"github.com/aquasecurity/trivy/pkg/db"
	"github.com/aquasecurity/trivy/pkg/fanal/analyzer"
	ftypes "github.com/aquasecurity/trivy/pkg/fanal/types"
	"github.com/aquasecurity/trivy/pkg/flag"
	"github.com/aquasecurity/trivy/pkg/javadb"
	"github.com/aquasecurity/trivy/pkg/types"
	"github.com/google/go-containerregistry/pkg/name"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	_ "modernc.org/sqlite" // registers the "sqlite" driver used by Trivy's RPM/Java DB
	sigsyaml "sigs.k8s.io/yaml"
)

// ListPodImages returns the distinct container images (including init and
// ephemeral containers) used by pods in the given namespace. An empty
// namespace lists across all namespaces.
func ListPodImages(client *kubernetes.Clientset, namespace string) ([]string, error) {
	pods, err := client.CoreV1().Pods(namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	set := map[string]struct{}{}
	for _, p := range pods.Items {
		for _, c := range p.Spec.InitContainers {
			set[c.Image] = struct{}{}
		}
		for _, c := range p.Spec.Containers {
			set[c.Image] = struct{}{}
		}
		for _, c := range p.Spec.EphemeralContainers {
			set[c.Image] = struct{}{}
		}
	}
	images := make([]string, 0, len(set))
	for img := range set {
		if img != "" {
			images = append(images, img)
		}
	}
	sort.Strings(images)
	return images, nil
}

// scanTimeout is generous because the first scan downloads the vulnerability DB.
const scanTimeout = 12 * time.Minute

// ScanImage scans a single container image for vulnerabilities using the Trivy
// library. cacheDir is where the vulnerability DB and layer cache are stored.
func ScanImage(ctx context.Context, imageRef, cacheDir string) (*models.TrivyScanResult, error) {
	opts := baseOptions(cacheDir)
	opts.ScanOptions.Target = imageRef

	report, err := scanContainerImage(ctx, opts)
	if err != nil {
		return nil, err
	}
	return mapReport("image", imageRef, report), nil
}

// scanContainerImage mirrors the internal artifact.run() flow but returns the
// report instead of writing it to an output sink (artifact.Run does not expose
// the report). We deliberately skip the Report step.
func scanContainerImage(ctx context.Context, opts flag.Options) (types.Report, error) {
	r, err := artifact.NewRunner(ctx, opts, artifact.TargetContainerImage)
	if err != nil {
		return types.Report{}, err
	}
	defer r.Close(ctx)

	report, err := r.ScanImage(ctx, opts)
	if err != nil {
		return types.Report{}, err
	}
	report, err = r.Filter(ctx, opts, report)
	if err != nil {
		return types.Report{}, err
	}
	return report, nil
}

// baseOptions builds a sane default flag.Options for a vulnerability scan.
func baseOptions(cacheDir string) flag.Options {
	return flag.Options{
		GlobalOptions: flag.GlobalOptions{
			CacheDir: cacheDir,
			Timeout:  scanTimeout,
			Quiet:    true,
		},
		CacheOptions: flag.CacheOptions{
			CacheBackend: "fs",
		},
		DBOptions: flag.DBOptions{
			NoProgress:         true,
			DBRepositories:     defaultDBRepos(),
			JavaDBRepositories: defaultJavaDBRepos(),
		},
		ScanOptions: flag.ScanOptions{
			Scanners: types.Scanners{types.VulnerabilityScanner},
			Parallel: 1,
		},
		// Without PkgTypes/PkgRelationships set, no packages are analyzed and
		// the scan reports zero vulnerabilities. These mirror the CLI defaults.
		PackageOptions: flag.PackageOptions{
			PkgTypes:         types.PkgTypes,
			PkgRelationships: ftypes.Relationships,
		},
		ReportOptions: flag.ReportOptions{
			Format:     types.FormatJSON,
			Severities: allSeverities(),
		},
		// "auto" lets Trivy pick the severity source per advisory; without it
		// most findings come back as UNKNOWN. Mirrors the CLI default.
		VulnerabilityOptions: flag.VulnerabilityOptions{
			VulnSeveritySources: []dbTypes.SourceID{"auto"},
		},
		ImageOptions: flag.ImageOptions{
			ImageSources: ftypes.AllImageSources,
		},
	}
}

func defaultDBRepos() []name.Reference {
	return parseRefs(db.DefaultGCRRepository, db.DefaultGHCRRepository)
}

func defaultJavaDBRepos() []name.Reference {
	return parseRefs(javadb.DefaultGCRRepository, javadb.DefaultGHCRRepository)
}

func parseRefs(repos ...string) []name.Reference {
	refs := make([]name.Reference, 0, len(repos))
	for _, r := range repos {
		ref, err := name.ParseReference(r, name.WithDefaultTag(""))
		if err == nil {
			refs = append(refs, ref)
		}
	}
	return refs
}

func allSeverities() []dbTypes.Severity {
	out := make([]dbTypes.Severity, 0, len(dbTypes.SeverityNames))
	for _, s := range dbTypes.SeverityNames {
		sev, err := dbTypes.NewSeverity(strings.ToUpper(s))
		if err == nil {
			out = append(out, sev)
		}
	}
	return out
}

// ─── K8s resource filesystem scan ────────────────────────────────────────────

// resourceRef holds an individual K8s resource and its serialised YAML.
type resourceRef struct {
	Kind      string
	Namespace string
	Name      string
	YAML      string
}

// indexFromFilename recovers the resource index from a filename written by
// ScanK8sFilesystem (e.g. "12.yaml" → 12). Files are named by index rather than
// by "Kind_namespace_name" because Trivy's secret scanner skips any file whose
// path contains tokens like "test" or "example" (it assumes test fixtures), so
// a resource in a namespace such as "trivy-test" would never be secret-scanned.
// Neutral numeric names sidestep all path-based allow rules; the caller maps the
// index back to the resource's (kind, namespace, name).
func indexFromFilename(target string) int {
	base := strings.TrimSuffix(filepath.Base(target), ".yaml")
	i, err := strconv.Atoi(base)
	if err != nil {
		return -1
	}
	return i
}

// misconfigSecretOptions builds flag.Options for a filesystem scan that only
// runs the misconfig and secret scanners. The vulnerability DB is NOT needed
// (and therefore NOT downloaded) for this scan type.
func misconfigSecretOptions(cacheDir string) flag.Options {
	return flag.Options{
		GlobalOptions: flag.GlobalOptions{
			CacheDir: cacheDir,
			Timeout:  5 * time.Minute,
			Quiet:    true,
		},
		CacheOptions: flag.CacheOptions{
			CacheBackend: "fs",
		},
		DBOptions: flag.DBOptions{
			NoProgress: true,
		},
		ScanOptions: flag.ScanOptions{
			Scanners: types.Scanners{types.MisconfigScanner, types.SecretScanner},
			Parallel: 1,
		},
		// Without MisconfigScanners set, none of the config-file analyzers
		// (Kubernetes, Dockerfile, Terraform, …) are registered, so the YAML
		// files we write are never recognised as config and the scan silently
		// returns zero findings. This mirrors the CLI default (--misconfig-scanners).
		MisconfOptions: flag.MisconfOptions{
			MisconfigScanners: analyzer.TypeConfigFiles,
		},
		ReportOptions: flag.ReportOptions{
			Format:     types.FormatJSON,
			Severities: allSeverities(),
		},
	}
}

// fetchAllResources bulk-lists 13 resource kinds and marshals each item to
// YAML. ClusterRole and ClusterRoleBinding are always cluster-scoped; all
// other kinds respect the namespace filter (empty = all namespaces).
func fetchAllResources(
	ctx context.Context,
	client *kubernetes.Clientset,
	namespace string,
	onProgress func(phase string, current, total int, msg string),
) ([]resourceRef, error) {
	const total = 13

	// client-go strips TypeMeta (apiVersion/kind) from objects returned by
	// List/Get, so the marshalled YAML has no apiVersion/kind fields. Without
	// them Trivy cannot recognise the file as a Kubernetes manifest and reports
	// zero misconfigurations. Re-inject the GVK header before scanning.
	apiVersionFor := map[string]string{
		"Deployment":    "apps/v1",
		"StatefulSet":   "apps/v1",
		"DaemonSet":     "apps/v1",
		"Job":           "batch/v1",
		"CronJob":       "batch/v1",
		"Pod":           "v1",
		"Service":       "v1",
		"ConfigMap":     "v1",
		"Ingress":       "networking.k8s.io/v1",
		"NetworkPolicy": "networking.k8s.io/v1",
		"Role":          "rbac.authorization.k8s.io/v1",
		"RoleBinding":   "rbac.authorization.k8s.io/v1",
		"ClusterRole":   "rbac.authorization.k8s.io/v1",
	}

	add := func(refs *[]resourceRef, kind, ns string, obj any) {
		y, err := sigsyaml.Marshal(obj)
		if err != nil {
			return
		}
		header := fmt.Sprintf("apiVersion: %s\nkind: %s\n", apiVersionFor[kind], kind)
		*refs = append(*refs, resourceRef{Kind: kind, Namespace: ns, YAML: header + string(y)})
	}

	var refs []resourceRef
	step := 0
	progress := func(msg string) {
		step++
		onProgress("fetch", step, total, msg)
	}

	// Deployments
	deps, err := client.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range deps.Items {
		d := &deps.Items[i]
		add(&refs, "Deployment", d.Namespace, d)
	}
	progress(fmt.Sprintf("Deployments (%d)", len(deps.Items)))

	// StatefulSets
	ssets, err := client.AppsV1().StatefulSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range ssets.Items {
		s := &ssets.Items[i]
		add(&refs, "StatefulSet", s.Namespace, s)
	}
	progress(fmt.Sprintf("StatefulSets (%d)", len(ssets.Items)))

	// DaemonSets
	dsets, err := client.AppsV1().DaemonSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range dsets.Items {
		d := &dsets.Items[i]
		add(&refs, "DaemonSet", d.Namespace, d)
	}
	progress(fmt.Sprintf("DaemonSets (%d)", len(dsets.Items)))

	// Jobs (standalone — skip those owned by a CronJob, which can accumulate
	// into the thousands and just duplicate their CronJob's pod template,
	// producing tens of thousands of redundant findings on a cluster-wide scan)
	jobs, err := client.BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	jobCount := 0
	for i := range jobs.Items {
		j := &jobs.Items[i]
		if ownedBy(j.OwnerReferences, "CronJob") {
			continue
		}
		add(&refs, "Job", j.Namespace, j)
		jobCount++
	}
	progress(fmt.Sprintf("Jobs (%d standalone)", jobCount))

	// CronJobs
	cjs, err := client.BatchV1().CronJobs(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range cjs.Items {
		c := &cjs.Items[i]
		add(&refs, "CronJob", c.Namespace, c)
	}
	progress(fmt.Sprintf("CronJobs (%d)", len(cjs.Items)))

	// Pods (standalone — skip those owned by a higher-level workload)
	pods, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	podCount := 0
	for i := range pods.Items {
		p := &pods.Items[i]
		if len(p.OwnerReferences) == 0 {
			add(&refs, "Pod", p.Namespace, p)
			podCount++
		}
	}
	progress(fmt.Sprintf("Pods (%d standalone)", podCount))

	// Services
	svcs, err := client.CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range svcs.Items {
		s := &svcs.Items[i]
		add(&refs, "Service", s.Namespace, s)
	}
	progress(fmt.Sprintf("Services (%d)", len(svcs.Items)))

	// Ingresses
	ings, err := client.NetworkingV1().Ingresses(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range ings.Items {
		ig := &ings.Items[i]
		add(&refs, "Ingress", ig.Namespace, ig)
	}
	progress(fmt.Sprintf("Ingresses (%d)", len(ings.Items)))

	// NetworkPolicies
	nps, err := client.NetworkingV1().NetworkPolicies(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range nps.Items {
		n := &nps.Items[i]
		add(&refs, "NetworkPolicy", n.Namespace, n)
	}
	progress(fmt.Sprintf("NetworkPolicies (%d)", len(nps.Items)))

	// Roles
	roles, err := client.RbacV1().Roles(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range roles.Items {
		r := &roles.Items[i]
		add(&refs, "Role", r.Namespace, r)
	}
	progress(fmt.Sprintf("Roles (%d)", len(roles.Items)))

	// RoleBindings
	rbs, err := client.RbacV1().RoleBindings(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range rbs.Items {
		rb := &rbs.Items[i]
		add(&refs, "RoleBinding", rb.Namespace, rb)
	}
	progress(fmt.Sprintf("RoleBindings (%d)", len(rbs.Items)))

	// ClusterRoles (always cluster-scoped, namespace arg is "")
	crs, err := client.RbacV1().ClusterRoles().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range crs.Items {
		cr := &crs.Items[i]
		add(&refs, "ClusterRole", "", cr)
	}
	progress(fmt.Sprintf("ClusterRoles (%d)", len(crs.Items)))

	// ConfigMaps
	cms, err := client.CoreV1().ConfigMaps(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range cms.Items {
		cm := &cms.Items[i]
		add(&refs, "ConfigMap", cm.Namespace, cm)
	}
	progress(fmt.Sprintf("ConfigMaps (%d)", len(cms.Items)))

	// Assign Name from ObjectMeta now that we have the full set
	for i := range refs {
		// Name was not set in add() because we only had the interface value;
		// parse it back from the YAML we just serialised.
		var meta struct {
			Metadata struct {
				Name string `yaml:"name"`
			} `yaml:"metadata"`
		}
		if err := sigsyaml.Unmarshal([]byte(refs[i].YAML), &meta); err == nil {
			refs[i].Name = meta.Metadata.Name
		}
	}

	return refs, nil
}

// mapK8sReport flattens a Trivy filesystem scan report into the K8s-specific DTO.
// resources must be the same slice (in the same order) that ScanK8sFilesystem
// wrote to disk, so each report target ("<index>.yaml") maps back to its
// resource metadata.
func mapK8sReport(report types.Report, clusterName, namespace string, resources []resourceRef) *models.TrivyK8sScanResult {
	res := &models.TrivyK8sScanResult{
		ClusterName:      clusterName,
		Namespace:        namespace,
		MisconfigSummary: map[string]int{},
		SecretSummary:    map[string]int{},
		ResourceCount:    len(resources),
		ScannedAt:        time.Now().Format(time.RFC3339),
	}
	for _, r := range report.Results {
		var kind, ns, name string
		if idx := indexFromFilename(r.Target); idx >= 0 && idx < len(resources) {
			kind, ns, name = resources[idx].Kind, resources[idx].Namespace, resources[idx].Name
		}

		for _, m := range r.Misconfigurations {
			if m.Status != types.MisconfStatusFailure {
				continue
			}
			res.Misconfigs = append(res.Misconfigs, models.TrivyK8sMisconfigFinding{
				ResourceKind: kind,
				ResourceName: name,
				Namespace:    ns,
				CheckID:      m.ID,
				Severity:     m.Severity,
				Title:        m.Title,
				Message:      m.Message,
				Description:  m.Description,
				Resolution:   m.Resolution,
				PrimaryURL:   m.PrimaryURL,
				References:   m.References,
				Status:       string(m.Status),
			})
			res.MisconfigSummary[m.Severity]++
		}

		for _, s := range r.Secrets {
			res.Secrets = append(res.Secrets, models.TrivyK8sSecretFinding{
				ResourceKind: kind,
				ResourceName: name,
				Namespace:    ns,
				RuleID:       s.RuleID,
				Category:     string(s.Category),
				Severity:     s.Severity,
				Title:        s.Title,
				Match:        s.Match,
			})
			res.SecretSummary[s.Severity]++
		}
	}
	return res
}

// ScanK8sFilesystem fetches Kubernetes resource YAMLs, writes them to a temp
// directory, runs Trivy's filesystem scanner for misconfigurations and secrets,
// then returns structured findings. No vulnerability DB download is needed.
func ScanK8sFilesystem(
	ctx context.Context,
	client *kubernetes.Clientset,
	clusterName, namespace, cacheDir string,
	onProgress func(phase string, current, total int, msg string),
) (*models.TrivyK8sScanResult, error) {
	tmpDir, err := os.MkdirTemp("", "kube-ins-trivy-*")
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	onProgress("fetch", 0, 13, "Fetching Kubernetes resources…")
	resources, err := fetchAllResources(ctx, client, namespace, onProgress)
	if err != nil {
		return nil, fmt.Errorf("fetch resources: %w", err)
	}

	for i, r := range resources {
		// Files are named by index, not by "Kind_namespace_name": Trivy's secret
		// scanner skips files whose path contains tokens like "test"/"example",
		// so a resource in e.g. namespace "trivy-test" would never be secret
		// scanned. mapK8sReport maps the index back to the resource metadata.
		filename := fmt.Sprintf("%d.yaml", i)
		if err := os.WriteFile(filepath.Join(tmpDir, filename), []byte(r.YAML), 0600); err != nil {
			return nil, fmt.Errorf("write %s: %w", filename, err)
		}
	}

	onProgress("misconfig", 0, 1, "Running misconfig & secret scan…")

	opts := misconfigSecretOptions(cacheDir)
	opts.ScanOptions.Target = tmpDir

	runner, err := artifact.NewRunner(ctx, opts, artifact.TargetFilesystem)
	if err != nil {
		return nil, fmt.Errorf("init trivy runner: %w", err)
	}
	defer runner.Close(ctx)

	report, err := runner.ScanFilesystem(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("trivy filesystem scan: %w", err)
	}
	report, err = runner.Filter(ctx, opts, report)
	if err != nil {
		return nil, fmt.Errorf("trivy filter: %w", err)
	}

	onProgress("misconfig", 1, 1, "Scan complete")
	return mapK8sReport(report, clusterName, namespace, resources), nil
}

// ListPodImagesWithContext returns pod images together with the top-level
// owner resource (Deployment, StatefulSet, DaemonSet, Job, CronJob, or Pod).
// Only the first image from each unique (image, ownerKind, ownerName, ns)
// combination is returned so the vulnerability tab can show resource context.
func ListPodImagesWithContext(client *kubernetes.Clientset, namespace string) ([]models.TrivyK8sImageInfo, error) {
	pods, err := client.CoreV1().Pods(namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	type key struct{ image, kind, name, ns string }
	seen := map[key]struct{}{}
	var out []models.TrivyK8sImageInfo

	for _, p := range pods.Items {
		ownerKind, ownerName := podOwner(p.OwnerReferences, p.Name)
		allContainers := make([]string, 0)
		for _, c := range p.Spec.InitContainers {
			allContainers = append(allContainers, c.Image)
		}
		for _, c := range p.Spec.Containers {
			allContainers = append(allContainers, c.Image)
		}
		for _, c := range p.Spec.EphemeralContainers {
			allContainers = append(allContainers, c.Image)
		}
		for _, img := range allContainers {
			if img == "" {
				continue
			}
			k := key{img, ownerKind, ownerName, p.Namespace}
			if _, ok := seen[k]; ok {
				continue
			}
			seen[k] = struct{}{}
			out = append(out, models.TrivyK8sImageInfo{
				Image:        img,
				ResourceKind: ownerKind,
				ResourceName: ownerName,
				Namespace:    p.Namespace,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Image < out[j].Image })
	return out, nil
}

// ownedBy reports whether any of the given OwnerReferences has the given kind.
func ownedBy(ownerRefs []metav1.OwnerReference, kind string) bool {
	for _, ref := range ownerRefs {
		if ref.Kind == kind {
			return true
		}
	}
	return false
}

// podOwner resolves the top-level owner kind and name from a pod's
// OwnerReferences. ReplicaSets are unwrapped to Deployment.
func podOwner(ownerRefs []metav1.OwnerReference, podName string) (kind, name string) {
	if len(ownerRefs) == 0 {
		return "Pod", podName
	}
	ref := ownerRefs[0]
	k := ref.Kind
	if k == "ReplicaSet" {
		// Strip the hash suffix added by the Deployment controller
		// e.g. "my-deploy-7d6c9b4f5" → "my-deploy"
		n := ref.Name
		if idx := lastHyphenIndex(n); idx >= 0 {
			n = n[:idx]
		}
		return "Deployment", n
	}
	return k, ref.Name
}

// lastHyphenIndex finds the last '-' in s that is followed by a typical
// pod-template hash (alphanumeric, 5-10 chars). Returns -1 if not found.
func lastHyphenIndex(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '-' {
			suffix := s[i+1:]
			if len(suffix) >= 5 && len(suffix) <= 10 && isAlphanumeric(suffix) {
				return i
			}
		}
	}
	return -1
}

func isAlphanumeric(s string) bool {
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

// mapReport flattens a Trivy report into the frontend DTO.
func mapReport(kind, ref string, report types.Report) *models.TrivyScanResult {
	res := &models.TrivyScanResult{
		Kind:        kind,
		ArtifactRef: ref,
		Summary:     map[string]int{},
		ScannedAt:   time.Now().Format(time.RFC3339),
	}
	for _, r := range report.Results {
		t := models.TrivyTarget{
			Target: r.Target,
			Class:  string(r.Class),
			Type:   string(r.Type),
		}
		for _, v := range r.Vulnerabilities {
			// Deprecated in favour of VendorSeverity, but it is the one value
			// Trivy resolves through VulnSeveritySources ("auto") and the only
			// one set when the DB has no detail for the ID. Reading the vendor
			// map instead would need that resolution redone here.
			severity := v.Severity //nolint:staticcheck // SA1019: see above
			published := ""
			if v.PublishedDate != nil {
				published = v.PublishedDate.Format("2006-01-02")
			}
			t.Vulnerabilities = append(t.Vulnerabilities, models.TrivyVulnerability{
				VulnerabilityID:  v.VulnerabilityID,
				PkgName:          v.PkgName,
				InstalledVersion: v.InstalledVersion,
				FixedVersion:     v.FixedVersion,
				Severity:         severity,
				Title:            v.Title,
				Description:      v.Description,
				PrimaryURL:       v.PrimaryURL,
				References:       v.References,
				PublishedDate:    published,
			})
			res.Summary[severity]++
		}
		if len(t.Vulnerabilities) > 0 {
			res.Targets = append(res.Targets, t)
		}
	}
	return res
}
