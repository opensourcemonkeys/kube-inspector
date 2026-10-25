// Package discovery lists the resources toolbox should watch: every listable,
// watchable top-level resource the API server serves, CRDs included, at its
// preferred version, narrowed by the configured include/exclude patterns.
package discovery

import (
	"log/slog"
	"sort"
	"strings"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"

	"github.com/kubeinspector/toolbox/internal/config"
)

type Resource struct {
	GVR        schema.GroupVersionResource
	Kind       string
	Namespaced bool
}

// Discover returns the resources to watch, sorted by group/resource. A group
// whose discovery failed (an aggregated API whose backend is down, typically)
// is skipped with a warning rather than failing the whole list.
func Discover(dc discovery.DiscoveryInterface, f *config.ResourceFilter) ([]Resource, error) {
	lists, err := dc.ServerPreferredResources()
	if err != nil {
		if !discovery.IsGroupDiscoveryFailedError(err) {
			return nil, err
		}
		slog.Warn("partial discovery failure; affected groups are skipped this round", "err", err)
	}
	var out []Resource
	for _, l := range lists {
		gv, err := schema.ParseGroupVersion(l.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range l.APIResources {
			if strings.Contains(r.Name, "/") || !hasVerbs(r.Verbs, "list", "watch") {
				continue
			}
			if !f.AllowsResource(gv.Group, r.Name) {
				continue
			}
			out = append(out, Resource{GVR: gv.WithResource(r.Name), Kind: r.Kind, Namespaced: r.Namespaced})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].GVR.Group != out[j].GVR.Group {
			return out[i].GVR.Group < out[j].GVR.Group
		}
		return out[i].GVR.Resource < out[j].GVR.Resource
	})
	return out, nil
}

func hasVerbs(have []string, want ...string) bool {
	for _, w := range want {
		found := false
		for _, h := range have {
			if h == w {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
