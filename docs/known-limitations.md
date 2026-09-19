---
description: What Kube Inspector deliberately does not do in beta — unsigned builds, Apple Silicon only, no update rollback, machine-translated locales, port-forward and scanner constraints.
---

# Known limitations

This page is the honest list. Everything below is either a deliberate decision
or a known gap — none of it is worth a bug report, though the reasoning behind
any of it is fair game to raise on the
[issue tracker](https://github.com/opensourcemonkeys/kube-inspector/issues).

If what you are seeing is *not* on this page, it probably is a bug:
[report it](support.md).

## Distribution

**The builds are not code-signed.** No Apple Developer ID, no Windows
Authenticode certificate. macOS Gatekeeper blocks the first launch and Windows
SmartScreen warns; both need a manual override. The published SHA-256 checksums
prove the file arrived intact — they do not prove who built it. See
[Unsigned builds](getting-started/unsigned-builds.md). Signing is on the roadmap
for 1.0.

**macOS is Apple Silicon only.** Releases up to v0.11.0 shipped a universal
binary; since then the dmg targets `arm64` alone. A universal build would embed
two copies of a ~262 MB Go binary. Intel Macs are not supported.

**The Windows installer is not cleaned up.** The in-app updater downloads a
~190 MB installer into `%TEMP%` and NSIS does not remove it afterwards. Delete
it by hand if you are short on disk.

## Updates

**There is no rollback.** The updater notices when an update was handed to an
installer and did not take effect — the next launch says so — but it cannot undo
one that succeeded. To go back, install the older package over the top from
[Downloads](downloads.md).

**Switching from beta to stable does not downgrade you.** If you are running a
build that is ahead of the stable channel, choosing *stable* simply means you
are offered nothing until stable catches up. The channel submenu says so where
you make the choice.

**macOS has a brief window where a failed swap leaves the app parked.** The
update helper runs after the app quits and replaces the bundle with two moves.
If it dies between them, the previous version is at
`/Applications/Kube Inspector.app.old`. One command recovers it:

```bash
mv "/Applications/Kube Inspector.app.old" "/Applications/Kube Inspector.app"
```

## Port forwarding

**A forward pinned to a Pod does not reconnect.** Workload and Service targets
re-resolve their pod and reconnect with backoff, which is what lets a tunnel
survive a rolling restart. A Pod target does not, because silently moving to a
different pod would answer a question you did not ask.

**Reconnection gives up after five attempts.** The row stays in the panel with
status `error` and the reason; the **Restart** button rebuilds it on the same
local port.

**Forwards are loopback-only, always.** They bind `127.0.0.1` and there is no
setting that changes it — a forwarded port is unauthenticated access to a
cluster workload. Sharing one on your LAN is deliberately not offered.

**"Open in browser" is guessed from the port number alone**, not the port name.
A port named `metrics` on 9091 gets no browser button. **Copy address** is
always there.

**Each process owns its own tunnels.** A second window of the same app shares
them; a second *instance*, the standalone CLI, and CLI Mode inside the GUI each
have their own registry and cannot see the others'. Closing the CLI Mode overlay
kills the process behind it, and its forwards with it.

## Workloads and resources

**Nodes cannot be deleted.** Deleting a Node object is a destructive topology
operation, and the app already offers cordon and drain, which is what the
situation usually calls for. Use `kubectl` if you genuinely need to remove one.

**Scaling does not fight an HPA.** If a HorizontalPodAutoscaler targets the
workload, the Scale dialog warns you and still lets you proceed — the autoscaler
will move the replica count back on its next reconcile. That is Kubernetes
behaving correctly, not the scale failing.

**Resource lists are cluster-wide.** Most views list across all namespaces,
which requires a ClusterRole. A user with only a namespaced Role sees a
`forbidden` banner even where `kubectl -n their-namespace` works.

**The Terminal panel is a local shell, not an in-cluster session.** It needs
`kubectl` installed on your machine. The rest of the app does not.

## Metrics and scanning

**CPU and memory need
[metrics-server](https://github.com/kubernetes-sigs/metrics-server).** The app
does not sample usage itself. Without metrics-server the Monitoring dashboard
and every usage column are empty.

**Monitoring trends are built while the panel is open.** metrics-server serves
point-in-time values only, so the time series is accumulated client-side and
lives in memory. It starts empty, fills in as the dashboard polls, and is not
persisted across restarts.

**Vulnerability scanning needs network access on first use.** Trivy downloads
its vulnerability database into `~/.kube-ins/trivy-cache/`; a scan started
offline with a cold cache fails. Images in private registries are not scannable
— the app does not collect registry credentials.

**Cluster scanning is image-by-image.** The scanner lists pod images and scans
each one; there is no cluster misconfiguration scan.

## Languages

**Four of the six catalogs are machine-translated.** English is the source of
truth and Turkish was reviewed by a native speaker. **German, Russian, Chinese
and Japanese were produced from English by machine and have not been read by
anyone who speaks the language.** Placeholders and markup are verified
mechanically; the wording is not. The app says so in the language submenu.

Corrections are the easiest contribution this project takes — see
[Translations](contributing/translations.md).

## Windows and panels

**Terminal and exec panels cannot be moved between windows or instances.** A
live pty belongs to the process that started it. Every other panel type can be
dragged out, undocked, or sent to another instance.

**Instances older than v0.16 cannot see newer ones.** Multi-instance discovery
now requires a shared token in `~/.kube-ins/.hubtoken`; there is deliberately no
unauthenticated fallback, so a mixed-version pair of running instances will each
report being alone.

## Related

- [Troubleshooting](troubleshooting.md)
- [FAQ](faq.md)
- [Support](support.md)
