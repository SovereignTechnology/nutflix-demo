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
import { Spender, WalletError, type MintConnections, type WalletKey } from './spend.js';
import { proofTotal, type ProofStore } from './store.js';

// ---------------------------------------------------------------------------------------
// Mint connections
// ---------------------------------------------------------------------------------------

/**
 * One loaded cashu-ts `Wallet` per mint, created on first use. `request` overrides the HTTP
 * transport per mint (the in-process `TestMint`, or a host transport with its own policy).
 * `requireSigDleq`: a mint that advertises NUT-12 must return DLEQ proofs on every signature.
 */
export class CashuMintConnections implements MintConnections {
  private readonly wallets = new Map<MintUrl, Promise<CashuTsWallet>>();

  constructor(
    private readonly opts: { readonly request?: (mint: MintUrl) => RequestFn | undefined } = {},
  ) {}

  wallet(mint: MintUrl): Promise<CashuTsWallet> {
    let w = this.wallets.get(mint);
    if (w === undefined) {
      const customRequest = this.opts.request?.(mint);
      const cashu = new CashuTsWallet(
        new Mint(mint, customRequest === undefined ? {} : { customRequest }),
        { unit: 'sat', requireSigDleq: true },
      );
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
    });
    this.now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  }

  async mints(): Promise<readonly MintUrl[]> {
    const held = await this.o.store.mints();
    return [...new Set([...(this.o.configuredMints ?? []), ...held])];
  }

  async balance(mint: MintUrl): Promise<Sats> {
    return proofTotal(await this.o.store.proofs(mint)) as Sats;
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
    const q = await w.createMintQuoteBolt11(amount);
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
      this.pending.delete(quote.quoteId);
      return { state: 'ISSUED' };
    }
    const minted = await this.spender.mint(quote);
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
    const set = await this.spender.send(amount, opts);
    await this.emitBalance(opts.mint);
    return set;
  }

  async receive(
    set: LockedProofSet | { readonly mint: MintUrl; readonly proofs: readonly CashuProof[] },
  ): Promise<Sats> {
    const got = await this.spender.receive(set);
    await this.emitBalance(set.mint);
    return got;
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
    const r = await this.spender.melt(quote);
    await this.emitBalance(quote.mint);
    return r;
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

  private async emitBalance(mint: MintUrl): Promise<void> {
    this.emit({ type: 'balance', mint, balance: await this.balance(mint) });
    const [latest] = await this.o.store.history({ limit: 1, mint });
    if (latest !== undefined) this.emit({ type: 'history', entry: latest });
  }
}
