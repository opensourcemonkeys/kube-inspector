import { describe, it, expect } from 'vitest';
import { simulateImpact, simulateImpactMany, type ImpactLevel } from './impact';
import type { ClusterGraph, ResourceEdge, ResourceNode } from './graphLayout';

// A small namespace, built per test from these pieces:
//   ing → svc → pod-a, pod-b  ← rs ← dep        (2 replicas behind one Service)
//   pods → cm (required), opt-cm (optional), sa, pvc → pv (Delete) → sc
const n = (kind: string, name: string, extra: Partial<ResourceNode> = {}): ResourceNode =>
    ({ id: `${kind.toLowerCase()}/ns/${name}`, kind, name, namespace: kind === 'PersistentVolume' || kind === 'StorageClass' ? '' : 'ns', labels: {}, ...extra });
const e = (source: ResourceNode, target: ResourceNode, kind: string, extra: Partial<ResourceEdge> = {}): ResourceEdge =>
    ({ id: `${source.id}->${target.id}`, source: source.id, target: target.id, kind, ...extra });

const ing = n('Ingress', 'web');
const svc = n('Service', 'web');
const dep = n('Deployment', 'web');
const rs = n('ReplicaSet', 'web-1');
const podA = n('Pod', 'web-a');
const podB = n('Pod', 'web-b');
const cm = n('ConfigMap', 'cfg');
const optCm = n('ConfigMap', 'extra');
const sa = n('ServiceAccount', 'web');
const pvc = n('PersistentVolumeClaim', 'data', { status: 'Bound · 1Gi' });
const pv = n('PersistentVolume', 'pv-1', { details: { reclaimPolicy: 'Delete' } });
const sc = n('StorageClass', 'fast');

function graph(opts: { replicas?: 1 | 2; pvPolicy?: string } = {}): ClusterGraph {
    const pods = opts.replicas === 1 ? [podA] : [podA, podB];
    const thePv = { ...pv, details: { reclaimPolicy: opts.pvPolicy ?? 'Delete' } };
    const edges: ResourceEdge[] = [e(ing, svc, 'ingress'), e(dep, rs, 'owner'), e(pvc, thePv, 'storage'), e(pvc, sc, 'storage')];
    for (const p of pods) {
        edges.push(e(svc, p, 'selector'), e(rs, p, 'owner'), e(p, cm, 'config'), e(p, optCm, 'config', { optional: true }),
            e(p, sa, 'config'), e(p, pvc, 'storage'));
    }
    return { nodes: [ing, svc, dep, rs, ...pods, cm, optCm, sa, pvc, thePv, sc], edges };
}

const levels = (g: ClusterGraph, target: ResourceNode, mode: 'delete' | 'fail') => {
    const r = simulateImpact(g, target.id, mode);
    const out: Record<string, ImpactLevel> = {};
    for (const [id, imp] of r.impacts) out[id] = imp.level;
    return { out, r };
};

describe('simulateImpact — delete', () => {
    it('a Deployment takes its ReplicaSet and pods, and the Service and Ingress go down', () => {
        const { out } = levels(graph(), dep, 'delete');
        expect(out).toEqual({
            [rs.id]: 'removed', [podA.id]: 'removed', [podB.id]: 'removed',
            [svc.id]: 'breaks', [ing.id]: 'breaks',
        });
    });

    it('one pod of two: recreated by its owner, the Service only loses capacity', () => {
        const { out, r } = levels(graph(), podA, 'delete');
        expect(out).toEqual({ [svc.id]: 'degraded', [ing.id]: 'degraded' });
        expect(r.notes.map(x => x.code)).toContain('recreatedByOwner');
    });

    it('a ConfigMap: required users fail on restart, optional users are untouched', () => {
        const { out } = levels(graph(), cm, 'delete');
        expect(out[podA.id]).toBe('breaksOnRestart');
        expect(out[rs.id]).toBe('breaksOnRestart');
        expect(out[dep.id]).toBe('breaksOnRestart');
        expect(out[svc.id]).toBe('breaksOnRestart');
        const { out: optional } = levels(graph(), optCm, 'delete');
        expect(optional).toEqual({});
    });

    it('a claim on a Delete-policy volume loses data; a Retain one keeps it', () => {
        const del = levels(graph(), pvc, 'delete');
        expect(del.out[pv.id]).toBe('removed');
        expect(del.r.dataLoss).toBe(true);
        expect(del.out[podA.id]).toBe('breaksOnRestart');
        const keep = levels(graph({ pvPolicy: 'Retain' }), pvc, 'delete');
        expect(keep.r.dataLoss).toBe(false);
        expect(keep.out[pv.id]).toBeUndefined();
        expect(keep.r.notes.map(x => x.code)).toContain('dataKept');
    });

    it('a StorageClass only hurts claims still waiting to be provisioned', () => {
        const bound = levels(graph(), sc, 'delete');
        expect(bound.out).toEqual({});
        expect(bound.r.notes).toEqual([{ code: 'boundUnaffected', params: { count: 1 } }]);
        const g = graph();
        g.nodes = g.nodes.map(x => (x.id === pvc.id ? { ...x, status: 'Pending' } : x));
        expect(levels(g, sc, 'delete').out[pvc.id]).toBe('breaks');
    });

    it('a Service: an Ingress with another healthy backend is only degraded', () => {
        const other = n('Service', 'other');
        const g = graph();
        g.nodes.push(other);
        g.edges.push(e(ing, other, 'ingress'));
        expect(levels(g, svc, 'delete').out).toEqual({ [ing.id]: 'degraded' });
        expect(levels(graph(), svc, 'delete').out).toEqual({ [ing.id]: 'breaks' });
    });
});

