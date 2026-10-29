import { create } from 'zustand';

// Cluster history view state (filters and the selected view), keyed by
// `history:${cluster}` so closing and reopening the tab keeps them. Kept in
// memory only, deliberately not persisted: a filter left over from yesterday
// would make a fresh launch look like history had gone missing.

export const HISTORY_VIEWS = ['overview', 'changes', 'attempts', 'users'] as const;
export type HistoryView = typeof HISTORY_VIEWS[number];

export interface HistoryFilters {
    q: string;
    namespace: string;
    resource: string;
    kind: string;
    name: string;
    user: string;
    verb: string;
    attribution: string;
    path: string;
    /** A preset duration ("24h"), "all", or "custom" for from/to. */
    since: string;
    /** ISO instants of a custom range; to is empty for "until now". */
    from: string;
    to: string;
    /** The overview chart's column width ("1h"), or "" to fit the range. */
    bucket: string;
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
    q: '', namespace: '', resource: '', kind: '', name: '', user: '', verb: '', attribution: '', path: '',
    since: '24h', from: '', to: '', bucket: '',
};

export interface HistoryTabState {
    view: HistoryView;
    filters: HistoryFilters;
}

// One shared object, so a selector reading a tab that does not exist yet
// returns the same value every time.
// The overview first: the panel opens on the summary and drills down from it.
const EMPTY_TAB: HistoryTabState = { view: 'overview', filters: DEFAULT_HISTORY_FILTERS };

interface HistoryStore {
    tabs: Record<string, HistoryTabState>;
    setView: (key: string, view: HistoryView) => void;
    patchFilters: (key: string, patch: Partial<HistoryFilters>) => void;
}

export const useHistoryStore = create<HistoryStore>((set) => ({
    tabs: {},
    setView: (key, view) =>
        set((state) => ({ tabs: { ...state.tabs, [key]: { ...(state.tabs[key] ?? EMPTY_TAB), view } } })),
    patchFilters: (key, patch) =>
        set((state) => {
            const prev = state.tabs[key] ?? EMPTY_TAB;
            return { tabs: { ...state.tabs, [key]: { ...prev, filters: { ...prev.filters, ...patch } } } };
        }),
}));

export const useHistoryTab = (key: string): HistoryTabState => useHistoryStore((s) => s.tabs[key] ?? EMPTY_TAB);
