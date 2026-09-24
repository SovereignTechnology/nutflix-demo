/**
 * Runtime provider seam for the seeder daemon entry (`cli/main.ts`) — the same pattern as the
 * gateway's `cli/providers.ts`. In Stage 1 every real dependency of a production seeder is
 * absent:
 *
 *   - `PaymentEngineSeeder` → `packages/core/src/payment/`      (locked until Stage 2)
 *   - `PayProtocol`         → `packages/core/src/pay-protocol/` (locked until Stage 2)
 *   - HELLO identity        → the `Signer` (`packages/core/src/signer/`, Stage 2)
 *
 * so `getRuntimeDeps()` returns `undefined` and `main()` refuses to start with a clear,
 * redacted reason and exit 78 (EX_CONFIG).
 *
 * STAGE 2 — this is NOT a one-function change, unlike the gateway's seam. `RuntimeDeps`
 * carries only what `runDaemon()` consumes today: the engine. The daemon does not yet
 * attach `pay/1` to swarm sessions or send `HELLO` (the gateway and the desktop worker do
 * that in their own shells), so a daemon started with only an engine serves every peer
 * `windowBlocks` unpaid blocks and then cuts it — `main()` logs a `warn` saying exactly
 * that on every start. Stage 2 has to add, together:
 *   1. the engine here;
 *   2. a `PayProtocol` factory + a HELLO identity (pubkey, P2PK, challenge signing) here;
 *   3. the wiring: on each admitted swarm session, attach the protocol to `session.mux`,
 *      `seeder.attachPayProtocol()`, send `HELLO` from `seeder.policy()`. The seeder's own
 *      `SwarmManager` admits a connection BEFORE Corestore replicates on it, so `session.mux`
 *      is still null at `session-open`; either `Seeder` grows an on-session hook
 *      (`seeder.ts`, outside the Seeder-entry lane) or the daemon owns the swarm the way the
 *      desktop worker's `PeerNode` does. See docs/lanes/Seeder-entry.md "Stage 2".
 * Remove the start-up `warn` in `main.ts` in the same change.
 */
import type { SeederDeps } from '../seeder.js';
import type { DaemonConfig } from './config-file.js';

export interface RuntimeDeps {
  /** The real `PaymentEngineSeeder` (Stage 2). Tests pass `mocks.MockPaymentEngine`. */
  readonly engine: SeederDeps['engine'];
}

/** Stage 1: nothing to provide. A provider may be async (Stage 2 will open a wallet). */
export function getRuntimeDeps(_config: DaemonConfig): RuntimeDeps | undefined {
  return undefined;
}

export const MISSING_PROVIDERS_REASON =
  'no runtime providers wired: PaymentEngineSeeder, PayProtocol and the HELLO Signer land in Stage 2 (see packages/seeder/src/cli/providers.ts)';
