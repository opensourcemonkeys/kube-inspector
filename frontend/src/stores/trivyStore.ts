import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type TrivySection = 'summary' | 'fixplan' | 'findings' | 'coverage';

export interface TrivyClusterState {
    section: TrivySection;
    /** The saved scan on screen; null follows the newest. */
    scanId: string | null;
    /** The scan it is compared with; null means "the one before scanId". */
    compareId: string | null;
    /** The fix-plan item open in the detail pane. */
    selectedFix: string | null;
}

interface TrivyStore {
    byCluster: Record<string, TrivyClusterState>;
    aiSuggestions: boolean;
    patch: (cluster: string, p: Partial<TrivyClusterState>) => void;
    setAiSuggestions: (v: boolean) => void;
}

const DEFAULT_STATE: TrivyClusterState = { section: 'summary', scanId: null, compareId: null, selectedFix: null };

/**
 * The vulnerability scan screen's view state. Which section and scan a cluster
 * shows is kept in memory only (a reopened tab within the session returns to
 * it, a restart starts on the newest scan's summary); the AI-suggestions switch
 * is a preference, and the only field persisted.
 */
export const useTrivyStore = create<TrivyStore>()(
    persist(
        (set) => ({
            byCluster: {},
            aiSuggestions: false,
            patch: (cluster, p) => set((s) => ({
                byCluster: { ...s.byCluster, [cluster]: { ...(s.byCluster[cluster] ?? DEFAULT_STATE), ...p } },
            })),
            setAiSuggestions: (aiSuggestions) => set({ aiSuggestions }),
        }),
        {
            name: 'kube-ins-trivy',
            storage: createJSONStorage(() => localStorage),
            version: 1,
            partialize: (s) => ({ aiSuggestions: s.aiSuggestions }),
        },
    ),
);

export function trivyState(cluster: string): TrivyClusterState {
    return useTrivyStore.getState().byCluster[cluster] ?? DEFAULT_STATE;
}

/** Selector hook; returns the shared default (a stable reference) for a cluster never written. */
export const useTrivyState = (cluster: string): TrivyClusterState =>
    useTrivyStore((s) => s.byCluster[cluster] ?? DEFAULT_STATE);
