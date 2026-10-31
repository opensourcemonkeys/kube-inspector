package business

import (
	"kube-ins/internal/models"
	"runtime"
	runtimedebug "runtime/debug"
)

var appVersion = "0.6.3-alpha"

var trackedDeps = []string{
	"github.com/wailsapp/wails/v2",
	"k8s.io/client-go",
	"k8s.io/api",
	"k8s.io/apimachinery",
	"github.com/creack/pty",
	"sigs.k8s.io/yaml",
	"github.com/wailsapp/mimetype",
	"github.com/aquasecurity/trivy",
}

func GetAppInfo() models.AppInfo {
	info := models.AppInfo{
		AppVersion: appVersion,
		GoVersion:  runtime.Version(),
	}

	buildInfo, ok := runtimedebug.ReadBuildInfo()
	if !ok {
		return info
	}

	// The toolchain stamps these when it can; `go run` and -buildvcs=false
	// leave them out, so both stay optional everywhere they are consumed.
	for _, s := range buildInfo.Settings {
		switch s.Key {
		case "vcs.revision":
			info.Commit = s.Value
		case "vcs.time":
			info.BuildDate = s.Value
		}
	}

	tracked := make(map[string]bool, len(trackedDeps))
	for _, d := range trackedDeps {
		tracked[d] = true
	}

	for _, dep := range buildInfo.Deps {
		if !tracked[dep.Path] {
			continue
		}
		v := dep.Version
		if dep.Replace != nil {
			v = dep.Replace.Version
		}
		info.Dependencies = append(info.Dependencies, models.DependencyInfo{
			Name:    dep.Path,
			Version: v,
		})
	}

	return info
}
