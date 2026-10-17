package services_k8sclient

import (
	"os"
	"os/exec"
	"path/filepath"

	"kube-ins/internal/models"
)

func discoverShells(getenv func(string) string) []shellSpec {
	sysRoot := getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	system32 := filepath.Join(sysRoot, "System32")

	var specs []shellSpec
	add := func(id, name, path string, args []string, env []string) {
		specs = append(specs, shellSpec{
			ShellInfo: models.ShellInfo{ID: id, Name: name, Path: path},
			args:      args,
			env:       env,
		})
	}

	// Order is the default preference: PowerShell 7 when installed, otherwise
	// the Windows PowerShell every Windows ships with.
	if p := firstExisting(pwshCandidates(getenv)...); p != "" {
		add("pwsh", "PowerShell 7", p, []string{"-NoLogo"}, nil)
	}
	if p := firstExisting(filepath.Join(system32, `WindowsPowerShell\v1.0\powershell.exe`)); p != "" {
		add("powershell", "Windows PowerShell", p, []string{"-NoLogo"}, nil)
	}
	if p := firstExisting(getenv("ComSpec"), filepath.Join(system32, "cmd.exe")); p != "" {
		add("cmd", "Command Prompt", p, nil, nil)
	}
	if p := firstExisting(gitBashCandidates(getenv)...); p != "" {
		add("git-bash", "Git Bash", p, []string{"--login", "-i"}, nil)
	}
	if p := firstExisting(filepath.Join(system32, "wsl.exe")); p != "" {
		// The session's KUBECONFIG is a ';'-separated list of Windows paths.
		// WSLENV's /l flag hands it to Linux as a translated path list, so the
		// panel's cluster selection keeps working inside WSL.
		wslenv := "KUBECONFIG/l"
		if inherited := getenv("WSLENV"); inherited != "" {
			wslenv = inherited + ":" + wslenv
		}
		add("wsl", "WSL", p, nil, []string{"WSLENV=" + wslenv})
	}

	return finishShellList(specs)
}

func pwshCandidates(getenv func(string) string) []string {
	var c []string
	if p, err := exec.LookPath("pwsh.exe"); err == nil {
		c = append(c, p)
	}
	for _, root := range []string{getenv("ProgramFiles"), getenv("ProgramW6432")} {
		if root != "" {
			c = append(c, filepath.Join(root, `PowerShell\7\pwsh.exe`))
		}
	}
	return c
}

func gitBashCandidates(getenv func(string) string) []string {
	var c []string
	for _, root := range []string{getenv("ProgramFiles"), getenv("ProgramW6432")} {
		if root != "" {
			c = append(c, filepath.Join(root, `Git\bin\bash.exe`))
		}
	}
	if local := getenv("LOCALAPPDATA"); local != "" {
		c = append(c, filepath.Join(local, `Programs\Git\bin\bash.exe`))
	}
	// A Git installed anywhere else: git.exe lives in <root>\cmd.
	if git, err := exec.LookPath("git.exe"); err == nil {
		c = append(c, filepath.Join(filepath.Dir(filepath.Dir(git)), `bin\bash.exe`))
	}
	return c
}

func firstExisting(paths ...string) string {
	for _, p := range paths {
		if p == "" {
			continue
		}
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
			return p
		}
	}
	return ""
}
