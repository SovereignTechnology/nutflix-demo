/**
 * Wallet provider (design §1 "Wallet and engine"). Stage 1 has no real wallet: behind
 * `--dev-mocks` it is core's `MockWallet` (fake sats), debited by the host from the worker's
 * `spend` events so the WalletChip moves; without it every wallet call rejects
 * `payments-unavailable: …` (reads too — a made-up "0 sats" would be a lie on screen).
 *
 * Nothing here executes an auto top-up (SE-4): the host only evaluates `autoTopUpDue` and logs.
 */
import type {
  CashuP2pkPubkey,
  LockedProofSet,
  MeltQuote,
  MintKeyset,
  MintQuote,
  MintUrl,
  Sats,
  Wallet,
  WalletChangeEvent,
  WalletHistoryEntry,
} from '@sovit/core';
import { mocks } from '@sovit/core';

import { hostError } from './errors.js';

const UNAVAILABLE = 'no wallet in Stage 1 (run with --dev-mocks for fake sats)';
/** Stage 3 (ADR 0013): what a signed-out, locked or wallet-less desktop says. */
export const NO_WALLET_YET =
  'no wallet: connect and unlock a signer (Settings › Account), and create a wallet';

export class UnavailableWallet implements Wallet {
  private readonly why: string;
  constructor(why: string = UNAVAILABLE) {
    this.why = why;
  }
  private unavailable<T>(): Promise<T> {
    return Promise.reject(hostError('payments-unavailable', this.why));
  }
  mints(): Promise<readonly MintUrl[]> {
    return this.unavailable();
  }
  balance(_mint: MintUrl): Promise<Sats> {
    return this.unavailable();
  }
  balances(): Promise<ReadonlyMap<MintUrl, Sats>> {
    return this.unavailable();
  }
  p2pkPubkey(): Promise<CashuP2pkPubkey> {
    return this.unavailable();
  }
  mintQuote(_mint: MintUrl, _amount: Sats): Promise<MintQuote> {
    return this.unavailable();
  }
  pollQuote(_quote: MintQuote): Promise<{ state: MintQuote['state']; minted?: Sats }> {
    return this.unavailable();
  }
  send(_amount: Sats, _opts: { p2pk: CashuP2pkPubkey; mint: MintUrl }): Promise<LockedProofSet> {
    return this.unavailable();
  }
  receive(_set: LockedProofSet): Promise<Sats> {
    return this.unavailable();
  }
  meltQuote(_mint: MintUrl, _bolt11: string): Promise<MeltQuote> {
    return this.unavailable();
  }
  melt(_quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    return this.unavailable();
  }
  keyset(_mint: MintUrl, _keysetId: string): Promise<MintKeyset> {
    return this.unavailable();
  }
  history(): Promise<readonly WalletHistoryEntry[]> {
    return this.unavailable();
  }
  onChange(_cb: (e: WalletChangeEvent) => void): () => void {
    return () => undefined;
  }
}

/**
 * Stage 3 (ADR 0013): the wallet the adapter holds for the app's lifetime, delegating to the
 * money plane of whatever signer is unlocked NOW (`set` on every signer change) — or answering
 * `payments-unavailable` while there is none. `onChange` listeners outlive the swaps.
 */
export class SwitchingWallet implements Wallet {
  private current: Wallet | undefined;
  private off: (() => void) | null = null;
  private readonly none = new UnavailableWallet(NO_WALLET_YET);
  private readonly listeners = new Set<(e: WalletChangeEvent) => void>();

  set(w: Wallet | undefined): void {
    if (w === this.current) return;
    this.off?.();
    this.off = null;
    this.current = w;
    if (w !== undefined)
      this.off = w.onChange((e) => {
        for (const cb of this.listeners) {
          try {
            cb(e);
          } catch {
            // a listener's failure is its own
          }
        }
      });
  }
  private w(): Wallet {
    return this.current ?? this.none;
  }
  mints(): Promise<readonly MintUrl[]> {
    return this.w().mints();
  }
  balance(mint: MintUrl): Promise<Sats> {
    return this.w().balance(mint);
  }
  balances(): Promise<ReadonlyMap<MintUrl, Sats>> {
    return this.w().balances();
  }
  p2pkPubkey(): Promise<CashuP2pkPubkey> {
    return this.w().p2pkPubkey();
  }
  mintQuote(mint: MintUrl, amount: Sats): Promise<MintQuote> {
    return this.w().mintQuote(mint, amount);
  }
  pollQuote(quote: MintQuote): Promise<{ state: MintQuote['state']; minted?: Sats }> {
    return this.w().pollQuote(quote);
  }
  send(amount: Sats, opts: { p2pk: CashuP2pkPubkey; mint: MintUrl }): Promise<LockedProofSet> {
    return this.w().send(amount, opts);
  }
  receive(set: LockedProofSet): Promise<Sats> {
    return this.w().receive(set);
  }
  meltQuote(mint: MintUrl, bolt11: string): Promise<MeltQuote> {
    return this.w().meltQuote(mint, bolt11);
  }
  melt(quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    return this.w().melt(quote);
  }
  keyset(mint: MintUrl, keysetId: string): Promise<MintKeyset> {
    return this.w().keyset(mint, keysetId);
  }
  history(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]> {
    return this.w().history(opts);
  }
  onChange(cb: (e: WalletChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

/** Fake sats a `--dev-mocks` wallet starts with at each fixture mint. */
export const DEV_BALANCE_SATS = 21_000;

export type WalletProvider =
  | { readonly kind: 'unavailable'; readonly wallet: Wallet }
  | { readonly kind: 'mock'; readonly wallet: mocks.MockWallet }
  /** Stage 3 (ADR 0012): the user's NIP-60 wallet, opened by the host's money plane. */
  | { readonly kind: 'real'; readonly wallet: Wallet };

export function createWalletProvider(devMocks: boolean): WalletProvider {
  if (!devMocks) return { kind: 'unavailable', wallet: new UnavailableWallet() };
  return {
    kind: 'mock',
    wallet: new mocks.MockWallet({
      balances: { [mocks.MINTS.a]: DEV_BALANCE_SATS, [mocks.MINTS.b]: DEV_BALANCE_SATS },
    }),
  };
}
