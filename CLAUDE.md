# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**kube-ins** is a desktop application for managing Kubernetes clusters with a visual interface. It's built using:
- **Backend**: Go with Wails v2 (desktop app framework)
- **Frontend**: React 18 + TypeScript with Vite, using PrimeReact + MUI components and Dockview for a resizable panel layout
- **Kubernetes Integration**: Uses `k8s.io/client-go` to interact with Kubernetes clusters

The app provides a unified interface to visualize and manage Kubernetes resources (pods, deployments, network policies, etc.) across multiple cluster configurations.

## Architecture

### Backend Architecture (Go)

The backend follows a layered architecture with clear separation of concerns:

```
main.go
└── controller/
    ├── app.go (Wails binding point, holds context + InstanceHub)
    └── functionBuilder.go (Exposes Go functions to frontend via Wails)
        ├── business/
        │   ├── pod.go, deployment.go, networkPolicy.go, cluster.go, terminal.go, log.go, etc.
        │   └── applyYaml.go, clusterResource.go
        ├── services/
        │   └── *Services.go (handles Kubernetes client logic and YAML operations)
        ├── repository/
        │   └── k8sClient.go (abstracts kubeconfig loading and k8s.io/client-go initialization)
        └── ipc/
            ├── hub.go (WebSocket hub for multi-instance discovery and panel transfer)
            └── messages.go (message types: MsgRegister, MsgInstanceList, MsgTransferTab)
models/
└── *Info.go (data structures for frontend serialization)
└── instanceModels.go (InstanceInfo, SerializedPanel — used by IPC system)
```

**Layer Responsibilities**:

1. **Controller** (`internal/controller/`): Entry point for Wails bindings. The `App` struct holds the `context.Context` and an `*ipc.InstanceHub`. `functionBuilder.go` exposes all callable methods to the frontend via Wails RPC, including `GetInstances()`, `GetSelfInstanceInfo()`, and `TransferTab()`.

2. **Business** (`internal/business/`): Orchestration layer that coordinates repository and service calls. Also manages app state like active cluster selection (persisted to `~/.kube-ins/.active` file).

3. **Services** (`internal/services/`): Direct Kubernetes API interactions. Takes a `kubernetes.Clientset` as a parameter (not a global). Examples: `GetPods()`, `DeletePod()`, `GetPodYaml()`, `GetClusterGraph()`.

> The backend has grown to cover most core Kubernetes resources — each has a parallel `business/<kind>.go`, `services/<kind>Services.go`, and `models/<kind>Info.go` triple (pods, deployments, daemonsets, statefulsets, jobs, cronjobs, services, endpoints, ingresses, configmaps, secrets, RBAC roles/bindings/service accounts, PVs/PVCs, storage classes, namespaces, nodes, events, quotas, limit ranges, etc.). The `securityGraph` feature (`business/securityGraph.go` → `services/securityGraphServices.go` → `models/securityGraphInfo.go`, surfaced by `components/security/SecurityRoleMap.tsx`) builds an RBAC subject→role→resource graph and needs both client and rest config (`NewK8sClientAndConfigForCluster`). The `trivy` vulnerability scanner (`business/trivy.go` → `services/trivyServices.go` → `models/trivyScanInfo.go`, surfaced by `components/security/TrivyScanner.tsx`) is different: instead of calling the k8s API it imports the **Trivy library directly** (`github.com/aquasecurity/trivy`). `services.ScanImage` hand-builds a `flag.Options` and runs `artifact.NewRunner(...).ScanImage(...)`; several non-obvious defaults are mandatory (`PackageOptions.PkgTypes`, `VulnSeveritySources: "auto"`, and the blank import `_ "modernc.org/sqlite"` for the Java/RPM DB) or scans silently return nothing. The cluster scan is implemented as the frontend listing all pod images (`TrivyListPodImages`) and scanning each via `TrivyScanImage` — there is no `trivy k8s` misconfig scan. Importing Trivy also has a **binary-wide side effect on logging**: its `pkg/log` `init()` calls `slog.SetDefault` with a handler that only buffers records into a slice until Trivy initialises its own logger, and since Go 1.21 `slog.SetDefault` reroutes the standard `log` package through the default handler too. Every `log.Print*` in the process therefore went nowhere — and kept working in tests, which never link Trivy. `main.go` restores `log.SetOutput(os.Stderr)` + `log.SetFlags` right after the `--tui` branch (stderr, never stdout — see the sidecar protocol below; and not for the TUI, which owns the screen). Anything built on `slog.Default()` inherits the same trap. Follow the existing triples when adding a resource — see "Adding a New Resource Type" below.

> Five features go beyond the per-resource triples:
> - **CRDs & generic object CRUD** (`business/crd.go` + `business/objectYaml.go` → `services/crdServices.go`/`objectYamlServices.go` → `models/crdInfo.go`, surfaced by `components/crd/main.tsx` + the `objectYaml` Dockview panel, and by TUI `crd.go`/`describe.go`). Unlike the typed triples, this path is **GVR-addressed via the dynamic client** and so needs the rest config (`NewK8sClientAndConfigForCluster`), not just the clientset. `GetCRDs(clusterName)` lists CustomResourceDefinitions; the CRD list **row-expands** to that CRD's live instances via `GetCustomResources(clusterName, group, resource)`. Any object (CRD or custom-resource instance) is then viewed/edited/deleted/described generically by (group, resource, namespace, name) through `GetObjectYaml`/`UpdateObjectYaml`/`DeleteObject`/`GetObjectDescribe` — the same generic helpers the Security Role Map detail modal and TUI describe panel reuse.
> - **Live resource Monitoring** (`business/metrics.go` → `services/metricsServices.go` → `models/metricsInfo.go`, surfaced by `components/monitoring/main.tsx`). `GetMetricsSnapshot(clusterName)` returns one point-in-time `MetricsSnapshot` (cluster totals, nodes, pods, workloads) from metrics-server; pods carry per-container usage and a resolved top-level owner (ReplicaSet→Deployment) so the dashboard can drill down. metrics-server is point-in-time only, so trend charts are built **client-side**: the dashboard polls every ~4s and keeps a rolling time-series in `stores/metricsStore.ts` (in-memory, **not** persisted — contrast with `eventsStore`). Charts use PrimeReact's `Chart` (chart.js) with a linear time x-axis.
> - **In-app updater** (`business/update.go` + `business/selfUpdate.go` → `services/selfUpdateServices.go` + `services/selfUpdate_{linux,windows,darwin}.go`, surfaced by `components/titlebar/UpdateModal.tsx`): `App.CheckForUpdate` fetches `https://kubeinspector.com/version.json` (overridable via `KUBE_INS_UPDATE_MANIFEST` for local testing) and compares with `appVersion` via `golang.org/x/mod/semver`. The manifest carries an `assets` map keyed by platform (`linux-deb`, `linux-rpm`, `windows-amd64`, `darwin-arm64`); `resolveAsset` picks this machine's entry and sets `Installable`, and the title-bar pill opens a two-step modal (download with a percentage bar, install with an indeterminate one) that ends by restarting the app. `App.StartSelfUpdate(sessionId)` runs it, streaming `update:progress:${id}` / `update:done:${id}` / `update:error:${id}`; `CancelSelfUpdate` aborts the download only — cancellation is dropped before the installer runs (`context.WithoutCancel`) so dpkg/rpm is never killed mid-transaction. Every download is checked against the `<assetUrl>.sha256` sidecar CI publishes beside each artifact, because on Linux the file is then handed to the package manager as root.
>
>   Each platform installs differently and that difference is load-bearing. **Linux** cannot update in place — the tree is root-owned under `/opt/kube-inspector`, dpkg/rpm-managed, and `chrome-sandbox` must stay setuid root — so the package goes to `pkexec dpkg -i` / `pkexec rpm -Uvh` **synchronously**, and only then does the shell relaunch. **Windows** runs the NSIS installer with `/S` and does *not* wait: the installer closes the running app itself and restarts it (`nsis.runAfterFinish`). **macOS** stages the new bundle out of the dmg and hands the swap to a detached helper script that waits for the app to exit first, since macOS maps the running executable out of the bundle being replaced. Hence `RunInstaller`'s two restart modes: `RestartRelaunch` (we re-exec) vs `RestartExternal` (we only quit), which the frontend turns into `relaunchApp()` or `quitApp()` — new `shell:relaunch` / `shell:quitApp` IPC channels, so **the updater only completes under the Electron shell**; elsewhere `Installable` is false and the modal falls back to opening the downloads page. The manifest and the `.sha256` sidecars are generated by the Makefile `docs-downloads` target and the `Checksums` step in each `build.yml` build job.
> - **Window screenshot** (`App.SaveSnapshot` → `business/snapshot.go` → `services/snapshotServices.go`): the frontend renders a panel to a PNG via `html-to-image`, then the controller opens a native `runtime.SaveFileDialog` and the service writes the file (webview `a[download]` is unreliable in WebKitGTK).
> - **AI assistant** (`internal/ai/` + `business/ai.go`, surfaced by `components/ai/AiChat.tsx`): a local-LLM chat agent backed by **Ollama** (`github.com/ollama/ollama/api`), default host `http://localhost:11434`. Not a per-resource triple — see the dedicated section below.

