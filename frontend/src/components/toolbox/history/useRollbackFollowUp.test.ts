import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { models } from '../../../../wailsjs/go/models';
import { useRollbackFollowUp } from './useRollbackFollowUp';
import { ROLLBACK_FIELD_MANAGER } from './RollbackDialog';

vi.mock('../../../../wailsjs/go/controller_app/App', () => ({}));

const change = (over: Partial<models.ToolboxChange>) => ({
    eventId: 'e', time: new Date().toISOString(), verb: 'update', resource: 'configmaps', namespace: 'ns', name: 'app',
    fieldManager: ROLLBACK_FIELD_MANAGER, ...over,
}) as models.ToolboxChange;

describe('useRollbackFollowUp', () => {
    afterEach(() => vi.useRealTimers());

    it('refreshes until the rollback is recorded, then names that row', () => {
        vi.useFakeTimers();
        const refresh = vi.fn();
        const at = Date.now();
        const { result, rerender } = renderHook(({ items }) => useRollbackFollowUp(refresh, items), {
            initialProps: { items: [change({ eventId: 'old', time: new Date(at - 60_000).toISOString() })] },
        });
        act(() => result.current.follow({ at, resource: 'configmaps', namespace: 'ns', name: 'app' }));
        expect(result.current.waiting).toBe(true);
        act(() => { vi.advanceTimersByTime(5_000); });
        expect(refresh).toHaveBeenCalledTimes(1);
        // An older write by the same manager is not the rollback.
        expect(result.current.found).toBeNull();

        rerender({ items: [change({ eventId: 'new' }), change({ eventId: 'old', time: new Date(at - 60_000).toISOString() })] });
        expect(result.current.found).toBe('new');
        expect(result.current.waiting).toBe(false);
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('gives up after two minutes', () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useRollbackFollowUp(() => {}, []));
        act(() => result.current.follow({ at: Date.now(), resource: 'pods', namespace: 'ns', name: 'p' }));
        act(() => { vi.advanceTimersByTime(60_000); });
        // Still waiting: an unattributed rollback is written after its retry.
        expect(result.current.waiting).toBe(true);
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(result.current.waiting).toBe(false);
        expect(result.current.found).toBeNull();
    });
});
