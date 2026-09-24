/**
 * The real-mint testing lane (execution plan §4; security review F6): three seeders, a viewer,
 * real ecash from a real Cashu mint, real `pay/1` over Hypercore replication streams — plus a
 * live double-spend attempt and a network drop mid-`PAY`.
 *
 * Opt-in: runs only when `NUTFLIX_REAL_MINT_URL` names a mint (`scripts/real-mint/nutshell.sh`
 * starts a local Nutshell with FakeWallet). Plain `npm test` skips it and stays offline.
 *
 * The viewer is a Seeder node used as a client, paying through the SAME `UpstreamPayer` the
 * gateway and the desktop worker use (manifest price, per-channel carry, one PAY in flight).
 */
import { payment, payProtocol, signer as signerMod, wallet as walletMod } from '@sovit/core';
import type {
  CashuP2pkPubkey,
  CashuProof,
  LockedProofSet,
  MintUrl,
  MuxLike,
  PayMessage,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { Seeder, nodeCrypto, nodeFs, toHex } from '@sovit/seeder';
import type { PeerSession } from '@sovit/seeder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpstreamPayer } from '../upstream/payer.js';
import { capturedLogger, settle, tmpDir, until } from './helpers.js';

const MINT = process.env['NUTFLIX_REAL_MINT_URL'] as MintUrl | undefined;

vi.setConfig({ testTimeout: 240_000 });

const BLOCK = 1024;
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A deterministic test key pair (a fixture scalar, never a real key). */
function keyOf(fill: number): { sk: Uint8Array; pub: CashuP2pkPubkey } {
  const sk = new Uint8Array(32).fill(fill);
  return { sk, pub: hex(getPubKeyFromPrivKey(sk)) as CashuP2pkPubkey };
}

function cashuWallet(key?: Uint8Array): walletMod.CashuWallet {
  return new walletMod.CashuWallet({
    mints: new walletMod.CashuMintConnections(),
    store: new walletMod.MemoryProofStore(),
    ...(key === undefined ? {} : { key: walletMod.memoryWalletKey(key) }),
  });
}

async function fund(w: walletMod.CashuWallet, mint: MintUrl, amount: number): Promise<void> {
  const q = await w.mintQuote(mint, amount as Sats);
  for (let i = 0; i < 50; i++) {
    if ((await w.pollQuote(q)).state === 'ISSUED') return;
    await settle(100);
  }
  throw new Error('the mint never marked the quote paid');
}

async function localSigner(): Promise<signerMod.LocalSigner> {
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: new TextEncoder().encode('real-mint lane'),
    cost: signerMod.minimumCost(),
  });
  return signer;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface SeederNode {
  readonly seeder: Seeder;
  readonly engine: payment.RealPaymentEngine;
  readonly wallet: walletMod.CashuWallet;
  readonly key: { sk: Uint8Array; pub: CashuP2pkPubkey };
  readonly signer: signerMod.LocalSigner;
  readonly zaps: LockedProofSet[];
  readonly log: string[];
}

async function seederNode(mint: MintUrl, fill: number, windowBlocks: number): Promise<SeederNode> {
  const key = keyOf(fill);
  const w = cashuWallet(key.sk);
  const zaps: LockedProofSet[] = [];
  const signer = await localSigner();
  const engine = new payment.RealPaymentEngine({
    config: {
      windowBlocks,
      acceptedMints: [mint],
      ownP2pk: key.pub,
      ownPubkey: await signer.getPublicKey(),
      flushEveryBlocks: 10_000,
      flushEveryMs: 3_600_000,
    },
    seen: new payment.SeenSecrets(),
    keyset: (m, id) => w.keyset(m, id),
    redeem: (set) => w.receive(set),
    nutzap: (set) => {
      zaps.push(set);
      return Promise.resolve();
    },
    checkSpent: (set) => w.checkSpent(set),
    spentByUs: (set) => w.spentByUs(set),
  });
  const t = await tmpDir('nutflix-real-mint-');
  const log = capturedLogger('info');
  const seeder = await Seeder.create(
    {
      dataDir: t.dir,
      diskCapBytes: 1 << 22,
      blockSize: BLOCK,
      swarm: null,
      flushEveryBlocks: 10_000,
      flushEveryMs: 3_600_000,
    },
    { engine, logger: log.logger, fs: nodeFs, crypto: nodeCrypto },
  );
  seeder.start();
  cleanups.push(async () => {
    await seeder.close();
    await t.rm();
  });
  return { seeder, engine, wallet: w, key, signer, zaps, log: log.lines };
}

