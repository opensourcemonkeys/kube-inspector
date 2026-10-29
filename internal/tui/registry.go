package tui

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"kube-ins/internal/business"
)

// rowData is one table row: name/namespace identify the object for actions,
// cells are the display columns (aligned with resourceDef.headers). ref carries
// the source model for views whose rows drill down into a child list (CRDs).
type rowData struct {
	name      string
	namespace string
	cells     []string
	ref       any
}

// rowAction is an extra per-row verb beyond the standard yaml/edit/delete set
// (e.g. cordon/drain on nodes, scale/restart on workloads). Bound to a single
// key on the list screen.
//
// Keys are uppercase by convention: the lowercase letters are taken by the
// list screen itself (r = refresh, d = delete, y = yaml, e = edit, l = logs,
// s = shell on pods) — see keys.go.
//
// An action either runs straight away (`run`) or first asks for a value
// (`promptLabel` + `runArg`); `confirm` only applies to `run`, since a prompt
// is already an explicit step the user can cancel.
type rowAction struct {
	key     rune
	label   string
	confirm bool
	run     func(cluster, name, namespace string) error
	// promptLabel, when non-empty, makes the action ask for one line of input
	// first and pass it to runArg instead of calling run.
	promptLabel string
	runArg      func(cluster, name, namespace, arg string) error
	// custom, when set, takes the key over entirely: it runs even with no row
	// selected (row is nil then) and does its own confirming and reporting,
	// calling reload when the list should be read again. For flows the
	// run/confirm pair cannot express, like a dry run before the confirmation.
	custom func(a *App, row *rowData, reload func())
}

// resourceDef binds a menu view to the business functions that back it. The
// list screen is generic over this — adding a resource is just a new entry.
type resourceDef struct {
	view       string
	title      string
	namespaced bool
	isPods     bool
	headers    []string
	list       func(cluster string) ([]rowData, error)
	getYAML    func(cluster, name, namespace string) (string, error)
	updateYAML func(cluster, name, namespace, yaml string) error
	del        func(cluster, name, namespace string) error
	actions    []rowAction
	// drill, when set, makes Enter open a child list built from the row instead
	// of the describe pane (used by CRDs to open a kind's instances). The child
	// def is constructed on the fly and never registered.
	drill func(cluster string, row rowData) *resourceDef
	// parent names the registry view Esc/q returns to on a drilled-into child
	// list; empty on top-level views (where back just refocuses the menu).
	parent string
	// noDescribe turns Enter's describe pane off, for rows that are not
	// Kubernetes objects (recorded changes).
	noDescribe bool
	// hints replaces the list screen's standard key hints when set.
	hints string
}

type menuItem struct {
	label string
	view  string
}

type menuGroup struct {
	label string
	items []menuItem
}

func i32(v int32) string { return strconv.FormatInt(int64(v), 10) }
func iN(v int) string    { return strconv.Itoa(v) }

func boolStr(b bool) string {
	if b {
		return "Yes"
	}
	return "No"
}

func join(ss []string) string {
	if len(ss) == 0 {
		return "-"
	}
	return strings.Join(ss, ",")
}

func dash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "-"
	}
	return s
}

