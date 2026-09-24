/**
 * Payout (`runtime/payout.ts`): the seeder's balance leaves for the owner's own wallet as a NIP-61
 * nutzap locked to the owner's P2PK key — real ecash from the in-process `TestMint`, a
 * `FakeRelayPool` for the relays. Threshold, the swap fee, the owner redeeming, a publish that
 * fails and is retried (also after a restart), one run at a time, and the config section.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { NostrKind, mocks, nostr, signer as signerMod, wallet as walletMod } from '@sovit/core';
import type { CashuP2pkPubkey, MintUrl, NostrPubkey, RelayUrl, Sats } from '@sovit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateDaemonConfig } from '../cli/config-file.js';
import { Payout } from '../runtime/payout.js';
import { capturedLogger, tmpDir } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

const MINT = 'https://mint.payout.example' as MintUrl;
const RELAY = 'wss://owner-relay.example' as RelayUrl;
const OWNER_SK = new Uint8Array(32).fill(0x0e);
const OWNER_P2PK = Buffer.from(getPubKeyFromPrivKey(OWNER_SK)).toString('hex') as CashuP2pkPubkey;
const OWNER = '0e'.repeat(32) as NostrPubkey;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** The owner's own signed kind 10019 naming `p2pk` (their NIP-61 wallet publishes it). */
async function ownerInfo(owner: signerMod.LocalSigner, p2pk: string) {
  return owner.signEvent({
    kind: NostrKind.NutzapInfo,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['relay', RELAY],
      ['mint', MINT, 'sat'],
      ['pubkey', p2pk],
    ],
  });
}

async function rig(o: {
  fee?: number;
  balance: number;
  threshold: number;
  pool?: nostr.FakeRelayPool;
  /** What the owner's kind 10019 names: their real key (default), another key, or nothing. */
  info?: 'match' | 'mismatch' | 'none';
}) {
  const t = await tmpDir('nutflix-payout-');
  cleanups.push(t.rm);
  const mint = new mocks.TestMint({
    url: MINT,
    seed: new Uint8Array(32).fill(0x61),
    inputFeePpk: o.fee ?? 0,
  });
  const wallet = new walletMod.CashuWallet({
    mints: new walletMod.CashuMintConnections({ request: () => mint.request }),
    store: new walletMod.MemoryProofStore(),
  });
  if (o.balance > 0) {
    const q = await wallet.mintQuote(MINT, o.balance as Sats);
    mint.payQuote(q.quoteId);
    await wallet.pollQuote(q);
  }
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from('payout-test-passphrase-0123456789'),
    cost: signerMod.minimumCost(),
  });
  const pool = o.pool ?? new nostr.FakeRelayPool();
  const { signer: ownerSigner } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from('payout-owner-passphrase-0123456789'),
    cost: signerMod.minimumCost(),
  });
  const owner = await ownerSigner.getPublicKey();
  const info = o.info ?? 'match';
  if (info !== 'none')
    pool.store(
      await ownerInfo(ownerSigner, info === 'match' ? OWNER_P2PK : `02${'77'.repeat(32)}`),
    );
  const log = capturedLogger();
  const make = (p: nostr.FakeRelayPool = pool): Payout =>
    new Payout({
      wallet,
      signer,
      pool: p,
      owner: { pubkey: owner, p2pk: OWNER_P2PK },
      relays: [RELAY],
      thresholdSats: o.threshold,
      logPath: path.join(t.dir, 'payouts.jsonl'),
      logger: log.logger,
    });
  return {
    mint,
    wallet,
    signer,
    pool,
    make,
    owner,
    ownerSigner,
    logPath: path.join(t.dir, 'payouts.jsonl'),
    log,
  };
}

function nutzaps(pool: nostr.FakeRelayPool): ReturnType<typeof nostr.parseNutzap>[] {
  return pool.published
    .filter((p) => p.event.kind === NostrKind.NutzapPayout)
    .map((p) => nostr.parseNutzap(p.event));
}

