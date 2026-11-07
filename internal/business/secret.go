package business

import (
	"fmt"
	"kube-ins/internal/models"
	repository "kube-ins/internal/repository"
	services "kube-ins/internal/services"
)

func GetSecrets(clusterName string) ([]models.SecretInfo, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return nil, fmt.Errorf("connect to cluster %q: %w", clusterName, err)
	}
	items, err := services.GetSecrets("", client)
	if err != nil {
		return nil, fmt.Errorf("list secrets in cluster %q: %w", clusterName, err)
	}
	return items, nil
}

func DeleteSecret(clusterName string, name, namespace string) error {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return err
	}
	return services.DeleteSecret(namespace, name, client)
}

func GetSecretYaml(clusterName string, name, namespace string) (string, error) {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return "", err
	}
	return services.GetSecretYaml(namespace, name, client)
}

func UpdateSecretYaml(clusterName string, name, namespace, yamlContent string) error {
	client, err := repository.NewK8sClientForCluster(clusterName)
	if err != nil {
		return err
	}
	return services.UpdateSecretYaml(namespace, name, yamlContent, client)
}
