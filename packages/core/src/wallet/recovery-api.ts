/**
 * ADR 0016 (issue #3, Cameron 2026-09-25): the NUT-13 recovery phrase — the seam between core
 * (lane N1: phrase, seed, counters, deterministic outputs, restore, reissue) and the desktop
 * (lane N2: storage, relay copy, prompt window, Settings, wiring). Types and constants only;
 * nothing here derives, stores or logs a secret.
 *
 * One phrase per device (ADR 0016 D3): a device derives only from its own phrase, from counter
 * 0 up; phrases of other devices (from their relay copies, D2) or typed in are used only to
 * restore. Frozen for the fan-out: a lane that needs a change writes
 * docs/contract-requests/<LANE>.md instead of editing this file.
 */
import type { MintUrl, Sats } from '../contracts/index.js';

/** BIP-39 entropy: exactly 16 bytes (12 English words). Only core's `seed.ts` makes one. */
export type RecoveryEntropy = Uint8Array & { readonly __recoveryEntropy: true };

/** Why a typed or stored phrase was refused. Never carries a word. */
export type RecoveryPhraseProblem = 'length' | 'word' | 'checksum';

/** The 64-byte BIP-39 seed (empty passphrase), held in secure memory by core. */
export interface RecoverySeed {
  /** Zero the seed; core refuses to derive from it afterwards. Idempotent. */
  wipe(): void;
  readonly wiped: boolean;
}

/** Phrase operations (core `wallet/seed.ts`, a locked file). */
export interface RecoveryPhrases {
  /** New entropy from the platform CSPRNG (via the BIP-39 library). */
  generate(): RecoveryEntropy;
  /** The 12 word indices, 0..2047 in the BIP-39 English list — what the prompt window shows. */
  toIndices(entropy: RecoveryEntropy): readonly number[];
  /** Throws a `RecoveryPhraseError` naming the problem only. */
  fromIndices(indices: readonly number[]): RecoveryEntropy;
  /** English words, NFKD-normalised and lower-cased; throws a `RecoveryPhraseError`. */
  fromWords(words: readonly string[]): RecoveryEntropy;
  toSeed(entropy: RecoveryEntropy): Promise<RecoverySeed>;
}

/**
 * Counter state for one identity on one device (desktop: `<userData>/wallet/counters-<pubkey>.json`,
 * 0600). Holds no secret.
 */
export interface CounterState {
  readonly v: 1;
  /** Keyset id -> the first counter not yet leased (a crash burns at most one lease). */
  readonly next: Readonly<Record<string, number>>;
  /** Keyset id -> every output below this counter is known published to NIP-60. */
  readonly published: Readonly<Record<string, number>>;
}

/** Durable counter storage, provided by the shell. `save` resolves only once it is on disk. */
export interface CounterStore {
  /** `null`: no state (first use, or lost — core then probes before deriving). */
  load(): Promise<CounterState | null>;
  save(state: CounterState): Promise<void>;
}

/**
 * What core needs to derive deterministic outputs: `new CashuMintConnections({ request, seed })`
 * takes it, and every `CashuWallet` over those connections then exposes `seeded`.
 */
export interface SeedMaterial {
  readonly seed: RecoverySeed;
  readonly counters: CounterStore;
}

/** Swap everything held at a mint into seeded outputs (ADR 0016 D5); the fee is shown first. */
export interface ReissuePlan {
  readonly mint: MintUrl;
  readonly amount: Sats;
  readonly inputs: number;
  readonly feeSats: Sats;
}

export interface ReissueResult {
  readonly mint: MintUrl;
  readonly reissued: Sats;
  readonly feeSats: Sats;
}

export type RestoreOutcome = 'restored' | 'nothing' | 'unsupported' | 'unreachable' | 'refused';

export interface RestoreReport {
  readonly mint: MintUrl;
  readonly outcome: RestoreOutcome;
  readonly restoredSats: Sats;
}

export interface RestoreProgress {
  readonly mint: MintUrl;
  readonly keysetsDone: number;
  readonly keysets: number;
}

/** `CashuWallet.seeded` when its connections carry `SeedMaterial` (lane N1 implements). */
export interface SeededWallet {
  reissuePlan(mint: MintUrl): Promise<ReissuePlan>;
  /** Refused if the holdings changed since the plan (the user confirmed that fee). */
  reissue(plan: ReissuePlan): Promise<ReissueResult>;
  /**
   * Scan `seed` from counter 0 at each mint (NUT-09, three empty batches of 100, NUT-12 DLEQ
   * required where supported, NUT-07 filter) and add what is unspent and not already held.
   * `seed` may be another device's phrase: nothing is derived from it afterwards.
   */
  restoreFromSeed(
    seed: RecoverySeed,
    mints: readonly MintUrl[],
    onProgress?: (p: RestoreProgress) => void,
  ): Promise<readonly RestoreReport[]>;
}

/** The relay copy (ADR 0016 D2): kind 30078, `d` = prefix + a random device id, NIP-44 to self. */
export const RECOVERY_RELAY_KIND = 30078;
export const RECOVERY_D_PREFIX = 'nutflix/nut13/';

/** The relay copy's plaintext (before NIP-44). `entropy` is 32 lower-case hex characters. */
export interface RecoveryRelayCopy {
  readonly v: 1;
  readonly entropy: string;
  readonly created: number;
}
