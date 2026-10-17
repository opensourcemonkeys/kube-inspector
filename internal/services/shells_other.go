//go:build !windows && !darwin

package services_k8sclient

import (
	"bufio"
	"os"
	"strings"
)

var fallbackShells = []string{"/bin/bash", "/bin/sh"}

// loginShellArgs: none — the shell starts as an interactive non-login shell,
// as it always has on Linux.
var loginShellArgs []string

// accountLoginShell reads the user's shell from /etc/passwd.
func accountLoginShell(user string) string {
	if user == "" {
		return ""
	}
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return ""
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		// name:password:uid:gid:gecos:home:shell
		fields := strings.Split(sc.Text(), ":")
		if len(fields) == 7 && fields[0] == user {
			return fields[6]
		}
	}
	return ""
}
