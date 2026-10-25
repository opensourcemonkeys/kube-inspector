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

func GetToolboxAttempts(clusterName string, filter models.ToolboxChangeFilter) ([]models.ToolboxAttempt, error) {
	t, err := toolboxFor(clusterName)
	if err != nil {
		return nil, err
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
	t := services.Toolbox{Key: clusterName, Client: client}
	out, err := services.RollbackToolboxChange(ctx, t, dyn, eventID, side)
	if err != nil {
		logging.With("business.toolbox").Warn("rollback failed", "cluster", clusterName, "event", eventID, "side", side, "err", err)
		return "", err
	}
	logging.With("business.toolbox").Info("rolled back", "cluster", clusterName, "event", eventID, "side", side, "result", out)
	return out, nil
}
