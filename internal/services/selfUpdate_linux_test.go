package services_k8sclient

import (
	"errors"
	"slices"
	"testing"
)

// fakeLookPath reports only the named programs as installed.
func fakeLookPath(installed ...string) func(string) (string, error) {
	return func(bin string) (string, error) {
		if slices.Contains(installed, bin) {
			return "/usr/bin/" + bin, nil
		}
		return "", errors.New("not found")
	}
}

// The package declares Depends, which dpkg -i and rpm -U do not install — and
// dpkg leaves a half-configured package behind (no postinst, so chrome-sandbox
// loses setuid and the app stops starting). The resolving front end must win
// whenever it exists.
func TestInstallCommandPrefersResolvingFrontEnd(t *testing.T) {
	const pkg = "/tmp/kube-ins-update-1/kube-inspector-1.0.0-linux-amd64.deb"
	cases := []struct {
		name      string
		kind      string
		installed []string
		want      []string
	}{
		{
			name:      "deb with apt-get",
			kind:      "deb",
			installed: []string{"dpkg", "apt-get", "pkexec"},
			want:      []string{"pkexec", "apt-get", "install", "-y", "--no-install-recommends", pkg},
		},
		{
			name:      "deb without apt-get falls back to dpkg",
			kind:      "deb",
			installed: []string{"dpkg", "pkexec"},
			want:      []string{"pkexec", "dpkg", "-i", pkg},
		},
		{
			name:      "rpm with dnf",
			kind:      "rpm",
			installed: []string{"rpm", "dnf", "pkexec"},
			// The *. prefix is load-bearing: Fedora sets skip_if_unavailable=False
			// per repo, which beats the global option and failed offline updates.
			want: []string{"pkexec", "dnf", "install", "-y",
				"--setopt=install_weak_deps=False", "--setopt=*.skip_if_unavailable=True", pkg},
		},
		{
			name:      "rpm without dnf (zypper, yum) falls back to rpm",
			kind:      "rpm",
			installed: []string{"rpm", "zypper", "pkexec"},
			want:      []string{"pkexec", "rpm", "-Uvh", "--replacepkgs", pkg},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := installCommand(tc.kind, pkg, fakeLookPath(tc.installed...))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !slices.Equal(got, tc.want) {
				t.Fatalf("command:\n got  %q\n want %q", got, tc.want)
			}
		})
	}
}

// A mismatched pair (a deb asset on an rpm system) must not pick a tool by
// accident: the kind decides the family, the installed tools only the member.
func TestInstallCommandFamilyFollowsKind(t *testing.T) {
	all := fakeLookPath("dpkg", "apt-get", "rpm", "dnf")
	deb, _ := installCommand("deb", "/p.deb", all)
	rpm, _ := installCommand("rpm", "/p.rpm", all)
	if deb[1] != "apt-get" || rpm[1] != "dnf" {
		t.Fatalf("deb → %q, rpm → %q", deb[1], rpm[1])
	}
}

func TestInstallCommandRejectsUnknownKind(t *testing.T) {
	if _, err := installCommand("appimage", "/p", fakeLookPath("dpkg", "rpm")); err == nil {
		t.Fatal("an unknown package kind must be refused, not handed to a package manager")
	}
}
