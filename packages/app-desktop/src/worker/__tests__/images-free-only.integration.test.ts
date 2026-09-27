/**
 * ADR 0015 amendment 2026-09-26 (Cameron; lane P2-owed-viewer): seeders say "free" per core, and
 * a viewer asks a seeder for an image core's blocks ONLY after that seeder's `PRICE { free: true }`
 * for it — silence or a price, and it is never asked: no probe, nothing counted.
 *
 * On a local `hyperdht` testnet (127.0.0.1 only) with the dev fixture rig: S1 and S2 seed a paid
 * video; S1 also holds a creator's profile core with two images and serves it FREE; a third seeder
 * (`gw`, standing for a gateway: it prices everything it holds) holds a replica of that profile
 * core and SELLS it. The desktop `WorkerHost` reads with `image.fetch`, under a stable identity
 * (injected providers, not `--dev-mocks`, whose identity is new every run), so a restart of the
 * viewer is the same viewer to the seeders. The reviewer's scenarios:
 *
 *   1. a free image with a seeder that prices it in the swarm loads — from the free seeder only;
 *      the pricing one is asked nothing and counts nothing;
 *   2. a free read that times out (the free seeder takes the requests and answers none) leaves
 *      NO debt against that seeder: nothing unpaid, no lost request, its playback credit whole;
 *   3. a paid core named by a thumbnail: nothing is requested from its seeders (they said its
 *      price), nobody bans us — and after a restart of the viewer the video plays in full, every
 *      block paid, with nothing reported owed from before.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { CoreKeyHex, NostrPubkey, Sha256Hex, VideoManifest } from '@sovit/core';
import { manifest } from '@sovit/core';
import type { Logger } from '@sovit/seeder';
import { createLogger, nodeFs, toHex } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import { sodiumCrypto } from '../crypto.js';
import { devMockProviders } from '../dev/dev-mocks.js';
import type { DevTestnet, FixtureNet, FixtureSeeder } from '../dev/fixtures-net.js';
import {
  createFixtureSeeder,
  startDevTestnet,
  startFixtureNet,
  syntheticBytes,
} from '../dev/fixtures-net.js';
import { LoopbackEnd, LoopbackPayHub } from '../dev/loopback-pay.js';
import type { ViewerPayer } from '../pay/viewer-payer.js';
import type { WorkerClient } from './helpers/harness.js';
import { httpGet, startWorker, tempDir } from './helpers/harness.js';

const BLOCK = 65_536;
const quiet: Logger = createLogger({ level: 'error', sink: () => undefined });
/** How long an image read may take here (production: 15 s). */
const READ_MS = 2500;
const jpeg = (blocks: number, salt: number): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...syntheticBytes(blocks * BLOCK - 100, salt)]);
const sha = (b: Uint8Array): Sha256Hex => createHash('sha256').update(b).digest('hex') as Sha256Hex;
/** The first image: 6 blocks (more than a fixture seeder's window of 4). */
const IMG_A = jpeg(6, 0x51);
/** The second image: read by the scenario that times out (never downloaded before). */
const IMG_B = jpeg(3, 0x52);

interface Seen {
  readonly core: string;
  readonly free: boolean;
}

