// Command toolbox records every create, update and delete in a Kubernetes
// cluster — what changed, when, and who did it from where — into ClickHouse,
// and serves that history over a REST API (Kube Inspector is its UI).
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"

	"github.com/kubeinspector/toolbox/internal/admission"
	"github.com/kubeinspector/toolbox/internal/api"
	"github.com/kubeinspector/toolbox/internal/auditsink"
	"github.com/kubeinspector/toolbox/internal/certs"
	"github.com/kubeinspector/toolbox/internal/config"
	"github.com/kubeinspector/toolbox/internal/correlate"
	"github.com/kubeinspector/toolbox/internal/safego"
	"github.com/kubeinspector/toolbox/internal/store"
	"github.com/kubeinspector/toolbox/internal/watcher"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	configPath := flag.String("config", os.Getenv("TOOLBOX_CONFIG"), "path to config.yaml")
	flag.Parse()

	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})))

	if err := run(*configPath); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	slog.Info("starting toolbox", "version", version, "cluster", cfg.ClusterName, "namespace", cfg.Namespace)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	restCfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		clientcmd.NewDefaultClientConfigLoadingRules(), &clientcmd.ConfigOverrides{}).ClientConfig()
	if err != nil {
		return err
	}
	// The informers' initial lists for every resource arrive in one burst.
	restCfg.QPS, restCfg.Burst = 50, 100
	restCfg.UserAgent = "toolbox/" + version
	kube := kubernetes.NewForConfigOrDie(restCfg)

	st, err := openStore(ctx, cfg)
	if err != nil {
		return err
	}
	defer st.Close()

	// Writers outlive the leader work so the correlator's final flush lands.
	writerCtx, stopWriters := context.WithCancel(context.Background())
	defer stopWriters()
	changes, hints, audits := st.ChangeWriter(), st.HintWriter(), st.AuditWriter()
	safego.Go("store.changes", func() { changes.Run(writerCtx) })
	safego.Go("store.hints", func() { hints.Run(writerCtx) })
	safego.Go("store.audit", func() { audits.Run(writerCtx) })

	cm := &certs.Manager{
		Client: kube, Namespace: cfg.Namespace, SecretName: cfg.TLS.SecretName, ServiceName: cfg.TLS.ServiceName,
		ExtraSANs: cfg.TLS.ExtraSANs, WebhookName: cfg.TLS.WebhookConfigName,
	}
	if err := cm.Ensure(ctx); err != nil {
		return err
	}
	safego.Go("certs.cabundle", func() { cm.KeepCABundle(ctx) })

	filter := cfg.Watch.Filter()
	webhookMux := http.NewServeMux()
	webhookMux.Handle("POST /admission", &admission.Handler{Cluster: cfg.ClusterName, Filter: filter, Put: hints.Put})
	webhookMux.Handle("POST /audit", &auditsink.Handler{Cluster: cfg.ClusterName, Filter: filter, Token: cfg.AuditToken,
		PutHint: hints.Put, PutAudit: audits.Put})
	webhookMux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	webhookSrv := &http.Server{
		Addr: cfg.WebhookAddr, Handler: webhookMux, ReadHeaderTimeout: 10 * time.Second,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: cm.GetCertificate},
	}

	mux := http.NewServeMux()
	apiSrv := &api.Server{Store: st, Cluster: cfg.ClusterName, Token: cfg.APIToken, Version: version, Recording: api.Recording{
		AdmissionWebhook: cfg.Sources.AdmissionWebhook, AuditWebhook: cfg.Sources.AuditWebhook,
		RecordStatusChanges: cfg.Watch.RecordStatusChanges, Include: cfg.Watch.Include, Exclude: cfg.Watch.Exclude,
		ExcludeNamespaces: cfg.Watch.ExcludeNamespaces, ChangesDays: cfg.Retention.ChangesDays, AuditRawDays: cfg.Retention.AuditRawDays,
		HeartbeatInterval: cfg.Recorder.HeartbeatInterval.String(), GapThreshold: cfg.Recorder.GapThreshold.Duration,
	},
		// The longest a change takes to be written: its delay, its retry,
		// and a minute for the writer's flush and a slow ClickHouse.
		StreamLookback: cfg.Enrich.Delay.Duration + cfg.Enrich.RetryAfter.Duration + time.Minute,
	}
	if cfg.LeaderElection.Enabled {
		apiSrv.Leader = leaseReader(kube, cfg)
	}
	apiSrv.Routes(mux)
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		pctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := st.Ping(pctx); err != nil {
			http.Error(w, "clickhouse: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	httpSrv := &http.Server{Addr: cfg.HTTPAddr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}

	if cfg.APIToken == "" {
		slog.Warn("TOOLBOX_API_TOKEN is empty: the API is unauthenticated")
	}
	if cfg.AuditToken == "" {
		slog.Warn("TOOLBOX_AUDIT_TOKEN is empty: anyone who can reach /audit can inject audit records")
	}

	serveErr := make(chan error, 2)
	safego.Go("http.webhook", func() {
		if err := webhookSrv.ListenAndServeTLS("", ""); !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	})
	safego.Go("http.api", func() {
		if err := httpSrv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	})

	// Leader work: one replica watches and correlates; all of them serve.
	dyn := dynamic.NewForConfigOrDie(restCfg)
	disc := discovery.NewDiscoveryClientForConfigOrDie(restCfg)
	corr := correlate.New(cfg.ClusterName, st, changes.Put, cfg.Enrich, cfg.Watch.RecordStatusChanges)
	identity, _ := os.Hostname()
	lead := func(lctx context.Context) {
		var wg sync.WaitGroup
		wg.Add(3)
		w := watcher.New(dyn, disc, cfg.Watch, corr.Observe)
		safego.Go("correlator", func() { defer wg.Done(); corr.Run(lctx) })
		safego.Go("watcher", func() { defer wg.Done(); w.Run(lctx) })
		safego.Go("heartbeat", func() { defer wg.Done(); heartbeat(lctx, st, cfg, identity, w, corr) })
		wg.Wait()
	}

	leaderDone := make(chan struct{})
	safego.Go("leader", func() {
		defer close(leaderDone)
		if !cfg.LeaderElection.Enabled {
			lead(ctx)
			return
		}
		runLeaderElection(ctx, kube, cfg, lead)
	})

	select {
	case <-ctx.Done():
	case err = <-serveErr:
		slog.Error("server failed", "err", err)
		stop()
	}

	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = webhookSrv.Shutdown(shutdownCtx)
	_ = httpSrv.Shutdown(shutdownCtx)
	<-leaderDone
	stopWriters()
	<-changes.Done()
	<-hints.Done()
	<-audits.Done()
	return err
}

// openStore retries until ClickHouse answers: in a fresh install it is
// usually still starting when we are.
func openStore(ctx context.Context, cfg config.Config) (*store.Store, error) {
	backoff := time.Second
	for {
		st, err := store.Open(ctx, cfg.ClickHouse)
		if err == nil {
			if err := st.EnsureRetention(ctx, cfg.Retention); err != nil {
				st.Close()
				return nil, err
			}
			return st, nil
		}
		slog.Warn("clickhouse not ready", "err", err, "retry_in", backoff.String())
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// runLeaderElection runs lead while this replica holds the lease, and returns
// only once lead has returned too: client-go starts OnStartedLeading in its own
// goroutine and does not wait for it, which would let shutdown stop the
// writers under the correlator's final flush.
func runLeaderElection(ctx context.Context, kube kubernetes.Interface, cfg config.Config, lead func(context.Context)) {
	id, _ := os.Hostname()
	var leading sync.WaitGroup
	defer leading.Wait()
	lock := &resourcelock.LeaseLock{
		LeaseMeta:  metav1.ObjectMeta{Name: cfg.LeaderElection.LeaseName, Namespace: cfg.Namespace},
		Client:     kube.CoordinationV1(),
		LockConfig: resourcelock.ResourceLockConfig{Identity: id},
	}
	leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
		Lock:            lock,
		ReleaseOnCancel: true,
		LeaseDuration:   15 * time.Second,
		RenewDeadline:   10 * time.Second,
		RetryPeriod:     2 * time.Second,
		Name:            cfg.LeaderElection.LeaseName,
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: func(lctx context.Context) {
				leading.Add(1)
				defer leading.Done()
				slog.Info("became leader; watching and correlating", "identity", id)
				lead(lctx)
			},
			OnStoppedLeading: func() {
				// Losing the lease while still running means another replica
				// may already be recording; carrying on would double-write.
				if ctx.Err() == nil {
					slog.Error("lost leadership; exiting so the pod restarts as a follower")
					os.Exit(1)
				}
			},
			OnNewLeader: func(identity string) {
				if identity != id {
					slog.Info("following leader", "leader", identity)
				}
			},
		},
	})
}

