/**
 * Design §5(a) — the Stage 1 exit integration test.
 *
 * A local `hyperdht` testnet (127.0.0.1 only); two `@sovit/seeder` nodes from the dev fixture
 * rig: S1 writes a deterministic 2 MiB blob (32 × 64 KiB), S2 mirrors blocks [16, 32) as a
 * PAYING viewer of S1 over the D1 loopback `pay/1` hub, then S1 clears [16, 32) — so S1 holds
 * exactly [0, 16) and S2 exactly [16, 32) and the viewer MUST fetch from both. The desktop
 * `WorkerHost` runs under Node with the Node runtime, `MockPaymentEngine('honest')` behind
 * `--dev-mocks` and the same hub, driven through the real framed wire (`WorkerRpc` + the L6-0
 * guards on both sides).
 *
 * Asserts: unknown core → 404 and never opened; `bytes=0-` + 1 s → downloaded ≤ the prefetch
 * window; pause → no new download even after the window grows; exact bytes over HTTP (full,
 * `bytes=0-` 206, mid-file 206, 416); every `download` attributed to the seeder that holds
 * the block (both Noise keys); viewer spend = blocks × price (engine AND `spend` events);
 * each seeder engine `paid == uploaded` after flush; no bans anywhere; close → 404.
 */
import { randomBytes } from 'node:crypto';

import type { VideoManifest } from '@sovit/core';
import type Hypercore from 'hypercore';
import type { Logger } from '@sovit/seeder';
import { createLogger, nodeFs, toHex } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import { sodiumCrypto } from '../crypto.js';
import type { DevMockProviders } from '../dev/dev-mocks.js';
import type { DevTestnet, FixtureNet } from '../dev/fixtures-net.js';
import { startDevTestnet, startFixtureNet, syntheticBytes } from '../dev/fixtures-net.js';
import { LoopbackPayHub } from '../dev/loopback-pay.js';
import type { WorkerClient } from './helpers/harness.js';
import {
  httpGet,
  httpHold,
  sleep,
  startWorker,
  tempDir,
  until,
  within,
} from './helpers/harness.js';

const BLOCK = 65_536;
const BLOCKS = 32;
const SIZE = BLOCK * BLOCKS;
const HALF = 16;
/**
 * 64 kbps → 8 000 B/s; 30 s of prefetch = ceil(240 000 / 65 536) = 4 blocks. The gate's paced
 * allowance grows by one block per 65 536 / (8 000 × 1.25) ≈ 6.5 s of playing time, so the
 * "≤ prefetch window after 1 s" check is not sensitive to a slow, loaded machine.
 */
const BITRATE_KBPS = 64;
const PREFETCH_SEC = 30;
const PREFETCH_BLOCKS = 4;
const PACED_BYTES_PER_MS = (BITRATE_KBPS * 1000 * 1.25) / 8 / 1000;

const quiet: Logger = createLogger({ level: 'error', sink: () => undefined });
const sid = (): SessionId => randomBytes(16).toString('hex') as SessionId;

