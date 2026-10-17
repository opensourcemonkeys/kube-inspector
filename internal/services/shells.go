package services_k8sclient

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"kube-ins/internal/models"
)

// shellSpec is a discovered shell plus what it takes to start it. Only the
// embedded ShellInfo ever reaches the frontend.
type shellSpec struct {
	models.ShellInfo
	args []string
	// env is appended after everything else, so it wins over inherited values.
	env []string
}

// DiscoverShells lists the shells installed on this machine, default first.
// Not cached: it is cheap, and a shell installed while the app runs should
// show up in the next terminal.
func DiscoverShells() []models.ShellInfo {
	specs := discoverShells(os.Getenv)
	out := make([]models.ShellInfo, len(specs))
	for i, s := range specs {
		out[i] = s.ShellInfo
	}
	return out
}

// resolveShell maps a shell ID from the frontend to a discovered shell. The ID
// is only ever a lookup key: a terminal panel's params can arrive from another
// instance over the IPC hub, so a path in there must never be executed. An
// empty or unknown ID falls back to the default shell.
func resolveShell(specs []shellSpec, id string) (shellSpec, error) {
	if len(specs) == 0 {
		return shellSpec{}, fmt.Errorf("no usable shell found on this system")
	}
	for _, s := range specs {
		if id != "" && s.ID == id {
			return s, nil
		}
	}
	for _, s := range specs {
		if s.Default {
			return s, nil
		}
	}
	return specs[0], nil
}

// finishShellList marks the first shell as the default and sorts the rest by
// name, so the dropdown opens on the default and is predictable below it.
func finishShellList(specs []shellSpec) []shellSpec {
	if len(specs) == 0 {
		return specs
	}
	specs[0].Default = true
	rest := specs[1:]
	sort.SliceStable(rest, func(i, j int) bool {
		return strings.ToLower(rest[i].Name) < strings.ToLower(rest[j].Name)
	})
	return specs
}

// parseEtcShells reads the /etc/shells format: one absolute path per line,
// '#' comments and blank lines ignored.
func parseEtcShells(r io.Reader) []string {
	var paths []string
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line != "" {
			paths = append(paths, line)
		}
	}
	return paths
}

// notInteractiveShells are /etc/shells entries that exist to lock an account
// down rather than to be typed into.
var notInteractiveShells = map[string]bool{
	"nologin":   true,
	"false":     true,
	"true":      true,
	"git-shell": true,
	"rbash":     true,
	"sync":      true,
	"halt":      true,
	"shutdown":  true,
}

// unixShellList turns candidate paths into the shell list. The first usable
// candidate becomes the default, so callers pass the login shell first. Paths
// that resolve to the same file are listed once — on merged-/usr systems
// /etc/shells names /bin/bash and /usr/bin/bash, which are one binary.
func unixShellList(candidates []string, args []string, executable func(string) bool, resolve func(string) (string, error)) []shellSpec {
	var specs []shellSpec
	seen := make(map[string]bool)
	for _, path := range candidates {
		if path == "" || !filepath.IsAbs(path) || notInteractiveShells[filepath.Base(path)] {
			continue
		}
		if !executable(path) {
			continue
		}
		real, err := resolve(path)
		if err != nil {
			continue
		}
		if seen[real] {
			continue
		}
		seen[real] = true
		specs = append(specs, shellSpec{
			ShellInfo: models.ShellInfo{ID: path, Name: filepath.Base(path), Path: path},
			args:      args,
		})
	}

	// Two different binaries with one name (/bin/zsh and a newer
	// /opt/homebrew/bin/zsh) need the path to be told apart.
	count := make(map[string]int)
	for _, s := range specs {
		count[s.Name]++
	}
	for i := range specs {
		if count[specs[i].Name] > 1 {
			specs[i].Name = fmt.Sprintf("%s (%s)", specs[i].Name, specs[i].Path)
		}
	}
	return finishShellList(specs)
}

func isExecutableFile(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0111 != 0
}

// etcShells returns the paths listed in /etc/shells, or nothing.
func etcShells() []string {
	f, err := os.Open("/etc/shells")
	if err != nil {
		return nil
	}
	defer f.Close()
	return parseEtcShells(f)
}
