import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { ITerminalOptions, ITheme, Terminal } from '@xterm/xterm';
import { displayColor, useThemeVersion } from './themeColors';
import { MONO_FONT } from './fonts';
import { prefersReducedMotion } from './motion';

/**
 * The terminal palette, derived from the app palette.
 *
 * xterm takes an `ITheme` of plain color strings and paints them itself, so
 * `var(--err)` never reaches it — the values have to be resolved. This is the
 * single definition; the terminal panel, the pod-exec panel and the CLI-mode
 * overlay all used to carry their own near-identical copy, which is why a theme
 * switch left them all looking like the default theme.
 *
 * The ANSI slots come from the `--ansi-*` tokens. Red, green, yellow and blue
 * resolve to the status colors, so a shell's red still reads as this theme's
 * "bad"; cyan is its own hue rather than the accent, which would have painted
 * every `ls --color` directory in the selection color.
 *
 * Everything is read through `displayColor`, the dark-display scope: the
 * terminal stays dark in the light theme, so it takes the dark palette there.
 */
// ITheme's selection slots are the only ones that take alpha, and displayColor
// hands back the palette's #rrggbb — so the two have to be combined here.
function withAlpha(hex: string | undefined, alpha: number): string | undefined {
    if (!hex) return undefined;
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return undefined;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function xtermTheme(): ITheme {
    const bg = displayColor('--screen-dark');
    const fg = displayColor('--ink');
    const accent = displayColor('--accent');
    return {
        background: bg,
        foreground: fg,
        cursor: accent,
        cursorAccent: bg,
        // xterm's default selection is a theme-blind rgba(255,255,255,.3) wash
        // that is barely visible on these dark backgrounds — which matters now
        // that copying is selection-driven. selectionForeground is deliberately
        // left unset: forcing it would flatten coloured output while selecting.
        selectionBackground: withAlpha(accent, 0.3),
        selectionInactiveBackground: withAlpha(accent, 0.15),
        black: displayColor('--line-strong'),
        red: displayColor('--ansi-red'),
        green: displayColor('--ansi-green'),
        yellow: displayColor('--ansi-yellow'),
        blue: displayColor('--ansi-blue'),
        magenta: displayColor('--ansi-magenta'),
        cyan: displayColor('--ansi-cyan'),
        white: displayColor('--ink-2'),
        brightBlack: displayColor('--ink-3'),
        brightRed: displayColor('--ansi-red'),
        brightGreen: displayColor('--ansi-green'),
        brightYellow: displayColor('--ansi-yellow'),
        brightBlue: displayColor('--ansi-blue'),
        brightMagenta: displayColor('--ansi-magenta'),
        brightCyan: displayColor('--ansi-cyan'),
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
        cursorBlink: !prefersReducedMotion(),
        cursorStyle: 'underline',
        fontFamily: MONO_FONT,
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
