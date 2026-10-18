import { useCallback, useEffect, useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import React from 'react';
import { VscGlobe, VscTypeHierarchySub, VscLayers, VscDatabase, VscServer, VscCopy, VscPackage, VscRefresh } from 'react-icons/vsc';
import ReactFlow, {
    Node,
    Edge,
    MarkerType,
    Handle,
    Position,
    NodeProps,
    ReactFlowInstance,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { GetClusterGraph } from '../../../wailsjs/go/controller_app/App';
import { useT } from '../../i18n/useT';
import { themeColor, useThemeVersion } from '../../lib/themeColors';
import type { ThemeVar } from '../../lib/themeColors';
import ErrorBanner from '../shared/ErrorBanner';
import GraphChrome from '../shared/GraphChrome';
import RowAction from '../shared/RowAction';
import Spinner from '../shared/Spinner';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResourceNode {
    id: string;
    kind: string;
    name: string;
    namespace: string;
    labels: Record<string, string>;
    selector?: Record<string, string>;
    status?: string;
}

interface ClusterGraph {
    nodes: ResourceNode[];
    edges: Array<{ id: string; source: string; target: string; kind: string }>;
}

// ── Kind config ───────────────────────────────────────────────────────────────

// Each kind carries a palette *variable*, not a color: reactflow hands some of
// these to SVG attributes (the minimap), where `var(--x)` never resolves, so
// they are resolved with `themeColor` at the point of use instead. Categories,
// not statuses — an Ingress used to be drawn in --err. ReplicaSet gets the
// muted ink because it is the intermediate object nobody is looking for.
const KIND_CONFIG: Record<string, { color: ThemeVar; Icon: React.ComponentType<{ style?: React.CSSProperties }>; column: number }> = {
    Ingress:     { color: '--cat-5', Icon: VscGlobe,             column: 0 },
    Service:     { color: '--cat-3', Icon: VscTypeHierarchySub,  column: 1 },
    Deployment:  { color: '--cat-1', Icon: VscLayers,            column: 2 },
    StatefulSet: { color: '--cat-2', Icon: VscDatabase,          column: 2 },
    DaemonSet:   { color: '--cat-4', Icon: VscServer,            column: 2 },
    ReplicaSet:  { color: '--ink-2', Icon: VscCopy,              column: 3 },
    Pod:         { color: '--cat-6', Icon: VscPackage,           column: 4 },
};

const UNKNOWN_KIND = { color: '--ink-3' as ThemeVar, Icon: VscPackage, column: 5 };

const NODE_W = 220;
const NODE_H = 80;
const NODE_UNIT_X = NODE_W + 20;   // horizontal step between sibling nodes = 240
const SECTION_GAP_X = 60;          // extra horizontal gap between deployment groups

// Y position of each kind row (top-to-bottom flow)
const ROW_Y: Record<string, number> = {
    Ingress:     0,
    Service:     200,
    Deployment:  400,
    StatefulSet: 400,
    DaemonSet:   400,
    ReplicaSet:  600,
    Pod:         800,
};

// ── Status ────────────────────────────────────────────────────────────────────

// A pod phase or a "ready/total" count, as a lamp tone.
function statusTone(kind: string, status?: string): LampTone {
    if (!status) return 'idle';
    if (kind === 'Pod') {
        if (status === 'Running') return 'ok';
        if (status === 'Pending') return 'warn';
        return 'err';
    }
    if (status.includes('/')) {
        const [ready, total] = status.split('/').map(Number);
        if (ready === total && total > 0) return 'ok';
        if (ready > 0) return 'warn';
        return 'err';
    }
    return 'idle';
}

// ── Custom node ───────────────────────────────────────────────────────────────

function K8sNode({ data }: NodeProps<ResourceNode>) {
    const cfg = KIND_CONFIG[data.kind] ?? UNKNOWN_KIND;
    // The kind colour used to be written as `cfg.color` — a variable *name*
    // ("--err"), which is not a colour, so labels, handles and legend never
    // took it. It rides a custom property now; the rest is .graph-node CSS.
    return (
        <div className="graph-node graph-node--tall" style={{ ['--kind' as string]: `var(${cfg.color})`, width: NODE_W, minHeight: NODE_H }}>
            <Handle type="target" position={Position.Top} />
            <div className="graph-node__kind">
                <cfg.Icon /> {data.kind}
                {data.status && <span className="graph-node__status"><StatusLamp label={data.status} tone={statusTone(data.kind, data.status)} /></span>}
            </div>
            <div className="graph-node__name" title={data.name}>{data.name}</div>
            <div className="graph-node__sub">{data.namespace}</div>
            <Handle type="source" position={Position.Bottom} />
        </div>
    );
}

const nodeTypes = { k8sNode: K8sNode };

// ── Top-to-bottom hierarchical layout ────────────────────────────────────────

function buildFlow(graph: ClusterGraph): { nodes: Node[]; edges: Edge[] } {
    // Owner-reference edges: parent → child
    const ownerChildren = new Map<string, string[]>();
    const ownerParent   = new Map<string, string>();
    for (const e of graph.edges) {
        if (e.kind !== 'owner') continue;
        if (!ownerChildren.has(e.source)) ownerChildren.set(e.source, []);
        ownerChildren.get(e.source)!.push(e.target);
        if (!ownerParent.has(e.target)) ownerParent.set(e.target, e.source);
    }

    const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
    const positions = new Map<string, { x: number; y: number }>();
    let cursor = 0; // horizontal cursor

    const alpha = (a: ResourceNode, b: ResourceNode) =>
        a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);

    // Place a pod → returns its X center
    function placePod(id: string): number {
        const x = cursor;
        positions.set(id, { x, y: ROW_Y['Pod'] });
        cursor += NODE_UNIT_X;
        return x;
    }

    // Place a ReplicaSet (or StatefulSet/DaemonSet leaf) + its pods → returns X center
    function placeRs(id: string, kind: string): number {
        const podIds = (ownerChildren.get(id) ?? [])
            .filter(cid => nodeById.get(cid)?.kind === 'Pod');
        if (podIds.length === 0) {
            const x = cursor;
            positions.set(id, { x, y: ROW_Y[kind] ?? ROW_Y['ReplicaSet'] });
            cursor += NODE_UNIT_X;
            return x;
        }
        const left = cursor;
        podIds.forEach(pid => placePod(pid));
        const centerX = (left + cursor - NODE_UNIT_X) / 2;
        positions.set(id, { x: centerX, y: ROW_Y[kind] ?? ROW_Y['ReplicaSet'] });
        return centerX;
    }

    // Place a Deployment + its ReplicaSets + pods → returns X center
    function placeDeployment(id: string, kind: string): number {
        const childIds = ownerChildren.get(id) ?? [];
        if (childIds.length === 0) {
            const x = cursor;
            positions.set(id, { x, y: ROW_Y[kind] ?? ROW_Y['Deployment'] });
            cursor += NODE_UNIT_X;
            return x;
        }
        const left = cursor;
        childIds.forEach(cid => {
            const child = nodeById.get(cid);
            if (child) placeRs(cid, child.kind);
        });
        const centerX = (left + cursor - NODE_UNIT_X) / 2;
        positions.set(id, { x: centerX, y: ROW_Y[kind] ?? ROW_Y['Deployment'] });
        return centerX;
    }

    // 1. Top-level controllers: Deployment / StatefulSet / DaemonSet
    const controllers = graph.nodes
        .filter(n => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(n.kind) && !ownerParent.has(n.id))
        .sort(alpha);
    for (const ctrl of controllers) {
        placeDeployment(ctrl.id, ctrl.kind);
        cursor += SECTION_GAP_X;
    }

    // 2. Orphan ReplicaSets (no Deployment parent)
    const orphanRs = graph.nodes
        .filter(n => n.kind === 'ReplicaSet' && !ownerParent.has(n.id))
        .sort(alpha);
    for (const rs of orphanRs) {
        placeRs(rs.id, 'ReplicaSet');
    }
    if (orphanRs.length) cursor += SECTION_GAP_X;

    // 3. Orphan Pods (no owner at all)
    graph.nodes
        .filter(n => n.kind === 'Pod' && !ownerParent.has(n.id))
        .sort(alpha)
        .forEach(pod => {
            positions.set(pod.id, { x: cursor, y: ROW_Y['Pod'] });
            cursor += NODE_UNIT_X;
        });

    // 4. Services — center horizontally on average X of their selected pods
    const selectorEdges = graph.edges.filter(e => e.kind === 'selector');
    const usedSvcX = new Set<number>();

    graph.nodes.filter(n => n.kind === 'Service').sort(alpha).forEach(svc => {
        const podXs = selectorEdges
            .filter(e => e.source === svc.id)
            .map(e => positions.get(e.target)?.x)
            .filter((x): x is number => x !== undefined);

        let svcX = podXs.length
            ? podXs.reduce((s, x) => s + x, 0) / podXs.length
            : (cursor += NODE_UNIT_X, cursor - NODE_UNIT_X);

        let slot = Math.round(svcX / 10) * 10;
        while (usedSvcX.has(slot)) { slot += NODE_UNIT_X; svcX = slot; }
        usedSvcX.add(slot);
        positions.set(svc.id, { x: svcX, y: ROW_Y['Service'] });
    });

    // 5. Ingresses — center on average X of their target services
    const ingressEdges = graph.edges.filter(e => e.kind === 'ingress');
    const usedIngX = new Set<number>();

    graph.nodes.filter(n => n.kind === 'Ingress').sort(alpha).forEach(ing => {
        const svcXs = ingressEdges
            .filter(e => e.source === ing.id)
            .map(e => positions.get(e.target)?.x)
            .filter((x): x is number => x !== undefined);

        let ingX = svcXs.length
            ? svcXs.reduce((s, x) => s + x, 0) / svcXs.length
            : (cursor += NODE_UNIT_X, cursor - NODE_UNIT_X);

        let slot = Math.round(ingX / 10) * 10;
        while (usedIngX.has(slot)) { slot += NODE_UNIT_X; ingX = slot; }
        usedIngX.add(slot);
        positions.set(ing.id, { x: ingX, y: ROW_Y['Ingress'] });
    });

    // ── Build ReactFlow nodes ──────────────────────────────────────────────────
    const nodes: Node[] = graph.nodes.map(n => ({
        id: n.id,
        type: 'k8sNode',
        position: positions.get(n.id) ?? { x: cursor, y: ROW_Y[n.kind] ?? 1000 },
        data: n,
    }));

    // ── Build ReactFlow edges (smoothstep avoids straight-line stacking) ───────
    const edges: Edge[] = graph.edges.map(e => {
        const isSelector = e.kind === 'selector';
        const isIngress  = e.kind === 'ingress';
        let color = themeColor('--ink-3');
        if (isSelector) color = themeColor('--cat-3');
        else if (isIngress) color = themeColor('--cat-5');
        return {
            id: e.id,
            source: e.source,
            target: e.target,
            type: 'smoothstep',
            // Dashed, not animated: a marching dash is a loop that never stops.
            style: {
                stroke: color,
                strokeWidth: 1.5,
                strokeDasharray: isSelector ? '6 3' : undefined,
            },
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
    });

    return { nodes, edges };
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface ClusterResourcePanelParams {
    clusterName: string;
}

export default function ClusterResourcePanel({ params }: IDockviewPanelProps<ClusterResourcePanelParams>) {
    const t = useT();
    // Graph colors are resolved values (reactflow puts several in SVG
    // attributes), so a re-render is what repaints after a theme switch.
    useThemeVersion();
    const cn = params?.clusterName ?? '';
    const [nodes, setNodes] = useState<Node[]>([]);
    const [edges, setEdges] = useState<Edge[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const rfRef = useRef<ReactFlowInstance | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const raw: any = await GetClusterGraph(cn);
            const graph: ClusterGraph = raw;
            const { nodes: n, edges: e } = buildFlow(graph);
            setNodes(n);
            setEdges(e);
            setTimeout(() => rfRef.current?.fitView({ padding: 0.15 }), 120);
        } catch (err: any) {
            setError(err?.message ?? String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    return (
        <div className="graph-root">
            <div className="panel-toolbar">
                <span className="panel-toolbar__label"><VscTypeHierarchySub /> {t('panels:resourceGraph.label')}</span>
                <div className="panel-toolbar__actions">
                    {loading && <Spinner />}
                    <RowAction icon={<VscRefresh size={15} />} label={t('panels:resourceGraph.refresh')} onClick={load} disabled={loading} />
                </div>
            </div>

            <div className="graph-legend">
                {Object.entries(KIND_CONFIG).map(([kind, cfg]) => (
                    <span key={kind} className="graph-legend__item" style={{ ['--kind' as string]: `var(${cfg.color})` }}>
                        <span className="graph-swatch" />{kind}
                    </span>
                ))}
                <span className="graph-legend__lines">
                    <span className="graph-legend__item" style={{ ['--kind' as string]: 'var(--ink-3)' }}>
                        <span className="graph-swatch graph-swatch--line" />{t('panels:resourceGraph.legendOwner')}
                    </span>
                    <span className="graph-legend__item" style={{ ['--kind' as string]: 'var(--cat-3)' }}>
                        <span className="graph-swatch graph-swatch--dashed" />{t('panels:resourceGraph.legendSelector')}
                    </span>
                    <span className="graph-legend__item" style={{ ['--kind' as string]: 'var(--cat-5)' }}>
                        <span className="graph-swatch graph-swatch--line" />{t('panels:resourceGraph.legendIngress')}
                    </span>
                </span>
            </div>

            <div className="graph-canvas">
                {error ? (
                    <ErrorBanner block message={error} onRetry={load} busy={loading} cluster={cn} context={`Resource graph (${cn})`} />
                ) : (
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        nodeTypes={nodeTypes}
                        fitView
                        fitViewOptions={{ padding: 0.15 }}
                        nodesDraggable
                        nodesConnectable={false}
                        elementsSelectable
                        onlyRenderVisibleElements
                        onInit={inst => { rfRef.current = inst; }}
                    >
                        <GraphChrome nodeColor={n => KIND_CONFIG[n.data?.kind]?.color ?? UNKNOWN_KIND.color} />
                    </ReactFlow>
                )}
            </div>
        </div>
    );
}
