---
description: Remove Kube Inspector from Linux, macOS or Windows, including the ~/.kube-ins directory that holds your saved kubeconfigs, logs and caches.
---

# Uninstall

Removing the application and removing its data are two separate steps. The
package manager never touches your data, so if you only want a clean reinstall,
stop after step 1.

!!! warning "`~/.kube-ins` holds your kubeconfigs"
    The cluster credentials you added inside the app live there, not in
    `~/.kube/`. Deleting it deletes them. Back it up first if those kubeconfigs
    exist nowhere else:

    ```bash
    tar czf kube-ins-backup.tar.gz -C ~ .kube-ins
    ```

## 1. Remove the application

=== "Debian / Ubuntu"
    ```bash
    sudo apt-get remove kube-inspector
    # or
    sudo dpkg -r kube-inspector
    ```

    This removes `/opt/kube-inspector`, the `/usr/bin/kube-inspector` symlink,
    the desktop entry and the icons.

    The terminal UI is a separate package:
    ```bash
    sudo apt-get remove kube-inspector-cli
    ```

=== "RHEL / Fedora"
    ```bash
    sudo dnf remove kube-inspector
    # or
    sudo rpm -e kube-inspector
    ```

    And the terminal UI, if installed:
    ```bash
    sudo dnf remove kube-inspector-cli
    ```

=== "macOS"
    Drag **Kube Inspector** from `/Applications` to the Trash, or:

    ```bash
    rm -rf "/Applications/Kube Inspector.app"
    ```

    If a previous update left one behind, remove that too:

    ```bash
    rm -rf "/Applications/Kube Inspector.app.old"
    ```

=== "Windows"
    **Settings → Apps → Installed apps → Kube Inspector → Uninstall**, or run
    `Uninstall Kube Inspector.exe` from the installation directory
    (`%LOCALAPPDATA%\Programs\kube-inspector` for the default per-user install).

If you installed the CLI as a portable binary rather than a package, just delete
it — `kube-inspector-cli` is a single self-contained file.

## 2. Remove your data

### `~/.kube-ins` — kubeconfigs, logs, caches, preferences

=== "Linux / macOS"
    ```bash
    rm -rf ~/.kube-ins
    ```

=== "Windows (PowerShell)"
    ```powershell
    Remove-Item -Recurse -Force "$env:USERPROFILE\.kube-ins"
    ```

What is in there:

| Path | Contents |
|---|---|
| `<cluster>.yaml` | **Your saved kubeconfigs, one per cluster.** |
| `.active` | Which cluster is selected. |
| `.channel` | Stable or beta update channel. |
| `.hubtoken` | Shared token for multi-instance discovery. |
| `.update-state` | Breadcrumb from the last update attempt. |
| `logs/` | Daily log files (also pruned automatically after 7 days). |
| `trivy-cache/` | The vulnerability database. Usually the largest item here. |

To reclaim space without losing your clusters, delete just the caches:

```bash
rm -rf ~/.kube-ins/trivy-cache ~/.kube-ins/logs
```

### Window state, theme, language and chat history

These live in the app's own browser-profile directory, which the package
manager does not remove:

=== "Linux"
    ```bash
    rm -rf ~/.config/kube-inspector
    ```

    Builds from before the Electron shell, and development builds, may also
    have left `~/.config/kube-inspector-electron` or `~/.config/kube-ins-dev-*`.

=== "macOS"
    ```bash
    rm -rf ~/Library/Application\ Support/kube-inspector
    rm -rf ~/Library/Caches/kube-inspector
    ```

=== "Windows (PowerShell)"
    ```powershell
    Remove-Item -Recurse -Force "$env:APPDATA\kube-inspector"
    ```

### What is *not* removed, ever

- `~/.kube/config` and anything else under `~/.kube/`. Kube Inspector reads it
  when you import a cluster and never writes to it.
- Anything in your clusters. Uninstalling the client changes nothing on the
  Kubernetes side. If you installed toolbox for Cluster History, remove it from
  each cluster yourself:
  [Turning it off and removing it](toolbox/history-install.md#turning-it-off-and-removing-it).

## Reinstalling later

Keeping `~/.kube-ins` is enough to come back to exactly the same clusters,
active selection and update channel. Install the package again and everything is
where you left it.
