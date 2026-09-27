import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
    needsPasteConfirm,
    normalisePaste,
    pasteLineCount,
    readScrollback,
    terminalKeyHandler,
    type KeyHandlerDeps,
} from './terminalActions';

function deps(overrides: Partial<KeyHandlerDeps> = {}) {
    return {
        hasSelection: vi.fn(() => false),
        copySelection: vi.fn(),
        clearSelection: vi.fn(),
        requestPaste: vi.fn(),
        selectAll: vi.fn(),
        clearScreen: vi.fn(),
        openSearch: vi.fn(),
        fontDelta: vi.fn(),
        fontReset: vi.fn(),
        ...overrides,
    };
}

function key(init: Partial<KeyboardEvent> & { key?: string; code?: string }): KeyboardEvent {
    return {
        type: 'keydown',
        key: '',
        code: '',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        ...init,
    } as unknown as KeyboardEvent;
}

describe('terminalKeyHandler', () => {
    // The single most important property in this file: a terminal that cannot
    // be interrupted is a broken terminal, so plain Ctrl+C has to reach the pty
    // untouched whenever there is nothing selected.
    it('lets plain Ctrl+C through when nothing is selected', () => {
        const d = deps();
        const e = key({ key: 'c', code: 'KeyC', ctrlKey: true });
        expect(terminalKeyHandler(d)(e)).toBe(true);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(d.copySelection).not.toHaveBeenCalled();
    });

    it('copies and clears the selection on plain Ctrl+C when there is one', () => {
        const d = deps({ hasSelection: vi.fn(() => true) });
        const e = key({ key: 'c', code: 'KeyC', ctrlKey: true });
        expect(terminalKeyHandler(d)(e)).toBe(false);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(d.copySelection).toHaveBeenCalled();
        // Without this the next Ctrl+C would copy again instead of killing.
        expect(d.clearSelection).toHaveBeenCalled();
    });

    it('lets plain Ctrl+V through as a control char', () => {
        const d = deps();
        const e = key({ key: 'v', code: 'KeyV', ctrlKey: true });
        expect(terminalKeyHandler(d)(e)).toBe(true);
        expect(d.requestPaste).not.toHaveBeenCalled();
    });

    it('copies on Ctrl+Shift+C without clearing the selection', () => {
        const d = deps({ hasSelection: vi.fn(() => true) });
        const e = key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
        expect(terminalKeyHandler(d)(e)).toBe(false);
        expect(d.copySelection).toHaveBeenCalled();
        expect(d.clearSelection).not.toHaveBeenCalled();
    });

    it('falls through on Ctrl+Shift+C with no selection so it still interrupts', () => {
        const d = deps();
        const e = key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
        expect(terminalKeyHandler(d)(e)).toBe(true);
    });

    it('claims Ctrl+Shift+V, A, K and F', () => {
        const cases: [string, keyof KeyHandlerDeps][] = [
            ['v', 'requestPaste'],
            ['a', 'selectAll'],
            ['k', 'clearScreen'],
            ['f', 'openSearch'],
        ];
        for (const [k, fn] of cases) {
            const d = deps();
            const e = key({ key: k, ctrlKey: true, shiftKey: true });
            expect(terminalKeyHandler(d)(e)).toBe(false);
            expect(d[fn]).toHaveBeenCalled();
        }
    });

    // AltGr arrives as ctrl+alt on Windows, so a Turkish or Polish layout must
    // still be able to type the glyph.
    it('ignores Ctrl+Alt+Shift+C (AltGr)', () => {
        const d = deps({ hasSelection: vi.fn(() => true) });
        const e = key({ key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true, altKey: true });
        expect(terminalKeyHandler(d)(e)).toBe(true);
        expect(d.copySelection).not.toHaveBeenCalled();
    });

    it('ignores Ctrl+Shift+I so devtools still opens', () => {
        expect(terminalKeyHandler(deps())(key({ key: 'i', ctrlKey: true, shiftKey: true }))).toBe(true);
    });

    it('ignores keyup', () => {
        const d = deps({ hasSelection: vi.fn(() => true) });
        const e = key({ type: 'keyup', key: 'c', code: 'KeyC', ctrlKey: true });
        expect(terminalKeyHandler(d)(e)).toBe(true);
        expect(d.copySelection).not.toHaveBeenCalled();
    });

    it('handles font size on code, not key', () => {
        const d = deps();
        // Shift+Ctrl+'=' reports key '+', which is why the branch reads .code.
        expect(terminalKeyHandler(d)(key({ key: '+', code: 'Equal', ctrlKey: true }))).toBe(false);
        expect(d.fontDelta).toHaveBeenCalledWith(1);
        expect(terminalKeyHandler(d)(key({ key: '-', code: 'NumpadSubtract', ctrlKey: true }))).toBe(false);
        expect(d.fontDelta).toHaveBeenCalledWith(-1);
        expect(terminalKeyHandler(d)(key({ key: '0', code: 'Digit0', ctrlKey: true }))).toBe(false);
        expect(d.fontReset).toHaveBeenCalled();
    });
});

function fakeTerm(lines: string[], cursorY: number, baseY = 0): Terminal {
    return {
        buffer: {
            active: {
                length: lines.length,
                baseY,
                cursorY,
                getLine: (y: number) =>
                    y < lines.length ? { translateToString: () => lines[y] } : undefined,
            },
        },
    } as unknown as Terminal;
}

describe('readScrollback', () => {
    it('stops at the cursor row', () => {
        // A fresh 5-row terminal: two lines of output, three blank rows the
        // buffer always carries.
        expect(readScrollback(fakeTerm(['a', 'b', '', '', ''], 2))).toBe('a\nb');
    });

    it('trims trailing blanks left below the cursor', () => {
        expect(readScrollback(fakeTerm(['a', '', '', ''], 3))).toBe('a');
    });

    it('returns empty for an untouched terminal', () => {
        expect(readScrollback(fakeTerm(['', '', ''], 0))).toBe('');
    });
});

describe('paste helpers', () => {
    it('does not confirm a single line, with or without a trailing newline', () => {
        expect(needsPasteConfirm('kubectl get pods')).toBe(false);
        expect(needsPasteConfirm('kubectl get pods\n')).toBe(false);
        expect(needsPasteConfirm('kubectl get pods\r\n')).toBe(false);
    });

    it('confirms anything with an embedded newline', () => {
        expect(needsPasteConfirm('a\nb')).toBe(true);
        expect(needsPasteConfirm('a\r\nb\r\n')).toBe(true);
        expect(pasteLineCount('a\r\nb\r\n')).toBe(2);
    });

    it('converts every newline to CR for the pty', () => {
        expect(normalisePaste('a\r\nb\nc')).toBe('a\rb\rc');
    });
});
