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

// ToolboxChangeFilter narrows a change or attempt listing. Since is a
// duration ("24h") or RFC 3339; empty means all time.
type ToolboxChangeFilter struct {
	Q         string `json:"q"`
	Namespace string `json:"namespace"`
	Resource  string `json:"resource"`
	Name      string `json:"name"`
	User      string `json:"user"`
	Verb      string `json:"verb"`
	Since     string `json:"since"`
	Cursor    string `json:"cursor"`
	Limit     int    `json:"limit"`
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
	ImpersonatedBy  string   `json:"impersonatedBy,omitempty"`
	SourceIPs       []string `json:"sourceIPs,omitempty"`
	UserAgent       string   `json:"userAgent,omitempty"`
	ResponseCode    int32    `json:"responseCode"`
	ResponseReason  string   `json:"responseReason,omitempty"`
	ResponseMessage string   `json:"responseMessage,omitempty"`
}

// ToolboxUser is one actor and how much they changed.
type ToolboxUser struct {
	Username   string   `json:"username"`
	Changes    uint64   `json:"changes"`
	LastSeen   string   `json:"lastSeen"`
	SourceIPs  []string `json:"sourceIPs,omitempty"`
	UserAgents []string `json:"userAgents,omitempty"`
}
