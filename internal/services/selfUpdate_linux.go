package services_k8sclient

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// installRoot is where the deb/rpm puts the app tree (see build/nfpm.yaml). A
// build running from anywhere else is a dev tree or a hand-extracted copy, and
// handing a package to dpkg/rpm would not update it.
const installRoot = "/opt/kube-inspector"

// PlatformAssetKey returns the key to look up in the manifest's "assets" map
// for this machine, plus the installer kind it maps to. Debian and RPM systems
// take different packages, so the key depends on which package manager exists.
func PlatformAssetKey() (key string, kind string) {
	if _, err := exec.LookPath("dpkg"); err == nil {
		return "linux-deb", "deb"
	}
	if _, err := exec.LookPath("rpm"); err == nil {
		return "linux-rpm", "rpm"
	}
	return "", ""
}

// CheckInstallable reports why the in-app updater cannot apply a release here,
// or nil when it can. The app lives under a root-owned /opt tree managed by
// dpkg/rpm, so updating means asking the package manager to do it as root —
// which needs pkexec.
func CheckInstallable() error {
	if key, _ := PlatformAssetKey(); key == "" {
		return errors.New("no supported package manager (dpkg or rpm) was found")
	}
	if _, err := exec.LookPath("pkexec"); err != nil {
		return errors.New("pkexec (polkit) is not installed, so the update cannot be applied with administrator rights")
	}

	exe, err := os.Executable()
	if err != nil {
		return errors.New("could not determine the running executable's location")
	}
	if !strings.HasPrefix(exe, installRoot+"/") {
		return fmt.Errorf("this build is not running from %s, so it was not installed from a package", installRoot)
	}
	return nil
}

// installCommand picks the command that installs the package, as root through
// pkexec. lookPath is exec.LookPath outside tests.
//
// The dependency-resolving front ends come first, because the package declares
// Depends (build/nfpm.yaml) and neither dpkg -i nor rpm -U installs a missing
// one. rpm then refuses and changes nothing, which is merely a failed update.
// dpkg is worse: it unpacks the new files *before* failing on the dependency
// and leaves the package unconfigured, so postinst never runs, chrome-sandbox
// loses its setuid bit and the app no longer starts at all.
//
// Both front ends are told to fetch nothing optional (no Recommends, no weak
// deps) and dnf to skip an unreachable repository: when every dependency is
// already installed — always true for the libraries, since the running app
// links them — the update needs no network beyond the download it already made,
// exactly like the dpkg/rpm path. apt-get never refreshes its lists on install;
// dnf does once its metadata has expired, and then fails the whole transaction
// on an unreachable mirror unless told to skip it.
//
// The skip is `*.skip_if_unavailable`, per repository, not the global option:
// Fedora's .repo files set skip_if_unavailable=False on each repo, and a
// repo-level value overrides the global one — the global form was measured to
// still fail offline on Fedora 44 (dnf5), while the glob passes there and is
// accepted by RHEL 9's dnf 4.14. No shell is involved, so the * reaches dnf
// literally.
//
// Where neither front end exists (yum-only, zypper) the low-level tool remains;
// rpm's refusal on a missing dependency changes nothing and is safe.
func installCommand(kind, pkgPath string, lookPath func(string) (string, error)) ([]string, error) {
	have := func(bin string) bool { _, err := lookPath(bin); return err == nil }
	switch kind {
	case "deb":
		if have("apt-get") {
			// apt-get treats the argument as a local file only because the path
			// contains a slash; RunInstaller passes an absolute one.
			return []string{"pkexec", "apt-get", "install", "-y", "--no-install-recommends", pkgPath}, nil
		}
		return []string{"pkexec", "dpkg", "-i", pkgPath}, nil
	case "rpm":
		if have("dnf") {
			// Installing the version already present is "Nothing to do" and exits
			// 0, which keeps a retry after a failed run working — the job
			// --replacepkgs does for rpm below.
			return []string{"pkexec", "dnf", "install", "-y",
				"--setopt=install_weak_deps=False", "--setopt=*.skip_if_unavailable=True", pkgPath}, nil
		}
		// --replacepkgs lets a reinstall of the same version succeed instead of
		// erroring out, which keeps a retry after a failed run working.
		return []string{"pkexec", "rpm", "-Uvh", "--replacepkgs", pkgPath}, nil
	}
	return nil, fmt.Errorf("unsupported package kind %q", kind)
}

// RunInstaller hands the downloaded package to the system package manager under
// pkexec and waits for it to finish. Running it synchronously matters: the
// caller quits the app right after this returns, and a root package manager
// started as our child would otherwise still be mid-transaction. Waiting also
// lets the postinstall script restore chrome-sandbox's setuid bit before we
// relaunch — Electron refuses to start without it.
func RunInstaller(ctx context.Context, pkgPath, kind string) (string, error) {
	abs, err := filepath.Abs(pkgPath)
	if err != nil {
		return "", fmt.Errorf("could not resolve the downloaded package path: %w", err)
	}
	args, err := installCommand(kind, abs, exec.LookPath)
	if err != nil {
		return "", err
	}

	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// pkexec exits 126 when the user dismisses the authentication dialog
		// and 127 when authorisation is denied outright.
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			switch exitErr.ExitCode() {
			case 126:
				return "", errors.New("installation was cancelled at the password prompt")
			case 127:
				return "", errors.New("not authorised to install the update")
			}
		}
		return "", fmt.Errorf("%s failed: %v\n%s", args[1], err, strings.TrimSpace(string(out)))
	}

	return RestartRelaunch, nil
}

// KeepPackageAfterInstall reports whether the installer is still reading the
// downloaded package after RunInstaller returns.
//
// False here, and only here: the Linux path runs the package manager through
// CombinedOutput and therefore waits for it, so by the time RunInstaller
// returns the ~190 MB package is safe to delete. Windows and macOS both detach
// their installer and are still reading it.
func KeepPackageAfterInstall() bool { return false }
