# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [v0.16.1-beta] - 2026-09-20

A pod-list release. The Pods screen previously reported a pod whose only container was in `CrashLoopBackOff` as **Running**, because it showed the phase and nothing else. It now says what `kubectl` says, adds a warning column that explains *why* a pod is unhealthy, and keeps the row's action buttons on screen when the table is wider than its panel.

### Added
- **A warnings column on the Pods screen.** An amber icon (with a count when there is more than one) marks every pod that is not running healthily, and hovering it lists each reason in full: a pod-level reason from the kubelet or controller (`Evicted`, `NodeLost`, …), a pod that cannot be scheduled, one stuck terminating past its deletion deadline, a container waiting on a fault (`CrashLoopBackOff`, `ImagePullBackOff`, …), a container that exited non-zero, and a container that is running but failing readiness. It also flags **a crash within the last hour even when the container is healthy now**, which is what makes a pod that "works but flaps" visible at all. Readiness gets a 30-second grace period so a warming-up container is not reported as broken. The column sorts by warning count, so the pods that need attention come to the top of the list.
- **A READY column** — ready / total containers, exactly as `kubectl get pods` counts it, coloured green when all are ready, amber when some are, red when none are.
- **A NODE column**, filterable like the others, showing which node a pod landed on and an explicit "not scheduled" dash while it has not.

### Changed
- **Pod status now mirrors `kubectl`'s STATUS column.** The screen showed the pod phase alone, so `CrashLoopBackOff`, `ImagePullBackOff`, `OOMKilled`, `Evicted` and an init container stuck at `Init:0/2` all appeared as `Running` or `Pending`. The most telling container or init-container reason now wins over the phase, the way `kubectl` picks it — including the details: a native sidecar (an init container with `restartPolicy: Always`) that has started no longer counts as blocking initialization, a pod whose job containers have finished while others still serve reads as `Running` rather than `Completed`, and a terminating pod on a lost node reads `Unknown`. The status colour follows the meaning rather than the word: progress states are amber, faults red, clean completions grey.
- **The per-container dots say more.** A container waiting for a normal reason (`ContainerCreating`, `PodInitializing`) is now blue rather than red, one that terminated with an error is red rather than grey, and **a container that has restarted carries an amber corner mark even while it is currently ready**. The tooltip adds ready / not-ready to the state and reason it already showed. Init containers are still squares, regular containers circles.
- **Row actions stay on screen.** A resource table is often wider than the panel it lives in, and the buttons that act on a row were the first thing to scroll out of sight. Each view's action buttons and the ⋮ menu are now merged into **one column frozen to the right edge**, separated by a divider, so they are reachable however far the table is scrolled sideways.

### Fixed
- **A split workspace no longer freezes every panel but one.** Background tabs stop polling (v0.16.0-beta), but the check asked dockview whether a panel was *active* — true for exactly one panel in the whole window. With the workspace split into two or more groups, every visible panel except the one last clicked was treated as backgrounded and quietly stopped refreshing. It now asks whether the panel is *visible*, which is per group, so the foreground tab of each group stays live.
- **Filter dropdowns no longer rewrite the values they show.** A stylesheet rule capitalised the selected entries, so `CrashLoopBackOff` was displayed as `Crashloopbackoff` and `kube-system` as `Kube-System` — values that match nothing the cluster ever reports.

