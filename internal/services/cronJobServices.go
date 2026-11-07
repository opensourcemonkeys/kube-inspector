package services_k8sclient

import (
	"context"
	"encoding/json"
	"fmt"
	"kube-ins/internal/models"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	utilrand "k8s.io/apimachinery/pkg/util/rand"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"
)

func GetCronJobs(namespace string, client *kubernetes.Clientset) ([]models.CronJobInfo, error) {
	list, err := client.BatchV1().CronJobs(namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	infos := make([]models.CronJobInfo, 0, len(list.Items))
	for _, cj := range list.Items {
		infos = append(infos, cronJobToInfo(cj))
	}
	return infos, nil
}

func DeleteCronJob(namespace, name string, client *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return errNamespaceNameRequired
	}
	propagation := metav1.DeletePropagationBackground
	return client.BatchV1().CronJobs(namespace).Delete(context.Background(), name, metav1.DeleteOptions{
		PropagationPolicy: &propagation,
	})
}

func GetCronJobYaml(namespace, name string, client *kubernetes.Clientset) (string, error) {
	if namespace == "" || name == "" {
		return "", errNamespaceNameRequired
	}
	cj, err := client.BatchV1().CronJobs(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return toApplyYaml(cj)
}

func UpdateCronJobYaml(namespace, name, yamlContent string, client *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return errNamespaceNameRequired
	}

	var cj batchv1.CronJob
	if err := yaml.Unmarshal([]byte(yamlContent), &cj); err != nil {
		return fmt.Errorf("failed to parse YAML: %w", err)
	}

	cj.Namespace = namespace
	cj.Name = name

	_, err := client.BatchV1().CronJobs(namespace).Update(context.Background(), &cj, metav1.UpdateOptions{})
	return err
}

// SetCronJobSuspend pauses or resumes a CronJob's schedule. Patching rather
// than updating keeps it a single field write, so it cannot revert a concurrent
// edit to the schedule or the job template.
func SetCronJobSuspend(namespace, name string, suspend bool, client *kubernetes.Clientset) error {
	if namespace == "" || name == "" {
		return errNamespaceNameRequired
	}
	patch, err := json.Marshal(map[string]any{
		"spec": map[string]any{"suspend": suspend},
	})
	if err != nil {
		return err
	}
	_, err = client.BatchV1().CronJobs(namespace).Patch(context.Background(), name,
		types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	return err
}

// TriggerCronJob runs a CronJob once, now, and returns the name of the Job it
// created. It builds the Job the way `kubectl create job --from=cronjob/<name>`
// does, so the result is indistinguishable from it: the CronJob's job template
// (labels, annotations, spec), the `cronjob.kubernetes.io/instantiate: manual`
// annotation, and the CronJob as controlling owner — which is what lists the
// Job under its CronJob and lets the CronJob's history limits clean it up.
//
// The owner reference deliberately leaves BlockOwnerDeletion unset, as kubectl
// does: setting it requires `update` on cronjobs/finalizers, which someone
// allowed to create Jobs need not have.
//
// It runs regardless of the schedule, of `suspend` and of the concurrency
// policy — that is the point of running one by hand.
func TriggerCronJob(namespace, name string, client kubernetes.Interface) (string, error) {
	if namespace == "" || name == "" {
		return "", errNamespaceNameRequired
	}
	cj, err := client.BatchV1().CronJobs(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}

	annotations := map[string]string{"cronjob.kubernetes.io/instantiate": "manual"}
	for k, v := range cj.Spec.JobTemplate.Annotations {
		annotations[k] = v
	}
	labels := map[string]string{}
	for k, v := range cj.Spec.JobTemplate.Labels {
		labels[k] = v
	}
	controller := true

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:        manualJobName(name),
			Namespace:   namespace,
			Labels:      labels,
			Annotations: annotations,
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: batchv1.SchemeGroupVersion.String(),
				Kind:       "CronJob",
				Name:       cj.Name,
				UID:        cj.UID,
				Controller: &controller,
			}},
		},
		Spec: *cj.Spec.JobTemplate.Spec.DeepCopy(),
	}
	created, err := client.BatchV1().Jobs(namespace).Create(context.Background(), job, metav1.CreateOptions{})
	if err != nil {
		return "", err
	}
	return created.Name, nil
}

// manualJobName is `<cronjob>-manual-<5 random>`. A Job's name becomes the
// value of its pods' job-name label, which may not exceed 63 characters, so the
// CronJob's part is cut to fit — the same budget the API server's generateName
// keeps. The name is made here rather than through generateName so the caller
// knows it at once (and the fake clientset in tests, which does not implement
// generateName, behaves like the real one).
func manualJobName(cronJob string) string {
	const suffix = "-manual-"
	base := cronJob
	if limit := 63 - len(suffix) - 5; len(base) > limit {
		base = base[:limit]
	}
	return base + suffix + utilrand.String(5)
}

func cronJobToInfo(cj batchv1.CronJob) models.CronJobInfo {
	info := models.CronJobInfo{
		Name:        cj.Name,
		Namespace:   cj.Namespace,
		Schedule:    cj.Spec.Schedule,
		Suspend:     cj.Spec.Suspend != nil && *cj.Spec.Suspend,
		ActiveCount: len(cj.Status.Active),
		CreatedAt:   cj.CreationTimestamp.Time.Format(time.RFC3339),
	}
	if cj.Status.LastScheduleTime != nil {
		info.LastScheduleTime = cj.Status.LastScheduleTime.Time.Format(time.RFC3339)
	}
	return info
}
