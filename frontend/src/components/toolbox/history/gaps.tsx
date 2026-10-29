import { useEffect, useRef, useState } from 'react';
import { GetToolboxGaps } from '../../../../wailsjs/go/controller_app/App';
import type { models } from '../../../../wailsjs/go/models';
import { useT } from '../../../i18n/useT';
import { formatTime } from './format';

const POLL_MS = 60_000;

/** "3m 20s", "2h 5m", "1d 3h": the same unit letters as the list ages. */
export function formatDuration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export const gapSeconds = (g: models.ToolboxGap) => (Date.parse(g.to) - Date.parse(g.from)) / 1000;

/**
 * The stretches in [since, until] with no recording leader. since/until are
 * what toolbox takes ("168h" or RFC 3339; empty until is now). Refreshed once
 * a minute while `active`; a failure leaves the last answer in place — gaps
 * are context for the list, never a reason to fail it.
 */
export function useRecordingGaps(clusterName: string, since: string, until: string, active: boolean): models.ToolboxGap[] {
    const [gaps, setGaps] = useState<models.ToolboxGap[]>([]);
    const req = useRef(0);
    useEffect(() => {
        if (!active) return;
        const load = () => {
            const id = ++req.current;
            GetToolboxGaps(clusterName, since, until)
                .then((c) => { if (id === req.current) setGaps(c.gaps ?? []); })
                .catch(() => { /* keep the last answer */ });
        };
        load();
        const h = setInterval(load, POLL_MS);
        return () => clearInterval(h);
    }, [clusterName, since, until, active]);
    return gaps;
}

/** A row in a list that interleaves changes with recording gaps. */
export interface GapRow {
    eventId: string;
    gap: models.ToolboxGap;
}

export const isGapRow = (r: object): r is GapRow => 'gap' in r;

/**
 * Places gaps among newest-first changes by time. With more pages still to
 * load, a gap older than the oldest loaded change is left out: it would sit
 * at the bottom of the list, out of its place.
 */
export function withGaps(changes: models.ToolboxChange[], gaps: models.ToolboxGap[], complete: boolean): (models.ToolboxChange | GapRow)[] {
    const oldest = changes.length ? Date.parse(changes[changes.length - 1].time) : Infinity;
    const shown = gaps
        .filter((g) => complete || Date.parse(g.to) >= oldest)
        .sort((a, b) => Date.parse(b.to) - Date.parse(a.to));
    const out: (models.ToolboxChange | GapRow)[] = [];
    let gi = 0;
    for (const c of changes) {
        const t = Date.parse(c.time);
        while (gi < shown.length && Date.parse(shown[gi].from) >= t) {
            out.push({ eventId: `gap:${shown[gi].from}`, gap: shown[gi] });
            gi++;
        }
        out.push(c);
    }
    for (; gi < shown.length; gi++) out.push({ eventId: `gap:${shown[gi].from}`, gap: shown[gi] });
    return out;
}

/** The text of a gap band: when, how long, and what it means. */
export function GapText({ gap }: { gap: models.ToolboxGap }) {
    const t = useT();
    const vars = { from: formatTime(gap.from), to: formatTime(gap.to), duration: formatDuration(gapSeconds(gap)) };
    return <span className="history-gap">{t(gap.open ? 'panels:clusterHistory.gap.open' : 'panels:clusterHistory.gap.closed', vars)}</span>;
}
