import { create } from 'zustand';

/**
 * The resource view behind the focused Dockview panel, for the sidebar's
 * active item.
 *
 * The sidebar used to keep its own `activeView`, set only when one of its own
 * items was clicked — so it went on marking Pods while the user was looking at
 * a Deployments tab, and marked Pods at launch while Overview was open. It now
 * follows the workspace instead.
 *
 * A store rather than a field on TabContext: that context's value object is
 * rebuilt on every TabProvider render, so a value that changes on every tab
 * switch would re-render every list that calls useTabContext().
 *
 * Not persisted — it is derived from the layout, which restores itself.
 */
interface ActiveViewStore {
    view: string | null;
    setView: (view: string | null) => void;
}

export const useActiveViewStore = create<ActiveViewStore>()((set) => ({
    view: null,
    setView: (view) => set({ view }),
}));

/**
 * Which sidebar view a panel is. Only view panels (`pods:my-cluster`) carry a
 * `view`; a YAML, log or terminal tab is not a place in the sidebar, so while
 * one is focused nothing is marked rather than the list it came from.
 */
export function viewOfPanel(params: unknown): string | null {
    const v = (params as { view?: unknown } | undefined)?.view;
    return typeof v === 'string' && v ? v : null;
}
