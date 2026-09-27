/**
 * The seeder's unpaid ledger (contracts v6 amendment, ADR 0018 amendment 2026-09-26): what the
 * engine reports in `OWED` and `ACK.outstanding`, and the rule that makes the report useful — a
 * PAY for blocks a previous connection left unpaid is accepted on the new connection (carry 0,
 * the core's terms) and clears them.
 *
 * `RangeSet.difference` against a `Set<number>` model; `boundOwed` at its caps; the real engine
 * against the mock's reference model; the reconnect-and-pay path with real ecash.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';

import { MAX_OWED_BLOCKS, MAX_OWED_RANGES } from '../../contracts/index.js';
import type { CoreKeyHex, NostrPubkey, OwedRange, PricePolicy } from '../../contracts/index.js';
import { MockPaymentEngine } from '../../mocks/mock-payment-engine.js';
import type { RealPaymentEngine } from '../engine.js';
import { OWED_LIMITS, boundOwed } from '../owed.js';
import { RangeSet } from '../range-set.js';
import {
  CORE_A,
  CORE_B,
  NOISE_ID,
  POLICY,
  SEEDER_INFO,
  VIEWER,
  WIDE_WINDOW,
  getPair,
  getSeederEngine,
  policyWith,
  range,
  sats,
  upload,
} from './provider.mjs';

// Round-8 review (test integrity): the stated reason. The seam returns the REAL engine over real
// ecash (`provider.mts`): the property run against the mock's model and the reconnect-and-pay
// tests mint and DLEQ-verify real proofs through in-process TestMints in pure JS (~30 ms per proof,
// see cheating-modes.test.ts). Alone the file takes under a second (measured 2026-09-27: 0.5 s for
// the reconnect test); under the whole suite's load real curve work runs many times slower, so it
// keeps the budget engine.test.ts gives the same seam. No run count or assertion depends on it.
vi.setConfig({ testTimeout: 120_000 });

const CORE_C = 'c4'.repeat(32) as CoreKeyHex;

/** A canonical listing of `set`: ascending, disjoint, not adjacent. */
function canonical(ranges: readonly (readonly [number, number])[]): boolean {
  let prev = -2;
  for (const [a, b] of ranges) {
    if (a > b || a <= prev + 1) return false;
    prev = b;
  }
  return true;
}

function members(ranges: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) out.push(i);
  return out;
}

