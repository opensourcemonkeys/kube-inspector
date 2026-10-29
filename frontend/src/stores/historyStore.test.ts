import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { DEFAULT_HISTORY_FILTERS, useHistoryStore, useHistoryTab } from './historyStore';

describe('historyStore', () => {
    beforeEach(() => useHistoryStore.setState({ tabs: {} }));

    it('keeps each cluster’s filters and view apart', () => {
        const { patchFilters, setView } = useHistoryStore.getState();
        patchFilters('history:a', { namespace: 'prod' });
        setView('history:b', 'users');
        const { tabs } = useHistoryStore.getState();
        expect(tabs['history:a'].filters.namespace).toBe('prod');
        expect(tabs['history:a'].view).toBe('overview');
        expect(tabs['history:b'].filters).toEqual(DEFAULT_HISTORY_FILTERS);
        expect(tabs['history:b'].view).toBe('users');
    });

    it('merges a patch over the existing filters', () => {
        const { patchFilters } = useHistoryStore.getState();
        patchFilters('history:a', { resource: 'deployments', name: 'api' });
        patchFilters('history:a', { name: 'web' });
        expect(useHistoryStore.getState().tabs['history:a'].filters).toMatchObject({ resource: 'deployments', name: 'web', since: '24h' });
    });

    it('returns a stable default for a tab never written', () => {
        // A fresh object per call would make the selector re-render forever.
        const { result, rerender } = renderHook(() => useHistoryTab('history:none'));
        const first = result.current;
        rerender();
        expect(result.current).toBe(first);
    });
});
