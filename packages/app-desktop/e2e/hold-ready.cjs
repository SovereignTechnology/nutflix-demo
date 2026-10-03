/**
 * Preloaded into the e2e Electron main process (`-r`, from `support.ts` `launch()`): holds the
 * app's `ready` until Playwright has attached, then lets it through. NEVER loaded by the app.
 *
 * Why: `launch()` passes `executablePath`, and then Playwright does NOT preload its own
 * `loader.js`, the one that holds `ready` this way. Without the hold, main creates its window
 * while Playwright is still connecting. When Playwright attaches to that window during its
 * initial empty document, it waits for the next `Page.frameNavigated`; if the navigation to
 * `app://nutflix/index.html` commits before `Page.enable` takes effect, that event never comes
 * and `electron.launch` times out after 30 s (reproduced under CPU load: 4 of 40 launches; CI:
 * main run 12, SovereignTechnology/nutflix-demo#7 and #8).
 *
 * Only the hold is copied from Playwright's loader (playwright-core 1.63.0,
 * `lib/server/electron/loader.js`, Apache-2.0): NOT its ~30 Chromium switches nor its
 * `process.argv` rewrite, which would change the posture these suites check. Playwright's
 * `ElectronApplication.initialize()` calls `__playwright_run()` once it is attached.
 */
'use strict';
const { app } = require('electron');

const originalWhenReady = app.whenReady();
const originalEmit = app.emit.bind(app);
let readyEventArgs = [];
app.emit = (event, ...args) => {
  if (event === 'ready') {
    readyEventArgs = args;
    return app.listenerCount('ready') > 0;
  }
  return originalEmit(event, ...args);
};
let isReady = false;
let whenReadyCallback = () => undefined;
const whenReadyPromise = new Promise((f) => {
  whenReadyCallback = f;
});
app.isReady = () => isReady;
app.whenReady = () => whenReadyPromise;
globalThis.__playwright_run = async () => {
  const event = await originalWhenReady;
  isReady = true;
  whenReadyCallback(event);
  originalEmit('ready', ...readyEventArgs);
};
