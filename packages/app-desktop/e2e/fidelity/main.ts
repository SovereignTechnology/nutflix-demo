/**
 * Fidelity spike — Electron main (design risk 5). Bundled to `main.mjs` by
 * `e2e/fidelity.e2e.ts` (ESM main, `electron` external). Mirrors the real shell's choices so
 * each finding transfers: privileged `app:` + `nf-media:` schemes, the CSP as a response header,
 * `protocol.handle` + `net.fetch` Range proxy, a sandboxed window with a CJS preload, and an ESM
 * `utilityProcess` that spawns Bare through `bare-sidecar`. Results → `globalThis.__fidelity`.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, ipcMain, net, protocol, utilityProcess } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = process.env['NUTFLIX_FIDELITY_MP4'] ?? '';
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' nf-media: data:; media-src nf-media:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";

const findings: Record<string, unknown> = {
  rangeRequests: [] as string[],
  statuses: [] as number[],
};
(globalThis as Record<string, unknown>)['__fidelity'] = findings;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, stream: true } },
  { scheme: 'nf-media', privileges: { standard: true, secure: true, stream: true } },
]);

/** A minimal Range server for the fixture (what the worker's blob server does for real). */
async function rangeServer(): Promise<string> {
  const size = (await stat(fixture)).size;
  const bytes = await readFile(fixture);
  const server = createServer((req, res) => {
    const range = req.headers.range ?? '';
    (findings['rangeRequests'] as string[]).push(range);
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m === null) {
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': String(size),
        'accept-ranges': 'bytes',
      });
      res.end(bytes);
      return;
    }
    const start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
    const end = m[2] === '' || m[1] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${String(size)}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'content-type': 'video/mp4',
      'content-range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
    });
    res.end(bytes.subarray(start, end + 1));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return `http://127.0.0.1:${String(typeof addr === 'object' && addr !== null ? addr.port : 0)}/fixture`;
}

void app.whenReady().then(async () => {
  findings['noSandboxSwitch'] = app.commandLine.hasSwitch('no-sandbox');
  const link = await rangeServer();
  protocol.handle('app', async (req) => {
    const name = new URL(req.url).pathname.slice(1) || 'index.html';
    if (!/^[a-z]+\.(html|js)$/.test(name)) return new Response(null, { status: 404 });
    const body = await readFile(join(here, name));
    return new Response(body, {
      headers: {
        'content-type': name.endsWith('.html') ? 'text/html' : 'text/javascript',
        'content-security-policy': CSP,
      },
    });
  });
  protocol.handle('nf-media', async (req) => {
    const headers: Record<string, string> = {};
    const range = req.headers.get('range');
    if (range !== null) headers['range'] = range;
    const up = await net.fetch(link, { headers, redirect: 'error' });
    (findings['statuses'] as number[]).push(up.status);
    const out = new Headers({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes' });
    for (const h of ['content-length', 'content-range']) {
      const v = up.headers.get(h);
      if (v !== null) out.set(h, v);
    }
    return new Response(up.body, { status: up.status, headers: out });
  });
  ipcMain.handle('fidelity:report', (_e, r: unknown) => {
    findings['page'] = r;
  });

  // ESM utilityProcess spawning Bare through bare-sidecar.
  const child = utilityProcess.fork(join(here, 'utility.mjs'), [], {
    serviceName: 'fidelity-utility',
  });
  child.on('message', (m: unknown) => {
    findings['utility'] = { ...(findings['utility'] as object | undefined), ...(m as object) };
  });

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Not in Electron 44's typings, still present at runtime (Electron's own specs use it).
  findings['webPreferences'] = (
    win.webContents as unknown as { getLastWebPreferences?: () => unknown }
  ).getLastWebPreferences?.();
  await win.loadURL('app://fidelity/index.html');
});
