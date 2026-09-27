import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { ITerminalOptions, ITheme, Terminal } from '@xterm/xterm';
import { themeColor, useThemeVersion } from './themeColors';

/**
 * The terminal palette, derived from the app palette.
 *
 * xterm takes an `ITheme` of plain color strings and paints them itself, so
 * `var(--red)` never reaches it — the values have to be resolved. This is the
 * single definition; the terminal panel, the pod-exec panel and the CLI-mode
 * overlay all used to carry their own near-identical copy, which is why a theme
 * switch left them all looking like the default theme.
 *
 * The ANSI slots are mapped to the palette's semantic colors rather than to
 * literal ANSI hues: what matters is that a shell's red still reads as this
 * theme's "bad" and its green as this theme's "good".
 */
// ITheme's selection slots are the only ones that take alpha, and themeColor
// hands back the palette's #rrggbb — so the two have to be combined here.
function withAlpha(hex: string | undefined, alpha: number): string | undefined {
    if (!hex) return undefined;
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return undefined;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function xtermTheme(): ITheme {
    const bg = themeColor('--panel2');
    const fg = themeColor('--ink');
    const accent = themeColor('--blue');
    return {
        background: bg,
        foreground: fg,
        cursor: accent,
        cursorAccent: bg,
        // xterm's default selection is a theme-blind rgba(255,255,255,.3) wash
        // that is barely visible on these dark backgrounds — which matters now
        // that copying is selection-driven. selectionForeground is deliberately
        // left unset: forcing it would flatten coloured output while selecting.
        selectionBackground: withAlpha(accent, 0.35),
        selectionInactiveBackground: withAlpha(accent, 0.18),
        black: themeColor('--panel3'),
        red: themeColor('--red'),
        green: themeColor('--green'),
        yellow: themeColor('--amber'),
        blue: accent,
        magenta: themeColor('--violet'),
        cyan: themeColor('--teal'),
        white: themeColor('--ink2'),
        brightBlack: themeColor('--ink3'),
        brightRed: themeColor('--red'),
        brightGreen: themeColor('--green'),
        brightYellow: themeColor('--amber'),
        brightBlue: accent,
        brightMagenta: themeColor('--violet'),
        brightCyan: themeColor('--teal'),
        brightWhite: fg,
    };
}

/**
 * Repaints a live terminal when the user switches themes.
 *
 * A terminal is created once per session and deliberately survives everything
 * else (see the session-registry rules), so without this it would keep the
 * palette that was active when its shell started.
 */
export function useXtermTheme(termRef: RefObject<Terminal | null>): void {
    const theme = useThemeVersion();
    useEffect(() => {
        const term = termRef.current;
        if (term) term.options.theme = xtermTheme();
    }, [theme, termRef]);
}

/**
 * Constructor options shared by the terminal and pod-exec panels.
 *
 * Kept here rather than copied into each panel so the two cannot drift, and so
 * a test can build a terminal that is genuinely the one the app ships.
 */
export function xtermOptions(): ITerminalOptions {
    return {
        cursorBlink: true,
        cursorStyle: 'underline',
        fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
        fontSize: 13,
        lineHeight: 1.4,
        // xterm's default is 1000 rows, which a single `kubectl logs` scrolls
        // past. Rows beyond this are dropped from the buffer outright, not
        // hidden — so this also bounds what "Copy all output" and "Save output
        // to file" can reach. ~1KB per 80-column row, so this costs a few MB
        // per terminal.
        scrollback: 3500,
        // Required by @xterm/addon-search's `decorations` option: registering a
        // decoration is gated on this at runtime even though the typings put
        // registerDecoration in the stable interface. Without it every
        // findNext/findPrevious throws "You must set the allowProposedApi
        // option to true", which reads as "find is broken" rather than as an
        // error — see the regression test in lib/terminalSearch.test.ts.
        allowProposedApi: true,
        theme: xtermTheme(),
    };
}
