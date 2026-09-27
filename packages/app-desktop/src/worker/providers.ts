/**
 * Runtime provider seam for the worker — the same pattern as L3's `cli/providers.ts`. In
 * Stage 1 every real dependency is absent:
 *
 *   - `PaymentEngine` (seeder + viewer side) → `packages/core/src/payment/`      (locked, Stage 2)
 *   - `PayProtocol` (`pay/1` on protomux)     → `packages/core/src/pay-protocol/` (locked, Stage 2)
 *   - HELLO challenge signing                 → the `Signer` (Stage 2)
 *
 * so `getWorkerProviders()` returns `undefined`. Without providers the worker still starts
 * (ffmpeg probe, `ready{port}`), but it runs no swarm and no seeder: `play.open` and
 * `studio.upload` reject `payments-unavailable:` (a viewer that cannot pay would be cut by
 * every seeder after the free window; a seeder that cannot verify PAYs must not serve).
 * `--dev-mocks` (`dev/dev-mocks.ts`) is the explicit, loudly logged, loopback-fenced way to
 * run against `MockPaymentEngine('honest')` — D1.
 */
import type {
  MintUrl,
  NostrPubkey,
  PaymentEngineSeeder,
  PaymentEngineConfig,
  payment,
} from '@sovit/core';

import type { PayWiring } from './net/peer-node.js';
import type { PayFn } from './pay/viewer-payer.js';

export interface WorkerProviders {
  /**
   * Verifies PAYs from peers that download from us (seeder side). Also an `UnpaidLedger` (both
   * engines of `@sovit/core` are): our seeder reports a viewer's unpaid blocks in `OWED` and
   * `ACK.outstanding` (contracts v6 amendment).
   */
  readonly seederEngine: PaymentEngineSeeder &
    payment.UnpaidLedger & {
      readonly config?: Pick<PaymentEngineConfig, 'flushEveryBlocks' | 'flushEveryMs'>;
    };
  /** Builds OUR `PAY` for blocks we downloaded (viewer side; `PaymentEngineViewer.pay`). */
  readonly pay: PayFn;
  /** Mints the viewer's wallet can pay with. */
  readonly viewerMints: readonly MintUrl[];
  /** One `pay/1` per connection + the HELLO we send. */
  readonly payWiring: PayWiring;
  /** Our identity on the payment channel (HELLO `pubkey`). */
  readonly pubkey: NostrPubkey;
  /**
   * The unpaid window the SEEDERS we download from grant (contract default 4 blocks): the
   * size of the worker's `CreditPool`.
   */
  readonly creditBlocks: number;
  /** Dev doubles only: the swarm must stay on loopback (the `--dev-mocks` fence). */
  readonly loopbackOnly: boolean;
  /**
   * `SeederDeps.accepting`: `false` while the accepted-but-unflushed PAY queue is full (a mint
   * down) — serving stops (a local cut, no ban) until a flush drains it. Real providers only.
   */
  readonly accepting?: () => boolean;
  /** Release what the providers hold (the DLEQ thread). Real providers only. */
  readonly close?: () => void;
}

export interface ProviderContext {
  /** The worker's storage directory (Stage 2 providers may keep state there). */
  readonly storage: string;
}

export function getWorkerProviders(_ctx: ProviderContext): WorkerProviders | undefined {
  return undefined;
}

export const MISSING_PROVIDERS_DETAIL =
  'no payment providers are wired in Stage 1 (PaymentEngine, pay/1 and the Signer land in Stage 2) — run with --dev-mocks for development only';

export const MISSING_PROVIDERS_REASON = `payments-unavailable: ${MISSING_PROVIDERS_DETAIL}`;
