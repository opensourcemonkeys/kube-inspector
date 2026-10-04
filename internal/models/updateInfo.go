package models

// UpdateInfo is the result of checking the published version manifest against
// the running app's version.
type UpdateInfo struct {
	Available      bool   `json:"available"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	DownloadURL    string `json:"downloadUrl"`

	// AssetURL is the direct download for this platform's installer, resolved
	// from the manifest's "assets" map. Empty when the manifest has no asset
	// for the running OS/arch.
	AssetURL string `json:"assetUrl"`
	// AssetKind tells the installer how to apply the download: deb, rpm, nsis
	// or dmg.
	AssetKind string `json:"assetKind"`
	// Installable reports whether the in-app updater can actually download and
	// apply this release here. When false the UI falls back to opening
	// DownloadURL in the browser.
	Installable bool `json:"installable"`
	// NotInstallableReason explains a false Installable, for the UI to show.
	NotInstallableReason string `json:"notInstallableReason"`

	// Channel is the update channel this result came from: "stable" or "beta".
	Channel string `json:"channel"`
	// AheadOfChannel is true when the running build is newer than the newest
	// release on the selected channel — what happens when a beta user switches
	// to stable. Nothing is installed; the app never downgrades itself.
	AheadOfChannel bool `json:"aheadOfChannel"`

	// FailedUpdateVersion is set once, on the first check after an update that
	// did not take: the app is running an older version than the one it tried to
	// install. Empty in every other case, including a successful update.
	FailedUpdateVersion string `json:"failedUpdateVersion"`
	// FailedUpdateLog is the tail of the macOS swap helper's log when there is
	// one. That helper runs after the app has quit, so the file is its only
	// channel back. Empty on other platforms.
	FailedUpdateLog string `json:"failedUpdateLog"`
}

// UpdateProgress is streamed to the frontend while a self-update runs. Phase is
// "download" or "install"; Total is -1 when the server sent no Content-Length,
// which the UI renders as an indeterminate bar.
type UpdateProgress struct {
	Phase    string  `json:"phase"`
	Received int64   `json:"received"`
	Total    int64   `json:"total"`
	Percent  float64 `json:"percent"`
}

// ChangelogEntry is one released version's notes, from the site's
// changelog.json (generated from CHANGELOG.md by mkdocs_hooks.py).
type ChangelogEntry struct {
	Version  string             `json:"version"`
	Date     string             `json:"date"`
	Summary  string             `json:"summary"` // the prose above the first section; may hold several paragraphs
	Sections []ChangelogSection `json:"sections"`
}

// ChangelogSection is one Keep-a-Changelog heading (Added, Changed, Fixed, ...)
// and its bullets. Items are Markdown; the UI renders the inline subset.
type ChangelogSection struct {
	Name  string   `json:"name"`
	Items []string `json:"items"`
}
