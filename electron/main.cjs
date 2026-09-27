// Electron shell for Kube Inspector.
//
// The Go binary is the application; this process only supplies a Chromium
// window and the few things a web page cannot do itself. It spawns the binary
// with --serve, which starts the same controller Wails drives (see
// internal/controller/rpcserver.go), then loads the URL it prints.
//
// Nothing here is Kubernetes-aware. Adding a backend feature does not touch
// this file.

const electron = require('electron');

// With ELECTRON_RUN_AS_NODE set, require('electron') returns a path string
// instead of the API, and every destructured name below would be undefined —
// surfacing much later as "Cannot read properties of undefined". Some editors
// (VS Code's integrated terminal) export it, so say what is wrong up front.
if (typeof electron === 'string') {
  console.error(
    'ELECTRON_RUN_AS_NODE is set, so Electron started as plain Node.\n' +
      'Run with: env -u ELECTRON_RUN_AS_NODE npm start',
  );
  process.exit(1);
}

const { app, BrowserWindow, dialog, shell, ipcMain, protocol, net, screen, Menu, clipboard } =
  electron;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const logfile = require('./logfile.cjs');

const isWindows = process.platform === 'win32';

// The page is served under this fixed origin rather than the sidecar's
// http://127.0.0.1:<port>. The sidecar binds an ephemeral port (it must: a fixed
// one would clash between instances), and localStorage/IndexedDB/cookies are
// keyed by origin — so loading the port URL directly meant every launch looked
// like a brand new site and all persisted UI state was silently lost.
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://kube-inspector`;

// Must be called before app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true, // gives it a real origin, which is the whole point
      secure: true, // counts as a secure context (needed by some web APIs)
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let sidecar = null;
let serverURL = null;
let shellToken = null;
let quitting = false;

// Every window in this process shares the one sidecar, so they are a single
// "instance" as far as internal/ipc is concerned. Moving a tab between them
// therefore never touches the hub — it is plain main->renderer IPC, addressed
// by the window id below. The hub is only involved when the target is another
// *process* (see TransferTab in FloatableTab.tsx).
const windows = new Map(); // windowId -> BrowserWindow
let nextWindowId = 1;

const PRIMARY_WINDOW_ID = 1;

// Set by electron/dev.cjs to the address of the Go server it already started
// (go run -tags kubeinsdev, pinned port). When present we attach to that one
// instead of spawning our own — otherwise dev would run two backends, and the
// renderer would be handed the wrong one's address.
const devRPC = process.env.KUBE_INS_DEV_RPC || '';

// Last lines of sidecar output, shown if it dies before we get a URL.
//
// This buffer is kept even though everything now also goes to disk: fatal()
// still needs something to put in the dialog when the log file itself is what
// could not be written.
const logTail = [];
const rememberLog = (stream, text) => {
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    logTail.push(`[${stream}] ${logfile.scrub(line)}`);
    if (logTail.length > 50) logTail.shift();
    if (!app.isPackaged) console.log(`[sidecar:${stream}]`, line);
    // The sidecar writes its own json_event records straight to the shared
    // file; under the dev stderr tee they also arrive here. Don't double-write.
    if (line.startsWith('{"@timestamp"')) continue;
    logfile.write(stream === 'err' ? 'WARN' : 'INFO', 'shell.sidecar', line, { stream });
  }
};

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

function resolveSidecar() {
  if (process.env.KUBE_INS_BIN) return process.env.KUBE_INS_BIN;
  const name = 'kube-inspector' + (isWindows ? '.exe' : '');
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', 'build', 'bin', name);
}