### Internal
- The repository moved to [`opensourcemonkeys/kube-inspector`](https://github.com/opensourcemonkeys/kube-inspector); every link in the README, the documentation site, the issue templates and the security policy follows it.
- Pod status derivation and the warning rules are covered by unit tests.

---

## [v0.16.0-beta] - 2026-08-25

The first beta. Alongside the actions that were missing — describe, scale, rollout restart, port forwarding — this release is mostly about the app telling you the truth: when a call fails it says so instead of showing an empty table, it writes a log file you can attach to a bug report, and the local network surfaces it opens are now authenticated.

### Breaking
- **Apply YAML now applies to the cluster the panel belongs to.** It previously wrote to whichever cluster was globally selected, so applying from a tab pinned to `staging` could land in `prod`. It also no longer shells out to `kubectl` — the manifest is applied through the Kubernetes API with **server-side apply**, which means Apply YAML works on a machine with no `kubectl` installed. (It never could before: the app does not ship `kubectl` and did not declare it as a dependency.)
- **Resource lists now report failures instead of returning an empty list.** An RBAC denial, an unreachable API server and a genuinely empty namespace used to produce the same "No pods found" screen. They are now three different things on screen — see *Added* below. If you script against the app's API surface, the list calls can now reject.
- **Multi-instance discovery requires a shared token.** The instance hub on `localhost:34200` is authenticated, with no unauthenticated fallback. A v0.16 instance and an older one running side by side will not see each other and cannot transfer tabs between themselves; upgrade both.

### Added
- **Describe** — `kubectl describe` output for any object, events included, in a read-only panel next to the list you opened it from. It is rendered in-process with the same describer library `kubectl` uses, so no `kubectl` binary is involved. Refresh keeps your scroll position, and the whole output can be copied in one click. Available from every resource list, and from the CRD explorer and the Security Role Map.
- **Scale** — Deployments, StatefulSets and ReplicaSets. Set the replica count with a slider or an exact number. It uses the `scale` subresource rather than a full object update, so it cannot clobber a concurrent change. The dialog warns you when a HorizontalPodAutoscaler targets the workload (naming it, with its min/max) and when you ask for zero, and lets you proceed in both cases.
- **Rollout restart** — Deployments, StatefulSets and DaemonSets, using the same `kubectl.kubernetes.io/restartedAt` annotation `kubectl rollout restart` writes, so the workload's own update strategy governs how it rolls.
- **Suspend and resume CronJobs** from the row menu.
- **Port forwarding** — pick a target's port **by name** from a dropdown of what it actually declares, accept a suggested free local port, and get a tunnel on `127.0.0.1`. A forward against a Deployment, StatefulSet, ReplicaSet or Service **re-resolves its pod and reconnects**, so it survives a rolling restart; one pinned to a Pod deliberately does not. Tunnels are owned by the process, not by the panel — closing the tab does not stop them. A Port Forwards panel lists every tunnel across all clusters with copy-address, open-in-browser, restart and stop, and a title-bar pill keeps the count visible while the panel is closed.
- **Create a namespace** from the Namespaces screen, with labels.
- **Errors are visible and actionable.** A failed call now shows a banner carrying the API server's own message, with **Retry** and **Copy diagnostics**. When a refresh fails, the rows you were reading stay on screen and are marked stale instead of being blanked. Panels that crash show a card with a copyable diagnostic instead of an empty rectangle.
- **Diagnostics** (Help ▸ Diagnostics) — an Overview tab with environment details and health checks (API reachable, can list pods, metrics-server present — per cluster — plus the log directory, the update manifest and the Trivy database), a Logs tab with search, role filter, follow and a live log-level control, and an Export tab that copies a report, saves a zip, or opens the log folder.
- **Local log files.** Every process — backend, terminal UI and the Electron shell — appends to one daily file in `~/.kube-ins/logs/`, kept for 7 days. Nothing is ever uploaded. Everything the app contributes to a report is redacted first: home paths, cluster names, secrets, base64 blobs and API server addresses.
- **Six languages** — English, Türkçe, Deutsch, Русский, 中文, 日本語 — selectable from **Open ▸ Language**, applied without a restart. Turkish was reviewed by a native speaker; German, Russian, Chinese and Japanese are **machine-translated**, the app says so where you pick the language, and [corrections are welcome](https://kubeinspector.com/contributing/translations/).
- **An update channel selector** (Open ▸ Update channel), a **Check for updates** entry in the Help menu, and an "you are up to date" state — previously the update dialog only existed when there was something to install, which is exactly when you would not need to change channel. Below 1.0 the default channel is **beta**.
- **Failed updates are reported.** When an update is handed to an installer and the app comes back on the old version anyway, the next launch says so rather than silently pretending nothing happened.
- **Every release now publishes a `SHA256SUMS-<version>`** covering all artifacts, in addition to the per-file `.sha256` sidecars, and the GitHub release carries a second independently hosted copy.
- **Missing actions filled in** — delete for ServiceAccounts, Roles, RoleBindings, LimitRanges, Endpoints, IngressClasses, PersistentVolumes and StorageClasses; YAML editing for Jobs, IngressClasses, Endpoints, PersistentVolumes, VolumeClaims and StorageClasses; and the Resource Quotas screen is now backed by its own endpoint instead of one request per namespace.
- **The terminal UI keeps pace.** Describe (`Enter`), scale (`S`), rollout restart (`R`), port forwarding (`F`) with a Port Forwards view (`X` to stop), CronJob pause/unpause and every new delete and edit are all available in `kube-inspector-cli` too.

### Changed
- **The app starts noticeably faster.** The entry bundle went from 6.3 MB to 853 KB (242 KB gzipped): every panel is now loaded on demand, and the Monaco editor — by far the heaviest piece — arrives with the first YAML tab instead of being parsed at every launch.
- **Background tabs stop polling.** A list panel that is not visible no longer refreshes, so ten open tabs no longer mean ten request loops.
- **Themes now reskin everything.** The last 180 hardcoded colours in the UI are gone; charts, graphs and terminals repaint when you switch theme instead of keeping the old palette.
- **`kube-inspector-cli` installs to `/usr/bin`** instead of `/usr/local/bin`. Package managers handle this on upgrade.
- **Desktop icons** are shipped at eight sizes, so the launcher entry looks right at every scale.

### Fixed
- **Sessions no longer leak or cross-talk.** A shell that exited on its own, a pod that died, or a stream that broke used to leave the panel silently unresponsive and the process behind it unreaped. Sessions now clean up after themselves and say when they ended. Reopening a terminal, an exec session, a log stream or an AI chat while the previous one was still closing could also strand the live session or hang the AI tool-approval dialog forever — both are fixed.
- **A freshly opened terminal no longer reports "[shell exited]"** and ignores input.
- **A cluster name can no longer escape `~/.kube-ins/`**, and a failed client construction no longer panics the request.
- **Requests have timeouts**, so an unreachable API server fails instead of hanging a panel.
- **Filter dropdowns and tables stopped churning** — lists whose data had not actually changed were re-rendering every poll, which made multi-select filters rebuild themselves every two seconds.
- **The Windows CLI build never reached the download page** — it was renamed in place and so was never checksummed, never uploaded, and 404'd from a link the site advertised. The CLI `.deb` was also published under the wrong name.

### Security
- **The instance hub is authenticated** — a shared `0600` token plus an origin check that only accepts a request with no `Origin` header, which no browser can produce. Any web page you visited could previously connect to `localhost:34200`, list your instances and inject a panel.
- **The backend's RPC token is injected into the page rather than the URL**, so a cross-origin page cannot read it, and both the HTTP endpoint and the event socket check `Origin`.
- **Port forwards bind `127.0.0.1` exclusively**, enforced in code with no setting to change it.
- **Every update download is verified against its published checksum before it is installed** — on Linux the file is handed to the package manager as root, so this check is not optional.
- **Nothing is collected.** No telemetry, no analytics, no crash reporting; the full list of outbound requests is documented at [kubeinspector.com/privacy](https://kubeinspector.com/privacy/).

### Internal
- **CI now runs on every push and pull request**, not only on a tag: Go build, `vet`, `golangci-lint` and tests; frontend typecheck, lint, locale-parity check, unit tests and build; and a `--strict` docs build. Release tags are filtered to `v*` so an unrelated tag can no longer trigger a full release.
- Every goroutine goes through a panic-recovering helper, and the logging package deliberately avoids `slog.SetDefault` — the global the bundled Trivy library takes over, which had been swallowing every log line in the binary.
- The documentation site gained troubleshooting, FAQ, known-limitations, privacy, support, uninstall, unsigned-builds, describe, port-forwarding, language and translation pages, and the repository gained contributing, security, code-of-conduct, issue-template and Dependabot files.

---

## [v0.15.0-alpha] - 2026-07-26

### Added
- **The CRDs screen is now a CRD explorer** — instead of a flat table that row-expanded, the screen is split in two: a searchable **API group → kind tree** on the left and the selected kind's instances on the right. The tree shows a **live instance count** next to every CRD, and can be narrowed by name, by scope (Namespaced / Cluster), or to **only CRDs that actually have instances**. Counts that cannot be taken — no permission, an unreachable aggregated apiserver — are shown as unknown rather than as zero.
- **Instances are listed with the server's own columns** — the instance table asks the apiserver to render the list the same way `kubectl get` does, so a CRD's `additionalPrinterColumns` (Ready, Phase, Version, whatever the operator defines) appear automatically instead of a generic Name/Namespace/Age. A **wide** toggle reveals the extra columns `kubectl` only prints with `-o wide`. If a server cannot render tables, the panel degrades to the plain Name/Age listing instead of coming up empty.
- **Select and delete several instances at once** — the instance table supports multi-select with a single confirmation dialog; the CRD itself can still be viewed, edited or deleted from the same screen, and double-clicking a row opens its YAML.
- **Filters on many more columns** — Services (Type, Cluster IP, External IP), Endpoints (Addresses, Ports), Ingresses (Hosts, Paths, Address), PersistentVolumes (Access Modes, Reclaim Policy, Volume Mode), PersistentVolumeClaims (Access Modes, Volume), StorageClasses (Provisioner, Reclaim Policy, Binding Mode) and RoleBindings (RoleRef) all gained dropdown filters in the column header.
- **Search inside event messages** — the Events table's Message column now has a free-text filter.

### Fixed
- **Filtering columns that hold more than one value** — columns such as Hosts, Addresses, External IPs or Access Modes never matched anything, because the filter compared the whole list against a single selection. A row now matches when **any** of its values is selected, and the dropdown lists the individual values rather than the joined text.
- **CRD screens no longer stall on their own rate limit** — listing custom resources fans out one request per API group, which ran into the Kubernetes client's default client-side throttle and left the screen waiting for seconds on clusters with many CRDs. The limit is raised for these paths; the cluster's own fairness rules still apply.
- **Existing Events tabs keep their filters** — a tab saved before this release would throw when its Message filter was first touched. Saved filters are now upgraded on load.

---

## [v0.14.0-alpha] - 2026-07-26

### Added
- **In-app updater** — the "Update available" pill in the title bar now opens an updater dialog instead of sending you to the website. It downloads the new version with a progress bar, verifies it against the checksum published alongside the release, installs it, and restarts the app. On Linux the package is installed through the system package manager, so you are asked for your password once; on Windows and macOS the installer handles it. Where an automatic update is not possible the dialog explains why and still offers the downloads page.
- **Cancelable download** — the download step can be stopped and the dialog closed at any point. Once installation has begun it is left to finish, so a package manager transaction is never interrupted half-way.

### Changed
- **Releases now publish a checksum for every artifact** — each deb, rpm, installer and dmg is uploaded alongside a `.sha256` file, which the updater checks before installing anything.

---

## [v0.13.0-alpha] - 2026-07-25

### Added
- **Pod age and last restart** — the Pods screen gained two columns: **Age** (kubectl-style relative time since creation) and **Last Restart** (when a container in the pod last restarted, highlighted when it has). Hovering either shows the exact local timestamp. Last-restart time is read from the container's last termination state, falling back to the current container's start time when the kubelet has already dropped that state. Both columns are also in the CLI's pod list, using the same formatting so the desktop app and terminal UI agree.
- **Middle-click to close a tab** — clicking a workspace tab with the middle mouse button closes it. The close fires on release over the tab, so pressing and dragging away leaves the tab open.

### Fixed
- **Resource tables now follow their panel's height** — table rows stayed pinned to the size a panel had when it first opened, so resizing or maximizing a tab left empty space below the rows. The virtual scroller no longer latches its initial height, and the row count now follows the panel as it resizes.
- **Wheel-scrolling the tab strip** — with many tabs open, scrolling over the tab bar did nothing. The global smooth-scroll behaviour was cancelling dockview's own scrolling mid-flight; the tab strip is now excluded from it and scrolls normally again.

---

## [v0.12.0-alpha] - 2026-07-19

### Added
- **Multi-window panel management** — improved transfer and docking flows so panels can be moved more smoothly between windows and instances.

### Changed
- **Electron dev experience** — refined the Electron development workflow with improved backend/shell integration, RPC handling, and startup behavior for local development.
- **Window/tab UX** — updated the title bar, transfer menu, and dockview tab behavior for better multi-window interactions.
---

## [v0.11.0-alpha] - 2026-07-19

### Breaking
- **macOS is now Apple Silicon only.** The previous universal build supported Intel Macs; this release ships an `arm64` dmg. Intel users should stay on v0.10.0-alpha or use the [CLI](https://kubeinspector.com/cli/), which is still universal.
- **Linux install path changed** — the app now lives in `/opt/kube-inspector` with a `/usr/bin/kube-inspector` symlink, instead of a single binary in `/usr/local/bin`. Package managers handle this on upgrade.

### Changed
- **The desktop app now ships with an embedded Chromium (Electron) instead of the system webview.** On Linux this removes the `libwebkit2gtk` dependency entirely: the packages declare **no dependencies at all**, and a single build now works on every distribution. The previous per-distro packages (`ubuntu-22.04` / `ubuntu-24.04`, `rhel9` / `rhel10`, split only because of the webkit2gtk 4.0-vs-4.1 divide) are replaced by one `linux-amd64` deb and one `linux-x86_64` rpm. Rendering is now identical on Linux, Windows and macOS, and Chrome DevTools is available.
- **Package size** — roughly 180MB (was ~90MB), about 523MB installed. Most of that is the bundled Chromium plus the built-in Trivy vulnerability scanner.

### Added
- **Terminal-only mode is unaffected** — `kube-inspector-cli` continues to ship as a separate, webview-free package with no new dependencies.

### Internal
- The controller layer is now **shell-agnostic**: everything Wails-specific sits behind a `Transport` interface, and a loopback HTTP/WebSocket RPC server exposes the same API to any shell. The Go backend runs as a sidecar process that the shell launches; all Kubernetes work, event streaming and the embedded frontend are unchanged.
- The Wails shell remains available for development (`make dev`, `make build`) but is no longer packaged or released.

---

## [v0.10.0-alpha] - 2026-07-13

### Added
- **Overview screen** — a new default workspace tab gives an at-a-glance summary of the cluster when a panel first opens, sharing the usage helpers (`lib/usage.tsx`) with the Monitoring dashboard.
- **Multi-pod exec** — the Pods screen can now open an exec/shell session across multiple selected pods at once.
- **Pod container status column** — the Pods table now surfaces per-container status, backed by new fields on `PodInfo` and the pod service layer.

### Changed
- **Events & resource list scrolling** — smoother scroll behavior in the Events screen and the shared `ResourceListView`.

### Fixed
- **Build fixes** — resolved build issues.

---

## [v0.9.0-alpha] - 2026-07-12

### Added
- **Custom Resource Definitions (CRDs) screen** — a new workspace view lists the cluster's CRDs and row-expands to each CRD's live instances. Any object (a CRD or a custom-resource instance) can be viewed, edited, deleted, or described generically by (group, resource, namespace, name) through the dynamic client — the same generic path the Security Role Map and TUI describe reuse.
- **Kubernetes YAML IntelliSense** — the YAML editor and Apply-YAML panels now share a Kubernetes-aware completion/validation helper (`k8sYamlIntellisense`) for smarter editing.
- **CLI / TUI additions** — the terminal UI gained CRDs, an apply-YAML (empty editor) window, Resource Quotas, and a Monitoring screen, further closing the gap with the desktop app.

### Changed
- **Resource list filtering** — refined DataTable filter behavior across the shared resource list views.
- **Sidebar cluster-management navigation** — repositioned so the managed-cluster nav sits correctly.

---

## [v0.8.1-alpha] - 2026-07-05

### Changed
- **Unified resource list views** — all ~21 table-based resource screens (pods, deployments, services, configmaps, secrets, RBAC, storage, networking, …) were rebuilt on a shared `ResourceListView` component and `useResourceList` hook. Filtering, polling (paused while a tab is backgrounded), multi-select delete, and toasts now behave identically across every screen, and ~2,600 lines of duplicated table code were removed.
- **Website refresh** — styling and home page refinements on the documentation site.

---

## [v0.8.0-alpha] - 2026-06-28

### Added
- **Inspect window in CLI** — a new inspect/detail view was added to the CLI screen so users can inspect selected resources more conveniently.

### Changed
- **CLI/TUI build size optimization** — the terminal-only build now excludes Trivy and desktop/Wails-specific code paths, resulting in a much smaller standalone binary.
- **Release packaging improvements** — production builds now strip debug symbols and avoid VCS metadata in the binary, which reduces artifact size for distribution.

### Fixed
- **Large standalone CLI binary** — the `kube-inspector-cli` artifact is now built with lighter defaults so it is more practical to ship and install.

---

## [v0.7.0-alpha] - 2026-06-28

### Added
- **Terminal UI (TUI)** — a new `tview`-based terminal interface that mirrors the desktop app (resource menu, tables, cluster add/select/delete, YAML view/edit, delete, pod logs and exec) on a single focused screen. It reuses the same `internal/business` functions as the GUI, so no new service endpoints were added. Ships two ways:
  - **Standalone CLI** — a separate, webview-free `kube-inspector-cli` binary (`cmd/tui`) with its own packages (`make build-tui*`, `make pkg-tui-deb`/`pkg-tui-rpm`). No `libwebkit2gtk` dependency.
  - **CLI Mode in the GUI** — an **Open ▸ CLI Mode** action opens a fullscreen terminal (xterm.js) running the TUI over the dockview/menu (which stay mounted underneath). The GUI re-execs itself with `--tui` in a pty; quitting the TUI restores the desktop UI.
- Cross-platform, k9s-style single-key shortcuts (`/` filter, `r` refresh, `y` yaml, `e` edit, `d` delete, `l` logs, `s` shell, `c` cluster, `?` help) shown as hints in the top bar.

### Changed
- **Release artifact names** — the desktop binary/installers are now published as `kube-inspector-*` (was `kube-ins-*`) and the CLI as `kube-inspector-cli-*`.

---

## [v0.6.4-alpha] - 2026-06-27

### Added
- **Vulnerability detail view** — clicking a CVE in the **Vulnerability Scan** screen now opens a detail panel with the full description, published date, fixed version, and external reference links; the underlying scan model was extended with `description`, `references`, and `publishedDate` (and richer fields for Kubernetes misconfiguration findings).

### Changed
- **Workspace layout** — the standalone cluster bar was removed; cluster selection now lives inside the sidebar and the **sidebar toggle moved into the title bar**, giving a cleaner, more compact top area.

---

## [v0.6.3-alpha] - 2026-06-27

### Added
- **AI Assistant improvements** — Ollama-backed chat experience with model discovery, pull flow, and cluster-aware tool actions.
- **Security scanning enhancements** — expanded Trivy-based image and cluster scan workflow with richer result handling.

### Changed
- **Security UI** — Trivy scanner view and scan result models were refined for clearer vulnerability reporting.
- **App experience** — theme handling, title bar interactions, and related UI polish were improved across the desktop experience.

## [v0.6.2-alpha] - 2026-06-18

### Changed
- **Monitoring** — selectable chart **time window** (5 min – 2 hours) with a time-based axis and easier hover tooltips; an animated **Pods / Workloads** switch; **Take snapshot** now uses a native Save dialog (reliable across Linux/macOS/Windows).

---

## [v0.6.0-alpha] - 2026-06-17

### Added
- **Monitoring dashboard** — new **Monitoring** screen under the Cluster menu with live cluster, node, pod, and workload CPU/memory usage charts, rolling time-series history, and filterable resource tables.
- **Dashboard snapshot export** — save the Monitoring panel as a PNG snapshot for reporting or sharing.
- **Update availability** — title bar now checks for newer releases and displays an update prompt with a download link.

### Changed
- **Cluster metrics collection** — improved monitoring by combining metrics-server data with Kubernetes objects for richer live resource usage reporting.

---

## [v0.5.9-alpha] - 2026-06-15

### Changed
- **Dropped remaining GitHub references** — removed the GitHub Releases / repository links from the README and the installation docs, and pointed the Linux package `homepage` to `https://kubeinspector.com`.

---

## [v0.5.8-alpha] - 2026-06-15

### Added
- **Vulnerability scanning (Trivy)** — a new **Vulnerability Scan** screen under the Security menu that integrates the Trivy library directly. Three tabs: a full-cluster scan (every image running across namespaces), a single-image scan, and per-namespace pod images. Results show a severity summary and a filterable, sortable table of CVEs (linked to cve.org), grouped by image.
- **Release distribution (Cloudflare R2)** — release artifacts are published to an R2 bucket under `/dist`.

### Changed
- **Rebranded to "Kube Inspector"** — all user-facing names (window title, title bar, About dialog, documentation) now read *Kube Inspector*. Internal identifiers (the `kube-ins` module/binary/package names and the `~/.kube-ins` config directory) are unchanged.
- **Cluster manager** — reworked the add/manage cluster modal.
- **Build toolchain** — the Trivy library pulls in `encoding/json/v2`, so the build now sets `GOEXPERIMENT=jsonv2` (exported by the Makefile) and CI builds with Go 1.26.

---

## [v0.5.5-alpha] - 2026-06-14

### Fixed
- **CI / Packaging (Ubuntu 24.04)** — the Ubuntu 24.04 build now passes `WAILS_TAGS=webkit2_41` so Wails compiles against `webkit2gtk-4.1`. Previously the build failed because Ubuntu 24.04 no longer ships `webkit2gtk-4.0`, which Wails links against by default.

---

## [v0.5.4-alpha] - 2026-06-14

### Changed
- **CI / Packaging** — linux artifact build adjusted for latest distributions; artifact filenames now include distro markers.

---

## [v0.5.3-alpha] - 2026-06-14

### Added
- **Security graph** — added a dedicated security graph view to visualize role and policy relationships.
- **Events screen state persistence** — proof-of-concept state storage using Zustand for the events screen.

### Changed
- **Security role mapping improvements** — enhanced role mapping handling for more accurate security rule display.
- **React Flow optimization** — improved React Flow performance and rendering efficiency.

---
## [v0.5.1-alpha] - 2026-06-13

### Fixed
- **CI E2E pipeline** — the frontend is now built before launching `wails dev` so the `//go:embed all:frontend/dist` directive resolves on a clean checkout (`dist/` is gitignored). Previously the dev server failed to compile, never came up, and the readiness check hung.
- E2E readiness check now fails fast and prints the dev log when `wails dev` exits early, instead of waiting out the full timeout.

---

## [v0.5.0-alpha] - 2026-06-13

### Added

#### Config & Security (RBAC)
- **Service Accounts** — DataTable with namespace and secret/token columns; read-only YAML view; new model, service and business layers
- **Roles** — namespaced DataTable with rule summary; YAML view/edit via a dedicated `RoleEditorPanel`
- **Role Bindings** — DataTable showing role reference and subjects; YAML view/edit via `RoleBindingEditorPanel`

#### Multi-Instance Management
- **Instance discovery & panel transfer** over a WebSocket IPC hub (`localhost:34200`); the first kube-ins process becomes the hub server, later processes connect as clients, and the hub auto-reassigns when the server exits
- **Transfer a tab to another instance** — right-click any tab to send the panel to another running instance via `InstancePickerMenu`; `terminal` and `podExec` panels are non-transferable
- Instances are auto-named in connection order ("Instance 1", "Instance 2", …) and shown in the title bar
- New `InstanceContext`, `TabInstanceBridge` and a custom `FloatableTab` tab header

#### Per-tab Cluster Isolation
- Each panel is now pinned to the cluster it was opened with; new `NewK8sClientForCluster` / `NewK8sClientAndConfigForCluster` / `NewMetricsClientForCluster` constructors load the panel's cluster directly, bypassing the global active path
- Panel IDs and tab titles encode the cluster name, so changing the global cluster via the cluster bar no longer affects already-open tabs
- **Cluster bar menu** for per-cluster actions

#### DataTable Filters
- **MultiSelect (dropdown) filters** for string columns (namespace, status, type, …) with `IN` matching and built-in search; numeric columns keep a number input
- **Workload status column** added to workload lists; improved tab insertion order

#### UI
- Switched to **Material Icons** / VSCode icon sets across the app
- Log viewer theming, dropdown theming and oversize hidden-item theme fixes

#### Testing & CI
- **Selenium E2E suite** under `e2e_tests/` (pytest): app smoke flow, navigation across every sidebar item, full YAML CRUD lifecycle, and panel open/load checks (Logs, Exec, Resource Graph); self-contained HTML report with inline failure screenshots; `make test-e2e` target
- **GitHub Actions E2E stages** — on tag, an ephemeral `kind` cluster + `xvfb` + headless Chrome run the suite, and the report is emailed via Gmail SMTP

### Changed
- Controller, business and service layers thread `clusterName` through all resource-fetching functions

### Fixed
- **Apply YAML** now targets the active cluster's kubeconfig (`--kubeconfig`) and surfaces kubectl's error output instead of a bare `exit status 1`

---

## [v0.4.0-alpha] - 2026-05-30

### Added

#### Storage
- **Persistent Volumes** — DataTable showing status, capacity, access modes, reclaim policy, storage class, volume mode and bound claim; read-only YAML view
- **Volume Claims** — DataTable with request/limit columns (instead of generic capacity), status tag, multi-select delete, read-only YAML view
- **Storage Classes** — DataTable with default tag, provisioner, reclaim policy, binding mode; read-only YAML view

#### Networking
- **Ingresses** — DataTable with class, hosts, paths, address and TLS tag; YAML view/edit, delete action
- **Ingress Classes** — cluster-scoped resource; default tag, controller column; read-only YAML view
- **Endpoints** — DataTable with ready/not-ready address counts and port info; read-only YAML view

#### Cluster
- **Events** — DataTable with message truncation (40 chars), warning-only toggle filter, 5 s polling; double-click opens detail modal with full message
- **Limit Ranges** — DataTable with type tags and per-type CPU/memory columns; list button opens full resource table modal; YAML view/edit

#### Pod Exec
- **Exec into pod** — new terminal panel per pod opened via the Exec button in the pod list; uses `kubectl exec`-equivalent SPDY streaming via `k8s.io/client-go/tools/remotecommand`
- Pod list now exposes two action buttons per row: **Logs** (article icon) and **Exec** (terminal icon)
- `containers` field added to `PodInfo` model; exec session defaults to the first container

#### UI
- **Material Icons** (`@mui/icons-material`) added as icon library alongside PrimeIcons; used for pod action buttons
- Menu consolidated to a single source of truth in `menuItems.tsx`; `menu.tsx` no longer duplicates nav item definitions

---

## [v0.3.2-alpha] - 2026-05-30

### Added

#### CI/CD
- **macOS DMG packaging** — new `build/dmg-builder/` node package using `appdmg`; produces `kube-ins-<version>-macos-universal.dmg` under `dist/`
- `build-mac` and `pkg-mac` Makefile targets for local macOS builds and DMG generation
- `build-macos` job added to GitHub Actions pipeline (`macos-latest` runner); runs in parallel with Linux and Windows build jobs
- macOS DMG artifact downloaded and uploaded to GitHub Releases in the release job

---

## [v0.3.1-alpha] - 2026-05-30

### Fixed

#### CI/CD
- Linux package filenames now use `-` instead of `~` as the pre-release separator (`version_schema: none` in nfpm)
- Linux package filenames include platform label: `debian` for `.deb`, `rhel` for `.rpm`
- Windows installer filename includes version and platform: `kube-ins-<version>-windows-amd64.exe`
- NSIS (`makensis`) added to PATH after winget install step to fix "Cannot create installer: makensis not found" error
- GitHub Actions pipeline consolidated: Linux build and packaging merged into a single job

---

## [v0.3.0-alpha] - 2026-05-30

### Added

#### Networking
- **Services** — DataTable with namespace filter, port/type tags, YAML view/edit, delete action

#### UI / UX
- **Onboarding Tour** — step-by-step guided tour on first launch covering key panels and actions
- **About Modal** — app version, build info, and repository link accessible from the cluster bar

#### Editor
- **Kubernetes YAML Schema Validation** — Monaco editor validates YAML against the full Kubernetes API schema; inline errors and autocompletion for all resource types

#### CI/CD
- Linux packages (`.deb` and `.rpm`) built with nfpm and published to GitHub Releases
- Windows NSIS installer built with `wails build -nsis` and published to GitHub Releases
- Makefile build targets: `build-linux`, `build-windows`, `pkg-deb`, `pkg-rpm`, `pkg-all`
- GitHub Actions pipeline split into Build & Package stage and Release stage

### Changed
- Dockview panel drag-and-drop uses a custom drag event for more reliable panel reordering
- Node and ResourceQuota screens refactored: leaner component structure, reduced DOM nesting

### Removed
- AI Assistant panel and all related backend endpoints

---

## [v0.2.0-alpha] - 2026-05-24

### Added

#### Cluster
- **Namespaces** — DataTable with multi-select, bulk delete, status tag, double-click YAML view
- **Resource Quotas** — Hierarchical card layout grouped by namespace; per-quota usage bars (green/amber/red), used/hard values, inline YAML edit per quota; namespace filter
- **Nodes** — Custom card layout per node: CPU & RAM usage charts (Chart.js), cordon / uncordon / drain actions, YAML edit

#### Config & Secrets
- **ConfigMaps** — Key-value editor panel in addition to YAML view/edit
- **Secrets** — Key-value editor panel in addition to YAML view/edit

#### AI
- **AI Assistant** — Chat panel powered by configurable LLM; context-aware cluster queries

#### UI / UX
- Unified toolbar style across all resource screens — consistent `h3` title, padding, and bottom border
- All DataTable screens moved to standalone toolbar div (header extracted from PrimeReact DataTable)

### Changed
- Node screen header cleaned up; redundant "Updates every 3 seconds" annotation removed
- Various SonarQube code-quality and accessibility fixes

---

## [v0.1.0-alpha] - 2026-05-19

### Added

#### Workloads
- **Pods** — list, delete, YAML view, log streaming
- **Deployments** — list, scale, delete, YAML view/edit, log streaming
- **StatefulSets** — list, delete, YAML view/edit, log streaming
- **ReplicaSets** — list, delete, YAML view/edit, log streaming
- **DaemonSets** — list, delete, YAML view/edit, log streaming
- **Jobs** — list, delete, YAML view (read-only), log streaming
- **CronJobs** — list, suspend/resume, delete, YAML view/edit, log streaming

#### Cluster Management
- Multi-cluster support — add, edit, and switch between clusters
- Cluster connection health check (polls every 20 seconds)
- Cluster resource graph visualization (ReactFlow)
- kubeconfig stored per-cluster under `~/.kube-ins/`

#### Networking
- **Network Policies** — list, YAML view, visual policy diagram (ingress/egress rules)

#### Workspace
- **YAML Editor** — apply arbitrary YAML to the active cluster (Monaco editor)
- **Terminal** — integrated kubectl terminal (xterm.js + pty)
- **Log Viewer** — real-time pod log streaming with pod selector for workload-level views

#### UI / UX
- Dockview resizable panel layout — drag, split, and dock panels freely
- PrimeReact Lara Dark theme with monolith overrides
- VSCode-style sharp corners (zero border-radius) on modals, buttons, inputs
- DataTable column resizing with visible resize handles
- Sidebar navigation grouped by resource category
- Dark monolith CSS theme with custom color palette

#### CI/CD
- GitHub Actions multi-platform build matrix (Linux amd64, Windows amd64, macOS universal)
- Automatic GitHub Release creation and artifact upload on tag push
