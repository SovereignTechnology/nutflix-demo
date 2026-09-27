/**
 * `--dev-mocks`: the worker's payment providers from the explicit, cheatable mocks in
 * `@sovit/core` so the shell can be driven end to end before Stage 2 (D1).
 *
 * NOT FOR PRODUCTION, and fenced like L3's `--dev-mocks`:
 *   - the host passes `init.dev.mocks` only behind the CLI flag; the worker loads this module
 *     with a dynamic `import()` only then, and logs a `warn` line on every start;
 *   - `checkDevFence` refuses mocks unless the swarm is provably loopback-only — a
 *     `127.0.0.1` bootstrap or the worker's own in-process fixture testnet — and the DHT node
 *     is bound to `127.0.0.1` (`PeerNode.loopbackOnly`): mock payments never meet the public
 *     DHT (the worker-guards refuse a non-loopback bootstrap too; this is the second check);
 *   - `MockPaymentEngine('honest')` for both roles (contracts v5 fixed the two mock bugs the
 *     Stage 1 `DevEngine` wrapper worked around — block index read as a count, colliding
 *     secrets — so the plain mock is used): it "pays" with mock proofs worth nothing and
 *     accepts the same; `pay/1` is the in-process `LoopbackPayHub`; HELLO signatures are the
 *     literal `dev-unsigned`.
 */
import type {
  CashuP2pkPubkey,
  HelloMessage,
  NostrPubkey,
  PaymentEngine,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { DEFAULT_WINDOW_BLOCKS, mocks } from '@sovit/core';

import { utf8 } from '../../ipc/codec.js';
import type { WorkerInit } from '../../ipc/worker-protocol.js';
import { sha256Hex } from '../crypto.js';
import type { WorkerProviders } from '../providers.js';
import type { LoopbackPayHub } from './loopback-pay.js';

/**
 * What a dev node charges per block (the fixture price). 2, not 1: the v4 split rounds the
 * seeder share DOWN (`floor(total × seeder / 100)`), so a one-block PAY at 1 sat/block with a
 * 50/50 split would carry an empty seeder set and be refused (`missing-seeder-set`) — the
 * per-PAY minimum ADR 0007 addresses in Stage 2.
 */
export const DEV_PRICE = 2 as Sats;

/** A deterministic, obviously-fake identity for a dev node (NOT a key: nothing signs with it). */
export function devIdentity(label: string): {
  readonly pubkey: NostrPubkey;
  readonly p2pk: CashuP2pkPubkey;
} {
  return {
    pubkey: sha256Hex(utf8.encode(`nutflix-dev-identity:${label}:pubkey`)) as NostrPubkey,
    p2pk: `02${sha256Hex(utf8.encode(`nutflix-dev-identity:${label}:p2pk`))}` as CashuP2pkPubkey,
  };
}

/** The HELLO a dev node sends: its engine's terms, unsigned. */
export function devHello(
  engine: Pick<PaymentEngine, 'config'>,
  terms: Pick<PricePolicy, 'satsPerBlock' | 'split'>,
): Omit<HelloMessage, 'type'> {
  return {
    version: 1,
    pubkey: engine.config.ownPubkey,
    challenge: 'dev',
    createdAt: 0 as HelloMessage['createdAt'],
    signature: 'dev-unsigned',
    acceptedMints: engine.config.acceptedMints,
    satsPerBlock: terms.satsPerBlock,
    split: terms.split,
    p2pk: engine.config.ownP2pk,
    windowBlocks: engine.config.windowBlocks,
  };
}

/** The dev engine: the plain v5 `MockPaymentEngine`. */
export type DevEngine = mocks.MockPaymentEngine;

/** A fresh `MockPaymentEngine('honest')` under a dev identity (window: the mock's, 4). */
export function devEngine(label: string, opts: { readonly windowBlocks?: number } = {}): DevEngine {
  const id = devIdentity(label);
  return new mocks.MockPaymentEngine({
    mode: 'honest',
    config: {
      ownPubkey: id.pubkey,
      ownP2pk: id.p2pk,
      ...(opts.windowBlocks !== undefined ? { windowBlocks: opts.windowBlocks } : {}),
    },
  });
}

/**
 * The `--dev-mocks` fence, in code (the guard already enforces the bootstrap shape):
 * mocks need a loopback swarm — an explicit all-`127.0.0.1` bootstrap or the worker's own
 * fixture testnet — and fixtures need mocks. Throws `invalid-argument:` otherwise.
 */
export function checkDevFence(dev: WorkerInit['dev']): void {
  if (dev === undefined) return;
  if (dev.fixtures && !dev.mocks)
    throw new Error('invalid-argument: --dev-fixtures requires --dev-mocks');
  if (dev.bootstrap !== undefined && !dev.mocks)
    throw new Error('invalid-argument: a custom bootstrap is only accepted with --dev-mocks');
  if (!dev.mocks) return;
  if (dev.bootstrap === undefined && !dev.fixtures)
    throw new Error(
      'invalid-argument: --dev-mocks refuses the public DHT: pass a 127.0.0.1 bootstrap or --dev-fixtures',
    );
  if (dev.bootstrap?.some((b) => !isLoopbackLiteral(b.host) || !isPort(b.port)))
    throw new Error('invalid-argument: --dev-mocks refuses a non-loopback swarm bootstrap');
}

/** Checked at runtime whatever the static type says (the fence must not trust the caller). */
function isLoopbackLiteral(host: string): boolean {
  return host === '127.0.0.1';
}

function isPort(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

export interface DevMockOptions {
  readonly hub: LoopbackPayHub;
  /** Names the dev identity (the worker passes a random label per run). */
  readonly label: string;
}

/** The providers plus the engine itself (tests read its `spent()` / `windows()`). */
export interface DevMockProviders extends WorkerProviders {
  readonly engine: DevEngine;
}

export function devMockProviders(o: DevMockOptions): DevMockProviders {
  const engine = devEngine(`worker:${o.label}`);
  return {
    engine,
    seederEngine: engine,
    pay: (range, seeder, policy) => engine.pay(range, seeder, policy),
    // A dev identity is new every run (nothing is recorded for it): mid-run tails only.
    payOwed: (_sid, range, seeder, policy) => engine.pay(range, seeder, policy),
    viewerMints: engine.config.acceptedMints,
    payWiring: {
      protocol: (link) => o.hub.endpoint(link),
      hello: () =>
        devHello(engine, { satsPerBlock: DEV_PRICE, split: { seeder: 50, creator: 50 } }),
    },
    pubkey: engine.config.ownPubkey,
    creditBlocks: DEFAULT_WINDOW_BLOCKS,
    loopbackOnly: true,
  };
}
