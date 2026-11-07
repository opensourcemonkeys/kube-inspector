// The one-shot request a window carries after its renderer crashed and the
// Electron shell reloaded it (electron/crashRecovery.cjs, "Reload and open
// Diagnostics"). The shell can only ask through the URL — the page that would
// receive an IPC message is the one that died — so the marker is a query
// parameter, read once and removed, so that a later manual reload does not
// open Diagnostics again. Keep AFTER_CRASH_PARAM in step with the shell's.
export const AFTER_CRASH_PARAM = 'after-crash';

export function takeAfterCrashAction(): string | null {
    const url = new URL(window.location.href);
    const action = url.searchParams.get(AFTER_CRASH_PARAM);
    if (action === null) return null;
    url.searchParams.delete(AFTER_CRASH_PARAM);
    window.history.replaceState(window.history.state, '', url.toString());
    return action;
}
