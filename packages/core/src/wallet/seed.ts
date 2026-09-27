/**
 * The NUT-13 recovery phrase and this device's counters (ADR 0016; issue #3). A LOCKED file
 * (SECURITY.md §locked): it imports only `@scure/bip39` (ADR 0016 D4, Cameron 2026-09-25) and
 * `sodium-universal`, plus the seam's types (`recovery-api.ts`).
 *
 *   - **The phrase** (`recoveryPhrases`): 12 English BIP-39 words over 16 bytes of entropy, made
 *     by the library's CSPRNG. The words leave core only as indices 0..2047 (`toIndices`); a
 *     typed phrase comes back through `fromWords` / `fromIndices`, whose error names the problem
 *     (`length`, `word`, `checksum`) and never a word.
 *   - **The seed** (`toSeed`): `mnemonicToSeed(words, '')` — the empty BIP-39 passphrase other
 *     Cashu wallets use — copied into `sodium_malloc` memory at once, the library's copy zeroed.
 *     `seedBytes` lends that buffer BY REFERENCE to the wallet (cashu-ts holds `bip39seed` so);
 *     after `wipe()` it is zero and `seedBytes` refuses it, and so does every derivation
 *     (`spend.ts` `seedGuardedOutputs`).
 *   - **The counters** (`DurableCounterSource`): cashu-ts's `CounterSource`, keyed by keyset id
 *     across every mint (two mints announcing one id still never share a counter), persisted
 *     through the shell's `CounterStore` AHEAD of use: before a counter is handed out, a lease
 *     reaching `COUNTER_LEASE` past it is on disk, so a crash burns at most one lease and never
 *     hands a counter out twice. A keyset the stored state does not know is PROBED first (NUT-09:
 *     anything this seed already signed there is skipped), whether the state is new or lost.
 *
 * Residuals (ADR 0016): the phrase strings the library builds (`entropyToMnemonic`) and the
 * words typed into the prompt window are JS strings, which cannot be wiped; cashu-ts's own
 * derivation intermediates (noble's BIP-32 and HMAC state) are the library's to clear.
 *
 * No cryptography is implemented here: BIP-39 is `@scure/bip39`, secure memory is libsodium.
 * Nothing here logs; errors carry a code, never a word, a seed or a counter's secret.
 */
import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import sodium from 'sodium-universal';

import type {
  CounterState,
  CounterStore,
  RecoveryEntropy,
  RecoveryPhraseProblem,
  RecoveryPhrases,
  RecoverySeed,
} from './recovery-api.js';

// ---------------------------------------------------------------------------------------
// Secure memory
// ---------------------------------------------------------------------------------------

function secureCopy(src: Uint8Array): Uint8Array {
  const b = sodium.sodium_malloc(src.length);
  b.set(src);
  return b;
}

function zero(b: Uint8Array): void {
  if (b.length > 0) sodium.sodium_memzero(b);
}

// ---------------------------------------------------------------------------------------
// The phrase
// ---------------------------------------------------------------------------------------

/** 12 words = 128 bits of entropy (NUT-13; ADR 0016 D1). */
export const RECOVERY_WORDS = 12;
const ENTROPY_BYTES = 16;
const ENTROPY_BITS = 128;
const WORDLIST_SIZE = 2048;

/** A typed or stored phrase was refused. `problem` is all it says: never a word. */
export class RecoveryPhraseError extends Error {
  override readonly name = 'RecoveryPhraseError';
  constructor(readonly problem: RecoveryPhraseProblem) {
    super(`recovery-phrase: ${problem}`);
  }
}

/** A seed core did not make, or one already wiped, was handed to a derivation. */
export class RecoverySeedError extends Error {
  override readonly name = 'RecoverySeedError';
  constructor(readonly problem: 'wiped' | 'foreign') {
    super(`recovery-seed: ${problem}`);
  }
}

/** word → index, for checking typed words one by one (the library's own error quotes a word). */
const INDEX = new Map<string, number>(wordlist.map((w, i) => [w, i]));

function checkEntropy(e: Uint8Array): void {
  if (!(e instanceof Uint8Array) || e.length !== ENTROPY_BYTES)
    throw new RecoveryPhraseError('length');
}

/**
 * Entropy about to be USED (shown, or turned into a seed): refused when it is all zeros. No CSPRNG
 * makes that (2^-128), but a wiped buffer is exactly that, and its phrase ("abandon … about") is
 * public: outputs derived from it are ecash anyone can restore. OR-folded, no early exit.
 */
