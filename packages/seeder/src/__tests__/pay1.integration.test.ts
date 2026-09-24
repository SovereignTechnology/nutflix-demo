/**
 * `pay/1` for real (Stage 2): two Seeder instances replicate a Hyperblob over directly piped
 * Noise streams, `PayChannel` rides the SAME protomux as Hypercore replication, HELLOs are signed
 * by real LocalSigners and bound to the connection, the seeder side is the real PaymentEngine
 * (offline DLEQ against a real mint keyset), and the viewer pays with real ecash from an
 * in-process TestMint. Nothing leaves the process.
 */
import { mocks, payment, payProtocol, signer as signerMod } from '@sovit/core';
import type {
  AckMessage,
  CashuP2pkPubkey,
  MintUrl,
  MuxLike,
  PayMessage,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Seeder } from '../seeder.js';
import { toHex } from '../util/hex.js';
import { adapters, capturedLogger, tmpDir } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

const BLOCK = 1024;
const MINT = 'https://mint.pay1-it.example' as MintUrl;
const SEEDER_P2PK = ('02' + '5e'.repeat(32)) as CashuP2pkPubkey;
const CREATOR_P2PK = ('02' + 'c7'.repeat(32)) as CashuP2pkPubkey;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const settle = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function signer(): Promise<signerMod.LocalSigner> {
  const { signer: s } = await signerMod.LocalSigner.create({
    passphrase: new TextEncoder().encode('integration pw'),
    cost: signerMod.minimumCost(),
  });
  return s;
}

