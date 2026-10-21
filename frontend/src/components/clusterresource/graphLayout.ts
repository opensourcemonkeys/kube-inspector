import dagre from '@dagrejs/dagre';
import { chainOf } from '../../lib/graphHighlight';
import type { GraphDirection } from '../../stores/resourceGraphStore';

// The workload graph as GetClusterGraph returns it. Kept structural rather than
// the generated `models.ClusterGraph` class so the layout stays a pure function
// that tests can feed plain objects.
export interface ResourceNode {
    id: string;
    kind: string;
    name: string;
    namespace: string;
    labels: Record<string, string>;
    selector?: Record<string, string>;
    status?: string;
    /** Worst first. */
    issues?: GraphIssue[];
    /** A placeholder for something referenced that does not exist. */
    missing?: boolean;
    /** Kind-specific facts, e.g. a PersistentVolume's reclaimPolicy. */
    details?: Record<string, string>;
    /** Gone since it was last seen; kept in place until the changes are cleared. Frontend only. */
    ghost?: boolean;
}

export interface GraphIssue {
    level: 'warn' | 'err' | string;
    code: string;
    params?: Record<string, string>;
}

export interface ResourceEdge {
    id: string;
    source: string;
    target: string;
    kind: string; // owner | selector | ingress | config | storage
    label?: string;
    /** Set when the edge is broken: a missing target, a port that does not exist. */
    issue?: GraphIssue;
    /** The source tolerates the target's absence (an optional ConfigMap, a pull secret). */
    optional?: boolean;
    /** Leads to or from a ghost. Frontend only. */
    ghost?: boolean;
}

export interface GraphWarning {
    kind: string;
    reason: string; // forbidden | error
    detail?: string;
}

/** A Kubernetes Node; drawn as the frame around its pods when grouping by node. */
export interface GraphHost {
    name: string;
    ready: boolean;
    issues?: GraphIssue[];
}

export interface ClusterGraph {
    nodes: ResourceNode[];
    edges: ResourceEdge[];
    warnings?: GraphWarning[];
    hosts?: GraphHost[];
}

/**
 * Edges that say how traffic or ownership flows. The rest (`config`,
 * `storage`) say what an object depends on — and one shared dependency (the
 * namespace's `default` ServiceAccount, a StorageClass) is depended on by
 * everything, so highlighting must never climb back up through one.
 */
export const STRUCTURAL_EDGE_KINDS = new Set(['owner', 'selector', 'ingress']);

export type GroupBy = 'none' | 'namespace' | 'node';

export interface LayoutOptions {
    direction: GraphDirection;
    hiddenKinds: string[];
    hideStaleReplicaSets: boolean;
    /** Keep only objects with a problem and what is related to them. */
    onlyProblems?: boolean;
    /** Controllers drawn collapsed: what they own is hidden behind them. */
    collapsed?: Iterable<string>;
    groupBy?: GroupBy;
}

/**
 * A box drawn behind a group of objects: a namespace (or the cluster-scoped
 * objects), or a Kubernetes Node around the pods it runs.
 */
export interface GraphFrame {
    id: string;
    kind: 'namespace' | 'cluster' | 'host' | 'unscheduled';
    /** The namespace or Node name; empty for 'cluster' and 'unscheduled'. */
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
    nodeIds: string[];
}

export interface PlacedNode {
    node: ResourceNode;
    x: number;
    y: number;
}

export interface GraphLayout {
    nodes: PlacedNode[];
    edges: ResourceEdge[];
    /** Objects left out by the kind toggles and the stale-ReplicaSet filter. */
    hiddenCount: number;
    /** What was laid out — the drawn ids and the direction. Equal keys, equal positions. */
    key: string;
    frames: GraphFrame[];
    /** Objects hidden inside a collapsed controller -> that controller. */
    collapsedBy: Map<string, string>;
}

