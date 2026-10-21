import { describe, expect, it } from 'vitest';
import { aggregateUsage, changeOrder, diffGraphs, formatUsage, mergeMarks, withGhosts, type ChangeMarks } from './liveGraph';
import { layoutGraph, type ClusterGraph, type ResourceEdge, type ResourceNode } from './graphLayout';

const node = (kind: string, name: string, extra: Partial<ResourceNode> = {}): ResourceNode => ({
    id: `${kind.toLowerCase()}/app/${name}`, kind, name, namespace: 'app', labels: {}, issues: [], ...extra,
});
const owner = (src: ResourceNode, tgt: ResourceNode): ResourceEdge => ({ id: `${src.id}->${tgt.id}`, source: src.id, target: tgt.id, kind: 'owner' });

const deploy = node('Deployment', 'web', { status: '2/2' });
const rs = node('ReplicaSet', 'web-1', { status: '2/2' });
const podA = node('Pod', 'web-a', { status: 'Running' });
const podB = node('Pod', 'web-b', { status: 'Running' });
const base: ClusterGraph = {
    nodes: [deploy, rs, podA, podB],
    edges: [owner(deploy, rs), owner(rs, podA), owner(rs, podB)],
};

const swap = (g: ClusterGraph, ...nodes: ResourceNode[]): ClusterGraph => ({
    ...g,
    nodes: g.nodes.map(n => nodes.find(x => x.id === n.id) ?? n),
});

describe('diffGraphs', () => {
    it('reports nothing for an identical read', () => {
        expect(diffGraphs(base, base).size).toBe(0);
    });

    it('sees added and removed objects, and keeps the removed one with its edges', () => {
        const podC = node('Pod', 'web-c', { status: 'Pending' });
        const next: ClusterGraph = {
            nodes: [deploy, rs, podA, podC],
            edges: [owner(deploy, rs), owner(rs, podA), owner(rs, podC)],
        };
        const d = diffGraphs(base, next);
        expect(d.get(podC.id)?.kind).toBe('added');
        expect(d.get(podB.id)?.kind).toBe('removed');
        expect(d.get(podB.id)?.ghost?.edges.map(e => e.id)).toEqual([`${rs.id}->${podB.id}`]);
        expect(d.has(rs.id)).toBe(false);
    });

    it('sees status, restarts and problems that start or end', () => {
        const crashing = { ...podA, status: 'CrashLoopBackOff', details: { restarts: '3' }, issues: [{ level: 'err', code: 'pod.waiting' }] };
        const before = swap(base, { ...podA, details: { restarts: '1' } });
        const d = diffGraphs(before, swap(base, crashing)).get(podA.id)!;
        expect(d.kind).toBe('changed');
        expect(d.details).toEqual([
            { code: 'status', from: 'Running', to: 'CrashLoopBackOff' },
            { code: 'restarted', count: 2 },
            { code: 'issueAdded', issue: { level: 'err', code: 'pod.waiting' } },
        ]);
        const healed = diffGraphs(swap(base, crashing), swap(base, { ...crashing, status: 'Running', issues: [] })).get(podA.id)!;
        expect(healed.details).toContainEqual({ code: 'issueCleared', issue: { level: 'err', code: 'pod.waiting' } });
    });

    it('does not count a moving event count or message as a change', () => {
        const ev = (count: string) => ({ ...podA, issues: [{ level: 'warn', code: 'recentWarnings', params: { count, message: `x${count}` } }] });
        expect(diffGraphs(swap(base, ev('1')), swap(base, ev('7'))).size).toBe(0);
    });

    it('ignores placeholders for missing objects', () => {
        const missing = node('ConfigMap', 'gone', { missing: true });
        expect(diffGraphs(base, { ...base, nodes: [...base.nodes, missing] }).size).toBe(0);
    });
});