4. **Repository** (`internal/repository/`): Abstracts kubeconfig loading. Provides six constructors in two families:
   - `NewK8sClient()` / `NewK8sClientAndConfig()` / `NewMetricsClient()` — read the global active kubeconfig path (set via `SetActiveKubeconfig()`). Still used by cluster-management functions that don't have a per-tab cluster.
   - `NewK8sClientForCluster(clusterName)` / `NewK8sClientAndConfigForCluster(clusterName)` / `NewMetricsClientForCluster(clusterName)` — load `~/.kube-ins/{clusterName}.yaml` directly, **bypassing the global active path**. Used by all resource-fetching business functions so each panel stays pinned to its cluster regardless of which cluster the user has globally selected. Falls back to `NewK8sClient()` when `clusterName == ""`.

5. **Models** (`internal/models/`): Struct definitions for frontend serialization (e.g., `PodInfo`, `DeploymentInfo`). These are marshaled to JSON by Wails.

6. **IPC** (`internal/ipc/`): Multi-instance discovery and panel transfer over WebSocket. The first kube-ins process binds `localhost:34200` and becomes the hub server; subsequent processes connect as clients. The hub auto-reassigns when the server exits. Exposes `GetInstances()`, `GetSelfInfo()`, `TransferTab()` on `InstanceHub`.

   The handshake is authenticated, because the port is **fixed** and a `SerializedPanel` is arbitrary enough to be an injection vector (`yamlEditor`/`objectYaml`/`applyYaml` aimed at anything). Two independent gates: `CheckOrigin` accepts **only an empty `Origin`** — browsers always stamp one and no legitimate hub client is a browser — and every handshake must present the shared token from `~/.kube-ins/.hubtoken` as `?token=` (compared with `crypto/subtle`), which also keeps out another local account. Unlike `rpcserver.go`'s per-process token, the hub's is **cross-process**, so it lives in a `0600` file created by whichever process starts first: `hubtoken.go::ensureHubToken` is create-or-read (`O_EXCL`, re-read on `EEXIST`) rather than "the server writes it", because the process that wins `net.Listen` is not necessarily the one that gets there first. **There is no unauthenticated fallback** — if the token cannot be established the hub simply never starts and `GetInstances()` reports this process alone. Consequence: instances older than v0.16 and newer ones cannot see each other.

   Register payloads are validated (`uuid.Parse`, not this hub's own ID, not already registered) **before** they reach the client map, and the handler's cleanup deletes by pointer identity. Both matter for the same reason: a client stored in the map before validation, or evicted by a later registration, stays listed forever with nothing draining its 64-slot `sendCh`, so every `send()` silently hits the `default:` branch.

7. **AI** (`internal/ai/`): The Ollama-backed assistant agent loop, kept separate from the per-resource layers. `agent.go` runs the chat↔tool loop (`RunChat`); `registry.go`/`models.go` handle model discovery, capability detection, and pulls; `client.go` wraps the Ollama API client; `tools.go` defines the `Tool` type. The **tool registry** (the list of cluster actions the model may call) lives in `business/ai.go::aiTools()` — each tool's `Run` closure delegates to the same `business.GetPods`/`DeletePod`/`ApplyYaml`/etc. functions the UI uses, so the assistant is pinned to the active cluster the same way panels are. See "AI Assistant" below.

8. **TUI** (`internal/tui/`): A `tview`/`tcell` terminal UI that is an alternative front end to the **same `internal/business` functions** — it imports no Wails and adds no service endpoints. `Run(ctx, version)` (`run.go`) drives a `tview.Pages` stack (cluster screen → split workspace → yaml/logs/exec overlays). Most screens show one at a time, but the **workspace** (`menu.go::showWorkspace`) is split k9s-style: the resource menu (TreeView) on the left beside the generic list (`resourcelist.go::buildResource`) on the right — pods open by default, and the **left/right arrows move focus between the two panes** (`loadResource` swaps the right-pane body). `registry.go` is the data-driven core: each resource `view` maps via a `resourceDef` to its `business.GetX`/`GetXYaml`/`UpdateXYaml`/`DeleteX` functions (+ extra `rowAction`s like node cordon/drain) — add a resource by appending one entry. Logs use `business.StartLogStream` with a `QueueUpdateDraw` callback; exec uses `app.Suspend()` to hand the raw tty to `business.CreatePodExecSession` (tview has no embedded terminal emulator), disconnect with **Ctrl-]**. Keybindings (`keys.go`) are cross-platform-safe single letters (k9s-style), shown top-right by the status bar. See "TUI / CLI Mode" below.

9. **Shell transport** (`internal/controller/transport.go`, `transport_wails.go`, `rpcserver.go`): The controller is **shell-agnostic**. Everything Wails-specific (pushing events, native save dialogs) sits behind the `Transport` interface, so `functionBuilder.go` and `app.go` contain **no Wails imports** — `transport_wails.go` is the only file in the package that imports Wails. Business logic emits through `a.emit(event, data...)` and prompts through `a.saveFile(opts)` rather than calling `runtime.*` directly.

   `rpcserver.go` is the second implementation: a loopback HTTP+WebSocket server that exposes the same App over `POST /rpc/{method}` (a **reflection dispatcher** — no per-method routes) and `GET /events`. It deliberately mirrors Wails' promise semantics so the generated bindings work unchanged: a trailing Go `error` return rejects, whatever remains resolves. `main.go --serve` runs it headless, which lets the whole app be exercised in a plain Chromium tab. Security: ephemeral loopback port (never fixed — 34200 belongs to the IPC hub), a per-process token injected into `index.html` (not the URL, so cross-origin pages cannot read it), and an Origin check on both `/rpc` and the WS handshake.

   `shellchannel.go` is the third piece: a `GET /shell` WebSocket that a native shell's **main process** attaches to, so Go can ask it for a native save dialog (`SaveSnapshot`/`SaveReport` decide to prompt on the Go side). `Server.SaveFile` therefore has three branches — in-process `NativeDialog`, the attached shell channel, then a `~/Downloads` fallback for plain-browser mode. It goes to the main process rather than the renderer because the renderer may be reloading or crashed at exactly that moment, and because it means **no new exported `App` method** is needed (see the binding constraint below). Requests time out after 2 minutes and drop immediately if the shell disconnects.

   Two constraints worth knowing before editing this area:
   - **Wails binds every exported method of `App`** into the generated TypeScript. That is why `Bootstrap` is a package-level function and `start` is unexported — an exported method taking a `Transport` interface breaks binding generation.
   - The dispatcher wraps calls in a `recover`. Several business functions log a client-construction error and then dereference the nil client (e.g. `business/pod.go::GetPods`); without the recover such a panic aborts the connection and leaves the frontend on a promise that never settles.

