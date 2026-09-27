import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { ContextMenu } from 'primereact/contextmenu';
import { Toast } from 'primereact/toast';
import type { MenuItem, MenuItemOptions } from 'primereact/menuitem';
import {
    VscClearAll,
    VscClippy,
    VscCopy,
    VscDiscard,
    VscListSelection,
    VscSaveAs,
    VscSearch,
    VscZoomIn,
    VscZoomOut,
} from 'react-icons/vsc';
import { readClipboard, writeClipboard } from '../../lib/clipboard';
import { errText } from '../../lib/errText';
import { themeColor } from '../../lib/themeColors';
import {
    needsPasteConfirm,
    normalisePaste,
    readScrollback,
    terminalKeyHandler,
} from '../../lib/terminalActions';
import {
    DEFAULT_TERMINAL_FONT_SIZE,
    useTerminalStore,
} from '../../stores/terminalStore';
import { useT } from '../../i18n/useT';
import { SaveText } from '../../../wailsjs/go/controller_app/App';
import PastePreviewDialog from './PastePreviewDialog';
import TerminalSearchBar from './TerminalSearchBar';

// Key names, not prose — these are what is printed on the user's keyboard and
// must not be translated.
const SHORTCUTS = {
    copy: 'Ctrl+C · Ctrl+Shift+C',
    paste: 'Ctrl+Shift+V',
    selectAll: 'Ctrl+Shift+A',
    clear: 'Ctrl+Shift+K',
    find: 'Ctrl+Shift+F',
    fontIncrease: 'Ctrl++',
    fontDecrease: 'Ctrl+-',
    fontReset: 'Ctrl+0',
} as const;

export interface TerminalActionsOptions {
    /** Raw bytes to the pty. */
    write: (data: string) => void;
    /** Re-fit and tell the backend the new cols/rows. Called after font changes. */
    resize: () => void;
    /** Filename stem offered by "Save output", e.g. `terminal-prod`. */
    saveName: string;
}

export interface TerminalActions {
    /**
     * Wires the live terminal in. Call once from the panel's own effect, right
     * after `term.open(...)`, and call the returned disposer from that same
     * effect's cleanup — pairing them inside one effect is what makes this
     * safe under StrictMode's create → destroy → create.
     */
    attach: (term: Terminal, fit: FitAddon) => () => void;
    /** Put on the terminal container: `onContextMenu={actions.onContextMenu}`. */
    onContextMenu: (e: React.MouseEvent) => void;
    /** Render once inside the panel root. */
    overlays: React.ReactNode;
}

/**
 * Selection, clipboard, shortcuts, right-click menu and find for an xterm panel.
 *
 * Shared by TerminalPanel and PodExecPanel, which differ only in which
 * WriteTo*Session they push bytes to — hence the `write` injection rather than
 * a session id. The API is imperative (attach/detach) on purpose: both panels
 * create their terminal inside an effect keyed on the session id, and anything
 * unstable added to those deps would tear down and recreate the pty on every
 * render.
 */
