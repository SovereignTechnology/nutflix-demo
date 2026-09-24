/**
 * The wallet against a real (in-process) Cashu mint: `TestMint` + `@cashu/cashu-ts`, so blind
 * signatures, DLEQ, P2PK witnesses and double-spend state are all real. Adversary cases:
 * concurrent sends, reserved lock tags, proofs locked to someone else, already-spent proofs,
 * a mint outage, a lost response after the mint spent the inputs, and a mint that strips DLEQ.
 */
import { describe, expect, it } from 'vitest';
import { getPubKeyFromPrivKey, hasValidDleq, Amount, type RequestFn } from '@cashu/cashu-ts';

import type { CashuP2pkPubkey, MintUrl, Sats } from '../../contracts/index.js';
import { TestMint } from '../../mocks/test-mint.js';
import { checkPayLock } from '../../payment/lock.js';
import { WalletError } from '../spend.js';
import { MemoryProofStore, proofTotal } from '../store.js';
import { CashuMintConnections, CashuWallet, memoryWalletKey } from '../wallet.js';

const MINT = 'https://mint.test-a.example' as MintUrl;
const sats = (n: number): Sats => n as Sats;

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function keyOf(fill: number): { sk: Uint8Array; pub: CashuP2pkPubkey } {
  const sk = new Uint8Array(32).fill(fill);
  return { sk, pub: hex(getPubKeyFromPrivKey(sk)) as CashuP2pkPubkey };
}

function rig(
  opts: {
    readonly fee?: number;
    readonly wrap?: (r: RequestFn) => RequestFn;
    readonly walletKey?: Uint8Array;
  } = {},
): { mint: TestMint; store: MemoryProofStore; wallet: CashuWallet } {
  const mint = new TestMint({
    url: MINT,
    seed: new Uint8Array(32).fill(1),
    inputFeePpk: opts.fee ?? 0,
  });
  const store = new MemoryProofStore();
  const request = opts.wrap ? opts.wrap(mint.request) : mint.request;
  const wallet = new CashuWallet({
    mints: new CashuMintConnections({ request: () => request }),
    store,
    ...(opts.walletKey ? { key: memoryWalletKey(opts.walletKey) } : {}),
  });
  return { mint, store, wallet };
}

async function fund(w: CashuWallet, mint: TestMint, amount: number): Promise<void> {
  const q = await w.mintQuote(MINT, sats(amount));
  expect(w.pendingMintQuotes().map((x) => x.quoteId)).toContain(q.quoteId);
  expect(await w.pollQuote(q)).toEqual({ state: 'UNPAID' });
  mint.payQuote(q.quoteId);
  expect(await w.pollQuote(q)).toEqual({ state: 'ISSUED', minted: amount });
  expect(w.pendingMintQuotes()).toEqual([]);
}