describe('simulateImpact — fail', () => {
    it('the only pod failing takes the Service, Ingress and its owners down', () => {
        const { out } = levels(graph({ replicas: 1 }), podA, 'fail');
        expect(out).toEqual({ [svc.id]: 'breaks', [ing.id]: 'breaks', [rs.id]: 'breaks', [dep.id]: 'breaks' });
    });

    it('one of two pods failing is lost capacity', () => {
        const { out } = levels(graph(), podA, 'fail');
        expect(out).toEqual({ [svc.id]: 'degraded', [ing.id]: 'degraded', [rs.id]: 'degraded', [dep.id]: 'degraded' });
    });

    it('a volume failing breaks the pods that mount it, and what routes to them', () => {
        const { out } = levels(graph(), pv, 'fail');
        expect(out[pvc.id]).toBe('breaks');
        expect(out[podA.id]).toBe('breaks');
        expect(out[svc.id]).toBe('breaks');
    });
});

describe('simulateImpact — rollout history', () => {
    it('failing a Deployment does not report its scaled-to-zero ReplicaSet', () => {
        const old = n('ReplicaSet', 'web-0', { status: '0/0' });
        const g = graph();
        g.nodes.push(old);
        g.edges.push(e(dep, old, 'owner'));
        const { out } = levels(g, dep, 'fail');
        expect(out[old.id]).toBeUndefined();
        expect(out[rs.id]).toBe('breaks');
        expect(simulateImpact(g, dep.id, 'fail').impacts.get(rs.id)!.reasons.map(r => r.code)).toEqual(['ownerFailed']);
        // Deleting it still removes the history.
        expect(levels(g, dep, 'delete').out[old.id]).toBe('removed');
    });
});

describe('simulateImpact — combining', () => {
    it('the worst level wins when an object is reached more than one way', () => {
        // The Secret is the Ingress's TLS certificate (degraded on its own)
        // and required by every pod behind it (breaks on restart via the Service).
        const secret = n('Secret', 'tls');
        const g = graph();
        g.nodes.push(secret);
        g.edges.push(e(ing, secret, 'config'), e(podA, secret, 'config'), e(podB, secret, 'config'));
        const imp = simulateImpact(g, secret.id, 'delete').impacts.get(ing.id)!;
        expect(imp.level).toBe('breaksOnRestart');
        expect(imp.reasons.map(r => r.code).sort()).toEqual(['backendsDownOnRestart', 'tlsMissing']);
    });
});

describe('simulateImpactMany — several deleted at once', () => {
    const many = (g: ClusterGraph, targets: ResourceNode[]) => {
        const r = simulateImpactMany(g, targets.map(t => t.id), 'delete');
        const out: Record<string, ImpactLevel> = {};
        for (const [id, imp] of r.impacts) out[id] = imp.level;
        return { out, r };
    };

    it('two pods behind one Service: together every endpoint goes (a brief outage), alone only some', () => {
        const { out } = many(graph(), [podA, podB]);
        expect(out[svc.id]).toBe('degraded'); // their owner recreates them
        expect(out[podA.id]).toBeUndefined();
        expect(out[podB.id]).toBeUndefined();
        expect(levels(graph(), podA, 'delete').r.impacts.get(svc.id)?.reasons.map(r => r.code)).toEqual(['someEndpoints']);
        expect(many(graph(), [podA, podB]).r.impacts.get(svc.id)?.reasons.map(r => r.code)).toEqual(['briefOutage']);
    });

    it('never lists a target as affected, even when another target cascades to it', () => {
        const { out } = many(graph(), [dep, rs]);
        expect(out[rs.id]).toBeUndefined();
        expect(out[dep.id]).toBeUndefined();
        expect(out[podA.id]).toBe('removed');
        expect(out[svc.id]).toBe('breaks');
    });

    it('combines data loss and notes across targets, without repeating a note', () => {
        const { r, out } = many(graph({ pvPolicy: 'Delete' }), [pvc, cm, podA]);
        expect(r.dataLoss).toBe(true);
        expect(out[pv.id]).toBe('removed');
        expect(out[podB.id]).toBe('breaksOnRestart');
        expect(r.notes.filter(x => x.code === 'recreatedByOwner')).toHaveLength(1);
    });

    it('a Service and its Ingress both deleted: nothing else is hit', () => {
        expect(many(graph(), [svc, ing]).out).toEqual({});
    });

    it('ignores ids that are not in the graph', () => {
        expect(simulateImpactMany(graph(), ['pod/ns/gone'], 'delete').impacts.size).toBe(0);
    });
});
