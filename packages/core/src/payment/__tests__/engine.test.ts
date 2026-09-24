/**
 * The real engine — adversary cases the L10 suite did not have, and why it could not:
 *
 *   - lock-policy abuse inside the secret (refund path, extra keys, a missing / foreign `pay1`
 *     binding): the v4 reference model never parsed secrets, and `pay1` is new in v5;
 *   - keyset confusion (another mint's keyset under this mint's envelope, a keyset the seeder has
 *     not cached): the model's DLEQ was a string compare, it had no keysets;
 *   - races (the same proofs from two peers at once; a peer's PAYs decided out of order; a
 *     `rebind` while a PAY waits for its keyset): the model was synchronous;
 *   - flush failures (mint down, relay down) and the viewer's orphaned seeder set: the model had
 *     no mint and no relay;
 *   - an end-to-end run with REAL wallets on both sides (witness signing at redeem, the creator
 *     redeeming its nutzap): the model had no wallet.
 */
import { describe, expect, it, vi } from 'vitest';
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';

import type {
  CashuP2pkPubkey,
  CashuProof,
  LockedProofSet,
  MintUrl,
  PayMessage,
  PricePolicy,
  Wallet,
} from '../../contracts/index.js';
import { TestMint } from '../../mocks/test-mint.js';
import { MemoryProofStore } from '../../wallet/store.js';
import { CashuMintConnections, CashuWallet, memoryWalletKey } from '../../wallet/wallet.js';
import { MAX_PROOFS_PER_SET, RealPaymentEngine } from '../engine.js';
import { PAY1_TAG } from '../lock.js';
import { SeenSecrets } from '../seen.js';
import {
  CORE_B,
  CREATOR_P2PK,
  MINT_A,
  MINT_B,
  NOISE_ID,
  NUTZAPS,
  OTHER_SEEDER_P2PK,
  OTHER_VIEWER,
  POLICY,
  SEEDER,
  SEEDER_INFO,
  SEEDER_P2PK,
  VIEWER,
  WIDE_WINDOW,
  getPair,
  getSeederEngine,
  policyWith,
  range,
  sats,
  testMint,
  upload,
} from './provider.mjs';

vi.setConfig({ testTimeout: 120_000 });

/** A PAY whose seeder set is issued with `secret`-level options the honest viewer never uses. */
function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function relock(
  msg: PayMessage,
  which: 'seederProofs' | 'creatorProofs',
  target: string,
  tags: string[][],
): PayMessage {
  const set = msg[which];
  const amount = set.proofs.reduce((a, p) => a + p.amount, 0);
  const proofs = testMint(set.mint).issue(amount, { p2pk: target, tags });
  return { ...msg, [which]: { ...set, proofs } };
}

describe('real engine — the lock inside the secret (ADR 0010 §6)', () => {
  for (const [name, which, tags, target] of [
    [
      'a seeder set with a refund path (the payer can take it back after the locktime)',
      'seederProofs',
      [
        ['locktime', '1'],
        ['refund', OTHER_SEEDER_P2PK],
      ],
      SEEDER_P2PK,
    ],
    [
      'a seeder set another key can also spend (pubkeys, n_sigs 1)',
      'seederProofs',
      [['pubkeys', OTHER_SEEDER_P2PK]],
      SEEDER_P2PK,
    ],
    ['a creator set with no seeder binding', 'creatorProofs', [], CREATOR_P2PK],
    [
      'a creator set bound to ANOTHER seeder (lifted from its public nutzap)',
      'creatorProofs',
      [[PAY1_TAG, OTHER_SEEDER_P2PK]],
      CREATOR_P2PK,
    ],
    [
      'a creator set with a refund path',
      'creatorProofs',
      [
        [PAY1_TAG, SEEDER_P2PK],
        ['locktime', '1'],
      ],
      CREATOR_P2PK,
    ],
    [
      'a creator set with an unknown spending tag',
      'creatorProofs',
      [
        [PAY1_TAG, SEEDER_P2PK],
        ['x-rule', '1'],
      ],
      CREATOR_P2PK,
    ],
  ] as const) {
    it(`refuses ${name} as wrong-p2pk-target, crediting nothing`, async () => {
      const { viewer, seeder } = getPair('honest');
      upload(seeder, VIEWER, 4);
      const honest = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
      const msg = relock(
        honest,
        which,
        target,
        tags.map((t) => [...t]),
      );
      expect(msg[which].lockedTo).toBe(target); // the envelope is right; the secret is not
      expect(await seeder.verify(VIEWER, msg, POLICY)).toMatchObject({
        ok: false,
        reason: 'wrong-p2pk-target',
      });
      expect(seeder.window(VIEWER)?.paid).toBe(0);
    });
  }
});

