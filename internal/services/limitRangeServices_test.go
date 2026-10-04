package services_k8sclient

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestLimitRangeToInfo(t *testing.T) {
	q := resource.MustParse
	lr := corev1.LimitRange{
		ObjectMeta: metav1.ObjectMeta{Name: "limits", Namespace: "team-a"},
		Spec: corev1.LimitRangeSpec{Limits: []corev1.LimitRangeItem{
			{
				Type:                 corev1.LimitTypeContainer,
				Min:                  corev1.ResourceList{corev1.ResourceCPU: q("50m"), corev1.ResourceMemory: q("64Mi")},
				Max:                  corev1.ResourceList{corev1.ResourceCPU: q("2"), corev1.ResourceMemory: q("2Gi")},
				Default:              corev1.ResourceList{corev1.ResourceCPU: q("500m")},
				DefaultRequest:       corev1.ResourceList{corev1.ResourceCPU: q("100m")},
				MaxLimitRequestRatio: corev1.ResourceList{corev1.ResourceCPU: q("4")},
			},
			{
				Type: corev1.LimitTypePersistentVolumeClaim,
				Min:  corev1.ResourceList{corev1.ResourceStorage: q("1Gi")},
				Max:  corev1.ResourceList{corev1.ResourceStorage: q("50Gi")},
			},
		}},
	}

	info := limitRangeToInfo(lr)
	if info.Name != "limits" || info.Namespace != "team-a" || len(info.Limits) != 2 {
		t.Fatalf("unexpected header: %+v", info)
	}

	c := info.Limits[0]
	checks := []struct{ name, got, want string }{
		{"type", c.Type, "Container"},
		{"min cpu", c.Min["cpu"], "50m"},
		{"min memory", c.Min["memory"], "64Mi"},
		{"max cpu", c.Max["cpu"], "2"},
		{"default cpu", c.Default["cpu"], "500m"},
		{"defaultRequest cpu", c.DefaultRequest["cpu"], "100m"},
		{"ratio cpu", c.MaxLimitRequestRatio["cpu"], "4"},
		{"pvc type", info.Limits[1].Type, "PersistentVolumeClaim"},
		{"pvc max storage", info.Limits[1].Max["storage"], "50Gi"},
	}
	for _, ch := range checks {
		if ch.got != ch.want {
			t.Errorf("%s = %q, want %q", ch.name, ch.got, ch.want)
		}
	}

	// An unset list is an empty map, never nil: the frontend indexes it directly.
	if r := info.Limits[1].MaxLimitRequestRatio; r == nil || len(r) != 0 {
		t.Errorf("pvc ratio = %#v, want empty non-nil map", r)
	}
}
