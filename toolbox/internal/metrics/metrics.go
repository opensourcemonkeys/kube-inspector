// Package metrics holds toolbox's Prometheus series, served on /metrics.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	ChangesObserved = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "toolbox_changes_observed_total",
		Help: "Changes observed by the informers, by verb.",
	}, []string{"verb"})

	ChangesAttributed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "toolbox_changes_attributed_total",
		Help: "Changes written, by attribution source.",
	}, []string{"attribution"})

	HintsReceived = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "toolbox_hints_received_total",
		Help: "Actor hints received from the webhooks, by source.",
	}, []string{"source"})

	RowsWritten = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "toolbox_rows_written_total",
		Help: "Rows written to ClickHouse, by table.",
	}, []string{"table"})

	RowsDropped = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "toolbox_rows_dropped_total",
		Help: "Rows dropped because the write queue was full or ClickHouse kept failing, by table.",
	}, []string{"table", "reason"})

	WatchedResources = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "toolbox_watched_resources",
		Help: "Resources currently watched.",
	})

	PendingChanges = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "toolbox_pending_changes",
		Help: "Changes waiting for attribution.",
	})
)
