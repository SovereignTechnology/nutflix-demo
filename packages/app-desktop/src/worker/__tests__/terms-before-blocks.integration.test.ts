/**
 * Contracts v6 amendment (Cameron 2026-09-26; ADRs 0015 and 0018 amendments) on the desktop
 * worker's own net layer: two `PeerNode`s (the class the worker and the dev fixtures run) on a
 * local hyperdht testnet — real hyperswarm connections, nothing leaves loopback — each with the
 * PRODUCTION `pay/1` wiring shape (`real-providers.ts`: a real `PayChannel` per connection, a HELLO
 * signed over that connection's handshake). Node A seeds like the worker does: a video core at its
 * manifest price (`setCorePolicy`) and a profile core served free (`setFreeCore`, ADR 0015). Node B
 * reads both, and must receive each core's PRICE before the core's first block — priced for the
 * video, `{ free: true }` for the profile core — while A counts only the video's blocks.
 *
 * The same for the `--dev-fixtures` seeders (`createFixtureSeeder`): their `pay/1` is the
 * in-process loopback hub, and the PRICE a fixture sends from inside its upload gate still reaches
 * the reader before the block.
 */
import { DEFAULT_BLOCK_SIZE, mocks, payProtocol, signer as signerMod } from '@sovit/core';
import type { CashuP2pkPubkey, PriceMessage, PricePolicy, Sats } from '@sovit/core';
import { Seeder, nodeFs, silentLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sodiumCrypto } from '../crypto.js';
import type { DevTestnet } from '../dev/fixtures-net.js';
import { createFixtureSeeder, devFixturePolicy, startDevTestnet } from '../dev/fixtures-net.js';
import { LoopbackPayHub } from '../dev/loopback-pay.js';
import type { PayLink } from '../net/peer-node.js';
import { PeerNode } from '../net/peer-node.js';
import { sleep, tempDir, within } from './helpers/harness.js';

vi.setConfig({ testTimeout: 60_000 });

const BLOCK = DEFAULT_BLOCK_SIZE;
const cleanups: (() => Promise<void>)[] = [];

/** Polls `cond` until it holds, failing clearly after `ms` (the loop stops either way). */
async function poll(cond: () => boolean, ms: number, what: string): Promise<void> {
  const loop = { stop: false };
  try {
    await within(
      (async () => {
        while (!loop.stop && !cond()) await sleep(20);
      })(),
      ms,
      what,
    );
  } finally {
    loop.stop = true;
  }
}

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function peer(
  testnet: DevTestnet,
  name: string,
  onChannel?: (c: payProtocol.PayChannel) => void,
) {
  const t = await tempDir(`nutflix-terms-${name}-`);
  const engine = new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks: 16 } });
  const seeder = await Seeder.create(
    { dataDir: t.dir, diskCapBytes: 1 << 24, swarm: null },
    { engine, fs: nodeFs, crypto: sodiumCrypto, logger: silentLogger },
  );
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: new TextEncoder().encode(`terms ${name}`),
    cost: signerMod.minimumCost(),
  });
  const node = new PeerNode({
    seeder,
    logger: silentLogger,
    bootstrap: testnet.bootstrap,
    loopbackOnly: true,
    pay: {
      protocol: () => {
        const c = new payProtocol.PayChannel();
        onChannel?.(c);
        return c;
      },
      hello: (binding) => {
        if (binding === null) throw new Error('no Noise handshake on this connection');
        return payProtocol.buildHello(signer, binding, {
          acceptedMints: [mocks.MINTS.a],
          satsPerBlock: 2 as Sats,
          split: { seeder: 50, creator: 50 },
          p2pk: engine.config.ownP2pk,
          windowBlocks: 16,
        });
      },
    },
  });
  seeder.start();
  node.start();
  cleanups.push(async () => {
    await node.destroy();
    await seeder.close();
    await t.rm();
  });
  return { seeder, node, engine, pubkey: await signer.getPublicKey() };
}

