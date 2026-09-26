/**
 * Test support (not a suite): a `TopUpVault` for AutoTopUp tests that run a bare `CashuWallet`
 * (no money plane). Its "seal" is a reversible encoding bound to the owner — a test double, not
 * sealing: `MoneyPlane.topUpVault` (NIP-44 to self through the signer) is tested in
 * `money.test.ts` and through the whole host in `topup-host.test.ts`. The journal and melt-quote
 * reads are the plane's, over the test's own store and mint connections.
 */
import type { MintUrl, NostrPubkey } from '@sovit/core';
import type { wallet as walletMod } from '@sovit/core';

import type { TopUpVault } from '../../topup/auto-topup.js';

export function testVault(o: {
  readonly owner: NostrPubkey;
  /** The wallet's store (its journal); none: nothing is ever journaled. */
  readonly store?: walletMod.ProofStore;
  readonly mints: walletMod.MintConnections;
  readonly recovery?: Promise<unknown>;
  /** Every text sealed (tests assert what reached the ledger sealed). */
  readonly sealed?: string[];
}): TopUpVault {
  const tag = `${o.owner}\n`;
  return {
    owner: o.owner,
    seal: (plain) => {
      o.sealed?.push(plain);
      return Promise.resolve(Buffer.from(tag + plain, 'utf8').toString('base64'));
    },
    unseal: (sealed) => {
      const text = Buffer.from(sealed, 'base64').toString('utf8');
      if (!text.startsWith(tag)) return Promise.reject(new Error('not sealed to this identity'));
      return Promise.resolve(text.slice(tag.length));
    },
    meltPending: async (mint: MintUrl, quoteId: string) =>
      ((await o.store?.pending?.(mint)) ?? []).some(
        (op) => op.kind === 'melt' && op.key.includes(quoteId),
      ),
    meltState: async (mint: MintUrl, quoteId: string) =>
      (await (await o.mints.wallet(mint)).checkMeltQuoteBolt11(quoteId)).state,
    recovery: () => o.recovery ?? Promise.resolve(),
  };
}
