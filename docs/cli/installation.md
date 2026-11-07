---
description: Install kube-inspector-cli, the webview-free Kubernetes terminal UI, on Linux, macOS, or Windows via package, binary, or from source.
---

# CLI Installation

The Kube Inspector CLI (`kube-inspector-cli`) is a single self-contained binary for **Linux, macOS and Windows** — there is nothing extra to install.

## Download

Grab the artifact for your platform from the [Downloads](../downloads.md#command-line-cli) page:

| Platform | File |
|---|---|
| Linux — portable binary | `kube-inspector-cli-<version>-linux-amd64.tar.gz` |
| Linux — Debian / Ubuntu | `kube-inspector-cli-<version>-linux-amd64.deb` |
| Linux — RHEL / Fedora | `kube-inspector-cli-<version>-linux-x86_64.rpm` |
| macOS (Universal) | `kube-inspector-cli-<version>-macos-universal.tar.gz` |
| Windows | `kube-inspector-cli-<version>-windows-amd64.exe` |

!!! tip "One Linux build for all distros"
    A single `.deb` / `.rpm` / tarball works on every x86-64 Linux distribution with glibc 2.34 or newer (Ubuntu 22.04+, Debian 12+, Fedora 35+, RHEL 9+). On macOS the binary is universal — Apple Silicon and Intel, macOS 13 Ventura or newer. The CLI is also much smaller than the desktop app, since it ships no browser engine.

## Linux

=== "Debian / Ubuntu (.deb)"
    ```bash
    sudo dpkg -i kube-inspector-cli-<version>-linux-amd64.deb
    # installs to /usr/bin/kube-inspector-cli
    kube-inspector-cli
    ```

=== "RHEL / Fedora (.rpm)"
    ```bash
    sudo rpm -Uvh kube-inspector-cli-<version>-linux-x86_64.rpm
    # installs to /usr/bin/kube-inspector-cli
    kube-inspector-cli
    ```

=== "Portable tarball"
    ```bash
    tar -xzf kube-inspector-cli-<version>-linux-amd64.tar.gz
    chmod +x kube-inspector-cli
    sudo mv kube-inspector-cli /usr/local/bin/   # or anywhere on your $PATH
    kube-inspector-cli
    ```

## macOS

```bash
tar -xzf kube-inspector-cli-<version>-macos-universal.tar.gz
chmod +x kube-inspector-cli
sudo mv kube-inspector-cli /usr/local/bin/
kube-inspector-cli
```

The binary is universal (Apple Silicon and Intel).

!!! note "Gatekeeper"
    The binary is unsigned, so macOS may block the first run. Allow it with:
    ```bash
    xattr -d com.apple.quarantine /usr/local/bin/kube-inspector-cli
    ```
    …or approve it under **System Settings → Privacy & Security**.

## Windows

Place `kube-inspector-cli-<version>-windows-amd64.exe` somewhere on your `PATH` (optionally rename it to `kube-inspector-cli.exe`) and run it from **Windows Terminal**, PowerShell, or `cmd`:

```powershell
.\kube-inspector-cli-<version>-windows-amd64.exe
```

!!! tip "Use a modern terminal"
    Run the CLI in **Windows Terminal** (or any VT-capable console) for correct colours and key handling. Interactive **pod exec** relies on a pseudo-terminal and works best there.

## Verify

The CLI shows its version in the top status bar. To confirm the binary runs, launch it — you should land on the **Clusters** screen. Press `?` for the keyboard help, and `q` to quit.

## Requirements

- A kubeconfig for at least one cluster, added through the CLI's **Clusters** screen (press `a`). Cluster configs live in `~/.kube-ins/` and are **shared with the desktop app** — clusters added in one are visible in the other.
- Network access to the target Kubernetes API server.

The CLI does **not** require `kubectl` — it talks to the Kubernetes API directly via client-go.

Next: [Usage & Shortcuts](usage.md).
