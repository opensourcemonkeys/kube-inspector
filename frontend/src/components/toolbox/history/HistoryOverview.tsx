import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Chart, ChartOptions, Plugin } from 'chart.js';
import { Dropdown } from 'primereact/dropdown';
import { GetToolboxStats } from '../../../../wailsjs/go/controller_app/App';
import { models } from '../../../../wailsjs/go/models';
import { errText } from '../../../lib/errText';
import { LiveChart } from '../../../lib/LiveChart';
import { themeAlpha, themeColor, useThemeVersion, type ThemeVar } from '../../../lib/themeColors';
import { useT } from '../../../i18n/useT';
import type { HistoryFilters, HistoryView } from '../../../stores/historyStore';
import Segmented from '../../shared/Segmented';
import ErrorBanner from '../../shared/ErrorBanner';
import { ListSkeleton } from '../../shared/PanelSkeleton';
import { formatTime } from './format';
import { useRecordingGaps } from './gaps';
import { VERB_ORDER, bucketChoices, bucketFor, bucketSeries, periodOf } from './buckets';

const POLL_MS = 60_000;
// The categorical order the dataviz validator passes for adjacent stack
// segments in every theme (CVD ΔE ≥ 14, normal vision ≥ 15). The tokens are
// the app's calm palette, below the validator's chroma floor by design, so a
// verb is never told by colour alone: the legend, the tooltip and the table
// say it too.
const VERB_COLOR: Record<string, ThemeVar> = { create: '--cat-6', update: '--cat-2', delete: '--cat-4', finalized: '--cat-1' };

type Mode = 'chart' | 'table';
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** A 45° hatch in the warning colour: the chart's mark for "nothing was recorded here". */
function hatch(ctx: CanvasRenderingContext2D): CanvasPattern | string {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 8;
    const c = tile.getContext('2d');
    if (!c) return themeAlpha('--warn', 0.15);
    c.strokeStyle = themeAlpha('--warn', 0.45);
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, 8); c.lineTo(8, 0);
    c.moveTo(-2, 2); c.lineTo(2, -2);
    c.moveTo(6, 10); c.lineTo(10, 6);
    c.stroke();
    return ctx.createPattern(tile, 'repeat') ?? themeAlpha('--warn', 0.15);
}

/**
 * The history's summary of a period: headline counts against the period
 * before, activity per column and verb, and the most changed resources, most
 * active users and busiest namespaces. Every part drills down into the
 * Changes view with the matching filter.
 */
