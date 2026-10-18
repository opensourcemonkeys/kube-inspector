import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewPanelApi } from 'dockview';
import { DataTable, DataTableFilterMeta } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Dropdown } from 'primereact/dropdown';
import { FilterMatchMode } from 'primereact/api';
import { VscPulse, VscClose, VscChevronRight } from 'react-icons/vsc';

import { GetMetricsSnapshot } from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { useMetricsStore, ClusterPoint, EntityPoint } from '../../stores/metricsStore';
import { fmtCpu, fmtMem, pct, CssBar } from '../../lib/usage';
import { themeAlpha, themeColor, useThemeVersion } from '../../lib/themeColors';
import { errText } from '../../lib/errText';
import ErrorBanner from '../shared/ErrorBanner';
import Gauge from '../shared/Gauge';
import NoMetrics from '../shared/NoMetrics';
import Segmented from '../shared/Segmented';
import { useT } from '../../i18n/useT';
import { usePanelActive } from '../../lib/usePanelActive';
import { LiveChart } from '../../lib/LiveChart';

const POLL_MS = 4000;

// The consumers table lists either; the ids double as i18n keys.
const MODES = ['pods', 'workloads'] as const;

// Selectable chart time windows (minutes) — clip the rolling buffer for display.
const WINDOWS = [
    { label: '5 min', value: 5 },
    { label: '10 min', value: 10 },
    { label: '15 min', value: 15 },
    { label: '30 min', value: 30 },
    { label: '1 hour', value: 60 },
    { label: '2 hours', value: 120 },
];

const defaultFilters = (): DataTableFilterMeta => ({
    namespace: { value: null, matchMode: FilterMatchMode.CONTAINS },
    name: { value: null, matchMode: FilterMatchMode.CONTAINS },
    node: { value: null, matchMode: FilterMatchMode.CONTAINS },
    kind: { value: null, matchMode: FilterMatchMode.CONTAINS },
});

// ── formatting ──────────────────────────────────────────────────────
const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ── chart options ───────────────────────────────────────────────────
// Time-based x-axis fixed to [xMin, xMax] so charts always span the selected
// window (data points are positioned by their real timestamp).
const lineOptions = (suggestedMax?: number, xMin?: number, xMax?: number) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    parsing: false as const,
    // Easy hover: snap to the nearest x anywhere over the chart (no need to land
    // exactly on a point), showing every dataset's value at that time.
    interaction: { mode: 'index' as const, intersect: false, axis: 'x' as const },
    plugins: {
        // One series per chart, and the card above it already names it.
        legend: { display: false },
        tooltip: { enabled: true, mode: 'index' as const, intersect: false, callbacks: { title: (items: any[]) => (items.length ? fmtTime(items[0].parsed.x) : '') } },
    },
    scales: {
        x: {
            type: 'linear' as const,
            min: xMin,
            max: xMax,
            ticks: { color: themeColor('--ink-3'), font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6, callback: (v: any) => fmtTime(Number(v)) },
            grid: { display: false },
        },
        y: {
            beginAtZero: true,
            ...(suggestedMax ? { suggestedMax } : {}),
            ticks: { color: themeColor('--ink-3'), font: { size: 10 }, maxTicksLimit: 4 },
            grid: { color: themeAlpha('--line', 0.45) },
            border: { display: false },
        },
    },
    elements: { point: { radius: 0, hoverRadius: 3, hitRadius: 10 }, line: { tension: 0.2, borderWidth: 1.5 } },
});

// ── small reusable bits ─────────────────────────────────────────────
// A compact row list (container breakdown / member pods) with CPU+Mem bars.
type BdRow = { id: string; label: string; sub?: string; cpu: number; mem: number; onClick?: () => void };
function BreakdownList({ rows, cpuMax, memMax, empty }: { rows: BdRow[]; cpuMax: number; memMax: number; empty: string }) {
    if (rows.length === 0) return <div className="mon-empty">{empty}</div>;
    return (
        <div className="mon-bd">
            {rows.map((r) => (
                <div key={r.id} className={`mon-bd__row${r.onClick ? ' mon-bd__row--click' : ''}`} onClick={r.onClick}>
                    <div className="mon-bd__label" title={r.label}>
                        {r.label}{r.sub && <span className="mon-bd__sub">{r.sub}</span>}
                    </div>
                    <div className="mon-bd__metric"><span>{fmtCpu(r.cpu)}</span><CssBar p={pct(r.cpu, cpuMax)} /></div>
                    <div className="mon-bd__metric"><span>{fmtMem(r.mem)}</span><CssBar p={pct(r.mem, memMax)} /></div>
                    {r.onClick && <VscChevronRight className="mon-bd__chev" />}
                </div>
            ))}
        </div>
    );
}

