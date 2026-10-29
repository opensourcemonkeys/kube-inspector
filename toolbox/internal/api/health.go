package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/kubeinspector/toolbox/internal/store"
)

// Recording is the part of the configuration that decides what gets recorded
// and for how long, reported back so a reader can tell what is missing on
// purpose from what is missing because something is broken.
type Recording struct {
	AdmissionWebhook    bool     `json:"admissionWebhook"`
	AuditWebhook        bool     `json:"auditWebhook"`
	RecordStatusChanges bool     `json:"recordStatusChanges"`
	Include             []string `json:"include"`
	Exclude             []string `json:"exclude"`
	ExcludeNamespaces   []string `json:"excludeNamespaces"`
	ChangesDays         int      `json:"changesRetentionDays"`
	AuditRawDays        int      `json:"auditRetentionDays"`
	HeartbeatInterval   string   `json:"heartbeatInterval"`
	// GapThreshold is how long without a heartbeat counts as a gap.
	GapThreshold time.Duration `json:"-"`
}

// LeaderInfo is the leader lease as the API server holds it.
type LeaderInfo struct {
	Identity  string     `json:"identity"`
	Since     *time.Time `json:"since,omitempty"`
	RenewedAt *time.Time `json:"renewedAt,omitempty"`
}

type sourceHealth struct {
	Enabled bool `json:"enabled"`
	// LastSeen is the newest hint from this source; hints are kept a day, so
	// absent means nothing in the last 24 hours.
	LastSeen *time.Time `json:"lastSeen,omitempty"`
}

type healthReport struct {
	Cluster string `json:"cluster"`
	Version string `json:"version"`
	Sources struct {
		Admission sourceHealth `json:"admission"`
		Audit     sourceHealth `json:"audit"`
	} `json:"sources"`
	Leader *LeaderInfo `json:"leader,omitempty"`
	// Recorder is the newest heartbeat: who watched, how many resources.
	Recorder *store.Heartbeat `json:"recorder,omitempty"`
	// Coverage is the last 7 days.
	Coverage    *store.Coverage `json:"coverage"`
	Attribution []store.Count   `json:"attribution"` // last 24 hours
	Recording   Recording       `json:"recording"`
}

const coverageWindow = 7 * 24 * time.Hour

// health answers "is this recording, and how well" in one call. Each part is
// independent: one failing is logged and left empty rather than failing the
// whole report, since the report is what someone reads when things are wrong.
func (s *Server) health(w http.ResponseWriter, r *http.Request) error {
	ctx, cluster, now := r.Context(), s.cluster(r), s.now()
	rep := healthReport{Cluster: s.Cluster, Version: s.Version, Recording: s.Recording, Attribution: []store.Count{}}
	rep.Sources.Admission.Enabled = s.Recording.AdmissionWebhook
	rep.Sources.Audit.Enabled = s.Recording.AuditWebhook

	soft := func(part string, err error) {
		if err != nil {
			slog.Warn("health report part failed", "part", part, "err", err)
		}
	}
	if last, err := s.Store.LastHints(ctx, cluster); err == nil {
		if t, ok := last["admission"]; ok {
			rep.Sources.Admission.LastSeen = &t
		}
		if t, ok := last["audit"]; ok {
			rep.Sources.Audit.LastSeen = &t
		}
	} else {
		soft("hints", err)
	}
	if s.Leader != nil {
		l, err := s.Leader(ctx)
		soft("leader", err)
		rep.Leader = l
	}
	hb, err := s.Store.LastHeartbeat(ctx, cluster)
	soft("heartbeat", err)
	rep.Recorder = hb
	if rep.Coverage, err = s.Store.Coverage(ctx, cluster, now.Add(-coverageWindow), now, s.gapThreshold()); err != nil {
		return err // without coverage the report has lost its point
	}
	if counts, err := s.Store.AttributionCounts(ctx, cluster, now.Add(-24*time.Hour)); err == nil {
		rep.Attribution = counts
	} else {
		soft("attribution", err)
	}
	writeJSON(w, http.StatusOK, rep)
	return nil
}

func (s *Server) gapThreshold() time.Duration {
	if s.Recording.GapThreshold > 0 {
		return s.Recording.GapThreshold
	}
	return 45 * time.Second
}

// gaps lists the stretches in which no leader was recording.
func (s *Server) gaps(w http.ResponseWriter, r *http.Request) error {
	since, err := s.sinceOr(r, coverageWindow)
	if err != nil {
		return err
	}
	until := s.now()
	if v := r.URL.Query().Get("until"); v != "" {
		if until, err = s.parseTime(v); err != nil {
			return err
		}
	}
	if !until.After(since) {
		return badRequest("until must be after since")
	}
	cov, err := s.Store.Coverage(r.Context(), s.cluster(r), since, until, s.gapThreshold())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, cov)
	return nil
}
