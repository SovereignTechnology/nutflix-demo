/**
 * Lane W8b-p2p, round 9 (F57): a core in this seeder's storage that it has not opened in this run
 * is never served — and once opened, it is served only through the upload gate: its `PRICE` first,
 * every block counted.
 *
 * Before the fix, Corestore 7.12.2's `replicate` answered a remote's channel open for ANY discovery
 * key in storage (`ondiscoverykey` → `_attachMaybe`): it opened the core without a Hypercore
 * session and attached its replicator, so `BlobStore.onCoreOpened` never ran — no upload gate, no
 * `PRICE`, nothing counted. After a restart, a sold core that had not been played or uploaded again
 * was served free to any connected peer that knew its key. Real Corestore / Hypercore / Hyperblobs
 * on tmp dirs, over DIRECTLY PIPED streams: nothing leaves the process.
 *
 * Both entry points are covered: `Seeder.replicate` (the gateway's WS bridge) and
 * `blobs.store.replicate` (the desktop worker's `PeerNode`, the daemon's and the gateway's swarm).
 *
 * WRITTEN, NOT RUN: Cameron's rule of 2026-09-27 allows no test runner on this machine. These run
 * in CI; what each assertion catches is reasoned in the review record (round 9).
 */
import { mocks } from '@sovit/core';
import type { PricePolicy } from '@sovit/core';
import type { ReplicationStream } from 'hypercore';
import DHT from 'hyperdht';
import { afterEach, describe, expect, it } from 'vitest';

import { Seeder } from '../seeder.js';
import { toHex } from '../util/hex.js';
import { FakePayProtocol, hello } from './fake-pay-protocol.js';
import { adapters, tmpDir } from './helpers.js';

const BLOCK = 1024;
const BLOCKS = 4;
const PRICE = 3;
/** Stable Noise identity for the viewer, so its session is found by key. */
const VIEWER_KEYS = DHT.keyPair(new Uint8Array(32).fill(57));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function seederOn(
  dataDir: string,
): Promise<{ seeder: Seeder; engine: mocks.MockPaymentEngine }> {
  const engine = new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks: 100 } });
  const seeder = await Seeder.create(
    {
      dataDir,
      diskCapBytes: 1024 * 1024,
      blockSize: BLOCK,
      swarm: null,
      flushEveryBlocks: 1000,
      flushEveryMs: 60_000,
    },
    { engine, ...adapters },
  );
  seeder.start();
  cleanups.push(() => seeder.close()); // idempotent
  return { seeder, engine };
}

async function freshSeeder(): Promise<{ seeder: Seeder; engine: mocks.MockPaymentEngine }> {
  const t = await tmpDir();
  cleanups.push(t.rm); // runs after the seeder's close (cleanups run in reverse)
  return seederOn(t.dir);
}

/**
 * Run 1 stores a 4-block blob and sells its core at 3 sat, then closes (the policy is kept on
 * disk). Run 2 starts on the same `dataDir` and does NOT open the core: it is only in storage.
 */
async function soldThenRestarted(): Promise<{
  seeder: Seeder;
  engine: mocks.MockPaymentEngine;
  core: string;
}> {
  const t = await tmpDir();
  cleanups.push(t.rm);
  const first = await seederOn(t.dir);
  const data = new Uint8Array(BLOCK * BLOCKS).map((_, i) => (i * 13 + 5) % 256);
  const put = await first.seeder.putBytes(data, { mime: 'video/mp4' });
  if (!put.ok) throw new Error(`put failed: ${put.error.code}`);
  const core = put.entry.coreKey;
  const policy: PricePolicy = {
    satsPerBlock: PRICE as PricePolicy['satsPerBlock'],
    blockSize: BLOCK,
    mints: first.engine.config.acceptedMints,
    split: { seeder: 50, creator: 50 },
    creatorP2pk: mocks.asP2pk('creator-f57'),
  };
  first.seeder.setCorePolicy(core, policy);
  await first.seeder.close(); // waits for the policy file
  const second = await seederOn(t.dir);
  // The premise: sold (the policy is back), in storage, and not open in this run.
  expect(second.seeder.corePolicyMap().get(core)?.satsPerBlock).toBe(PRICE);
  expect(second.seeder.blobs.coreByKey(core)).toBeUndefined();
  return { seeder: second.seeder, engine: second.engine, core };
}

