---
description: Fix common Kube Inspector problems — cluster connection failures, empty resource lists, missing metrics, terminal and exec issues, port-forward errors, failed updates — and find the logs.
---

# Troubleshooting

Work top-down: the first two sections cover most reports, and the last two tell
you how to collect the information an issue needs.

!!! tip "Start with Diagnostics"
    **Help ▸ Diagnostics** opens a panel with an **Overview** tab that runs the
    same health checks described below: log directory, update manifest and the
    Trivy database once, then API reachability, pod-list permission and
    metrics-server **for each configured cluster** — with the reason printed
    next to every failure. It is usually faster than reading this page.

---

## The app will not start

**macOS refuses to open it, or Windows blocks the installer.** That is the
operating system reacting to an unsigned build, not a failure. Verify the
download, then use the documented override:
[Unsigned builds](getting-started/unsigned-builds.md).

**Linux: "The SUID sandbox helper binary was found, but is not configured
correctly".** The bundled `chrome-sandbox` must be owned by root and setuid.
Package installation sets this; a tree that was copied, extracted or moved by
hand loses it:

```bash
sudo chown root:root /opt/kube-inspector/chrome-sandbox
sudo chmod 4755 /opt/kube-inspector/chrome-sandbox
```

Reinstalling the `.deb` or `.rpm` fixes it too. Do **not** work around it with
`--no-sandbox`.

**Linux: "error while loading shared libraries: libnss3.so" (or another
`.so`).** A system library the app links against is missing — usually on a
minimal install or under WSL, and usually because the package went in through
`dpkg -i` or `rpm -i`, which do not install dependencies. Let the package
manager finish the job:

```bash
sudo apt-get -f install        # Debian / Ubuntu, after a dpkg -i
sudo dnf install ./kube-inspector-<version>-linux-x86_64.rpm   # RHEL / Fedora
```

Installing with `apt install ./…deb` or `dnf install ./…rpm` in the first place
avoids it.

**Linux: ``version `GLIBC_2.34' not found``.** The distribution is older than
the app supports — Ubuntu 20.04, Debian 11 and the RHEL 8 family ship an older
C library. Nothing on the machine can fix it short of a newer release; see
[System requirements](getting-started/installation.md#system-requirements).

**Nothing happens at all when you launch it.** Start it from a terminal —
`kube-inspector` on Linux — and read what it prints. Whatever it says, the same
detail is in today's log file (see [where the logs are](#where-the-logs-are)),
which is written even when no window ever appears.

---

## The cluster will not connect

The indicator next to the cluster name in the top bar is red, or every panel
shows a connection error.

**1. Confirm the kubeconfig works outside the app.**

```bash
kubectl --kubeconfig ~/.kube-ins/<cluster-name>.yaml get nodes
```

If that fails, the problem is the kubeconfig or the cluster, not Kube Inspector.

**2. Check for an exec-based credential plugin.** Cloud kubeconfigs often
authenticate through a helper binary:

```yaml
users:
- user:
    exec:
      command: aws          # or gke-gcloud-auth-plugin, az, kubelogin …
