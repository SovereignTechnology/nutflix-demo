/**
 * Issue #8 review, findings 4 and 5 (core), against the in-process TestMint with NUT-09:
 *
 *   finding 4  a refusal cashu-ts wraps is still a refusal. A keyset refusal (12xxx) comes back
 *              as a `StaleKeysetError` whose `cause` carries the code: it drops the journal entry
 *              at once — melt and send — so the inputs are not held and the quote is not locked
 *              for `PENDING_SETTLE_AFTER_S`. A 429 (`RateLimitError`) was treated the same way
 *              until fix round 2, which made it ambiguous again (a retrying transport can meet it
 *              after its first attempt executed; `journal-retry.test.ts`);
 *   finding 5  a retry of a melt an earlier settle already recovered (the startup one) answers
 *              "paid" with no request, never "melt failed"; and a recovered entry answers only for
 *              its own kind (a top-up recovered by the settle never passes for a melt).
 */
import {
  getPubKeyFromPrivKey,
  MeltChangeError,
  MintOperationError,
  RateLimitError,
  type MeltQuoteBaseResponse,
  type RequestFn,
} from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';

import type { CashuP2pkPubkey, MintUrl, Sats, UnixSeconds } from '../../contracts/index.js';
import { TestMint } from '../../mocks/test-mint.js';
import { PENDING_SETTLE_AFTER_S } from '../spend.js';
import { MemoryProofStore } from '../store.js';
import { CashuMintConnections, CashuWallet } from '../wallet.js';

const MINT = 'https://mint.journal-review.example' as MintUrl;
const INVOICE_20 = 'lnbc200n1testinvoice'; // 20 sat

function pub(fill: number): CashuP2pkPubkey {
  return Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(fill))).toString(
    'hex',
  ) as CashuP2pkPubkey;
}

/**
 * A transport that can: throw an error of the test's choosing for the next request to a path
 * (before the mint sees it); lose the next answer from a path (after the mint ran it); keep the
 * restore endpoint down; and give a melt quote the id of another quote (a malicious mint).
 */
function transport(inner: RequestFn) {
  const st = {
    fail: null as null | { path: string; err: () => Error },
    /** Throw this after the mint ran the request (its answer replaced by the error). */
    failAfter: null as null | { path: string; err: (res: Record<string, unknown>) => Error },
    drop: null as null | string,
    noRestore: 0,
    /** The next melt quote the mint creates is shown under this id. */
    aliasNextMelt: null as null | string,
    alias: null as null | { real: string; shown: string },
  };
  const request: RequestFn = async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
    let endpoint = args.endpoint;
    const path = new URL(endpoint).pathname;
    if (st.fail !== null && path.endsWith(st.fail.path)) {
      const f = st.fail;
      st.fail = null;
      throw f.err();
    }
    if (st.noRestore > 0 && path.endsWith('/v1/restore')) {
      st.noRestore--;
      throw new Error('connect ETIMEDOUT');
    }
    const a = st.alias;
    const body = args.requestBody;
    if (a !== null) {
      if (endpoint.endsWith(`/v1/melt/quote/bolt11/${a.shown}`))
        endpoint = endpoint.replace(a.shown, a.real);
      if (body?.['quote'] === a.shown) body['quote'] = a.real;
    }
    const res = await inner<Record<string, unknown>>({ ...args, endpoint });
    if (st.drop !== null && path.endsWith(st.drop)) {
      st.drop = null;
      throw new Error('socket hang up');
    }
    if (st.failAfter !== null && path.endsWith(st.failAfter.path)) {
      const f = st.failAfter;
      st.failAfter = null;
      throw f.err(res);
    }
    if (st.aliasNextMelt !== null && path.endsWith('/v1/melt/quote/bolt11')) {
      st.alias = { real: String(res['quote']), shown: st.aliasNextMelt };
      st.aliasNextMelt = null;
    }
    if (st.alias !== null && res['quote'] === st.alias.real) res['quote'] = st.alias.shown;
    return res as T;
  };
  return { st, request };
}

