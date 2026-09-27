---
description: Inspect Kubernetes nodes in Kube Inspector — capacity, conditions, and status — and cordon, drain or open a root shell on a node directly from the desktop app.
---

# Nodes

The Nodes screen shows all nodes in the cluster as cards. Each card displays the node's health, hardware details, and live CPU/RAM usage.

## Node Card Layout

Each card contains:

- **Node name** with status tag (`Ready` / `NotReady`) and an `Unschedulable` badge when cordoned
- **Metadata** — internal IP, kubelet version, OS image, CPU capacity, memory capacity
- **Usage charts** — horizontal bars showing CPU (millicores) and RAM (MiB) utilization, color-coded:
  - Green — below 60%
  - Amber — 60–80%
  - Red — above 80%

!!! note "Metrics Server"
    CPU and RAM usage charts require the **Metrics Server** to be installed in the cluster. If it is not available, the charts section shows an informational message instead.

## Actions

### Cordon

Marks the node as **unschedulable**. New pods will not be scheduled here. Existing pods continue running. The node card border turns yellow and an `Unschedulable` badge appears.

Use cordon when you want to drain a node gradually or temporarily exclude it from scheduling without evicting existing workloads.

### Uncordon

Removes the unschedulable taint, allowing new pods to be scheduled on the node again.

### Drain

Drain performs two steps:

1. **Cordons** the node (marks it unschedulable)
2. **Evicts** all pods except DaemonSet pods and static mirror pods

A confirmation dialog is shown before drain starts. DaemonSet pods are intentionally left in place because they are managed by DaemonSet controllers and would be immediately rescheduled anyway.

!!! warning
    Draining a node evicts all workloads on it. Ensure the remaining nodes have sufficient capacity to absorb the rescheduled pods before draining.

### Node Shell

The **Shell** button (terminal icon) opens a root shell **on the node itself** — the
node's own process, network and mount namespaces, not a container's. Use it to read
kubelet logs, inspect disk pressure, check `containerd`, or look at routes and
iptables rules.

Kubernetes has no API for executing a command on a node, so Kube Inspector does what
`kubectl debug node/...`, k9s and Lens do:

1. A **privileged helper pod** is created in the `kube-system` namespace, pinned to
   that node via `spec.nodeName`, with `hostPID`, `hostIPC` and `hostNetwork` enabled
   and a toleration for every taint — so a cordoned or tainted node still gets it.
2. Once the pod is running, the app execs `nsenter -t 1 -m -u -i -n -p` into it,
   entering PID 1's namespaces, and starts a shell there. That is what makes `ps`,
   `ss`, `systemctl` and `journalctl` show the **host's** state rather than the
   container's. The node's `/etc/profile` is sourced, so `PATH` includes
   `/usr/sbin` and `/sbin`.
3. Closing the terminal tab deletes the helper pod. So does the shell exiting on its
   own (type `exit`).

A confirmation dialog is shown first, because this is a genuinely privileged action.
The terminal narrates the wait — pod creation, scheduling, image pull — so a slow
start is visible rather than looking like a hang.

!!! warning "This is root on the node"
    Anyone who can open a node shell has full control of the host, which is more than
    most cluster-admin tasks require. The helper pod carries an
    `activeDeadlineSeconds` backstop of 8 hours so that a crash of the app cannot
    leave a privileged pod running indefinitely, and it is labelled
    `kube-ins/node-shell=true` so a leaked one is easy to find:

    ```bash
    kubectl -n kube-system get pods -l kube-ins/node-shell=true
    ```

!!! note "Requirements"
    The shell needs permission to **create pods in `kube-system`** and to **exec into
    them**, and the node's container runtime must accept a privileged container. A
    cluster enforcing the `restricted` or `baseline` Pod Security Standard on
    `kube-system` will refuse the helper pod; the error the API server returns is
    shown in the terminal. The helper image is `alpine:latest`, so the node (or its
    registry mirror) must be able to pull it.

### Edit YAML

Click the **Edit YAML** button (pencil icon) to open the node manifest in a YAML editor panel. Node-level changes such as labels, annotations, and taints can be applied here.

## Refresh Rate

Node data refreshes every **3 seconds** to keep usage charts current.