/** The owner's wallet redeeming what the nutzap carries. */
async function ownerRedeems(
  mint: mocks.TestMint,
  pool: nostr.FakeRelayPool,
  i = 0,
): Promise<number> {
  const ev = pool.published.filter((p) => p.event.kind === NostrKind.NutzapPayout)[i]!.event;
  const owner = new walletMod.CashuWallet({
    mints: new walletMod.CashuMintConnections({ request: () => mint.request }),
    store: new walletMod.MemoryProofStore(),
    key: walletMod.memoryWalletKey(OWNER_SK),
  });
  const proofs = ev.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]!) as never);
  return owner.receive({ mint: MINT, proofs });
}

describe('Payout', () => {
  it('below the threshold nothing moves; at it, the whole balance goes to the owner as one nutzap the owner redeems', async () => {
    const low = await rig({ balance: 99, threshold: 100 });
    expect(await low.make().run()).toEqual({
      paid: [],
      republished: 0,
      unpublished: 0,
      owner: 'match',
    });
    expect(nutzaps(low.pool)).toEqual([]);
    await expect(stat(low.logPath)).rejects.toThrow(); // nothing written

    const r = await rig({ balance: 150, threshold: 100 });
    expect(await r.make().run()).toEqual({
      paid: [{ mint: MINT, amount: 150 }],
      republished: 0,
      unpublished: 0,
      owner: 'match',
    });
    expect(await r.wallet.balance(MINT)).toBe(0);
    const zaps = nutzaps(r.pool);
    expect(zaps).toHaveLength(1);
    expect(zaps[0]).toMatchObject({ recipient: r.owner, mint: MINT, claimedAmount: 150 });
    expect(zaps[0]!.sender).toBe(await r.signer.getPublicKey());
    expect(r.pool.published.find((p) => p.event.kind === NostrKind.NutzapPayout)!.relays).toEqual([
      RELAY,
    ]);
    expect(await ownerRedeems(r.mint, r.pool)).toBe(150);
    expect((await stat(r.logPath)).mode & 0o777).toBe(0o600);
    // Nothing left to pay: a second run is a no-op.
    expect((await r.make().run()).paid).toEqual([]);
  });

  it('pays the swap fee out of the balance at a real input fee (100 ppk)', async () => {
    const r = await rig({ balance: 1000, threshold: 500, fee: 100 });
    const res = await r.make().run();
    expect(res.paid).toHaveLength(1);
    const amount = res.paid[0]!.amount;
    // 1000 sats in ≤ 10 power-of-two proofs → at most 1 sat of fee; nothing but dust remains.
    expect(amount).toBeGreaterThanOrEqual(998);
    expect(amount + (await r.wallet.balance(MINT))).toBeLessThanOrEqual(1000);
    expect(await ownerRedeems(r.mint, r.pool)).toBe(amount - 1); // the owner's own swap fee
  });

  it('a payout no relay accepts is kept and published on a later run — also by a new instance after a restart', async () => {
    const refusing = new nostr.FakeRelayPool({ rejectPublish: () => 'blocked: test' });
    const r = await rig({ balance: 200, threshold: 100, pool: refusing });
    expect(await r.make().run()).toEqual({
      paid: [{ mint: MINT, amount: 200 }],
      republished: 0,
      unpublished: 1,
      owner: 'match',
    });
    expect(await r.wallet.balance(MINT)).toBe(0); // locked to the owner, recorded, not lost
    expect(r.log.lines.some((l) => l.includes('payout not published yet'))).toBe(true);
    // The process restarts; the relay is back.
    const good = new nostr.FakeRelayPool();
    good.store(await ownerInfo(r.ownerSigner, OWNER_P2PK));
    expect(await r.make(good).run()).toEqual({
      paid: [],
      republished: 1,
      unpublished: 0,
      owner: 'match',
    });
    expect(await ownerRedeems(r.mint, good)).toBe(200);
    // Published once: a further run does not publish it again.
    expect((await r.make(good).run()).republished).toBe(0);
    expect(nutzaps(good)).toHaveLength(1);
  });

  it('nothing leaves before the owner’s own kind 10019 confirms payout.p2pk: another key stops payouts, none found waits and asks again', async () => {
    const wrong = await rig({ balance: 500, threshold: 100, info: 'mismatch' });
    const p = wrong.make();
    expect(await p.run()).toMatchObject({ paid: [], owner: 'mismatch' });
    expect(await wrong.wallet.balance(MINT)).toBe(500);
    expect(wrong.log.lines.some((l) => l.includes('payouts stopped'))).toBe(true);
    // Final for this process, even if a matching 10019 appears later.
    wrong.pool.store(await ownerInfo(wrong.ownerSigner, OWNER_P2PK));
    expect(await p.run()).toMatchObject({ paid: [], owner: 'mismatch' });

    const none = await rig({ balance: 500, threshold: 100, info: 'none' });
    const q = none.make();
    expect(await q.run()).toMatchObject({ paid: [], owner: 'unknown' });
    expect(await none.wallet.balance(MINT)).toBe(500);
    // A 10019 signed by someone else claiming to be the owner's does not count.
    const { signer: mallory } = await signerMod.LocalSigner.create({
      passphrase: Buffer.from('mallory-passphrase-0123456789'),
      cost: signerMod.minimumCost(),
    });
    const forged = await ownerInfo(mallory, OWNER_P2PK);
    none.pool.inject({ ...forged, pubkey: none.owner });
    expect(await q.run()).toMatchObject({ paid: [], owner: 'unknown' });
    // The owner's wallet publishes its 10019: the next run confirms and pays.
    none.pool.store(await ownerInfo(none.ownerSigner, OWNER_P2PK));
    expect(await q.run()).toMatchObject({ paid: [{ mint: MINT, amount: 500 }], owner: 'match' });
  });

  it('one run at a time: concurrent calls share the run (one payout, not two)', async () => {
    const r = await rig({ balance: 300, threshold: 100 });
    const p = r.make();
    const [a, b] = await Promise.all([p.run(), p.run()]);
    expect(a).toBe(b);
    expect(nutzaps(r.pool)).toHaveLength(1);
    await p.idle();
  });
});

