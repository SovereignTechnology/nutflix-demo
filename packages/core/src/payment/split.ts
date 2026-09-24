/**
 * The per-PAY money arithmetic both sides of `pay/1` share (contracts v5, ADR 0007 as
 * specified by ADR 0010). The viewer builds a PAY with these functions and the seeder
 * verifies it with the SAME functions, so "exact amounts, computed identically on both
 * sides" (SECURITY.md invariant 2) is true by construction rather than by agreement.
 *
 * Integers only: sats, percentages and the carry (hundredths of a sat scaled by the
 * percentage) are all safe integers, and every function refuses anything else. Nothing here
 * is cryptography.
 */
import type { PricePolicy } from '../contracts/manifest.js';
import { DEFAULT_MIN_PAY_SATS } from '../contracts/manifest.js';

/** The carry is `units mod 100`, so it always lies in `[0, CARRY_MODULUS)`. */
export const CARRY_MODULUS = 100;

/**
 * Upper bound on one PAY's `amount`, in sats. Far above any real PAY (a 64 KiB block at
 * this price would make a gigabyte cost ~16 BTC) and low enough that `amount × 100 + 99`
 * stays a safe integer, so no step below can lose precision.
 */
export const MAX_PAY_SATS = 2 ** 40;

export interface PaySplit {
  readonly seederSats: number;
  readonly creatorSats: number;
  /** Carry for the NEXT PAY on this channel × core, if this one is accepted. */
  readonly carryOut: number;
}

/** True for an integer split `{seeder, creator}` in [0, 100] summing to exactly 100. */
export function isValidSplit(split: unknown): split is PricePolicy['split'] {
  if (typeof split !== 'object' || split === null) return false;
  const { seeder, creator } = split as Record<string, unknown>;
  return (
    Number.isInteger(seeder) &&
    Number.isInteger(creator) &&
    (seeder as number) >= 0 &&
    (creator as number) >= 0 &&
    (seeder as number) + (creator as number) === 100
  );
}

/** True for an integer carry in `[0, 99]`. */
export function isValidCarry(carry: unknown): carry is number {
  return Number.isInteger(carry) && (carry as number) >= 0 && (carry as number) < CARRY_MODULUS;
}

/**
 * ADR 0007 (a):
 *
 *     units       = amount × c + carryIn
 *     creatorSats = floor(units / 100),  carryOut = units mod 100
 *     seederSats  = amount − creatorSats
 *
 * Throws `RangeError` on a non-integer / negative / oversized amount, an invalid split or an
 * out-of-range carry — callers on the verify path check shapes first and never let it throw.
 */
export function splitPay(amount: number, split: PricePolicy['split'], carryIn: number): PaySplit {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_PAY_SATS)
    throw new RangeError('splitPay: amount must be an integer in [0, 2^40]');
  if (!isValidSplit(split)) throw new RangeError('splitPay: split must be integers summing to 100');
  if (!isValidCarry(carryIn)) throw new RangeError('splitPay: carry must be an integer in [0, 99]');
  const units = amount * split.creator + carryIn;
  const creatorSats = Math.floor(units / CARRY_MODULUS);
  return {
    seederSats: amount - creatorSats,
    creatorSats,
    carryOut: units % CARRY_MODULUS,
  };
}

/**
 * Run `splitPay` over a sequence of accepted PAY amounts from `carryIn` (default 0). The
 * telescoping property ADR 0007 relies on: the creator total is
 * `floor((Σ amounts × c + carryIn) / 100)`, the carry is what is left over.
 */
export function splitSequence(
  amounts: readonly number[],
  split: PricePolicy['split'],
  carryIn = 0,
): { readonly splits: readonly PaySplit[]; readonly carryOut: number } {
  const splits: PaySplit[] = [];
  let carry = carryIn;
  for (const a of amounts) {
    const s = splitPay(a, split, carry);
    splits.push(s);
    carry = s.carryOut;
  }
  return { splits, carryOut: carry };
}

/** The policy's minimum PAY in sats (`DEFAULT_MIN_PAY_SATS` when the policy sets none). */
export function minPaySats(policy: Pick<PricePolicy, 'minPaySats'>): number {
  return policy.minPaySats ?? DEFAULT_MIN_PAY_SATS;
}

/**
 * The unpaid window a peer downloading under `policy` must be allowed (ADR 0007): big enough
 * for one minimum PAY, never below the configured window. A `satsPerBlock` of 0 (a free
 * video) needs no more than the configured window.
 */
export function effectiveWindowBlocks(
  windowBlocks: number,
  policy: Pick<PricePolicy, 'minPaySats' | 'satsPerBlock'>,
): number {
  const price = policy.satsPerBlock;
  if (!(price > 0)) return windowBlocks;
  return Math.max(windowBlocks, Math.ceil(minPaySats(policy) / price));
}
