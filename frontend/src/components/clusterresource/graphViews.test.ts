import { describe, expect, it } from 'vitest';
import {
    AUTO_COLLAPSE_PODS, collapsedSet, layoutGraph, NODE_H, NODE_W, podSummary, podsUnder, visibleGraph,
    type ClusterGraph, type GraphFrame, type ResourceEdge, type ResourceNode,
} from './graphLayout';

const node = (kind: string, name: string, ns = 'a', extra: Partial<ResourceNode> = {}): ResourceNode =>
    ({ id: `${kind.toLowerCase()}/${ns}/${name}`, kind, name, namespace: ns, labels: {}, issues: [], ...extra });
const edge = (s: ResourceNode, t: ResourceNode, kind: string, extra: Partial<ResourceEdge> = {}): ResourceEdge =>
    ({ id: `${s.id}->${t.id}`, source: s.id, target: t.id, kind, ...extra });

// A Deployment with n pods behind one Service, every pod mounting one claim.
function app(ns: string, name: string, pods: number, host = (i: number) => `worker-${i % 2}`) {
    const dep = node('Deployment', name, ns);
    const rs = node('ReplicaSet', `${name}-1`, ns, { status: `${pods}/${pods}` });
    const svc = node('Service', name, ns);
    const pvc = node('PersistentVolumeClaim', `${name}-data`, ns);
    const pv = node('PersistentVolume', `pv-${name}`, '');
    const nodes: ResourceNode[] = [dep, rs, svc, pvc, pv];
    const edges: ResourceEdge[] = [edge(dep, rs, 'owner'), edge(pvc, pv, 'storage')];
    for (let i = 0; i < pods; i++) {
        const p = node('Pod', `${name}-${i}`, ns, { status: i === 0 ? 'CrashLoopBackOff' : 'Running', details: { node: host(i) } });
        nodes.push(p);
        edges.push(edge(rs, p, 'owner'), edge(svc, p, 'selector'), edge(p, pvc, 'storage', { label: '/data' }));
    }
    return { nodes, edges, dep, rs, svc, pvc, pv };
}
const merge = (...parts: Array<{ nodes: ResourceNode[]; edges: ResourceEdge[] }>): ClusterGraph =>
    ({ nodes: parts.flatMap(p => p.nodes), edges: parts.flatMap(p => p.edges) });

const opts = { direction: 'TB' as const, hiddenKinds: [] as string[], hideStaleReplicaSets: false };

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (f: GraphFrame, p: { x: number; y: number }) =>
    p.x >= f.x && p.y >= f.y && p.x + NODE_W <= f.x + f.w && p.y + NODE_H <= f.y + f.h;

describe('collapsing controllers', () => {
    const big = app('a', 'big', AUTO_COLLAPSE_PODS + 1);
    const small = app('a', 'small', 2);
    const g = merge(big, small);

    it('collapses a top-level controller with many pods, not a small one or its ReplicaSet', () => {
        const set = collapsedSet(g, {});
        expect([...set]).toEqual([big.dep.id]);
        expect(podsUnder(g).get(big.dep.id)).toHaveLength(AUTO_COLLAPSE_PODS + 1);
    });

    it('follows the user\'s choice either way', () => {
        const set = collapsedSet(g, { [big.dep.id]: false, [small.dep.id]: true });
        expect([...set]).toEqual([small.dep.id]);
    });

    it('hides what the controller owns and moves the edges onto it', () => {
        const v = visibleGraph(g, { ...opts, collapsed: [big.dep.id] });
        const ids = new Set(v.nodes.map(n => n.id));
        expect(ids.has(big.rs.id)).toBe(false);
        expect(v.nodes.some(n => n.name.startsWith('big-') && n.kind === 'Pod')).toBe(false);
        expect(v.collapsedBy.get(big.rs.id)).toBe(big.dep.id);
        expect(v.collapsedBy.get(`pod/a/big-3`)).toBe(big.dep.id);
        // Service and claim edges now land on the Deployment, once each.
        expect(v.edges.filter(e => e.source === big.svc.id).map(e => e.target)).toEqual([big.dep.id]);
        expect(v.edges.filter(e => e.target === big.pvc.id).map(e => e.source)).toEqual([big.dep.id]);
        // The small app is untouched.
        expect(ids.has(small.rs.id)).toBe(true);
    });

    it('summarises the pods that are not running', () => {
        expect(podSummary(podsUnder(g).get(big.dep.id)!)).toEqual({ total: 6, other: [{ status: 'CrashLoopBackOff', count: 1 }] });
    });
});

