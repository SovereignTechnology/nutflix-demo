/**
 * Test support (not a suite): a fake of lane N1's side of the NUT-13 seam
 * (`@sovit/core` `wallet/recovery-api.ts`), injected as `HostOptions.recoveryCore` /
 * `RecoveryServiceOptions.core` so the desktop side is tested without N1's code.
 *
 *   phrases   the real BIP-39 conversions (`@scure/bip39`, English), so indices, words and
 *             checksums behave as core's will; `generate` is scriptable; `toSeed` returns a
 *             `FakeSeed` that records which entropy it came from (never a real BIP-39 seed).
 *   seedOption  records the seed material the money plane passed to its connections (the real
 *             `CashuMintConnections` of today ignores the unknown key).
 *   seeded    the `FakeSeededWallet` of the most recent material whose seed is not wiped — what
 *             N1's `CashuWallet.seeded` will be for a plane opened with it.
 *
 * The seeded wallet is scripted per test: reissue plans and results per mint, and restore
 * reports per phrase (keyed by the seed's entropy hex).
 */
import { entropyToMnemonic, generateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import type { MintUrl, Sats } from '@sovit/core';
import type { wallet as walletMod } from '@sovit/core';

import type { RecoveryCore } from '../../recovery/core.js';

export class FakeRecoveryPhraseError extends Error {
  override readonly name = 'RecoveryPhraseError';
  constructor(readonly problem: walletMod.RecoveryPhraseProblem) {
    super(`recovery phrase refused: ${problem}`);
  }
}

export class FakeSeed implements walletMod.RecoverySeed {
  wiped = false;
  constructor(readonly entropyHex: string) {}
  wipe(): void {
    this.wiped = true;
  }
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class FakePhrases implements walletMod.RecoveryPhrases {
  /** The next `generate()` results (then random). */
  readonly queue: Uint8Array[] = [];
  readonly generated: Uint8Array[] = [];
  readonly seeds: FakeSeed[] = [];

  generate(): walletMod.RecoveryEntropy {
    const e = this.queue.shift() ?? mnemonicToEntropy(generateMnemonic(wordlist, 128), wordlist);
    const copy = new Uint8Array(e);
    this.generated.push(new Uint8Array(copy));
    return copy as walletMod.RecoveryEntropy;
  }

  toIndices(entropy: walletMod.RecoveryEntropy): readonly number[] {
    if (entropy.byteLength !== 16) throw new FakeRecoveryPhraseError('length');
    return entropyToMnemonic(entropy, wordlist)
      .split(' ')
      .map((w) => wordlist.indexOf(w));
  }

  fromIndices(indices: readonly number[]): walletMod.RecoveryEntropy {
    if (indices.length !== 12) throw new FakeRecoveryPhraseError('length');
    const words = indices.map((i) => wordlist[i]);
    if (words.some((w) => w === undefined)) throw new FakeRecoveryPhraseError('word');
    try {
      return mnemonicToEntropy(words.join(' '), wordlist) as walletMod.RecoveryEntropy;
    } catch {
      throw new FakeRecoveryPhraseError('checksum');
    }
  }

  fromWords(words: readonly string[]): walletMod.RecoveryEntropy {
    return this.fromIndices(words.map((w) => wordlist.indexOf(w.normalize('NFKD').toLowerCase())));
  }

  toSeed(entropy: walletMod.RecoveryEntropy): Promise<walletMod.RecoverySeed> {
    if (entropy.byteLength !== 16 || entropy.every((b) => b === 0))
      return Promise.reject(new FakeRecoveryPhraseError('length'));
    const s = new FakeSeed(hex(entropy));
    this.seeds.push(s);
    return Promise.resolve(s);
  }
}

export interface RestoreCall {
  readonly entropyHex: string;
  readonly mints: readonly MintUrl[];
  /** Was the seed still unwiped while the restore ran? */
  readonly liveDuringRestore: boolean;
}

export class FakeSeededWallet implements walletMod.SeededWallet {
  /** Per mint: the plan `reissuePlan` answers (absent = throws `unreachable`). */
  readonly plans = new Map<MintUrl, { inputs: number; feeSats: number }>();
  /** Per mint: `reissue` throws instead. */
  readonly failReissue = new Set<MintUrl>();
  /** Per phrase (entropy hex): what `restoreFromSeed` reports per mint. */
  readonly restores = new Map<
    string,
    Partial<Record<MintUrl, { outcome: walletMod.RestoreOutcome; restoredSats: number }>>
  >();
  /** Phrases whose restore throws. */
  readonly failRestore = new Set<string>();
  readonly reissued: walletMod.ReissuePlan[] = [];
  readonly restoreCalls: RestoreCall[] = [];
  /** Balances the plan reads (set by the test to mirror the wallet). */
  readonly balances = new Map<MintUrl, number>();

  reissuePlan(mint: MintUrl): Promise<walletMod.ReissuePlan> {
    const p = this.plans.get(mint);
    if (p === undefined) return Promise.reject(new Error('unreachable: no answer'));
    return Promise.resolve({
      mint,
      amount: (this.balances.get(mint) ?? 0) as Sats,
      inputs: p.inputs,
      feeSats: p.feeSats as Sats,
    });
  }

  reissue(plan: walletMod.ReissuePlan): Promise<walletMod.ReissueResult> {
    if (this.failReissue.has(plan.mint)) return Promise.reject(new Error('backend-down: mint'));
    this.reissued.push(plan);
    return Promise.resolve({
      mint: plan.mint,
      reissued: (plan.amount - plan.feeSats) as Sats,
      feeSats: plan.feeSats,
    });
  }

  async restoreFromSeed(
    seed: walletMod.RecoverySeed,
    mints: readonly MintUrl[],
    onProgress?: (p: walletMod.RestoreProgress) => void,
  ): Promise<readonly walletMod.RestoreReport[]> {
    const s = seed as FakeSeed;
    this.restoreCalls.push({
      entropyHex: s.entropyHex,
      mints: [...mints],
      liveDuringRestore: !s.wiped,
    });
    if (this.failRestore.has(s.entropyHex)) throw new Error('backend-down: restore failed');
    const script = this.restores.get(s.entropyHex) ?? {};
    const out: walletMod.RestoreReport[] = [];
    for (const mint of mints) {
      onProgress?.({ mint, keysetsDone: 0, keysets: 2 });
      await Promise.resolve();
      onProgress?.({ mint, keysetsDone: 2, keysets: 2 });
      const r = script[mint] ?? { outcome: 'nothing' as const, restoredSats: 0 };
      out.push({ mint, outcome: r.outcome, restoredSats: r.restoredSats as Sats });
    }
    return out;
  }
}

/** The fake core: phrases + seed option + seeded view, with what the plane handed it. */
export class FakeRecoveryCore implements RecoveryCore {
  readonly phrases = new FakePhrases();
  readonly wallet = new FakeSeededWallet();
  /** Every seed material a money plane opened with. */
  readonly materials: walletMod.SeedMaterial[] = [];
  /** `false`: the "wallet" did not take the seed (a renamed core option). */
  takesSeed = true;

  seedOption(seed: walletMod.SeedMaterial): object {
    this.materials.push(seed);
    return { seed };
  }

  seeded(): walletMod.SeededWallet | undefined {
    const last = this.materials.at(-1);
    return this.takesSeed && last !== undefined && !last.seed.wiped ? this.wallet : undefined;
  }
}

/** The words of an index list (tests only: the canary looks for these). */
export function wordsOf(indices: readonly number[]): string[] {
  return indices.map((i) => wordlist[i] ?? '?');
}

export { hex as entropyHexOf, wordlist };
