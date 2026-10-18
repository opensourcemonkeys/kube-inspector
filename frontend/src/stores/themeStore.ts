import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type ThemeId = 'graphite' | 'daylight' | 'last-samurai' | 'god-of-war';

export const THEMES: { id: ThemeId; label: string }[] = [
    { id: 'graphite', label: 'Graphite' },
    { id: 'daylight', label: 'Daylight' },
    { id: 'last-samurai', label: 'Last Samurai' },
    { id: 'god-of-war', label: 'God of War' },
];

const STORE_KEY = 'kube-ins-theme';

// Apply a theme by setting (or clearing) data-theme on <html>. The default
// "graphite" palette lives in :root, so it uses no attribute.
function applyTheme(theme: ThemeId) {
    const el = document.documentElement;
    if (theme === 'graphite') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
}

/**
 * The theme for someone who has never picked one: daylight when the OS is in
 * light mode, graphite otherwise. Under Electron `prefers-color-scheme` follows
 * the OS setting. It is only a starting point — nothing is persisted until the
 * user chooses, so the suggestion keeps following the OS until then, and a
 * choice always wins over it.
 */
function suggestedTheme(): ThemeId {
    const light = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-color-scheme: light)').matches === true;
    return light ? 'daylight' : 'graphite';
}

// A theme that has been removed (or a hand-edited localStorage value) must not
// reach applyTheme: it would stamp a data-theme with no CSS block behind it,
// leaving the app on the :root palette with nothing selected in the picker.
// The default has been renamed twice — "monolith" before the redesign,
// "sodium" while its accent was orange — and both ids name the palette that is
// now graphite, so they map there rather than to the OS suggestion: that user
// did choose a dark theme.
function coerceTheme(theme: unknown): ThemeId {
    if (theme === 'monolith' || theme === 'sodium') return 'graphite';
    return THEMES.some((t) => t.id === theme) ? (theme as ThemeId) : suggestedTheme();
}

// Apply the theme synchronously at module load, before React renders, to avoid
// a flash of the default palette — including the suggested one, so a light-mode
// OS never sees a dark first frame.
(function bootstrap() {
    let t: unknown;
    try {
        const raw = localStorage.getItem(STORE_KEY);
        t = raw ? JSON.parse(raw)?.state?.theme : undefined;
    } catch { /* ignore */ }
    applyTheme(coerceTheme(t));
})();

interface ThemeStore {
    theme: ThemeId;
    setTheme: (t: ThemeId) => void;
}

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: suggestedTheme(),
            setTheme: (theme) => { applyTheme(theme); set({ theme }); },
        }),
        {
            name: STORE_KEY,
            storage: createJSONStorage(() => localStorage),
            // 3: the default theme's id changed from "monolith" to "sodium";
            // 4: and from "sodium" to "graphite", when its accent became blue.
            version: 4,
            migrate: (persisted: any) => ({ ...persisted, theme: coerceTheme(persisted?.theme) }),
            onRehydrateStorage: () => (state) => {
                if (!state) return;
                state.theme = coerceTheme(state.theme);
                applyTheme(state.theme);
            },
        },
    ),
);