function checkLive(e: Uint8Array): void {
  checkEntropy(e);
  let acc = 0;
  for (const b of e) acc |= b;
  if (acc === 0) throw new RecoverySeedError('wiped');
}

/** Entropy in secure memory; the library's copy is zeroed. */
function adopt(raw: Uint8Array): RecoveryEntropy {
  try {
    checkEntropy(raw);
    return secureCopy(raw) as RecoveryEntropy;
  } finally {
    zero(raw);
  }
}

/** Words known to be in the list → entropy; a bad checksum is the only way this can fail. */
function wordsToEntropy(words: readonly string[]): RecoveryEntropy {
  let raw: Uint8Array;
  try {
    raw = mnemonicToEntropy(words.join(' '), wordlist);
  } catch {
    throw new RecoveryPhraseError('checksum');
  }
  return adopt(raw);
}

function generate(): RecoveryEntropy {
  return adopt(mnemonicToEntropy(generateMnemonic(wordlist, ENTROPY_BITS), wordlist));
}

function toIndices(entropy: RecoveryEntropy): readonly number[] {
  checkLive(entropy);
  return entropyToMnemonic(entropy, wordlist)
    .split(' ')
    .map((w) => {
      const i = INDEX.get(w);
      if (i === undefined) throw new RecoveryPhraseError('word'); // unreachable: the list's own words
      return i;
    });
}

function fromIndices(indices: readonly number[]): RecoveryEntropy {
  if (!Array.isArray(indices) || indices.length !== RECOVERY_WORDS)
    throw new RecoveryPhraseError('length');
  const words: string[] = [];
  for (const i of indices as readonly unknown[]) {
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= WORDLIST_SIZE)
      throw new RecoveryPhraseError('word');
    const w = wordlist[i];
    if (w === undefined) throw new RecoveryPhraseError('word');
    words.push(w);
  }
  return wordsToEntropy(words);
}

function fromWords(words: readonly string[]): RecoveryEntropy {
  if (!Array.isArray(words) || words.length !== RECOVERY_WORDS)
    throw new RecoveryPhraseError('length');
  const norm: string[] = [];
  for (const w of words as readonly unknown[]) {
    if (typeof w !== 'string') throw new RecoveryPhraseError('word');
    const n = w.normalize('NFKD').trim().toLowerCase();
    if (!INDEX.has(n)) throw new RecoveryPhraseError('word');
    norm.push(n);
  }
  return wordsToEntropy(norm);
}

/** Bytes of each seed core made (by reference: the one buffer cashu-ts is lent). */
const SEEDS = new WeakMap<RecoverySeed, Uint8Array>();

class SecureSeed implements RecoverySeed {
  #wiped = false;

  constructor(bytes: Uint8Array) {
    SEEDS.set(this, bytes);
  }

  get wiped(): boolean {
    return this.#wiped;
  }

