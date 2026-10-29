// Package config loads toolbox's configuration: a YAML file (mounted from the
// Helm chart's ConfigMap) with secrets and per-pod values supplied through the
// environment.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"strings"
	"time"

	"sigs.k8s.io/yaml"
)

// Duration is a time.Duration that reads "15s"-style strings from YAML.
type Duration struct{ time.Duration }

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("duration must be a string like \"15s\": %w", err)
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return err
	}
	d.Duration = v
	return nil
}

func (d Duration) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }

type Config struct {
	// ClusterName tags every row, so one ClickHouse can serve several clusters.
	ClusterName string `json:"clusterName"`
	// Namespace is where toolbox itself runs (POD_NAMESPACE).
	Namespace string `json:"namespace"`

	HTTPAddr    string `json:"httpAddr"`    // REST API, health, metrics
	WebhookAddr string `json:"webhookAddr"` // TLS: /admission and /audit

	ClickHouse     ClickHouse     `json:"clickhouse"`
	Watch          Watch          `json:"watch"`
	Enrich         Enrich         `json:"enrich"`
	Retention      Retention      `json:"retention"`
	TLS            TLS            `json:"tls"`
	LeaderElection LeaderElection `json:"leaderElection"`
	Recorder       Recorder       `json:"recorder"`
	Sources        Sources        `json:"sources"`

	// APIToken guards /api; AuditToken guards /audit. Both come from the
	// environment (a Secret), never from the ConfigMap.
	APIToken   string `json:"-"`
	AuditToken string `json:"-"`
}

type ClickHouse struct {
	Addr     []string `json:"addr"`
	Database string   `json:"database"`
	Username string   `json:"username"`
	Password string   `json:"-"`
	Secure   bool     `json:"secure"`
}

type Watch struct {
	// Include and Exclude are glob patterns over "resource.group" ("resource"
	// for the core group), e.g. "deployments.apps", "*.cert-manager.io",
	// "*reviews*". Exclude wins.
	Include           []string `json:"include"`
	Exclude           []string `json:"exclude"`
	ExcludeNamespaces []string `json:"excludeNamespaces"`
	// RecordStatusChanges keeps updates that only touched .status. Off by
	// default: those are controllers reporting, not anyone changing anything.
	RecordStatusChanges bool `json:"recordStatusChanges"`
	// DiscoveryInterval is how often the resource list is refreshed so new
	// CRDs start being watched.
	DiscoveryInterval Duration `json:"discoveryInterval"`
}

type Enrich struct {
	// Delay holds a change back before attributing it, so the audit backend's
	// batch (which the API server sends seconds later) has arrived.
	Delay Duration `json:"delay"`
	// RetryAfter is when a change still unattributed after Delay is tried
	// once more; a match re-writes the row.
	RetryAfter Duration `json:"retryAfter"`
	// Window is how far apart a hint and a change may be to match by time
	// alone (used only when no exact key is available).
	Window Duration `json:"window"`
}

type Retention struct {
	ChangesDays  int `json:"changesDays"`
	AuditRawDays int `json:"auditRawDays"`
}

type TLS struct {
	// SecretName holds the self-signed CA and serving certificate.
	SecretName string `json:"secretName"`
	// ServiceName is the webhook Service; its DNS names go into the cert.
	ServiceName string `json:"serviceName"`
	// ExtraSANs adds names/IPs the API server may use to reach /audit
	// (a pinned ClusterIP, a node IP for a NodePort).
	ExtraSANs []string `json:"extraSANs"`
	// WebhookConfigName is the ValidatingWebhookConfiguration whose caBundle
	// toolbox keeps in sync with its CA.
	WebhookConfigName string `json:"webhookConfigName"`
}

// Recorder is the leader's heartbeat: a row every HeartbeatInterval while it
// is watching, each tagged with that leader term. A change of term, or a
// stretch with none longer than GapThreshold, is a period in which changes
// went unrecorded.
type Recorder struct {
	HeartbeatInterval Duration `json:"heartbeatInterval"`
	GapThreshold      Duration `json:"gapThreshold"`
}

// Sources says which collectors this release has switched on, so the health
// report can tell "audit is not configured" from "audit has gone quiet".
type Sources struct {
	AdmissionWebhook bool `json:"admissionWebhook"`
	AuditWebhook     bool `json:"auditWebhook"`
}

type LeaderElection struct {
	Enabled   bool   `json:"enabled"`
	LeaseName string `json:"leaseName"`
}

// DefaultExclude are resources that either change constantly without anyone
// changing them, or are not objects at all (review requests).
var DefaultExclude = []string{
	"events",
	"events.events.k8s.io",
	"leases.coordination.k8s.io",
	"endpoints",
	"endpointslices.discovery.k8s.io",
	"componentstatuses",
	"*reviews.*",
	"*reviews",
	"*requests.authentication.k8s.io",
	"bindings",
}