export function useTerminalActions(opts: TerminalActionsOptions): TerminalActions {
    const t = useT();
    const optsRef = useRef(opts);
    optsRef.current = opts;

    const termRef = useRef<Terminal | null>(null);
    const searchRef = useRef<SearchAddon | null>(null);
    const menuRef = useRef<ContextMenu>(null);
    const toastRef = useRef<Toast>(null);

    const [menuModel, setMenuModel] = useState<MenuItem[]>([]);
    const [pasteText, setPasteText] = useState<string | null>(null);
    const [searchOpen, setSearchOpen] = useState(false);

    const fontSize = useTerminalStore((s) => s.fontSize);
    const bumpFontSize = useTerminalStore((s) => s.bumpFontSize);
    const resetFontSize = useTerminalStore((s) => s.resetFontSize);

    // A font change alters the cell size, so the terminal has to refit and the
    // pty has to be told the new geometry — otherwise every line wraps wrong.
    useEffect(() => {
        const term = termRef.current;
        if (!term) return;
        term.options.fontSize = fontSize;
        optsRef.current.resize();
    }, [fontSize]);

    const toast = useCallback(
        (severity: 'success' | 'error' | 'warn', summary: string, detail?: string) => {
            toastRef.current?.show({ severity, summary, detail, life: 3000 });
        },
        [],
    );

    const focusTerm = useCallback(() => termRef.current?.focus(), []);

    const copySelection = useCallback(() => {
        const term = termRef.current;
        if (!term?.hasSelection()) return;
        const text = term.getSelection();
        void writeClipboard(text, focusTerm).then((ok) => {
            if (!ok) toast('error', t('panels:terminal.toast.copyFailed'));
        });
    }, [focusTerm, t, toast]);

    const copyAll = useCallback(() => {
        const term = termRef.current;
        if (!term) return;
        const text = readScrollback(term);
        if (!text) {
            toast('warn', t('panels:terminal.toast.nothingToCopy'));
            return;
        }
        void writeClipboard(text, focusTerm).then((ok) => {
            toast(
                ok ? 'success' : 'error',
                ok ? t('panels:terminal.toast.copied') : t('panels:terminal.toast.copyFailed'),
            );
        });
    }, [focusTerm, t, toast]);

    const saveOutput = useCallback(async () => {
        const term = termRef.current;
        if (!term) return;
        const text = readScrollback(term);
        if (!text) {
            toast('warn', t('panels:terminal.toast.nothingToCopy'));
            return;
        }
        try {
            const path = await SaveText(`${optsRef.current.saveName}.txt`, text);
            // "" is a cancelled dialog, not a failure — say nothing.
            if (path) toast('success', t('panels:terminal.toast.saved'), path);
        } catch (e) {
            toast('error', t('panels:terminal.toast.saveFailed'), errText(e));
        }
    }, [t, toast]);

    /** Sends text straight to the pty. Used by both dialog and direct paste. */
    const sendPaste = useCallback((text: string) => {
        if (!text) return;
        optsRef.current.write(normalisePaste(text));
    }, []);

    const requestPaste = useCallback(async () => {
        const text = await readClipboard();
        // null: unreadable — open the dialog empty so a native Ctrl+V into its
        // textarea can do the job with no clipboard permission at all.
        if (text === null) {
            setPasteText('');
            return;
        }
        if (text === '') return;
        if (needsPasteConfirm(text)) {
            setPasteText(text);
            return;
        }
        sendPaste(text);
    }, [sendPaste]);

    const closePaste = useCallback(() => {
        setPasteText(null);
        focusTerm();
    }, [focusTerm]);

    const confirmPaste = useCallback(
        (text: string) => {
            sendPaste(text);
            closePaste();
        },
        [closePaste, sendPaste],
    );

    // `incremental` is what makes type-ahead usable: without it every keystroke
    // starts a fresh search from the end of the current match, so typing
    // "world" walks forward through five different matches. With it the
    // selection only grows while it still matches what was typed.
    const find = useCallback((query: string, back: boolean, incremental = false) => {
        if (!query) {
            searchRef.current?.clearDecorations();
            return;
        }
        // Resolved per call rather than cached, so a theme switch is picked up
        // without reloading the addon. All four fields are required by
        // ISearchDecorationOptions; the ruler ones need opaque colours.
        const accent = themeColor('--blue') ?? '#6ea8e6';
        const amber = themeColor('--amber') ?? '#e2a85a';
        const options = {
            decorations: {
                matchBackground: accent,
                activeMatchBackground: amber,
                matchOverviewRuler: accent,
                activeMatchColorOverviewRuler: amber,
            },
        };
        if (back) searchRef.current?.findPrevious(query, { ...options });
        else searchRef.current?.findNext(query, { ...options, incremental });
    }, []);

    const closeSearch = useCallback(() => {
        searchRef.current?.clearDecorations();
        setSearchOpen(false);
        focusTerm();
    }, [focusTerm]);

    const attach = useCallback((term: Terminal, fit: FitAddon) => {
        termRef.current = term;

        const search = new SearchAddon();
        term.loadAddon(search);
        searchRef.current = search;

        term.options.fontSize = useTerminalStore.getState().fontSize;

        term.attachCustomKeyEventHandler(
            terminalKeyHandler({
                hasSelection: () => term.hasSelection(),
                copySelection: () => copySelection(),
                clearSelection: () => term.clearSelection(),
                requestPaste: () => void requestPaste(),
                selectAll: () => term.selectAll(),
                clearScreen: () => term.clear(),
                openSearch: () => setSearchOpen(true),
                fontDelta: (delta) => bumpFontSize(delta),
                fontReset: () => resetFontSize(),
            }),
        );

        fit.fit();

        return () => {
            search.dispose();
            // Identity-guarded, like the panels' own termRef cleanup: under
            // StrictMode the replacement terminal has already registered itself
            // by the time the first one tears down, and clearing by key would
            // strand it — leaving the menu pointing at a disposed Terminal,
            // whose hasSelection() throws.
            if (searchRef.current === search) searchRef.current = null;
            if (termRef.current === term) termRef.current = null;
        };
    }, [bumpFontSize, copySelection, requestPaste, resetFontSize]);

    const onContextMenu = useCallback(
        (e: React.MouseEvent) => {
            const term = termRef.current;
            if (!term) return;
            e.preventDefault();

            // Recomputed at show time: a selection changes without re-rendering
            // this component, so a model built during render would be stale.
            const hasSelection = term.hasSelection();
            const hasOutput = readScrollback(term) !== '';

            const item = (
                label: string,
                keys: string | null,
                icon: React.ReactNode,
                command: () => void,
                disabled = false,
            ): MenuItem => ({
                label,
                disabled,
                command,
                template: (it: MenuItem, o: MenuItemOptions) => (
                    <a
                        className={o.className}
                        onClick={o.onClick}
                        role="menuitem"
                        aria-disabled={disabled}
                    >
                        {icon}
                        <span className="p-menuitem-text">{it.label}</span>
                        {keys && <span className="terminal-ctx-menu__key">{keys}</span>}
                    </a>
                ),
            });

            setMenuModel([
                item(t('panels:terminal.ctx.copy'), SHORTCUTS.copy, <VscCopy size={15} />,
                    copySelection, !hasSelection),
                item(t('panels:terminal.ctx.paste'), SHORTCUTS.paste, <VscClippy size={15} />,
                    () => void requestPaste()),
                { separator: true },
                item(t('panels:terminal.ctx.selectAll'), SHORTCUTS.selectAll,
                    <VscListSelection size={15} />, () => term.selectAll()),
                item(t('panels:terminal.ctx.clear'), SHORTCUTS.clear, <VscClearAll size={15} />,
                    () => term.clear()),
                item(t('panels:terminal.ctx.find'), SHORTCUTS.find, <VscSearch size={15} />,
                    () => setSearchOpen(true)),
                { separator: true },
                item(t('panels:terminal.ctx.copyAll'), null, <VscCopy size={15} />,
                    copyAll, !hasOutput),
                item(t('panels:terminal.ctx.saveOutput'), null, <VscSaveAs size={15} />,
                    () => void saveOutput(), !hasOutput),
                { separator: true },
                item(t('panels:terminal.ctx.fontIncrease'), SHORTCUTS.fontIncrease,
                    <VscZoomIn size={15} />, () => bumpFontSize(+1)),
                item(t('panels:terminal.ctx.fontDecrease'), SHORTCUTS.fontDecrease,
                    <VscZoomOut size={15} />, () => bumpFontSize(-1)),
                item(t('panels:terminal.ctx.fontReset'), SHORTCUTS.fontReset,
                    <VscDiscard size={15} />, resetFontSize,
                    fontSize === DEFAULT_TERMINAL_FONT_SIZE),
            ]);
            menuRef.current?.show(e);
        },
        [bumpFontSize, copyAll, copySelection, fontSize, requestPaste, resetFontSize, saveOutput, t],
    );

    const overlays = (
        <>
            <ContextMenu
                ref={menuRef}
                model={menuModel}
                className="terminal-ctx-menu"
                // The terminal containers are overflow:hidden, so an inline
                // popup would be clipped — the same reason ResourceListView's
                // row menu appends to the body.
                appendTo={document.body}
                onHide={focusTerm}
            />
            {searchOpen && <TerminalSearchBar onFind={find} onClose={closeSearch} />}
            <PastePreviewDialog text={pasteText} onCancel={closePaste} onPaste={confirmPaste} />
            <Toast ref={toastRef} position="bottom-right" />
        </>
    );

    return { attach, onContextMenu, overlays };
}
