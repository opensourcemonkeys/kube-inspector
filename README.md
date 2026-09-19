# Kube Inspector

[![CI](https://github.com/opensourcemonkeys/kube-inspector/actions/workflows/ci.yml/badge.svg)](https://github.com/opensourcemonkeys/kube-inspector/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/opensourcemonkeys/kube-inspector?include_prereleases&sort=semver&label=release)](https://github.com/opensourcemonkeys/kube-inspector/releases)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-kubeinspector.com-0a7d7d)](https://kubeinspector.com)

A visual desktop client for managing Kubernetes clusters — built with Go, Electron and React.
Free, open source, and **no telemetry of any kind**.

> **Documentation:** [kubeinspector.com](https://kubeinspector.com)

> [!IMPORTANT]
> **Kube Inspector is in beta.** It talks to real clusters and can delete, scale
> and restart real workloads. Read
> [Known limitations](https://kubeinspector.com/known-limitations/) before you
> point it at production, and expect rough edges worth
> [reporting](https://kubeinspector.com/support/).

![Kube Inspector workspace](docs/assets/screenshots/split-view.png)

## What it does

A tiled, dockable workspace over the Kubernetes API — the YAML, the logs, the
describe output, an exec session and the events are all one click apart, and
each panel stays pinned to the cluster it was opened with.

- **~25 resource types** — workloads, networking, config & secrets, RBAC,
  storage, nodes, namespaces, events, quotas and CRDs — listed cluster-wide with
  filtering and multi-select delete.
- **A YAML editor** with Kubernetes schema completion, hover and validation
  (schema embedded — no external fetch), applied server-side.
- **Describe** — `kubectl describe` output, events included, rendered in-process
  with no `kubectl` binary involved.
- **The actions you would otherwise type:** scale, rollout restart, CronJob
  suspend/resume, delete, namespace create, node cordon/drain.
- **Port forwarding** that survives a rolling restart — loopback-only, owned by
  the process rather than the panel, with one panel listing every tunnel.
- **Live logs, pod exec, and a local `kubectl` terminal**, each as its own panel.
- **A monitoring dashboard** over metrics-server, with client-side trend charts.
- **Security tooling:** an RBAC subject → role → resource graph, and Trivy image
  vulnerability scanning built in as a library.
- **A local AI assistant** (optional) backed by [Ollama](https://ollama.com) —
  it runs against your own host, so nothing leaves the machine.
- **Diagnostics built in:** local log files, health checks, and a redacted
  "copy diagnostics" blob for bug reports. No telemetry, no analytics.
- **Multi-window and multi-instance:** drag a tab out into its own window, or
  send it to another running instance.
- **Six languages, three themes**, and a full **terminal UI** in the same
  project for when you are on a remote machine.

## Installation

Download from [kubeinspector.com/downloads](https://kubeinspector.com/downloads/).

| Platform | File |
|---|---|
| Linux — Debian / Ubuntu | `kube-inspector-<version>-linux-amd64.deb` |
| Linux — RHEL / Fedora | `kube-inspector-<version>-linux-x86_64.rpm` |
| macOS (Apple Silicon) | `kube-inspector-<version>-macos-arm64.dmg` |
| Windows | `kube-inspector-<version>-windows-amd64.exe` |

**The packages declare no dependencies.** The app bundles its own browser
engine, so there is no WebKitGTK, GTK or WebView2 runtime to install — on any
platform. `kubectl` is not required either; the app speaks to the Kubernetes API
directly through `client-go`.

```bash
# Debian / Ubuntu
sudo dpkg -i kube-inspector-<version>-linux-amd64.deb

# RHEL / Fedora
sudo rpm -Uvh kube-inspector-<version>-linux-x86_64.rpm
```

There is also a terminal UI, `kube-inspector-cli` — see
[Terminal UI](#terminal-ui-kube-inspector-cli) below.

### Verify what you downloaded

Every artifact ships a `.sha256` sidecar, and each release publishes a
`SHA256SUMS-<version>` covering all of them:

```bash
curl -fsSLO https://kubeinspector.com/dist/kube-inspector-<version>-linux-amd64.deb.sha256
sha256sum -c kube-inspector-<version>-linux-amd64.deb.sha256
```

The builds are **not code-signed** — the project has no signing certificates —
so macOS Gatekeeper and Windows SmartScreen will both warn on first launch.
Verifying the checksum is the one integrity check available. See
[Verifying downloads](https://kubeinspector.com/getting-started/verifying-downloads/)
and [Unsigned builds](https://kubeinspector.com/getting-started/unsigned-builds/).

## Terminal UI (`kube-inspector-cli`)

The same backend with a `tview` front end — no window, no browser engine, no GUI
libraries at all. It is a single self-contained binary, which makes it the one
to use over SSH, on a jump host, or on a server with no desktop session.

![Terminal UI](docs/assets/screenshots/cli-pods.png)

It reads and writes the **same `~/.kube-ins/`** as the desktop app, so the
clusters you added there are already here, and switching the active cluster in
one is visible to the other.

### Install

```bash
# Debian / Ubuntu
sudo dpkg -i kube-inspector-cli-<version>-linux-amd64.deb

# RHEL / Fedora
sudo rpm -Uvh kube-inspector-cli-<version>-linux-x86_64.rpm

# Or just drop the binary somewhere on PATH
tar xzf kube-inspector-cli-<version>-linux-amd64.tar.gz
```

No dependencies, and deliberately **no WebKitGTK/GTK** — `internal/tui` and
`cmd/tui` import no Wails, which is what keeps the package that light.

It is also reachable from inside the desktop app: **Open ▸ CLI Mode** runs the
same UI full-screen in an embedded terminal.

### Layout

```
Clusters  →  Workspace ( resource menu | resource list )  →  yaml · describe · logs · exec
```

The workspace is split k9s-style: the resource menu on the left, the list on the
right, `←` / `→` moving focus between them. Pods open by default.

### Keys

Navigation and row actions are plain single letters — nothing a terminal
intercepts — and the current screen's keys are always shown in the top-right.
Only the editors and the exec session use a `Ctrl` chord.

| Screen | Keys |
|---|---|
| **Clusters** | `↵` select · `a` add · `d` delete · `v` view kubeconfig · `q` quit |
| **Any resource list** | `↵` describe · `y` yaml · `e` edit · `d` delete · `/` filter · `r` refresh · `←` menu · `q` back |
| **Pods** | + `l` logs · `s` shell · `F` port-forward |
| **Deployments / StatefulSets** | + `S` scale · `R` rollout restart · `F` port-forward |
| **ReplicaSets** | + `S` scale · `F` port-forward |
| **Services** | + `F` port-forward |
| **DaemonSets** | + `R` rollout restart |
| **CronJobs** | + `P` pause · `U` unpause |
| **Nodes** | + `C` cordon · `U` uncordon · `D` drain |
| **Port Forwards** | `X` stop |
| **YAML view** | `e` edit · `/` search · `n`/`N` next/prev · `g`/`G` top/bottom |
| **YAML edit** | `Ctrl-O` save · `Ctrl-X` exit |
| **Logs** | `f` follow · `g`/`G` top/bottom |
| **Exec** | `Ctrl-]` disconnect |
| **Anywhere** | `c` cluster switcher · `?` help · `q`/`Esc` back |

Port forwards started here live in **this** process: they appear under
**Cluster ▸ Port Forwards** and are invisible to the desktop app, which has its
own registry.

Full reference: [CLI docs](https://kubeinspector.com/cli/).

## Security & privacy posture

- **No telemetry, no analytics, no crash reporting.** Nothing about your usage
  leaves the machine.
- **Kubeconfigs and cluster data stay local.** Clusters live in `~/.kube-ins/`
  (mode `0700`) and are read by the app only.
- **Local servers bind loopback only.** The RPC server between the Go backend
  and the window uses an ephemeral `127.0.0.1` port with a per-process token;
  the multi-instance hub on `localhost:34200` requires a shared token from
  `~/.kube-ins/.hubtoken`. Port forwards bind `127.0.0.1` exclusively.
- **Outbound requests only for:** the update manifest at `kubeinspector.com`,
  artifacts you choose to download, the Trivy vulnerability database when you
  run a scan, and `registry.ollama.ai` if you use the AI assistant.
- **Diagnostics are redacted and manual.** The report is copied to your
  clipboard by you, with home paths, cluster names, secrets and tokens scrubbed.

Full detail: [Privacy](https://kubeinspector.com/privacy/).

## Building from Source

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Go | 1.26+ | `GOEXPERIMENT=jsonv2` is **required**, not optional |
| Node.js | 20+ | |
| Wails CLI | latest | used to generate the TypeScript bindings |
| nfpm | latest | only for `pkg-deb` / `pkg-rpm` |

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

> **`GOEXPERIMENT=jsonv2` is mandatory.** The bundled Trivy scanner pulls in
> `encoding/json/v2`, which is gated behind that experiment. The `Makefile`
> exports it for every target; bare `go build` / `go test` / `wails` invocations
> must set it themselves or the build fails with
> `build constraints exclude all Go files in .../encoding/json/v2`.

Linux build hosts need no GTK or WebKit development packages — the shipped GUI
is Electron.

### Development

```bash
make dev
```

One command: it starts the Go backend, Vite and Electron, and tears all three
down together on Ctrl-C. Wails remains available for debugging against the
system webview (`make dev-wails`), but it is a development target only — every
released build is the Electron one.

```bash
make dev-tui     # the terminal UI alone
```

### Checks

```bash
make check       # go test + vet + golangci-lint, then tsc, eslint, i18n parity, vitest
```

Run this before opening a pull request. See
[CONTRIBUTING.md](.github/CONTRIBUTING.md).

### Production Build

```bash
make build           # current platform
make build-linux
make build-windows
make build-mac

make build-tui       # standalone terminal UI (kube-inspector-cli)
```

Output goes to `build/bin/`.

### Package (deb / rpm / installer / dmg)

```bash
make pkg-deb        # .deb (Debian / Ubuntu)
make pkg-rpm        # .rpm (RHEL / Fedora)
make pkg-windows    # NSIS installer (.exe)
make pkg-mac        # DMG (.dmg)
make pkg-tui-deb    # kube-inspector-cli .deb
make pkg-tui-rpm    # kube-inspector-cli .rpm
make pkg-all        # everything above
```

Packages go to `dist/`.

### Documentation site

```bash
make docs-serve     # live preview at http://127.0.0.1:8000
make docs-build     # build to ./site with --strict
```

## Contributing

- [Contributing guide](.github/CONTRIBUTING.md)
- [Security policy](.github/SECURITY.md)
- [Code of conduct](.github/CODE_OF_CONDUCT.md)
- [Translation fixes](https://kubeinspector.com/contributing/translations/) — the
  German, Russian, Chinese and Japanese catalogs are machine-translated and
  corrections are the easiest first contribution.

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.
