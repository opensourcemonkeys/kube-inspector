package services_k8sclient

import (
	"context"
	"reflect"
	"testing"

	"kube-ins/internal/models"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func exposurePod(name, rs string, lbls map[string]string) *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: name, Namespace: "shop", Labels: lbls,
		OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: rs}},
	}}
}

func exposureFixture() *fake.Clientset {
	return fake.NewSimpleClientset(
		exposurePod("api-1", "api-7d6c9b4f5", map[string]string{"app": "api"}),
		exposurePod("web-1", "web-7d6c9b4f5", map[string]string{"app": "web"}),
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "shop"},
			Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeLoadBalancer, Selector: map[string]string{"app": "api"}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"},
			Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, Selector: map[string]string{"app": "web"}}},
	)
}

func TestWorkloadExposureLoadBalancerAndIngress(t *testing.T) {
	c := exposureFixture()
	_, err := c.NetworkingV1().Ingresses("shop").Create(context.Background(), &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Name: "front", Namespace: "shop"},
		Spec: networkingv1.IngressSpec{Rules: []networkingv1.IngressRule{{IngressRuleValue: networkingv1.IngressRuleValue{
			HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{{
				Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "web"}},
			}}}}}}},
	}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := WorkloadExposure(context.Background(), c, "")
	if err != nil {
		t.Fatal(err)
	}
	want := map[models.TrivyWorkloadRef][]string{
		{Kind: "Deployment", Name: "api", Namespace: "shop"}: {"LoadBalancer shop/api"},
		{Kind: "Deployment", Name: "web", Namespace: "shop"}: {"Ingress shop/front"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestWorkloadExposureClusterIPOnlyIsNotExposed(t *testing.T) {
	got, err := WorkloadExposure(context.Background(), exposureFixture(), "")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got[models.TrivyWorkloadRef{Kind: "Deployment", Name: "web", Namespace: "shop"}]; ok {
		t.Fatalf("ClusterIP-only workload must not be exposed: %v", got)
	}
}

func TestNormalizeCheckID(t *testing.T) {
	for _, in := range []string{"AVD-KSV-0012", "KSV-0012", "KSV012", "ksv12"} {
		if got := NormalizeCheckID(in); got != "KSV12" {
			t.Errorf("%q -> %q", in, got)
		}
	}
	if got := NormalizeCheckID("KSV-0009"); got != "KSV9" {
		t.Errorf("got %q", got)
	}
}

func TestWorkloadPrivileges(t *testing.T) {
	mk := func(id, name string) models.TrivyK8sMisconfigFinding {
		return models.TrivyK8sMisconfigFinding{ResourceKind: "Deployment", ResourceName: name, Namespace: "shop", CheckID: id}
	}
	got := WorkloadPrivileges([]models.TrivyK8sMisconfigFinding{
		mk("KSV-0017", "api"), mk("AVD-KSV-0012", "api"), mk("KSV-0012", "api"), mk("KSV-0001", "api"),
	})
	want := map[models.TrivyWorkloadRef][]string{
		{Kind: "Deployment", Name: "api", Namespace: "shop"}: {"privileged", "root"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}
