/**
 * The day-1 Bare probe (design §6 L6-C "Day 1"), runtime-neutral so the same checks run
 * under Node in unit tests and under the real `bare` (`./probe-entry.ts`, driven by
 * `scripts/bare-probe.ts` and `__tests__/bare-probe.test.ts`):
 *
 *   1. the globals D6 installs exist (`TextEncoder` / `TextDecoder`);
 *   2. `@sovit/seeder` resolved its runtime-portable entry (under Bare: the `bare` export
 *      condition → `dist/portable.js`, i.e. no Node adapters in the namespace), `@sovit/core`
 *      and `@sovit/gateway/upstream` load;
 *   3. a `Seeder` on a temp dir with the injected adapters: `putBytes` + `getBlob` round
 *      trip, `putFile` of the same bytes deduplicates, sha256 = libsodium's;
 *   4. the gated playback server (`hypercore-blob-server` + wrapper store) answers a Range
 *      request with exactly those bytes (206, `Content-Range`, fixed `video/mp4`,
 *      `CSP: sandbox`, no CORS), 416 past the end, 404 for a wrong path token, 404 after the
 *      session closes.
 */
import { mocks } from '@sovit/core';
import * as seederModule from '@sovit/seeder';
import { Seeder, silentLogger } from '@sovit/seeder';
import { UpstreamPayer } from '@sovit/gateway/upstream';

import { randomHex, sha256Hex, sodiumCrypto } from './crypto.js';
import { CreditPool } from './playback/credit.js';
import { PlaybackGate } from './playback/gate.js';
import { PlaybackServer } from './playback/server.js';
import type { WorkerRuntime } from './runtime.js';

export interface ProbeHttpResponse {
  readonly status: number;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ProbeDeps {
  readonly runtime: WorkerRuntime;
  /** An absolute, empty, writable directory. */
  readonly dir: string;
  readonly httpGet: (
    url: string,
    headers: Readonly<Record<string, string>>,
  ) => Promise<ProbeHttpResponse>;
}

export interface ProbeStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ProbeReport {
  readonly ok: boolean;
  readonly steps: readonly ProbeStep[];
  readonly ms: number;
}

function filler(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >>> 8)) & 0xff;
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function runProbe(deps: ProbeDeps): Promise<ProbeReport> {
  const t0 = Date.now();
  const steps: ProbeStep[] = [];
  const step = (name: string, ok: boolean, detail?: string): void => {
    steps.push(detail === undefined ? { name, ok } : { name, ok, detail });
  };
  const g = globalThis as Record<string, unknown>;
  step(
    'globals: TextEncoder/TextDecoder',
    typeof g['TextEncoder'] === 'function' && typeof g['TextDecoder'] === 'function',
  );
  // Under Bare the `bare` export condition must pick `dist/portable.js` (no Node adapters);
  // under Node the default entry adds them. The detail says which one loaded.
  step(
    'imports: @sovit/seeder',
    typeof Seeder === 'function',
    Object.prototype.hasOwnProperty.call(seederModule, 'nodeAdapters') ? 'node entry' : 'portable',
  );
  step('imports: @sovit/core + mocks', typeof mocks.MockPaymentEngine === 'function');
  step('imports: @sovit/gateway/upstream', typeof UpstreamPayer === 'function');

  const { runtime, dir } = deps;
  const c0 = runtime.monotonicNow();
  const c1 = runtime.monotonicNow();
  step('runtime: monotonic clock', Number.isFinite(c0) && c1 >= c0, String(c0));
  const fs = runtime.seederFs;
  const size = 3 * 65_536 + 1234;
  const bytes = filler(size);
  let seeder: Seeder | null = null;
  let server: PlaybackServer | null = null;
  try {
    seeder = await Seeder.create(
      { dataDir: fs.join(dir, 'seeder'), diskCapBytes: 64 * 1024 * 1024, swarm: null },
      { engine: new mocks.MockPaymentEngine(), fs, crypto: sodiumCrypto, logger: silentLogger },
    );
    const put = await seeder.putBytes(bytes, { mime: 'video/mp4' });
    step(
      'seeder: putBytes',
      put.ok,
      put.ok ? `${String(put.entry.blob.blockLength)} blocks` : put.error.code,
    );
    if (!put.ok) throw new Error('put failed');
    step('seeder: sha256 (libsodium)', put.entry.sha256 === sha256Hex(bytes));
    const got = await seeder.getBlob(put.entry.sha256);
    step('seeder: getBlob round trip', got !== null && equal(got, bytes));
    const file = fs.join(dir, 'same.bin');
    await fs.writeFile(file, bytes);
    const again = await seeder.putFile(file, { mime: 'video/mp4' });
    step('seeder: putFile dedupe', again.ok && again.deduplicated);

    const sc = seeder.blobs.coreByKey(put.entry.coreKey);
    if (sc === undefined) throw new Error('core not open');
    const gate = new PlaybackGate({
      core: sc.core,
      blob: put.entry.blob,
      blockSize: 65_536,
      bytesPerSec: 1_000_000,
      prefetchSeconds: 10,
      credit: new CreditPool(4),
      logger: silentLogger,
    });
    server = new PlaybackServer({ logger: silentLogger, randomHex });
    const port = await server.listen();
    step('blob server: listening on 127.0.0.1', port > 0, String(port));
    const sid = randomHex(16);
    const link = server.register(sid, put.entry.coreKey, put.entry.blob, gate);
    step('blob server: loopback link', link.startsWith(`http://127.0.0.1:${String(port)}/`));

    const r = await deps.httpGet(link, { range: 'bytes=100-199' });
    step('range: 206', r.status === 206, String(r.status));
    step(
      'range: Content-Range',
      r.headers['content-range'] === `bytes 100-199/${String(size)}`,
      r.headers['content-range'],
    );
    step('range: exact bytes', equal(r.body, bytes.subarray(100, 200)));
    step('range: Content-Type video/mp4', r.headers['content-type'] === 'video/mp4');
    step('range: CSP sandbox', r.headers['content-security-policy'] === 'sandbox');
    step('range: no CORS', r.headers['access-control-allow-origin'] === undefined);

    const mid = await deps.httpGet(link, {
      range: `bytes=${String(65_536 - 10)}-${String(65_536 + 9)}`,
    });
    step(
      'range: across a block boundary',
      mid.status === 206 && equal(mid.body, bytes.subarray(65_536 - 10, 65_536 + 10)),
    );
    const past = await deps.httpGet(link, { range: `bytes=${String(size + 10)}-` });
    step('range: 416 past the end', past.status === 416, String(past.status));
    const wrong = link.replace(/\/[0-9a-f]{32}\?/, `/${randomHex(16)}?`);
    const w = await deps.httpGet(wrong, {});
    step('allowlist: unknown session → 404', w.status === 404, String(w.status));
    const admittedBefore = server.stats().admitted;
    gate.close();
    server.unregister(sid);
    const closed = await deps.httpGet(link, { range: 'bytes=0-9' });
    step(
      'allowlist: closed session → 404, store untouched',
      closed.status === 404 && server.stats().admitted === admittedBefore,
      String(closed.status),
    );
  } catch (err) {
    step('probe aborted', false, err instanceof Error ? err.message : String(err));
  } finally {
    await server?.close().catch(() => undefined);
    await seeder?.close().catch(() => undefined);
  }
  return { ok: steps.every((s) => s.ok), steps, ms: Date.now() - t0 };
}
