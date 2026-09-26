/**
 * CashuWallet — the contract's `Wallet` (NIP-60 ecash wallet, thin over `@cashu/cashu-ts`).
 *
 * The read side (mints, balances, history, keysets) and the NUT-04 quote flow live here; every
 * operation that moves proofs goes through `spend.ts`'s `Spender` (the locked audit surface).
 * Mint quotes the wallet created are remembered and can be listed (`pendingMintQuotes`, L5-Wallet
 * request 2) so a paid invoice is not forgotten when the fund sheet closes.
 */
import {
  Mint,
  Wallet as CashuTsWallet,
  getPubKeyFromPrivKey,
  schnorrSignMessage,
  type RequestFn,
} from '@cashu/cashu-ts';

import type {
  CashuP2pkPubkey,
  CashuProof,
  LockedProofSet,
  MeltQuote,
  MintKeyset,
  MintQuote,
  MintUrl,
  Sats,
  Signer,
  UnixSeconds,
  Wallet,
  WalletChangeEvent,
  WalletHistoryEntry,
} from '../contracts/index.js';
import {
  PENDING_SETTLE_AFTER_S,
  Spender,
  WalletError,
  type MintConnections,
  type WalletKey,
} from './spend.js';
import { fetchRawHttp } from './fetch-http.js';
import { heldSecrets, proofTotal, type ProofStore } from './store.js';
import { cashuRequestFn } from './transport.js';

// ---------------------------------------------------------------------------------------
// Mint connections
// ---------------------------------------------------------------------------------------

/**
 * Every mint of a `CashuMintConnections` not given a request function: `cashuRequestFn` (one
 * attempt per request, 30 s, 300 s for a melt, no redirects, a 4 MiB cap) over the platform's
 * `fetch` (`fetch-http.ts`). `fetch` is looked up per request, so building this loads nothing.
 */
const DEFAULT_REQUEST: RequestFn = cashuRequestFn(fetchRawHttp());

/**
 * One loaded cashu-ts `Wallet` per mint, created on first use. `request` overrides the HTTP
 * transport per mint (the in-process `TestMint`, or a host transport with its own policy).
 * `requireSigDleq`: a mint that advertises NUT-12 must return DLEQ proofs on every signature.
 *
 * Every mint is reached through a SINGLE-ATTEMPT transport: `spend.ts` reads a coded answer as the
 * mint's answer to its one request (`isDefinitive`). Without `request`, or where it answers
 * `undefined`, that is `cashuRequestFn` over `fetch` (`fetch-http.ts`) — never cashu-ts's own
 * fetch transport, which RETRIES swaps, melts and mints at a mint advertising NUT-19; a coded
 * answer to such a retry dropped the journal entry of a request that had executed (issue #8 fix
 * round 3; before, only the callers kept it away). The Node wallets pass `cashuRequestFn` over
 * `node:http(s)` instead — the daemons run `--jitless`, where `fetch`'s parser (WebAssembly)
 * crashes: the desktop's `host/mint-transport.ts`, the daemons' `@sovit/seeder`
 * `runtime/mint-http.ts`. An injected `request` must not retry either.
 */
export class CashuMintConnections implements MintConnections {
  private readonly wallets = new Map<MintUrl, Promise<CashuTsWallet>>();

  constructor(
    private readonly opts: { readonly request?: (mint: MintUrl) => RequestFn | undefined } = {},
  ) {}

  wallet(mint: MintUrl): Promise<CashuTsWallet> {
    let w = this.wallets.get(mint);
    if (w === undefined) {
      const customRequest = this.opts.request?.(mint) ?? DEFAULT_REQUEST;
      const cashu = new CashuTsWallet(new Mint(mint, { customRequest }), {
        unit: 'sat',
        requireSigDleq: true,
      });
      w = cashu.loadMint().then(() => cashu);
      // A failed load is not cached: the next call retries.
      w.catch(() => this.wallets.delete(mint));
      this.wallets.set(mint, w);
    }
    return w;
  }
}

// ---------------------------------------------------------------------------------------
// Wallet keys
// ---------------------------------------------------------------------------------------

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/**
 * A wallet key held in memory (the NIP-60 `privkey`, decrypted from kind 17375 by the signer's
 * NIP-44 — the fallback mode build-plan §3 says the UI must disclose). The buffer is NOT copied:
 * pass a secure buffer and wipe it when the wallet is closed.
 */