/** A viewer node: a Seeder used as a client, its own engine irrelevant (it only downloads). */
async function viewerNode(mint: MintUrl) {
  const holder = await seederNode(mint, 99, 1);
  return holder.seeder;
}

interface Link {
  readonly session: PeerSession;
  readonly viewerChan: payProtocol.PayChannel;
  readonly destroy: () => void;
}

/**
 * Pipe `from` (seeder) ⇄ `viewer`, attach `pay/1` on both ends of the same protomux, exchange
 * connection-bound HELLOs, and register the viewer side with the payer.
 */
async function connect(
  from: SeederNode,
  viewer: Seeder,
  viewerSigner: signerMod.LocalSigner,
  payer: UpstreamPayer,
  policy: PricePolicy,
  windowBlocks: number,
): Promise<Link> {
  const sa = from.seeder.replicate(true);
  const sb = viewer.replicate(false);
  sa.on('error', () => undefined);
  sb.on('error', () => undefined);
  sa.pipe(sb).pipe(sa);
  await sb.noiseStream.opened;
  const viewerNoise = toHex(sb.noiseStream.publicKey!);
  await until(() => from.seeder.session(viewerNoise) !== undefined);
  const session = from.seeder.session(viewerNoise)!;
  const seederMux = session.mux!;
  const viewerMux = sb.noiseStream.userData as MuxLike;
  const seederChan = new payProtocol.PayChannel({ destroyOnCut: false });
  const viewerChan = new payProtocol.PayChannel();
  seederChan.attach(seederMux);
  viewerChan.attach(viewerMux);
  from.seeder.attachPayProtocol(session, seederChan);
  payer.attachPeer(toHex(sb.noiseStream.remotePublicKey!), viewerChan);
  seederChan.sendHello(
    await payProtocol.buildHello(from.signer, payProtocol.bindingFromMux(seederMux)!, {
      acceptedMints: [...policy.mints],
      satsPerBlock: policy.satsPerBlock,
      split: policy.split,
      p2pk: from.key.pub,
      windowBlocks,
    }),
  );
  viewerChan.sendHello(
    await payProtocol.buildHello(viewerSigner, payProtocol.bindingFromMux(viewerMux)!, {
      acceptedMints: [],
      satsPerBlock: 0 as Sats,
      split: { seeder: 50, creator: 50 },
      p2pk: `02${'aa'.repeat(32)}` as CashuP2pkPubkey,
      windowBlocks: 0,
    }),
  );
  await until(() => viewerChan.state === 'open' && seederChan.state === 'open');
  viewerChan.on('ack', (a) => {
    if (!a.ok) REJECTIONS.push(`${String(a.fromBlock)}-${String(a.toBlock)} ${String(a.reason)}`);
  });
  return {
    session,
    viewerChan,
    destroy: () => {
      sa.destroy();
      sb.destroy();
    },
  };
}

/** Rejected ACKs seen by any viewer channel, for failure messages. */
const REJECTIONS: string[] = [];

const total = (proofs: readonly CashuProof[]): number => proofs.reduce((a, p) => a + p.amount, 0);

