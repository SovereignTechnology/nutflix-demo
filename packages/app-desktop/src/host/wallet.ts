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

function unavailable<T>(): Promise<T> {
  return Promise.reject(hostError('payments-unavailable', UNAVAILABLE));
}

export class UnavailableWallet implements Wallet {
  mints(): Promise<readonly MintUrl[]> {
    return unavailable();
  }
  balance(_mint: MintUrl): Promise<Sats> {
    return unavailable();
  }
  balances(): Promise<ReadonlyMap<MintUrl, Sats>> {
    return unavailable();
  }
  p2pkPubkey(): Promise<CashuP2pkPubkey> {
    return unavailable();
  }
  mintQuote(_mint: MintUrl, _amount: Sats): Promise<MintQuote> {
    return unavailable();
  }
  pollQuote(_quote: MintQuote): Promise<{ state: MintQuote['state']; minted?: Sats }> {
    return unavailable();
  }
  send(_amount: Sats, _opts: { p2pk: CashuP2pkPubkey; mint: MintUrl }): Promise<LockedProofSet> {
    return unavailable();
  }
  receive(_set: LockedProofSet): Promise<Sats> {
    return unavailable();
  }
  meltQuote(_mint: MintUrl, _bolt11: string): Promise<MeltQuote> {
    return unavailable();
  }
  melt(_quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    return unavailable();
  }
  keyset(_mint: MintUrl, _keysetId: string): Promise<MintKeyset> {
    return unavailable();
  }
  history(): Promise<readonly WalletHistoryEntry[]> {
    return unavailable();
  }
  onChange(_cb: (e: WalletChangeEvent) => void): () => void {
    return () => undefined;
  }
}

/** Fake sats a `--dev-mocks` wallet starts with at each fixture mint. */
export const DEV_BALANCE_SATS = 21_000;

export type WalletProvider =
  | { readonly kind: 'unavailable'; readonly wallet: Wallet }
  | { readonly kind: 'mock'; readonly wallet: mocks.MockWallet };

export function createWalletProvider(devMocks: boolean): WalletProvider {
  if (!devMocks) return { kind: 'unavailable', wallet: new UnavailableWallet() };
  return {
    kind: 'mock',
    wallet: new mocks.MockWallet({
      balances: { [mocks.MINTS.a]: DEV_BALANCE_SATS, [mocks.MINTS.b]: DEV_BALANCE_SATS },
    }),
  };
}
