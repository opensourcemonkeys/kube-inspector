package controller_app

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"kube-ins/internal/ai"
	bussiness "kube-ins/internal/business"
	"kube-ins/internal/models"
	"kube-ins/internal/safego"
)

// ============================================================================
// App & System Functions
// ============================================================================

func (a *App) GetAppInfo() models.AppInfo {
	return bussiness.GetAppInfo()
}

func (a *App) CheckForUpdate() models.UpdateInfo {
	return bussiness.CheckForUpdate()
}

// SetUpdateChannel switches between the stable and beta update feeds. There is
// deliberately no matching getter: Wails binds every exported App method, so
// each one is permanent frontend API surface, and the current channel already
// rides back on UpdateInfo.Channel from the CheckForUpdate the caller runs next.
func (a *App) SetUpdateChannel(channel string) error {
	return bussiness.SetUpdateChannel(channel)
}

var updateJobs = newCancelRegistry()

// StartSelfUpdate downloads and installs the latest release, streaming progress
// to the frontend as update:progress / update:done / update:error events
// suffixed with sessionId. The manifest is re-read here rather than taken from
// the caller, so the download URL and the platform check are always the
// backend's own.
//
// update:done carries {"restart": "relaunch"|"external"} — "relaunch" means the
// new files are in place and the shell should re-exec, "external" means the
// installer (or the macOS swap helper) will start the new version once we quit.
func (a *App) StartSelfUpdate(sessionId string) error {
	info := bussiness.CheckForUpdate()

	ctx, cancel := context.WithCancel(context.Background())
	tok := updateJobs.begin(sessionId, cancel)

	safego.Go("controller.selfUpdate", func() {
		defer updateJobs.done(sessionId, tok)

		onProgress := func(p models.UpdateProgress) {
			a.emit("update:progress:"+sessionId, p)
		}

		restart, err := bussiness.RunSelfUpdate(ctx, info, onProgress)
		if err != nil {
			// A cancelled download is the user closing the dialog, not a failure.
			if ctx.Err() != nil {
				return
			}
			a.emit("update:error:"+sessionId, map[string]any{"message": err.Error()})
			return
		}
		a.emit("update:done:"+sessionId, map[string]any{"restart": restart})
	})

	return nil
}

// CancelSelfUpdate aborts an in-flight download. It has no effect once the
// installer has been handed the package.
func (a *App) CancelSelfUpdate(sessionId string) error {
	updateJobs.cancel(sessionId)
	return nil
}

// SaveSnapshot prompts the user for a location (native Save dialog) and writes
// the given PNG (data URL or base64). Returns the saved path, or "" if cancelled.
func (a *App) SaveSnapshot(defaultName, dataURL string) (string, error) {
	path, err := a.saveFile(SaveFileOptions{
		Title:       "Save snapshot",
		DefaultName: defaultName,
		FilterName:  "PNG Image (*.png)",
		Pattern:     "*.png",
	})
	if err != nil || path == "" {
		return "", err
	}
	return bussiness.SaveSnapshotPNG(path, dataURL)
}

// SaveReport prompts for a location and writes an HTML report to it. Returns the
// saved path, or "" if the user cancelled.
func (a *App) SaveReport(defaultName, content string) (string, error) {
	path, err := a.saveFile(SaveFileOptions{
		Title:       "Save report",
		DefaultName: defaultName,
		FilterName:  "HTML (*.html)",
		Pattern:     "*.html",
	})
	if err != nil || path == "" {
		return "", err
	}
	if !strings.HasSuffix(strings.ToLower(path), ".html") {
		path += ".html"
	}
	return bussiness.SaveTextFile(path, content)
}

// SaveText prompts for a location and writes plain text to it. Returns the saved
// path, or "" if the user cancelled. Separate from SaveReport because that one
// forces an .html extension; this is the terminal's "save output" path.
func (a *App) SaveText(defaultName, content string) (string, error) {
	path, err := a.saveFile(SaveFileOptions{
		Title:       "Save text",
		DefaultName: defaultName,
		FilterName:  "Text file (*.txt)",
		Pattern:     "*.txt",
	})
	if err != nil || path == "" {
		return "", err
	}
	lower := strings.ToLower(path)
	if !strings.HasSuffix(lower, ".txt") && !strings.HasSuffix(lower, ".log") {
		path += ".txt"
	}
	return bussiness.SaveTextFile(path, content)
}

func (a *App) GetK8sSchema() string {
	return bussiness.GetK8sSchema()
}

// ============================================================================
// Cluster Screen: Nodes & Namespaces
// ============================================================================

func (a *App) GetNodes(clusterName string) ([]models.NodeInfo, error) {
	return bussiness.GetNodes(clusterName)
}

// GetClusterCounts backs the Overview dashboard's tile row. It exists so the
// dashboard needs one small call instead of six full listings it only counts.
func (a *App) GetClusterCounts(clusterName string) (models.ClusterCounts, error) {
	return bussiness.GetClusterCounts(clusterName)
}

func (a *App) GetMetricsSnapshot(clusterName string) (models.MetricsSnapshot, error) {
	return bussiness.GetMetricsSnapshot(clusterName)
}

func (a *App) GetNamespaces(clusterName string) ([]models.NamespaceInfo, error) {
	return bussiness.GetNamespaces(clusterName)
}

func (a *App) CreateNamespace(clusterName string, name string, labels map[string]string) error {
	return bussiness.CreateNamespace(clusterName, name, labels)
}

func (a *App) DeleteNamespace(clusterName string, name string) error {
	return bussiness.DeleteNamespace(clusterName, name)
}

