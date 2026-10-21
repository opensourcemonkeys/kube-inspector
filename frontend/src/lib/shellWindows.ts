/**
 * Multi-window support from the Electron shell (see electron/preload.cjs).
 *
 * Every window in one Electron process shares a single Go sidecar, and so a
 * single hub instance id (internal/ipc). Windows are therefore invisible to the
 * Go side: moving a panel between them goes over these IPC channels, while
 * moving it to another *process* still goes through TransferTab.
 *
 * Everything here degrades to a no-op under Wails or a plain browser tab, where
 * there is only ever one window.
 */

/** Mirrors models.SerializedPanel — the wire format both transfer paths use. */
export interface PanelPayload {
    componentType: string;
    title: string;
    params: Record<string, any>;
}

/**
 * Resolved colours for the OS-level drag ghost. Its page is a data: URL that
 * cannot see our stylesheet, so without these it would paint a fixed palette
 * whatever theme is active.
 */
export interface DragGhostStyle {
    background: string;
    color: string;
    accent: string;
    line: string;
    radius: string;
    font: string;
    weight: string;
}

export interface ShellWindow {
    id: number;
    title: string;
}

interface ShellApi {
    windowId?: number;
    initialPanel?: PanelPayload;
    startDragGhost?: (title: string, style?: DragGhostStyle) => void;
    endDragGhost?: () => void;
    onDragHover?: (cb: (x: number, y: number) => void) => () => void;
    onDragLeave?: (cb: () => void) => () => void;
    undockPanel?: (panel: PanelPayload) => void;
    listWindows?: () => Promise<ShellWindow[]>;
    windowAtCursor?: () => Promise<number | null>;
    sendPanel?: (targetWindowId: number, panel: PanelPayload) => void;
    onPanel?: (cb: (panel: PanelPayload) => void) => () => void;
    relaunch?: () => void;
    quitApp?: () => void;
}

const shell = (): ShellApi => (window as any).__KUBE_INS_SHELL__ ?? {};

/** True when the shell can open more than one window. */
export const supportsWindows = () => typeof shell().undockPanel === 'function';

export const windowId = () => shell().windowId ?? 1;

/**
 * The window the app started with. Only it reacts to `tab:received`: the Go
 * server broadcasts events to every /events client, so without this guard a
 * panel transferred from another process would open in all windows at once.
 */
export const isPrimaryWindow = () => windowId() === 1;

/** Set when this window was created by dragging a tab out of another one. */
export const initialPanel = () => shell().initialPanel;

/**
 * Mirror the tab being dragged in an OS-level window, so it stays visible once
 * the pointer leaves this one — the in-page ghost is clipped at the edge.
 * Main polls the cursor and reveals it only outside; always pair with
 * `endDragGhost`.
 */
export const startDragGhost = (title: string, style?: DragGhostStyle) =>
    shell().startDragGhost?.(title, style);

export const endDragGhost = () => shell().endDragGhost?.();

/**
 * A tab from another window is being dragged over this one; the callback fires
 * with the cursor's client coords (window-relative) as it moves. Used to drive
 * dockview's drop overlay via `crossWindowDrop`. Returns an unsubscribe fn.
 */
export const onDragHover = (cb: (x: number, y: number) => void) =>
    shell().onDragHover?.(cb);

/** The cross-window drag left this window. Returns an unsubscribe fn. */
export const onDragLeave = (cb: () => void) => shell().onDragLeave?.(cb);

export const undockPanel = (panel: PanelPayload) => shell().undockPanel?.(panel);

export const sendPanelToWindow = (targetWindowId: number, panel: PanelPayload) =>
    shell().sendPanel?.(targetWindowId, panel);

export async function listWindows(): Promise<ShellWindow[]> {
    try {
        return (await shell().listWindows?.()) ?? [];
    } catch {
        return [];
    }
}

/**
 * Which sibling window is under the mouse pointer right now, if any.
 *
 * The cursor is read in the main process rather than passed in from here: a tab
 * drag ends outside the source window, where client coordinates mean nothing,
 * and screenX/screenY are unreliable across DPI scaling and Wayland.
 */
export async function windowAtCursor(): Promise<number | null> {
    try {
        return (await shell().windowAtCursor?.()) ?? null;
    } catch {
        return null;
    }
}

/** Panels pushed here from a sibling window. Returns an unsubscribe function. */
export const onPanelFromWindow = (cb: (panel: PanelPayload) => void) =>
    shell().onPanel?.(cb);

/**
 * Whole-app restart, used by the in-app updater once the new version is in
 * place. `relaunchApp` re-execs the (now updated) binary; `quitApp` only closes,
 * for the platforms where the installer brings the new version up itself.
 *
 * Only the Electron shell can do this — under Wails or a browser tab the
 * updater never gets this far, because the backend reports Installable=false.
 */
export const supportsSelfRestart = () => typeof shell().relaunch === 'function';

export const relaunchApp = () => shell().relaunch?.();

export const quitApp = () => shell().quitApp?.();
