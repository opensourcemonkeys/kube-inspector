import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import React from 'react';
import { VscGlobe, VscTypeHierarchySub, VscLayers, VscDatabase, VscServer, VscCopy, VscPackage, VscRefresh, VscClose, VscNote, VscKey, VscAccount, VscInbox, VscFolder, VscBriefcase, VscChevronUp, VscChevronDown, VscCheck, VscCode, VscInfo, VscOutput, VscFiles, VscTypeHierarchy, VscTrash, VscWarning, VscScreenFull, VscSettings, VscSave, VscExport, VscFoldDown, VscFoldUp } from 'react-icons/vsc';
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
import { Button } from 'primereact/button';
import { Checkbox } from 'primereact/checkbox';
import { ContextMenu } from 'primereact/contextmenu';
import { Dropdown } from 'primereact/dropdown';
import { InputText } from 'primereact/inputtext';
import { OverlayPanel } from 'primereact/overlaypanel';
import { MultiSelect } from 'primereact/multiselect';
import type { MenuItem, MenuItemOptions } from 'primereact/menuitem';
import { GetClusterGraph, GetGraphUsage, GetNamespaces, SaveSvg } from '../../../wailsjs/go/controller_app/App';
import { useTabContext, type LogPanelDef } from '../../contexts/TabContext';
import { useT } from '../../i18n/useT';
import { writeClipboard } from '../../lib/clipboard';
import { applyHighlight, chainOf } from '../../lib/graphHighlight';
import { themeColor, useThemeVersion } from '../../lib/themeColors';
import type { ThemeVar } from '../../lib/themeColors';
import { usePanelActive } from '../../lib/usePanelActive';
import { usePayloadSignature } from '../../lib/usePayloadSignature';
import { useSplitPane } from '../../lib/useSplitPane';
import { REFRESH_CHOICES, useResourceGraphView, useSavedGraphViews, type GraphDirection, type RefreshSeconds, type SavedViewSettings } from '../../stores/resourceGraphStore';
import ErrorBanner from '../shared/ErrorBanner';
import GraphChrome from '../shared/GraphChrome';
import RowAction from '../shared/RowAction';
import Segmented from '../shared/Segmented';
import Spinner from '../shared/Spinner';
import StatusLamp, { type LampTone } from '../shared/StatusLamp';
import ImpactPanel, { IMPACT_TONE, impactLabel } from './ImpactPanel';
import { kindShortLabel, simulateImpact, type Impact, type ImpactMode } from './impact';
import {
    collapsedSet, layoutGraph, NODE_H, NODE_W, podSummary, podsUnder, problemOrder, STRUCTURAL_EDGE_KINDS, worstLevel,
    type ClusterGraph, type GraphFrame, type GraphIssue, type GraphLayout, type GroupBy, type ResourceEdge, type ResourceNode,
} from './graphLayout';
import { graphToSvg, type SvgBox } from './graphSvg';
import { aggregateUsage, changeOrder, diffGraphs, formatUsage, mergeMarks, withGhosts, type ChangeDetail, type ChangeMark, type ChangeMarks, type NodeUsage, type PodUsage } from './liveGraph';

// ── Kind config ───────────────────────────────────────────────────────────────

// Each kind carries a palette *variable*, not a color: reactflow hands some of
// these to SVG attributes (the minimap), where `var(--x)` never resolves, so
// they are resolved with `themeColor` at the point of use instead. Categories,
// not statuses — an Ingress used to be drawn in --err. ReplicaSet gets the
// muted ink because it is the intermediate object nobody is looking for.
// There are six categorical colours and seven workload kinds already, so the
// config and storage kinds take one colour per *group*; the icon and the kind
// label on every box tell them apart. Icons match the sidebar.
// `group`/`resource` address the object for the generic YAML panel; the label
// the box and legend print is kindShortLabel (shared with the delete dialogs).
interface KindConfig {
    color: ThemeVar;
    Icon: React.ComponentType<{ style?: React.CSSProperties }>;
    group: string;
    resource: string;
}

const KIND_CONFIG: Record<string, KindConfig> = {
    Ingress:     { color: '--cat-5', Icon: VscGlobe,            group: 'networking.k8s.io', resource: 'ingresses' },
    Service:     { color: '--cat-3', Icon: VscTypeHierarchySub, group: '',                  resource: 'services' },
    Deployment:  { color: '--cat-1', Icon: VscLayers,           group: 'apps',              resource: 'deployments' },
    StatefulSet: { color: '--cat-2', Icon: VscDatabase,         group: 'apps',              resource: 'statefulsets' },
    DaemonSet:   { color: '--cat-4', Icon: VscServer,           group: 'apps',              resource: 'daemonsets' },
    ReplicaSet:  { color: '--ink-2', Icon: VscCopy,             group: 'apps',              resource: 'replicasets' },
    Pod:         { color: '--cat-6', Icon: VscPackage,          group: '',                  resource: 'pods' },
    ServiceAccount:        { color: '--cat-4', Icon: VscAccount,   group: '',                resource: 'serviceaccounts' },
    ConfigMap:             { color: '--cat-4', Icon: VscNote,      group: '',                resource: 'configmaps' },
    Secret:                { color: '--cat-4', Icon: VscKey,       group: '',                resource: 'secrets' },
    PersistentVolumeClaim: { color: '--cat-2', Icon: VscInbox,     group: '',                resource: 'persistentvolumeclaims' },
    PersistentVolume:      { color: '--cat-2', Icon: VscFolder,    group: '',                resource: 'persistentvolumes' },
    StorageClass:          { color: '--cat-2', Icon: VscBriefcase, group: 'storage.k8s.io',  resource: 'storageclasses' },
};