func (a *App) GetNamespaceYaml(clusterName string, name string) (string, error) {
	return bussiness.GetNamespaceYaml(clusterName, name)
}

// GetResourceQuotas lists every quota in the cluster with one API call. The
// Resource Quotas view used to rebuild this from GetNamespaces, which fanned
// out one quota list per namespace.
func (a *App) GetResourceQuotas(clusterName string) ([]models.NamespacedResourceQuota, error) {
	return bussiness.GetResourceQuotas(clusterName)
}

func (a *App) GetResourceQuotaYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetResourceQuotaYaml(clusterName, name, namespace)
}

func (a *App) UpdateResourceQuotaYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateResourceQuotaYaml(clusterName, name, namespace, yamlContent)
}

func (a *App) CordonNode(clusterName string, name string) error {
	return bussiness.CordonNode(clusterName, name)
}

func (a *App) UncordonNode(clusterName string, name string) error {
	return bussiness.UncordonNode(clusterName, name)
}

func (a *App) DrainNode(clusterName string, name string) error {
	return bussiness.DrainNode(clusterName, name)
}

func (a *App) GetNodeYaml(clusterName string, name string) (string, error) {
	return bussiness.GetNodeYaml(clusterName, name)
}

func (a *App) UpdateNodeYaml(clusterName string, name string, yamlContent string) error {
	return bussiness.UpdateNodeYaml(clusterName, name, yamlContent)
}

// ============================================================================
// Workloads Screen: Pods
// ============================================================================

func (a *App) GetPods(clusterName string) ([]models.PodInfo, error) {
	return bussiness.GetPods(clusterName)
}

func (a *App) DeletePod(clusterName string, name string, namespace string) error {
	return bussiness.DeletePod(clusterName, name, namespace)
}

func (a *App) GetPodYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetPodYaml(clusterName, name, namespace)
}

func (a *App) CreatePodExecSession(clusterName string, sessionId string, namespace string, podName string, container string) error {
	return bussiness.CreatePodExecSession(clusterName, sessionId, namespace, podName, container,
		func(data string) { a.emit("exec:output:"+sessionId, data) },
		func() { a.emit("exec:closed:" + sessionId) },
	)
}

func (a *App) WriteToPodExecSession(sessionId string, data string) error {
	return bussiness.WriteToPodExecSession(sessionId, data)
}

func (a *App) ResizePodExecSession(sessionId string, cols int, rows int) error {
	return bussiness.ResizePodExecSession(sessionId, cols, rows)
}

func (a *App) ClosePodExecSession(sessionId string) error {
	return bussiness.ClosePodExecSession(sessionId)
}

// ============================================================================
// Workloads Screen: Cross-kind actions (scale, rollout restart, suspend)
// ============================================================================

// ScaleWorkload takes `replicas` as int rather than int32 because JavaScript
// has no int32 and the generated TypeScript is `number` either way. The range
// check therefore has to happen here, *before* the narrowing conversion —
// int32(replicas) on an out-of-range value wraps silently and would scale a
// workload to an arbitrary number.
func (a *App) ScaleWorkload(clusterName string, kind string, name string, namespace string, replicas int) error {
	if replicas < 0 {
		return fmt.Errorf("replicas must be >= 0, got %d", replicas)
	}
	if replicas > math.MaxInt32 {
		return fmt.Errorf("replicas must be <= %d, got %d", math.MaxInt32, replicas)
	}
	return bussiness.ScaleWorkload(clusterName, kind, name, namespace, int32(replicas))
}

func (a *App) RestartWorkload(clusterName string, kind string, name string, namespace string) error {
	return bussiness.RestartWorkload(clusterName, kind, name, namespace)
}

func (a *App) SetCronJobSuspend(clusterName string, name string, namespace string, suspend bool) error {
	return bussiness.SetCronJobSuspend(clusterName, name, namespace, suspend)
}

// GetWorkloadAutoscaler returns nil when no HPA targets the workload *and* when
// the lookup could not be performed at all — the frontend treats both as "no
// warning to show". See business.GetWorkloadAutoscaler for why.
func (a *App) GetWorkloadAutoscaler(clusterName string, kind string, name string, namespace string) (*models.HPAInfo, error) {
	return bussiness.GetWorkloadAutoscaler(clusterName, kind, name, namespace)
}

// ============================================================================
// Workloads Screen: Deployments
// ============================================================================

func (a *App) GetDeployments(clusterName string) ([]models.DeploymentInfo, error) {
	return bussiness.GetDeployments(clusterName)
}

func (a *App) DeleteDeployment(clusterName string, name string, namespace string) error {
	return bussiness.DeleteDeployment(clusterName, name, namespace)
}

func (a *App) GetDeploymentYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetDeploymentYaml(clusterName, name, namespace)
}

func (a *App) UpdateDeploymentYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateDeploymentYaml(clusterName, name, namespace, yamlContent)
}

// ============================================================================
// Workloads Screen: StatefulSets
// ============================================================================

func (a *App) GetStatefulSets(clusterName string) ([]models.StatefulSetInfo, error) {
	return bussiness.GetStatefulSets(clusterName)
}

func (a *App) DeleteStatefulSet(clusterName string, name string, namespace string) error {
	return bussiness.DeleteStatefulSet(clusterName, name, namespace)
}

func (a *App) GetStatefulSetYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetStatefulSetYaml(clusterName, name, namespace)
}

func (a *App) UpdateStatefulSetYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateStatefulSetYaml(clusterName, name, namespace, yamlContent)
}

// ============================================================================
// Workloads Screen: ReplicaSets
// ============================================================================

func (a *App) GetReplicaSets(clusterName string) ([]models.ReplicaSetInfo, error) {
	return bussiness.GetReplicaSets(clusterName)
}

