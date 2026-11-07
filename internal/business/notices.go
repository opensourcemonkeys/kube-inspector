package business

import (
	"embed"
	"fmt"
	"io"
)

// The third-party notices of everything this binary and the frontend it serves
// are built from — the licence texts and NOTICE files the MIT, BSD and Apache
// licences require to travel with a binary. Generated, not tracked:
// scripts/notices/notices.mjs writes THIRD_PARTY_NOTICES.txt here (`make
// notices`, which every packaging target runs before compiling). The tracked
// .gitkeep is what lets the directory embed on a fresh checkout or a plain
// `go build`, the same arrangement as frontend/dist; such a build simply has
// no notices, and says so.
//
// One file for both binaries: kube-inspector-cli links a subset of the Go
// modules and none of the frontend, so its copy over-covers, never under.
//
//go:embed all:assets/notices
var noticesFS embed.FS

const noticesFile = "assets/notices/THIRD_PARTY_NOTICES.txt"

// ThirdPartyNotices returns the embedded notices, or "" in a build made
// without `make notices` (a development build).
func ThirdPartyNotices() string {
	b, err := noticesFS.ReadFile(noticesFile)
	if err != nil {
		return ""
	}
	return string(b)
}

// PrintLicenses implements `--licenses` for both binaries and returns the
// process exit code. It runs before logging, clusters or a window exist.
func PrintLicenses(stdout, stderr io.Writer) int {
	n := ThirdPartyNotices()
	if n == "" {
		_, _ = fmt.Fprintln(stderr, "This build carries no third-party notices (a development build: run `make notices` before building).")
		return 1
	}
	_, _ = io.WriteString(stdout, n)
	return 0
}
