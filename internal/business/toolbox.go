package business

import (
	"context"
	"fmt"
	"time"

	"k8s.io/client-go/dynamic"

	"kube-ins/internal/logging"
	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"
)

// toolboxTimeout bounds one call: discovery (up to three requests) plus the
// proxied one.
const toolboxTimeout = 20 * time.Second

func toolboxFor(clusterName string) (services.Toolbox, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return services.Toolbox{}, fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}
	return services.Toolbox{Key: clusterName, Client: client}, nil
}

// GetToolboxStatus says whether the toolbox change recorder is installed on the
// cluster and usable with the user's access. Failures are the answer
// (State), not an error.
func GetToolboxStatus(clusterName string) models.ToolboxStatus {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return models.ToolboxStatus{State: services.ToolboxUnreachable, Detail: err.Error()}
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	st := services.GetToolboxStatus(ctx, t)
	if st.State != services.ToolboxOK {
		logging.With("business.toolbox").Debug("toolbox not usable", "cluster", clusterName, "state", st.State, "detail", st.Detail)
	}
	return st
}

func GetToolboxChanges(clusterName string, filter models.ToolboxChangeFilter) (models.ToolboxChangePage, error) {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return models.ToolboxChangePage{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	return services.ListToolboxChanges(ctx, t, filter)
}

func GetToolboxChangeDetail(clusterName, eventID string) (models.ToolboxChangeDetail, error) {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return models.ToolboxChangeDetail{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	return services.GetToolboxChangeDetail(ctx, t, eventID)
}

func GetToolboxAttempts(clusterName string, filter models.ToolboxChangeFilter) (models.ToolboxAttemptPage, error) {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return models.ToolboxAttemptPage{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	return services.ListToolboxAttempts(ctx, t, filter)
}

func GetToolboxUsers(clusterName, since string) ([]models.ToolboxUser, error) {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	return services.ListToolboxUsers(ctx, t, since)
}

// GetToolboxHealth reports how well toolbox is recording on the cluster.
func GetToolboxHealth(clusterName string) (models.ToolboxHealth, error) {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return models.ToolboxHealth{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	return services.GetToolboxHealth(ctx, t)
}

// StreamToolboxChanges follows the cluster's new changes until ctx ends; see
// services.StreamToolboxChanges. It uses the streaming client, which has no
// request timeout.
func StreamToolboxChanges(ctx context.Context, clusterName string, filter models.ToolboxChangeFilter, onChange func(models.ToolboxChange)) error {
	client, _, err := repository.NewK8sClientAndConfigForClusterStreaming(clusterName)
	if err != nil {
		return fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}
	return services.StreamToolboxChanges(ctx, services.Toolbox{Key: clusterName, Client: client}, filter, onChange)
}

// ToolboxExportLimit is the most rows one export writes.
const ToolboxExportLimit = services.ToolboxExportLimit

// toolboxExportTimeout bounds a whole export: up to 50 pages of 1000.
const toolboxExportTimeout = 3 * time.Minute

// BuildToolboxExport collects every row of a history view the filter matches
// (up to services.ToolboxExportLimit) and renders it as CSV or JSON.
func BuildToolboxExport(clusterName, view string, filter models.ToolboxChangeFilter, format string) (services.ToolboxExport, error) {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return services.ToolboxExport{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxExportTimeout)
	defer cancel()
	out, err := services.ExportToolboxHistory(ctx, t, view, filter, format, services.ToolboxExportLimit)
	if err != nil {
		logging.With("business.toolbox").Warn("export failed", "cluster", clusterName, "view", view, "err", err)
	}
	return out, err
}

// GetToolboxStats summarises a period of the cluster's change history.
func GetToolboxStats(clusterName string, filter models.ToolboxStatsFilter) (models.ToolboxStats, error) {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return models.ToolboxStats{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	return services.GetToolboxStats(ctx, t, filter)
}

// GetToolboxGaps lists the stretches in [since, until] when nothing was recorded.
func GetToolboxGaps(clusterName, since, until string) (models.ToolboxCoverage, error) {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return models.ToolboxCoverage{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	return services.ListToolboxGaps(ctx, t, since, until)
}

// GetToolboxLiveObject reads the object a change was recorded for as it is
// now, for comparison with a recorded version.
func GetToolboxLiveObject(clusterName, group, version, resource, namespace, name string) (models.ToolboxLiveObject, error) {
	_, config, err := repository.NewK8sClientAndConfigForCluster(clusterName)
	if err != nil {
		return models.ToolboxLiveObject{}, fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}
	dyn, err := dynamic.NewForConfig(config)
	if err != nil {
		return models.ToolboxLiveObject{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	return services.GetToolboxLiveObject(ctx, dyn, group, version, resource, namespace, name)
}

// RollbackToolboxChange writes the "before" or "after" version of a recorded
// change back to the cluster, replacing the live object (or re-creating it).
func RollbackToolboxChange(clusterName, eventID, side string) (string, error) {
	out, err := rollbackToolbox(clusterName, eventID, side, services.RollbackToolboxChange)
	if err != nil {
		logging.With("business.toolbox").Warn("rollback failed", "cluster", clusterName, "event", eventID, "side", side, "err", err)
		return "", err
	}
	logging.With("business.toolbox").Info("rolled back", "cluster", clusterName, "event", eventID, "side", side, "result", out)
	return out, nil
}

// DryRunToolboxRollback checks a rollback with the API server (dryRun=All)
// without writing it, so the confirmation can say up front whether it would
// be accepted.
func DryRunToolboxRollback(clusterName, eventID, side string) (string, error) {
	return rollbackToolbox(clusterName, eventID, side, services.DryRunToolboxRollback)
}

func rollbackToolbox(clusterName, eventID, side string,
	run func(context.Context, services.Toolbox, dynamic.Interface, string, string) (string, error)) (string, error) {
	client, config, err := repository.NewK8sClientAndConfigForCluster(clusterName)
	if err != nil {
		return "", fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}
	dyn, err := dynamic.NewForConfig(config)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolboxTimeout)
	defer cancel()
	return run(ctx, services.Toolbox{Key: clusterName, Client: client}, dyn, eventID, side)
}