export default function HistoryOverview({ clusterName, filters, active, onDrill, onBucket }: {
    clusterName: string;
    filters: HistoryFilters;
    active: boolean;
    onDrill: (patch: Partial<HistoryFilters>, view: HistoryView) => void;
    onBucket: (bucket: string) => void;
}) {
    const t = useT();
    // Colours are read from the theme's tokens; a theme switch re-reads them.
    const theme = useThemeVersion();
    const [stats, setStats] = useState<models.ToolboxStats | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>('chart');
    const [tick, setTick] = useState(0);
    const reqId = useRef(0);

    // The period is fixed when the filters change and on each poll, not on
    // every render: "the last 24 hours" must not slide under the chart.
    const period = useMemo(() => periodOf(filters), [filters, tick]); // eslint-disable-line react-hooks/exhaustive-deps
    const bucket = bucketFor(filters, period);
    const gaps = useRecordingGaps(clusterName, period.since, period.until, active);

    const load = useCallback(async () => {
        const id = ++reqId.current;
        try {
            const st = await GetToolboxStats(clusterName, models.ToolboxStatsFilter.createFrom({
                since: period.since, until: period.until, namespace: filters.namespace, bucket: bucket.id,
            }));
            if (id !== reqId.current) return;
            setStats(st);
            setError(null);
        } catch (e) {
            if (id === reqId.current) setError(errText(e));
        }
    }, [clusterName, period, filters.namespace, bucket.id]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        if (!active) return;
        const h = setInterval(() => setTick((n) => n + 1), POLL_MS);
        return () => clearInterval(h);
    }, [active]);

    const series = useMemo(() => (stats ? bucketSeries(stats.buckets, period, bucket.ms) : null), [stats, period, bucket.ms]);
    const wide = period.endMs - period.startMs > 24 * 60 * 60 * 1000;
    const tick_ = (ms: number) => {
        const s = formatTime(new Date(ms).toISOString());
        return bucket.ms >= 24 * 60 * 60 * 1000 ? s.slice(5, 10) : wide ? s.slice(5, 16) : s.slice(11, 16);
    };

    const drillBucket = (i: number) => {
        if (!series) return;
        const from = series.starts[i];
        onDrill({ since: 'custom', from: new Date(from).toISOString(), to: new Date(from + bucket.ms).toISOString() }, 'changes');
    };

    // Recording gaps, hatched behind the bars across the columns they cover.
    const gapsRef = useRef(gaps);
    gapsRef.current = gaps;
    const seriesRef = useRef(series);
    seriesRef.current = series;
    const widthRef = useRef(bucket.ms);
    widthRef.current = bucket.ms;
    const gapPlugin = useMemo<Plugin<'bar'>>(() => ({
        id: 'recordingGaps',
        beforeDatasetsDraw(chart: Chart<'bar'>) {
            const s = seriesRef.current;
            const x = chart.scales.x;
            if (!s || !x || s.starts.length === 0 || gapsRef.current.length === 0) return;
            const col = s.starts.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : chart.chartArea.width;
            const left = x.getPixelForValue(0) - col / 2;
            const at = (ms: number) => left + ((ms - s.starts[0]) / widthRef.current) * col;
            const { top, bottom, left: minX, right: maxX } = chart.chartArea;
            const ctx = chart.ctx;
            ctx.save();
            ctx.fillStyle = hatch(ctx);
            for (const g of gapsRef.current) {
                const a = Math.max(minX, at(Date.parse(g.from)));
                const b = Math.min(maxX, at(Date.parse(g.to)));
                // At least 2px, so a gap shorter than a column still shows.
                if (b > minX && a < maxX) ctx.fillRect(a, top, Math.max(2, b - a), bottom - top);
            }
            ctx.restore();
        },
    }), []);

    const chartData = useMemo(() => (series ? {
        labels: series.starts.map(tick_),
        datasets: VERB_ORDER.map((v) => ({
            label: v,
            data: series.byVerb[v],
            backgroundColor: themeColor(VERB_COLOR[v]),
            hoverBackgroundColor: themeColor(VERB_COLOR[v]),
            // The 2px surface gap between stacked segments.
            borderColor: themeColor('--screen'),
            borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
            borderSkipped: 'start' as const,
            borderRadius: 4,
            maxBarThickness: 24,
            stack: 'verbs',
        })),
    } : null), [series, theme]); // eslint-disable-line react-hooks/exhaustive-deps

    const options: ChartOptions<'bar'> = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        onClick: (_e, els) => { if (els[0]) drillBucket(els[0].index); },
        onHover: (e, els) => {
            const el = e.native?.target as HTMLElement | undefined;
            if (el) el.style.cursor = els.length ? 'pointer' : 'default';
        },
        scales: {
            x: { stacked: true, grid: { display: false }, border: { color: themeColor('--line-strong') },
                ticks: { color: themeColor('--ink-3'), autoSkip: true, maxTicksLimit: 8, maxRotation: 0 } },
            y: { stacked: true, beginAtZero: true, grid: { color: themeColor('--line') }, border: { display: false },
                ticks: { color: themeColor('--ink-3'), precision: 0, maxTicksLimit: 5, callback: (v) => compact.format(Number(v)) } },
        },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: themeColor('--bezel-raised'), titleColor: themeColor('--ink'), bodyColor: themeColor('--ink'),
                footerColor: themeColor('--ink-2'), borderColor: themeColor('--line-strong'), borderWidth: 1,
                filter: (item) => Number(item.raw) > 0,
                callbacks: {
                    title: (items) => (series && items[0] ? formatTime(new Date(series.starts[items[0].dataIndex]).toISOString()) : ''),
                    footer: (items) => t('panels:clusterHistory.overview.total', { count: items.reduce((n, i) => n + Number(i.raw), 0) }),
                },
            },
        },
    };

    if (!stats) {
        return error
            ? <ErrorBanner block message={error} onRetry={() => void load()} cluster={clusterName} context={t('panels:clusterHistory.label')} />
            : <ListSkeleton />;
    }

    const modeOptions: { value: Mode; label: string }[] = [
        { value: 'chart', label: t('panels:clusterHistory.overview.chart') },
        { value: 'table', label: t('panels:clusterHistory.overview.table') },
    ];
    const tot = stats.totals;
    const prev = stats.previous;
    const delta = (now: number, before: number) => {
        if (before === 0) return now === 0 ? t('panels:clusterHistory.overview.same') : t('panels:clusterHistory.overview.newSince');
        const pct = Math.round(((now - before) / before) * 100);
        return pct === 0 ? t('panels:clusterHistory.overview.same')
            : t(pct > 0 ? 'panels:clusterHistory.overview.up' : 'panels:clusterHistory.overview.down', { pct: Math.abs(pct) });
    };
    const share = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);
    const tiles = tot && prev ? [
        { label: t('panels:clusterHistory.overview.tile.changes'), value: compact.format(tot.changes), delta: delta(tot.changes, prev.changes) },
        { label: t('panels:clusterHistory.overview.tile.deletes'), value: compact.format(tot.deletes), delta: delta(tot.deletes, prev.deletes) },
        { label: t('panels:clusterHistory.overview.tile.attempts'), value: compact.format(tot.attempts), delta: delta(tot.attempts, prev.attempts) },
        {
            label: t('panels:clusterHistory.overview.tile.unattributed'),
            value: `${share(tot.unattributed, tot.changes)}%`,
            delta: t('panels:clusterHistory.overview.points', { before: share(prev.unattributed, prev.changes) }),
        },
    ] : null;

    const tops: { key: 'resources' | 'users' | 'namespaces'; items: models.ToolboxCount[]; drill: (k: string) => Partial<HistoryFilters> | null }[] = [
        // "deployments.apps": the resource filter takes the plural alone.
        { key: 'resources', items: stats.byResource, drill: (k) => ({ resource: k.split('.')[0] }) },
        // "(manager)" is a field manager, which no filter selects.
        { key: 'users', items: stats.byUser, drill: (k) => (k.startsWith('(') ? null : { user: k }) },
        { key: 'namespaces', items: stats.byNamespace, drill: (k) => (k ? { namespace: k } : null) },
    ];
    const rows = series ? series.starts.map((s, i) => ({ s, i, total: VERB_ORDER.reduce((n, v) => n + series.byVerb[v][i], 0) })).filter((r) => r.total > 0) : [];

    return (
        <div className="ov">
            {error && <ErrorBanner message={error} onRetry={() => void load()} stale context={t('panels:clusterHistory.label')} />}
            {tiles ? (
                <div className="ov-tiles">
                    {tiles.map((tile) => (
                        <div className="ov-tile" key={tile.label}>
                            <div className="ov-tile__label">{tile.label}</div>
                            <div className="ov-tile__value">{tile.value}</div>
                            <div className="ov-tile__delta">{tile.delta}</div>
                        </div>
                    ))}
                </div>
            ) : (
                <p className="ov-note">{t('panels:clusterHistory.overview.noTotals')}</p>
            )}

            <section className="ov-card">
                <div className="ov-card__head">
                    <h3 className="ov-card__title">{t('panels:clusterHistory.overview.activity')}</h3>
                    <ul className="ov-legend" aria-label={t('panels:clusterHistory.overview.legend')}>
                        {VERB_ORDER.map((v) => <li key={v}><span className={`ov-key ov-key--${v}`} aria-hidden />{v}</li>)}
                        {gaps.length > 0 && <li><span className="ov-key ov-key--gap" aria-hidden />{t('panels:clusterHistory.overview.gapKey')}</li>}
                    </ul>
                    <span className="history-detail__spacer" />
                    <Dropdown className="p-inputtext-sm ov-bucket" value={bucket.id} aria-label={t('panels:clusterHistory.overview.bucket')}
                        options={bucketChoices(period).map((b) => ({ value: b.id, label: t('panels:clusterHistory.overview.per', { width: b.id }) }))}
                        onChange={(e) => onBucket(e.value)} />
                    <Segmented<Mode> value={mode} onChange={setMode} ariaLabel={t('panels:clusterHistory.overview.modeAria')} options={modeOptions} />
                </div>
                {mode === 'chart' ? (
                    chartData && <LiveChart type="bar" data={chartData} options={options} plugins={[gapPlugin]} height={220} />
                ) : (
                    <div className="ov-table-wrap">
                        <table className="rlv-subtable ov-table">
                            <thead><tr><th>{t('panels:clusterHistory.col.time')}</th>{VERB_ORDER.map((v) => <th key={v}>{v}</th>)}<th>{t('panels:clusterHistory.overview.totalCol')}</th></tr></thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr key={r.s} className="ov-table__row" onClick={() => drillBucket(r.i)}>
                                        <td className="cell-mono">{formatTime(new Date(r.s).toISOString())}</td>
                                        {VERB_ORDER.map((v) => <td key={v} className="cell-mono">{series!.byVerb[v][r.i] || ''}</td>)}
                                        <td className="cell-mono">{r.total}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {rows.length === 0 && <div className="rlv-empty"><span>{t('panels:clusterHistory.empty.changes')}</span></div>}
                    </div>
                )}
            </section>

            <div className="ov-tops">
                {tops.map(({ key, items, drill }) => {
                    const max = Math.max(1, ...items.map((c) => c.count));
                    return (
                        <section className="ov-card" key={key}>
                            <h3 className="ov-card__title">{t(`panels:clusterHistory.overview.top.${key}`)}</h3>
                            {items.length === 0 ? <div className="ov-note">{t('panels:clusterHistory.overview.none')}</div> : (
                                <ol className="ov-top">
                                    {items.map((c) => {
                                        const patch = drill(c.key);
                                        // "()" is a write with neither a user nor a field manager.
                                        const label = c.key === '()' ? `(${t('panels:clusterHistory.via.none')})`
                                            : c.key || t('panels:clusterHistory.overview.clusterScoped');
                                        const body = (
                                            <>
                                                <span className="ov-top__key" title={label}>{label}</span>
                                                <span className="ov-top__count cell-mono">{compact.format(c.count)}</span>
                                                <span className="ov-top__bar" style={{ width: `${(c.count / max) * 100}%` }} aria-hidden />
                                            </>
                                        );
                                        return (
                                            <li key={c.key}>
                                                {patch ? (
                                                    <button type="button" className="ov-top__row" title={t('panels:clusterHistory.overview.showChanges', { name: label })}
                                                        onClick={() => onDrill(patch, 'changes')}>{body}</button>
                                                ) : <div className="ov-top__row ov-top__row--static">{body}</div>}
                                            </li>
                                        );
                                    })}
                                </ol>
                            )}
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
