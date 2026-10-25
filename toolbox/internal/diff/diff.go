// Package diff turns two versions of an object into what is stored: a
// sanitised copy of each, an RFC 6902 patch between them, and the paths that
// changed. It also computes the content hash that pins an admission request to
// the change the informer later observes.
package diff

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"

	"github.com/wI2L/jsondiff"
)

// lastApplied is kubectl's copy of the whole applied manifest. On a Secret it
// is a second copy of the secret data, so it is redacted like data is.
const lastApplied = "kubectl.kubernetes.io/last-applied-configuration"

// Sanitize returns a deep copy of obj fit for storage: managedFields dropped
// (bulky, and summarised separately as the field manager) and, for core
// Secrets, every value redacted to a short hash so a diff still shows that a
// key changed without recording what it changed to.
func Sanitize(obj map[string]any, group, resource string) map[string]any {
	if obj == nil {
		return nil
	}
	out := deepCopy(obj)
	if md, ok := out["metadata"].(map[string]any); ok {
		delete(md, "managedFields")
	}
	if group == "" && resource == "secrets" {
		redactSecret(out)
	}
	return out
}

func redactSecret(obj map[string]any) {
	for _, field := range []string{"data", "stringData"} {
		m, ok := obj[field].(map[string]any)
		if !ok {
			continue
		}
		for k, v := range m {
			m[k] = redact(v)
		}
	}
	if md, ok := obj["metadata"].(map[string]any); ok {
		if ann, ok := md["annotations"].(map[string]any); ok {
			if v, ok := ann[lastApplied]; ok {
				ann[lastApplied] = redact(v)
			}
		}
	}
}

func redact(v any) string {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:6])
}

// noise is removed before diffing: it changes on every write and says nothing
// about what the writer changed.
func stripNoise(obj map[string]any) map[string]any {
	if obj == nil {
		return nil
	}
	out := deepCopy(obj)
	if md, ok := out["metadata"].(map[string]any); ok {
		delete(md, "resourceVersion")
		delete(md, "generation")
		delete(md, "managedFields")
	}
	return out
}

// Result is the stored form of one change.
type Result struct {
	Patch        string
	ChangedPaths []string
	// StatusOnly is true when every changed path is under /status.
	StatusOnly bool
	// Empty is true when nothing but resourceVersion-like noise changed.
	Empty bool
}

// Compute diffs two sanitised objects; either may be nil (create, delete).
func Compute(before, after map[string]any) (Result, error) {
	a, b := stripNoise(before), stripNoise(after)
	var src, dst any = a, b
	if a == nil {
		src = map[string]any{}
	}
	if b == nil {
		dst = map[string]any{}
	}
	patch, err := jsondiff.Compare(src, dst, jsondiff.Invertible())
	if err != nil {
		return Result{}, err
	}
	if len(patch) == 0 {
		return Result{Empty: true, Patch: "[]"}, nil
	}
	raw, err := json.Marshal(patch)
	if err != nil {
		return Result{}, err
	}
	seen := map[string]bool{}
	statusOnly := true
	var paths []string
	for _, op := range patch {
		if op.Type == jsondiff.OperationTest {
			continue
		}
		p := op.Path
		if !seen[p] {
			seen[p] = true
			paths = append(paths, p)
		}
		if p != "/status" && !strings.HasPrefix(p, "/status/") {
			statusOnly = false
		}
	}
	sort.Strings(paths)
	return Result{Patch: string(raw), ChangedPaths: paths, StatusOnly: statusOnly}, nil
}

// ContentHash identifies the content a write persists, independent of the
// fields the API server assigns at or after admission (resourceVersion,
// managedFields) and of status, which the main resource's update strategy
// overwrites with the stored value anyway. The admission webhook hashes the
// object it is asked to admit; the correlator hashes the object the informer
// sees afterwards; equal hashes mean the same write.
func ContentHash(obj map[string]any) string {
	if obj == nil {
		return ""
	}
	c := deepCopy(obj)
	delete(c, "status")
	if md, ok := c["metadata"].(map[string]any); ok {
		delete(md, "resourceVersion")
		delete(md, "managedFields")
	}
	b, _ := json.Marshal(c) // map keys are sorted: canonical
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:16])
}

// Writer returns the field manager that made the write turning before into
// after, which is the best we can say about who wrote an object when no hint
// matched. The API server stamps the writing manager's entry with the current
// time whenever its write changes the object, so that is the entry that is new
// or re-stamped; when none is (the same manager wrote twice within the
// second-granular timestamp), the newest entry is the best guess.
func Writer(before, after map[string]any) string {
	prev := map[string]string{}
	for _, e := range managedEntries(before) {
		prev[e.key] = e.time
	}
	var stamped, newest managedEntry
	for _, e := range managedEntries(after) {
		// RFC 3339 timestamps compare correctly as strings.
		if e.time >= newest.time {
			newest = e
		}
		if t, ok := prev[e.key]; (!ok || t != e.time) && e.time >= stamped.time {
			stamped = e
		}
	}
	if stamped.manager != "" {
		return stamped.manager
	}
	return newest.manager
}

type managedEntry struct{ key, manager, time string }

func managedEntries(obj map[string]any) []managedEntry {
	md, _ := obj["metadata"].(map[string]any)
	raw, _ := md["managedFields"].([]any)
	out := make([]managedEntry, 0, len(raw))
	for _, e := range raw {
		m, _ := e.(map[string]any)
		mgr, _ := m["manager"].(string)
		if mgr == "" {
			continue
		}
		op, _ := m["operation"].(string)
		sub, _ := m["subresource"].(string)
		t, _ := m["time"].(string)
		out = append(out, managedEntry{key: mgr + "\x00" + op + "\x00" + sub, manager: mgr, time: t})
	}
	return out
}

func deepCopy(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = copyValue(v)
	}
	return out
}

func copyValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return deepCopy(t)
	case []any:
		s := make([]any, len(t))
		for i, e := range t {
			s[i] = copyValue(e)
		}
		return s
	default:
		return v
	}
}
