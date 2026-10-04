import { DetachTerminalSession, DetachPodExecSession } from '../../wailsjs/go/controller_app/App';
import type { PanelPayload } from './shellWindows';

/**
 * Moving a terminal, pod exec or node shell tab between windows of this process.
 *
 * A moved panel is re-created on the other side, and closing the original
 * normally ends its session. But every window of one Electron process talks to
 * the same Go sidecar, so the session does not have to move at all: the source
 * detaches it (the backend keeps it alive for a grace period), the panel
 * arrives with `handoff: true`, and the new panel attaches to the same session
 * id instead of opening one — replaying the backend's copy of the output so
 * the tab keeps its history.
 *
 * Another *instance* is a different process with a different backend, so these
 * panels can never go there; FloatableTab only offers windows for them.
 */

// Pod exec and node shell share one backend registry, so one pair covers both.
const DETACH: Record<string, (sessionId: string) => Promise<void>> = {
    terminal: DetachTerminalSession,
    podExec: DetachPodExecSession,
    nodeShell: DetachPodExecSession,
};

/** Panels that may move between windows but never to another instance. */
export const isWindowOnly = (componentType: string) => componentType in DETACH;

// Session ids whose panel is being closed because it moved, not because the
// user closed it. The panel's cleanup checks this before ending the session.
const handedOff = new Set<string>();

/**
 * Prepare a serialized panel for a move to another window. Must run before the
 * panel is sent: detaching after the send could land after the receiving
 * window has already attached, which would restart the grace timer on a
 * session that is in use. Other panels pass through as-is.
 */
export async function prepareWindowHandoff(panel: PanelPayload): Promise<PanelPayload> {
    const detach = DETACH[panel.componentType];
    const sessionId: string | undefined = panel.params?.sessionId;
    if (!detach || !sessionId) return panel;

    // Only a session the backend agreed to hold is left running. One that is
    // already gone — or not registered yet — is closed by the source as usual,
    // so nothing can come up afterwards with no panel and no grace timer; the
    // receiving panel then reports that there was nothing to attach to.
    try {
        await detach(sessionId);
        handedOff.add(sessionId);
    } catch {
        /* closed normally by the source panel's cleanup */
    }
    return { ...panel, params: { ...panel.params, handoff: true } };
}

/** True (once) when this session's panel is closing because it moved. */
export function consumeHandoff(sessionId: string): boolean {
    return handedOff.delete(sessionId);
}

export interface SessionSnapshot {
    data: string;
    offset: number;
}

/**
 * Orders a panel's output around an attach. Every streamed chunk carries the
 * stream offset it ends at, and a snapshot the offset it ends at, so chunks
 * that arrive while the snapshot is in flight are held, then written only if
 * they go past it — nothing lost, nothing printed twice. A panel that is not
 * attaching writes straight through.
 */
export function createOutputGate(write: (data: string) => void, attaching: boolean) {
    let replayedTo = -1;
    let pending: [string, number | undefined][] | null = attaching ? [] : null;

    return {
        /** Feed every streamed chunk through this. */
        onOutput(data: string, end?: number) {
            if (pending) { pending.push([data, end]); return; }
            if (end !== undefined && end <= replayedTo) return;
            write(data);
        },
        /** Write the snapshot (null when the attach failed), then the held chunks past it. */
        replay(snapshot: SessionSnapshot | null) {
            if (!pending) return;
            if (snapshot) {
                write(snapshot.data);
                replayedTo = snapshot.offset;
            }
            for (const [data, end] of pending) {
                if (end === undefined || end > replayedTo) write(data);
            }
            pending = null;
        },
    };
}
