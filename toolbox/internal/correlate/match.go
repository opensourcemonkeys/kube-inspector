package correlate

import (
	"sort"
	"time"

	"github.com/kubeinspector/toolbox/internal/model"
)

// clockSkew is how far after the change a hint may claim to be. A request is
// received (audit) and admitted (admission) before it is persisted and then
// observed, so a later hint is only plausible within the clock difference
// between the API server and this pod.
const clockSkew = 5 * time.Second

// result is one attribution decision.
type result struct {
	actor model.Actor
	attr  model.Attribution
	ids   []string
}

// matchAll attributes a batch of changes (sorted by time) against hints.
// Rules, strongest first:
//
//  1. audit hint for the same object with the exact resourceVersion the
//     request produced (audit at RequestResponse level);
//  2. admission hint for the same object whose content hash equals the
//     persisted content (for a delete: the same object UID) — then an audit
//     hint from the same user is looked for to add network details;
//  3. audit hint for the same object and verb that carried no
//     resourceVersion (Metadata level), nearest in time;
//  4. admission hint for a subresource (kubectl scale), which cannot be
//     hashed, for the same object and verb, nearest in time.
//
// A removal after deletion was requested (finalized) takes rule 1 or a later
// DELETE of the same object (laterDelete), nothing else.
//
// Rules 1–2 are exact and decided per change. Rules 3–4 are decided over the
// whole batch at once, closest pairs first: deciding them change by change
// lets an early change take a hint that sits right next to a later one.
//
// upcoming are changes observed but not yet due. They take part in the
// matching so that a hint closer to one of them is left for it rather than
// spent on a change in this batch; their own results are dropped and they are
// decided again when they come due.
//
// used holds hint IDs already spent; a hint attributes one change.
func matchAll(items, upcoming []*item, hints []model.Hint, used map[string]time.Time, window time.Duration, now time.Time) []*result {
	all := append(append(make([]*item, 0, len(items)+len(upcoming)), items...), upcoming...)
	out := make([]*result, len(all))
	// Upcoming changes reserve hints only for the length of this call.
	taken := make(map[string]bool)
	spent := func(id string) bool {
		_, ok := used[id]
		return ok || taken[id]
	}
	spend := func(i int, ids ...string) {
		for _, id := range ids {
			taken[id] = true
			if i < len(items) {
				used[id] = now
			}
		}
	}

	for i, it := range all {
		if r := matchExact(&it.change, it.hash, hints, spent, window); r != nil {
			out[i] = r
			spend(i, r.ids...)
		}
	}

	type pair struct {
		item, hint, rank int
		dist             time.Duration
	}
	var pairs []pair
	for i, it := range all {
		ch := &it.change
		if out[i] != nil || ch.Verb == model.VerbFinalized {
			continue
		}
		for j := range hints {
			h := &hints[j]
			if spent(h.ID) || h.Verb != ch.Verb || !sameObject(h, ch) {
				continue
			}
			rank := 0
			switch {
			case h.Source == model.HintAudit && (h.ResourceVersion == "" || ch.Verb == model.VerbDelete):
				rank = 3
			case h.Source == model.HintAdmission && h.Subresource != "":
				rank = 4
			default:
				continue
			}
			if d, ok := distance(ch.Time, h.Time, window); ok {
				pairs = append(pairs, pair{i, j, rank, d})
			}
		}
	}
	sort.SliceStable(pairs, func(a, b int) bool {
		if pairs[a].rank != pairs[b].rank {
			return pairs[a].rank < pairs[b].rank
		}
		return pairs[a].dist < pairs[b].dist
	})
	for _, p := range pairs {
		h := &hints[p.hint]
		if spent(h.ID) || out[p.item] != nil {
			continue
		}
		attr := model.AttrAudit
		if h.Source == model.HintAdmission {
			attr = model.AttrAdmission
		}
		out[p.item] = &result{actor: h.Actor, attr: attr, ids: []string{h.ID}}
		spend(p.item, h.ID)
	}
	return out[:len(items)]
}

