/**
 * `payment/split.ts` — the per-PAY arithmetic both sides of `pay/1` share (contracts v5,
 * ADR 0007 as specified by ADR 0010). Properties first: the telescoping creator total that
 * justifies the carry, equivalence with ADR 0005 at carry 0, and the size / window rules.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { DEFAULT_MIN_PAY_SATS } from '../../contracts/index.js';
import {
  CARRY_MODULUS,
  MAX_PAY_SATS,
  effectiveWindowBlocks,
  isValidCarry,
  isValidSplit,
  minPaySats,
  splitPay,
  splitSequence,
} from '../split.js';

const splitArb = fc.integer({ min: 0, max: 100 }).map((seeder) => ({
  seeder,
  creator: 100 - seeder,
}));
const carryArb = fc.integer({ min: 0, max: CARRY_MODULUS - 1 });
const amountArb = fc.integer({ min: 0, max: 10_000 });

describe('splitPay (ADR 0007 a)', () => {
  it('conserves the amount, keeps both shares non-negative, and keeps the carry in [0, 99]', () => {
    fc.assert(
      fc.property(amountArb, splitArb, carryArb, (amount, split, carry) => {
        const s = splitPay(amount, split, carry);
        expect(s.seederSats + s.creatorSats).toBe(amount);
        expect(s.seederSats).toBeGreaterThanOrEqual(0);
        expect(s.creatorSats).toBeGreaterThanOrEqual(0);
        expect(isValidCarry(s.carryOut)).toBe(true);
        // Exactly the formula.
        const units = amount * split.creator + carry;
        expect(s.creatorSats).toBe(Math.floor(units / 100));
        expect(s.carryOut).toBe(units % 100);
      }),
      { numRuns: 500 },
    );
  });

  it('at carry 0 it IS ADR 0005 Q1: seederSats = ceil(amount × s / 100), creator the remainder', () => {
    fc.assert(
      fc.property(amountArb, splitArb, (amount, split) => {
        const s = splitPay(amount, split, 0);
        expect(s.seederSats).toBe(Math.ceil((amount * split.seeder) / 100));
        expect(s.creatorSats).toBe(amount - Math.ceil((amount * split.seeder) / 100));
      }),
      { numRuns: 300 },
    );
  });

  it('telescopes: over any PAY sequence the creator receives floor((ΣT × c + carryIn) / 100) — the full share less under 1 sat, however small each PAY', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 1, maxLength: 60 }),
        splitArb,
        carryArb,
        (amounts, split, carryIn) => {
          const { splits, carryOut } = splitSequence(amounts, split, carryIn);
          const total = amounts.reduce((a, b) => a + b, 0);
          const creator = splits.reduce((a, s) => a + s.creatorSats, 0);
          expect(creator).toBe(Math.floor((total * split.creator + carryIn) / 100));
          expect(carryOut).toBe((total * split.creator + carryIn) % 100);
          // …so from carry 0 the creator is short by strictly less than one sat.
          if (carryIn === 0) expect((total * split.creator) / 100 - creator).toBeLessThan(1);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('fixes the starvation ADR 0005’s erratum found: 4-sat PAYs at a 90/10 split pay the creator 1 sat every 2.5 PAYs instead of never', () => {
    const split = { seeder: 90, creator: 10 };
    const bare = Array.from({ length: 10 }, () => splitPay(4, split, 0).creatorSats);
    expect(bare.every((c) => c === 0)).toBe(true); // the v3 rule: nothing, forever
    const { splits } = splitSequence(
      Array.from({ length: 10 }, () => 4),
      split,
    );
    expect(splits.reduce((a, s) => a + s.creatorSats, 0)).toBe(4); // floor(40 × 10 / 100)
  });

  it('refuses what it cannot compute exactly: non-integer / negative / oversized amounts, bad splits, bad carries', () => {
    const ok = { seeder: 50, creator: 50 };
    for (const amount of [-1, 1.5, Number.NaN, Infinity, MAX_PAY_SATS + 1])
      expect(() => splitPay(amount, ok, 0)).toThrow(RangeError);
    for (const split of [
      { seeder: 50, creator: 49 },
      { seeder: 101, creator: -1 },
      { seeder: 50.5, creator: 49.5 },
    ])
      expect(() => splitPay(10, split, 0)).toThrow(RangeError);
    for (const carry of [-1, 100, 0.5, Number.NaN])
      expect(() => splitPay(10, ok, carry)).toThrow(RangeError);
    expect(splitPay(MAX_PAY_SATS, ok, 99)).toMatchObject({ seederSats: MAX_PAY_SATS / 2 });
    expect(isValidSplit(null)).toBe(false);
    expect(isValidSplit({ seeder: 0, creator: 100 })).toBe(true);
  });
});

describe('minimum PAY (a batching target, ADR 0010) and the effective window (ADR 0007 a)', () => {
  it('minPaySats defaults to DEFAULT_MIN_PAY_SATS (10)', () => {
    expect(DEFAULT_MIN_PAY_SATS).toBe(10);
    expect(minPaySats({})).toBe(10);
    expect(minPaySats({ minPaySats: 3 as never })).toBe(3);
  });

  it('the effective window fits one minimum PAY and never shrinks below the configured window', () => {
    expect(effectiveWindowBlocks(4, { satsPerBlock: 1 as never })).toBe(10);
    expect(effectiveWindowBlocks(4, { satsPerBlock: 2 as never })).toBe(5);
    expect(effectiveWindowBlocks(4, { satsPerBlock: 3 as never })).toBe(4);
    expect(effectiveWindowBlocks(4, { satsPerBlock: 1 as never, minPaySats: 25 as never })).toBe(
      25,
    );
    expect(effectiveWindowBlocks(4, { satsPerBlock: 0 as never })).toBe(4);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 1, max: 200 }),
        (window, price, min) => {
          const w = effectiveWindowBlocks(window, {
            satsPerBlock: price as never,
            minPaySats: min as never,
          });
          expect(w).toBeGreaterThanOrEqual(window);
          expect(w * price).toBeGreaterThanOrEqual(min); // one minimum PAY always fits
          // …and it is the smallest window that does (or the configured one).
          if (w > window) expect((w - 1) * price).toBeLessThan(min);
        },
      ),
    );
  });
});
