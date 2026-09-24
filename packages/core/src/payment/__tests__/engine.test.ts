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
import {
  MAX_KEYSETS_PER_SET,
  MAX_PROOFS_PER_SET,
  RealPaymentEngine,
  maxProofsFor,
  proofDleqOk,
  type DleqCheck,
  type PendingPay,
} from '../engine.js';
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

const total = (proofs: readonly CashuProof[]): number => proofs.reduce((a, p) => a + p.amount, 0);

/** A deterministic test key pair (the scalar is a test fixture, never a real key). */
function keyOf(fill: number): { sk: Uint8Array; pub: CashuP2pkPubkey } {
  const sk = new Uint8Array(32).fill(fill);
  return { sk, pub: hex(getPubKeyFromPrivKey(sk)) as CashuP2pkPubkey };
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

  // Stage 2 pre-push review (missed before: every fixture used one keyset). Each keyset id the
  // seeder has not cached may cost a lookup, and a peer names them freely.
  it(`a set naming more than ${String(MAX_KEYSETS_PER_SET)} keyset ids is malformed before any keyset lookup`, async () => {
    const lookups: string[] = [];
    const seeder = new RealPaymentEngine({
      config: getSeederEngine(WIDE_WINDOW).config,
      seen: new SeenSecrets(),
      keyset: (_mint, id) => {
        lookups.push(id);
        return Promise.resolve(undefined);
      },
    });
    const { viewer } = getPair('honest', WIDE_WINDOW);
    upload(seeder, VIEWER, 4);
    const honest = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    const p0 = honest.seederProofs.proofs[0]!;
    const spread: CashuProof[] = Array.from({ length: MAX_KEYSETS_PER_SET + 1 }, (_, i) => ({
      ...p0,
      id: `00${String(i).padStart(14, '0')}`,
      secret: `k${String(i)}`,
    }));
    const res = await seeder.verify(
      VIEWER,
      { ...honest, seederProofs: { ...honest.seederProofs, proofs: spread } },
      POLICY,
    );
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    expect(lookups).toEqual([]);
  });
});

