// Package auditsink receives the API server's audit webhook backend: batches
// of audit.k8s.io/v1 events. Audit is the only place the API server reports a
// request's source IPs and user agent, and — at RequestResponse level — the
// resourceVersion the write produced, which pins a hint to exactly one change.
//
// The event types are declared here rather than imported from
// k8s.io/apiserver: only a handful of fields are read, and the JSON shape of
// audit.k8s.io/v1 is stable.
package auditsink

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/kubeinspector/toolbox/internal/config"
	"github.com/kubeinspector/toolbox/internal/metrics"
	"github.com/kubeinspector/toolbox/internal/model"
)

// maxBody bounds one batch. The API server's default batch is up to 400
// events, each possibly carrying request and response objects.
const maxBody = 128 << 20

type userInfo struct {
	Username string              `json:"username"`
	UID      string              `json:"uid"`
	Groups   []string            `json:"groups"`
	Extra    map[string][]string `json:"extra"`
}

type objectRef struct {
	Resource    string `json:"resource"`
	Namespace   string `json:"namespace"`
	Name        string `json:"name"`
	UID         string `json:"uid"`
	APIGroup    string `json:"apiGroup"`
	APIVersion  string `json:"apiVersion"`
	Subresource string `json:"subresource"`
}

type status struct {
	Code    int32  `json:"code"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type event struct {
	AuditID                  string          `json:"auditID"`
	Stage                    string          `json:"stage"`
	RequestURI               string          `json:"requestURI"`
	Verb                     string          `json:"verb"`
	User                     userInfo        `json:"user"`
	ImpersonatedUser         *userInfo       `json:"impersonatedUser"`
	SourceIPs                []string        `json:"sourceIPs"`
	UserAgent                string          `json:"userAgent"`
	ObjectRef                *objectRef      `json:"objectRef"`
	ResponseStatus           *status         `json:"responseStatus"`
	ResponseObject           json.RawMessage `json:"responseObject"`
	RequestReceivedTimestamp time.Time       `json:"requestReceivedTimestamp"`
	StageTimestamp           time.Time       `json:"stageTimestamp"`
}

type eventList struct {
	Items []event `json:"items"`
}

var mutating = map[string]model.Verb{
	"create":           model.VerbCreate,
	"update":           model.VerbUpdate,
	"patch":            model.VerbUpdate,
	"delete":           model.VerbDelete,
	"deletecollection": "", // audited, but names no single object to attribute
}

type Handler struct {
	Cluster  string
	Filter   *config.ResourceFilter
	Token    string // when set, requests must carry "Authorization: Bearer <token>"
	PutHint  func(model.Hint) bool
	PutAudit func(model.AuditRecord) bool
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if h.Token != "" {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(h.Token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}
	var list eventList
	if err := json.NewDecoder(io.LimitReader(r.Body, maxBody)).Decode(&list); err != nil {
		// A batch we cannot parse will not parse on retry either; accept it
		// so the API server does not resend it forever.
		slog.Warn("audit: undecodable batch dropped", "err", err)
		w.WriteHeader(http.StatusOK)
		return
	}
	for i := range list.Items {
		h.handle(&list.Items[i])
	}
	w.WriteHeader(http.StatusOK)
}

func (h *Handler) handle(e *event) {
	verb, ok := mutating[e.Verb]
	if !ok || e.ObjectRef == nil || (e.Stage != "ResponseComplete" && e.Stage != "Panic") {
		return
	}
	if strings.Contains(e.RequestURI, "dryRun=") {
		return
	}
	ref := e.ObjectRef
	verb = parentVerb(verb, ref.Subresource)
	if !h.Filter.AllowsResource(ref.APIGroup, ref.Resource) || !h.Filter.AllowsNamespace(ref.Namespace) {
		return
	}

	meta := responseMeta(e.ResponseObject)
	name := ref.Name
	if name == "" {
		name = meta.Name
	}
	code, reason, message := int32(0), "", ""
	if e.ResponseStatus != nil {
		code, reason, message = e.ResponseStatus.Code, e.ResponseStatus.Reason, e.ResponseStatus.Message
	}
	ts := e.RequestReceivedTimestamp
	if ts.IsZero() {
		ts = e.StageTimestamp
	}
	// Audit's user is whoever authenticated; with impersonation (kubectl
	// --as) the request was made as impersonatedUser, which is also what the
	// admission webhook reports. Record the effective user as the actor and
	// the authenticated one as who impersonated them.
	actor, impersonatedBy := e.User, ""
	if e.ImpersonatedUser != nil && e.ImpersonatedUser.Username != "" {
		actor, impersonatedBy = *e.ImpersonatedUser, e.User.Username
	}

	h.PutAudit(model.AuditRecord{
		Time: ts, Cluster: h.Cluster, AuditID: e.AuditID, Verb: e.Verb,
		Group: ref.APIGroup, APIVersion: ref.APIVersion, Resource: ref.Resource, Subresource: ref.Subresource,
		Namespace: ref.Namespace, Name: name, Username: actor.Username, Groups: actor.Groups,
		ImpersonatedBy: impersonatedBy, SourceIPs: e.SourceIPs, UserAgent: e.UserAgent, RequestURI: e.RequestURI,
		ResponseCode: code, ResponseReason: reason, ResponseMessage: message,
	})

	if verb == "" || code >= 400 || code == 0 {
		return
	}
	uid := ref.UID
	if uid == "" {
		uid = meta.UID
	}
	metrics.HintsReceived.WithLabelValues(string(model.HintAudit)).Inc()
	h.PutHint(model.Hint{
		ID: e.AuditID, Source: model.HintAudit, Time: ts, Cluster: h.Cluster, Verb: verb,
		Key:         model.ObjectKey{Group: ref.APIGroup, Resource: ref.Resource, Namespace: ref.Namespace, Name: name},
		Subresource: ref.Subresource, ObjectUID: uid, ResourceVersion: meta.ResourceVersion,
		Actor: model.Actor{
			Username: actor.Username, UserUID: actor.UID, Groups: actor.Groups, Extra: actor.Extra,
			ImpersonatedBy: impersonatedBy, SourceIPs: e.SourceIPs, UserAgent: e.UserAgent, AuditID: e.AuditID,
		},
	})
}

// parentVerb is what a request does to the object the informer watches. A
// create on a subresource is not a create of the parent: the scheduler's
// pods/binding sets spec.nodeName (an update), and pods/eviction starts a
// graceful delete.
func parentVerb(v model.Verb, subresource string) model.Verb {
	if subresource == "" || v != model.VerbCreate {
		return v
	}
	if subresource == "eviction" {
		return model.VerbDelete
	}
	return model.VerbUpdate
}

type objectMeta struct {
	Name            string
	UID             string
	ResourceVersion string
}

// responseMeta reads the object the request returned. A Status (what a
// delete without finalizers may return) carries no object identity.
func responseMeta(raw json.RawMessage) objectMeta {
	if len(raw) == 0 {
		return objectMeta{}
	}
	var o struct {
		Kind     string `json:"kind"`
		Metadata struct {
			Name            string `json:"name"`
			UID             string `json:"uid"`
			ResourceVersion string `json:"resourceVersion"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(raw, &o); err != nil || o.Kind == "Status" {
		return objectMeta{}
	}
	return objectMeta{Name: o.Metadata.Name, UID: o.Metadata.UID, ResourceVersion: o.Metadata.ResourceVersion}
}
