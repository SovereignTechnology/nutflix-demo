/**
 * Fix round 4 (cross-lane review, HIGH): a thumbnail or avatar URL naming a PAID core must never
 * get the viewer banned or charged, and browsing never spends sats (Cameron). On a local
 * `hyperdht` testnet (127.0.0.1 only) with the dev fixture rig — S1 and S2 seed a 16-block paid
 * video (S1 the first half, S2 the second), and S1 also holds a free profile core with a 6-block
 * image — the desktop `WorkerHost` (dev mocks, seeding off) reads images with `image.fetch`:
 *
 *   1. an honest free image, larger than S1's window, loads, and nothing of it is counted — not by
 *      S1, not against S1's credit at the viewer (ADR 0015 serving keeps working; browsing never
 *      erodes paid playback);
 *   2. THE REVIEWER'S PROBE: one `image.fetch` naming the fixture video's core. Before the fix both
 *      fixture seeders ended `{ uploaded: 6, paid: 0, windowBlocks: 5, banned: true }`. Fix round 4
 *      asked each seeder one block (a probe) and stopped at its price. ADR 0015 amendment
 *      (2026-09-26, lane P2-owed-viewer): both say the core's price as soon as the core is open, and
 *      a seeder is asked for image blocks only after `PRICE { free: true }` — so nobody is asked
 *      anything, nobody is overrun or bans us, nothing is counted, and the read ends at its
 *      deadline (the placeholder);
 *   3. a second read of that core asks nothing of anyone either;
 *   4. the video still plays in full from the same seeders, fully paid, nobody banned;
 *   5. once played, the core is refused as an image, and never marked free on our own seeder;
 *   6. (lane W8b-p2p, round-8 review, MEDIUM) and still after a worker RESTART with seeding on —
 *      for that played video and for one we uploaded: an attacker's thumbnail URL naming either
 *      used to mark it free on our seeder, which then served the whole video free.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { CoreKeyHex, NostrPubkey, Sha256Hex, VideoManifest } from '@sovit/core';
import { manifest } from '@sovit/core';
import type { Logger, SeedCore } from '@sovit/seeder';
import { createLogger, nodeFs, toHex } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import { sodiumCrypto } from '../crypto.js';
import type { DevTestnet, FixtureNet, FixtureSeeder } from '../dev/fixtures-net.js';
import { startDevTestnet, startFixtureNet, syntheticBytes } from '../dev/fixtures-net.js';
import { LoopbackEnd, LoopbackPayHub } from '../dev/loopback-pay.js';
import type { ViewerPayer } from '../pay/viewer-payer.js';
import type { WorkerClient } from './helpers/harness.js';
import { httpGet, startWorker, tempDir } from './helpers/harness.js';

const BLOCK = 65_536;
const VIDEO_BLOCKS = 16;
const quiet: Logger = createLogger({ level: 'error', sink: () => undefined });
/** A 6-block "JPEG": more than a fixture seeder's window (the mock engine's 4). */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...syntheticBytes(6 * BLOCK - 100, 0x77)]);
const JPEG_SHA = createHash('sha256').update(JPEG).digest('hex') as Sha256Hex;

