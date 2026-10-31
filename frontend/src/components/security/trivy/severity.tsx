import StatusLamp from '../../shared/StatusLamp';

export const SEVERITY_ORDER: Record<string, number> = {
    CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, UNKNOWN: 1,
};
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

export function severitySeverity(sev: string): 'danger' | 'warning' | 'info' | undefined {
    switch (sev) {
        case 'CRITICAL': case 'HIGH': return 'danger';
        case 'MEDIUM': return 'warning';
        case 'LOW': return 'info';
        default: return undefined;
    }
}

/** Highest severity first. */
export function bySeverity<T extends { severity: string }>(rows: T[] | null | undefined): T[] {
    return [...(rows ?? [])].sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0));
}

// A severity is a state of the finding, so a lamp: ■ critical/high, ▲ medium,
// ◆ low, ○ unknown — the shape says it before the colour does.
export function SeverityTag({ sev, markOnly }: { sev: string; markOnly?: boolean }) {
    return <StatusLamp label={sev} severity={severitySeverity(sev)} markOnly={markOnly} />;
}