func (a *App) DeleteReplicaSet(clusterName string, name string, namespace string) error {
	return bussiness.DeleteReplicaSet(clusterName, name, namespace)
}

func (a *App) GetReplicaSetYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetReplicaSetYaml(clusterName, name, namespace)
}

func (a *App) UpdateReplicaSetYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateReplicaSetYaml(clusterName, name, namespace, yamlContent)
}

// ============================================================================
// Workloads Screen: DaemonSets
// ============================================================================

func (a *App) GetDaemonSets(clusterName string) ([]models.DaemonSetInfo, error) {
	return bussiness.GetDaemonSets(clusterName)
}

func (a *App) DeleteDaemonSet(clusterName string, name string, namespace string) error {
	return bussiness.DeleteDaemonSet(clusterName, name, namespace)
}

func (a *App) GetDaemonSetYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetDaemonSetYaml(clusterName, name, namespace)
}

func (a *App) UpdateDaemonSetYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateDaemonSetYaml(clusterName, name, namespace, yamlContent)
}

// ============================================================================
// Workloads Screen: Jobs & CronJobs
// ============================================================================

func (a *App) GetJobs(clusterName string) ([]models.JobInfo, error) {
	return bussiness.GetJobs(clusterName)
}

func (a *App) DeleteJob(clusterName string, name string, namespace string) error {
	return bussiness.DeleteJob(clusterName, name, namespace)
}

func (a *App) GetJobYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetJobYaml(clusterName, name, namespace)
}

func (a *App) UpdateJobYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateJobYaml(clusterName, name, namespace, yamlContent)
}

func (a *App) GetCronJobs(clusterName string) ([]models.CronJobInfo, error) {
	return bussiness.GetCronJobs(clusterName)
}

func (a *App) DeleteCronJob(clusterName string, name string, namespace string) error {
	return bussiness.DeleteCronJob(clusterName, name, namespace)
}

func (a *App) GetCronJobYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetCronJobYaml(clusterName, name, namespace)
}

func (a *App) UpdateCronJobYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateCronJobYaml(clusterName, name, namespace, yamlContent)
}

// ============================================================================
// Configuration Screen: Secrets
// ============================================================================

func (a *App) GetSecrets(clusterName string) ([]models.SecretInfo, error) {
	return bussiness.GetSecrets(clusterName)
}

func (a *App) DeleteSecret(clusterName string, name string, namespace string) error {
	return bussiness.DeleteSecret(clusterName, name, namespace)
}

func (a *App) GetSecretYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetSecretYaml(clusterName, name, namespace)
}

func (a *App) UpdateSecretYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateSecretYaml(clusterName, name, namespace, yamlContent)
}

func (a *App) GetSecretData(clusterName string, name string, namespace string) (map[string]string, error) {
	return bussiness.GetSecretData(clusterName, name, namespace)
}

func (a *App) UpdateSecretData(clusterName string, name string, namespace string, data map[string]string) error {
	return bussiness.UpdateSecretData(clusterName, name, namespace, data)
}

// ============================================================================
// Configuration Screen: ConfigMaps
// ============================================================================

func (a *App) GetConfigMaps(clusterName string) ([]models.ConfigMapInfo, error) {
	return bussiness.GetConfigMaps(clusterName)
}

func (a *App) DeleteConfigMap(clusterName string, name string, namespace string) error {
	return bussiness.DeleteConfigMap(clusterName, name, namespace)
}

func (a *App) GetConfigMapYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetConfigMapYaml(clusterName, name, namespace)
}

func (a *App) UpdateConfigMapYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateConfigMapYaml(clusterName, name, namespace, yamlContent)
}

func (a *App) GetConfigMapData(clusterName string, name string, namespace string) (map[string]string, error) {
	return bussiness.GetConfigMapData(clusterName, name, namespace)
}

func (a *App) UpdateConfigMapData(clusterName string, name string, namespace string, data map[string]string) error {
	return bussiness.UpdateConfigMapData(clusterName, name, namespace, data)
}

// ============================================================================
// Access Control: ServiceAccounts, Roles, RoleBindings
// ============================================================================

func (a *App) GetServiceAccounts(clusterName string) ([]models.ServiceAccountInfo, error) {
	return bussiness.GetServiceAccounts(clusterName)
}

func (a *App) GetServiceAccountYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetServiceAccountYaml(clusterName, name, namespace)
}

func (a *App) DeleteServiceAccount(clusterName string, name string, namespace string) error {
	return bussiness.DeleteServiceAccount(clusterName, name, namespace)
}

func (a *App) UpdateServiceAccountYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateServiceAccountYaml(clusterName, name, namespace, yamlContent)
}

func (a *App) UpdateServiceAccount(clusterName string, name string, namespace string, labels map[string]string, annotations map[string]string) error {
	return bussiness.UpdateServiceAccount(clusterName, name, namespace, labels, annotations)
}

func (a *App) GetRoles(clusterName string) ([]models.RoleInfo, error) {
	return bussiness.GetRoles(clusterName)
}

func (a *App) GetRoleYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetRoleYaml(clusterName, name, namespace)
}

func (a *App) DeleteRole(clusterName string, name string, namespace string) error {
	return bussiness.DeleteRole(clusterName, name, namespace)
}

func (a *App) UpdateRoleYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateRoleYaml(clusterName, name, namespace, yamlContent)
}

func (a *App) UpdateRole(clusterName string, name string, namespace string, labels map[string]string, annotations map[string]string, rules []models.PolicyRuleInfo) error {
	return bussiness.UpdateRole(clusterName, name, namespace, labels, annotations, rules)
}

