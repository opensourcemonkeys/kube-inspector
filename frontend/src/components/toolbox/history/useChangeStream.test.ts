import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const handlers = new Map<string, (d: unknown) => void>();
const start = vi.fn();
const stop = vi.fn();
vi.mock('../../../../wailsjs/go/controller_app/App', () => ({
    StartToolboxStream: (...a: unknown[]) => start(...a),
    StopToolboxStream: (...a: unknown[]) => stop(...a),
}));
vi.mock('../../../../wailsjs/runtime/runtime', () => ({
    EventsOn: (name: string, fn: (d: unknown) => void) => { handlers.set(name, fn); return () => handlers.delete(name); },
}));

import { useChangeStream } from './useChangeStream';
import { mergeChange } from './mergeChange';
import type { models } from '../../../../wailsjs/go/models';

const ch = (id: string, time: string) => ({ eventId: id, time }) as models.ToolboxChange;
const sessionOf = () => (start.mock.calls[start.mock.calls.length - 1][0] as string);

describe('useChangeStream', () => {
    beforeEach(() => { handlers.clear(); start.mockReset().mockResolvedValue(undefined); stop.mockReset(); });

    it('delivers changes, falls back on stream end, and stops on unmount', async () => {
        const got: string[] = [];
        const { result, unmount } = renderHook(() => useChangeStream('c1', { namespace: 'ns' } as models.ToolboxChangeFilter, (c) => got.push(c.eventId)));
        await act(async () => {});
        expect(result.current).toBe('live');
        const id = sessionOf();
        act(() => handlers.get(`toolbox:change:${id}`)!(ch('e1', '2026-10-29T10:00:00Z')));
        expect(got).toEqual(['e1']);
        act(() => handlers.get(`toolbox:stream-end:${id}`)!({ message: 'closed' }));
        expect(result.current).toBe('failed');
        unmount();
        expect(stop).toHaveBeenCalledWith(id);
        expect(handlers.size).toBe(0);
    });

    it('is off without a filter and fails when the stream cannot start', async () => {
        const { result, rerender } = renderHook(({ f }) => useChangeStream('c1', f, () => {}), { initialProps: { f: null as models.ToolboxChangeFilter | null } });
        expect(result.current).toBe('off');
        expect(start).not.toHaveBeenCalled();
        start.mockRejectedValueOnce(new Error('404'));
        rerender({ f: { namespace: 'x' } as models.ToolboxChangeFilter });
        await act(async () => {});
        expect(result.current).toBe('failed');
    });

    it('restarts for a different filter, not for an equal one', async () => {
        const { rerender } = renderHook(({ f }) => useChangeStream('c1', f, () => {}), { initialProps: { f: { namespace: 'a' } as models.ToolboxChangeFilter } });
        await act(async () => {});
        rerender({ f: { namespace: 'a' } as models.ToolboxChangeFilter });
        expect(start).toHaveBeenCalledTimes(1);
        rerender({ f: { namespace: 'b' } as models.ToolboxChangeFilter });
        await act(async () => {});
        expect(start).toHaveBeenCalledTimes(2);
        expect(stop).toHaveBeenCalledTimes(1);
    });
});

describe('mergeChange', () => {
    const list = [ch('c', '2026-10-29T12:00:00Z'), ch('a', '2026-10-29T10:00:00Z')];
    it('places a late-written change by its time and replaces a resent one', () => {
        expect(mergeChange(list, ch('b', '2026-10-29T11:00:00Z')).map((c) => c.eventId)).toEqual(['c', 'b', 'a']);
        expect(mergeChange(list, ch('d', '2026-10-29T13:00:00Z')).map((c) => c.eventId)).toEqual(['d', 'c', 'a']);
        expect(mergeChange(list, ch('z', '2026-10-29T09:00:00Z')).map((c) => c.eventId)).toEqual(['c', 'a', 'z']);
        expect(mergeChange(list, ch('a', '2026-10-29T10:00:00Z'))).toHaveLength(2);
    });
});