function startSidecar() {
  return new Promise((resolve, reject) => {
    const bin = resolveSidecar();
    logfile.info('shell.main', 'starting backend', { binary: bin });

    // stdin stays piped and open: closing it is how the Go side learns we died
    // even when we are SIGKILLed and no signal reaches it.
    sidecar = spawn(bin, ['--serve', '--shell-channel'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(
      () => reject(new Error('backend did not start within 30s')),
      30000,
    );

    let buf = '';
    sidecar.stdout.on('data', (chunk) => {
      rememberLog('out', chunk);
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);

        let m;
        if ((m = line.match(/kube-ins serving at (\S+)/))) serverURL = m[1];
        if ((m = line.match(/kube-ins shell token (\S+)/))) shellToken = m[1];
        if (serverURL && shellToken) {
          clearTimeout(timer);
          resolve();
        }
      }
    });

    sidecar.stderr.on('data', (chunk) => rememberLog('err', chunk));

    // Missing/unreadable binary — a broken package.
    sidecar.on('error', (err) => {
      clearTimeout(timer);
      logfile.error('shell.main', 'could not start the backend', {
        binary: bin,
        err: err.message,
      });
      reject(new Error(`could not start backend (${bin}): ${err.message}`));
    });

    sidecar.on('exit', (code, signal) => {
      clearTimeout(timer);
      logfile.write(quitting ? 'INFO' : 'ERROR', 'shell.main', 'backend exited', {
        code,
        signal,
        expected: quitting,
        hadURL: Boolean(serverURL),
      });
      if (quitting) return;
      const why = signal ? `signal ${signal}` : `code ${code}`;
      // Before the window exists this rejects startup; after, it is a crash.
      if (!serverURL) {
        reject(new Error(`backend exited early (${why})`));
      } else {
        fatal('Backend stopped', `The Kube Inspector backend exited (${why}).`);
      }
    });
  });
}

function stopSidecar() {
  if (!sidecar || sidecar.exitCode !== null) return Promise.resolve();

  const done = new Promise((resolve) => sidecar.once('exit', resolve));

  try {
    sidecar.stdin.end(); // orphan guard in main.go picks this up
  } catch {}

  if (isWindows) {
    // Windows has no process groups; taskkill takes the tree.
    spawn('taskkill', ['/pid', String(sidecar.pid), '/T', '/F']);
  } else {
    // SIGTERM unwinds serve(): srv.Close() drops WS clients so log/exec
    // goroutines finish instead of leaving a zombie holding a watch.
    sidecar.kill('SIGTERM');
  }

  const force = setTimeout(() => {
    try {
      sidecar.kill('SIGKILL');
    } catch {}
  }, 3000);

  return Promise.race([done, new Promise((r) => setTimeout(r, 4000))]).then(
    () => clearTimeout(force),
  );
}

function fatal(title, message) {
  logfile.error('shell.main', `${title}: ${message}`, { tail: logTail.slice(-20) });
  // logTail is already scrubbed on the way in, but the dialog is the one place
  // a token would be rendered on screen, so this stays explicit.
  dialog.showErrorBox(
    title,
    `${message}\n\n${logfile.scrub(logTail.slice(-20).join('\n'))}`,
  );
  quitting = true;
  stopSidecar().finally(() => app.exit(1));
}

// ---------------------------------------------------------------------------
// Shell channel: native dialogs requested by the Go side
// ---------------------------------------------------------------------------

// "PNG Image (*.png)" + "*.png;*.jpg" -> [{name, extensions:['png','jpg']}]
function toFilters(opts) {
  const exts = String(opts.Pattern || '')
    .split(';')
    .map((p) => p.trim().replace(/^\*\./, ''))
    .filter((e) => e && e !== '*');
  if (!exts.length) return [];
  return [{ name: opts.FilterName || 'File', extensions: exts }];
}

