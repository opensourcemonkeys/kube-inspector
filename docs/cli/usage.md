---
description: Keyboard shortcuts and usage for Kube Inspector CLI — the split workspace, describe, YAML edit, scale, rollout restart, port forwarding, logs and pod exec from the terminal.
---

# CLI Usage & Shortcuts

Launch the CLI by running `kube-inspector-cli` (or **Open ▸ CLI Mode** in the desktop app). You start on the **Clusters** screen and navigate inward; each screen replaces the previous one. The top bar always shows a breadcrumb on the left and the available shortcuts for the current screen on the right.

## Navigating

```
Clusters  →  Workspace ( resource menu │ resource list )  →  describe · yaml · logs · exec
```

Pick a cluster and you land in the **workspace**, which is split k9s-style: the
resource menu on the left, the selected resource's list on the right. **`←` and
`→` move focus between the two panes** — `←` from the list puts you back in the
menu, and Pods are open by default.

Detail screens (describe, YAML, logs, exec) open over the workspace. Press `q`
or `Esc` to go **back** one level; on the Clusters screen `q` / `Esc` **quits**.

## Global keys

These work on every screen (except while typing in a text field):

| Key | Action |
|---|---|
| `↑` / `↓` or `j` / `k` | Move selection |
| `g` / `G` | Jump to top / bottom |
| `Enter` | Open / select |
| `q` or `Esc` | Back one screen (quit on the Clusters screen) |
| `c` | Jump to the cluster selector |
| `?` | Toggle the help overlay |

!!! tip "Cross-platform shortcuts"
    Navigation and row actions are plain single keys — no `Ctrl`/`Alt` combos for a terminal to intercept — so they behave the same on Linux, macOS and Windows. Only the YAML editor and the exec session use a `Ctrl` chord. The current screen's keys are always shown in the top-right.

## Clusters screen

The landing screen lists the clusters configured in `~/.kube-ins/` (shared with the desktop app).

| Key | Action |
|---|---|
| `Enter` | Set the selected cluster active and open the resource menu |
| `a` | Add a cluster — enter a **name** and a path to a **kubeconfig** file |
| `d` | Delete the selected cluster config (with confirmation) |
| `v` | View the selected cluster's kubeconfig |

## Resource menu

The left pane of the workspace: a grouped tree (Workloads, Networking, Config & Secrets, Security, Storage, Cluster) mirroring the desktop sidebar. Use the arrow keys to move, `Enter` (or `→`) to open a resource type into the right-hand pane, and `Enter` on a group header to collapse or expand it.

## Resource list

The right pane: a table pinned to the active cluster. The header shows the resource title and the current item count.

| Key | Action |
|---|---|
| `Enter` | **Describe** the selected object — `kubectl describe` output, events included |
| `y` | View the object's YAML |
| `e` | Edit the object's YAML *(where supported)* |
| `d` | Delete the selected object (with confirmation) |
| `/` | Filter rows (matches name & namespace); `Esc` clears the filter |
| `r` | Refresh the list |
| `→` | Scroll the table horizontally |
| `←` | Back to the resource menu |
| `c` | Switch cluster |
| `q` / `Esc` | Back |

### Per-resource actions

Some resources add row actions, always shown in the hint bar for the list you are looking at:

| Resource | Extra keys |
|---|---|
| Pods | `l` stream logs · `s` open a shell · `F` port-forward |
| Deployments, StatefulSets | `S` scale · `R` rollout restart · `F` port-forward |
| ReplicaSets | `S` scale · `F` port-forward |
| Services | `F` port-forward |
| DaemonSets | `R` rollout restart |
| CronJobs | `P` pause (suspend) · `U` unpause · `T` run now (creates a Job from the template, with confirmation) |
| Nodes | `C` cordon · `U` uncordon · `D` drain (with confirmation) |
| Port Forwards | `X` stop the selected tunnel |

`S`, `R`, `F`, `P`/`U`, `T` and the node operations run **synchronously** — the UI waits for the cluster to answer before returning, which for a port forward means waiting until the tunnel is actually up.

!!! note "Editable resources"
    Resources without a backing update operation (e.g. Pods, Events) are view-only — pressing `e` shows a notice. Editable kinds (Deployments, Services, ConfigMaps, Secrets, RBAC, Nodes, …) open the YAML editor.

## Describe

`Enter` on a row renders the same `kubectl describe` output the desktop app shows — conditions, container state, volumes and the object's recent events — scrollable with `g` / `G`. `q` / `Esc` returns to the list.

The one exception is the **CRDs** list, where `Enter` drills into that CRD's live instances instead; `y` still opens the YAML of either.

## YAML view & edit

- **View** (`y`): a read-only, scrollable YAML pane. `/` searches, `n` / `N` step through matches, `g` / `G` jump to top / bottom, `e` switches to editing, `q` / `Esc` goes back.
- **Edit** (`e`): an editable buffer seeded with the live YAML.
    - **`Ctrl-O`** — save (applies the update to the cluster)
    - **`Ctrl-X`** or **`Esc`** — leave without saving

The same two keys apply in the **Apply YAML** screen (Cluster ▸ Apply YAML), where `Ctrl-O` applies the buffer to the cluster.

## Logs

Press `l` on a pod to stream its logs. If the pod has more than one container you'll be prompted to pick one first.

| Key | Action |
|---|---|
| `f` | Toggle follow (auto-scroll) |
| `g` / `G` | Jump to top / bottom |
| `q` / `Esc` | Stop streaming and go back |

## Exec (pod shell)

Press `s` on a pod to open an interactive shell (`/bin/sh`) in the selected container. The terminal UI steps aside and hands the raw terminal to the remote shell.

!!! warning "Disconnecting"
    To leave the shell and return to the table, press **`Ctrl-]`** (the TUI cannot embed a terminal, so it uses this telnet-style escape). Typing `exit` in the shell ends the remote process; press `Ctrl-]` afterwards to return.

## Port forwarding

Press `F` on a Pod, Deployment, StatefulSet, ReplicaSet or Service and enter
`local:remote` (or just the remote port, e.g. `80`, to let the local one be
chosen for you). The tunnel binds `127.0.0.1` only.

Running tunnels are listed under **Cluster ▸ Port Forwards**, where `X` stops
the selected one.

!!! warning "The CLI's tunnels are its own"
    Port forwards belong to the **process** that started them. Those started
    here are invisible to the desktop app and vice versa, and they end when this
    process does — including when you close **CLI Mode** inside the desktop app,
    which kills the terminal process behind the overlay.

## CLI Mode inside the desktop app

You don't need a separate install to try the CLI from the desktop app: choose **Open ▸ CLI Mode** in the title bar. The graphical workspace is replaced by a fullscreen terminal running the same TUI; click **Exit CLI Mode** (or quit the TUI with `q`) to return to the dockview workspace with your panels intact.

!!! note "Shared active cluster"
    The active cluster is stored on disk (`~/.kube-ins/.active`) and shared between the CLI and the desktop app — switching clusters in one affects the other.