describe("contracts v6 amendment on the desktop worker's PeerNode (real hyperswarm, loopback)", () => {
  it("a viewer receives each core's PRICE before its first block: priced for a video at its manifest price, { free: true } for a profile core", async () => {
    const testnet = await startDevTestnet();
    cleanups.push(() => testnet.destroy());
    const a = await peer(testnet, 'a');
    const policy: PricePolicy = {
      satsPerBlock: 3 as Sats,
      blockSize: BLOCK,
      mints: [mocks.MINTS.a],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: ('02' + 'c7'.repeat(32)) as CashuP2pkPubkey,
    };
    const video = new Uint8Array(BLOCK * 3).map((_, i) => (i * 7 + 1) % 256);
    const put = await a.seeder.putBytes(video, { mime: 'video/mp4' });
    if (!put.ok) throw new Error('put failed');
    const paid = put.entry.coreKey;
    a.seeder.setCorePolicy(paid, policy);
    const profile = await a.seeder.openCore('nutflix-profile');
    const image = await profile.blobs.put(new Uint8Array(BLOCK * 2).fill(5));
    expect(a.seeder.setFreeCore(profile.keyHex, true)).toBe(true);
    const name = (c: string): string => (c === paid ? 'paid' : c === profile.keyHex ? 'free' : '?');
    for (const k of [paid, profile.keyHex])
      a.node.join(a.seeder.blobs.coreByKey(k)!.core.discoveryKey, { server: true, client: false });
    await a.node.flush();

    const seen: string[] = [];
    const b = await peer(testnet, 'b', (c) => {
      c.on('price', (p: PriceMessage) =>
        seen.push(`price:${name(p.core)}:${p.free === true ? 'free' : String(p.satsPerBlock)}`),
      );
    });
    const vpaid = await b.seeder.blobs.openCoreByKey(Buffer.from(paid, 'hex'));
    const vfree = await b.seeder.blobs.openCoreByKey(Buffer.from(profile.keyHex, 'hex'));
    for (const [vc, n] of [
      [vpaid, 'paid'],
      [vfree, 'free'],
    ] as const) {
      vc.core.on('download', (i: number) => seen.push(`download:${n}:${String(i)}`));
      b.node.join(vc.core.discoveryKey, { server: false, client: true });
    }
    await b.node.flush();
    for (let i = image.blockOffset; i < image.blockOffset + image.blockLength; i++)
      expect(await vfree.core.get(i, { wait: true, timeout: 10_000 })).not.toBeNull();
    for (let i = 0; i < 3; i++)
      expect(await vpaid.core.get(i, { wait: true, timeout: 10_000 })).not.toBeNull();
    await poll(() => seen.filter((e) => e.startsWith('download:')).length >= 5, 5000, 'downloads');

    for (const n of ['paid', 'free']) {
      const price = seen.findIndex((e) => e.startsWith(`price:${n}:`));
      expect(price, seen.join(' ')).toBeGreaterThanOrEqual(0);
      expect(seen.findIndex((e) => e.startsWith(`download:${n}:`))).toBeGreaterThan(price);
      expect(seen.filter((e) => e.startsWith(`price:${n}:`))).toHaveLength(1);
    }
    expect(seen).toContain('price:paid:3');
    expect(seen).toContain('price:free:free');
    // A counted the video's three blocks for B's HELLO pubkey, and none of the profile core's.
    await poll(() => a.engine.window(b.pubkey)?.uploaded === 3, 5000, 'B bound on A');
    expect(a.engine.unpaid(b.pubkey)).toEqual([{ core: paid, ranges: [[0, 2]] }]);
  });

  // ADR 0015 amendment: a viewer's image read asks a peer for blocks only after its
  // `PRICE { free: true }`, with no probe — so the terms must come with nothing asked (independent
  // review 2026-09-27).
  it('a viewer that opens both cores and asks for NOTHING receives their terms: { free: true } for the profile core, the price for the video — nothing downloaded, nothing counted', async () => {
    const testnet = await startDevTestnet();
    cleanups.push(() => testnet.destroy());
    const a = await peer(testnet, 'a');
    const policy: PricePolicy = {
      satsPerBlock: 4 as Sats,
      blockSize: BLOCK,
      mints: [mocks.MINTS.a],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: ('02' + 'c7'.repeat(32)) as CashuP2pkPubkey,
    };
    const put = await a.seeder.putBytes(new Uint8Array(BLOCK * 2).fill(8), { mime: 'video/mp4' });
    if (!put.ok) throw new Error('put failed');
    const paid = put.entry.coreKey;
    a.seeder.setCorePolicy(paid, policy);
    const profile = await a.seeder.openCore('nutflix-profile');
    await profile.blobs.put(new Uint8Array(BLOCK).fill(6));
    expect(a.seeder.setFreeCore(profile.keyHex, true)).toBe(true);
    const name = (c: string): string => (c === paid ? 'paid' : c === profile.keyHex ? 'free' : '?');
    for (const k of [paid, profile.keyHex])
      a.node.join(a.seeder.blobs.coreByKey(k)!.core.discoveryKey, { server: true, client: false });
    await a.node.flush();

    const seen: string[] = [];
    const b = await peer(testnet, 'b', (c) => {
      c.on('price', (p: PriceMessage) =>
        seen.push(`price:${name(p.core)}:${p.free === true ? 'free' : String(p.satsPerBlock)}`),
      );
    });
    for (const k of [paid, profile.keyHex]) {
      const vc = await b.seeder.blobs.openCoreByKey(Buffer.from(k, 'hex'));
      vc.core.on('download', (i: number) => seen.push(`download:${name(k)}:${String(i)}`));
      b.node.join(vc.core.discoveryKey, { server: false, client: true });
    }
    await b.node.flush();
    await poll(() => seen.length >= 2, 10_000, 'both PRICEs, unprompted');
    await sleep(200); // anything more would show here
    expect([...seen].sort()).toEqual(['price:free:free', 'price:paid:4']);
    expect(a.engine.window(b.pubkey)?.uploaded ?? 0).toBe(0);
  });

  for (const ask of [true, false])
    it(
      ask
        ? 'the dev fixtures do the same over the loopback pay/1 hub: PRICE (priced, or free) before the first block of each core'
        : "the dev fixtures say both cores' terms with NOTHING asked (ADR 0015 amendment: an image read waits for { free: true })",
      async () => {
        const testnet = await startDevTestnet();
        cleanups.push(() => testnet.destroy());
        const seen: string[] = [];
        let readerNoise = '';
        let name = (_c: string): string => '?';
        /** Records the PRICEs the READER's ends receive. */
        class RecordingHub extends LoopbackPayHub {
          override endpoint(link: PayLink) {
            const end = super.endpoint(link);
            if (link.localNoise === readerNoise)
              end.on('price', (p: PriceMessage) =>
                seen.push(
                  `price:${name(p.core)}:${p.free === true ? 'free' : String(p.satsPerBlock)}`,
                ),
              );
            return end;
          }
        }
        const hub = new RecordingHub();
        const fixture = async (n: string) => {
          const t = await tempDir(`nutflix-terms-fx-${n}-`);
          const f = await createFixtureSeeder({
            name: n,
            dataDir: t.dir,
            fs: nodeFs,
            crypto: sodiumCrypto,
            hub,
            bootstrap: testnet.bootstrap,
            logger: silentLogger,
            policy: devFixturePolicy(),
            windowBlocks: 16,
          });
          cleanups.push(async () => {
            await f.close();
            await t.rm();
          });
          return f;
        };
        const a = await fixture('a');
        const put = await a.seeder.putBytes(new Uint8Array(BLOCK * 2).fill(9), {
          mime: 'video/mp4',
        });
        if (!put.ok) throw new Error('put failed');
        const paid = put.entry.coreKey;
        const profile = await a.seeder.openCore('nutflix-profile');
        const image = await profile.blobs.put(new Uint8Array(BLOCK * 2).fill(4));
        expect(a.seeder.setFreeCore(profile.keyHex, true)).toBe(true);
        name = (c) => (c === paid ? 'paid' : c === profile.keyHex ? 'free' : '?');
        for (const k of [paid, profile.keyHex])
          a.node.join(a.seeder.blobs.coreByKey(k)!.core.discoveryKey, {
            server: true,
            client: false,
          });
        await a.node.flush();
        const b = await fixture('b');
        readerNoise = b.noiseKeyHex();
        const vpaid = await b.seeder.blobs.openCoreByKey(Buffer.from(paid, 'hex'));
        const vfree = await b.seeder.blobs.openCoreByKey(Buffer.from(profile.keyHex, 'hex'));
        for (const [vc, n] of [
          [vpaid, 'paid'],
          [vfree, 'free'],
        ] as const) {
          vc.core.on('download', (i: number) => seen.push(`download:${n}:${String(i)}`));
          b.node.join(vc.core.discoveryKey, { server: false, client: true });
        }
        await b.node.flush();
        if (!ask) {
          await poll(() => seen.length >= 2, 10_000, 'both PRICEs, unprompted');
          await sleep(200); // anything more would show here
          expect([...seen].sort()).toEqual([
            'price:free:free',
            `price:paid:${String(devFixturePolicy().satsPerBlock)}`,
          ]);
          return;
        }
        for (let i = image.blockOffset; i < image.blockOffset + image.blockLength; i++)
          expect(await vfree.core.get(i, { wait: true, timeout: 10_000 })).not.toBeNull();
        for (let i = 0; i < 2; i++)
          expect(await vpaid.core.get(i, { wait: true, timeout: 10_000 })).not.toBeNull();
        for (const n of ['paid', 'free']) {
          const price = seen.findIndex((e) => e.startsWith(`price:${n}:`));
          expect(price, seen.join(' ')).toBeGreaterThanOrEqual(0);
          expect(seen.findIndex((e) => e.startsWith(`download:${n}:`))).toBeGreaterThan(price);
        }
        expect(seen).toContain(`price:paid:${String(devFixturePolicy().satsPerBlock)}`);
        expect(seen).toContain('price:free:free');
      },
    );
});
