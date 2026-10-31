import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTrivyStore } from '../../../stores/trivyStore';

const listScans = vi.fn();
const getView = vi.fn();
vi.mock('../../../../wailsjs/go/controller_app/App', () => ({
    TrivyListScans: (...a: unknown[]) => listScans(...a),
    TrivyGetScanView: (...a: unknown[]) => getView(...a),
}));

import { useScanView } from './useScanView';

describe('useScanView notice', () => {
    beforeEach(() => {
        useTrivyStore.setState({ byCluster: {}, aiSuggestions: false });
        listScans.mockReset();
        getView.mockReset();
        // One earlier saved scan; "s2" ended unseen and was never saved.
        listScans.mockResolvedValue([{ id: 's1', startedAt: '', finishedAt: '', critical: 0, high: 0, imagesFailed: 0 }]);
        getView.mockImplementation((_c: string, id: string) =>
            id === 's2' ? Promise.reject(new Error('scan s2 not found')) : Promise.resolve({ scanId: id }));
    });

    it('keeps the "scan ended" notice through the fallback load and clears it on a selection', async () => {
        const { result } = renderHook(() => useScanView('c'));
        await waitFor(() => expect(result.current.view?.scanId).toBe('s1'));

        await act(async () => { await result.current.showFinished('s2', true); });

        // The failed load of s2 falls back to the newest saved scan, which loads fine…
        await waitFor(() => expect(getView).toHaveBeenCalledWith('c', 's2', expect.anything()));
        await waitFor(() => expect(result.current.notice).toBe('ended'));
        await waitFor(() => expect(getView.mock.calls.filter((c) => c[1] === 's1').length).toBeGreaterThan(1));
        await waitFor(() => expect(result.current.loading).toBe(false));
        // …and the notice is still there afterwards.
        expect(result.current.notice).toBe('ended');
        expect(result.current.error).toBe('');
        expect(result.current.view?.scanId).toBe('s1');

        act(() => result.current.select('s1'));
        expect(result.current.notice).toBe('');
    });

    it('clears the notice when a scan is started', async () => {
        const { result } = renderHook(() => useScanView('c'));
        await act(async () => { await result.current.showFinished('s2', true); });
        await waitFor(() => expect(result.current.notice).toBe('ended'));
        act(() => result.current.clearNotice());
        expect(result.current.notice).toBe('');
    });

    it('reports a load failure of a scan it followed to the end as an error, not a notice', async () => {
        const { result } = renderHook(() => useScanView('c'));
        await act(async () => { await result.current.showFinished('s2', false); });
        await waitFor(() => expect(result.current.error).toMatch(/not found/));
        expect(result.current.notice).toBe('');
    });
});
