/**
 * Contracts v6 amendment (Cameron 2026-09-26) on a REAL replication stream: two Seeder instances
 * over directly piped Noise streams, `PayChannel` on the same Protomux as Hypercore, HELLOs signed
 * by real LocalSigners and bound to the connection, the real PaymentEngine on the seeder side and
 * real ecash from an in-process TestMint on the viewer side. Nothing leaves the process.
 *
 *   - the viewer receives a core's PRICE before the first block of that core, for a sold core
 *     (priced) and for a core served outside payment (`{ free: true }`);
 *   - blocks a dropped connection left unpaid are reported in OWED on the next connection (a new
 *     Noise key, the same HELLO pubkey), after the core's PRICE; the viewer pays them there, the
 *     ACK says nothing is outstanding any more, and playback continues within the window.
 *
 * Opt-in: with `NUTFLIX_REAL_MINT_URL` set (a local Nutshell or cdk-mintd, `scripts/real-mint/`),
 * the owed-range PAY is made of real ecash from that mint, verified against its keyset, and the
 * seeder then redeems it there. Plain `npm test` stays offline.
 */
import { mocks, payment, payProtocol, signer as signerMod, wallet as walletMod } from '@sovit/core';
import type {
  AckMessage,
  CashuP2pkPubkey,
  CashuProof,
  CoreKeyHex,
  MintUrl,
  MuxLike,
  OwedMessage,
  PriceMessage,
  PricePolicy,
  Sats,
  Wallet,
} from '@sovit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Seeder } from '../seeder.js';
import { toHex } from '../util/hex.js';
import { adapters, capturedLogger, tmpDir } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

const BLOCK = 1024;
const MINT = 'https://mint.owed-it.example' as MintUrl;
const SEEDER_P2PK = ('02' + '5e'.repeat(32)) as CashuP2pkPubkey;
const CREATOR_P2PK = ('02' + 'c7'.repeat(32)) as CashuP2pkPubkey;
const VIEWER_P2PK = ('02' + 'aa'.repeat(32)) as CashuP2pkPubkey;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const settle = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function newSigner(): Promise<signerMod.LocalSigner> {
  const { signer: s } = await signerMod.LocalSigner.create({
    passphrase: new TextEncoder().encode('integration pw'),
    cost: signerMod.minimumCost(),
  });
  return s;
}

const REAL_MINT = process.env['NUTFLIX_REAL_MINT_URL'] as MintUrl | undefined;

const policyAt = (mint: MintUrl): PricePolicy => ({
  satsPerBlock: 2 as Sats,
  blockSize: BLOCK,
  mints: [mint],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
  minPaySats: 1 as Sats,
});
function cashuWallet(key?: Uint8Array): walletMod.CashuWallet {
  return new walletMod.CashuWallet({
    mints: new walletMod.CashuMintConnections(),
    store: new walletMod.MemoryProofStore(),
    ...(key === undefined ? {} : { key: walletMod.memoryWalletKey(key) }),
  });
}

/**
 * The seeder's money side: the in-process TestMint (default), or — `real` — a wallet at a real
 * mint that looks up its keysets there and redeems what the seeder is paid (a fixture key, never a
 * real one). The viewer's wallet pays from the same mint.
 */
async function money(real: MintUrl | undefined) {
  if (real === undefined) {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(33) });
    const viewerWallet: Pick<Wallet, 'send'> = {
      send: (amount, o) =>
        Promise.resolve({
          mint: o.mint,
          unit: 'sat',
          lockedTo: o.p2pk,
          proofs: mint.issue(amount, { p2pk: o.p2pk, ...(o.tags ? { tags: o.tags } : {}) }),
        }),
    };
    return {
      mint: MINT,
      seederP2pk: SEEDER_P2PK,
      seederWallet: null,
      keyset: (m: MintUrl, id: string) =>
        Promise.resolve(m === MINT && id === mint.keysetId ? mint.keyset() : undefined),
      viewerWallet,
    };
  }
  const seederKey = walletMod.memoryWalletKey(new Uint8Array(32).fill(0x5e));
  const seederWallet = cashuWallet(new Uint8Array(32).fill(0x5e));
  const viewerWallet = cashuWallet();
  const q = await viewerWallet.mintQuote(real, 64 as Sats);
  let issued = false;
  for (let i = 0; i < 50 && !issued; i++) {
    issued = (await viewerWallet.pollQuote(q)).state === 'ISSUED';
    if (!issued) await settle(100);
  }
  if (!issued) throw new Error('the mint never marked the quote paid');
  return {
    mint: real,
    seederP2pk: seederKey.pubkey,
    seederWallet,
    keyset: (m: MintUrl, id: string) => seederWallet.keyset(m, id),
    viewerWallet,
  };
}