func (a *App) GetRoleBindings(clusterName string) ([]models.RoleBindingInfo, error) {
	return bussiness.GetRoleBindings(clusterName)
}

func (a *App) GetRoleBindingYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetRoleBindingYaml(clusterName, name, namespace)
}

func (a *App) DeleteRoleBinding(clusterName string, name string, namespace string) error {
	return bussiness.DeleteRoleBinding(clusterName, name, namespace)
}

func (a *App) UpdateRoleBindingYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateRoleBindingYaml(clusterName, name, namespace, yamlContent)
}

func (a *App) UpdateRoleBinding(clusterName string, name string, namespace string, labels map[string]string, annotations map[string]string, subjects []models.SubjectInfo) error {
	return bussiness.UpdateRoleBinding(clusterName, name, namespace, labels, annotations, subjects)
}

// ============================================================================
// Terminal Screen
// ============================================================================

func (a *App) CreateTerminalSession(id string, clusterName string) error {
	return bussiness.CreateTerminalSession(id, clusterName,
		func(data string) { a.emit("terminal:output:"+id, data) },
		func() { a.emit("terminal:exit:" + id) },
	)
}

// SetTerminalSessionCluster points a running terminal at another cluster's
// kubeconfig without restarting its shell.
func (a *App) SetTerminalSessionCluster(id string, clusterName string) error {
	return bussiness.SetTerminalSessionCluster(id, clusterName)
}

func (a *App) WriteToTerminalSession(id string, data string) error {
	return bussiness.WriteToTerminalSession(id, data)
}

func (a *App) ResizeTerminalSession(id string, cols int, rows int) error {
	return bussiness.ResizeTerminalSession(id, cols, rows)
}

func (a *App) CloseTerminalSession(id string) error {
	return bussiness.CloseTerminalSession(id)
}

// ============================================================================
// CLI Mode (fullscreen terminal UI hosted in the GUI)
// ============================================================================

func (a *App) CreateCliModeSession(id string) error {
	return bussiness.CreateCliModeSession(id,
		func(data string) { a.emit("climode:output:"+id, data) },
		func() { a.emit("climode:exit:" + id) },
	)
}

func (a *App) WriteToCliModeSession(id string, data string) error {
	return bussiness.WriteToCliModeSession(id, data)
}

func (a *App) ResizeCliModeSession(id string, cols int, rows int) error {
	return bussiness.ResizeCliModeSession(id, cols, rows)
}

func (a *App) CloseCliModeSession(id string) error {
	return bussiness.CloseCliModeSession(id)
}

// ============================================================================
// Network Screen: Network Policies
// ============================================================================

func (a *App) GetNetworkPolicies(clusterName string) ([]models.NetworkPolicyInfo, error) {
	return bussiness.GetNetworkPolicies(clusterName)
}

func (a *App) DeleteNetworkPolicy(clusterName string, name string, namespace string) error {
	return bussiness.DeleteNetworkPolicy(clusterName, name, namespace)
}

func (a *App) GetNetworkPolicyYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetNetworkPolicyYaml(clusterName, name, namespace)
}

func (a *App) UpdateNetworkPolicyYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateNetworkPolicyYaml(clusterName, name, namespace, yamlContent)
}

func (a *App) GetNetworkPolicyDetail(clusterName string, name string, namespace string) (*models.NetworkPolicyDetail, error) {
	return bussiness.GetNetworkPolicyDetail(clusterName, name, namespace)
}

func (a *App) ParseNetworkPolicyYaml(yamlContent string) (*models.NetworkPolicyDetail, error) {
	return bussiness.ParseNetworkPolicyYaml(yamlContent)
}

// ============================================================================
// Network Screen: Services
// ============================================================================

func (a *App) GetServices(clusterName string) ([]models.ServiceInfo, error) {
	return bussiness.GetServices(clusterName)
}

func (a *App) DeleteService(clusterName string, name string, namespace string) error {
	return bussiness.DeleteService(clusterName, name, namespace)
}

func (a *App) GetServiceYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetServiceYaml(clusterName, name, namespace)
}

func (a *App) UpdateServiceYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateServiceYaml(clusterName, name, namespace, yamlContent)
}

// ============================================================================
// Cluster Screen: LimitRanges
// ============================================================================

func (a *App) GetLimitRanges(clusterName string) ([]models.LimitRangeInfo, error) {
	return bussiness.GetLimitRanges(clusterName)
}

func (a *App) GetLimitRangeYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetLimitRangeYaml(clusterName, name, namespace)
}

func (a *App) DeleteLimitRange(clusterName string, name string, namespace string) error {
	return bussiness.DeleteLimitRange(clusterName, name, namespace)
}

func (a *App) UpdateLimitRangeYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateLimitRangeYaml(clusterName, name, namespace, yamlContent)
}

// ============================================================================
// Cluster Screen: Events
// ============================================================================

func (a *App) GetEvents(clusterName string) ([]models.EventInfo, error) {
	return bussiness.GetEvents(clusterName)
}

// ============================================================================
// Network Screen: Ingresses
// ============================================================================

func (a *App) GetIngresses(clusterName string) ([]models.IngressInfo, error) {
	return bussiness.GetIngresses(clusterName)
}

func (a *App) DeleteIngress(clusterName string, name string, namespace string) error {
	return bussiness.DeleteIngress(clusterName, name, namespace)
}

func (a *App) GetIngressYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetIngressYaml(clusterName, name, namespace)
}

func (a *App) UpdateIngressYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateIngressYaml(clusterName, name, namespace, yamlContent)
}

// ============================================================================
// Network Screen: IngressClasses
// ============================================================================

