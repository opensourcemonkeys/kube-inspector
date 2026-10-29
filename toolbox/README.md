# toolbox

A Kubernetes controller that records every create, update and delete in a
cluster — **what** changed (a JSON patch with old and new values), **when**,
and **who** did it **from where** (user, groups, impersonation, source IP,
user agent, field manager) — into ClickHouse, and serves that history over a
REST API. Kube Inspector is its UI; there is no web UI of its own.

## How it works

Kubernetes has no single place that knows both what changed and who changed
it, so toolbox joins three sources:

| Source | Gives | Works on |
|---|---|---|
| **Informers** (dynamic, every resource incl. CRDs) | the persisted change: before/after, diff, resourceVersion, field manager | every cluster |
| **Validating admission webhook** (always allows) | user, UID, groups, extra; the object about to be written | every cluster, incl. managed |
| **Audit webhook receiver** (`/audit`) | source IPs, user agent, impersonation, response code, and the exact resourceVersion a write produced | clusters where you can configure kube-apiserver |

```
kube-apiserver ──audit webhook──────────────▶ /audit      ─┐ hints (user, IP, UA, RV)
kube-apiserver ──ValidatingWebhook (allow)──▶ /admission  ─┤ hints (user, groups, content hash)
                                                            ▼
                                       ClickHouse: actor_hints, audit_raw
informers (leader) ── old/new ──▶ diff ──▶ correlator ──▶ changes
REST API (every replica)  ◀── ClickHouse
```

