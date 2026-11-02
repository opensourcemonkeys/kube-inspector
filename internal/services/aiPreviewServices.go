package services_k8sclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/yaml"

	"kube-ins/internal/models"
)

// The assistant's confirm card shows what a mutating action would do, and it
// asks the API server rather than guessing: every preview here is the real
// request sent with dryRun=All, so admission, validation and defaulting have
// all had their say. An error from one of these means the action itself would
// fail, and the assistant hands it back to the model instead of asking the user.

// previewTimeout bounds a preview; the REST mapper alone fans out over every
// API group-version.
const previewTimeout = 30 * time.Second

// workloadGVRs is the lowercase kind vocabulary of ScaleWorkload and
// RestartWorkload, as dynamic-client resources.
var workloadGVRs = map[string]schema.GroupVersionResource{
	"deployment":  {Group: "apps", Version: "v1", Resource: "deployments"},
	"statefulset": {Group: "apps", Version: "v1", Resource: "statefulsets"},
	"daemonset":   {Group: "apps", Version: "v1", Resource: "daemonsets"},
	"replicaset":  {Group: "apps", Version: "v1", Resource: "replicasets"},
}

// PreviewApply dry-runs every document of a manifest the way ApplyYaml would
// apply it.
func PreviewApply(config *rest.Config, yamlContent string) (models.AiActionPreview, error) {
	ctx, cancel := context.WithTimeout(context.Background(), previewTimeout)
	defer cancel()
	dyn, mapper, err := newDynamicAndMapper(config)
	if err != nil {
		return models.AiActionPreview{}, err
	}

	var out models.AiActionPreview
	decoder := utilyaml.NewYAMLOrJSONDecoder(strings.NewReader(yamlContent), yamlDecodeBuffer)
	for doc := 1; ; doc++ {
		var obj unstructured.Unstructured
		err := decoder.Decode(&obj)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return out, fmt.Errorf("document %d: %w", doc, err)
		}
		if len(obj.Object) == 0 {
			continue
		}
		target, _, err := applyTarget(dyn, mapper, &obj)
		if err != nil {
			return out, fmt.Errorf("document %d: %w", doc, err)
		}

		item := models.AiPreviewItem{Verb: "update", Kind: obj.GetKind(), Namespace: obj.GetNamespace(), Name: obj.GetName()}
		live, err := target.Get(ctx, obj.GetName(), metav1.GetOptions{})
		switch {
		case apierrors.IsNotFound(err):
			item.Verb = "create"
		case err != nil:
			return out, fmt.Errorf("%s/%s: %w", strings.ToLower(obj.GetKind()), obj.GetName(), err)
		default:
			item.Before = previewYaml(live)
		}
		after, err := target.Apply(ctx, obj.GetName(), &obj, applyOptions(true))
		if err != nil {
			return out, fmt.Errorf("%s/%s: %w", strings.ToLower(obj.GetKind()), obj.GetName(), err)
		}
		item.After = previewYaml(after)
		out.Items = append(out.Items, item)
	}
	if len(out.Items) == 0 {
		return out, fmt.Errorf("no Kubernetes objects found in the manifest")
	}
	return out, nil
}

// PreviewDelete dry-runs deleting one object by (group, resource).
func PreviewDelete(config *rest.Config, group, resource, namespace, name string) (models.AiActionPreview, error) {
	ctx, cancel := context.WithTimeout(context.Background(), previewTimeout)
	defer cancel()
	dyn, mapper, err := newDynamicAndMapper(config)
	if err != nil {
		return models.AiActionPreview{}, err
	}
	ri, err := resolveResourceInterface(dyn, mapper, group, resource, namespace)
	if err != nil {
		return models.AiActionPreview{}, err
	}
	return previewDelete(ctx, ri, name)
}

