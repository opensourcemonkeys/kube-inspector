# Graph Report - kube-in-go  (2026-08-25)

## Corpus Check
- 454 files · ~562,071 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3247 nodes · 5751 edges · 242 communities (192 shown, 50 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 591 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6f38eb67`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Wails Controller Bindings
- Cluster & CRD Business Layer
- AI Assistant Agent Loop
- RPC Shell Transport Server
- Trivy Vulnerability Scanning
- App Bootstrap & IPC Hub
- YAML Editor & Policy Panels
- Trivy Scanner Frontend
- CI Pipeline & Changelog Docs
- Monitoring & Overview Dashboards
- MkDocs Build Hooks
- TUI Describe & Metrics Render
- Network Policy Stack
- E2E DataTable Helpers
- Resource List Components
- Cluster Resource Graph
- RBAC Security Graph
- E2E Panel Tests
- Frontend TypeScript Config
- Pod & Metrics Services
- Tab Context & ConfigMaps
- CRD List & Shared List View
- TUI Application Shell
- Workload & Security Docs
- Electron Package Manifest
- Log Streaming Business Layer
- Node Services & Cordon/Drain
- E2E Navigation Tests
- Frontend Dependencies
- Log Services Layer
- RoleBinding Stack
- Role Stack
- E2E YAML CRUD Helpers
- Electron Main Process
- Events View & Store
- Multi-Instance Tab Transfer
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 120
- Community 121
- Community 122
- Community 123
- Community 124
- Incremental --update Flow
- Community 126
- Community 127
- Community 128
- nodeServices.go
- Community 130
- Community 131
- main.tsx
- ModelTags
- ModelCatalog
- Context
- Incremental --update Flow
- main.tsx
- main.tsx
- messages.go
- Community 141
- Community 142
- Community 143
- Community 144
- Community 145
- Community 146
- Community 147
- Community 148
- restartPatch
- runChecks
- LogViewerPanel.tsx
- runChecks
- Community 156
- Community 158
- Community 159
- Community 160
- Community 161
- Community 162
- Community 163
- @fontsource/jetbrains-mono
- AppInfo
- Community 168
- Community 169
- Community 170
- Community 171
- Zustand Per-tab Stores
- networkPolicy.go
- applyOne
- sweep
- Zustand Per-tab Stores
- build_merge Replace-on-Re-extract
- open_resource_graph
- Community 179
- @emotion/styled
- Community 181
- namespace.go
- main.tsx
- AppInfo
- Community 185
- ingressClass.go
- job.go
- ingress.go
- endpoint.go
- Community 193
- Community 194
- Community 195
- Community 196
- Community 197
- Community 198
- Community 199
- Community 200
- Community 201
- Community 202
- Community 212
- podExec.go
- dockview-react
- .GetInstances
- primereact
- SweepStaleUpdateTemps
- @fontsource/geist
- PanelErrorBoundary
- daemonSet.go
- persistentVolume.go
- yaml
- html-to-image
- @melloware/react-logviewer
- react-router-dom
- monaco-yaml
- @mui/material
- motion
- persistentVolumeClaim.go
- @xterm/addon-fit
- TestClusterConfigPath
- resourceQuota.go
- dockview-react
- namespace.go
- replicaSet.go
- @fontsource/jetbrains-mono
- role.go
- serviceAccount.go
- persistentVolume.go

## God Nodes (most connected - your core abstractions)
1. `App` - 190 edges
2. `useT()` - 162 edges
3. `NewK8sClientForCluster()` - 128 edges
4. `useTabContext()` - 69 edges
5. `With()` - 46 edges
6. `themeColor()` - 32 edges
7. `errText()` - 29 edges
8. `InstanceHub` - 26 edges
9. `toApplyYaml()` - 26 edges
10. `pfSession` - 25 edges

## Surprising Connections (you probably didn't know these)
- `kubeinsdev Build Tag Relaxations` --semantically_similar_to--> `No API Key Required Policy`  [AMBIGUOUS] [semantically similar]
  CLAUDE.md → .claude/skills/graphify/SKILL.md
- `Semantic Extraction Cache` --semantically_similar_to--> `frontend/dist/.gitkeep Embed Bootstrap Cycle`  [INFERRED] [semantically similar]
  .claude/skills/graphify/SKILL.md → CLAUDE.md
- `main()` --calls--> `With()`  [INFERRED]
  cmd/tui/main.go → internal/logging/logging.go
- `main()` --calls--> `Run()`  [INFERRED]
  cmd/tui/main.go → internal/tui/run.go
- `main()` --calls--> `NewApp()`  [INFERRED]
  main.go → internal/controller/app.go

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **CI Build/Package/Publish Flow** — _github_workflows_build_pipeline, _github_workflows_build_goexperiment_jsonv2, _github_workflows_build_cloudflare_r2, _github_workflows_build_nfpm_packaging, _github_workflows_build_deploy_docs [EXTRACTED 0.90]
- **Shell-agnostic Electron Migration** — changelog_electron_shell, changelog_transport_interface, changelog_sidecar_process, changelog_webkit_removal [EXTRACTED 0.90]
- **CLI Same-engine Dual Delivery** — docs_cli_index_kube_inspector_cli, docs_cli_index_same_engine, docs_cli_index_cli_mode, changelog_tui [EXTRACTED 0.85]
- **RBAC Security Chain** — docs_security_roles_roles_screen, docs_security_role_bindings_role_bindings_screen, docs_security_security_role_map_security_role_map [EXTRACTED 1.00]
- **Kubernetes Workload Screens** — docs_workloads_pods_pods_screen, docs_workloads_deployments_deployments, docs_workloads_statefulsets_replicasets_statefulsets_replicasets, docs_workloads_daemonsets_daemonsets, docs_workloads_jobs_cronjobs_jobs_cronjobs [EXTRACTED 1.00]
- **Docs Site Build & SEO Pipeline** — mkdocs_mkdocs_config, overrides_main_base_override, overrides_home_landing_hero, overrides_main_json_ld [INFERRED 0.85]
- **Shell Transport Implementations** — claude_shell_transport, claude_wails_shell, claude_rpc_server, claude_shell_channel, claude_electron_shell [EXTRACTED 1.00]
- **Per-tab Cluster Pinning Flow** — claude_dockview_panel_system, claude_panel_id_scheme, claude_use_resource_list, claude_controller_layer, claude_business_layer, claude_repository_layer [EXTRACTED 1.00]
- **graphify Build Pipeline Stages** — _claude_skills_graphify_skill_interpreter_detection, _claude_skills_graphify_skill_ast_extraction, _claude_skills_graphify_skill_semantic_extraction, _claude_skills_graphify_skill_extraction_cache, _claude_skills_graphify_skill_community_clustering, _claude_skills_graphify_skill_graph_health_check, _claude_skills_graphify_skill_god_nodes [EXTRACTED 1.00]

## Communities (242 total, 50 thin omitted)

### Community 1 - "Cluster & CRD Business Layer"
Cohesion: 0.07
Nodes (39): CheckClusterConnection(), clusterFile(), DeleteCluster(), GetActiveCluster(), GetClusterContent(), init(), SaveCluster(), SetActiveCluster() (+31 more)

### Community 2 - "AI Assistant Agent Loop"
Cohesion: 0.25
Nodes (14): age(), PortForwardsPanel(), statusSeverity(), TagSeverity, PortForwardPill(), execCopy(), writeClipboard(), forwardAddress() (+6 more)

### Community 3 - "RPC Shell Transport Server"
Cohesion: 0.04
Nodes (43): Adding a locale, Key naming, Locale catalogs, Plurals, Status, The parity checker, The rule that keeps this honest, What is never translated (+35 more)

### Community 4 - "Trivy Vulnerability Scanning"
Cohesion: 0.07
Nodes (46): driver(), pytest_runtest_makereport(), Single Chrome WebDriver instance shared across the entire test session.      The, Capture a full-page screenshot whenever a test fails and embed it in the     pyt, Context, lockTrivyCache(), trivyCacheSubdir(), TrivyListPodImages() (+38 more)

### Community 5 - "App Bootstrap & IPC Hub"
Cohesion: 0.07
Nodes (50): Bool, Transport, Context, App, NewApp(), Bootstrap(), App, Context (+42 more)

### Community 6 - "YAML Editor & Policy Panels"
Cohesion: 0.10
Nodes (28): PanelLoading(), ObjectYamlPanel(), ObjectYamlPanelParams, editable(), YamlEditorPanel(), YamlEditorPanelParams, rec, childShape() (+20 more)

### Community 7 - "Trivy Scanner Frontend"
Cohesion: 0.07
Nodes (35): cveBody(), defaultMisconfigFilters, defaultSecretFilters, defaultVulnFilters, DetailFinding, escapeHtml(), FindingDetailDialog(), ImageScanTab() (+27 more)

### Community 8 - "CI Pipeline & Changelog Docs"
Cohesion: 0.07
Nodes (33): Cloudflare R2 Artifact Publishing, MkDocs Site Deploy Job, Disabled E2E (kind + xvfb + Chrome), GOEXPERIMENT=jsonv2 Build Flag, nfpm deb/rpm Packaging, Build & Release CI Pipeline, Embedded Chromium (Electron) Shell, Monitoring Dashboard (+25 more)

### Community 9 - "Monitoring & Overview Dashboards"
Cohesion: 0.09
Nodes (38): buildFlow(), ClusterGraph, ClusterResourcePanel(), ClusterResourcePanelParams, K8sNode(), KIND_CONFIG, nodeTypes, ResourceNode (+30 more)

### Community 10 - "MkDocs Build Hooks"
Cohesion: 0.09
Nodes (30): _abs_url(), _app_version(), _build_timeline(), _first_paragraph(), on_config(), on_page_markdown(), on_post_build(), _ordered_pages() (+22 more)

### Community 11 - "TUI Describe & Metrics Render"
Cohesion: 0.21
Nodes (21): hexOf(), barColor(), barColumn(), buildDescribeText(), fmtCPU(), fmtMem(), Color, kv() (+13 more)

### Community 12 - "Network Policy Stack"
Cohesion: 0.14
Nodes (23): GetNetworkPolicyDetail(), DeleteNetworkPolicy(), egressRuleToInfo(), GetNetworkPolicies(), GetNetworkPolicyDetail(), GetNetworkPolicyYaml(), Clientset, ingressRuleToInfo() (+15 more)

### Community 13 - "E2E DataTable Helpers"
Cohesion: 0.13
Nodes (22): assert_row_absent(), click_delete_selected_button(), click_dialog_button(), filter_datatable_by_name(), find_datatable_row(), Reusable Selenium helpers for kube-ins E2E tests.  All helpers accept an explici, Type *name* into the DataTable's 'Search name' plain-text filter input     (the, Wait until a DataTable <tr> containing a cell with *cell_text* is present. (+14 more)

### Community 14 - "Resource List Components"
Cohesion: 0.05
Nodes (63): ConfigMapListComponent(), ConfigMapRow, defaultFilters, CronJobListComponent(), defaultFilters, DaemonSetListComponent(), defaultFilters, getReadySeverity() (+55 more)

### Community 15 - "Cluster Resource Graph"
Cohesion: 0.23
Nodes (24): IngressRule, collectDaemonSets(), collectDeployments(), collectIngresses(), collectPods(), collectReplicaSets(), collectServices(), collectStatefulSets() (+16 more)

### Community 16 - "RBAC Security Graph"
Cohesion: 0.14
Nodes (24): clusterRoleID(), expandRules(), GetSecurityGraph(), Clientset, Config, Context, Interface, PolicyRule (+16 more)

### Community 17 - "E2E Panel Tests"
Cohesion: 0.14
Nodes (15): pod_data_rows(), Wait for a PrimeReact DataTable (`.p-datatable`) to be present.      The table r, Return the list of real (non-empty-message) <tr> elements currently in the     P, Wait until the *active* Dockview tab (`.dv-active-tab`) contains     *title_frag, wait_for_active_tab(), wait_for_datatable(), _open_pods_list(), Panel open/load E2E tests for kube-ins.  Verifies that the interactive resource (+7 more)

### Community 18 - "Frontend TypeScript Config"
Cohesion: 0.09
Nodes (22): compilerOptions, allowJs, allowSyntheticDefaultImports, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib (+14 more)

### Community 19 - "Pod & Metrics Services"
Cohesion: 0.15
Nodes (20): ContainerStatus, controllerRef(), GetMetricsSnapshot(), Clientset, OwnerReference, resolveOwner(), DeletePod(), GetPods() (+12 more)

### Community 20 - "Tab Context & ConfigMaps"
Cohesion: 0.50
Nodes (4): fetchPodsForKind(), LogViewerPanel(), LogViewerPanelParams, WorkloadKind

### Community 21 - "CRD List & Shared List View"
Cohesion: 0.29
Nodes (23): L(), decodeRecord(), decodeTop(), RawMessage, T, lineWithLogger(), readLines(), resetForTest() (+15 more)

### Community 22 - "TUI Application Shell"
Cohesion: 0.13
Nodes (11): Application, Flex, Color, Duration, Mutex, Primitive, App, newApp() (+3 more)

### Community 23 - "Workload & Security Docs"
Cohesion: 0.14
Nodes (19): Role Bindings Screen, Roles Screen, RBAC Interactive Graph, Security Role Map, DaemonSets Screen, Deployments Screen, Workloads Section, Jobs & CronJobs Screen (+11 more)

### Community 24 - "Electron Package Manifest"
Cohesion: 0.11
Nodes (18): electron, electron-builder, dependencies, ws, description, devDependencies, electron, electron-builder (+10 more)

### Community 25 - "Log Streaming Business Layer"
Cohesion: 0.09
Nodes (31): DeleteIngress(), GetIngresses(), GetIngressYaml(), UpdateIngressYaml(), DeleteLimitRange(), GetLimitRanges(), GetLimitRangeYaml(), UpdateLimitRangeYaml() (+23 more)

### Community 26 - "Node Services & Cordon/Drain"
Cohesion: 0.20
Nodes (15): CloseTerminalSession(), CreateTerminalSession(), Cmd, File, sessionKubeconfigPath(), SetTerminalSessionKubeconfig(), terminalKubeconfigDir(), terminalKubeconfigEnv() (+7 more)

### Community 27 - "E2E Navigation Tests"
Cohesion: 0.12
Nodes (17): click_sidebar_item(), expand_sidebar_group(), navigate_to(), Wait for an <h3> with exactly *heading_text* to appear in the DOM.      Each res, Expand a sidebar section (e.g. 'WORKLOADS') if it is currently collapsed.      T, Click a sidebar nav item by its visible label text (e.g. 'Pods')., Expand a sidebar group and click one of its items in a single call., Wait until any Dockview tab whose title contains *title_fragment* exists.      T (+9 more)

### Community 29 - "Log Services Layer"
Cohesion: 0.21
Nodes (16): GetCronJobPods(), GetDaemonSetPods(), GetDeploymentPods(), GetJobPods(), GetPodContainers(), GetPodLogsTail(), GetReplicaSetPods(), GetStatefulSetPods() (+8 more)

### Community 30 - "RoleBinding Stack"
Cohesion: 0.21
Nodes (12): DeleteRoleBinding(), GetRoleBindings(), GetRoleBindingYaml(), Clientset, roleBindingToInfo(), subjectsToK8s(), UpdateRoleBinding(), UpdateRoleBindingYaml() (+4 more)

### Community 31 - "Role Stack"
Cohesion: 0.19
Nodes (13): UpdateRole(), DeleteRole(), GetRoles(), GetRoleYaml(), Clientset, PolicyRule, policyRulesToK8s(), roleToInfo() (+5 more)

### Community 32 - "E2E YAML CRUD Helpers"
Cohesion: 0.19
Nodes (12): click_apply_button(), open_apply_yaml_panel(), Wait for a PrimeReact Toast of the given severity and return its summary text., Wait until all PrimeReact toast messages have faded away., Open the Apply YAML panel via the TitleBar 'Open → YAML Editor' menu.      The T, Click the 'Apply' button inside the YAML editor toolbar., wait_for_toast(), wait_for_toast_gone() (+4 more)

### Community 33 - "Electron Main Process"
Cohesion: 0.06
Nodes (46): dayFileName(), ensureOpen(), fs, os, pad2(), path, scrub(), sweep() (+38 more)

### Community 34 - "Events View & Store"
Cohesion: 0.06
Nodes (32): ConfigMapListComponent, CrdListComponent, CronJobListComponent, DaemonSetListComponent, DataTableComponent, DeploymentListComponent, EndpointListComponent, EventListComponent (+24 more)

### Community 35 - "Multi-Instance Tab Transfer"
Cohesion: 0.06
Nodes (57): updateState, FS, kubeInsDir(), Context, RunSelfUpdate(), T, TestCheckForUpdateAheadOfChannel(), TestCheckForUpdateEmptyChannelManifest() (+49 more)

### Community 36 - "Community 36"
Cohesion: 0.25
Nodes (11): Token Reduction Benchmark, EXTRACTED/INFERRED/AMBIGUOUS Confidence Rubric, Deterministic Node ID Format, Verbatim source_file Rule, build_merge Replace-on-Re-extract, Semantic Extraction Cache, Graph Health Check (integrity gate), graphify Pipeline (Steps 0-9) (+3 more)

### Community 37 - "Community 37"
Cohesion: 0.14
Nodes (15): Hexagon Node-Graph Brand Mark, Kube Inspector Logo, CLI Pods TUI Screenshot, Single-Letter Keybinding Actions, tview Terminal UI (TUI/CLI Mode), Deployments List Screenshot, Dockview Multi-Tab Panel Layout, Kube Inspector Desktop App (+7 more)

### Community 38 - "Community 38"
Cohesion: 0.16
Nodes (14): ClosePodExecSession(), CreatePodExecSession(), CancelFunc, Clientset, Config, releaseExecSession(), T, newTestExecSession() (+6 more)

### Community 39 - "Community 39"
Cohesion: 0.18
Nodes (7): crdChildDef(), App, App, App, App, resourceDef, rowData

### Community 40 - "Community 40"
Cohesion: 0.24
Nodes (10): ConfigMap, configMapToInfo(), DeleteConfigMap(), GetConfigMapData(), GetConfigMaps(), GetConfigMapYaml(), Clientset, UpdateConfigMapData() (+2 more)

### Community 41 - "Community 41"
Cohesion: 0.19
Nodes (14): Dockview Tabbed Panel Workspace, Resource Category Sidebar Navigation, Embedded Terminal Sessions, Multi-Panel Terminal Layout, Terminal Screenshot, CVE Severity Results Table, Container Image Scan, Vulnerability Scan Screenshot (+6 more)

### Community 42 - "Community 42"
Cohesion: 0.22
Nodes (11): graphify Skill Trigger Declaration, URL Ingest (/graphify add), Agent-Crawlable Wiki Export, Native CLAUDE.md Integration, Whisper Video/Audio Transcription, --cluster-only Reclustering, Incremental --update Flow, Portable Relative Manifest (+3 more)

### Community 43 - "Community 43"
Cohesion: 0.22
Nodes (11): DeleteLimitRange(), GetLimitRanges(), GetLimitRangeYaml(), Clientset, limitRangeToInfo(), resourceListToMap(), UpdateLimitRangeYaml(), LimitRange (+3 more)

### Community 44 - "Community 44"
Cohesion: 0.24
Nodes (10): DeleteSecret(), GetSecretData(), GetSecrets(), GetSecretYaml(), Clientset, secretToInfo(), UpdateSecretData(), UpdateSecretYaml() (+2 more)

### Community 45 - "Community 45"
Cohesion: 0.15
Nodes (7): E2E smoke tests for kube-ins.  Prerequisites: `make dev` must be running so the, The React mount point must exist as soon as the page loads., Dockview renders its container with the theme class we apply in         Dockview, The left sidebar (id='tour-sidebar') must be rendered and the         WORKLOADS, The CLUSTER section of the sidebar must also be present, confirming         all, Clicking the WORKLOADS section toggle should reveal the Pods menu         item (, TestMainFlow

### Community 46 - "Community 46"
Cohesion: 0.23
Nodes (12): children, fail(), fs, killTree(), main(), path, preflight(), ROOT (+4 more)

### Community 47 - "Community 47"
Cohesion: 0.23
Nodes (6): SaveFileOptions, shellRequest, Server, Duration, Request, ResponseWriter

### Community 48 - "Community 48"
Cohesion: 0.11
Nodes (18): CustomTypeOptions, i18next, changeLocale(), initI18n(), loadCatalog(), loaders, Namespace, NAMESPACES (+10 more)

### Community 49 - "Community 49"
Cohesion: 0.18
Nodes (13): chatMsg, aiTools(), argInt(), argStr(), asJSON(), Context, PullAiModel(), DeleteDeployment() (+5 more)

### Community 50 - "Community 50"
Cohesion: 0.50
Nodes (5): MCP stdio Server, graphify explain (single-node explanation), graphify path (shortest path between concepts), Work Memory / Self-Improving Loop, Python Interpreter Detection

### Community 51 - "Community 51"
Cohesion: 0.28
Nodes (9): No API Key Required Policy, kubeinsdev Build Tag Relaxations, Electron Shell (shipped GUI), GOEXPERIMENT=jsonv2 Build Requirement, electron-builder Builds, nfpm Packages, Loopback RPC Server (rpcserver.go), Trivy Vulnerability Scanner Integration, TUI / CLI Mode (tview terminal front end) (+1 more)

### Community 52 - "Community 52"
Cohesion: 0.47
Nodes (3): Box, focusBorder(), App

### Community 53 - "Community 53"
Cohesion: 0.17
Nodes (13): CrdTree(), CrdTreeProps, groupLabel(), InstanceRow, InstanceTable(), InstanceTableProps, CrdListComponent(), DeleteTarget (+5 more)

### Community 54 - "Community 54"
Cohesion: 0.17
Nodes (12): DaemonSet, DeleteDaemonSet(), GetDaemonSets(), GetDaemonSetYaml(), UpdateDaemonSetYaml(), daemonSetToInfo(), DeleteDaemonSet(), GetDaemonSets() (+4 more)

### Community 55 - "Community 55"
Cohesion: 0.27
Nodes (11): Endpoints, DeleteEndpoint(), endpointToInfo(), GetEndpoints(), GetEndpointYaml(), Clientset, UpdateEndpointYaml(), EndpointAddressInfo (+3 more)

### Community 56 - "Community 56"
Cohesion: 0.26
Nodes (9): Ingress, DeleteIngress(), GetIngresses(), GetIngressYaml(), Clientset, ingressToInfo(), UpdateIngressYaml(), IngressInfo (+1 more)

### Community 57 - "Community 57"
Cohesion: 0.26
Nodes (9): DeleteService(), GetServices(), GetServiceYaml(), Clientset, Service, serviceToInfo(), UpdateServiceYaml(), ServiceInfo (+1 more)

### Community 58 - "Community 58"
Cohesion: 0.17
Nodes (12): DeleteStatefulSet(), GetStatefulSets(), GetStatefulSetYaml(), UpdateStatefulSetYaml(), DeleteStatefulSet(), GetStatefulSets(), GetStatefulSetYaml(), Clientset (+4 more)

### Community 59 - "Community 59"
Cohesion: 0.17
Nodes (12): NetworkPolicy Ingress/Egress Graph, Network Policies Screenshot, NetworkPolicy YAML Editor Split, Namespace/Status Filter and Search, Pod List Table View, Pods List Screenshot, ServiceAccount/RoleBinding/Role/ClusterRole Focus Filters, RBAC Subject-Role-Resource Graph (+4 more)

### Community 60 - "Community 60"
Cohesion: 0.18
Nodes (7): App, Context, Server, RWMutex, jsonRepresentable(), Type, wsClient

### Community 61 - "Community 61"
Cohesion: 0.23
Nodes (10): CronJob, GetCronJobs(), cronJobToInfo(), DeleteCronJob(), GetCronJobs(), GetCronJobYaml(), Clientset, SetCronJobSuspend() (+2 more)

### Community 62 - "Community 62"
Cohesion: 0.24
Nodes (9): Deployment, GetDeployments(), DeleteDeployment(), deploymentToInfo(), GetDeployments(), GetDeploymentYaml(), Clientset, UpdateDeploymentYaml() (+1 more)

### Community 63 - "Community 63"
Cohesion: 0.24
Nodes (10): GetJobs(), DeleteJob(), GetJobs(), GetJobYaml(), Clientset, jobStatus(), jobToInfo(), UpdateJobYaml() (+2 more)

### Community 64 - "Community 64"
Cohesion: 0.09
Nodes (14): failures, glossary, LOCALES_DIR, namespaces, onDisk, PLURAL_RE, PLURAL_SUFFIXES, readGlossary() (+6 more)

### Community 65 - "Community 65"
Cohesion: 0.27
Nodes (8): DeleteReplicaSet(), GetReplicaSets(), GetReplicaSetYaml(), Clientset, replicaSetToInfo(), UpdateReplicaSetYaml(), ReplicaSetInfo, ReplicaSet

### Community 66 - "Community 66"
Cohesion: 0.23
Nodes (10): GetServiceAccounts(), DeleteServiceAccount(), GetServiceAccounts(), GetServiceAccountYaml(), Clientset, serviceAccountToInfo(), UpdateServiceAccount(), UpdateServiceAccountYaml() (+2 more)

### Community 67 - "Community 67"
Cohesion: 0.06
Nodes (31): eslint, @eslint/js, eslint-plugin-i18next, eslint-plugin-react-hooks, devDependencies, eslint, @eslint/js, eslint-plugin-i18next (+23 more)

### Community 68 - "Community 68"
Cohesion: 0.15
Nodes (12): name, private, scripts, build, dev, i18n:check, lint, preview (+4 more)

### Community 69 - "Community 69"
Cohesion: 0.22
Nodes (18): boolStr(), buildRegistry(), clusterScopedDelete(), clusterScopedUpdate(), clusterScopedYAML(), dash(), humanSince(), i32() (+10 more)

### Community 70 - "Community 70"
Cohesion: 0.18
Nodes (10): author, email, name, frontend:build, frontend:dev:serverUrl, frontend:dev:watcher, frontend:install, name (+2 more)

### Community 71 - "Community 71"
Cohesion: 0.16
Nodes (16): Business Orchestration Layer, Cluster Configuration (~/.kube-ins), ClusterContext, CRDs and Generic Object CRUD, Dockview Panel System, Selenium + pytest E2E Suite, Module-level DataTable Body Helpers, Panel ID Scheme (+8 more)

### Community 72 - "Community 72"
Cohesion: 0.24
Nodes (6): Event, GetEvents(), eventToInfo(), GetEvents(), Clientset, EventInfo

### Community 73 - "Community 73"
Cohesion: 0.17
Nodes (12): DeletePersistentVolumeClaim(), GetPersistentVolumeClaims(), GetPersistentVolumeClaimYaml(), UpdatePersistentVolumeClaimYaml(), DeletePersistentVolumeClaim(), GetPersistentVolumeClaims(), GetPersistentVolumeClaimYaml(), Clientset (+4 more)

### Community 74 - "Community 74"
Cohesion: 0.18
Nodes (3): FakeResizeObserver, resizeCallbacks, Row

### Community 75 - "Community 75"
Cohesion: 0.13
Nodes (18): defaultFilters, getStatusSeverity(), NamespaceListComponent(), NewNamespaceButton(), Severity, ConfirmActionDialog(), ScaleDialog(), DescribePanel() (+10 more)

### Community 76 - "Community 76"
Cohesion: 0.20
Nodes (11): AI Assistant (Ollama tool-calling agent), AI Tool Registry (aiTools), Event Streaming (terminal, logs, AI, tab transfer), InstanceContext, IPC InstanceHub (WebSocket multi-instance discovery), Multi-Instance Tab Transfer, Shell-Agnostic Transport Interface, Go Sidecar Process Lifecycle (+3 more)

### Community 77 - "Community 77"
Cohesion: 0.29
Nodes (7): IngressClass, GetIngressClasses(), GetIngressClassYaml(), Clientset, ingressClassToInfo(), UpdateIngressClassYaml(), IngressClassInfo

### Community 78 - "Community 78"
Cohesion: 0.29
Nodes (7): GetPersistentVolumes(), GetPersistentVolumeYaml(), Clientset, pvToInfo(), UpdatePersistentVolumeYaml(), PersistentVolumeInfo, PersistentVolume

### Community 79 - "Community 79"
Cohesion: 0.29
Nodes (7): GetStorageClasses(), GetStorageClassYaml(), Clientset, storageClassToInfo(), UpdateStorageClassYaml(), StorageClassInfo, StorageClass

### Community 80 - "Community 80"
Cohesion: 0.04
Nodes (44): Adım ikiye bölündü (planlama oturumu kararı), Bağımlılık grafiği, Bilinen kısıtlar (S16 Known Limitations'a), Bu step'i çalıştıran oturuma tavsiye, Context — bu plan neden var, Her step oturumuna yapıştırılacak global önsöz, İlerleme, Karar: imzaları değiştir. Paralel mekanizma ekleme. (+36 more)

### Community 81 - "Community 81"
Cohesion: 0.39
Nodes (8): CreateNamespace(), DeleteNamespace(), GetNamespaces(), GetNamespaceYaml(), Clientset, namespaceToInfo(), quantityToComparableNum(), Quantity

### Community 82 - "Community 82"
Cohesion: 0.24
Nodes (12): containerDotColor(), DataTableComponent(), defaultFilters, fmtCpu(), fmtMem(), getOwnerSeverity(), getStatusSeverity(), renderContainerItem() (+4 more)

### Community 83 - "Community 83"
Cohesion: 0.05
Nodes (66): Dialer, GetForwardablePorts(), ListPortForwards(), StartPortForward(), errText(), Clientset, Config, Context (+58 more)

### Community 84 - "Community 84"
Cohesion: 0.38
Nodes (4): expandHome(), App, headerCell(), TableCell

### Community 85 - "Community 85"
Cohesion: 0.20
Nodes (8): GetWorkloadAutoscaler(), RestartWorkload(), ScaleWorkload(), SetCronJobSuspend(), FindScaleAutoscaler(), Clientset, ScaleWorkload(), HPAInfo

### Community 86 - "Community 86"
Cohesion: 0.25
Nodes (5): CreateCliModeSession(), Cmd, File, selfExe(), cliModeSession

### Community 87 - "Community 87"
Cohesion: 0.17
Nodes (18): normalizedCall, textCall, Tool, ToolEvent, argsToAPI(), Context, jsonObjects(), parseTextToolCalls() (+10 more)

### Community 88 - "Community 88"
Cohesion: 0.11
Nodes (36): check, ListClusters(), addZipLogFile(), addZipText(), buildChecks(), checkClusterAPI(), checkClusterMetrics(), checkClusterRBAC() (+28 more)

### Community 89 - "Community 89"
Cohesion: 0.39
Nodes (8): nextId(), RoleEditorPanel(), RoleEditorPanelParams, rowsEqual(), rowsToRules(), RuleRow, rulesToRows(), splitCSV()

### Community 90 - "Community 90"
Cohesion: 0.06
Nodes (42): CliModeOverlay(), GROUP_ICONS, SideMenu(), GroupKey, NAV_GROUPS, NavGroup, NavItem, S (+34 more)

### Community 91 - "Community 91"
Cohesion: 0.08
Nodes (30): addressesOf(), createFrom(), defaultFilters, EndpointListComponent(), EndpointRow, portsOf(), createFrom(), defaultFilters (+22 more)

### Community 92 - "Community 92"
Cohesion: 0.25
Nodes (7): compilerOptions, allowSyntheticDefaultImports, composite, module, moduleResolution, include, vite.config.ts

### Community 93 - "Community 93"
Cohesion: 0.36
Nodes (8): nextId(), RoleBindingEditorPanel(), RoleBindingEditorPanelParams, rowsEqual(), rowsToSubjects(), SUBJECT_KINDS, SubjectRow, subjectsToRows()

### Community 94 - "Community 94"
Cohesion: 0.07
Nodes (33): react, AiChat(), buildContext(), ConfirmReq, fmtBytes(), PullState, ToolLines(), DiagnosticsPanel() (+25 more)

### Community 95 - "Community 95"
Cohesion: 0.25
Nodes (8): Controller Layer (Wails binding point), frontend/dist/.gitkeep Embed Bootstrap Cycle, Go-embedded Kubernetes JSON Schema, kube-ins Desktop Application, Layered Go Backend Architecture, Models Layer (frontend serialization structs), Services Layer (Kubernetes API calls), Generated Wails TypeScript Bindings

### Community 96 - "Community 96"
Cohesion: 0.38
Nodes (7): Cross-Repo / Monorepo Graph Merge, GitHub Repo Clone, BFS Traversal Mode, DFS Traversal Mode, Constrained Query Expansion, Token-Budget-Aware Output, Fast Path for an Existing Graph

### Community 97 - "Community 97"
Cohesion: 0.08
Nodes (42): BdRow, BreakdownList(), defaultFilters(), DetailDrawer(), findUsage(), fmtTime(), lineOptions(), MonitoringDashboard() (+34 more)

### Community 98 - "Community 98"
Cohesion: 0.06
Nodes (32): Are port forwards reachable from my network?, Can I change the language or theme?, Can I move a tab into its own window?, Can I roll back an update?, Can I use several clusters at once?, Can it edit resources, or is it read-only?, Clusters and configuration, Comparisons (+24 more)

### Community 99 - "Community 99"
Cohesion: 0.46
Nodes (3): Request, ResponseWriter, writeJSON()

### Community 100 - "Community 100"
Cohesion: 0.33
Nodes (6): If verification fails, Verify against the whole-release file, Verify one file, Verifying your download, What is published, What this does not prove

### Community 101 - "Community 101"
Cohesion: 0.18
Nodes (11): AboutModal(), DEP_LABELS, Props, TitleBar(), TitleBarProps, useLocaleStore, coerceTheme(), ThemeId (+3 more)

### Community 102 - "Community 102"
Cohesion: 0.23
Nodes (15): clusterReplacer(), isNameByte(), redact(), redactBase64(), redactorFor(), redactURL(), redactURLs(), replaceFold() (+7 more)

### Community 105 - "Community 105"
Cohesion: 0.06
Nodes (49): GroupVersionResource, GetCRDInstanceCounts(), GetCRDs(), GetCustomResources(), applyError(), applyOne(), ApplyYaml(), Config (+41 more)

### Community 107 - "Community 107"
Cohesion: 0.29
Nodes (8): Folder Watcher (--watch), Call Edge Direction and Language Rule, Hyperedges, Rationale as Node Attribute, semantically_similar_to Edges, Post-Commit Auto-Rebuild Hook, Code-Only Update Fast Path, Part A - AST Structural Extraction

### Community 108 - "Community 108"
Cohesion: 0.20
Nodes (11): CheckInstallable(), Context, PlatformAssetKey(), RunInstaller(), runningAppBundle(), startSwapHelper(), shellQuote(), swapHelperScript() (+3 more)

### Community 109 - "Community 109"
Cohesion: 0.40
Nodes (4): Also never translated (not glossary terms — *data*), CamelCase kinds stay; spaced prose does not, Glossary — terms that stay English in every locale, Translated

### Community 110 - "Community 110"
Cohesion: 0.20
Nodes (16): Attr, LogDir(), CurrentFile(), Dir(), doInit(), Files(), Handler, init() (+8 more)

### Community 111 - "Community 111"
Cohesion: 0.18
Nodes (12): GetClusterCounts(), countAll(), GetClusterCounts(), Clientset, Context, T, TestCountAllFallsBackToFullListWhenRemainingIsAbsent(), TestCountAllPropagatesListError() (+4 more)

### Community 112 - "Community 112"
Cohesion: 0.53
Nodes (5): fetchRegistryToken(), Header, ModelTags(), regGet(), ListAiModelTags()

### Community 113 - "Community 113"
Cohesion: 0.06
Nodes (71): ClusterBar(), ClusterModal(), ParsedConfig, parseKubeconfig(), ParseResult, Props, sanitizeName(), suggestName() (+63 more)

### Community 114 - "Community 114"
Cohesion: 0.26
Nodes (8): dayFileName(), File, Mutex, Time, newDayWriter(), startOfDay(), truncateRecord(), dayWriter

### Community 115 - "Community 115"
Cohesion: 0.15
Nodes (9): Primitive, Table, App, statusColumnIndex(), Context, Run(), applyTheme(), Color (+1 more)

### Community 116 - "Community 116"
Cohesion: 0.22
Nodes (3): wailsTransport, Context, App

### Community 117 - "Community 117"
Cohesion: 0.33
Nodes (5): complete(), fakeModel(), Item, providers, SCHEMA

### Community 118 - "Community 118"
Cohesion: 0.33
Nodes (6): _click_first_row_action(), open_pod_exec_panel(), open_pod_log_panel(), Click the action button at *button_index* on the first data row of the     activ, Click the Logs action button on the first pod row.     Returns True if a pod row, Click the Exec (terminal) action button on the first pod row.     Returns True i

### Community 120 - "Community 120"
Cohesion: 0.33
Nodes (5): configmap_cleanup(), YAML CRUD lifecycle E2E test for kube-ins.  This test simulates a real user:   1, Pytest fixture that guarantees the test ConfigMap is deleted from the     cluste, Full Create → Read/Verify → Delete lifecycle via the kube-ins UI.      The test, TestConfigMapCRUD

### Community 122 - "Community 122"
Cohesion: 0.67
Nodes (3): T, TestSweepStaleUpdateTemps(), TestSweepStaleUpdateTempsMissingRoot()

### Community 123 - "Community 123"
Cohesion: 0.22
Nodes (6): main(), Writer, StdlibWriter(), stdlibWriter, main(), serve()

### Community 124 - "Community 124"
Cohesion: 0.14
Nodes (14): A port forward stopped working, A resource list is empty, Collecting diagnostics for a bug report, Exec into a pod fails, Monitoring is empty, or CPU/memory columns show nothing, Port forward: "address already in use", Related, The app will not start (+6 more)

### Community 127 - "Community 127"
Cohesion: 0.50
Nodes (3): aiSession, CancelFunc, Mutex

### Community 128 - "Community 128"
Cohesion: 0.83
Nodes (3): init(), initProgress(), initToggle()

### Community 129 - "nodeServices.go"
Cohesion: 0.18
Nodes (15): GetNodes(), CordonNode(), DrainNode(), GetNodes(), GetNodeYaml(), Clientset, Pod, isDaemonSetPod() (+7 more)

### Community 131 - "Community 131"
Cohesion: 0.33
Nodes (5): DeleteNetworkPolicy(), GetNetworkPolicies(), GetNetworkPolicyYaml(), ParseNetworkPolicyYaml(), UpdateNetworkPolicyYaml()

### Community 132 - "main.tsx"
Cohesion: 0.43
Nodes (5): rpcResponse, wsClient, buildResponse(), Conn, Value

### Community 133 - "ModelTags"
Cohesion: 0.39
Nodes (6): dataToRows(), KeyValueRow, nextId(), rowsEqual(), SecretEditorPanel(), SecretEditorPanelParams

### Community 135 - "Context"
Cohesion: 0.29
Nodes (6): DeleteConfigMap(), GetConfigMapData(), GetConfigMaps(), GetConfigMapYaml(), UpdateConfigMapData(), UpdateConfigMapYaml()

### Community 137 - "Incremental --update Flow"
Cohesion: 0.33
Nodes (5): CordonNode(), DrainNode(), GetNodeYaml(), UncordonNode(), UpdateNodeYaml()

### Community 139 - "main.tsx"
Cohesion: 0.15
Nodes (14): Client, ListModels(), newClient(), baseName(), Context, IsAvailable(), ModelCatalog(), PullModel() (+6 more)

### Community 140 - "messages.go"
Cohesion: 0.18
Nodes (10): cancelRegistry, cancelToken, ApplyYaml(), CancelFunc, Mutex, newCancelRegistry(), T, TestCancelRegistryCancelUnknownKeyIsNoop() (+2 more)

### Community 141 - "Community 141"
Cohesion: 0.07
Nodes (27): chart.js, @dagrejs/dagre, dockview, @emotion/react, @fontsource/inter, dependencies, chart.js, @dagrejs/dagre (+19 more)

### Community 142 - "Community 142"
Cohesion: 0.67
Nodes (3): Unified ResourceListView / useResourceList, Endpoints Screen, Services Screen

### Community 143 - "Community 143"
Cohesion: 0.67
Nodes (3): MkDocs Documentation Site, SEO / LLM Discoverability Files, In-app Update Check

### Community 144 - "Community 144"
Cohesion: 0.36
Nodes (6): TailLogs(), toLogEntry(), levelRank(), Tail(), Record, LogEntry

### Community 145 - "Community 145"
Cohesion: 0.67
Nodes (3): Persistent Volumes Screen, Storage Classes Screen, Volume Claims Screen

### Community 149 - "restartPatch"
Cohesion: 0.50
Nodes (4): Clientset, Time, restartPatch(), RestartWorkload()

### Community 150 - "runChecks"
Cohesion: 0.40
Nodes (3): GetAppInfo(), AppInfo, DependencyInfo

### Community 151 - "LogViewerPanel.tsx"
Cohesion: 0.54
Nodes (7): T, seedLogDir(), TestExportDiagnosticsZipIsRedacted(), TestExportDiagnosticsZipKeepsTheEvidence(), TestRenderDiagnosticsTextHasNoClusterNames(), TestRunHealthChecksBoundedAndStable(), TestRunHealthChecksSurvivesAPanickingCheck()

### Community 153 - "runChecks"
Cohesion: 0.48
Nodes (6): ConfigMapEditorPanel(), ConfigMapEditorPanelParams, dataToRows(), KeyValueRow, nextId(), rowsEqual()

### Community 164 - "@fontsource/jetbrains-mono"
Cohesion: 0.38
Nodes (5): shellChannel, shellReply, Conn, Mutex, newShellChannel()

### Community 165 - "AppInfo"
Cohesion: 0.22
Nodes (9): Adding a language, Fixing a string, Getting a language marked "reviewed", Plurals, Related, Translations, What must stay in English, What the checker enforces (+1 more)

### Community 172 - "Zustand Per-tab Stores"
Cohesion: 0.22
Nodes (9): Distribution, Known limitations, Languages, Metrics and scanning, Port forwarding, Related, Updates, Windows and panels (+1 more)

### Community 173 - "networkPolicy.go"
Cohesion: 0.22
Nodes (9): In the terminal UI, Lifetime: the process owns the tunnel, not the panel, Port forwarding, Reconnection, Related, Security, Starting a forward, The Port Forwards panel (+1 more)

### Community 174 - "applyOne"
Cohesion: 0.25
Nodes (8): Data you can delete, Diagnostics are manual and redacted, Local network surfaces, Privacy, Questions, This website is not the app, What never leaves your machine, What the app sends

### Community 175 - "sweep"
Cohesion: 0.67
Nodes (5): Time, parseDayFileName(), sweep(), sweepAsync(), touch()

### Community 176 - "Zustand Per-tab Stores"
Cohesion: 0.25
Nodes (8): Fixed app:// Origin with protocol.handle Proxy, Live Resource Monitoring Dashboard, Shell Channel (native save dialog bridge), Window Screenshot (SaveSnapshot), theme-monolith.css Variable-Driven Theming, Zustand Per-tab Stores, Nunito Font Family, SIL Open Font License v1.1

### Community 177 - "build_merge Replace-on-Re-extract"
Cohesion: 0.25
Nodes (8): Before you file, Beta expectations, Contributing a fix, Fixing a translation, Reporting a bug, Reporting a security vulnerability, Requesting a feature, Support

### Community 178 - "open_resource_graph"
Cohesion: 0.40
Nodes (4): open_resource_graph(), Click the 'Resource Graph' button in the ClusterBar, which opens the     cluster, Opening the Resource Graph from the ClusterBar mounts the ClusterResourcePanel, TestResourceGraphPanel

### Community 179 - "Community 179"
Cohesion: 0.40
Nodes (4): CheckInstallable(), Context, PlatformAssetKey(), RunInstaller()

### Community 181 - "Community 181"
Cohesion: 0.33
Nodes (5): InstanceInfo, SerializedPanel, InstanceListPayload, RegisterPayload, TransferPayload

### Community 182 - "namespace.go"
Cohesion: 0.32
Nodes (6): GetResourceQuotas(), GetResourceQuotaYaml(), Clientset, UpdateResourceQuotaYaml(), toApplyYaml(), Object

### Community 183 - "main.tsx"
Cohesion: 0.25
Nodes (7): 1. Remove the application, 2. Remove your data, `~/.kube-ins` — kubeconfigs, logs, caches, preferences, Reinstalling later, Uninstall, What is *not* removed, ever, Window state, theme, language and chat history

### Community 184 - "AppInfo"
Cohesion: 0.40
Nodes (4): DeleteService(), GetServices(), GetServiceYaml(), UpdateServiceYaml()

### Community 185 - "Community 185"
Cohesion: 0.40
Nodes (4): CheckInstallable(), Context, PlatformAssetKey(), RunInstaller()

### Community 186 - "ingressClass.go"
Cohesion: 0.36
Nodes (5): GetMetricsSnapshot(), matchUsage(), ContainerUsage, MetricsSnapshot, ResourceUsage

### Community 189 - "job.go"
Cohesion: 0.50
Nodes (3): DeleteJob(), GetJobYaml(), UpdateJobYaml()

### Community 190 - "ingress.go"
Cohesion: 0.50
Nodes (3): DeleteCronJob(), GetCronJobYaml(), UpdateCronJobYaml()

### Community 192 - "endpoint.go"
Cohesion: 0.40
Nodes (4): DeleteEndpoint(), GetEndpoints(), GetEndpointYaml(), UpdateEndpointYaml()

### Community 213 - "podExec.go"
Cohesion: 0.43
Nodes (4): NamespacedResourceQuota, NamespaceInfo, ResourceQuotaEntry, ResourceQuotaInfo

### Community 214 - "dockview-react"
Cohesion: 1.00
Nodes (3): lastNewline(), Recover(), Stack()

### Community 215 - ".GetInstances"
Cohesion: 0.50
Nodes (3): GetIngressClasses(), GetIngressClassYaml(), UpdateIngressClassYaml()

### Community 220 - "daemonSet.go"
Cohesion: 0.29
Nodes (7): Linux, macOS, Related, The in-app updater, Unsigned builds, What "unsigned" does and does not mean, Windows

### Community 221 - "persistentVolume.go"
Cohesion: 0.50
Nodes (3): GetStorageClasses(), GetStorageClassYaml(), UpdateStorageClassYaml()

### Community 229 - "persistentVolumeClaim.go"
Cohesion: 0.29
Nodes (6): Actions, Describe, Notes, Opening it, Reading it, Related

### Community 231 - "TestClusterConfigPath"
Cohesion: 0.33
Nodes (6): Changing it, Language, Related, Reporting or fixing a translation, What is never translated, What "machine-translated" means

### Community 232 - "resourceQuota.go"
Cohesion: 0.40
Nodes (4): Anything reviewers should know, Checklist, How it was verified, What and why

### Community 236 - "namespace.go"
Cohesion: 0.40
Nodes (4): CreateNamespace(), DeleteNamespace(), GetNamespaces(), GetNamespaceYaml()

### Community 237 - "replicaSet.go"
Cohesion: 0.40
Nodes (4): DeleteReplicaSet(), GetReplicaSets(), GetReplicaSetYaml(), UpdateReplicaSetYaml()

### Community 239 - "role.go"
Cohesion: 0.40
Nodes (4): DeleteRole(), GetRoles(), GetRoleYaml(), UpdateRoleYaml()

### Community 240 - "serviceAccount.go"
Cohesion: 0.40
Nodes (4): DeleteServiceAccount(), GetServiceAccountYaml(), UpdateServiceAccount(), UpdateServiceAccountYaml()

### Community 241 - "persistentVolume.go"
Cohesion: 0.50
Nodes (3): GetPersistentVolumes(), GetPersistentVolumeYaml(), UpdatePersistentVolumeYaml()

## Ambiguous Edges - Review These
- `Frontend index.html` → `MkDocs Site Config`  [AMBIGUOUS]
  frontend/index.html · relation: conceptually_related_to
- `kubeinsdev Build Tag Relaxations` → `No API Key Required Policy`  [AMBIGUOUS]
  CLAUDE.md · relation: semantically_similar_to
- `theme-monolith.css Variable-Driven Theming` → `Nunito Font Family`  [AMBIGUOUS]
  frontend/src/assets/fonts/OFL.txt · relation: references

## Knowledge Gaps
- **619 isolated node(s):** `{ spawn }`, `path`, `fs`, `ROOT`, `children` (+614 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **50 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Frontend index.html` and `MkDocs Site Config`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `kubeinsdev Build Tag Relaxations` and `No API Key Required Policy`?**
  _Edge tagged AMBIGUOUS (relation: semantically_similar_to) - confidence is low._
- **What is the exact relationship between `theme-monolith.css Variable-Driven Theming` and `Nunito Font Family`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `App` connect `Wails Controller Bindings` to `nodeServices.go`, `Trivy Vulnerability Scanning`, `main.tsx`, `Network Policy Stack`, `messages.go`, `Community 144`, `Pod & Metrics Services`, `runChecks`, `RoleBinding Stack`, `Role Stack`, `Community 161`, `Community 162`, `Multi-Instance Tab Transfer`, `Community 163`, `Community 40`, `Community 43`, `Community 44`, `Community 54`, `Community 55`, `Community 56`, `Community 57`, `ingressClass.go`, `Community 58`, `Community 61`, `Community 62`, `Community 63`, `Community 65`, `Community 66`, `Community 72`, `Community 73`, `Community 77`, `Community 78`, `Community 79`, `Community 83`, `podExec.go`, `Community 85`, `Community 105`, `Community 110`, `Community 111`, `Community 121`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **Why does `With()` connect `CRD List & Shared List View` to `nodeServices.go`, `Cluster & CRD Business Layer`, `Multi-Instance Tab Transfer`, `main.tsx`, `SweepStaleUpdateTemps`, `App Bootstrap & IPC Hub`, `Community 185`, `Community 108`, `Community 110`, `sweep`, `Community 49`, `Community 83`, `Community 85`, `dockview-react`, `Community 88`, `Log Streaming Business Layer`, `Community 123`, `Community 60`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Why does `NewK8sClientForCluster()` connect `Log Streaming Business Layer` to `nodeServices.go`, `Cluster & CRD Business Layer`, `Community 131`, `Trivy Vulnerability Scanning`, `Context`, `Incremental --update Flow`, `Network Policy Stack`, `Community 148`, `Role Stack`, `Community 49`, `Community 54`, `AppInfo`, `ingressClass.go`, `Community 58`, `job.go`, `Community 62`, `Community 61`, `endpoint.go`, `ingress.go`, `Community 63`, `Community 66`, `Community 72`, `Community 73`, `Community 83`, `Community 85`, `.GetInstances`, `Community 88`, `persistentVolume.go`, `namespace.go`, `replicaSet.go`, `Community 111`, `role.go`, `persistentVolume.go`, `serviceAccount.go`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Are the 123 inferred relationships involving `NewK8sClientForCluster()` (e.g. with `GetClusterCounts()` and `GetClusterGraph()`) actually correct?**
  _`NewK8sClientForCluster()` has 123 INFERRED edges - model-reasoned connections that need verification._