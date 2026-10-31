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

// TrivyScanProgress is sent via Wails events during a long scan.
type TrivyScanProgress struct {
	Phase   string `json:"phase"` // cluster scan: "targets" | "misconfig" | "images" | "waitingCache" | "enrich" | "saving" | "stopping"
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
const TrivyScanSchemaVersion = 2

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
	// ExposureError says why the workloads' Exposure is incomplete (the
	// lookup failed, or the Ingresses were not readable). "" means it is
	// complete — which is also what a schema-2 scan saved before this field
	// existed reads as.
	ExposureError string `json:"exposureError"`
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

// TrivySummary is the headline numbers of a scan view. Accepted findings are
// not counted.
type TrivySummary struct {
	Vulns      map[string]int `json:"vulns"` // severity → distinct findings
	Misconfigs map[string]int `json:"misconfigs"`
	Secrets    map[string]int `json:"secrets"`
	// Delta is severity → the change in vulnerability, misconfig and secret
	// findings against the compared scan, nil without one. It counts only what
	// both scans could see (images neither scan failed on, misconfigs and
	// secrets only when neither misconfig scan failed), so it agrees with the
	// Changes list rather than with the difference of the two headline totals.
	Delta         map[string]int `json:"delta"`
	FixableRatio  float64        `json:"fixableRatio"` // share of critical+high findings with a fixed version; -1 when there are none
	ImagesTotal   int            `json:"imagesTotal"`
	ImagesScanned int            `json:"imagesScanned"`
	// ExposedCritical is the unaccepted CRITICAL findings that touch a workload
	// reachable from outside the cluster: distinct vulnerability findings of
	// images such a workload runs, plus misconfig and secret rows on one.
	ExposedCritical int `json:"exposedCritical"`
}

// TrivyWorkloadRisk is one row of the riskiest-workloads table.
type TrivyWorkloadRisk struct {
	Workload   TrivyWorkloadRef `json:"workload"`
	Exposure   []string         `json:"exposure"`
	Privileges []string         `json:"privileges"`
	Counts     map[string]int   `json:"counts"` // severity → vulnerability findings
}

// TrivyChange is one finding that appeared or disappeared between two scans.
type TrivyChange struct {
	Kind     string           `json:"kind"` // "vuln" | "misconfig" | "secret"
	Key      string           `json:"key"`
	ID       string           `json:"id"` // CVE, check ID or rule ID
	Severity string           `json:"severity"`
	Title    string           `json:"title"`
	Workload TrivyWorkloadRef `json:"workload"`
}

// TrivyChanges is the difference between a scan and the one it is compared with.
type TrivyChanges struct {
	New          []TrivyChange      `json:"new"`
	Closed       []TrivyChange      `json:"closed"`
	NewWorkloads []TrivyWorkloadRef `json:"newWorkloads"`
}

// TrivyFixItem is one entry of the fix plan: an action and what it closes.
type TrivyFixItem struct {
	ID               string             `json:"id"`   // "pkg:<name>@<installed>" | "os:<image>" | "check:<KSVn>"
	Kind             string             `json:"kind"` // "package" | "baseOS" | "misconfig"
	Package          string             `json:"package"`
	InstalledVersion string             `json:"installedVersion"`
	FixedVersion     string             `json:"fixedVersion"` // highest of FixedVersions
	FixedVersions    []string           `json:"fixedVersions"`
	Image            string             `json:"image"`
	OS               *TrivyOSInfo       `json:"os"`
	CheckID          string             `json:"checkId"`
	Title            string             `json:"title"`
	Resolution       string             `json:"resolution"`
	Severity         string             `json:"severity"` // highest severity it closes
	Closes           map[string]int     `json:"closes"`   // severity → findings closed
	VulnIDs          []string           `json:"vulnIds"`
	Images           []string           `json:"images"`
	Workloads        []TrivyWorkloadRef `json:"workloads"`
	ExposedWorkloads int                `json:"exposedWorkloads"`
}

// TrivyVulnRow is one vulnerability of one image as used by one workload.
type TrivyVulnRow struct {
	Key              string           `json:"key"`
	Workload         TrivyWorkloadRef `json:"workload"`
	Image            string           `json:"image"`
	ImageRepo        string           `json:"imageRepo"` // the scope a vulnerability exception is accepted for
	Target           string           `json:"target"`
	Class            string           `json:"class"`
	VulnerabilityID  string           `json:"vulnerabilityID"`
	PkgName          string           `json:"pkgName"`
	PkgPath          string           `json:"pkgPath"`
	InstalledVersion string           `json:"installedVersion"`
	FixedVersion     string           `json:"fixedVersion"`
	Severity         string           `json:"severity"`
	Title            string           `json:"title"`
	Description      string           `json:"description"`
	PrimaryURL       string           `json:"primaryURL"`
	PublishedDate    string           `json:"publishedDate"`
	References       []string         `json:"references"`
	IsNew            bool             `json:"isNew"`
	Accepted         bool             `json:"accepted"`
}

// TrivyMisconfigRow is a misconfiguration finding with its view state.
type TrivyMisconfigRow struct {
	Key          string   `json:"key"`
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
	Status       string   `json:"status"`
	IsNew        bool     `json:"isNew"`
	Accepted     bool     `json:"accepted"`
}

// TrivySecretRow is a secret finding with its view state. Secrets cannot be accepted.
type TrivySecretRow struct {
	Key          string `json:"key"`
	ResourceKind string `json:"resourceKind"`
	ResourceName string `json:"resourceName"`
	Namespace    string `json:"namespace"`
	RuleID       string `json:"ruleID"`
	Category     string `json:"category"`
	Severity     string `json:"severity"`
	Title        string `json:"title"`
	Match        string `json:"match"`
	IsNew        bool   `json:"isNew"`
}

// TrivyExceptionState is an exception as it applies to the viewed scan.
type TrivyExceptionState struct {
	Exception TrivyException `json:"exception"`
	Expired   bool           `json:"expired"`
	Matches   int            `json:"matches"` // findings (vuln) or rows (misconfig) it matches in this scan
}

// TrivyScanView is everything the scan screen and the HTML report show,
// computed from a saved scan, an optional comparison scan and the exceptions.
type TrivyScanView struct {
	ScanID           string                `json:"scanId"`
	ClusterName      string                `json:"clusterName"`
	Scope            string                `json:"scope"`
	StartedAt        string                `json:"startedAt"`
	FinishedAt       string                `json:"finishedAt"`
	CompareID        string                `json:"compareId"`
	CompareStartedAt string                `json:"compareStartedAt"`
	AppVersion       string                `json:"appVersion"`
	TrivyVersion     string                `json:"trivyVersion"`
	DBUpdatedAt      string                `json:"dbUpdatedAt"`
	APIServer        string                `json:"apiServer"`
	ServerVersion    string                `json:"serverVersion"`
	MisconfigError   string                `json:"misconfigError"`
	ResourceCount    int                   `json:"resourceCount"`
	ExposureKnown    bool                  `json:"exposureKnown"` // SchemaVersion >= 2 and no ExposureError
	ExposureError    string                `json:"exposureError"` // why exposure is unknown, if the lookup failed
	Summary          TrivySummary          `json:"summary"`
	TopWorkloads     []TrivyWorkloadRisk   `json:"topWorkloads"`
	Changes          *TrivyChanges         `json:"changes"` // nil without a comparison
	FixPlan          []TrivyFixItem        `json:"fixPlan"`
	UnfixableCount   int                   `json:"unfixableCount"`
	Vulns            []TrivyVulnRow        `json:"vulns"`
	Misconfigs       []TrivyMisconfigRow   `json:"misconfigs"`
	Secrets          []TrivySecretRow      `json:"secrets"`
	Coverage         []TrivyImageCoverage  `json:"coverage"`
	Exceptions       []TrivyExceptionState `json:"exceptions"`
}
