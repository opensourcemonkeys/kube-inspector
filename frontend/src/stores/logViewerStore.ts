import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Log viewer preferences, shared by every log panel and kept across restarts:
 * a new panel opens with whatever the user last chose. Follow and Previous are
 * deliberately not here — they describe what one panel is doing right now, not
 * how the user likes to read logs.
 */

export const TAIL_OPTIONS = [100, 500, 1000, 5000, 0] as const; // 0 = all
export const SINCE_OPTIONS = [0, 300, 900, 3600, 21600, 86400] as const; // seconds; 0 = no limit

export const DEFAULT_TAIL_LINES = 1000;

interface LogViewerStore {
    wrap: boolean;
    timestamps: boolean;
    colorLevels: boolean;
    tailLines: number;
    sinceSeconds: number;
    setWrap: (v: boolean) => void;
    setTimestamps: (v: boolean) => void;
    setColorLevels: (v: boolean) => void;
    setTailLines: (v: number) => void;
    setSinceSeconds: (v: number) => void;
}

function oneOf<T extends number>(options: readonly T[], v: unknown, fallback: T): T {
    return options.includes(v as T) ? (v as T) : fallback;
}

export const useLogViewerStore = create<LogViewerStore>()(
    persist(
        (set) => ({
            wrap: false,
            timestamps: false,
            colorLevels: true,
            tailLines: DEFAULT_TAIL_LINES,
            sinceSeconds: 0,
            setWrap: (wrap) => set({ wrap }),
            setTimestamps: (timestamps) => set({ timestamps }),
            setColorLevels: (colorLevels) => set({ colorLevels }),
            setTailLines: (tailLines) => set({ tailLines }),
            setSinceSeconds: (sinceSeconds) => set({ sinceSeconds }),
        }),
        {
            name: 'kube-ins-log-viewer',
            storage: createJSONStorage(() => localStorage),
            version: 1,
            // A hand-edited or stale value must not reach the API as a tail of
            // 7 lines nobody can select again from the dropdown.
            merge: (raw, current) => {
                const persisted = (raw ?? {}) as Partial<LogViewerStore>;
                return {
                    ...current,
                    wrap: !!persisted.wrap,
                    timestamps: !!persisted.timestamps,
                    colorLevels: persisted.colorLevels ?? current.colorLevels,
                    tailLines: oneOf(TAIL_OPTIONS, persisted.tailLines, DEFAULT_TAIL_LINES),
                    sinceSeconds: oneOf(SINCE_OPTIONS, persisted.sinceSeconds, 0),
                };
            },
        },
    ),
);
