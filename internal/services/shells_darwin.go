package services_k8sclient

import (
	"os/exec"
	"strings"
)

// zsh has been the macOS default since Catalina.
var fallbackShells = []string{"/bin/zsh", "/bin/bash", "/bin/sh"}

// loginShellArgs: an app launched from Finder or the Dock inherits launchd's
// bare PATH (/usr/bin:/bin:/usr/sbin:/sbin). A login shell runs /etc/zprofile's
// path_helper and the user's profile, which is what puts Homebrew — and kubectl
// with it — on PATH. zsh, bash, fish and sh all accept -l.
var loginShellArgs = []string{"-l"}

// accountLoginShell reads the user's shell from Directory Services.
func accountLoginShell(user string) string {
	if user == "" {
		return ""
	}
	out, err := exec.Command("/usr/bin/dscl", ".", "-read", "/Users/"+user, "UserShell").Output()
	if err != nil {
		return ""
	}
	// "UserShell: /bin/zsh"
	if _, shell, ok := strings.Cut(strings.TrimSpace(string(out)), ":"); ok {
		return strings.TrimSpace(shell)
	}
	return ""
}
