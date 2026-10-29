package tui

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"kube-ins/internal/business"
	"kube-ins/internal/models"
)

// hintHistory: the history list has its own keys; its rows are recorded
// changes, not objects, so there is no describe, yaml, edit or delete.
const hintHistory = "[teal]←[-] menu  [teal]/[-] search  [teal]r[-] refresh  [teal]q[-] back"

const historyPage = 100

// historyState is the history view's server-side filter and the pages loaded
// so far. It is shared by the view's def (built once, in buildRegistry); the
// pages are dropped when the cluster changes, the filter is kept.
type historyState struct {
	mu      sync.Mutex
	cluster string
	filter  models.ToolboxChangeFilter
	rows    []rowData
	cursor  string
	pages   int
}

func newHistoryFilter() models.ToolboxChangeFilter {
	return models.ToolboxChangeFilter{Since: "24h", Limit: historyPage}
}

// historyFilterText renders the filter as the k=v line the F prompt edits.
func historyFilterText(f models.ToolboxChangeFilter) string {
	var parts []string
	for _, kv := range [][2]string{{"namespace", f.Namespace}, {"user", f.User}, {"verb", f.Verb}, {"since", f.Since}} {
		if kv[1] != "" {
			parts = append(parts, kv[0]+"="+kv[1])
		}
	}
	return strings.Join(parts, " ")
}

// parseHistoryFilter reads "namespace=prod user=alice verb=update since=7d".
// Keys left out are cleared; since keeps its 24h default unless given ("all"
// lifts it). A day suffix is accepted because a Go duration has none.
func parseHistoryFilter(line string) (models.ToolboxChangeFilter, error) {
	f := newHistoryFilter()
	for _, tok := range strings.Fields(line) {
		k, v, ok := strings.Cut(tok, "=")
		if !ok || v == "" {
			return f, fmt.Errorf("%q: want key=value (namespace, user, verb, since)", tok)
		}
		switch k {
		case "namespace", "ns":
			f.Namespace = v
		case "user":
			f.User = v
		case "verb":
			switch v {
			case "create", "update", "delete", "finalized":
				f.Verb = v
			default:
				return f, fmt.Errorf("verb must be create, update, delete or finalized")
			}
		case "since":
			switch {
			case v == "all":
				f.Since = ""
			case strings.HasSuffix(v, "d"):
				var days int
				if _, err := fmt.Sscanf(v, "%dd", &days); err != nil || days <= 0 {
					return f, fmt.Errorf("since %q: use e.g. 1h, 24h, 7d or all", v)
				}
				f.Since = fmt.Sprintf("%dh", days*24)
			default:
				if _, err := time.ParseDuration(v); err != nil {
					return f, fmt.Errorf("since %q: use e.g. 1h, 24h, 7d or all", v)
				}
				f.Since = v
			}
		default:
			return f, fmt.Errorf("unknown filter %q (namespace, user, verb, since)", k)
		}
	}
	return f, nil
}

func historyRow(c models.ToolboxChange) rowData {
	user := c.Actor.Username
	if user == "" {
		user = "(" + c.FieldManager + ")"
		if c.FieldManager == "" {
			user = "—"
		}
	}
	paths := c.ChangedPaths
	if len(paths) > 3 {
		paths = append(paths[:3:3], "…")
	}
	return rowData{name: c.Name, namespace: c.Namespace, ref: c, cells: []string{
		humanSince(c.Time), c.Verb, c.Kind, dash(c.Namespace), c.Name, user, c.Attribution, strings.Join(paths, " "),
	}}
}

