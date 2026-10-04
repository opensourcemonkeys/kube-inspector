import { LiveChart } from './LiveChart';
import { themeColor } from './themeColors';

// Shared resource-usage formatting + tiny bar widgets, used by the Monitoring
// dashboard (components/monitoring/main.tsx) and the Overview dashboard
// (components/overview/main.tsx). Kept here so both render usage identically.

// ── formatting ──────────────────────────────────────────────────────
export const fmtCpu = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${m} m`);
export const fmtMem = (mi: number) => (mi >= 1024 ? `${(mi / 1024).toFixed(1)} GiB` : `${mi} MiB`);
export const pct = (used: number, cap: number) => (cap > 0 ? Math.min((used / cap) * 100, 100) : 0);
/**
 * The canonical usage-severity color. Resolved from the palette rather than
 * hardcoded so alternate themes re-skin it — and resolved at call time, not at
 * module load, because a module-level constant would capture whichever theme
 * happened to be active when the chunk was first evaluated.
 */
export const getUsageColor = (p: number) =>
    p < 60 ? themeColor('--green')
    : p < 80 ? themeColor('--amber')
    : themeColor('--red');

// ── chart options ───────────────────────────────────────────────────
export const barOptions = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    animation: false as const,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: { x: { stacked: true, display: false, min: 0, max: 100 }, y: { stacked: true, display: false } },
    events: [] as any[],
};

// ── small reusable bits ─────────────────────────────────────────────
export function UsageBarChart({ p }: { p: number }) {
    const color = getUsageColor(p);
    const data = {
        labels: [''],
        datasets: [
            { data: [p], backgroundColor: [color], borderRadius: 3, borderSkipped: false as const },
            { data: [100 - p], backgroundColor: [themeColor('--line2')], borderRadius: 0, borderSkipped: false as const },
        ],
    };
    return <div style={{ flex: 1, height: 14, minWidth: 60 }}><LiveChart type="bar" data={data} options={barOptions} height={14} /></div>;
}

export function CssBar({ p }: { p: number }) {
    return <div className="mon-bar"><div className="mon-bar__fill" style={{ width: `${p}%`, background: getUsageColor(p) }} /></div>;
}
