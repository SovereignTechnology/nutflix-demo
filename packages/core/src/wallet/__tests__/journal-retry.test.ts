/**
 * Issue #8, fix round 2 (independent verifier, HIGH): a 429 is not a refusal. A transport that
 * retries — cashu-ts's own fetch transport does, for the endpoints a mint lists as NUT-19 cached —
 * can send a request that EXECUTES, lose its answer, and meet a rate limiter on the retry. The
 * wallet then sees `RateLimitError` although the mint spent the inputs and signed the outputs.
 * Dropping the journal entry at that point loses the outputs (the verifier's run on cdk-mintd: one
 * 64-sat proof, `send(3)`, balance 0 and nothing to recover). Kept, the entry is settled like any
 * lost answer: NUT-09 restores what the mint signed, NUT-07 decides the rest.
 *
 *   a retrying transport (a stand-in)   the first request executes and its answer is lost, the
 *                                       retry is answered 429: a send completes from NUT-09; with
 *                                       the restore down too, the entry is kept (inputs held) and a
 *                                       later settle recovers it; the same for a melt's change;
 *   cashu-ts's own fetch transport      the verifier's scenario in process: the mint advertises
 *                                       NUT-19, the first POST /v1/swap executes and its answer is
 *                                       lost, cashu-ts retries, a rate limiter answers 429 — the
 *                                       wallet loses nothing.
 */
import {
  getPubKeyFromPrivKey,
  MintOperationError,
  NetworkError,
  RateLimitError,
  type RequestFn,
} from '@cashu/cashu-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CashuP2pkPubkey, MintUrl, Sats, UnixSeconds } from '../../contracts/index.js';
import { TestMint } from '../../mocks/test-mint.js';
import { PENDING_SETTLE_AFTER_S } from '../spend.js';
import { MemoryProofStore } from '../store.js';
import { CashuMintConnections, CashuWallet } from '../wallet.js';

const MINT = 'https://mint.journal-retry.example' as MintUrl;
const INVOICE_20 = 'lnbc200n1testinvoice'; // 20 sat
const T0 = 1_900_000_000;

const TO = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x5a))).toString(
  'hex',
) as CashuP2pkPubkey;

/**
 * A transport that retries once after a lost answer, like any retrying transport: the first
 * request to a path in `lose` reaches the mint (it executes) and its answer is lost; the retry is
 * answered 429 by a rate limiter in front of the mint. `restoreDown` keeps NUT-09 unreachable.
 */
function retrying(inner: RequestFn) {
  const st = { lose: new Map<string, number>(), restoreDown: false, rateLimited: 0 };
  const request: RequestFn = async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
    const path = new URL(args.endpoint).pathname;
    if (st.restoreDown && path.endsWith('/v1/restore')) throw new NetworkError('connect ETIMEDOUT');
    const left = st.lose.get(path) ?? 0;
    if (left > 0) {
      st.lose.set(path, left - 1);
      await inner(args); // attempt 1: the mint executes it; the answer never arrives
      st.rateLimited++;
      throw new RateLimitError('429 Too Many Requests', 1000); // the retry, answered 429
    }
    return inner<T>(args);
  };
  return { st, request };
}

function rig() {
  const clock = { t: T0 };
  const mint = new TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x5b), feeReserve: 4 });
  const net = retrying(mint.request);
  const store = new MemoryProofStore();
  const wallet = new CashuWallet({
    mints: new CashuMintConnections({ request: () => net.request }),
    store,
    now: () => clock.t as UnixSeconds,
  });
  return { clock, mint, net, store, wallet };
}

async function fund(w: CashuWallet, mint: TestMint, amount: number): Promise<void> {
  const q = await w.mintQuote(MINT, amount as Sats);
  mint.payQuote(q.quoteId);
  await w.pollQuote(q);
}

const swaps = (m: TestMint): number => m.calls.filter((c) => c === 'POST /v1/swap').length;