export function memoryWalletKey(secretKey: Uint8Array): WalletKey {
  const pubkey = hex(getPubKeyFromPrivKey(secretKey)) as CashuP2pkPubkey;
  return {
    pubkey,
    sign: (secret) => Promise.resolve(schnorrSignMessage(secret, secretKey)),
    // NUT-20: cashu-ts takes the key as a string for a locked mint (see `WalletKey`).
    withSecretHex: (use) => use(hex(secretKey)),
  };
}

/** A wallet key the signer holds (`Signer.signSecret`) — the key never enters this process. */
export function signerWalletKey(signer: Signer, pubkey: CashuP2pkPubkey): WalletKey {
  const sign = signer.signSecret;
  if (sign === undefined)
    throw new WalletError('invalid-argument', 'this signer cannot sign NUT-11 witnesses');
  return { pubkey, sign: (secret) => sign(secret) };
}

// ---------------------------------------------------------------------------------------
// The wallet
// ---------------------------------------------------------------------------------------

export interface CashuWalletOptions {
  readonly mints: MintConnections;
  readonly store: ProofStore;
  /** The NIP-60 wallet key (receiving P2PK ecash; the nutzap target). */
  readonly key?: WalletKey;
  /** Mints to list even with a zero balance (the user's defaults). */
  readonly configuredMints?: readonly MintUrl[];
  readonly now?: () => UnixSeconds;
}

export class CashuWallet implements Wallet {
  private readonly spender: Spender;
  private readonly listeners = new Set<(e: WalletChangeEvent) => void>();
  private readonly pending = new Map<string, MintQuote>();
  private readonly keysets = new Map<string, MintKeyset>();
  private readonly now: () => UnixSeconds;

  constructor(private readonly o: CashuWalletOptions) {
    this.spender = new Spender({
      mints: o.mints,
      store: o.store,
      ...(o.key ? { key: o.key } : {}),
      ...(o.now ? { now: o.now } : {}),
    });
    this.now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  }

  /** The active keyset's `input_fee_ppk` (cashu-ts `Keyset.fee`; 0 when the mint sets none). */
  async inputFeePpk(mint: MintUrl): Promise<number> {
    const w = await this.o.mints.wallet(mint);
    const fee = w.getKeyset().fee;
    return Number.isSafeInteger(fee) && fee >= 0 ? fee : 0;
  }

  async mints(): Promise<readonly MintUrl[]> {
    const held = await this.o.store.mints();
    return [...new Set([...(this.o.configuredMints ?? []), ...held])];
  }

  /**
   * What can be spent at `mint`: the proofs held, less those an unresolved journaled send or melt
   * holds (ADR 0014 amendment, issue #8). Those come back when the mint says the operation never
   * executed, or leave with it when it did — never counted twice, never forgotten.
   */
  async balance(mint: MintUrl): Promise<Sats> {
    const proofs = await this.o.store.proofs(mint);
    const pending = this.o.store.pending === undefined ? [] : await this.o.store.pending(mint);
    if (pending.length === 0) return proofTotal(proofs) as Sats;
    const held = heldSecrets(pending);
    return proofTotal(proofs.filter((p) => !held.has(p.secret))) as Sats;
  }

  async balances(): Promise<ReadonlyMap<MintUrl, Sats>> {
    const out = new Map<MintUrl, Sats>();
    for (const m of await this.mints()) out.set(m, await this.balance(m));
    return out;
  }

  p2pkPubkey(): Promise<CashuP2pkPubkey> {
    if (this.o.key === undefined)
      return Promise.reject(new WalletError('invalid-argument', 'no NIP-60 wallet key is loaded'));
    return Promise.resolve(this.o.key.pubkey);
  }

