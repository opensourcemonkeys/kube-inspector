import type { ClusterGraph, ResourceNode } from './graphLayout';

/**
 * Blast radius: what happens to everything else if one object is deleted, or
 * stops working. Pure, over the raw graph (kinds hidden from the view still
 * count), so every rule below has a test.
 *
 * Four levels, worst wins when an object is reached more than one way:
 *   removed          deleted along with the target (owner cascade, a volume)
 *   breaks           stops working now (a Service with no endpoints left)
 *   breaksOnRestart  keeps running, fails the next time it starts — a pod
 *                    whose ConfigMap is gone, a Deployment whose rollouts will
 *   degraded         loses capacity, or a short outage while a controller
 *                    recreates what was deleted
 * Data loss is a separate flag: it is what decides whether a delete is safe.
 *
 * Propagation runs in the order failures travel: the target's direct effect
 * on pods, then their owners, then the Services selecting them, then the
 * Ingresses in front of those.
 */

export type ImpactMode = 'delete' | 'fail';
export type ImpactLevel = 'removed' | 'breaks' | 'breaksOnRestart' | 'degraded';
export const IMPACT_LEVELS: ImpactLevel[] = ['removed', 'breaks', 'breaksOnRestart', 'degraded'];

const SEVERITY: Record<ImpactLevel, number> = { removed: 4, breaks: 3, breaksOnRestart: 2, degraded: 1 };

export interface ImpactReason { code: string; params?: Record<string, string | number> }

export interface Impact {
    level: ImpactLevel;
    reasons: ImpactReason[];
    /** Deleted, but its owner will recreate it. */
    recreated?: boolean;
    dataLoss?: boolean;
}

export interface ImpactResult {
    impacts: Map<string, Impact>;
    /** Facts about the target itself (recreated by its owner, data kept, …). */
    notes: ImpactReason[];
    dataLoss: boolean;
}

// What the graph, the impact panel and the delete dialogs print for a kind:
// the API kind, except where it is too long for a 220px box.
const SHORT_KIND: Record<string, string> = { PersistentVolumeClaim: 'PVC', PersistentVolume: 'PV' };
export const kindShortLabel = (kind: string) => SHORT_KIND[kind] ?? kind;

const CONTROLLERS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']);

// How a pod is affected, internally: 'transient' is a pod deleted while its
// owner will recreate it — gone for a moment, not for good.
type PodLoss = 'removed' | 'transient' | 'breaks' | 'breaksOnRestart';

function index(graph: ClusterGraph) {
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const children = new Map<string, string[]>();   // owner -> owned
    const parents = new Map<string, string[]>();    // owned -> owners
    const selects = new Map<string, string[]>();    // Service -> pods
    const routes = new Map<string, string[]>();     // Ingress -> Services
    const users = new Map<string, Array<{ id: string; optional: boolean; kind: string }>>(); // target -> who depends on it
    const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
        const arr = m.get(k);
        if (arr) arr.push(v); else m.set(k, [v]);
    };
    for (const e of graph.edges) {
        switch (e.kind) {
            case 'owner': push(children, e.source, e.target); push(parents, e.target, e.source); break;
            case 'selector': push(selects, e.source, e.target); break;
            case 'ingress': push(routes, e.source, e.target); break;
            case 'config':
            case 'storage': push(users, e.target, { id: e.source, optional: !!e.optional, kind: e.kind }); break;
        }
    }
    const descendants = (id: string): string[] => {
        const out: string[] = [];
        const queue = [...(children.get(id) ?? [])];
        const seen = new Set<string>();
        while (queue.length) {
            const cur = queue.shift()!;
            if (seen.has(cur)) continue;
            seen.add(cur);
            out.push(cur);
            queue.push(...(children.get(cur) ?? []));
        }
        return out;
    };
    const ancestors = (id: string): string[] => {
        const out: string[] = [];
        const queue = [...(parents.get(id) ?? [])];
        const seen = new Set<string>();
        while (queue.length) {
            const cur = queue.shift()!;
            if (seen.has(cur)) continue;
            seen.add(cur);
            out.push(cur);
            queue.push(...(parents.get(cur) ?? []));
        }
        return out;
    };
    return { byId, children, parents, selects, routes, users, descendants, ancestors };
}