// humanSince renders a compact age string (e.g. "5d", "3h", "12m") from an
// RFC3339 timestamp, matching internal/services/crdServices.go::humanAge so
// GUI and TUI agree. Empty or unparsable input yields "-".
func humanSince(iso string) string {
	if strings.TrimSpace(iso) == "" {
		return "-"
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return "-"
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// buildRegistry returns the menu groups (mirroring the GUI NAV_GROUPS) and a
// lookup of view -> resourceDef. "monitoring" and "applyyaml" are menu-only
// views dispatched to bespoke panes by loadResource (no registry entry); the
// security graph and trivy views are intentionally omitted for now.
func buildRegistry() ([]menuGroup, map[string]*resourceDef) {
	defs := []*resourceDef{
		{
			view: "pods", title: "Pods", namespaced: true, isPods: true,
			headers: []string{"NAMESPACE", "NAME", "STATUS", "CONTAINERS", "AGE", "LAST RESTART"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetPods(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, p := range items {
					rows = append(rows, rowData{name: p.Name, namespace: p.Namespace,
						cells: []string{p.Namespace, p.Name, string(p.Status), iN(len(p.Containers)), humanSince(p.CreatedAt), humanSince(p.LastRestartAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetPodYaml,
			del:     business.DeletePod,
			actions: []rowAction{portForwardAction("pod")},
		},
		{
			view: "deployments", title: "Deployments", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "READY", "UPDATED", "AVAILABLE", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetDeployments(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, d := range items {
					rows = append(rows, rowData{name: d.Name, namespace: d.Namespace,
						cells: []string{d.Namespace, d.Name, fmt.Sprintf("%d/%d", d.ReadyReplicas, d.Replicas), i32(d.UpdatedReplicas), i32(d.AvailableReplicas), dash(d.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetDeploymentYaml, updateYAML: business.UpdateDeploymentYaml, del: business.DeleteDeployment,
			actions: []rowAction{scaleAction("deployment"), restartAction("deployment"), portForwardAction("deployment")},
		},
		{
			view: "statefulsets", title: "StatefulSets", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "READY", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetStatefulSets(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, s := range items {
					rows = append(rows, rowData{name: s.Name, namespace: s.Namespace,
						cells: []string{s.Namespace, s.Name, fmt.Sprintf("%d/%d", s.ReadyReplicas, s.Replicas), dash(s.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetStatefulSetYaml, updateYAML: business.UpdateStatefulSetYaml, del: business.DeleteStatefulSet,
			actions: []rowAction{scaleAction("statefulset"), restartAction("statefulset"), portForwardAction("statefulset")},
		},
		{
			view: "replicasets", title: "ReplicaSets", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "READY", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetReplicaSets(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, r := range items {
					rows = append(rows, rowData{name: r.Name, namespace: r.Namespace,
						cells: []string{r.Namespace, r.Name, fmt.Sprintf("%d/%d", r.ReadyReplicas, r.Replicas), dash(r.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetReplicaSetYaml, updateYAML: business.UpdateReplicaSetYaml, del: business.DeleteReplicaSet,
			// No restart: a ReplicaSet has no rollout of its own.
			actions: []rowAction{scaleAction("replicaset"), portForwardAction("replicaset")},
		},
		{
			view: "daemonsets", title: "DaemonSets", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "DESIRED", "READY", "AVAILABLE", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetDaemonSets(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, d := range items {
					rows = append(rows, rowData{name: d.Name, namespace: d.Namespace,
						cells: []string{d.Namespace, d.Name, i32(d.DesiredNumberScheduled), i32(d.NumberReady), i32(d.NumberAvailable), dash(d.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetDaemonSetYaml, updateYAML: business.UpdateDaemonSetYaml, del: business.DeleteDaemonSet,
			// No scale: a DaemonSet's replica count is the node count.
			actions: []rowAction{restartAction("daemonset")},
		},
		{
			view: "jobs", title: "Jobs", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "COMPLETIONS", "STATUS", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetJobs(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, j := range items {
					rows = append(rows, rowData{name: j.Name, namespace: j.Namespace,
						cells: []string{j.Namespace, j.Name, fmt.Sprintf("%d/%d", j.Succeeded, j.Completions), dash(j.Status), dash(j.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetJobYaml, updateYAML: business.UpdateJobYaml, del: business.DeleteJob,
		},
		{
			view: "cronjobs", title: "CronJobs", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "SCHEDULE", "SUSPEND", "ACTIVE", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetCronJobs(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, cj := range items {
					rows = append(rows, rowData{name: cj.Name, namespace: cj.Namespace,
						cells: []string{cj.Namespace, cj.Name, dash(cj.Schedule), boolStr(cj.Suspend), iN(cj.ActiveCount), dash(cj.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetCronJobYaml, updateYAML: business.UpdateCronJobYaml, del: business.DeleteCronJob,
			actions: []rowAction{suspendAction('P', "pause", true), suspendAction('U', "unpause", false)},
		},
		{
			view: "services", title: "Services", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "TYPE", "CLUSTER-IP", "PORTS", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetServices(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, s := range items {
					var ports []string
					for _, p := range s.Ports {
						ports = append(ports, fmt.Sprintf("%d/%s", p.Port, p.Protocol))
					}
					rows = append(rows, rowData{name: s.Name, namespace: s.Namespace,
						cells: []string{s.Namespace, s.Name, dash(s.Type), dash(s.ClusterIP), join(ports), dash(s.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetServiceYaml, updateYAML: business.UpdateServiceYaml, del: business.DeleteService,
			actions: []rowAction{portForwardAction("service")},
		},
		{
			view: "ingresses", title: "Ingresses", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "CLASS", "HOSTS", "ADDRESS", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetIngresses(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, ig := range items {
					var hosts []string
					for _, r := range ig.Rules {
						hosts = append(hosts, r.Host)
					}
					rows = append(rows, rowData{name: ig.Name, namespace: ig.Namespace,
						cells: []string{ig.Namespace, ig.Name, dash(ig.ClassName), join(hosts), dash(ig.Address), dash(ig.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetIngressYaml, updateYAML: business.UpdateIngressYaml, del: business.DeleteIngress,
		},
		{
			view: "ingressclasses", title: "Ingress Classes", namespaced: false,
			headers: []string{"NAME", "CONTROLLER", "DEFAULT", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetIngressClasses(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, ic := range items {
					rows = append(rows, rowData{name: ic.Name, namespace: "",
						cells: []string{ic.Name, dash(ic.Controller), boolStr(ic.IsDefault), dash(ic.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML:    clusterScopedYAML(business.GetIngressClassYaml),
			updateYAML: clusterScopedUpdate(business.UpdateIngressClassYaml),
			del:        clusterScopedDelete("networking.k8s.io", "ingressclasses"),
		},
		{
			view: "endpoints", title: "Endpoints", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "READY", "NOT-READY", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetEndpoints(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, e := range items {
					rows = append(rows, rowData{name: e.Name, namespace: e.Namespace,
						cells: []string{e.Namespace, e.Name, iN(e.Ready), iN(e.NotReady), dash(e.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetEndpointYaml, updateYAML: business.UpdateEndpointYaml, del: business.DeleteEndpoint,
		},
		{
			view: "networkpolicies", title: "Network Policies", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "POD-SELECTOR", "TYPES", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetNetworkPolicies(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, n := range items {
					rows = append(rows, rowData{name: n.Name, namespace: n.Namespace,
						cells: []string{n.Namespace, n.Name, dash(n.PodSelector), join(n.PolicyTypes), dash(n.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetNetworkPolicyYaml, updateYAML: business.UpdateNetworkPolicyYaml, del: business.DeleteNetworkPolicy,
		},
		{
			view: "configmaps", title: "ConfigMaps", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "DATA", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetConfigMaps(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, cm := range items {
					rows = append(rows, rowData{name: cm.Name, namespace: cm.Namespace,
						cells: []string{cm.Namespace, cm.Name, iN(cm.DataCount), dash(cm.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetConfigMapYaml, updateYAML: business.UpdateConfigMapYaml, del: business.DeleteConfigMap,
		},
		{
			view: "secrets", title: "Secrets", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "TYPE", "DATA", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetSecrets(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, s := range items {
					rows = append(rows, rowData{name: s.Name, namespace: s.Namespace,
						cells: []string{s.Namespace, s.Name, dash(s.Type), iN(s.DataCount), dash(s.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetSecretYaml, updateYAML: business.UpdateSecretYaml, del: business.DeleteSecret,
		},
		{
			view: "serviceaccounts", title: "Service Accounts", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "SECRETS", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetServiceAccounts(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, sa := range items {
					rows = append(rows, rowData{name: sa.Name, namespace: sa.Namespace,
						cells: []string{sa.Namespace, sa.Name, iN(sa.Secrets), dash(sa.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetServiceAccountYaml, updateYAML: business.UpdateServiceAccountYaml, del: business.DeleteServiceAccount,
		},
		{
			view: "roles", title: "Roles", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "RULES", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetRoles(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, r := range items {
					rows = append(rows, rowData{name: r.Name, namespace: r.Namespace,
						cells: []string{r.Namespace, r.Name, iN(len(r.Rules)), dash(r.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetRoleYaml, updateYAML: business.UpdateRoleYaml, del: business.DeleteRole,
		},
		{
			view: "rolebindings", title: "Role Bindings", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "ROLE", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetRoleBindings(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, rb := range items {
					rows = append(rows, rowData{name: rb.Name, namespace: rb.Namespace,
						cells: []string{rb.Namespace, rb.Name, dash(rb.RoleRefName), dash(rb.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetRoleBindingYaml, updateYAML: business.UpdateRoleBindingYaml, del: business.DeleteRoleBinding,
		},
		{
			view: "persistentvolumes", title: "Persistent Volumes", namespaced: false,
			headers: []string{"NAME", "STATUS", "CAPACITY", "RECLAIM", "STORAGECLASS", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetPersistentVolumes(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, pv := range items {
					rows = append(rows, rowData{name: pv.Name, namespace: "",
						cells: []string{pv.Name, dash(pv.Status), dash(pv.Capacity), dash(pv.ReclaimPolicy), dash(pv.StorageClassName), dash(pv.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML:    clusterScopedYAML(business.GetPersistentVolumeYaml),
			updateYAML: clusterScopedUpdate(business.UpdatePersistentVolumeYaml),
			del:        clusterScopedDelete("", "persistentvolumes"),
		},
		{
			view: "persistentvolumeclaims", title: "Volume Claims", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "STATUS", "VOLUME", "CAPACITY", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetPersistentVolumeClaims(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, pvc := range items {
					rows = append(rows, rowData{name: pvc.Name, namespace: pvc.Namespace,
						cells: []string{pvc.Namespace, pvc.Name, dash(pvc.Status), dash(pvc.VolumeName), dash(pvc.Request), dash(pvc.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetPersistentVolumeClaimYaml, updateYAML: business.UpdatePersistentVolumeClaimYaml, del: business.DeletePersistentVolumeClaim,
		},
		{
			view: "storageclasses", title: "Storage Classes", namespaced: false,
			headers: []string{"NAME", "PROVISIONER", "RECLAIM", "BINDING", "DEFAULT"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetStorageClasses(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, sc := range items {
					rows = append(rows, rowData{name: sc.Name, namespace: "",
						cells: []string{sc.Name, dash(sc.Provisioner), dash(sc.ReclaimPolicy), dash(sc.VolumeBindingMode), boolStr(sc.IsDefault)}})
				}
				return rows, nil
			},
			getYAML:    clusterScopedYAML(business.GetStorageClassYaml),
			updateYAML: clusterScopedUpdate(business.UpdateStorageClassYaml),
			del:        clusterScopedDelete("storage.k8s.io", "storageclasses"),
		},
		{
			view: "nodes", title: "Nodes", namespaced: false,
			headers: []string{"NAME", "STATUS", "INTERNAL-IP", "VERSION", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetNodes(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, n := range items {
					status := n.Status
					if n.Unschedulable {
						status += ",SchedDisabled"
					}
					rows = append(rows, rowData{name: n.Name, namespace: "",
						cells: []string{n.Name, dash(status), dash(n.InternalIP), dash(n.KubeletVersion), dash(n.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML:    clusterScopedYAML(business.GetNodeYaml),
			updateYAML: func(c, name, _, yaml string) error { return business.UpdateNodeYaml(c, name, yaml) },
			actions: []rowAction{
				{key: 'C', label: "cordon", run: func(c, name, _ string) error { return business.CordonNode(c, name) }},
				{key: 'U', label: "uncordon", run: func(c, name, _ string) error { return business.UncordonNode(c, name) }},
				{key: 'D', label: "drain", confirm: true, run: func(c, name, _ string) error { return business.DrainNode(c, name) }},
			},
		},
		{
			view: "namespaces", title: "Namespaces", namespaced: false,
			headers: []string{"NAME", "STATUS"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetNamespaces(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, ns := range items {
					rows = append(rows, rowData{name: ns.Name, namespace: "", cells: []string{ns.Name, dash(ns.Status)}})
				}
				return rows, nil
			},
			getYAML: clusterScopedYAML(business.GetNamespaceYaml),
			del:     func(c, name, _ string) error { return business.DeleteNamespace(c, name) },
		},
		{
			view: "events", title: "Events", namespaced: true,
			headers: []string{"NAMESPACE", "TYPE", "REASON", "OBJECT", "MESSAGE", "COUNT"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetEvents(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, e := range items {
					rows = append(rows, rowData{name: e.Name, namespace: e.Namespace,
						cells: []string{e.Namespace, dash(e.Type), dash(e.Reason), dash(e.Object), dash(e.Message), i32(e.Count)}})
				}
				return rows, nil
			},
		},
		{
			view: "resourcequotas", title: "Resource Quotas", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "RESOURCE", "USED", "HARD", "USE%"},
			// One row per tracked resource entry: rows of a multi-entry quota share
			// name/namespace, so y/e/d on any of them targets the same quota object.
			list: func(c string) ([]rowData, error) {
				quotas, err := business.GetResourceQuotas(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, q := range quotas {
					if len(q.Entries) == 0 {
						rows = append(rows, rowData{name: q.Name, namespace: q.Namespace,
							cells: []string{q.Namespace, q.Name, "-", "-", "-", "-"}})
						continue
					}
					for _, e := range q.Entries {
						rows = append(rows, rowData{name: q.Name, namespace: q.Namespace,
							cells: []string{q.Namespace, q.Name, e.Resource, e.Used, e.Hard, textBar(e.UsedNum, e.HardNum, 10)}})
					}
				}
				return rows, nil
			},
			getYAML:    business.GetResourceQuotaYaml,
			updateYAML: business.UpdateResourceQuotaYaml,
			del: func(c, name, ns string) error {
				return business.DeleteObject(c, "", "resourcequotas", ns, name)
			},
		},
		{
			view: "limitranges", title: "Limit Ranges", namespaced: true,
			headers: []string{"NAMESPACE", "NAME", "ITEMS", "AGE"},
			list: func(c string) ([]rowData, error) {
				items, err := business.GetLimitRanges(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, lr := range items {
					rows = append(rows, rowData{name: lr.Name, namespace: lr.Namespace,
						cells: []string{lr.Namespace, lr.Name, iN(len(lr.Limits)), dash(lr.CreatedAt)}})
				}
				return rows, nil
			},
			getYAML: business.GetLimitRangeYaml, updateYAML: business.UpdateLimitRangeYaml, del: business.DeleteLimitRange,
		},
		{
			// Cluster-scoped in shape only: forwards belong to this process and
			// span every cluster, so `list` ignores the cluster argument. It is
			// filed under CLUSTER because that is where the other
			// not-a-namespaced-resource screens live.
			//
			// Note these are *this binary's* tunnels. The TUI is a separate
			// process from the GUI backend and does not share its registry —
			// and in the GUI's CLI Mode the pty dies with the overlay, taking
			// any forward started here with it.
			view: "portforwards", title: "Port Forwards", namespaced: false,
			headers: []string{"STATUS", "ADDRESS", "TARGET", "NAMESPACE", "POD", "CLUSTER", "AGE"},
			list: func(string) ([]rowData, error) {
				var rows []rowData
				for _, f := range business.ListPortForwards() {
					rows = append(rows, rowData{name: f.ID, namespace: f.Namespace, cells: []string{
						f.Status,
						fmt.Sprintf("%s:%d -> %d", f.Address, f.LocalPort, f.RemotePort),
						f.ResourceKind + "/" + f.ResourceName,
						dash(f.Namespace),
						dash(f.PodName),
						dash(f.ClusterName),
						humanSince(f.StartedAt),
					}})
				}
				return rows, nil
			},
			actions: []rowAction{{
				key: 'X', label: "stop",
				run: func(_, name, _ string) error { return business.StopPortForward(name) },
			}},
		},
		historyDef(),
		{
			view: "crds", title: "CRDs", namespaced: false,
			headers: []string{"NAME", "GROUP", "KIND", "SCOPE", "VERSION", "AGE"},
			list: func(c string) ([]rowData, error) {
				crds, err := business.GetCRDs(c)
				if err != nil {
					return nil, err
				}
				var rows []rowData
				for _, crd := range crds {
					rows = append(rows, rowData{name: crd.Name, ref: crd,
						cells: []string{crd.Name, dash(crd.Group), dash(crd.Kind), dash(crd.Scope), dash(crd.Version), dash(crd.Age)}})
				}
				return rows, nil
			},
			getYAML: func(c, name, _ string) (string, error) {
				return business.GetObjectYaml(c, "apiextensions.k8s.io", "customresourcedefinitions", "", name)
			},
			updateYAML: func(c, name, _, yaml string) error {
				return business.UpdateObjectYaml(c, "apiextensions.k8s.io", "customresourcedefinitions", "", name, yaml)
			},
			del: func(c, name, _ string) error {
				return business.DeleteObject(c, "apiextensions.k8s.io", "customresourcedefinitions", "", name)
			},
			drill: crdChildDef,
		},
	}

	reg := make(map[string]*resourceDef, len(defs))
	for _, d := range defs {
		reg[d.view] = d
	}

	groups := []menuGroup{
		{"WORKLOADS", []menuItem{{"Pods", "pods"}, {"Deployments", "deployments"}, {"StatefulSets", "statefulsets"}, {"ReplicaSets", "replicasets"}, {"DaemonSets", "daemonsets"}, {"Jobs", "jobs"}, {"CronJobs", "cronjobs"}}},
		{"NETWORKING", []menuItem{{"Services", "services"}, {"Ingresses", "ingresses"}, {"Ingress Classes", "ingressclasses"}, {"Endpoints", "endpoints"}, {"Network Policies", "networkpolicies"}}},
		{"CONFIG & SECRETS", []menuItem{{"ConfigMaps", "configmaps"}, {"Secrets", "secrets"}}},
		{"SECURITY", []menuItem{{"Service Accounts", "serviceaccounts"}, {"Roles", "roles"}, {"Role Bindings", "rolebindings"}}},
		{"STORAGE", []menuItem{{"Persistent Volumes", "persistentvolumes"}, {"Volume Claims", "persistentvolumeclaims"}, {"Storage Classes", "storageclasses"}}},
		{"CLUSTER", []menuItem{{"Monitoring", "monitoring"}, {"Nodes", "nodes"}, {"Namespaces", "namespaces"}, {"Events", "events"}, {"Resource Quotas", "resourcequotas"}, {"Limit Ranges", "limitranges"}, {"CRDs", "crds"}, {"Port Forwards", "portforwards"}, {"Cluster History", "history"}, {"Apply YAML", "applyyaml"}}},
	}

	return groups, reg
}

// clusterScopedYAML adapts a (cluster, name) YAML getter to the namespaced
// (cluster, name, namespace) signature the generic list screen expects.
func clusterScopedYAML(fn func(cluster, name string) (string, error)) func(cluster, name, namespace string) (string, error) {
	return func(cluster, name, _ string) (string, error) { return fn(cluster, name) }
}

// clusterScopedUpdate is the write-side counterpart of clusterScopedYAML.
func clusterScopedUpdate(fn func(cluster, name, yaml string) error) func(cluster, name, namespace, yaml string) error {
	return func(cluster, name, _, yaml string) error { return fn(cluster, name, yaml) }
}

// clusterScopedDelete adapts business.DeleteObject to the list screen's `del`
// signature for cluster-scoped kinds that have no typed delete of their own.
func clusterScopedDelete(group, resource string) func(cluster, name, namespace string) error {
	return func(cluster, name, _ string) error {
		return business.DeleteObject(cluster, group, resource, "", name)
	}
}

// scaleAction builds the 'S' row action for a scalable workload kind. The
// replica count is parsed here rather than in business so a typo produces a
// readable message instead of an API rejection.
func scaleAction(kind string) rowAction {
	return rowAction{
		key: 'S', label: "scale", promptLabel: "Replicas",
		runArg: func(cluster, name, namespace, arg string) error {
			// ParseInt with bitSize 32 rather than Atoi: the API field is an
			// int32, and Atoi parses into a 64-bit int that the conversion then
			// wraps — 2147483648 would have been sent as -2147483648.
			replicas, err := strconv.ParseInt(arg, 10, 32)
			if err != nil {
				return fmt.Errorf("replicas must be a whole number in 0..%d, got %q", math.MaxInt32, arg)
			}
			if replicas < 0 {
				return fmt.Errorf("replicas must be >= 0, got %d", replicas)
			}
			return business.ScaleWorkload(cluster, kind, name, namespace, int32(replicas))
		},
	}
}

// restartAction builds the 'R' row action for a workload kind that has a rollout.
func restartAction(kind string) rowAction {
	return rowAction{
		key: 'R', label: "restart", confirm: true,
		run: func(cluster, name, namespace string) error {
			return business.RestartWorkload(cluster, kind, name, namespace)
		},
	}
}

// portForwardAction builds the 'F' row action. It takes "local:remote" or a
// bare remote port, because typing a local port is the part nobody wants to do:
// an empty local half means "pick a free one", the same as leaving the GUI
// dialog's local field blank.
//
// Uppercase, like the other row actions: 'r' is refresh and 's' is shell on the
// pod screen.
func portForwardAction(kind string) rowAction {
	return rowAction{
		key: 'F', label: "port-forward", promptLabel: "Local:Remote (e.g. 8080:80, or just 80)",
		runArg: func(cluster, name, namespace, arg string) error {
			local, remote, err := parsePortPair(arg)
			if err != nil {
				return err
			}
			id := fmt.Sprintf("tui-%s-%d", kind, time.Now().UnixNano())
			_, err = business.StartPortForward(cluster, kind, name, namespace, local, remote, id, nil)
			return err
		},
	}
}

// parsePortPair reads "8080:80", ":80" or "80".
func parsePortPair(arg string) (local, remote int, err error) {
	arg = strings.TrimSpace(arg)
	localStr, remoteStr, hasColon := strings.Cut(arg, ":")
	if !hasColon {
		remoteStr, localStr = localStr, ""
	}
	remote, err = strconv.Atoi(strings.TrimSpace(remoteStr))
	if err != nil {
		return 0, 0, fmt.Errorf("remote port must be a number, got %q", remoteStr)
	}
	if strings.TrimSpace(localStr) != "" {
		local, err = strconv.Atoi(strings.TrimSpace(localStr))
		if err != nil {
			return 0, 0, fmt.Errorf("local port must be a number, got %q", localStr)
		}
	}
	return local, remote, nil
}

// suspendAction builds the CronJob pause/resume pair. They are two idempotent
// keys rather than one toggle because rowAction only sees a row's name and
// namespace, not its current suspend state.
func suspendAction(key rune, label string, suspend bool) rowAction {
	return rowAction{
		key: key, label: label, confirm: true,
		run: func(cluster, name, namespace string) error {
			return business.SetCronJobSuspend(cluster, name, namespace, suspend)
		},
	}
}
