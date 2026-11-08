package services_k8sclient

import (
	"reflect"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"kube-ins/internal/models"
)

func ownerRefForTest() metav1.OwnerReference {
	return metav1.OwnerReference{APIVersion: "v1", Kind: "Thing", Name: "owner", UID: "1"}
}

func migObj(apiVersion, kind, ns, name string, fields map[string]any) *unstructured.Unstructured {
	o := map[string]any{"apiVersion": apiVersion, "kind": kind, "metadata": map[string]any{"name": name, "namespace": ns}}
	for k, v := range fields {
		o[k] = v
	}
	return &unstructured.Unstructured{Object: o}
}

func TestMigrationSkipReason(t *testing.T) {
	owned := migObj("v1", "ConfigMap", "a", "x", nil)
	owned.SetOwnerReferences(append(owned.GetOwnerReferences(), ownerRefForTest()))
	mover := migObj("v1", "Secret", "a", "k", nil)
	mover.SetLabels(map[string]string{moverLabel: "true"})

	for name, tc := range map[string]struct {
		u    *unstructured.Unstructured
		want string
	}{
		"pod":             {migObj("v1", "Pod", "a", "p", nil), MigrationSkipGenerated},
		"replicaset":      {migObj("apps/v1", "ReplicaSet", "a", "r", nil), MigrationSkipGenerated},
		"revision":        {migObj("apps/v1", "ControllerRevision", "a", "r", nil), MigrationSkipGenerated},
		"endpoints":       {migObj("v1", "Endpoints", "a", "e", nil), MigrationSkipGenerated},
		"endpointslice":   {migObj("discovery.k8s.io/v1", "EndpointSlice", "a", "e", nil), MigrationSkipGenerated},
		"event":           {migObj("v1", "Event", "a", "e", nil), MigrationSkipGenerated},
		"event new group": {migObj("events.k8s.io/v1", "Event", "a", "e", nil), MigrationSkipGenerated},
		"lease":           {migObj("coordination.k8s.io/v1", "Lease", "a", "l", nil), MigrationSkipGenerated},
		"root ca":         {migObj("v1", "ConfigMap", "a", "kube-root-ca.crt", nil), MigrationSkipGenerated},
		"owned":           {owned, MigrationSkipOwned},
		"standalone job":  {migObj("batch/v1", "Job", "a", "j", nil), MigrationSkipStandaloneJob},
		"sa token":        {migObj("v1", "Secret", "a", "t", map[string]any{"type": "kubernetes.io/service-account-token"}), MigrationSkipServiceToken},
		"pod metrics":     {migObj("metrics.k8s.io/v1beta1", "PodMetrics", "a", "m", nil), MigrationSkipClusterLocal},
		"volume snapshot": {migObj("snapshot.storage.k8s.io/v1", "VolumeSnapshot", "a", "s", nil), MigrationSkipClusterLocal},
		"our own worker":  {mover, MigrationSkipGenerated},
		"plain configmap": {migObj("v1", "ConfigMap", "a", "x", nil), ""},
		"plain secret":    {migObj("v1", "Secret", "a", "x", map[string]any{"type": "Opaque"}), ""},
		"deployment":      {migObj("apps/v1", "Deployment", "a", "d", nil), ""},
		"custom resource": {migObj("example.com/v1", "Widget", "a", "w", nil), ""},
	} {
		t.Run(name, func(t *testing.T) {
			if got := migrationSkipReason(tc.u); got != tc.want {
				t.Fatalf("reason = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMigratableService(t *testing.T) {
	src := migObj("v1", "Service", "a", "web", map[string]any{"spec": map[string]any{
		"clusterIP": "10.0.0.1", "clusterIPs": []any{"10.0.0.1"}, "healthCheckNodePort": int64(32000),
		"ports": []any{map[string]any{"port": int64(80), "nodePort": int64(31000)}},
	}, "status": map[string]any{"loadBalancer": map[string]any{}}})
	got := migratable(src, nil)

	spec := got.Object["spec"].(map[string]any)
	for _, f := range []string{"clusterIP", "clusterIPs", "healthCheckNodePort"} {
		if _, ok := spec[f]; ok {
			t.Errorf("%s survived", f)
		}
	}
	if _, ok := spec["ports"].([]any)[0].(map[string]any)["nodePort"]; ok {
		t.Error("nodePort survived")
	}
	if _, ok := got.Object["status"]; ok {
		t.Error("status survived")
	}
	if _, ok := src.Object["status"]; !ok {
		t.Error("the source object was modified")
	}
}

func TestMigratableDropsFinalizers(t *testing.T) {
	src := migObj("example.com/v1", "Widget", "a", "w", nil)
	src.SetFinalizers([]string{"example.com/cleanup"})
	if got := migratable(src, nil).GetFinalizers(); len(got) != 0 {
		t.Fatalf("finalizers = %v: with no controller on the target the object could never be deleted", got)
	}
}

func TestMigratableKeepsHeadlessService(t *testing.T) {
	src := migObj("v1", "Service", "a", "db", map[string]any{"spec": map[string]any{"clusterIP": "None", "clusterIPs": []any{"None"}}})
	if ip := migratable(src, nil).Object["spec"].(map[string]any)["clusterIP"]; ip != "None" {
		t.Fatalf("clusterIP = %v", ip)
	}
}

func TestMigratablePVC(t *testing.T) {
	src := migObj("v1", "PersistentVolumeClaim", "a", "data", map[string]any{
		"spec": map[string]any{
			"volumeName": "pv-123", "storageClassName": "ssd",
			"dataSource": map[string]any{"kind": "VolumeSnapshot"},
			"resources":  map[string]any{"requests": map[string]any{"storage": "10Gi"}},
		},
		"status": map[string]any{"capacity": map[string]any{"storage": "20Gi"}},
	})
	src.SetAnnotations(map[string]string{
		"pv.kubernetes.io/bind-completed":               "yes",
		"volume.kubernetes.io/selected-node":            "n1",
		"volume.beta.kubernetes.io/storage-provisioner": "x",
		"keep.example.com/mine":                         "1",
	})
	got := migratable(src, map[string]string{"ssd": "gp3"})
	spec := got.Object["spec"].(map[string]any)
	if _, ok := spec["volumeName"]; ok {
		t.Error("volumeName survived")
	}
	if _, ok := spec["dataSource"]; ok {
		t.Error("dataSource survived")
	}
	if spec["storageClassName"] != "gp3" {
		t.Errorf("class = %v", spec["storageClassName"])
	}
	if q := spec["resources"].(map[string]any)["requests"].(map[string]any)["storage"]; q != "20Gi" {
		t.Errorf("size = %v: an expanded volume must fit", q)
	}
	if !reflect.DeepEqual(got.GetAnnotations(), map[string]string{"keep.example.com/mine": "1"}) {
		t.Errorf("annotations = %v", got.GetAnnotations())
	}
}

func TestMigratablePVCDefaultClassDropsTheField(t *testing.T) {
	src := migObj("v1", "PersistentVolumeClaim", "a", "data", map[string]any{"spec": map[string]any{"storageClassName": "ssd"}})
	if _, ok := migratable(src, map[string]string{"ssd": ""}).Object["spec"].(map[string]any)["storageClassName"]; ok {
		t.Fatal("an empty target class must leave the claim to the target's default")
	}
}

func TestMigratableServiceAccountAndDeployment(t *testing.T) {
	sa := migObj("v1", "ServiceAccount", "a", "app", map[string]any{"secrets": []any{map[string]any{"name": "app-token"}}})
	if _, ok := migratable(sa, nil).Object["secrets"]; ok {
		t.Error("token references survived")
	}
	d := migObj("apps/v1", "Deployment", "a", "web", nil)
	d.SetAnnotations(map[string]string{"deployment.kubernetes.io/revision": "7"})
	if got := migratable(d, nil).GetAnnotations(); len(got) != 0 {
		t.Errorf("annotations = %v", got)
	}
}

func TestShapeForPrepareHoldsEverythingBack(t *testing.T) {
	d := migObj("apps/v1", "Deployment", "a", "web", map[string]any{"spec": map[string]any{"replicas": int64(3)}})
	c := migObj("batch/v1", "CronJob", "a", "nightly", map[string]any{"spec": map[string]any{"suspend": false}})
	shapeForPrepare(d, "m1")
	shapeForPrepare(c, "m1")
	if d.Object["spec"].(map[string]any)["replicas"] != int64(0) {
		t.Errorf("replicas = %v", d.Object["spec"])
	}
	if c.Object["spec"].(map[string]any)["suspend"] != true {
		t.Errorf("suspend = %v", c.Object["spec"])
	}
	if d.GetLabels()[migrationLabel] != "m1" {
		t.Errorf("labels = %v", d.GetLabels())
	}
}

func TestShapeForFinalRestoresWhatTheSourceHad(t *testing.T) {
	rec := &models.MigrationRecord{
		Workloads: []models.MigrationWorkload{{Kind: "Deployment", Namespace: "a", Name: "web", Replicas: 3}},
		CronJobs:  []models.MigrationCronJob{{Namespace: "a", Name: "held", WasSuspended: true}, {Namespace: "a", Name: "live"}},
	}
	d := migObj("apps/v1", "Deployment", "a", "web", map[string]any{"spec": map[string]any{"replicas": int64(0)}})
	held := migObj("batch/v1", "CronJob", "a", "held", map[string]any{"spec": map[string]any{"suspend": true}})
	live := migObj("batch/v1", "CronJob", "a", "live", map[string]any{"spec": map[string]any{"suspend": true}})
	for _, u := range []*unstructured.Unstructured{d, held, live} {
		shapeForFinal(u, rec)
	}
	if d.Object["spec"].(map[string]any)["replicas"] != int64(3) {
		t.Errorf("replicas = %v", d.Object["spec"])
	}
	if held.Object["spec"].(map[string]any)["suspend"] != true {
		t.Error("a CronJob suspended before the migration must stay suspended")
	}
	if live.Object["spec"].(map[string]any)["suspend"] != false {
		t.Error("a running CronJob must run again")
	}
	if _, ok := d.GetLabels()[migrationLabel]; ok {
		t.Error("the migration label must be gone from the final form")
	}
}

func TestMigrationApplyOrder(t *testing.T) {
	objs := []*unstructured.Unstructured{
		migObj("networking.k8s.io/v1", "Ingress", "a", "i", nil),
		migObj("apps/v1", "Deployment", "a", "d", nil),
		migObj("v1", "Service", "a", "s", nil),
		migObj("v1", "PersistentVolumeClaim", "a", "p", nil),
		migObj("v1", "Secret", "a", "c", nil),
		migObj("rbac.authorization.k8s.io/v1", "RoleBinding", "a", "rb", nil),
		migObj("rbac.authorization.k8s.io/v1", "Role", "a", "r", nil),
		migObj("v1", "ServiceAccount", "a", "sa", nil),
	}
	sortForApply(objs)
	var got []string
	for _, o := range objs {
		got = append(got, o.GetKind())
	}
	want := []string{"ServiceAccount", "Role", "RoleBinding", "Secret", "PersistentVolumeClaim", "Service", "Deployment", "Ingress"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v", got)
	}
}
