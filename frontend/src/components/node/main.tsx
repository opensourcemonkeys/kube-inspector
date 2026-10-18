import { useCallback, useEffect, useRef, useState } from 'react';
import React from 'react';
import type { DockviewPanelApi } from 'dockview';
import { Trans } from 'react-i18next';
import { VscPass, VscCircleSlash, VscOutput, VscNote, VscClose, VscTerminal } from 'react-icons/vsc';
import StatusLamp from '../shared/StatusLamp';
import CountCell from '../shared/CountCell';
import NoMetrics from '../shared/NoMetrics';
import { Toast } from 'primereact/toast';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { GetNodes, CordonNode, UncordonNode, DrainNode } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import { errText } from '../../lib/errText';
import ErrorBanner from '../shared/ErrorBanner';
import { useT } from '../../i18n/useT';
import { fmtCpu, fmtMem, pct } from '../../lib/usage';
import Gauge from '../shared/Gauge';
import RowAction from '../shared/RowAction';
import { ListSkeleton } from '../shared/PanelSkeleton';
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
            onToast('success', t('panels:node.toastCordoned'), t('panels:node.toastCordonedDetail', { name: node.name }));
            onAction();
        } catch (e: any) {
            onToast('error', t('panels:node.toastCordonFailed'), String(e));
        } finally { setCordonLoading(false); }
    };

    const handleUncordon = async () => {
        setCordonLoading(true);
        try {
            await UncordonNode(clusterName, node.name);
            onToast('success', t('panels:node.toastUncordoned'), t('panels:node.toastUncordonedDetail', { name: node.name }));
            onAction();
        } catch (e: any) {
            onToast('error', t('panels:node.toastUncordonFailed'), String(e));
        } finally { setCordonLoading(false); }
    };

    const handleDrain = async () => {
        setDrainDialogVisible(false);
        setDrainLoading(true);
        try {
            await DrainNode(clusterName, node.name);
            onToast('success', t('panels:node.toastDrained'), t('panels:node.toastDrainedDetail', { name: node.name }));
            onAction();
        } catch (e: any) {
            onToast('error', t('panels:node.toastDrainFailed'), String(e));
        } finally { setDrainLoading(false); }
    };

    const handleOpenShell = () => {
        setShellDialogVisible(false);
        onOpenShell(node.name);
    };

    const shellFooter = (
        <div className="dlg-actions">
            <Button label={t('action.cancel')} icon={<VscClose fontSize="small" />} text onClick={() => setShellDialogVisible(false)} />
            <Button label={t('panels:node.shell')} icon={<VscTerminal fontSize="small" />} severity="warning" onClick={handleOpenShell} />
        </div>
    );

    const drainFooter = (
        <div className="dlg-actions">
            <Button label={t('action.cancel')} icon={<VscClose fontSize="small" />} text onClick={() => setDrainDialogVisible(false)} disabled={drainLoading} />
            <Button label={t('panels:node.drain')} icon={<VscOutput fontSize="small" />} severity="danger" onClick={handleDrain} loading={drainLoading} />
        </div>
    );

    const metric = (label: string, value: string) => (
        <div className="node-card__fact"><dt>{label}</dt><dd>{value || '—'}</dd></div>
    );

    return (
        <div className={`node-card${node.unschedulable ? ' node-card--cordoned' : ''}`}>
            <div className="node-card__head">
                <span className="node-card__name" title={node.name}>{node.name}</span>
                <StatusLamp label={node.status} severity={getStatusSeverity(node.status)} />
                {node.unschedulable && <StatusLamp label={t('panels:overview.cordoned')} tone="warn" />}
                {/* Neutral keys for the reversible actions; only Drain, which
                    evicts every pod, carries the danger outline. */}
                <div className="node-card__actions">
                    {node.unschedulable ? (
                        <Button label={t('panels:node.uncordon')} icon={<VscPass size={14} />} size="small" severity="secondary" loading={cordonLoading} onClick={handleUncordon} tooltip={t('panels:node.uncordonTooltip')} tooltipOptions={{ position: 'top' }} />
                    ) : (
                        <Button label={t('panels:node.cordon')} icon={<VscCircleSlash size={14} />} size="small" severity="secondary" loading={cordonLoading} onClick={handleCordon} tooltip={t('panels:node.cordonTooltip')} tooltipOptions={{ position: 'top' }} />
                    )}
                    <Button label={t('panels:node.drain')} icon={<VscOutput size={14} />} size="small" severity="danger" loading={drainLoading} onClick={() => setDrainDialogVisible(true)} tooltip={t('panels:node.drainTooltip')} tooltipOptions={{ position: 'top' }} />
                    <RowAction icon={<VscTerminal size={15} />} label={t('panels:node.shellTooltip')} onClick={() => setShellDialogVisible(true)} />
                    <RowAction icon={<VscNote size={15} />} label={t('panels:node.editYaml')} onClick={() => onEditYaml(node.name)} />
                </div>
            </div>

            <div className="node-card__body">
                <dl className="node-card__facts">
                    {/* The IP is a value people copy; the rest read as text. */}
                    <div className="node-card__fact"><dt>IP</dt><dd className="cell-mono">{node.internal_ip || '—'}</dd></div>
                    {metric(t('panels:node.version'), node.kubelet_version)}
                    {metric('OS', node.os_image)}
                    {metric(t('panels:node.cpuCap'), node.cpu_capacity_millis > 0 ? fmtCpu(node.cpu_capacity_millis) : node.cpu_capacity)}
                    {/* From the parsed MiB, not the raw quantity: "32326340Ki" is
                        what the API says and nobody reads. */}
                    {metric(t('panels:node.memCap'), node.mem_capacity_mi > 0 ? fmtMem(node.mem_capacity_mi) : node.memory_capacity)}
                </dl>

                {node.metrics_available ? (
                    <div className="node-card__gauges">
                        <Gauge label={t('resources:column.cpu')} value={pct(node.cpu_usage_millis, node.cpu_capacity_millis)}
                            detail={`${fmtCpu(node.cpu_usage_millis)} / ${fmtCpu(node.cpu_capacity_millis)}`} />
                        <Gauge label={t('panels:monitoring.memory')} value={pct(node.mem_usage_mi, node.mem_capacity_mi)}
                            detail={`${fmtMem(node.mem_usage_mi)} / ${fmtMem(node.mem_capacity_mi)}`} />
                    </div>
                ) : (
                    <div className="node-card__gauges"><NoMetrics /></div>
                )}
            </div>

            <Dialog
                header={`${t('panels:node.drain')}: ${node.name}`}
                visible={drainDialogVisible}
                className="confirm-dialog"
                modal
                footer={drainFooter}
                onHide={() => { if (!drainLoading) setDrainDialogVisible(false); }}
            >
                <div className="dlg-form">
                    <p className="dlg-message">
                        <Trans t={t} i18nKey="panels:node.drainWarning" components={{ 1: <strong /> }} />
                    </p>
                    <p className="dlg-note">
                        <Trans t={t} i18nKey="panels:node.drainTarget" values={{ name: node.name }} components={{ 1: <strong /> }} />
                    </p>
                </div>
            </Dialog>

            {/* Gated like drain, and for a stronger reason: opening this shell
                creates a privileged pod and hands out root on the host. */}
            <Dialog
                header={`${t('panels:node.shell')}: ${node.name}`}
                visible={shellDialogVisible}
                className="confirm-dialog"
                modal
                footer={shellFooter}
                onHide={() => setShellDialogVisible(false)}
            >
                <div className="dlg-form">
                    <p className="dlg-message">
                        <Trans t={t} i18nKey="panels:node.shellWarning" components={{ 1: <strong /> }} />
                    </p>
                    <p className="dlg-note">{t('panels:node.shellCleanup')}</p>
                    <p className="dlg-note">
                        <Trans t={t} i18nKey="panels:node.shellTarget" values={{ name: node.name }} components={{ 1: <strong /> }} />
                    </p>
                </div>
            </Dialog>
        </div>
    );
});

export default function NodeListComponent({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const active = usePanelActive(api);
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
        <div className="rlv-root">
            <Toast ref={toast} position="bottom-right" />

            <div className="rlv-toolbar">
                <h3 className="rlv-toolbar__title">{t('panels:node.title')}</h3>
                {loaded && nodes.length > 0 && (
                    <span className="rlv-toolbar__count">
                        <CountCell
                            value={t('panels:node.readyCount', { ready: readyCount, total: nodes.length })}
                            severity={readyCount === nodes.length ? 'success' : 'warning'}
                        />
                    </span>
                )}
            </div>

            {nodes.length > 0 && (
                <ErrorBanner message={error} onRetry={loadNodes} busy={refreshing} stale context={`Nodes (${clusterName})`} />
            )}

            {!loaded ? (
                <ListSkeleton rows={3} />
            ) : error && nodes.length === 0 ? (
                <ErrorBanner block message={error} onRetry={loadNodes} busy={refreshing} cluster={clusterName} context={`Nodes (${clusterName})`} />
            ) : (
                <div className="node-list">
                    {nodes.length === 0 ? (
                        <div className="rlv-empty"><span>{t('panels:node.empty')}</span></div>
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