describe('real engine — proof count vs amount (security review F5)', () => {
  // Missed before: every fixture paid with the wallet's powers of two. Each proof costs the
  // seeder a DLEQ check (~11 ms, ~20 ms under --jitless), so a payer that splits its sats into
  // one-sat proofs buys CPU at a sat a check.
  it('a set carrying more proofs than its amount needs is malformed before any keyset lookup; the honest split passes', async () => {
    const lookups: string[] = [];
    const base = getSeederEngine(WIDE_WINDOW);
    const seeder = new RealPaymentEngine({
      config: base.config,
      seen: new SeenSecrets(),
      keyset: (mint, id) => {
        lookups.push(id);
        const m = testMint(mint);
        return Promise.resolve(m.keysetId === id ? m.keyset() : undefined);
      },
    });
    // 4 blocks × 8 sat at 50/50 → 16 + 16.
    const p = policyWith({ satsPerBlock: sats(8) });
    upload(seeder, VIEWER, 4, { policy: p });
    const { viewer } = getPair('honest');
    const honest = await viewer.pay(range(0, 3), SEEDER_INFO, p);
    expect(maxProofsFor(16)).toBe(11);
    const dust = Array.from({ length: 16 }, () =>
      testMint(MINT_A).issue(1, { p2pk: SEEDER_P2PK }),
    ).flat();
    expect(dust).toHaveLength(16);
    const res = await seeder.verify(
      VIEWER,
      { ...honest, seederProofs: { ...honest.seederProofs, proofs: dust } },
      p,
    );
    expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    expect(lookups).toEqual([]);
    // The honest PAY for the same range is accepted.
    expect(await seeder.verify(VIEWER, honest, p)).toMatchObject({ ok: true, blocks: 4 });
  });

  it('maxProofsFor: bit length plus the reuse allowance, never above MAX_PROOFS_PER_SET', () => {
    expect(maxProofsFor(0)).toBe(6);
    expect(maxProofsFor(1)).toBe(7);
    expect(maxProofsFor(255)).toBe(14);
    expect(maxProofsFor(2 ** 40)).toBe(Math.min(MAX_PROOFS_PER_SET, 41 + 6));
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

describe('real engine — a PAY from a replaced channel (real-mint lane, network drop)', () => {
  // A PAY sent just before a connection dropped can still be verifying (its keyset loading) when
  // the viewer reconnects and the new channel's HELLO rebinds the account — which restarts the
  // carry at 0. Committed late, the old PAY would move that carry and every PAY on the new
  // channel would fail `carryIn`. It is refused instead.
  it('a PAY queued under the old channel and decided after the new channel bound is refused; the new channel pays from carry 0', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let slow = true;
    const base = getSeederEngine(WIDE_WINDOW);
    const seeder = new RealPaymentEngine({
      config: base.config,
      seen: new SeenSecrets(),
      keyset: async (mint, id) => {
        if (slow) {
          slow = false;
          await gate;
        }
        const m = testMint(mint);
        return m.keysetId === id ? m.keyset() : undefined;
      },
    });
    // 70/30 at 3 sat: a 2-block PAY moves the carry (6 × 30 = 180 → creator 1, carry 80).
    const p = policyWith({ satsPerBlock: sats(3), split: { seeder: 70, creator: 30 } });
    upload(seeder, VIEWER, 4, { policy: p });
    const { viewer } = getPair('honest');
    const old = await viewer.pay(range(0, 1), SEEDER_INFO, p, { carryIn: 0 });
    const late = seeder.verify(VIEWER, old, p); // queued on the old channel…
    upload(seeder, NOISE_ID, 2, { policy: p, from: 2 });
    seeder.rebind(NOISE_ID, VIEWER); // …the viewer reconnected: a new channel, carry 0
    release();
    expect(await late).toMatchObject({ ok: false, reason: 'malformed' });
    const fresh = await viewer.pay(range(2, 3), SEEDER_INFO, p, { carryIn: 0 });
    expect(await seeder.verify(VIEWER, fresh, p)).toMatchObject({ ok: true, blocks: 2 });
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

// ---------------------------------------------------------------------------------------------
// Security review F11, F12, F31: flush robustness, with real wallets on both sides.

describe('real engine — flush robustness (security review F11, F12, F31)', () => {
  const MINT = 'https://mint.flush.example' as MintUrl;

  async function world(
    deps: {
      check?: boolean;
      own?: boolean;
      persist?: (items: readonly PendingPay[]) => void;
      nutzap?: (set: LockedProofSet) => Promise<void>;
      feePpk?: number;
      onRedeem?: (n: number) => void;
    } = {},
  ) {
    const mint = new TestMint({
      url: MINT,
      seed: new Uint8Array(32).fill(41),
      inputFeePpk: deps.feePpk ?? 0,
    });
    const conns = (): CashuMintConnections =>
      new CashuMintConnections({ request: () => mint.request });
    const seederKey = keyOf(51);
    const creatorKey = keyOf(52);
    const viewerWallet = new CashuWallet({ mints: conns(), store: new MemoryProofStore() });
    const q = await viewerWallet.mintQuote(MINT, sats(200));
    mint.payQuote(q.quoteId);
    await viewerWallet.pollQuote(q);
    const seederWallet = new CashuWallet({
      mints: conns(),
      store: new MemoryProofStore(),
      key: memoryWalletKey(seederKey.sk),
    });
    const zaps: LockedProofSet[] = [];
    const config = {
      windowBlocks: 16,
      acceptedMints: [MINT],
      ownP2pk: seederKey.pub,
      ownPubkey: SEEDER,
      flushEveryBlocks: 64,
      flushEveryMs: 60_000,
    };
    const seederDeps = {
      config,
      keyset: (m: MintUrl, id: string) => seederWallet.keyset(m, id),
      redeem: (set: { mint: MintUrl; proofs: readonly CashuProof[] }) => {
        deps.onRedeem?.(set.proofs.length);
        return seederWallet.receive(set);
      },
      nutzap:
        deps.nutzap ??
        ((set: LockedProofSet) => {
          zaps.push(set);
          return Promise.resolve();
        }),
      ...(deps.check === true
        ? {
            checkSpent: (s: { mint: MintUrl; proofs: readonly CashuProof[] }) =>
              seederWallet.checkSpent(s),
          }
        : {}),
      ...(deps.own === true
        ? {
            spentByUs: (s: { mint: MintUrl; proofs: readonly CashuProof[] }) =>
              seederWallet.spentByUs(s),
          }
        : {}),
      ...(deps.persist ? { persistPending: deps.persist } : {}),
    };
    const seeder = new RealPaymentEngine({ ...seederDeps, seen: new SeenSecrets() });
    const viewer = new RealPaymentEngine({
      config: { ...config, acceptedMints: [], ownPubkey: VIEWER },
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
    upload(seeder, VIEWER, 8, { core: CORE_B, policy });
    const msg = await viewer.pay(range(0, 3, CORE_B), who, policy);
    expect(await seeder.verify(VIEWER, msg, policy)).toMatchObject({ ok: true });
    /** Another viewer, same wallet funds, paying `target` for `blocks` blocks at `p`. */
    const otherViewer = async (
      target: RealPaymentEngine,
      blocks: number,
      p: PricePolicy = policy,
    ): Promise<PayMessage> => {
      const v2 = new RealPaymentEngine({
        config: { ...config, acceptedMints: [], ownPubkey: OTHER_VIEWER },
        wallet: viewerWallet,
      });
      upload(target, OTHER_VIEWER, blocks, { core: CORE_B, policy: p });
      return v2.pay(range(0, blocks - 1, CORE_B), who, p);
    };
    return { mint, seeder, seederWallet, seederDeps, msg, policy, zaps, otherViewer };
  }

  it('F31: a redeem whose response was lost is recognised as OUR spend — no ban, the creator is still paid', async () => {
    const w = await world({ own: true });
    w.mint.dropNextResponse();
    expect(await w.seeder.flush()).toEqual({ swapped: 0, nutzapped: 0, failed: 0 }); // ambiguous: kept
    expect(w.seeder.pendingCount()).toBe(1);
    const r = await w.seeder.flush(); // the mint now answers "already spent" — by us
    expect(r).toEqual({ swapped: 12, nutzapped: 8, failed: 0 });
    expect(w.seeder.isBanned(VIEWER)).toBe(false);
    expect(w.zaps).toHaveLength(1);
  });

  it('F31: without the check (or when someone else spent it) the same "spent" is a double-spend ban', async () => {
    const w = await world({ own: true });
    // Someone else — the viewer, elsewhere — spent the seeder set first: no witness of ours.
    w.mint.markSpent(w.msg.seederProofs.proofs);
    expect(await w.seeder.flush()).toMatchObject({ failed: 1 });
    expect(w.seeder.isBanned(VIEWER)).toBe(true);
    expect(w.zaps).toHaveLength(0);
    const legacy = await world();
    legacy.mint.dropNextResponse();
    await legacy.seeder.flush();
    expect(await legacy.seeder.flush()).toMatchObject({ failed: 1 });
    expect(legacy.seeder.isBanned(VIEWER)).toBe(true);
  });

  // Found while planning the real-mint lane: a set we redeemed BEFORE a restart that lost the
  // seen set also carries our witness. Only a retried redeem may be read as our own lost swap.
  it('F31: a replay, after a restart, of a set we already redeemed is a double-spend even though the witness is ours', async () => {
    const w = await world({ own: true });
    expect(await w.seeder.flush()).toMatchObject({ swapped: 12, failed: 0 });
    // Restart without the seen set: the replay passes the offline checks…
    const after = new RealPaymentEngine({ ...w.seederDeps, seen: new SeenSecrets() });
    upload(after, VIEWER, 8, { core: CORE_B, policy: w.policy });
    const replay = { ...w.msg, range: { ...w.msg.range, fromBlock: 4, toBlock: 7 } };
    expect(await after.verify(VIEWER, replay, w.policy)).toMatchObject({ ok: true });
    // …but its FIRST redeem is answered "spent": a double-spend, ban.
    expect(await after.flush()).toMatchObject({ swapped: 0, failed: 1 });
    expect(after.isBanned(VIEWER)).toBe(true);
  });

  it('F31 + F12: a crash right after the redeem was sent restores as "tried", and the retry reads our own spend correctly', async () => {
    const snapshots: (readonly PendingPay[])[] = [];
    const w = await world({ own: true, persist: (items) => snapshots.push(items) });
    w.mint.dropNextResponse();
    await w.seeder.flush(); // the swap happened at the mint; we never heard back
    const last = snapshots.at(-1)!;
    expect(last[0]).toMatchObject({ stage: 'redeem', redeemTried: true });
    const after = new RealPaymentEngine({ ...w.seederDeps, seen: new SeenSecrets() });
    after.restorePending(last);
    expect(await after.flush()).toEqual({ swapped: 12, nutzapped: 8, failed: 0 });
    expect(after.isBanned(VIEWER)).toBe(false);
  });

  // Found by the real-mint lane (Nutshell, 100 ppk input fee): a 1-sat seeder set can never be
  // redeemed alone — the fee eats it ("no outputs provided") — so the item sat in the retry
  // queue forever and its creator share was never forwarded. Redeems are now batched per mint.
  it('real-mint finding: several accepted PAYs are redeemed in ONE swap per mint', async () => {
    const calls: number[] = [];
    const w = await world({ onRedeem: (n) => calls.push(n) });
    const second = await w.otherViewer(w.seeder, 2);
    expect(await w.seeder.verify(OTHER_VIEWER, second, w.policy)).toMatchObject({ ok: true });
    expect(await w.seeder.flush()).toMatchObject({ failed: 0 });
    expect(calls).toEqual([w.msg.seederProofs.proofs.length + second.seederProofs.proofs.length]);
    expect(w.seeder.pendingCount()).toBe(0);
  });

  it('real-mint finding: dust below the mint fee waits in the queue — kept, not dropped, not a double-spend', async () => {
    const w = await world({ feePpk: 1000 }); // 1 sat per input: a lone 1-sat proof is worth nothing
    await w.seeder.flush(); // the world's own PAY clears first
    const dustPolicy = { ...w.policy, satsPerBlock: sats(1), split: { seeder: 50, creator: 50 } };
    // 2 blocks × 1 sat at 50/50: a 1-sat seeder set, which alone cannot pay its own fee.
    const dust = await w.otherViewer(w.seeder, 2, dustPolicy);
    expect(total(dust.seederProofs.proofs)).toBe(1);
    expect(await w.seeder.verify(OTHER_VIEWER, dust, dustPolicy)).toMatchObject({ ok: true });
    expect(await w.seeder.flush()).toMatchObject({ swapped: 0, failed: 0 });
    expect(w.seeder.pendingCount()).toBe(1);
    expect(w.seeder.isBanned(OTHER_VIEWER)).toBe(false);
  });

  it('a batch holding one replayed set: only that PAY is a double-spend, the honest PAY in the same swap redeems (checkSpent attribution)', async () => {
    const w = await world({ own: true, check: true });
    expect(await w.seeder.flush()).toMatchObject({ swapped: 12 });
    // Restart without the seen set; the viewer replays its redeemed set while another viewer pays
    // honestly — both land in one batch.
    const after = new RealPaymentEngine({ ...w.seederDeps, seen: new SeenSecrets() });
    upload(after, VIEWER, 8, { core: CORE_B, policy: w.policy });
    const replay = { ...w.msg, range: { ...w.msg.range, fromBlock: 4, toBlock: 7 } };
    expect(await after.verify(VIEWER, replay, w.policy)).toMatchObject({ ok: true });
    const honest = await w.otherViewer(after, 4);
    expect(await after.verify(OTHER_VIEWER, honest, w.policy)).toMatchObject({ ok: true });
    const r = await after.flush();
    expect(r.failed).toBe(1);
    expect(r.swapped).toBe(total(honest.seederProofs.proofs));
    expect(after.isBanned(VIEWER)).toBe(true);
    expect(after.isBanned(OTHER_VIEWER)).toBe(false);
  });

  it('F34: creator sets of one flush that share creator × mint × core go out as ONE nutzap; a double-spent one is dropped and only its viewer banned', async () => {
    const w = await world({ check: true });
    const honest = await w.otherViewer(w.seeder, 2);
    expect(await w.seeder.verify(OTHER_VIEWER, honest, w.policy)).toMatchObject({ ok: true });
    // The first viewer spent its creator set before we forwarded it.
    w.mint.markSpent(w.msg.creatorProofs.proofs);
    const r = await w.seeder.flush();
    expect(r.failed).toBe(1);
    expect(w.seeder.isBanned(VIEWER)).toBe(true);
    expect(w.seeder.isBanned(OTHER_VIEWER)).toBe(false);
    expect(w.zaps).toHaveLength(1);
    expect(w.zaps[0]!.proofs).toEqual(honest.creatorProofs.proofs);
    expect(r.nutzapped).toBe(total(honest.creatorProofs.proofs));
    // Two honest viewers: one nutzap carrying both creator sets.
    const w2 = await world();
    const second = await w2.otherViewer(w2.seeder, 2);
    expect(await w2.seeder.verify(OTHER_VIEWER, second, w2.policy)).toMatchObject({ ok: true });
    await w2.seeder.flush();
    expect(w2.zaps).toHaveLength(1);
    expect(total(w2.zaps[0]!.proofs)).toBe(
      total(w2.msg.creatorProofs.proofs) + total(second.creatorProofs.proofs),
    );
  });

  it('F11: a creator set spent before it is forwarded is a double-spend of the creator share — ban, no nutzap', async () => {
    const w = await world({ check: true });
    w.mint.markSpent(w.msg.creatorProofs.proofs);
    const r = await w.seeder.flush();
    expect(r).toEqual({ swapped: 12, nutzapped: 0, failed: 1 });
    expect(w.seeder.isBanned(VIEWER)).toBe(true);
    expect(w.zaps).toHaveLength(0);
  });

  it('F11: the creator set is checked only before its FIRST nutzap — a retry never reads the creator’s own redemption as fraud', async () => {
    let fail = true;
    const zaps: LockedProofSet[] = [];
    const w = await world({
      check: true,
      nutzap: (set) => {
        if (fail) return Promise.reject(new Error('relay down (but the event may have landed)'));
        zaps.push(set);
        return Promise.resolve();
      },
    });
    expect(await w.seeder.flush()).toMatchObject({ swapped: 12, nutzapped: 0, failed: 0 });
    // The nutzap reached a relay after all and the creator redeemed it.
    w.mint.markSpent(w.msg.creatorProofs.proofs);
    fail = false;
    expect(await w.seeder.flush()).toEqual({ swapped: 0, nutzapped: 8, failed: 0 });
    expect(w.seeder.isBanned(VIEWER)).toBe(false);
    expect(zaps).toHaveLength(1);
  });

  it('F12: accepted PAYs are handed to persistPending before verify resolves, and restorePending brings them back after a crash', async () => {
    const snapshots: (readonly PendingPay[])[] = [];
    const w = await world({ persist: (items) => snapshots.push(items) });
    expect(snapshots.at(-1)).toHaveLength(1);
    expect(snapshots.at(-1)?.[0]).toMatchObject({ peer: VIEWER, stage: 'redeem' });
    // "Crash": a new engine on the same wallet, restored from the last snapshot.
    const after = new RealPaymentEngine({ ...w.seederDeps, seen: new SeenSecrets() });
    after.restorePending(snapshots.at(-1)!);
    expect(after.pendingCount()).toBe(1);
    expect(await after.flush()).toEqual({ swapped: 12, nutzapped: 8, failed: 0 });
    expect(await w.seederWallet.balance(MINT)).toBe(12);
    // The restored secrets are still "seen": replaying them is a double-spend.
    upload(after, VIEWER, 8, { core: CORE_B, policy: w.policy });
    const replay = { ...w.msg, range: { ...w.msg.range, fromBlock: 4, toBlock: 7 } };
    expect(await after.verify(VIEWER, replay, w.policy)).toMatchObject({
      ok: false,
      reason: 'double-spend',
    });
  });
});

describe('F5: DLEQ checks off the event loop (deps.dleq)', () => {
  type Verifier = (checks: readonly DleqCheck[]) => Promise<readonly boolean[]>;
  function seederWith(dleq: Verifier): RealPaymentEngine {
    const m = testMint(MINT_A);
    return new RealPaymentEngine({
      config: {
        windowBlocks: 8,
        ownP2pk: SEEDER_P2PK,
        ownPubkey: SEEDER,
        acceptedMints: [MINT_A],
        flushEveryBlocks: 64,
        flushEveryMs: 60_000,
      },
      seen: new SeenSecrets(),
      keyset: (mint, id) =>
        Promise.resolve(mint === MINT_A && id === m.keysetId ? m.keyset() : undefined),
      redeem: (set) => Promise.resolve(total(set.proofs) as ReturnType<typeof sats>),
      nutzap: () => Promise.resolve(),
      dleq,
    });
  }
  const honestRun: Verifier = (checks) =>
    Promise.resolve(checks.map((c) => proofDleqOk(c.proof, c.keyset)));

  it("sends every proof of a PAY in ONE call, each with only its amount's key, and honours the answers", async () => {
    const calls: (readonly DleqCheck[])[] = [];
    const seeder = seederWith((checks) => {
      calls.push(checks);
      return honestRun(checks);
    });
    const { viewer } = getPair('honest');
    upload(seeder, VIEWER, 4);
    const msg = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, msg, POLICY)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    const proofs = [...msg.seederProofs.proofs, ...msg.creatorProofs.proofs];
    expect(calls[0]).toHaveLength(proofs.length);
    for (const [i, c] of (calls[0] ?? []).entries()) {
      expect(c.proof).toBe(proofs[i]);
      expect(Object.keys(c.keyset.keys)).toEqual([String(c.proof.amount)]);
    }
  });

  it('a "false" from the verifier is a forgery: bad-dleq and a ban', async () => {
    const seeder = seederWith((checks) => Promise.resolve(checks.map((_c, i) => i !== 0)));
    const { viewer } = getPair('honest');
    upload(seeder, VIEWER, 4);
    const msg = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, msg, POLICY)).toMatchObject({
      ok: false,
      reason: 'bad-dleq',
    });
    expect(seeder.isBanned(VIEWER)).toBe(true);
  });

  it('a verifier that throws or answers the wrong length falls back to the synchronous check', async () => {
    for (const broken of [
      (() => Promise.reject(new Error('worker died'))) as Verifier,
      (() => Promise.resolve([true])) as Verifier,
    ]) {
      const seeder = seederWith(broken);
      const honest = getPair('honest').viewer;
      upload(seeder, VIEWER, 4);
      expect(
        await seeder.verify(VIEWER, await honest.pay(range(0, 3), SEEDER_INFO, POLICY), POLICY),
      ).toMatchObject({
        ok: true,
      });
      // …and a forged DLEQ is still caught by the fallback, never accepted.
      const forger = getPair('forge').viewer;
      upload(seeder, OTHER_VIEWER, 4);
      expect(
        await seeder.verify(
          OTHER_VIEWER,
          await forger.pay(range(0, 3), SEEDER_INFO, POLICY),
          POLICY,
        ),
      ).toMatchObject({ ok: false, reason: 'bad-dleq' });
    }
  });

  it('state that moves while the verifier runs is seen: a peer banned meanwhile is refused', async () => {
    let release: () => void = () => undefined;
    const seeder = seederWith(async (checks) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return honestRun(checks);
    });
    const { viewer } = getPair('honest');
    upload(seeder, VIEWER, 4);
    const msg = await viewer.pay(range(0, 3), SEEDER_INFO, POLICY);
    const pending = seeder.verify(VIEWER, msg, POLICY);
    await vi.waitFor(() => {
      expect(release).not.toBe(undefined);
    });
    await new Promise((r) => setTimeout(r, 0));
    // The peer blows its window while its PAY is being checked off-thread.
    upload(seeder, VIEWER, 20, { from: 4 });
    expect(seeder.isBanned(VIEWER)).toBe(true);
    release();
    expect(await pending).toMatchObject({ ok: false, reason: 'peer-banned' });
  });
});
