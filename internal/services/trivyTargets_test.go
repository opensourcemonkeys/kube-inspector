package services_k8sclient

import (
	"context"
	"reflect"
	"testing"

	"kube-ins/internal/models"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func tpod(ns, name string, owners []metav1.OwnerReference, init []string, imgs ...string) *corev1.Pod {
	p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, OwnerReferences: owners}}
	for _, i := range init {
		p.Spec.InitContainers = append(p.Spec.InitContainers, corev1.Container{Image: i})
	}
	for _, i := range imgs {
		p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Image: i})
	}
	return p
}

func TestListScanTargetsDedupesImages(t *testing.T) {
	client := fake.NewSimpleClientset(
		tpod("shop", "a-7d9f5c8b4-x1", ctrlRef("ReplicaSet", "a-7d9f5c8b4"), []string{"busybox:1"}, "nginx:1.27"),
		tpod("shop", "b-6c8d4f9d7-x2", ctrlRef("ReplicaSet", "b-6c8d4f9d7"), nil, "nginx:1.27"),
	)
	targets, wls, err := ListScanTargets(context.Background(), client, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 2 || targets[0].Image != "busybox:1" || targets[1].Image != "nginx:1.27" {
		t.Fatalf("targets = %+v", targets)
	}
	want := []models.TrivyWorkloadRef{{Kind: "Deployment", Name: "a", Namespace: "shop"}, {Kind: "Deployment", Name: "b", Namespace: "shop"}}
	if !reflect.DeepEqual(targets[1].Workloads, want) {
		t.Fatalf("workloads = %+v", targets[1].Workloads)
	}
	if len(wls) != 2 || !reflect.DeepEqual(wls[0].Images, []string{"busybox:1", "nginx:1.27"}) {
		t.Fatalf("wls = %+v", wls)
	}
}

func TestListScanTargetsUnwrapsCronJob(t *testing.T) {
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Namespace: "ops", Name: "backup-29384712", OwnerReferences: ctrlRef("CronJob", "backup")}}
	client := fake.NewSimpleClientset(job,
		tpod("ops", "backup-29384712-abcde", ctrlRef("Job", "backup-29384712"), nil, "restic:1"))
	targets, _, err := ListScanTargets(context.Background(), client, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []models.TrivyWorkloadRef{{Kind: "CronJob", Name: "backup", Namespace: "ops"}}
	if len(targets) != 1 || !reflect.DeepEqual(targets[0].Workloads, want) {
		t.Fatalf("targets = %+v", targets)
	}
}

func TestListScanTargetsStandaloneJobAndPod(t *testing.T) {
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Namespace: "ops", Name: "migrate"}}
	client := fake.NewSimpleClientset(job,
		tpod("ops", "migrate-xyz12", ctrlRef("Job", "migrate"), nil, "migr:1"),
		tpod("ops", "debug", nil, nil, "alpine:3"))
	targets, _, err := ListScanTargets(context.Background(), client, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 2 {
		t.Fatalf("targets = %+v", targets)
	}
	if targets[0].Workloads[0].Kind != "Pod" || targets[0].Workloads[0].Name != "debug" {
		t.Fatalf("alpine: %+v", targets[0])
	}
	if targets[1].Workloads[0].Kind != "Job" || targets[1].Workloads[0].Name != "migrate" {
		t.Fatalf("migr: %+v", targets[1])
	}
}

func TestListScanTargetsWorkloadsSortedAcrossNamespaces(t *testing.T) {
	client := fake.NewSimpleClientset(
		tpod("zeta", "z", nil, nil, "img:1"),
		tpod("alpha", "b", nil, nil, "img:1"),
		tpod("alpha", "a", nil, nil, "img:1"),
	)
	targets, wls, err := ListScanTargets(context.Background(), client, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []models.TrivyWorkloadRef{
		{Kind: "Pod", Name: "a", Namespace: "alpha"},
		{Kind: "Pod", Name: "b", Namespace: "alpha"},
		{Kind: "Pod", Name: "z", Namespace: "zeta"},
	}
	if !reflect.DeepEqual(targets[0].Workloads, want) {
		t.Fatalf("target workloads = %+v", targets[0].Workloads)
	}
	for i, w := range wls {
		if w.Ref() != want[i] {
			t.Fatalf("wls[%d] = %+v", i, w)
		}
	}
}