describe('real engine — keysets (T7)', () => {
  it('another mint’s proofs under this mint’s envelope, and a keyset the seeder has not cached, are bad-dleq WITHOUT a ban; a forged DLEQ against a known keyset bans', async () => {
    const seeder = getSeederEngine({
      config: { acceptedMints: [MINT_A, MINT_B], windowBlocks: 100 },
    });
    const policy = policyWith({ mints: [MINT_A, MINT_B] });
    upload(seeder, VIEWER, 8);
    const { viewer } = getPair('honest');
    const onB = await viewer.pay(range(0, 3), { ...SEEDER_INFO, mint: MINT_B }, policy);
    // Relabel B's proofs as A's: the keyset id is B's, so (A, id) is unknown.
    const confused: PayMessage = {
      ...onB,
      seederProofs: { ...onB.seederProofs, mint: MINT_A },
      creatorProofs: { ...onB.creatorProofs, mint: MINT_A },
    };
    expect(await seeder.verify(VIEWER, confused, policy)).toMatchObject({
      ok: false,
      reason: 'bad-dleq',
      detail: 'unknown keyset',
    });
    expect(seeder.isBanned(VIEWER)).toBe(false);
    // A seeder with no keyset source at all refuses (cannot verify offline) — and does not ban.
    const blind = new RealPaymentEngine({
      config: { ...seeder.config },
      seen: new SeenSecrets(),
    });
    upload(blind, VIEWER, 4);
    const onA = await viewer.pay(range(0, 3), SEEDER_INFO, policy);
    expect(await blind.verify(VIEWER, onA, policy)).toMatchObject({
      ok: false,
      reason: 'bad-dleq',
    });
    expect(blind.isBanned(VIEWER)).toBe(false);
    // The genuine B PAY is accepted.
    expect(await seeder.verify(VIEWER, onB, policy)).toMatchObject({ ok: true });
    // A forged DLEQ against a KNOWN keyset is a forgery: banned.
    const forged: PayMessage = {
      ...onA,
      range: range(4, 7),
      seederProofs: {
        ...onA.seederProofs,
        proofs: onA.seederProofs.proofs.map((p) => ({
          ...p,
          dleq: { ...p.dleq!, s: '11'.repeat(32) },
        })),
      },
    };
    expect(await seeder.verify(VIEWER, forged, policy)).toMatchObject({
      ok: false,
      reason: 'bad-dleq',
    });
    expect(seeder.isBanned(VIEWER)).toBe(true);
  });

  it(`a set with more than ${String(MAX_PROOFS_PER_SET)} proofs is malformed before any DLEQ runs (a CPU lever, T11)`, async () => {
    const { viewer, seeder } = getPair('honest', WIDE_WINDOW);
    upload(seeder, VIEWER, 4);
    const honest = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    const many: CashuProof[] = Array.from({ length: MAX_PROOFS_PER_SET + 1 }, (_, i) => ({
      ...honest.seederProofs.proofs[0]!,
      secret: `s${String(i)}`,
    }));
    const started = Date.now();
    const res = await seeder.verify(
      VIEWER,
      { ...honest, seederProofs: { ...honest.seederProofs, proofs: many } },
      POLICY,
    );
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('real engine — races', () => {
  it('the same proofs from two peers at once: exactly one is credited, the other is a double-spend', async () => {
    const seeder = getSeederEngine(WIDE_WINDOW);
    upload(seeder, VIEWER, 4);
    upload(seeder, OTHER_VIEWER, 4);
    const msg = await getPair('honest').viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    const [a, b] = await Promise.all([
      seeder.verify(VIEWER, msg, POLICY),
      seeder.verify(OTHER_VIEWER, msg, POLICY),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({ ok: false, reason: 'double-spend' });
  });

  it('a peer’s PAYs are decided in arrival order even when the first waits longer for its keyset (the carry chains them)', async () => {
    let slow = true;
    const base = getSeederEngine(WIDE_WINDOW);
    const seeder = new RealPaymentEngine({
      config: base.config,
      seen: new SeenSecrets(),
      keyset: async (mint, id) => {
        if (slow) {
          slow = false;
          await new Promise((r) => setTimeout(r, 30));
        }
        const m = testMint(mint);
        return m.keysetId === id ? m.keyset() : undefined;
      },
    });
    // 70/30 at 3 sat: each 1-block PAY moves the carry (90 → carry 90, then 80, …).
    const p = policyWith({ satsPerBlock: sats(3), split: { seeder: 70, creator: 30 } });
    upload(seeder, VIEWER, 2, { policy: p });
    const { viewer } = getPair('honest');
    const one = await viewer.pay(range(0, 0), SEEDER_INFO, p);
    const two = await viewer.pay(range(1, 1), SEEDER_INFO, p);
    expect(two.carryIn).not.toBe(0);
    const [r1, r2] = await Promise.all([
      seeder.verify(VIEWER, one, p),
      seeder.verify(VIEWER, two, p),
    ]);
    expect(r1).toMatchObject({ ok: true });
    expect(r2).toMatchObject({ ok: true });
  });

  it('a rebind while a PAY waits for its keyset: the PAY is decided against the state it finds when the keyset arrives', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const base = getSeederEngine(WIDE_WINDOW);
    const seeder = new RealPaymentEngine({
      config: base.config,
      seen: new SeenSecrets(),
      keyset: async (mint, id) => {
        await gate;
        const m = testMint(mint);
        return m.keysetId === id ? m.keyset() : undefined;
      },
    });
    upload(seeder, NOISE_ID, 4);
    const msg = await getPair('honest').viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    const pending = seeder.verify(NOISE_ID, msg, POLICY);
    // HELLO arrives: the provisional id is gone before the PAY finishes.
    seeder.rebind(NOISE_ID, VIEWER);
    release();
    expect(await pending).toMatchObject({ ok: false, reason: 'range-not-uploaded' });
    expect(seeder.window(VIEWER)).toMatchObject({ uploaded: 4, paid: 0 });
  });
});

describe('real engine — flush never drops the creator’s money', () => {
  it('a mint outage keeps the item; a relay outage keeps the creator set without redeeming the seeder set twice', async () => {
    let mintDown = true;
    let relayDown = true;
    const redeemed: number[] = [];
    const zaps: LockedProofSet[] = [];
    const base = getSeederEngine();
    const seeder = new RealPaymentEngine({
      config: base.config,
      seen: new SeenSecrets(),
      keyset: (mint, id) =>
        Promise.resolve(testMint(mint).keysetId === id ? testMint(mint).keyset() : undefined),
      redeem: (set) => {
        if (mintDown) return Promise.reject(new Error('mint unreachable'));
        redeemed.push(set.proofs.reduce((a, p) => a + p.amount, 0));
        return Promise.resolve(sats(0));
      },
      nutzap: (set) => {
        if (relayDown) return Promise.reject(new Error('relay unreachable'));
        zaps.push(set);
        return Promise.resolve();
      },
    });
    upload(seeder, VIEWER, 4);
    const msg = await getPair('honest').viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, msg, POLICY)).toMatchObject({ ok: true });
    expect(await seeder.flush()).toEqual({ swapped: 0, nutzapped: 0, failed: 0 });
    expect(seeder.pendingCount()).toBe(1);
    mintDown = false;
    expect(await seeder.flush()).toEqual({ swapped: 4, nutzapped: 0, failed: 0 });
    expect(seeder.pendingCount()).toBe(1); // the creator set still waits for a relay
    relayDown = false;
    expect(await seeder.flush()).toEqual({ swapped: 0, nutzapped: 4, failed: 0 });
    expect(redeemed).toEqual([4]); // redeemed exactly once
    expect(zaps).toHaveLength(1);
    expect(seeder.pendingCount()).toBe(0);
  });

  it('two concurrent flushes run once', async () => {
    const { viewer, seeder } = getPair('honest');
    upload(seeder, VIEWER, 4);
    expect(
      await seeder.verify(VIEWER, await viewer.pay(range(0, 3), SEEDER_INFO, POLICY), POLICY),
    ).toMatchObject({ ok: true });
    const before = NUTZAPS.length;
    const [a, b] = await Promise.all([seeder.flush(), seeder.flush()]);
    expect(a).toBe(b);
    expect(NUTZAPS.length - before).toBe(1);
  });
});

describe('real engine — the viewer side', () => {
  it('never pays at a mint the video does not list, and never more than blocks × price', async () => {
    const pays: number[] = [];
    const wallet: Pick<Wallet, 'send'> = {
      send: (amount, o) => {
        pays.push(amount);
        return Promise.resolve({
          mint: o.mint,
          unit: 'sat',
          lockedTo: o.p2pk,
          proofs: testMint(o.mint).issue(amount, {
            p2pk: o.p2pk,
            ...(o.tags ? { tags: o.tags } : {}),
          }),
        });
      },
    };
    const viewer = new RealPaymentEngine({
      config: {
        windowBlocks: 4,
        acceptedMints: [],
        ownP2pk: SEEDER_P2PK,
        ownPubkey: VIEWER,
        flushEveryBlocks: 64,
        flushEveryMs: 60_000,
      },
      wallet,
    });
    await expect(viewer.pay(range(0, 3), { ...SEEDER_INFO, mint: MINT_B }, POLICY)).rejects.toThrow(
      /does not accept this mint/,
    );
    expect(pays).toEqual([]);
    const msg = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    expect(pays.reduce((a, b) => a + b, 0)).toBe(4 * POLICY.satsPerBlock);
    expect(msg.creatorProofs.proofs.every((p) => p.secret.includes(PAY1_TAG))).toBe(true);
  });

  it('a creator send that fails after the seeder set was made keeps the seeder set and spends it first next time (a delay, not a loss)', async () => {
    let failCreator = true;
    const sends: { amount: number; to: string }[] = [];
    const wallet: Pick<Wallet, 'send'> = {
      send: (amount, o) => {
        if (o.p2pk === CREATOR_P2PK && failCreator) return Promise.reject(new Error('mint down'));
        sends.push({ amount, to: o.p2pk });
        return Promise.resolve({
          mint: o.mint,
          unit: 'sat',
          lockedTo: o.p2pk,
          proofs: testMint(o.mint).issue(amount, {
            p2pk: o.p2pk,
            ...(o.tags ? { tags: o.tags } : {}),
          }),
        });
      },
    };
    const viewer = new RealPaymentEngine({
      config: {
        windowBlocks: 4,
        acceptedMints: [],
        ownP2pk: SEEDER_P2PK,
        ownPubkey: VIEWER,
        flushEveryBlocks: 64,
        flushEveryMs: 60_000,
      },
      wallet,
    });
    await expect(viewer.pay(range(0, 3), SEEDER_INFO, POLICY)).rejects.toThrow(/mint down/);
    expect(sends).toEqual([{ amount: 4, to: SEEDER_P2PK }]); // the seeder set was made
    failCreator = false;
    const msg = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY, { carryIn: 0 });
    // The orphaned 4-sat seeder set is reused: no new seeder send, only the creator's.
    expect(sends).toEqual([
      { amount: 4, to: SEEDER_P2PK },
      { amount: 4, to: CREATOR_P2PK },
    ]);
    const seeder = getSeederEngine();
    upload(seeder, VIEWER, 4);
    expect(await seeder.verify(VIEWER, msg, POLICY)).toMatchObject({ ok: true });
  });
});

describe('real engine — end to end with real wallets on both sides', () => {
  function keyOf(fill: number): { sk: Uint8Array; pub: CashuP2pkPubkey } {
    const sk = new Uint8Array(32).fill(fill);
    return { sk, pub: hex(getPubKeyFromPrivKey(sk)) as CashuP2pkPubkey };
  }

  it('viewer wallet pays → seeder verifies → flush redeems the seeder set with its own key; the creator redeems its nutzap; a replay is caught; the seeder cannot redeem the creator set', async () => {
    const MINT = 'https://mint.e2e.example' as MintUrl;
    const mint = new TestMint({ url: MINT, seed: new Uint8Array(32).fill(9), inputFeePpk: 0 });
    const conns = (): CashuMintConnections =>
      new CashuMintConnections({ request: () => mint.request });
    const seederKey = keyOf(31);
    const creatorKey = keyOf(32);

    const viewerWallet = new CashuWallet({ mints: conns(), store: new MemoryProofStore() });
    const q = await viewerWallet.mintQuote(MINT, sats(200));
    mint.payQuote(q.quoteId);
    await viewerWallet.pollQuote(q);

    const seederWallet = new CashuWallet({
      mints: conns(),
      store: new MemoryProofStore(),
      key: memoryWalletKey(seederKey.sk),
    });
    const creatorWallet = new CashuWallet({
      mints: conns(),
      store: new MemoryProofStore(),
      key: memoryWalletKey(creatorKey.sk),
    });
    const zaps: LockedProofSet[] = [];
    const seeder = new RealPaymentEngine({
      config: {
        windowBlocks: 4,
        acceptedMints: [MINT],
        ownP2pk: seederKey.pub,
        ownPubkey: SEEDER,
        flushEveryBlocks: 64,
        flushEveryMs: 60_000,
      },
      seen: new SeenSecrets(),
      keyset: (m, id) => seederWallet.keyset(m, id),
      redeem: (set) => seederWallet.receive(set),
      nutzap: (set) => {
        zaps.push(set);
        return Promise.resolve();
      },
    });
    const viewer = new RealPaymentEngine({
      config: {
        windowBlocks: 4,
        acceptedMints: [],
        ownP2pk: seederKey.pub,
        ownPubkey: VIEWER,
        flushEveryBlocks: 64,
        flushEveryMs: 60_000,
      },
      wallet: viewerWallet,
    });
    const policy: PricePolicy = {
      satsPerBlock: sats(5),
      blockSize: 65_536,
      mints: [MINT],
      split: { seeder: 60, creator: 40 },
      creatorP2pk: creatorKey.pub,
      minPaySats: sats(1),
    };
    const who = { pubkey: SEEDER, p2pk: seederKey.pub, mint: MINT };

    upload(seeder, VIEWER, 4, { core: CORE_B, policy });
    const msg = await viewer.pay(range(0, 3, CORE_B), who, policy);
    expect(await seeder.verify(VIEWER, msg, policy)).toEqual({ ok: true, credited: 20, blocks: 4 });
    expect(await viewerWallet.balance(MINT)).toBe(200 - 20);

    const r = await seeder.flush();
    expect(r).toEqual({ swapped: 12, nutzapped: 8, failed: 0 });
    expect(await seederWallet.balance(MINT)).toBe(12);

    // The seeder cannot redeem the creator's share; the creator can.
    await expect(seederWallet.receive(zaps[0]!)).rejects.toMatchObject({ code: 'not-ours' });
    expect(await creatorWallet.receive(zaps[0]!)).toBe(8);

    // A replay of the same PAY (new range) is refused at verify and bans the viewer.
    upload(seeder, VIEWER, 4, { core: CORE_B, policy, from: 4 });
    const replay: PayMessage = { ...msg, range: range(4, 7, CORE_B) };
    expect(await seeder.verify(VIEWER, replay, policy)).toMatchObject({
      ok: false,
      reason: 'double-spend',
    });
    expect(seeder.isBanned(VIEWER)).toBe(true);
  });
});
