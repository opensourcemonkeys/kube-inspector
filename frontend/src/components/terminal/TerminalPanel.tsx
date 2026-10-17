import { useEffect, useRef, useState } from 'react';
import { IDockviewPanelProps } from 'dockview';
import { Terminal } from '@xterm/xterm';
import { useXtermTheme, xtermOptions } from '../../lib/xtermTheme';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Dropdown } from 'primereact/dropdown';
import { VscTerminal } from 'react-icons/vsc';
import { EventsOn } from '../../../wailsjs/runtime/runtime';
import {
    CreateTerminalSession,
    SetTerminalSessionCluster,
    WriteToTerminalSession,
    ResizeTerminalSession,
    CloseTerminalSession,
    AttachTerminalSession,
    GetAvailableShells,
} from '../../../wailsjs/go/controller_app/App';
import { models } from '../../../wailsjs/go/models';
import { consumeHandoff, createOutputGate } from '../../lib/terminalHandoff';
import { useClusterContext } from '../../contexts/ClusterContext';
import { useTerminalActions } from './useTerminalActions';
import { renderPanelTitle } from '../../contexts/TabContext';
import { useT } from '../../i18n/useT';

export interface TerminalPanelParams {
    sessionId: string;
    clusterName?: string;
    titleKey?: string;
    titleVars?: Record<string, string | number | undefined>;
    /** Moved here from another window: attach to the running shell instead of starting one. */
    handoff?: boolean;
    /** Shell ID from GetAvailableShells; empty means the platform default. */
    shell?: string;
}

// The installed shells belong to the process, not to a panel, so every
// terminal shares one lookup. A failed lookup is not cached.
let shellsPromise: Promise<models.ShellInfo[]> | null = null;
function loadShells(): Promise<models.ShellInfo[]> {
    if (!shellsPromise) {
        shellsPromise = GetAvailableShells()
            .then((list) => list ?? [])
            .catch(() => {
                shellsPromise = null;
                return [];
            });
    }
    return shellsPromise;
}

// The last shell picked, so the next terminal opens in it. Only a default: the
// backend falls back to the platform default for an ID it does not know.
const SHELL_KEY = 'kube-ins-terminal-shell';
function readStoredShell(): string {
    try { return localStorage.getItem(SHELL_KEY) ?? ''; } catch { return ''; }
}
function storeShell(id: string) {
    try { localStorage.setItem(SHELL_KEY, id); } catch { /* storage unavailable */ }
}