// The row (TB) or column (LR) each kind sits in. Rows are what make the graph
// readable at a glance — every Pod on one line, every Service on another — so
// they are enforced after dagre rather than left to its ranking (a Service with
// no Pods has nothing below it and would otherwise float up to the Ingress row).
export const KIND_RANK: Record<string, number> = {
    Ingress: 0,
    Service: 1,
    Deployment: 2,
    StatefulSet: 2,
    DaemonSet: 2,
    ReplicaSet: 3,
    Pod: 4,
    ServiceAccount: 5,
    ConfigMap: 5,
    PersistentVolumeClaim: 5,
    Secret: 6,
    PersistentVolume: 6,
    StorageClass: 7,
};
const UNKNOWN_RANK = 8;

export const NODE_W = 220;
export const NODE_H = 80;
const NODE_GAP = 20;     // between neighbours in one row
const RANK_GAP = 120;    // between rows
const GROUP_GAP = 60;    // between frames; more than a frame's padding on both sides
export const FRAME_PAD = 14;
export const FRAME_HEAD = 26;

// Edges that say what an object needs. A hidden object in the middle of a
// chain of them is passed through: Pod → (PVC) → PV.
const DEPENDENCY_EDGE_KINDS = new Set(['config', 'storage']);

export const rankOf = (kind: string) => KIND_RANK[kind] ?? UNKNOWN_RANK;

/** A ReplicaSet scaled to zero: the rollout history every Deployment keeps. */
export function isStaleReplicaSet(n: ResourceNode): boolean {
    return n.kind === 'ReplicaSet' && n.status === '0/0';
}

export interface VisibleGraph {
    nodes: ResourceNode[];
    edges: ResourceEdge[];
    /** Objects hidden inside a collapsed controller -> that controller. */
    collapsedBy: Map<string, string>;
}

/**
 * Drops hidden objects without dropping what connects through them. Each end
 * of an edge that lands on a hidden object moves to that object's nearest
 * visible owner: with ReplicaSets hidden, Deployment→ReplicaSet→Pod becomes
 * Deployment→Pod, and with Pods hidden, a Service's selector edges move up to
 * the Deployment that owns those Pods. A collapsed controller hides what it
 * owns the same way. A hidden object with no owner in the middle of a
 * dependency chain is passed through instead: with claims hidden, Pod→PVC→PV
 * becomes Pod→PV. An edge that collapses onto a single node, or has nowhere
 * to move to, is dropped.
 */