10. **Electron shell** (`electron/`): A second shell that embeds Chromium instead of using the system webview, so Linux packages carry **no `libwebkit2gtk` dependency**. Wails is untouched and remains a first-class target — this is an additional shell, not a replacement. (Energy/CEF was evaluated and rejected: it compiles fine but swaps `libwebkit2gtk` for a `liblcl.so` + CEF runtime dependency, and its own window loop would have had to displace Wails.)

    `main.cjs` spawns the Go binary as a **sidecar** (`--serve --shell-channel`) and parses the URL and shell token from its stdout. It does **not** load that URL directly: the window loads a fixed `app://kube-inspector` origin, and a `protocol.handle` forwards those requests to the sidecar. This is not cosmetic — the sidecar binds an ephemeral port (a fixed one would clash between instances), and browser storage is keyed by **origin**, so loading `http://127.0.0.1:<random>` made every launch look like a brand new site and silently wiped all persisted UI state (theme, events, AI chat). Two consequences: the proxy forwards only `content-type`/`x-kube-ins-token` and buffers the response — passing the renderer's own headers through made Chromium reject the proxied module scripts with `net::ERR_UNEXPECTED` — and the event WebSocket cannot travel through a custom protocol, so `preload.cjs` hands the renderer the sidecar's real address via `__KUBE_INS_SHELL__.rpcUrl` and `originAllowed` in `rpcserver.go` accepts the `app://` origin for that one cross-origin connection. The Go binary *is* the application; this shell only supplies a window and the few things a page cannot do — adding a backend feature never touches `electron/`. `preload.cjs` fills in `window.__KUBE_INS_SHELL__`, the hook `wailsBridge.ts` already reads, so `TitleBar.tsx` works unmodified with `contextIsolation`/`sandbox` on.

    Lifecycle details that matter: `app.requestSingleInstanceLock()` is **deliberately not used** (multi-instance tab transfer via `internal/ipc` is a feature); shutdown goes `stdin.end()` → `SIGTERM` → `SIGKILL` after 3s; and `serve()` in `main.go` watches for **stdin EOF** so the sidecar cannot outlive an Electron process that was `SIGKILL`ed. That watchdog is skipped when stdin is a character device, so `kube-ins --serve` from a terminal or under systemd is unaffected.

    **Dev mode** is `make dev` — one command. `electron/dev.cjs` starts the Go backend (`go run -tags kubeinsdev`), Vite and Electron, waits for each to print its address, and tears all three down together on Ctrl-C (POSIX: `detached` + `kill(-pid)`, because `go run` execs the real binary as a child and signalling only `go run` leaves the port held). `make electron-dev-go` / `-vite` / `electron-dev` still exist for debugging one piece alone, and `make dev-wails` runs the old Wails/webview loop. `make bindings` generates the gitignored `frontend/wailsjs` when missing — `wails dev` used to do that implicitly.

    Three relaxations are gated behind the `kubeinsdev` build tag (`dev_on.go` / `dev_off.go`), which appears in no `build-*`/`pkg-*` target: the port is pinned (`KUBE_INS_DEV_PORT`, default 34567) so `vite.config.ts` can proxy to it; the token check is skipped, because Vite serves `index.html` itself and cannot receive the injected token; and `devOriginAllowed` accepts loopback http origins. That third one is **not optional** — the page is served by Vite, so requests carry `Origin: http://localhost:5173`, and the proxy's `changeOrigin` does not help because it rewrites *Host*, not *Origin*. Without it every RPC call and the `/events` socket from a Vite-served page 403s. The loopback bind still applies in dev, so nothing off the machine can reach the server whatever Origin it claims.

    Under `make dev` Electron **does not spawn a sidecar**: `KUBE_INS_DEV_RPC` tells `main.cjs` to attach to the one `dev.cjs` already started (otherwise dev ran two backends, the second being a stale release binary from `build/bin/`). It also omits the `--kube-ins-rpc-url` argument in that mode, so `wailsBridge.ts` opens `/events` at `location.host` and lets Vite proxy it — pointing the socket straight at the Go port would fail the Origin check for the *page's* origin.

    Packaging is `make pkg-electron-{linux,windows,mac,all}`, with the Go binary as an `extraResource` and the frontend *not* duplicated (the sidecar embeds and serves it). The Linux package is named `kube-inspector-electron` so it cannot overwrite nfpm's `/usr/local/bin/kube-inspector`. macOS is per-arch on purpose — a universal dmg would embed two ~262MB Go binaries. Note `make electron-frontend` still shells out to `wails generate module`, because `npm run build` runs `tsc` against the gitignored `frontend/wailsjs` types.

    **Electron is the shipped GUI. Wails is development-only and is no longer packaged** — `make dev` / `make build` still drive it for debugging against the system webview, but every `pkg-*` target and every CI release job produces the Electron build.

    **The split is: electron-builder *builds*, nfpm *packages*.** on Linux electron-builder produces only the app tree (`dir`), and deb/rpm come from nfpm (`build/nfpm.yaml` — one config, package name `kube-inspector`, installed to `/opt/kube-inspector` with a `/usr/bin` symlink). electron-builder's own deb/rpm targets shell out to `dpkg`/`fakeroot`/`rpmbuild`, which do not exist on Fedora or any non-Debian machine; nfpm is pure Go and has no such dependency.

    Three consequences worth knowing before touching this:
    - electron-builder's output goes to **`build/electron/`, not `dist/`** — it holds `linux-unpacked/` (~523MB of intermediate tree), and CI does `aws s3 sync dist/` to the public bucket. **`dist/` must contain shippable artifacts only**; each `pkg-*` target copies just its finished artifact across.
    - `chrome-sandbox` must be **setuid root** or the app aborts at startup ("SUID sandbox helper binary … not configured correctly"). nfpm refuses a second contents entry for a path its `tree` already supplied, so this is done in `build/electron-postinstall.sh`.
    - `artifactName` is overridden because `productName` contains a space, which would be percent-encoded in the download URL.

    The packages declare **no dependencies at all** — dropping `libwebkit2gtk` is the whole point. That also collapsed the release matrix: there is no longer a per-distro build (the old `build-linux-24` CI job existed solely for the webkit2gtk 4.0/4.1 split), and `build/dmg-builder/` is gone because electron-builder makes the dmg. Sizes: ~180MB deb/rpm, 523MB installed.

**Key Patterns**:
- Business functions call repository constructors each time (not singletons).
- All resource-fetching business functions take `clusterName string` as their first parameter and call `NewK8sClientForCluster(clusterName)` so that each panel is pinned to the cluster it was opened with. The controller passes `clusterName` through from the frontend call.
- `clusterName` flows: Dockview panel params → frontend component → Wails call → controller function → business function → `NewK8sClientForCluster(clusterName)` → service function.

### Frontend Architecture (React)

```
frontend/src/
├── main.tsx (Vite entry point, routes and global setup)
├── pages/
│   └── main/appmain.tsx (main app layout)
├── components/
│   ├── workspace/
│   │   ├── DockviewContainer.tsx (panel manager, routes panel IDs to components)
│   │   ├── FloatableTab.tsx (custom Dockview tab header — drag out or right-click to move a panel)
│   │   ├── TabInstanceBridge.tsx (zero-render bridge: wires InstanceContext → TabContext)
│   │   ├── ViewPanel.tsx, YamlEditorPanel.tsx, ApplyYamlPanel.tsx, etc.
│   ├── transfer/
│   │   └── InstancePickerMenu.tsx (portal context menu: undock / another window / another instance)
│   ├── pod/, deployment/, networkpolicy/ (resource-specific views — thin configs over ResourceListView)
│   ├── shared/
│   │   └── ResourceListView.tsx (generic list shell: toolbar + DataTable + delete dialog + toast)
│   ├── terminal/ (xterm.js wrapper)
│   ├── logs/ (react-logviewer wrapper)
│   ├── cluster/ (cluster selection UI)
│   └── menu/ (sidebar navigation)
├── contexts/
│   ├── ClusterContext.tsx (manages cluster list, active cluster, connection health checks)
│   ├── TabContext.tsx (manages dockview panel lifecycle and routing)
│   └── InstanceContext.tsx (multi-instance discovery, panel transfer via IPC hub)
└── lib/ (Monaco editor theme, utilities, useResourceList.ts, usePanelActive.ts, wailsBridge.ts)
```

**Shared resource-list scaffold**: Almost every resource view (`pod`, `deployment`, `service`, `role`, …, ~21 of them) is a thin config over two shared pieces instead of a hand-copied DataTable clone:
- `lib/useResourceList.ts` — a generic hook owning the fetch/poll loop, filter/selection state, the multi-select delete flow (with toasts), and `usePanelActive`-based visibility gating (polling pauses while the Dockview tab is backgrounded). Effect deps are `clusterName`/`pollInterval`/active, so it does not rely on remount-per-tab to pick up cluster changes.
- `components/shared/ResourceListView.tsx` — the presentational shell (toolbar, `DataTable`, delete `Dialog`, `Toast`) that calls `useResourceList` internally and takes a `columns` render-prop (`{ items, buildInOptions }`). Pass `deleter`/`deleteLabel` for deletable resources, `dataKey` when names collide across namespaces.
When adding a resource, follow this pattern (see "Adding a New Resource Type"). Only genuinely bespoke layouts stay hand-written: `node/main.tsx` (cards + cordon/drain), `resourcequota/main.tsx` (usage bars over `GetNamespaces`), `events/main.tsx` (zustand store), `monitoring/main.tsx` (dashboard).

