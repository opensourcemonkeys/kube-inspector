//go:build !windows

package services_k8sclient

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"kube-ins/internal/models"
)

func TestParseEtcShells(t *testing.T) {
	in := "# /etc/shells: valid login shells\n\n/bin/sh\n  /bin/bash  \n/usr/bin/zsh # trailing comment\n#/bin/fish\n"
	got := parseEtcShells(strings.NewReader(in))
	want := []string{"/bin/sh", "/bin/bash", "/usr/bin/zsh"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseEtcShells = %v, want %v", got, want)
	}
}

func TestUnixShellList(t *testing.T) {
	// A merged-/usr layout: /bin/bash and /usr/bin/bash are one file, and
	// there are two different zsh binaries.
	files := map[string]string{
		"/bin/bash":             "/usr/bin/bash",
		"/usr/bin/bash":         "/usr/bin/bash",
		"/bin/sh":               "/usr/bin/bash",
		"/usr/bin/zsh":          "/usr/bin/zsh",
		"/opt/homebrew/bin/zsh": "/opt/homebrew/bin/zsh",
		"/usr/sbin/nologin":     "/usr/sbin/nologin",
		"/usr/bin/fish":         "/usr/bin/fish",
	}
	executable := func(p string) bool { _, ok := files[p]; return ok }
	resolve := func(p string) (string, error) {
		if r, ok := files[p]; ok {
			return r, nil
		}
		return "", errors.New("missing")
	}

	candidates := []string{
		"/usr/bin/zsh", // login shell → default
		"/bin/bash", "/bin/sh",
		"/bin/bash", "/usr/bin/bash", "/usr/sbin/nologin", "relative/sh", "/bin/missing",
		"/usr/bin/fish", "/opt/homebrew/bin/zsh",
	}
	got := unixShellList(candidates, []string{"-l"}, executable, resolve)

	var ids, names []string
	for _, s := range got {
		ids = append(ids, s.ID)
		names = append(names, s.Name)
		if !reflect.DeepEqual(s.args, []string{"-l"}) {
			t.Errorf("%s: args = %v, want [-l]", s.ID, s.args)
		}
	}
	wantIDs := []string{"/usr/bin/zsh", "/bin/bash", "/usr/bin/fish", "/opt/homebrew/bin/zsh"}
	if !reflect.DeepEqual(ids, wantIDs) {
		t.Fatalf("ids = %v, want %v", ids, wantIDs)
	}
	wantNames := []string{"zsh (/usr/bin/zsh)", "bash", "fish", "zsh (/opt/homebrew/bin/zsh)"}
	if !reflect.DeepEqual(names, wantNames) {
		t.Fatalf("names = %v, want %v", names, wantNames)
	}
	for i, s := range got {
		if s.Default != (i == 0) {
			t.Errorf("%s: Default = %v", s.ID, s.Default)
		}
	}
}

func TestUnixShellListFallsBackWhenLoginShellIsMissing(t *testing.T) {
	executable := func(p string) bool { return p == "/bin/bash" }
	resolve := func(p string) (string, error) { return p, nil }
	got := unixShellList([]string{"/usr/local/bin/gone", "/bin/bash"}, nil, executable, resolve)
	if len(got) != 1 || got[0].ID != "/bin/bash" || !got[0].Default {
		t.Fatalf("got %+v, want /bin/bash as the default", got)
	}
}

func TestResolveShellNeverRunsAnUnlistedPath(t *testing.T) {
	specs := []shellSpec{
		{ShellInfo: models.ShellInfo{ID: "/bin/bash", Path: "/bin/bash", Default: true}},
		{ShellInfo: models.ShellInfo{ID: "/usr/bin/zsh", Path: "/usr/bin/zsh"}},
	}

	for _, id := range []string{"", "unknown", "/tmp/evil", "/bin/bash -c 'rm -rf ~'"} {
		got, err := resolveShell(specs, id)
		if err != nil {
			t.Fatalf("resolveShell(%q): %v", id, err)
		}
		if got.Path != "/bin/bash" {
			t.Errorf("resolveShell(%q) = %s, want the default /bin/bash", id, got.Path)
		}
	}

	got, err := resolveShell(specs, "/usr/bin/zsh")
	if err != nil || got.Path != "/usr/bin/zsh" {
		t.Fatalf("resolveShell(zsh) = %s, %v", got.Path, err)
	}

	if _, err := resolveShell(nil, ""); err == nil {
		t.Fatal("resolveShell with no shells should fail")
	}
}

func TestDiscoverShellsDefaultsToSHELL(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("no /bin/sh")
	}
	t.Setenv("SHELL", "/bin/sh")
	shells := DiscoverShells()
	if len(shells) == 0 || shells[0].ID != "/bin/sh" || !shells[0].Default {
		t.Fatalf("DiscoverShells() = %+v, want /bin/sh first and default", shells)
	}
}