// The legend's groups; clicking a group's name shows or hides all of it.
const KIND_GROUPS: Array<{ key: 'groupWorkloads' | 'groupConfig' | 'groupStorage'; kinds: string[] }> = [
    { key: 'groupWorkloads', kinds: ['Ingress', 'Service', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Pod'] },
    { key: 'groupConfig', kinds: ['ServiceAccount', 'ConfigMap', 'Secret'] },
    { key: 'groupStorage', kinds: ['PersistentVolumeClaim', 'PersistentVolume', 'StorageClass'] },
];

const kindLabel = kindShortLabel;

const UNKNOWN_KIND = { color: '--ink-3' as ThemeVar, Icon: VscPackage, group: '', resource: '' };

// Dependencies (config, storage) are dotted in their group's colour: they say
// what a workload needs, not where traffic or ownership flows.
const EDGE_STYLE: Record<string, { color: ThemeVar; dash?: string }> = {
    owner:    { color: '--ink-3' },
    selector: { color: '--cat-3', dash: '6 3' },
    ingress:  { color: '--cat-5' },
    config:   { color: '--cat-4', dash: '2 3' },
    storage:  { color: '--cat-2', dash: '2 3' },
};

const EDGE_LEGEND: Array<{ kind: string; key: string; swatch: string; color: ThemeVar }> = [
    { kind: 'owner', key: 'legendOwner', swatch: 'graph-swatch--line', color: EDGE_STYLE.owner.color },
    { kind: 'selector', key: 'legendSelector', swatch: 'graph-swatch--dashed', color: EDGE_STYLE.selector.color },
    { kind: 'ingress', key: 'legendIngress', swatch: 'graph-swatch--line', color: EDGE_STYLE.ingress.color },
    { kind: 'config', key: 'legendConfig', swatch: 'graph-swatch--dotted', color: EDGE_STYLE.config.color },
    { kind: 'storage', key: 'legendStorage', swatch: 'graph-swatch--dotted', color: EDGE_STYLE.storage.color },
    { kind: 'broken', key: 'legendBroken', swatch: 'graph-swatch--dashed', color: '--err' },
];

// A broken edge keeps its route but takes the problem's colour and its own
// dash, so it reads as broken even while dimmed.
const BROKEN_DASH = '5 3';
const GHOST_DASH = '3 4';

const isStructural = (e: Edge) => STRUCTURAL_EDGE_KINDS.has(e.data?.kind);

// The impact summary beside the graph: its width is remembered like the pod
// detail panel's, and both sides keep room to be useful.
const IMPACT_WIDTH_KEY = 'kube-ins:graph-impact-width';
const DEFAULT_IMPACT_WIDTH = 340;
const MIN_IMPACT_PANE = 280;

// Past this many objects the graph stops being something you can read; the
// legend says so instead of quietly drawing a wall of boxes.
const DENSE_GRAPH = 800;

// Kinds with a log stream: a pod's own, or every pod of a controller.
const LOG_KIND: Record<string, LogPanelDef['resourceKind']> = {
    Pod: 'pod', Deployment: 'deployment', StatefulSet: 'statefulset', ReplicaSet: 'replicaset', DaemonSet: 'daemonset',
};

// ── Status ────────────────────────────────────────────────────────────────────

// Pod statuses are kubectl's (getPodStatus): a phase, or the reason that
// matters (CrashLoopBackOff, Init:1/2, Completed).
const POD_OK = new Set(['Running']);
const POD_DONE = new Set(['Completed', 'Succeeded', 'Terminating']);
const POD_ON_ITS_WAY = new Set(['Pending', 'ContainerCreating', 'PodInitializing']);

// A pod status, a volume phase or a "ready/total" count, as a lamp tone.
function statusTone(kind: string, status?: string): LampTone {
    if (!status) return 'idle';
    if (kind === 'Pod') {
        if (POD_OK.has(status)) return 'ok';
        if (POD_DONE.has(status)) return 'idle';
        if (POD_ON_ITS_WAY.has(status) || /^Init:\d+\/\d+$/.test(status)) return 'warn';
        return 'err';
    }
    if (kind === 'PersistentVolumeClaim' || kind === 'PersistentVolume') {
        const phase = status.split(' ')[0];
        if (phase === 'Bound' || phase === 'Available') return 'ok';
        if (phase === 'Pending' || phase === 'Released') return 'warn';
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

// ── Issues ────────────────────────────────────────────────────────────────────

type TFn = ReturnType<typeof useT>;

// The backend sends codes. Pod issues are the Pods list's own diagnosis
// ("pod.<code>") and reuse its wording, so both screens say the same thing.
function issueText(t: TFn, is: GraphIssue): string {
    if (is.code.startsWith('pod.')) {
        const c = is.params?.container;
        return `${c ? `[${c}] ` : ''}${t(`resources:pod.warning.${is.code.slice(4)}` as never, { reason: is.params?.reason ?? '' })}`;
    }
    // count drives plural forms, which need a number; the backend sends strings.
    const params = {
        ...is.params,
        kind: is.params?.kind ? kindLabel(is.params.kind) : undefined,
        count: is.params?.count !== undefined ? Number(is.params.count) : undefined,
    };
    return t(`panels:resourceGraph.issue.${is.code}` as never, params);
}

const lampTone = (level: string): LampTone => (level === 'err' ? 'err' : 'warn');

// One line of a change mark's tooltip.
function changeText(t: TFn, d: ChangeDetail): string {
    switch (d.code) {
        case 'status': return t('panels:resourceGraph.change.status', { from: d.from || '—', to: d.to || '—' });
        case 'restarted': return t('panels:resourceGraph.change.restarted', { count: d.count });
        case 'issueAdded': return t('panels:resourceGraph.change.issueAdded', { issue: issueText(t, d.issue) });
        case 'issueCleared': return t('panels:resourceGraph.change.issueCleared', { issue: issueText(t, d.issue) });
        case 'inside': return t('panels:resourceGraph.change.inside', { count: d.count });
    }
}

// The box's tooltip: every problem (with an event's message, which the box
// has no room for), then what changed. Nothing when the box already says it all.
function nodeTitle(t: TFn, data: K8sNodeData): string | undefined {
    const issues = data.issues ?? [];
    const lines: string[] = [];
    if (issues.length > 1 || issues.some(is => is.params?.message)) {
        for (const is of issues) {
            lines.push(issueText(t, is));
            if (is.params?.message) lines.push(`  ${is.params.message}`);
        }
    }
    if (data.change) {
        if (lines.length) lines.push('');
        lines.push(t(`panels:resourceGraph.change.tag.${data.change.kind}` as never));
        for (const d of data.change.details) lines.push(`  ${changeText(t, d)}`);
    }
    if (data.usage && data.usage.pods > 1 && data.kind !== 'Pod') {
        if (lines.length) lines.push('');
        lines.push(t('panels:resourceGraph.usageSum', { count: data.usage.pods }));
    }
    return lines.length ? lines.join('\n') : undefined;
}

// ── Custom node ───────────────────────────────────────────────────────────────

// In an impact view: how this object is affected, or 'target' for the object
// the analysis is about.
type NodeImpact = Pick<Impact, 'level' | 'recreated' | 'dataLoss'> | 'target';

type K8sNodeData = ResourceNode & {
    horizontal: boolean;
    scopeLabel: string;
    impact?: NodeImpact;
    /** Changed since the marks were last cleared. */
    change?: Pick<ChangeMark, 'kind' | 'details'>;
    /** Live CPU/memory: the pod's own, or the sum of a controller's pods. */
    usage?: NodeUsage;
    /** A controller that can fold its ReplicaSets and pods into itself. */
    collapse?: { collapsed: boolean; pods: number; summary: string };
};

// What a box can ask of the panel. A context rather than callbacks in the
// node data: data is compared on every render, functions in it never match.
const GraphActions = React.createContext<{ toggleCollapse: (id: string) => void; openHost: (name: string) => void }>({
    toggleCollapse: () => {},
    openHost: () => {},
});

function K8sNode({ id, data }: NodeProps<K8sNodeData>) {
    const t = useT();
    const actions = React.useContext(GraphActions);
    const cfg = KIND_CONFIG[data.kind] ?? UNKNOWN_KIND;
    const issues = data.issues ?? [];
    const first = issues[0];
    const level = worstLevel(data);
    const impact = data.impact;
    // In an impact view the fourth line says how the object is affected, in
    // place of its health — that is the question being asked. A collapsed
    // controller with nothing wrong says what it is hiding.
    const collapse = data.collapse;
    const fourth = impact ? 'impact' : first ? 'issue' : collapse?.collapsed ? 'pods' : null;
    const foldLabel = collapse?.collapsed ? t('panels:resourceGraph.foldedPods', { count: collapse.pods }) : FOLD_OPEN;
    const change = data.change;
    const classes = ['graph-node', 'graph-node--tall'];
    if (data.missing) classes.push('graph-node--missing');
    if (data.ghost) classes.push('graph-node--ghost');
    if (change) classes.push('graph-node--changed');
    if (fourth) classes.push('graph-node--issue');
    if (impact && impact !== 'target') classes.push(`impact--${impact.level}`);
    else if (!impact && level) classes.push(`graph-node--${level}`);
    // The kind colour rides a custom property; the rest is .graph-node CSS.
    // A problem is a lamp (shape + text) and a ring, never colour alone.
    return (
        <div
            className={classes.join(' ')}
            style={{ ['--kind' as string]: `var(${cfg.color})`, width: NODE_W, minHeight: NODE_H }}
            title={nodeTitle(t, data)}
        >
            {change && (
                <span className={`graph-node__change graph-node__change--${change.kind}`}>
                    {t(`panels:resourceGraph.change.tag.${change.kind}` as never)}
                </span>
            )}
            <Handle type="target" position={data.horizontal ? Position.Left : Position.Top} />
            <div className="graph-node__kind">
                <cfg.Icon /> {kindLabel(data.kind)}
                {data.status && <span className="graph-node__status"><StatusLamp label={data.status} tone={statusTone(data.kind, data.status)} /></span>}
            </div>
            <div className="graph-node__name" title={data.name}>{data.name}</div>
            <div className="graph-node__sub">
                <span className="graph-node__ns">{data.namespace || data.scopeLabel}</span>
                {data.usage && <span className="graph-node__usage">{formatUsage(data.usage)}</span>}
            </div>
            {fourth === 'impact' && (
                <div className="graph-node__issue">
                    {impact === 'target'
                        ? <StatusLamp tone="idle" label={t('panels:resourceGraph.impact.target')} />
                        : <StatusLamp tone={IMPACT_TONE[impact!.level]} label={impactLabel(t, impact!)} />}
                </div>
            )}
            {fourth === 'issue' && (
                <div className="graph-node__issue">
                    <StatusLamp tone={lampTone(first.level)} label={issueText(t, first)} />
                    {issues.length > 1 && <span className="graph-node__more">{t('panels:resourceGraph.moreIssues', { count: issues.length - 1 })}</span>}
                </div>
            )}
            {fourth === 'pods' && <div className="graph-node__issue graph-node__pods">{collapse!.summary}</div>}
            {collapse && (
                // nodrag/nopan: a press on the button must not start a drag or pan.
                <button
                    type="button"
                    className={`graph-node__fold nodrag nopan${collapse.collapsed ? ' is-collapsed' : ''}`}
                    aria-expanded={!collapse.collapsed}
                    title={collapse.collapsed ? t('panels:resourceGraph.expand') : t('panels:resourceGraph.collapse')}
                    onClick={e => { e.stopPropagation(); actions.toggleCollapse(id); }}
                    onDoubleClick={e => e.stopPropagation()}
                >
                    {foldLabel}
                </button>
            )}
            <Handle type="source" position={data.horizontal ? Position.Right : Position.Bottom} />
        </div>
    );
}

type FrameData = { frame: GraphFrame; title: string; lamps: Array<{ tone: LampTone; label: string }>; detail?: string };

// The box behind a group. Only its title takes the pointer: the body lets
// clicks through to the canvas, so a frame never gets in the way of a pan.
function GroupFrame({ data }: NodeProps<FrameData>) {
    const actions = React.useContext(GraphActions);
    const { frame } = data;
    return (
        <div className={`graph-frame graph-frame--${frame.kind}`} style={{ width: frame.w, height: frame.h }}>
            <div
                className="graph-frame__head"
                onDoubleClick={frame.kind === 'host' ? () => actions.openHost(frame.name) : undefined}
            >
                <span className="graph-frame__title">{data.title}</span>
                {data.lamps.map(l => <StatusLamp key={l.label} tone={l.tone} label={l.label} />)}
                {data.detail && <span className="graph-frame__detail">{data.detail}</span>}
            </div>
        </div>
    );
}

const nodeTypes = { k8sNode: K8sNode, groupFrame: GroupFrame };
// An open controller's fold key: a minus, not a word.
const FOLD_OPEN = '−';
// The View key opens a non-modal panel of settings.
const VIEW_MENU_POPUP = 'dialog';
const isFrame = (n: Node) => n.type === 'groupFrame';

type EdgeData = { kind: string; label?: string; issue?: GraphIssue };

function toFlow(
    graph: ClusterGraph,
    view: { direction: GraphDirection; hiddenKinds: string[]; hideStaleReplicaSets: boolean; onlyProblems: boolean; collapsed: string[]; groupBy: GroupBy },
    scopeLabel: string,
    prevLayout: GraphLayout | null,
) {
    const layout = layoutGraph(graph, view, prevLayout);
    const horizontal = view.direction === 'LR';
    const nodes: Node<K8sNodeData>[] = layout.nodes.map(p => ({
        id: p.node.id,
        type: 'k8sNode',
        position: { x: p.x, y: p.y },
        // Carried on the node because nothing writes the measured size back
        // (no onNodesChange): without it every highlight change hands
        // reactflow size-less nodes, which it hides until re-measured — the
        // whole graph blinked on hover, and the second click of a
        // double-click landed on the pane.
        width: NODE_W,
        height: NODE_H,
        data: { ...p.node, horizontal, scopeLabel },
    }));
    const edges: Edge<EdgeData>[] = layout.edges.map((e: ResourceEdge) => {
        const st = EDGE_STYLE[e.kind] ?? EDGE_STYLE.owner;
        // An edge to or from a ghost is history: grey, and dashed like the ghost's outline.
        const color = themeColor(e.ghost ? '--ink-3' : e.issue ? (e.issue.level === 'err' ? '--err' : '--warn') : st.color);
        const dash = e.ghost ? GHOST_DASH : e.issue ? BROKEN_DASH : st.dash;
        return {
            id: e.id,
            source: e.source,
            target: e.target,
            type: 'smoothstep',
            data: { kind: e.kind, label: e.label, issue: e.issue },
            // Dashed, not animated: a marching dash is a loop that never stops.
            style: { stroke: color, strokeWidth: e.issue ? 2 : 1.5, strokeDasharray: dash },
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
    });
    return { nodes, edges, hiddenCount: layout.hiddenCount, layout };
}

// "12 pods · 1 CrashLoopBackOff · 2 Pending": a collapsed controller's pods.
function podSummaryText(t: TFn, pods: ResourceNode[]): string {
    const s = podSummary(pods);
    const parts = [t('panels:resourceGraph.podCount', { count: s.total })];
    if (!s.other.length) parts.push(t('panels:resourceGraph.allRunning'));
    for (const o of s.other.slice(0, 2)) parts.push(`${o.count} ${o.status}`);
    if (s.other.length > 2) parts.push('…');
    return parts.join(' · ');
}

// A file name that survives every file system: the cluster name is free text.
const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'cluster';

// ── Panel ─────────────────────────────────────────────────────────────────────

interface ClusterResourcePanelParams {
    clusterName: string;
}

// The usage overlay as GetGraphUsage returns it.
interface GraphUsage {
    available: boolean;
    reason?: string;
    pods: PodUsage[];
    hosts?: PodUsage[];
}

const STATUS_COLOR: Record<LampTone, ThemeVar> = { ok: '--ok', warn: '--warn', err: '--err', info: '--info', idle: '--ink-3' };

type LoadKind = 'scope' | 'manual' | 'auto';

const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function ClusterResourcePanel({ params, api }: IDockviewPanelProps<ClusterResourcePanelParams>) {
    const t = useT();
    // Graph colors are resolved values (reactflow puts several in SVG
    // attributes), so a re-render is what repaints after a theme switch.
    const themeVersion = useThemeVersion();
    const cn = params?.clusterName ?? '';
    const { openObjectYaml, openDescribePanel, openLogPanel } = useTabContext();
    const menuRef = useRef<ContextMenu>(null);
    const [menuModel, setMenuModel] = useState<MenuItem[]>([]);
    const [view, patchView] = useResourceGraphView(cn);
    const savedViews = useSavedGraphViews(cn);
    const viewMenuRef = useRef<OverlayPanel>(null);
    const [viewName, setViewName] = useState('');
    // Where the last export went (or why it failed), shown in the View menu.
    const [exportNote, setExportNote] = useState<{ tone: LampTone; text: string } | null>(null);
    // An object picked in Find that is folded into a collapsed controller:
    // the controller opens first, then the view pans to it.
    const [pendingFocus, setPendingFocus] = useState<string | null>(null);
    const [graph, setGraph] = useState<ClusterGraph | null>(null);
    const [namespaceOptions, setNamespaceOptions] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // A failed refresh keeps the last graph on screen and says so here.
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const [updatedAt, setUpdatedAt] = useState<number | null>(null);
    const [usage, setUsage] = useState<GraphUsage | null>(null);
    // What changed since the user last cleared the marks. In memory only:
    // they describe this session's watching, not the cluster.
    const [marks, setMarks] = useState<ChangeMarks>(() => new Map());
    const [changeIdx, setChangeIdx] = useState(-1);
    const active = usePanelActive(api);
    // The clicked node: its related objects stay lit until the pane is clicked.
    const [selectedId, setSelectedId] = useState<string | null>(null);
    // The hovered node: a lighter, one-hop preview, only while nothing is selected.
    const [hoverId, setHoverId] = useState<string | null>(null);
    // What the selection shows: its relations, or the blast radius of
    // deleting it / of it failing. Not persisted; it follows the selection.
    const [focusMode, setFocusMode] = useState<'relations' | ImpactMode>('relations');
    const { splitRef, width: impactWidth, startResize } = useSplitPane(IMPACT_WIDTH_KEY, DEFAULT_IMPACT_WIDTH, MIN_IMPACT_PANE);
    // Not persisted: left on by accident, it would show a healthy cluster as empty.
    const [onlyProblems, setOnlyProblems] = useState(false);
    // Where the problem navigator is; -1 before the first step.
    const [problemIdx, setProblemIdx] = useState(-1);
    const rfRef = useRef<ReactFlowInstance | null>(null);

    // A string key so a new-but-equal array from the store does not refetch.
    const nsKey = view.namespaces.join(',');
    const nsList = useMemo(() => (nsKey ? nsKey.split(',') : []), [nsKey]);

    // The last graph read, which the next one is compared against; null right
    // after the scope changed, so a new scope does not read as all-new.
    const lastGraphRef = useRef<ClusterGraph | null>(null);
    // Every load takes a number; a response that is not the latest one's is
    // dropped, so a slow read of the old namespaces cannot land after the new.
    const seqRef = useRef(0);
    const inFlightRef = useRef(0);
    const lastFetchRef = useRef(0);
    const signature = usePayloadSignature();
    const showUsageRef = useRef(view.showUsage);
    showUsageRef.current = view.showUsage;

    const fetchUsage = useCallback((seq: number) => GetGraphUsage(cn, nsList)
        .then(u => { if (seq === seqRef.current) setUsage(u as unknown as GraphUsage); })
        .catch(() => { /* the overlay is optional */ }), [cn, nsList]);

    // scope: the namespaces changed (or first open) — start the comparison
    // over and frame the result. manual: the refresh key. auto: the timer,
    // which never stacks on a read still running and never moves the view.
    const load = useCallback(async (how: LoadKind) => {
        if (how === 'auto' && inFlightRef.current > 0) return;
        const seq = ++seqRef.current;
        inFlightRef.current++;
        if (how === 'scope') {
            lastGraphRef.current = null;
            signature.reset();
            setMarks(new Map());
            setUsage(null);
        }
        if (how !== 'auto') setLoading(true);
        try {
            const [g] = await Promise.all([
                GetClusterGraph(cn, nsList),
                showUsageRef.current ? fetchUsage(seq) : null,
            ]);
            if (seq !== seqRef.current) return;
            const next = g as unknown as ClusterGraph;
            const prev = lastGraphRef.current;
            lastGraphRef.current = next;
            setError(null);
            setRefreshError(null);
            setUpdatedAt(Date.now());
            // An unchanged read changes nothing: no render, no layout.
            if (!signature.changed(g)) return;
            if (prev) {
                const changes = diffGraphs(prev, next);
                setMarks(m => mergeMarks(m, changes, Date.now()));
            }
            setGraph(next);
            if (how === 'scope') setTimeout(() => rfRef.current?.fitView({ padding: 0.15 }), 120);
        } catch (err: any) {
            if (seq !== seqRef.current) return;
            const msg = err?.message ?? String(err);
            // With a graph on screen a failed refresh is a note, not a wall.
            if (lastGraphRef.current) setRefreshError(msg); else setError(msg);
        } finally {
            inFlightRef.current--;
            lastFetchRef.current = Date.now();
            if (seq === seqRef.current) setLoading(false);
        }
    }, [cn, nsList, signature, fetchUsage]);

    useEffect(() => { load('scope'); }, [load]);

    // The refresh timer runs only while the tab and its window are visible.
    // Coming back after longer than the interval refreshes at once.
    const refreshMs = view.refreshSec * 1000;
    useEffect(() => {
        if (!active || !refreshMs) return;
        let timer: number | undefined;
        let stopped = false;
        const schedule = (ms: number) => {
            timer = window.setTimeout(async () => {
                await load('auto');
                if (!stopped) schedule(refreshMs);
            }, ms);
        };
        schedule(Math.max(0, refreshMs - (Date.now() - lastFetchRef.current)));
        return () => { stopped = true; window.clearTimeout(timer); };
    }, [active, refreshMs, load]);

    useEffect(() => {
        // The picker is a convenience: without it the stored selection still
        // works, so a failure (RBAC on namespaces) only empties the list.
        GetNamespaces(cn)
            .then(list => setNamespaceOptions((list ?? []).map(n => n.name).sort()))
            .catch(() => setNamespaceOptions([]));
    }, [cn]);

    const { direction, hiddenKinds, hideStaleReplicaSets, groupBy } = view;
    const scopeLabel = t('panels:resourceGraph.clusterScoped');
    // Removed objects stay drawn, in place, until their marks are cleared.
    const drawGraph = useMemo(() => (graph ? withGhosts(graph, marks) : null), [graph, marks]);
    // Controllers and their pods; which of them are folded.
    const podsByController = useMemo(() => (drawGraph ? podsUnder(drawGraph) : new Map<string, ResourceNode[]>()), [drawGraph]);
    const collapsed = useMemo(
        () => (drawGraph ? [...collapsedSet(drawGraph, view.collapsed, podsByController)].sort() : []),
        [drawGraph, view.collapsed, podsByController],
    );
    const collapsedIds = useMemo(() => new Set(collapsed), [collapsed]);
    // Owned controllers (a Deployment's ReplicaSet) offer no fold of their own
    // unless the user folded one: opening the Deployment should show pods.
    const ownedIds = useMemo(
        () => new Set((drawGraph?.edges ?? []).filter(e => e.kind === 'owner').map(e => e.target)),
        [drawGraph],
    );
    // The previous layout: when the same objects are drawn, positions are
    // reused rather than recomputed, so a refresh never moves anything.
    const layoutRef = useRef<GraphLayout | null>(null);
    const flow = useMemo(
        () => {
            if (!drawGraph) return { nodes: [] as Node<K8sNodeData>[], edges: [] as Edge[], hiddenCount: 0, layout: null };
            const f = toFlow(drawGraph, { direction, hiddenKinds, hideStaleReplicaSets, onlyProblems, collapsed, groupBy }, scopeLabel, layoutRef.current);
            layoutRef.current = f.layout;
            return f;
        },
        // themeVersion is read by nothing here, but the edge colours are resolved
        // values (themeColor), so a palette switch has to rebuild them.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [drawGraph, direction, hiddenKinds, hideStaleReplicaSets, onlyProblems, collapsed, groupBy, scopeLabel, themeVersion],
    );
    const { edges, hiddenCount } = flow;
    const collapsedBy = flow.layout?.collapsedBy;

    // Marks on objects folded into a collapsed controller show on the controller.
    const insideChanges = useMemo(() => {
        const out = new Map<string, number>();
        if (!collapsedBy) return out;
        for (const id of marks.keys()) {
            const c = collapsedBy.get(id);
            if (c) out.set(c, (out.get(c) ?? 0) + 1);
        }
        return out;
    }, [marks, collapsedBy]);

    // Usage is summed on the raw graph, so a Deployment counts its pods
    // while Pods are hidden from view.
    const usageById = useMemo(
        () => (view.showUsage && graph && usage?.available ? aggregateUsage(graph, usage.pods) : null),
        [view.showUsage, graph, usage],
    );
    const nodes = useMemo(() => flow.nodes.map(n => {
        const own = marks.get(n.id);
        const inside = insideChanges.get(n.id);
        const change = inside
            ? { kind: own?.kind ?? 'changed' as const, details: [...(own?.details ?? []), { code: 'inside' as const, count: inside }] }
            : own;
        const u = usageById?.get(n.id);
        const pods = podsByController.get(n.id);
        const folded = collapsedIds.has(n.id);
        // A fold key on a one-pod controller would hide one box behind another.
        const collapse = pods && (folded || (!ownedIds.has(n.id) && pods.length > 1))
            ? { collapsed: folded, pods: pods.length, summary: podSummaryText(t, pods) }
            : undefined;
        return change || u || collapse ? { ...n, data: { ...n.data, change, usage: u, collapse } } : n;
    }), [flow.nodes, marks, insideChanges, usageById, podsByController, collapsedIds, ownedIds, t]);

    // A layout change re-places every node; frame the result.
    useEffect(() => {
        const id = setTimeout(() => rfRef.current?.fitView({ padding: 0.15 }), 60);
        return () => clearTimeout(id);
    }, [direction, hiddenKinds, hideStaleReplicaSets, onlyProblems, groupBy]);

    // The navigator walks what is drawn, so hiding a kind also skips its problems.
    const problems = useMemo(() => problemOrder(nodes.map(n => n.data)), [nodes]);
    const errCount = problems.filter(n => worstLevel(n) === 'err').length;
    const warnCount = problems.length - errCount;
    useEffect(() => { setProblemIdx(-1); }, [problems]);

    // A selection or hover that a filter or refresh removed from the graph is
    // dropped. The hover matters as much: a node that vanishes under the
    // pointer never fires mouseleave, and a stale hover dims the whole graph.
    useEffect(() => {
        if (selectedId && !nodes.some(n => n.id === selectedId)) setSelectedId(null);
        if (hoverId && !nodes.some(n => n.id === hoverId)) setHoverId(null);
    }, [nodes, selectedId, hoverId]);

    useEffect(() => { if (!selectedId) setFocusMode('relations'); }, [selectedId]);
    const closeImpact = useCallback(() => setFocusMode('relations'), []);
    const drawnIds = useMemo(() => new Set(nodes.map(n => n.id)), [nodes]);
    // A ghost no longer exists: there is nothing to delete or to fail.
    const selectedGhost = !!selectedId && marks.get(selectedId)?.kind === 'removed';
    const impactMode = selectedId && !selectedGhost && focusMode !== 'relations' ? focusMode : null;

    // Marked objects in view, then collapsed controllers hiding marked ones.
    const changes = useMemo(
        () => [...changeOrder(marks, drawnIds), ...[...insideChanges.keys()].filter(id => drawnIds.has(id) && !marks.has(id))],
        [marks, drawnIds, insideChanges],
    );
    useEffect(() => { setChangeIdx(-1); }, [changes.length]);
    const clearMarks = () => { setMarks(new Map()); setChangeIdx(-1); };

    // On the raw graph, so kinds hidden from the view are still counted.
    const byId = useMemo(() => new Map((graph?.nodes ?? []).map(n => [n.id, n])), [graph]);
    const impact = useMemo(
        () => (graph && selectedId && impactMode ? simulateImpact(graph, selectedId, impactMode) : null),
        [graph, selectedId, impactMode],
    );

    // Hover previews relations; in an impact view it would only muddy it.
    const focusId = selectedId ?? (impactMode ? null : hoverId);
    const chain = useMemo(
        () => (focusId && !impactMode ? chainOf(edges, focusId, selectedId ? 'related' : 'neighbors', isStructural) : null),
        [edges, focusId, selectedId, impactMode],
    );
    const display = useMemo(() => {
        if (impact && selectedId) {
            const hit = new Set([selectedId, ...impact.impacts.keys()]);
            return {
                nodes: nodes.map(n => {
                    if (n.id === selectedId) return { ...n, zIndex: 1000, className: 'is-focus', data: { ...n.data, impact: 'target' as const } };
                    const imp = impact.impacts.get(n.id);
                    if (!imp) return { ...n, style: { ...n.style, opacity: 0.22 } };
                    return { ...n, zIndex: 1000, data: { ...n.data, impact: { level: imp.level, recreated: imp.recreated, dataLoss: imp.dataLoss } } };
                }),
                edges: edges.map(e => (hit.has(e.source) && hit.has(e.target)
                    ? { ...e, zIndex: 1000, style: { ...e.style, strokeWidth: 2.25, opacity: 1 } }
                    : { ...e, style: { ...e.style, opacity: 0.1 } })),
            };
        }
        const lit = applyHighlight(nodes, edges, chain, focusId, !selectedId);
        if (!selectedId || !chain) return lit;
        // Labels only along the selected chain: on every edge they would bury
        // the graph. Resolved colours, because reactflow draws them in SVG.
        const labelled = lit.edges.map(e => {
            const label = (e.data as EdgeData | undefined)?.label;
            return label && chain.edges.has(e.id)
                ? {
                    ...e,
                    label,
                    labelStyle: { fill: themeColor('--ink-2'), fontSize: 10, fontFamily: 'var(--font-family-mono)' },
                    labelBgStyle: { fill: themeColor('--bezel'), fillOpacity: 0.9 },
                    labelBgPadding: [4, 2] as [number, number],
                    labelBgBorderRadius: 2,
                }
                : e;
        });
        return { nodes: lit.nodes, edges: labelled };
    // themeVersion: the label colours are resolved values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, edges, chain, focusId, selectedId, impact, themeVersion]);

    // The impact panel takes room from the canvas: frame the analysed object
    // and what it hits in what is left. Closing it moves nothing — the canvas
    // only grows.
    const impactKey = impact && selectedId && impactMode ? `${selectedId}:${impactMode}` : null;
    useEffect(() => {
        if (!impactKey || !impact || !selectedId) return;
        const ids = [selectedId, ...impact.impacts.keys()].filter(id => drawnIds.has(id));
        const timer = setTimeout(() => rfRef.current?.fitView({ nodes: ids.map(id => ({ id })), padding: 0.25, maxZoom: 1.2, duration: 200 }), 80);
        return () => clearTimeout(timer);
        // Only when the analysis changes: a refresh must not move the view.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [impactKey]);

    // Select a node and pan to it. Used by the finder.
    const focusNode = useCallback((nodeId: string | null) => {
        setSelectedId(nodeId);
        if (!nodeId) return;
        const n = nodes.find(x => x.id === nodeId);
        const inst = rfRef.current;
        if (n && inst) {
            inst.setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { zoom: Math.max(inst.getZoom(), 0.9), duration: 300 });
        }
    }, [nodes]);

    // Pan to a node without selecting it: the impact panel's rows, which must
    // not change what the analysis is about. A node hidden from the view has
    // nowhere to pan to.
    const peekNode = useCallback((nodeId: string) => {
        const n = nodes.find(x => x.id === nodeId);
        const inst = rfRef.current;
        if (n && inst) {
            inst.setCenter(n.position.x + NODE_W / 2, n.position.y + NODE_H / 2, { zoom: Math.max(inst.getZoom(), 0.9), duration: 300 });
        }
    }, [nodes]);

    const toggleCollapse = useCallback((id: string) => {
        patchView({ collapsed: { ...view.collapsed, [id]: !collapsedIds.has(id) } });
    }, [patchView, view.collapsed, collapsedIds]);

    const openHost = useCallback((name: string) => {
        openObjectYaml({
            clusterName: cn, kind: 'Node', group: '', resource: 'nodes', namespace: '', name,
            referencePanel: `cluster-resource-view:${cn}`,
        });
    }, [cn, openObjectYaml]);
    const graphActions = useMemo(() => ({ toggleCollapse, openHost }), [toggleCollapse, openHost]);

    // Opens whatever still folds the picked object away, one level per
    // render, then pans to it once it is drawn.
    useEffect(() => {
        if (!pendingFocus) return;
        const c = collapsedBy?.get(pendingFocus);
        if (c) {
            patchView({ collapsed: { ...view.collapsed, [c]: false } });
            return;
        }
        const id = pendingFocus;
        setPendingFocus(null);
        if (nodes.some(n => n.id === id)) setTimeout(() => focusNode(id), 60);
    }, [pendingFocus, collapsedBy, nodes, patchView, view.collapsed, focusNode]);

    // The boxes behind the groups, with what their title says.
    const frameNodes = useMemo((): Node<FrameData>[] => {
        const frames = flow.layout?.frames ?? [];
        if (!frames.length) return [];
        const dataById = new Map(nodes.map(n => [n.id, n.data]));
        const hostInfo = new Map((graph?.hosts ?? []).map(h => [h.name, h]));
        const hostUsage = new Map((usage?.hosts ?? []).map(h => [h.name, h]));
        return frames.map(f => {
            const members = f.nodeIds.map(id => dataById.get(id)).filter((d): d is K8sNodeData => !!d);
            const lamps: FrameData['lamps'] = [];
            let title = f.name;
            let detail: string | undefined;
            if (f.kind === 'namespace' || f.kind === 'cluster') {
                if (f.kind === 'cluster') title = t('panels:resourceGraph.frameCluster');
                const errs = members.filter(m => !m.missing && worstLevel(m) === 'err').length;
                const warns = members.filter(m => !m.missing && worstLevel(m) === 'warn').length;
                if (errs) lamps.push({ tone: 'err', label: t('panels:resourceGraph.errCount', { count: errs }) });
                if (warns) lamps.push({ tone: 'warn', label: t('panels:resourceGraph.warnCount', { count: warns }) });
                detail = t('panels:resourceGraph.frameObjects', { count: members.length });
            } else {
                if (f.kind === 'unscheduled') title = t('panels:resourceGraph.frameUnscheduled');
                const host = hostInfo.get(f.name);
                if (host) {
                    if (host.ready) lamps.push({ tone: 'ok', label: t('panels:resourceGraph.hostReady') });
                    for (const is of host.issues ?? []) lamps.push({ tone: lampTone(is.level), label: issueText(t, is) });
                }
                const parts = [t('panels:resourceGraph.podCount', { count: members.length })];
                const u = view.showUsage ? hostUsage.get(f.name) : undefined;
                if (u) parts.push(formatUsage(u));
                detail = parts.join(' · ');
            }
            return {
                id: f.id,
                type: 'groupFrame',
                position: { x: f.x, y: f.y },
                width: f.w,
                height: f.h,
                data: { frame: f, title, lamps, detail },
                className: 'graph-frame-node',
                selectable: false,
                draggable: false,
                focusable: false,
                zIndex: -1,
            };
        });
    }, [flow.layout, nodes, graph, usage, view.showUsage, t]);

    const openYaml = useCallback((node: ResourceNode) => {
        const cfg = KIND_CONFIG[node.kind];
        if (!cfg || node.ghost) return;
        openObjectYaml({
            clusterName: cn,
            kind: node.kind,
            group: cfg.group,
            resource: cfg.resource,
            namespace: node.namespace,
            name: node.name,
            referencePanel: `cluster-resource-view:${cn}`,
        });
    }, [cn, openObjectYaml]);

    // The right-click menu. Read-only by design: it opens views of the object
    // and the analyses; changing the cluster happens in the lists.
    const openMenu = useCallback((node: ResourceNode, at: { pageX: number; pageY: number; preventDefault?: () => void; stopPropagation?: () => void }) => {
        at.preventDefault?.();
        const cfg = KIND_CONFIG[node.kind];
        const ref = `cluster-resource-view:${cn}`;
        const fullName = node.namespace ? `${node.namespace}/${node.name}` : node.name;
        const item = (label: string, icon: React.ReactNode, command: () => void): MenuItem => ({
            label,
            command,
            template: (it: MenuItem, o: MenuItemOptions) => (
                <a className={o.className} onClick={o.onClick} role="menuitem">
                    {icon}
                    <span className="p-menuitem-text">{it.label}</span>
                </a>
            ),
        });
        const analyse = (mode: 'relations' | ImpactMode) => () => {
            setSelectedId(node.id);
            setFocusMode(mode);
        };
        const head: MenuItem = {
            label: fullName,
            disabled: true,
            template: () => (
                <div className="graph-ctx-menu__head">
                    <span className="graph-ctx-menu__kind">{kindLabel(node.kind)}</span>
                    <span className="graph-ctx-menu__name">{fullName}</span>
                </div>
            ),
        };
        const copy = item(t('panels:resourceGraph.menu.copyName'), <VscFiles size={15} />, () => { void writeClipboard(fullName); });
        // A ghost is gone and a placeholder never existed: there is nothing
        // to open or analyse, only a name to look up elsewhere.
        if (node.ghost || node.missing || !cfg) {
            setMenuModel([head, copy]);
            menuRef.current?.show(at as unknown as React.SyntheticEvent);
            return;
        }
        const logKind = LOG_KIND[node.kind];
        setMenuModel([
            head,
            item(t('panels:resourceGraph.menu.yaml'), <VscCode size={15} />, () => openYaml(node)),
            item(t('panels:resourceGraph.menu.describe'), <VscInfo size={15} />, () => openDescribePanel({
                clusterName: cn, resource: cfg.resource, name: node.name, namespace: node.namespace, referencePanel: ref,
            })),
            ...(logKind ? [item(t('panels:resourceGraph.menu.logs'), <VscOutput size={15} />, () => openLogPanel({
                clusterName: cn, resourceKind: logKind, name: node.name, namespace: node.namespace, referencePanel: ref,
            }))] : []),
            copy,
            { separator: true },
            item(t('panels:resourceGraph.menu.relations'), <VscTypeHierarchy size={15} />, analyse('relations')),
            item(t('panels:resourceGraph.menu.ifDeleted'), <VscTrash size={15} />, analyse('delete')),
            item(t('panels:resourceGraph.menu.ifFails'), <VscWarning size={15} />, analyse('fail')),
            item(t('panels:resourceGraph.menu.center'), <VscScreenFull size={15} />, () => focusNode(node.id)),
        ]);
        menuRef.current?.show(at as unknown as React.SyntheticEvent);
    }, [cn, t, openYaml, openDescribePanel, openLogPanel, focusNode]);

    // The keyboard way in: Shift+F10 or the Menu key opens it for the
    // selected box, placed over the box.
    const openMenuForSelection = useCallback(() => {
        const node = selectedId ? nodes.find(n => n.id === selectedId) : undefined;
        if (!node) return false;
        const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(node.id)}"]`);
        const r = el?.getBoundingClientRect();
        if (!r) return false;
        // PrimeReact positions the menu from pageX/pageY and calls
        // stopPropagation on what it is given, so the stand-in needs both.
        openMenu(node.data, {
            pageX: r.left + 24 + window.scrollX,
            pageY: r.top + r.height / 2 + window.scrollY,
            preventDefault: () => {},
            stopPropagation: () => {},
        });
        return true;
    }, [selectedId, nodes, openMenu]);

    const toggleKind = (kind: string) => {
        const hidden = new Set(view.hiddenKinds);
        if (hidden.has(kind)) hidden.delete(kind); else hidden.add(kind);
        patchView({ hiddenKinds: [...hidden] });
    };

    // A group's name shows the whole group if any of it is hidden, else hides it all.
    const toggleGroup = (kinds: string[]) => {
        const hidden = new Set(view.hiddenKinds);
        const anyHidden = kinds.some(k => hidden.has(k));
        kinds.forEach(k => (anyHidden ? hidden.delete(k) : hidden.add(k)));
        patchView({ hiddenKinds: [...hidden] });
    };

    // No Node access only matters while grouping by Node.
    const warnings = (graph?.warnings ?? []).filter(w => w.kind !== 'Node' || groupBy === 'node');

    const stepProblem = (step: 1 | -1) => {
        if (!problems.length) return;
        const next = problemIdx < 0
            ? (step === 1 ? 0 : problems.length - 1)
            : (problemIdx + step + problems.length) % problems.length;
        setProblemIdx(next);
        focusNode(problems[next].id);
    };

    const stepChange = (step: 1 | -1) => {
        if (!changes.length) return;
        const next = changeIdx < 0
            ? (step === 1 ? 0 : changes.length - 1)
            : (changeIdx + step + changes.length) % changes.length;
        setChangeIdx(next);
        focusNode(changes[next]);
    };

    const refreshNow = () => load('manual');

    const toggleUsage = (on: boolean) => {
        patchView({ showUsage: on });
        if (on) fetchUsage(seqRef.current);
    };

    // How many View settings differ from the defaults; the View key shows it.
    const changedSettings = [direction !== 'TB', groupBy !== 'none', !hideStaleReplicaSets, view.showUsage, onlyProblems]
        .filter(Boolean).length;

    const currentSettings = (): SavedViewSettings => ({
        namespaces: view.namespaces, direction, hiddenKinds, hideStaleReplicaSets,
        showUsage: view.showUsage, groupBy, collapsed: view.collapsed,
    });
    const saveCurrentView = () => {
        const name = viewName.trim();
        if (!name) return;
        savedViews.save(name, currentSettings());
        setViewName('');
    };
    const applyView = (settings: SavedViewSettings) => {
        patchView(settings);
        if (settings.showUsage) fetchUsage(seqRef.current);
    };

    // The whole drawn graph as an SVG file, in the current theme's colours.
    const exportSvg = async () => {
        const boxes: SvgBox[] = nodes.map(n => {
            const d = n.data;
            const first = d.issues?.[0];
            const tone = d.status ? statusTone(d.kind, d.status) : undefined;
            return {
                id: n.id,
                x: n.position.x,
                y: n.position.y,
                kind: kindLabel(d.kind),
                name: d.name,
                sub: [d.namespace || scopeLabel, d.usage ? formatUsage(d.usage) : ''].filter(Boolean).join(' · '),
                status: d.status,
                statusColor: tone ? themeColor(STATUS_COLOR[tone]) : undefined,
                line: first ? issueText(t, first) : d.collapse?.collapsed ? d.collapse.summary : undefined,
                lineColor: first ? themeColor(first.level === 'err' ? '--err' : '--warn') : undefined,
                kindColor: themeColor((KIND_CONFIG[d.kind] ?? UNKNOWN_KIND).color),
                dashed: d.ghost || d.missing,
                faded: d.ghost,
            };
        });
        const svg = graphToSvg({
            boxes,
            edges: edges.map(e => ({
                source: e.source,
                target: e.target,
                color: String(e.style?.stroke ?? themeColor('--ink-3')),
                dash: e.style?.strokeDasharray ? String(e.style.strokeDasharray) : undefined,
                width: Number(e.style?.strokeWidth ?? 1.5),
            })),
            frames: frameNodes.map(f => ({
                ...f.data.frame,
                title: f.data.title,
                detail: [...f.data.lamps.map(l => l.label), f.data.detail].filter(Boolean).join(' · '),
            })),
            direction,
            palette: {
                background: themeColor('--screen'), surface: themeColor('--bezel-raised'), border: themeColor('--line-strong'),
                frame: themeColor('--screen-2'), ink: themeColor('--ink'), ink2: themeColor('--ink-2'), ink3: themeColor('--ink-3'),
                font: getComputedStyle(document.body).fontFamily,
            },
            title: t('panels:resourceGraph.exportTitle', { cluster: cn }),
        });
        // Local time, as the user reads the clock: 20261022-0057.
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        try {
            const path = await SaveSvg(`resource-graph-${fileSafe(cn)}-${stamp}.svg`, svg);
            if (path) setExportNote({ tone: 'ok', text: t('panels:resourceGraph.exportSaved', { path }) });
        } catch (err) {
            setExportNote({ tone: 'err', text: t('panels:resourceGraph.exportFailed', { error: String(err) }) });
        }
    };

    const refreshOptions = useMemo(() => REFRESH_CHOICES.map(sec => ({
        value: String(sec),
        label: sec === 0
            ? t('panels:resourceGraph.refreshOff')
            : sec < 60 ? t('panels:resourceGraph.refreshSeconds', { count: sec }) : t('panels:resourceGraph.refreshMinutes', { count: sec / 60 }),
    })), [t]);

    // What is drawn, plus what is folded into a collapsed controller: picking
    // one of those opens the controller.
    const findOptions = useMemo(() => {
        const label = (n: ResourceNode) => `${kindLabel(n.kind)}  ${n.namespace ? `${n.namespace}/` : ''}${n.name}`;
        const drawn = nodes.map(n => ({ label: label(n.data), value: n.id }));
        const all = new Map((drawGraph?.nodes ?? []).map(n => [n.id, n]));
        const folded = [...(collapsedBy ?? [])].flatMap(([id, c]) => {
            const n = all.get(id);
            const owner = all.get(c);
            return n && owner ? [{ label: `${label(n)}  · ${t('panels:resourceGraph.insideCollapsed', { name: owner.name })}`, value: id }] : [];
        });
        return [...drawn, ...folded].sort((a, b) => a.label.localeCompare(b.label));
    }, [nodes, drawGraph, collapsedBy, t]);

    const pick = (id: string | null) => {
        if (id && collapsedBy?.has(id)) setPendingFocus(id);
        else focusNode(id);
    };

    const focusModeOptions = useMemo(() => [
        { value: 'relations' as const, label: t('panels:resourceGraph.impact.modeRelations') },
        { value: 'delete' as const, label: t('panels:resourceGraph.impact.modeDelete') },
        { value: 'fail' as const, label: t('panels:resourceGraph.impact.modeFail') },
    ], [t]);

    const groupOptions = useMemo(() => [
        { value: 'none' as GroupBy, label: t('panels:resourceGraph.groupNone') },
        { value: 'namespace' as GroupBy, label: t('panels:resourceGraph.groupNamespace') },
        { value: 'node' as GroupBy, label: t('panels:resourceGraph.groupNode') },
    ], [t]);

    const directionOptions = useMemo(() => [
        { value: 'TB' as GraphDirection, label: t('panels:resourceGraph.dirTB') },
        { value: 'LR' as GraphDirection, label: t('panels:resourceGraph.dirLR') },
    ], [t]);

    return (
        <div
            className="graph-root"
            onKeyDown={e => {
                if (e.key === 'Escape' && selectedId) { e.stopPropagation(); setSelectedId(null); }
                if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && openMenuForSelection()) e.preventDefault();
            }}
        >
            <div className="panel-toolbar">
                <span className="panel-toolbar__label"><VscTypeHierarchySub /> {t('panels:resourceGraph.label')}</span>
                <div className="panel-toolbar__actions">
                    {refreshError && <StatusLamp tone="warn" label={t('panels:resourceGraph.refreshFailed')} title={refreshError} />}
                    {loading && <Spinner />}
                    <span className="graph-refresh">
                        <span className="graph-refresh__label">{t('panels:resourceGraph.autoRefresh')}</span>
                        <Segmented
                            value={String(view.refreshSec)}
                            options={refreshOptions}
                            onChange={v => patchView({ refreshSec: Number(v) as RefreshSeconds })}
                            ariaLabel={t('panels:resourceGraph.autoRefresh')}
                        />
                    </span>
                    <RowAction
                        icon={<VscRefresh size={15} />}
                        label={updatedAt ? t('panels:resourceGraph.refreshAt', { time: clockTime(updatedAt) }) : t('panels:resourceGraph.refresh')}
                        onClick={refreshNow}
                        disabled={loading}
                    />
                </div>
            </div>

            <div className="graph-filters">
                <div className="graph-filter graph-filter--wide">
                    <span className="graph-filter__label">{t('panels:resourceGraph.namespaces')}</span>
                    <MultiSelect
                        value={view.namespaces}
                        options={namespaceOptions}
                        onChange={e => patchView({ namespaces: (e.value as string[]) ?? [] })}
                        filter
                        showClear
                        display="chip"
                        maxSelectedLabels={4}
                        placeholder={t('panels:resourceGraph.allNamespaces')}
                        emptyFilterMessage={t('panels:resourceGraph.noMatches')}
                        className="graph-filter__field"
                    />
                </div>
                <div className="graph-filter">
                    <span className="graph-filter__label">{t('panels:resourceGraph.find')}</span>
                    <Dropdown
                        value={selectedId}
                        options={findOptions}
                        onChange={e => pick(e.value ?? null)}
                        filter
                        showClear
                        placeholder={t('panels:resourceGraph.findPlaceholder')}
                        emptyMessage={t('panels:resourceGraph.noMatches')}
                        emptyFilterMessage={t('panels:resourceGraph.noMatches')}
                        virtualScrollerOptions={findOptions.length > 100 ? { itemSize: 32 } : undefined}
                        className="graph-filter__field"
                    />
                </div>
                <div className="graph-problems" role="group" aria-label={t('panels:resourceGraph.problems')}>
                    {problems.length === 0 ? (
                        <StatusLamp tone="ok" label={t('panels:resourceGraph.noProblemsShort')} />
                    ) : (
                        <>
                            {errCount > 0 && <StatusLamp tone="err" label={t('panels:resourceGraph.errCount', { count: errCount })} />}
                            {warnCount > 0 && <StatusLamp tone="warn" label={t('panels:resourceGraph.warnCount', { count: warnCount })} />}
                            {problemIdx >= 0 && <span className="graph-problems__pos">{problemIdx + 1}/{problems.length}</span>}
                            <RowAction icon={<VscChevronUp size={15} />} label={t('panels:resourceGraph.prevProblem')} onClick={() => stepProblem(-1)} />
                            <RowAction icon={<VscChevronDown size={15} />} label={t('panels:resourceGraph.nextProblem')} onClick={() => stepProblem(1)} />
                        </>
                    )}
                </div>
                {changes.length > 0 && (
                    <div className="graph-problems graph-changes" role="group" aria-label={t('panels:resourceGraph.changes')}>
                        <StatusLamp tone="info" label={t('panels:resourceGraph.changeCount', { count: changes.length })} />
                        {changeIdx >= 0 && <span className="graph-problems__pos">{changeIdx + 1}/{changes.length}</span>}
                        <RowAction icon={<VscChevronUp size={15} />} label={t('panels:resourceGraph.prevChange')} onClick={() => stepChange(-1)} />
                        <RowAction icon={<VscChevronDown size={15} />} label={t('panels:resourceGraph.nextChange')} onClick={() => stepChange(1)} />
                        <Button label={t('panels:resourceGraph.markSeen')} icon={<VscCheck size={14} />} text size="small" onClick={clearMarks} />
                    </div>
                )}
                {selectedId && !selectedGhost && (
                    <div className="graph-filter graph-filter--fit">
                        <span className="graph-filter__label">{t('panels:resourceGraph.impact.show')}</span>
                        <Segmented
                            value={focusMode}
                            options={focusModeOptions}
                            onChange={setFocusMode}
                            ariaLabel={t('panels:resourceGraph.impact.show')}
                        />
                    </div>
                )}
                {selectedId && (
                    <Button label={t('panels:resourceGraph.clearFocus')} icon={<VscClose size={14} />} text size="small" onClick={() => setSelectedId(null)} />
                )}
                <Button
                    className="graph-view-key"
                    label={changedSettings ? t('panels:resourceGraph.viewMenuCount', { count: changedSettings }) : t('panels:resourceGraph.viewMenu')}
                    icon={<VscSettings size={14} />}
                    severity="secondary"
                    outlined
                    size="small"
                    aria-haspopup={VIEW_MENU_POPUP}
                    onClick={e => viewMenuRef.current?.toggle(e)}
                />
                <OverlayPanel ref={viewMenuRef} className="graph-view-menu" ariaCloseLabel={t('panels:resourceGraph.impact.close')}>
                    <div className="graph-view-menu__body">
                        <div className="graph-view-menu__row">
                            <span className="graph-view-menu__label">{t('panels:resourceGraph.layout')}</span>
                            <Segmented value={view.direction} options={directionOptions} onChange={d => patchView({ direction: d })} ariaLabel={t('panels:resourceGraph.layout')} />
                        </div>
                        <div className="graph-view-menu__row">
                            <span className="graph-view-menu__label">{t('panels:resourceGraph.groupBy')}</span>
                            <Segmented value={view.groupBy} options={groupOptions} onChange={g => patchView({ groupBy: g })} ariaLabel={t('panels:resourceGraph.groupBy')} />
                        </div>
                        <label className="graph-check">
                            <Checkbox inputId={`graph-stale-rs-${cn}`} checked={view.hideStaleReplicaSets} onChange={e => patchView({ hideStaleReplicaSets: !!e.checked })} />
                            <span>{t('panels:resourceGraph.hideStaleRs')}</span>
                        </label>
                        <label className="graph-check">
                            <Checkbox inputId={`graph-usage-${cn}`} checked={view.showUsage} onChange={e => toggleUsage(!!e.checked)} />
                            <span>{t('panels:resourceGraph.showUsage')}</span>
                            {view.showUsage && usage && !usage.available && (
                                <StatusLamp
                                    tone="idle"
                                    label={t(usage.reason === 'forbidden' ? 'panels:resourceGraph.usageForbidden' : 'panels:resourceGraph.usageUnavailable')}
                                />
                            )}
                        </label>
                        <label className="graph-check">
                            <Checkbox inputId={`graph-only-problems-${cn}`} checked={onlyProblems} onChange={e => setOnlyProblems(!!e.checked)} />
                            <span>{t('panels:resourceGraph.onlyProblems')}</span>
                        </label>
                        {Object.keys(view.collapsed).length > 0 && (
                            <Button
                                label={t('panels:resourceGraph.resetFolds')}
                                icon={<VscFoldDown size={14} />}
                                text
                                size="small"
                                onClick={() => patchView({ collapsed: {} })}
                            />
                        )}

                        <h3 className="graph-view-menu__heading">{t('panels:resourceGraph.savedViews')}</h3>
                        {savedViews.list.length === 0 && <p className="graph-view-menu__note">{t('panels:resourceGraph.noSavedViews')}</p>}
                        {savedViews.list.length > 0 && (
                            <ul className="graph-view-menu__saved">
                                {savedViews.list.map(v => (
                                    <li key={v.name}>
                                        <button type="button" className="graph-view-menu__apply" onClick={() => applyView(v.settings)}>
                                            <VscFoldUp size={13} /> {v.name}
                                        </button>
                                        <RowAction
                                            icon={<VscTrash size={14} />}
                                            label={t('panels:resourceGraph.deleteView', { name: v.name })}
                                            onClick={() => savedViews.remove(v.name)}
                                        />
                                    </li>
                                ))}
                            </ul>
                        )}
                        <form className="graph-view-menu__save" onSubmit={e => { e.preventDefault(); saveCurrentView(); }}>
                            <InputText
                                value={viewName}
                                onChange={e => setViewName(e.target.value)}
                                placeholder={t('panels:resourceGraph.viewNamePlaceholder')}
                                aria-label={t('panels:resourceGraph.viewNamePlaceholder')}
                                className="p-inputtext-sm"
                            />
                            <Button type="submit" label={t('panels:resourceGraph.saveView')} icon={<VscSave size={14} />} size="small" severity="secondary" disabled={!viewName.trim()} />
                        </form>

                        <h3 className="graph-view-menu__heading">{t('panels:resourceGraph.export')}</h3>
                        <Button label={t('panels:resourceGraph.exportSvg')} icon={<VscExport size={14} />} size="small" severity="secondary" outlined onClick={exportSvg} disabled={!nodes.length} />
                        {exportNote && <StatusLamp tone={exportNote.tone} label={exportNote.text} />}
                    </div>
                </OverlayPanel>
            </div>

            <div className="graph-legend">
                {KIND_GROUPS.map(group => {
                    const groupOff = group.kinds.every(k => view.hiddenKinds.includes(k));
                    const groupName = t(`panels:resourceGraph.${group.key}`);
                    return (
                        <span key={group.key} className="graph-legend__group">
                            <button
                                type="button"
                                className={`graph-legend__toggle graph-legend__group-name${groupOff ? ' is-off' : ''}`}
                                aria-pressed={!groupOff}
                                title={t('panels:resourceGraph.toggleGroup', { group: groupName })}
                                onClick={() => toggleGroup(group.kinds)}
                            >
                                {groupName}
                            </button>
                            {group.kinds.map(kind => {
                                const cfg = KIND_CONFIG[kind];
                                const off = view.hiddenKinds.includes(kind);
                                return (
                                    <button
                                        key={kind}
                                        type="button"
                                        className={`graph-legend__item graph-legend__toggle${off ? ' is-off' : ''}`}
                                        style={{ ['--kind' as string]: `var(${cfg.color})` }}
                                        aria-pressed={!off}
                                        title={t('panels:resourceGraph.toggleKind', { kind })}
                                        onClick={() => toggleKind(kind)}
                                    >
                                        <span className="graph-swatch" />{kindLabel(kind)}
                                    </button>
                                );
                            })}
                        </span>
                    );
                })}
            </div>

            <div className="graph-legend graph-legend--secondary">
                {EDGE_LEGEND.map(({ kind, key, swatch, color }) => (
                    <span key={kind} className="graph-legend__item" style={{ ['--kind' as string]: `var(${color})` }}>
                        <span className={`graph-swatch ${swatch}`} />{t(`panels:resourceGraph.${key}` as never)}
                    </span>
                ))}
                <span className="graph-legend__status">
                    {warnings.map(w => (
                        <StatusLamp
                            key={w.kind}
                            tone="warn"
                            label={t(w.reason === 'forbidden' ? 'panels:resourceGraph.warnForbidden' : 'panels:resourceGraph.warnError', { kind: kindLabel(w.kind) })}
                        />
                    ))}
                    {hiddenCount > 0 && <span>{t('panels:resourceGraph.hidden', { count: hiddenCount })}</span>}
                    {nodes.length > DENSE_GRAPH
                        ? <StatusLamp tone="warn" label={t('panels:resourceGraph.tooMany', { count: nodes.length })} />
                        : <span>{t('panels:resourceGraph.tip')}</span>}
                </span>
            </div>

            <div className="pod-split graph-split" ref={splitRef}>
            <div className="graph-canvas pod-split__list">
                {error ? (
                    <ErrorBanner block message={error} onRetry={refreshNow} busy={loading} cluster={cn} context={`Resource graph (${cn})`} />
                ) : (
                    <>
                        <GraphActions.Provider value={graphActions}>
                        <ReactFlow
                            nodes={frameNodes.length ? [...frameNodes, ...display.nodes] : display.nodes}
                            edges={display.edges}
                            nodeTypes={nodeTypes}
                            fitView
                            fitViewOptions={{ padding: 0.15 }}
                            minZoom={0.05}
                            nodesDraggable
                            nodesConnectable={false}
                            elementsSelectable
                            onlyRenderVisibleElements
                            onNodeClick={(_, node) => { if (!isFrame(node)) setSelectedId(prev => prev === node.id ? null : node.id); }}
                            onNodeDoubleClick={(_, node) => { if (!isFrame(node)) openYaml(node.data as ResourceNode); }}
                            onNodeContextMenu={(e, node) => { if (isFrame(node)) e.preventDefault(); else openMenu(node.data as ResourceNode, e); }}
                            onNodeMouseEnter={(_, node) => { if (!impactMode && !isFrame(node)) setHoverId(node.id); }}
                            onNodeMouseLeave={() => setHoverId(null)}
                            onPaneClick={() => setSelectedId(null)}
                            onInit={inst => { rfRef.current = inst; }}
                        >
                            <GraphChrome nodeColor={n => (isFrame(n) ? '--bezel' : KIND_CONFIG[n.data?.kind]?.color ?? UNKNOWN_KIND.color)} />
                        </ReactFlow>
                        </GraphActions.Provider>
                        <ContextMenu
                            ref={menuRef}
                            model={menuModel}
                            className="graph-ctx-menu"
                            // The canvas is overflow:hidden; inline, the menu would be clipped.
                            appendTo={document.body}
                        />
                        {graph && !loading && nodes.length === 0 && (
                            <div className="graph-canvas__empty">
                                {t(onlyProblems ? 'panels:resourceGraph.noProblems' : 'panels:resourceGraph.empty')}
                            </div>
                        )}
                    </>
                )}
            </div>
            {impact && impactMode && selectedId && byId.get(selectedId) && (
                <>
                    <div className="pod-split__handle" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
                    <div className="pod-split__detail" style={{ width: impactWidth }}>
                        <ImpactPanel
                            mode={impactMode}
                            target={byId.get(selectedId)!}
                            result={impact}
                            byId={byId}
                            isHidden={id => !drawnIds.has(id)}
                            kindLabel={kindLabel}
                            kindIcon={kind => {
                                const Icon = (KIND_CONFIG[kind] ?? UNKNOWN_KIND).Icon;
                                return <Icon />;
                            }}
                            onPeek={peekNode}
                            onOpen={openYaml}
                            onClose={closeImpact}
                        />
                    </div>
                </>
            )}
            </div>
        </div>
    );
}
