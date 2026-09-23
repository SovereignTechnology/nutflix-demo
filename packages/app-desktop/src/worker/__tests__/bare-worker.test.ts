/**
 * The WHOLE worker under the real Bare runtime: `entry.ts` (D6 first, `Bare.IPC` ⇄ framing ⇄
 * guards ⇄ `WorkerHost` with the Bare runtime) spawned through bare-sidecar exactly as the
 * host will (D2), driven over the framed pipe with `--dev-mocks --dev-fixtures`:
 *
 *   init → ready{port} → dev.fixtures (an in-process testnet + S1/S2 fixture seeders inside the
 *   Bare process, the clip made by the system ffmpeg through bare-subprocess when there is
 *   one) → play.open → the bytes over HTTP from Node equal the manifest's sha256 (UDX
 *   replication, gated blob server on bare-http1, pay/1 over the loopback hub) → spend events
 *   add up → close → 404 → studio.ffmpeg → junk refused → pipe closed → exit 0.
 */
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { VideoManifest } from '@sovit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Guard } from '../../ipc/protocol.js';
import { validateWorkerResult } from '../../ipc/worker-guards.js';
import type { WorkerToHost } from '../../ipc/worker-protocol.js';
import { WORKER_SRC, bundleForBare, spawnBare } from './helpers/bare.js';
import type { BareWorker } from './helpers/bare.js';
import { httpGet, tempDir } from './helpers/harness.js';

type Ev<E extends string> = Extract<WorkerToHost, { op: 'ev'; e: E }>;
type Res = Extract<WorkerToHost, { op: 'res' }>;

let bundle: { readonly file: string; cleanup(): Promise<void> };
let storage: { dir: string; rm: () => Promise<void> };

beforeAll(async () => {
  bundle = await bundleForBare(join(WORKER_SRC, 'entry.ts'));
  storage = await tempDir('nf-l6c-bare-worker-');
});
afterAll(async () => {
  await bundle.cleanup();
  await storage.rm();
});

function call(w: BareWorker, id: number, m: string, a: unknown): Promise<Res> {
  w.send({ op: 'req', id, m, a });
  return w.next((x): x is Res => x.op === 'res' && x.id === id, 30_000, `${m} response`);
}

describe('the worker entry under the real bare', () => {
  it('serves a fixture video end to end and exits cleanly', { timeout: 90_000 }, async () => {
    const w = spawnBare(bundle.file);
    try {
      const init = await call(w, 1, 'init', {
        v: 1,
        storage: storage.dir,
        seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
        prefetchSeconds: 30,
        dev: { mocks: true, fixtures: true },
      });
      expect(init).toMatchObject({ ok: true });
      const ready = await w.next((m): m is Ev<'ready'> => m.op === 'ev' && m.e === 'ready');
      expect(ready.port).toBeGreaterThan(0);

      const fx = await w.next(
        (m): m is Ev<'dev.fixtures'> => m.op === 'ev' && m.e === 'dev.fixtures',
        60_000,
        'dev.fixtures',
      );
      const video: VideoManifest = fx.videos[0]!;
      const r = video.renditions[0]!;

      const sid = randomBytes(16).toString('hex');
      const open = await call(w, 2, 'play.open', {
        sid,
        videoId: video.id,
        rendition: {
          label: r.label,
          hyper: r.hyper,
          size: r.size,
          ...(r.bitrateKbps ? { bitrateKbps: r.bitrateKbps } : {}),
        },
        policy: video.price,
        prefetchSeconds: 600,
      });
      expect(open.ok).toBe(true);
      const link = (open as Extract<Res, { ok: true }>).r as { key: string; link: string };
      expect((validateWorkerResult['play.open'] as Guard<unknown>)(link)).toBe(true);

      const full = await httpGet(link.link);
      expect(full.status).toBe(200);
      expect(full.headers['content-type']).toBe('video/mp4');
      expect(full.body.byteLength).toBe(r.size);
      expect(createHash('sha256').update(full.body).digest('hex')).toBe(r.sha256);
      const mid = await httpGet(link.link, { range: 'bytes=10-1033' });
      expect(mid.status).toBe(206);
      expect(Buffer.compare(mid.body, full.body.subarray(10, 1034))).toBe(0);

      // Every block is paid: the spend events add up to blocks × price.
      const owed = r.hyper.blob.blockLength * video.price.satsPerBlock;
      const lastSpend = await w.next(
        (m): m is Ev<'spend'> =>
          m.op === 'ev' && m.e === 'spend' && m.sid === sid && m.total === owed,
        20_000,
        `spend total ${String(owed)}`,
      );
      expect(lastSpend.total).toBe(owed);

      expect(await call(w, 3, 'play.close', { sid })).toMatchObject({ ok: true });
      expect((await httpGet(link.link, { range: 'bytes=0-9' })).status).toBe(404);

      const ff = await call(w, 4, 'studio.ffmpeg', { recheck: true });
      expect(ff.ok).toBe(true);
      expect(
        (validateWorkerResult['studio.ffmpeg'] as Guard<unknown>)(
          (ff as Extract<Res, { ok: true }>).r,
        ),
      ).toBe(true);

      // Junk is refused, not executed.
      const junk = await call(w, 5, 'play.open', { sid: 'nope' });
      expect(junk).toMatchObject({ ok: false, e: { code: 'invalid-argument' } });

      expect(w.invalid).toEqual([]);
      w.end();
      expect(await w.exited).toBe(0);
    } finally {
      w.kill();
    }
  });
});
