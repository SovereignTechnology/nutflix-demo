/**
 * Shared rig for the NUT-13 tests (ADR 0016): a "device" is a `CashuWallet` over
 * `CashuMintConnections` given a recovery seed and a counters file, talking to in-process
 * `TestMint`s through a transport that records what the mint answered and can rewrite it, hold a
 * request, or take a mint offline. Imported by the NUT-13 tests. (Core's vitest config runs every
 * file under `__tests__`, so the helper carries its own check, like `cashu-ts-own-transport.ts`.)
 */
import {
  getPubKeyFromPrivKey,
  OutputData,
  type HasKeysetKeys,
  type RequestFn,
} from '@cashu/cashu-ts';

import { describe, expect, it } from 'vitest';

import type { CashuP2pkPubkey, MintUrl, Sats } from '../../contracts/index.js';
import { MemoryCounterStore } from '../../mocks/counter-store.js';
import { TestMint } from '../../mocks/test-mint.js';
import type { RecoverySeed } from '../recovery-api.js';
import { recoveryPhrases, seedBytes } from '../seed.js';
import { MemoryProofStore, type ProofStore } from '../store.js';
import { CashuMintConnections, CashuWallet, type CashuWalletOptions } from '../wallet.js';

export const MINT_A = 'https://mint.nut13-a.example' as MintUrl;
export const MINT_B = 'https://mint.nut13-b.example' as MintUrl;
/** 200 × 0.1 sat = 20 sat at the TestMint. */
export const INVOICE_20 = 'lnbc200n1testinvoice';
export const sats = (n: number): Sats => n as Sats;

export const TO = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x61))).toString(
  'hex',
) as CashuP2pkPubkey;

export async function newSeed(): Promise<RecoverySeed> {
  return recoveryPhrases.toSeed(recoveryPhrases.generate());
}

/** A counters file that already knows `keysetId` at `next` (so no probe runs for it). */
export function knownCounters(keysetId: string, next: number): MemoryCounterStore {
  return new MemoryCounterStore({ v: 1, next: { [keysetId]: next }, published: {} });
}

/** Derivations are slow (a hash-to-curve each): computed once per seed and keyset, extended on demand. */
interface Derived {
  readonly secrets: string[];
  readonly blinded: string[];
}
const DERIVED = new WeakMap<RecoverySeed, Map<string, Derived>>();

function derivedList(seed: RecoverySeed, keysetId: string, n: number): Derived {
  let bySet = DERIVED.get(seed);
  if (bySet === undefined) DERIVED.set(seed, (bySet = new Map<string, Derived>()));
  let got = bySet.get(keysetId);
  if (got === undefined) bySet.set(keysetId, (got = { secrets: [], blinded: [] }));
  if (got.secrets.length < n) {
    const from = got.secrets.length;
    const keyset: HasKeysetKeys = { id: keysetId, keys: {} };
    for (const o of OutputData.createDeterministicData(
      0,
      seedBytes(seed),
      from,
      keyset,
      new Array<number>(n - from).fill(0),
    )) {
      got.secrets.push(new TextDecoder().decode(o.secret));
      got.blinded.push(o.blindedMessage.B_);
    }
  }
  return got;
}

/** The NUT-13 secrets of `seed` under `keysetId` for counters `[0, n)`. */
export function derivedSecrets(seed: RecoverySeed, keysetId: string, n = 64): Set<string> {
  return new Set(derivedList(seed, keysetId, n).secrets.slice(0, n));
}

/** The counter whose NUT-13 blinded message is `B_` under `keysetId` (searched in `[0, n)`), or -1. */
export function blindedCounter(seed: RecoverySeed, keysetId: string, B_: string, n = 64): number {
  return derivedList(seed, keysetId, n).blinded.slice(0, n).indexOf(B_);
}

/** The counter of `secret` under `keysetId` (searched in `[0, n)`), or -1. */
export function counterOf(seed: RecoverySeed, keysetId: string, secret: string, n = 64): number {
  return derivedList(seed, keysetId, n).secrets.slice(0, n).indexOf(secret);
}

export interface Net {
  /** Every coded refusal a mint answered (MintOperationError codes), in order. */
  readonly codes: number[];
  /** `METHOD url-path` of every request sent, in order. */
  readonly calls: string[];
  /** Mints that are unreachable (the request never arrives). */
  readonly down: Set<string>;
  /** Rewrite an answer before the wallet sees it. */
  rewrite: ((path: string, res: Record<string, unknown>) => void) | null;
  /** Replace a mint's refusal (e.g. its code) before the wallet sees it. */
  mapError: ((path: string, e: unknown) => unknown) | null;
  /** Run before a request is forwarded (may await: another device acting first). */
  before: ((path: string, body: Record<string, unknown> | undefined) => Promise<void>) | null;
  /** Hold the next request to a path ending so, until the returned release is called. */
  hold(pathEnd: string): () => void;
  /** Requests to `/v1/restore` so far. */
  restores(): number;
}

