package services_k8sclient

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"kube-ins/internal/models"
)

// ToolboxExportLimit caps one export. Past it a file is not a report anyone
// reads but a copy of the database, which toolbox's own ClickHouse is better at.
const ToolboxExportLimit = 50_000

// toolboxExportPage is toolbox's largest page.
const toolboxExportPage = 1000

// ToolboxExport is an export built in memory, ready to be written.
type ToolboxExport struct {
	Data      []byte
	Rows      int
	Truncated bool
}

// ExportToolboxHistory pages through every change (view "changes") or refused
// write (view "attempts") the filter matches, newest first, up to limit rows,
// and renders them as "csv" or "json".
//
// JSON keeps toolbox's own records as they came (patch included; the stored
// objects are never requested), so nothing is lost in translation. CSV is
// the flat columns a spreadsheet wants.
func ExportToolboxHistory(ctx context.Context, t Toolbox, view string, f models.ToolboxChangeFilter, format string, limit int) (ToolboxExport, error) {
	var path string
	switch view {
	case "changes":
		path = "api/v1/changes"
	case "attempts":
		path = "api/v1/attempts"
	default:
		return ToolboxExport{}, fmt.Errorf("unknown export view %q", view)
	}
	if format != "csv" && format != "json" {
		return ToolboxExport{}, fmt.Errorf("unknown export format %q", format)
	}

	var items []json.RawMessage
	truncated := false
	f.Cursor, f.Limit = "", toolboxExportPage
	for {
		p := changeParams(f)
		if view == "attempts" {
			p = attemptParams(f)
		}
		body, _, err := t.get(ctx, path, p)
		if err != nil {
			return ToolboxExport{}, err
		}
		var page struct {
			Items      []json.RawMessage `json:"items"`
			NextCursor string            `json:"nextCursor"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return ToolboxExport{}, fmt.Errorf("decode toolbox %s: %w", view, err)
		}
		items = append(items, page.Items...)
		if len(items) >= limit {
			truncated = len(items) > limit || page.NextCursor != ""
			items = items[:limit]
			break
		}
		// No cursor: the last page, or an older toolbox that does not page
		// attempts, which then exports its first page only.
		if page.NextCursor == "" || page.NextCursor == f.Cursor {
			break
		}
		f.Cursor = page.NextCursor
	}

	var out []byte
	var err error
	if format == "json" {
		if items == nil {
			items = []json.RawMessage{}
		}
		out, err = json.MarshalIndent(struct {
			View       string            `json:"view"`
			ExportedAt string            `json:"exportedAt"`
			Truncated  bool              `json:"truncated"`
			Items      []json.RawMessage `json:"items"`
		}{view, time.Now().UTC().Format(time.RFC3339), truncated, items}, "", "  ")
	} else {
		out, err = toolboxCSV(view, items)
	}
	if err != nil {
		return ToolboxExport{}, err
	}
	return ToolboxExport{Data: out, Rows: len(items), Truncated: truncated}, nil
}

// csvCell guards a value a spreadsheet would run as a formula. Object names,
// user agents and refusal messages are written by whoever made the request,
// so a leading = + - @ (or a tab/CR that some apps strip first) is defused
// with an apostrophe, which spreadsheets show as text and drop from display.
func csvCell(v string) string {
	if v != "" && strings.ContainsRune("=+-@\t\r", rune(v[0])) {
		return "'" + v
	}
	return v
}

func joinCells(v []string) string { return strings.Join(v, " ") }

func toolboxCSV(view string, items []json.RawMessage) ([]byte, error) {
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	write := func(rec []string) error {
		for i := range rec {
			rec[i] = csvCell(rec[i])
		}
		return w.Write(rec)
	}
	if view == "changes" {
		if err := w.Write([]string{"time", "verb", "group", "apiVersion", "kind", "resource", "namespace", "name", "uid",
			"resourceVersion", "user", "impersonatedBy", "groups", "sourceIPs", "userAgent", "fieldManager",
			"attribution", "changedPaths", "auditId", "eventId"}); err != nil {
			return nil, err
		}
		for _, raw := range items {
			var c models.ToolboxChange
			if err := json.Unmarshal(raw, &c); err != nil {
				return nil, fmt.Errorf("decode toolbox change: %w", err)
			}
			a := c.Actor
			if err := write([]string{c.Time, c.Verb, c.Group, c.APIVersion, c.Kind, c.Resource, c.Namespace, c.Name, c.ObjectUID,
				c.ResourceVersion, a.Username, a.ImpersonatedBy, joinCells(a.Groups), joinCells(a.SourceIPs), a.UserAgent, c.FieldManager,
				c.Attribution, joinCells(c.ChangedPaths), a.AuditID, c.EventID}); err != nil {
				return nil, err
			}
		}
	} else {
		if err := w.Write([]string{"time", "responseCode", "responseReason", "verb", "group", "resource", "subresource",
			"namespace", "name", "user", "impersonatedBy", "groups", "sourceIPs", "userAgent", "requestUri", "message", "auditId"}); err != nil {
			return nil, err
		}
		for _, raw := range items {
			var r models.ToolboxAttempt
			if err := json.Unmarshal(raw, &r); err != nil {
				return nil, fmt.Errorf("decode toolbox attempt: %w", err)
			}
			if err := write([]string{r.Time, strconv.Itoa(int(r.ResponseCode)), r.ResponseReason, r.Verb, r.Group, r.Resource, r.Subresource,
				r.Namespace, r.Name, r.Username, r.ImpersonatedBy, joinCells(r.Groups), joinCells(r.SourceIPs), r.UserAgent, r.RequestURI,
				r.ResponseMessage, r.AuditID}); err != nil {
				return nil, err
			}
		}
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}
