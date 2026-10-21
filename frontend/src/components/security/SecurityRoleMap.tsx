import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import React from 'react';
import { VscAccount, VscLink, VscLock, VscShield, VscDatabase, VscFile, VscRefresh, VscTypeHierarchySub, VscClose, VscInfo, VscEdit } from 'react-icons/vsc';
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
import dagre from '@dagrejs/dagre';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { Dropdown } from 'primereact/dropdown';
import { InputText } from 'primereact/inputtext';
import { useTabContext } from '../../contexts/TabContext';
import { GetSecurityGraph } from '../../../wailsjs/go/controller_app/App';
import { useT } from '../../i18n/useT';
import { applyHighlight, chainOf } from '../../lib/graphHighlight';
import { themeColor, useThemeVersion } from '../../lib/themeColors';
import type { ThemeVar } from '../../lib/themeColors';
import ErrorBanner from '../shared/ErrorBanner';
import GraphChrome from '../shared/GraphChrome';
import RowAction from '../shared/RowAction';
import Spinner from '../shared/Spinner';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SecurityNodeData {
    id: string;
    kind: string;       // ServiceAccount | RoleBinding | Role | ClusterRole | Resource | Object
    name: string;
    namespace: string;
    verbs?: string;     // Resource nodes: comma-separated permission set, shown in the box
    group?: string;     // backing object's API group (for YAML view/edit)
    resource?: string;  // backing object's resource (plural); set => has YAML
}

interface SecurityGraph {
    nodes: SecurityNodeData[];
    edges: Array<{ id: string; source: string; target: string; kind: string; label?: string }>;
}

// ── Kind config (column = left→right position) ──────────────────────────────────

const KIND_CONFIG: Record<string, { color: ThemeVar; Icon: React.ComponentType<{ style?: React.CSSProperties }> }> = {
    // Palette variables, not colors: the minimap and the edge markers put these
    // in SVG attributes, where `var(--x)` never resolves — they are passed
    // through `themeColor` at the point of use.
    // Categories, not statuses: a Role is not "ok" and a RoleBinding is not a
    // warning, which is what --ok and --warn said here before.
    ServiceAccount: { color: '--cat-1', Icon: VscAccount },
    RoleBinding:    { color: '--cat-4', Icon: VscLink },
    Role:           { color: '--cat-3', Icon: VscLock },
    ClusterRole:    { color: '--cat-2', Icon: VscShield },
    Resource:       { color: '--cat-5', Icon: VscDatabase },
    Object:         { color: '--ink-2', Icon: VscFile },
};

const NODE_W = 210;
const NODE_H = 64;

// ── Edge styling per relationship kind ─────────────────────────────────────────

const UNKNOWN_KIND = { color: '--ink-3' as ThemeVar, Icon: VscTypeHierarchySub };

const EDGE_STYLE: Record<string, { stroke: ThemeVar; dashed: boolean }> = {
    subject:  { stroke: '--cat-1', dashed: false },
    roleref:  { stroke: '--cat-4', dashed: false },
    grants:   { stroke: '--cat-5', dashed: false },
    instance: { stroke: '--ink-3', dashed: false },
};

// ── Custom node ─────────────────────────────────────────────────────────────────

function SecNode({ data }: NodeProps<SecurityNodeData>) {
    const cfg = KIND_CONFIG[data.kind] ?? UNKNOWN_KIND;
    // The kind colour rides a custom property; everything else is in CSS
    // (.graph-node). The box fills the size dagre laid out, so the handles —
    // anchored at its vertical centre — keep role→resource arrows straight.
    return (
        <div className="graph-node" style={{ ['--kind' as string]: `var(${cfg.color})` }}>
            <Handle type="target" position={Position.Left} />
            <div className="graph-node__kind"><cfg.Icon /> {data.kind}</div>
            <div className="graph-node__name" title={data.name}>{data.name}</div>
            {data.namespace && <div className="graph-node__sub">{data.namespace}</div>}
            {data.verbs && (
                <div className="graph-node__chips">
                    {data.verbs.split(', ').map(v => <span key={v} className="graph-node__chip">{v}</span>)}
                </div>
            )}
            <Handle type="source" position={Position.Right} />
        </div>
    );
}