export function visibleGraph(graph: ClusterGraph, opts: Pick<LayoutOptions, 'hiddenKinds' | 'hideStaleReplicaSets' | 'onlyProblems' | 'collapsed'>): VisibleGraph {
    const owners = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    const needs = new Map<string, string[]>(); // dependency edges, source -> targets
    const push = (m: Map<string, string[]>, k: string, v: string) => {
        const arr = m.get(k);
        if (arr) arr.push(v); else m.set(k, [v]);
    };
    for (const e of graph.edges) {
        if (e.kind === 'owner') { push(owners, e.target, e.source); push(children, e.source, e.target); }
        else if (DEPENDENCY_EDGE_KINDS.has(e.kind)) push(needs, e.source, e.target);
    }

    // Everything under a collapsed controller, mapped to the outermost
    // collapsed controller above it — the box it is folded into.
    const collapsed = new Set(opts.collapsed ?? []);
    const below = new Map<string, string>();
    for (const c of collapsed) {
        const queue = [...(children.get(c) ?? [])];
        const seen = new Set<string>();
        while (queue.length) {
            const id = queue.shift()!;
            if (seen.has(id)) continue;
            seen.add(id);
            below.set(id, c);
            queue.push(...(children.get(id) ?? []));
        }
    }
    const collapsedBy = new Map<string, string>();
    for (const [id, c] of below) {
        let top = c;
        for (let guard = 0; below.has(top) && guard < 16; guard++) top = below.get(top)!;
        collapsedBy.set(id, top);
    }

    const hiddenKinds = new Set(opts.hiddenKinds);
    const isHidden = (n: ResourceNode) =>
        hiddenKinds.has(n.kind) || (opts.hideStaleReplicaSets && isStaleReplicaSet(n)) || collapsedBy.has(n.id);
    const nodes = graph.nodes.filter(n => !isHidden(n));
    const visible = new Set(nodes.map(n => n.id));

    const resolved = new Map<string, string[]>();
    const resolve = (id: string, seen = new Set<string>()): string[] => {
        if (visible.has(id)) return [id];
        const cached = resolved.get(id);
        if (cached) return cached;
        if (seen.has(id)) return [];
        seen.add(id);
        const out = [...new Set((owners.get(id) ?? []).flatMap(o => resolve(o, seen)))];
        resolved.set(id, out);
        return out;
    };
    // Down a dependency chain to the first visible objects.
    const forward = (id: string, seen = new Set<string>()): string[] => {
        if (visible.has(id)) return [id];
        if (seen.has(id)) return [];
        seen.add(id);
        return [...new Set((needs.get(id) ?? []).flatMap(t => forward(t, seen)))];
    };

    const edges: ResourceEdge[] = [];
    const seenIds = new Set<string>();
    for (const e of graph.edges) {
        let targets = resolve(e.target);
        if (!targets.length && DEPENDENCY_EDGE_KINDS.has(e.kind)) targets = forward(e.target);
        for (const source of resolve(e.source)) {
            for (const target of targets) {
                const id = `${source}->${target}`;
                if (source === target || seenIds.has(id)) continue;
                seenIds.add(id);
                edges.push(source === e.source && target === e.target ? e : { ...e, id, source, target });
            }
        }
    }
    if (opts.onlyProblems) return { ...keepProblems(nodes, edges), collapsedBy };
    return { nodes, edges, collapsedBy };
}

const hasIssues = (n: ResourceNode) => (n.issues?.length ?? 0) > 0;

// Every problem plus its related chain — what it breaks and what it depends on.
function keepProblems(nodes: ResourceNode[], edges: ResourceEdge[]): { nodes: ResourceNode[]; edges: ResourceEdge[] } {
    const isStructural = (e: ResourceEdge) => STRUCTURAL_EDGE_KINDS.has(e.kind);
    const keep = new Set<string>();
    for (const n of nodes) {
        if (!hasIssues(n)) continue;
        for (const id of chainOf(edges, n.id, 'related', isStructural).nodes) keep.add(id);
    }
    return {
        nodes: nodes.filter(n => keep.has(n.id)),
        edges: edges.filter(e => keep.has(e.source) && keep.has(e.target)),
    };
}

const LEVEL_RANK: Record<string, number> = { err: 2, warn: 1 };

export const worstLevel = (n: ResourceNode): 'err' | 'warn' | null => {
    const top = n.issues?.[0]?.level;
    return top === 'err' || top === 'warn' ? top : null;
};

/**
 * The objects the problem navigator steps through: errors before warnings,
 * then in row order (Ingress → … → StorageClass), then by name. Placeholders
 * are left out — the object that references one carries the issue, and
 * counting both would report one fault twice.
 */
export function problemOrder(nodes: ResourceNode[]): ResourceNode[] {
    return nodes
        .filter(n => hasIssues(n) && !n.missing)
        .sort((a, b) =>
            (LEVEL_RANK[worstLevel(b) ?? ''] ?? 0) - (LEVEL_RANK[worstLevel(a) ?? ''] ?? 0)
            || rankOf(a.kind) - rankOf(b.kind)
            || alpha(a, b));
}

const alpha = (a: ResourceNode, b: ResourceNode) =>
    a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);

/**
 * Places the visible graph. Given the previous layout, positions are reused
 * when the same objects and edges are drawn: a refresh that only changed
 * statuses must not re-run dagre, and must not move anything.
 */
