# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting on this repository:

**<https://github.com/opensourcemonkeys/kube-inspector/security/advisories/new>**

That reaches the maintainers without disclosing anything. If the form is
unavailable to you, open a public issue containing only "I would like to report
a security issue privately" and no details, and a maintainer will get in touch.

Please include, as far as you can:

- the version (**Help ▸ About**, or **Help ▸ Diagnostics ▸ Overview**) and the
  platform;
- what an attacker can do, and what they need in order to do it (local user?
  another local account? a web page the user visits? a hostile cluster?);
- reproduction steps or a proof of concept.

This is a small volunteer project. Expect an acknowledgement within a few days
rather than within hours, and a fix in the next release rather than an
out-of-band one, unless the issue is being actively exploited.

We will credit you in the release notes unless you ask us not to.

## Supported versions

| Version | Supported |
|---|---|
| The latest release | ✅ Fixes land here |
| Anything older | ❌ Upgrade first |

There is no long-term support branch. Fixes ship in the next release on both the
`stable` and `beta` channels; from 1.0 on, releases follow semantic versioning,
so a security fix alone is a patch release (1.x.**y+1**) that the in-app updater
offers. See <https://kubeinspector.com/versioning/>.

## Threat model

What the application assumes, so you can tell a bug from a design decision.

### Trust boundary

**The user's own account is trusted.** Kubeconfigs live in `~/.kube-ins/`
(directory `0700`, files `0600`), the same posture as `~/.kube/`. Anything
running as the user can already read those files; the application does not try
to defend against that.

**Everything else on the machine is not.** In particular: other local accounts,
and any web page the user visits.

### Local network surfaces

All of them bind loopback. All of them are authenticated.

| Surface | Bind | Gate |
|---|---|---|
| RPC + `/events` (backend ↔ window) | `127.0.0.1`, **ephemeral** port | Per-process token, injected into the page rather than the URL so a cross-origin page cannot read it, plus an `Origin` check on both the HTTP endpoint and the WebSocket handshake |
| `/shell` channel (backend ↔ Electron main process) | same server | Same token and origin check |
| Multi-instance hub | `localhost:34200`, **fixed** | Shared token from `~/.kube-ins/.hubtoken` (`0600`), compared with `crypto/subtle`; `CheckOrigin` accepts an **empty** `Origin` only, which no browser ever sends. There is **no unauthenticated fallback** — if the token cannot be established the hub does not start |
| Port forwards | `127.0.0.1` only | None, by design: a tunnel is unauthenticated access to a cluster workload, which is exactly why it is never bound to any other address and why no setting changes that |

The hub is the sharpest edge, because its port is fixed and its payload
(a serialized panel) is expressive enough to be an injection vector. Registration
payloads are validated before they reach the client map, and the token check is
mandatory.

Three relaxations exist **only** behind the `kubeinsdev` build tag (pinned port,
no token check, loopback HTTP origins allowed) so that a Vite-served page can
talk to the backend in development. That tag appears in no `build-*` or `pkg-*`
target and in no release build.

### In scope

- Anything that lets a **web page**, another **local account**, or a process
  outside the user's session reach the RPC server, the shell channel or the
  instance hub.
- Path traversal or arbitrary file access through a cluster name, a panel
  parameter or an RPC argument.
- Sensitive data reaching a place the user did not choose: the diagnostics
  report, the log files, or an outbound request. The log files and the
  diagnostics blob are **redacted** (home path, cluster names, secrets, base64
  blobs, URLs) and that redaction failing is a valid report.
- The updater: the checksum verification, the download path, or the installer
  invocation being bypassable.
- A hostile Kubernetes API server, or hostile object content, causing anything
  worse than bad rendering.

### Out of scope

- **Unsigned builds.** There is no Apple Developer ID and no Windows
  Authenticode certificate, and the OS warnings are expected. Published SHA-256
  checksums cover integrity, not provenance. This is documented at
  <https://kubeinspector.com/getting-started/unsigned-builds/> and is a known
  limitation, not a vulnerability report.
- **Anything the kubeconfig already permits.** The application acts as you. If
  it can delete a workload, that is because your credentials can.
- **Reading `~/.kube-ins/` as the user who owns it**, or as root.
- Vulnerabilities in a dependency with no reachable path from this application
  — please report those upstream, though a note here is welcome if you believe
  we do reach it.