  async mintQuote(mint: MintUrl, amount: Sats): Promise<MintQuote> {
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new WalletError('invalid-argument', 'amount must be a positive integer of sats');
    const w = await this.o.mints.wallet(mint);
    // Security review F17: a quote is bearer — whoever knows its id once the invoice is paid
    // mints the ecash. Where the mint supports NUT-20 and our key can sign, lock it to our key.
    const key = this.o.key;
    const lock = key?.withSecretHex !== undefined && supportsNut20(w) ? key.pubkey : undefined;
    const q =
      lock === undefined
        ? await w.createMintQuoteBolt11(amount)
        : await w.createLockedMintQuote(amount, lock);
    if (lock !== undefined && q.pubkey?.toLowerCase() !== lock.toLowerCase())
      throw new WalletError('bad-mint-response', 'the mint did not lock the quote to our key');
    const quote: MintQuote = {
      mint,
      quoteId: q.quote,
      amount: q.amount.toNumber(),
      bolt11: q.request,
      expiry: q.expiry ?? 0,
      state: q.state,
    };
    if (quote.amount !== amount)
      throw new WalletError('bad-mint-response', 'the mint quoted a different amount');
    this.pending.set(quote.quoteId, quote);
    this.emit({ type: 'quote', quote });
    return quote;
  }

  async pollQuote(quote: MintQuote): Promise<{ state: MintQuote['state']; minted?: Sats }> {
    const w = await this.o.mints.wallet(quote.mint);
    const q = await w.checkMintQuoteBolt11(quote.quoteId);
    if (q.state === 'UNPAID') return { state: 'UNPAID' };
    if (q.state === 'ISSUED') {
      // ADR 0014: issued by a mint request of ours whose answer was lost — restored, not gone.
      const minted = await this.spender.recoverMint(quote);
      this.pending.delete(quote.quoteId);
      if (minted === null) return { state: 'ISSUED' };
      this.emit({ type: 'quote', quote: { ...quote, state: 'ISSUED' } });
      await this.emitBalance(quote.mint);
      return { state: 'ISSUED', minted };
    }
    const minted = await this.spender.mint(quote, q.pubkey !== undefined ? q : undefined);
    this.pending.delete(quote.quoteId);
    const issued: MintQuote = { ...quote, state: 'ISSUED' };
    this.emit({ type: 'quote', quote: issued });
    await this.emitBalance(quote.mint);
    return { state: 'ISSUED', minted };
  }

  /** Quotes this wallet created and has not seen issued (L5-Wallet request 2). */
  pendingMintQuotes(): readonly MintQuote[] {
    const now = this.now();
    return [...this.pending.values()].filter((q) => q.expiry === 0 || q.expiry > now);
  }

  async send(
    amount: Sats,
    opts: {
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
      readonly tags?: readonly (readonly string[])[];
      readonly memo?: string;
    },
  ): Promise<LockedProofSet> {
    // A failed send may still move the balance (its inputs held while the mint's answer is
    // unknown, or reconciled away): the change event goes out either way.
    try {
      return await this.spender.send(amount, opts);
    } finally {
      await this.emitBalanceSafe(opts.mint);
    }
  }

  async receive(
    set: LockedProofSet | { readonly mint: MintUrl; readonly proofs: readonly CashuProof[] },
  ): Promise<Sats> {
    try {
      return await this.spender.receive(set);
    } finally {
      await this.emitBalanceSafe(set.mint);
    }
  }