describe('fix round 2: a 429 after a retry is not a refusal (the journal keeps the entry)', () => {
  it('a send whose first swap executed and whose retry was answered 429 completes from NUT-09', async () => {
    const { mint, net, store, wallet } = rig();
    await fund(wallet, mint, 64); // one 64-sat proof
    net.st.lose.set('/v1/swap', 1);
    const set = await wallet.send(3 as Sats, { p2pk: TO, mint: MINT });
    expect(net.st.rateLimited).toBe(1);
    expect(set.proofs.reduce((a, p) => a + p.amount, 0)).toBe(3);
    expect(swaps(mint)).toBe(1); // the one that executed; no second send of the inputs
    expect(await wallet.balance(MINT)).toBe(61);
    expect(await store.pending(MINT)).toEqual([]);
    // What the wallet holds is unspent at the mint; the recipient's proofs are the mint's own.
    expect(await wallet.checkSpent({ mint: MINT, proofs: await store.proofs(MINT) })).not.toContain(
      true,
    );
  });

  it('with the restore down as well, the entry is kept (inputs held) and a later settle recovers it — nothing lost', async () => {
    const { mint, net, store, wallet } = rig();
    await fund(wallet, mint, 64);
    net.st.lose.set('/v1/swap', 1);
    net.st.restoreDown = true;
    await expect(wallet.send(3 as Sats, { p2pk: TO, mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    const [op] = await store.pending(MINT);
    expect(op?.kind).toBe('send');
    expect(await wallet.balance(MINT)).toBe(0); // held, not dropped
    net.st.restoreDown = false;
    expect(await wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await wallet.balance(MINT)).toBe(61);
    expect(await store.pending(MINT)).toEqual([]);
    const [line] = await wallet.history({ limit: 1, mint: MINT });
    expect(line).toMatchObject({ direction: 'out', amount: 3 });
  });

  it('a melt whose first request paid and whose retry was answered 429: held, then its change restored', async () => {
    const { mint, net, store, wallet } = rig();
    await fund(wallet, mint, 64);
    const q = await wallet.meltQuote(MINT, INVOICE_20);
    net.st.lose.set('/v1/melt/bolt11', 1);
    net.st.restoreDown = true;
    await expect(wallet.melt(q)).rejects.toThrow(/outcome unknown/);
    expect((await store.pending(MINT)).map((o) => o.kind)).toEqual(['melt']);
    expect(await wallet.balance(MINT)).toBe(0);
    net.st.restoreDown = false;
    expect(await wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await wallet.balance(MINT)).toBe(44); // 64 − 20 paid; the unused reserve came back
    // A retry of the invoice answers paid, and pays nothing twice.
    expect(await wallet.melt(q)).toMatchObject({ paid: true, change: 0 });
    expect(mint.calls.filter((c) => c === 'POST /v1/melt/bolt11')).toHaveLength(1);
  });

  it('a 429 on a request that never ran holds the inputs only until the wait is over (NUT-07 says unspent)', async () => {
    const { clock, mint, store, wallet } = rig();
    await fund(wallet, mint, 16);
    // A rate limiter refusing the only attempt: the wallet cannot tell it from the retry above.
    const refuse = { next: true };
    const w = new CashuWallet({
      mints: new CashuMintConnections({
        request: () => async (args) => {
          if (refuse.next && args.endpoint.endsWith('/v1/swap')) {
            refuse.next = false;
            throw new RateLimitError('429 Too Many Requests', 1000);
          }
          return mint.request(args);
        },
      }),
      store,
      now: () => clock.t as UnixSeconds,
    });
    await expect(w.send(4 as Sats, { p2pk: TO, mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await w.balance(MINT)).toBe(0);
    expect(swaps(mint)).toBe(0);
    clock.t += PENDING_SETTLE_AFTER_S;
    expect(await w.recoverPending()).toEqual({ recovered: 0, left: 0 });
    expect(await w.balance(MINT)).toBe(16);
    await w.send(4 as Sats, { p2pk: TO, mint: MINT });
    expect(await w.balance(MINT)).toBe(12);
  });
});

describe('fix round 2: cashu-ts’s own fetch transport, a NUT-19 mint, a lost swap and a 429 on the retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the verifier’s scenario in process: the wallet loses nothing', async () => {
    const mint = new TestMint({
      url: MINT,
      seed: new Uint8Array(32).fill(0x5c),
      // What cdk-mintd 0.18.1 on 3397 advertises: ttl 60, swap / mint / melt cached.
      nut19: {
        ttl: 60,
        cachedEndpoints: [
          { method: 'POST', path: '/v1/swap' },
          { method: 'POST', path: '/v1/mint/bolt11' },
          { method: 'POST', path: '/v1/melt/bolt11' },
        ],
      },
    });
    let swapPosts = 0;
    // The network: the mint behind a rate limiter. The first POST /v1/swap reaches the mint and
    // its answer is lost (the connection drops); every later one is answered 429.
    const net = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const endpoint =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const raw = init?.body;
      const requestBody =
        typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      if (method === 'POST' && new URL(endpoint).pathname === '/v1/swap') {
        swapPosts++;
        if (swapPosts > 1)
          return new Response('', { status: 429, headers: { 'Retry-After': '1' } });
        await mint.request({ endpoint, method, ...(requestBody ? { requestBody } : {}) });
        throw new TypeError('fetch failed'); // executed; the answer never arrives
      }
      try {
        const res = await mint.request({
          endpoint,
          method,
          ...(requestBody ? { requestBody } : {}),
        });
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        if (e instanceof MintOperationError)
          return new Response(JSON.stringify({ code: e.code, detail: e.message }), { status: 400 });
        throw e;
      }
    };
    vi.stubGlobal('fetch', net);
    const store = new MemoryProofStore();
    // No `request`: cashu-ts's default transport (global fetch, NUT-19 retries).
    const wallet = new CashuWallet({ mints: new CashuMintConnections(), store });
    await fund(wallet, mint, 64);
    const set = await wallet.send(3 as Sats, { p2pk: TO, mint: MINT });
    expect(swapPosts).toBe(2); // cashu-ts did retry, and met the 429
    expect(set.proofs.reduce((a, p) => a + p.amount, 0)).toBe(3);
    expect(await wallet.balance(MINT)).toBe(61);
    expect(await store.pending(MINT)).toEqual([]);
  });
});