describe('RangeSet.difference', () => {
  it('matches a Set<number> model, is canonical, and changes neither set', () => {
    const op = fc.tuple(fc.nat(80), fc.nat(9)).map(([from, len]) => [from, from + len] as const);
    fc.assert(
      fc.property(
        fc.array(op, { maxLength: 25 }),
        fc.array(op, { maxLength: 25 }),
        (adds, subs) => {
          const a = new RangeSet();
          const b = new RangeSet();
          const model = new Set<number>();
          for (const [x, y] of adds) {
            a.add(x, y);
            for (let i = x; i <= y; i++) model.add(i);
          }
          for (const [x, y] of subs) {
            b.add(x, y);
            for (let i = x; i <= y; i++) model.delete(i);
          }
          const before = [a.intervals(), b.intervals()];
          const diff = a.difference(b);
          expect(canonical(diff)).toBe(true);
          expect(members(diff)).toEqual([...model].sort((p, q) => p - q));
          expect([a.intervals(), b.intervals()]).toEqual(before);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('edges: empty sets, a hole in the middle, other covering all', () => {
    const a = new RangeSet();
    const b = new RangeSet();
    expect(a.difference(b)).toEqual([]);
    a.add(0, 9);
    expect(a.difference(b)).toEqual([[0, 9]]);
    b.add(3, 4);
    expect(a.difference(b)).toEqual([
      [0, 2],
      [5, 9],
    ]);
    b.add(0, 20);
    expect(a.difference(b)).toEqual([]);
  });
});

describe('boundOwed (the OWED caps over a whole report)', () => {
  const r = (n: number, from = 0): OwedRange[] =>
    Array.from({ length: n }, (_, i) => [from + 2 * i, from + 2 * i] as const);

  it('keeps cores in order and ranges ascending; stops at the range cap, oldest first', () => {
    const out = boundOwed(
      [
        [CORE_A, r(200)],
        [CORE_B, r(100)],
        [CORE_C, r(5)],
      ],
      OWED_LIMITS,
    );
    expect(out.map((c) => c.core)).toEqual([CORE_A, CORE_B]);
    expect(out[0]!.ranges).toHaveLength(200);
    expect(out[1]!.ranges).toHaveLength(MAX_OWED_RANGES - 200);
    expect(out[1]!.ranges[0]).toEqual([0, 0]);
  });

  it('cuts the range that crosses the block cap short, and reports nothing past it', () => {
    const out = boundOwed([
      [CORE_A, [[10, 1009]]], // 1000 blocks
      [
        CORE_B,
        [
          [0, 99],
          [200, 299],
        ],
      ],
    ]);
    expect(out).toEqual([
      { core: CORE_A, ranges: [[10, 1009]] },
      { core: CORE_B, ranges: [[0, MAX_OWED_BLOCKS - 1000 - 1]] },
    ]);
  });

  // Written (in the interrupted lane's wip commit) as "junk limits report nothing". That is the
  // unsafe direction: a short report lets the viewer think it owes less and overrun the window.
  // Junk limits now fall back to the caps (which keep any report inside the OWED grammar).
  it('limits never raise the caps, a smaller one is kept, and a junk one falls back to the cap (never a shorter report)', () => {
    const big = boundOwed([[CORE_A, [[0, 5000]]]], { maxRanges: 10_000, maxBlocks: 10_000 });
    expect(big).toEqual([{ core: CORE_A, ranges: [[0, MAX_OWED_BLOCKS - 1]] }]);
    expect(boundOwed([[CORE_A, [[0, 9]]]], { maxRanges: 1, maxBlocks: 4 })).toEqual([
      { core: CORE_A, ranges: [[0, 3]] },
    ]);
    for (const bad of [
      { maxRanges: Number.NaN, maxBlocks: 10 },
      { maxRanges: 10, maxBlocks: -1 },
      { maxRanges: 0, maxBlocks: 10 },
      { maxRanges: 1.5, maxBlocks: 10 },
      { maxRanges: '3', maxBlocks: 10 } as never,
    ])
      expect(boundOwed([[CORE_A, [[0, 3]]]], bad)).toEqual([{ core: CORE_A, ranges: [[0, 3]] }]);
    expect(
      boundOwed([[CORE_A, [[0, 5000]]]], { maxRanges: Number.NaN, maxBlocks: Number.NaN }),
    ).toEqual([{ core: CORE_A, ranges: [[0, MAX_OWED_BLOCKS - 1]] }]);
    expect(boundOwed([[CORE_A, []]])).toEqual([]);
  });
});

describe('the real engine’s ledger against the mock’s reference model', () => {
  it('any sequence of uploads on three cores, two ids and a rebind: the same OWED report and the same per-core outstanding', () => {
    const cores = [CORE_A, CORE_B, CORE_C] as const;
    const step = fc.tuple(fc.nat(2), fc.nat(1), fc.nat(120));
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), fc.boolean(), (steps, rebind) => {
        const real = getSeederEngine({ config: { windowBlocks: 10_000 } });
        const mock = new MockPaymentEngine({ config: { windowBlocks: 10_000 } });
        const ids = [VIEWER, NOISE_ID] as const;
        for (const [c, who, block] of steps)
          for (const e of [real, mock])
            e.recordUpload(ids[who]!, range(block, block, cores[c]), POLICY);
        if (rebind) for (const e of [real, mock]) e.rebind(NOISE_ID, VIEWER);
        const r = real as RealPaymentEngine;
        for (const id of ids) {
          expect(r.unpaid(id)).toEqual(mock.unpaid(id));
          for (const core of cores)
            expect(r.outstandingOn(id, core)).toBe(mock.outstandingOn(id, core));
        }
      }),
      { numRuns: 150 },
    );
  });

  it('cores in first-counted order; an unknown peer has none; a rebind appends the provisional id’s new cores', () => {
    const e = getSeederEngine(WIDE_WINDOW) as RealPaymentEngine;
    expect(e.unpaid('00'.repeat(32) as NostrPubkey)).toEqual([]);
    expect(e.outstandingOn('00'.repeat(32) as NostrPubkey, CORE_A)).toBe(0);
    upload(e, VIEWER, 2, { core: CORE_B, from: 5 });
    upload(e, VIEWER, 3, { core: CORE_A, from: 0 });
    upload(e, NOISE_ID, 1, { core: CORE_C, from: 9 });
    upload(e, NOISE_ID, 1, { core: CORE_A, from: 7 });
    e.rebind(NOISE_ID, VIEWER);
    expect(e.unpaid(VIEWER)).toEqual([
      { core: CORE_B, ranges: [[5, 6]] },
      {
        core: CORE_A,
        ranges: [
          [0, 2],
          [7, 7],
        ],
      },
      { core: CORE_C, ranges: [[9, 9]] },
    ]);
    expect(e.outstandingOn(VIEWER, CORE_A)).toBe(4);
    expect(e.unpaid(NOISE_ID)).toEqual([]);
  });
});

describe('an owed range paid on a NEW connection (ADR 0018 amendment)', () => {
  it('blocks a closed connection left unpaid are reported, paid on the next one at the core’s terms with carry 0, and cleared', async () => {
    // 70/30 at 3 sat: a PAY moves the carry, so a stale carry would be refused (`malformed`).
    const p: PricePolicy = policyWith({
      satsPerBlock: sats(3),
      split: { seeder: 70, creator: 30 },
    });
    const e = getSeederEngine({ config: { windowBlocks: 8 } }) as RealPaymentEngine;
    const { viewer } = getPair('honest');
    // Connection 1 (bound to VIEWER): 6 blocks, blocks 0–1 paid (carry → 80), then it drops.
    upload(e, VIEWER, 6, { policy: p });
    const first = await viewer.pay(range(0, 1), SEEDER_INFO, p, { carryIn: 0 });
    expect(await e.verify(VIEWER, first, p)).toMatchObject({ ok: true });
    expect(e.unpaid(VIEWER)).toEqual([{ core: CORE_A, ranges: [[2, 5]] }]);
    expect(e.outstandingOn(VIEWER, CORE_A)).toBe(4);
    // Connection 2: the provisional id, then its HELLO binds VIEWER — a new channel, carry 0.
    e.rebind(NOISE_ID, VIEWER);
    expect(e.unpaid(VIEWER)).toEqual([{ core: CORE_A, ranges: [[2, 5]] }]);
    // Paying part of the owed range at the old carry is refused; at carry 0 it is accepted.
    const stale = await viewer.pay(range(2, 3), SEEDER_INFO, p, { carryIn: 80 });
    expect(await e.verify(VIEWER, stale, p)).toMatchObject({ ok: false, reason: 'malformed' });
    const part = await viewer.pay(range(2, 3), SEEDER_INFO, p, { carryIn: 0 });
    expect(await e.verify(VIEWER, part, p)).toMatchObject({ ok: true, blocks: 2 });
    expect(e.unpaid(VIEWER)).toEqual([{ core: CORE_A, ranges: [[4, 5]] }]);
    expect(e.outstandingOn(VIEWER, CORE_A)).toBe(2);
    // The rest, then nothing is owed; a second PAY for the same blocks is a replay.
    const carry = (2 * 3 * 30) % 100; // the carry the accepted 2-block PAY left
    const rest = await viewer.pay(range(4, 5), SEEDER_INFO, p, { carryIn: carry });
    expect(await e.verify(VIEWER, rest, p)).toMatchObject({ ok: true, blocks: 2 });
    expect(e.unpaid(VIEWER)).toEqual([]);
    expect(e.outstandingOn(VIEWER, CORE_A)).toBe(0);
    expect(e.window(VIEWER)).toMatchObject({ uploaded: 6, paid: 6, outstanding: 0 });
    const again = await viewer.pay(range(4, 5), SEEDER_INFO, p, { carryIn: (carry + 180) % 100 });
    expect(await e.verify(VIEWER, again, p)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
  });

  it('a PAY that claims blocks beyond what is owed (never sent) is refused and clears nothing', async () => {
    const e = getSeederEngine({ config: { windowBlocks: 8 } }) as RealPaymentEngine;
    upload(e, VIEWER, 3);
    e.rebind(NOISE_ID, VIEWER);
    const msg = await getPair('honest').viewer.pay(range(0, 4), SEEDER_INFO, POLICY, {
      carryIn: 0,
    });
    expect(await e.verify(VIEWER, msg, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-not-uploaded',
    });
    expect(e.unpaid(VIEWER)).toEqual([{ core: CORE_A, ranges: [[0, 2]] }]);
  });
});