  wipe(): void {
    if (this.#wiped) return;
    this.#wiped = true;
    const b = SEEDS.get(this);
    if (b !== undefined) zero(b);
  }
}

async function toSeed(entropy: RecoveryEntropy): Promise<RecoverySeed> {
  checkLive(entropy);
  const raw = await mnemonicToSeed(entropyToMnemonic(entropy, wordlist), '');
  try {
    return new SecureSeed(secureCopy(raw));
  } finally {
    zero(raw);
  }
}

/** ADR 0016 §1: the phrase operations (`recovery-api.ts` `RecoveryPhrases`). */
export const recoveryPhrases: RecoveryPhrases = {
  generate,
  toIndices,
  fromIndices,
  fromWords,
  toSeed,
};

/** Zero entropy once it is sealed or shown. Idempotent. */
export function wipeEntropy(entropy: RecoveryEntropy): void {
  if (entropy instanceof Uint8Array) zero(entropy);
}

/**
 * Entropy read back from where the shell keeps it (the sealed file, the relay copy — ADR 0016
 * D2): exactly 16 bytes, copied into secure memory. The caller's buffer is left as it is (the
 * caller zeroes its own plaintext). Throws `RecoveryPhraseError('length')` for anything else.
 * Outside `RecoveryPhrases` only because that seam is frozen (docs/contract-requests/N1-nut13-core.md).
 */
export function entropyFromBytes(bytes: Uint8Array): RecoveryEntropy {
  checkEntropy(bytes);
  return secureCopy(bytes) as RecoveryEntropy;
}

const ENTROPY_HEX = /^[0-9a-f]{32}$/;

/**
 * `RecoveryRelayCopy.entropy` (32 lower-case hex characters) back to entropy in secure memory.
 * Throws `RecoveryPhraseError('length')` for any other string. The hex string itself is a JS
 * string and cannot be wiped (ADR 0016 residual).
 */
export function entropyFromHex(hex: string): RecoveryEntropy {
  if (typeof hex !== 'string' || !ENTROPY_HEX.test(hex)) throw new RecoveryPhraseError('length');
  const b = sodium.sodium_malloc(ENTROPY_BYTES);
  for (let i = 0; i < ENTROPY_BYTES; i++) b[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return b as RecoveryEntropy;
}

/** Entropy as `RecoveryRelayCopy.entropy`: 32 lower-case hex characters (an unwipeable string). */
export function entropyToHex(entropy: RecoveryEntropy): string {
  checkEntropy(entropy);
  let s = '';
  for (const byte of entropy) s += byte.toString(16).padStart(2, '0');
  return s;
}

/**
 * The seed's bytes, BY REFERENCE, for the wallet's derivations only (not exported from the
 * package). Throws for a seed core did not make or one already wiped: derivation from a zeroed
 * buffer would make ecash anyone can restore.
 */
export function seedBytes(seed: RecoverySeed): Uint8Array {
  const b = SEEDS.get(seed);
  if (b === undefined) throw new RecoverySeedError('foreign');
  if (seed.wiped) throw new RecoverySeedError('wiped');
  return b;
}

/** Whether two live seeds are the same phrase (constant-time); false if either is not live. */
export function sameSeed(a: RecoverySeed, b: RecoverySeed | undefined): boolean {
  if (b === undefined) return false;
  const x = SEEDS.get(a);
  const y = SEEDS.get(b);
  if (x === undefined || y === undefined || a.wiped || b.wiped) return false;
  return x.length === y.length && sodium.sodium_memcmp(x, y);
}

/** cashu-ts wallets built with a seed (`CashuMintConnections`) → that seed. */
const SEEDED = new WeakMap<object, RecoverySeed>();

/** Record that `wallet` (a cashu-ts wallet) derives NUT-13 outputs from `seed`. */
export function markSeeded(wallet: object, seed: RecoverySeed): void {
  SEEDED.set(wallet, seed);
}

/**
 * The seed `wallet` was built with, if any — so the `Spender` notices a `MintConnections` wrapper
 * that hands out seeded wallets but dropped `seeding` (it would otherwise make random outputs
 * without a word, and `close` would wipe nothing).
 */
export function seededWith(wallet: object): RecoverySeed | undefined {
  return SEEDED.get(wallet);
}

// ---------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------

/** How far ahead of use a keyset's counter is persisted (ADR 0016 §3: a crash burns ≤ this). */
export const COUNTER_LEASE = 32;

/**
 * Every counter stays below 2^31: a v1 (`00…`) keyset derives at the HARDENED BIP-32 index
 * `counter'` (NUT-13), and one phrase per device runs the whole space from 0 (ADR 0016 D3).
 */
export const COUNTER_LIMIT = 0x80000000;

/** A range cashu-ts may use: `[start, start + count)` (its `CounterRange`). */
export interface CounterRange {
  readonly start: number;
  readonly count: number;
}

/**
 * What a mint says this seed already signed under `keysetId` from `start` on: the first counter
 * past every signed one (≥ `start`), or `undefined` when this mint does not serve the keyset.
 * Rejects when the mint cannot be asked (the reservation is then refused).
 */
export type CounterProbe = (keysetId: string, start: number) => Promise<number | undefined>;

/** A counters file that is not a `CounterState` — refused rather than guessed at. */
export class CounterStateError extends Error {
  override readonly name = 'CounterStateError';
  constructor(readonly problem: 'malformed' | 'closed' | 'exhausted' | 'argument' | 'unprobed') {
    super(`counters: ${problem}`);
  }
}

const KEYSET_ID = /^[0-9a-f]{2,128}$/;

function isCounter(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= COUNTER_LIMIT;
}

function isCounterMap(x: unknown): x is Readonly<Record<string, number>> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  return Object.keys(x).every(
    (k) => KEYSET_ID.test(k) && isCounter((x as Record<string, unknown>)[k]),
  );
}

/** A stored `CounterState`: version 1, hex keyset ids, counters in `[0, 2^31]`. */
export function isCounterState(x: unknown): x is CounterState {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return s['v'] === 1 && isCounterMap(s['next']) && isCounterMap(s['published']);
}

interface Loaded {
  /** Keyset → the first counter not handed out in this process. */
  readonly cursor: Map<string, number>;
  /** Keyset → what the store holds as `next` (never below `cursor`). */
  readonly leased: Map<string, number>;
  /** Keyset → every output below it is known published (never above `cursor`). */
  readonly published: Map<string, number>;
  /** Keysets whose counters the store knew, or a probe settled, in this process. */
  readonly safe: Set<string>;
  /** `published` moved since the last save. */
  dirty: boolean;
}

/** A keyset range not yet known published: restored at startup (ADR 0016 §3). */
export interface UnpublishedRange {
  readonly keysetId: string;
  readonly from: number;
  readonly to: number;
}

/**
 * cashu-ts `CounterSource` (structurally: this file imports nothing from cashu-ts), durable
 * through a `CounterStore`. Every call runs one at a time, in call order, so a save and the
 * hand-out it covers are never interleaved with another reservation.
 */
export class DurableCounterSource {
  private state: Promise<Loaded> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private isClosed = false;
  private readonly probes = new Set<CounterProbe>();
  private readonly lease: number;

