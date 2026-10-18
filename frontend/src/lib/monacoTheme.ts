import { useEffect } from 'react';
import { loader, type Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { displayColor, useThemeVersion, type ThemeVar } from './themeColors';
import { MONO_FONT } from './fonts';
import { prefersReducedMotion } from './motion';

/** The Monaco theme every editor panel uses. Its colors are the app palette. */
export const MONACO_THEME = 'kube-ins';

/** Editor options shared by every YAML panel. */
export const MONACO_BASE_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
    fontFamily: MONO_FONT,
    fontSize: 13,
    // Plex Mono has no programming ligatures, and `!=`/`->` must read as typed.
    fontLigatures: false,
    // Monaco draws its own caret, out of reach of the reduced-motion CSS block.
    cursorBlinking: prefersReducedMotion() ? 'solid' : 'blink',
};

// Monaco only accepts #rrggbb / #rrggbbaa — no var(), rgba() or color-mix().
// Every colour comes from the dark-display scope: the editor stays dark in the
// light theme, widgets included.
function hex(name: ThemeVar, alpha?: number): string {
    const c = displayColor(name);
    if (alpha === undefined || !/^#[0-9a-f]{6}$/i.test(c)) return c;
    return c + Math.round(alpha * 255).toString(16).padStart(2, '0');
}
const fg = (name: ThemeVar) => hex(name).replace('#', '');

/**
 * (Re)defines the theme from the current palette.
 *
 * Pass as an editor's `beforeMount`: Monaco resolves `theme` while mounting,
 * so the definition has to exist first.
 */
export function defineMonacoTheme(monaco: Monaco): void {
    monaco.editor.defineTheme(MONACO_THEME, {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: '', foreground: fg('--ink') },
            { token: 'type', foreground: fg('--ansi-blue') },          // YAML keys
            { token: 'string', foreground: fg('--ink') },
            { token: 'number', foreground: fg('--ansi-cyan') },
            { token: 'keyword', foreground: fg('--ansi-cyan') },       // true / false / null
            { token: 'tag', foreground: fg('--ansi-magenta') },        // !!str and friends
            { token: 'operators', foreground: fg('--ink-2') },
            { token: 'delimiter', foreground: fg('--ink-2') },
            { token: 'comment', foreground: fg('--ink-3'), fontStyle: 'italic' },
        ],
        colors: {
            'editor.background': hex('--screen-dark'),
            'editor.foreground': hex('--ink'),
            'editorGutter.background': hex('--screen-dark'),
            'minimap.background': hex('--screen-dark'),
            'editorLineNumber.foreground': hex('--ink-3'),
            'editorLineNumber.activeForeground': hex('--ink-2'),
            'editor.lineHighlightBackground': hex('--screen-2'),
            'editor.lineHighlightBorder': '#00000000',
            'editorCursor.foreground': hex('--accent'),
            'editor.selectionBackground': hex('--accent', 0.28),
            'editor.inactiveSelectionBackground': hex('--accent', 0.14),
            'editor.findMatchBackground': hex('--warn', 0.4),
            'editor.findMatchHighlightBackground': hex('--warn', 0.18),
            'editorIndentGuide.background1': hex('--line'),
            'editorIndentGuide.activeBackground1': hex('--line-strong'),
            'editorBracketMatch.background': hex('--accent', 0.12),
            'editorBracketMatch.border': hex('--accent', 0.5),
            'editorWidget.background': hex('--bezel-raised'),
            'editorWidget.border': hex('--line-strong'),
            'editorSuggestWidget.background': hex('--bezel-raised'),
            'editorSuggestWidget.border': hex('--line-strong'),
            'editorSuggestWidget.foreground': hex('--ink'),
            'editorSuggestWidget.selectedBackground': hex('--screen-2'),
            'editorSuggestWidget.highlightForeground': hex('--accent'),
            'editorHoverWidget.background': hex('--bezel-raised'),
            'editorHoverWidget.border': hex('--line-strong'),
            'editorError.foreground': hex('--err'),
            'editorWarning.foreground': hex('--warn'),
            'scrollbarSlider.background': hex('--ink-3', 0.25),
            'scrollbarSlider.hoverBackground': hex('--ink-3', 0.4),
            'scrollbarSlider.activeBackground': hex('--ink-3', 0.55),
            'focusBorder': hex('--accent', 0.6),
        },
    });
}

/**
 * Repaints open editors when the user switches app themes. Monaco themes are
 * global, so one call re-skins every editor; mounting it in each panel is
 * harmless and keeps a panel correct when it is the only one open.
 */
export function useMonacoTheme(): void {
    const theme = useThemeVersion();
    useEffect(() => {
        // The attribute flip happens in the store's setter, before this effect,
        // so the palette read here is already the new one.
        void loader.init().then((monaco) => {
            defineMonacoTheme(monaco);
            monaco.editor.setTheme(MONACO_THEME);
        });
    }, [theme]);
}
