/**
 * A set of block indexes kept as sorted, disjoint, non-adjacent inclusive intervals. Viewers
 * download mostly front to back, so a peer's "sent" and "paid" sets are a handful of intervals
 * however long the video — a gateway can hold thousands of peers without a Set entry per block.
 * Plain data structure; nothing here is cryptography.
 */
export class RangeSet {
  /** [from, to] pairs, sorted by `from`, never overlapping or touching. */
  private readonly spans: [number, number][] = [];
  private count = 0;

  /** Number of distinct indexes in the set. */
  get size(): number {
    return this.count;
  }

  /** Add `[from, to]`; returns how many indexes were NEW. */
  add(from: number, to: number): number {
    if (!(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from))
      throw new RangeError('RangeSet.add: expected 0 <= from <= to, integers');
    let lo = from;
    let hi = to;
    let i = 0;
    // Skip spans that end before `lo - 1` (not touching).
    for (let span = this.spans[i]; span !== undefined && span[1] < lo - 1; span = this.spans[++i]);
    let removed = 0;
    let absorbed = 0;
    for (let span = this.spans[i]; span !== undefined; span = this.spans[i + removed]) {
      const [s, e] = span;
      if (s > hi + 1) break;
      absorbed += e - s + 1;
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
      removed++;
    }
    this.spans.splice(i, removed, [lo, hi]);
    const added = hi - lo + 1 - absorbed;
    this.count += added;
    return added;
  }

  /** True when every index in `[from, to]` is in the set. */
  hasAll(from: number, to: number): boolean {
    for (const [s, e] of this.spans) {
      if (s > from) return false;
      if (e >= from) return e >= to;
    }
    return false;
  }

  /** True when any index in `[from, to]` is in the set. */
  hasAny(from: number, to: number): boolean {
    for (const [s, e] of this.spans) {
      if (s > to) return false;
      if (e >= from) return true;
    }
    return false;
  }

  /**
   * The indexes of this set that are not in `other`, as intervals: ascending, disjoint and not
   * adjacent (the canonical form a `pay/1` `OWED` carries). Neither set changes.
   */
  difference(other: RangeSet): readonly (readonly [number, number])[] {
    const out: (readonly [number, number])[] = [];
    const b = other.spans;
    let j = 0;
    for (const [start, end] of this.spans) {
      // Skip the spans of `other` that end before this one starts (both lists ascend).
      for (let span = b[j]; span !== undefined && span[1] < start; span = b[++j]);
      let s = start;
      for (let k = j; s <= end; k++) {
        const span = b[k];
        if (span === undefined || span[0] > end) {
          out.push([s, end]);
          break;
        }
        if (span[0] > s) out.push([s, span[0] - 1]);
        s = Math.max(s, span[1] + 1);
      }
    }
    return out;
  }

  /** Union `other` into this set. */
  merge(other: RangeSet): void {
    for (const [s, e] of other.spans) this.add(s, e);
  }

  /** The intervals, for tests and snapshots. */
  intervals(): readonly (readonly [number, number])[] {
    return this.spans.map(([s, e]) => [s, e] as const);
  }
}
