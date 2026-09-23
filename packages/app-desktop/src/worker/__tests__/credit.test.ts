import { describe, expect, it } from 'vitest';

import { CreditCancelled, CreditPool } from '../playback/credit.js';

const K = 'ab'.repeat(32);

describe('CreditPool (the seeders’ unpaid window, viewer side)', () => {
  it('refuses a limit below 1', () => {
    expect(() => new CreditPool(0)).toThrow(RangeError);
    expect(() => new CreditPool(1.5)).toThrow(RangeError);
  });

  it('never holds more than `limit` blocks', () => {
    const p = new CreditPool(4);
    for (let i = 0; i < 4; i++) expect(p.tryAcquire(K, i)).toBe(true);
    expect(p.tryAcquire(K, 4)).toBe(false);
    expect(p.size).toBe(4);
    // A block already held costs nothing more.
    expect(p.tryAcquire(K, 2)).toBe(true);
    expect(p.holds(K, 2)).toBe(true);
    expect(p.size).toBe(4);
  });

  it('serves blocking acquirers FIFO, before any lookahead', async () => {
    const p = new CreditPool(1);
    await p.acquire(K, 0).promise;
    const order: number[] = [];
    const a = p.acquire(K, 1);
    const b = p.acquire(K, 2);
    void a.promise.then(() => order.push(1));
    void b.promise.then(() => order.push(2));
    // Lookahead must yield to the queued players even once a unit is free.
    p.settle(K, 0);
    expect(p.tryAcquire(K, 9)).toBe(false);
    await a.promise;
    expect(p.holds(K, 1)).toBe(true);
    p.settle(K, 1);
    await b.promise;
    expect(order).toEqual([1, 2]);
    expect(p.waiting).toBe(0);
  });

  it('settle is idempotent and only notifies for a unit that was held', () => {
    const p = new CreditPool(2);
    let calls = 0;
    const off = p.onAvailable(() => calls++);
    p.tryAcquire(K, 5);
    p.settle(K, 5);
    p.settle(K, 5);
    p.settle(K, 6);
    expect(calls).toBe(1);
    off();
    p.tryAcquire(K, 5);
    p.settle(K, 5);
    expect(calls).toBe(1);
  });

  it('a cancelled wait rejects with CreditCancelled and holds nothing', async () => {
    const p = new CreditPool(1);
    p.tryAcquire(K, 0);
    const w = p.acquire(K, 1);
    w.cancel();
    await expect(w.promise).rejects.toBeInstanceOf(CreditCancelled);
    expect(p.holds(K, 1)).toBe(false);
    expect(p.waiting).toBe(0);
    w.cancel(); // idempotent
    p.settle(K, 0);
    expect(p.size).toBe(0);
  });

  it('a queued acquirer for a block someone else already holds is served without a unit', async () => {
    const p = new CreditPool(1);
    p.tryAcquire(K, 0);
    const w = p.acquire(K, 7);
    const other = p.acquire(K, 0); // already held → immediate
    await other.promise;
    p.settle(K, 0);
    await w.promise;
    expect(p.holds(K, 7)).toBe(true);
    expect(p.size).toBe(1);
  });

  it('keys by core AND index', () => {
    const p = new CreditPool(2);
    p.tryAcquire(K, 1);
    expect(p.holds('cd'.repeat(32), 1)).toBe(false);
  });
});
