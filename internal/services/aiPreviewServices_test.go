package services_k8sclient

import (
	"context"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func secretObj() *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Secret",
		"metadata": map[string]any{"name": "db", "namespace": "shop", "resourceVersion": "7", "uid": "u1"},
		"data":     map[string]any{"password": "aHVudGVyMg=="},
	}}
}

func TestPreviewYamlRedactsSecretsAndCleans(t *testing.T) {
	out := previewYaml(secretObj())
	if strings.Contains(out, "aHVudGVyMg==") {
		t.Fatalf("secret value leaked:\n%s", out)
	}
	if !strings.Contains(out, "password: sha256:") {
		t.Fatalf("key not kept with a hash:\n%s", out)
	}
	if strings.Contains(out, "resourceVersion") || strings.Contains(out, "uid:") {
		t.Fatalf("volatile metadata kept:\n%s", out)
	}
}

func TestPreviewDeleteShowsLiveObject(t *testing.T) {
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "secrets"}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{gvr: "SecretList"}, secretObj())
	p, err := previewDelete(context.Background(), dyn.Resource(gvr).Namespace("shop"), "db")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Items) != 1 {
		t.Fatalf("items = %+v", p.Items)
	}
	it := p.Items[0]
	if it.Verb != "delete" || it.Kind != "Secret" || it.Name != "db" || it.After != "" {
		t.Fatalf("item = %+v", it)
	}
	if strings.Contains(it.Before, "aHVudGVyMg==") {
		t.Fatal("secret value leaked into the preview")
	}
}

func TestPreviewDeleteMissingObjectFails(t *testing.T) {
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "secrets"}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{gvr: "SecretList"})
	if _, err := previewDelete(context.Background(), dyn.Resource(gvr).Namespace("shop"), "db"); err == nil {
		t.Fatal("previewing the delete of a missing object succeeded")
	}
}
