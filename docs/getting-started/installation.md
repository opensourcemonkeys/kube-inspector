---
description: Install Kube Inspector, the free visual desktop client for Kubernetes, on Linux, macOS, or Windows.
---

# Installation

Kube Inspector ships as a self-contained application for **Linux, macOS and Windows**. It bundles its own browser engine, so there is **no WebView or WebKitGTK runtime to install** and nothing to set up by hand on any platform. On Linux the package names the system libraries it uses, and your package manager installs any that are missing.

## Download

Get the package for your platform from the [Downloads](../downloads.md) page:

| Platform | File |
|---|---|
| Linux — Debian / Ubuntu | `kube-inspector-<version>-linux-amd64.deb` |
| Linux — RHEL / Fedora | `kube-inspector-<version>-linux-x86_64.rpm` |
| macOS (Apple Silicon) | `kube-inspector-<version>-macos-arm64.dmg` |
| Windows | `kube-inspector-<version>-windows-amd64.exe` |

!!! tip "Verify before you install"
    Every release publishes a SHA-256 checksum beside each file. See
    [Verifying your download](verifying-downloads.md) — it takes a few seconds
    and the builds are unsigned, so it is the one integrity check available.

!!! note "One Linux build"
    Earlier releases shipped separate packages per distribution because the app used the system WebKitGTK library, whose version differs between distros. It now bundles its own browser engine, so **a single `.deb` and a single `.rpm` work everywhere**.

## Linux

Install with your package manager. It also pulls in any system library the app
needs that is missing — GTK 3, NSS, ALSA and the like, which a desktop install
almost always already has:

=== "Debian / Ubuntu"
    ```bash
    sudo apt install ./kube-inspector-<version>-linux-amd64.deb
    ```

=== "RHEL / Fedora"
    ```bash
    sudo dnf install ./kube-inspector-<version>-linux-x86_64.rpm
    ```

The `./` matters: without it `apt` and `dnf` look the name up in their
repositories. `dpkg -i` and `rpm -i` install nothing the package depends on; if
you used one and the app reports a missing `.so`, see
[Troubleshooting](../troubleshooting.md#the-app-will-not-start).

The application is installed to `/opt/kube-inspector` and linked as `/usr/bin/kube-inspector`, so you can launch it from the application menu or by running `kube-inspector`.

## macOS

Open `kube-inspector-<version>-macos-arm64.dmg` and drag **Kube Inspector** into your Applications folder.

!!! warning "Apple Silicon only"
    The macOS build targets Apple Silicon (M1 and later). Intel Macs are not supported by this build.

!!! note "Gatekeeper"
    The app is unsigned, so macOS may block the first launch. Right-click the app → **Open** and confirm, or allow it under **System Settings → Privacy & Security**.

## Windows

Run `kube-inspector-<version>-windows-amd64.exe` and follow the installation wizard.

!!! note "Windows SmartScreen"
    Windows may show a SmartScreen warning for unsigned binaries. Click **More info → Run anyway** to proceed.

## Requirements

- Network access to the target Kubernetes API server

Kube Inspector does **not** require `kubectl` to be installed — it communicates directly with the Kubernetes API using client-go. It also needs no system browser engine, GTK or WebView runtime.

## Supported Operating Systems

We build and test the platforms below. Other distributions will generally work, since the packages have no external dependencies, but they are not officially supported.

### Linux

`.deb` targets the Debian/Ubuntu family, `.rpm` the RHEL/Fedora family. There is no per-distribution variant to choose.

| Distribution | Versions | Package |
|---|---|---|
| Ubuntu | 22.04 LTS, 24.04 LTS | `.deb` |
| Debian | 11 (Bullseye), 12 (Bookworm) | `.deb` |
| Ubuntu derivatives (Mint, Pop!\_OS, elementary) | based on 22.04 / 24.04 | `.deb` |
| Fedora | 38 and later | `.rpm` |
| RHEL / AlmaLinux / Rocky Linux | 9.x, 10.x | `.rpm` |

### macOS

| Version | Notes |
|---|---|
| macOS 11 (Big Sur) and later | Apple Silicon only |

### Windows

| Version | Notes |
|---|---|
| Windows 11 (all builds) | Fully supported |
| Windows 10 (build 1803+) | Fully supported — no WebView2 runtime needed |

## First Launch

On first launch, Kube Inspector checks `~/.kube/config` automatically. If you already have clusters configured there, they will be importable from the cluster manager. See [Adding Clusters](cluster-setup.md) for details.