// historyDef is the Cluster History view: toolbox's recorded changes, newest
// first, filtered on the server (F) and paged (M), with an undo (U) that
// writes back the version before a change after a dry run says it would be
// accepted.
//
// Only the first page refreshes: once more pages are loaded, a refresh would
// throw them away, the same rule as the GUI's list.
func historyDef() *resourceDef {
	st := &historyState{filter: newHistoryFilter()}
	def := &resourceDef{
		view: "history", title: "Cluster History", namespaced: true, noDescribe: true, hints: hintHistory,
		headers: []string{"AGE", "VERB", "KIND", "NAMESPACE", "NAME", "USER", "VIA", "CHANGED"},
	}
	retitle := func() {
		def.title = "Cluster History"
		if f := historyFilterText(st.filter); f != "" {
			def.title += " · " + f
		}
	}
	retitle()

	def.list = func(cluster string) ([]rowData, error) {
		st.mu.Lock()
		defer st.mu.Unlock()
		// Another cluster: its own pages. The filter stays, and with it the
		// title — which is only ever set on the UI thread (F), never here, on
		// the refresh goroutine.
		if cluster != st.cluster {
			st.cluster, st.rows, st.cursor, st.pages = cluster, nil, "", 0
		}
		if st.pages > 1 {
			return st.rows, nil
		}
		page, err := business.GetToolboxChanges(cluster, st.filter)
		if err != nil {
			return nil, err
		}
		st.rows = st.rows[:0]
		for _, c := range page.Items {
			st.rows = append(st.rows, historyRow(c))
		}
		st.cursor, st.pages = page.NextCursor, 1
		return st.rows, nil
	}

	def.actions = []rowAction{
		{key: 'F', label: "filter", custom: func(a *App, _ *rowData, reload func()) {
			st.mu.Lock()
			current := historyFilterText(st.filter)
			st.mu.Unlock()
			a.prompt("Filter: namespace= user= verb= since=", "filter", current, func(line string) {
				f, err := parseHistoryFilter(line)
				if err != nil {
					a.flash("Filter", err.Error(), colWarn)
					return
				}
				st.mu.Lock()
				st.filter, st.pages = f, 0
				retitle()
				st.mu.Unlock()
				// Remounted rather than reloaded, so the breadcrumb shows the
				// new filter too.
				a.loadResource(def.view)
			})
		}},
		{key: 'M', label: "more", custom: func(a *App, _ *rowData, reload func()) {
			st.mu.Lock()
			f, cursor, cluster := st.filter, st.cursor, st.cluster
			st.mu.Unlock()
			if cursor == "" {
				a.flash("History", "No older changes match this filter.", colMuted)
				return
			}
			f.Cursor = cursor
			page, err := business.GetToolboxChanges(cluster, f)
			if err != nil {
				a.flash("Error", err.Error(), colDanger)
				return
			}
			st.mu.Lock()
			for _, c := range page.Items {
				st.rows = append(st.rows, historyRow(c))
			}
			st.cursor = page.NextCursor
			st.pages++
			st.mu.Unlock()
			reload()
		}},
		{key: 'U', label: "undo", custom: func(a *App, row *rowData, reload func()) {
			if row == nil {
				return
			}
			c, ok := row.ref.(models.ToolboxChange)
			if !ok {
				return
			}
			undoChange(a, c, reload)
		}},
	}
	return def
}

// undoChange writes back the version from before c. The API server is asked
// first with a dry run, and the confirmation names what will be written and
// says the dry run passed; a refusal is shown instead and nothing is offered.
func undoChange(a *App, c models.ToolboxChange, reload func()) {
	if c.Verb == "create" {
		a.flash("Undo", "This change created the object; there is no earlier version to restore.", colWarn)
		return
	}
	target := c.Kind + " " + c.Name
	if c.Namespace != "" {
		target = c.Kind + " " + c.Namespace + "/" + c.Name
	}
	if _, err := business.DryRunToolboxRollback(a.cluster, c.EventID, "before"); err != nil {
		a.flash("Undo refused", "The API server would not accept restoring "+target+":\n\n"+err.Error(), colDanger)
		return
	}
	user := c.Actor.Username
	if user == "" {
		user = "(" + c.FieldManager + ")"
	}
	paths := strings.Join(c.ChangedPaths, ", ")
	if len(paths) > 160 {
		paths = paths[:160] + "…"
	}
	if paths == "" {
		paths = "—"
	}
	msg := fmt.Sprintf("Undo this change?\n\n%s\n%s %s ago by %s\nchanged: %s\n\n%s is replaced with its version from before this change; "+
		"fields added since are removed.\n\nDry run: the API server accepts it.",
		target, c.Verb, humanSince(c.Time), user, paths, target)
	a.confirm(msg, func() {
		out, err := business.RollbackToolboxChange(a.cluster, c.EventID, "before")
		if err != nil {
			a.flash("Error", err.Error(), colDanger)
			return
		}
		a.flash("Undone", out+"\n\ntoolbox records the undo itself after its enrich delay.", colOk)
		reload()
	})
}