  /** NUT-07 spent flags for a proof set (the seeder's creator-set check, security review F11). */
  checkSpent(set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }): Promise<readonly boolean[]> {
    return this.spender.checkSpent(set);
  }

  /** Whether every proof was spent with this wallet's own signature (a lost swap, F31). */
  spentByUs(set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }): Promise<boolean> {
    return this.spender.spentByUs(set);
  }

  /**
   * ADR 0014: settle the journal at every mint this wallet holds proofs or journaled operations
   * at — recover what a mint signed for an operation whose answer was lost. Run once at startup.
   * A mint that cannot be asked keeps its journal for the next operation there. Returns counts
   * of operations recovered and still journaled — `left` counts every entry still in the journal,
   * a skipped mint's too (one whose wallet does not load, or that no longer offers NUT-09): the
   * settle loop reads `left < before` as progress (issue #8 fix round 2).
   */
  async recoverPending(): Promise<{ recovered: number; left: number }> {
    let recovered = 0;
    let left = 0;
    const pendingAt = async (mint: MintUrl): Promise<number> =>
      (await this.o.store.pending?.(mint))?.length ?? 0;
    for (const mint of await this.o.store.mints()) {
      let before = 0;
      let counted = false;
      try {
        before = await pendingAt(mint);
        const r = await this.spender.recover(mint);
        recovered += r.recovered;
        const after = await pendingAt(mint);
        left += after;
        counted = true;
        // Held inputs come back (or leave) as entries settle: the balance moves either way.
        if (r.recovered > 0 || after !== before) await this.emitBalance(mint);
      } catch {
        // unreachable now (every operation at this mint settles it first): still journaled
        if (!counted) left += before;
      }
    }
    return { recovered, left };
  }

  /**
   * When the journal next needs a settle (issue #8 review: held inputs must come back without a
   * restart). `count`: operations journaled; `next`: the earliest time one that is still young can
   * be decided (`created + PENDING_SETTLE_AFTER_S`), `null` when none is; `overdue`: how many are
   * past that already — a melt the mint still reports PENDING, or a mint that could not be asked —
   * and are retried. `SettleLoop` (`settle-loop.ts`) plans `recoverPending` from this. Reads the
   * store only; never asks a mint.
   */
  async settleSchedule(): Promise<{
    readonly count: number;
    readonly overdue: number;
    readonly next: UnixSeconds | null;
  }> {
    const store = this.o.store;
    if (store.pending === undefined) return { count: 0, overdue: 0, next: null };
    const now = this.now();
    let count = 0;
    let overdue = 0;
    let next: number | null = null;
    for (const mint of await store.mints())
      for (const op of await store.pending(mint)) {
        count++;
        const at = op.created + PENDING_SETTLE_AFTER_S;
        if (at <= now) overdue++;
        else if (next === null || at < next) next = at;
      }
    return { count, overdue, next: next === null ? null : (next as UnixSeconds) };
  }

  async meltQuote(mint: MintUrl, bolt11: string): Promise<MeltQuote> {
    if (typeof bolt11 !== 'string' || !/^ln[a-z0-9]+$/i.test(bolt11.trim()))
      throw new WalletError('invalid-argument', 'expected a bolt11 invoice');
    const w = await this.o.mints.wallet(mint);
    const q = await w.createMeltQuoteBolt11(bolt11.trim());
    return {
      mint,
      quoteId: q.quote,
      amount: q.amount.toNumber(),
      feeReserve: q.fee_reserve.toNumber(),
      expiry: q.expiry,
      state: q.state,
    };
  }

  async melt(quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    try {
      return await this.spender.melt(quote);
    } finally {
      await this.emitBalanceSafe(quote.mint);
    }
  }

  async keyset(mint: MintUrl, keysetId: string): Promise<MintKeyset> {
    const cacheKey = `${mint}|${keysetId}`;
    const hit = this.keysets.get(cacheKey);
    if (hit !== undefined) return hit;
    const w = await this.o.mints.wallet(mint);
    let ks: ReturnType<CashuTsWallet['getKeyset']>;
    try {
      ks = w.getKeyset(keysetId);
    } catch {
      await w.loadMint(true); // fetch on miss (a keyset rotated in since the wallet loaded)
      ks = w.getKeyset(keysetId);
    }
    const keys: Record<string, string> = {};
    for (const [amount, key] of Object.entries(ks.keys)) keys[amount] = key;
    const out: MintKeyset = {
      mint,
      id: ks.id,
      unit: ks.unit,
      active: ks.isActive,
      keys,
      ...(ks.fee > 0 ? { inputFeePpk: ks.fee } : {}),
      fetchedAt: this.now(),
    };
    this.keysets.set(cacheKey, out);
    return out;
  }

  history(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]> {
    return this.o.store.history(opts);
  }

  onChange(cb: (e: WalletChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: WalletChangeEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  /** `emitBalance` for a `finally`: a failing read must not replace the operation's own error. */
  private async emitBalanceSafe(mint: MintUrl): Promise<void> {
    try {
      await this.emitBalance(mint);
    } catch {
      // the next change event carries the balance
    }
  }

  private async emitBalance(mint: MintUrl): Promise<void> {
    this.emit({ type: 'balance', mint, balance: await this.balance(mint) });
    const [latest] = await this.o.store.history({ limit: 1, mint });
    if (latest !== undefined) this.emit({ type: 'history', entry: latest });
  }
}

/** NUT-20 in the mint's info (loaded with the mint). Never throws. */
function supportsNut20(w: {
  getMintInfo(): { isSupported(n: 20): { supported: boolean } };
}): boolean {
  try {
    return w.getMintInfo().isSupported(20).supported;
  } catch {
    return false;
  }
}
