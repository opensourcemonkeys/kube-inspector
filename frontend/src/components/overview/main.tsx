import { useCallback, useEffect, useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import { VscDashboard } from 'react-icons/vsc';

import {
    GetMetricsSnapshot, GetNodes, GetClusterCounts,
} from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useTabContext } from '../../contexts/TabContext';
import { usePanelActive } from '../../lib/usePanelActive';
import { fmtCpu, fmtMem, pct } from '../../lib/usage';
import { errText } from '../../lib/errText';
import ErrorBanner from '../shared/ErrorBanner';
import Gauge from '../shared/Gauge';
import NoMetrics from '../shared/NoMetrics';
import StatusLamp from '../shared/StatusLamp';
import { NAV_ITEMS, type ViewKey } from '../menu/menuItems';
import { useT } from '../../i18n/useT';

// A count tile does not need 5s granularity, and this tick is three cluster
// round trips wide.
const POLL_MS = 15000;

// The readouts across the top — each opens its list. Label and icon come from
// the sidebar's own entries (menu/menuItems.tsx), so they are translated and can
// never drift from it.
const READOUTS: { key: keyof Counts; view: ViewKey }[] = [
    { key: 'pods',        view: 'pods' },
    { key: 'deployments', view: 'deployments' },
    { key: 'services',    view: 'services' },
    { key: 'nodes',       view: 'nodes' },
    { key: 'namespaces',  view: 'namespaces' },
];
const navItem = (view: ViewKey) => NAV_ITEMS.find((i) => i.view === view)!;

type Counts = models.ClusterCounts;

export default function OverviewDashboard({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    const { openTab } = useTabContext();
    const active = usePanelActive(api);

    const [snap, setSnap] = useState<models.MetricsSnapshot | null>(null);
    const [nodes, setNodes] = useState<models.NodeInfo[] | null>(null);
    const [counts, setCounts] = useState<Counts | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    // Promise.all rejects on the first failing call, so one unreachable endpoint
    // reports the whole tick as failed — which is the honest outcome here: the
    // dashboard's numbers would be a mix of fresh and stale otherwise. Last good
    // values stay on screen and the banner says so.
    //
    // The tile numbers come from GetClusterCounts, not from six listings this
    // used to fetch in full and then call `.length` on. GetNodes stays because
    // the node cards below render the objects themselves.
    const tick = useCallback(async () => {
        setRefreshing(true);
        try {
            const [s, n, cnt] = await Promise.all([
                GetMetricsSnapshot(clusterName),
                GetNodes(clusterName),
                GetClusterCounts(clusterName),
            ]);
            setSnap(s);
            setNodes(n);
            setCounts(cnt);
            setError(null);
        } catch (e) {
            console.error('Failed to load the overview:', e);
            setError(errText(e));
        } finally {
            setRefreshing(false);
        }
    }, [clusterName]);

    useEffect(() => {
        if (!active) return; // pause polling for a backgrounded tab or a hidden window
        tick();
        const id = window.setInterval(tick, POLL_MS);
        return () => window.clearInterval(id);
    }, [active, tick]);

    const openView = (view: ViewKey) =>
        openTab({ view, clusterName, icon: navItem(view).icon });

    const c = snap?.cluster;
    const cpuPct = c ? pct(c.cpuMillis, c.cpuCapMillis) : 0;
    const memPct = c ? pct(c.memMi, c.memCapMi) : 0;

    return (
        <div className="mon-root">
            <div className="mon-header">
                <VscDashboard /> <span>{t('panels:overview.label')}</span>{clusterName && <span className="mon-cluster">{clusterName}</span>}
            </div>

            {counts !== null && (
                <ErrorBanner message={error} onRetry={tick} busy={refreshing} stale context={`Overview (${clusterName})`} />
            )}
            {error && counts === null ? (
                <ErrorBanner block message={error} onRetry={tick} busy={refreshing} cluster={clusterName} context={`Overview (${clusterName})`} />
            ) : (<>

            {/* One strip of readouts rather than five identical cards: the
                numbers are what matters, side by side, divided like the faces
                of a panel meter. */}
            <div className="ov-readouts">
                {READOUTS.map((r) => (
                    <button key={r.key} type="button" className="ov-readout" onClick={() => openView(r.view)}>
                        <span className="ov-readout__num">{counts ? counts[r.key] : '—'}</span>
                        <span className="ov-readout__label">{t(navItem(r.view).labelKey)}</span>
                    </button>
                ))}
            </div>

            <div className="mon-section-title">{t('panels:overview.clusterCapacity')}</div>
            {snap && !snap.metricsAvailable ? (
                <NoMetrics />
            ) : (
                <div className="ov-gauges">
                    <Gauge label={t('panels:overview.clusterCpu')} value={cpuPct}
                        detail={c ? `${fmtCpu(c.cpuMillis)} / ${fmtCpu(c.cpuCapMillis)}` : undefined} />
                    <Gauge label={t('panels:overview.clusterMemory')} value={memPct}
                        detail={c ? `${fmtMem(c.memMi)} / ${fmtMem(c.memCapMi)}` : undefined} />
                </div>
            )}

            <div className="mon-section-title">{t('nav:item.nodes')}</div>
            <div className="ov-nodes">
                {(nodes ?? []).map((n) => {
                    const ready = n.status === 'Ready';
                    return (
                        <div key={n.name} className="ov-node">
                            <StatusLamp label={n.status} tone={ready ? 'ok' : 'err'} />
                            <span className="ov-node__name" title={n.name}>{n.name}</span>
                            <span className="ov-node__version">{n.kubelet_version}</span>
                            {n.unschedulable && <StatusLamp label={t('panels:overview.cordoned')} tone="warn" />}
                            {n.metrics_available ? (
                                <div className="ov-node__gauges">
                                    <Gauge compact label={t('resources:column.cpu')} value={pct(n.cpu_usage_millis, n.cpu_capacity_millis)} />
                                    <Gauge compact label={t('panels:monitoring.memory')} value={pct(n.mem_usage_mi, n.mem_capacity_mi)} />
                                </div>
                            ) : (
                                <span className="ov-node__nometrics">{t('panels:overview.metricsUnavailable')}</span>
                            )}
                        </div>
                    );
                })}
                {nodes && nodes.length === 0 && <div className="mon-empty">{t('panels:overview.noNodes')}</div>}
            </div>
            </>)}
        </div>
    );
}