describe('payout config', () => {
  const base = {
    dataDir: '/var/lib/nutflix-seeder',
    relays: ['wss://relay.example'],
    policy: {
      satsPerBlock: 1,
      mints: ['https://mint.example'],
      creatorP2pk: `02${'ab'.repeat(32)}`,
      creatorPubkey: 'c1'.repeat(32),
    },
  };

  it('optional; given, it needs the owner pubkey and P2PK key; threshold defaults to 1000, relays to the top-level ones', () => {
    const none = validateDaemonConfig(base);
    expect(none.ok && none.config.payout).toBeNull();
    const r = validateDaemonConfig({ ...base, payout: { pubkey: OWNER, p2pk: OWNER_P2PK } });
    expect(r.ok && r.config.payout).toEqual({
      pubkey: OWNER,
      p2pk: OWNER_P2PK,
      thresholdSats: 1000,
      relays: ['wss://relay.example'],
    });
    const own = validateDaemonConfig({
      ...base,
      payout: { pubkey: OWNER, p2pk: OWNER_P2PK, thresholdSats: 50, relays: [RELAY] },
    });
    expect(own.ok && own.config.payout).toMatchObject({ thresholdSats: 50, relays: [RELAY] });
  });

  it('refusals name the path, never the value', () => {
    const r = validateDaemonConfig({
      ...base,
      payout: {
        pubkey: 'SENTINEL',
        p2pk: `04${'ab'.repeat(32)}`,
        thresholdSats: 0,
        relays: ['ws://sentinel.example'],
        extra: 1,
      },
    });
    expect(r.ok).toBe(false);
    const errs = r.ok ? [] : r.errors;
    expect(errs).toEqual([
      '$.payout.extra: unknown key',
      '$.payout.pubkey: expected 64 lower-case hex chars (x-only Nostr pubkey)',
      '$.payout.p2pk: expected 33-byte compressed pubkey: 02 or 03 then 64 lower-case hex chars',
      `$.payout.thresholdSats: expected integer in [1, ${Number.MAX_SAFE_INTEGER}]`,
      '$.payout.relays[0]: plain ws:// is accepted only to a loopback relay; use wss://',
    ]);
    expect(JSON.stringify(errs).toLowerCase()).not.toContain('sentinel');
    const same = validateDaemonConfig({
      ...base,
      payout: { pubkey: OWNER_P2PK.slice(2), p2pk: OWNER_P2PK },
    });
    expect(same.ok ? [] : same.errors).toEqual([
      '$.payout.p2pk: must not be the key payout.pubkey names (NIP-61)',
    ]);
  });
});