describe('fix round 4: an image URL naming a paid core (images over Pear × F33 × seeder windows)', () => {
  const teardown: (() => Promise<void>)[] = [];
  let testnet: DevTestnet;
  let net: FixtureNet;
  let worker: WorkerClient;
  let video: VideoManifest;
  let imageUrl: string;
  let videoCore: CoreKeyHex;
  let videoImage: { url: string; sha256: Sha256Hex; size: number };
  let hub: LoopbackPayHub;
  let workerStorage: string;
  /** PRICE frames the worker's pay/1 ends received: `[core, free]`. */
  let readPrices: () => [string, boolean][] = () => [];

  const payer = (): ViewerPayer => {
    const p = worker.host.internals.payer;
    if (p === null) throw new Error('worker not initialised');
    return p;
  };
  const viewerPubkey = (): NostrPubkey => {
    const p = worker.host.internals.providers;
    if (p === null) throw new Error('worker not initialised');
    return p.pubkey;
  };
  /** What a fixture seeder counts against us, from its own engine. */
  const counted = (fx: FixtureSeeder) => fx.engine.window(viewerPubkey());

  beforeAll(async () => {
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    hub = new LoopbackPayHub();
    const fixDir = await tempDir('nf-r4-img-fixtures-');
    const workerDir = await tempDir('nf-r4-img-worker-');
    workerStorage = workerDir.dir;
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
      fixtures: [
        { title: 'a paid video', bytes: syntheticBytes(VIDEO_BLOCKS * BLOCK, 9), durationSec: 16 },
      ],
    });
    teardown.push(() => net.close());
    video = net.videos[0]!;
    const entry = net.entries[0]!;
    videoCore = entry.coreKey;
    // The attacker's thumbnail: the paid video's own blob, with its true hash and size.
    videoImage = {
      url: manifest.encodeHyperUrl({ core: entry.coreKey, blob: entry.blob }),
      sha256: entry.sha256,
      size: entry.size,
    };
    // S1's profile core: the image, free, announced.
    const sc = await net.s1.seeder.blobs.openCore('nutflix-profile');
    const blob = await sc.blobs.put(JPEG);
    net.s1.seeder.setFreeCore(sc.keyHex, true);
    net.s1.node.join(sc.core.discoveryKey, { server: true, client: false });
    await net.s1.node.flush();
    imageUrl = manifest.encodeHyperUrl({ core: sc.keyHex, blob });

    // Every PRICE frame the WORKER's ends receive (they are registered under its Noise key; the
    // spy passes every frame through untouched).
    const spy = vi.spyOn(LoopbackEnd.prototype, 'receive');
    teardown.push(() => {
      spy.mockRestore();
      return Promise.resolve();
    });
    readPrices = () => {
      const node = worker.host.internals.node;
      if (node === null) return [];
      const key = toHex(node.publicKey);
      return spy.mock.calls.flatMap(([w], i) => {
        const end = spy.mock.contexts[i] as LoopbackEnd;
        if (w.t !== 'price' || !end.id.endsWith(`:${key}`)) return [];
        return [[w.m.core, w.m.free === true] as [string, boolean]];
      });
    };
    // Image reads here end at their deadline when nobody serves the core free: 2.5 s, not 15.
    worker = startWorker({ hub, logLevel: 'error', imageTimeoutMs: 2500 });
    teardown.push(() => worker.close());
    await worker.call('init', {
      v: 1,
      storage: workerDir.dir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
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
  }, 90_000);

  afterAll(async () => {
    for (const close of teardown.reverse()) await close();
  }, 60_000);

  it('an honest free image larger than the seeder’s window loads; nothing of it is counted, by S1 or against S1’s credit', async () => {
    const own = worker.host.internals.seeder!;
    const marks = vi.spyOn(own, 'setFreeCore');
    const { hex } = await worker.call('image.fetch', {
      url: imageUrl,
      sha256: JPEG_SHA,
      size: JPEG.byteLength,
    });
    expect(Buffer.from(hex, 'hex').equals(Buffer.from(JPEG))).toBe(true);
    // Fix round 4 (LOW): with serving off, the replica was still served on every connection
    // during the read — and counted. It is free while open now, then closed and unmarked.
    const core = manifest.decodeHyperUrl(imageUrl, JPEG.byteLength)!.core;
    await expect.poll(() => own.blobs.coreByKey(core), { timeout: 5000 }).toBeUndefined();
    // (Our own profile core is marked free at init, possibly while this ran: not this read's.)
    const ofCore = () => marks.mock.calls.filter(([c]) => c === core);
    await expect.poll(() => ofCore().length, { timeout: 5000 }).toBe(2);
    expect(ofCore()).toEqual([
      [core, true],
      [core, false],
    ]);
    marks.mockRestore();
    // S1 served it outside payment.
    expect(counted(net.s1)?.uploaded ?? 0).toBe(0);
    // …and the viewer never counted it against S1: its playback credit is whole.
    expect(payer().seeders.stats().unpaid).toBe(0);
    expect(payer().seeders.router.debt(net.s1.noiseKeyHex())).toBe(0);
  }, 60_000);

  // Lane W8b-p2p (round-8 review, LOW): two thumbnails of one profile core read at once opened two
  // Hypercore sessions; the upload gate moved to the second, the release closed only the second,
  // and the first stayed open and replicating with no gate — against ADR 0015's "neither
  // announced nor replicated" when serving is off.
  it('two reads of one profile core at once share one session, and with serving off that session is closed when the last read ends', async () => {
    const own = worker.host.internals.seeder!;
    const core = manifest.decodeHyperUrl(imageUrl, JPEG.byteLength)!.core;
    expect(own.blobs.coreByKey(core)).toBeUndefined(); // closed after the first test's read
    const opened: SeedCore[] = [];
    const real = own.blobs.openCoreByKey.bind(own.blobs);
    own.blobs.openCoreByKey = async (key: Uint8Array): Promise<SeedCore> => {
      const sc = await real(key);
      opened.push(sc);
      return sc;
    };
    try {
      const args = { url: imageUrl, sha256: JPEG_SHA, size: JPEG.byteLength };
      const [a, b] = await Promise.all([
        worker.call('image.fetch', args),
        worker.call('image.fetch', args),
      ]);
      expect(a.hex).toBe(b.hex);
      await expect.poll(() => own.blobs.coreByKey(core), { timeout: 5000 }).toBeUndefined();
      const ofCore = opened.filter((sc) => sc.keyHex === core);
      expect(ofCore).toHaveLength(2);
      expect(new Set(ofCore.map((sc) => sc.core)).size).toBe(1); // one session
      expect(ofCore.every((sc) => sc.core.closed)).toBe(true); // nothing left replicating
      expect(own.isFreeCore(core)).toBe(false);
    } finally {
      own.blobs.openCoreByKey = real;
    }
  }, 60_000);

  it("the reviewer's probe: image.fetch naming the paid video's core is refused, and neither fixture seeder is overrun or bans us", async () => {
    const outcome = await worker.call('image.fetch', videoImage).then(
      () => 'loaded',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    let sent = 0;
    for (const fx of [net.s1, net.s2]) {
      const w = counted(fx);
      // Nobody bans us (before the fix: both did, at window+1)…
      expect(fx.seeder.bans(), `${fx.name} bans`).toEqual([]);
      expect(fx.engine.bans(), `${fx.name} engine bans`).toEqual([]);
      if (w !== undefined) {
        expect(w.banned).toBe(false);
        expect(w.outstanding).toBeLessThanOrEqual(w.windowBlocks);
      }
      // …nobody was asked anything (ADR 0015 amendment: no probe — fix round 4 allowed one block
      // here, and its check that the probe reached a seeder is replaced by the one below)…
      sent += w?.uploaded ?? 0;
      expect(w?.paid ?? 0).toBe(0); // …and browsing spends nothing.
    }
    expect(sent).toBe(0);
    // No seeder said `free` for it: the read ends at its deadline (fix round 4 stopped it at a
    // seeder's price, and so a price from a gateway also stopped an honest free image).
    expect(outcome).toMatch(/^not-found/);
    // Not a vacuous pass (it replaces fix round 4's "the probe reached a seeder"): the seeders
    // said the core's price to us, and nobody said `free` for it.
    expect(readPrices().some(([c, free]) => c === videoCore && !free)).toBe(true);
    expect(readPrices().some(([c, free]) => c === videoCore && free)).toBe(false);
    // The viewer counts nothing against either of them.
    const credit = payer().seeders;
    expect(credit.stats().unpaid).toBe(0);
    expect(credit.router.debt(net.s1.noiseKeyHex())).toBe(0);
    expect(credit.router.debt(net.s2.noiseKeyHex())).toBe(0);
    // Our own seeder never marked the video free, and the replica is gone again.
    const own = worker.host.internals.seeder!;
    expect(own.isFreeCore(videoCore)).toBe(false);
    expect(own.blobs.coreByKey(videoCore)).toBeUndefined();
  }, 60_000);

  // Fix round 4 refused a second read at once, from its memory of a seeder's price on the image
  // path. That memory went with the probe (ADR 0015 amendment, lane P2-owed-viewer): it also
  // refused an honest free image for good once a gateway that prices it had answered first. A
  // second read now costs what the first did — nothing at any seeder.
  it('a second read of that core asks nothing of anyone either', async () => {
    const before = [net.s1, net.s2].map((fx) => counted(fx)?.uploaded ?? 0);
    await expect(worker.call('image.fetch', videoImage)).rejects.toThrow(/^not-found/);
    expect([net.s1, net.s2].map((fx) => counted(fx)?.uploaded ?? 0)).toEqual(before);
    expect(before).toEqual([0, 0]);
    for (const fx of [net.s1, net.s2]) expect(fx.seeder.bans()).toEqual([]);
    expect(payer().seeders.stats().unpaid).toBe(0);
  }, 60_000);

  it('the video still plays in full from the same seeders afterwards: every block it downloads is paid, nobody is banned', async () => {
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
    await worker.call('play.close', { sid });
    for (const fx of [net.s1, net.s2]) {
      await fx.seeder.flushNow();
      const w = counted(fx)!;
      // Everything it served is paid (fix round 4 allowed one probe block unpaid here; with no
      // probe, nothing is left).
      expect(w.outstanding).toBe(0);
      expect(w.outstanding).toBeLessThanOrEqual(w.windowBlocks);
      expect(w.banned).toBe(false);
      expect(fx.seeder.bans()).toEqual([]);
    }
    expect(payer().stats()).toMatchObject({ owed: 0, acksRejected: 0 });
  }, 60_000);

  it('once played, the core is refused as an image, and it is never marked free on our own seeder', async () => {
    await expect(worker.call('image.fetch', videoImage)).rejects.toThrow(/^forbidden/);
    expect(worker.host.internals.seeder!.isFreeCore(videoCore)).toBe(false);
    // The honest image still loads (from our replica or S1).
    const { hex } = await worker.call('image.fetch', {
      url: imageUrl,
      sha256: JPEG_SHA,
      size: JPEG.byteLength,
    });
    expect(hex.length).toBe(JPEG.byteLength * 2);
  }, 60_000);

  // Fix round 4 (INFO): `releaseImageCore` checked only `coresAttached`, which a play open sets
  // AFTER awaiting the open — a release in between closed the core under it. The policy a play
  // open sets before any await now claims it.
  it('a play open racing the release of an image replica keeps it open, and ends its free serving', async () => {
    await worker.call('seeder.configure', {
      enabled: true,
      diskCapBytes: 1024 ** 3,
      serveImages: true,
    });
    await worker.call('image.fetch', { url: imageUrl, sha256: JPEG_SHA, size: JPEG.byteLength });
    const own = worker.host.internals.seeder!;
    const ref = manifest.decodeHyperUrl(imageUrl, JPEG.byteLength)!;
    expect(own.isFreeCore(ref.core)).toBe(true); // an image replica, served free
    // A (hostile) manifest names that profile core as a video: the open starts, and while it
    // awaits the core, serving images is switched off (which releases the idle replicas).
    const sid = randomBytes(16).toString('hex') as SessionId;
    const opening = worker.call('play.open', {
      sid,
      videoId: video.id,
      rendition: { label: 'x', hyper: { core: ref.core, blob: ref.blob }, size: JPEG.byteLength },
      policy: video.price,
      prefetchSeconds: 30,
    });
    const configuring = worker.call('seeder.configure', {
      enabled: true,
      diskCapBytes: 1024 ** 3,
      serveImages: false,
    });
    const [{ link }] = await Promise.all([opening, configuring]);
    await new Promise((r) => setTimeout(r, 200)); // any release has run by now
    expect(own.blobs.coreByKey(ref.core)).toBeDefined();
    expect(own.isFreeCore(ref.core)).toBe(false); // it has a price now: sold, never free
    const got = await httpGet(link);
    expect(got.status).toBe(200);
    expect(Buffer.from(got.body).equals(Buffer.from(JPEG))).toBe(true);
    await worker.call('play.close', { sid });
  }, 60_000);

  // Lane W8b-p2p (round-8 review, MEDIUM): per-core prices lived in memory only, so after a
  // restart nothing here knew the played video was sold; an attacker's thumbnail naming it marked
  // it free on our seeder (seeding on keeps the replica open), and anyone downloaded the whole
  // video from us for nothing. The same for a video we uploaded. Reproduced before the fix: the
  // read returned the video's bytes ('loaded') and `isFreeCore` was true.
  it('after a worker restart with seeding on, an image URL naming a video we played or uploaded is refused and never served free', async () => {
    const own = worker.host.internals.seeder!;
    // Our own upload, as `upload()` leaves it at the seeder: the rendition stored, its core priced.
    const put = await own.putBytes(syntheticBytes(3 * BLOCK, 0x33));
    if (!put.ok) throw new Error('put failed');
    own.setCorePolicy(put.entry.coreKey, video.price);
    const uploadImage = {
      url: manifest.encodeHyperUrl({ core: put.entry.coreKey, blob: put.entry.blob }),
      sha256: put.entry.sha256,
      size: put.entry.size,
    };
    await worker.close();
    worker = startWorker({ hub, logLevel: 'error', imageTimeoutMs: 2500 });
    await worker.call('init', {
      v: 1,
      storage: workerStorage,
      seeding: { enabled: true, diskCapBytes: 1024 ** 3, serveImages: true },
      prefetchSeconds: 30,
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
    const again = worker.host.internals.seeder!;
    for (const img of [videoImage, uploadImage]) {
      const core = manifest.decodeHyperUrl(img.url, img.size)!.core;
      const outcome = await worker.call('image.fetch', img).then(
        () => 'loaded',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(outcome).toMatch(/^forbidden/);
      expect(again.isFreeCore(core)).toBe(false);
      expect(again.setFreeCore(core, true)).toBe(false); // the seeder itself refuses it
      expect(again.corePolicyMap().has(core)).toBe(true);
    }
    // The rule is the same one as before the restart: the profile core the test above played
    // under a (hostile) manifest got a price then, and it is still sold now…
    await expect(
      worker.call('image.fetch', { url: imageUrl, sha256: JPEG_SHA, size: JPEG.byteLength }),
    ).rejects.toThrow(/^forbidden/);
    // …while an honest image core nobody priced still loads, and is served free by us.
    const sc = await net.s1.seeder.blobs.openCore('nutflix-profile-2');
    const blob = await sc.blobs.put(JPEG);
    net.s1.seeder.setFreeCore(sc.keyHex, true);
    net.s1.node.join(sc.core.discoveryKey, { server: true, client: false });
    await net.s1.node.flush();
    const { hex } = await worker.call('image.fetch', {
      url: manifest.encodeHyperUrl({ core: sc.keyHex, blob }),
      sha256: JPEG_SHA,
      size: JPEG.byteLength,
    });
    expect(Buffer.from(hex, 'hex').equals(Buffer.from(JPEG))).toBe(true);
    expect(again.isFreeCore(sc.keyHex)).toBe(true); // an image replica, served free
  }, 90_000);

  // Lane W8b-p2p: kept across restarts, a price on OUR OWN profile core (a hostile manifest naming
  // it as a video) would stay for good, and our avatar and thumbnails would never be served free
  // again. A play open naming it is refused, and a price an earlier run left on it is dropped.
  it('our own profile core is never priced: a play open naming it is refused, and a price an earlier run left on it is dropped at start', async () => {
    const own = worker.host.internals.seeder!;
    const profile = (await own.openCore('nutflix-profile')).keyHex;
    await expect.poll(() => own.isFreeCore(profile), { timeout: 5000 }).toBe(true);
    const sid = randomBytes(16).toString('hex') as SessionId;
    await expect(
      worker.call('play.open', {
        sid,
        videoId: video.id,
        rendition: {
          label: 'x',
          hyper: { core: profile, blob: video.renditions[0]!.hyper.blob },
          size: video.renditions[0]!.size,
        },
        policy: video.price,
        prefetchSeconds: 30,
      }),
    ).rejects.toThrow(/^forbidden/);
    expect(own.corePolicyMap().has(profile)).toBe(false);
    expect(own.isFreeCore(profile)).toBe(true);
    // What an earlier run could have left (the manifest played before the core was open).
    own.setCorePolicy(profile, video.price);
    await worker.close();
    worker = startWorker({ hub, logLevel: 'error', imageTimeoutMs: 2500 });
    await worker.call('init', {
      v: 1,
      storage: workerStorage,
      seeding: { enabled: true, diskCapBytes: 1024 ** 3, serveImages: true },
      prefetchSeconds: 30,
      dev: {
        mocks: true,
        fixtures: false,
        bootstrap: testnet.bootstrap.map((b) => ({ host: '127.0.0.1' as const, port: b.port })),
      },
    });
    const next = worker.host.internals.seeder!;
    await expect.poll(() => next.isFreeCore(profile), { timeout: 5000 }).toBe(true);
    expect(next.corePolicyMap().has(profile)).toBe(false);
  }, 90_000);
});
