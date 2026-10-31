import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const getRunning = vi.fn();
const stopScan = vi.fn();
const startScan = vi.fn();
vi.mock('../../../../wailsjs/go/controller_app/App', () => ({
    TrivyGetRunningScan: (...a: unknown[]) => getRunning(...a),
    TrivyStopClusterScan: (...a: unknown[]) => stopScan(...a),
    TrivyStartClusterScan: (...a: unknown[]) => startScan(...a),
}));
// No event ever arrives: these tests are about the end events that were lost
// while the /events socket was down.
vi.mock('../../../../wailsjs/runtime/runtime', () => ({
    EventsOn: () => () => {},
}));

import { useClusterScan, RECONCILE_MS } from './useClusterScan';

const progress = { phase: 'images', current: 1, total: 4, message: 'nginx:1' };
const runningScan = (id: string) => ({ scanId: id, progress });

describe('useClusterScan settles a scan whose end event was missed', () => {
    beforeEach(() => {
        getRunning.mockReset();
        stopScan.mockReset();
        startScan.mockReset();
    });
    afterEach(() => { vi.useRealTimers(); });

    it('re-checks right after re-attaching on mount', async () => {
        // Running when the panel asks, gone by the time it has subscribed.
        getRunning.mockResolvedValueOnce(runningScan('s1')).mockResolvedValue(null);
        const onEnd = vi.fn();
        const { result } = renderHook(() => useClusterScan('c', vi.fn(), onEnd));
        await waitFor(() => expect(onEnd).toHaveBeenCalledWith({ kind: 'done', id: 's1', late: true }));
        expect(result.current.running).toBe(false);
    });

    it('settles when Stop finds nothing running', async () => {
        getRunning.mockResolvedValue(runningScan('s1'));
        const onEnd = vi.fn();
        const { result } = renderHook(() => useClusterScan('c', vi.fn(), onEnd));
        await waitFor(() => expect(result.current.running).toBe(true));
        await waitFor(() => expect(getRunning).toHaveBeenCalledTimes(2));

        // It ended while the socket was down: Stop has nothing to cancel.
        getRunning.mockResolvedValue(null);
        stopScan.mockResolvedValue(false);
        act(() => result.current.stop());
        await waitFor(() => expect(onEnd).toHaveBeenCalledWith({ kind: 'done', id: 's1', late: true }));
        expect(result.current.running).toBe(false);
        expect(result.current.stopping).toBe(false);
    });

    it('keeps waiting when Stop did cancel a running scan', async () => {
        getRunning.mockResolvedValue(runningScan('s1'));
        stopScan.mockResolvedValue(true);
        const onEnd = vi.fn();
        const { result } = renderHook(() => useClusterScan('c', vi.fn(), onEnd));
        await waitFor(() => expect(getRunning).toHaveBeenCalledTimes(2));
        act(() => result.current.stop());
        await waitFor(() => expect(stopScan).toHaveBeenCalledWith('s1'));
        expect(result.current.stopping).toBe(true);
        expect(onEnd).not.toHaveBeenCalled();
    });

    it('polls while running and settles once the scan is gone', async () => {
        vi.useFakeTimers();
        getRunning.mockResolvedValue(runningScan('s1'));
        const onEnd = vi.fn();
        const { result } = renderHook(() => useClusterScan('c', vi.fn(), onEnd));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(result.current.running).toBe(true);
        const calls = getRunning.mock.calls.length;

        await act(async () => { await vi.advanceTimersByTimeAsync(RECONCILE_MS); });
        expect(getRunning.mock.calls.length).toBe(calls + 1);
        expect(onEnd).not.toHaveBeenCalled();

        // Another scan is running now: this one is over.
        getRunning.mockResolvedValue(runningScan('s2'));
        await act(async () => { await vi.advanceTimersByTimeAsync(RECONCILE_MS); });
        expect(onEnd).toHaveBeenCalledWith({ kind: 'done', id: 's1', late: true });
        expect(result.current.running).toBe(false);

        // Nothing is followed any more, so the polling stops.
        const after = getRunning.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(RECONCILE_MS * 2); });
        expect(getRunning.mock.calls.length).toBe(after);
    });
});