**State Management**:
- **ClusterContext**: Loaded on app startup, persists active cluster selection. Polls `CheckClusterConnection()` every 20 seconds.
- **TabContext**: Manages Dockview API for opening/closing panels. Each resource type (pods, deployments, etc.) opens as a panel.
- **InstanceContext**: Polls `GetInstances()` every 3 seconds. Listens for `tab:received` Wails event and calls the registered `onPanelReceived` callback. `TabInstanceBridge` wires this to `TabContext.openReceivedPanel`.
- **Zustand stores** (`frontend/src/stores/`): React Context holds app-wide state; per-tab view state that must survive a tab close/reopen uses Zustand instead. `eventsStore.ts` is the reference example — a `persist`-middleware store keyed by `events:${clusterName}` so each cluster's Events tab keeps its rows, filters, and toggles across app restarts (persisted to the Wails webview's localStorage). New persistent per-tab state should follow this keyed-by-panel-id pattern rather than living in component `useState`. `metricsStore.ts` is the non-persisted counterpart — a plain (no `persist`) store, also keyed by cluster, holding the Monitoring dashboard's rolling time-series in memory only (ephemeral data that should reset on restart). `aiChatStore.ts` (persisted) holds the assistant's open/host/model/messages; `themeStore.ts` (persisted) holds the selected theme.

**UI Framework**:
- **Dockview** (v6): Resizable, draggable panel layout. Components are registered in `DockviewContainer.tsx` and instantiated by panel type string.
- **PrimeReact**: DataTable, Dialogs, Tags, Buttons, etc. Built on the `lara-dark-cyan` theme, but heavily re-skinned by `frontend/src/theme-monolith.css` — a single global stylesheet imported last in `main.tsx` that overrides `.p-*` selectors using the app's `--app/--panel/--ink/--teal/...` CSS variables (defined in its `:root`). **Style new PrimeReact components by adding global `.p-*` overrides to this file rather than per-component CSS**; match the Dockview tab look via the `.dockview-theme-monolith` rules in the same file. One trap lives there already: PrimeReact's `Button` always renders a zero-width `.p-button-label` (`&nbsp;`) even when icon-only, and a zero-width flex item still consumes `.p-button`'s `gap` — so every icon-only button drew its glyph `gap/2` left of centre until the `gap: 0` on the two `.p-button-icon-only` rules. Invisible on a wide button, obvious the moment a hover background is drawn around a small one. One trap lives there already: PrimeReact's `Button` always renders a zero-width `.p-button-label` (`&nbsp;`) even when icon-only, and a zero-width flex item still consumes `.p-button`'s `gap` — so every icon-only button drew its glyph `gap/2` left of centre until the `gap: 0` on the two `.p-button-icon-only` rules. It is invisible on a wide button and obvious as soon as a hover background is drawn around a small one.
- **Themes**: `theme-monolith.css` also defines alternate palettes (`last-samurai`, `god-of-war`) as `html[data-theme="..."]` blocks that only re-bind the same `--app/--panel/--ink/...` variables — so every `.p-*` override automatically re-skins. The default `monolith` palette lives in bare `:root` (no attribute). `stores/themeStore.ts` (Zustand + `persist`, localStorage key `kube-ins-theme`) toggles the `data-theme` attribute on `<html>` and applies the persisted theme synchronously at module load to avoid a flash. **To add a theme, add an entry to `THEMES` in the store and an `html[data-theme="id"]` variable block in the CSS — do not write per-theme component rules.**
- **MUI** (`@mui/material`): Used alongside PrimeReact for some UI elements.
- **Monaco Editor** (via `@monaco-editor/react`): YAML editing with schema-driven completion, hover and validation. The Kubernetes JSON schema is a **Go-embedded asset** — `business/schema.go` `//go:embed`s `internal/business/assets/k8s-schema.json` and serves it over Wails as `App.GetK8sSchema()` (no external schema fetch). Note the consumer is **`lib/k8sYamlIntellisense.ts`, hand-written against the Monaco API, not `monaco-yaml`** — that package is still in `package.json` but is imported nowhere, because the webview has no working web workers and monaco-yaml is worker-based (hence the `NoopWorker` stub).

  Two setup constraints, both from S14f: Monaco's wiring lives in **`lib/monacoBootstrap.ts`** and is imported by each editor panel for its side effects — never from `main.tsx`, since an eager `import 'monaco-editor'` there puts all ~3.6MB of Monaco in the entry chunk that every launch waits for. And `vite.config.ts` **aliases the bare `monaco-editor` specifier to `esm/vs/editor/edcore.main.js`** (the editor plus every editor contribution, minus the css/html/json/TypeScript language services and the ~80 basic-language grammars); `monacoBootstrap` adds back the one grammar the app needs. Import Monaco through the bare specifier so the alias applies — a deep `monaco-editor/esm/...` import bypasses it and silently pulls the full entry back in.
- **xterm.js**: Terminal emulation.
- **Onboarding tour**: A first-run guided tour via the `nextstepjs` library — steps are defined in `lib/tourSteps.ts` (`appTour`), rendered with the custom `components/tour/TourCard.tsx`, and mounted in `pages/main/appmain.tsx`. Steps anchor to `#tour-*` element IDs (e.g. `#tour-cluster-area`, `#tour-sidebar`, `#tour-workspace`) scattered across the layout components.

**Registered Dockview panel types** (in `DockviewContainer.tsx`):
`view`, `yamlEditor`, `terminal`, `applyYaml`, `logViewer`, `policyViewer`, `clusterResource`, `configMapEditor`, `secretEditor`, `podExec`, `roleEditor`, `roleBindingEditor`, `objectYaml`, `portforwards`

`FloatableTab` is registered as `defaultTabComponent` — it replaces the default Dockview tab header for all panels. A tab can be **dragged out of the window** or right-clicked for `InstancePickerMenu` (undock / another window of this process / another instance). Panels whose component type is `terminal` or `podExec` are non-transferable. See "Moving panels between windows and instances" below.

