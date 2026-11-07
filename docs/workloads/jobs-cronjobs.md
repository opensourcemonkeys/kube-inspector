---
description: Inspect Kubernetes Jobs and CronJobs, their schedules and completion status, in Kube Inspector.
---

# Jobs & CronJobs

## Jobs

Jobs run a workload to completion. Kube Inspector lists all Jobs across namespaces.

### Columns

| Column | Description |
|---|---|
| Name | Job name |
| Namespace | Namespace |
| Completions | Successful / desired completions |
| Status | Active, Complete, Failed |
| Duration | How long the job ran (or has been running) |
| Age | Time since creation |

### Actions

- **View YAML** — Double-click to open the Job manifest. Jobs are read-only in Kube Inspector; to re-run, delete the Job and recreate it (or trigger the parent CronJob).
- **Delete** — Removes the Job and its completed/failed pods.

---

## CronJobs

CronJobs create Jobs on a schedule defined by a cron expression.

### Columns

| Column | Description |
|---|---|
| Name | CronJob name |
| Namespace | Namespace |
| Schedule | Cron expression (e.g. `0 * * * *`) |
| Last Schedule | When the last Job was triggered |
| Active | Number of currently active Jobs |
| Status | Active / Suspended |
| Age | Time since creation |

### Actions

Per-row actions live in the **⋮** menu at the end of the row: Describe,
Suspend or Resume, and Run now.

### Run now

**⋮ → Run now** creates one Job from the CronJob's template and starts it
immediately — the same Job `kubectl create job --from=cronjob/<name>` makes. It
is named `<cronjob>-manual-<suffix>`, carries the
`cronjob.kubernetes.io/instantiate: manual` annotation, and is owned by the
CronJob, so it appears under it in the Jobs list and counts toward its history
limits like a scheduled run.

It runs whatever the schedule says, and also when the CronJob is suspended or
its concurrency policy would forbid a second run. It asks for confirmation
first, and needs permission to create Jobs in that namespace. In the terminal
UI the same action is `T` on the CronJobs list.

### Suspend / Resume

**⋮ → Suspend** sets `spec.suspend: true`, which stops the CronJob creating new
Jobs. **⋮ → Resume** clears it. Both ask for confirmation, and the Status column
reflects the current state.

Suspending does **not** stop a Job that is already running, and missed schedules
are not made up when you resume — the next run is simply the next one due.

### Describe

**⋮ → Describe** opens `kubectl describe` output for the CronJob, including its
schedule, last-scheduled time, active Jobs and recent events. See
[Describe](../workspace/describe.md).

### View / Edit YAML

Double-click a row to open the full CronJob manifest. You can change the schedule, image, environment variables, or any other spec field, then click **Apply**.

### Delete

Deletes the CronJob. Active Jobs that were created by it are not automatically deleted — use the Jobs screen to clean those up if needed.

### View Logs

Opens a log panel for the most recently active pod spawned by this CronJob.
