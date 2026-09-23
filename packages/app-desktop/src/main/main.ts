/**
 * Electron main — the thin shell (design §1 row "Main"): lifecycle, the one window, security
 * handlers, the `app:` and `nf-media:` protocols, the SE-1 file-token registry, the IPC gate,
 * and supervision of the host `utilityProcess`. This is the only main-process module that
 * imports `electron` at runtime; everything it wires is Electron-free and unit-tested with
 * fakes (Electron cannot launch on the dev box yet, D4).
 *
 * Entry: `dist/main/main.js` (ESM). Layout it expects next to it (see scripts/bundle.ts):
 *   dist/preload.cjs          the bundled sandboxed preload
 *   dist/renderer/            index.html, app.js, ui.css, shell.css (served by `app:`)
 *   dist/host/main.js         the host utilityProcess entry (lane L6-B)
 */
import { randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  Menu,
  app,
  ipcMain,
  net,
  protocol,
  session,
  utilityProcess,
  type WebContents,
} from 'electron';
import type { HostOut } from '../ipc/protocol.js';
import { CHANNEL } from '../ipc/protocol.js';
import { createAppProtocolHandler } from './app-protocol.js';
import { hostArgs, parseMainArgs } from './args.js';
import { FileTokenRegistry } from './file-tokens.js';
import { HostLink } from './host-link.js';
import { IpcGate } from './ipc-gate.js';
import { createLogger } from './log.js';
import { ImageRequests, MediaLinks, createMediaProtocolHandler } from './media.js';
import { createMoneyGate } from './money-gate.js';
import { APP_URL, MEDIA_SCHEME, APP_SCHEME, privilegedSchemes } from './schemes.js';
import { hardenWebContents, installSessionPolicy, sandboxBypassSwitch } from './security.js';
import { createMainWindow } from './window.js';

/** Relative to `dist/`: the host entry lane L6-B builds. */
export const HOST_ENTRY = 'host/main.js';

const log = createLogger((line) => {
  process.stderr.write(`${line}\n`);
});
const opts = parseMainArgs(process.argv.slice(1));
const distDir = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- before ready ------------------------------------------------------------------------

// D4: never run without the Chromium sandbox. Refuse, loudly, instead of degrading.
if (sandboxBypassSwitch(app.commandLine) !== undefined) {
  log('error', 'app.sandbox-bypass-refused');
  app.exit(78);
  throw new Error('refusing to run without the Chromium sandbox');
}
app.enableSandbox();
if (opts.userDataDir !== undefined) app.setPath('userData', opts.userDataDir);
protocol.registerSchemesAsPrivileged(privilegedSchemes());

/** webContents ids that show the app (the gate refuses everything else). */
const appWebContents = new Set<number>();

const tokens = new FileTokenRegistry({
  lstat: (p) => lstat(p),
  now: () => Date.now(),
  randomHex: (n) => randomBytes(n).toString('hex'),
  basename: (p) => basename(p),
});
const links = new MediaLinks(log);
let host: HostLink | undefined;
const post = (msg: Parameters<HostLink['post']>[0]): boolean => host?.post(msg) ?? false;
const images = new ImageRequests(post, 30_000, log);
const gate = new IpcGate({
  post,
  tokens,
  moneyGate: createMoneyGate({ devMocks: opts.devMocks }),
  isAppWebContents: (id) => appWebContents.has(id),
  log,
});

app.on('web-contents-created', (_event, wc) => {
  hardenWebContents(wc);
  wc.once('destroyed', () => {
    appWebContents.delete(wc.id);
    gate.webContentsGone(wc.id);
  });
  // A new document in the same webContents (crash recovery, our reload after a host restart):
  // the old page's subscriptions, sessions and file tokens die with it.
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) gate.webContentsGone(wc.id);
  });
  wc.on('render-process-gone', () => {
    log('error', 'renderer.gone');
    gate.webContentsGone(wc.id);
  });
});

function onHostOut(out: HostOut): void {
  switch (out.kind) {
    case 'media-link':
      links.set(out.token, out.url);
      return;
    case 'image':
      images.resolve(out.req, out.bytes, out.type);
      return;
    case 'reply':
    case 'sub-reply':
    case 'event':
      gate.fromHost(out);
      return;
  }
}

function showWindow(): void {
  const win = createMainWindow(BrowserWindow, join(distDir, 'preload.cjs'));
  const wc: WebContents = win.webContents;
  appWebContents.add(wc.id);
  win.once('ready-to-show', () => {
    win.show();
  });
  wc.on('did-fail-load', () => {
    log('error', 'window.load-failed');
  });
  void win.loadURL(APP_URL);
  log('info', 'window.created');
}

function start(): void {
  // macOS needs an Edit menu for copy/paste shortcuts; elsewhere there is no menu at all
  // (so no default Reload / Toggle DevTools accelerators either).
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
      : null,
  );
  installSessionPolicy(session.defaultSession);
  protocol.handle(
    APP_SCHEME,
    createAppProtocolHandler({ root: join(distDir, 'renderer'), readFile, realpath }),
  );
  const media = createMediaProtocolHandler({
    links,
    images,
    fetch: (url, init) => net.fetch(url, { ...init, headers: { ...init.headers } }),
    log,
  });
  /** e2e only: response status counts of `nf-media:` (numbers, never URLs). */
  const mediaStatuses = new Map<number, number>();
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const res = await media(req);
    if (opts.e2eHooks) mediaStatuses.set(res.status, (mediaStatuses.get(res.status) ?? 0) + 1);
    return res;
  });
  ipcMain.handle(CHANNEL.call, (e, raw: unknown) => gate.call(e, raw));
  ipcMain.handle(CHANNEL.sub, (e, raw: unknown) => gate.sub(e, raw));
  ipcMain.handle(CHANNEL.grant, (e, raw: unknown) => gate.grant(e, raw));

  host = new HostLink({
    spawn: () =>
      utilityProcess.fork(join(distDir, HOST_ENTRY), hostArgs(opts, app.getPath('userData')), {
        serviceName: 'nutflix-host',
        stdio: 'inherit',
      }),
    onOut: onHostOut,
    onDown: () => {
      gate.hostDown();
      links.clear();
      images.failAll();
    },
    onRestart: () => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.reload();
    },
    now: () => Date.now(),
    log,
  });
  host.start();

  if (opts.e2eHooks) {
    // Main-process only (reached by playwright's `electronApp.evaluate`), counts only.
    (globalThis as Record<symbol, unknown>)[Symbol.for('nutflix.e2e')] = Object.freeze({
      mediaLinks: (): number => links.size,
      mediaStatuses: (): Record<number, number> => Object.fromEntries(mediaStatuses),
      fileTokens: (): number => tokens.count(),
      hostRunning: (): boolean => host?.running ?? false,
    });
  }
  showWindow();
  log('info', 'app.start', { devMocks: opts.devMocks, devFixtures: opts.devFixtures });
}

app.on('window-all-closed', () => {
  app.quit();
});
app.on('before-quit', () => {
  host?.stop();
});
app.whenReady().then(start, () => {
  app.exit(1);
});