```

Kube Inspector runs that command like `kubectl` does, but it inherits the
environment of a **desktop session**, not your shell. If the helper lives in a
directory added to `PATH` by `~/.bashrc` or `~/.zshrc` — including anything
installed by `asdf`, `mise`, Homebrew on Apple Silicon, or a `~/.local/bin`
that only your shell adds — the app will not find it. Fixes, in order of
preference:

- Give the plugin an absolute path in the kubeconfig: `command: /usr/local/bin/aws`.
- Launch the app from a terminal that already has the right `PATH`
  (`kube-inspector` on Linux, `open -a "Kube Inspector"` on macOS).
- Or replace the exec block with a long-lived token or client certificate.

**3. Check for a private CA or a proxy.** A `certificate signed by unknown
authority` error means the CA data in the kubeconfig does not cover the API
server. Kube Inspector uses the kubeconfig's own `certificate-authority-data`;
it does not read your system trust store for this. Export a kubeconfig with the
CA embedded:

```bash
kubectl config view --raw --minify --context=<context-name>
```

`--raw` is what keeps the certificate data in the output.

**4. Cluster on a VPN or an SSH tunnel?** The app connects from your machine
with no extra networking of its own. If `kubectl` needs the VPN up, so does
Kube Inspector.

---

## A resource list is empty

An empty list and a failed list look different on purpose:

| What you see | What it means |
|---|---|
| *No pods found* with no banner | The request succeeded and the namespace really is empty. |
| A red banner above the table | The request failed. The banner carries the API server's own message. |
| A banner plus rows still visible | The refresh failed; you are looking at the last good data. It is marked **stale**. |

**If the banner says `forbidden`,** it is RBAC, not a bug. The message names the
verb and resource the API server refused:

```
pods is forbidden: User "dev@example.com" cannot list resource "pods"
in API group "" at the cluster scope
```

Kube Inspector lists most resources **across all namespaces**, which needs a
ClusterRole. A user granted only a namespaced Role will see this even though
`kubectl get pods -n their-namespace` works fine. Check what you actually have:

```bash
kubectl auth can-i list pods --all-namespaces
kubectl auth can-i --list
```

**If the banner mentions a timeout or a connection reset,** see
[the cluster will not connect](#the-cluster-will-not-connect) above.

---

## Monitoring is empty, or CPU/memory columns show nothing

The Monitoring dashboard and every CPU/memory reading come from
[metrics-server](https://github.com/kubernetes-sigs/metrics-server). Kube
Inspector does not sample usage itself, and cannot show what the cluster does
not measure.

```bash
kubectl top nodes          # works → metrics-server is healthy
kubectl get deploy metrics-server -n kube-system
```

If it is missing:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

On kind, k3s, minikube and other local clusters metrics-server is often absent
or fails its TLS check against kubelet's self-signed certificate; the usual
local-only workaround is the `--kubelet-insecure-tls` argument on the
metrics-server deployment.

Metrics also need a moment: metrics-server serves nothing for roughly the first
minute after it starts, and the dashboard's trend charts are built from samples
taken while the panel is open — they start empty by design and fill in as it
polls.

---

## The terminal opens but `kubectl` is not found

The **Terminal** panel runs a shell **on your own machine** (`$SHELL`, falling
back to `/bin/bash`) with `KUBECONFIG` pointed at the active cluster. It does
not ship a `kubectl` binary and does not run anything inside the cluster, so
`kubectl` has to be installed locally for that panel to be useful.

The app itself never needs `kubectl` — resource lists, YAML edits, scaling and
port forwards all go through the Kubernetes API directly.

If your `kubectl` is installed but the terminal cannot find it, the cause is the
same desktop-session `PATH` described [above](#the-cluster-will-not-connect).

## Exec into a pod fails

Exec opens a real `exec` subresource stream, so it needs three things the
terminal panel does not:

1. **Permission** — `kubectl auth can-i create pods/exec -n <namespace>`.
2. **A shell in the image.** Distroless and `scratch` images have neither
   `/bin/sh` nor `/bin/bash`; the session closes immediately with an
   `executable file not found` error. There is nothing to fix on the client
   side — use an ephemeral debug container instead
   (`kubectl debug -it <pod> --image=busybox --target=<container>`).
3. **A running pod.** A pod in `Pending`, `CrashLoopBackOff` or `Completed`
   cannot be exec'd into.

A session that closes on its own prints a closing line in the panel rather than
going quiet — if the panel is silent and unresponsive instead, that is worth
reporting with a diagnostics blob.

---

## Port forward: "address already in use"

The local port you asked for is taken by another process — often a previous
`kubectl port-forward`, or a forward from a **second** Kube Inspector instance
(each process owns its own tunnels).

```bash
# Linux / macOS
ss -ltnp 'sport = :8080'   ||   lsof -iTCP:8080 -sTCP:LISTEN

