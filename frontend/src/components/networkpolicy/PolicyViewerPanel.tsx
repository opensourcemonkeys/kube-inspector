import { useCallback, useEffect, useRef, useState } from 'react';






import { VscShield, VscPackage, VscCircleSlash, VscArrowRight, VscArrowLeft, VscDiscard, VscCheck } from 'react-icons/vsc';
import { IDockviewPanelProps } from 'dockview';
import ReactFlow, {
    Node,
    Edge,
    MarkerType,
    Handle,
    Position,
    NodeProps,
    useNodesState,
    useEdgesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import Editor, { OnMount } from '@monaco-editor/react';
// Configures @monaco-editor/react to use the bundled Monaco. Side-effect
// import: this panel is lazily loaded, so Monaco arrives with it.
import '../../lib/monacoBootstrap';
import { themeColor, useThemeVersion, type ThemeVar } from '../../lib/themeColors';
import GraphChrome from '../shared/GraphChrome';
import Spinner from '../shared/Spinner';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import type * as monaco from 'monaco-editor';
import { GetNetworkPolicyDetail, GetNetworkPolicyYaml, ParseNetworkPolicyYaml, UpdateNetworkPolicyYaml } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { MONACO_BASE_OPTIONS, MONACO_THEME, defineMonacoTheme, useMonacoTheme } from '../../lib/monacoTheme';
import { useT, type TFn } from '../../i18n/useT';
import PanelLoading from '../shared/PanelLoading';

interface PolicyViewerPanelParams {
    clusterName: string;
    name: string;
    namespace: string;
}

// ── Node styles ───────────────────────────────────────────────────────────────
//
// Every node is a .graph-flow-node; its category colour rides `--kind`. The
// HTML of a node takes var() fine — only edges and the minimap, which are SVG
// attributes, need a resolved colour (themeColor below and in GraphChrome).
// Categories, not statuses: ingress was --info and egress --warn before, which
// read as "fine" and "careful". Only a deny is a real state, so it keeps --err.

const flowNode = (kind: ThemeVar, size: React.CSSProperties) => ({
    className: 'graph-flow-node',
    style: { ['--kind' as string]: `var(${kind})`, ...size } as React.CSSProperties,
});

// The minimap's colour for a node, from the id scheme buildGraph uses.
const kindOfNode = (id: string): ThemeVar =>
    id === 'policy' ? '--cat-2'
    : id === 'pods' ? '--cat-3'
    : id.startsWith('ingress') ? '--cat-1'
    : id.startsWith('egress') ? '--cat-4'
    : id.startsWith('deny') ? '--err'
    : '--ink-3';

// ── Custom policy node (left target + right source + bottom source) ───────────

function PolicyNodeComponent({ data }: NodeProps) {
    return (
        <>
            <Handle type="target" position={Position.Left} id="left" />
            {data.label}
            <Handle type="source" position={Position.Right} id="right" />
            {/* Toward the affected pods, so in their colour. */}
            <Handle type="source" position={Position.Bottom} id="bottom" className="graph-handle--pods" />
        </>
    );
}

const NODE_TYPES = { policyNode: PolicyNodeComponent };

// ── Graph builder ─────────────────────────────────────────────────────────────

// `t` is a parameter, not a hook call: this is a plain graph builder, not a
// component, so it cannot use useT() — and it must still re-run when the
// language changes, which the caller's useMemo dependency handles.
function buildGraph(detail: models.NetworkPolicyDetail, t: TFn): { nodes: Node[]; edges: Edge[] } {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    const cx = 450;
    const cy = 220;

    nodes.push({
        id: 'policy',
        type: 'policyNode',
        position: { x: cx, y: cy },
        data: {
            label: (
                <div>
                    <div className="graph-node__name">
                        <VscShield size={13} />
                        {detail.name}
                    </div>
                    <div className="graph-node__sub">{detail.namespace}</div>
                    {(detail.policy_types ?? []).length > 0 && (
                        <div className="graph-node__chips">
                            {detail.policy_types.map((pt) => (
                                <span key={pt} className="graph-node__chip graph-node__chip--kind"
                                    style={{ ['--kind' as string]: pt === 'Ingress' ? 'var(--cat-1)' : 'var(--cat-4)' }}>
                                    {pt}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            ),
        },
        ...flowNode('--cat-2', { width: 220 }),
    });

    nodes.push({
        id: 'pods',
        type: 'output',
        targetPosition: Position.Top,
        position: { x: cx, y: cy + 180 },
        data: {
            label: (
                <div>
                    <div className="graph-node__name">
                        <VscPackage size={13} />{' '}
                        {t('panels:policy.affectedPods')}
                    </div>
                    <div className="graph-node__sub">{detail.pod_selector || t('panels:policy.allPods')}</div>
                </div>
            ),
        },
        ...flowNode('--cat-3', { width: 220 }),
    });

    edges.push({
        id: 'policy-pods',
        source: 'policy',
        target: 'pods',
        sourceHandle: 'bottom',
        type: 'straight',
        style: { stroke: themeColor('--cat-3'), strokeDasharray: '4 3' },
        markerEnd: { type: MarkerType.ArrowClosed, color: themeColor('--cat-3') },
    });

    const policyTypes = detail.policy_types ?? [];
    const ingress = detail.ingress_rules ?? [];
    const egress = detail.egress_rules ?? [];

    // Deny node for ingress: policyType includes Ingress but no rules defined
    if (policyTypes.includes('Ingress') && ingress.length === 0) {
        nodes.push({
            id: 'deny-ingress',
            type: 'input',
            sourcePosition: Position.Right,
            position: { x: cx - 370, y: cy },
            data: {
                label: (
                    <div>
                        <div className="graph-node__name">
                            <VscCircleSlash size={13} className="graph-node__deny" />{' '}
                            {t('panels:policy.denyAllIngress')}
                        </div>
                        <div className="graph-node__sub">{t('panels:policy.denyAllIngressHint')}</div>
                    </div>
                ),
            },
            ...flowNode('--err', { minWidth: 180 }),
        });
        edges.push({
            id: 'deny-ingress-edge',
            source: 'deny-ingress',
            target: 'policy',
            targetHandle: 'left',
            style: { stroke: themeColor('--err'), strokeDasharray: '6 3' },
            markerEnd: { type: MarkerType.ArrowClosed, color: themeColor('--err') },
            label: t('panels:policy.blocked'),
            labelStyle: { fill: themeColor('--err'), fontSize: 11, fontWeight: 500 },
            labelBgStyle: { fill: themeColor('--bezel'), fillOpacity: 0.9 },
        });
    }

    // Deny node for egress: policyType includes Egress but no rules defined
    if (policyTypes.includes('Egress') && egress.length === 0) {
        nodes.push({
            id: 'deny-egress',
            type: 'output',
            targetPosition: Position.Left,
            position: { x: cx + 410, y: cy },
            data: {
                label: (
                    <div>
                        <div className="graph-node__name">
                            <VscCircleSlash size={13} className="graph-node__deny" />{' '}
                            {t('panels:policy.denyAllEgress')}
                        </div>
                        <div className="graph-node__sub">{t('panels:policy.denyAllEgressHint')}</div>
                    </div>
                ),
            },
            ...flowNode('--err', { minWidth: 180 }),
        });
        edges.push({
            id: 'deny-egress-edge',
            source: 'policy',
            target: 'deny-egress',
            sourceHandle: 'right',
            style: { stroke: themeColor('--err'), strokeDasharray: '6 3' },
            markerEnd: { type: MarkerType.ArrowClosed, color: themeColor('--err') },
            label: t('panels:policy.blocked'),
            labelStyle: { fill: themeColor('--err'), fontSize: 11, fontWeight: 500 },
            labelBgStyle: { fill: themeColor('--bezel'), fillOpacity: 0.9 },
        });
    }

    const ingressStartY = cy - ((ingress.length - 1) * 130) / 2;

    ingress.forEach((rule, i) => {
        const nodeId = `ingress-${i}`;
        const ports = (rule.ports ?? []).join(', ') || t('panels:policy.allPorts');
        nodes.push({
            id: nodeId,
            type: 'input',
            sourcePosition: Position.Right,
            position: { x: cx - 370, y: ingressStartY + i * 130 },
            data: {
                label: (
                    <div>
                        <div className="graph-node__name">
                            <VscArrowRight size={13} />{' '}
                            {t('panels:policy.ingressRule', { n: i + 1 })}
                        </div>
                        <div className="graph-node__sub">{t('panels:policy.ports', { ports })}</div>
                        {(rule.peers ?? []).map((p, pi) => (
                            <div key={pi} className="graph-node__peer">
                                {p.namespace_selector && <div className="graph-node__meta">{t('panels:policy.namespaceSelector', { selector: p.namespace_selector })}</div>}
                                {p.pod_selector && <div className="graph-node__meta">{t('panels:policy.podSelector', { selector: p.pod_selector })}</div>}
                                {p.ip_block && <div className="graph-node__meta">{t('panels:policy.ipBlock', { block: p.ip_block })}</div>}
                                {(p.ip_block_except ?? []).map((exc, ei) => (
                                    <div key={ei} className="graph-node__meta graph-node__meta--err">
                                        <VscCircleSlash size={9} />{' '}
                                        {t('panels:policy.except', { value: exc })}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                ),
            },
            ...flowNode('--cat-1', { minWidth: 180 }),
        });

        edges.push({
            id: `ingress-edge-${i}`,
            source: nodeId,
            target: 'policy',
            targetHandle: 'left',
            style: { stroke: themeColor('--cat-1') },
            markerEnd: { type: MarkerType.ArrowClosed, color: themeColor('--cat-1') },
        });
    });

    const egressStartY = cy - ((egress.length - 1) * 130) / 2;

    egress.forEach((rule, i) => {
        const nodeId = `egress-${i}`;
        const ports = (rule.ports ?? []).join(', ') || t('panels:policy.allPorts');
        nodes.push({
            id: nodeId,
            type: 'output',
            targetPosition: Position.Left,
            position: { x: cx + 410, y: egressStartY + i * 130 },
            data: {
                label: (
                    <div>
                        <div className="graph-node__name">
                            <VscArrowLeft size={13} />{' '}
                            {t('panels:policy.egressRule', { n: i + 1 })}
                        </div>
                        <div className="graph-node__sub">{t('panels:policy.ports', { ports })}</div>
                        {(rule.peers ?? []).map((p, pi) => (
                            <div key={pi} className="graph-node__peer">
                                {p.namespace_selector && <div className="graph-node__meta">{t('panels:policy.namespaceSelector', { selector: p.namespace_selector })}</div>}
                                {p.pod_selector && <div className="graph-node__meta">{t('panels:policy.podSelector', { selector: p.pod_selector })}</div>}
                                {p.ip_block && <div className="graph-node__meta">{t('panels:policy.ipBlock', { block: p.ip_block })}</div>}
                                {(p.ip_block_except ?? []).map((exc, ei) => (
                                    <div key={ei} className="graph-node__meta graph-node__meta--err">
                                        <VscCircleSlash size={9} />{' '}
                                        {t('panels:policy.except', { value: exc })}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                ),
            },
            ...flowNode('--cat-4', { minWidth: 180 }),
        });

        edges.push({
            id: `egress-edge-${i}`,
            source: 'policy',
            target: nodeId,
            sourceHandle: 'right',
            style: { stroke: themeColor('--cat-4') },
            markerEnd: { type: MarkerType.ArrowClosed, color: themeColor('--cat-4') },
        });
    });

    return { nodes, edges };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PolicyViewerPanel({ params }: IDockviewPanelProps<PolicyViewerPanelParams>) {
    useMonacoTheme();
    const t = useT();
    // The graph's colors are resolved values (reactflow puts several of them in
    // SVG attributes), so a re-render is what repaints it after a theme switch.
    useThemeVersion();
    const { clusterName, name, namespace } = params;
    const cn = clusterName ?? '';

    const [splitPct, setSplitPct] = useState(55);
    const isDragging = useRef(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const [nodes, setNodes, onNodesChange] = useNodesState<Node[]>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge[]>([]);
    const [graphLoading, setGraphLoading] = useState(true);

    // Held at null until the document arrives: the editor must be *created*
    // holding the real YAML. @monaco-editor/react applies a later `value`
    // change to a writable editor as executeEdits + pushUndoStop, so seeding
    // the model with a placeholder puts the placeholder->document transition
    // on Monaco's undo stack and Ctrl+Z on an untouched editor wipes the object.
    const [yaml, setYaml] = useState<string | null>(null);
    const [originalYaml, setOriginalYaml] = useState('');
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const toast = useRef<Toast | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Initial graph load
    useEffect(() => {
        setGraphLoading(true);
        GetNetworkPolicyDetail(cn, name, namespace)
            .then((raw: any) => {
                const detail = models.NetworkPolicyDetail.createFrom(raw);
                const { nodes: n, edges: e } = buildGraph(detail, t);
                setNodes(n);
                setEdges(e);
            })
            .catch((err) => console.error('Failed to load network policy detail:', err))
            .finally(() => setGraphLoading(false));
    }, [name, namespace]);

    // Initial YAML load
    useEffect(() => {
        GetNetworkPolicyYaml(cn, name, namespace)
            .then((result: string) => {
                const content = result || 'No YAML available';
                setYaml(content);
                setOriginalYaml(content);
            })
            .catch(() => setYaml('Failed to load YAML.'));
    }, [name, namespace]);

    // ── Drag divider ──
    const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
        isDragging.current = true;
        e.preventDefault();
    }, []);

    const handleDividerKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSplitPct((prev) => Math.max(prev - 2, 20));
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSplitPct((prev) => Math.min(prev + 2, 80));
        }
    }, []);

    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (!isDragging.current || !containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const pct = ((e.clientY - rect.top) / rect.height) * 100;
            setSplitPct(Math.min(Math.max(pct, 20), 80));
        };
        const onUp = () => { isDragging.current = false; };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, []);

    // ── YAML editor handlers ──
    const handleMount: OnMount = (editor) => {
        editorRef.current = editor;
        requestAnimationFrame(() => editor.layout());
    };

    const handleChange = (value: string | undefined) => {
        const val = value ?? '';
        setDirty(val !== originalYaml);

        // Debounced graph refresh
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            if (!val.trim()) return;
            try {
                const raw: any = await ParseNetworkPolicyYaml(val);
                const detail = models.NetworkPolicyDetail.createFrom(raw);
                const { nodes: n, edges: e } = buildGraph(detail, t);
                setNodes(n);
                setEdges(e);
            } catch {
                // YAML not yet valid, skip graph update
            }
        }, 600);
    };

    const handleSave = async () => {
        const value = editorRef.current?.getValue() ?? yaml ?? '';
        setSaving(true);
        try {
            await UpdateNetworkPolicyYaml(cn, name, namespace, value);
            setOriginalYaml(value);
            setYaml(value);
            setDirty(false);
            toast.current?.show({ severity: 'success', summary: 'Updated', detail: `${namespace}/${name} updated`, life: 2500 });
        } catch {
            toast.current?.show({ severity: 'error', summary: 'Update failed', detail: `${namespace}/${name} could not be updated`, life: 3500 });
        } finally {
            setSaving(false);
        }
    };

    const handleRevert = () => {
        editorRef.current?.setValue(originalYaml);
        setDirty(false);
        // Revert graph to original state
        GetNetworkPolicyDetail(cn, name, namespace)
            .then((raw: any) => {
                const detail = models.NetworkPolicyDetail.createFrom(raw);
                const { nodes: n, edges: e } = buildGraph(detail, t);
                setNodes(n);
                setEdges(e);
            })
            .catch(() => {});
    };

    return (
        <div ref={containerRef} className="graph-root">
            <Toast ref={toast} position="bottom-right" />

            {/* Toolbar */}
            <div className="panel-toolbar">
                <span className="panel-toolbar__label"><VscShield /> {namespace}/{name}</span>
                <div className="panel-toolbar__actions">
                    <Button
                        label={t('panels:yaml.revert')}
                        icon={<VscDiscard size={16} />}
                        text
                        size="small"
                        disabled={!dirty || saving}
                        onClick={handleRevert}
                    />
                    <Button
                        label={t('panels:yaml.save')}
                        icon={<VscCheck size={16} />}
                        size="small"
                        loading={saving}
                        disabled={!dirty}
                        onClick={handleSave}
                    />
                </div>
            </div>

            {/* Top: ReactFlow */}
            <div className="graph-canvas graph-canvas--split" style={{ flexBasis: `${splitPct}%` }}>
                {graphLoading ? (
                    <div className="graph-canvas__loading"><Spinner size={22} /></div>
                ) : (
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        nodeTypes={NODE_TYPES}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        fitView
                        fitViewOptions={{ padding: 0.3 }}
                        nodesDraggable
                        nodesConnectable={false}
                        elementsSelectable
                        onlyRenderVisibleElements
                    >
                        <GraphChrome nodeColor={(n) => kindOfNode(n.id)} />
                    </ReactFlow>
                )}
            </div>

            {/* Divider */}
            <button
                type="button"
                aria-label={t('panels:policy.resizeDivider')}
                onMouseDown={handleDividerMouseDown}
                onKeyDown={handleDividerKeyDown}
                className="graph-divider"
            >
                <span className="graph-divider__grip" />
            </button>

            {/* Bottom: YAML Editor */}
            <div className="graph-editor">
                {yaml === null ? <PanelLoading /> : <Editor
                    height="100%"
                    defaultLanguage="yaml"
                    language="yaml"
                    value={yaml}
                    theme={MONACO_THEME}
                    beforeMount={defineMonacoTheme}
                    onMount={handleMount}
                    onChange={handleChange}
                    options={{
                        ...MONACO_BASE_OPTIONS,
                        minimap: { enabled: true },
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        automaticLayout: true,
                        lineNumbers: 'on',
                        folding: true,
                        renderLineHighlight: 'all',
                    }}
                />}
            </div>
        </div>
    );
}