// ── selection ───────────────────────────────────────────────────────
type Selected = { cat: 'node' | 'pod' | 'workload'; kind: string; name: string; namespace: string; id: string; label: string };

const findUsage = (snap: models.MetricsSnapshot, sel: Selected): models.ResourceUsage | undefined => {
    if (sel.cat === 'node') return snap.nodes?.find((n) => n.name === sel.name);
    if (sel.cat === 'pod') return snap.pods?.find((x) => x.namespace === sel.namespace && x.name === sel.name);
    return snap.workloads?.find((w) => w.kind === sel.kind && w.namespace === sel.namespace && w.name === sel.name);
};

const podSel = (r: models.ResourceUsage): Selected => ({
    cat: 'pod', kind: 'pod', name: r.name, namespace: r.namespace, id: `pod/${r.namespace}/${r.name}`, label: `${r.namespace}/${r.name}`,
});

export default function MonitoringDashboard({ clusterName, api }: { clusterName: string; api?: DockviewPanelApi }) {
    const t = useT();
    // Ditto: chart.js paints into a canvas, so `var(--accent)` cannot reach it and
    // the colors are read from the palette on each render instead.
    useThemeVersion();
    // The most expensive poll in the app (a metrics-server fan-out every 4s):
    // it must stop for a backgrounded tab and for a hidden window alike.
    const active = usePanelActive(api);
    const storeKey = `metrics:${clusterName}`;
    const [snap, setSnap] = useState<models.MetricsSnapshot | null>(null);
    const [mode, setMode] = useState<'pods' | 'workloads'>('pods');
    const [filters, setFilters] = useState<DataTableFilterMeta>(defaultFilters);
    const [selected, setSelected] = useState<Selected | null>(null);
    const [windowMin, setWindowMin] = useState(15);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const record = useMetricsStore((s) => s.record);
    const buf = useMetricsStore((s) => s.tabs[storeKey]);

    const selRef = useRef<Selected | null>(null);
    selRef.current = selected;

    // Keep only points within the selected time window.
    const clip = <T extends { t: number }>(pts: T[]): T[] => {
        const since = Date.now() - windowMin * 60_000;
        return pts.filter((p) => p.t >= since);
    };

    const tick = useCallback(async () => {
        setRefreshing(true);
        try {
            const s = await GetMetricsSnapshot(clusterName);
            setSnap(s);
            const cp: ClusterPoint = {
                t: s.timestamp || Date.now(),
                cpu: s.cluster?.cpuMillis ?? 0, mem: s.cluster?.memMi ?? 0,
                cpuCap: s.cluster?.cpuCapMillis ?? 0, memCap: s.cluster?.memCapMi ?? 0,
            };
            let eid: string | null = null;
            let ep: EntityPoint | null = null;
            const sel = selRef.current;
            if (sel) {
                const u = findUsage(s, sel);
                if (u) { eid = sel.id; ep = { t: cp.t, cpu: u.cpuMillis, mem: u.memMi }; }
            }
            record(storeKey, cp, eid, ep);
            setError(null);
        } catch (e) {
            // Keep the last snapshot and the rolling series: a gap in the charts
            // is worse than a stale point, and the banner explains the gap.
            console.error('Failed to load metrics:', e);
            setError(errText(e));
        } finally {
            setRefreshing(false);
        }
    }, [clusterName, storeKey, record]);

    useEffect(() => {
        if (!active) return;
        tick();
        const id = window.setInterval(tick, POLL_MS);
        return () => window.clearInterval(id);
    }, [active, tick]);

    const select = (s: Selected) => setSelected((cur) => (cur?.id === s.id ? null : s));

    // consumers table rows — all of them; sorting & filtering handled by DataTable
    const rows = useMemo(() => {
        const src = (mode === 'pods' ? snap?.pods : snap?.workloads) ?? [];
        return src.map((r) => ({
            ...r,
            _id: mode === 'pods' ? `pod/${r.namespace}/${r.name}` : `wl/${r.kind}/${r.namespace}/${r.name}`,
        }));
    }, [snap, mode]);

    // Never reached a first snapshot: with an error that is a failure to report,
    // not a load that is still running.
    if (!snap) {
        return (
            <div className="mon-root">
                <div className="mon-header"><VscPulse /> <span>{t('panels:monitoring.label')}</span>{clusterName && <span className="mon-cluster">{clusterName}</span>}</div>
                {error
                    ? <ErrorBanner block message={error} onRetry={tick} busy={refreshing} cluster={clusterName} context={`Monitoring (${clusterName})`} />
                    : <div className="mon-empty">{t('panels:monitoring.loading')}</div>}
            </div>
        );
    }
    if (!snap.metricsAvailable) {
        return (
            <div className="mon-root">
                <div className="mon-header"><VscPulse /> <span>{t('panels:monitoring.label')}</span>{clusterName && <span className="mon-cluster">{clusterName}</span>}</div>
                <ErrorBanner message={error} onRetry={tick} busy={refreshing} stale context={`Monitoring (${clusterName})`} />
                <NoMetrics />
            </div>
        );
    }

    const c = snap.cluster;
    const cpuCap = c.cpuCapMillis || 1;
    const memCap = c.memCapMi || 1;
    const cpuClusterPct = pct(c.cpuMillis, c.cpuCapMillis);
    const memClusterPct = pct(c.memMi, c.memCapMi);
    const clusterPts = clip(buf?.cluster ?? []);

    const xMax = Date.now();
    const xMin = xMax - windowMin * 60_000;
    // One dataset per card. Both cards used to be handed the same two-series
    // object, so the "Cluster Memory" chart plotted CPU alongside memory and the
    // two cards were pixel-identical.
    const cpuTrend = {
        datasets: [
            { label: 'CPU %', data: clusterPts.map((p) => ({ x: p.t, y: +pct(p.cpu, p.cpuCap).toFixed(1) })), borderColor: themeColor('--accent'), backgroundColor: themeAlpha('--accent', 0.08), fill: true },
        ],
    };
    const memTrend = {
        datasets: [
            { label: 'Mem %', data: clusterPts.map((p) => ({ x: p.t, y: +pct(p.mem, p.memCap).toFixed(1) })), borderColor: themeColor('--info'), backgroundColor: themeAlpha('--info', 0.08), fill: true },
        ],
    };

    return (
        <div className="mon-root">
            <div className="mon-header">
                <VscPulse /> <span>{t('panels:monitoring.label')}</span>{clusterName && <span className="mon-cluster">{clusterName}</span>}
                <div className="mon-header__actions">
                    <Dropdown value={windowMin} options={WINDOWS} onChange={(e) => setWindowMin(e.value)} aria-label={t('panels:monitoring.timeWindow')} />
                </div>
            </div>

            <ErrorBanner message={error} onRetry={tick} busy={refreshing} stale context={`Monitoring (${clusterName})`} />

            <div className="mon-layout">
                <div className="mon-main">
                    {/* Cluster summary */}
                    <div className="mon-grid">
                        <div className="mon-card">
                            <Gauge label={t('panels:monitoring.clusterCpu')} value={cpuClusterPct} detail={`${fmtCpu(c.cpuMillis)} / ${fmtCpu(c.cpuCapMillis)}`} />
                            <div className="mon-trend"><LiveChart type="line" data={cpuTrend} options={lineOptions(100, xMin, xMax)} height={130} /></div>
                        </div>
                        <div className="mon-card">
                            <Gauge label={t('panels:monitoring.clusterMemory')} value={memClusterPct} detail={`${fmtMem(c.memMi)} / ${fmtMem(c.memCapMi)}`} />
                            <div className="mon-trend"><LiveChart type="line" data={memTrend} options={lineOptions(100, xMin, xMax)} height={130} /></div>
                        </div>
                    </div>

                    {/* Nodes */}
                    <div className="mon-section-title">{t('nav:item.nodes')}</div>
                    <div className="ov-nodes">
                        {(snap.nodes ?? []).map((n) => {
                            const isSel = selected?.id === `node/${n.name}`;
                            return (
                                <button key={n.name} type="button" className={`ov-node ov-node--button${isSel ? ' is-selected' : ''}`}
                                    aria-pressed={isSel}
                                    onClick={() => select({ cat: 'node', kind: 'node', name: n.name, namespace: '', id: `node/${n.name}`, label: n.name })}>
                                    <span className="ov-node__name" title={n.name}>{n.name}</span>
                                    <div className="ov-node__gauges">
                                        <Gauge compact label={t('resources:column.cpu')} value={pct(n.cpuMillis, n.cpuCapMillis)} />
                                        <Gauge compact label={t('panels:monitoring.memory')} value={pct(n.memMi, n.memCapMi)} />
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {/* Top consumers */}
                    <div className="mon-consumers-head">
                        <Segmented
                            value={mode}
                            onChange={setMode}
                            ariaLabel={t('panels:monitoring.switchTooltip')}
                            options={MODES.map((m) => ({ value: m, label: t(`panels:monitoring.${m}`) }))}
                        />
                    </div>
                    <DataTable value={rows} size="small" dataKey="_id" scrollable scrollHeight="340px"
                        removableSort sortField="cpuMillis" sortOrder={-1}
                        filterDisplay="menu" filters={filters} onFilter={(e) => setFilters(e.filters)}
                        rowClassName={(r: any) => (selected?.id === r._id ? 'mon-row--sel' : '')}
                        onRowClick={(e) => {
                            const r = e.data as models.ResourceUsage;
                            if (mode === 'pods') select(podSel(r));
                            else select({ cat: 'workload', kind: r.kind, name: r.name, namespace: r.namespace, id: `wl/${r.kind}/${r.namespace}/${r.name}`, label: `${r.namespace}/${r.name}` });
                        }}
                        emptyMessage={t('panels:monitoring.noData')}>
                        {mode === 'workloads' && <Column field="kind" header={t('resources:column.kind')} sortable filter filterPlaceholder={t('resources:column.kind')} style={{ width: 120 }} />}
                        <Column field="namespace" header={t('resources:column.namespace')} sortable filter filterPlaceholder={t('resources:column.namespace')} style={{ width: 150 }} />
                        <Column field="name" header={t('resources:column.name')} sortable filter filterPlaceholder={t('resources:column.name')} />
                        {mode === 'pods' && <Column field="node" header={t('resources:column.node')} sortable filter filterPlaceholder={t('resources:column.node')} style={{ width: 140 }} />}
                        {mode === 'workloads' && <Column field="pods" header={t('resources:column.pods')} sortable dataType="numeric" style={{ width: 70 }} />}
                        <Column field="cpuMillis" header={t('resources:column.cpu')} sortable dataType="numeric" style={{ width: 200 }} body={(r: models.ResourceUsage) => (
                            <div className="mon-cell"><span className="mon-cell__val">{fmtCpu(r.cpuMillis)}</span><CssBar p={pct(r.cpuMillis, cpuCap)} /></div>
                        )} />
                        <Column field="memMi" header={t('resources:column.memory')} sortable dataType="numeric" style={{ width: 200 }} body={(r: models.ResourceUsage) => (
                            <div className="mon-cell"><span className="mon-cell__val">{fmtMem(r.memMi)}</span><CssBar p={pct(r.memMi, memCap)} /></div>
                        )} />
                    </DataTable>
                </div>

                {selected && (
                    <DetailDrawer snap={snap} selected={selected} series={clip(buf?.series[selected.id] ?? [])}
                        cpuCap={cpuCap} memCap={memCap} windowMin={windowMin} onSelect={select} onClose={() => setSelected(null)} />
                )}
            </div>
        </div>
    );
}

// ── detail drawer ───────────────────────────────────────────────────
function DetailDrawer({ snap, selected, series, cpuCap, memCap, windowMin, onSelect, onClose }: {
    snap: models.MetricsSnapshot;
    selected: Selected;
    series: EntityPoint[];
    cpuCap: number;
    memCap: number;
    windowMin: number;
    onSelect: (s: Selected) => void;
    onClose: () => void;
}) {
    const t = useT();
    // Chart colors are resolved from the palette at render time, so this
    // subscription is what makes a theme switch repaint the canvases.
    useThemeVersion();
    const cur = findUsage(snap, selected);
    const curCpu = cur?.cpuMillis ?? 0;
    const curMem = cur?.memMi ?? 0;

    const xMax = Date.now();
    const xMin = xMax - windowMin * 60_000;
    const cpuTrend = { datasets: [{ label: 'CPU (m)', data: series.map((p) => ({ x: p.t, y: p.cpu })), borderColor: themeColor('--accent'), backgroundColor: themeAlpha('--accent', 0.08), fill: true }] };
    const memTrend = { datasets: [{ label: 'Mem (MiB)', data: series.map((p) => ({ x: p.t, y: p.mem })), borderColor: themeColor('--info'), backgroundColor: themeAlpha('--info', 0.08), fill: true }] };

    let breakdown: JSX.Element | null = null;
    if (selected.cat === 'pod') {
        const conts = cur?.containers ?? [];
        const cMax = Math.max(1, ...conts.map((x) => x.cpuMillis));
        const mMax = Math.max(1, ...conts.map((x) => x.memMi));
        breakdown = (
            <>
                <div className="mon-drawer__sub">{t('panels:monitoring.containers', { count: conts.length })}</div>
                <BreakdownList empty={t('panels:monitoring.noContainerMetrics')} cpuMax={cMax} memMax={mMax}
                    rows={conts.map((x) => ({ id: x.name, label: x.name, cpu: x.cpuMillis, mem: x.memMi }))} />
            </>
        );
    } else {
        const members = selected.cat === 'workload'
            ? (snap.pods ?? []).filter((p) => p.ownerKind === selected.kind && p.ownerName === selected.name && p.namespace === selected.namespace)
            : (snap.pods ?? []).filter((p) => p.node === selected.name);
        const cMax = Math.max(1, ...members.map((x) => x.cpuMillis));
        const mMax = Math.max(1, ...members.map((x) => x.memMi));
        const sorted = [...members].sort((a, b) => b.cpuMillis - a.cpuMillis);
        breakdown = (
            <>
                <div className="mon-drawer__sub">{t('panels:monitoring.memberPods', { count: members.length })}</div>
                <BreakdownList empty={t('panels:monitoring.noPods')} cpuMax={cMax} memMax={mMax}
                    rows={sorted.map((p) => ({
                        id: `${p.namespace}/${p.name}`,
                        label: p.name,
                        sub: selected.cat === 'node' ? p.namespace : undefined,
                        cpu: p.cpuMillis, mem: p.memMi,
                        onClick: () => onSelect(podSel(p)),
                    }))} />
            </>
        );
    }

    return (
        <aside className="mon-drawer">
            <div className="mon-drawer__head">
                <div className="mon-drawer__title">
                    <span className="mon-drawer__kind">{selected.cat === 'pod' ? 'Pod' : selected.cat === 'node' ? 'Node' : selected.kind}</span>
                    <b title={selected.label}>{selected.label}</b>
                </div>
                <button className="mon-drawer__close" onClick={onClose} title={t('panels:monitoring.close')}><VscClose /></button>
            </div>

            <div className="mon-drawer__stats">
                <div><span>CPU</span><b>{fmtCpu(curCpu)}</b><i>{t('panels:monitoring.percentOfCluster', { percent: pct(curCpu, cpuCap).toFixed(1) })}</i></div>
                <div><span>{t('panels:monitoring.memory')}</span><b>{fmtMem(curMem)}</b><i>{t('panels:monitoring.percentOfCluster', { percent: pct(curMem, memCap).toFixed(1) })}</i></div>
            </div>

            <div className="mon-drawer__sub">{t('panels:monitoring.trend')}</div>
            {series.length < 2 ? (
                <div className="mon-empty">{t('panels:monitoring.collecting', { seconds: POLL_MS / 1000 })}</div>
            ) : (
                <>
                    <div className="mon-trend mon-trend--lg"><LiveChart type="line" data={cpuTrend} options={lineOptions(undefined, xMin, xMax)} height={130} /></div>
                    <div className="mon-trend mon-trend--lg"><LiveChart type="line" data={memTrend} options={lineOptions(undefined, xMin, xMax)} height={130} /></div>
                </>
            )}

            {breakdown}
        </aside>
    );
}
