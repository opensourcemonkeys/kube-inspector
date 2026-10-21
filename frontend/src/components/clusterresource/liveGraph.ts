import type { ClusterGraph, GraphIssue, ResourceEdge, ResourceNode } from './graphLayout';

// What changed between two reads of the resource graph, and the marks that
// collect those changes until the user clears them. Pure, like the layout.

export type ChangeKind = 'added' | 'removed' | 'changed' | 'recreated';

export type ChangeDetail =
    | { code: 'status'; from: string; to: string }
    | { code: 'restarted'; count: number }
    | { code: 'issueAdded'; issue: GraphIssue }
    | { code: 'issueCleared'; issue: GraphIssue }
    /** On a collapsed controller: how many of the objects folded into it changed. Never stored in the marks. */
    | { code: 'inside'; count: number };

export interface ChangeMark {
    kind: ChangeKind;
    details: ChangeDetail[];
    /** When the change was first seen (ms); the navigator walks oldest first. */
    at: number;
    /** A removed object as it was last seen, with its edges, so it can stay drawn. */
    ghost?: { node: ResourceNode; edges: ResourceEdge[] };
}

export type ChangeMarks = Map<string, ChangeMark>;

/** One read-to-read difference, before it is merged into the marks. */
export interface GraphChange {
    kind: 'added' | 'removed' | 'changed';
    details: ChangeDetail[];
    ghost?: ChangeMark['ghost'];
}

const restarts = (n: ResourceNode) => Number(n.details?.restarts ?? 0) || 0;

// An issue is the same issue while its code and level are: parameters (an
// event count, a message) move on every read and are not a change.
const issueKey = (is: GraphIssue) => `${is.level}:${is.code}`;

/**
 * Objects that appeared, disappeared or changed state between two reads. A
 * changed state is the status line, the restart count going up, or a problem
 * starting or ending. Placeholders for missing objects are not objects and
 * are left out — the broken reference shows as an issue on its user.
 */
export function diffGraphs(prev: ClusterGraph, next: ClusterGraph): Map<string, GraphChange> {
    const out = new Map<string, GraphChange>();
    const before = new Map(prev.nodes.filter(n => !n.missing).map(n => [n.id, n]));
    const after = new Map(next.nodes.filter(n => !n.missing).map(n => [n.id, n]));

    for (const [id, n] of after) {
        const old = before.get(id);
        if (!old) {
            out.set(id, { kind: 'added', details: [] });
            continue;
        }
        const details: ChangeDetail[] = [];
        if ((old.status ?? '') !== (n.status ?? '')) details.push({ code: 'status', from: old.status ?? '', to: n.status ?? '' });
        const more = restarts(n) - restarts(old);
        if (more > 0) details.push({ code: 'restarted', count: more });
        const oldIssues = new Map((old.issues ?? []).map(is => [issueKey(is), is]));
        const newIssues = new Map((n.issues ?? []).map(is => [issueKey(is), is]));
        for (const [k, is] of newIssues) if (!oldIssues.has(k)) details.push({ code: 'issueAdded', issue: is });
        for (const [k, is] of oldIssues) if (!newIssues.has(k)) details.push({ code: 'issueCleared', issue: is });
        if (details.length) out.set(id, { kind: 'changed', details });
    }

    for (const [id, n] of before) {
        if (after.has(id)) continue;
        const edges = prev.edges.filter(e => e.source === id || e.target === id);
        out.set(id, { kind: 'removed', details: [], ghost: { node: n, edges } });
    }
    return out;
}

/**
 * Folds one read's changes into the marks. Details collapse rather than pile
 * up: a status that goes A → B → C reads "A → C", one that comes back to
 * where it started is no change, restarts add up, and a problem that started
 * and then ended cancels out. A mark left with nothing to say is dropped —
 * except an added, removed or recreated one, whose existence is the news.
 */
export function mergeMarks(marks: ChangeMarks, changes: Map<string, GraphChange>, now: number): ChangeMarks {
    if (changes.size === 0) return marks;
    const out: ChangeMarks = new Map(marks);
    for (const [id, change] of changes) {
        const old = out.get(id);
        let kind: ChangeKind;
        if (change.kind === 'removed') kind = 'removed';
        else if (change.kind === 'added') kind = old?.kind === 'removed' ? 'recreated' : 'added';
        else kind = old && old.kind !== 'removed' ? old.kind : 'changed';

        // An object that appears, disappears or comes back starts over: what
        // it was before is not a change of what is there now.
        const details = change.kind === 'changed' ? foldDetails(old?.details ?? [], change.details) : [];
        if (kind === 'changed' && details.length === 0) {
            out.delete(id);
            continue;
        }
        out.set(id, { kind, details, at: old?.at ?? now, ghost: change.ghost });
    }
    return out;
}