// heartbeat writes a row every recorder.heartbeatInterval while this replica
// leads, so the history can show when nobody was recording. A failed write is
// only logged: the heartbeat must never take the recording down with it.
func heartbeat(ctx context.Context, st *store.Store, cfg config.Config, identity string, w *watcher.Watcher, corr *correlate.Correlator) {
	t := time.NewTicker(cfg.Recorder.HeartbeatInterval.Duration)
	defer t.Stop()
	for {
		wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := st.WriteHeartbeat(wctx, store.Heartbeat{
			Time: time.Now(), Cluster: cfg.ClusterName, Identity: identity,
			WatchedResources: uint32(w.Watched()), Pending: uint32(corr.Pending()),
		})
		cancel()
		if err != nil && ctx.Err() == nil {
			slog.Warn("heartbeat write failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// leaseReader reads the leader lease for the health report. Every replica
// serves the API, so it is read from the API server, not from this process.
func leaseReader(kube kubernetes.Interface, cfg config.Config) func(context.Context) (*api.LeaderInfo, error) {
	return func(ctx context.Context) (*api.LeaderInfo, error) {
		l, err := kube.CoordinationV1().Leases(cfg.Namespace).Get(ctx, cfg.LeaderElection.LeaseName, metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		if l.Spec.HolderIdentity == nil || *l.Spec.HolderIdentity == "" {
			return nil, nil
		}
		info := &api.LeaderInfo{Identity: *l.Spec.HolderIdentity}
		if l.Spec.AcquireTime != nil {
			info.Since = &l.Spec.AcquireTime.Time
		}
		if l.Spec.RenewTime != nil {
			info.RenewedAt = &l.Spec.RenewTime.Time
		}
		return info, nil
	}
}
