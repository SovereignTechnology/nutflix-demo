/**
 * ADR 0015 — thumbnails and avatars over Pear, on a local `hyperdht` testnet (127.0.0.1 only).
 *
 * S1 (a creator's node) holds a JPEG in its profile core, marked free and announced. The desktop
 * `WorkerHost` reads it with `image.fetch`:
 *   - the bytes arrive, and length and sha256 are checked (a wrong hash is refused);
 *   - with seeding off (or `serveImages: false`) the replica it opened is closed afterwards — not
 *     announced, not replicated, never served;
 *   - with seeding on and `serveImages` on it stays open and is served free (marked free in the
 *     worker's own seeder); switching `serveImages` off releases it.
 * S1 serves the block outside payment: its engine records nothing for the viewer.
 */
import { createHash } from 'node:crypto';

import type { CoreKeyHex, Sha256Hex } from '@sovit/core';
import { manifest } from '@sovit/core';
import type { Logger, Seeder } from '@sovit/seeder';
import { createLogger, nodeFs } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import { sodiumCrypto } from '../crypto.js';
import type { DevTestnet, FixtureNet } from '../dev/fixtures-net.js';
import { startDevTestnet, startFixtureNet, syntheticBytes } from '../dev/fixtures-net.js';
import { LoopbackPayHub } from '../dev/loopback-pay.js';
import type { WorkerHost } from '../host.js';
import type { WorkerClient } from './helpers/harness.js';
import { startWorker, tempDir } from './helpers/harness.js';

const quiet: Logger = createLogger({ level: 'error', sink: () => undefined });
/** A small "JPEG" (the magic bytes, then filler): the host sniffs; the worker only hashes. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...syntheticBytes(3000, 0x1234)]);
const SHA = createHash('sha256').update(JPEG).digest('hex') as Sha256Hex;

/** The worker's own seeder (the test-only `internals` accessor). */
function workerSeeder(host: WorkerHost): Seeder {
  const s = host.internals.seeder;
  if (s === null) throw new Error('worker not initialised');
  return s;
}

describe('ADR 0015: images over Pear (creator → desktop worker)', () => {
  const teardown: (() => Promise<void>)[] = [];
  let testnet: DevTestnet;
  let net: FixtureNet;
  let worker: WorkerClient;
  let url: string;
  let core: CoreKeyHex;

  beforeAll(async () => {
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    const hub = new LoopbackPayHub();
    const fixDir = await tempDir('nf-img-fixtures-');
    const workerDir = await tempDir('nf-img-worker-');
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
      fixtures: [{ title: 'a video', bytes: syntheticBytes(65_536 * 2, 7), durationSec: 10 }],
    });
    teardown.push(() => net.close());
    // S1's profile core: the JPEG, free, announced.
    const sc = await net.s1.seeder.blobs.openCore('nutflix-profile');
    const blob = await sc.blobs.put(JPEG);
    net.s1.seeder.setFreeCore(sc.keyHex, true);
    net.s1.node.join(sc.core.discoveryKey, { server: true, client: false });
    await net.s1.node.flush();
    core = sc.keyHex;
    url = manifest.encodeHyperUrl({ core, blob });

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
  }, 60_000);

  afterAll(async () => {
    for (const close of teardown.reverse()) await close();
  }, 60_000);

  it('reads the image over Pear; with seeding off the replica is closed again (never served)', async () => {
    const before = new Set(net.s1.seeder.sessionInfos().map((i) => i.noiseKeyHex));
    const { hex } = await worker.call('image.fetch', { url, sha256: SHA, size: JPEG.byteLength });
    expect(Buffer.from(hex, 'hex').equals(Buffer.from(JPEG))).toBe(true);
    const s = workerSeeder(worker.host);
    expect(s.blobs.coreByKey(core)).toBeUndefined();
    expect(s.isFreeCore(core)).toBe(false);
    // S1 served the worker outside payment: bytes went out, no block was sold or recorded.
    const fresh = net.s1.seeder.sessionInfos().filter((i) => !before.has(i.noiseKeyHex));
    expect(fresh.length).toBeGreaterThan(0);
    for (const info of fresh) {
      expect(info.uploadedBlocks).toBe(0);
      expect(info.window?.uploaded ?? 0).toBe(0);
    }
    expect(fresh.some((i) => i.uploadedBytes >= JPEG.byteLength)).toBe(true);
  }, 60_000);

  it('refuses bytes that do not match the signed hash', async () => {
    await expect(
      worker.call('image.fetch', {
        url,
        sha256: 'e'.repeat(64) as Sha256Hex,
        size: JPEG.byteLength,
      }),
    ).rejects.toThrow(/^hash-mismatch/);
  }, 60_000);

  it('serves it free while seeding with serveImages on; switching serveImages off releases it', async () => {
    await worker.call('seeder.configure', {
      enabled: true,
      diskCapBytes: 1024 ** 3,
      serveImages: true,
    });
    await worker.call('image.fetch', { url, sha256: SHA, size: JPEG.byteLength });
    const s = workerSeeder(worker.host);
    expect(s.blobs.coreByKey(core)).toBeDefined();
    expect(s.isFreeCore(core)).toBe(true);
    await worker.call('seeder.configure', {
      enabled: true,
      diskCapBytes: 1024 ** 3,
      serveImages: false,
    });
    await expect.poll(() => s.blobs.coreByKey(core), { timeout: 5000 }).toBeUndefined();
    expect(s.isFreeCore(core)).toBe(false);
  }, 60_000);
});
