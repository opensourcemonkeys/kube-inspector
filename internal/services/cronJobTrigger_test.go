package services_k8sclient

import (
	"context"
	"strings"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
)

func testCronJob(name string) *batchv1.CronJob {
	return &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "ops", UID: types.UID("cj-uid")},
		Spec: batchv1.CronJobSpec{
			Schedule: "0 3 * * *",
			JobTemplate: batchv1.JobTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      map[string]string{"app": "backup"},
					Annotations: map[string]string{"team": "platform"},
				},
				Spec: batchv1.JobSpec{
					Template: corev1.PodTemplateSpec{
						Spec: corev1.PodSpec{
							RestartPolicy: corev1.RestartPolicyOnFailure,
							Containers:    []corev1.Container{{Name: "backup", Image: "backup:1"}},
						},
					},
				},
			},
		},
	}
}

// The Job must be what `kubectl create job --from=cronjob/<name>` makes, so it
// shows up and is cleaned up exactly like one the schedule started.
func TestTriggerCronJobBuildsTheJobKubectlWould(t *testing.T) {
	client := fake.NewClientset(testCronJob("backup"))

	name, err := TriggerCronJob("ops", "backup", client)
	if err != nil {
		t.Fatalf("TriggerCronJob: %v", err)
	}
	if !strings.HasPrefix(name, "backup-manual-") || len(name) != len("backup-manual-")+5 {
		t.Fatalf("job name %q: want backup-manual-<5 chars>", name)
	}

	job, err := client.BatchV1().Jobs("ops").Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("created job not found: %v", err)
	}
	if job.Spec.Template.Spec.Containers[0].Image != "backup:1" ||
		job.Spec.Template.Spec.RestartPolicy != corev1.RestartPolicyOnFailure {
		t.Errorf("job spec was not taken from the template: %+v", job.Spec.Template.Spec)
	}
	if job.Labels["app"] != "backup" {
		t.Errorf("template labels not carried: %v", job.Labels)
	}
	if job.Annotations["team"] != "platform" || job.Annotations["cronjob.kubernetes.io/instantiate"] != "manual" {
		t.Errorf("annotations: %v", job.Annotations)
	}

	if len(job.OwnerReferences) != 1 {
		t.Fatalf("owner references: %+v", job.OwnerReferences)
	}
	ref := job.OwnerReferences[0]
	if ref.APIVersion != "batch/v1" || ref.Kind != "CronJob" || ref.Name != "backup" || ref.UID != "cj-uid" {
		t.Errorf("owner reference: %+v", ref)
	}
	if ref.Controller == nil || !*ref.Controller {
		t.Errorf("owner reference must be the controller: %+v", ref)
	}
	// BlockOwnerDeletion would need the cronjobs/finalizers permission, which
	// a user allowed to create Jobs need not hold; kubectl leaves it unset too.
	if ref.BlockOwnerDeletion != nil {
		t.Errorf("BlockOwnerDeletion must be unset: %+v", ref)
	}
}

func TestTriggerCronJobLeavesTheCronJobAlone(t *testing.T) {
	client := fake.NewClientset(testCronJob("backup"))
	if _, err := TriggerCronJob("ops", "backup", client); err != nil {
		t.Fatal(err)
	}
	cj, _ := client.BatchV1().CronJobs("ops").Get(context.Background(), "backup", metav1.GetOptions{})
	if _, ok := cj.Spec.JobTemplate.Annotations["cronjob.kubernetes.io/instantiate"]; ok {
		t.Errorf("the CronJob's own template was modified: %v", cj.Spec.JobTemplate.Annotations)
	}
}

// A Job's name becomes a pod label value, which may not exceed 63 characters.
func TestTriggerCronJobKeepsLongNamesValid(t *testing.T) {
	long := strings.Repeat("a", 52) // the API's own CronJob name limit
	client := fake.NewClientset(testCronJob(long))
	name, err := TriggerCronJob("ops", long, client)
	if err != nil {
		t.Fatal(err)
	}
	if len(name) > 63 {
		t.Errorf("job name is %d characters: %q", len(name), name)
	}
	if !strings.Contains(name, "-manual-") {
		t.Errorf("job name %q lost the -manual- marker", name)
	}
}

func TestTriggerCronJobErrors(t *testing.T) {
	client := fake.NewClientset()
	if _, err := TriggerCronJob("ops", "missing", client); !apierrors.IsNotFound(err) {
		t.Errorf("missing CronJob: want NotFound, got %v", err)
	}
	if _, err := TriggerCronJob("", "backup", client); err == nil {
		t.Error("empty namespace must be refused")
	}
}