func Default() Config {
	return Config{
		ClusterName: "default",
		Namespace:   "default",
		HTTPAddr:    ":8080",
		WebhookAddr: ":9443",
		ClickHouse: ClickHouse{
			Addr:     []string{"localhost:9000"},
			Database: "toolbox",
			Username: "default",
		},
		Watch: Watch{
			Include:           []string{"*"},
			Exclude:           DefaultExclude,
			DiscoveryInterval: Duration{time.Minute},
		},
		Enrich: Enrich{
			Delay:      Duration{15 * time.Second},
			RetryAfter: Duration{90 * time.Second},
			Window:     Duration{2 * time.Minute},
		},
		Retention: Retention{ChangesDays: 90, AuditRawDays: 30},
		TLS: TLS{
			SecretName:        "toolbox-tls",
			ServiceName:       "toolbox",
			WebhookConfigName: "toolbox",
		},
		LeaderElection: LeaderElection{Enabled: true, LeaseName: "toolbox-leader"},
		// The threshold is for one leader going quiet; a change of leader is a
		// gap however short (see store.Coverage), so it needs no slack for one.
		Recorder: Recorder{HeartbeatInterval: Duration{15 * time.Second}, GapThreshold: Duration{45 * time.Second}},
		Sources:  Sources{AdmissionWebhook: true, AuditWebhook: true},
	}
}

// Load reads the YAML file at path (if non-empty) over the defaults, then
// applies environment overrides.
func Load(file string) (Config, error) {
	c := Default()
	if file != "" {
		b, err := os.ReadFile(file)
		if err != nil {
			return c, err
		}
		if err := yaml.Unmarshal(b, &c); err != nil {
			return c, fmt.Errorf("parse %s: %w", file, err)
		}
	}
	if v := os.Getenv("POD_NAMESPACE"); v != "" {
		c.Namespace = v
	}
	if v := os.Getenv("TOOLBOX_CLUSTER_NAME"); v != "" {
		c.ClusterName = v
	}
	if v := os.Getenv("CLICKHOUSE_ADDR"); v != "" {
		c.ClickHouse.Addr = strings.Split(v, ",")
	}
	if v := os.Getenv("CLICKHOUSE_USERNAME"); v != "" {
		c.ClickHouse.Username = v
	}
	c.ClickHouse.Password = os.Getenv("CLICKHOUSE_PASSWORD")
	c.APIToken = os.Getenv("TOOLBOX_API_TOKEN")
	c.AuditToken = os.Getenv("TOOLBOX_AUDIT_TOKEN")
	return c, c.validate()
}

func (c Config) validate() error {
	for _, p := range append(append([]string{}, c.Watch.Include...), c.Watch.Exclude...) {
		if _, err := path.Match(p, ""); err != nil {
			return fmt.Errorf("bad watch pattern %q: %w", p, err)
		}
	}
	if c.Enrich.Delay.Duration <= 0 || c.Enrich.RetryAfter.Duration <= c.Enrich.Delay.Duration {
		return fmt.Errorf("enrich: need 0 < delay < retryAfter")
	}
	if c.Retention.ChangesDays <= 0 || c.Retention.AuditRawDays <= 0 {
		return fmt.Errorf("retention days must be positive")
	}
	if c.Recorder.HeartbeatInterval.Duration <= 0 || c.Recorder.GapThreshold.Duration <= c.Recorder.HeartbeatInterval.Duration {
		return fmt.Errorf("recorder: need 0 < heartbeatInterval < gapThreshold")
	}
	return nil
}

// ResourceFilter decides which resources are recorded.
type ResourceFilter struct {
	include, exclude []string
	excludeNS        map[string]bool
}

func (w Watch) Filter() *ResourceFilter {
	ns := map[string]bool{}
	for _, n := range w.ExcludeNamespaces {
		ns[n] = true
	}
	return &ResourceFilter{include: w.Include, exclude: w.Exclude, excludeNS: ns}
}

// AllowsResource reports whether resource in group is recorded.
func (f *ResourceFilter) AllowsResource(group, resource string) bool {
	name := resource
	if group != "" {
		name = resource + "." + group
	}
	for _, p := range f.exclude {
		if ok, _ := path.Match(p, name); ok {
			return false
		}
	}
	for _, p := range f.include {
		if ok, _ := path.Match(p, name); ok {
			return true
		}
	}
	return false
}

// AllowsNamespace reports whether objects in namespace are recorded.
func (f *ResourceFilter) AllowsNamespace(ns string) bool { return !f.excludeNS[ns] }
