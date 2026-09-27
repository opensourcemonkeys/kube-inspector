import { useCallback, useEffect, useRef, useState } from 'react';
import React from 'react';
import type { DockviewPanelApi } from 'dockview';
import { Trans } from 'react-i18next';
import { Chart } from 'primereact/chart';
import { VscServer, VscPass, VscCircleSlash, VscOutput, VscNote, VscClose, VscInfo, VscLocation, VscTag, VscDesktopDownload, VscChip, VscDatabase, VscTerminal } from 'react-icons/vsc';
import { Tag } from 'primereact/tag';
import { Toast } from 'primereact/toast';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { ProgressSpinner } from 'primereact/progressspinner';
import { GetNodes, CordonNode, UncordonNode, DrainNode } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import { errText } from '../../lib/errText';
import ErrorBanner from '../shared/ErrorBanner';
import { useT } from '../../i18n/useT';
import { getUsageColor } from '../../lib/usage';
import { themeColor, useThemeVersion } from '../../lib/themeColors';
import { usePanelActive } from '../../lib/usePanelActive';
import { usePayloadSignature } from '../../lib/usePayloadSignature';

type Severity = 'success' | 'warning' | 'danger' | 'info' | 'secondary' | 'contrast' | undefined;

const getStatusSeverity = (status: string): Severity => {
    switch (status) {
        case 'Ready':    return 'success';
        case 'NotReady': return 'danger';
        default:         return 'warning';
    }
};

const barOptions = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
        x: { stacked: true, display: false, min: 0, max: 100 },
        y: { stacked: true, display: false },
    },
    events: [] as any[],
};

function UsageChart({ label, used, total, unit }: {
    label: string; used: number; total: number; unit: string;
}) {
    const chartRef = useRef<any>(null);
    const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
    const color = getUsageColor(pct);

    const [chartData] = useState(() => ({
        labels: [''],
        datasets: [
            { data: [pct],       backgroundColor: [getUsageColor(pct)], borderRadius: 3, borderSkipped: false as const },
            { data: [100 - pct], backgroundColor: [themeColor('--line2')],          borderRadius: 0, borderSkipped: false as const },
        ],
    }));

    useEffect(() => {
        const chart = chartRef.current?.getChart?.();
        if (!chart) return;
        chart.data.datasets[0].data = [pct];
        chart.data.datasets[0].backgroundColor = [color];
        chart.data.datasets[1].data = [100 - pct];
        chart.update('none');
    }, [used, total]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{
                fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.05em', color: 'var(--ink2)',
                width: '2.8rem', textAlign: 'right', flexShrink: 0,
            }}>{label}</span>
            <div style={{ flex: 1, height: '18px', minWidth: 0 }}>
                <Chart ref={chartRef} type="bar" data={chartData} options={barOptions} style={{ height: '18px' }} />
            </div>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color, width: '2.8rem', textAlign: 'right', flexShrink: 0 }}>
                {pct.toFixed(0)}%
            </span>
            <span style={{ fontSize: '0.68rem', color: 'var(--ink2)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {used.toLocaleString()} / {total.toLocaleString()} {unit}
            </span>
        </div>
    );
}

/**
 * One node's card. Memoized because a cluster of any size renders a lot of
 * these and `loadNodes` only replaces the array when the payload really
 * changed — so on a quiet cluster every card's props keep their identity and
 * none of them re-render. Safe to memo: it is module-scope and takes
 * everything it needs as explicit props.
 */
