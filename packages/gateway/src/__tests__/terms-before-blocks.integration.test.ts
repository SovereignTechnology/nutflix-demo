/**
 * Contracts v6 amendment (Cameron 2026-09-26; ADRs 0015 and 0018 amendments) on the GATEWAY's own
 * seeder, over a real replication stream: the gateway attaches a real `PayChannel` (its
 * `payProtocol` factory) to every session and signs its HELLO; a viewer node attaches its own on
 * the same Protomux. Then:
 *
 *   - the viewer receives each core's PRICE before that core's first block — priced (the gateway's
 *     price) for a sold core, `{ free: true }` for a core the gateway serves outside payment;
 *   - every ACK carries `outstanding`;
 *   - on a new connection (a new Noise key, the same HELLO pubkey) the blocks the first one left
 *     unpaid come back as OWED, after the core's PRICE, and a PAY for them clears them.
 */
import { mocks, payProtocol } from '@sovit/core';
import type {
  AckMessage,
  CashuP2pkPubkey,
  MuxLike,
  NostrEvent,
  NostrPubkey,
  OwedMessage,
  PriceMessage,
  Sats,
} from '@sovit/core';
import { Seeder, nodeAdapters, silentLogger, toHex } from '@sovit/seeder';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BLOCK, cleanupRigs, rig, settle, tmpDir, until } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

/** The viewer's HELLO key: a fixture scalar, never a real key. */
const VIEWER_SECRET = new Uint8Array(32).fill(0x7a);
const VIEWER_PUBKEY = getPublicKey(VIEWER_SECRET) as NostrPubkey;
const VIEWER_IDENTITY = {
  signEvent: (t: {
    kind: number;
    created_at: number;
    tags: readonly (readonly string[])[];
    content: string;
  }) =>
    Promise.resolve(
      finalizeEvent(
        { ...t, tags: t.tags.map((x) => [...x]) },
        VIEWER_SECRET,
      ) as unknown as NostrEvent,
    ),
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await cleanupRigs();
});

async function world() {
  const r = await rig({
    windowBlocks: 8,
    listen: false,
    deps: { payProtocol: () => new payProtocol.PayChannel({ destroyOnCut: false }) },
  });
  const t = await tmpDir();
  const viewer = await Seeder.create(
    { dataDir: t.dir, diskCapBytes: 1 << 22, blockSize: BLOCK, swarm: null },
    { engine: new mocks.MockPaymentEngine(), logger: silentLogger, ...nodeAdapters },
  );
  cleanups.push(async () => {
    await viewer.close();
    await t.rm();
  });

  /** A connection gateway ⇄ viewer; `before` hooks the viewer's channel before any HELLO. */
  const connect = async (before: (chan: payProtocol.PayChannel) => void) => {
    const sa = r.gateway.seeder.replicate(true);
    const sb = viewer.replicate(false);
    sa.on('error', () => undefined);
    sb.on('error', () => undefined);
    sa.pipe(sb).pipe(sa);
    await sb.noiseStream.opened;
    const viewerNoise = toHex(sb.noiseStream.publicKey!);
    await until(() => r.gateway.seeder.session(viewerNoise) !== undefined);
    const session = r.gateway.seeder.session(viewerNoise)!;
    const mux = sb.noiseStream.userData as MuxLike;
    const chan = new payProtocol.PayChannel();
    chan.attach(mux);
    before(chan);
    chan.sendHello(
      await payProtocol.buildHello(VIEWER_IDENTITY, payProtocol.bindingFromMux(mux)!, {
        acceptedMints: [],
        satsPerBlock: 0 as Sats,
        split: { seeder: 50, creator: 50 },
        p2pk: `02${'aa'.repeat(32)}` as CashuP2pkPubkey,
        windowBlocks: 0,
      }),
    );
    await until(() => chan.state === 'open' && session.pubkey === VIEWER_PUBKEY);
    return {
      session,
      chan,
      drop: async () => {
        sa.destroy();
        sb.destroy();
        await until(() => session.closed);
      },
    };
  };

  /** A PAY from the viewer for `[from, to]` of `core`, at the gateway's terms; resolves on its ACK. */
  const pay = async (
    chan: payProtocol.PayChannel,
    core: string,
    from: number,
    to: number,
    carryIn: number,
  ): Promise<AckMessage> => {
    const h = chan.peer!;
    const policy = r.gateway.seeder.policyFor(core as never);
    const msg = await new mocks.MockPaymentEngine().pay(
      { core: core as never, fromBlock: from, toBlock: to },
      { pubkey: h.pubkey, p2pk: h.p2pk, mint: policy.mints[0]! },
      policy,
      { carryIn },
    );
    let off = (): void => undefined;
    const acked = new Promise<AckMessage>((resolve) => {
      off = chan.on('ack', (a) => {
        if (a.core === core && a.fromBlock === from && a.toBlock === to) resolve(a);
      });
    });
    chan.sendPay(msg);
    try {
      return await acked;
    } finally {
      off();
    }
  };

  return { r, viewer, connect, pay };
}

