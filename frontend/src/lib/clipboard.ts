// Clipboard helpers.
//
// navigator.clipboard.writeText can be unavailable or silently blocked in the
// WebKitGTK webview Wails uses, so every copy falls back to the old
// hidden-textarea + execCommand trick. Extracted from CliModeOverlay so the
// three copy buttons in the Diagnostics panel cannot quietly reintroduce a bare
// navigator.clipboard call that works in Electron and fails under Wails.

function execCopy(text: string): boolean {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch {
        ok = false;
    }
    document.body.removeChild(ta);
    return ok;
}

/**
 * Copies text to the clipboard, falling back when the async API is unavailable.
 * Resolves to whether the copy is believed to have succeeded, so callers can
 * choose between a success and an error toast.
 *
 * onDone runs after the fallback path, for callers that need to restore focus
 * (an xterm instance, say) once the hidden textarea is gone.
 */
export async function writeClipboard(text: string, onDone?: () => void): Promise<boolean> {
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            /* blocked: fall through */
        }
    }
    const ok = execCopy(text);
    onDone?.();
    return ok;
}

/**
 * Reads the clipboard, preferring the native shell over the web API.
 *
 * The distinction between "" and null is load-bearing for callers: "" means the
 * clipboard is empty and there is nothing to do, null means it could not be
 * read at all and the caller should fall back to asking the user (a textarea
 * they can press Ctrl+V into needs no permission and always works).
 *
 * The Electron branch reads in the main process, which has neither Chromium's
 * clipboard-read permission gate nor its transient-activation requirement —
 * both of which reject silently in a frameless window that is not focused.
 * Under Wails (WebKitGTK) readText is generally unavailable, so that path
 * usually ends at null by design.
 */
export async function readClipboard(): Promise<string | null> {
    const shell = (window as any).__KUBE_INS_SHELL__;
    if (typeof shell?.readClipboard === 'function') {
        try {
            return (await shell.readClipboard()) ?? '';
        } catch {
            /* fall through to the web API */
        }
    }
    if (navigator.clipboard?.readText) {
        try {
            return await navigator.clipboard.readText();
        } catch {
            /* blocked */
        }
    }
    return null;
}