async function rig(windowBlocks: number, real?: MintUrl) {
  const m = await money(real);
  const policy = policyAt(m.mint);
  const nutzaps: CashuProof[] = [];
  const engine = new payment.RealPaymentEngine({
    config: {
      windowBlocks,
      acceptedMints: [m.mint],
      ownP2pk: m.seederP2pk,
      ownPubkey: mocks.asPubkey('owed-seeder'),
      flushEveryBlocks: 1000,
      flushEveryMs: 60_000,
    },
    seen: new payment.SeenSecrets(),
    keyset: m.keyset,
    ...(m.seederWallet === null
      ? {}
      : {
          redeem: (set: { readonly mint: MintUrl; readonly proofs: readonly CashuProof[] }) =>
            m.seederWallet.receive(set),
          nutzap: (set: { readonly proofs: readonly CashuProof[] }) => {
            nutzaps.push(...set.proofs);
            return Promise.resolve();
          },
        }),
  });
  const t1 = await tmpDir();
  const t2 = await tmpDir();
  const common = {
    diskCapBytes: 1 << 20,
    blockSize: BLOCK,
    swarm: null,
    flushEveryBlocks: 1000,
    flushEveryMs: 60_000,
  };
  const seeder = await Seeder.create(
    { dataDir: t1.dir, ...common },
    { engine, logger: capturedLogger().logger, ...adapters },
  );
  const viewerNode = await Seeder.create(
    { dataDir: t2.dir, ...common },
    { engine: new mocks.MockPaymentEngine(), logger: capturedLogger().logger, ...adapters },
  );
  seeder.start();
  viewerNode.start();
  cleanups.push(async () => {
    await seeder.close();
    await viewerNode.close();
    await t1.rm();
    await t2.rm();
  });
  const seederSigner = await newSigner();
  const viewerSigner = await newSigner();
  const viewerPubkey = await viewerSigner.getPublicKey();
  const viewerEngine = new payment.RealPaymentEngine({
    config: {
      windowBlocks: 4,
      acceptedMints: [],
      ownP2pk: VIEWER_P2PK,
      ownPubkey: viewerPubkey,
      flushEveryBlocks: 64,
      flushEveryMs: 60_000,
    },
    wallet: m.viewerWallet,
  });

  /**
   * One connection: piped streams, pay/1 on both ends of the same Protomux (attached before any
   * block is asked for), both HELLOs sent. `before` runs once the channels exist, before the
   * HELLOs — where a test hooks the events it records.
   */
  const connect = async (
    before: (c: { seederChan: payProtocol.PayChannel; viewerChan: payProtocol.PayChannel }) => void,
  ) => {
    const sa = seeder.replicate(true);
    const sb = viewerNode.replicate(false);
    sa.on('error', () => undefined);
    sb.on('error', () => undefined);
    sa.pipe(sb).pipe(sa);
    await sb.noiseStream.opened;
    await settle(50);
    const session = seeder.session(toHex(sb.noiseStream.publicKey!))!;
    const seederMux = session.mux!;
    const viewerMux = sb.noiseStream.userData as MuxLike;
    const seederChan = new payProtocol.PayChannel({ destroyOnCut: false });
    const viewerChan = new payProtocol.PayChannel();
    seederChan.attach(seederMux);
    viewerChan.attach(viewerMux);
    seeder.attachPayProtocol(session, seederChan);
    before({ seederChan, viewerChan });
    seederChan.sendHello(
      await payProtocol.buildHello(seederSigner, payProtocol.bindingFromMux(seederMux)!, {
        acceptedMints: [m.mint],
        satsPerBlock: policy.satsPerBlock,
        split: policy.split,
        p2pk: m.seederP2pk,
        windowBlocks,
      }),
    );
    viewerChan.sendHello(
      await payProtocol.buildHello(viewerSigner, payProtocol.bindingFromMux(viewerMux)!, {
        acceptedMints: [m.mint],
        satsPerBlock: 0 as Sats,
        split: policy.split,
        p2pk: VIEWER_P2PK,
        windowBlocks: 0,
      }),
    );
    await settle(80);
    expect(seederChan.state).toBe('open');
    expect(viewerChan.state).toBe('open');
    expect(session.pubkey).toBe(viewerPubkey);
    const drop = async (): Promise<void> => {
      sa.destroy();
      sb.destroy();
      await settle(80);
      expect(session.closed).toBe(true);
    };
    return { session, seederChan, viewerChan, drop };
  };

  const pay = async (
    chan: payProtocol.PayChannel,
    core: CoreKeyHex,
    from: number,
    to: number,
    carryIn: number,
  ): Promise<void> => {
    const hello = chan.peer!;
    const msg = await viewerEngine.pay(
      { core, fromBlock: from, toBlock: to },
      { pubkey: hello.pubkey, p2pk: hello.p2pk, mint: m.mint },
      policy,
      { carryIn },
    );
    // Until its ACK (a real mint's keyset lookup takes a round trip), with an in-test deadline.
    let off = (): void => undefined;
    const acked = new Promise<void>((resolve) => {
      off = chan.on('ack', (a) => {
        if (a.core === core && a.fromBlock === from && a.toBlock === to) resolve();
      });
    });
    chan.sendPay(msg);
    await Promise.race([acked, settle(15_000)]);
    off();
    await settle(20);
  };

  return {
    seeder,
    viewerNode,
    engine,
    viewerEngine,
    viewerPubkey,
    connect,
    pay,
    policy,
    mint: m.mint,
    seederWallet: m.seederWallet,
    nutzaps,
  };
}

