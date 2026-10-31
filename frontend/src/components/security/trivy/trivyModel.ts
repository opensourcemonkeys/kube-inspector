import { models } from '../../../../wailsjs/go/models';
import type { YamlPanelDef } from '../../../contexts/TabContext';

// Pure helpers for the scan screen: exception payloads, the summary's
// arithmetic and where a workload's YAML opens. No React, no bindings.

/** Days an accepted risk lasts unless the user picks another date. */
export const DEFAULT_EXPIRY_DAYS = 90;

/** The last second of the local day `d` falls on, as RFC 3339 in UTC (Go's time.RFC3339 parses it). */
export function endOfDayRFC3339(d: Date): string {
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 0);
    return end.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Local midnight `DEFAULT_EXPIRY_DAYS` days after `now`. */
export function defaultExpiryDate(now: Date = new Date()): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + DEFAULT_EXPIRY_DAYS);
}

function exception(p: Partial<models.TrivyException>): models.TrivyException {
    return models.TrivyException.createFrom({
        id: '', kind: '', vulnerabilityId: '', imageRepo: '', checkId: '',
        workload: { kind: '', name: '', namespace: '' }, reason: '', createdAt: '', expiresAt: '', ...p,
    });
}

/** A vulnerability is accepted for its CVE in one image repository, whatever the tag. */
export function vulnException(row: models.TrivyVulnRow, reason: string, expiresAt: string): models.TrivyException {
    return exception({ kind: 'vuln', vulnerabilityId: row.vulnerabilityID, imageRepo: row.imageRepo, reason: reason.trim(), expiresAt });
}

/** A misconfiguration is accepted for one check on one workload. */
export function misconfigException(row: models.TrivyMisconfigRow, reason: string, expiresAt: string): models.TrivyException {
    return exception({
        kind: 'misconfig', checkId: row.checkID, reason: reason.trim(), expiresAt,
        workload: models.TrivyWorkloadRef.createFrom({ kind: row.resourceKind, name: row.resourceName, namespace: row.namespace }),
    });
}

/**
 * The exceptions that accept everything one fix-plan item would close.
 *
 * A package or base-OS item names its CVEs and images but not the image
 * repositories exceptions are scoped to, so those come from the view's rows:
 * one exception per (CVE, repository) that actually occurs in the item's
 * images and is not already accepted. A misconfiguration item gives one
 * exception per workload it names.
 */
export function fixItemExceptions(item: models.TrivyFixItem, vulns: models.TrivyVulnRow[], reason: string, expiresAt: string): models.TrivyException[] {
    if (item.kind === 'misconfig') {
        return (item.workloads ?? []).map((w) => exception({
            kind: 'misconfig', checkId: item.checkId, reason: reason.trim(), expiresAt,
            workload: models.TrivyWorkloadRef.createFrom({ kind: w.kind, name: w.name, namespace: w.namespace }),
        }));
    }
    const ids = new Set(item.vulnIds ?? []);
    const images = new Set(item.images ?? []);
    const seen = new Set<string>();
    const out: models.TrivyException[] = [];
    for (const r of vulns ?? []) {
        if (r.accepted || !r.imageRepo || !ids.has(r.vulnerabilityID) || !images.has(r.image)) continue;
        const k = `${r.vulnerabilityID}\x00${r.imageRepo}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(vulnException(r, reason, expiresAt));
    }
    return out;
}

type SevMap = Record<string, number> | null | undefined;

/** One severity's total over several severity → count maps, any of which may be nil from Go. */
export function sumSeverities(sev: string, ...maps: SevMap[]): number {
    return maps.reduce<number>((n, m) => n + (m?.[sev] ?? 0), 0);
}

/** cur − prev, or null when there is nothing to compare with. */
export function countDelta(cur: number, prev: number | null): number | null {
    return prev == null ? null : cur - prev;
}

/** The verdict's numbers: how many of the first fix items it names, and the critical+high findings they close. */
export function verdictParams(plan: models.TrivyFixItem[] | null): { topItems: number; closes: number } {
    const top = (plan ?? []).slice(0, 3);
    return {
        topItems: top.length,
        closes: top.reduce((n, it) => n + sumSeverities('CRITICAL', it.closes) + sumSeverities('HIGH', it.closes), 0),
    };
}

/** The scan a scan is compared with by default: the one before it (scans are newest first). */
export function defaultCompareId(scans: models.TrivyScanMeta[], scanId: string): string {
    const i = scans.findIndex((s) => s.id === scanId);
    return i >= 0 && i + 1 < scans.length ? scans[i + 1].id : '';
}

type YamlKind = YamlPanelDef['resourceKind'];

// Kinds with a typed YAML panel, and the sidebar view that titles its tab.
const TYPED: Record<string, { yaml: YamlKind; view: string }> = {
    Pod: { yaml: 'pod', view: 'pods' },
    Deployment: { yaml: 'deployment', view: 'deployments' },
    StatefulSet: { yaml: 'statefulset', view: 'statefulsets' },
    ReplicaSet: { yaml: 'replicaset', view: 'replicasets' },
    DaemonSet: { yaml: 'daemonset', view: 'daemonsets' },
    Job: { yaml: 'job', view: 'jobs' },
    CronJob: { yaml: 'cronjob', view: 'cronjobs' },
    Service: { yaml: 'service', view: 'services' },
    Ingress: { yaml: 'ingress', view: 'ingresses' },
    ConfigMap: { yaml: 'configmap', view: 'configmaps' },
    Secret: { yaml: 'secret', view: 'secrets' },
    ServiceAccount: { yaml: 'serviceaccount', view: 'serviceaccounts' },
    Role: { yaml: 'role', view: 'roles' },
    RoleBinding: { yaml: 'rolebinding', view: 'rolebindings' },
    Namespace: { yaml: 'namespace', view: 'namespaces' },
    PersistentVolumeClaim: { yaml: 'persistentvolumeclaim', view: 'persistentvolumeclaims' },
};

// Kinds the misconfig scan reports that have no typed panel: opened through
// the generic object YAML, addressed by group and resource.
const OBJECT: Record<string, { group: string; resource: string }> = {
    ClusterRole: { group: 'rbac.authorization.k8s.io', resource: 'clusterroles' },
    ClusterRoleBinding: { group: 'rbac.authorization.k8s.io', resource: 'clusterrolebindings' },
    NetworkPolicy: { group: 'networking.k8s.io', resource: 'networkpolicies' },
};

export type YamlTarget = { typed: { yaml: YamlKind; view: string } } | { object: { group: string; resource: string } };

/** Where a workload's YAML opens, or null for a kind the app cannot address. */
export function workloadYamlTarget(kind: string): YamlTarget | null {
    if (TYPED[kind]) return { typed: TYPED[kind] };
    if (OBJECT[kind]) return { object: OBJECT[kind] };
    return null;
}