func (a *App) GetIngressClasses(clusterName string) ([]models.IngressClassInfo, error) {
	return bussiness.GetIngressClasses(clusterName)
}

func (a *App) GetIngressClassYaml(clusterName string, name string) (string, error) {
	return bussiness.GetIngressClassYaml(clusterName, name)
}

func (a *App) UpdateIngressClassYaml(clusterName string, name string, yamlContent string) error {
	return bussiness.UpdateIngressClassYaml(clusterName, name, yamlContent)
}

// ============================================================================
// Network Screen: Endpoints
// ============================================================================

func (a *App) GetEndpoints(clusterName string) ([]models.EndpointInfo, error) {
	return bussiness.GetEndpoints(clusterName)
}

func (a *App) GetEndpointYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetEndpointYaml(clusterName, name, namespace)
}

func (a *App) UpdateEndpointYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdateEndpointYaml(clusterName, name, namespace, yamlContent)
}

func (a *App) DeleteEndpoint(clusterName string, name string, namespace string) error {
	return bussiness.DeleteEndpoint(clusterName, name, namespace)
}

// ============================================================================
// Storage Screen: Persistent Volumes
// ============================================================================

func (a *App) GetPersistentVolumes(clusterName string) ([]models.PersistentVolumeInfo, error) {
	return bussiness.GetPersistentVolumes(clusterName)
}

func (a *App) GetPersistentVolumeYaml(clusterName string, name string) (string, error) {
	return bussiness.GetPersistentVolumeYaml(clusterName, name)
}

func (a *App) UpdatePersistentVolumeYaml(clusterName string, name string, yamlContent string) error {
	return bussiness.UpdatePersistentVolumeYaml(clusterName, name, yamlContent)
}

// ============================================================================
// Storage Screen: Persistent Volume Claims
// ============================================================================

func (a *App) GetPersistentVolumeClaims(clusterName string) ([]models.PersistentVolumeClaimInfo, error) {
	return bussiness.GetPersistentVolumeClaims(clusterName)
}

func (a *App) DeletePersistentVolumeClaim(clusterName string, name string, namespace string) error {
	return bussiness.DeletePersistentVolumeClaim(clusterName, name, namespace)
}

func (a *App) GetPersistentVolumeClaimYaml(clusterName string, name string, namespace string) (string, error) {
	return bussiness.GetPersistentVolumeClaimYaml(clusterName, name, namespace)
}

func (a *App) UpdatePersistentVolumeClaimYaml(clusterName string, name string, namespace string, yamlContent string) error {
	return bussiness.UpdatePersistentVolumeClaimYaml(clusterName, name, namespace, yamlContent)
}

// ============================================================================
// Storage Screen: Storage Classes
// ============================================================================

func (a *App) GetStorageClasses(clusterName string) ([]models.StorageClassInfo, error) {
	return bussiness.GetStorageClasses(clusterName)
}

func (a *App) GetStorageClassYaml(clusterName string, name string) (string, error) {
	return bussiness.GetStorageClassYaml(clusterName, name)
}

func (a *App) UpdateStorageClassYaml(clusterName string, name string, yamlContent string) error {
	return bussiness.UpdateStorageClassYaml(clusterName, name, yamlContent)
}

// ============================================================================
// YAML Editor Screen
// ============================================================================

func (a *App) ApplyYaml(clusterName string, yamlContent string) (string, error) {
	return bussiness.ApplyYaml(clusterName, yamlContent)
}

// ============================================================================
// Cluster Management
// ============================================================================

func (a *App) ListClusters() ([]string, error) {
	return bussiness.ListClusters()
}

func (a *App) SaveCluster(name string, content string) error {
	return bussiness.SaveCluster(name, content)
}

func (a *App) GetClusterContent(name string) (string, error) {
	return bussiness.GetClusterContent(name)
}

func (a *App) DeleteCluster(name string) error {
	return bussiness.DeleteCluster(name)
}

func (a *App) SetActiveCluster(name string) error {
	return bussiness.SetActiveCluster(name)
}

func (a *App) GetActiveCluster() string {
	return bussiness.GetActiveCluster()
}

func (a *App) CheckClusterConnection() error {
	return bussiness.CheckClusterConnection()
}

func (a *App) GetClusterGraph(clusterName string) (*models.ClusterGraph, error) {
	return bussiness.GetClusterGraph(clusterName)
}

func (a *App) GetSecurityGraph(clusterName string) (*models.SecurityGraph, error) {
	return bussiness.GetSecurityGraph(clusterName)
}

func (a *App) TrivyScanImage(clusterName, imageRef string) (*models.TrivyScanResult, error) {
	return bussiness.TrivyScanImage(clusterName, imageRef)
}

func (a *App) TrivyListPodImages(clusterName, namespace string) ([]string, error) {
	return bussiness.TrivyListPodImages(clusterName, namespace)
}

// TrivyListPodImagesWithContext returns pod images with owner resource context
// (Deployment, StatefulSet, etc.) for the vulnerability tab.
func (a *App) TrivyListPodImagesWithContext(clusterName, namespace string) ([]models.TrivyK8sImageInfo, error) {
	return bussiness.TrivyListPodImagesWithContext(clusterName, namespace)
}

// K8s misconfig + secret scan — async, streams progress via Wails events.
// Events emitted (all suffixed with scanId):
//
//	"trivy:k8s:progress:{scanId}" → models.TrivyScanProgress
//	"trivy:k8s:done:{scanId}"     → *models.TrivyK8sScanResult
//	"trivy:k8s:error:{scanId}"    → string

var k8sScanJobs = newCancelRegistry()