describe('ADR 0015 amendment: image blocks only from seeders that said free', () => {
  const teardown: (() => Promise<void>)[] = [];
  let testnet: DevTestnet;
  let hub: LoopbackPayHub;
  let net: FixtureNet;
  let gw: FixtureSeeder;
  let workerDir: string;
  let worker: WorkerClient;
  let video: VideoManifest;
  let videoCore: CoreKeyHex;
  let videoImage: { url: string; sha256: Sha256Hex; size: number };
  let profileCore: CoreKeyHex;
  let urlA: string;
  let urlB: string;
  /** PRICE frames the worker's pay/1 ends received (every run of it: `workerKeys`). */
  let readPrices: () => Seen[] = () => [];
  const workerKeys: string[] = [];

  const label = `owed-viewer-images-${randomBytes(4).toString('hex')}`;
  const start = async (): Promise<WorkerClient> => {
    const w = startWorker({
      hub,
      logLevel: 'error',
      testBootstrap: testnet.bootstrap,
      imageTimeoutMs: READ_MS,
      // A stable identity across restarts: the same dev engine label.
      providers: () => devMockProviders({ hub, label }),
    });
    await w.call('init', {
      v: 1,
      storage: workerDir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
    });
    await w.event((e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready', 5000, 'ready');
    const node = w.host.internals.node;
    if (node !== null) workerKeys.push(toHex(node.publicKey));
    return w;
  };
  const payer = (): ViewerPayer => {
    const p = worker.host.internals.payer;
    if (p === null) throw new Error('worker not initialised');
    return p;
  };
  const me = (): NostrPubkey => {
    const p = worker.host.internals.providers;
    if (p === null) throw new Error('worker not initialised');
    return p.pubkey;
  };
  /** What a fixture seeder counts against us, from its own engine. */
  const counted = (fx: FixtureSeeder) => fx.engine.window(me());
  const uploaded = (fx: FixtureSeeder): number => counted(fx)?.uploaded ?? 0;

  beforeAll(async () => {
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    hub = new LoopbackPayHub();
    const fixDir = await tempDir('nf-p2-img-fixtures-');
    const wdir = await tempDir('nf-p2-img-worker-');
    workerDir = wdir.dir;
    teardown.push(
      () => fixDir.rm(),
      () => wdir.rm(),
    );
    net = await startFixtureNet({
      baseDir: fixDir.dir,
      fs: nodeFs,
      crypto: sodiumCrypto,
      hub,
      bootstrap: testnet.bootstrap,
      logger: quiet,
      fixtures: [{ title: 'a paid video', bytes: syntheticBytes(16 * BLOCK, 9), durationSec: 16 }],
    });
    teardown.push(() => net.close());
    video = net.videos[0]!;
    const entry = net.entries[0]!;
    videoCore = entry.coreKey;
    videoImage = {
      url: manifest.encodeHyperUrl({ core: entry.coreKey, blob: entry.blob }),
      sha256: entry.sha256,
      size: entry.size,
    };
    // S1's profile core: two images, free, announced.
    const sc = await net.s1.seeder.blobs.openCore('nutflix-profile');
    const blobA = await sc.blobs.put(IMG_A);
    const blobB = await sc.blobs.put(IMG_B);
    net.s1.seeder.setFreeCore(sc.keyHex, true);
    net.s1.node.join(sc.core.discoveryKey, { server: true, client: false });
    await net.s1.node.flush();
    profileCore = sc.keyHex;
    urlA = manifest.encodeHyperUrl({ core: profileCore, blob: blobA });
    urlB = manifest.encodeHyperUrl({ core: profileCore, blob: blobB });
    // "gw": holds image A's blocks of that profile core, and SELLS the core.
    const gwDir = await tempDir('nf-p2-img-gw-');
    teardown.push(() => gwDir.rm());
    gw = await createFixtureSeeder({
      name: 'gw',
      dataDir: gwDir.dir,
      fs: nodeFs,
      crypto: sodiumCrypto,
      hub,
      bootstrap: testnet.bootstrap,
      logger: quiet,
      policy: net.policy,
    });
    teardown.push(() => gw.close());
    const rep = await gw.seeder.blobs.openCoreByKey(sc.core.key);
    gw.node.join(rep.core.discoveryKey, { server: true, client: true });
    await rep.core
      .download({ start: blobA.blockOffset, end: blobA.blockOffset + blobA.blockLength })
      .done();
    gw.seeder.setCorePolicy(profileCore, net.policy);
    await gw.node.flush();

    // Every PRICE frame the WORKER's ends receive (they are registered under its Noise key; the
    // spy passes every frame through untouched).
    const spy = vi.spyOn(LoopbackEnd.prototype, 'receive');
    teardown.push(() => {
      spy.mockRestore();
      return Promise.resolve();
    });
    readPrices = () => {
      const keys = new Set(workerKeys);
      return spy.mock.calls.flatMap(([w], i) => {
        const end = spy.mock.contexts[i] as LoopbackEnd;
        if (w.t !== 'price' || ![...keys].some((key) => end.id.endsWith(`:${key}`))) return [];
        return [{ core: w.m.core, free: w.m.free === true }];
      });
    };

    worker = await start();
    teardown.push(() => worker.close());
  }, 120_000);

  afterAll(async () => {
    for (const close of teardown.reverse()) await close();
  }, 60_000);

  it('a free image loads with a seeder that prices it in the swarm: asked of the free seeder only; the pricing one is asked nothing, counts nothing', async () => {
    const gwBefore = uploaded(gw);
    const { hex } = await worker.call('image.fetch', {
      url: urlA,
      sha256: sha(IMG_A),
      size: IMG_A.byteLength,
    });
    expect(Buffer.from(hex, 'hex').equals(Buffer.from(IMG_A))).toBe(true);
    // Both words reached us for that core: `free` (S1) and a price (gw) — not a vacuous pass.
    expect(readPrices().some((p) => p.core === profileCore && p.free)).toBe(true);
    expect(readPrices().some((p) => p.core === profileCore && !p.free)).toBe(true);
    // The pricing seeder was asked nothing: it counted nothing; S1 served outside payment.
    expect(uploaded(gw)).toBe(gwBefore);
    expect(uploaded(net.s1)).toBe(0);
    for (const fx of [net.s1, gw]) expect(fx.seeder.bans(), `${fx.name} bans`).toEqual([]);
    // Nothing of it is counted against anyone at the viewer either.
    const credit = payer().seeders;
    expect(credit.stats().unpaid).toBe(0);
    expect(credit.router.debt(net.s1.noiseKeyHex())).toBe(0);
    expect(credit.router.debt(gw.noiseKeyHex())).toBe(0);
  }, 60_000);

  it('a free read that times out leaves NO debt against the free seeder: nothing unpaid, no lost request, its credit whole', async () => {
    // S1 takes block requests for its profile core and answers none (a stalled free seeder).
    const sc = net.s1.seeder.blobs.coreByKey(profileCore)!;
    let withheld = 0;
    const hold = (peer: { onrequest: (m: { block?: unknown }) => unknown }): void => {
      const orig = peer.onrequest.bind(peer);
      peer.onrequest = (m) => {
        if (m.block !== null && m.block !== undefined) {
          withheld++;
          return undefined;
        }
        return orig(m);
      };
    };
    const raw = sc.core as unknown as {
      replicator: { peers: { onrequest: (m: { block?: unknown }) => unknown }[] };
      on(e: 'peer-add', cb: (p: never) => void): void;
      off(e: 'peer-add', cb: (p: never) => void): void;
    };
    for (const p of raw.replicator.peers) hold(p);
    const onAdd = (p: never): void => {
      hold(p);
    };
    raw.on('peer-add', onAdd);
    try {
      const t0 = Date.now();
      const outcome = await worker
        .call('image.fetch', { url: urlB, sha256: sha(IMG_B), size: IMG_B.byteLength })
        .then(
          () => 'loaded',
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
      expect(outcome).toMatch(/^not-found/);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(READ_MS - 100);
      // The free seeder WAS asked (the read is not vacuous) and took the requests into the void.
      expect(withheld).toBeGreaterThan(0);
      const credit = payer().seeders;
      const s1 = net.s1.noiseKeyHex();
      await expect.poll(() => credit.router.inflight(s1), { timeout: 5000 }).toBe(0);
      expect(credit.router.debt(s1)).toBe(0);
      expect(credit.router.lostOf(s1)).toBe(0);
      expect(credit.router.used(s1)).toBe(0);
      expect(credit.stats().unpaid).toBe(0);
      // What the durable ledger would keep for it: nothing it may count.
      const pk = net.s1.engine.config.ownPubkey;
      for (const r of credit.seederReach()) if (r.pubkey === pk) expect(r.reach).toBe(0);
      expect(uploaded(net.s1)).toBe(0);
    } finally {
      raw.off('peer-add', onAdd);
    }
  }, 60_000);

  it('a paid core named by a thumbnail: nothing is requested from its seeders, nobody bans us — and after a restart the video plays in full, all paid, nothing owed from before', async () => {
    const outcome = await worker.call('image.fetch', videoImage).then(
      () => 'loaded',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    // No seeder said `free` for it: nobody was asked, and the read timed out (the placeholder).
    expect(outcome).toMatch(/^not-found/);
    // Its seeders said its price to us (this is not silence): the refusal is the rule, not luck.
    expect(readPrices().some((p) => p.core === videoCore && !p.free)).toBe(true);
    expect(readPrices().some((p) => p.core === videoCore && p.free)).toBe(false);
    for (const fx of [net.s1, net.s2]) {
      expect(uploaded(fx), `${fx.name} sent`).toBe(0);
      expect(fx.seeder.bans(), `${fx.name} bans`).toEqual([]);
      expect(fx.engine.bans(), `${fx.name} engine bans`).toEqual([]);
    }
    expect(payer().seeders.stats().unpaid).toBe(0);
    const own = worker.host.internals.seeder!;
    expect(own.isFreeCore(videoCore)).toBe(false);
    await expect.poll(() => own.blobs.coreByKey(videoCore), { timeout: 5000 }).toBeUndefined();

    // A restart of the viewer (the same identity, the same storage).
    await worker.close();
    worker = await start();
    const r = video.renditions[0]!;
    const sid = randomBytes(16).toString('hex') as SessionId;
    const { link } = await worker.call('play.open', {
      sid,
      videoId: video.id,
      rendition: { label: r.label, hyper: r.hyper, size: r.size },
      policy: video.price,
      prefetchSeconds: 600,
    });
    const full = await httpGet(link);
    expect(full.status).toBe(200);
    expect(createHash('sha256').update(full.body).digest('hex')).toBe(r.sha256);
    expect(await worker.call('play.close', { sid })).toEqual({ unpaid: 0 });
    // Nothing was counted from before, so nothing was reported owed; everything sent is paid.
    expect(payer().stats()).toMatchObject({ owedReported: 0, owedRecorded: 0, owed: 0 });
    for (const fx of [net.s1, net.s2]) {
      await fx.seeder.flushNow();
      const w = counted(fx)!;
      expect(w.outstanding).toBe(0);
      expect(w.banned).toBe(false);
      expect(fx.seeder.bans()).toEqual([]);
    }
  }, 90_000);
});