  constructor(
    private readonly store: CounterStore,
    opts: { readonly lease?: number } = {},
  ) {
    const lease = opts.lease ?? COUNTER_LEASE;
    if (!Number.isSafeInteger(lease) || lease < 1 || lease > 10_000)
      throw new CounterStateError('argument');
    this.lease = lease;
  }

  /** `close()` ran: every reservation throws from now on. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** A mint's probe (its wallet loaded); returns the unregister function. */
  addProbe(probe: CounterProbe): () => void {
    this.probes.add(probe);
    return () => this.probes.delete(probe);
  }

  /** cashu-ts: reserve `n` counters (`n = 0` peeks at the cursor without moving it). */
  reserve(keysetId: string, n: number): Promise<CounterRange> {
    return this.serial(async () => {
      checkKeyset(keysetId);
      if (!Number.isSafeInteger(n) || n < 0) throw new CounterStateError('argument');
      const s = await this.usable(keysetId);
      const start = s.cursor.get(keysetId) ?? 0;
      if (n > 0) await this.handOut(s, keysetId, start, n);
      return { start, count: n };
    });
  }

  /**
   * cashu-ts: reserve the caller's range `[start, start + count)`; throws when `start` is below
   * the cursor (already handed out). Counters between the cursor and `start` are burned.
   */
  reserveAt(keysetId: string, start: number, count: number): Promise<CounterRange> {
    return this.serial(async () => {
      checkKeyset(keysetId);
      if (!isCounter(start) || !Number.isSafeInteger(count) || count < 0)
        throw new CounterStateError('argument');
      const s = await this.usable(keysetId);
      if (start < (s.cursor.get(keysetId) ?? 0)) throw new CounterStateError('argument');
      if (count > 0) await this.handOut(s, keysetId, start, count);
      else s.cursor.set(keysetId, Math.max(s.cursor.get(keysetId) ?? 0, start));
      return { start, count };
    });
  }

  /** cashu-ts: the cursor never moves back; moving it on is persisted before this resolves. */
  advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    return this.serial(async () => {
      checkKeyset(keysetId);
      if (!isCounter(minNext)) throw new CounterStateError('argument');
      if (this.isClosed) throw new CounterStateError('closed');
      const s = await this.load();
      if (minNext <= (s.cursor.get(keysetId) ?? 0)) return;
      if (minNext > (s.leased.get(keysetId) ?? 0)) {
        const leased = new Map(s.leased).set(keysetId, minNext);
        for (const [k, v] of await this.save(s, leased)) s.leased.set(k, v);
      }
      s.cursor.set(keysetId, minNext);
    });
  }

  /** cashu-ts: keyset → the next counter this process hands out. */
  snapshot(): Promise<Record<string, number>> {
    return this.serial(async () => Object.fromEntries((await this.load()).cursor));
  }

  /**
   * Every output handed out so far is published (the caller checked: no operation running,
   * nothing journaled, the store's outbox empty). Kept in memory; written with the next lease
   * or by `flush` — a stale watermark only restores more at startup.
   */
  markPublished(): Promise<void> {
    return this.serial(async () => {
      const s = await this.load();
      for (const [k, c] of s.cursor) {
        if ((s.published.get(k) ?? 0) < c) {
          s.published.set(k, c);
          s.dirty = true;
        }
      }
    });
  }