// TrivyStartK8sScan starts an async misconfig+secret cluster scan. Returns
// immediately; results arrive via Wails events.
func (a *App) TrivyStartK8sScan(scanId, clusterName, namespace string) error {
	ctx, cancel := context.WithCancel(context.Background())
	tok := k8sScanJobs.begin(scanId, cancel)

	safego.Go("controller.trivyK8sScan", func() {
		defer k8sScanJobs.done(scanId, tok)

		onProgress := func(phase string, current, total int, msg string) {
			a.emit("trivy:k8s:progress:"+scanId, models.TrivyScanProgress{
				Phase: phase, Current: current, Total: total, Message: msg,
			})
		}

		result, err := bussiness.TrivyScanK8sResources(ctx, clusterName, namespace, onProgress)
		if err != nil {
			a.emit("trivy:k8s:error:"+scanId, err.Error())
			return
		}
		a.emit("trivy:k8s:done:"+scanId, result)
	})
	return nil
}

// TrivyStopK8sScan cancels an in-flight K8s scan.
func (a *App) TrivyStopK8sScan(scanId string) error {
	k8sScanJobs.cancel(scanId)
	return nil
}

func (a *App) GetObjectYaml(clusterName, group, resource, namespace, name string) (string, error) {
	return bussiness.GetObjectYaml(clusterName, group, resource, namespace, name)
}

// GetObjectDescribe renders the full `kubectl describe` text for any object,
// addressed by its plural resource name (the same strings the sidebar/TUI use).
// Implemented over kubectl's own describers via the API — no subprocess.
func (a *App) GetObjectDescribe(clusterName, resource, namespace, name string) (string, error) {
	return bussiness.GetObjectDescribe(clusterName, resource, namespace, name)
}

func (a *App) UpdateObjectYaml(clusterName, group, resource, namespace, name, yamlContent string) error {
	return bussiness.UpdateObjectYaml(clusterName, group, resource, namespace, name, yamlContent)
}

func (a *App) DeleteObject(clusterName, group, resource, namespace, name string) error {
	return bussiness.DeleteObject(clusterName, group, resource, namespace, name)
}

// CRDs: list definitions and their custom resource instances (CRD view).
func (a *App) GetCRDs(clusterName string) ([]models.CRDInfo, error) {
	return bussiness.GetCRDs(clusterName)
}

func (a *App) GetCustomResources(clusterName, group, resource string) ([]models.CustomResourceInfo, error) {
	return bussiness.GetCustomResources(clusterName, group, resource)
}

// GetCRDInstanceCounts returns instance counts keyed by CRD name (-1 = unknown).
func (a *App) GetCRDInstanceCounts(clusterName string) (map[string]int, error) {
	return bussiness.GetCRDInstanceCounts(clusterName)
}

// GetResourceTable lists any (group, resource) with the server-rendered
// columns `kubectl get` would print.
func (a *App) GetResourceTable(clusterName, group, resource, namespace string) (models.ResourceTable, error) {
	return bussiness.GetResourceTable(clusterName, group, resource, namespace)
}

// ============================================================================
// Utility Functions: Resource Relationships & Navigation
// ============================================================================

func (a *App) GetPodContainers(clusterName string, name string, namespace string) ([]string, error) {
	return bussiness.GetPodContainers(clusterName, name, namespace)
}

func (a *App) GetDeploymentPods(clusterName string, name string, namespace string) ([]string, error) {
	return bussiness.GetDeploymentPods(clusterName, name, namespace)
}

func (a *App) GetStatefulSetPods(clusterName string, name string, namespace string) ([]string, error) {
	return bussiness.GetStatefulSetPods(clusterName, name, namespace)
}

func (a *App) GetReplicaSetPods(clusterName string, name string, namespace string) ([]string, error) {
	return bussiness.GetReplicaSetPods(clusterName, name, namespace)
}

func (a *App) GetDaemonSetPods(clusterName string, name string, namespace string) ([]string, error) {
	return bussiness.GetDaemonSetPods(clusterName, name, namespace)
}

func (a *App) GetJobPods(clusterName string, name string, namespace string) ([]string, error) {
	return bussiness.GetJobPods(clusterName, name, namespace)
}

func (a *App) GetCronJobPods(clusterName string, name string, namespace string) ([]string, error) {
	return bussiness.GetCronJobPods(clusterName, name, namespace)
}

// ============================================================================
// Logs Screen
// ============================================================================

func (a *App) StartLogStream(clusterName string, sessionId string, podName string, namespace string, container string) error {
	return bussiness.StartLogStream(clusterName, sessionId, podName, namespace, container, func(data string) {
		a.emit("log:output:"+sessionId, data)
	})
}

func (a *App) StopLogStream(sessionId string) {
	bussiness.StopLogStream(sessionId)
}

// ============================================================================
// Instance Hub — cross-instance tab transfer
// ============================================================================

func (a *App) GetInstances() []models.InstanceInfo {
	return a.hub.GetInstances()
}

func (a *App) GetSelfInstanceInfo() models.InstanceInfo {
	return a.hub.GetSelfInfo()
}

func (a *App) TransferTab(targetInstanceId string, panel models.SerializedPanel) error {
	return a.hub.TransferTab(targetInstanceId, panel)
}

// ============================================================================
// AI Assistant (Ollama)
// ============================================================================

type aiSession struct {
	cancel   context.CancelFunc
	mu       sync.Mutex
	confirms map[string]chan bool
}

var (
	aiMu       sync.Mutex
	aiSessions = map[string]*aiSession{}
)

// ListAiModels returns the models available on the given Ollama host.
func (a *App) ListAiModels(host string) ([]string, error) {
	return bussiness.ListAiModels(host)
}