describe.skipIf(MINT === undefined)(
  'real mint — three seeders and a viewer (execution plan §4)',
  () => {
    const mint = MINT!;
    const creatorKey = keyOf(77);

    async function world(blocks: number, windowBlocks: number) {
      const origin = await seederNode(mint, 71, windowBlocks);
      const data = new Uint8Array(BLOCK * blocks).map((_, i) => (i * 31 + 7) % 256);
      const put = await origin.seeder.putBytes(data, { mime: 'video/mp4' });
      if (!put.ok) throw new Error('put failed');
      const core = put.entry.coreKey;
      const policy: PricePolicy = {
        satsPerBlock: 2 as Sats,
        blockSize: BLOCK,
        mints: [mint],
        split: { seeder: 60, creator: 40 },
        creatorP2pk: creatorKey.pub,
        minPaySats: 1 as Sats,
      };
      origin.seeder.setPolicy(policy);
      const viewerWallet = cashuWallet();
      await fund(viewerWallet, mint, 1000);
      const viewerSigner = await localSigner();
      const viewerEngine = new payment.RealPaymentEngine({
        config: {
          windowBlocks,
          acceptedMints: [],
          ownP2pk: `02${'bb'.repeat(32)}` as CashuP2pkPubkey,
          ownPubkey: await viewerSigner.getPublicKey(),
          flushEveryBlocks: 10_000,
          flushEveryMs: 3_600_000,
        },
        wallet: viewerWallet,
      });
      const payer = new UpstreamPayer({
        engine: viewerEngine,
        logger: capturedLogger('error').logger,
        payEveryBlocks: 1,
        ownMints: [mint],
        policyFor: () => policy,
      });
      return { origin, data, put, core, policy, viewerWallet, viewerSigner, viewerEngine, payer };
    }

    it('the viewer downloads one video from three seeders and pays each for what it served; every seeder redeems at the mint and the creator redeems its share', async () => {
      const BLOCKS = 24;
      const WINDOW = 64; // no flow control here (the desktop credit pool does that): the window only has to hold the burst
      const w = await world(BLOCKS, WINDOW);
      // Two more seeders mirror the core from the origin before the viewer arrives (unpaid warm-up:
      // they are seeders, not viewers — the origin's window absorbs it).
      const s2 = await seederNode(mint, 72, WINDOW);
      const s3 = await seederNode(mint, 73, WINDOW);
      for (const s of [s2, s3]) {
        s.seeder.setPolicy(w.policy);
        const a = w.origin.seeder.replicate(true);
        const b = s.seeder.replicate(false);
        a.on('error', () => undefined);
        b.on('error', () => undefined);
        a.pipe(b).pipe(a);
        const mirror = await s.seeder.blobs.openCoreByKey(Buffer.from(w.core, 'hex'));
        for (let i = 0; i < BLOCKS; i++)
          expect(await mirror.core.get(i, { wait: true, timeout: 5000 })).not.toBeNull();
        a.destroy();
        b.destroy();
      }

      const viewer = await viewerNode(mint);
      const links: Link[] = [];
      for (const s of [w.origin, s2, s3])
        links.push(await connect(s, viewer, w.viewerSigner, w.payer, w.policy, WINDOW));
      const vcore = await viewer.blobs.openCoreByKey(Buffer.from(w.core, 'hex'));
      const detachCore = w.payer.attachCore(vcore.core);
      const full = await vcore.blobs.get(w.put.entry.blob, { wait: true, timeout: 30_000 });
      expect(Buffer.from(full!).equals(Buffer.from(w.data))).toBe(true);
      await w.payer.flush();
      // Every block paid AND every PAY answered ("acks == pays" alone is briefly true between an
      // ACK and the next PAY, which takes a real-mint round trip to build).
      // Done when every block ANY seeder sent is paid and every PAY answered. Hypercore can fetch
      // one block from two seeders (racing requests); each is paid for what it sent (see below).
      const viewerPk = await w.viewerSigner.getPublicKey();
      const nodes = [w.origin, s2, s3];
      await until(() => {
        const st = w.payer.stats();
        const wins = nodes.map((n) => n.engine.window(viewerPk));
        const up = wins.reduce((a, x) => a + (x?.uploaded ?? 0), 0);
        const paid = wins.reduce((a, x) => a + (x?.paid ?? 0), 0);
        return up >= BLOCKS && paid === up && st.acksOk + st.acksRejected === st.pays;
      }, 60_000);
      detachCore();

      const stats = w.payer.stats();
      expect(stats).toMatchObject({ acksRejected: 0, skippedOverpriced: 0 });
      // Real-mint finding: blocks a seeder sent twice (a raced request) are paid twice — each
      // seeder counts what it SENT. So the viewer pays blocksPaid × price, which can exceed the
      // video's price; docs/security-review.md F33.
      expect(stats.blocksPaid).toBeGreaterThanOrEqual(BLOCKS);
      expect(w.viewerEngine.spent().total).toBe(stats.blocksPaid * 2);

      let swapped = 0;
      let nutzapped = 0;
      let served = 0;
      let dust = 0;
      for (const s of nodes) {
        const win = s.engine.window(viewerPk);
        if (win !== undefined) {
          expect(win).toMatchObject({ outstanding: 0, banned: false });
          served += win.uploaded;
        }
        const r = await s.engine.flush();
        expect(r.failed).toBe(0);
        swapped += r.swapped;
        nutzapped += r.nutzapped;
        // What stays queued is dust below the mint's input fee (kept for the next batch).
        const left = (s.engine as unknown as { pending: { msg: PayMessage }[] }).pending;
        for (const it of left)
          dust += total(it.msg.seederProofs.proofs) + total(it.msg.creatorProofs.proofs);
        expect(await s.wallet.balance(mint)).toBeLessThanOrEqual(r.swapped);
      }
      expect(served).toBe(stats.blocksPaid);
      expect(swapped + nutzapped + dust).toBe(stats.blocksPaid * 2);
      // The creator redeems every nutzap in ONE swap, as a NIP-61 wallet should: at a real input
      // fee a lone 1-sat nutzap is worth nothing, together they are worth their sum less one fee.
      const zapProofs = nodes.flatMap((n) => n.zaps.flatMap((z) => z.proofs));
      if (zapProofs.length > 0) {
        const creatorGot = await cashuWallet(creatorKey.sk).receive({ mint, proofs: zapProofs });
        expect(creatorGot).toBeGreaterThan(0);
        expect(creatorGot).toBeLessThanOrEqual(nutzapped);
      }
      for (const l of links) l.destroy();
    });

    it('a live double-spend: a creator set bound to one seeder is refused by another, and a replayed PAY is refused and banned', async () => {
      const BLOCKS = 12;
      const WINDOW = 32;
      const w = await world(BLOCKS, WINDOW);
      const other = await seederNode(mint, 74, WINDOW);
      other.seeder.setPolicy(w.policy);
      const viewerPubkey = await w.viewerSigner.getPublicKey();
      for (let i = 0; i < BLOCKS; i++) {
        w.origin.engine.recordUpload(
          viewerPubkey,
          { core: w.core, fromBlock: i, toBlock: i },
          w.policy,
        );
        other.engine.recordUpload(
          viewerPubkey,
          { core: w.core, fromBlock: i, toBlock: i },
          w.policy,
        );
      }
      const toOrigin = await w.viewerEngine.pay(
        { core: w.core, fromBlock: 0, toBlock: 3 },
        { pubkey: await w.origin.signer.getPublicKey(), p2pk: w.origin.key.pub, mint },
        w.policy,
        { carryIn: 0 },
      );
      expect(await w.origin.engine.verify(viewerPubkey, toOrigin, w.policy)).toMatchObject({
        ok: true,
      });
      // The same creator set re-used in a PAY to another seeder (with a fresh seeder set for it):
      // the pay1 binding names the origin, so the other seeder refuses it.
      const fresh = await w.viewerEngine.pay(
        { core: w.core, fromBlock: 0, toBlock: 3 },
        { pubkey: await other.signer.getPublicKey(), p2pk: other.key.pub, mint },
        w.policy,
        { carryIn: 0 },
      );
      const reused: PayMessage = { ...fresh, creatorProofs: toOrigin.creatorProofs };
      expect(await other.engine.verify(viewerPubkey, reused, w.policy)).toMatchObject({
        ok: false,
        reason: 'wrong-p2pk-target',
      });
      // The origin's own proofs replayed for new blocks — with the carry the origin now expects, so
      // the replay reaches the double-spend check: a local double-spend, banned at once.
      const carry = payment.splitPay(4 * w.policy.satsPerBlock, w.policy.split, 0).carryOut;
      const replay = {
        ...toOrigin,
        carryIn: carry,
        range: { core: w.core, fromBlock: 4, toBlock: 7 },
      };
      expect(await w.origin.engine.verify(viewerPubkey, replay, w.policy)).toMatchObject({
        ok: false,
        reason: 'double-spend',
      });
      expect(w.origin.engine.isBanned(viewerPubkey)).toBe(true);
      // The accepted PAY still redeems at the mint.
      expect(await w.origin.engine.flush()).toMatchObject({
        swapped: total(toOrigin.seederProofs.proofs),
        failed: 0,
      });
    });

    it('a network drop mid-PAY: after reconnecting, the carry restarts on both sides and the viewer keeps paying — no malformed carry, no ban', async () => {
      const BLOCKS = 16;
      const WINDOW = 32;
      const w = await world(BLOCKS, WINDOW);
      const viewer = await viewerNode(mint);
      let link = await connect(w.origin, viewer, w.viewerSigner, w.payer, w.policy, WINDOW);
      const vcore = await viewer.blobs.openCoreByKey(Buffer.from(w.core, 'hex'));
      const detachCore = w.payer.attachCore(vcore.core);
      for (let i = 0; i < 6; i++)
        expect(await vcore.core.get(i, { wait: true, timeout: 5000 })).not.toBeNull();
      await until(() => w.payer.stats().acksOk > 0, 10_000);
      // Drop the connection the moment the next PAY goes out.
      const send = link.viewerChan.sendPay.bind(link.viewerChan);
      let dropped = false;
      link.viewerChan.sendPay = (msg) => {
        send(msg);
        if (!dropped) {
          dropped = true;
          link.destroy();
        }
      };
      for (let i = 6; i < 8; i++)
        await vcore.core.get(i, { wait: true, timeout: 5000 }).catch(() => null);
      await settle(300);
      // Reconnect: a new channel (carry 0 on both sides — the seeder rebinds, the payer keeps
      // carry per channel), and the rest of the video.
      link = await connect(w.origin, viewer, w.viewerSigner, w.payer, w.policy, WINDOW);
      const full = await vcore.blobs.get(w.put.entry.blob, { wait: true, timeout: 30_000 });
      expect(Buffer.from(full!).equals(Buffer.from(w.data))).toBe(true);
      await w.payer.flush();
      await settle(500);
      detachCore();
      const viewerPubkey = await w.viewerSigner.getPublicKey();
      const win = w.origin.engine.window(viewerPubkey)!;
      expect(win.banned).toBe(false);
      // Only the blocks of the PAY lost in the drop can be outstanding.
      const seederSide = w.origin.log
        .filter((l) => /PAY rejected|rebind|pubkey bound|cut/.test(l))
        .map((l) => l.slice(0, 260));
      expect(
        win.outstanding,
        `stats ${JSON.stringify(w.payer.stats())} rejections ${REJECTIONS.join(' | ')}\n${seederSide.join('\n')}`,
      ).toBeLessThanOrEqual(8);
      expect(w.payer.stats().acksRejected, REJECTIONS.join(' | ')).toBe(0);
      expect((await w.origin.engine.flush()).failed).toBe(0);
      link.destroy();
    });
  },
);