# Windows
netstat -ano | findstr :8080
```

The dialog suggests a free local port when you pick the remote one; accepting
the suggestion avoids this entirely. Ports below 1024 need privileges the app
does not have — pick 8080 rather than 80.

## A port forward stopped working

Look at the **Status** column in the Port Forwards panel (**Open ▸ Port
Forwards**):

| Status | Meaning |
|---|---|
| `ready` | The tunnel is up. |
| `starting` | Resolving the target and connecting. |
| `reconnecting` | The pod went away; retrying with backoff. The counter next to it is the attempt number. |
| `error` | Given up. The reason is printed under the table; the row stays until you dismiss it. |

Things worth knowing before filing a bug:

- **A forward pinned to a Pod does not reconnect.** Only workload and service
  targets do, because moving to a different pod behind your back would answer a
  question you did not ask. Restart it, or forward the Deployment/Service next
  time.
- **Reconnection gives up after five attempts** and leaves the row in `error`.
  The **Restart** button (⟳) rebuilds it on the same local port.
- **Forwards are owned by the process, not the panel.** Closing the Port
  Forwards tab stops nothing; quitting the app stops everything.
- **Forwards started in the CLI, or in CLI Mode, are invisible here** — that is
  a separate process with its own registry. Closing the CLI Mode overlay kills
  them.

---

## The update failed, or the app is still on the old version

The updater downloads the artifact, verifies it against the `.sha256` published
beside it, and only then hands it to the platform's installer. Failures land in
one of three places:

**"checksum mismatch"** — the download was corrupted or incomplete. Retry. If it
happens twice, download manually and
[verify it yourself](getting-started/verifying-downloads.md); report it if the
manual check also fails.

**Linux: nothing happens after you approve the install.** The package is handed
to `pkexec apt-get install` / `pkexec dnf install` (or to `dpkg -i` /
`rpm -Uvh` where those are missing), which needs a working PolicyKit agent. On a
minimal desktop session there may be none, and the prompt never appears.
Install the package by hand instead:

```bash
sudo apt install ~/Downloads/kube-inspector-<version>-linux-amd64.deb     # Debian / Ubuntu
sudo dnf install ~/Downloads/kube-inspector-<version>-linux-x86_64.rpm    # RHEL / Fedora
```

**The app restarted but reports the old version.** The next launch detects this
and says so — the update was handed to an installer that did not complete.
Reinstall from [Downloads](downloads.md). On macOS specifically, if the app is
missing from `/Applications` entirely, the swap helper died between its two
moves and the previous version is parked beside it:

```bash
mv "/Applications/Kube Inspector.app.old" "/Applications/Kube Inspector.app"
```

**There is no rollback.** The updater detects a failed update; it cannot undo a
successful one. To go back a version, install the older package over the top —
the newest three releases of each channel stay downloadable
([which ones](versioning.md#what-an-upgrade-within-1x-keeps-working)).

**Nothing is ever offered.** Check **Help ▸ Check for Updates**, and check the
channel: **Open ▸ Update channel** offers *stable* and *beta*. A build ahead of
its channel — a release candidate on *stable*, say — is offered nothing until
the channel catches up
([Update channels](versioning.md#update-channels)). The Diagnostics overview
reports whether the manifest is reachable at all.

---

## Vulnerability scans return nothing, or fail to start

The Trivy scanner downloads its vulnerability database on first use — tens of
megabytes — into `~/.kube-ins/trivy-cache/`. It needs outbound network access to do
that, and a scan started offline with a cold cache will fail. The Diagnostics
overview has a **Trivy vulnerability database** row showing whether the cache is
present and how old it is.

Scanning a private registry image requires credentials the app does not
currently collect; those scans fail with a registry authentication error.

---

## Where the logs are

Every process — the backend, the terminal UI and the Electron shell — appends to
**one shared daily file**:

=== "Linux"
    ```
    ~/.kube-ins/logs/kube-inspector-<YYYY-MM-DD>.log
    ```

=== "macOS"
    ```
    ~/.kube-ins/logs/kube-inspector-<YYYY-MM-DD>.log
    ```

=== "Windows"
    ```
    %USERPROFILE%\.kube-ins\logs\kube-inspector-<YYYY-MM-DD>.log
    ```

Files are one JSON record per line, kept for **7 days** and then deleted; there
is no size cap. Nothing is ever uploaded.

The **Diagnostics ▸ Logs** tab reads the same files inside the app, with a
search box, a role filter (backend / cli / shell), a *this process only* toggle,
follow mode, and a log-level control. Raising the level to `debug` there and
reproducing the problem gives a far more useful report.

**Diagnostics ▸ Export** has **Open log folder**, which reveals the directory in
your file manager, and **Save zip**, which writes the whole redacted bundle to a
file you choose.

---

## Collecting diagnostics for a bug report

Two ways, both redacted before they reach your clipboard — home paths, cluster
names, secrets, base64 blobs and API server URLs are scrubbed:

**From an error banner.** Any red banner has a **Copy diagnostics** button. It
copies the environment report, the health checks, *and* the specific failure you
are looking at, including which call failed and against which panel. This is the
best one to use when something visibly went wrong.

**From the panel.** **Help ▸ Diagnostics ▸ Export ▸ Copy report** gives the same
report without the failure context, and **Save zip** bundles the report together
with the log files.

Paste the result into your issue. See [Support](support.md) for what else to
include.

---

## Related

- [Known limitations](known-limitations.md) — behaviour that is deliberate, not a bug
- [FAQ](faq.md)
- [Support](support.md)
- [Privacy](privacy.md) — what leaves your machine, and what does not
