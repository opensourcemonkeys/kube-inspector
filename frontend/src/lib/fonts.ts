/**
 * The monospace stack, for the two consumers that cannot read a CSS variable:
 * xterm and Monaco take a font-family string and measure glyphs themselves.
 * Mirrors `--font-family-mono` in theme-monolith.css — keep the two in sync.
 */
export const MONO_FONT = '"IBM Plex Mono", ui-monospace, monospace';

/**
 * Resolves once Plex Mono is ready to measure.
 *
 * xterm and Monaco size their character cells from the font that is loaded at
 * the moment they open. A webfont is only fetched once something on the page
 * uses it, so a terminal opened before any mono text was painted measured the
 * fallback face and drew Plex into cells of the wrong width. `main.tsx`
 * imports this module, which starts the fetch at launch; Monaco also re-measures
 * when it settles (see monacoBootstrap.ts).
 */
export const monoFontReady: Promise<unknown> =
    typeof document !== 'undefined' && document.fonts
        ? Promise.all([
            document.fonts.load('400 13px "IBM Plex Mono"'),
            document.fonts.load('500 13px "IBM Plex Mono"'),
            document.fonts.load('italic 400 13px "IBM Plex Mono"'),
        ]).catch(() => undefined)
        : Promise.resolve();
