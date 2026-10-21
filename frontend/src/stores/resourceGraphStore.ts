import { useCallback, useMemo } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { GroupBy } from '../components/clusterresource/graphLayout';

export type GraphDirection = 'TB' | 'LR';

/** Seconds between automatic refreshes; 0 is off. */
export const REFRESH_CHOICES = [0, 10, 30, 60] as const;
export type RefreshSeconds = (typeof REFRESH_CHOICES)[number];

// How the Resource Graph tab of one cluster is scoped and drawn. Persisted so a
// reopened tab comes back on the same namespaces — on a large cluster the
// all-namespaces graph is the one view nobody wants to land on by accident.
export interface ResourceGraphView {
    /** Namespaces to list; empty means every namespace. */
    namespaces: string[];
    direction: GraphDirection;
    hiddenKinds: string[];
    /** Hide ReplicaSets scaled to zero — the rollout history of every Deployment. */
    hideStaleReplicaSets: boolean;
    /** Automatic refresh while the tab is visible. */
    refreshSec: RefreshSeconds;
    /** Show live CPU/memory (metrics-server) on pods and their controllers. */
    showUsage: boolean;
    groupBy: GroupBy;
    /**
     * The user's collapse/expand choices, by controller id. A controller with
     * no entry follows the default (collapsed when it has many pods).
     */
    collapsed: Record<string, boolean>;
}

/** What a saved view restores: everything but the refresh interval, which is a habit, not a view. */
export type SavedViewSettings = Omit<ResourceGraphView, 'refreshSec'>;

export interface SavedView {
    name: string;
    settings: SavedViewSettings;
}

export const defaultGraphView = (): ResourceGraphView => ({
    namespaces: ['default'],
    direction: 'TB',
    hiddenKinds: [],
    hideStaleReplicaSets: true,
    refreshSec: 30,
    showUsage: false,
    groupBy: 'none',
    collapsed: {},
});

interface ResourceGraphStore {
    // Keyed by `resourceGraph:${clusterName}`.
    views: Record<string, ResourceGraphView>;
    patchView: (key: string, patch: Partial<ResourceGraphView>) => void;
    // Named views, by the same key. Sorted by name.
    savedViews: Record<string, SavedView[]>;
    /** Saves under a name, replacing a view of the same name. */
    saveView: (key: string, view: SavedView) => void;
    deleteView: (key: string, name: string) => void;
}

export const useResourceGraphStore = create<ResourceGraphStore>()(
    persist(
        (set) => ({
            views: {},
            patchView: (key, patch) =>
                set((state) => ({
                    views: { ...state.views, [key]: { ...defaultGraphView(), ...state.views[key], ...patch } },
                })),
            savedViews: {},
            saveView: (key, view) =>
                set((state) => {
                    const others = (state.savedViews[key] ?? []).filter((v) => v.name !== view.name);
                    const list = [...others, view].sort((a, b) => a.name.localeCompare(b.name));
                    return { savedViews: { ...state.savedViews, [key]: list } };
                }),
            deleteView: (key, name) =>
                set((state) => ({
                    savedViews: { ...state.savedViews, [key]: (state.savedViews[key] ?? []).filter((v) => v.name !== name) },
                })),
        }),
        {
            name: 'kube-ins-resource-graph-store',
            storage: createJSONStorage(() => localStorage),
            version: 1,
            partialize: (state) => ({ views: state.views, savedViews: state.savedViews }),
        },
    ),
);

/** The view for one cluster, with defaults for anything never set. */
export function useResourceGraphView(clusterName: string): [ResourceGraphView, (patch: Partial<ResourceGraphView>) => void] {
    const key = `resourceGraph:${clusterName}`;
    const stored = useResourceGraphStore((s) => s.views[key]);
    const patchView = useResourceGraphStore((s) => s.patchView);
    // Memoised on the stored object: a fresh `namespaces` array every render
    // would re-run the panel's fetch effect forever.
    const view = useMemo(() => ({ ...defaultGraphView(), ...stored }), [stored]);
    const patch = useCallback((p: Partial<ResourceGraphView>) => patchView(key, p), [patchView, key]);
    return [view, patch];
}

const NO_SAVED_VIEWS: SavedView[] = [];

/** One cluster's named views, and the functions that change them. */
export function useSavedGraphViews(clusterName: string) {
    const key = `resourceGraph:${clusterName}`;
    const list = useResourceGraphStore((s) => s.savedViews[key]) ?? NO_SAVED_VIEWS;
    const saveView = useResourceGraphStore((s) => s.saveView);
    const deleteView = useResourceGraphStore((s) => s.deleteView);
    const save = useCallback((name: string, settings: SavedViewSettings) => saveView(key, { name, settings }), [saveView, key]);
    const remove = useCallback((name: string) => deleteView(key, name), [deleteView, key]);
    return { list, save, remove };
}