describe('CashuWallet (NUT-04 / NUT-11 / NUT-03 / NUT-05 over a real mint)', () => {
  it('funds through a mint quote; balance and history follow', async () => {
    const { mint, wallet } = rig();
    await fund(wallet, mint, 100);
    expect(await wallet.balance(MINT)).toBe(100);
    expect(await wallet.mints()).toEqual([MINT]);
    const [top] = await wallet.history({ limit: 1 });
    expect(top).toMatchObject({ direction: 'in', amount: 100, memo: 'top-up' });
  });

  it('P2PK send: exactly the amount, locked to the recipient with the binding tag, every proof with a DLEQ the recipient can verify; change committed; the sender pays the swap fee', async () => {
    const { mint, wallet } = rig({ fee: 100 });
    await fund(wallet, mint, 100);
    const to = keyOf(5);
    const seller = keyOf(6).pub;
    const set = await wallet.send(sats(10), { p2pk: to.pub, mint: MINT, tags: [['pay1', seller]] });
    expect(set).toMatchObject({ mint: MINT, unit: 'sat', lockedTo: to.pub });
    expect(proofTotal(set.proofs)).toBe(10);
    for (const p of set.proofs) {
      expect(p.dleq?.r).toBeDefined();
      expect(hasValidDleq({ ...p, amount: Amount.from(p.amount) }, mint.keyset())).toBe(true);
      expect(checkPayLock(p.secret, to.pub, { binding: seller })).toEqual({ ok: true });
    }
    const fee = 100 - 10 - (await wallet.balance(MINT));
    expect(fee).toBeGreaterThanOrEqual(1); // inputs cost 100 ppk each, rounded up
    const [out] = await wallet.history({ limit: 1 });
    expect(out).toMatchObject({ direction: 'out', amount: 10 + fee });
    // The recipient can redeem them; nobody else can (both wallets on the SAME mint).
    const thief = new CashuWallet({
      mints: new CashuMintConnections({ request: () => mint.request }),
      store: new MemoryProofStore(),
      key: memoryWalletKey(keyOf(7).sk),
    });
    await expect(thief.receive(set)).rejects.toMatchObject({ code: 'not-ours' });
    const good = new CashuWallet({
      mints: new CashuMintConnections({ request: () => mint.request }),
      store: new MemoryProofStore(),
      key: memoryWalletKey(to.sk),
    });
    expect(await good.receive(set)).toBeGreaterThanOrEqual(8); // 10 less the receiving swap's fee
    // Presenting the thief's own key as the lock does not help: the witness must match `data`.
    const forged = { ...set, lockedTo: keyOf(7).pub };
    await expect(thief.receive(forged)).rejects.toMatchObject({ code: 'not-ours' });
  });

  it('refuses a lock tag with spending semantics, a bad recipient key, a non-positive amount, and more than the balance', async () => {
    const { mint, wallet } = rig();
    await fund(wallet, mint, 20);
    const to = keyOf(5).pub;
    for (const tag of ['locktime', 'refund', 'pubkeys', 'n_sigs', 'sigflag', 'n_sigs_refund'])
      await expect(
        wallet.send(sats(1), { p2pk: to, mint: MINT, tags: [[tag, '1']] }),
      ).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    await expect(
      wallet.send(sats(1), { p2pk: 'nothex' as CashuP2pkPubkey, mint: MINT }),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(wallet.send(sats(0), { p2pk: to, mint: MINT })).rejects.toThrow(
      /invalid-argument/,
    );
    await expect(wallet.send(sats(21), { p2pk: to, mint: MINT })).rejects.toMatchObject({
      code: 'insufficient-funds',
    });
    expect(await wallet.balance(MINT)).toBe(20);
  });

  it('two concurrent sends never select the same proof (per-mint lock): one succeeds, the other is insufficient, the mint sees no double-spend', async () => {
    const { mint, wallet } = rig();
    await fund(wallet, mint, 10);
    const to = keyOf(5).pub;
    const results = await Promise.allSettled([
      wallet.send(sats(6), { p2pk: to, mint: MINT }),
      wallet.send(sats(6), { p2pk: to, mint: MINT }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(
      rejected?.status === 'rejected' ? (rejected.reason as unknown) : undefined,
    ).toMatchObject({
      code: 'insufficient-funds',
    });
    expect(await wallet.balance(MINT)).toBe(4);
  });

  it('receive: proofs locked to our wallet key are signed and swapped; a proof already spent is `spent`; unlocked proofs are swapped too', async () => {
    const me = keyOf(9);
    const { mint, wallet } = rig({ walletKey: me.sk });
    expect(await wallet.p2pkPubkey()).toBe(me.pub);
    const locked = mint.issue(13, { p2pk: me.pub, tags: [['pay1', keyOf(6).pub]] });
    expect(await wallet.receive({ mint: MINT, proofs: locked })).toBe(13);
    await expect(wallet.receive({ mint: MINT, proofs: locked })).rejects.toMatchObject({
      code: 'spent',
    });
    const plain = mint.issue(5);
    expect(await wallet.receive({ mint: MINT, proofs: plain })).toBe(5);
    expect(await wallet.balance(MINT)).toBe(18);
    // A wallet without a key cannot receive locked proofs at all.
    const keyless = rig();
    await expect(
      keyless.wallet.receive({ mint: MINT, proofs: mint.issue(2, { p2pk: me.pub }) }),
    ).rejects.toMatchObject({
      code: 'not-ours',
    });
    await expect(keyless.wallet.p2pkPubkey()).rejects.toThrow(/no NIP-60 wallet key/);
  });

  it('melt: quote → pay; the fee reserve comes back as change; the history records what left', async () => {
    const mint = new TestMint({ url: MINT, seed: new Uint8Array(32).fill(1), feeReserve: 4 });
    const wallet = new CashuWallet({
      mints: new CashuMintConnections({ request: () => mint.request }),
      store: new MemoryProofStore(),
    });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, 'lnbc200n1testinvoice'); // 200 × 0.1 sat = 20 sat
    expect(q).toMatchObject({ amount: 20, feeReserve: 4 });
    const r = await wallet.melt(q);
    expect(r.paid).toBe(true);
    expect(await wallet.balance(MINT)).toBe(64 - 20);
    await expect(wallet.meltQuote(MINT, 'not an invoice')).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('a mint outage before the swap reaches it leaves the inputs in the wallet (reconciled as unspent)', async () => {
    const { mint, wallet } = rig();
    await fund(wallet, mint, 16);
    mint.failNext(1);
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await wallet.balance(MINT)).toBe(16);
    // …and the next send works.
    await wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT });
    expect(await wallet.balance(MINT)).toBe(13);
  });

  it('a response lost AFTER the mint spent the inputs is reconciled: the spent inputs are dropped and the loss is recorded (never silently kept)', async () => {
    let dropNextSwap = false;
    const { mint, wallet } = rig({
      wrap: (inner) =>
        (async (args: Parameters<RequestFn>[0]) => {
          const res = await inner(args);
          if (dropNextSwap && args.endpoint.endsWith('/v1/swap')) {
            dropNextSwap = false;
            throw new Error('socket hang up');
          }
          return res;
        }) as RequestFn,
    });
    await fund(wallet, mint, 16);
    dropNextSwap = true;
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await wallet.balance(MINT)).toBe(0); // the 16-sat input is gone at the mint
    const [loss] = await wallet.history({ limit: 1 });
    expect(loss).toMatchObject({ direction: 'out', amount: 16 });
    expect(loss?.memo).toMatch(/lost in a failed mint operation/);
  });

  it('a mint that strips DLEQ from its signatures is refused (requireSigDleq); the spent inputs are reconciled, not kept', async () => {
    const { mint, wallet } = rig({
      wrap: (inner) =>
        (async (args: Parameters<RequestFn>[0]) => {
          const res = await inner<{ signatures?: { dleq?: unknown }[] }>(args);
          if (args.endpoint.endsWith('/v1/swap') && Array.isArray(res.signatures))
            for (const s of res.signatures) delete s.dleq;
          return res;
        }) as RequestFn,
    });
    await fund(wallet, mint, 8);
    await expect(wallet.send(sats(3), { p2pk: keyOf(5).pub, mint: MINT })).rejects.toBeInstanceOf(
      WalletError,
    );
    expect(await wallet.balance(MINT)).toBe(0);
  });

  it('keyset(): the contract shape, cached; an unknown keyset id is an error', async () => {
    const { mint, wallet } = rig();
    const ks = await wallet.keyset(MINT, mint.keysetId);
    expect(ks).toMatchObject({ mint: MINT, id: mint.keysetId, unit: 'sat', active: true });
    expect(ks.keys['1']).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(await wallet.keyset(MINT, mint.keysetId)).toBe(ks);
    await expect(wallet.keyset(MINT, '00ffffffffffffff')).rejects.toThrow();
  });
});
