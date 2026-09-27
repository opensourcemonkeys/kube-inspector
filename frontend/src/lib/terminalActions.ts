// Pure terminal helpers, deliberately free of React and of any DOM beyond the
// KeyboardEvent shape — everything here is unit-testable on its own, which is
// the point: the key handler decides whether Ctrl+C reaches the pty, and that
// is not a thing to verify by hand after every refactor.
//
// The React side lives in components/terminal/useTerminalActions.tsx.
import type { Terminal } from '@xterm/xterm';

/**
 * Whole scrollback as plain text.
 *
 * Public xterm API only — @xterm/addon-serialize would add a dependency for
 * something three lines of IBuffer already answer. Reading stops at the cursor
 * row rather than at `buffer.length`, because the buffer is always at least
 * `rows` tall: a freshly opened 40-row terminal would otherwise yield 39 blank
 * lines. The trailing trim covers a shell that left the cursor below its last
 * output.
 */
export function readScrollback(term: Terminal): string {
    const buf = term.buffer.active;
    const last = Math.min(buf.baseY + buf.cursorY, Math.max(buf.length - 1, 0));
    const lines: string[] = [];
    for (let i = 0; i <= last; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
}

/** Line count as the paste dialog reports it (one trailing newline ignored). */
export function pasteLineCount(text: string): number {
    return text.replace(/\r\n$|[\r\n]$/, '').split(/\r\n|\r|\n/).length;
}

/**
 * Whether a paste is dangerous enough to show the preview dialog first.
 *
 * A single trailing newline is not counted: copying one command out of a doc
 * usually drags it along, and a terminal pasting one line that then runs is
 * ordinary. Anything with an *embedded* newline runs several commands the user
 * has not read, which is the case the dialog exists for.
 */
export function needsPasteConfirm(text: string): boolean {
    return pasteLineCount(text) > 1;
}

/**
 * Converts clipboard text to what a pty expects: CR, never LF or CRLF.
 * Without this a Windows clipboard produces a blank line per pasted line.
 *
 * Deliberately not wrapped in bracketed-paste markers (\x1b[200~ … \x1b[201~):
 * the shell turns that mode on itself and wraps what it receives, so doing it
 * here double-brackets in some shells. Do not "fix" this.
 */
export function normalisePaste(text: string): string {
    return text.replace(/\r\n|\n/g, '\r');
}

export interface KeyHandlerDeps {
    hasSelection: () => boolean;
    copySelection: () => void;
    clearSelection: () => void;
    requestPaste: () => void;
    selectAll: () => void;
    clearScreen: () => void;
    openSearch: () => void;
    fontDelta: (delta: number) => void;
    fontReset: () => void;
}

/**
 * xterm's `attachCustomKeyEventHandler` callback.
 *
 * Contract: `true` means "xterm, handle this normally" (→ onData → pty) and
 * `false` means "xterm, ignore it" — but `false` does *not* call
 * preventDefault, so every key we claim needs both. Every key we do not claim
 * gets a bare `true`, and that is what keeps Ctrl+V arriving as ^V.
 */
export function terminalKeyHandler(d: KeyHandlerDeps) {
    return (e: KeyboardEvent): boolean => {
        // keyup/keypress are delivered here too; claiming only keydown avoids
        // swallowing half of a combo.
        if (e.type !== 'keydown') return true;
        const claim = () => {
            e.preventDefault();
            return false;
        };

        // Ctrl+Shift+<letter>. `!altKey` matters twice: Ctrl+Alt+Shift+C stays a
        // passthrough, and on Windows AltGr arrives as ctrl+alt — without it,
        // AltGr+C on a Turkish or Polish layout would be eaten instead of
        // typing a glyph. `.key` rather than `.code` so the letters follow the
        // user's keyboard layout.
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'c':
                    // No selection: fall through so the control char is still
                    // sent. xterm folds Shift away for control chars, so this
                    // stays an interrupt — which is what a user hammering the
                    // combo expects, and what gnome-terminal does.
                    if (!d.hasSelection()) return true;
                    d.copySelection();
                    return claim();
                case 'v':
                    d.requestPaste();
                    return claim();
                case 'a':
                    d.selectAll();
                    return claim();
                case 'k':
                    d.clearScreen();
                    return claim();
                case 'f':
                    d.openSearch();
                    return claim();
                default:
                    return true; // Ctrl+Shift+I and friends stay untouched
            }
        }

        // Plain Ctrl+C: copy when there is a selection, otherwise leave it alone
        // so it reaches the pty as \x03. The selection is cleared right after
        // copying — without that, a selection left on screen from ten minutes
        // ago silently swallows the Ctrl+C meant to stop a runaway process. With
        // it, the second press always kills.
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyC') {
            if (!d.hasSelection()) return true;
            d.copySelection();
            d.clearSelection();
            return claim();
        }

        // Font size. `.code`, not `.key`: with Shift the key is '+', and the
        // numpad reports 'Add'.
        if (e.ctrlKey && !e.altKey && !e.metaKey) {
            switch (e.code) {
                case 'Equal':
                case 'NumpadAdd':
                    d.fontDelta(+1);
                    return claim();
                case 'Minus':
                case 'NumpadSubtract':
                    d.fontDelta(-1);
                    return claim();
                case 'Digit0':
                case 'Numpad0':
                    d.fontReset();
                    return claim();
            }
        }

        return true; // everything else, plain Ctrl+C with no selection included
    };
}