describe('mergeMarks', () => {
    const t0 = 1000;
    const step = (marks: ChangeMarks, prev: ClusterGraph, next: ClusterGraph, at: number) => mergeMarks(marks, diffGraphs(prev, next), at);

    it('collects changes until cleared, keeping when each was first seen', () => {
        const g1 = swap(base, { ...podA, status: 'Error' });
        const g2 = swap(base, { ...podA, status: 'CrashLoopBackOff' });
        let marks = step(new Map(), base, g1, t0);
        marks = step(marks, g1, g2, t0 + 30);
        const m = marks.get(podA.id)!;
        expect(m.at).toBe(t0);
        expect(m.details).toEqual([{ code: 'status', from: 'Running', to: 'CrashLoopBackOff' }]);
    });

    it('drops a change that went back to where it started, but not restarts on the way', () => {
        const flap = swap(base, { ...podA, status: 'Error', details: { restarts: '1' } });
        const back = swap(base, { ...podA, status: 'Running', details: { restarts: '1' } });
        let marks = step(new Map(), base, flap, t0);
        marks = step(marks, flap, back, t0 + 30);
        expect(marks.get(podA.id)?.details).toEqual([{ code: 'restarted', count: 1 }]);

        const noisy = swap(base, { ...podB, issues: [{ level: 'warn', code: 'pod.notReady' }] });
        let m2 = step(new Map(), base, noisy, t0);
        m2 = step(m2, noisy, base, t0 + 30);
        expect(m2.has(podB.id)).toBe(false);
    });

    it('marks an object that comes back as recreated', () => {
        const without: ClusterGraph = { nodes: [deploy, rs, podA], edges: [owner(deploy, rs), owner(rs, podA)] };
        let marks = step(new Map(), base, without, t0);
        expect(marks.get(podB.id)?.kind).toBe('removed');
        marks = step(marks, without, base, t0 + 30);
        expect(marks.get(podB.id)).toMatchObject({ kind: 'recreated', ghost: undefined, at: t0 });
    });

    it('keeps an added object added when it then changes', () => {
        const podC = node('Pod', 'web-c', { status: 'Pending' });
        const g1: ClusterGraph = { ...base, nodes: [...base.nodes, podC] };
        const g2: ClusterGraph = { ...base, nodes: [...base.nodes, { ...podC, status: 'Running' }] };
        let marks = step(new Map(), base, g1, t0);
        marks = step(marks, g1, g2, t0 + 30);
        expect(marks.get(podC.id)).toMatchObject({ kind: 'added', details: [{ code: 'status', from: 'Pending', to: 'Running' }] });
    });

    it('returns the same map when nothing changed', () => {
        const marks: ChangeMarks = new Map();
        expect(step(marks, base, base, t0)).toBe(marks);
    });
});

describe('withGhosts', () => {
    it('draws a removed object in place, without problems, with edges to what is still there', () => {
        const without: ClusterGraph = { nodes: [deploy, rs, podA], edges: [owner(deploy, rs), owner(rs, podA)] };
        const gone = { ...podB, issues: [{ level: 'err', code: 'pod.waiting' }] };
        const marks = mergeMarks(new Map(), diffGraphs(swap(base, gone), without), 1);
        const drawn = withGhosts(without, marks);
        const ghost = drawn.nodes.find(n => n.id === podB.id)!;
        expect(ghost).toMatchObject({ ghost: true, issues: [] });
        expect(drawn.edges.find(e => e.target === podB.id)).toMatchObject({ source: rs.id, ghost: true });

        const layout = layoutGraph(drawn, { direction: 'TB', hiddenKinds: [], hideStaleReplicaSets: false });
        expect(layout.nodes.map(p => p.node.id)).toContain(podB.id);
    });

    it('leaves the graph alone when nothing is marked removed', () => {
        expect(withGhosts(base, new Map())).toBe(base);
    });
});

describe('layout reuse', () => {
    it('keeps every position when only states changed', () => {
        const opts = { direction: 'TB' as const, hiddenKinds: [], hideStaleReplicaSets: false };
        const first = layoutGraph(base, opts);
        const next = layoutGraph(swap(base, { ...podA, status: 'Error' }), opts, first);
        expect(next.key).toBe(first.key);
        expect(next.nodes.find(p => p.node.id === podA.id)?.node.status).toBe('Error');
        for (const p of next.nodes) {
            const was = first.nodes.find(q => q.node.id === p.node.id)!;
            expect([p.x, p.y]).toEqual([was.x, was.y]);
        }
    });
});

describe('changeOrder', () => {
    it('walks the drawn marks oldest first', () => {
        const marks: ChangeMarks = new Map([
            ['b', { kind: 'changed', details: [], at: 2 }],
            ['a', { kind: 'added', details: [], at: 2 }],
            ['c', { kind: 'removed', details: [], at: 1 }],
            ['hidden', { kind: 'added', details: [], at: 0 }],
        ]);
        expect(changeOrder(marks, new Set(['a', 'b', 'c']))).toEqual(['c', 'a', 'b']);
    });
});

describe('aggregateUsage', () => {
    it('gives each pod its own usage and each owner up the chain the sum', () => {
        const u = aggregateUsage(base, [
            { namespace: 'app', name: 'web-a', cpuMillis: 100, memMi: 64 },
            { namespace: 'app', name: 'web-b', cpuMillis: 20, memMi: 32 },
            { namespace: 'other', name: 'web-a', cpuMillis: 999, memMi: 999 },
        ]);
        expect(u.get(podA.id)).toEqual({ cpuMillis: 100, memMi: 64, pods: 1 });
        expect(u.get(rs.id)).toEqual({ cpuMillis: 120, memMi: 96, pods: 2 });
        expect(u.get(deploy.id)).toEqual({ cpuMillis: 120, memMi: 96, pods: 2 });
    });

    it('formats like kubectl top', () => {
        expect(formatUsage({ cpuMillis: 240, memMi: 512 })).toBe('240m · 512Mi');
        expect(formatUsage({ cpuMillis: 1250, memMi: 1536 })).toBe('1250m · 1.5Gi');
    });
});
