/**
 * Issue #8 (ADR 0014 amendment) against the in-process TestMint with NUT-09:
 *
 *   (b) melt change is journaled: NUT-08 blanks written before the request, restored (NUT-09)
 *       when the answer is lost, when the mint could not be asked, across a restart, and when the
 *       mint answers PENDING; a melt paid with no change settles by NUT-07; refusals are final;
 *   (c) the inputs of an unresolved send or melt are out of the balance (and out of the change
 *       events the header chip follows), and come back — or leave — exactly once when it resolves.
 */
import { describe, expect, it } from 'vitest';
import { getPubKeyFromPrivKey, type RequestFn } from '@cashu/cashu-ts';

import type {
  CashuP2pkPubkey,
  MintUrl,
  Sats,
  UnixSeconds,
  WalletChangeEvent,
} from '../../contracts/index.js';
import { TestMint } from '../../mocks/test-mint.js';
import { PENDING_SETTLE_AFTER_S, WalletError } from '../spend.js';
import { MemoryProofStore, heldSecrets, proofTotal } from '../store.js';
import { CashuMintConnections, CashuWallet } from '../wallet.js';

const MINT = 'https://mint.residuals.example' as MintUrl;
const sats = (n: number): Sats => n as Sats;
const INVOICE_20 = 'lnbc200n1testinvoice'; // 200 × 0.1 sat = 20 sat

function pub(fill: number): CashuP2pkPubkey {
  return Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(fill))).toString(
    'hex',
  ) as CashuP2pkPubkey;
}

/** A transport that can lose answers, refuse requests, and rewrite what comes back. */
function net() {
  const st = {
    drop: new Map<string, number>(),
    refuse: new Map<string, number>(),
    noRestore: 0,
    /** Rewrite a response (after the mint ran the request). */
    rewrite: null as null | ((path: string, res: Record<string, unknown>) => void),
    /** Rewrite a request body before the mint sees it. */
    before: null as null | ((path: string, body: Record<string, unknown>) => void),
  };
  const take = (m: Map<string, number>, path: string): boolean => {
    for (const [k, n] of m)
      if (path.endsWith(k) && n > 0) {
        m.set(k, n - 1);
        return true;
      }
    return false;
  };
  const wrap =
    (inner: RequestFn): RequestFn =>
    async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
      const path = new URL(args.endpoint).pathname;
      if (path.endsWith('/v1/restore') && st.noRestore > 0) {
        st.noRestore--;
        throw new Error('connect ETIMEDOUT');
      }
      if (take(st.refuse, path)) throw new Error('connect ECONNREFUSED');
      if (st.before !== null && args.requestBody !== undefined) st.before(path, args.requestBody);
      const res = await inner<Record<string, unknown>>(args);
      if (take(st.drop, path)) throw new Error('socket hang up');
      st.rewrite?.(path, res);
      return res as T;
    };
  return {
    wrap,
    st,
    dropNext: (p: string) => st.drop.set(p, (st.drop.get(p) ?? 0) + 1),
    refuseNext: (p: string) => st.refuse.set(p, (st.refuse.get(p) ?? 0) + 1),
  };
}

function rig(
  o: {
    readonly feeReserve?: number;
    readonly store?: MemoryProofStore;
    readonly mint?: TestMint;
    readonly wrap?: (r: RequestFn) => RequestFn;
    readonly now?: () => UnixSeconds;
  } = {},
) {
  const mint =
    o.mint ??
    new TestMint({ url: MINT, seed: new Uint8Array(32).fill(3), feeReserve: o.feeReserve ?? 4 });
  const store = o.store ?? new MemoryProofStore();
  const request = o.wrap ? o.wrap(mint.request) : mint.request;
  const wallet = new CashuWallet({
    mints: new CashuMintConnections({ request: () => request }),
    store,
    ...(o.now ? { now: o.now } : {}),
  });
  return { mint, store, wallet };
}

async function fund(w: CashuWallet, mint: TestMint, amount: number): Promise<void> {
  const q = await w.mintQuote(MINT, sats(amount));
  mint.payQuote(q.quoteId);
  expect(await w.pollQuote(q)).toEqual({ state: 'ISSUED', minted: amount });
}

