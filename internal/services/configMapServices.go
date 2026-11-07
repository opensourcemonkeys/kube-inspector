package services_k8sclient

import (
	"context"
	"fmt"
	"kube-ins/internal/models"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"
)

func GetConfigMaps(namespace string, client *kubernetes.Clientset) ([]models.ConfigMapInfo, error) {
	cms, err := client.CoreV1().ConfigMaps(namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	infos := make([]models.ConfigMapInfo, 0, len(cms.Items))
	for _, cm := range cms.Items {
		infos = append(infos, configMapToInfo(cm))
	}
	return infos, nil
}

func DeleteConfigMap(namespace, name string, client *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return errNamespaceNameRequired
	}
	return client.CoreV1().ConfigMaps(namespace).Delete(context.Background(), name, metav1.DeleteOptions{})
}

func GetConfigMapYaml(namespace, name string, client *kubernetes.Clientset) (string, error) {
	if namespace == "" || name == "" {
		return "", errNamespaceNameRequired
	}
	cm, err := client.CoreV1().ConfigMaps(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return toApplyYaml(cm)
}

func UpdateConfigMapYaml(namespace, name, yamlContent string, client *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return errNamespaceNameRequired
	}

	var cm corev1.ConfigMap
	if err := yaml.Unmarshal([]byte(yamlContent), &cm); err != nil {
		return fmt.Errorf("failed to parse YAML: %w", err)
	}

	cm.Namespace = namespace
	cm.Name = name

	_, err := client.CoreV1().ConfigMaps(namespace).Update(context.Background(), &cm, metav1.UpdateOptions{})
	return err
}

func configMapToInfo(cm corev1.ConfigMap) models.ConfigMapInfo {
	return models.ConfigMapInfo{
		Name:      cm.Name,
		Namespace: cm.Namespace,
		DataCount: len(cm.Data),
		CreatedAt: cm.CreationTimestamp.Time.Format(time.RFC3339),
	}
}
