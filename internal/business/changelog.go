package business

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"kube-ins/internal/models"
)

// Published by the docs build (mkdocs_hooks.py) beside version.json, from the
// same CHANGELOG.md that renders https://kubeinspector.com/changelog/. The app
// reads this rather than scraping that page, whose markup belongs to the theme.
const defaultChangelogURL = "https://kubeinspector.com/changelog.json"

// changelogURL is overridable for local testing, like KUBE_INS_UPDATE_MANIFEST.
func changelogURL() string {
	if u := os.Getenv("KUBE_INS_CHANGELOG_URL"); u != "" {
		return u
	}
	return defaultChangelogURL
}

// GetChangelog returns the notes for every release the user would gain by
// moving from `from` to `to`: newer than `from`, up to and including `to`,
// newest first. Releases skipped in between are included on purpose — their
// changes arrive with the update too.
//
// Unlike CheckForUpdate this reports errors: the update dialog falls back to a
// link to the changelog page, which is better than an empty "What's new".
func GetChangelog(from, to string) ([]models.ChangelogEntry, error) {
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(changelogURL())
	if err != nil {
		return nil, fmt.Errorf("fetch changelog: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch changelog: %s", resp.Status)
	}
	var doc struct {
		Versions []models.ChangelogEntry `json:"versions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("parse changelog: %w", err)
	}
	return filterChangelog(doc.Versions, from, to), nil
}

// filterChangelog keeps the entries in (from, to], drops the Internal section
// (developer notes: tests, refactors), and drops a version left with nothing
// to show. An unparsable version string never matches, so a malformed entry
// cannot leak into the dialog.
func filterChangelog(entries []models.ChangelogEntry, from, to string) []models.ChangelogEntry {
	out := []models.ChangelogEntry{}
	for _, e := range entries {
		if !isNewer(e.Version, from) || isNewer(e.Version, to) {
			continue
		}
		sections := make([]models.ChangelogSection, 0, len(e.Sections))
		for _, s := range e.Sections {
			if strings.EqualFold(strings.TrimSpace(s.Name), "internal") || len(s.Items) == 0 {
				continue
			}
			sections = append(sections, s)
		}
		if len(sections) == 0 && strings.TrimSpace(e.Summary) == "" {
			continue
		}
		e.Sections = sections
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return isNewer(out[i].Version, out[j].Version) })
	return out
}
