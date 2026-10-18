import { themeColor, type ThemeVar } from './themeColors';

// Shared resource-usage formatting + the small usage bar, used by the Monitoring
// dashboard (components/monitoring/main.tsx), the Overview dashboard
// (components/overview/main.tsx), the Nodes list and resource quotas. Kept here
// so all of them render usage identically.

// ── formatting ──────────────────────────────────────────────────────
export const fmtCpu = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} cores` : `${m} m`);
export const fmtMem = (mi: number) => (mi >= 1024 ? `${(mi / 1024).toFixed(1)} GiB` : `${mi} MiB`);
export const pct = (used: number, cap: number) => (cap > 0 ? Math.min((used / cap) * 100, 100) : 0);

/** Usage thresholds: under 60% fine, under 80% watch, above that act. */
export const USAGE_WARN = 60;
export const USAGE_ERR = 80;

/**
 * The usage tone, for CSS: `gauge--ok`, `mon-bar__fill--warn`, … Preferred over
 * a resolved colour wherever the element is HTML, because a class follows a
 * theme switch without the component re-rendering.
 */
export const usageTone = (p: number): 'ok' | 'warn' | 'err' =>
    p < USAGE_WARN ? 'ok' : p < USAGE_ERR ? 'warn' : 'err';

/**
 * The same tone as a concrete colour, for the places CSS cannot reach (a
 * canvas). Resolved at call time, not at module load, because a module-level
 * constant would capture whichever theme was active when the chunk loaded.
 */
export const getUsageColor = (p: number) => themeColor(`--${usageTone(p)}` as ThemeVar);

// ── small reusable bits ─────────────────────────────────────────────
export function CssBar({ p }: { p: number }) {
    return <div className="mon-bar"><div className={`mon-bar__fill mon-bar__fill--${usageTone(p)}`} style={{ width: `${p}%` }} /></div>;
}
