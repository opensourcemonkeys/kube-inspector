import { describe, it, expect, vi } from 'vitest';
import type { models } from '../../../../wailsjs/go/models';

vi.mock('../../../../wailsjs/go/controller_app/App', () => ({}));

import { formatDuration, isGapRow, withGaps } from './gaps';

const change = (id: string, time: string) => ({ eventId: id, time }) as models.ToolboxChange;
const gap = (from: string, to: string, open = false) => ({ from, to, open }) as models.ToolboxGap;

describe('formatDuration', () => {
    it('uses the list age units', () => {
        expect(formatDuration(42)).toBe('42s');
        expect(formatDuration(200)).toBe('3m 20s');
        expect(formatDuration(3600 * 2 + 300)).toBe('2h 5m');
        expect(formatDuration(86400 + 3 * 3600)).toBe('1d 3h');
    });
});

describe('withGaps', () => {
    const changes = [change('c3', '2026-10-25T12:30:00Z'), change('c2', '2026-10-25T12:10:00Z'), change('c1', '2026-10-25T11:00:00Z')];

    it('puts each gap between the changes either side of it, newest first', () => {
        const rows = withGaps(changes, [gap('2026-10-25T12:00:00Z', '2026-10-25T12:05:00Z'), gap('2026-10-25T12:40:00Z', '2026-10-25T12:50:00Z', true)], true);
        expect(rows.map((r) => (isGapRow(r) ? `gap@${r.gap.from.slice(11, 16)}` : r.eventId)))
            .toEqual(['gap@12:40', 'c3', 'c2', 'gap@12:00', 'c1']);
    });

    it('holds back a gap older than the loaded page while more pages remain', () => {
        const old = gap('2026-10-25T09:00:00Z', '2026-10-25T09:30:00Z');
        expect(withGaps(changes, [old], false).some(isGapRow)).toBe(false);
        // With the whole list loaded it belongs at the end.
        const rows = withGaps(changes, [old], true);
        expect(isGapRow(rows[rows.length - 1])).toBe(true);
    });
});
