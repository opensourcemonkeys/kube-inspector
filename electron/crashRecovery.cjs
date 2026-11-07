// What to do when a window's page process (its renderer) dies.
//
// Until 1.0 a crashed renderer was only logged and its window stayed blank,
// with no way back but closing it. The backend is a separate process and
// survives a renderer crash — port forwards, scans and other windows are
// unaffected — so the window can simply load again. This offers that, plus a
// reload straight into Diagnostics, where the crash line is in the log.
//
// Plain functions with Electron injected, so `node --test` covers them without
// a display (crashRecovery.test.cjs). English only, like the shell's other
// native dialogs (main.cjs fatal()): the main process has no i18n.

// The one-shot marker the frontend reads and strips on load
// (frontend/src/lib/afterCrash.ts). Keep the two in step.
const AFTER_CRASH_PARAM = 'after-crash';

const BUTTONS = ['Reload', 'Reload and open Diagnostics', 'Close window'];

// A renderer exits cleanly whenever its window closes or the app quits; only
// an unexpected end (crashed, killed, oom, ...) deserves a dialog.
function shouldOffer(details, quitting) {
  return !quitting && Boolean(details) && details.reason !== 'clean-exit';
}

// The page to load for "Reload and open Diagnostics": the same URL, so dev
// (Vite) and packaged (app://) both work, with the marker set.
function diagnosticsURL(currentURL) {
  const u = new URL(currentURL);
  u.searchParams.set(AFTER_CRASH_PARAM, 'diagnostics');
  return u.toString();
}

// Asks, then acts on the window. Resolves to what was done, for the log.
async function offerRecovery({ win, details, showMessageBox }) {
  const { response } = await showMessageBox(win, {
    type: 'error',
    title: 'Kube Inspector',
    message: 'This window stopped unexpectedly.',
    detail:
      `Its page process ended (${details.reason}, exit code ${details.exitCode}). ` +
      'The backend is still running, so port forwards, scans and other windows are not affected. ' +
      'The details are in the log file.',
    buttons: BUTTONS,
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (win.isDestroyed()) return 'gone';
  switch (response) {
    case 0:
      win.webContents.reload();
      return 'reload';
    case 1:
      win.loadURL(diagnosticsURL(win.webContents.getURL()));
      return 'diagnostics';
    default:
      win.close();
      return 'close';
  }
}

module.exports = { AFTER_CRASH_PARAM, BUTTONS, shouldOffer, diagnosticsURL, offerRecovery };
