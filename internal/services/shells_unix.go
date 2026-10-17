//go:build !windows

package services_k8sclient

import "path/filepath"

func discoverShells(getenv func(string) string) []shellSpec {
	login := getenv("SHELL")
	if login == "" {
		// A GUI app started from Finder or a desktop launcher may have no
		// $SHELL at all, so ask the account database.
		login = accountLoginShell(getenv("USER"))
	}

	candidates := append([]string{login}, fallbackShells...)
	candidates = append(candidates, etcShells()...)
	return unixShellList(candidates, loginShellArgs, isExecutableFile, filepath.EvalSymlinks)
}