const nodeTypes = { secNode: SecNode };

// ── Layered left→right layout (dagre) ───────────────────────────────────────────
// Dagre assigns ranks from the edge structure (SA→RB→Role→Resource naturally land
// in successive columns) and orders nodes within each rank to minimise edge
// crossings, so arrows no longer pile on top of each other.

// Resource nodes carry verb chips inside the box, so they need extra height for
// dagre to reserve enough vertical room (≈4 chips per line).
function nodeHeight(n: SecurityNodeData): number {
    if (!n.verbs) return NODE_H;
    const lines = Math.ceil(n.verbs.split(', ').length / 4);
    return NODE_H + lines * 15 + 6;
}

function buildFlow(graph: SecurityGraph): { nodes: Node[]; edges: Edge[] } {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: 'LR',
        nodesep: 22,     // gap between nodes in the same rank
        ranksep: 140,    // gap between ranks
        edgesep: 14,
        marginx: 24,
        marginy: 24,
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Object (instance) nodes/edges are no longer drawn in the graph — they live
    // as a filterable list inside the Resource detail popup instead.
    const layoutNodes = graph.nodes.filter(n => n.kind !== 'Object');
    const layoutEdges = graph.edges.filter(e => e.kind !== 'instance');

    for (const n of layoutNodes) {
        g.setNode(n.id, { width: NODE_W, height: nodeHeight(n) });
    }
    for (const e of layoutEdges) {
        // Only lay out edges whose endpoints exist as nodes.
        if (g.hasNode(e.source) && g.hasNode(e.target)) {
            g.setEdge(e.source, e.target);
        }
    }

    dagre.layout(g);

    const nodes: Node[] = layoutNodes.map(n => {
        // dagre returns the node centre; ReactFlow positions from the top-left.
        const p = g.node(n.id);
        const h = nodeHeight(n);
        return {
            id: n.id,
            type: 'secNode',
            position: p ? { x: p.x - NODE_W / 2, y: p.y - h / 2 } : { x: 0, y: 0 },
            // Pin the DOM size to exactly what dagre used so the node's centre (and
            // thus the handle anchors) line up — keeps role→resource arrows straight.
            width: NODE_W,
            height: h,
            style: { width: NODE_W, height: h },
            data: n,
        };
    });

    const edges: Edge[] = layoutEdges.map(e => {
        const st = EDGE_STYLE[e.kind] ?? { stroke: '--ink-3' as ThemeVar, dashed: false };
        return {
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label || undefined,
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed, color: themeColor(st.stroke) },
            style: { stroke: themeColor(st.stroke), strokeWidth: 1.5, strokeDasharray: st.dashed ? '5 4' : undefined },
            labelStyle: { fill: themeColor('--ink-2'), fontSize: 10, fontFamily: 'var(--font-family-mono)' },
            labelBgStyle: { fill: themeColor('--bezel'), fillOpacity: 0.85 },
            labelBgPadding: [4, 2] as [number, number],
        };
    });

    return { nodes, edges };
}

// ── Detail (double-click) ────────────────────────────────────────────────────────
// Builds a relationship/permission summary for one object purely from the
// in-memory graph (no extra backend call).

interface DetailItem { label: string; sub?: string }
interface DetailSection { title: string; items: DetailItem[] }
// `objects` holds the real cluster objects a Resource node grants access to; they
// are rendered as a filterable list (not a plain section) in the detail popup.
interface NodeDetail { node: SecurityNodeData; sections: DetailSection[]; objects?: DetailItem[] }

