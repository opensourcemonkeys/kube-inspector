---
description: Frequently asked questions about Kube Inspector — kubectl, permissions, multiple clusters, telemetry, unsigned builds, the terminal UI, and how it compares to kubectl and Lens.
---

# FAQ

## General

### Do I need `kubectl` installed?

No. Kube Inspector talks to the Kubernetes API directly through `client-go` —
listing, editing, scaling, restarting, describing and port forwarding all work
without it.

The one exception is the **Terminal** panel, which is a shell on your own
machine with `KUBECONFIG` pre-set. That panel is only useful if you have
`kubectl` installed locally.

### Does it need anything installed on the cluster?

No agent, no operator, no CRDs. It uses the API you already have.

One thing is the exception:
[metrics-server](https://github.com/kubernetes-sigs/metrics-server) has to be
running in the cluster for CPU and memory readings, because it is what measures
them. Everything else works against a bare cluster.

### What permissions does it need?

Whatever the kubeconfig grants. The app never escalates — every request is made
as you.

Because most views list **across all namespaces**, comfortable use wants a
read-oriented ClusterRole. A kubeconfig scoped to a single namespace works, but
cluster-wide lists will show a `forbidden` banner. See
[Troubleshooting](troubleshooting.md#a-resource-list-is-empty).

### Which Kubernetes versions are supported?

Anything the bundled `client-go` can talk to, which in practice is any currently
supported Kubernetes release. Managed clusters (EKS, GKE, AKS), kubeadm
clusters, k3s, kind and minikube all work — the app only sees the API.

### Is it free? What is the license?

Free and open source, GPL-3.0. There is no paid tier, no account and no sign-in.

## Clusters and configuration

### Where are my kubeconfigs stored?

In `~/.kube-ins/`, one file per cluster (`<name>.yaml`), directory mode `0700`.
Your `~/.kube/config` is read when you import a cluster and is never modified.

### Can I use several clusters at once?

Yes, and each panel is pinned to the cluster it was opened with. Open Pods
against `staging`, switch the active cluster to `prod`, and the `staging` tab
keeps showing `staging` — its title says which one. Switching the active cluster
only affects panels you open afterwards.

### Does it support kubeconfig contexts?

Each cluster entry is a kubeconfig in its own right, so the cleanest way to bring
one context in is:

```bash
kubectl config view --raw --minify --context=<context-name>
```

and paste the output when adding a cluster. Add several entries for several
contexts.

### Do exec credential plugins (AWS, GCP, Azure) work?

Yes, with a caveat: the app runs them with the environment of a desktop session,
which often has a narrower `PATH` than your shell. Use an absolute path in the
kubeconfig, or start the app from a terminal. See
[Troubleshooting](troubleshooting.md#the-cluster-will-not-connect).

## Privacy and security

### Does it phone home?

No telemetry, no analytics, no crash reporting. The only unattended outbound
request is the update check against `kubeinspector.com`. The full list is on the
[Privacy](privacy.md) page.

### Why is my OS warning me about the app?

The builds are not code-signed — the project has no signing certificates. macOS
Gatekeeper and Windows SmartScreen both notice. Verify the checksum, then use
the documented override: [Unsigned builds](getting-started/unsigned-builds.md).

### Are port forwards reachable from my network?

No. They bind `127.0.0.1` only, with no setting to change it.

### Does the AI assistant send my cluster data to a cloud provider?

No. It talks to a local [Ollama](https://ollama.com) server (default
`http://localhost:11434`). Models are downloaded from Ollama's registry; prompts
and any cluster data the assistant's tools pull in go to your Ollama host and
nowhere else. Secret values are replaced by a hash before they reach the model.
Without Ollama running, the assistant is simply unavailable.

### Can the AI assistant change my cluster?

Only if you let it, one cluster at a time. The assistant opens as a tab per
cluster (the robot button next to the Toolbox button, or **Open ▸ AI
Assistant**). Each one starts **Read-only**, which means the model is not even
offered a tool that changes anything. Switch that cluster's tab to **Can
change** and it may propose a delete, scale, restart or apply. The API server
checks each proposal with a dry run first, and the result is shown as a diff
against the live object, naming the cluster. Nothing is changed until you
press **Approve**.

## Using it

### How do I see `kubectl describe` output?

Open the row's ⋮ menu and choose **Describe**. See
[Describe](workspace/describe.md).

### Can it edit resources, or is it read-only?

It edits. YAML editing with schema-aware completion, scale, rollout restart,
CronJob suspend/resume, delete, namespace creation, node cordon/drain, and
server-side apply from the YAML editor panel.

### Does editing YAML trigger a rollout?

It does whatever the API server does with your change — editing a Deployment's
pod template triggers a rolling update, editing an annotation does not. For a
restart with no spec change, use **Rollout restart**, which sets the same
annotation `kubectl rollout restart` does.

### Can I move a tab into its own window?

Yes. Drag a tab outside the window to undock it, or right-click it for
**Undock**, another window, or another running instance. Terminal and exec
panels are the exception — a live pty belongs to its process.

### Is there a terminal version?

Yes — `kube-inspector-cli`, a full terminal UI over the same backend, useful
over SSH. It is packaged separately and has no GUI dependencies. See the
[CLI docs](cli/index.md).

### Can I change the language or theme?

**Open ▸ Language** and **Open ▸ Theme**. Six languages, three themes; both
persist. Note that four of the six catalogs are machine-translated — see
[Language](settings/language.md).

## Updates

### How do updates work?

The app checks a published manifest, and when a newer release exists offers a
two-step download-then-install flow. The download is verified against its
published SHA-256 before anything is installed. On Linux the package goes to
`pkexec apt-get install` / `pkexec dnf install` — or `dpkg -i` / `rpm -Uvh` on a
system without them — so you will be asked to authenticate.

### Stable or beta channel?

**Open ▸ Update channel.** Below 1.0 every release is a prerelease, so the
default is *beta* — a build on *stable* would be offered nothing. Switching to
stable never downgrades you.

### Can I roll back an update?

Not from inside the app. Install the older package over the top from
[Downloads](downloads.md).

## Comparisons

### How is this different from `kubectl`?

It is not a replacement. It is a fast way to see state across a cluster, drill
into a resource, and perform the handful of actions you would otherwise type out
— with the YAML, logs, describe output, exec session and events all one click
apart in a tiled layout. Anything unusual still belongs in `kubectl`.

### How does it compare to Lens or k9s?

Kube Inspector is a native desktop app with a dockable panel layout, no account
and no telemetry, plus a terminal UI in the same package for when you are on a
remote machine. Whether that suits you better than the alternatives is a matter
of taste — all three read the same API.

## Still stuck?

- [Troubleshooting](troubleshooting.md)
- [Known limitations](known-limitations.md)
- [Support](support.md)