describe('pay/1 over a real replication stream', () => {
  it('HELLO both ways, PAYs for real downloads ACKed by the real engine, the whole blob arrives; a replayed PAY is refused and the viewer cut', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(21) });
    const nutzaps: unknown[] = [];
    const engine = new payment.RealPaymentEngine({
      config: {
        windowBlocks: 4,
        acceptedMints: [MINT],
        ownP2pk: SEEDER_P2PK,
        ownPubkey: mocks.asPubkey('seeder'),
        flushEveryBlocks: 1000,
        flushEveryMs: 60_000,
      },
      seen: new payment.SeenSecrets(),
      keyset: (m, id) =>
        Promise.resolve(m === MINT && id === mint.keysetId ? mint.keyset() : undefined),
      redeem: (set) => {
        mint.markSpent(set.proofs);
        return Promise.resolve(set.proofs.reduce((a, p) => a + p.amount, 0) as Sats);
      },
      nutzap: (set) => {
        nutzaps.push(set);
        return Promise.resolve();
      },
    });
    const t1 = await tmpDir();
    const t2 = await tmpDir();
    const log = capturedLogger();
    const seeder = await Seeder.create(
      {
        dataDir: t1.dir,
        diskCapBytes: 1 << 20,
        blockSize: BLOCK,
        swarm: null,
        flushEveryBlocks: 1000,
        flushEveryMs: 60_000,
      },
      { engine, logger: log.logger, ...adapters },
    );
    const viewerNode = await Seeder.create(
      {
        dataDir: t2.dir,
        diskCapBytes: 1 << 20,
        blockSize: BLOCK,
        swarm: null,
        flushEveryBlocks: 1000,
        flushEveryMs: 60_000,
      },
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

    const BLOCKS = 12;
    const data = new Uint8Array(BLOCK * BLOCKS).map((_, i) => (i * 13 + 1) % 256);
    const put = await seeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error('put failed');
    const core = put.entry.coreKey;
    // 50/50 at 2 sat: every 4-block PAY is 4 + 4 with the carry at 0, so a replayed PAY is
    // amount-correct and reaches the double-spend check.
    const policy: PricePolicy = {
      satsPerBlock: 2 as Sats,
      blockSize: BLOCK,
      mints: [MINT],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: CREATOR_P2PK,
      minPaySats: 1 as Sats,
    };
    seeder.setPolicy(policy);

    // Wire: seeder (initiator) ⇄ viewer.
    const sa = seeder.replicate(true);
    const sb = viewerNode.replicate(false);
    sa.on('error', () => undefined);
    sb.on('error', () => undefined);
    sa.pipe(sb).pipe(sa);
    await sb.noiseStream.opened;
    await settle(50);
    const session = seeder.session(toHex(sb.noiseStream.publicKey!))!;
    expect(session).toBeDefined();

    // pay/1 on both ends of the same protomux as replication.
    const seederMux = session.mux!;
    const viewerMux = sb.noiseStream.userData as MuxLike;
    const seederChan = new payProtocol.PayChannel({ destroyOnCut: false });
    const viewerChan = new payProtocol.PayChannel();
    seederChan.attach(seederMux);
    viewerChan.attach(viewerMux);
    seeder.attachPayProtocol(session, seederChan);

    const seederSigner = await signer();
    const viewerSigner = await signer();
    const seederBinding = payProtocol.bindingFromMux(seederMux)!;
    const viewerBinding = payProtocol.bindingFromMux(viewerMux)!;
    expect(seederBinding.handshakeHash).toEqual(viewerBinding.handshakeHash);
    seederChan.sendHello(
      await payProtocol.buildHello(seederSigner, seederBinding, {
        acceptedMints: [MINT],
        satsPerBlock: policy.satsPerBlock,
        split: policy.split,
        p2pk: SEEDER_P2PK,
        windowBlocks: 4,
      }),
    );
    const viewerPubkey = await viewerSigner.getPublicKey();
    viewerChan.sendHello(
      await payProtocol.buildHello(viewerSigner, viewerBinding, {
        acceptedMints: [MINT],
        satsPerBlock: 0 as Sats,
        split: { seeder: 50, creator: 50 },
        p2pk: ('02' + 'aa'.repeat(32)) as CashuP2pkPubkey,
        windowBlocks: 0,
      }),
    );
    await settle(50);
    expect(viewerChan.state).toBe('open');
    expect(seederChan.state).toBe('open');
    expect(session.pubkey).toBe(viewerPubkey);
    const seederHello = viewerChan.peer!;
    expect(seederHello.pubkey).toBe(await seederSigner.getPublicKey());

    // The viewer: real engine, paying with real ecash from the mint.
    const viewerEngine = new payment.RealPaymentEngine({
      config: {
        windowBlocks: 4,
        acceptedMints: [],
        ownP2pk: SEEDER_P2PK,
        ownPubkey: viewerPubkey,
        flushEveryBlocks: 64,
        flushEveryMs: 60_000,
      },
      wallet: {
        send: (amount, o) =>
          Promise.resolve({
            mint: o.mint,
            unit: 'sat',
            lockedTo: o.p2pk,
            proofs: mint.issue(amount, { p2pk: o.p2pk, ...(o.tags ? { tags: o.tags } : {}) }),
          }),
      },
    });
    const acks: AckMessage[] = [];
    viewerChan.on('ack', (a) => acks.push(a));
    const vcore = await viewerNode.blobs.openCoreByKey(Buffer.from(core, 'hex'));
    const seederInfo = { pubkey: seederHello.pubkey, p2pk: seederHello.p2pk, mint: MINT };

    let sent: PayMessage | null = null;
    for (const [from, to] of [
      [0, 3],
      [4, 7],
    ] as const) {
      for (let i = from; i <= to; i++)
        expect(await vcore.core.get(i, { wait: true, timeout: 3000 })).not.toBeNull();
      await settle(30);
      sent = await viewerEngine.pay({ core, fromBlock: from, toBlock: to }, seederInfo, policy);
      viewerChan.sendPay(sent);
      await settle(60);
    }
    expect(acks.map((a) => [a.core, a.fromBlock, a.toBlock, a.ok])).toEqual([
      [core, 0, 3, true],
      [core, 4, 7, true],
    ]);
    expect(engine.window(viewerPubkey)).toMatchObject({ uploaded: 8, paid: 8, outstanding: 0 });
    expect(await engine.flush()).toEqual({ swapped: 8, nutzapped: 8, failed: 0 });
    expect(nutzaps).toHaveLength(2);

    // The last 4 blocks arrive — and the viewer pays for them with the PREVIOUS PAY's proofs:
    // refused at verify as a double-spend, the viewer banned and cut.
    for (let i = 8; i < 12; i++)
      expect(await vcore.core.get(i, { wait: true, timeout: 3000 })).not.toBeNull();
    await settle(30);
    viewerChan.sendPay({ ...sent!, range: { core, fromBlock: 8, toBlock: 11 } });
    await settle(80);
    expect(engine.isBanned(viewerPubkey)).toBe(true);
    expect(session.cutReason).toBe('banned');
    const full = await vcore.blobs.get(put.entry.blob, { wait: false });
    expect(Buffer.from(full!).equals(Buffer.from(data))).toBe(true);
  });
});
