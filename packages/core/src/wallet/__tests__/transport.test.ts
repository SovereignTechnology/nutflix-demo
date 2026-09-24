/**
 * `cashuRequestFn` — the cashu-ts transport over an injected raw HTTP call (for Node daemons,
 * whose global `fetch` crashes under `--jitless`). The error contract is what the wallet relies
 * on: a 400 `{ code, detail }` must become a `MintOperationError` with the code, or `spend.ts`
 * cannot tell a double-spend. The last case runs the whole wallet over the transport against the
 * in-process mint, double-spend included.
 */
import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  RateLimitError,
  getPubKeyFromPrivKey,
} from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';

import type { CashuP2pkPubkey, MintUrl, Sats } from '../../contracts/index.js';
import { TestMint } from '../../mocks/test-mint.js';
import { WalletError } from '../spend.js';
import { MemoryProofStore } from '../store.js';
import { cashuRequestFn } from '../transport.js';
import type { RawHttp, RawHttpRequest, RawHttpResponse } from '../transport.js';
import { CashuMintConnections, CashuWallet, memoryWalletKey } from '../wallet.js';

const MINT = 'https://mint.transport.example' as MintUrl;

function fixed(res: Partial<RawHttpResponse>, seen?: RawHttpRequest[]): RawHttp {
  return (req) => {
    seen?.push(req);
    return Promise.resolve({ status: 200, headers: {}, body: '', ...res });
  };
}

const call = (http: RawHttp, args: Record<string, unknown>): Promise<unknown> =>
  cashuRequestFn(http)({ endpoint: `${MINT}/v1/info`, ...args });

describe('cashuRequestFn: the RequestFn error contract over a raw HTTP call', () => {
  it('GET and POST: method, JSON headers, the JSONInt body; a 2xx body parsed by JSONInt (big numbers stay exact)', async () => {
    const seen: RawHttpRequest[] = [];
    const http = fixed({ body: '{"amount": 12345678901234567890, "ok": true}' }, seen);
    expect(await call(http, {})).toEqual({ amount: 12345678901234567890n, ok: true });
    await call(http, { endpoint: `${MINT}/v1/swap`, method: 'POST', requestBody: { a: 1 } });
    expect(seen[0]).toMatchObject({
      url: `${MINT}/v1/info`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: 30_000,
      maxBytes: 4 * 1024 * 1024,
    });
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    // cashu-ts's own timeout wins over the default.
    await call(http, { requestTimeout: 1234 });
    expect(seen[2]?.timeoutMs).toBe(1234);
  });

  it('400 { code, detail } → MintOperationError with the NUT code (spend.ts tells a double-spend by it)', async () => {
    const err = await call(
      fixed({ status: 400, body: '{"code": 11001, "detail": "Token already spent."}' }),
      {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MintOperationError);
    expect((err as MintOperationError).code).toBe(11001);
    expect((err as Error).message).toContain('already spent');
  });

  it('429 → RateLimitError with Retry-After; other non-2xx (3xx included: redirects are never followed) → HttpResponseError', async () => {
    const rl = await call(
      fixed({ status: 429, headers: { 'retry-after': '7' }, body: '' }),
      {},
    ).catch((e: unknown) => e);
    expect(rl).toBeInstanceOf(RateLimitError);
    expect((rl as RateLimitError).retryAfterMs).toBe(7000);
    for (const [status, body, message] of [
      [500, '{"detail": "boom"}', 'boom'],
      [503, '{"error": "maintenance"}', 'maintenance'],
      [302, '', 'bad response'],
      [400, '{"detail": "no code"}', 'no code'],
      [404, 'not json', 'not json'],
    ] as const) {
      const e = await call(fixed({ status, body }), {}).catch((x: unknown) => x);
      expect(e, String(status)).toBeInstanceOf(HttpResponseError);
      expect(e).not.toBeInstanceOf(MintOperationError);
      expect((e as HttpResponseError).status).toBe(status);
      expect((e as Error).message).toBe(message);
    }
  });

  it('no answer → NetworkError; an empty or non-JSON 2xx body → HttpResponseError', async () => {
    const down: RawHttp = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const e = await call(down, {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NetworkError);
    expect((e as Error).message).toBe('connect ECONNREFUSED');
    for (const body of ['', '{oops'])
      expect(await call(fixed({ body }), {}).catch((x: unknown) => x)).toBeInstanceOf(
        HttpResponseError,
      );
  });

  it('onResponseMeta gets status, Retry-After and a get() over the headers; a throwing observer does not fail the request', async () => {
    const metas: { status: number; retryAfterMs?: number; rl: string | null }[] = [];
    const http = fixed({ body: '{}', headers: { ratelimit: 'r=1', 'retry-after': '2' } });
    await call(http, {
      onResponseMeta: (m: { status: number; retryAfterMs?: number; headers: Headers }) =>
        metas.push({
          status: m.status,
          ...(m.retryAfterMs === undefined ? {} : { retryAfterMs: m.retryAfterMs }),
          rl: m.headers.get('RateLimit'),
        }),
    });
    expect(metas).toEqual([{ status: 200, retryAfterMs: 2000, rl: 'r=1' }]);
    await expect(
      call(http, {
        onResponseMeta: () => {
          throw new Error('observer bug');
        },
      }),
    ).resolves.toEqual({});
  });

  it('the whole wallet over the transport against the in-process mint: fund, P2PK send, receive — and a double-spend still reads as `spent`', async () => {
    const mint = new TestMint({ url: MINT, seed: new Uint8Array(32).fill(4) });
    // A wire in front of the mint: JSON in both directions, mint errors as 400 { code, detail }.
    const wire: RawHttp = async (req) => {
      try {
        const out = await mint.request({
          endpoint: req.url,
          method: req.method,
          ...(req.body === undefined
            ? {}
            : { requestBody: JSON.parse(req.body) as Record<string, unknown> }),
        });
        return { status: 200, headers: {}, body: JSON.stringify(out) };
      } catch (e) {
        if (e instanceof MintOperationError)
          return {
            status: 400,
            headers: {},
            body: JSON.stringify({ code: e.code, detail: e.message }),
          };
        throw e;
      }
    };
    const request = cashuRequestFn(wire);
    const sk = new Uint8Array(32).fill(8);
    const pub = Buffer.from(getPubKeyFromPrivKey(sk)).toString('hex') as CashuP2pkPubkey;
    const make = (key?: Uint8Array): CashuWallet =>
      new CashuWallet({
        mints: new CashuMintConnections({ request: () => request }),
        store: new MemoryProofStore(),
        ...(key === undefined ? {} : { key: memoryWalletKey(key) }),
      });
    const payer = make();
    const q = await payer.mintQuote(MINT, 50 as Sats);
    mint.payQuote(q.quoteId);
    expect(await payer.pollQuote(q)).toEqual({ state: 'ISSUED', minted: 50 });
    const set = await payer.send(20 as Sats, { p2pk: pub, mint: MINT });
    const payee = make(sk);
    expect(await payee.receive(set)).toBe(20);
    const again = await make(sk)
      .receive(set)
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(WalletError);
    expect((again as WalletError).code).toBe('spent');
    expect(await payee.checkSpent(set)).toEqual(set.proofs.map(() => true));
  });
});
