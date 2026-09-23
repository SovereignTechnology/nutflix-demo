/**
 * End to end under the REAL runtime: `PearRuntime.run` (pear-runtime 1.3.1 → bare-sidecar →
 * prebuilt bare 1.31.0) spawns a worker that speaks the host ⇄ worker protocol with the
 * `src/ipc/` modules. Proves (1) the ambient types in ../pear-runtime.d.ts and ../bare.d.ts
 * describe the real objects, (2) framing + guards + error envelopes run under Bare, which has
 * no TextEncoder/TextDecoder, and (3) multi-chunk frames survive the pipe both ways.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import PearRuntime from 'pear-runtime';
import type { PearWorkerIPC } from 'pear-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toHex } from '../../ipc/codec.js';
import { FrameDecoder, encodeFrame } from '../../ipc/framing.js';
import { isWorkerToHost } from '../../ipc/worker-guards.js';
import type { WorkerToHost } from '../../ipc/worker-protocol.js';
import { WORKER_V } from '../../ipc/worker-protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let dir = '';
let entry = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nf-l6-0-sidecar-'));
  entry = join(dir, 'worker.cjs');
  await build({
    entryPoints: [join(HERE, 'fixtures', 'bare-echo-worker.ts')],
    outfile: entry,
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  });
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

interface Harness {
  readonly ipc: PearWorkerIPC;
  readonly messages: WorkerToHost[];
  readonly invalid: unknown[];
  next(pred: (m: WorkerToHost) => boolean): Promise<WorkerToHost>;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

function start(args: readonly string[]): Harness {
  const ipc = PearRuntime.run(entry, args);
  // Drain stdio so the child can never block on a full pipe (see pear-runtime.d.ts).
  ipc.stdout?.resume();
  ipc.stderr?.resume();
  const messages: WorkerToHost[] = [];
  const invalid: unknown[] = [];
  const waiters: { pred: (m: WorkerToHost) => boolean; resolve: (m: WorkerToHost) => void }[] = [];
  const decoder = new FrameDecoder((m) => {
    if (!isWorkerToHost(m)) {
      invalid.push(m);
      return;
    }
    messages.push(m);
    for (const w of [...waiters])
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
  });
  ipc.on('data', (chunk) => {
    decoder.push(chunk);
  });
  ipc.on('error', () => undefined);
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    ipc.once('exit', (code, signal) => {
      resolve({ code, signal });
    }),
  );
  return {
    ipc,
    messages,
    invalid,
    exited,
    next: (pred) => {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
  };
}

const isRes = (id: number) => (m: WorkerToHost) => m.op === 'res' && m.id === id;

describe('host ⇄ worker over PearRuntime.run (real bare)', () => {
  it(
    'runs the protocol end to end, then dies on a corrupt frame',
    { timeout: 30_000 },
    async () => {
      const h = start(['/tmp/storage-arg', 'second']);
      try {
        const ready = await h.next((m) => m.op === 'ev' && m.e === 'ready');
        expect(ready).toEqual({ op: 'ev', e: 'ready', v: WORKER_V, port: 1 });

        const log = await h.next((m) => m.op === 'ev' && m.e === 'log');
        const info = JSON.parse((log as { msg: string }).msg) as {
          argv: string[];
          version: string;
          globals: Record<string, string>;
        };
        expect(info.argv).toEqual(['/tmp/storage-arg', 'second']); // Bare.argv[2…]
        expect(info.version).toBe('v1.31.0');
        // The Bare 1.31 globals finding (docs/lanes/L6-0.md).
        expect(info.globals).toEqual({
          TextEncoder: 'undefined',
          TextDecoder: 'undefined',
          crypto: 'undefined',
          AbortController: 'undefined',
          process: 'undefined',
          URL: 'function',
          Buffer: 'function',
        });

        // A valid request, split across writes.
        const f = encodeFrame({
          op: 'req',
          id: 1,
          m: 'seeder.unban',
          a: { pubkey: 'ab'.repeat(32) },
        });
        h.ipc.write(f.subarray(0, 3));
        h.ipc.write(f.subarray(3));
        expect(await h.next(isRes(1))).toEqual({ op: 'res', id: 1, ok: true });

        // An invalid one is refused by the worker's guard, not executed.
        h.ipc.write(encodeFrame({ op: 'req', id: 2, m: 'seeder.unban', a: { pubkey: 'not-hex' } }));
        const refused = await h.next(isRes(2));
        expect(refused).toMatchObject({ ok: false, e: { code: 'invalid-argument' } });

        // A handler error travels as a coded WireError.
        h.ipc.write(encodeFrame({ op: 'req', id: 3, m: 'play.close', a: { sid: '0'.repeat(32) } }));
        expect(await h.next(isRes(3))).toMatchObject({ ok: false, e: { code: 'not-found' } });

        // ~8 MiB frames both ways (the pipe delivers them in many chunks).
        const hex = toHex(new Uint8Array(4 * 1024 * 1024).fill(0xab));
        h.ipc.write(
          encodeFrame({
            op: 'req',
            id: 4,
            m: 'studio.upload',
            a: {
              uploadId: 'f'.repeat(32),
              path: '/tmp/a.mp4',
              name: 'a.mp4',
              meta: {
                title: 't',
                description: '',
                tags: [],
                kind: 21,
                mints: ['https://mint.example'],
                satsPerBlock: 1,
                split: { seeder: 50, creator: 50 },
              },
              thumbnailChoice: { hex, type: 'image/jpeg' },
            },
          }),
        );
        const echo = (await h.next(isRes(4))) as { r?: { echo?: string } };
        expect(echo.r?.echo?.length).toBe(hex.length);
        expect(echo.r?.echo === hex).toBe(true);
        expect(h.invalid).toEqual([]);

        // Garbage: an oversize length header. The worker must not resync — it exits (code 3).
        h.ipc.write(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0x7b));
        expect(await h.exited).toEqual({ code: 3, signal: null });
      } finally {
        if (!h.ipc.destroyed) h.ipc.destroy();
      }
    },
  );

  it('D2: the constructor is not callable from TypeScript', () => {
    // @ts-expect-error — D2: never construct PearRuntime in Stage 1 (joins the public DHT).
    const make = (): unknown => new PearRuntime();
    expect(typeof make).toBe('function');
    expect(typeof PearRuntime.run).toBe('function');
  });
});