function makeNet(): Net & { wrap(url: string, inner: RequestFn): RequestFn } {
  const holds = new Map<string, Promise<void>>();
  const net = {
    codes: [] as number[],
    calls: [] as string[],
    down: new Set<string>(),
    rewrite: null as Net['rewrite'],
    mapError: null as Net['mapError'],
    before: null as Net['before'],
    hold(pathEnd: string): () => void {
      let release: () => void = () => undefined;
      holds.set(
        pathEnd,
        new Promise<void>((res) => {
          release = res;
        }),
      );
      return () => {
        release();
      };
    },
    restores(): number {
      return net.calls.filter((c) => c.endsWith('/v1/restore')).length;
    },
    wrap(url: string, inner: RequestFn): RequestFn {
      return async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
        const path = new URL(args.endpoint).pathname;
        if (net.down.has(url)) throw new Error('connect ECONNREFUSED');
        net.calls.push(`${(args.method ?? 'GET').toUpperCase()} ${path}`);
        for (const [end, gate] of holds)
          if (path.endsWith(end)) {
            holds.delete(end);
            await gate;
          }
        if (net.before !== null) await net.before(path, args.requestBody);
        let res: Record<string, unknown>;
        try {
          res = await inner<Record<string, unknown>>(args);
        } catch (e) {
          const code = (e as { code?: unknown }).code;
          if (typeof code === 'number') net.codes.push(code);
          throw net.mapError === null ? e : net.mapError(path, e);
        }
        net.rewrite?.(path, res);
        return res as T;
      };
    },
  };
  return net;
}

export interface Device {
  readonly wallet: CashuWallet;
  readonly store: ProofStore;
  readonly counters: MemoryCounterStore;
  readonly conns: CashuMintConnections;
  readonly net: Net;
  readonly seed: RecoverySeed | undefined;
}

export function device(o: {
  readonly mints: readonly TestMint[];
  /** This device's own phrase; none: an unseeded wallet (random outputs). */
  readonly seed?: RecoverySeed;
  readonly counters?: MemoryCounterStore;
  readonly store?: ProofStore;
  readonly restoreLimits?: CashuWalletOptions['restoreLimits'];
}): Device {
  const net = makeNet();
  const byUrl = new Map(o.mints.map((m) => [m.url as string, net.wrap(m.url, m.request)]));
  const counters = o.counters ?? new MemoryCounterStore(null);
  const conns = new CashuMintConnections({
    request: (m) => byUrl.get(m),
    ...(o.seed === undefined ? {} : { seed: { seed: o.seed, counters } }),
  });
  const store = o.store ?? new MemoryProofStore();
  const wallet = new CashuWallet({
    mints: conns,
    store,
    ...(o.restoreLimits === undefined ? {} : { restoreLimits: o.restoreLimits }),
  });
  return { wallet, store, counters, conns, net, seed: o.seed };
}

/** Top up `amount` sat at `mint` (the quote paid at once). */
export async function fund(d: Device, mint: TestMint, amount: number): Promise<void> {
  const q = await d.wallet.mintQuote(mint.url, sats(amount));
  mint.payQuote(q.quoteId);
  const r = await d.wallet.pollQuote(q);
  if (r.state !== 'ISSUED' || r.minted !== amount) throw new Error('funding failed');
}

/** A proof store without a journal (`pending`): the wallet journals nothing over it. */
export function unjournaled(inner: MemoryProofStore = new MemoryProofStore()): ProofStore {
  return {
    mints: () => inner.mints(),
    proofs: (m) => inner.proofs(m),
    commit: (tx) => inner.commit(tx),
    history: (opts) => inner.history(opts),
  };
}

/** Put `proofs` in a store directly (e.g. random proofs a TestMint issued). */
export async function hold(
  store: ProofStore,
  mint: MintUrl,
  proofs: Parameters<ProofStore['commit']>[0]['added'],
): Promise<void> {
  await store.commit({ mint, spent: [], added: proofs });
}

describe('nut13-rig (test helper)', () => {
  it('derivations agree with one another; a known counters file skips the probe; the net records refusals', async () => {
    const seed = await newSeed();
    const k = '01' + '22'.repeat(32);
    const set = derivedSecrets(seed, k, 8);
    expect(set.size).toBe(8);
    const [third] = [...set].slice(2, 3);
    expect(counterOf(seed, k, third!, 8)).toBe(2);
    expect(counterOf(seed, k, 'not a secret', 8)).toBe(-1);
    expect(knownCounters(k, 5).state).toEqual({ v: 1, next: { [k]: 5 }, published: {} });
    expect('pending' in unjournaled()).toBe(false);

    const mint = new TestMint({ url: MINT_A, seed: new Uint8Array(32).fill(0x70) });
    const d = device({ mints: [mint], seed, counters: knownCounters(mint.keysetId, 0) });
    await fund(d, mint, 3);
    expect(d.net.restores()).toBe(0); // known: nothing probed
    const q = await d.wallet.mintQuote(MINT_A, sats(1));
    await expect(d.wallet.pollQuote(q)).resolves.toEqual({ state: 'UNPAID' });
    mint.payQuote(q.quoteId);
    await d.wallet.pollQuote(q);
    await expect(d.wallet.pollQuote(q)).resolves.toMatchObject({ state: 'ISSUED' });
    expect(d.net.codes).toEqual([]);
  });
});
