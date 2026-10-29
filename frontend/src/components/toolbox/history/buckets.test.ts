import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../../wailsjs/go/controller_app/App', () => ({}));
import { DEFAULT_HISTORY_FILTERS } from '../../../stores/historyStore';
import { bucketChoices, bucketFor, bucketSeries, periodOf } from './buckets';

const now = Date.parse('2026-10-29T12:30:00Z');
const f = (p: Partial<typeof DEFAULT_HISTORY_FILTERS>) => ({ ...DEFAULT_HISTORY_FILTERS, ...p });

describe('activity buckets', () => {
    it('fits each preset with its own width', () => {
        expect(bucketFor(f({ since: '1h' }), periodOf(f({ since: '1h' }), now)).id).toBe('1m');
        expect(bucketFor(f({ since: '24h' }), periodOf(f({ since: '24h' }), now)).id).toBe('1h');
        expect(bucketFor(f({ since: '168h' }), periodOf(f({ since: '168h' }), now)).id).toBe('6h');
        expect(periodOf(f({ since: 'all' }), now).since).toBe('2160h');
    });

    it('fits a custom range to about 48 columns and keeps a pick that still fits', () => {
        const range = f({ since: 'custom', from: '2026-10-28T00:00:00Z', to: '2026-10-29T00:00:00Z' });
        const p = periodOf(range, now);
        expect(p.since).toBe(range.from);
        expect(p.until).toBe(range.to);
        expect(bucketFor(range, p).id).toBe('30m');
        expect(bucketFor({ ...range, bucket: '5m' }, p).id).toBe('5m');
        // One minute over a whole 90 days is more columns than toolbox allows.
        const all = periodOf(f({ since: 'all' }), now);
        expect(bucketChoices(all).some((b) => b.id === '1m')).toBe(false);
        expect(bucketFor(f({ since: 'all', bucket: '1m' }), all).id).toBe('24h');
    });

    it('lays out every column, empty ones included, aligned like ClickHouse', () => {
        const p = periodOf(f({ since: '1h' }), now); // 11:30 – 12:30
        const s = bucketSeries([
            { time: '2026-10-29T11:00:00Z', verb: 'update', count: 9 }, // before the period's first column: dropped
            { time: '2026-10-29T12:00:00Z', verb: 'create', count: 2 },
            { time: '2026-10-29T12:00:00Z', verb: 'delete', count: 1 },
        ] as never, p, 15 * 60_000);
        expect(s.starts.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(['11:30', '11:45', '12:00', '12:15']);
        expect(s.byVerb.create).toEqual([0, 0, 2, 0]);
        expect(s.byVerb.delete).toEqual([0, 0, 1, 0]);
        expect(s.byVerb.update).toEqual([0, 0, 0, 0]);
    });
});
