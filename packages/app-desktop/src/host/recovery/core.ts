/**
 * ADR 0016 (issue #3): what the desktop needs from core's NUT-13 code (lane N1) — the phrase
 * operations, the option that seeds mint connections, and a wallet's seeded view — typed by the
 * frozen seam (`@sovit/core` `wallet/recovery-api.ts`) and taken BY INJECTION, so the desktop
 * side builds and is tested without N1's implementation.
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────────┐
 * │ WIRING POINT — `recoveryCore()` below is the ONE place lane N1's code is wired (filled │
 * │ at the merge, 2026-09-27). A host injecting `undefined` has no recovery phrase (status │
 * │ `unavailable`, every flow refused `payments-unavailable`) and derives nothing.         │
 * │                                                                                        │
 * │ `seedOption` has core's real option type (`SeedConnectionsOption`, a type-only mention │
 * │ of the class), so tsc checks the key. The money plane keeps its ONE connections        │
 * │ constructor (money.ts, pinned by mint-transport.test.ts, which tells a construction    │
 * │ from a type) and spreads this option into it; it hands `CashuWallet` that connections  │
 * │ instance itself, so `CashuWallet.seeded` reads the seed there. A seed core refuses     │
 * │ (not one it made, or wiped) fails the plane's open — payments stay unavailable, never  │
 * │ random outputs under a phrase; an option the connections ignore is caught at open      │
 * │ (`MoneyPlane`: logged, the seed wiped, status `unreadable`) — never a silent           │
 * │ "covered".                                                                             │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * The host and money-plane tests run core's real code (`__tests__/support/real-recovery.ts`, a
 * pass-through spy); the service's unit tests, whose plane is a stub, inject fakes
 * (`__tests__/support/fake-recovery.ts`) — whose seed core would refuse (integration fix 2).
 */
import type { MintUrl } from '@sovit/core';
import { wallet as walletMod } from '@sovit/core';

/** The mint connections' option that carries the seed (core `CashuMintConnections`). */
export type SeedConnectionsOption = Pick<
  NonNullable<ConstructorParameters<typeof walletMod.CashuMintConnections>[0]>,
  'seed'
>;

export interface RecoveryCore {
  /** Generate, index, decode and seed phrases (core `wallet/seed.ts`, a locked file). */
  readonly phrases: walletMod.RecoveryPhrases;
  /**
   * The mint connections' constructor option that carries `seed` (the seam: the connections
   * take `{ request, seed }`). Spread into the money plane's one constructor call; every wallet
   * over those connections then derives from the seed and draws counters from `seed.counters`.
   */
  seedOption(seed: walletMod.SeedMaterial): SeedConnectionsOption;
  /** A wallet's seeded view (`CashuWallet.seeded`); `undefined` over unseeded connections. */
  seeded(wallet: walletMod.CashuWallet): walletMod.SeededWallet | undefined;
}

/** WIRING POINT (see the box above): lane N1's implementation, filled at the merge (2026-09-27). */
export function recoveryCore(): RecoveryCore | undefined {
  return {
    phrases: walletMod.recoveryPhrases, // core wallet/seed.ts (locked)
    seedOption: (seed) => ({ seed }), // CashuMintConnections({ request, seed })
    seeded: (w) => w.seeded, // CashuWallet.seeded
  };
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

/** Same bytes? (Dedupes phrases without turning either into a string.) */
export function sameEntropy(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Mints a restore scans, in order, without duplicates. */
export function uniqueMints(list: readonly MintUrl[]): MintUrl[] {
  return [...new Set(list)];
}