- The documentation site (`kubeinspector.com`) content itself, other than the
  release artifacts and checksums it serves.

### What runs inside a cluster

Both are optional and installed or started only when you ask for them.

- **The toolbox Helm chart (Cluster History).** Its ServiceAccount has `get`, `list` and `watch` on every resource, **Secrets included**, because it watches them to record changes; treat it as highly privileged. Secret values are reduced to hashes before anything is stored. Its REST API is read-only and guarded by one shared token in a Secret, so reading that Secret grants read access to the history.
- **Cluster Migration workers.** Short-lived root pods, one per volume, in the namespaces being migrated, removed when the migration ends. Their SSH keys are generated per migration, live in a namespace Secret while it runs, and are restricted to running rsync. Credentials for one cluster are never stored in the other: the desktop app does all writing with the user's own kubeconfig.

## Known advisories in dependencies

Scanners — `govulncheck`, `npm audit`, and Trivy pointed at our own binary —
report the advisories below. Each was reviewed and does not apply to Kube
Inspector, for the reason given. CI runs `govulncheck` on every check and fails
on any reachable finding that is not in this list
(`scripts/vulncheck/accepted.txt` is the machine-readable copy).

### `github.com/ollama/ollama` (Go)

Kube Inspector imports only the module's `api` package: the **client** that
talks to an Ollama server you run, for the AI assistant. Every advisory below
is in the Ollama **server** (`ollama serve`). The Go vulnerability database
records each one against the whole module, from version 0 and with no fixed
version — Ollama's Go module versions do not follow its app versions — so
`govulncheck` counts any call into the client as reaching it. Most also name
app versions years older than the module version we use (v0.40).

| ID | CVE | What it is | Why it does not apply |
|---|---|---|---|
| GO-2025-3557 | CVE-2025-0315 | Unbounded memory when a crafted GGUF model is uploaded (app ≤ 0.3.14) | Server-side model processing; the client never parses a model |
| GO-2025-3558 | CVE-2024-12055 | Out-of-bounds read parsing a crafted GGUF (app ≤ 0.3.14) | Same |
| GO-2025-3559 | CVE-2025-0317 | Divide by zero in `ggufPadding` (app ≤ 0.3.14) | Same |
| GO-2025-3582 | CVE-2025-0312 | Nil dereference on a crafted GGUF (app ≤ 0.3.14) | Same |
| GO-2025-3689 | CVE-2024-8063 | Divide by zero on a crafted `block_count` (app 0.3.3) | Same |
| GO-2025-3695 | CVE-2025-1975 | Server crash on a spoofed manifest during `/api/pull` (app 0.5.11) | The server fetches the manifest; the client only asks it to |
| GO-2025-3824 | CVE-2025-51471 | `server.auth.getAuthorizationToken` sends a token to a malicious registry realm (app 0.6.7) | In the server package; the client's pull request goes to your server, which talks to the registry |
| GO-2025-4251 | CVE-2025-63389 | Server API endpoints without authentication (app ≤ 0.12.3) | A property of the server you run, not of the client |

What *does* matter to you as an Ollama user: keep your Ollama server up to
date, and keep it bound to `localhost` (its default, and the assistant's default
host) unless you mean to expose it.

### DOMPurify (npm, vendored by Monaco)

`npm audit` reports DOMPurify ≤ 3.4.16 inside `monaco-editor` 0.57 (GHSA-p98j-92pf-mc4p,
GHSA-mrv2-3pqr-j5jr, GHSA-6688-9rhm-gjv2, GHSA-cg2g-xh64-v4q7, GHSA-c6gr-qvv4-5v3f).
Each needs a configuration Monaco never uses: `IN_PLACE` sanitisation (the first
three), `SAFE_FOR_TEMPLATES` (the fourth) or `PARSER_MEDIA_TYPE:
'application/xhtml+xml'` (the fifth). Monaco's sanitiser
(`vs/base/browser/domSanitize.js`) sets none of them — its default configuration
is an allow-list of tags and attributes — and Kube Inspector does not call
DOMPurify itself. The fix is to take a Monaco release that vendors a newer
DOMPurify; `npm audit fix --force` would instead *downgrade* Monaco.

## What the application sends

No telemetry, no analytics, no crash reporting. The complete outbound list —
update manifest, artifact downloads, the Trivy vulnerability database, and
Ollama if the AI assistant is used — is at
<https://kubeinspector.com/privacy/>.
