import { useState } from 'react';
import { LiveChart } from '../../../lib/LiveChart';
import { themeAlpha, themeColor } from '../../../lib/themeColors';
import { useT } from '../../../i18n/useT';
import { fmtCpu, fmtMem } from '../podStatus';

/** One sample of the pod's total usage. */
export interface UsagePoint {
    t: number;
    cpu: number; // millicores
    mem: number; // MiB
}

type Metric = 'cpu' | 'mem';
const METRICS: Metric[] = ['cpu', 'mem'];

// chart.js draws on a canvas and so never inherits the page's font; without
// this it falls back to its own Helvetica default.
const appFont = () => getComputedStyle(document.documentElement).getPropertyValue('--font-family').trim() || undefined;

const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * CPU / Memory usage of the pod over the time the panel has been open.
 * metrics-server only keeps the latest sample, so the history is whatever this
 * panel has collected; it starts empty and fills in. The dashed line is the
 * pod's limit, drawn only when every container sets one — otherwise there is
 * no ceiling to show.
 */
export default function UsageChart({ points, cpuLimit, memLimit, unavailable }: {
    points: UsagePoint[];
    cpuLimit: number; // 0 = no pod-wide limit
    memLimit: number;
    unavailable: boolean;
}) {
    const t = useT();
    const [metric, setMetric] = useState<Metric>('cpu');
    const fmt = metric === 'cpu' ? fmtCpu : fmtMem;
    const limit = metric === 'cpu' ? cpuLimit : memLimit;
    const color = metric === 'cpu' ? '--teal' : '--blue';
    const xMin = points.length ? points[0].t : undefined;
    const xMax = points.length ? points[points.length - 1].t : undefined;

    const datasets: any[] = [{
        label: t('resources:pod.detail.usage'),
        data: points.map((p) => ({ x: p.t, y: p[metric] })),
        borderColor: themeColor(color),
        backgroundColor: themeAlpha(color, 0.15),
        fill: true,
    }];
    if (limit > 0 && points.length) {
        datasets.push({
            label: t('resources:pod.detail.limit'),
            data: [{ x: xMin, y: limit }, { x: xMax, y: limit }],
            borderColor: themeColor('--amber'),
            borderDash: [5, 4],
            borderWidth: 1,
            fill: false,
        });
    }

    const family = appFont();
    const options = {
        responsive: true,
        maintainAspectRatio: false,
        animation: false as const,
        parsing: false as const,
        interaction: { mode: 'index' as const, intersect: false, axis: 'x' as const },
        plugins: {
            legend: { display: true, position: 'bottom' as const, labels: { color: themeColor('--ink2'), boxWidth: 10, boxHeight: 10, font: { family, size: 11 } } },
            tooltip: {
                titleFont: { family },
                bodyFont: { family },
                callbacks: {
                    title: (items: any[]) => (items.length ? fmtTime(items[0].parsed.x) : ''),
                    label: (item: any) => `${item.dataset.label}: ${fmt(item.parsed.y)}`,
                },
            },
        },
        scales: {
            x: {
                type: 'linear' as const,
                min: xMin,
                max: xMax,
                ticks: { color: themeColor('--ink3'), font: { family, size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6, callback: (v: any) => fmtTime(Number(v)) },
                grid: { display: false },
            },
            y: {
                beginAtZero: true,
                ...(limit > 0 ? { suggestedMax: limit * 1.05 } : {}),
                ticks: { color: themeColor('--ink3'), font: { family, size: 10 }, maxTicksLimit: 4, callback: (v: any) => fmt(Number(v)) },
                grid: { color: themeAlpha('--line', 0.6) },
            },
        },
        elements: { point: { radius: 0, hoverRadius: 4, hitRadius: 10 }, line: { tension: 0.3, borderWidth: 1.5 } },
    };

    return (
        <div className="pd-chart">
            <div className="pd-chart__tabs" role="tablist">
                {METRICS.map((m) => (
                    <button key={m} type="button" role="tab" aria-selected={metric === m}
                        className={`pd-chart__tab${metric === m ? ' pd-chart__tab--active' : ''}`} onClick={() => setMetric(m)}>
                        {m === 'cpu' ? t('resources:column.cpu') : t('resources:column.memory')}
                    </button>
                ))}
            </div>
            {unavailable ? (
                <div className="pd-chart__empty">{t('resources:pod.detail.metricsUnavailable')}</div>
            ) : points.length < 2 ? (
                <div className="pd-chart__empty">{t('resources:pod.detail.collecting')}</div>
            ) : (
                <div className="pd-chart__canvas"><LiveChart type="line" data={{ datasets }} options={options} height={170} /></div>
            )}
        </div>
    );
}
