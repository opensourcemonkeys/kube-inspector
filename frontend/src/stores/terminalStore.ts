import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** The literal both terminal panels were hardcoded to before this store. */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 28;

const clamp = (n: unknown): number => {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_TERMINAL_FONT_SIZE;
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, v));
};

interface TerminalStore {
    fontSize: number;
    setFontSize: (n: number) => void;
    bumpFontSize: (delta: number) => void;
    resetFontSize: () => void;
}

/**
 * Terminal font size, shared by every terminal and pod-exec panel.
 *
 * Deliberately global rather than per-panel: a per-panel value would have to
 * ride in the Dockview params to survive a layout restore, and PodExecPanel has
 * no toolbar to change it from. "Make my terminals bigger" is one setting.
 */
export const useTerminalStore = create<TerminalStore>()(
    persist(
        (set, get) => ({
            fontSize: DEFAULT_TERMINAL_FONT_SIZE,
            setFontSize: (n) => set({ fontSize: clamp(n) }),
            bumpFontSize: (delta) => set({ fontSize: clamp(get().fontSize + delta) }),
            resetFontSize: () => set({ fontSize: DEFAULT_TERMINAL_FONT_SIZE }),
        }),
        {
            name: 'kube-ins-terminal',
            storage: createJSONStorage(() => localStorage),
            version: 1,
            onRehydrateStorage: () => (state) => {
                // A hand-edited or out-of-range value would otherwise render the
                // terminal unusable with no way back through the UI.
                if (state) state.fontSize = clamp(state.fontSize);
            },
        },
    ),
);