func previewDelete(ctx context.Context, ri dynamic.ResourceInterface, name string) (models.AiActionPreview, error) {
	live, err := ri.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return models.AiActionPreview{}, err
	}
	if err := ri.Delete(ctx, name, metav1.DeleteOptions{DryRun: []string{metav1.DryRunAll}}); err != nil {
		return models.AiActionPreview{}, err
	}
	return models.AiActionPreview{Items: []models.AiPreviewItem{{
		Verb: "delete", Kind: live.GetKind(), Namespace: live.GetNamespace(), Name: live.GetName(),
		Before: previewYaml(live),
	}}}, nil
}

// PreviewScale dry-runs setting a workload's replicas.
func PreviewScale(config *rest.Config, kind, namespace, name string, replicas int32) (models.AiActionPreview, error) {
	if replicas < 0 {
		return models.AiActionPreview{}, errNegativeReplicas
	}
	if kind == "daemonset" {
		return models.AiActionPreview{}, fmt.Errorf("scaling not supported for %q", kind)
	}
	patch, _ := json.Marshal(map[string]any{"spec": map[string]any{"replicas": replicas}})
	return previewPatch(config, kind, namespace, name, types.MergePatchType, patch)
}

// PreviewRestart dry-runs a rollout restart.
func PreviewRestart(config *rest.Config, kind, namespace, name string) (models.AiActionPreview, error) {
	if kind == "replicaset" {
		return models.AiActionPreview{}, fmt.Errorf("rollout restart not supported for %q", kind)
	}
	patch, err := restartPatch(time.Now())
	if err != nil {
		return models.AiActionPreview{}, err
	}
	return previewPatch(config, kind, namespace, name, types.StrategicMergePatchType, patch)
}

func previewPatch(config *rest.Config, kind, namespace, name string, pt types.PatchType, patch []byte) (models.AiActionPreview, error) {
	if namespace == "" || name == "" {
		return models.AiActionPreview{}, errNamespaceNameRequired
	}
	gvr, ok := workloadGVRs[kind]
	if !ok {
		return models.AiActionPreview{}, fmt.Errorf("unsupported workload kind %q", kind)
	}
	ctx, cancel := context.WithTimeout(context.Background(), previewTimeout)
	defer cancel()
	dyn, err := dynamic.NewForConfig(config)
	if err != nil {
		return models.AiActionPreview{}, err
	}
	ri := dyn.Resource(gvr).Namespace(namespace)
	live, err := ri.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return models.AiActionPreview{}, err
	}
	after, err := ri.Patch(ctx, name, pt, patch, metav1.PatchOptions{DryRun: []string{metav1.DryRunAll}})
	if err != nil {
		return models.AiActionPreview{}, err
	}
	return models.AiActionPreview{Items: []models.AiPreviewItem{{
		Verb: "update", Kind: live.GetKind(), Namespace: namespace, Name: name,
		Before: previewYaml(live), After: previewYaml(after),
	}}}, nil
}

// previewYaml renders one side of a preview: cleaned like the YAML panels,
// and with a Secret's values replaced by toolbox's hash so a diff still shows
// which keys change without the values ever reaching the screen.
func previewYaml(u *unstructured.Unstructured) string {
	if u == nil {
		return ""
	}
	c := u.DeepCopy()
	cleanUnstructured(c)
	if c.GetKind() == "Secret" && c.GroupVersionKind().Group == "" {
		redactSecret(c.Object)
	}
	b, err := yaml.Marshal(c.Object)
	if err != nil {
		return ""
	}
	return string(b)
}

// RedactedObjectYaml is GetObjectYaml for the assistant: a core Secret's
// values are hashed before the YAML leaves the backend, since the Ollama host
// need not be this machine.
func RedactedObjectYaml(config *rest.Config, group, resource, namespace, name string) (string, error) {
	dyn, mapper, err := newDynamicAndMapper(config)
	if err != nil {
		return "", err
	}
	ri, err := resolveResourceInterface(dyn, mapper, group, resource, namespace)
	if err != nil {
		return "", err
	}
	obj, err := ri.Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	return previewYaml(obj), nil
}