const NodeCard = React.memo(function NodeCard({ node, clusterName, onEditYaml, onOpenShell, onAction, onToast }: {
    node: models.NodeInfo;
    clusterName: string;
    onEditYaml: (name: string) => void;
    onOpenShell: (name: string) => void;
    onAction: () => void;
    onToast: (severity: 'success' | 'error', summary: string, detail: string) => void;
}) {
    const t = useT();
    const [drainDialogVisible, setDrainDialogVisible] = useState(false);
    const [shellDialogVisible, setShellDialogVisible] = useState(false);
    const [cordonLoading, setCordonLoading] = useState(false);
    const [drainLoading, setDrainLoading] = useState(false);

    const handleCordon = async () => {
        setCordonLoading(true);
        try {
            await CordonNode(clusterName, node.name);
            onToast('success', 'Cordoned', `${node.name} marked as unschedulable`);
            onAction();
        } catch (e: any) {
            onToast('error', 'Cordon failed', String(e));
        } finally { setCordonLoading(false); }
    };

    const handleUncordon = async () => {
        setCordonLoading(true);
        try {
            await UncordonNode(clusterName, node.name);
            onToast('success', 'Uncordoned', `${node.name} is schedulable again`);
            onAction();
        } catch (e: any) {
            onToast('error', 'Uncordon failed', String(e));
        } finally { setCordonLoading(false); }
    };

    const handleDrain = async () => {
        setDrainDialogVisible(false);
        setDrainLoading(true);
        try {
            await DrainNode(clusterName, node.name);
            onToast('success', 'Drain complete', `Pods on ${node.name} have been evicted`);
            onAction();
        } catch (e: any) {
            onToast('error', 'Drain failed', String(e));
        } finally { setDrainLoading(false); }
    };

    const handleOpenShell = () => {
        setShellDialogVisible(false);
        onOpenShell(node.name);
    };

    const shellFooter = (
        <div className="flex justify-content-end gap-2">
            <Button label={t('action.cancel')} icon={<VscClose fontSize="small" />} text onClick={() => setShellDialogVisible(false)} />
            <Button label={t('panels:node.shell')} icon={<VscTerminal fontSize="small" />} severity="warning" onClick={handleOpenShell} />
        </div>
    );

    const drainFooter = (
        <div className="flex justify-content-end gap-2">
            <Button label={t('action.cancel')} icon={<VscClose fontSize="small" />} text onClick={() => setDrainDialogVisible(false)} disabled={drainLoading} />
            <Button label={t('panels:node.drain')} icon={<VscOutput fontSize="small" />} severity="danger" onClick={handleDrain} loading={drainLoading} />
        </div>
    );

    return (
        <div style={{
            background: 'var(--panel2)',
            border: `1px solid ${node.unschedulable ? 'var(--amber)' : 'var(--line)'}`,
            borderRadius: 6,
            padding: '1rem 1.25rem',
            display: 'flex', flexDirection: 'column', gap: '0.75rem',
        }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0 }}>
                    <VscServer style={{ fontSize: '1.1rem', color: 'var(--teal)', flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                    <Tag value={node.status} severity={getStatusSeverity(node.status)} style={{ fontSize: '0.7rem', flexShrink: 0 }} />
                    {node.unschedulable && (
                        <Tag value="Unschedulable" severity="warning" style={{ fontSize: '0.7rem', flexShrink: 0 }} />
                    )}
                </div>
                <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                    {node.unschedulable ? (
                        <Button label={t('panels:node.uncordon')} icon={<VscPass fontSize="small" />} size="small" severity="success" text loading={cordonLoading} onClick={handleUncordon} tooltip={t('panels:node.uncordonTooltip')} tooltipOptions={{ position: 'top' }} />
                    ) : (
                        <Button label={t('panels:node.cordon')} icon={<VscCircleSlash fontSize="small" />} size="small" severity="warning" text loading={cordonLoading} onClick={handleCordon} tooltip={t('panels:node.cordonTooltip')} tooltipOptions={{ position: 'top' }} />
                    )}
                    <Button label={t('panels:node.drain')} icon={<VscOutput fontSize="small" />} size="small" severity="danger" text loading={drainLoading} onClick={() => setDrainDialogVisible(true)} tooltip={t('panels:node.drainTooltip')} tooltipOptions={{ position: 'top' }} />
                    <Button icon={<VscTerminal fontSize="small" />} text size="small" severity="info" onClick={() => setShellDialogVisible(true)} tooltip={t('panels:node.shellTooltip')} tooltipOptions={{ position: 'top' }} />
                    <Button icon={<VscNote fontSize="small" />} text size="small" severity="secondary" onClick={() => onEditYaml(node.name)} tooltip={t('panels:node.editYaml')} tooltipOptions={{ position: 'top' }} />
                </div>
            </div>

            {/* Meta + Charts */}
            <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flexShrink: 0, minWidth: '200px' }}>
                    <MetaItem icon={<VscLocation style={{ fontSize: '0.75rem' }} />}           label="IP"      value={node.internal_ip      || '—'} />
                    <MetaItem icon={<VscTag style={{ fontSize: '0.75rem' }} />}           label={t('panels:node.version')} value={node.kubelet_version   || '—'} />
                    <MetaItem icon={<VscDesktopDownload style={{ fontSize: '0.75rem' }} />}  label="OS"      value={node.os_image          || '—'} />
                    <MetaItem icon={<VscChip style={{ fontSize: '0.75rem' }} />}          label={t('panels:node.cpuCap')} value={node.cpu_capacity      || '—'} />
                    <MetaItem icon={<VscDatabase style={{ fontSize: '0.75rem' }} />}         label={t('panels:node.memCap')} value={node.memory_capacity   || '—'} />
                </div>

                <div style={{ width: '1px', alignSelf: 'stretch', background: 'var(--line)', flexShrink: 0 }} />

                {node.metrics_available ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.6rem', minWidth: '200px' }}>
                        <UsageChart label="CPU" used={node.cpu_usage_millis} total={node.cpu_capacity_millis} unit="m" />
                        <UsageChart label="MEM" used={node.mem_usage_mi}     total={node.mem_capacity_mi}     unit="MiB" />
                    </div>
                ) : (
                    <div style={{ flex: 1, color: 'var(--ink2)', fontSize: '0.8rem', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <VscInfo style={{ fontSize: '0.9rem' }} />
                        {t('panels:node.noMetricsServer')}
                    </div>
                )}
            </div>

            <Dialog
                header={`Drain: ${node.name}`}
                visible={drainDialogVisible}
                style={{ width: '32rem' }}
                modal
                footer={drainFooter}
                onHide={() => { if (!drainLoading) setDrainDialogVisible(false); }}
            >
                <p className="m-0 mb-3">
                    <Trans t={t} i18nKey="panels:node.drainWarning" components={{ 1: <strong /> }} />
                </p>
                <p className="m-0" style={{ fontSize: '0.85rem', color: 'var(--ink2)' }}>
                    <Trans t={t} i18nKey="panels:node.drainTarget" values={{ name: node.name }} components={{ 1: <strong /> }} />
                </p>
            </Dialog>

            {/* Gated like drain, and for a stronger reason: opening this shell
                creates a privileged pod and hands out root on the host. */}
            <Dialog
                header={`${t('panels:node.shell')}: ${node.name}`}
                visible={shellDialogVisible}
                style={{ width: '32rem' }}
                modal
                footer={shellFooter}
                onHide={() => setShellDialogVisible(false)}
            >
                <p className="m-0 mb-3">
                    <Trans t={t} i18nKey="panels:node.shellWarning" components={{ 1: <strong /> }} />
                </p>
                <p className="m-0 mb-3" style={{ fontSize: '0.85rem', color: 'var(--ink2)' }}>
                    {t('panels:node.shellCleanup')}
                </p>
                <p className="m-0" style={{ fontSize: '0.85rem', color: 'var(--ink2)' }}>
                    <Trans t={t} i18nKey="panels:node.shellTarget" values={{ name: node.name }} components={{ 1: <strong /> }} />
                </p>
            </Dialog>
        </div>
    );
});

function MetaItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ display: 'flex', alignItems: 'center', color: 'var(--ink2)' }}>{icon}</span>
            <span style={{ fontSize: '0.72rem', color: 'var(--ink2)' }}>{label}:</span>
            <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--ink)' }}>{value}</span>
        </div>
    );
}

export default function NodeListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const active = usePanelActive(api);
    // Bar charts paint into a canvas, which CSS variables cannot reach: the
    // colors are read from the palette per render, so this subscription is what
    // repaints them on a theme switch.
    useThemeVersion();
    const [nodes, setNodes] = useState<models.NodeInfo[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const toast = useRef<Toast | null>(null);
    const { openYamlPanel, openNodeShellPanel } = useTabContext();
    const payload = usePayloadSignature();

    // Mirrors lib/useResourceList: keep the last good cards on a failed poll and
    // let the banner say the data is stale, rather than blanking to a message
    // that reads like "this cluster has no nodes".
    const loadNodes = useCallback(async () => {
        setRefreshing(true);
        try {
            const items = await GetNodes(clusterName);
            // Unchanged poll: keep the current node objects so the memoized
            // cards below have nothing to re-render.
            if (!payload.changed(items)) {
                setError(null);
                return;
            }
            setNodes(items.map((item: any) => models.NodeInfo.createFrom(item)));
            setError(null);
        } catch (e) {
            console.error('Failed to load nodes:', e);
            setError(errText(e));
        } finally {
            setLoaded(true);
            setRefreshing(false);
        }
    }, [clusterName, payload]);

    useEffect(() => {
        if (!active) return;
        loadNodes();
        const id = window.setInterval(loadNodes, 3000);
        return () => window.clearInterval(id);
    }, [active, loadNodes]);

    // useCallback, not because these are expensive, but because NodeCard is
    // memoized: a fresh function identity per render would defeat the memo.
    const handleEditYaml = useCallback((name: string) => {
        openYamlPanel({ clusterName,
            resourceKind: 'node', name, namespace: '', referencePanel: `nodes:${clusterName}` });
    }, [openYamlPanel, clusterName]);

    const handleOpenShell = useCallback((name: string) => {
        openNodeShellPanel({ clusterName, nodeName: name, referencePanel: `nodes:${clusterName}` });
    }, [openNodeShellPanel, clusterName]);

    const showToast = useCallback((severity: 'success' | 'error', summary: string, detail: string) => {
        toast.current?.show({ severity, summary, detail, life: 3000 });
    }, []);

    const readyCount = nodes.filter(n => n.status === 'Ready').length;

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Toast ref={toast} position="bottom-right" />

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.6rem 1rem', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, color: 'var(--ink)' }}>{t('panels:node.title')}</h3>
                <Tag value={`${readyCount} / ${nodes.length} Ready`} severity={readyCount === nodes.length && nodes.length > 0 ? 'success' : 'warning'} />
            </div>

            <ErrorBanner
                message={error}
                onRetry={loadNodes}
                busy={refreshing}
                stale={nodes.length > 0}
                context={`Nodes (${clusterName})`}
            />

            {!loaded ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <ProgressSpinner style={{ width: 40, height: 40 }} strokeWidth="4" />
                </div>
            ) : (
            <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {nodes.length === 0 ? (
                    error ? null : (
                    <div style={{ color: 'var(--ink2)', padding: '2rem', textAlign: 'center' }}>
                        {t('panels:node.empty')}
                    </div>
                    )
                ) : (
                    nodes.map(node => (
                        <NodeCard key={node.name} node={node} clusterName={clusterName} onEditYaml={handleEditYaml} onOpenShell={handleOpenShell} onAction={loadNodes} onToast={showToast} />
                    ))
                )}
            </div>
            )}
        </div>
    );
}