export default function TerminalPanel({ api, params }: IDockviewPanelProps<TerminalPanelParams>) {
    const t = useT();
    const { sessionId } = params;
    const containerRef = useRef<HTMLDivElement>(null);
    // Held so a theme switch can repaint the live terminal — see useXtermTheme.
    const termRef = useRef<Terminal | null>(null);
    useXtermTheme(termRef);

    const { clusters, activeCluster } = useClusterContext();
    // Same contract as the apply-yaml panel: the seeded cluster is only a
    // default, and the choice is mirrored back into params so the panel keeps
    // its target across a layout restore.
    const [cluster, setCluster] = useState(params.clusterName || activeCluster || '');
    // The session is created once per sessionId; reading the cluster through a
    // ref keeps it out of the effect's deps, so retargeting never restarts the
    // shell.
    const clusterRef = useRef(cluster);
    clusterRef.current = cluster;

    const [shells, setShells] = useState<models.ShellInfo[]>([]);
    const [shell, setShell] = useState(() => params.shell || readStoredShell());
    // Read by the session effect for the same reason as clusterRef.
    const shellRef = useRef(shell);
    shellRef.current = shell;
    // Set when the shell is gone (it exited, or a moved session could not be
    // found). A ref rather than an effect local so a shell switch can revive
    // the panel.
    const exitedRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        loadShells().then((list) => {
            if (cancelled) return;
            setShells(list);
            // An ID this machine does not have (a panel moved from another OS,
            // or an uninstalled shell) has already fallen back to the default
            // in the backend — show that.
            if (list.length && !list.some((s) => s.id === shellRef.current)) {
                setShell(list.find((s) => s.default)?.id ?? list[0].id);
            }
        });
        return () => { cancelled = true; };
    }, []);

    // Selection, clipboard, shortcuts, right-click menu and find. Shared with
    // PodExecPanel; the panel only supplies the three things that differ.
    const fitRef = useRef<FitAddon | null>(null);
    const actions = useTerminalActions({
        write: (data) => WriteToTerminalSession(sessionId, data).catch(() => {}),
        resize: () => {
            const term = termRef.current;
            if (!term || !fitRef.current) return;
            fitRef.current.fit();
            ResizeTerminalSession(sessionId, term.cols, term.rows).catch(() => {});
        },
        saveName: `terminal-${cluster || 'shell'}`,
    });
    // Read through a ref so the session effect below can stay keyed on
    // sessionId alone — anything unstable in its deps recreates the pty.
    const actionsRef = useRef(actions);
    actionsRef.current = actions;

    // A running shell cannot be swapped, so a switch starts a new one under
    // the same session id. No CloseTerminalSession first: Create replaces the
    // old session atomically, while a Close followed by a Create are two RPCs
    // that can arrive in either order — and a late Close kills the new shell.
    const handleShellChange = (next: string) => {
        if (!next || next === shell) return;
        setShell(next);
        shellRef.current = next;
        storeShell(next);
        api.updateParameters({ shell: next });

        const term = termRef.current;
        if (!term) return;
        exitedRef.current = false;
        term.reset();
        term.options.cursorBlink = xtermOptions().cursorBlink;
        CreateTerminalSession(sessionId, clusterRef.current, next)
            .then(() => ResizeTerminalSession(sessionId, term.cols, term.rows))
            .catch((err: unknown) => {
                term.write(`\r\nSession error: ${err}\r\n`);
            });
    };

    const handleClusterChange = (next: string) => {
        setCluster(next);
        SetTerminalSessionCluster(sessionId, next).catch(() => {});
        // Retitle through the panel's own i18n key rather than by splicing the
        // current title string: that keeps the title translatable after a
        // language switch (DockviewContainer re-renders it from these params).
        const titleVars = { ...(params.titleVars ?? {}), suffix: next || undefined };
        api.updateParameters({ clusterName: next, titleVars });
        api.setTitle(renderPanelTitle(t, { titleKey: params.titleKey, titleVars }));
    };

    useEffect(() => {
        if (!containerRef.current) return;

        const term = new Terminal(xtermOptions());

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitRef.current = fitAddon;
        termRef.current = term;
        term.open(containerRef.current);

        const detachActions = actionsRef.current.attach(term, fitAddon);

        // small delay so the DOM has settled before fitting
        const fitTimer = setTimeout(() => {
            fitAddon.fit();
            ResizeTerminalSession(sessionId, term.cols, term.rows).catch(() => {});
        }, 50);

        // Fired when the shell exits on its own (the user typing `exit`). The
        // pty is gone at that point, so keystrokes have nowhere to go.
        exitedRef.current = false;

        // A panel moved in from another window attaches to the shell that is
        // still running in the shared backend (lib/terminalHandoff.ts), and
        // the gate keeps the replayed history and the live stream in order.
        //
        // Deferred by one macrotask, like ExecTerminal's connect: StrictMode
        // and the drop placement (DockviewContainer.placeDrop) can mount and
        // discard this effect at once, and the discarded mount must neither
        // attach nor close a session the surviving one is about to take over.
        const attaching = !!params.handoff;
        const gate = createOutputGate((data) => term.write(data), attaching);
        let started = !attaching;
        const startTimer = attaching
            ? setTimeout(() => {
                started = true;
                AttachTerminalSession(sessionId)
                    .then((snap) => gate.replay(snap))
                    .catch(() => {
                        gate.replay(null);
                        exitedRef.current = true;
                        term.write('[session no longer available]\r\n');
                        term.options.cursorBlink = false;
                    });
            }, 0)
            : undefined;

        if (!attaching) {
            CreateTerminalSession(sessionId, clusterRef.current, shellRef.current)
                // The fit timer's resize can land before the session exists;
                // size it again once it does, or it keeps the pty's default size.
                .then(() => ResizeTerminalSession(sessionId, term.cols, term.rows))
                .catch((err: unknown) => {
                    term.write(`\r\nSession error: ${err}\r\n`);
                });
        }

        const offOutput = EventsOn(`terminal:output:${sessionId}`, gate.onOutput);

        const offExit = EventsOn(`terminal:exit:${sessionId}`, () => {
            if (exitedRef.current) return;
            exitedRef.current = true;
            term.write('\r\n[shell exited]\r\n');
            term.options.cursorBlink = false;
        });

        const onData = term.onData((data) => {
            if (exitedRef.current) return;
            WriteToTerminalSession(sessionId, data).catch(() => {});
        });

        const observer = new ResizeObserver(() => {
            fitAddon.fit();
            ResizeTerminalSession(sessionId, term.cols, term.rows).catch(() => {});
        });
        observer.observe(containerRef.current);

        return () => {
            clearTimeout(fitTimer);
            clearTimeout(startTimer);
            offOutput();
            offExit();
            onData.dispose();
            observer.disconnect();
            detachActions();
            // A panel closing because it moved to another window leaves the
            // shell to the panel that is taking it over there.
            if (!consumeHandoff(sessionId) && started) {
                CloseTerminalSession(sessionId).catch(() => {});
            }
            if (fitRef.current === fitAddon) fitRef.current = null;
            if (termRef.current === term) termRef.current = null;
            term.dispose();
        };
    }, [sessionId]);

    return (
        <div
            className="flex flex-column h-full"
            // relative: the find bar is absolutely positioned over the terminal.
            style={{ background: 'var(--panel2)', position: 'relative' }}
        >
            <div className="yaml-editor-toolbar flex align-items-center justify-content-between">
                <span className="yaml-editor-toolbar__label flex align-items-center gap-1">
                    <VscTerminal size={14} /> {t('panels:terminal.label')}
                </span>
                <div className="flex align-items-center gap-2">
                    {shells.length > 1 && (
                        <Dropdown
                            value={shell || null}
                            options={shells}
                            optionLabel="name"
                            optionValue="id"
                            onChange={(e) => handleShellChange(e.value ?? '')}
                            placeholder={t('panels:terminal.selectShell')}
                            className="yaml-editor-toolbar__cluster"
                            style={{ minWidth: '9rem' }}
                            aria-label={t('panels:terminal.shellAria')}
                        />
                    )}
                    <Dropdown
                        value={cluster || null}
                        options={clusters}
                        onChange={(e) => handleClusterChange(e.value ?? '')}
                        placeholder={t('panels:terminal.selectCluster')}
                        className="yaml-editor-toolbar__cluster"
                        style={{ minWidth: '11rem' }}
                        aria-label={t('panels:terminal.clusterAria')}
                    />
                </div>
            </div>

            <div
                ref={containerRef}
                onContextMenu={actions.onContextMenu}
                style={{
                    flex: 1,
                    minHeight: 0,
                    padding: '4px',
                    boxSizing: 'border-box',
                    overflow: 'hidden',
                }}
            />

            {actions.overlays}
        </div>
    );
}