describe('passing hidden dependencies through', () => {
    const one = app('a', 'web', 2);

    it('draws pods straight to the volume when claims are hidden, keeping the mount label', () => {
        const v = visibleGraph(one, { ...opts, hiddenKinds: ['PersistentVolumeClaim'] });
        const toPv = v.edges.filter(e => e.target === one.pv.id);
        expect(toPv.map(e => e.source).sort()).toEqual(['pod/a/web-0', 'pod/a/web-1']);
        expect(toPv.every(e => e.kind === 'storage' && e.label === '/data')).toBe(true);
    });

    it('goes through a ServiceAccount to its Secret', () => {
        const pod = node('Pod', 'p');
        const sa = node('ServiceAccount', 'sa');
        const secret = node('Secret', 'pull');
        const v = visibleGraph({ nodes: [pod, sa, secret], edges: [edge(pod, sa, 'config'), edge(sa, secret, 'config')] },
            { ...opts, hiddenKinds: ['ServiceAccount'] });
        expect(v.edges.map(e => e.id)).toEqual([`${pod.id}->${secret.id}`]);
    });

    it('with pods and claims both hidden, the Deployment reaches the volume', () => {
        const v = visibleGraph(one, { ...opts, hiddenKinds: ['Pod', 'PersistentVolumeClaim'] });
        expect(v.edges.some(e => e.source === one.rs.id && e.target === one.pv.id)).toBe(true);
    });
});

describe('grouping by namespace', () => {
    const g = merge(app('shop', 'web', 2), app('blog', 'cms', 3));
    const layout = layoutGraph(g, { ...opts, groupBy: 'namespace' });

    it('frames each namespace, cluster-scoped objects last, without overlap', () => {
        expect(layout.frames.map(f => f.id)).toEqual(['frame:ns:blog', 'frame:ns:shop', 'frame:cluster']);
        for (let i = 0; i < layout.frames.length; i++) {
            for (let j = i + 1; j < layout.frames.length; j++) expect(overlaps(layout.frames[i], layout.frames[j])).toBe(false);
        }
    });

    it('puts every object inside its own frame, and keeps rows aligned across frames', () => {
        const frameOf = new Map(layout.frames.flatMap(f => f.nodeIds.map(id => [id, f] as const)));
        for (const p of layout.nodes) expect(inside(frameOf.get(p.node.id)!, p)).toBe(true);
        const podRows = new Set(layout.nodes.filter(p => p.node.kind === 'Pod').map(p => p.y));
        expect(podRows.size).toBe(1);
    });
});

describe('grouping by node', () => {
    const g = merge(app('a', 'web', 4, i => (i < 3 ? `worker-${i % 2}` : '')));
    const layout = layoutGraph(g, { ...opts, groupBy: 'node' });

    it('frames the pods of each Node as one block, unscheduled pods last', () => {
        expect(layout.frames.map(f => f.kind)).toEqual(['host', 'host', 'unscheduled']);
        const byHost = (f: GraphFrame) => f.nodeIds.map(id => g.nodes.find(n => n.id === id)!.details?.node ?? '');
        for (const f of layout.frames) expect(new Set(byHost(f)).size).toBe(1);
        expect(layout.frames[2].nodeIds).toEqual(['pod/a/web-3']);
    });

    it('keeps the blocks apart and every pod inside its frame', () => {
        const [a, b, c] = layout.frames;
        expect(overlaps(a, b) || overlaps(b, c) || overlaps(a, c)).toBe(false);
        const at = new Map(layout.nodes.map(p => [p.node.id, p]));
        for (const f of layout.frames) for (const id of f.nodeIds) expect(inside(f, at.get(id)!)).toBe(true);
    });

    it('lays out again when a pod moves to another Node', () => {
        const moved: ClusterGraph = { ...g, nodes: g.nodes.map(n => (n.name === 'web-0' ? { ...n, details: { node: 'worker-1' } } : n)) };
        expect(layoutGraph(moved, { ...opts, groupBy: 'node' }, layout).key).not.toBe(layout.key);
        expect(layoutGraph(g, { ...opts, groupBy: 'node' }, layout).frames).toBe(layout.frames);
    });
});
