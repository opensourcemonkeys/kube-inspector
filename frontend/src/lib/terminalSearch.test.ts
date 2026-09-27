import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { xtermOptions } from './xtermTheme';

// jsdom has none of these; xterm's CoreBrowserService and DOM renderer need
// them before `open()` will run at all.
const w = window as unknown as Record<string, unknown>;
w.matchMedia ??= () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
});
w.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const write = (term: Terminal, s: string) =>
    new Promise<void>((resolve) => term.write(s, resolve));

/**
 * Guards the one thing that silently broke find: @xterm/addon-search's
 * `decorations` option calls registerDecoration, which xterm gates on
 * `allowProposedApi` at runtime even though its typings place it in the stable
 * interface. Dropping that option from xtermOptions() makes every keystroke in
 * the find bar throw, which looks exactly like a dead feature.
 *
 * The terminal here is built from the same xtermOptions() the panels use, so
 * the test fails if the option is removed there.
 */
describe('terminal search', () => {
    it('searches with decorations using the app\'s own terminal options', async () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        const term = new Terminal({ ...xtermOptions(), cols: 80, rows: 10 });
        term.open(el);
        const search = new SearchAddon();
        term.loadAddon(search);
        await write(term, 'hello world\r\nsecond line world\r\n');

        const decorations = {
            matchBackground: '#6ea8e6',
            activeMatchBackground: '#e2a85a',
            matchOverviewRuler: '#6ea8e6',
            activeMatchColorOverviewRuler: '#e2a85a',
        };

        expect(() => search.findNext('world', { decorations })).not.toThrow();
        expect(search.findNext('world', { decorations })).toBe(true);
        expect(term.getSelection()).toBe('world');
        expect(search.findPrevious('world', { decorations })).toBe(true);
        expect(search.findNext('no-such-token', { decorations })).toBe(false);

        term.dispose();
        el.remove();
    });

    it('declares allowProposedApi, which the decorations option requires', () => {
        expect(xtermOptions().allowProposedApi).toBe(true);
    });
});
