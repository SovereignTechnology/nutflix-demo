/**
 * RangeSet (per-peer sent / paid blocks) against a naive `Set<number>` model, and SeenSecrets'
 * bound and persistence hook.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { RangeSet } from '../range-set.js';
import { SeenSecrets } from '../seen.js';

describe('RangeSet', () => {
  it('matches a Set<number> model for any sequence of adds (size, hasAll, hasAny, merge) and stays normalised', () => {
    const op = fc.tuple(fc.nat(60), fc.nat(8)).map(([from, len]) => [from, from + len] as const);
    fc.assert(
      fc.property(
        fc.array(op, { maxLength: 30 }),
        fc.array(op, { maxLength: 10 }),
        fc.array(op, { maxLength: 20 }),
        (adds, others, probes) => {
          const rs = new RangeSet();
          const model = new Set<number>();
          for (const [a, b] of adds) {
            const before = model.size;
            for (let i = a; i <= b; i++) model.add(i);
            expect(rs.add(a, b)).toBe(model.size - before);
          }
          const other = new RangeSet();
          for (const [a, b] of others) {
            other.add(a, b);
            for (let i = a; i <= b; i++) model.add(i);
          }
          rs.merge(other);
          expect(rs.size).toBe(model.size);
          for (const [a, b] of probes) {
            let all = true;
            let any = false;
            for (let i = a; i <= b; i++) {
              if (model.has(i)) any = true;
              else all = false;
            }
            expect(rs.hasAll(a, b)).toBe(all);
            expect(rs.hasAny(a, b)).toBe(any);
          }
          // Sorted, disjoint, never touching.
          const iv = rs.intervals();
          for (let i = 1; i < iv.length; i++) expect(iv[i]![0]).toBeGreaterThan(iv[i - 1]![1] + 1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses bad input', () => {
    const rs = new RangeSet();
    for (const [a, b] of [
      [-1, 0],
      [3, 2],
      [0.5, 1],
      [0, Number.NaN],
    ] as const)
      expect(() => rs.add(a, b)).toThrow(RangeError);
  });
});

describe('SeenSecrets', () => {
  it('remembers, persists new secrets, restores without persisting, and evicts the oldest past capacity', () => {
    const persisted: string[][] = [];
    const s = new SeenSecrets({ capacity: 3, persist: (x) => persisted.push([...x]) });
    s.restore(['a']);
    expect(persisted).toEqual([]);
    s.add(['b', 'c']);
    expect(persisted).toEqual([['b', 'c']]);
    expect(['a', 'b', 'c'].every((x) => s.has(x))).toBe(true);
    s.add(['d']);
    expect(s.size).toBe(3);
    expect(s.has('a')).toBe(false); // the oldest went
    expect(s.has('d')).toBe(true);
  });

  // Stage 2 pre-push review (sharp edges): capacity 0 evicted each secret as it was added — a
  // configuration that silently turned the local double-spend check off.
  it('refuses a capacity that would disable it (0, negative, fractional, NaN)', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN])
      expect(() => new SeenSecrets({ capacity }), String(capacity)).toThrow(RangeError);
  });
});