describe('§5(a) two seeders → desktop worker (Stage 1 exit)', () => {
  const teardown: (() => Promise<void>)[] = [];
  let testnet: DevTestnet;
  let net: FixtureNet;
  let worker: WorkerClient;
  let video: VideoManifest;
  let viewerCore: Hypercore;
  const bytes = syntheticBytes(SIZE, 0x5a5a);
  const downloads: { index: number; from: string }[] = [];
  let onDownload: (cb: () => void) => () => void = () => () => undefined;

  beforeAll(async () => {
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    const hub = new LoopbackPayHub();
    const fixDir = await tempDir('nf-l6c-fixtures-');
    const workerDir = await tempDir('nf-l6c-worker-');
    teardown.push(
      () => fixDir.rm(),
      () => workerDir.rm(),
    );
    net = await startFixtureNet({
      baseDir: fixDir.dir,
      fs: nodeFs,
      crypto: sodiumCrypto,
      hub,
      bootstrap: testnet.bootstrap,
      logger: quiet,
      fixtures: [{ title: '§5(a) blob', bytes, durationSec: (SIZE * 8) / (BITRATE_KBPS * 1000) }],
    });
    teardown.push(() => net.close());
    video = net.videos[0]!;
    worker = startWorker({ hub, logLevel: 'error' });
    teardown.push(() => worker.close());
    await worker.call('init', {
      v: 1,
      storage: workerDir.dir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: PREFETCH_SEC,
      dev: {
        mocks: true,
        fixtures: false,
        bootstrap: testnet.bootstrap.map((b) => ({ host: '127.0.0.1' as const, port: b.port })),
      },
    });
    await worker.event(
      (e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready',
      5000,
      'ready',
    );
  }, 60_000);

  afterAll(async () => {
    // Whatever beforeAll got as far as creating, newest first.
    for (const close of teardown.reverse()) await close();
  }, 60_000);

  const rendition = () => video.renditions[0]!;
  const openArgs = (s: SessionId) => ({
    sid: s,
    videoId: video.id,
    rendition: {
      label: rendition().label,
      hyper: rendition().hyper,
      size: rendition().size,
      bitrateKbps: BITRATE_KBPS,
    },
    policy: video.price,
    prefetchSeconds: PREFETCH_SEC,
  });

  it('the fixture split is exactly S1 = [0,16), S2 = [16,32), and the mirror was paid', async () => {
    const key = rendition().hyper.core;
    const c1 = net.s1.seeder.blobs.coreByKey(key)!.core;
    const c2 = net.s2.seeder.blobs.coreByKey(key)!.core;
    for (let i = 0; i < BLOCKS; i++) {
      expect(await c1.has(i)).toBe(i < HALF);
      expect(await c2.has(i)).toBe(i >= HALF);
    }
    const w = net.s1.engine.window(net.s2.engine.config.ownPubkey);
    expect(w).toMatchObject({ uploaded: HALF, paid: HALF, outstanding: 0, banned: false });
  });

  it('an unknown core is a 404 and is never opened', async () => {
    const s = sid();
    const { link } = await worker.call('play.open', openArgs(s));
    const server = worker.host.internals.server!;
    const before = server.stats();
    const bogusKey = randomBytes(32);
    // Same live path token, someone else's core: refused by resolve(), store never asked.
    const bogus = link.replace(/key=[^&]+/, `key=${bogusKey.toString('hex')}`);
    expect((await httpGet(bogus, { range: 'bytes=0-9' })).status).toBe(404);
    // A made-up session entirely.
    const made = link.replace(/\/[0-9a-f]{32}\?/, `/${randomBytes(16).toString('hex')}?`);
    expect((await httpGet(made)).status).toBe(404);
    expect(server.stats().admitted).toBe(before.admitted);
    expect(server.stats().refused).toBe(before.refused + 2);
    expect(worker.host.internals.seeder!.blobs.coreByKey(bogusKey.toString('hex'))).toBeUndefined();
    await worker.call('play.close', { sid: s });
  });

  it(
    'plays: prefetch bound, pause, exact bytes, attribution, payments, close',
    { timeout: 60_000 },
    async () => {
      const s = sid();
      const opened = await worker.call('play.open', openArgs(s));
      expect(opened.key).toBe(rendition().hyper.core);
      expect(opened.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\?/);

      const seeder = worker.host.internals.seeder!;
      viewerCore = seeder.blobs.coreByKey(opened.key)!.core;
      const listeners = new Set<() => void>();
      viewerCore.on('download', (index, _len, peer) => {
        downloads.push({ index, from: toHex(peer.remotePublicKey) });
        for (const cb of [...listeners]) cb();
      });
      onDownload = (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      };
      const gate = worker.host.internals.gate(s)!;
      expect(gate.prefetchBlocks).toBe(PREFETCH_BLOCKS);

      // ---- bytes=0- and a player that stops reading: ≤ prefetch window after 1 s -------------
      const asked = Date.now();
      const held = await httpHold(opened.link, { range: 'bytes=0-' });
      expect(held.res.statusCode).toBe(206);
      await until(() => downloads.length >= 1, onDownload, 20_000, 'the first block');
      await sleep(1000);
      // The window, plus whatever the pacing legitimately added for the time actually elapsed
      // (0 blocks unless this phase took > 6.5 s).
      const paced = Math.floor(((Date.now() - asked) * PACED_BYTES_PER_MS) / BLOCK);
      expect(downloads.length).toBeGreaterThan(0);
      expect(downloads.length).toBeLessThanOrEqual(PREFETCH_BLOCKS + paced);
      expect(gate.requestedTotal).toBeLessThanOrEqual(PREFETCH_BLOCKS + paced);

      // ---- pause: nothing new is requested, even when the window grows past the file ---------
      await worker.call('play.pause', { sid: s });
      await worker.call('play.prefetch', { sid: s, seconds: 600 });
      await within(gate.idle(), 10_000, 'in-flight blocks to land after pause');
      const atPause = downloads.length;
      const requestedAtPause = gate.requestedTotal;
      await sleep(1000);
      expect(downloads.length).toBe(atPause);
      expect(gate.requestedTotal).toBe(requestedAtPause);
      expect(atPause).toBeLessThan(BLOCKS);

      // ---- resume: the (still unread) response pulls the rest --------------------------------
      await worker.call('play.resume', { sid: s });
      await until(() => downloads.length >= BLOCKS, onDownload, 30_000, 'all 32 blocks');
      const body = await within(held.readAll(), 10_000, 'the held body');
      expect(held.res.headers['content-range']).toBe(`bytes 0-${String(SIZE - 1)}/${String(SIZE)}`);
      expect(Buffer.compare(body, Buffer.from(bytes))).toBe(0);

      // ---- exact bytes over HTTP ranges -------------------------------------------------------
      const full = await httpGet(opened.link);
      expect(full.status).toBe(200);
      expect(full.headers['content-type']).toBe('video/mp4');
      expect(full.headers['content-security-policy']).toBe('sandbox');
      expect(full.headers['access-control-allow-origin']).toBeUndefined();
      expect(Buffer.compare(full.body, Buffer.from(bytes))).toBe(0);
      const mid = await httpGet(opened.link, { range: 'bytes=1000000-1100000' });
      expect(mid.status).toBe(206);
      expect(mid.headers['content-range']).toBe(`bytes 1000000-1100000/${String(SIZE)}`);
      expect(Buffer.compare(mid.body, Buffer.from(bytes.subarray(1_000_000, 1_100_001)))).toBe(0);
      expect((await httpGet(opened.link, { range: `bytes=${String(SIZE)}-` })).status).toBe(416);
      expect((await httpGet(opened.link, { range: `bytes=${String(SIZE + 5000)}-` })).status).toBe(
        416,
      );

      // ---- attribution: every block from the seeder that holds it -----------------------------
      const s1 = net.s1.noiseKeyHex();
      const s2 = net.s2.noiseKeyHex();
      expect(downloads).toHaveLength(BLOCKS);
      expect(new Set(downloads.map((d) => d.index)).size).toBe(BLOCKS);
      for (const d of downloads) expect(d.from).toBe(d.index < HALF ? s1 : s2);

      // ---- payments ---------------------------------------------------------------------------
      const payer = worker.host.internals.payer!;
      const credit = worker.host.internals.credit!;
      await payer.flush();
      await until(
        () => credit.size === 0,
        (cb) => credit.onAvailable(cb),
        10_000,
        'every PAY acknowledged',
      );
      const providers = worker.host.internals.providers as DevMockProviders;
      const price = video.price.satsPerBlock;
      expect(providers.engine.spent().total).toBe(BLOCKS * price);
      const spends = worker.events.filter(
        (e): e is Extract<WorkerEvent, { e: 'spend' }> => e.e === 'spend' && e.sid === s,
      );
      expect(spends.reduce((n, e) => n + e.amount, 0)).toBe(BLOCKS * price);
      expect(spends.at(-1)?.total).toBe(BLOCKS * price);
      for (const e of spends) expect(e.mint).toBe(video.price.mints[0]);
      const peers = worker.events.filter(
        (e): e is Extract<WorkerEvent, { e: 'peers' }> => e.e === 'peers' && e.sid === s,
      );
      const lastPeers = peers.at(-1)!.peers;
      expect(lastPeers.map((p) => p.blocks).sort()).toEqual([HALF, HALF]);
      expect(new Set(lastPeers.map((p) => p.pubkey))).toEqual(
        new Set([net.s1.engine.config.ownPubkey, net.s2.engine.config.ownPubkey]),
      );
      expect(payer.stats()).toMatchObject({ acksRejected: 0, unmatchedAcks: 0, owed: 0 });

      const viewerPubkey = providers.pubkey;
      for (const fx of [net.s1, net.s2]) {
        await fx.seeder.flushNow();
        const w = fx.engine.window(viewerPubkey)!;
        expect(w.uploaded).toBe(HALF);
        expect(w.paid).toBe(w.uploaded);
        expect(w.outstanding).toBe(0);
        expect(w.banned).toBe(false);
        expect(fx.engine.pendingCount()).toBe(0);
      }

      // ---- no bans anywhere -------------------------------------------------------------------
      expect(net.s1.seeder.bans()).toEqual([]);
      expect(net.s2.seeder.bans()).toEqual([]);
      expect(net.s1.engine.bans()).toEqual([]);
      expect(net.s2.engine.bans()).toEqual([]);
      expect(seeder.bans()).toEqual([]);
      expect(providers.engine.bans()).toEqual([]);

      // ---- close → 404 (idempotent) -----------------------------------------------------------
      await worker.call('play.close', { sid: s });
      await worker.call('play.close', { sid: s });
      expect((await httpGet(opened.link, { range: 'bytes=0-9' })).status).toBe(404);
      await expect(worker.call('play.pause', { sid: s })).rejects.toMatchObject({
        code: 'session-closed',
      });

      // Nothing the worker sent was refused by the host-side guard.
      expect(worker.invalid).toEqual([]);
      expect(worker.rpc.stats().droppedEvents).toBe(0);
    },
  );
});