`GroupActions` is registered as `leftHeaderActionsComponent` — the "+" that opens a terminal or a blank YAML editor, the same pair the title bar's Open menu offers. Three things about it are not obvious:
- **`left`, not `right`.** dockview lays the header out as `preActions → tabs → leftActions → void strip → rightActions`, so the "left" slot is the one immediately *after* the last tab (VS Code's "+" position); `right` pins it to the far edge of the bar.
- **It activates its own group before opening.** `TabContext.openTerminal`/`openApplyYaml` call `api.addPanel` with no position, so the panel lands in whichever group is *active* — the same assumption the void-container double-click relies on. Without the `api.setActive()` a "+" in a split layout opens into the other pane.
- **The new panel is pinned to the nav panel's `ClusterBar` selection** (`activeCluster`), not to the cluster of the tab it was opened beside — these two panels are what a user reaches for to act on "the cluster I am working on". `activePanel.params.clusterName` is only a fallback, for the frames before `ClusterContext` has loaded its selection.
PrimeReact's `SpeedDial` is a floating-action-button component, so `theme-monolith.css` has to undo its `position: absolute` root (the anchoring moves to `.dv-group-actions`, whose `top: 100%` is the bottom of the *bar* rather than of the 22px button) and shrink the 4rem/3rem buttons. Note `direction="right"` is set for a horizontal row that the stylesheet then drops below the button and centres — **PrimeReact writes `flex-direction` as an inline style**, so the axis cannot be chosen from CSS; pick it with `direction` and never re-declare it in the stylesheet. The actions take that cluster's colour through a `--dial-accent` custom property set inline by `GroupActions` (the same idiom as `FloatableTab`'s `--tab-accent`), carried by the **border and a 14% fill only** — the icon stays `--ink`, so a hex the user picked freely from the colour picker never has to work as a glyph colour on a dark panel.

**Event Streaming**: The frontend listens to Wails events for real-time updates:
- `terminal:output:${id}` for terminal output
- `log:output:${sessionId}` for pod logs
- `tab:received` for incoming panel transfers from other instances (payload: `SerializedPanel`)
- `portforward:update` for port-forward status changes (one broadcast channel, payload: `PortForwardInfo`)

These are emitted from backend functions via `a.emit()` in the controller (which reaches Wails' `runtime.EventsEmit()` or the RPC server's WebSocket, depending on the shell — see "Shell transport" above).

**Binding globals**: every file under `frontend/wailsjs` is a thin wrapper over two globals — `window.go.controller_app.App.<Method>()` and `window.runtime.<Fn>()`. Wails injects them; under a non-Wails shell `lib/wailsBridge.ts` installs equivalents backed by the RPC server (a `Proxy` for the ~150 methods, a reconnecting WebSocket for events). It is imported **first** in `main.tsx` and no-ops when Wails is present. Because it supplies the globals rather than replacing modules, all ~50 call sites and the generated `App.js`/`runtime.js` stay untouched — do not add a per-call abstraction layer on top. Note `EventsOn`/`EventsOnce` both delegate to `window.runtime.EventsOnMultiple`, so that is the method a shim must implement.

### Per-tab Cluster Isolation

Each panel is frozen to the cluster it was opened with:
- **Panel ID scheme**: View panels use `${view}:${clusterName}` (e.g., `pods:my-cluster`). Sub-panels use the cluster name in their ID too (e.g., `yaml:pod:my-cluster:ns/name`).
- **Tab title**: `${label} • ${clusterName}` (e.g., `Pods • my-cluster`).
- **`clusterName` stored in Dockview `params`**: All panel components destructure `clusterName` from `params` and pass it to every API call. Changing the global cluster via `ClusterBar` does not affect existing open tabs.
- **`referencePanel`**: When opening sub-panels from a list view, `referencePanel` is the view panel ID (`pods:my-cluster`). `TabContext.openYamlPanel` extracts the view key via `def.referencePanel.split(':')[0]` to build the title.

### AI Assistant (Ollama)

The assistant is a tool-calling agent over a **local Ollama** server (default `http://localhost:11434`; the frontend gates everything on `AiAvailable(host)`). It is not part of the per-resource triple convention.

- **Agent loop** (`internal/ai/agent.go::RunChat`): a non-streaming-per-turn chat↔tool loop, capped at `maxIterations` (8) round-trips. Each turn it inspects the whole assistant message, runs any tool calls, feeds results back, and repeats until the model replies with no tool calls (the final answer).
- **Two tool-calling modes**: `business/ai.go` picks the mode from `ai.SupportsTools(host, model)` (queries the model's `tools` capability via Ollama `Show`). Native-capable models use Ollama's `tool_calls` field; others get the tools described in the system prompt (`ai.ToolSpec`) and their JSON-text replies are parsed by `parseTextToolCalls` — **raw tool-call JSON is never surfaced to the user**. Tool results go back as a `tool`-role message (native) or a `TOOL RESULT (...)` user message (prompt mode).
- **Tool registry** (`business/ai.go::aiTools()`): the single source of truth for what the model can do. Read tools (`list_pods`, `list_deployments`, `list_events`, `get_*_yaml`, `get_pod_logs`) run immediately; **mutating** tools (`delete_pod`, `delete_deployment`, `apply_yaml`, `update_deployment_yaml`) carry `Mutating: true` and are gated behind user confirmation in the agent loop. Each `Run` closure delegates to the existing `business.*` functions, so tools are pinned to the active `clusterName`. Add a tool by appending an `ai.Tool` here — no controller/binding change needed.
- **Controller streaming** (`functionBuilder.go`, "AI Assistant" section): `StartAiChat(sessionId, …)` runs the loop in a goroutine and pushes everything to the frontend as Wails events suffixed with the session ID: `ai:token:${id}` (assistant prose), `ai:tool:${id}` (a `ToolEvent` activity line), `ai:confirm:${id}` (a mutating-tool approval request — the backend blocks on a channel until the frontend calls the confirm method), `ai:done:${id}`, `ai:error:${id}`. Model downloads stream `ai:pull` / `ai:pull-done` / `ai:pull-error`. Sessions are tracked in `aiSessions` so a new turn or a stop cancels the previous context.
- **Model management**: `ModelCatalog` merges Ollama's experimental recommendations + a `curatedModels` base list + locally-installed models; `ModelTags` hits the Ollama OCI registry (`registry.ollama.ai`) directly — including the anonymous bearer-token handshake — to list size/quant variants. `PullAiModel` streams download progress.

### Cluster Configuration

Clusters are stored as YAML files in `~/.kube-ins/` with a `.yaml` extension (e.g., `my-cluster.yaml`). The active cluster is tracked in `~/.kube-ins/.active`. When a cluster is selected via the UI:
1. Backend calls `SetActiveCluster(name)` which calls `SetActiveKubeconfig(path)`.
2. This updates the global active path used by `NewK8sClient()` / `NewK8sClientAndConfig()` / `NewMetricsClient()`.
3. Newly opened panels pass the selected cluster name through `clusterName` and call `NewK8sClientForCluster(clusterName)` directly — so the global path matters only for the cluster-management functions (listing clusters, checking connections, etc.).

### Logging & Diagnostics

Every process writes **logstash `json_event` v1** lines to **one shared daily file**,
`~/.kube-ins/logs/kube-inspector-<local-date>.log` (`0600`, directory `0700`): the GUI
backend, the TUI, *and* the Electron main process, told apart by `fields.role`
(`backend`/`cli`/`shell`) and `fields.pid`. One file rather than three because the failure
this exists to diagnose — the sidecar dying before it prints a URL — can only be read by
interleaving the shell's lines with the backend's by timestamp.

`internal/logging` is a **leaf package that imports only the standard library**;
`safego → logging` is the one intra-project edge pointing at it, and `logging → anything`
is forbidden (a cycle back through safego). Four rules are load-bearing:

- **Nothing ever writes to `os.Stdout`.** Stdout is the Electron protocol pipe carrying
  the RPC URL and shell token (`main.go:42,51`); one stray byte hangs the handshake for
  30s. The optional dev tee goes to stderr and `Init` forces it **off for `RoleCLI`**,
  because tview owns the screen.
- **`slog.SetDefault` is never called** — not in `init()`, not in `Init()`. That is the
  exact global Trivy's `pkg/log` `init()` takes over, which since Go 1.21 also swallows
  the standard `log` package. The package owns its own `*slog.Logger`; `main.go` and
  `cmd/tui/main.go` do `log.SetOutput(logging.StdlibWriter())` + `log.SetFlags(0)` to pull
  third-party `log.Print` output in without joining a fight over a process-global.
- **Call `logging.With(name)` at the log site, never in a package-level var.** A package
  var binds before `Init` runs and captures the discard handler permanently — silent, and
  the easiest way to kill a whole file's logging.
- **`L()` already has the `fields` group open**, so `L().With("logger", x)` produces
  `fields.logger`. `With(name)` is the only way to set the top-level logger name.

Mechanics worth knowing before editing: records are written with `O_APPEND` and **exactly
one `Write` per record** (that, not a lock, is what makes cross-process appending safe —
`slog.commonHandler` already guarantees one `w.Write` per `Handle`, so never wrap the
writer in a `bufio.Writer`); a record over 32 KiB is replaced by a valid truncation
notice; day rollover is a **deadline compare on each write, not a ticker** (a ticker does
not survive suspend); retention is **7 days with no size cap**, coordinated by a
`.retention` marker plus an `O_EXCL` `.retention.lock`, matching on a strict
`^kube-inspector-\d{4}-\d{2}-\d{2}\.log$` so nothing else in the directory can be
deleted. `electron/logfile.cjs` mirrors all of this in ~150 lines of dependency-free Node
and **must stay in sync** (local date in the name, UTC `@timestamp`, same sweep). It also
scrubs `kube-ins shell token <hex>` out of every line, because `rememberLog` is fed the
raw sidecar stdout and the export is a file users email.

**Diagnostics** is a singleton Dockview panel (`components/diagnostics/`, panel id
`diagnostics`, deliberately outside the `${view}:${clusterName}` scheme — it describes the
process, not a cluster) with Overview / Logs / Export tabs, opened from Help ▸ Diagnostics
and the About modal. Backend: `business/diagnostics.go` (report, concurrent health checks
via `safego.Go` writing into a pre-sized slice so row order is stable, log tail, zip
export) + `business/redact.go`. **Redaction order is mandatory** — `$HOME` → cluster names
→ secrets → base64 → URLs — and each step's ordering hazard is documented at the function;
40-char hex (git commits) survives while 64-char hex does not, because this app's RPC and
hub tokens are exactly that shape. `GetDiagnostics` leaves `Shell` and `Hub` empty:
`business` must not import `internal/ipc`, and only the controller knows its `Transport`.

`Transport` gained **`OpenLogFolder() error` (no arguments)** and `Kind() string`. The
zero-argument signature is the point: an `OpenPath(string)` would hand the renderer an
arbitrary-path-to-OS primitive, so each shell computes `~/.kube-ins/logs` itself. The
shell channel is now a generic `shellCall` over `saveFile` / `openLogFolder` /
`diagnostics`, and `electron/main.cjs` answers an unknown `req.type` with an error instead
of dropping it (dropping made a mismatched pair wait out the 2-minute timeout).

### TUI / CLI Mode

The `tview` terminal UI (`internal/tui/`) is an alternative front end that drives the **same `internal/business` functions** the GUI uses (no new service endpoints). It ships two ways:

- **Standalone CLI** — `cmd/tui/main.go` calls `tui.Run(...)` and imports **no Wails**, so `go build ./cmd/tui` produces a webview-free binary (output name `kube-inspector-cli`) with **no `libwebkit2gtk`/`libgtk` dependency**. Built/packaged by `make build-tui*` and `make pkg-tui-deb`/`pkg-tui-rpm` (separate `build/nfpm-cli.yaml`, no webkit `depends:`). Keep `internal/tui` + `cmd/tui` Wails-free — `grep -rn "wailsapp/wails" internal/tui cmd/tui` must stay empty.
- **CLI Mode inside the GUI** — the root `main.go` checks for a `--tui` flag *before* bootstrapping Wails; if present it runs `tui.Run(...)` and returns. The **Open ▸ CLI Mode** title-bar action mounts `CliModeOverlay.tsx` (fullscreen xterm.js) over the dockview/menu (which stay mounted underneath so their state survives). The backend `CreateCliModeSession` (`services/cliModeServices.go` → `business/cliMode.go` → controller) re-execs `os.Executable() --tui` in a **pty** (mirroring `terminalServices.go`), streaming `climode:output:{id}` and, on pty close, `climode:exit:{id}` so the overlay auto-restores the GUI.

**Patterns/caveats:** `registry.go::buildRegistry()` is the single place that maps each `view` to its `business.*` functions — add a resource by appending one `resourceDef`. Streaming reuses the GUI's callback functions directly (`StartLogStream`, `CreatePodExecSession`) — only the *controller* layer is Wails-bound. Importing `internal/business` transitively pulls Trivy → the TUI binary is large and **must** build with `GOEXPERIMENT=jsonv2`. The GUI CLI-mode pty relies on `creack/pty` (limited on Windows). Both the TUI and GUI read/write the shared `~/.kube-ins/.active`, so changing the active cluster in CLI mode persists for the GUI.

## Build & Run

> **`frontend/dist/.gitkeep` must stay tracked.** `main.go` embeds `frontend/dist`, and `wails generate module` parses that source to produce the TypeScript bindings — so on a fresh checkout the parse fails with `pattern all:frontend/dist: no matching files found` before `npm run build` (which needs those bindings to typecheck) has ever created the directory. The placeholder breaks that cycle. Vite empties the directory on each build, so `make electron-frontend` recreates it; keep it **empty** so builds never dirty the working tree. Note `/dist` in `.gitignore` is anchored on purpose: an unanchored `dist` also matches `frontend/dist`, and git cannot re-include a file whose parent directory is excluded.

> **`GOEXPERIMENT=jsonv2` is required to compile.** The Trivy scanner library pulls in `encoding/json/v2`, which is gated behind the `jsonv2` GOEXPERIMENT on Go 1.26 (the project is on `go 1.26.3`). The `Makefile` exports it for every target (`export GOEXPERIMENT := jsonv2`) and CI sets it in the workflow `env:`. If you run bare `go build`/`go test`/`wails` outside `make`, prefix with `GOEXPERIMENT=jsonv2` or the build fails with `build constraints exclude all Go files in .../encoding/json/v2`.

### Development

Use `make dev` rather than bare `wails dev` — it injects the app version from the latest git tag via ldflags:

```bash
make dev
```

This starts:
- Vite dev server on `localhost:5173` (frontend hot reload)
- Wails dev server on `localhost:34115` (Go methods accessible from browser devtools)
- Wails app window

**Frontend only** (if Go backend is unchanged):
```bash
cd frontend
npm run dev
```

### Building

```bash
make build           # current platform
make build-linux     # linux/amd64
make build-windows   # windows/amd64 (with NSIS installer)
make build-mac       # darwin/universal

make build-tui          # standalone terminal UI (current platform, webview-free)
make build-tui-linux    # kube-inspector-cli linux/amd64
make build-tui-windows  # kube-inspector-cli windows/amd64
make build-tui-mac      # kube-inspector-cli darwin/universal
```

Output goes to `build/bin/`.

The Makefile injects the version from git tags: `git describe --tags --abbrev=0` → `kube-ins/internal/business.appVersion`.

**Packaging** (requires `nfpm` on PATH):
```bash
make pkg-deb     # .deb package
make pkg-rpm     # .rpm package
make pkg-mac     # .dmg (runs build/dmg-builder/build.js)
make pkg-tui-deb # kube-inspector-cli .deb (no webkit dependency)
make pkg-tui-rpm # kube-inspector-cli .rpm (no webkit dependency)
make pkg-all     # all platforms (incl. the TUI deb/rpm)
```

Packages go to `./dist/`.

**Frontend build only**:
```bash
cd frontend
npm run build
```

### Documentation site (MkDocs)

The marketing/docs site lives in `docs/` (MkDocs Material, config `mkdocs.yml`, custom theme overrides in `overrides/` + `docs/stylesheets/extra.css`). Build/preview with the Makefile (needs `pip install "mkdocs-material[imaging]"` — the `imaging` extra + system Cairo/Pango libs are required by the `social` plugin that generates the `og:image`/`twitter:image` cards; the plugin is gated `enabled: !ENV [CI, false]` so a bare local `mkdocs serve` without those libs still works):
```bash
make docs-serve   # live-reload preview at http://127.0.0.1:8000
make docs-build   # build to ./site (gitignored), --strict
```
`docs-build` first runs `docs-downloads`, which substitutes the git tag into the (git-ignored, generated) `docs/downloads.md` and writes `docs/version.json` (consumed by the in-app update check). On a git **tag** push, the `deploy-docs` job in `.github/workflows/build.yml` builds the site and `aws s3 sync`s it to the Cloudflare R2 bucket root, while `upload-r2` publishes the release artifacts under `/dist` on the same bucket (served at `kubeinspector.com`). Both R2 jobs need the `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets and the `R2_BUCKET` variable.

**SEO / LLM discoverability**: the build emits several discovery files at the site root. `sitemap.xml` is auto-generated by MkDocs from `site_url` + the nav (every page is in the nav, so it is complete — nothing to hand-edit). `docs/robots.txt` is a static file (copied verbatim) that allows all crawlers, explicitly opts **in** the AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …), and points to the sitemap. `llms.txt` (compact link index, grouped by nav section) and `llms-full.txt` (the whole docs corpus as one Markdown file) are **generated by `mkdocs_hooks.py`** (`on_nav` captures the nav; `on_post_build` writes both into `site/`) — they stay in sync with the docs automatically. Every page carries a unique `description:` front-matter (feeds `<meta name="description">`, the social cards, and the `llms.txt` bullets); `overrides/main.html` injects `SoftwareApplication` + `WebSite` JSON-LD. **When adding/removing/renaming a doc page, nothing extra is needed** — sitemap, llms.txt and llms-full.txt regenerate from the nav; just give the new page a `description:`.

## Key Dependencies

**Backend (Go)**:
- `wailsapp/wails/v2`: Desktop app framework, handles Go-to-JS RPC and event emission
- `k8s.io/client-go`: Kubernetes API client
- `k8s.io/metrics`: Metrics API client for node/pod resource usage
- `k8s.io/apimachinery`: Kubernetes data types
- `creack/pty`: Pseudo-terminal for terminal sessions
- `sigs.k8s.io/yaml`: YAML marshaling
- `gorilla/websocket`: WebSocket server/client used by the IPC hub
- `google/uuid`: Unique instance IDs for the IPC hub
- `github.com/aquasecurity/trivy`: Vulnerability scanner, imported as a library (pulls in `encoding/json/v2` → needs `GOEXPERIMENT=jsonv2`)
- `golang.org/x/mod/semver`: Semantic-version compare for the in-app update check
- `github.com/ollama/ollama`: Ollama API client for the local-LLM AI assistant (`internal/ai/`)

**Frontend**:
- `react`, `react-dom`, `react-router-dom`: Core framework
- `primereact`, `@mui/material`: Component libraries (both are used)
- `dockview`: Panel layout manager
- `@monaco-editor/react`, `monaco-editor`: YAML editor (schema intelligence is hand-written in `lib/k8sYamlIntellisense.ts`; `monaco-yaml` is a leftover dependency that nothing imports)
- `@xterm/xterm`: Terminal emulation
- `@melloware/react-logviewer`: Log streaming viewer
- `reactflow`: Cluster graph visualization
- `chart.js`: Charts (node metrics, monitoring trends) — used via PrimeReact's `Chart` wrapper
- `zustand`: Per-tab state stores (`stores/`, see Zustand note above)
- `html-to-image`: Renders a panel to PNG for the monitoring "Take snapshot" feature
- `nextstepjs`: First-run guided onboarding tour (steps in `lib/tourSteps.ts`, custom card `components/tour/TourCard.tsx`)

## Common Tasks

### Adding a New Resource Type (e.g., Services)

1. **Create model** (`internal/models/serviceInfo.go`):
   ```go
   package models
   type ServiceInfo struct {
       Name      string
       Namespace string
       // ... other fields
   }
   ```

2. **Add service layer** (`internal/services/serviceServices.go`):
   ```go
   func GetServices(namespace string, client *kubernetes.Clientset) ([]models.ServiceInfo, error) {
       // Use client.CoreV1().Services(namespace).List()
   }
   ```

3. **Add business layer** (`internal/business/service.go`):
   ```go
   func GetServices(clusterName string) []models.ServiceInfo {
       client, _ := repository.NewK8sClientForCluster(clusterName)
       return services.GetServices("", client)
   }
   ```

4. **Expose in controller** (`internal/controller/functionBuilder.go`):
   ```go
   func (a *App) GetServices(clusterName string) []models.ServiceInfo {
       return business.GetServices(clusterName)
   }
   ```

5. **Create frontend component** (`frontend/src/components/service/main.tsx`):
   - `export default function ServiceListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi })`
   - **Build it on `ResourceListView` (`components/shared/ResourceListView.tsx`) — do not hand-roll the DataTable/fetch/poll/delete/toast scaffold.** Render `<ResourceListView<models.ServiceInfo> fetcher={GetServices} createFrom={models.ServiceInfo.createFrom} deleter={DeleteService} .../>` and provide the `columns` render-prop (which receives `{ items, buildInOptions }` — use `buildInOptions('namespace')` etc. for `IN`-filter `MultiSelect` options). `ResourceListView` internally calls `useResourceList` (`lib/useResourceList.ts`), which owns the fetch/poll loop, `usePanelActive` visibility gating, and the multi-select delete flow. Pass `deleter`/`deleteLabel` only for deletable resources; omit for read-only ones. Use `dataKey` when names collide across namespaces (see `configmap/main.tsx`, keyed by a synthetic `_uid`).
   - Pass `clusterName` to all `openYamlPanel` / `openLogPanel` calls (via `onRowDoubleClick` and column action bodies) and include it in `referencePanel: \`services:${clusterName}\``
   - **Thread `api`**: `ViewPanel.tsx` must pass `api={api}` to the component so `usePanelActive` can pause polling while the tab is backgrounded.
   - Only resources with a genuinely different layout stay hand-written (e.g. `node/main.tsx` cards, `resourcequota/main.tsx` usage bars, `events/main.tsx` zustand store, `monitoring/main.tsx` dashboard). Everything else that is "a filterable table of a list endpoint" should use `ResourceListView`.

6. **Register in Dockview** (`frontend/src/components/workspace/DockviewContainer.tsx`):
   ```js
   const components = {
       // ...
       services: ServiceComponent,
   };
   ```

7. **Add menu item** (`frontend/src/components/menu/menuItems.tsx`):
   - Add to appropriate category (Workloads, Discovery, etc.)

### Debugging Wails Events

The frontend listens to Wails events. To debug:
```javascript
// In browser console
window.runtime.EventsOn('terminal:output:sessionId', (data) => console.log(data));
```

Backend emits via:
```go
runtime.EventsEmit(a.ctx, "event:name", payload)
```

## TypeScript & Wails Bindings

Wails auto-generates TypeScript definitions from Go structs and exposed methods. Located in `frontend/wailsjs/go/`:
- `controller_app/App.ts`: Generated from `internal/controller/functionBuilder.go`
- `models/`: Generated from `internal/models/`

After modifying Go methods or models, regenerate bindings:
```bash
wails generate bindings
```

## Testing

Go unit tests exist only for the self-updater (`internal/services/selfUpdateServices_test.go`, `internal/business/selfUpdate_test.go`) — that path downloads a package and hands it to the package manager as root, so the download, checksum-verification, cancellation and asset-resolution logic is covered. Both are hermetic (`httptest`, no network) and never invoke an installer. The rest of the backend is covered by a Selenium + pytest **end-to-end suite** in `e2e_tests/` (`test_main_flow.py`, `test_navigation.py`, `test_panels.py`, `test_yaml_crud.py`). It drives the live Wails dev server via Chrome:

```bash
make dev                 # in one terminal (serves http://localhost:34115)
make test-e2e            # in another: installs deps, runs pytest, emits report.html
E2E_HEADLESS=1 make test-e2e   # headless (CI uses xvfb)
```

The CI `e2e` job spins up an ephemeral `kind` cluster, writes its kubeconfig to `~/.kube-ins/ci.yaml`, sets `.active` to `ci`, then runs the suite. Ad-hoc Go tests still follow conventions (`GOEXPERIMENT=jsonv2 go test ./...`); note any test touching the Trivy scanner downloads the vulnerability DB and needs network.

## Code Conventions

1. **Package names**: kebab-case in imports, but use aliases (`controller_app`, `services_k8sclient`)
2. **Error handling**: Business layer logs errors with `fmt.Println()`, returns them as second return value
3. **Concurrency**: Terminal and log streaming use callback functions emitted via Wails events. Start goroutines with `safego.Go`, never `go func()` — see "Known Patterns" below
4. **State**: Cluster selection is the only persistent app state (file-based in `~/.kube-ins/`)

## Known Patterns

- **Callback-based streaming**: Terminal input/output and log streaming use callback functions passed from controller to business layer, which emit results via `runtime.EventsEmit()`
- **Every goroutine goes through `internal/safego`**: `safego.Go("pkg.thing", func(){...})` recovers and logs panics with a stack instead of taking the process down. Neither shell saves you — Wails' generated dispatcher has no recover at all, and `rpcserver.go`'s covers only the request's own stack, not goroutines it started. `grep -rn "go func()" internal/services internal/controller internal/ipc` must stay empty. (`internal/tui` is exempt: it is its own process and tview owns the screen.) safego logs through the standard `log` package on purpose — see the Trivy/`slog.SetDefault` trap above.
- **Session registries are keyed maps whose entry is the ownership token.** Six of them exist (`termSessions`, `execSessions`, `logSessions`, `aiSessions`, `pfSessions`, plus the `cancelRegistry` instances in `controller/sessions.go`), and they share two rules:
  - **A stream's goroutine must delete its own entry, not just the Close function.** A shell that exits on its own, a pod that dies, a broken stream — none of them call `Close*Session`, so cleanup that lives only there leaks the entry, leaves the pty child unreaped (`cmd.Wait` in `terminalServices.go`'s reader goroutine is the only place a terminal is reaped) and leaves the panel silently unresponsive. Each such path also emits a terminal event — `terminal:exit:{id}`, `exec:closed:{id}`, `climode:exit:{id}` — so the frontend can distinguish a dead session from a quiet one. **Those events are keyed by session id alone, so emit one only when the goroutine still owned the registry entry.** An unconditional emit reports the *replacement's* shell as dead: React StrictMode runs every panel effect as create → close → create under one id, which made a freshly opened terminal print "[shell exited]" and ignore all input.
  - **Remove by identity, never by key.** `defer delete(m, key)` deletes whatever is under the key *at that moment*, which after a restart is the replacement session's entry — stranding a live session that nothing can then find or cancel. This is what hung the AI chat's tool-approval dialog forever when a second turn started before the first finished. `controller/sessions.go::cancelRegistry` packages the fix for the controller's cancel-func maps (function values are not comparable, hence the `*cancelToken` wrapper); `services.releaseExecSession` does it for pod exec, where winning the map delete is also what makes the `sizeQueue.ch` close happen exactly once.
