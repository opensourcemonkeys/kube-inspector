package models

// TrivyVulnerability is a single vulnerability finding surfaced to the frontend.
type TrivyVulnerability struct {
	VulnerabilityID  string   `json:"vulnerabilityID"`
	PkgName          string   `json:"pkgName"`
	InstalledVersion string   `json:"installedVersion"`
	FixedVersion     string   `json:"fixedVersion"`
	Severity         string   `json:"severity"` // CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN
	Title            string   `json:"title"`
	Description      string   `json:"description"`
	PrimaryURL       string   `json:"primaryURL"`
	References       []string `json:"references"`
	PublishedDate    string   `json:"publishedDate"`
	PkgPath          string   `json:"pkgPath"`
}

// TrivyOSInfo is the operating system Trivy detected in an image.
type TrivyOSInfo struct {
	Family string `json:"family"`
	Name   string `json:"name"`
	EOSL   bool   `json:"eosl"`
}

// TrivyTarget groups findings for one scan target (an OS layer, a language
// dependency set, etc.) within a single scanned artifact.
type TrivyTarget struct {
	Target          string               `json:"target"`
	Class           string               `json:"class"`
	Type            string               `json:"type"`
	Vulnerabilities []TrivyVulnerability `json:"vulnerabilities"`
}

// TrivyScanResult is the full result of scanning one artifact (an image or,
// for cluster scans, one of the cluster's images).
type TrivyScanResult struct {
	Kind        string         `json:"kind"`        // "image" | "cluster"
	ArtifactRef string         `json:"artifactRef"` // image name or cluster name
	Targets     []TrivyTarget  `json:"targets"`
	Summary     map[string]int `json:"summary"` // severity -> count
	ScannedAt   string         `json:"scannedAt"`
	Error       string         `json:"error"`
	OS          *TrivyOSInfo   `json:"os"`
}

// TrivyK8sMisconfigFinding is one failing KSV* check from a filesystem scan.
type TrivyK8sMisconfigFinding struct {
	ResourceKind string   `json:"resourceKind"`
	ResourceName string   `json:"resourceName"`
	Namespace    string   `json:"namespace"`
	CheckID      string   `json:"checkID"`
	Severity     string   `json:"severity"`
	Title        string   `json:"title"`
	Message      string   `json:"message"`
	Description  string   `json:"description"`
	Resolution   string   `json:"resolution"`
	PrimaryURL   string   `json:"primaryURL"`
	References   []string `json:"references"`
	Status       string   `json:"status"` // "FAIL" | "EXCEPTION"
}

// TrivyK8sSecretFinding is one detected secret in a resource's YAML.
type TrivyK8sSecretFinding struct {
	ResourceKind string `json:"resourceKind"`
	ResourceName string `json:"resourceName"`
	Namespace    string `json:"namespace"`
	RuleID       string `json:"ruleID"`
	Category     string `json:"category"`
	Severity     string `json:"severity"`
	Title        string `json:"title"`
	Match        string `json:"match"`
}

// TrivyK8sScanResult is the result of the filesystem-based misconfig+secret scan.
type TrivyK8sScanResult struct {
	ClusterName      string                     `json:"clusterName"`
	Namespace        string                     `json:"namespace"`
	Misconfigs       []TrivyK8sMisconfigFinding `json:"misconfigs"`
	Secrets          []TrivyK8sSecretFinding    `json:"secrets"`
	MisconfigSummary map[string]int             `json:"misconfigSummary"`
	SecretSummary    map[string]int             `json:"secretSummary"`
	ResourceCount    int                        `json:"resourceCount"`
	ScannedAt        string                     `json:"scannedAt"`
	Error            string                     `json:"error"`
}

// TrivyK8sImageInfo enriches a plain image string with the resource that uses it.
type TrivyK8sImageInfo struct {
	Image        string `json:"image"`
	ResourceKind string `json:"resourceKind"`
	ResourceName string `json:"resourceName"`
	Namespace    string `json:"namespace"`
}

// TrivyScanProgress is sent via Wails events during a long scan.
type TrivyScanProgress struct {
	Phase   string `json:"phase"` // "fetch" | "misconfig" | "secret"
	Current int    `json:"current"`
	Total   int    `json:"total"`
	Message string `json:"message"`
}

// TrivyWorkloadRef identifies a workload (Jobs owned by a CronJob appear as the CronJob).
type TrivyWorkloadRef struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

// TrivyWorkload is a workload with the images it runs.
type TrivyWorkload struct {
	Kind       string   `json:"kind"`
	Name       string   `json:"name"`
	Namespace  string   `json:"namespace"`
	Images     []string `json:"images"`
	Exposure   []string `json:"exposure"`
	Privileges []string `json:"privileges"`
}

// Ref returns the workload's identity.
func (w TrivyWorkload) Ref() TrivyWorkloadRef {
	return TrivyWorkloadRef{Kind: w.Kind, Name: w.Name, Namespace: w.Namespace}
}
