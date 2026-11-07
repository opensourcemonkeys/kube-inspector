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

func GetSecrets(namespace string, client *kubernetes.Clientset) ([]models.SecretInfo, error) {
	secrets, err := client.CoreV1().Secrets(namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	infos := make([]models.SecretInfo, 0, len(secrets.Items))
	for _, s := range secrets.Items {
		infos = append(infos, secretToInfo(s))
	}
	return infos, nil
}

func DeleteSecret(namespace, name string, client *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return errNamespaceNameRequired
	}
	return client.CoreV1().Secrets(namespace).Delete(context.Background(), name, metav1.DeleteOptions{})
}

func GetSecretYaml(namespace, name string, client *kubernetes.Clientset) (string, error) {
	if namespace == "" || name == "" {
		return "", errNamespaceNameRequired
	}
	s, err := client.CoreV1().Secrets(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return toApplyYaml(s)
}

func UpdateSecretYaml(namespace, name, yamlContent string, client *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return errNamespaceNameRequired
	}

	var s corev1.Secret
	if err := yaml.Unmarshal([]byte(yamlContent), &s); err != nil {
		return fmt.Errorf("failed to parse YAML: %w", err)
	}

	s.Namespace = namespace
	s.Name = name

	_, err := client.CoreV1().Secrets(namespace).Update(context.Background(), &s, metav1.UpdateOptions{})
	return err
}

func secretToInfo(s corev1.Secret) models.SecretInfo {
	return models.SecretInfo{
		Name:      s.Name,
		Namespace: s.Namespace,
		Type:      string(s.Type),
		DataCount: len(s.Data),
		CreatedAt: s.CreationTimestamp.Time.Format(time.RFC3339),
	}
}
