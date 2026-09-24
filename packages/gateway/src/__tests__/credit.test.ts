/**
 * The shared credit pool's PRESSURE signal (security review F5 batching, F37): a batching payer
 * must learn the moment a download needs credit and none is free, or a pool full of short
 * unpaid runs would stall. (The pool's grant / settle rules are covered by the desktop worker's
 * credit tests, which run against this same class.)
 */
import { describe, expect, it } from 'vitest';

import { CreditPool } from '../upstream/credit.js';

describe('CreditPool pressure', () => {
  it('is signalled when a tryAcquire is refused, or an acquire has to queue', () => {
    const pool = new CreditPool(2);
    let signals = 0;
    const off = pool.onPressure(() => {
      signals++;
    });
    expect(pool.tryAcquire('c', 0)).toBe(true);
    expect(pool.pressured).toBe(false);
    expect(pool.tryAcquire('c', 1)).toBe(true);
    expect(pool.pressured).toBe(true); // full
    expect(signals).toBe(0);
    expect(pool.tryAcquire('c', 2)).toBe(false);
    expect(signals).toBe(1);
    const w = pool.acquire('c', 3);
    expect(signals).toBe(2);
    expect(pool.waiting).toBe(1);
    pool.settle('c', 0); // the waiter gets the unit
    expect(pool.holds('c', 3)).toBe(true);
    w.cancel();
    pool.settle('c', 1);
    pool.settle('c', 3);
    expect(pool.pressured).toBe(false);
    off();
    pool.tryAcquire('c', 4);
    pool.tryAcquire('c', 5);
    pool.tryAcquire('c', 6);
    expect(signals).toBe(2);
  });

  it('a throwing pressure listener does not break the pool', () => {
    const pool = new CreditPool(1);
    pool.onPressure(() => {
      throw new Error('listener bug');
    });
    pool.tryAcquire('c', 0);
    expect(pool.tryAcquire('c', 1)).toBe(false);
    expect(pool.size).toBe(1);
  });
});
