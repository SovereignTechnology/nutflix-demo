/**
 * ADR 0016 (issue #3): what the desktop needs from core's NUT-13 code (lane N1) — the phrase
 * operations, seeded mint connections and a wallet's seeded view — typed by the frozen seam
 * (`@sovit/core` `wallet/recovery-api.ts`) and taken BY INJECTION, so the desktop side builds and
 * is tested without N1's implementation.
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────────┐
 * │ WIRING POINT — `recoveryCore()` below is the ONE place the orchestrator fills when lane │
 * │ N1 merges. Until then it returns `undefined`: the desktop has no recovery phrase (status │
 * │ `unavailable`, every flow refused `payments-unavailable`) and derives nothing.           │
 * │ With N1 (names as the seam's docs give them; adjust to N1's exports):                   │
 * │                                                                                         │
 * │   return {                                                                              │
 * │     phrases: new walletMod.RecoveryPhrases(),          // core wallet/seed.ts (locked)   │
 * │     connections: ({ request, seed }) =>                                                 │
 * │       new walletMod.CashuMintConnections({ request, seed }),                            │
 * │     seeded: (w) => w.seeded,                           // CashuWallet.seeded            │
 * │   };                                                                                    │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Tests inject fakes through `HostOptions.recoveryCore` (`__tests__/support/fake-recovery.ts`).
 */
import type { MintUrl } from '@sovit/core';
import type { wallet as walletMod } from '@sovit/core';

/** One mint's request function, as `CashuMintConnections` takes it. */
export type MintRequest = NonNullable<
  NonNullable<ConstructorParameters<typeof walletMod.CashuMintConnections>[0]>['request']
>;

export interface RecoveryCore {
  /** Generate, index, decode and seed phrases (core `wallet/seed.ts`, a locked file). */
  readonly phrases: walletMod.RecoveryPhrases;
  /** Mint connections whose wallets derive from `seed` and draw counters from `seed.counters`. */
  connections(o: {
    readonly request: MintRequest;
    readonly seed: walletMod.SeedMaterial;
  }): walletMod.CashuMintConnections;
  /** A wallet's seeded view (`CashuWallet.seeded`); `undefined` over unseeded connections. */
  seeded(wallet: walletMod.CashuWallet): walletMod.SeededWallet | undefined;
}

/** WIRING POINT (see the box above): lane N1's implementation, or `undefined` before it. */
export function recoveryCore(): RecoveryCore | undefined {
  return undefined;
}

/** Keyset ids the counters file may hold: v1 (`00` + 14 hex) and v2 (`01` + 64 hex). */
export const KEYSET_ID = /^(?:00[0-9a-f]{14}|01[0-9a-f]{64})$/;

const ENTROPY_HEX = /^[0-9a-f]{32}$/;

/**
 * 32 lower-case hex characters → the 16-byte `RecoveryEntropy` the seam's other methods take.
 *
 * The seam has no "from raw entropy" method (docs/contract-requests/N2-nut13-desktop.md, item 1),
 * yet both the sealed file and the relay copy hold the entropy as hex (`RecoveryRelayCopy`). This
 * is the ONE place the desktop brands bytes as entropy, after checking there are exactly 16; core
 * still validates every phrase it is handed (`toSeed`, `toIndices`).
 */
export function entropyFromHex(hex: string): walletMod.RecoveryEntropy {
  if (!ENTROPY_HEX.test(hex)) throw new Error('invalid-argument: not 16 bytes of entropy');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out as walletMod.RecoveryEntropy;
}

/** The entropy as 32 lower-case hex characters (what the sealed file and the relay copy hold). */
export function entropyHex(entropy: Uint8Array): string {
  if (entropy.byteLength !== 16) throw new Error('invalid-argument: not 16 bytes of entropy');
  let s = '';
  for (const b of entropy) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Mints a restore scans, in order, without duplicates. */
export function uniqueMints(list: readonly MintUrl[]): MintUrl[] {
  return [...new Set(list)];
}