func matchExact(ch *model.Change, hash string, hints []model.Hint, spent func(string) bool, window time.Duration) *result {
	exactRV := func(h *model.Hint) bool {
		return h.Source == model.HintAudit && sameObject(h, ch) && h.ResourceVersion != "" && h.ResourceVersion == ch.ResourceVersion
	}
	// 1.
	if h := nearest(hints, spent, ch.Time, window, exactRV); h != nil {
		return &result{actor: h.Actor, attr: model.AttrAudit, ids: []string{h.ID}}
	}
	if ch.Verb == model.VerbFinalized {
		return laterDelete(ch, hints, spent, window)
	}

	// 2.
	h := nearest(hints, spent, ch.Time, window, func(h *model.Hint) bool {
		if h.Source != model.HintAdmission || h.Verb != ch.Verb || !sameObject(h, ch) {
			return false
		}
		if ch.Verb == model.VerbDelete {
			return h.ObjectUID != "" && h.ObjectUID == ch.ObjectUID
		}
		return h.ContentHash != "" && h.ContentHash == hash
	})
	if h == nil {
		return nil
	}
	r := &result{actor: h.Actor, attr: model.AttrAdmission, ids: []string{h.ID}}
	if au := nearest(hints, spent, ch.Time, window, func(x *model.Hint) bool {
		return x.Source == model.HintAudit && x.Verb == ch.Verb && sameObject(x, ch) &&
			x.Actor.Username == h.Actor.Username && (x.ResourceVersion == "" || x.ResourceVersion == ch.ResourceVersion)
	}); au != nil {
		r.actor.SourceIPs, r.actor.UserAgent = au.Actor.SourceIPs, au.Actor.UserAgent
		r.actor.AuditID, r.actor.ImpersonatedBy = au.Actor.AuditID, au.Actor.ImpersonatedBy
		r.attr = model.AttrAudit
		r.ids = append(r.ids, au.ID)
	}
	return r
}

// laterDelete attributes a removal to a DELETE of the same object that came
// after the first one. The first DELETE (per source: one request leaves both an
// admission and an audit hint) set deletionTimestamp; a later one — the
// kubelet ending a pod's graceful delete, a forced delete — removed it. When
// the last finalizer ran out there is no later DELETE, and nothing else can
// say who removed that finalizer.
func laterDelete(ch *model.Change, hints []model.Hint, spent func(string) bool, window time.Duration) *result {
	isDelete := func(h *model.Hint) bool {
		return h.Verb == model.VerbDelete && h.ObjectUID != "" && h.ObjectUID == ch.ObjectUID
	}
	first := map[model.HintSource]time.Time{}
	for i := range hints {
		h := &hints[i]
		if t, seen := first[h.Source]; isDelete(h) && (!seen || h.Time.Before(t)) {
			first[h.Source] = h.Time
		}
	}
	h := nearest(hints, spent, ch.Time, window, func(h *model.Hint) bool {
		return isDelete(h) && h.Time.After(first[h.Source])
	})
	if h == nil {
		return nil
	}
	attr := model.AttrAudit
	if h.Source == model.HintAdmission {
		attr = model.AttrAdmission
	}
	return &result{actor: h.Actor, attr: attr, ids: []string{h.ID}}
}

// sameObject compares by UID when both sides know it, else by key. A hint
// without a name can still match a create: a generateName create audited at
// Metadata level names nothing.
func sameObject(h *model.Hint, ch *model.Change) bool {
	if h.ObjectUID != "" && ch.ObjectUID != "" {
		return h.ObjectUID == ch.ObjectUID
	}
	if h.Key.Group != ch.Group || h.Key.Resource != ch.Resource || h.Key.Namespace != ch.Namespace {
		return false
	}
	return h.Key.Name == ch.Name || (h.Key.Name == "" && ch.Verb == model.VerbCreate)
}

// distance is how long before the change the hint was, and whether that is
// plausible: no more than window before, no more than clockSkew after.
func distance(change, hint time.Time, window time.Duration) (time.Duration, bool) {
	d := change.Sub(hint)
	if d > window || d < -clockSkew {
		return 0, false
	}
	if d < 0 {
		d = -d
	}
	return d, true
}

// nearest returns the unspent, plausible hint satisfying ok closest to t.
func nearest(hints []model.Hint, spent func(string) bool, t time.Time, window time.Duration, ok func(*model.Hint) bool) *model.Hint {
	var out *model.Hint
	var best time.Duration
	for i := range hints {
		h := &hints[i]
		if spent(h.ID) || !ok(h) {
			continue
		}
		d, plausible := distance(t, h.Time, window)
		if !plausible {
			continue
		}
		if out == nil || d < best {
			out, best = h, d
		}
	}
	return out
}
