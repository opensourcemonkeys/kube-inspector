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
	Phase   string `json:"phase"` // cluster scan: "targets" | "misconfig" | "images" | "waitingCache" | "enrich" | "saving" | "stopping"; legacy k8s scan: "fetch" | "misconfig"
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

// TrivyScanSchemaVersion is the on-disk version of a saved TrivyClusterScan.
const TrivyScanSchemaVersion = 1

// TrivyImageCoverage records whether one image was scanned and, if not, why.
type TrivyImageCoverage struct {
	Image      string             `json:"image"`
	Workloads  []TrivyWorkloadRef `json:"workloads"`
	Status     string             `json:"status"` // "scanned" | "failed"
	Reason     string             `json:"reason"` // empty when scanned
	Message    string             `json:"message"`
	PullSecret string             `json:"pullSecret"` // "ns/name"
	OS         *TrivyOSInfo       `json:"os"`
}

// TrivyClusterScan is one complete, persisted cluster scan.
type TrivyClusterScan struct {
	SchemaVersion  int                        `json:"schemaVersion"`
	ID             string                     `json:"id"`
	ClusterName    string                     `json:"clusterName"`
	Scope          string                     `json:"scope"`
	StartedAt      string                     `json:"startedAt"`
	FinishedAt     string                     `json:"finishedAt"`
	AppVersion     string                     `json:"appVersion"`
	TrivyVersion   string                     `json:"trivyVersion"`
	DBUpdatedAt    string                     `json:"dbUpdatedAt"`
	APIServer      string                     `json:"apiServer"`
	ServerVersion  string                     `json:"serverVersion"`
	Images         []TrivyImageCoverage       `json:"images"`
	ImageTargets   map[string][]TrivyTarget   `json:"imageTargets"`
	Misconfigs     []TrivyK8sMisconfigFinding `json:"misconfigs"`
	Secrets        []TrivyK8sSecretFinding    `json:"secrets"`
	MisconfigError string                     `json:"misconfigError"`
	ResourceCount  int                        `json:"resourceCount"`
	Workloads      []TrivyWorkload            `json:"workloads"`
}

// TrivyScanMeta is the small summary stored beside each scan for listing.
type TrivyScanMeta struct {
	ID           string `json:"id"`
	StartedAt    string `json:"startedAt"`
	FinishedAt   string `json:"finishedAt"`
	Critical     int    `json:"critical"`
	High         int    `json:"high"`
	ImagesFailed int    `json:"imagesFailed"`
}

// TrivyException accepts a finding so it is hidden from the results.
type TrivyException struct {
	ID              string           `json:"id"`
	Kind            string           `json:"kind"` // "vuln" | "misconfig"
	VulnerabilityID string           `json:"vulnerabilityId"`
	ImageRepo       string           `json:"imageRepo"`
	CheckID         string           `json:"checkId"`
	Workload        TrivyWorkloadRef `json:"workload"`
	Reason          string           `json:"reason"`
	CreatedAt       string           `json:"createdAt"`
	ExpiresAt       string           `json:"expiresAt"`
}

// TrivyRunningScan is the cluster scan currently running, with its latest
// progress, so a reopened screen can re-attach to it.
type TrivyRunningScan struct {
	ScanID   string            `json:"scanId"`
	Progress TrivyScanProgress `json:"progress"`
}
