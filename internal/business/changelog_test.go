package business

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"kube-ins/internal/models"
)

func entry(ver string, sections ...models.ChangelogSection) models.ChangelogEntry {
	return models.ChangelogEntry{Version: ver, Sections: sections}
}

func section(name string, items ...string) models.ChangelogSection {
	return models.ChangelogSection{Name: name, Items: items}
}

func versions(entries []models.ChangelogEntry) []string {
	out := []string{}
	for _, e := range entries {
		out = append(out, e.Version)
	}
	return out
}

func TestFilterChangelogRange(t *testing.T) {
	all := []models.ChangelogEntry{
		entry("v0.17.0-beta", section("Added", "a")),
		entry("v0.16.1-beta", section("Fixed", "b")),
		entry("v0.16.0-beta", section("Added", "c")),
		entry("v0.15.0-alpha", section("Added", "d")),
		entry("not-a-version", section("Added", "e")),
	}
	// from is excluded, to included, and the release skipped in between is kept.
	got := versions(filterChangelog(all, "0.15.0-alpha", "v0.17.0-beta"))
	if want := []string{"v0.17.0-beta", "v0.16.1-beta", "v0.16.0-beta"}; !reflect.DeepEqual(got, want) {
		t.Errorf("range = %v, want %v", got, want)
	}
	// Nothing beyond the version on offer, even if the file already lists it.
	if got := versions(filterChangelog(all, "v0.16.0-beta", "v0.16.1-beta")); !reflect.DeepEqual(got, []string{"v0.16.1-beta"}) {
		t.Errorf("single step = %v", got)
	}
	// A dev build's unparsable version matches nothing rather than everything.
	if got := filterChangelog(all, "dev", "v0.17.0-beta"); len(got) != 0 {
		t.Errorf("unparsable from = %v, want none", versions(got))
	}
}

func TestFilterChangelogDropsInternal(t *testing.T) {
	all := []models.ChangelogEntry{
		entry("v0.17.0-beta", section("Added", "user-facing"), section("Internal", "refactor")),
		// Only developer notes: nothing for the dialog to show.
		entry("v0.16.1-beta", section(" internal ", "tests")),
		{Version: "v0.16.0-beta", Summary: "A prose-only release.", Sections: []models.ChangelogSection{section("Internal", "x")}},
	}
	got := filterChangelog(all, "v0.15.0", "v0.17.0-beta")
	if want := []string{"v0.17.0-beta", "v0.16.0-beta"}; !reflect.DeepEqual(versions(got), want) {
		t.Fatalf("versions = %v, want %v", versions(got), want)
	}
	if want := []models.ChangelogSection{section("Added", "user-facing")}; !reflect.DeepEqual(got[0].Sections, want) {
		t.Errorf("sections = %+v, want Internal dropped", got[0].Sections)
	}
}

func TestGetChangelog(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/changelog.json":
			w.Write([]byte(`{"versions":[
				{"version":"v0.17.0-beta","date":"2026-09-27","summary":"A terminal release.","sections":[{"name":"Added","items":["**Node shell.**"]}]},
				{"version":"v0.16.1-beta","date":"2026-09-20","summary":"","sections":[{"name":"Fixed","items":["x"]}]}]}`))
		case "/broken.json":
			w.Write([]byte(`{"versions":`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	t.Setenv("KUBE_INS_CHANGELOG_URL", srv.URL+"/changelog.json")
	got, err := GetChangelog("v0.16.1-beta", "v0.17.0-beta")
	if err != nil {
		t.Fatal(err)
	}
	want := []models.ChangelogEntry{{Version: "v0.17.0-beta", Date: "2026-09-27", Summary: "A terminal release.",
		Sections: []models.ChangelogSection{section("Added", "**Node shell.**")}}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("changelog = %+v", got)
	}

	// A site not yet redeployed with changelog.json, and a truncated file,
	// are errors: the dialog then links to the changelog page instead.
	for _, path := range []string{"/missing.json", "/broken.json"} {
		t.Setenv("KUBE_INS_CHANGELOG_URL", srv.URL+path)
		if _, err := GetChangelog("v0.16.1-beta", "v0.17.0-beta"); err == nil {
			t.Errorf("%s: want an error", path)
		}
	}
}