function pipe(a: ReplicationStream, b: ReplicationStream): void {
  a.on('error', () => undefined);
  b.on('error', () => undefined);
  a.pipe(b).pipe(a);
}

describe('F57: a stored core not opened in this run is never served', () => {
  it('Seeder.replicate (the gateway WS bridge): refused while not open; once opened, served through the gate — PRICE first, every block counted', async () => {
    const s = await soldThenRestarted();
    const viewer = await freshSeeder();
    const vcore = await viewer.seeder.blobs.openCoreByKey(Buffer.from(s.core, 'hex'));

    const sa = s.seeder.replicate(true);
    const sb = viewer.seeder.replicate(false, { keyPair: VIEWER_KEYS });
    pipe(sa, sb);
    await sb.noiseStream.opened;
    await settle(50);
    const session = s.seeder.session(toHex(VIEWER_KEYS.publicKey));
    if (session === undefined) throw new Error('the viewer was not admitted');
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    const viewerPubkey = mocks.asPubkey('f57-viewer');
    protocol.remoteHello(hello(viewerPubkey));

    // Not open here: the viewer's ask for it by discovery key is refused. Before the fix, Corestore
    // opened it from storage and served block 0 with no gate: `got` was the block.
    const got = await vcore.core.get(0, { wait: true, timeout: 1500 }).catch((e: unknown) => e);
    expect(got).not.toBeInstanceOf(Uint8Array);
    await settle();
    expect(await vcore.core.has(0)).toBe(false);
    expect(session.uploadedBlocks).toBe(0);
    expect(s.engine.window(viewerPubkey)?.uploaded ?? 0).toBe(0);
    expect(protocol.prices.filter((p) => p.core === s.core)).toEqual([]);

    // Opened in this run (as a play or an upload opens it): Corestore attaches it to the live
    // stream, and every block goes through the gate — the core's PRICE is out before it.
    const sc = await s.seeder.openCore();
    expect(sc.keyHex).toBe(s.core);
    const pricedAtUpload: boolean[] = [];
    // Added after the gate's listener (attached at open), so it runs after the gate has spoken.
    sc.core.on('upload', () => {
      pricedAtUpload.push(
        protocol.prices.some(
          (p) => p.core === s.core && p.free !== true && p.satsPerBlock === PRICE,
        ),
      );
    });
    expect(await vcore.core.get(0, { wait: true, timeout: 5000 })).not.toBeNull();
    await settle(50);
    expect(pricedAtUpload.length).toBeGreaterThan(0);
    expect(pricedAtUpload.every(Boolean)).toBe(true);
    expect(protocol.prices.find((p) => p.core === s.core)).toMatchObject({
      satsPerBlock: PRICE,
      effectiveFromBlock: 0,
    });
    expect(session.uploadedBlocks).toBeGreaterThan(0);
    expect(s.engine.window(viewerPubkey)?.uploaded).toBe(session.uploadedBlocks);
    expect(session.cutReason).toBeNull();
  });

  it('blobs.store.replicate (the desktop PeerNode, the daemon and gateway swarms): refused while not open; once opened, served and counted', async () => {
    const s = await soldThenRestarted();
    const viewer = await freshSeeder();
    const vcore = await viewer.seeder.blobs.openCoreByKey(Buffer.from(s.core, 'hex'));

    const sa = s.seeder.blobs.store.replicate(true);
    const sb = viewer.seeder.blobs.store.replicate(false);
    pipe(sa, sb);
    await sb.noiseStream.opened;

    // Before the fix: served from storage, ungated (the same `_attachMaybe` path).
    const got = await vcore.core.get(0, { wait: true, timeout: 1500 }).catch((e: unknown) => e);
    expect(got).not.toBeInstanceOf(Uint8Array);
    await settle();
    expect(await vcore.core.has(0)).toBe(false);

    await s.seeder.openCore();
    expect(await vcore.core.get(0, { wait: true, timeout: 5000 })).not.toBeNull();
    await settle(50);
    // A stream handed to the store directly is admitted at its first upload, by the gate.
    const viewerNoise = sb.noiseStream.publicKey;
    if (viewerNoise === null) throw new Error('no Noise key on the viewer stream');
    expect(s.seeder.session(toHex(viewerNoise))?.uploadedBlocks).toBeGreaterThan(0);
  });
});
