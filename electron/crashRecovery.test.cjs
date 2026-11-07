// node --test electron/*.test.cjs   (no Electron, no display; `npm test` in electron/)
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldOffer, diagnosticsURL, offerRecovery, AFTER_CRASH_PARAM } = require('./crashRecovery.cjs');

test('a clean exit or a quitting app gets no dialog; a crash does', () => {
  assert.equal(shouldOffer({ reason: 'clean-exit', exitCode: 0 }, false), false);
  assert.equal(shouldOffer({ reason: 'crashed', exitCode: 11 }, true), false);
  assert.equal(shouldOffer(undefined, false), false);
  for (const reason of ['crashed', 'killed', 'oom', 'abnormal-exit', 'launch-failed']) {
    assert.equal(shouldOffer({ reason, exitCode: 1 }, false), true, reason);
  }
});

test('the Diagnostics reload keeps the page and sets the marker the frontend reads', () => {
  assert.equal(diagnosticsURL('app://kube-inspector/'), `app://kube-inspector/?${AFTER_CRASH_PARAM}=diagnostics`);
  assert.equal(diagnosticsURL('http://localhost:5173/?x=1'), `http://localhost:5173/?x=1&${AFTER_CRASH_PARAM}=diagnostics`);
  // A second crash right after the first does not stack markers.
  assert.equal(
    diagnosticsURL(`app://kube-inspector/?${AFTER_CRASH_PARAM}=diagnostics`),
    `app://kube-inspector/?${AFTER_CRASH_PARAM}=diagnostics`,
  );
});

function fakeWindow(url = 'app://kube-inspector/') {
  const calls = [];
  let destroyed = false;
  return {
    calls,
    destroy() { destroyed = true; },
    isDestroyed: () => destroyed,
    loadURL: (u) => calls.push(['loadURL', u]),
    close: () => calls.push(['close']),
    webContents: { reload: () => calls.push(['reload']), getURL: () => url },
  };
}

const crash = { reason: 'crashed', exitCode: 11 };

for (const [response, action, call] of [
  [0, 'reload', ['reload']],
  [1, 'diagnostics', ['loadURL', `app://kube-inspector/?${AFTER_CRASH_PARAM}=diagnostics`]],
  [2, 'close', ['close']],
]) {
  test(`button ${response} → ${action}`, async () => {
    const win = fakeWindow();
    let shown;
    const got = await offerRecovery({
      win, details: crash,
      showMessageBox: async (w, opts) => { shown = { w, opts }; return { response }; },
    });
    assert.equal(got, action);
    assert.deepEqual(win.calls, [call]);
    assert.equal(shown.w, win);
    assert.equal(shown.opts.defaultId, 0);
    assert.equal(shown.opts.cancelId, 2);
    assert.match(shown.opts.detail, /crashed, exit code 11/);
  });
}

test('a window closed while the dialog was up is left alone', async () => {
  const win = fakeWindow();
  const got = await offerRecovery({
    win, details: crash,
    showMessageBox: async () => { win.destroy(); return { response: 0 }; },
  });
  assert.equal(got, 'gone');
  assert.deepEqual(win.calls, []);
});