- **Port forwarding is owned by the process, not by a panel.** `services/portForwardServices.go` holds `pfSessions`, a registry that outlives every panel: the user starts `127.0.0.1:8080 → svc/api:80`, closes the tab and goes to work in their browser, so tearing the tunnel down on panel dispose would be indistinguishable from a fault. Only an explicit stop or process exit closes one — `business.StopAllPortForwards()` is wired into **both** shutdown paths in `main.go` (`serve()` before `srv.Close()`, and Wails' `OnShutdown`, which is a closure rather than a method because Wails binds every exported method of `App`). Five consequences worth knowing:
  - **Loopback only, and there is no parameter that changes it.** `portforward.NewOnAddresses(dialer, []string{"127.0.0.1"}, …)`, never `portforward.New` (which binds `localhost` and can include `::1`). A forwarded port is unauthenticated access to a cluster workload.
  - **The dialer is websocket-first with a SPDY fallback** (`NewSPDYOverWebsocketDialer` + `NewFallbackDialer`, what kubectl 1.30+ does): the plain SPDY upgrade is on its way out and some proxies already refuse it, while older API servers do not speak the WebSocket variant. It is built from the **streaming** rest config (`NewK8sClientAndConfigForClusterStreaming`) — the ordinary 20s request timeout would kill the tunnel mid-session.
  - **Reconnect is decided by target kind** (`reconnectForKind`): a workload or service target re-resolves its pod and reconnects with backoff, which is what makes a tunnel survive a rolling restart; a pinned Pod does not, because silently moving to a different pod answers a question the user did not ask. A reconnect **keeps the already-bound local port**, or the browser tab the user left open points at nothing.
  - **`run()` must report the first outcome when the tunnel becomes *ready*, not when `attempt` returns** — on the happy path that is when the tunnel *ends*, which leaves `StartPortForward` (and its RPC, and the dialog's Start button) blocked for the life of the forward. This shipped broken once and looked like a frozen app rather than a backend fault, so `pfSession` carries `resolve`/`attempt` seams purely to make it testable without a cluster, and `pfStartTimeout` is a backstop so the RPC always settles.
  - **A forward that never came up is reported through `StartPortForward`'s error; one that worked and then died keeps its registry row** with status `error` so the panel can show why. Only the second kind is a row the user has to act on.
  The UI side is a singleton `portforwards` Dockview panel (like `diagnostics`, deliberately outside the `${view}:${clusterName}` scheme — it describes the process, not a cluster), a `tb-pf` title-bar pill that subscribes via `stores/portForwardStore.ts` so the count keeps updating while the panel is closed, and a `portForward` prop on `ResourceListView` that adds the ⇄ button to the same trailing column as Describe. The backend pushes one **broadcast** `portforward:update` event — not suffixed with a session id, and deliberately **not** gated by `isPrimaryWindow()` the way `tab:received` is: every window of a shell shares one backend and therefore shares these tunnels. The TUI has the same actions (`F` to start, a `portforwards` view, `X` to stop) but is a **separate process with its own registry**, so its forwards are invisible to the GUI — and in the GUI's CLI Mode the pty dies with the overlay, taking them with it.
- **Namespace filtering**: Some functions take `namespace=""` to fetch across all namespaces
- **Panel ID scheme**:
  - View panels: `${view}:${clusterName}` → e.g., `pods:my-cluster`
  - YAML panels: `yaml:${kind}:${clusterName}:${namespace}/${name}`
  - Log panels: `log:${kind}:${clusterName}:${namespace}/${name}`
  - Exec panels: `exec:${clusterName}:${namespace}/${name}:${container}`
  - Policy viewer: `policy:${clusterName}:${namespace}/${name}`
- **Error recovery**: Frontend gracefully handles Wails call failures and displays toasts
- **Moving panels between windows and instances**: A panel can travel to another **window** of this Electron process or to another **instance** (process). Both paths serialize it identically (`SerializedPanel`: `componentType` + `title` + `params`) and both end at `TabContext.openReceivedPanel`, but they are otherwise separate — because *windows are invisible to Go*. One Electron process spawns one sidecar, which mints one `InstanceID`, so a second `BrowserWindow` is **not** a second hub instance and cannot be addressed by `TransferTab`.
  - **Window → window** (undock, drag-out, or the menu's window entries): pure Electron IPC, `shell:undockPanel` / `shell:sendPanel` in `electron/main.cjs`, reached from React through `lib/shellWindows.ts`. The hub is not involved. An undocked window is seeded via `--kube-ins-initial-panel=<percent-encoded json>` in `additionalArguments`, which `DockviewContainer.onReady` opens instead of the Overview tab. It is percent-encoded rather than base64 because the preload is **sandboxed and has no `Buffer`** to decode with.
  - **A moved panel's `params` must survive structured clone.** The window path goes over Electron IPC, which throws `An object could not be cloned` on anything exotic and — because both the drag-out and the undock handler are `async`/void — fails *silently*, looking exactly like a dead feature. View panels store their sidebar icon as a **React element** in `params` (`TabContext.openTab`), so `FloatableTab.serialize()` strips `icon` and JSON round-trips the rest; `openReceivedPanel` looks the icon up again by `view` from `NAV_GROUPS`. The hub path never caught this because JSON drops a React element quietly. Keep new panel params to plain data.
  - **Instance → instance**: unchanged — `TransferTab(targetId, SerializedPanel)` → hub WebSocket → `tab:received`.
  - **Only window 1 listens to `tab:received`** (`isPrimaryWindow()` in `InstanceContext`). `Server.Emit` broadcasts to every `/events` client, and all windows of a process share one sidecar, so without this guard one transfer opens the panel in every window at once.
  - **Drag-out detection**: dockview runs tab drags on pointer events (`dndStrategy: 'pointer'`), so there is no `dataTransfer` to carry across a window boundary and no `setPointerCapture` (verified in `dockview-core@6.6.1`). `FloatableTab` therefore watches for a `pointerup` **outside the viewport** — which dockview ignores, having hit no drop target — and routes the panel itself. The inside/outside test uses client coords against `innerWidth/innerHeight` (window-relative, so DPI scaling and Wayland cannot skew it); *where* the pointer landed is resolved by `shell:windowAtCursor`, which reads `screen.getCursorScreenPoint()` in the **main process** for the same reason. Releasing over a sibling window moves the panel there; releasing over nothing opens a new window.
- **Electron windows are per-`event.sender`**: `main.cjs` keeps a `windows` Map, not a single `win`. Every `ipcMain` handler resolves its window via `BrowserWindow.fromWebContents(event.sender)` — a shared global would make the second window's titlebar drive the first. Instance names ("Instance 1", "Instance 2", ...) are still assigned by the hub server in connection order and broadcast to all clients.
- **Dockview tab insertion at index**: When opening a sub-panel (YAML, logs, exec, etc.) from within an existing panel, `positionAfter()` in `TabContext` uses `direction: 'within'` + `index: refIndex + 1` to insert the new tab immediately to the right of the source panel within the same group.
- **`FloatableTab` component type detection**: Uses `panelId.startsWith('cluster-resource-view')` (prefix match) rather than exact equality, because cluster resource view IDs encode the cluster name (`cluster-resource-view:${clusterName}`).
- **Module-level body helpers** (e.g., `DaemonSetActionsBody`, `NodeCard`): When a DataTable column body renderer needs `clusterName`, it must be received as an explicit prop — it cannot close over `clusterName` from the parent component since it is defined at module scope.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
