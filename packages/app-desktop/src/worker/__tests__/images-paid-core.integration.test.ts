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
 *      fixture seeders ended `{ uploaded: 6, paid: 0, windowBlocks: 5, banned: true }`. Now each
 *      seeder is asked one block at most, announces the core's price before it, and the read stops
 *      (refused): nobody is overrun, nobody bans us, and the viewer counts what they sent as unpaid;
 *   3. a second read of that core is refused at once, asking nothing more of anyone;
 *   4. the video still plays in full from the same seeders, fully paid, nobody banned;
 *   5. once played, the core is refused as an image, and never marked free on our own seeder.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { CoreKeyHex, NostrPubkey, Sha256Hex, VideoManifest } from '@sovit/core';
import { manifest } from '@sovit/core';
import type { Logger } from '@sovit/seeder';
import { createLogger, nodeFs } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import { sodiumCrypto } from '../crypto.js';
import type { DevTestnet, FixtureNet, FixtureSeeder } from '../dev/fixtures-net.js';
import { startDevTestnet, startFixtureNet, syntheticBytes } from '../dev/fixtures-net.js';
import { LoopbackPayHub } from '../dev/loopback-pay.js';
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
    const hub = new LoopbackPayHub();
    const fixDir = await tempDir('nf-r4-img-fixtures-');
    const workerDir = await tempDir('nf-r4-img-worker-');
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

    worker = startWorker({ hub, logLevel: 'error' });
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
      // …each was asked one block at most (the probe), announced as sold before it…
      expect(w?.uploaded ?? 0).toBeLessThanOrEqual(1);
      expect(w?.paid ?? 0).toBe(0); // …and browsing spends nothing.
      sent += w?.uploaded ?? 0;
    }
    // The read stops as soon as a seeder says the core is sold.
    expect(outcome).toMatch(/^forbidden/);
    expect(sent).toBeGreaterThan(0); // the probe did reach a seeder: this is not a vacuous pass
    // The viewer counts, for good, every block they may count: unpaid, or lost with a request.
    const credit = payer().seeders;
    const lost =
      credit.stats().unpaid +
      credit.router.debt(net.s1.noiseKeyHex()) +
      credit.router.debt(net.s2.noiseKeyHex());
    expect(lost).toBeGreaterThanOrEqual(sent);
    // Our own seeder never marked the video free, and the replica is gone again.
    const own = worker.host.internals.seeder!;
    expect(own.isFreeCore(videoCore)).toBe(false);
    expect(own.blobs.coreByKey(videoCore)).toBeUndefined();
  }, 60_000);

  it('a second read of that core is refused at once, asking nothing more of anyone', async () => {
    const before = [net.s1, net.s2].map((fx) => counted(fx)?.uploaded ?? 0);
    const opens = vi.spyOn(worker.host.internals.seeder!.blobs, 'openCoreByKey');
    const t0 = Date.now();
    await expect(worker.call('image.fetch', videoImage)).rejects.toThrow(/^forbidden/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect([net.s1, net.s2].map((fx) => counted(fx)?.uploaded ?? 0)).toEqual(before);
    // Refused before anything is opened: no replica, no topic joined, nothing replicated.
    expect(opens).not.toHaveBeenCalled();
    opens.mockRestore();
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
      // Everything it served is paid, except the probe block browsing never pays for.
      expect(w.outstanding).toBeLessThanOrEqual(1);
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
});
