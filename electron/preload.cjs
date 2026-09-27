// Fills in the shell hook that frontend/src/lib/wailsBridge.ts already reads:
//
//   const shell = window.__KUBE_INS_SHELL__ ?? {}
//   BrowserOpenURL: shell.openURL ?? ...
//   WindowMinimise: shell.minimise ?? noop
//   ...
//
// Preload runs before any page script, so the bridge sees these and TitleBar
// works unmodified. Nothing else is exposed — contextIsolation and sandbox stay
// on, and the renderer never gets Node.

const { contextBridge, ipcRenderer } = require('electron');

// The page is served from the stable app:// origin, but the event WebSocket has
// to reach the sidecar's real ephemeral port directly (ws:// cannot go through
// a custom protocol handler). main.cjs passes it in via additionalArguments.
const argOf = (prefix) => {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
};

// Sandboxed preload: no Buffer here, so main.cjs percent-encodes the panel.
const decodePanel = (encoded) => {
  if (!encoded) return undefined;
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    return undefined;
  }
};

contextBridge.exposeInMainWorld('__KUBE_INS_SHELL__', {
  rpcUrl: argOf('--kube-ins-rpc-url='),

  openURL: (url) => ipcRenderer.send('shell:openURL', url),
  minimise: () => ipcRenderer.send('shell:minimise'),
  toggleMaximise: () => ipcRenderer.send('shell:toggleMaximise'),
  quit: () => ipcRenderer.send('shell:quit'),

  // Whole-app restart for the in-app updater. `relaunch` comes back up on the
  // new build; `quitApp` is for the platforms where the installer restarts us.
  relaunch: () => ipcRenderer.send('shell:relaunch'),
  quitApp: () => ipcRenderer.send('shell:quitApp'),

  // Clipboard read, done in the main process. The renderer's own
  // navigator.clipboard.readText() is gated on a permission prompt and on
  // transient activation, and rejects silently in a frameless unfocused window.
  readClipboard: () => ipcRenderer.invoke('shell:readClipboard'),

  // Real window state, so the titlebar icon tracks OS-initiated changes.
  isMaximised: () => ipcRenderer.invoke('shell:isMaximised'),
  onMaximised: (cb) => {
    const handler = (_event, value) => cb(value);
    ipcRenderer.on('kube-ins:maximised', handler);
    return () => ipcRenderer.removeListener('kube-ins:maximised', handler);
  },

  // --- Tab undock / move between windows ---
  //
  // Windows of this process share one sidecar and therefore one hub instance
  // id, so panels move between them over this channel rather than TransferTab.

  // 1 is the window the app started with. It is the only one that acts on
  // `tab:received`, because the Go side broadcasts events to every /events
  // client and would otherwise open a transferred tab in each window at once.
  windowId: Number(argOf('--kube-ins-window-id=') ?? 1),

  // Set on a window created by dragging a tab out: opened instead of Overview.
  initialPanel: decodePanel(argOf('--kube-ins-initial-panel=')),

  // An OS-level mirror of the drag ghost, so a tab dragged past the window
  // edge stays visible. Main tracks the cursor and shows it only outside.
  startDragGhost: (title) => ipcRenderer.send('shell:dragGhostStart', { title }),
  endDragGhost: () => ipcRenderer.send('shell:dragGhostEnd'),

  // Cursor position of a cross-window drag hovering THIS window, forwarded by
  // main (the window a drag started in captures all its own pointer events, so
  // the target window can't see them). Drives the drop overlay.
  onDragHover: (cb) => {
    const handler = (_event, p) => cb(p.x, p.y);
    ipcRenderer.on('kube-ins:dragHover', handler);
    return () => ipcRenderer.removeListener('kube-ins:dragHover', handler);
  },
  onDragLeave: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('kube-ins:dragLeave', handler);
    return () => ipcRenderer.removeListener('kube-ins:dragLeave', handler);
  },

  undockPanel: (panel) => ipcRenderer.send('shell:undockPanel', { panel }),
  listWindows: () => ipcRenderer.invoke('shell:listWindows'),
  windowAtCursor: () => ipcRenderer.invoke('shell:windowAtCursor'),
  sendPanel: (targetWindowId, panel) =>
    ipcRenderer.send('shell:sendPanel', { targetWindowId, panel }),
  onPanel: (cb) => {
    const handler = (_event, panel) => cb(panel);
    ipcRenderer.on('kube-ins:panel', handler);
    return () => ipcRenderer.removeListener('kube-ins:panel', handler);
  },
});

// Marks the document so the titlebar drag rules apply only under Electron.
// See the -webkit-app-region block in theme-monolith.css.
document.addEventListener('DOMContentLoaded', () =>
  document.documentElement.classList.add('electron-shell'),
);