  /** `[published, next)` per keyset, as the store holds them: what a startup restore scans. */
  unpublished(): Promise<readonly UnpublishedRange[]> {
    return this.serial(async () => {
      const s = await this.load();
      const out: UnpublishedRange[] = [];
      for (const [keysetId, to] of s.leased) {
        const from = s.published.get(keysetId) ?? 0;
        if (from < to) out.push({ keysetId, from, to });
      }
      return out;
    });
  }

  /** Refuse every reservation from now on (the wallet is closing). Idempotent. */
  close(): void {
    this.isClosed = true;
  }

  /** Write a moved `published` watermark (works after `close`). */
  flush(): Promise<void> {
    return this.serial(async () => {
      if (this.state === null) return;
      const s = await this.load();
      if (s.dirty) for (const [k, v] of await this.save(s, s.leased)) s.leased.set(k, v);
    });
  }

  // ---- internals ------------------------------------------------------------------------

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The stored state, read once (a failed read is retried by the next call). */
  private load(): Promise<Loaded> {
    if (this.state === null) {
      const p = this.store.load().then((st): Loaded => {
        if (st !== null && !isCounterState(st)) throw new CounterStateError('malformed');
        const cursor = new Map<string, number>();
        const leased = new Map<string, number>();
        const published = new Map<string, number>();
        for (const [k, v] of Object.entries(st?.next ?? {})) {
          cursor.set(k, v);
          leased.set(k, v);
        }
        for (const [k, v] of Object.entries(st?.published ?? {})) {
          const next = leased.get(k);
          if (next !== undefined) published.set(k, Math.min(v, next));
        }
        return { cursor, leased, published, safe: new Set(leased.keys()), dirty: false };
      });
      this.state = p;
      p.catch(() => {
        if (this.state === p) this.state = null;
      });
    }
    return this.state;
  }

  /** The state, once `keysetId` may be derived from: open, and known or probed. */
  private async usable(keysetId: string): Promise<Loaded> {
    if (this.isClosed) throw new CounterStateError('closed');
    const s = await this.load();
    if (s.safe.has(keysetId)) return s;
    // A keyset the stored state does not know: this seed may have signed there before (the
    // counters file was lost, or never written). Ask every mint that serves it.
    const from = s.cursor.get(keysetId) ?? 0;
    const answers = await Promise.all([...this.probes].map((p) => p(keysetId, from)));
    const known = answers.filter((a): a is number => a !== undefined);
    if (known.length === 0 || !known.every(isCounter)) throw new CounterStateError('unprobed');
    const past = Math.max(from, ...known);
    // Again after the probe's await: `close()` may have run meanwhile.
    if (this.closed) throw new CounterStateError('closed');
    if (past > from) s.cursor.set(keysetId, past);
    s.safe.add(keysetId);
    return s;
  }

  /** Hand out `[start, start + n)`: the lease covering it is on disk before the cursor moves. */
  private async handOut(s: Loaded, keysetId: string, start: number, n: number): Promise<void> {
    const end = start + n;
    if (end > COUNTER_LIMIT) throw new CounterStateError('exhausted');
    if (end > (s.leased.get(keysetId) ?? 0)) {
      const leased = new Map(s.leased).set(keysetId, Math.min(end + this.lease, COUNTER_LIMIT));
      for (const [k, v] of await this.save(s, leased)) s.leased.set(k, v);
    }
    s.cursor.set(keysetId, end);
  }

  /**
   * Write `leased` (and the watermark). A stored lease is never moved back: the store is re-read
   * and each keyset keeps the higher of the two — a source closed for a reopened wallet may still
   * flush after its successor leased further (`CashuMintConnections` keeps ONE live source per
   * store; this covers the one that was closed). Returns what was written.
   */
  private async save(
    s: Loaded,
    leased: ReadonlyMap<string, number>,
  ): Promise<ReadonlyMap<string, number>> {
    const next = new Map(leased);
    const onDisk = await this.store.load();
    if (onDisk !== null && isCounterState(onDisk))
      for (const [k, v] of Object.entries(onDisk.next)) if (v > (next.get(k) ?? 0)) next.set(k, v);
    const published: Record<string, number> = {};
    for (const [k, v] of s.published) published[k] = Math.min(v, next.get(k) ?? 0);
    await this.store.save({ v: 1, next: Object.fromEntries(next), published });
    s.dirty = false;
    return next;
  }
}

function checkKeyset(keysetId: string): void {
  if (typeof keysetId !== 'string' || !KEYSET_ID.test(keysetId))
    throw new CounterStateError('argument');
}
