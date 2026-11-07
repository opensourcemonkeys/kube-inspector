---
description: How Kube Inspector numbers its releases from 1.0 on, what an upgrade within 1.x keeps working, how toolbox fits in, the update channels, and which version receives fixes.
---

# Versioning and compatibility

From 1.0 on, Kube Inspector follows [Semantic Versioning](https://semver.org):
`MAJOR.MINOR.PATCH`.

| Release | What it may contain |
|---|---|
| Patch — 1.0.**1** | Fixes only, security fixes included. |
| Minor — 1.**1**.0 | New features and fixes. Nothing you rely on stops working. |
| Major — **2**.0.0 | Changes or removals. The [changelog](changelog.md) says what changed and how to adapt. |

A version with a suffix — `1.1.0-rc.1`, `0.21.0-beta` — is a prerelease of the
version it names.

## What an upgrade within 1.x keeps working

- **Your clusters.** A newer 1.x reads every kubeconfig an older 1.x saved in
  `~/.kube-ins/`, and the selected cluster (`.active`) and the update channel
  (`.channel`) carry over.
- **What the app has stored.** Vulnerability scan history and accepted risks
  (`~/.kube-ins/trivy-history/`, `~/.kube-ins/trivy-exceptions/`) are versioned
  records, and a newer 1.x reads every record an older 1.x wrote.
- **Your preferences** — theme, language, cluster colours, the events list, the
  assistant's conversations — are kept. When a release changes how one of them
  is stored it converts it, or, where a conversion would be wrong, starts that
  one afresh and says so in the changelog.

**Going back** within 1.x is possible by installing the older package over the
top; there is no in-app rollback. An older version is not promised to read what
a newer one wrote, and starts from defaults where it cannot.

**Which older packages stay downloadable.** The newest three releases of each
update channel stay at `https://kubeinspector.com/dist/` under their versioned
names (`kube-inspector-<version>-linux-amd64.deb` and so on, each with its
`.sha256` and the release's `SHA256SUMS-<version>`). When a release is
published, older ones are removed. The checksums of every release stay on its
GitHub release.

**Platform requirements may rise in a minor release** when Electron or Go drop
an operating system version. The changelog says so. The current list is under
[System requirements](getting-started/installation.md#system-requirements).

## toolbox

[toolbox](toolbox/index.md), the in-cluster recorder behind Cluster History,
has its own version line and is still a beta (`toolbox-v1.0.0-beta.*`). The
panels that depend on it are marked **Beta** in the app.

- A newer Kube Inspector keeps working with an older toolbox: what the older
  one cannot provide is hidden or explained, not an error.
- An older Kube Inspector against a newer toolbox is not promised while toolbox
  is in beta.
- What toolbox records, and its API, may still change between toolbox releases.

## Update channels

**Open ▸ Update channel** picks one:

| Channel | Receives |
|---|---|
| **stable** | Releases with no suffix. The default from 1.0 on. |
| **beta** | Every release — release candidates and betas first, and the stable ones too. |

If you never picked a channel, a 0.x install updated on *beta* — before 1.0
nothing else existed — and it moves to *stable* by itself once it runs 1.0.
Switching channel never downgrades you: a build ahead of its channel is offered
nothing until the channel catches up.

## Which version receives fixes

**Only the latest release.** Fixes, security fixes included, ship as a new
release on both channels, and the in-app updater offers it. There are no
long-term support branches: to receive a fix, update. How to report a
vulnerability is in the
[security policy](https://github.com/opensourcemonkeys/kube-inspector/blob/main/.github/SECURITY.md).