describe('issue #8 (c): an unresolved send holds its inputs out of the balance', () => {
  it('while pending the inputs are not counted; when the mint did execute they leave once and the change arrives', async () => {
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    await fund(wallet, mint, 16); // one 16-sat proof
    const events: WalletChangeEvent[] = [];
    wallet.onChange((e) => events.push(e));
    n.dropNext('/v1/swap');
    n.st.noRestore = 1; // the answer is lost AND the mint cannot be asked right away
    await expect(wallet.send(sats(3), { p2pk: pub(5), mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    const [op] = await store.pending(MINT);
    expect(op?.kind).toBe('send');
    expect(await store.proofs(MINT)).toHaveLength(1); // still in the store…
    expect(await wallet.balance(MINT)).toBe(0); // …but held: not spendable, not shown
    expect((await wallet.balances()).get(MINT)).toBe(0);
    // The header chip follows change events: the failed send announced the held balance.
    expect(events.filter((e) => e.type === 'balance').at(-1)).toMatchObject({ balance: 0 });

    // The mint answers now: the swap had executed. The input leaves, the change comes in.
    expect(await wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await store.pending(MINT)).toEqual([]);
    expect(await wallet.balance(MINT)).toBe(13);
    expect(events.filter((e) => e.type === 'balance').at(-1)).toMatchObject({ balance: 13 });
    // Not double-spent: the input was spent ONCE at the mint, and the change is spendable.
    expect(mint.calls.filter((c) => c === 'POST /v1/swap')).toHaveLength(1);
    await wallet.send(sats(13), { p2pk: pub(5), mint: MINT });
    expect(await wallet.balance(MINT)).toBe(0);
  });

  it('when the mint never saw it, the inputs come back after the wait, spendable (not lost)', async () => {
    let now = 1_900_000_000;
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap, now: () => now as UnixSeconds });
    await fund(wallet, mint, 16);
    n.refuseNext('/v1/swap');
    await expect(wallet.send(sats(3), { p2pk: pub(5), mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await wallet.balance(MINT)).toBe(0);
    // Too young to drop: its request may still be in flight.
    expect(await wallet.recoverPending()).toEqual({ recovered: 0, left: 1 });
    expect(await wallet.balance(MINT)).toBe(0);
    now += PENDING_SETTLE_AFTER_S;
    expect(await wallet.recoverPending()).toEqual({ recovered: 0, left: 0 });
    expect(await store.pending(MINT)).toEqual([]);
    expect(await wallet.balance(MINT)).toBe(16);
    await wallet.send(sats(16), { p2pk: pub(5), mint: MINT });
    expect(await wallet.balance(MINT)).toBe(0);
  });

  it('held inputs are counted once: proofs outside the entry still count, the entry’s never twice', async () => {
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    await fund(wallet, mint, 16);
    await fund(wallet, mint, 8);
    n.refuseNext('/v1/swap');
    await expect(wallet.send(sats(10), { p2pk: pub(5), mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    const held = heldSecrets(await store.pending(MINT));
    const all = await store.proofs(MINT);
    const free = proofTotal(all.filter((p) => !held.has(p.secret)));
    expect(await wallet.balance(MINT)).toBe(free);
    expect(free).toBe(24 - proofTotal(all.filter((p) => held.has(p.secret))));
  });
});

describe('issue #8: held inputs are nobody’s — not a melt’s, not a restore’s to inflate', () => {
  it('a melt cannot select the inputs an unresolved send holds', async () => {
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    await fund(wallet, mint, 64); // one proof
    n.refuseNext('/v1/swap');
    await expect(wallet.send(sats(3), { p2pk: pub(5), mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    await expect(wallet.melt(q)).rejects.toMatchObject({ code: 'insufficient-funds' });
    expect(mint.calls.filter((c) => c === 'POST /v1/melt/bolt11')).toHaveLength(0);
    expect(await store.pending(MINT)).toHaveLength(1);
  });

  it('a restore that names other amounts than the journaled outputs is refused (only melt blanks take the mint’s)', async () => {
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    // A mint without NUT-12 (no DLEQ to catch the lie): the amount check is what stands.
    n.st.rewrite = (path, res) => {
      if (path.endsWith('/v1/info')) {
        const nuts = res['nuts'] as Record<string, unknown>;
        delete nuts['12'];
      }
      if (path.endsWith('/v1/restore'))
        for (const sig of res['signatures'] as { amount: number; dleq?: unknown }[]) {
          sig.amount = sig.amount * 2;
          delete sig.dleq;
        }
    };
    const set = { mint: MINT, proofs: mint.issue(8) };
    n.dropNext('/v1/swap');
    await expect(wallet.receive(set)).rejects.toMatchObject({ code: 'mint-error' });
    expect(await wallet.balance(MINT)).toBe(0); // nothing inflated
    expect(await store.proofs(MINT)).toEqual([]);
    expect(await store.pending(MINT)).toHaveLength(1); // kept for an honest answer
    n.st.rewrite = (path, res) => {
      if (path.endsWith('/v1/info')) delete (res['nuts'] as Record<string, unknown>)['12'];
    };
    expect(await wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await wallet.balance(MINT)).toBe(8);
  });
});

describe('issue #8 (b): melt change outputs are journaled (NUT-08 blanks, NUT-09 restore)', () => {
  it('a melt whose answer was lost after the mint paid returns paid, with its change restored', async () => {
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    n.dropNext('/v1/melt/bolt11');
    const r = await wallet.melt(q);
    expect(r).toMatchObject({ paid: true });
    expect(r.change).toBe(44); // 64 − 20 (the test mint charges no Lightning fee)
    expect(await wallet.balance(MINT)).toBe(44);
    expect(await store.pending(MINT)).toEqual([]);
    const [last] = await wallet.history({ limit: 1 });
    expect(last).toMatchObject({ direction: 'out', amount: 20 });
  });

  it('the journal entry is written BEFORE the melt request, and carries the blanks and the inputs', async () => {
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    let seen: readonly unknown[] = [];
    let outputs: string[] = [];
    n.st.before = (path, body) => {
      if (!path.endsWith('/v1/melt/bolt11')) return;
      // What the store held at the moment the request left (read synchronously, here).
      void store.pending(MINT).then((p) => {
        seen = p;
      });
      outputs = ((body['outputs'] as { B_: string }[] | undefined) ?? []).map((o) => o.B_);
    };
    n.dropNext('/v1/melt/bolt11');
    // The mint cannot be asked for a while: this melt's own attempt, the send's settle and the
    // second melt's settle all find it unreachable.
    n.st.noRestore = 3;
    await expect(wallet.melt(q)).rejects.toMatchObject({ code: 'mint-error' });
    const pending = await store.pending(MINT);
    expect(seen).toEqual(pending);
    expect(pending).toHaveLength(1);
    const [op] = pending;
    expect(op).toMatchObject({ kind: 'melt', key: [q.quoteId] });
    expect(op?.spends.map((p) => p.amount)).toEqual([64]);
    expect(op?.keep.map((o) => o.blindedMessage.B_)).toEqual(outputs);
    expect(outputs.length).toBeGreaterThan(0);
    // Held: out of the balance and out of every selection until it resolves.
    expect(await wallet.balance(MINT)).toBe(0);
    await expect(wallet.send(sats(1), { p2pk: pub(5), mint: MINT })).rejects.toMatchObject({
      code: 'insufficient-funds',
    });
    // A second melt of the same quote is refused locally while the first is unresolved.
    await expect(wallet.melt(q)).rejects.toMatchObject({ code: 'mint-error' });
    // The mint answers now. A retry of the same quote settles the journal first: the change the
    // mint signed on the journaled blanks comes back, and nothing is paid twice.
    expect(await wallet.melt(q)).toEqual({ paid: true, change: 44 });
    expect(await wallet.balance(MINT)).toBe(44);
    expect(await store.pending(MINT)).toEqual([]);
    expect(mint.calls.filter((c) => c === 'POST /v1/melt/bolt11')).toHaveLength(1);
    expect(await wallet.recoverPending()).toEqual({ recovered: 0, left: 0 });
  });

  it('survives a restart: a new wallet over the same store restores the change at startup', async () => {
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    n.dropNext('/v1/melt/bolt11');
    n.st.noRestore = 1;
    await expect(wallet.melt(q)).rejects.toMatchObject({ code: 'mint-error' });
    // "Crash": the process is gone; the store (durable on the desktop, ADR 0014 amendment) stays.
    const after = rig({ mint, store }).wallet;
    expect(await after.balance(MINT)).toBe(0);
    expect(await after.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await after.balance(MINT)).toBe(44);
  });

  it('a melt the mint reports PENDING keeps its blanks journaled; the change is restored once it settles', async () => {
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    // The mint pays (and signs change) but answers as if the payment were still in flight.
    n.st.rewrite = (path, res) => {
      if (!path.endsWith('/v1/melt/bolt11')) return;
      res['state'] = 'PENDING';
      res['change'] = [];
    };
    expect(await wallet.melt(q)).toEqual({ paid: false, change: 0 });
    n.st.rewrite = null;
    expect(await store.pending(MINT)).toHaveLength(1);
    expect(await wallet.balance(MINT)).toBe(0);
    expect(await wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await wallet.balance(MINT)).toBe(44);
  });

  it('inputs PENDING at the mint keep the entry however old it is; SPENT with no change settles as paid', async () => {
    let now = 1_900_000_000;
    let pendingInputs = true;
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap, now: () => now as UnixSeconds });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    // The mint is sent no blanks (so it signs no change) and the answer is lost.
    n.st.before = (path, body) => {
      if (path.endsWith('/v1/melt/bolt11')) body['outputs'] = [];
    };
    n.st.rewrite = (path, res) => {
      if (!path.endsWith('/v1/checkstate') || !pendingInputs) return;
      for (const s of res['states'] as { state: string }[]) s.state = 'PENDING';
    };
    n.dropNext('/v1/melt/bolt11');
    await expect(wallet.melt(q)).rejects.toMatchObject({ code: 'mint-error' });
    n.st.before = null;
    now += 10 * PENDING_SETTLE_AFTER_S;
    expect(await wallet.recoverPending()).toEqual({ recovered: 0, left: 1 }); // in flight
    expect(await wallet.balance(MINT)).toBe(0);
    pendingInputs = false; // the payment went through: inputs SPENT, no change signed
    expect(await wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await store.pending(MINT)).toEqual([]);
    expect(await store.proofs(MINT)).toEqual([]);
    expect(await wallet.balance(MINT)).toBe(0);
    const [last] = await wallet.history({ limit: 1 });
    expect(last).toMatchObject({ direction: 'out', amount: 64 });
    expect(last?.memo).toMatch(/melt to Lightning/);
  });

  it('a melt the mint never saw frees its inputs after the wait', async () => {
    let now = 1_900_000_000;
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap, now: () => now as UnixSeconds });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    n.refuseNext('/v1/melt/bolt11');
    await expect(wallet.melt(q)).rejects.toMatchObject({ code: 'mint-error' });
    expect(await wallet.balance(MINT)).toBe(0);
    now += PENDING_SETTLE_AFTER_S;
    expect(await wallet.recoverPending()).toEqual({ recovered: 0, left: 0 });
    expect(await store.pending(MINT)).toEqual([]);
    expect(await wallet.balance(MINT)).toBe(64);
    expect((await wallet.melt(q)).paid).toBe(true); // the quote is still payable
    expect(await wallet.balance(MINT)).toBe(44);
  });

  it('a melt the mint refuses (an error code) drops its entry at once; the inputs stay', async () => {
    // This test used to melt the same quote twice and let the mint refuse the second ("quote
    // already paid"). Since the issue #8 review (finding 5) a quote the mint reports PAID is
    // answered "paid" without a request, so the refusal is made another way: the request reaches
    // the mint without its inputs, and the mint refuses it (11002).
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    n.st.before = (path, body) => {
      if (path.endsWith('/v1/melt/bolt11')) body['inputs'] = [];
    };
    await expect(wallet.melt(q)).rejects.toBeInstanceOf(WalletError);
    n.st.before = null;
    expect(mint.calls.filter((c) => c === 'POST /v1/melt/bolt11')).toHaveLength(1);
    expect(await store.pending(MINT)).toEqual([]);
    expect(await wallet.balance(MINT)).toBe(64);
    // Nothing is held: the same quote can be paid right away.
    expect(await wallet.melt(q)).toMatchObject({ paid: true, change: 44 });
  });

  it('a restored change signature without its DLEQ (NUT-12 mint) is refused: nothing committed, the entry stays', async () => {
    let strip = true;
    const n = net();
    const { mint, store, wallet } = rig({ wrap: n.wrap });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    n.st.rewrite = (path, res) => {
      if (!strip || !/\/v1\/(melt\/bolt11|restore)$/.test(path)) return;
      for (const sig of (res['signatures'] ?? res['change'] ?? []) as { dleq?: unknown }[])
        delete sig.dleq;
    };
    await expect(wallet.melt(q)).rejects.toMatchObject({ code: 'mint-error' });
    expect(await store.pending(MINT)).toHaveLength(1);
    expect(await wallet.balance(MINT)).toBe(0);
    strip = false;
    expect(await wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await wallet.balance(MINT)).toBe(44);
  });

  it('with no change to come back (exact amount), nothing is journaled', async () => {
    const { mint, store, wallet } = rig({ feeReserve: 0 });
    await fund(wallet, mint, 16);
    await fund(wallet, mint, 4);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    const commits: unknown[] = [];
    const orig = store.commit.bind(store);
    store.commit = (tx) => {
      commits.push(tx);
      return orig(tx);
    };
    expect(await wallet.melt(q)).toMatchObject({ paid: true, change: 0 });
    expect(commits.some((tx) => (tx as { begin?: unknown }).begin !== undefined)).toBe(false);
    expect(await wallet.balance(MINT)).toBe(0);
  });
});
