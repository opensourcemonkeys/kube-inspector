package correlate

import (
	"encoding/json"

	"github.com/google/uuid"

	"github.com/kubeinspector/toolbox/internal/diff"
	"github.com/kubeinspector/toolbox/internal/model"
	"github.com/kubeinspector/toolbox/internal/watcher"
)

// Build turns an informer event into an unattributed Change, plus the content
// hash used to match it to an admission hint. ok is false for events that are
// not worth recording (nothing but noise changed, or only status when status
// changes are not recorded).
func Build(ev watcher.Event, cluster string, recordStatus bool) (ch model.Change, hash string, ok bool) {
	gvr := ev.Resource.GVR
	var before, after map[string]any
	if ev.Old != nil {
		before = ev.Old.Object
	}
	if ev.New != nil {
		after = ev.New.Object
	}

	var verb model.Verb
	switch ev.Type {
	case watcher.Added:
		verb = model.VerbCreate
	case watcher.Updated:
		verb = model.VerbUpdate
		if ev.Old.GetDeletionTimestamp() == nil && ev.New.GetDeletionTimestamp() != nil {
			verb = model.VerbDelete
		}
	case watcher.Deleted:
		verb = model.VerbDelete
		if ev.Old.GetDeletionTimestamp() != nil {
			verb = model.VerbFinalized
		}
	}

	sBefore := diff.Sanitize(before, gvr.Group, gvr.Resource)
	sAfter := diff.Sanitize(after, gvr.Group, gvr.Resource)
	res, err := diff.Compute(sBefore, sAfter)
	if err != nil || res.Empty {
		return ch, "", false
	}
	if verb == model.VerbUpdate && res.StatusOnly && !recordStatus {
		return ch, "", false
	}

	obj := ev.New
	if obj == nil {
		obj = ev.Old
	}
	ch = model.Change{
		EventID:         uuid.New(),
		Version:         1,
		Time:            ev.Observed.UTC(),
		Cluster:         cluster,
		Verb:            verb,
		Group:           gvr.Group,
		APIVersion:      gvr.Version,
		Resource:        gvr.Resource,
		Kind:            ev.Resource.Kind,
		Namespace:       obj.GetNamespace(),
		Name:            obj.GetName(),
		ObjectUID:       string(obj.GetUID()),
		ResourceVersion: obj.GetResourceVersion(),
		ChangedPaths:    res.ChangedPaths,
		Patch:           res.Patch,
		Before:          marshal(sBefore),
		After:           marshal(sAfter),
	}
	if verb == model.VerbCreate || verb == model.VerbUpdate {
		ch.FieldManager = diff.Writer(before, after)
		hash = diff.ContentHash(after)
	}
	return ch, hash, true
}

func marshal(m map[string]any) string {
	if m == nil {
		return ""
	}
	b, _ := json.Marshal(m)
	return string(b)
}