export function layoutGraph(graph: ClusterGraph, opts: LayoutOptions, prev?: GraphLayout | null): GraphLayout {
    const { nodes, edges, collapsedBy } = visibleGraph(graph, opts);
    const groupBy = opts.groupBy ?? 'none';
    // Which Node each pod is on is part of the layout when grouping by node.
    const hostKey = groupBy === 'node'
        ? nodes.filter(n => n.kind === 'Pod').map(n => `${n.id}@${n.details?.node ?? ''}`).join('|')
        : '';
    const key = [opts.direction, groupBy, nodes.map(n => n.id).join('|'), edges.map(e => e.id).join('|'), hostKey].join('#');
    const hiddenCount = graph.nodes.length - nodes.length;
    if (prev && prev.key === key) {
        const at = new Map(prev.nodes.map(p => [p.node.id, p]));
        return {
            nodes: nodes.map(node => ({ node, x: at.get(node.id)!.x, y: at.get(node.id)!.y })),
            edges, hiddenCount, key, frames: prev.frames, collapsedBy,
        };
    }

    let placed: PlacedNode[];
    let frames: GraphFrame[] = [];
    if (groupBy === 'namespace') ({ placed, frames } = placeByNamespace(nodes, edges, opts.direction));
    else {
        placed = placeRows(nodes, edges, opts.direction);
        if (groupBy === 'node') frames = groupPodsByHost(placed, opts.direction);
    }
    return { nodes: placed, edges, hiddenCount, key, frames, collapsedBy };
}

// Along a row (cross) and across rows (rank), for the given direction.
const axes = (direction: GraphDirection) => {
    const tb = direction === 'TB';
    return {
        tb,
        crossSize: tb ? NODE_W : NODE_H,
        rankSize: tb ? NODE_H : NODE_W,
        cross: (p: PlacedNode) => (tb ? p.x : p.y),
        setCross: (p: PlacedNode, c: number) => { if (tb) p.x = c; else p.y = c; },
    };
};

/** Every object in its kind's row, ordered by dagre to keep edges from crossing. */
function placeRows(nodes: ResourceNode[], edges: ResourceEdge[], direction: GraphDirection): PlacedNode[] {
    const { tb, crossSize, rankSize } = axes(direction);
    const crossStep = crossSize + NODE_GAP;
    const rankPos = (kind: string) => rankOf(kind) * (rankSize + RANK_GAP);

    const linked = new Set<string>();
    for (const e of edges) { linked.add(e.source); linked.add(e.target); }

    // Dagre orders each row to keep edges from crossing; only its cross-axis
    // coordinate is used. `minlen` spans the rows between the two kinds so its
    // ranking agrees with ours wherever an edge says anything about it.
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: direction, nodesep: NODE_GAP, ranksep: RANK_GAP, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (const n of nodes) {
        if (linked.has(n.id)) g.setNode(n.id, { width: NODE_W, height: NODE_H });
    }
    for (const e of edges) {
        const s = byId.get(e.source);
        const t = byId.get(e.target);
        if (!s || !t) continue;
        g.setEdge(e.source, e.target, { minlen: Math.max(1, rankOf(t.kind) - rankOf(s.kind)) });
    }
    dagre.layout(g);

    // Snap to the kind's row, then sweep each row left to right so nothing that
    // dagre put on a different rank now overlaps.
    const rows = new Map<number, Array<{ node: ResourceNode; cross: number }>>();
    const pushRow = (node: ResourceNode, cross: number) => {
        const r = rankOf(node.kind);
        const row = rows.get(r);
        if (row) row.push({ node, cross }); else rows.set(r, [{ node, cross }]);
    };
    for (const n of nodes) {
        if (!linked.has(n.id)) continue;
        const p = g.node(n.id);
        pushRow(n, (tb ? p.x : p.y) - crossSize / 2);
    }

    const placed: PlacedNode[] = [];
    let rowEnd = 0;
    const settled = new Map<number, Array<{ node: ResourceNode; cross: number }>>();
    for (const [r, row] of rows) {
        row.sort((a, b) => a.cross - b.cross);
        for (let i = 1; i < row.length; i++) {
            row[i].cross = Math.max(row[i].cross, row[i - 1].cross + crossStep);
        }
        settled.set(r, row);
        rowEnd = Math.max(rowEnd, row[row.length - 1].cross + crossStep);
    }

    // Objects with no edge at all have no neighbours to sit beside; they line up
    // in their kind's row after everything that does.
    const loners = nodes.filter(n => !linked.has(n.id)).sort(alpha);
    const looseStart = rowEnd + (rowEnd > 0 ? crossStep : 0);
    const looseCursor = new Map<number, number>();
    for (const n of loners) {
        const r = rankOf(n.kind);
        const cross = looseCursor.get(r) ?? looseStart;
        looseCursor.set(r, cross + crossStep);
        const row = settled.get(r);
        if (row) row.push({ node: n, cross }); else settled.set(r, [{ node: n, cross }]);
    }

    for (const row of settled.values()) {
        for (const { node, cross } of row) {
            const rank = rankPos(node.kind);
            placed.push({ node, x: tb ? cross : rank, y: tb ? rank : cross });
        }
    }
    return placed;
}

