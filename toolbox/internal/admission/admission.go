// Package admission is a validating admission webhook that never rejects
// anything. It exists to see who is making each write — the API server hands
// a webhook the requesting user, groups and the object about to be persisted,
// which an informer never sees — and records that as a hint for the
// correlator.
package admission

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	admissionv1 "k8s.io/api/admission/v1"

	"github.com/kubeinspector/toolbox/internal/config"
	"github.com/kubeinspector/toolbox/internal/diff"
	"github.com/kubeinspector/toolbox/internal/metrics"
	"github.com/kubeinspector/toolbox/internal/model"
)

// maxBody bounds a review: two copies of an object at etcd's ~1.5MiB limit,
// plus envelope.
const maxBody = 8 << 20

type Handler struct {
	Cluster string
	Filter  *config.ResourceFilter
	Put     func(model.Hint) bool
	Now     func() time.Time
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var review admissionv1.AdmissionReview
	if err := json.Unmarshal(body, &review); err != nil || review.Request == nil {
		http.Error(w, "not an AdmissionReview", http.StatusBadRequest)
		return
	}
	req := review.Request

	// Answer first in spirit: whatever happens below, the request is allowed.
	if hint, ok := h.hintFor(req); ok {
		metrics.HintsReceived.WithLabelValues(string(model.HintAdmission)).Inc()
		h.Put(hint)
	}

	review.Response = &admissionv1.AdmissionResponse{UID: req.UID, Allowed: true}
	review.Request = nil
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(review); err != nil {
		slog.Warn("admission: write response", "err", err)
	}
}

func (h *Handler) hintFor(req *admissionv1.AdmissionRequest) (model.Hint, bool) {
	var verb model.Verb
	switch req.Operation {
	case admissionv1.Create:
		verb = model.VerbCreate
	case admissionv1.Update:
		verb = model.VerbUpdate
	case admissionv1.Delete:
		verb = model.VerbDelete
	default:
		return model.Hint{}, false
	}
	// A dry run persists nothing, so it can never be the cause of a change.
	if req.DryRun != nil && *req.DryRun {
		return model.Hint{}, false
	}
	if !h.Filter.AllowsResource(req.Resource.Group, req.Resource.Resource) || !h.Filter.AllowsNamespace(req.Namespace) {
		return model.Hint{}, false
	}

	obj := decode(req.Object.Raw)
	old := decode(req.OldObject.Raw)
	name, uid := req.Name, ""
	for _, o := range []map[string]any{obj, old} {
		md, _ := o["metadata"].(map[string]any)
		if n, _ := md["name"].(string); name == "" && n != "" {
			name = n
		}
		if u, _ := md["uid"].(string); uid == "" && u != "" {
			uid = u
		}
	}

	hint := model.Hint{
		ID:          string(req.UID),
		Source:      model.HintAdmission,
		Time:        h.now(),
		Cluster:     h.Cluster,
		Verb:        verb,
		Key:         model.ObjectKey{Group: req.Resource.Group, Resource: req.Resource.Resource, Namespace: req.Namespace, Name: name},
		Subresource: req.SubResource,
		ObjectUID:   uid,
		Actor:       actorOf(req.UserInfo.Username, req.UserInfo.UID, req.UserInfo.Groups, req.UserInfo.Extra),
	}
	// A subresource's object (a Scale) is not the object the informer sees,
	// so it cannot be hashed into a match key.
	if verb != model.VerbDelete && req.SubResource == "" {
		hint.ContentHash = diff.ContentHash(obj)
	}
	return hint, true
}

func actorOf[E ~[]string](user, uid string, groups []string, extra map[string]E) model.Actor {
	a := model.Actor{Username: user, UserUID: uid, Groups: groups}
	if len(extra) > 0 {
		a.Extra = make(map[string][]string, len(extra))
		for k, v := range extra {
			a.Extra[k] = []string(v)
		}
	}
	return a
}

func decode(raw []byte) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}