// AiAvailable reports whether an Ollama server is reachable at host. The frontend
// gates all assistant actions on this and otherwise prompts the user to install Ollama.
func (a *App) AiAvailable(host string) bool {
	return bussiness.AiAvailable(host)
}

// ListAiModelCatalog returns downloadable + installed models for the model manager.
func (a *App) ListAiModelCatalog(host string) ([]models.OllamaModelInfo, error) {
	return bussiness.ListAiModelCatalog(host)
}

// ListAiModelTags returns the registry tags (size variants) of a base model.
func (a *App) ListAiModelTags(name string) ([]string, error) {
	return bussiness.ListAiModelTags(name)
}

// AiModelSupportsTools reports whether the model can do function calling.
func (a *App) AiModelSupportsTools(host, model string) bool {
	return bussiness.AiModelSupportsTools(host, model)
}

var aiPullJobs = newCancelRegistry()

// PullAiModel downloads a model, streaming progress to the frontend via
// ai:pull / ai:pull-done / ai:pull-error events (payload carries the model name).
func (a *App) PullAiModel(host, model string) error {
	ctx, cancel := context.WithCancel(context.Background())
	tok := aiPullJobs.begin(model, cancel)

	safego.Go("controller.aiPull", func() {
		defer aiPullJobs.done(model, tok)

		onProgress := func(status string, total, completed int64) {
			var percent float64
			if total > 0 {
				percent = float64(completed) / float64(total) * 100
			}
			a.emit("ai:pull", map[string]any{
				"model": model, "status": status, "total": total, "completed": completed, "percent": percent,
			})
		}

		if err := bussiness.PullAiModel(ctx, host, model, onProgress); err != nil {
			a.emit("ai:pull-error", map[string]any{"model": model, "error": err.Error()})
			return
		}
		a.emit("ai:pull-done", map[string]any{"model": model})
	})

	return nil
}

// StopAiPull cancels an in-flight model download.
func (a *App) StopAiPull(model string) error {
	aiPullJobs.cancel(model)
	return nil
}

// StartAiChat runs the streaming chat + tool loop for one user turn. Tokens,
// tool activity, confirmation requests and completion are pushed to the frontend
// via ai:token/ai:tool/ai:confirm/ai:done/ai:error events suffixed with sessionId.
func (a *App) StartAiChat(sessionId, host, model, clusterName, messagesJSON, contextJSON string) error {
	ctx, cancel := context.WithCancel(context.Background())
	sess := &aiSession{cancel: cancel, confirms: map[string]chan bool{}}

	aiMu.Lock()
	if old, ok := aiSessions[sessionId]; ok {
		old.cancel()
	}
	aiSessions[sessionId] = sess
	aiMu.Unlock()

	safego.Go("controller.aiChat", func() {
		defer func() {
			// Deregister by identity: a turn started before this one finished
			// has already replaced the entry, and deleting by key would strand
			// it — ConfirmToolCall would find no session and its approval
			// dialog would hang forever.
			aiMu.Lock()
			if cur, ok := aiSessions[sessionId]; ok && cur == sess {
				delete(aiSessions, sessionId)
			}
			aiMu.Unlock()
			cancel()
		}()

		emitToken := func(s string) { a.emit("ai:token:"+sessionId, s) }
		emitTool := func(ev ai.ToolEvent) { a.emit("ai:tool:"+sessionId, ev) }
		awaitConfirm := func(id, name string, args map[string]any) bool {
			ch := make(chan bool, 1)
			sess.mu.Lock()
			sess.confirms[id] = ch
			sess.mu.Unlock()
			a.emit("ai:confirm:"+sessionId, map[string]any{"id": id, "name": name, "args": args})
			select {
			case ok := <-ch:
				return ok
			case <-ctx.Done():
				return false
			}
		}

		if err := bussiness.RunAiChat(ctx, host, model, clusterName, messagesJSON, contextJSON, emitToken, emitTool, awaitConfirm); err != nil {
			a.emit("ai:error:"+sessionId, err.Error())
			return
		}
		a.emit("ai:done:"+sessionId, "")
	})

	return nil
}

// ConfirmToolCall delivers the user's approve/deny decision for a pending
// mutating tool call to the waiting agent loop.
func (a *App) ConfirmToolCall(sessionId, callId string, approved bool) error {
	aiMu.Lock()
	sess, ok := aiSessions[sessionId]
	aiMu.Unlock()
	if !ok {
		return nil
	}
	sess.mu.Lock()
	ch, ok := sess.confirms[callId]
	if ok {
		delete(sess.confirms, callId)
	}
	sess.mu.Unlock()
	if ok {
		ch <- approved
	}
	return nil
}

// StopAiChat cancels an in-flight chat session.
func (a *App) StopAiChat(sessionId string) error {
	aiMu.Lock()
	sess, ok := aiSessions[sessionId]
	aiMu.Unlock()
	if ok {
		sess.cancel()
	}
	return nil
}

// ============================================================================
// Diagnostics
// ============================================================================
//
// The panel behind these methods is the app's answer to "it broke, what do I
// send you". Everything stays on the machine: the report is assembled here, the
// user reads it, and the user decides whether to export it.

// GetDiagnostics returns the environment report. Shell and Hub are filled in
// here because only the controller knows which Transport is installed and owns
// the InstanceHub — business must not import internal/ipc.
func (a *App) GetDiagnostics() models.DiagnosticsReport {
	rep := bussiness.GetDiagnostics()
	rep.Shell = a.shellKind()
	rep.Hub = a.hubDiagnostics()
	return rep
}

