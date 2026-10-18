import { useThemeStore } from '../stores/themeStore';

/**
 * Palette variable names, as defined in theme-monolith.css. Every alternate
 * theme (`last-samurai`, `god-of-war`, `daylight`) re-binds these,
 * which is what makes reading them enough to re-skin anything.
 */
export type ThemeVar =
    | '--screen' | '--screen-2' | '--screen-dark' | '--well'
    | '--bezel' | '--bezel-raised' | '--bezel-high' | '--line' | '--line-strong'
    | '--ink' | '--ink-2' | '--ink-3'
    | '--accent' | '--ok' | '--warn' | '--err' | '--info' | '--violet'
    | '--on-accent'
    | '--ansi-red' | '--ansi-green' | '--ansi-yellow' | '--ansi-blue' | '--ansi-magenta' | '--ansi-cyan'
    | '--cat-1' | '--cat-2' | '--cat-3' | '--cat-4' | '--cat-5' | '--cat-6';

/**
 * The default (Graphite) palette, mirrored from `:root` in
 * theme-monolith.css.
 *
 * Used only as the fallback when a variable cannot be read — a non-browser
 * environment (tests) or a stylesheet that has not applied yet. Keep in sync
 * with the CSS; being a little stale here is harmless, being absent is not,
 * because the alternative fallback is an unreadable black-on-black.
 */
const PALETTE_FALLBACK: Record<ThemeVar, string> = {
    '--screen': '#17191b', '--screen-2': '#1e2124', '--screen-dark': '#121416', '--well': '#121416',
    '--bezel': '#24282c', '--bezel-raised': '#2d3237', '--bezel-high': '#353a40',
    '--line': '#2c3034', '--line-strong': '#3a4045',
    '--ink': '#ece6d9', '--ink-2': '#b8b3a7', '--ink-3': '#9e9a92',
    '--accent': '#58bde8', '--ok': '#7fb685', '--warn': '#e3c84b',
    '--err': '#e9786a', '--info': '#9ea6ec', '--violet': '#a891c9',
    '--on-accent': '#06151d',
    '--ansi-red': '#e9786a', '--ansi-green': '#7fb685', '--ansi-yellow': '#e3c84b',
    '--ansi-blue': '#9ea6ec', '--ansi-magenta': '#a891c9', '--ansi-cyan': '#6fb3b8',
    '--cat-1': '#7c9fc4', '--cat-2': '#a48fc9', '--cat-3': '#6eb0b0',
    '--cat-4': '#c3a46a', '--cat-5': '#c98ba6', '--cat-6': '#a3ad6b',
};

/**
 * Reads a palette variable as a concrete color string.
 *
 * Most of the UI should use `var(--x)` in CSS and never call this. It exists
 * for the two places a CSS variable cannot reach:
 *   - **canvas** — chart.js paints into a bitmap and takes real colors;
 *   - **xterm** — its `ITheme` is a plain object of color strings.
 *
 * Falls back to the argument when the variable is missing or the document is
 * not available (tests), so a caller always gets something paintable.
 */
export function themeColor(name: ThemeVar, fallback = PALETTE_FALLBACK[name]): string {
    if (typeof document === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

let displayProbe: HTMLElement | null = null;

/**
 * Reads a palette variable as it is inside a dark display — the code, log and
 * terminal surfaces that stay dark in the light theme.
 *
 * theme-monolith.css re-binds the whole palette under `.dark-display` when the
 * daylight theme is active, so a hidden element carrying that class resolves
 * the display's values; in every dark theme it simply inherits the root's.
 * Monaco and xterm paint themselves and must take every colour from here:
 * mixing in one root value would put daylight's graphite ink on a dark editor.
 */
export function displayColor(name: ThemeVar, fallback = PALETTE_FALLBACK[name]): string {
    if (typeof document === 'undefined' || !document.body) return fallback;
    if (!displayProbe || !displayProbe.isConnected) {
        displayProbe = document.createElement('div');
        displayProbe.className = 'dark-display';
        displayProbe.hidden = true;
        document.body.appendChild(displayProbe);
    }
    const value = getComputedStyle(displayProbe).getPropertyValue(name).trim();
    return value || fallback;
}

/**
 * Subscribes a component to theme changes so colors it resolved through
 * `themeColor` are re-read when the user switches palettes.
 *
 * Returns the active theme id: components that cache resolved colors should
 * put it in the dependency list of the `useMemo`/`useEffect` that does the
 * caching. Without it, switching themes leaves canvases and terminals painted
 * in the old palette until they happen to remount.
 */
export function useThemeVersion(): string {
    return useThemeStore((s) => s.theme);
}

/**
 * A palette color at partial opacity, as `rgba(...)`.
 *
 * For canvas fills (chart.js area series). CSS could do this with
 * `color-mix(in srgb, var(--accent) 15%, transparent)`, but chart.js hands the
 * string to the 2D context, which does not understand `color-mix` or `var`.
 * Handles the `#rgb` and `#rrggbb` forms the palettes use; anything else is
 * returned untouched, so a future `oklch()` palette degrades to opaque rather
 * than to an unpaintable string.
 */
export function themeAlpha(name: ThemeVar, alpha: number, fallback = PALETTE_FALLBACK[name]): string {
    const color = themeColor(name, fallback);
    const hex = color.startsWith('#') ? color.slice(1) : '';
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    if (full.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(full)) return color;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
