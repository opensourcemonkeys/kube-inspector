package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDefaultFilter(t *testing.T) {
	f := Default().Watch.Filter()
	for _, tc := range []struct {
		group, resource string
		want            bool
	}{
		{"apps", "deployments", true},
		{"", "configmaps", true},
		{"", "secrets", true},
		{"cert-manager.io", "certificates", true},
		{"", "events", false},
		{"events.k8s.io", "events", false},
		{"coordination.k8s.io", "leases", false},
		{"discovery.k8s.io", "endpointslices", false},
		{"authentication.k8s.io", "tokenreviews", false},
		{"authorization.k8s.io", "subjectaccessreviews", false},
	} {
		if got := f.AllowsResource(tc.group, tc.resource); got != tc.want {
			t.Errorf("%s.%s: got %v", tc.resource, tc.group, got)
		}
	}
}

func TestLoad(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(`
clusterName: prod
watch:
  include: ["*.apps", "configmaps"]
  exclude: ["replicasets.apps"]
  excludeNamespaces: [kube-system]
enrich:
  delay: 5s
  retryAfter: 1m
  window: 30s
retention:
  changesDays: 30
  auditRawDays: 7
`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLICKHOUSE_PASSWORD", "pw")
	t.Setenv("POD_NAMESPACE", "obs")
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.ClusterName != "prod" || c.Namespace != "obs" || c.ClickHouse.Password != "pw" ||
		c.Enrich.Delay.Duration != 5*time.Second || c.Retention.ChangesDays != 30 || c.HTTPAddr != ":8080" {
		t.Fatalf("config = %+v", c)
	}
	f := c.Watch.Filter()
	if !f.AllowsResource("apps", "deployments") || f.AllowsResource("apps", "replicasets") ||
		!f.AllowsResource("", "configmaps") || f.AllowsResource("", "secrets") || f.AllowsNamespace("kube-system") {
		t.Fatal("filter does not follow config")
	}

	if err := os.WriteFile(p, []byte("enrich:\n  delay: 2m\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err == nil {
		t.Fatal("delay >= retryAfter accepted")
	}
}
