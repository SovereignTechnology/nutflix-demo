/**
 * Bare program for the day-1 probe (`./probe.ts`): run under the REAL `bare` through
 * `bare-sidecar` (what the host uses to spawn the worker), it reports over `Bare.IPC` with
 * the L6-0 framing — one `log` event whose `msg` is the JSON `ProbeReport` — and exits 0 when
 * every step passed, 1 otherwise, 10 without an IPC pipe.
 *
 * Driven by `scripts/bare-probe.ts` (manual) and `__tests__/bare-probe.test.ts` (CI).
 */
import './bare-globals.js';

import fs from 'bare-fs';
import http from 'bare-http1';
import os from 'bare-os';
import path from 'bare-path';

import { encodeFrame } from '../ipc/framing.js';
import { bareRuntime } from './adapters/bare.js';
import type { ProbeHttpResponse } from './probe.js';
import { runProbe } from './probe.js';

function httpGet(
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<ProbeHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers: { ...headers } }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on('data', (c: unknown) => {
        if (c instanceof Uint8Array) chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => {
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const body = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          body.set(c, off);
          off += c.byteLength;
        }
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = String(v);
        resolve({ status: res.statusCode, headers: h, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const ipc = Bare.IPC;
if (ipc === null) Bare.exit(10);
else {
  void (async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nf-bare-probe-'));
    const report = await runProbe({ runtime: bareRuntime(), dir, httpGet });
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    ipc.write(
      encodeFrame({ op: 'ev', e: 'log', level: 'info', msg: JSON.stringify(report) }),
      () => {
        Bare.exit(report.ok ? 0 : 1);
      },
    );
  })();
}