function rig(
  o: {
    readonly mint?: TestMint;
    readonly store?: MemoryProofStore;
    readonly now?: () => UnixSeconds;
  } = {},
) {
  const mint =
    o.mint ?? new TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x61), feeReserve: 4 });
  const net = transport(mint.request);
  const store = o.store ?? new MemoryProofStore();
  const wallet = new CashuWallet({
    mints: new CashuMintConnections({ request: () => net.request }),
    store,
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  return { mint, net, store, wallet };
}

async function fund(w: CashuWallet, mint: TestMint, amount: number): Promise<void> {
  const q = await w.mintQuote(MINT, amount as Sats);
  mint.payQuote(q.quoteId);
  await w.pollQuote(q);
}

const meltCalls = (m: TestMint): number =>
  m.calls.filter((c) => c === 'POST /v1/melt/bolt11').length;

describe('issue #8 review, finding 4: a refusal cashu-ts wraps is still a refusal', () => {
  it('a melt refused with a keyset code (a StaleKeysetError) drops its entry at once: nothing held, the quote payable', async () => {
    const { mint, net, store, wallet } = rig();
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    net.st.fail = {
      path: '/v1/melt/bolt11',
      err: () => new MintOperationError(12001, 'Keyset is not known'),
    };
    const err = (await wallet.melt(q).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe('mint-error');
    expect(err.message).toMatch(/StaleKeysetError/); // cashu-ts did wrap it
    expect(err.message).not.toMatch(/outcome unknown/);
    expect(await store.pending(MINT)).toEqual([]);
    expect(await wallet.balance(MINT)).toBe(64);
    // Not locked locally for ten minutes: the same quote is paid right away.
    expect(await wallet.melt(q)).toMatchObject({ paid: true, change: 44 });
    expect(meltCalls(mint)).toBe(1);
  });

  it('a melt answered 429 (RateLimitError) is not a refusal: held until the mint can say, then payable (fix round 2)', async () => {
    // Fix round 2 (independent verifier, HIGH): this test used to expect the entry dropped at
    // once. That rule lost funds when a RETRYING transport met the 429 after its first attempt
    // had executed (`journal-retry.test.ts`), and the wallet cannot tell that 429 from this one
    // (refused before the mint saw anything). So both stay ambiguous: the inputs are held, the
    // quote is not sent again meanwhile, and after the wait NUT-07 (inputs unspent) gives them
    // back and the quote is payable.
    const clock = { t: 1_900_000_000 };
    const { mint, net, store, wallet } = rig({ now: () => clock.t as UnixSeconds });
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    net.st.fail = {
      path: '/v1/melt/bolt11',
      err: () => new RateLimitError('429 Too Many Requests', 1000),
    };
    await expect(wallet.melt(q)).rejects.toThrow(/outcome unknown/);
    expect((await store.pending(MINT)).map((o) => o.kind)).toEqual(['melt']);
    expect(await wallet.balance(MINT)).toBe(0);
    await expect(wallet.melt(q)).rejects.toThrow(/still unresolved/);
    expect(meltCalls(mint)).toBe(0);
    clock.t += PENDING_SETTLE_AFTER_S;
    expect(await wallet.recoverPending()).toEqual({ recovered: 0, left: 0 });
    expect(await wallet.balance(MINT)).toBe(64);
    expect(await wallet.melt(q)).toMatchObject({ paid: true, change: 44 });
    expect(meltCalls(mint)).toBe(1);
  });

  it('a send refused with a keyset code does not hold its input', async () => {
    const { mint, net, store, wallet } = rig();
    await fund(wallet, mint, 16);
    net.st.fail = {
      path: '/v1/swap',
      err: () => new MintOperationError(12002, 'Keyset is inactive'),
    };
    await expect(wallet.send(4 as Sats, { p2pk: pub(7), mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await store.pending(MINT)).toEqual([]);
    expect(await wallet.balance(MINT)).toBe(16);
    await wallet.send(4 as Sats, { p2pk: pub(7), mint: MINT });
    expect(await wallet.balance(MINT)).toBe(12);
  });

  it('a coded cause under any other error is not a refusal: a MeltChangeError means the melt went through, and its change is restored', async () => {
    const { mint, net, store, wallet } = rig();
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    // The mint paid and signed the change; cashu-ts could not build it — and its cause carries a
    // code (a keyset fetch the mint refused). Dropping the entry here would lose the change.
    net.st.failAfter = {
      path: '/v1/melt/bolt11',
      err: (res) =>
        new MeltChangeError([], res as unknown as MeltQuoteBaseResponse, {
          cause: new MintOperationError(12001, 'Keyset is not known'),
        }),
    };
    expect(await wallet.melt(q)).toMatchObject({ paid: true, change: 44 });
    expect(await wallet.balance(MINT)).toBe(44);
    expect(await store.pending(MINT)).toEqual([]);
    expect(meltCalls(mint)).toBe(1);
  });

  it('a lost answer is still ambiguous (the wrappers are the only additions)', async () => {
    const { mint, net, store, wallet } = rig();
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    net.st.fail = { path: '/v1/melt/bolt11', err: () => new Error('socket hang up') };
    await expect(wallet.melt(q)).rejects.toThrow(/outcome unknown/);
    expect(await store.pending(MINT)).toHaveLength(1);
    expect(await wallet.balance(MINT)).toBe(0);
  });
});

describe('issue #8 review, finding 5: a melt recovered earlier is reported paid', () => {
  it('a retry of a quote the startup settle already recovered answers paid — no request, not "melt failed"', async () => {
    const { mint, net, store, wallet } = rig();
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    net.st.drop = '/v1/melt/bolt11';
    net.st.noRestore = 1;
    await expect(wallet.melt(q)).rejects.toMatchObject({ code: 'mint-error' });
    // A restart: the startup settle restores the change.
    const after = rig({ mint, store }).wallet;
    expect(await after.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await after.balance(MINT)).toBe(44);
    // The user retries the same invoice: it IS paid — said so, and nothing is sent again.
    const r = await after.melt(q);
    expect(r).toMatchObject({ paid: true, change: 0 });
    expect(r.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(meltCalls(mint)).toBe(1);
    expect(await after.balance(MINT)).toBe(44);
    expect(await store.pending(MINT)).toEqual([]);
  });

  it('a recovered top-up never passes for a melt that shares its quote id (a malicious mint’s ids)', async () => {
    const { mint, net, store, wallet } = rig();
    await fund(wallet, mint, 64);
    // A top-up whose answer is lost while the mint cannot be asked: journaled under its quote id.
    const top = await wallet.mintQuote(MINT, 8 as Sats);
    mint.payQuote(top.quoteId);
    net.st.drop = '/v1/mint/bolt11';
    net.st.noRestore = 1;
    await expect(wallet.pollQuote(top)).rejects.toMatchObject({ code: 'mint-error' });
    expect((await store.pending(MINT)).map((o) => [o.kind, o.key])).toEqual([
      ['mint', [top.quoteId]],
    ]);
    // The mint shows a melt quote under the same id.
    net.st.aliasNextMelt = top.quoteId;
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    expect(q.quoteId).toBe(top.quoteId);
    // The melt's settle recovers the top-up (8 sat) — which is not this melt's result: the melt
    // still runs, and reports its own change.
    const r = await wallet.melt(q);
    expect(r).toMatchObject({ paid: true, change: 44 });
    expect(meltCalls(mint)).toBe(1);
    expect(await wallet.balance(MINT)).toBe(8 + 44);
    expect(await store.pending(MINT)).toEqual([]);
  });
});