function connectShellChannel() {
  if (!serverURL || !shellToken) return;

  const host = new URL(serverURL).host;
  const ws = new WebSocket(
    `ws://${host}/shell?token=${encodeURIComponent(shellToken)}`,
  );
  let backoff = 250;

  ws.on('open', () => {
    backoff = 250;
  });

  ws.on('message', async (raw) => {
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    const reply = (body) => ws.send(JSON.stringify({ id: req.id, ...body }));

    try {
      switch (req.type) {
        case 'saveFile': {
          const opts = req.opts || {};
          // Parent it to whichever window the user is looking at; the Go side
          // has no notion of windows, so focus is the best signal we have.
          const parent =
            BrowserWindow.getFocusedWindow() ?? windows.get(PRIMARY_WINDOW_ID) ?? null;
          const { canceled, filePath } = await dialog.showSaveDialog(parent, {
            title: opts.Title || 'Save',
            defaultPath: opts.DefaultName || undefined,
            filters: toFilters(opts),
          });
          // Empty path means cancelled — same contract as Wails'
          // SaveFileDialog.
          reply({ path: canceled ? '' : filePath });
          break;
        }

        case 'openLogFolder': {
          // The directory is computed here and never received, so no string
          // from the Go side — let alone from the renderer — reaches the OS.
          const dir = logfile.dir();
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          // shell.openPath resolves to an error STRING rather than throwing.
          const problem = await shell.openPath(dir);
          reply({ error: problem || undefined });
          break;
        }

        case 'diagnostics': {
          reply({
            data: JSON.stringify({
              electron: process.versions.electron,
              chrome: process.versions.chrome,
              node: process.versions.node,
              platform: process.platform,
              arch: process.arch,
              packaged: app.isPackaged,
              locale: app.getLocale(),
              windows: windows.size,
              gpuFeatures: app.getGPUFeatureStatus(),
              logTail: logTail.slice(-50),
            }),
          });
          break;
        }

        default:
          // Answer, never drop. An older shell paired with a newer backend
          // would otherwise leave the Go caller waiting out the full timeout.
          reply({ error: `unsupported request type "${req.type}"` });
      }
    } catch (err) {
      reply({ error: String(err) });
    }
  });

  ws.on('close', () => {
    if (quitting) return;
    setTimeout(connectShellChannel, backoff);
    backoff = Math.min(backoff * 2, 5000);
  });

  ws.on('error', () => {}); // 'close' handles the retry
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

// Forwards every app:// request to the sidecar, so the page (and its /rpc
// calls) stay same-origin under a stable origin while the backend keeps its
// ephemeral port. The token injected into index.html rides along untouched.
function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, serverURL);

    // Forward only what the backend actually needs. Passing the renderer's own
    // headers through (Accept-Encoding, Range, Sec-Fetch-*) made Chromium
    // reject the proxied module scripts with net::ERR_UNEXPECTED, even though
    // a manual fetch() of the same URL succeeded.
    const headers = new Headers();
    for (const name of ['content-type', 'x-kube-ins-token']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const init = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }

    const upstream = await net.fetch(target.toString(), init);

    // Buffer rather than stream the response: everything here is local and
    // small, and handing back a fresh Response keeps any content-length or
    // encoding mismatch from reaching the renderer.
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type':
          upstream.headers.get('content-type') ?? 'application/octet-stream',
      },
    });
  });
}

// Places an undocked window near the cursor without letting it hang off the
// display it was dropped on.
function boundsNearCursor(width, height) {
  const point = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(v, hi)));
  return {
    x: clamp(point.x - Math.round(width / 3), area.x, area.x + area.width - width),
    y: clamp(point.y - 16, area.y, area.y + area.height - height),
  };
}

