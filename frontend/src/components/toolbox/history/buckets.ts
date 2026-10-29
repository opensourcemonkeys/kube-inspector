import type { models } from '../../../../wailsjs/go/models';
import type { HistoryFilters } from '../../../stores/historyStore';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Column widths offered for the activity chart, narrowest first. */
export const BUCKETS: { id: string; ms: number }[] = [
    { id: '1m', ms: MIN }, { id: '5m', ms: 5 * MIN }, { id: '15m', ms: 15 * MIN }, { id: '30m', ms: 30 * MIN },
    { id: '1h', ms: HOUR }, { id: '3h', ms: 3 * HOUR }, { id: '6h', ms: 6 * HOUR }, { id: '12h', ms: 12 * HOUR },
    // toolbox takes Go durations, which have no day unit.
    { id: '24h', ms: DAY },
];

const PRESET_MS: Record<string, number> = { '1h': HOUR, '24h': DAY, '168h': 7 * DAY, '720h': 30 * DAY };
// "All time" is as far as toolbox keeps changes by default.
const ALL_MS = 90 * DAY;
const ALL_SINCE = '2160h';
// The width each preset reads best at.
const PRESET_BUCKET: Record<string, string> = { '1h': '1m', '24h': '1h', '168h': '6h', '720h': '24h', all: '24h' };
// About this many columns for a custom range.
const TARGET_COLUMNS = 48;
// toolbox refuses more than this many.
const MAX_COLUMNS = 2000;

export interface Period {
    /** What toolbox is sent. */
    since: string;
    until: string;
    startMs: number;
    endMs: number;
}

/** The period a filter's time choice covers, as of `now`. */
export function periodOf(f: HistoryFilters, now = Date.now()): Period {
    if (f.since === 'custom') {
        const start = f.from ? Date.parse(f.from) : now - DAY;
        const end = f.to ? Date.parse(f.to) : now;
        return { since: f.from || '24h', until: f.to, startMs: start, endMs: end };
    }
    if (f.since === 'all' || !PRESET_MS[f.since]) return { since: ALL_SINCE, until: '', startMs: now - ALL_MS, endMs: now };
    return { since: f.since, until: '', startMs: now - PRESET_MS[f.since], endMs: now };
}

/** The widths that give between 1 and toolbox's maximum of columns. */
export function bucketChoices(p: Period) {
    const span = p.endMs - p.startMs;
    return BUCKETS.filter((b) => span / b.ms <= MAX_COLUMNS && span / b.ms >= 1);
}

/** The width in use: the user's pick when it still fits, otherwise one fitted to the range. */
export function bucketFor(f: HistoryFilters, p: Period): { id: string; ms: number } {
    const choices = bucketChoices(p);
    const picked = choices.find((b) => b.id === f.bucket);
    if (picked) return picked;
    const preset = f.since !== 'custom' ? choices.find((b) => b.id === PRESET_BUCKET[f.since]) : undefined;
    if (preset) return preset;
    const span = p.endMs - p.startMs;
    return choices.find((b) => span / b.ms <= TARGET_COLUMNS) ?? choices[choices.length - 1] ?? BUCKETS[0];
}

export const VERB_ORDER = ['create', 'update', 'delete', 'finalized'] as const;

/**
 * Every column of the period with its count per verb, empty columns included
 * so the time axis is even. Columns start on multiples of the width since the
 * epoch, the way ClickHouse's toStartOfInterval aligns them.
 */
export function bucketSeries(buckets: models.ToolboxBucket[], p: Period, widthMs: number) {
    const first = Math.floor(p.startMs / widthMs) * widthMs;
    const starts: number[] = [];
    for (let t = first; t < p.endMs; t += widthMs) starts.push(t);
    const index = new Map(starts.map((t, i) => [t, i]));
    const byVerb: Record<string, number[]> = Object.fromEntries(VERB_ORDER.map((v) => [v, starts.map(() => 0)]));
    for (const b of buckets) {
        const i = index.get(Date.parse(b.time));
        if (i !== undefined && byVerb[b.verb]) byVerb[b.verb][i] += b.count;
    }
    return { starts, byVerb };
}