describe('contracts v6 amendment on a real replication stream', () => {
  it("the viewer receives a core's PRICE before that core's first block — priced for a sold core, { free: true } for a core served outside payment", async () => {
    const r = await rig(8);
    // A sold core (its own policy, as the desktop sets per video) and a free one (a profile core).
    const data = new Uint8Array(BLOCK * 4).map((_, i) => (i * 7 + 3) % 256);
    const put = await r.seeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error('put failed');
    const paid = put.entry.coreKey;
    r.seeder.setCorePolicy(paid, r.policy);
    const profile = await r.seeder.openCore('profile');
    const image = await profile.blobs.put(new Uint8Array(BLOCK * 3).fill(9));
    const free = profile.keyHex;
    expect(r.seeder.setFreeCore(free, true)).toBe(true);
    const name = (core: string): string => (core === paid ? 'paid' : core === free ? 'free' : '?');

    // The seeder's side: the order of `sendPrice` and the cores' `upload` events. The gate's
    // listener was registered when the core opened; this one runs after it, for the same block.
    const sent: string[] = [];
    for (const sc of [r.seeder.blobs.coreByKey(paid)!, profile])
      sc.core.on('upload', (index: number) =>
        sent.push(`upload:${name(sc.keyHex)}:${String(index)}`),
      );

    const seen: string[] = [];
    await r.connect(({ seederChan, viewerChan }) => {
      const send = seederChan.sendPrice.bind(seederChan);
      seederChan.sendPrice = (p): void => {
        sent.push(`price:${name(p.core)}`);
        send(p);
      };
      viewerChan.on('price', (p: PriceMessage) =>
        seen.push(`price:${name(p.core)}:${p.free === true ? 'free' : String(p.satsPerBlock)}`),
      );
    });
    const vpaid = await r.viewerNode.blobs.openCoreByKey(Buffer.from(paid, 'hex'));
    const vfree = await r.viewerNode.blobs.openCoreByKey(Buffer.from(free, 'hex'));
    for (const [vc, n] of [
      [vpaid, 'paid'],
      [vfree, 'free'],
    ] as const)
      vc.core.on('download', (index: number) => seen.push(`download:${n}:${String(index)}`));

    for (let i = image.blockOffset; i < image.blockOffset + image.blockLength; i++)
      expect(await vfree.core.get(i, { wait: true, timeout: 3000 })).not.toBeNull();
    for (let i = 0; i < 4; i++)
      expect(await vpaid.core.get(i, { wait: true, timeout: 3000 })).not.toBeNull();
    await settle(50);

    for (const n of ['paid', 'free']) {
      const firstPrice = seen.findIndex((e) => e.startsWith(`price:${n}:`));
      const firstBlock = seen.findIndex((e) => e.startsWith(`download:${n}:`));
      expect(firstPrice, `${n}: ${seen.join(' ')}`).toBeGreaterThanOrEqual(0);
      expect(firstBlock).toBeGreaterThan(firstPrice);
      expect(sent.indexOf(`price:${n}`)).toBeLessThan(
        sent.findIndex((e) => e.startsWith(`upload:${n}:`)),
      );
      // Said once: every later block of the core goes out under the same terms.
      expect(seen.filter((e) => e.startsWith(`price:${n}:`))).toHaveLength(1);
    }
    expect(seen.filter((e) => e.startsWith('price:'))).toEqual(
      expect.arrayContaining(['price:paid:2', 'price:free:free']),
    );
    // The free core's blocks were never counted; the sold core's four were.
    expect(r.engine.window(r.viewerPubkey)).toMatchObject({ uploaded: 4, paid: 0 });
    expect(r.engine.unpaid(r.viewerPubkey)).toEqual([{ core: paid, ranges: [[0, 3]] }]);
  });

  it('blocks a dropped connection left unpaid come back as OWED on the next connection (new Noise key, same HELLO pubkey), after the PRICE; paying them there clears them and playback continues', async () => {
    await dropThenPayOwed();
  });
});

