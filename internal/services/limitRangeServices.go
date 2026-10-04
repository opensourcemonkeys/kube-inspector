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

func GetLimitRanges(namespace string, client *kubernetes.Clientset) ([]models.LimitRangeInfo, error) {
	list, err := client.CoreV1().LimitRanges(namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	infos := make([]models.LimitRangeInfo, 0, len(list.Items))
	for _, lr := range list.Items {
		infos = append(infos, limitRangeToInfo(lr))
	}
	return infos, nil
}

func GetLimitRangeYaml(namespace, name string, client *kubernetes.Clientset) (string, error) {
	if namespace == "" || name == "" {
		return "", errNamespaceNameRequired
	}
	lr, err := client.CoreV1().LimitRanges(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return toApplyYaml(lr)
}

func UpdateLimitRangeYaml(namespace, name, yamlContent string, client *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return errNamespaceNameRequired
	}

	var lr corev1.LimitRange
	if err := yaml.Unmarshal([]byte(yamlContent), &lr); err != nil {
		return fmt.Errorf("failed to parse YAML: %w", err)
	}

	lr.Namespace = namespace
	lr.Name = name

	_, err := client.CoreV1().LimitRanges(namespace).Update(context.Background(), &lr, metav1.UpdateOptions{})
	return err
}

func DeleteLimitRange(namespace, name string, client *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return errNamespaceNameRequired
	}
	return client.CoreV1().LimitRanges(namespace).Delete(context.Background(), name, metav1.DeleteOptions{})
}

func limitRangeToInfo(lr corev1.LimitRange) models.LimitRangeInfo {
	limits := make([]models.LimitRangeItemInfo, 0, len(lr.Spec.Limits))
	for _, item := range lr.Spec.Limits {
		limits = append(limits, models.LimitRangeItemInfo{
			Type:                 string(item.Type),
			Max:                  resourceListToMap(item.Max),
			Min:                  resourceListToMap(item.Min),
			Default:              resourceListToMap(item.Default),
			DefaultRequest:       resourceListToMap(item.DefaultRequest),
			MaxLimitRequestRatio: resourceListToMap(item.MaxLimitRequestRatio),
		})
	}

	return models.LimitRangeInfo{
		Name:      lr.Name,
		Namespace: lr.Namespace,
		Limits:    limits,
		CreatedAt: lr.CreationTimestamp.Time.Format(time.RFC3339),
	}
}

func resourceListToMap(rl corev1.ResourceList) map[string]string {
	m := make(map[string]string)
	for k, v := range rl {
		m[string(k)] = v.String()
	}
	return m
}
