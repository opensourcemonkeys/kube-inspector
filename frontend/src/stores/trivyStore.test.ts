import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { trivyState, useTrivyStore, useTrivyState } from './trivyStore';

describe('trivyStore', () => {
    beforeEach(() => {
        localStorage.clear();
        useTrivyStore.setState({ byCluster: {}, aiSuggestions: false });
    });

    it('keeps AI suggestions off by default', () => {
        expect(useTrivyStore.getState().aiSuggestions).toBe(false);
    });

    it('keeps the section per cluster', () => {
        useTrivyStore.getState().patch('a', { section: 'fixplan' });
        expect(trivyState('a').section).toBe('fixplan');
        expect(trivyState('b').section).toBe('summary');
    });

    it('defaults every field of a cluster never written', () => {
        expect(trivyState('none')).toEqual({ section: 'summary', scanId: null, compareId: null, selectedFix: null });
    });

    it('merges a patch over the cluster’s state', () => {
        const { patch } = useTrivyStore.getState();
        patch('a', { scanId: 's2', compareId: 's1' });
        patch('a', { selectedFix: 'pkg:openssl@1' });
        expect(trivyState('a')).toEqual({ section: 'summary', scanId: 's2', compareId: 's1', selectedFix: 'pkg:openssl@1' });
    });

    it('persists only aiSuggestions', () => {
        useTrivyStore.getState().patch('a', { section: 'coverage', scanId: 's1' });
        useTrivyStore.getState().setAiSuggestions(true);
        const raw = localStorage.getItem('kube-ins-trivy');
        expect(raw).not.toBeNull();
        const saved = JSON.parse(raw as string);
        expect(saved.state.aiSuggestions).toBe(true);
        expect(saved.state.byCluster).toBeUndefined();
    });

    it('returns a stable default for a cluster never written', () => {
        // A fresh object per call would make the selector re-render forever.
        const { result, rerender } = renderHook(() => useTrivyState('none'));
        const first = result.current;
        rerender();
        expect(result.current).toBe(first);
    });
});