/** The frame around some placed objects: padded, with room for its title on top. */
function frameAround(id: string, kind: GraphFrame['kind'], name: string, members: PlacedNode[]): GraphFrame {
    const minX = Math.min(...members.map(p => p.x));
    const minY = Math.min(...members.map(p => p.y));
    const maxX = Math.max(...members.map(p => p.x + NODE_W));
    const maxY = Math.max(...members.map(p => p.y + NODE_H));
    return {
        id, kind, name,
        x: minX - FRAME_PAD,
        y: minY - FRAME_PAD - FRAME_HEAD,
        w: maxX - minX + 2 * FRAME_PAD,
        h: maxY - minY + 2 * FRAME_PAD + FRAME_HEAD,
        nodeIds: members.map(p => p.node.id),
    };
}

/**
 * One block per namespace, side by side, each laid out on its own (rows still
 * line up across blocks, since a row's position comes from the kind alone).
 * Cluster-scoped objects (PVs, StorageClasses) get a block of their own, last.
 */
function placeByNamespace(nodes: ResourceNode[], edges: ResourceEdge[], direction: GraphDirection): { placed: PlacedNode[]; frames: GraphFrame[] } {
    const ax = axes(direction);
    const groups = new Map<string, ResourceNode[]>();
    for (const n of nodes) {
        const arr = groups.get(n.namespace);
        if (arr) arr.push(n); else groups.set(n.namespace, [n]);
    }
    const names = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    const placed: PlacedNode[] = [];
    const frames: GraphFrame[] = [];
    let offset = 0;
    for (const ns of names) {
        const members = groups.get(ns)!;
        const ids = new Set(members.map(n => n.id));
        const own = placeRows(members, edges.filter(e => ids.has(e.source) && ids.has(e.target)), direction);
        const start = Math.min(...own.map(ax.cross));
        const end = Math.max(...own.map(ax.cross)) + ax.crossSize;
        for (const p of own) ax.setCross(p, ax.cross(p) - start + offset);
        placed.push(...own);
        frames.push(frameAround(ns ? `frame:ns:${ns}` : 'frame:cluster', ns ? 'namespace' : 'cluster', ns, own));
        offset += end - start + GROUP_GAP + 2 * FRAME_PAD;
    }
    return { placed, frames };
}

/**
 * The Pod row regrouped by the Node each pod runs on: each Node's pods side
 * by side, blocks ordered by where dagre put their pods (so edges cross as
 * little as they did), a frame around each. Pods not yet scheduled share a
 * block of their own, last.
 */
