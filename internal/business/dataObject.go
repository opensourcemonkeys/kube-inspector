package business

import (
	"encoding/base64"
	"errors"
	"fmt"

	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"
)

// GetDataObject reads a ConfigMap or Secret (kind) for the key/value editor.
func GetDataObject(clusterName, kind, namespace, name string) (models.DataObject, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return models.DataObject{}, fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}
	return services.GetDataObject(kind, namespace, name, client)
}

// SaveDataObject saves (or, with dryRun, only checks) the editor's entries.
// Every outcome is a DataSaveResult so the frontend can word it; only a
// cluster that cannot be reached at all is an error.
func SaveDataObject(clusterName, kind, namespace, name, resourceVersion string, entries []models.DataEntry, dryRun bool) (models.DataSaveResult, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return models.DataSaveResult{}, fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}
	rv, err := services.SaveDataObject(kind, namespace, name, resourceVersion, entries, dryRun, client)
	if err == nil {
		return models.DataSaveResult{ResourceVersion: rv}, nil
	}
	res := models.DataSaveResult{Code: "rejected", Message: err.Error()}
	switch {
	case errors.Is(err, services.ErrDataConflict):
		res.Code = "conflict"
	case errors.Is(err, services.ErrDataImmutable):
		res.Code = "immutable"
	case errors.Is(err, services.ErrDataInvalid):
		res.Code = "invalid"
	}
	return res, nil
}

// GetDataConsumers lists the workloads using a ConfigMap or Secret.
func GetDataConsumers(clusterName, kind, namespace, name string) ([]models.DataConsumer, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}
	return services.GetDataConsumers(kind, namespace, name, client)
}

// InspectTlsPair describes a TLS certificate and checks its key (both base64).
func InspectTlsPair(certB64, keyB64 string) models.TlsInfo {
	return services.InspectTlsPair(certB64, keyB64)
}

// SaveDataValueFile writes one exported value (base64) to path.
func SaveDataValueFile(path, valueB64 string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(valueB64)
	if err != nil {
		return "", fmt.Errorf("value is not base64: %w", err)
	}
	return services.SaveBinaryFile(path, b)
}
