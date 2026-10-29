package models

// ToolboxStatus says whether the toolbox change recorder can be used on a
// cluster. State is a code the frontend translates: "ok", "notInstalled",
// "forbidden" (RBAC stops us reading its token or proxying to it) or
// "unreachable" (found, but it did not answer). Detail carries the underlying
// error for the tooltip.
type ToolboxStatus struct {
	State     string `json:"state"`
	Namespace string `json:"namespace,omitempty"`
	Service   string `json:"service,omitempty"`
	Version   string `json:"version,omitempty"`
	// Cluster is the name toolbox tags its rows with, not the kube-ins one.
	Cluster string `json:"cluster,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

// ToolboxActor is who made a change, as toolbox attributed it.
type ToolboxActor struct {
	Username       string   `json:"username"`
	Groups         []string `json:"groups,omitempty"`
	ImpersonatedBy string   `json:"impersonatedBy,omitempty"`
	SourceIPs      []string `json:"sourceIPs,omitempty"`
	UserAgent      string   `json:"userAgent,omitempty"`
	AuditID        string   `json:"auditId,omitempty"`
}

// ToolboxChange is one recorded create, update, delete or final removal.
type ToolboxChange struct {
	EventID         string       `json:"eventId"`
	Time            string       `json:"time"`
	Verb            string       `json:"verb"`
	Group           string       `json:"group"`
	APIVersion      string       `json:"apiVersion"`
	Resource        string       `json:"resource"`
	Kind            string       `json:"kind"`
	Namespace       string       `json:"namespace"`
	Name            string       `json:"name"`
	ObjectUID       string       `json:"objectUid"`
	ResourceVersion string       `json:"resourceVersion,omitempty"`
	Actor           ToolboxActor `json:"actor"`
	FieldManager    string       `json:"fieldManager"`
	// Attribution is how the actor was found: audit, admission,
	// managedFields or none.
	Attribution  string   `json:"attribution"`
	ChangedPaths []string `json:"changedPaths,omitempty"`
}

type ToolboxChangePage struct {
	Items      []ToolboxChange `json:"items"`
	NextCursor string          `json:"nextCursor,omitempty"`
}

// ToolboxChangeFilter narrows a change or attempt listing. Since and Until
// are a duration ("24h", meaning that long ago) or RFC 3339; an empty Since
// means all time, an empty Until means now. Path is a JSON pointer prefix
// ("/spec/replicas") matched against the paths a change touched.
type ToolboxChangeFilter struct {
	Q string `json:"q"`
	// Group narrows to one API group: "" does not filter, "core" is the
	// core (empty) group — toolbox's own spelling for it.
	Group       string `json:"group"`
	Namespace   string `json:"namespace"`
	Resource    string `json:"resource"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	User        string `json:"user"`
	Verb        string `json:"verb"`
	Attribution string `json:"attribution"`
	Path        string `json:"path"`
	Since       string `json:"since"`
	Until       string `json:"until"`
	Cursor      string `json:"cursor"`
	Limit       int    `json:"limit"`
}

// ToolboxChangeDetail is one change with both sides of it as YAML.
//
// BeforeYaml/AfterYaml are the objects as toolbox stored them, status
// included. The *Restorable variants are what a rollback would write — server
// managed fields and status stripped — and are compared with the live object.
type ToolboxChangeDetail struct {
	Change           ToolboxChange `json:"change"`
	BeforeYaml       string        `json:"beforeYaml"`
	AfterYaml        string        `json:"afterYaml"`
	BeforeRestorable string        `json:"beforeRestorable"`
	AfterRestorable  string        `json:"afterRestorable"`
	// RollbackBlocked is a code for why no rollback is offered at all:
	// "secretRedacted" (toolbox never stores Secret values), or "".
	RollbackBlocked string `json:"rollbackBlocked,omitempty"`
}

// ToolboxLiveObject is the object as it is now, cleaned like a restorable
// side. Exists is false when it has been deleted.
type ToolboxLiveObject struct {
	Exists bool   `json:"exists"`
	Yaml   string `json:"yaml"`
}

// ToolboxAttempt is a write the API server refused or failed.
type ToolboxAttempt struct {
	Time            string   `json:"time"`
	Verb            string   `json:"verb"`
	Group           string   `json:"group"`
	Resource        string   `json:"resource"`
	Subresource     string   `json:"subresource,omitempty"`
	Namespace       string   `json:"namespace"`
	Name            string   `json:"name"`
	Username        string   `json:"username"`
	Groups          []string `json:"groups,omitempty"`
	ImpersonatedBy  string   `json:"impersonatedBy,omitempty"`
	SourceIPs       []string `json:"sourceIPs,omitempty"`
	UserAgent       string   `json:"userAgent,omitempty"`
	RequestURI      string   `json:"requestUri,omitempty"`
	AuditID         string   `json:"auditId,omitempty"`
	ResponseCode    int32    `json:"responseCode"`
	ResponseReason  string   `json:"responseReason,omitempty"`
	ResponseMessage string   `json:"responseMessage,omitempty"`
}

// ToolboxAttemptPage is one page of refused writes. NextCursor is empty on the
// last page, and always from a toolbox older than attempt paging.
type ToolboxAttemptPage struct {
	Items      []ToolboxAttempt `json:"items"`
	NextCursor string           `json:"nextCursor,omitempty"`
}