const isPod = (n?: ResourceNode) => n?.kind === 'Pod';
const ref = (n: ResourceNode) => ({ kind: n.kind, name: n.namespace ? `${n.namespace}/${n.name}` : n.name });

export function simulateImpact(graph: ClusterGraph, targetId: string, mode: ImpactMode): ImpactResult {
    return simulateImpactMany(graph, [targetId], mode);
}

/**
 * The blast radius of several objects going at once — a multi-row delete.
 * Simulated together rather than merged afterwards: two pods behind one
 * Service each only degrade it, but deleting both leaves it with nothing.
 * The targets themselves are never listed as affected.
 */
export function simulateImpactMany(graph: ClusterGraph, targetIds: string[], mode: ImpactMode): ImpactResult {
    const g = index(graph);
    const impacts = new Map<string, Impact>();
    const notes: ImpactReason[] = [];
    // Each lost pod remembers which target took it, for the reason text.
    const podLoss = new Map<string, PodLoss>();
    const podWhy = new Map<string, ReturnType<typeof ref>>();
    const result: ImpactResult = { impacts, notes, dataLoss: false };
    const targetSet = new Set(targetIds);
    const targets = targetIds.map(id => g.byId.get(id)).filter((n): n is ResourceNode => !!n);
    if (!targets.length) return result;
    let why = ref(targets[0]);

    const note = (n: ImpactReason) => {
        const key = JSON.stringify(n);
        if (!notes.some(x => JSON.stringify(x) === key)) notes.push(n);
    };
    const mark = (id: string, level: ImpactLevel, reason: ImpactReason, extra?: Partial<Impact>) => {
        if (targetSet.has(id)) return;
        const cur = impacts.get(id);
        if (!cur) {
            impacts.set(id, { level, reasons: [reason], ...extra });
            return;
        }
        if (SEVERITY[level] > SEVERITY[cur.level]) cur.level = level;
        if (!cur.reasons.some(r => r.code === reason.code)) cur.reasons.push(reason);
        if (extra?.dataLoss) cur.dataLoss = true;
        if (extra?.recreated && cur.level === 'removed') cur.recreated = true;
    };
    const losePod = (id: string, loss: PodLoss) => {
        const order: Record<PodLoss, number> = { removed: 4, breaks: 3, transient: 2, breaksOnRestart: 1 };
        const cur = podLoss.get(id);
        if (!cur || order[loss] > order[cur]) {
            podLoss.set(id, loss);
            podWhy.set(id, why);
        }
    };
    // Pods (and claims, service accounts) that depend on the target.
    const dependents = (id: string, includeOptional = false) =>
        (g.users.get(id) ?? []).filter(u => includeOptional || !u.optional);

    // A claim's loss reaches the pods that mount it.
    const claimLost = (pvcId: string, level: 'breaks' | 'breaksOnRestart', code: string) => {
        mark(pvcId, level, { code, params: why });
        for (const u of dependents(pvcId)) {
            if (isPod(g.byId.get(u.id))) {
                mark(u.id, level, { code, params: why });
                losePod(u.id, level);
            }
        }
    };

    // ── Seeds ─────────────────────────────────────────────────────────────
    const hasPods = (id: string) => g.descendants(id).some(d => isPod(g.byId.get(d)));
    // Every target's descendants: the seeds account for them.
    const targetDescendants = new Set<string>();
    const svcLevel = new Map<string, ImpactLevel>();

    for (const target of targets) {
        const targetId = target.id;
        why = ref(target);
        const recreatedTarget = mode === 'delete' && (g.parents.get(targetId)?.length ?? 0) > 0;
        if (recreatedTarget) note({ code: 'recreatedByOwner' });
        const descendants = g.descendants(targetId);
        for (const d of descendants) targetDescendants.add(d);
        if (target.kind === 'Service') svcLevel.set(targetId, mode === 'delete' ? 'removed' : 'breaks');

        switch (target.kind) {
            case 'Deployment': case 'StatefulSet': case 'DaemonSet': case 'ReplicaSet':
                for (const d of descendants) {
                    const node = g.byId.get(d);
                    if (mode === 'delete') {
                        mark(d, 'removed', { code: 'cascade', params: why }, { recreated: recreatedTarget || undefined });
                        if (isPod(node)) losePod(d, recreatedTarget ? 'transient' : 'removed');
                    } else if (isPod(node)) {
                        mark(d, 'breaks', { code: 'ownerFailed', params: why });
                        losePod(d, 'breaks');
                    } else if (hasPods(d)) {
                        // A ReplicaSet scaled to zero (rollout history) has nothing to fail.
                        mark(d, 'breaks', { code: 'ownerFailed', params: why });
                    }
                }
                break;
            case 'Pod':
                losePod(targetId, mode === 'fail' ? 'breaks' : recreatedTarget ? 'transient' : 'removed');
                break;
            case 'ConfigMap': case 'Secret':
                for (const u of dependents(targetId)) {
                    const user = g.byId.get(u.id);
                    if (isPod(user)) {
                        mark(u.id, 'breaksOnRestart', { code: 'missingConfig', params: why });
                        losePod(u.id, 'breaksOnRestart');
                    } else if (user?.kind === 'Ingress') {
                        mark(u.id, 'degraded', { code: 'tlsMissing', params: why });
                    } else if (user) {
                        mark(u.id, 'breaksOnRestart', { code: 'missingConfig', params: why });
                    }
                }
                break;
            case 'ServiceAccount':
                for (const u of dependents(targetId)) {
                    if (isPod(g.byId.get(u.id))) {
                        mark(u.id, 'breaksOnRestart', { code: 'missingIdentity', params: why });
                        losePod(u.id, 'breaksOnRestart');
                    }
                }
                break;
            case 'PersistentVolumeClaim': {
                for (const u of dependents(targetId)) {
                    if (isPod(g.byId.get(u.id))) {
                        const level = mode === 'fail' ? 'breaks' : 'breaksOnRestart';
                        mark(u.id, level, { code: mode === 'fail' ? 'volumeFailed' : 'volumeGone', params: why });
                        losePod(u.id, level);
                    }
                }
                if (mode === 'delete') {
                    for (const e of graph.edges) {
                        if (e.kind !== 'storage' || e.source !== targetId) continue;
                        const pv = g.byId.get(e.target);
                        if (pv?.kind !== 'PersistentVolume') continue;
                        if (pv.details?.reclaimPolicy === 'Delete') {
                            mark(pv.id, 'removed', { code: 'dataLoss', params: ref(pv) }, { dataLoss: true });
                            result.dataLoss = true;
                        } else {
                            note({ code: 'dataKept', params: { policy: pv.details?.reclaimPolicy || 'Retain', name: pv.name } });
                        }
                    }
                }
                break;
            }
            case 'PersistentVolume':
                for (const u of dependents(targetId)) {
                    if (g.byId.get(u.id)?.kind === 'PersistentVolumeClaim') {
                        claimLost(u.id, mode === 'fail' ? 'breaks' : 'breaksOnRestart', mode === 'fail' ? 'volumeFailed' : 'volumeGone');
                    }
                }
                if (mode === 'delete' && target.details?.reclaimPolicy === 'Delete') {
                    result.dataLoss = true;
                    note({ code: 'dataLossTarget' });
                }
                break;
            case 'StorageClass': {
                let bound = 0;
                for (const u of dependents(targetId)) {
                    const pvc = g.byId.get(u.id);
                    if (pvc?.kind !== 'PersistentVolumeClaim') continue;
                    if (pvc.status?.startsWith('Pending')) claimLost(pvc.id, 'breaks', 'cannotProvision');
                    else bound++;
                }
                if (bound) note({ code: 'boundUnaffected', params: { count: bound } });
                break;
            }
            case 'Ingress':
                note({ code: mode === 'delete' ? 'entryRemoved' : 'entryDown' });
                break;
        }
    }

    // ── Pods ──────────────────────────────────────────────────────────────
    for (const [pod, loss] of podLoss) {
        if (loss === 'removed' || loss === 'transient') {
            mark(pod, 'removed', { code: 'cascade', params: podWhy.get(pod) }, { recreated: loss === 'transient' || undefined });
        }
    }

    // ── Owners: a rollout needs its pods to start; a controller whose pods
    // fail is down, or short of capacity. Deleting pods does not hurt the
    // owner — it is the target, or it recreates them. ─────────────────────
    const ownersOf = new Set<string>();
    for (const [pod, loss] of podLoss) {
        if (loss === 'breaks' || loss === 'breaksOnRestart') {
            for (const o of g.ancestors(pod)) ownersOf.add(o);
        }
    }
    for (const owner of ownersOf) {
        // The target's own descendants were accounted for by the seed.
        if (targetSet.has(owner) || targetDescendants.has(owner) || !CONTROLLERS.has(g.byId.get(owner)?.kind ?? '')) continue;
        const pods = g.descendants(owner).filter(id => isPod(g.byId.get(id)));
        const down = pods.filter(p => podLoss.get(p) === 'breaks').length;
        const onRestart = pods.filter(p => podLoss.get(p) === 'breaksOnRestart').length;
        const params = { count: down + onRestart, total: pods.length };
        if (down && down === pods.length) mark(owner, 'breaks', { code: 'podsAffected', params });
        else if (onRestart) mark(owner, 'breaksOnRestart', { code: 'rolloutBlocked', params });
        else if (down) mark(owner, 'degraded', { code: 'podsAffected', params });
    }

    // ── Services ──────────────────────────────────────────────────────────
    for (const [svc, pods] of g.selects) {
        if (targetSet.has(svc)) continue;
        let gone = 0, transient = 0, onRestart = 0;
        for (const p of pods) {
            const loss = podLoss.get(p);
            if (loss === 'removed' || loss === 'breaks') gone++;
            else if (loss === 'transient') transient++;
            else if (loss === 'breaksOnRestart') onRestart++;
        }
        const total = pods.length;
        const params = { lost: gone + transient + onRestart, total };
        let level: ImpactLevel | null = null;
        if (gone === total) { level = 'breaks'; mark(svc, level, { code: 'noEndpoints', params }); }
        else if (gone + onRestart === total && onRestart) { level = 'breaksOnRestart'; mark(svc, level, { code: 'noEndpointsOnRestart', params }); }
        else if (transient && gone + transient === total) { level = 'degraded'; mark(svc, level, { code: 'briefOutage', params }); }
        else if (gone || transient) { level = 'degraded'; mark(svc, level, { code: 'someEndpoints', params }); }
        if (level) svcLevel.set(svc, level);
    }

    // ── Ingresses ─────────────────────────────────────────────────────────
    for (const [ing, svcs] of g.routes) {
        if (targetSet.has(ing)) continue;
        const levels = svcs.map(s => svcLevel.get(s));
        const hit = levels.filter(Boolean) as ImpactLevel[];
        if (!hit.length) continue;
        const down = hit.filter(l => l === 'removed' || l === 'breaks').length;
        const params = { count: hit.length, total: svcs.length };
        if (down === svcs.length) mark(ing, 'breaks', { code: 'backendsDown', params });
        else if (hit.length === svcs.length && hit.every(l => SEVERITY[l] >= SEVERITY.breaksOnRestart)) {
            mark(ing, 'breaksOnRestart', { code: 'backendsDownOnRestart', params });
        } else mark(ing, 'degraded', { code: 'backendsDegraded', params });
    }

    return result;
}

/** Affected objects grouped by level, each group in row order then by name. */
export function groupImpacts(result: ImpactResult, byId: Map<string, ResourceNode>, rankOf: (kind: string) => number) {
    const groups = new Map<ImpactLevel, Array<{ node: ResourceNode; impact: Impact }>>();
    for (const level of IMPACT_LEVELS) groups.set(level, []);
    for (const [id, impact] of result.impacts) {
        const node = byId.get(id);
        if (node) groups.get(impact.level)!.push({ node, impact });
    }
    for (const list of groups.values()) {
        list.sort((a, b) => rankOf(a.node.kind) - rankOf(b.node.kind)
            || a.node.namespace.localeCompare(b.node.namespace) || a.node.name.localeCompare(b.node.name));
    }
    return groups;
}
