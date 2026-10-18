import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import StatusLamp from '../shared/StatusLamp';
import RowAction from '../shared/RowAction';
import { Toast } from 'primereact/toast';
import { VscGlobe, VscCopy, VscDebugRestart, VscClose, VscLock, VscArrowSwap } from 'react-icons/vsc';
import { BrowserOpenURL } from '../../../wailsjs/runtime/runtime';
import { StopPortForward, StartPortForward } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import {
    usePortForwardStore,
    isWebForward,
    forwardUrl,
    forwardAddress,
    type PortForward,
} from '../../stores/portForwardStore';
import { usePanelActive } from '../../lib/usePanelActive';
import { writeClipboard } from '../../lib/clipboard';
import { errText } from '../../lib/errText';
import { useT } from '../../i18n/useT';
import { ACTION_COLUMN_PROPS } from '../shared/actionColumn';

type TagSeverity = 'success' | 'info' | 'warning' | 'danger' | 'secondary' | 'contrast';

const statusSeverity = (status: string): TagSeverity => {
    switch (status) {
        case 'ready': return 'success';
        case 'starting': return 'info';
        case 'reconnecting': return 'warning';
        case 'error': return 'danger';
        default: return 'secondary';
    }
};

const age = (iso: string): string => {
    if (!iso) return '-';
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms) || ms < 0) return '-';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h${m % 60}m`;
    return `${Math.floor(h / 24)}d${h % 24}h`;
};

/**
 * The Port Forwards panel is a *view* onto the backend registry, not its owner.
 *
 * Every other list panel is pinned to one cluster and lists what that cluster
 * has. This one lists what this process is doing, across clusters — which is
 * why it is a singleton with empty params and lives outside the
 * `${view}:${clusterName}` scheme, next to Diagnostics. Closing it stops
 * nothing.
 */
export default function PortForwardsPanel({ api }: IDockviewPanelProps<Record<string, never>>) {
    const t = useT();
    const active = usePanelActive(api);
    const forwards = usePortForwardStore((s) => s.forwards);
    const startSync = usePortForwardStore((s) => s.startSync);
    const refresh = usePortForwardStore((s) => s.refresh);
    const toastRef = useRef<Toast>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    // Only used to re-render the Age column; the rows themselves are pushed by
    // the store.
    const [, setTick] = useState(0);

    useEffect(() => startSync(), [startSync]);

    useEffect(() => {
        if (!active) return;
        void refresh();
        const id = window.setInterval(() => setTick((t) => t + 1), 1000);
        return () => window.clearInterval(id);
    }, [active, refresh]);

    const notify = (severity: 'success' | 'error', summary: string, detail: string) =>
        toastRef.current?.show({ severity, summary, detail, life: severity === 'error' ? 6000 : 3000 });

    const stop = async (f: PortForward) => {
        setBusyId(f.id);
        try {
            await StopPortForward(f.id);
            await refresh();
        } catch (e) {
            notify('error', t('panels:portForwards.toastStopFailed'), errText(e));
        } finally {
            setBusyId(null);
        }
    };

    // Restart is stop + start rather than a backend verb: a new tunnel resolves
    // the target again and gets a new id, which is exactly what the user wants
    // after a pod was replaced. The local port is requested explicitly so the
    // address they already have keeps working.
    const restart = async (f: PortForward) => {
        setBusyId(f.id);
        try {
            await StopPortForward(f.id);
            const info = await StartPortForward(
                f.cluster_name,
                f.resource_kind,
                f.resource_name,
                f.namespace,
                f.local_port,
                f.remote_port,
            );
            await refresh();
            notify('success', t('panels:portForwards.toastRestarted'), `${f.address}:${models.PortForwardInfo.createFrom(info).local_port}`);
        } catch (e) {
            notify('error', t('panels:portForwards.toastRestartFailed'), errText(e));
            await refresh();
        } finally {
            setBusyId(null);
        }
    };

    const copy = async (f: PortForward) => {
        const ok = await writeClipboard(forwardAddress(f));
        notify(ok ? 'success' : 'error', ok ? t('panels:portForwards.toastCopied') : t('panels:portForwards.toastCopyFailed'), forwardAddress(f));
    };

    if (!active) return <div className="pf-panel" />;

    const statusLabel = (status: string) => {
        switch (status) {
            case 'ready': return t('panels:portForwards.status.ready');
            case 'starting': return t('panels:portForwards.status.starting');
            case 'reconnecting': return t('panels:portForwards.status.reconnecting');
            case 'error': return t('panels:portForwards.status.error');
            case 'stopped': return t('panels:portForwards.status.stopped');
            default: return status;
        }
    };

    const empty = (
        <div className="rlv-empty">
            <VscArrowSwap size={20} aria-hidden />
            <span>{t('panels:portForwards.empty')}</span>
            <span className="pf-panel__hint">{t('panels:portForwards.emptyHint')}</span>
        </div>
    );

    const failed = forwards.filter((f) => f.status === 'error');

    return (
        <div className="pf-panel">
            <Toast ref={toastRef} />

            <div className="rlv-toolbar">
                <h3 className="rlv-toolbar__title">{t('panels:portForwards.title')}</h3>
                {forwards.length > 0 && <span className="rlv-toolbar__count">{forwards.length}</span>}
                <span className="pf-panel__note">
                    <VscLock size={12} aria-hidden />
                    {t('panels:portForwards.loopbackNote')}
                </span>
            </div>

            <div className="pf-panel__table">
                <DataTable
                    value={forwards}
                    dataKey="id"
                    scrollable
                    scrollHeight="flex"
                    size="small"
                    emptyMessage={empty}
                >
                    <Column
                        field="status"
                        header={t('resources:column.status')}
                        style={{ minWidth: '9rem' }}
                        body={(f: PortForward) => (
                            <span className="pf-panel__status">
                                <StatusLamp label={statusLabel(f.status)} severity={statusSeverity(f.status)} />
                                {f.status === 'reconnecting' && (
                                    <span className="pf-panel__muted">{t('panels:portForwards.attempt', { n: f.attempts })}</span>
                                )}
                            </span>
                        )}
                    />
                    <Column
                        header={t('resources:column.address')}
                        style={{ minWidth: '15rem' }}
                        body={(f: PortForward) => (
                            <span className="cell-mono">
                                {f.address}:{f.local_port} → {f.remote_port}
                                {f.target_port !== 0 && f.target_port !== f.remote_port && (
                                    <span className="pf-panel__muted">{t('panels:portForwards.podPort', { port: f.target_port })}</span>
                                )}
                            </span>
                        )}
                    />
                    <Column
                        header={t('resources:column.target')}
                        style={{ minWidth: '14rem' }}
                        body={(f: PortForward) => (
                            <span>
                                <span className="pf-panel__muted">{f.resource_kind}/</span>
                                {f.resource_name}
                            </span>
                        )}
                    />
                    <Column field="namespace" header={t('resources:column.namespace')} style={{ minWidth: '9rem' }} />
                    <Column
                        header={t('resources:column.pod')}
                        style={{ minWidth: '12rem' }}
                        body={(f: PortForward) => f.pod_name || '—'}
                    />
                    <Column field="cluster_name" header={t('resources:column.cluster')} style={{ minWidth: '9rem' }} />
                    <Column header={t('resources:column.age')} style={{ minWidth: '5rem' }} body={(f: PortForward) => age(f.started_at)} />
                    <Column
                        header=""
                        {...ACTION_COLUMN_PROPS}
                        headerStyle={{ width: '9rem' }}
                        style={{ minWidth: '9rem', maxWidth: '9rem' }}
                        body={(f: PortForward) => (
                            <div className="row-actions">
                                {isWebForward(f) && (
                                    <RowAction icon={<VscGlobe size={15} />} label={t('panels:portForwards.openInBrowser')}
                                        onClick={() => BrowserOpenURL(forwardUrl(f))} />
                                )}
                                <RowAction icon={<VscCopy size={15} />} label={t('panels:portForwards.copyAddress')} onClick={() => void copy(f)} />
                                <RowAction icon={<VscDebugRestart size={15} />} label={t('panels:portForwards.restart')}
                                    loading={busyId === f.id} onClick={() => void restart(f)} />
                                <RowAction icon={<VscClose size={15} />} severity="danger"
                                    label={t(f.status === 'error' ? 'panels:portForwards.dismiss' : 'panels:portForwards.stop')}
                                    loading={busyId === f.id} onClick={() => void stop(f)} />
                            </div>
                        )}
                    />
                </DataTable>
            </div>

            {failed.length > 0 && (
                <div className="pf-panel__errors" role="status">
                    {failed.map((f) => (
                        <div key={f.id} className="pf-panel__error">
                            <StatusLamp label={`${f.resource_kind}/${f.resource_name}`} tone="err" />
                            <span>{f.error}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