describe("contracts v6 amendment on the gateway's seeder (real replication stream)", () => {
  it("the viewer receives each core's PRICE before its first block — the gateway's price for a sold core, { free: true } for a free one — and every ACK carries outstanding", async () => {
    const w = await world();
    const data = new Uint8Array(BLOCK * 4).map((_, i) => (i * 5 + 1) % 256);
    const put = await w.r.gateway.seeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error('put failed');
    const paid = put.entry.coreKey;
    const profile = await w.r.gateway.seeder.openCore('profile');
    const image = await profile.blobs.put(new Uint8Array(BLOCK * 2).fill(3));
    expect(w.r.gateway.seeder.setFreeCore(profile.keyHex, true)).toBe(true);
    const name = (c: string): string => (c === paid ? 'paid' : c === profile.keyHex ? 'free' : '?');

    const seen: string[] = [];
    const c = await w.connect((chan) => {
      chan.on('price', (p: PriceMessage) =>
        seen.push(`price:${name(p.core)}:${p.free === true ? 'free' : String(p.satsPerBlock)}`),
      );
    });
    const vpaid = await w.viewer.blobs.openCoreByKey(Buffer.from(paid, 'hex'));
    const vfree = await w.viewer.blobs.openCoreByKey(Buffer.from(profile.keyHex, 'hex'));
    for (const [vc, n] of [
      [vpaid, 'paid'],
      [vfree, 'free'],
    ] as const)
      vc.core.on('download', (i: number) => seen.push(`download:${n}:${String(i)}`));
    for (let i = image.blockOffset; i < image.blockOffset + image.blockLength; i++)
      expect(await vfree.core.get(i, { wait: true, timeout: 5000 })).not.toBeNull();
    for (let i = 0; i < 4; i++)
      expect(await vpaid.core.get(i, { wait: true, timeout: 5000 })).not.toBeNull();
    await settle(30);
    for (const n of ['paid', 'free']) {
      const price = seen.findIndex((e) => e.startsWith(`price:${n}:`));
      expect(price, seen.join(' ')).toBeGreaterThanOrEqual(0);
      expect(seen.findIndex((e) => e.startsWith(`download:${n}:`))).toBeGreaterThan(price);
      expect(seen.filter((e) => e.startsWith(`price:${n}:`))).toHaveLength(1);
    }
    expect(seen).toContain(`price:paid:${String(w.r.gateway.price())}`);
    expect(seen).toContain('price:free:free');
    expect(w.r.engine.window(VIEWER_PUBKEY)).toMatchObject({ uploaded: 4, paid: 0 });
    expect(await w.pay(c.chan, paid, 0, 2, 0)).toMatchObject({ ok: true, outstanding: 1 });
  });

  it('a returning viewer (new Noise key, same HELLO pubkey) gets the PRICE then OWED for what the first connection left unpaid, and paying it there clears it', async () => {
    const w = await world();
    const data = new Uint8Array(BLOCK * 6).map((_, i) => (i * 3 + 2) % 256);
    const put = await w.r.gateway.seeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error('put failed');
    const core = put.entry.coreKey;
    const c1 = await w.connect(() => undefined);
    const vcore = await w.viewer.blobs.openCoreByKey(Buffer.from(core, 'hex'));
    for (let i = 0; i < 4; i++)
      expect(await vcore.core.get(i, { wait: true, timeout: 5000 })).not.toBeNull();
    expect(await w.pay(c1.chan, core, 0, 0, 0)).toMatchObject({ ok: true, outstanding: 3 });
    await c1.drop();

    const got: (PriceMessage | OwedMessage)[] = [];
    const c2 = await w.connect((chan) => {
      chan.on('price', (m) => got.push(m));
      chan.on('owed', (m) => got.push(m));
    });
    await until(() => got.length >= 2);
    expect(got).toEqual([
      { type: 'PRICE', core, satsPerBlock: w.r.gateway.price(), effectiveFromBlock: 0 },
      { type: 'OWED', core, ranges: [[1, 3]] },
    ]);
    expect(await w.pay(c2.chan, core, 1, 3, 0)).toMatchObject({ ok: true, outstanding: 0 });
    expect(w.r.engine.window(VIEWER_PUBKEY)).toMatchObject({ uploaded: 4, paid: 4 });
    expect(c2.session.cutReason).toBeNull();
  });
});