function foldDetails(prev: ChangeDetail[], next: ChangeDetail[]): ChangeDetail[] {
    let status = prev.find(d => d.code === 'status') as Extract<ChangeDetail, { code: 'status' }> | undefined;
    let restarted = (prev.find(d => d.code === 'restarted') as Extract<ChangeDetail, { code: 'restarted' }> | undefined)?.count ?? 0;
    // issue key -> the detail that stands, so started-then-ended cancels.
    const issues = new Map<string, ChangeDetail>();
    for (const d of prev) if (d.code === 'issueAdded' || d.code === 'issueCleared') issues.set(issueKey(d.issue), d);

    for (const d of next) {
        if (d.code === 'status') status = { code: 'status', from: status?.from ?? d.from, to: d.to };
        else if (d.code === 'restarted') restarted += d.count;
        else if (d.code === 'inside') continue;
        else {
            const k = issueKey(d.issue);
            const was = issues.get(k);
            if (was && was.code !== d.code) issues.delete(k);
            else issues.set(k, d);
        }
    }
    const out: ChangeDetail[] = [];
    if (status && status.from !== status.to) out.push(status);
    if (restarted > 0) out.push({ code: 'restarted', count: restarted });
    out.push(...issues.values());
    return out;
}

/**
 * The graph to draw: the latest read plus a ghost for every removed object
 * still marked, so a pod that was replaced keeps its place beside its
 * successor. A ghost has no problems of its own, and keeps only the edges
 * whose other end is still drawn.
 */
export function withGhosts(graph: ClusterGraph, marks: ChangeMarks): ClusterGraph {
    const ghosts = [...marks.values()].filter(m => m.ghost).map(m => m.ghost!);
    if (ghosts.length === 0) return graph;
    const ids = new Set(graph.nodes.map(n => n.id));
    const nodes = [...graph.nodes];
    for (const { node } of ghosts) {
        if (ids.has(node.id)) continue;
        ids.add(node.id);
        nodes.push({ ...node, issues: [], ghost: true });
    }
    const edgeIds = new Set(graph.edges.map(e => e.id));
    const edges = [...graph.edges];
    for (const g of ghosts) {
        for (const e of g.edges) {
            if (edgeIds.has(e.id) || !ids.has(e.source) || !ids.has(e.target)) continue;
            edgeIds.add(e.id);
            edges.push({ ...e, issue: undefined, ghost: true });
        }
    }
    return { ...graph, nodes, edges };
}

/** The ids the change navigator steps through: oldest change first, then by name. */
export function changeOrder(marks: ChangeMarks, drawn: Set<string>): string[] {
    return [...marks.entries()]
        .filter(([id]) => drawn.has(id))
        .sort(([a, ma], [b, mb]) => ma.at - mb.at || a.localeCompare(b))
        .map(([id]) => id);
}

// ── Usage ─────────────────────────────────────────────────────────────────────

export interface PodUsage {
    namespace: string;
    name: string;
    cpuMillis: number;
    memMi: number;
}

export interface NodeUsage {
    cpuMillis: number;
    memMi: number;
    /** How many pods the figure sums (1 for a pod). */
    pods: number;
}

/**
 * Usage per drawn object: each pod's own, and every owner up its chain
 * (ReplicaSet, then Deployment) the sum of its pods. Read off the raw graph,
 * so a Deployment still sums its pods while Pods are hidden from view.
 */
export function aggregateUsage(graph: ClusterGraph, pods: PodUsage[]): Map<string, NodeUsage> {
    const podIds = new Map<string, string>();
    for (const n of graph.nodes) if (n.kind === 'Pod') podIds.set(`${n.namespace}/${n.name}`, n.id);
    const owners = new Map<string, string[]>();
    for (const e of graph.edges) {
        if (e.kind !== 'owner') continue;
        const arr = owners.get(e.target);
        if (arr) arr.push(e.source); else owners.set(e.target, [e.source]);
    }
    const out = new Map<string, NodeUsage>();
    const add = (id: string, u: PodUsage) => {
        const cur = out.get(id);
        if (cur) { cur.cpuMillis += u.cpuMillis; cur.memMi += u.memMi; cur.pods += 1; }
        else out.set(id, { cpuMillis: u.cpuMillis, memMi: u.memMi, pods: 1 });
    };
    for (const u of pods) {
        const id = podIds.get(`${u.namespace}/${u.name}`);
        if (!id) continue;
        add(id, u);
        const seen = new Set([id]);
        const queue = [...(owners.get(id) ?? [])];
        while (queue.length) {
            const o = queue.shift()!;
            if (seen.has(o)) continue;
            seen.add(o);
            add(o, u);
            queue.push(...(owners.get(o) ?? []));
        }
    }
    return out;
}

/** "240m · 512Mi", kubectl top's units: millicores stay millicores. */
export function formatUsage(u: Pick<NodeUsage, 'cpuMillis' | 'memMi'>): string {
    const mem = u.memMi >= 1024 ? `${(u.memMi / 1024).toFixed(1)}Gi` : `${u.memMi}Mi`;
    return `${u.cpuMillis}m · ${mem}`;
}
