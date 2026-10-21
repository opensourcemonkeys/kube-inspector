import type { Edge, Node } from 'reactflow';

/**
 * Which part of a directed graph lights up around a node. Shared by the graph
 * panels (Resource Graph, Security Role Map); the walk is pure so it is tested
 * without reactflow.
 *
 * - `lineage`: the node's ancestors and its descendants, never reversing
 *   direction mid-walk. Two RoleBindings that reference one shared ClusterRole
 *   stay apart — an undirected flood-fill would pull each into the other's chain.
 * - `related`: the node's descendants, its ancestors, and the ancestors of its
 *   *structural* descendants along structural edges only. A Deployment's
 *   descendants are its ReplicaSets and Pods (and what they mount); the
 *   Services and Ingresses routing to those Pods are their structural
 *   ancestors — what someone clicking a Deployment wants to see, and what
 *   `lineage` would miss. Climbing back up from a dependency instead would
 *   light the whole namespace through its shared `default` ServiceAccount.
 *   Without `isStructural` every edge counts as structural.
 * - `neighbors`: one hop either way; the light preview shown on hover.
 */
export type ChainMode = 'lineage' | 'related' | 'neighbors';

export interface GraphChain {
    nodes: Set<string>;
    edges: Set<string>;
}

export interface EdgeRef { id: string; source: string; target: string }
type Step = { edgeId: string; other: string; structural: boolean };
type Adjacency = Map<string, Step[]>;

function adjacency<E extends EdgeRef>(edges: E[], isStructural: (e: E) => boolean): { fwd: Adjacency; bwd: Adjacency } {
    const fwd: Adjacency = new Map(); // source -> targets
    const bwd: Adjacency = new Map(); // target -> sources
    const push = (m: Adjacency, k: string, v: Step) => {
        const arr = m.get(k);
        if (arr) arr.push(v); else m.set(k, [v]);
    };
    for (const e of edges) {
        const structural = isStructural(e);
        push(fwd, e.source, { edgeId: e.id, other: e.target, structural });
        push(bwd, e.target, { edgeId: e.id, other: e.source, structural });
    }
    return { fwd, bwd };
}

// Breadth-first from every start node along one direction, adding what it
// crosses to `chain`. Returns the nodes reached (starts included).
function walk(adj: Adjacency, starts: Iterable<string>, chain: GraphChain, maxDepth = Infinity, structuralOnly = false): Set<string> {
    const seen = new Set<string>(starts);
    let frontier = [...seen];
    for (let depth = 0; frontier.length && depth < maxDepth; depth++) {
        const next: string[] = [];
        for (const cur of frontier) {
            for (const { edgeId, other, structural } of adj.get(cur) ?? []) {
                if (structuralOnly && !structural) continue;
                chain.edges.add(edgeId);
                chain.nodes.add(other);
                if (!seen.has(other)) { seen.add(other); next.push(other); }
            }
        }
        frontier = next;
    }
    return seen;
}

export function chainOf<E extends EdgeRef>(
    edges: E[],
    nodeId: string,
    mode: ChainMode,
    isStructural: (e: E) => boolean = () => true,
): GraphChain {
    const { fwd, bwd } = adjacency(edges, isStructural);
    const chain: GraphChain = { nodes: new Set([nodeId]), edges: new Set() };
    switch (mode) {
        case 'neighbors':
            walk(fwd, [nodeId], chain, 1);
            walk(bwd, [nodeId], chain, 1);
            break;
        case 'lineage':
            walk(fwd, [nodeId], chain);
            walk(bwd, [nodeId], chain);
            break;
        case 'related': {
            walk(fwd, [nodeId], chain);
            walk(bwd, [nodeId], chain);
            const scratch: GraphChain = { nodes: new Set(), edges: new Set() };
            const structuralDown = walk(fwd, [nodeId], scratch, Infinity, true);
            walk(bwd, structuralDown, chain, Infinity, true);
            break;
        }
    }
    return chain;
}

/**
 * Dims everything outside `chain` and rings what is inside it — `is-focus` on
 * the focused node, `is-chain` on the rest (theme-monolith.css). `light` is the
 * hover preview: the same shape, a softer dim, so it reads as a preview rather
 * than a selection. Thicker edges, not animated ones: the only looping motion
 * the app allows is a spinner.
 */
export function applyHighlight(
    nodes: Node[],
    edges: Edge[],
    chain: GraphChain | null,
    focusId: string | null,
    light = false,
): { nodes: Node[]; edges: Edge[] } {
    if (!chain) return { nodes, edges };
    const dimNode = light ? 0.45 : 0.22;
    const dimEdge = light ? 0.25 : 0.1;
    return {
        nodes: nodes.map(n => {
            if (!chain.nodes.has(n.id)) return { ...n, style: { ...n.style, opacity: dimNode } };
            return { ...n, zIndex: 1000, className: n.id === focusId ? 'is-focus' : 'is-chain' };
        }),
        edges: edges.map(e => chain.edges.has(e.id)
            ? { ...e, zIndex: 1000, style: { ...e.style, strokeWidth: 2.25, opacity: 1 } }
            : { ...e, style: { ...e.style, opacity: dimEdge } }),
    };
}
