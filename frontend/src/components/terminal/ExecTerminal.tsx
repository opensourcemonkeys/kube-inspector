import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useXtermTheme, xtermOptions } from '../../lib/xtermTheme';
import { EventsOn } from '../../../wailsjs/runtime/runtime';
import { WriteToPodExecSession, ResizePodExecSession } from '../../../wailsjs/go/controller_app/App';
import { useTerminalActions } from './useTerminalActions';

export interface ExecTerminalProps {
    /** Registry key on the backend. Every event and write is scoped to it. */
    sessionId: string;
    /** Written to the terminal before `connect` runs, so the tab is never blank. */
    banner: string;
    /** Opens the backend session. Rejections are printed into the terminal. */
    connect: () => Promise<unknown>;
    /** Tears it down again on unmount. */
    close: () => Promise<unknown>;
    /** Base filename offered when the user saves the buffer. */
    saveName: string;
}

/**
 * An xterm panel bound to a backend exec session.
 *
 * Shared by PodExecPanel and NodeShellPanel because a node shell *is* an exec
 * session once its helper pod is up: both live in the same backend registry, so
 * both push bytes through WriteToPodExecSession and both listen on
 * `exec:output:${id}` / `exec:closed:${id}`. Only opening and closing the
 * session differ, hence the `connect`/`close` injection.
 */
export default function ExecTerminal({ sessionId, banner, connect, close, saveName }: ExecTerminalProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    // Held so a theme switch can repaint the live terminal — see useXtermTheme.
    const termRef = useRef<Terminal | null>(null);
    useXtermTheme(termRef);

    const fitRef = useRef<FitAddon | null>(null);
    const actions = useTerminalActions({
        write: (data) => WriteToPodExecSession(sessionId, data).catch(() => {}),
        resize: () => {
            const term = termRef.current;
            if (!term || !fitRef.current) return;
            fitRef.current.fit();
            ResizePodExecSession(sessionId, term.cols, term.rows).catch(() => {});
        },
        saveName,
    });
    // Read through refs so the session effect stays keyed on the session only:
    // anything unstable in its deps would tear down and reopen the shell on
    // every render.
    const actionsRef = useRef(actions);
    actionsRef.current = actions;
    const lifecycleRef = useRef({ banner, connect, close });
    lifecycleRef.current = { banner, connect, close };

    useEffect(() => {
        if (!containerRef.current) return;

        const term = new Terminal(xtermOptions());

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitRef.current = fitAddon;
        termRef.current = term;
        term.open(containerRef.current);

        const detachActions = actionsRef.current.attach(term, fitAddon);

        const fitTimer = setTimeout(() => {
            fitAddon.fit();
            ResizePodExecSession(sessionId, term.cols, term.rows).catch(() => {});
        }, 50);

        term.write(`${lifecycleRef.current.banner}\r\n`);

        // Opening the session is deferred by one macrotask, and torn down only
        // if it actually started. StrictMode mounts, unmounts and remounts this
        // effect in one go, and every mount shares the panel's session id — so a
        // connect fired synchronously means the discarded mount opens a backend
        // session whose progress output then lands in the surviving terminal.
        // For a node shell that also meant creating a privileged pod just to
        // cancel it. Deferring lets the discarded mount's timer be cleared
        // before it ever reaches the backend.
        let started = false;
        const startTimer = setTimeout(() => {
            started = true;
            lifecycleRef.current.connect().catch((err: unknown) => {
                term.write(`\r\nFailed to connect: ${err}\r\n`);
            });
        }, 0);

        const offOutput = EventsOn(`exec:output:${sessionId}`, (data: string) => {
            term.write(data);
        });

        // The backend fires this when the session ends on its own — the remote
        // shell exiting, the pod going away, the stream breaking. Without it the
        // panel just stopped responding, which is indistinguishable from a hang.
        let closed = false;
        const offClosed = EventsOn(`exec:closed:${sessionId}`, () => {
            if (closed) return;
            closed = true;
            term.write('\r\n[session closed]\r\n');
            term.options.cursorBlink = false;
        });

        const onData = term.onData((data) => {
            if (closed) return;
            WriteToPodExecSession(sessionId, data).catch(() => {});
        });

        const observer = new ResizeObserver(() => {
            fitAddon.fit();
            ResizePodExecSession(sessionId, term.cols, term.rows).catch(() => {});
        });
        observer.observe(containerRef.current);

        return () => {
            clearTimeout(fitTimer);
            offOutput();
            offClosed();
            onData.dispose();
            observer.disconnect();
            detachActions();
            clearTimeout(startTimer);
            if (started) lifecycleRef.current.close().catch(() => {});
            if (fitRef.current === fitAddon) fitRef.current = null;
            if (termRef.current === term) termRef.current = null;
            term.dispose();
        };
    }, [sessionId]);

    return (
        // The wrapper exists so the find bar has a positioned ancestor; the
        // terminal element itself is unchanged.
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            <div
                ref={containerRef}
                onContextMenu={actions.onContextMenu}
                style={{
                    width: '100%',
                    height: '100%',
                    padding: '4px',
                    boxSizing: 'border-box',
                    background: 'var(--panel2)',
                    overflow: 'hidden',
                }}
            />
            {actions.overlays}
        </div>
    );
}