// `panel` is a SerializedPanel (internal/models/instanceModels.go) when this
// window is being undocked from an existing one; the renderer opens it instead
// of the default Overview tab.
function createWindow({ panel } = {}) {
  // Dev uses the Vite server directly (its origin is already stable).
  const target = process.env.KUBE_INS_DEV_URL || `${APP_ORIGIN}/`;

  const id = nextWindowId++;
  const width = 1024;
  const height = 768;

  // The renderer needs the sidecar's real address for the event WebSocket:
  // ws:// cannot travel through the app:// handler, so that one connection is
  // made directly and is therefore cross-origin.
  //
  // Not in dev: the page comes from Vite, whose dev server already proxies
  // /events (ws: true, changeOrigin) to the Go server. Passing the address
  // here would make wailsBridge.ts open the socket straight at the Go port
  // with Origin: http://localhost:5173, which originAllowed rejects.
  //
  // The window id and seed panel are unrelated to that, so they go through in
  // dev too — preload has no other way to learn which window it is in.
  const args = [`--kube-ins-window-id=${id}`];
  if (!devRPC) args.push(`--kube-ins-rpc-url=${serverURL}`);
  if (panel) {
    // Percent-encoded rather than base64: preload runs sandboxed, where there
    // is no Buffer to decode it with. This keeps the argument free of spaces
    // and quotes while staying unicode-safe.
    args.push(
      `--kube-ins-initial-panel=${encodeURIComponent(JSON.stringify(panel))}`,
    );
  }

  const win = new BrowserWindow({
    width,
    height,
    ...(panel ? boundsNearCursor(width, height) : {}),
    frame: false, // custom titlebar, see components/titlebar/TitleBar.tsx
    backgroundColor: '#060e20',
    show: false, // avoid a white flash before React mounts
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: args,
    },
  });

  windows.set(id, win);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    windows.delete(id);
  });

  // Keep the app pinned to its own origin; anything else opens in the browser.
  // Undocked windows are created through shell:undockPanel, not window.open,
  // so denying every popup stays correct.
  const allowedOrigin = new URL(target).origin;
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== allowedOrigin) {
      event.preventDefault();
      openExternal(url);
    }
  });

  // The default application menu is removed below, which takes its devtools and
  // reload accelerators with it. Devtools is the one worth keeping, so it is
  // re-added here deliberately rather than as a side effect of a menu nobody
  // can see. Ctrl+Shift+I is therefore off-limits to the terminal shortcut set.
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const devtools =
      input.key === 'F12' ||
      (input.control && input.shift && String(input.key).toUpperCase() === 'I');
    if (devtools) win.webContents.toggleDevTools();
  });

  // Real window state, so the titlebar's restore icon cannot desync from the
  // OS (snap, double-click, keyboard shortcuts).
  const pushMaximised = () =>
    win.isDestroyed() || win.webContents.send('kube-ins:maximised', win.isMaximized());
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, pushMaximised);
  }

  win.loadURL(target);
  return win;
}

function openExternal(url) {
  // Never hand an unvalidated renderer string to the OS.
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
  } catch {}
}

// Always act on the window the message came from. With more than one window a
// shared global would make the second window's titlebar drive the first.
const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);

