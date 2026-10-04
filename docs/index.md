---
title: Kubernetes, in one window
description: Kube Inspector is a free, open-source visual desktop client for Kubernetes — manage pods, deployments, RBAC, secrets and more across clusters on Windows, macOS and Linux.
template: home.html
hide:
  - navigation
  - toc
---

**Kube Inspector** is a free, open-source **visual desktop client for Kubernetes** that runs on Windows, macOS, and Linux. It gives you a fast, filterable view of every core Kubernetes resource — pods, deployments, services, config maps, secrets, RBAC and more — with an inline YAML editor, a built-in kubectl terminal, live log streaming, resource monitoring, RBAC visualization, and image vulnerability scanning, all across multiple clusters at once. Prefer the terminal? The same features ship as a webview-free CLI, `kube-inspector-cli`.

<div class="grid cards ki-features" markdown>

-   :material-cube-outline:{ .lg .middle } __Workloads__

    ---

    Pods, Deployments, StatefulSets, ReplicaSets, DaemonSets, Jobs and CronJobs — list, inspect, edit YAML, and delete.

    [:octicons-arrow-right-24: Manage workloads](workloads/index.md)

-   :material-server:{ .lg .middle } __Cluster__

    ---

    Namespaces, Nodes with cordon/drain, and Resource Quotas across every connected cluster.

    [:octicons-arrow-right-24: Explore the cluster](cluster/nodes.md)

-   :material-lan:{ .lg .middle } __Networking__

    ---

    Network Policies rendered as visual diagrams so you can see what talks to what.

    [:octicons-arrow-right-24: Network policies](networking/network-policies.md)

-   :material-key-variant:{ .lg .middle } __Config & Secrets__

    ---

    ConfigMaps and Secrets with a friendly key-value editor — no base64 juggling.

    [:octicons-arrow-right-24: Config & secrets](config-secrets/configmaps.md)

-   :material-code-braces:{ .lg .middle } __Workspace__

    ---

    Monaco YAML editor, an integrated kubectl terminal, and a real-time log viewer in a dockable panel layout.

    [:octicons-arrow-right-24: YAML editor](workspace/yaml-editor.md)

-   :material-layers-triple:{ .lg .middle } __Multi-cluster__

    ---

    Add and switch between multiple kubeconfigs; every tab stays pinned to the cluster it was opened with.

    [:octicons-arrow-right-24: Add a cluster](getting-started/cluster-setup.md)

</div>

## See it in action

<div class="ki-showcase">

  <div class="ki-shot ki-reveal">
    <div class="ki-frame">
      <span class="ki-frame__dots"></span>
      <img src="assets/screenshots/pods.png" alt="Pod list with live status and filters" loading="lazy" />
      <div class="ki-shot__text">
        <h3>Every workload, one click away</h3>
        <p>Pods, Deployments, StatefulSets and more in fast, filterable tables — namespaces, live status and inline actions at a glance.</p>
      </div>
    </div>
  </div>

  <div class="ki-shot ki-reveal">
    <div class="ki-frame">
      <span class="ki-frame__dots"></span>
      <img src="assets/screenshots/monitoring.png" alt="Live resource monitoring dashboard" loading="lazy" />
      <div class="ki-shot__text">
        <h3>Live resource monitoring</h3>
        <p>Watch cluster, node, pod and workload CPU &amp; memory over time and drill into the top consumers.</p>
      </div>
    </div>
  </div>

  <div class="ki-shot ki-reveal">
    <div class="ki-frame">
      <span class="ki-frame__dots"></span>
      <img src="assets/screenshots/security-role-map.png" alt="RBAC security role map graph" loading="lazy" />
      <div class="ki-shot__text">
        <h3>See who can touch what</h3>
        <p>An interactive RBAC graph maps service accounts → roles → resources, so permissions are something you can actually read.</p>
      </div>
    </div>
  </div>

  <div class="ki-shot ki-reveal">
    <div class="ki-frame">
      <span class="ki-frame__dots"></span>
      <img src="assets/screenshots/network-policies.png" alt="Network policy ingress/egress diagram" loading="lazy" />
      <div class="ki-shot__text">
        <h3>Network policies, drawn out</h3>
        <p>Ingress and egress rules become a clear diagram — which pods are affected and what's allowed in and out — alongside the raw YAML.</p>
      </div>
    </div>
  </div>

  <div class="ki-shot ki-reveal">
    <div class="ki-frame">
      <span class="ki-frame__dots"></span>
      <img src="assets/screenshots/vulnerability-scan.png" alt="Trivy vulnerability scan results" loading="lazy" />
      <div class="ki-shot__text">
        <h3>Scan images for CVEs</h3>
        <p>Built-in Trivy scanning surfaces vulnerabilities per image, severity and fix version — for a single image or the whole cluster.</p>
      </div>
    </div>
  </div>

  <div class="ki-shot ki-reveal">
    <div class="ki-frame">
      <span class="ki-frame__dots"></span>
      <img src="assets/screenshots/yaml-editor.png" alt="Monaco YAML editor" loading="lazy" />
      <div class="ki-shot__text">
        <h3>Edit manifests inline</h3>
        <p>A Monaco-powered YAML editor with schema validation lets you view and apply changes without leaving the window.</p>
      </div>
    </div>
  </div>

  <div class="ki-shot ki-reveal">
    <div class="ki-frame">
      <span class="ki-frame__dots"></span>
      <img src="assets/screenshots/split-view.png" alt="Dockable split layout: resource list beside the YAML editor" loading="lazy" />
      <div class="ki-shot__text">
        <h3>Your layout, your way</h3>
        <p>Dockable, resizable panels: keep a resource list, its YAML and a terminal side by side — drag, split and dock tabs freely.</p>
      </div>
    </div>
  </div>

  <div class="ki-shot ki-reveal">
    <div class="ki-frame">
      <span class="ki-frame__dots"></span>
      <img src="assets/screenshots/terminal.png" alt="Multiple integrated terminals tiled in the workspace" loading="lazy" />
      <div class="ki-shot__text">
        <h3>Real terminals, built in</h3>
        <p>Open as many integrated terminals as you need — run kubectl, exec into pods, tail logs — tiled right next to your resources.</p>
      </div>
    </div>
  </div>

</div>

## Get started

<div class="ki-quicklinks" markdown>

- [Install Kube Inspector](getting-started/installation.md) — download and run on Linux, macOS, or Windows.
- [Add your first cluster](getting-started/cluster-setup.md) — point Kube Inspector at a kubeconfig.
- [Manage workloads](workloads/index.md) — your day-to-day resource views.

</div>

## Frequently asked questions

### What is Kube Inspector?

Kube Inspector is a free, open-source desktop application for viewing and managing Kubernetes clusters through a visual interface — a graphical alternative to running `kubectl` by hand. It runs on Windows, macOS, and Linux.

### Is Kube Inspector free?

Yes. Kube Inspector is free and open source.

### Which platforms does it support?

Native desktop builds for Windows, macOS, and Linux, plus a webview-free terminal UI (`kube-inspector-cli`) for servers and SSH sessions. See the [downloads page](downloads.md).

### Does it work with any Kubernetes cluster?

Yes. Kube Inspector reads your existing kubeconfig files, so it works with any conformant cluster — local (kind, minikube, k3s) or managed (EKS, GKE, AKS, and more). See [adding clusters](getting-started/cluster-setup.md).

### Does Kube Inspector send my cluster data anywhere?

No. It talks directly to your clusters' API servers from your machine using your kubeconfig — there is no backend service in between.
