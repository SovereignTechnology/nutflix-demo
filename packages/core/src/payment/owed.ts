/**
 * What a seeder's engine still counts, per core, for one peer — the `pay/1` `OWED` report and
 * `ACK.outstanding` (contracts v6 amendment, ADR 0018 amendment 2026-09-26). Plain accounting over
 * the engine's own block ranges: nothing here is cryptography, and nothing logs.
 */
import { MAX_OWED_BLOCKS, MAX_OWED_RANGES } from '../contracts/index.js';
import type { CoreKeyHex, NostrPubkey, OwedRange } from '../contracts/index.js';

/** One core's unpaid blocks, as canonical ranges (ascending, disjoint, not adjacent). */
export interface OwedCore {
  readonly core: CoreKeyHex;
  readonly ranges: readonly OwedRange[];
}

/** Caps on a whole report (every core together). */
export interface OwedLimits {
  readonly maxRanges: number;
  readonly maxBlocks: number;
}

/** The `OWED` caps: what one connection's report may name in total. */
export const OWED_LIMITS: OwedLimits = { maxRanges: MAX_OWED_RANGES, maxBlocks: MAX_OWED_BLOCKS };

/**
 * The seeder side's view of what a peer still owes. Both engines implement it (the real one and
 * the mock); a seeder needs it to send `OWED` and `ACK.outstanding`.
 */
export interface UnpaidLedger {
  /** Blocks of `core` counted for `peer` and not paid (0 when none). Never throws. */
  outstandingOn(peer: NostrPubkey, core: CoreKeyHex): number;
  /**
   * The blocks counted for `peer` and not paid, per core: cores in the order they were first
   * counted for `peer` (a `rebind` keeps the target's order and appends the source's new cores),
   * each core's ranges ascending. The whole report is bounded by `limits` (default and ceiling:
   * `OWED_LIMITS`); what is past them is left out, oldest kept, and a range crossing the block cap
   * is cut short. Cores with nothing unpaid are absent. Never throws.
   */
  unpaid(peer: NostrPubkey, limits?: OwedLimits): readonly OwedCore[];
}

/** A limit as given, if it is a positive safe integer — never above `cap`; anything else is 0. */
function clampLimit(n: unknown, cap: number): number {
  return Number.isSafeInteger(n) && (n as number) > 0 ? Math.min(n as number, cap) : 0;
}

/**
 * Bound a per-core listing of unpaid ranges (oldest core first, ranges ascending and canonical) to
 * `limits`, clamped to `OWED_LIMITS` so the result always fits the `OWED` grammar.
 */
export function boundOwed(
  cores: Iterable<readonly [CoreKeyHex, readonly OwedRange[]]>,
  limits: OwedLimits = OWED_LIMITS,
): OwedCore[] {
  const maxRanges = clampLimit(limits.maxRanges, MAX_OWED_RANGES);
  const maxBlocks = clampLimit(limits.maxBlocks, MAX_OWED_BLOCKS);
  const out: OwedCore[] = [];
  let ranges = 0;
  let blocks = 0;
  for (const [core, list] of cores) {
    if (ranges >= maxRanges || blocks >= maxBlocks) break;
    const taken: OwedRange[] = [];
    for (const [from, to] of list) {
      if (ranges >= maxRanges || blocks >= maxBlocks) break;
      const len = Math.min(to - from + 1, maxBlocks - blocks);
      taken.push([from, from + len - 1]);
      ranges++;
      blocks += len;
    }
    if (taken.length > 0) out.push({ core, ranges: taken });
  }
  return out;
}