/**
 * Connection 1 leaves blocks 2–3 of a 4-block window unpaid and drops; connection 2 (a new Noise
 * key, the same HELLO pubkey) gets the PRICE then the OWED, pays the owed range there at carry 0,
 * and is cleared. With `real`, the ecash is from that mint.
 */
async function dropThenPayOwed(real?: MintUrl) {
  const r = await rig(4, real);
  const data = new Uint8Array(BLOCK * 8).map((_, i) => (i * 13 + 1) % 256);
  const put = await r.seeder.putBytes(data, { mime: 'video/mp4' });
  if (!put.ok) throw new Error('put failed');
  const core = put.entry.coreKey;
  r.seeder.setCorePolicy(core, r.policy);

  // Connection 1: four blocks (the whole window), two paid, then the link drops.
  const acks1: AckMessage[] = [];
  const c1 = await r.connect(({ viewerChan }) => viewerChan.on('ack', (a) => acks1.push(a)));
  const vcore = await r.viewerNode.blobs.openCoreByKey(Buffer.from(core, 'hex'));
  for (let i = 0; i < 4; i++)
    expect(await vcore.core.get(i, { wait: true, timeout: 3000 })).not.toBeNull();
  await settle(30);
  await r.pay(c1.viewerChan, core, 0, 1, 0);
  expect(acks1).toEqual([
    { type: 'ACK', core, fromBlock: 0, toBlock: 1, ok: true, outstanding: 2 },
  ]);
  const firstNoise = c1.session.noiseKeyHex;
  await c1.drop();

  // Connection 2: a new Noise key; the same signer's HELLO. PRICE, then OWED for blocks 2–3.
  const got: (PriceMessage | OwedMessage | AckMessage)[] = [];
  const c2 = await r.connect(({ viewerChan }) => {
    viewerChan.on('price', (m) => got.push(m));
    viewerChan.on('owed', (m) => got.push(m));
    viewerChan.on('ack', (m) => got.push(m));
  });
  expect(c2.session.noiseKeyHex).not.toBe(firstNoise);
  expect(got).toEqual([
    { type: 'PRICE', core, satsPerBlock: 2, effectiveFromBlock: 0 },
    { type: 'OWED', core, ranges: [[2, 3]] },
  ]);
  // Paid on this connection, at the core's terms, from carry 0: cleared.
  await r.pay(c2.viewerChan, core, 2, 3, 0);
  expect(got.at(-1)).toEqual({
    type: 'ACK',
    core,
    fromBlock: 2,
    toBlock: 3,
    ok: true,
    outstanding: 0,
  });
  expect(r.engine.window(r.viewerPubkey)).toMatchObject({ uploaded: 4, paid: 4, outstanding: 0 });
  expect(r.engine.unpaid(r.viewerPubkey)).toEqual([]);
  // The window is free again: the next four blocks arrive, and nobody is cut.
  for (let i = 4; i < 8; i++)
    expect(await vcore.core.get(i, { wait: true, timeout: 3000 })).not.toBeNull();
  await settle(50);
  expect(c2.session.cutReason).toBeNull();
  expect(r.engine.isBanned(r.viewerPubkey)).toBe(false);
  expect(r.engine.unpaid(r.viewerPubkey)).toEqual([{ core, ranges: [[4, 7]] }]);
  return r;
}

describe.skipIf(REAL_MINT === undefined)(
  'contracts v6 amendment at a real mint (NUTFLIX_REAL_MINT_URL)',
  () => {
    it('the owed range is paid in real ecash from that mint on the next connection, verified against its keyset, and the seeder redeems it there', async () => {
      const r = await dropThenPayOwed(REAL_MINT);
      // Two PAYs of 2 blocks at 2 sat: 8 sat in all, half the seeder's, half the creator's.
      expect(r.viewerEngine.spent().total).toBe(8);
      const out = await r.engine.flush();
      expect(out.failed).toBe(0);
      // What stays queued is dust below the mint's input fee (kept for the next batch).
      const left = (r.engine as unknown as { pending: { msg: payment.PendingPay['msg'] }[] })
        .pending;
      let dust = 0;
      for (const it of left)
        for (const p of [...it.msg.seederProofs.proofs, ...it.msg.creatorProofs.proofs])
          dust += p.amount;
      expect(out.swapped + out.nutzapped + dust).toBe(8);
      // Both PAYs' seeder sets (the owed one included) go in ONE swap: 4 sat, above any input fee
      // of a local test mint (measured 2026-09-27: swapped 4, nutzapped 4, no dust, on Nutshell
      // 0.21.0 and cdk-mintd 0.18.1).
      expect(out.swapped).toBeGreaterThan(0);
      const held = await r.seederWallet!.balance(r.mint);
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThanOrEqual(out.swapped);
    });
  },
);
