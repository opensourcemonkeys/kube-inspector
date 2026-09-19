---
description: Kube Inspector collects no telemetry, no analytics and no crash reports. The complete list of what the app sends, what stays on your machine, and what the docs site does.
---

# Privacy

**Kube Inspector has no telemetry.** No analytics, no crash reporting, no usage
statistics, no "anonymous" identifiers, no phone-home on launch. There is no
setting to turn off, because there is nothing running.

This page lists every outbound request the app can make, what stays local, and
where the boundary is.

## What the app sends

Four requests, and nothing else. Three of them only happen because you asked for
something.

| # | Request | When | What it carries |
|---|---|---|---|
| 1 | `GET https://kubeinspector.com/version.json` (or `version-beta.json`) | Update check | Nothing beyond a plain HTTP GET — no version, no identifier, no query string, no custom headers. The version comparison happens locally. |
| 2 | Artifact download from `kubeinspector.com/dist/` | You accept an update, or click a download link | The artifact path. |
| 3 | Trivy vulnerability database | You run a vulnerability scan and the local cache is cold or stale | Whatever Trivy's own database fetch sends. The **image names you scan are not uploaded** — scanning is local, against the downloaded database. |
| 4 | `registry.ollama.ai` and your Ollama host | Only if you use the AI assistant | Model catalog and download traffic for the registry; your prompts and the tool results go to **your** Ollama host, which is `http://localhost:11434` by default. |

Requests 3 and 4 exist only if you use those features. An install that never
opens the scanner or the assistant makes exactly one kind of outbound request:
the update check.

!!! note "Turning off the update check"
    There is no toggle. If you need an installation that never reaches the
    network, block `kubeinspector.com` at the firewall — the check is
    best-effort and a failed one is silent.

## What never leaves your machine

- **Kubeconfigs.** Stored in `~/.kube-ins/` (directory mode `0700`, files
  `0600`). Read by the app, never transmitted anywhere except to the API server
  they authenticate against.
- **Cluster data.** Every pod, secret, log line and YAML document you look at
  travels between your machine and your cluster's API server, and nowhere else.
- **Logs.** `~/.kube-ins/logs/`, deleted after 7 days. Nothing uploads them.
- **The AI assistant's conversation.** It runs against a local Ollama server.
  Prompts, cluster data pulled in by tools, and replies stay between the app and
  that host. If you point it at a remote Ollama, that is where they go — your
  choice, your host.
- **Your preferences.** Theme, language, update channel, open panels, the events
  list and the assistant's history live in local application storage and in
  `~/.kube-ins/`.

## Local network surfaces

The app runs local servers. All of them are bound to loopback and
authenticated:

| Surface | Bind | Authentication |
|---|---|---|
| RPC + event server (backend ↔ window) | `127.0.0.1`, ephemeral port | Per-process token injected into the page, plus an `Origin` check |
| Multi-instance hub | `localhost:34200` (fixed) | Shared token from `~/.kube-ins/.hubtoken` (`0600`), compared in constant time; empty-`Origin` only, so no browser can connect |
| Port forwards you start | `127.0.0.1` only | None — this is a tunnel into your cluster, which is why it is loopback-only with no option to change it |

Nothing off the machine can reach any of these.

## Diagnostics are manual and redacted

The diagnostics report is never sent anywhere. You copy it to your clipboard, or
save a zip, and decide what to do with it.

Before it reaches your clipboard the Go side scrubs, in this order: your home
directory path, cluster names, secret-looking values, base64 blobs and URLs. API
server addresses are removed; cluster names appear as a hash, enough to tell two
of them apart. The counts and the health-check outcomes survive; the identities
do not.

Two things are added on the client side and do **not** pass through that
redactor: the error message you are currently looking at, and any UI crash
stacks. Skim the blob before you paste it into a public issue — it is short.

See [Troubleshooting ▸ Collecting diagnostics](troubleshooting.md#collecting-diagnostics-for-a-bug-report).

## This website is not the app

**kubeinspector.com uses Google Analytics** (property `G-707GCW6202`), like most
documentation sites. That is this site, in your browser — it has nothing to do
with the desktop application, which contains no analytics of any kind.

The download and update endpoints served from this domain are subject to
ordinary web server logging by the host.

## Data you can delete

Everything the app keeps is under one directory:

```bash
rm -rf ~/.kube-ins        # kubeconfigs, logs, caches, preferences
```

That directory holds the **kubeconfigs you added** — deleting it removes them.
It does not touch `~/.kube/`. See [Uninstall](uninstall.md) for the full
removal, including in-app storage.

## Questions

If something on this page is unclear or looks wrong, open an issue — see
[Support](support.md). Security concerns go through
[the security policy](https://github.com/opensourcemonkeys/kube-inspector/blob/main/.github/SECURITY.md)
instead of a public issue.