The informer is the source of truth for *what* was persisted. Each change waits
`enrich.delay` (default 15s, so the API server's audit batch has arrived) and is
then matched to a hint, strongest rule first:

1. **audit, exact** — same object and the resourceVersion the write produced
   (audit level `RequestResponse`);
2. **admission, exact** — same object and the same content hash (UID for a
   delete); an audit hint from the same user then adds IPs and user agent;
3. **audit, by time** — same object and verb, nearest in time (audit level
   `Metadata`, e.g. Secrets and ConfigMaps);
4. **admission for subresources** (`kubectl scale`), nearest in time;
5. otherwise the **managedFields** manager whose entry this write re-stamped.

The final removal of an object whose deletion was requested earlier
(`finalized`) is attributed to a later DELETE of it, e.g. the kubelet ending a
pod's graceful delete; when finalizers ran out there is none, and it stays
unattributed unless audit names the exact write.

Rules 3 and 4 are decided over everything that is waiting, closest pairs
first, including changes not yet due: a hint is never spent on an earlier
change when a later one sits closer to it.

The `attribution` column says which one applied (`audit`, `admission`,
`managedFields`, `none`). A change still unattributed is held and retried once
after `enrich.retryAfter`, then written with whatever was found: every change is
written exactly once, so it shows up 15s after it happened when a hint matches
and about 90s after when none does. (`changes` is still a `ReplacingMergeTree`,
which is what makes rows from an older release, which re-wrote such changes,
read correctly with `FINAL`.)

Every replica serves the API and both webhooks; only the Lease-elected leader
watches and writes changes.

**Kubeconfig files never reach the API server.** What is recorded is the
identity a kubeconfig authenticates as: a client certificate's CN/O, a token's
user or ServiceAccount, OIDC claims (`extra`), plus the client's user agent.

## Install

```bash
helm install toolbox oci://ghcr.io/opensourcemonkeys/charts/kube-inspector-toolbox -n toolbox --create-namespace \
  --set clusterName=prod \
  --set audit.service.clusterIP=10.96.200.200   # a free IP in your service CIDR
```

(From a checkout, `deploy/helm/toolbox` works in place of the OCI reference.)

This runs toolbox (2 replicas) and a single-node ClickHouse. To use your own
ClickHouse: `--set clickhouse.enabled=false --set externalClickhouse.addr[0]=ch:9000`
(plus `externalClickhouse.existingSecret` for the password).

The admission webhook works immediately. The **audit webhook** must be wired
into kube-apiserver on each control-plane node — the chart's NOTES print the
exact steps. In short: install `deploy/helm/toolbox/files/audit-policy.yaml`,
write a webhook kubeconfig pointing at `https://<audit ClusterIP>/audit` with
the CA from the `toolbox-tls` Secret and the `audit-token` from the `toolbox`
Secret, and add `--audit-policy-file`, `--audit-webhook-config-file` and
`--audit-webhook-batch-max-wait=5s`. The CA is created once and never rotated,
so this is a one-time step.

### Managed clusters (EKS, GKE, AKS)

The API server's audit configuration is not yours to change, so there are no
source IPs or user agents. Users and groups are still attributed through the
admission webhook.

## API

All endpoints are `GET` and need the `X-Toolbox-Token` header (or
`Authorization: Bearer`) with the `api-token` from the `toolbox` Secret. The
custom header exists so Kube Inspector can call through the API server's
service proxy (`/api/v1/namespaces/toolbox/services/toolbox:http/proxy/...`)
with the user's own credentials — the proxy consumes `Authorization`.

| Endpoint | |
|---|---|
| `/api/v1/info` | cluster name and version |
| `/api/v1/changes` | newest first. Filters: `cluster` (`*` = all), `group` (`core` = ""), `resource`, `kind`, `namespace`, `name`, `uid`, `user`, `verb`, `attribution`, `path` (JSON pointer prefix), `q`, `since`/`until` (RFC 3339 or a duration like `24h`), `limit`, `cursor`, `objects=true` |
| `/api/v1/changes/stream` | new changes as Server-Sent Events (`event: change`), same filters as `/changes` without `since`/`until`; a `: keepalive` comment every 15s. Each poll looks back `enrich.delay + enrich.retryAfter + 1m` and sends what this stream has not sent, so a change written late still arrives; clients de-duplicate by `eventId` |
| `/api/v1/changes/{eventId}` | one change with `before`/`after` |
| `/api/v1/objects/{group}/{version}/{resource}/{namespace}/{name}/history` | one object's timeline (`core` for the empty group, `_` for cluster-scoped) |
| `/api/v1/attempts` | audited requests that failed, newest first (`minCode`, default 400; `limit`, `cursor`) |
| `/api/v1/stats` | counts per bucket/verb, top resources/users/namespaces, and totals (changes, deletes, unattributed, refused writes) for the period and the one of equal length before it (`since`, `until`, `namespace`, `bucket`; at most 2000 buckets) |
| `/api/v1/users` | actors with change counts (total and per verb), last seen, IPs, user agents |
| `/api/v1/gaps` | stretches with no recording leader in `since`..`until` (default the last 7 days), with the recorded share |
| `/api/v1/health` | one report: last hint per source, leader lease, newest heartbeat, 7-day coverage, attribution mix of the last 24h, and what this release records |
| `/healthz`, `/readyz`, `/metrics` | unauthenticated |

`patch` is an RFC 6902 patch in invertible form: every `replace`/`remove` is
preceded by a `test` op holding the old value.

## Security notes

- The ClusterRole can **read every object, Secrets included** — it has to, to
  watch them. Secret `data`/`stringData` and the
  `last-applied-configuration` annotation are reduced to `sha256:` prefixes
  before storage, so a diff shows *that* a key changed, not to what.
- `/audit` requires the audit token. `/admission` cannot be authenticated
  portably; a pod that can reach port 9443 could forge admission hints and
  mis-attribute a change. Audit attribution, when present, wins over admission.
  Restrict the port with a NetworkPolicy if your CNI can name the
  control-plane nodes.
- The admission webhook uses `failurePolicy: Ignore` and always allows: toolbox
  being down never blocks the cluster.

## Recording gaps

The leader writes a heartbeat to `recorder_heartbeats` every
`recorder.heartbeatInterval` (15s) while it watches. Consecutive heartbeats
further apart than `recorder.gapThreshold` (45s — above the 15s lease plus a
hand-over, so an ordinary failover is not a gap), or none since the newest one,
are reported as gaps by `/api/v1/gaps` and `/api/v1/health`. Heartbeats are kept
30 days. Coverage is counted from the first heartbeat ever kept, so a toolbox
upgraded from a release without heartbeats does not report its past as a gap.

## Overview statistics

`/api/v1/stats` reads whole hours from `changes_hourly`, a `SummingMergeTree`
that a materialized view fills on every insert into `changes` (counts per
hour, namespace, verb, attribution, resource and actor), and only the partial
hours at the window's edges from `changes` itself. Windows shorter than a day,
columns narrower than an hour, and windows reaching back before the rollup
existed (`rollup_state`: it starts empty on upgrade; nothing is back-filled)
are read from `changes` alone. On 50M rows (`make bench-store`) the 7- and
90-day overview went from 4.9s and 7.5s to 0.4s.

## Known limitations

- A change waiting for its retry is in the leader's memory only: a leader
  killed outright (OOM, node loss) loses up to `enrich.retryAfter` of
  unattributed changes. A graceful shutdown writes them first.

- Changes made while no leader is running are not seen by the informers (they
  still appear in `audit_raw` if audit is wired). There is no catch-up on
  restart; such a stretch is reported as a recording gap.
- Objects created in the first `discoveryInterval` (1m) after a new CRD is
  installed are missed as creates.
- The informer cache holds every watched object (managedFields trimmed); size
  the memory limit to the cluster, or narrow `watch.include`.
- `deletecollection` requests are listed in `audit_raw` but the resulting
  deletes are attributed by time, not by request.

## Releases

A `toolbox-v<semver>` tag runs `.github/workflows/toolbox.yml`: tests, then a
linux/amd64 + linux/arm64 image `ghcr.io/opensourcemonkeys/kube-inspector-toolbox:<semver>` and
the chart `oci://ghcr.io/opensourcemonkeys/charts/kube-inspector-toolbox` at the same version
(`appVersion` too). GHCR creates new packages private; make both public once
after the first release so `helm install` works without a login.

## Development

```bash
make test         # unit tests (race detector)
make test-store   # store tests against a throwaway ClickHouse container
make bench-store  # read latency on 50M synthetic rows (TOOLBOX_BENCH_ROWS to change)
make helm-lint
make e2e          # kind cluster with audit wired in, real kubectl --as writes, API assertions
```

Layout: `cmd/toolbox` (wiring), `internal/{watcher,discovery}` (informers),
`internal/{admission,auditsink}` (webhooks), `internal/correlate` (matching),
`internal/diff` (sanitise/redact/patch/hash), `internal/store` (ClickHouse,
migrations in `internal/store/migrations`), `internal/api`
(REST API), `internal/certs` (self-signed webhook TLS), `deploy/helm`.

To move it to its own repository: copy this directory and run
`go mod edit -module <new path>` plus a search-and-replace of
`github.com/kubeinspector/toolbox` in imports.
