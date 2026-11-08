---
description: Move namespaces and their volume data to another cluster from Kube Inspector — live copy, a short final switch, what moves and what does not, and the status page afterwards.
---

# Cluster Migration

Cluster Migration copies one or more namespaces, with the data on their volumes,
to another cluster. The application keeps running while the data copies, and
stops only for the last difference at the end.

Open it from the **Cluster migration** row of the Toolbox tab, on the cluster
you are moving **from**.

## What you need

- Both clusters added to Kube Inspector.
- **Network between the clusters.** A pod on the source has to reach the target,
  either on the pod's IP or on a node address and NodePort. Kube Inspector tries
  them in that order.
- **Access on both clusters** to create pods, Jobs, Services and Secrets in those
  namespaces, and to scale their workloads. The check step names what is missing.
- **A Pod Security level below `restricted`** on those namespaces. The workers
  run as root, because copying a volume has to keep every file's owner.

There is nothing to install. Kube Inspector starts a worker on each side per
volume and removes them when the migration ends. The workers pull
`ghcr.io/opensourcemonkeys/kube-inspector-toolbox-migrator`; in a cluster that
cannot reach the public registry, mirror it and set the image in the first step.

## The steps

| Step | What happens | Is the application stopped? |
|---|---|---|
| **Choose** | The target cluster and the namespaces. | No |
| **Check** | Reads both clusters and reports what would move and what stands in the way. Writes nothing. | No |
| **Prepare** | Creates everything on the target, held back: workloads at zero replicas, CronJobs suspended. The API server judges every object here, before anything has stopped. | No |
| **Copy** | Copies each volume, then again every few minutes while this panel is open, so the last difference stays small. Closing the app does not interrupt a copy in progress. | No |
| **Final switch** | You start it. See below. | Yes, until the last copy finishes |
| **Status** | One page with what moved and how it stands now. | |

### The final switch

1. Workloads on the source scale to zero and CronJobs are suspended. What they
   had is written on each of them first.
2. Kube Inspector waits until no pod has a copied volume mounted. **The last copy
   does not start while anything can still write.** If something keeps starting
   those pods, such as Argo CD, Flux or an operator, the switch stops and names
   them, with nothing started on the target.
3. The last difference is copied, including deletions.
4. The workers are removed, and the application starts on the target with the
   replica counts it had.

If the switch stops part-way, the panel shows why. You can continue from that
step or, until the target has started, give up: the application starts again on
the source with its earlier replica counts. The app has to be open while the
switch runs.

## What moves, and what does not

Everything in the namespace moves, custom resources included, except:

| Not carried over | Why |
|---|---|
| Pods, ReplicaSets, Endpoints, Events, Leases | The cluster generates them |
| Anything with an owner | Its owner recreates it |
| One-off Jobs | They have already run, or belong to this cluster's moment |
| ServiceAccount tokens | They are only valid on this cluster |
| VolumeSnapshots, metrics | They only mean something on this cluster |
| Custom resources whose CRD the target lacks | The target could not store them |

**Cluster-level objects are reported, never created.** The check lists any
CRD, ClusterRole, ClusterRoleBinding, PriorityClass or IngressClass the namespaces
use and the target lacks; install those yourself.

A disk's storage class on the target is the one with the same name if there is
one, otherwise the target's default. You can choose another in the check step.

## When something already exists on the target

The check lists every object that already exists there. For each you choose to
keep the target's or overwrite it, and nothing is overwritten unless you say so.

**An existing PersistentVolumeClaim can only be kept.** Replacing a disk's content
could not be undone, so that disk is not copied and the workload on the target
uses what is on it.

## Afterwards

The status page lists each workload and whether it is ready, each disk, what was
skipped, and the addresses of LoadBalancer Services and Ingresses.

- **Traffic is yours to move.** Kube Inspector does not touch DNS or external load
  balancers; point them at the addresses listed.
- **The source stays stopped**, its data in place, until you decide. The page
  offers to start it with its earlier replica counts. If you do, both clusters
  run, and both write to anything they share.
- Nothing happens on its own after the switch.

## Security

- Credentials for one cluster are never stored in the other. The desktop app
  holds both kubeconfigs and does the writing with your own access.
- The workers' SSH keys are generated per migration, live only in a Secret in the
  namespace while it runs, and can run rsync and nothing else. Traffic between
  the clusters is encrypted by that connection.
- Secret values travel from the source API server through the app's memory to the
  target API server. They are not logged or written to the migration's saved
  record, which lives in `~/.kube-ins/migrations/`.

See also the [known limitations](../known-limitations.md#cluster-migration).
