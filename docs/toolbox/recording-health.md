---
description: How well toolbox is recording — source webhooks, the leader, seven-day coverage and recording gaps, attribution mix and settings — as shown in Kube Inspector's Toolbox tab.
---

# Recording health

Under **Cluster history inspection** in the Toolbox tab, **Recording health**
says how complete the history is. It opens by itself when something needs
attention.

| Line | Says |
|---|---|
| **Admission webhook** | when the last request arrived; *Nothing in the last 24 hours* means users and groups are not being recorded |
| **Audit webhook** | the same for the audit log; when it is off or quiet, source IPs and user agents are not recorded |
| **Leader** | which toolbox pod is recording, for how long, and how many resource types it watches. *No leader* means nothing is being recorded right now |
| **Coverage (7 days)** | the share of the last week that was recorded, and the last gap |
| **Attributed via (24 h)** | how the last day's changes were matched to who made them |
| **Settings** | how long changes are kept, whether status-only updates are recorded, and what is excluded |

## Recording gaps

Only one toolbox pod records at a time (the others stand by). It writes a
heartbeat every 15 seconds. A **gap** is a stretch in which changes were never
seen:

- **Every change of the recording pod** — a failover to the standby, a
  restart, an upgrade. The new pod starts watching from the cluster as it is
  then, so whatever changed in between, even for 15 seconds, was not recorded.
- **A silence of more than 45 seconds** from the same pod — ClickHouse
  unreachable, the pod stalled — or no pod running at all.

Gaps appear where they happened: as a band in the Changes list, as a divider in
an object's timeline, hatched in the activity chart, and in the coverage line
above.

Coverage is counted from the first heartbeat toolbox kept, so a toolbox
upgraded from a release without heartbeats does not report its past as a gap.

## Why a change can appear late

toolbox writes each change once. When it cannot yet tell who made a change, it
waits about 90 seconds for the API server's audit batch before writing it with
what it found. Such changes show up a minute and a half after they happened,
in their place by time.

If the recording pod is killed outright while changes are waiting (out of
memory, a lost node), those up to 90 seconds of changes are lost; a normal
shutdown writes them first.