// ToolboxUser is one actor and how much they changed. The per-verb counts are
// zero from a toolbox older than them.
type ToolboxUser struct {
	Username   string   `json:"username"`
	Changes    uint64   `json:"changes"`
	Creates    uint64   `json:"creates"`
	Updates    uint64   `json:"updates"`
	Deletes    uint64   `json:"deletes"`
	Finalized  uint64   `json:"finalized"`
	LastSeen   string   `json:"lastSeen"`
	SourceIPs  []string `json:"sourceIPs,omitempty"`
	UserAgents []string `json:"userAgents,omitempty"`
}

// ToolboxHealth is how well toolbox is recording, from its /api/v1/health.
// Supported is false for a toolbox from before that endpoint existed; the
// rest is then empty and everything else still works.
type ToolboxHealth struct {
	Supported   bool                   `json:"supported"`
	Sources     ToolboxSources         `json:"sources"`
	Leader      *ToolboxLeader         `json:"leader,omitempty"`
	Recorder    *ToolboxHeartbeat      `json:"recorder,omitempty"`
	Coverage    ToolboxCoverage        `json:"coverage"`
	Attribution []ToolboxCount         `json:"attribution"`
	Recording   ToolboxRecordingConfig `json:"recording"`
}

type ToolboxSources struct {
	Admission ToolboxSource `json:"admission"`
	Audit     ToolboxSource `json:"audit"`
}

// ToolboxSource is one collector. LastSeen is empty when it sent nothing in
// the last 24 hours (toolbox keeps hints a day).
type ToolboxSource struct {
	Enabled  bool   `json:"enabled"`
	LastSeen string `json:"lastSeen,omitempty"`
}

type ToolboxLeader struct {
	Identity  string `json:"identity"`
	Since     string `json:"since,omitempty"`
	RenewedAt string `json:"renewedAt,omitempty"`
}

type ToolboxHeartbeat struct {
	Time             string `json:"time"`
	Identity         string `json:"identity"`
	WatchedResources uint32 `json:"watchedResources"`
	Pending          uint32 `json:"pending"`
}

// ToolboxGap is a stretch with no recording leader: changes made then were
// missed. Open means it is still going on.
type ToolboxGap struct {
	From string `json:"from"`
	To   string `json:"to"`
	Open bool   `json:"open"`
}

// ToolboxCoverage is how much of [Since, Until] was recorded. Since is the
// first heartbeat when that is later than asked; HasData is false when there
// has never been one.
type ToolboxCoverage struct {
	Since      string       `json:"since"`
	Until      string       `json:"until"`
	HasData    bool         `json:"hasData"`
	Gaps       []ToolboxGap `json:"gaps"`
	GapSeconds float64      `json:"gapSeconds"`
	Ratio      float64      `json:"ratio"`
}

type ToolboxCount struct {
	Key   string `json:"key"`
	Count uint64 `json:"count"`
}

// ToolboxRecordingConfig is what this toolbox release records, and for how long.
type ToolboxRecordingConfig struct {
	AdmissionWebhook     bool     `json:"admissionWebhook"`
	AuditWebhook         bool     `json:"auditWebhook"`
	RecordStatusChanges  bool     `json:"recordStatusChanges"`
	Include              []string `json:"include"`
	Exclude              []string `json:"exclude"`
	ExcludeNamespaces    []string `json:"excludeNamespaces"`
	ChangesRetentionDays int      `json:"changesRetentionDays"`
	AuditRetentionDays   int      `json:"auditRetentionDays"`
	HeartbeatInterval    string   `json:"heartbeatInterval"`
}

// ToolboxStatsFilter is the period an overview covers. Since/Until as in
// ToolboxChangeFilter; Bucket is the chart column width ("1h").
type ToolboxStatsFilter struct {
	Since     string `json:"since"`
	Until     string `json:"until"`
	Namespace string `json:"namespace"`
	Bucket    string `json:"bucket"`
}

type ToolboxBucket struct {
	Time  string `json:"time"`
	Verb  string `json:"verb"`
	Count uint64 `json:"count"`
}

type ToolboxTotals struct {
	Changes      uint64 `json:"changes"`
	Deletes      uint64 `json:"deletes"`
	Unattributed uint64 `json:"unattributed"`
	Attempts     uint64 `json:"attempts"`
}

// ToolboxStats is toolbox's summary of a period. Totals and Previous are nil
// from a toolbox older than them; the chart and top lists still work then.
type ToolboxStats struct {
	Buckets     []ToolboxBucket `json:"buckets"`
	ByResource  []ToolboxCount  `json:"byResource"`
	ByUser      []ToolboxCount  `json:"byUser"`
	ByNamespace []ToolboxCount  `json:"byNamespace"`
	Totals      *ToolboxTotals  `json:"totals,omitempty"`
	Previous    *ToolboxTotals  `json:"previous,omitempty"`
}

// ToolboxExportResult says what an export wrote. Path is empty when the user
// cancelled the save dialog; Truncated means the filter matched more than the
// export limit and only the newest rows were written.
type ToolboxExportResult struct {
	Path      string `json:"path"`
	Rows      int    `json:"rows"`
	Truncated bool   `json:"truncated"`
	Limit     int    `json:"limit"`
}
