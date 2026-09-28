/**
 * Test support (not a suite): a fake of lane N1's side of the NUT-13 seam
 * (`@sovit/core` `wallet/recovery-api.ts`), injected as `RecoveryServiceOptions.core` so the
 * service's flows are unit-tested with a STUB money plane: scripted reissue plans and restore
 * reports, failures on demand.
 *
 * Never with a real `MoneyPlane` (integration fix 2): core's `CashuMintConnections` refuses a
 * `FakeSeed` (a seed core did not make), so such a plane never opens. The host and money-plane
 * tests run core's real code instead (`real-recovery.ts`).
 *
 *   phrases   the real BIP-39 conversions (`@scure/bip39`, English), so indices, words and
 *             checksums behave as core's will; `generate` is scriptable; `toSeed` returns a
 *             `FakeSeed` that records which entropy it came from (never a real BIP-39 seed).
 *   seedOption  records the seed material it was handed.
 *   seeded    the `FakeSeededWallet` of the most recent material whose seed is not wiped.
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
  /** W8a: where each mint's scan was asked to continue from (core's `RestoreOptions.resume`). */
  readonly resume?: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** One scripted call's answer at a mint (W8a): a report, with `resume` while unfinished. */
export interface ScriptedStep {
  readonly outcome: walletMod.RestoreOutcome;
  readonly restoredSats: number;
  readonly resume?: Readonly<Record<string, number>>;
}

export class FakeSeededWallet implements walletMod.CoreSeededWallet {
  /** Per mint: the plan `reissuePlan` answers (absent = throws `unreachable`). */
  readonly plans = new Map<MintUrl, { inputs: number; feeSats: number }>();
  /** Per mint: `reissue` throws instead. */
  readonly failReissue = new Set<MintUrl>();
  /** Per phrase (entropy hex): what `restoreFromSeed` reports per mint. */
  readonly restores = new Map<
    string,
    Partial<Record<MintUrl, { outcome: walletMod.RestoreOutcome; restoredSats: number }>>
  >();
  /**
   * W8a: per phrase (entropy hex) and mint, what successive calls answer, in order (each call takes
   * the next; once they run out, `restores` answers).
   */
  readonly steps = new Map<string, Partial<Record<MintUrl, ScriptedStep[]>>>();
  /** Phrases whose restore throws. */
  readonly failRestore = new Set<string>();
  readonly reissued: walletMod.ReissuePlan[] = [];
  /** Every mint `reissuePlan` was asked about, in order. */
  readonly planned: MintUrl[] = [];
  readonly restoreCalls: RestoreCall[] = [];
  /** Balances the plan reads (set by the test to mirror the wallet). */
  readonly balances = new Map<MintUrl, number>();

  reissuePlan(mint: MintUrl): Promise<walletMod.ReissuePlan> {
    this.planned.push(mint);
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
    opts?: walletMod.RestoreOptions,
  ): Promise<readonly walletMod.RestoreDetail[]> {
    const s = seed as FakeSeed;
    const resume =
      opts?.resume === undefined
        ? undefined
        : Object.fromEntries([...opts.resume].map(([m, r]) => [m, { ...r }]));
    this.restoreCalls.push({
      entropyHex: s.entropyHex,
      mints: [...mints],
      liveDuringRestore: !s.wiped,
      ...(resume === undefined ? {} : { resume }),
    });
    if (this.failRestore.has(s.entropyHex)) throw new Error('backend-down: restore failed');
    const script = this.restores.get(s.entropyHex) ?? {};
    const steps = this.steps.get(s.entropyHex) ?? {};
    const out: walletMod.RestoreDetail[] = [];
    for (const mint of mints) {
      onProgress?.({ mint, keysetsDone: 0, keysets: 2 });
      await Promise.resolve();
      onProgress?.({ mint, keysetsDone: 2, keysets: 2 });
      const step = steps[mint]?.shift();
      const r = step ?? script[mint] ?? { outcome: 'nothing' as const, restoredSats: 0 };
      out.push({
        mint,
        outcome: r.outcome,
        restoredSats: r.restoredSats as Sats,
        ...(step?.resume === undefined ? {} : { resume: step.resume }),
      });
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

  seeded(): walletMod.CoreSeededWallet | undefined {
    const last = this.materials.at(-1);
    return this.takesSeed && last !== undefined && !last.seed.wiped ? this.wallet : undefined;
  }

  /** W8a: a stand-in phrase tag (tests only; the real one is core's keyed BLAKE2b). */
  phraseTag(seed: walletMod.RecoverySeed): string {
    const hex = (seed as FakeSeed).entropyHex;
    return `fake-tag-${hex.slice(16)}${hex.slice(0, 16)}`;
  }
}

/** The words of an index list (tests only: the canary looks for these). */
export function wordsOf(indices: readonly number[]): string[] {
  return indices.map((i) => wordlist[i] ?? '?');
}

export { hex as entropyHexOf, wordlist };
