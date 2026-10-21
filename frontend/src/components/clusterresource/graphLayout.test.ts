import { describe, it, expect } from 'vitest';
import { layoutGraph, problemOrder, visibleGraph, type ClusterGraph, type ResourceNode } from './graphLayout';

const node = (kind: string, name: string, status?: string): ResourceNode =>
    ({ id: `${kind.toLowerCase()}/ns/${name}`, kind, name, namespace: 'ns', labels: {}, status });
const edge = (source: ResourceNode, target: ResourceNode, kind: string) =>
    ({ id: `${source.id}->${target.id}`, source: source.id, target: target.id, kind });

const dep = node('Deployment', 'web', '2/2');
const rs = node('ReplicaSet', 'web-new', '2/2');
const oldRs = node('ReplicaSet', 'web-old', '0/0');
const pod = node('Pod', 'web-a', 'Running');
const svc = node('Service', 'web', 'ClusterIP');
const lonePod = node('Pod', 'debug', 'Running');
const graph: ClusterGraph = {
    nodes: [dep, rs, oldRs, pod, svc, lonePod],
    edges: [edge(dep, rs, 'owner'), edge(dep, oldRs, 'owner'), edge(rs, pod, 'owner'), edge(svc, pod, 'selector')],
};
const ids = (es: { id: string }[]) => es.map(e => e.id).sort();

describe('visibleGraph', () => {
    it('hides scaled-to-zero ReplicaSets', () => {
        const v = visibleGraph(graph, { hiddenKinds: [], hideStaleReplicaSets: true });
        expect(v.nodes.map(n => n.id)).not.toContain(oldRs.id);
        expect(ids(v.edges)).not.toContain(`${dep.id}->${oldRs.id}`);
    });

    it('bridges owner edges through a hidden kind', () => {
        const v = visibleGraph(graph, { hiddenKinds: ['ReplicaSet'], hideStaleReplicaSets: false });
        expect(ids(v.edges)).toEqual([`${dep.id}->${pod.id}`, `${svc.id}->${pod.id}`]);
    });

    it('moves selector edges up to the owner when Pods are hidden', () => {
        const v = visibleGraph(graph, { hiddenKinds: ['Pod'], hideStaleReplicaSets: true });
        const lifted = v.edges.find(e => e.source === svc.id);
        expect(lifted?.target).toBe(rs.id);
        expect(lifted?.kind).toBe('selector');
    });
});

describe('layoutGraph', () => {
    const opts = { direction: 'TB' as const, hiddenKinds: [], hideStaleReplicaSets: true };

    it('puts each kind on its own row, top to bottom', () => {
        const l = layoutGraph(graph, opts);
        const y = (n: ResourceNode) => l.nodes.find(p => p.node.id === n.id)!.y;
        expect(y(svc)).toBeLessThan(y(dep));
        expect(y(dep)).toBeLessThan(y(rs));
        expect(y(rs)).toBeLessThan(y(pod));
        expect(y(lonePod)).toBe(y(pod));
        expect(l.hiddenCount).toBe(1);
    });

    it('lines unconnected objects up after the connected ones', () => {
        const l = layoutGraph(graph, opts);
        const x = (n: ResourceNode) => l.nodes.find(p => p.node.id === n.id)!.x;
        expect(x(lonePod)).toBeGreaterThan(x(pod));
    });

    it('never overlaps two nodes in one row', () => {
        const many: ClusterGraph = { nodes: [], edges: [] };
        for (let i = 0; i < 12; i++) {
            const s = node('Service', `s${i}`);
            many.nodes.push(s); // no pods: dagre ranks every one of these at the top
        }
        const d = node('Deployment', 'd');
        const p = node('Pod', 'p');
        many.nodes.push(d, p);
        many.edges.push(edge(d, p, 'owner'), edge(many.nodes[0], p, 'selector'));
        const row = layoutGraph(many, opts).nodes.filter(n => n.node.kind === 'Service').map(n => n.x).sort((a, b) => a - b);
        for (let i = 1; i < row.length; i++) expect(row[i] - row[i - 1]).toBeGreaterThanOrEqual(220);
    });

    it('LR swaps the axes', () => {
        const l = layoutGraph(graph, { ...opts, direction: 'LR' });
        const at = (n: ResourceNode) => l.nodes.find(p => p.node.id === n.id)!;
        expect(at(svc).x).toBeLessThan(at(pod).x);
    });
});

describe('layoutGraph with config and storage', () => {
    it('puts dependencies on their own rows below the Pods', () => {
        const cm = node('ConfigMap', 'cfg');
        const sec = node('Secret', 'db');
        const pvc = node('PersistentVolumeClaim', 'data', 'Bound · 1Gi');
        const sc = { ...node('StorageClass', 'fast'), namespace: '', id: 'storageclass//fast' };
        const g: ClusterGraph = {
            nodes: [dep, rs, pod, cm, sec, pvc, sc],
            edges: [edge(dep, rs, 'owner'), edge(rs, pod, 'owner'), edge(pod, cm, 'config'), edge(pod, sec, 'config'), edge(pod, pvc, 'storage'), edge(pvc, sc, 'storage')],
        };
        const l = layoutGraph(g, { direction: 'TB', hiddenKinds: [], hideStaleReplicaSets: true });
        const y = (n: ResourceNode) => l.nodes.find(p => p.node.id === n.id)!.y;
        expect(y(pod)).toBeLessThan(y(cm));
        expect(y(cm)).toBe(y(pvc));
        expect(y(cm)).toBeLessThan(y(sec));
        expect(y(sec)).toBeLessThan(y(sc));
    });

    it('lifts a dependency edge to the owner when Pods are hidden', () => {
        const cm = node('ConfigMap', 'cfg');
        const g: ClusterGraph = { nodes: [dep, rs, pod, cm], edges: [edge(dep, rs, 'owner'), edge(rs, pod, 'owner'), edge(pod, cm, 'config')] };
        const v = visibleGraph(g, { hiddenKinds: ['Pod'], hideStaleReplicaSets: true });
        expect(v.edges.find(e => e.target === cm.id)).toMatchObject({ source: rs.id, kind: 'config' });
    });
});

describe('problems', () => {
    const issue = (level: string, code = 'x') => [{ level, code }];
    const sick = { ...pod, issues: issue('err', 'pod.waiting') };
    const missingCm = { ...node('ConfigMap', 'gone'), missing: true, issues: issue('err', 'notFound') };
    const degraded = { ...svc, issues: issue('warn', 'someNotReady') };
    const other = node('Deployment', 'other', '1/1');
    const otherPod = node('Pod', 'other-a', 'Running');
    const g: ClusterGraph = {
        nodes: [dep, rs, sick, degraded, missingCm, other, otherPod],
        edges: [
            edge(dep, rs, 'owner'), edge(rs, sick, 'owner'), edge(degraded, sick, 'selector'),
            edge(sick, missingCm, 'config'), edge(other, otherPod, 'owner'),
        ],
    };

    it('only-problems keeps each problem and its related chain, nothing else', () => {
        const v = visibleGraph(g, { hiddenKinds: [], hideStaleReplicaSets: true, onlyProblems: true });
        expect(v.nodes.map(n => n.id).sort()).toEqual([dep.id, rs.id, sick.id, degraded.id, missingCm.id].sort());
        expect(v.nodes.find(n => n.id === other.id)).toBeUndefined();
    });

    it('navigator: errors first, then row order; placeholders are not counted', () => {
        expect(problemOrder(g.nodes).map(n => n.id)).toEqual([sick.id, degraded.id]);
    });
});