function computeDetail(graph: SecurityGraph, nodeId: string): NodeDetail | null {
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const node = byId.get(nodeId);
    if (!node) return null;

    const out = graph.edges.filter(e => e.source === nodeId);
    const inc = graph.edges.filter(e => e.target === nodeId);
    const name = (id: string) => byId.get(id)?.name ?? id;
    const ns = (id: string) => byId.get(id)?.namespace ?? '';

    // resource → verbs that a given role/clusterrole grants (verbs live on the
    // resource node now, not on the grant edge)
    const permsOf = (roleId: string): DetailItem[] =>
        graph.edges
            .filter(e => e.source === roleId && e.kind === 'grants')
            .map(e => ({ label: name(e.target), sub: byId.get(e.target)?.verbs }))
            .sort((a, b) => a.label.localeCompare(b.label));

    const sections: DetailSection[] = [];
    let objects: DetailItem[] | undefined;

    if (node.kind === 'ServiceAccount') {
        const items = out.filter(e => e.kind === 'subject').map(e => {
            const roleref = graph.edges.find(x => x.source === e.target && x.kind === 'roleref');
            const role = roleref ? byId.get(roleref.target) : undefined;
            return { label: name(e.target), sub: role ? `→ ${role.kind}: ${role.name}` : undefined };
        });
        sections.push({ title: `Bound via RoleBindings (${items.length})`, items });
    } else if (node.kind === 'RoleBinding') {
        sections.push({
            title: 'Subjects',
            items: inc.filter(e => e.kind === 'subject').map(e => ({ label: name(e.source), sub: ns(e.source) })),
        });
        const roleref = out.find(e => e.kind === 'roleref');
        const role = roleref ? byId.get(roleref.target) : undefined;
        if (role) {
            sections.push({ title: 'Role reference', items: [{ label: role.name, sub: role.kind }] });
            sections.push({ title: `Permissions (${permsOf(role.id).length})`, items: permsOf(role.id) });
        }
    } else if (node.kind === 'Role' || node.kind === 'ClusterRole') {
        sections.push({ title: `Permissions — resource → verbs (${permsOf(nodeId).length})`, items: permsOf(nodeId) });
        sections.push({
            title: 'Used by RoleBindings',
            items: inc.filter(e => e.kind === 'roleref').map(e => ({ label: name(e.source), sub: ns(e.source) })),
        });
    } else if (node.kind === 'Resource') {
        if (node.verbs) {
            sections.push({ title: 'Verbs', items: [{ label: node.verbs }] });
        }
        sections.push({
            title: 'Granted by',
            items: inc.filter(e => e.kind === 'grants').map(e => ({ label: name(e.source), sub: ns(e.source) })),
        });
        objects = out.filter(e => e.kind === 'instance').map(e => ({ label: name(e.target), sub: ns(e.target) || undefined }));
    } else if (node.kind === 'Object') {
        const inst = inc.find(e => e.kind === 'instance');
        const resId = inst?.source;
        if (resId) {
            sections.push({ title: 'Resource type', items: [{ label: name(resId), sub: byId.get(resId)?.namespace }] });
            const grant = graph.edges.find(e => e.target === resId && e.kind === 'grants');
            const role = grant ? byId.get(grant.source) : undefined;
            if (role) {
                sections.push({ title: 'Granted by role', items: [{ label: role.name, sub: `${role.kind}${grant?.label ? ' · ' + grant.label : ''}` }] });
            }
        }
    }

    return { node, sections, objects };
}

// ── Panel ───────────────────────────────────────────────────────────────────────