function groupPodsByHost(placed: PlacedNode[], direction: GraphDirection): GraphFrame[] {
    const ax = axes(direction);
    const pods = placed.filter(p => p.node.kind === 'Pod');
    if (!pods.length) return [];
    const blocks = new Map<string, PlacedNode[]>();
    for (const p of pods) {
        const host = p.node.details?.node ?? '';
        const arr = blocks.get(host);
        if (arr) arr.push(p); else blocks.set(host, [p]);
    }
    const mean = (ps: PlacedNode[]) => ps.reduce((sum, p) => sum + ax.cross(p), 0) / ps.length;
    const order = [...blocks.entries()].sort(([a, pa], [b, pb]) =>
        (a === '' ? 1 : 0) - (b === '' ? 1 : 0) || mean(pa) - mean(pb) || a.localeCompare(b));
    let cursor = Math.min(...pods.map(ax.cross));
    const frames: GraphFrame[] = [];
    for (const [host, members] of order) {
        members.sort((a, b) => ax.cross(a) - ax.cross(b));
        for (const p of members) {
            ax.setCross(p, cursor);
            cursor += ax.crossSize + NODE_GAP;
        }
        cursor += GROUP_GAP + 2 * FRAME_PAD - NODE_GAP;
        frames.push(frameAround(host ? `frame:host:${host}` : 'frame:unscheduled', host ? 'host' : 'unscheduled', host, members));
    }
    return frames;
}

// ── Collapsing controllers ────────────────────────────────────────────────────

export const COLLAPSIBLE_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']);
/** More pods than this and a top-level controller starts collapsed. */
export const AUTO_COLLAPSE_PODS = 5;

/** The pods under each controller, all the way down its owner chain. */
export function podsUnder(graph: ClusterGraph): Map<string, ResourceNode[]> {
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const children = new Map<string, string[]>();
    for (const e of graph.edges) {
        if (e.kind !== 'owner') continue;
        const arr = children.get(e.source);
        if (arr) arr.push(e.target); else children.set(e.source, [e.target]);
    }
    const out = new Map<string, ResourceNode[]>();
    for (const n of graph.nodes) {
        if (!COLLAPSIBLE_KINDS.has(n.kind)) continue;
        const pods: ResourceNode[] = [];
        const queue = [...(children.get(n.id) ?? [])];
        const seen = new Set<string>();
        while (queue.length) {
            const id = queue.shift()!;
            if (seen.has(id)) continue;
            seen.add(id);
            const child = byId.get(id);
            if (child?.kind === 'Pod') pods.push(child);
            queue.push(...(children.get(id) ?? []));
        }
        if (pods.length) out.set(n.id, pods);
    }
    return out;
}

/**
 * Which controllers are drawn collapsed: the user's choice where there is
 * one, otherwise a controller nothing owns that has more than
 * AUTO_COLLAPSE_PODS pods. A ReplicaSet under a Deployment is never collapsed
 * on its own — opening the Deployment should show its pods, not one more box.
 */
export function collapsedSet(graph: ClusterGraph, overrides: Record<string, boolean>, pods = podsUnder(graph)): Set<string> {
    const owned = new Set(graph.edges.filter(e => e.kind === 'owner').map(e => e.target));
    const out = new Set<string>();
    for (const [id, list] of pods) {
        const choice = overrides[id];
        if (choice ?? (!owned.has(id) && list.length > AUTO_COLLAPSE_PODS)) out.add(id);
    }
    return out;
}

/** "12 pods, 1 CrashLoopBackOff": the statuses that are not Running, most common first. */
export function podSummary(pods: ResourceNode[]): { total: number; other: Array<{ status: string; count: number }> } {
    const counts = new Map<string, number>();
    for (const p of pods) {
        const st = p.status || 'Unknown';
        if (st === 'Running') continue;
        counts.set(st, (counts.get(st) ?? 0) + 1);
    }
    const other = [...counts.entries()].map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
    return { total: pods.length, other };
}