ipcMain.on('shell:openURL', (_e, url) => openExternal(url));
ipcMain.on('shell:minimise', (e) => senderWindow(e)?.minimize());
ipcMain.on('shell:toggleMaximise', (e) => {
  const win = senderWindow(e);
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
// Wails' Quit binding, which every window's custom titlebar X routes to. With
// one window it ends the app, so that is what it used to call — but each
// undocked window has the same titlebar, and app.quit() took all of them down
// with it. Close only the sender; window-all-closed below quits once the last
// window is gone, so single-window behaviour is unchanged.
ipcMain.on('shell:quit', (e) => senderWindow(e)?.close());
ipcMain.handle('shell:isMaximised', (e) => senderWindow(e)?.isMaximized() ?? false);

// Read the OS clipboard in the main process. The renderer's
// navigator.clipboard.readText() goes through Chromium's permission + transient
// activation gates and rejects silently in a frameless window that is not
// focused; this path has neither gate. lib/clipboard.ts prefers it and falls
// back to the web API under Wails/browser.
ipcMain.handle('shell:readClipboard', () => clipboard.readText());

// --- Self-update restart -----------------------------------------------------
//
// Both are whole-app, not per-window: the updater has just replaced the files
// every window is running from. relaunch() re-execs process.execPath, which the
// package manager has already pointed at the new build, so this comes back up
// on the new version. quitApp is the other half — used when something else (the
// NSIS installer, or the macOS swap helper) starts the new version for us.
ipcMain.on('shell:relaunch', () => {
  app.relaunch();
  app.quit();
});
ipcMain.on('shell:quitApp', () => app.quit());

// --- Drag ghost outside the window -----------------------------------------
//
// Dockview's own drag ghost is a DOM node, so the window clips it and the tab
// appears to vanish the moment it is dragged out — exactly when the user needs
// the feedback most. This mirrors it with a real OS-level window.
//
// The cursor is polled here rather than fed in from the renderer: pointer
// delivery outside the window is not something to rely on, and main already
// knows every window's bounds, so it can decide on its own when the pointer
// has left the source window and the mirror should take over.

const GHOST_WIDTH = 220;
const GHOST_HEIGHT = 36;

// Matches dockview's own ghost offset (see createGhost in tab.js), so the
// mirror picks up exactly where the in-page one is clipped.
const GHOST_OFFSET_X = 30;
const GHOST_OFFSET_Y = -10;

// A drag that never reports its end (crashed renderer, closed window) must not
// leave a ghost pinned above every other window.
const GHOST_MAX_MS = 30000;

let dragGhost = null;
let dragGhostTimer = null;
// The window a cross-window drag is currently hovering, so we can tell it to
// clear its overlay when the cursor moves on or the drag ends.
let dragHoverWin = null;

function ghostMarkup() {
  // Inline everything: this is a data: URL with no origin to load from.
  return `<!doctype html><meta charset="utf-8"><style>
    html,body { margin:0; height:100%; background:transparent; overflow:hidden;
      -webkit-user-select:none; cursor:grabbing; }
    .tab { box-sizing:border-box; height:${GHOST_HEIGHT}px; max-width:${GHOST_WIDTH}px;
      display:flex; align-items:center; padding:0 12px; opacity:.85;
      font:13px/1 system-ui,-apple-system,'Segoe UI',sans-serif; color:#e7eaf0;
      background:#0c1017; border:1px solid #252e3f; border-top:1px solid #3fc8b4;
      border-radius:3px; box-shadow:0 4px 12px rgba(0,0,0,.4); }
    span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  </style><div class="tab"><span></span></div>
  <script>document.querySelector('span').textContent=decodeURIComponent(location.hash.slice(1))</script>`;
}

// Tell the currently-hovered window (if any) to drop its overlay.
function clearDragHover() {
  if (dragHoverWin && !dragHoverWin.isDestroyed()) {
    dragHoverWin.webContents.send('kube-ins:dragLeave');
  }
  dragHoverWin = null;
}

function stopDragGhost() {
  if (dragGhostTimer) {
    clearInterval(dragGhostTimer);
    dragGhostTimer = null;
  }
  if (dragGhost && !dragGhost.isDestroyed()) dragGhost.destroy();
  dragGhost = null;
  clearDragHover();
}

ipcMain.on('shell:dragGhostStart', (e, { title } = {}) => {
  stopDragGhost(); // a previous drag that never reported its end
  const source = senderWindow(e);
  if (!source) return;

  dragGhost = new BrowserWindow({
    width: GHOST_WIDTH,
    height: GHOST_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // taking focus mid-drag would cancel the drag
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  dragGhost.setIgnoreMouseEvents(true);
  // Title rides in the fragment so it is never parsed as markup.
  dragGhost.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(ghostMarkup())}#${encodeURIComponent(title ?? '')}`,
  );

  const startedAt = Date.now();
  dragGhostTimer = setInterval(() => {
    if (!dragGhost || dragGhost.isDestroyed() || source.isDestroyed()) return stopDragGhost();
    if (Date.now() - startedAt > GHOST_MAX_MS) return stopDragGhost();

    const point = screen.getCursorScreenPoint();
    const b = source.getContentBounds();
    const inside =
      point.x >= b.x && point.x < b.x + b.width &&
      point.y >= b.y && point.y < b.y + b.height;

    // Drive the drop overlay in whichever sibling window the cursor is over.
    // Inside the source, dockview's own overlay handles it, so target = none.
    const hit = inside ? null : windowUnderPoint(point, source);
    const hoverWin = hit ? hit[1] : null;
    if (hoverWin !== dragHoverWin) {
      clearDragHover();
      dragHoverWin = hoverWin;
    }
    if (hoverWin) {
      const hb = hoverWin.getContentBounds();
      hoverWin.webContents.send('kube-ins:dragHover', { x: point.x - hb.x, y: point.y - hb.y });
    }

    if (inside) {
      // Inside the source window dockview's own ghost is visible, so showing
      // both would double up.
      if (dragGhost.isVisible()) dragGhost.hide();
      return;
    }
    dragGhost.setPosition(point.x - GHOST_OFFSET_X, point.y - GHOST_OFFSET_Y);
    if (!dragGhost.isVisible()) dragGhost.showInactive();
  }, 16);
});

ipcMain.on('shell:dragGhostEnd', () => stopDragGhost());

// --- Tab undock / move between windows -------------------------------------

ipcMain.on('shell:undockPanel', (_e, { panel } = {}) => {
  if (panel) createWindow({ panel });
});

ipcMain.handle('shell:listWindows', (e) => {
  const self = senderWindow(e);
  return [...windows.entries()]
    .filter(([, w]) => w !== self && !w.isDestroyed())
    .map(([id, w]) => ({ id, title: w.getTitle() }));
});

// Topmost of our windows containing `point` (screen coords), excluding one.
// Later-created windows sit on top, so search in reverse insertion order.
function windowUnderPoint(point, exclude) {
  return (
    [...windows.entries()]
      .filter(([, w]) => w !== exclude && !w.isDestroyed() && !w.isMinimized())
      .reverse()
      .find(([, w]) => {
        const b = w.getContentBounds();
        return (
          point.x >= b.x && point.x < b.x + b.width &&
          point.y >= b.y && point.y < b.y + b.height
        );
      }) ?? null
  );
}

// Answers "which of my windows is under the mouse right now?".
//
// The cursor position is read here rather than taken from the renderer: the
// drag ends outside the source window, where client coordinates no longer map
// to anything, and screenX/screenY are unreliable across DPI scaling and
// Wayland.
ipcMain.handle('shell:windowAtCursor', (e) => {
  const hit = windowUnderPoint(screen.getCursorScreenPoint(), senderWindow(e));
  return hit ? hit[0] : null;
});

ipcMain.on('shell:sendPanel', (_e, { targetWindowId, panel } = {}) => {
  const target = windows.get(targetWindowId);
  if (!target || target.isDestroyed() || !panel) return;
  target.webContents.send('kube-ins:panel', panel);
  if (target.isMinimized()) target.restore();
  target.focus();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Deliberately NO requestSingleInstanceLock: running several instances and
// transferring tabs between them is a product feature (internal/ipc).

app.whenReady().then(async () => {
  // Electron installs a default application menu when none is set, and its role
  // accelerators are matched in the browser process before the keystroke ever
  // reaches the page. The window is frameless, so that menu is invisible *and*
  // harmful: Ctrl+C could not send SIGINT to a terminal, Ctrl+W closed the
  // window mid-command and Ctrl+R reloaded the whole app. macOS is different —
  // there the application menu *is* the system menubar, and dropping it takes
  // Cmd+Q, the app name and native field editing with it.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  logfile.setVersion(app.getVersion());
  logfile.info('shell.main', 'shell starting', {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    packaged: app.isPackaged,
    dev: Boolean(devRPC),
  });

  // A renderer or GPU process dying is the single most valuable line a
  // packaged crash can leave behind, and until now it left none at all.
  app.on('render-process-gone', (_e, _wc, details) => {
    logfile.error('shell.window', 'render process gone', details);
  });
  app.on('child-process-gone', (_e, details) => {
    logfile.error('shell.main', 'child process gone', details);
  });

  if (devRPC) {
    // dev.cjs owns the Go process; we only attach. The dev build skips the
    // token check (devShell in internal/controller/dev_on.go), so any non-empty
    // token gets the shell channel connected — SaveSnapshot's native dialog
    // then works in dev too. No app:// handler: the page is served by Vite.
    serverURL = devRPC;
    shellToken = 'dev';
  } else {
    try {
      await startSidecar();
    } catch (err) {
      fatal('Kube Inspector failed to start', err.message);
      return;
    }
    registerAppProtocol();
  }
  connectShellChannel();
  createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', (event) => {
  stopDragGhost(); // an always-on-top window would outlive the drag otherwise
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopSidecar().finally(() => app.exit(0));
});

// Belt and braces for the paths before-quit never sees.
process.on('exit', () => {
  if (sidecar && sidecar.exitCode === null) sidecar.kill('SIGKILL');
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    quitting = true;
    stopSidecar().finally(() => app.exit(0));
  });
}
