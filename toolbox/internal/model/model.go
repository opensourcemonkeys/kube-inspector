// Package model holds the records that flow between the collectors, the
// correlator and the store. They are plain data so every package can share
// them without importing one another.
package model

import (
	"time"

	"github.com/google/uuid"
)

// Verb is the kind of change recorded for an object.
type Verb string

const (
	VerbCreate Verb = "create"
	VerbUpdate Verb = "update"
	// VerbDelete is the user's delete request: either the object vanished at
	// once, or its deletionTimestamp was just set and finalizers are now running.
	VerbDelete Verb = "delete"
	// VerbFinalized is the object finally leaving storage after a VerbDelete
	// that had to wait for finalizers. Nobody "did" it at that moment — the
	// last finalizer was removed — so it is recorded separately rather than as
	// a second delete.
	VerbFinalized Verb = "finalized"
)

// Attribution names where a change's actor information came from, from most
// to least complete.
type Attribution string

const (
	AttrAudit         Attribution = "audit"         // user, groups, source IPs, user agent
	AttrAdmission     Attribution = "admission"     // user and groups, no network details
	AttrManagedFields Attribution = "managedFields" // only the field manager's name
	AttrNone          Attribution = "none"
)

// HintSource is the collector a Hint came from.
type HintSource string

const (
	HintAudit     HintSource = "audit"
	HintAdmission HintSource = "admission"
)

// Actor is who made a change, as far as we can tell.
type Actor struct {
	Username       string              `json:"username"`
	UserUID        string              `json:"userUid,omitempty"`
	Groups         []string            `json:"groups,omitempty"`
	Extra          map[string][]string `json:"extra,omitempty"`
	ImpersonatedBy string              `json:"impersonatedBy,omitempty"`
	SourceIPs      []string            `json:"sourceIPs,omitempty"`
	UserAgent      string              `json:"userAgent,omitempty"`
	AuditID        string              `json:"auditId,omitempty"`
}

// ObjectKey identifies an object by resource rather than kind, since that is
// what both audit events and admission requests carry.
type ObjectKey struct {
	Group     string `json:"group"`
	Resource  string `json:"resource"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
}

// Hint is a piece of actor information collected from the API server's side
// of a request — an audit event or an admission review — waiting to be matched
// to the change the informer observes once the request has been persisted.
type Hint struct {
	ID          string     `json:"id"` // audit ID or admission request UID; one hint attributes one change
	Source      HintSource `json:"source"`
	Time        time.Time  `json:"time"`
	Cluster     string     `json:"cluster"`
	Verb        Verb       `json:"verb"` // create, update or delete
	Key         ObjectKey  `json:"key"`
	Subresource string     `json:"subresource,omitempty"`
	ObjectUID   string     `json:"objectUid"`
	// ResourceVersion is the version the request produced. Only audit events
	// at RequestResponse level carry it, and it is then an exact join key.
	ResourceVersion string `json:"resourceVersion,omitempty"`
	// ContentHash is diff.ContentHash of the object an admission request was
	// about to persist; it pins the hint to that exact change.
	ContentHash string `json:"contentHash,omitempty"`
	Actor       Actor  `json:"actor"`
}

// Change is one persisted change to one object.
type Change struct {
	EventID         uuid.UUID   `json:"eventId"`
	Version         uint32      `json:"version"` // bumped when a later pass re-attributes the row
	Time            time.Time   `json:"time"`
	Cluster         string      `json:"cluster"`
	Verb            Verb        `json:"verb"`
	Group           string      `json:"group"`
	APIVersion      string      `json:"apiVersion"`
	Resource        string      `json:"resource"`
	Kind            string      `json:"kind"`
	Namespace       string      `json:"namespace"`
	Name            string      `json:"name"`
	ObjectUID       string      `json:"objectUid"`
	ResourceVersion string      `json:"resourceVersion,omitempty"`
	Actor           Actor       `json:"actor"`
	FieldManager    string      `json:"fieldManager"`
	Attribution     Attribution `json:"attribution"`
	ChangedPaths    []string    `json:"changedPaths,omitempty"`
	Patch           string      `json:"patch,omitempty"`  // RFC 6902, invertible (each replace/remove preceded by a test of the old value)
	Before          string      `json:"before,omitempty"` // sanitised JSON, empty on create
	After           string      `json:"after,omitempty"`  // sanitised JSON, empty on delete
}

// AuditRecord is a mutating request seen by the audit webhook, kept whether or
// not it succeeded so rejected attempts can be listed too.
type AuditRecord struct {
	Time            time.Time `json:"time"`
	Cluster         string    `json:"cluster"`
	AuditID         string    `json:"auditId,omitempty"`
	Verb            string    `json:"verb"` // the API verb as audited: create, update, patch, delete, deletecollection
	Group           string    `json:"group"`
	APIVersion      string    `json:"apiVersion"`
	Resource        string    `json:"resource"`
	Subresource     string    `json:"subresource,omitempty"`
	Namespace       string    `json:"namespace"`
	Name            string    `json:"name"`
	Username        string    `json:"username"`
	Groups          []string  `json:"groups,omitempty"`
	ImpersonatedBy  string    `json:"impersonatedBy,omitempty"`
	SourceIPs       []string  `json:"sourceIPs,omitempty"`
	UserAgent       string    `json:"userAgent,omitempty"`
	RequestURI      string    `json:"requestUri"`
	ResponseCode    int32     `json:"responseCode"`
	ResponseReason  string    `json:"responseReason,omitempty"`
	ResponseMessage string    `json:"responseMessage,omitempty"`
}