// hubDiagnostics describes this process's place in the multi-instance hub.
func (a *App) hubDiagnostics() models.HubDiagnostics {
	if a.hub == nil {
		return models.HubDiagnostics{Role: "disabled"}
	}
	self := a.hub.GetSelfInfo()
	return models.HubDiagnostics{
		Role:          a.hub.Role(),
		InstanceID:    self.ID,
		InstanceName:  self.Name,
		InstanceCount: len(a.hub.GetInstances()),
	}
}

// RunHealthChecks runs the preflight. ollamaHost comes from the frontend's chat
// store; pass "" to skip the assistant check.
func (a *App) RunHealthChecks(ollamaHost string) []models.HealthCheck {
	checks := bussiness.RunHealthChecks(ollamaHost)
	return append(checks, a.hubHealthCheck())
}

func (a *App) hubHealthCheck() models.HealthCheck {
	hub := a.hubDiagnostics()
	c := models.HealthCheck{Name: "ipc-hub", Label: "Instance discovery (IPC hub)"}
	switch hub.Role {
	case "server", "client":
		c.Status = models.HealthOK
		c.Detail = fmt.Sprintf("%s as %s, %d instance(s)", hub.Role, hub.InstanceName, hub.InstanceCount)
	case "disabled":
		// No shared token: the hub refuses to run rather than fall back to an
		// unauthenticated one. Tab transfer is off, nothing else is affected.
		c.Status = models.HealthWarn
		c.Detail = "discovery is off; multi-window tab transfer is unavailable"
	default:
		c.Status = models.HealthWarn
		c.Detail = "not connected to a hub"
	}
	return c
}

// TailLogs returns the tail of today's log file, filtered server-side so the
// search covers the whole window on disk rather than the rows already loaded.
func (a *App) TailLogs(n int, minLevel, query string) ([]models.LogEntry, error) {
	return bussiness.TailLogs(n, minLevel, query)
}

// SetLogLevel changes the level of this process immediately and remembers it
// for processes started later. Windows of one shell share a backend and so
// share a level; a separate instance does not.
func (a *App) SetLogLevel(level string) error { return bussiness.SetLogLevel(level) }

func (a *App) GetLogLevel() string { return bussiness.GetLogLevel() }

func (a *App) GetLogDir() string {
	dir, err := bussiness.LogDir()
	if err != nil {
		return ""
	}
	return dir
}

// OpenLogFolder reveals the log directory in the OS file manager. It rejects in
// browser mode, where the frontend falls back to copying the path.
func (a *App) OpenLogFolder() error { return a.openLogFolder() }

// ExportDiagnostics writes a redacted zip wherever the user chooses and returns
// the path. An empty path with a nil error means the user cancelled.
func (a *App) ExportDiagnostics(ollamaHost string) (string, error) {
	name := "kube-inspector-diagnostics-" + time.Now().Format("20060102-150405") + ".zip"
	path, err := a.saveFile(SaveFileOptions{
		Title:       "Save diagnostics",
		DefaultName: name,
		FilterName:  "Zip archive (*.zip)",
		Pattern:     "*.zip",
	})
	if err != nil || path == "" {
		return "", err
	}
	if !strings.HasSuffix(strings.ToLower(path), ".zip") {
		path += ".zip"
	}

	// Best-effort: the shell contributes its runtime versions and its own log
	// tail. Absent under Wails and in a plain browser tab.
	shellJSON := ""
	if srv, ok := a.tr.(*Server); ok {
		shellJSON = srv.ShellDiagnostics()
	}

	if err := bussiness.ExportDiagnosticsZip(path, ollamaHost, shellJSON, a.hubDiagnostics(), a.shellKind()); err != nil {
		return "", err
	}
	return path, nil
}

// ============================================================================
// Port Forwarding
// ============================================================================

// StartPortForward opens a tunnel and returns it once it is ready, so the
// frontend can show the port that was actually bound even when the user asked
// for an automatic one.
//
// The ports are `int`, not `int32`: JavaScript has no int32 and the generated
// TypeScript is `number` either way (same reasoning as ScaleWorkload).
func (a *App) StartPortForward(clusterName, kind, name, namespace string, localPort, remotePort int) (models.PortForwardInfo, error) {
	id := uuid.NewString()
	return bussiness.StartPortForward(clusterName, kind, name, namespace, localPort, remotePort, id, func(info models.PortForwardInfo) {
		// One broadcast channel, not an event suffixed with the session id.
		// Log and exec streams are consumed by the one panel that owns them; a
		// forward is owned by the process, its consumers are a registry view and
		// a title-bar indicator, and the payload already carries the id.
		//
		// Unlike tab:received this is deliberately *not* gated to the primary
		// window: every window of this shell shares one backend and so shares
		// these tunnels, and all of them should show the same list.
		a.emit("portforward:update", info)
	})
}

// StopPortForward closes a tunnel, or dismisses the row of one that already
// failed. Idempotent.
func (a *App) StopPortForward(id string) error { return bussiness.StopPortForward(id) }

// ListPortForwards returns the process-wide registry. It is a pure in-memory
// snapshot, which is why the frontend can poll it as a cheap safety net behind
// the portforward:update events.
func (a *App) ListPortForwards() []models.PortForwardInfo { return bussiness.ListPortForwards() }

// GetForwardablePorts lists the target's real ports so the dialog can offer
// them instead of asking the user to remember one.
func (a *App) GetForwardablePorts(clusterName, kind, name, namespace string) ([]models.PortOption, error) {
	return bussiness.GetForwardablePorts(clusterName, kind, name, namespace)
}

// SuggestLocalPort returns a free local port, preferring the remote one. Zero
// means "let the kernel choose".
func (a *App) SuggestLocalPort(preferred int) int { return bussiness.SuggestLocalPort(preferred) }