export default function SecurityRoleMap({ clusterName }: { clusterName: string }) {
    // Graph colors are resolved values (reactflow puts several in SVG
    // attributes), so a re-render is what repaints after a theme switch.
    useThemeVersion();
    const t = useT();
    const cn = clusterName ?? '';
    const [graph, setGraph] = useState<SecurityGraph | null>(null);
    const [nodes, setNodes] = useState<Node[]>([]);
    const [edges, setEdges] = useState<Edge[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The object (node) the user clicked. Everything connected to it (its whole
    // RBAC chain) is highlighted so the relationships can be traced.
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    // The object double-clicked, shown in a detail modal.
    const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
    // Free-text filter for a Resource node's accessible-objects list.
    const [objFilter, setObjFilter] = useState('');
    const rfRef = useRef<ReactFlowInstance | null>(null);
    const { openObjectYaml, openDescribePanel } = useTabContext();

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const raw: any = await GetSecurityGraph(cn);
            const g = raw as SecurityGraph;
            const { nodes: n, edges: e } = buildFlow(g);
            setGraph(g);
            setNodes(n);
            setEdges(e);
            setSelectedNodeId(null);
            setDetailNodeId(null);
            setTimeout(() => rfRef.current?.fitView({ padding: 0.15 }), 120);
        } catch (err: any) {
            setError(err?.message ?? String(err));
        } finally {
            setLoading(false);
        }
    }, [cn]);

    useEffect(() => { load(); }, [load]);

    const openDetail = useCallback((nodeId: string) => { setObjFilter(''); setDetailNodeId(nodeId); }, []);
    const closeDetail = useCallback(() => setDetailNodeId(null), []);

    // Focus a node by id — same effect as clicking it (highlights its chain) plus
    // it pans the view so the node is centred. Used by the filter dropdowns.
    const focusNode = useCallback((nodeId: string | null) => {
        setSelectedNodeId(nodeId);
        if (!nodeId) return;
        const n = nodes.find(x => x.id === nodeId);
        const inst = rfRef.current;
        if (n && inst) {
            const zoom = inst.getZoom();
            inst.setCenter(n.position.x + NODE_W / 2, n.position.y + 40, { zoom, duration: 400 });
        }
    }, [nodes]);

    // Open the object's YAML in a dockview panel (beside this map), not a popup.
    const openYaml = useCallback((node: SecurityNodeData) => {
        if (!node.resource) return;
        openObjectYaml({
            clusterName: cn,
            kind: node.kind,
            group: node.group ?? '',
            resource: node.resource,
            namespace: node.namespace ?? '',
            name: node.name,
            referencePanel: cn ? `securityrolemap:${cn}` : 'securityrolemap',
        });
        closeDetail();
    }, [cn, openObjectYaml, closeDetail]);

    // Same addressing as openYaml, minus the group: describe resolves the plural
    // to a GroupKind server-side through the REST mapper.
    const openDescribe = useCallback((node: SecurityNodeData) => {
        if (!node.resource) return;
        openDescribePanel({
            clusterName: cn,
            resource: node.resource,
            namespace: node.namespace ?? '',
            name: node.name,
            referencePanel: cn ? `securityrolemap:${cn}` : 'securityrolemap',
        });
        closeDetail();
    }, [cn, openDescribePanel, closeDetail]);

    // Highlight only the clicked node's own RBAC chain — its ancestors toward
    // ServiceAccounts and its descendants toward Resources, never reversing
    // direction mid-walk (see `lineage` in lib/graphHighlight.ts).
    const chain = useMemo(
        () => (selectedNodeId ? chainOf(edges, selectedNodeId, 'lineage') : null),
        [edges, selectedNodeId],
    );
    const highlightNodes = chain?.nodes ?? null;

    const { nodes: displayNodes, edges: displayEdges } = useMemo(
        () => applyHighlight(nodes, edges, chain, selectedNodeId),
        [nodes, edges, chain, selectedNodeId],
    );

    // Filter dropdown options per kind. When a node is focused, options narrow to
    // that node's connected chain (highlightNodes) so picking a ServiceAccount
    // surfaces only its related RoleBindings / Roles / ClusterRoles, and so on.
    const optionsByKind = useMemo(() => {
        const mk = (kind: string) => (graph?.nodes ?? [])
            .filter(n => n.kind === kind && (!highlightNodes || highlightNodes.has(n.id)))
            .map(n => ({ label: n.namespace ? `${n.namespace}/${n.name}` : n.name, value: n.id }))
            .sort((a, b) => a.label.localeCompare(b.label));
        return {
            ServiceAccount: mk('ServiceAccount'),
            RoleBinding: mk('RoleBinding'),
            Role: mk('Role'),
            ClusterRole: mk('ClusterRole'),
        } as Record<string, Array<{ label: string; value: string }>>;
    }, [graph, highlightNodes]);

    // The value shown in each dropdown: the focused node id when it is of that
    // kind, otherwise empty.
    const selectedKind = selectedNodeId ? graph?.nodes.find(n => n.id === selectedNodeId)?.kind : undefined;
    const valueForKind = (kind: string) => (selectedKind === kind ? selectedNodeId : null);

    const FILTER_KINDS: Array<keyof typeof KIND_CONFIG> = ['ServiceAccount', 'RoleBinding', 'Role', 'ClusterRole'];

    const detail = detailNodeId && graph ? computeDetail(graph, detailNodeId) : null;
    const detailCfg = detail ? (KIND_CONFIG[detail.node.kind] ?? UNKNOWN_KIND) : null;

    const objectRow = (it: { label: string; sub?: string }, key: React.Key) => (
        <div key={key} className="graph-detail__row">
            <span className="graph-detail__label">{it.label}</span>
            {it.sub && <span className="graph-detail__sub">{it.sub}</span>}
        </div>
    );

    return (
        <div className="graph-root">
            <div className="panel-toolbar">
                <span className="panel-toolbar__label"><VscShield /> {t('panels:roleMap.label')}</span>
                <div className="panel-toolbar__actions">
                    {loading && <Spinner />}
                    <RowAction icon={<VscRefresh size={15} />} label={t('panels:roleMap.refresh')} onClick={load} disabled={loading} />
                </div>
            </div>

            {/* Pick an object to focus it (and narrow the others to its chain). */}
            <div className="graph-filters">
                {FILTER_KINDS.map(kind => {
                    const cfg = KIND_CONFIG[kind];
                    return (
                        <div key={kind} className="graph-filter" style={{ ['--kind' as string]: `var(${cfg.color})` }}>
                            <span className="graph-filter__label"><span className="graph-swatch" />{kind}</span>
                            <Dropdown
                                value={valueForKind(kind)}
                                options={optionsByKind[kind]}
                                onChange={e => focusNode(e.value ?? null)}
                                filter
                                showClear
                                placeholder={t('panels:roleMap.allOf', { count: optionsByKind[kind].length })}
                                emptyMessage={t('panels:roleMap.none')}
                                emptyFilterMessage={t('panels:roleMap.noMatches')}
                                className="graph-filter__field"
                            />
                        </div>
                    );
                })}
                {selectedNodeId && (
                    <Button label={t('panels:roleMap.clearFocus')} icon={<VscClose size={14} />} text size="small" onClick={() => setSelectedNodeId(null)} />
                )}
            </div>

            <div className="graph-legend">
                {Object.entries(KIND_CONFIG).filter(([kind]) => kind !== 'Object').map(([kind, cfg]) => (
                    <span key={kind} className="graph-legend__item" style={{ ['--kind' as string]: `var(${cfg.color})` }}>
                        <span className="graph-swatch" />{kind}
                    </span>
                ))}
                <span className="graph-legend__item" style={{ ['--kind' as string]: `var(${EDGE_STYLE.grants.stroke})` }}>
                    <span className="graph-swatch graph-swatch--line" />{t('panels:roleMap.legendGrants')}
                </span>
                <span className="graph-legend__note">{t('panels:roleMap.tip')}</span>
            </div>

            <div className="graph-canvas">
                {error ? (
                    <ErrorBanner block message={error} onRetry={load} busy={loading} cluster={clusterName} context={`Security role map (${clusterName})`} />
                ) : (
                    <ReactFlow
                        nodes={displayNodes}
                        edges={displayEdges}
                        nodeTypes={nodeTypes}
                        fitView
                        fitViewOptions={{ padding: 0.15 }}
                        nodesDraggable
                        nodesConnectable={false}
                        elementsSelectable
                        onlyRenderVisibleElements
                        onNodeClick={(_, node) => setSelectedNodeId(prev => prev === node.id ? null : node.id)}
                        onNodeDoubleClick={(_, node) => openDetail(node.id)}
                        onPaneClick={() => setSelectedNodeId(null)}
                        onInit={inst => { rfRef.current = inst; }}
                    >
                        <GraphChrome nodeColor={n => KIND_CONFIG[(n.data as SecurityNodeData)?.kind]?.color ?? UNKNOWN_KIND.color} />
                    </ReactFlow>
                )}
            </div>

            {/* Detail (double-click an object) */}
            <Dialog
                visible={!!detail}
                onHide={closeDetail}
                dismissableMask
                className="graph-detail-dialog"
                header={detail && detailCfg ? (
                    <span className="graph-detail__head" style={{ ['--kind' as string]: `var(${detailCfg.color})` }}>
                        <span className="graph-detail__kind"><detailCfg.Icon /> {detail.node.kind}</span>
                        <span className="graph-detail__title">
                            {detail.node.namespace ? `${detail.node.namespace}/${detail.node.name}` : detail.node.name}
                        </span>
                    </span>
                ) : undefined}
            >
                {detail && (
                    <div className="graph-detail">
                        {detail.sections.map((section, si) => (
                            <section key={si}>
                                <h4 className="graph-detail__section">{section.title}</h4>
                                {section.items.length === 0
                                    ? <div className="graph-detail__empty">{t('panels:roleMap.none')}</div>
                                    : <div className="graph-detail__list">{section.items.map(objectRow)}</div>}
                            </section>
                        ))}

                        {/* Accessible objects — filterable list (Resource nodes) */}
                        {detail.objects && (() => {
                            const q = objFilter.trim().toLowerCase();
                            const filtered = q
                                ? detail.objects.filter(o => o.label.toLowerCase().includes(q) || (o.sub ?? '').toLowerCase().includes(q))
                                : detail.objects;
                            return (
                                <section>
                                    <h4 className="graph-detail__section">{t('panels:roleMap.accessibleObjects', { count: detail.objects.length })}</h4>
                                    {detail.objects.length === 0 ? (
                                        <div className="graph-detail__empty">{t('panels:roleMap.none')}</div>
                                    ) : (
                                        <>
                                            <InputText
                                                value={objFilter}
                                                onChange={e => setObjFilter(e.target.value)}
                                                placeholder={t('panels:roleMap.filterObjects')}
                                                className="graph-detail__filter"
                                            />
                                            <div className="graph-detail__list graph-detail__list--scroll">
                                                {filtered.length === 0
                                                    ? <div className="graph-detail__empty">{t('panels:roleMap.noMatches')}</div>
                                                    : filtered.map(objectRow)}
                                            </div>
                                        </>
                                    )}
                                </section>
                            );
                        })()}

                        {/* Object actions — only for nodes backed by a real object */}
                        {detail.node.resource && (
                            <div className="graph-detail__actions">
                                <Button label={t('panels:roleMap.describe')} icon={<VscInfo size={14} />} size="small" severity="secondary" onClick={() => openDescribe(detail.node)} />
                                <Button label={t('panels:roleMap.viewEditYaml')} icon={<VscEdit size={14} />} size="small" onClick={() => openYaml(detail.node)} />
                            </div>
                        )}
                    </div>
                )}
            </Dialog>
        </div>
    );
}
