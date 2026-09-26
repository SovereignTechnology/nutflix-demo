/**
 * The money plane's PAY/melt gate (ADR 0012 amendment 2026-09-25, lane I2-paygate), on its own:
 * a melt and a PAY build at one mint never overlap, a PAY is refused at once — never built —
 * while a melt is pending or in flight there, PAY builds take turns, the belt refuses a PAY whose
 * turn came too late, and the mark always clears. The real wallet under it is `money.test.ts`'s.
 */
import type { MintUrl } from '@sovit/core';
import { wallet as walletMod } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import { PAY_BUILD_START_BY_MS, WORKER_HOST_REQUEST_TIMEOUT_MS } from '../../ipc/deadlines.js';
import { toWireError } from '../../ipc/errors.js';
import type { GateTimers } from '../pay-melt-gate.js';
import {
  GateRefusal,
  MELT_AT_MINT,
  PAY_STILL_BUILDING,
  PAY_TOO_LATE,
  PayMeltGate,
} from '../pay-melt-gate.js';

const A = 'https://mint-a.gate.test' as MintUrl;
const B = 'https://mint-b.gate.test' as MintUrl;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A promise's outcome, readable without awaiting it. */
function observe<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const o: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (v) => {
      o.done = true;
      o.value = v;
    },
    (e: unknown) => {
      o.done = true;
      o.error = e;
    },
  );
  return o;
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Timers the test fires by hand. */
function manualTimers(): GateTimers & { readonly armed: { ms: number; fn: () => void }[] } {
  const armed: { ms: number; fn: () => void }[] = [];
  return {
    armed,
    setTimeout: (fn, ms) => {
      const h = { ms, fn };
      armed.push(h);
      return h;
    },
    clearTimeout: (h) => {
      const i = armed.indexOf(h as { ms: number; fn: () => void });
      if (i >= 0) armed.splice(i, 1);
    },
  };
}

function gate(o: { clock?: () => number } = {}) {
  let now = 0;
  const timers = manualTimers();
  const g = new PayMeltGate({ clock: o.clock ?? (() => now), timers });
  return {
    g,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const refusal = (e: unknown): string =>
  e instanceof GateRefusal ? e.message : `not a refusal: ${String(e)}`;

describe('PayMeltGate: a melt and a PAY build at one mint never overlap', () => {
  it('a melt in flight: a PAY at that mint is refused at once and never built; one at another mint is', async () => {
    const { g } = gate();
    const melting = deferred<string>();
    const melt = observe(g.melt(A, () => melting.promise));
    await tick();
    expect(g.melting(A)).toBe(true);
    let built = 0;
    const build = (): Promise<string> => {
      built++;
      return Promise.resolve('pay');
    };
    await expect(g.pay(A, g.now(), build)).rejects.toThrow(`rate-limited: ${MELT_AT_MINT}`);
    expect(built).toBe(0);
    expect(await g.pay(B, g.now(), build)).toBe('pay'); // another mint: its own gate
    expect(built).toBe(1);
    melting.resolve('paid');
    await tick();
    expect(melt).toMatchObject({ done: true, value: 'paid' });
    expect(g.melting(A)).toBe(false);
    expect(await g.pay(A, g.now(), build)).toBe('pay'); // the mark cleared
  });

  it('a PAY in flight: the melt waits for it, then runs; a PAY arriving meanwhile — or already waiting its turn — is refused at once', async () => {
    const { g } = gate();
    const order: string[] = [];
    const first = deferred<string>();
    const pay1 = observe(
      g.pay(A, g.now(), async () => {
        order.push('pay 1 starts');
        const r = await first.promise;
        order.push('pay 1 ends');
        return r;
      }),
    );
    let built2 = 0;
    const pay2 = observe(
      g.pay(A, g.now(), () => {
        built2++;
        return Promise.resolve('pay 2');
      }),
    );
    await tick();
    const melt = observe(
      g.melt(A, () => {
        order.push('melt');
        return Promise.resolve('paid');
      }),
    );
    await tick();
    // Pending: the waiting PAY is refused now, the melt has not run.
    expect(pay2.done).toBe(true);
    expect(refusal(pay2.error)).toBe(`rate-limited: ${MELT_AT_MINT}`);
    expect(built2).toBe(0);
    expect(melt.done).toBe(false);
    expect(g.melting(A)).toBe(true);
    await expect(g.pay(A, g.now(), () => Promise.resolve('pay 3'))).rejects.toBeInstanceOf(
      GateRefusal,
    );
    first.resolve('pay 1');
    await tick();
    expect(pay1).toMatchObject({ done: true, value: 'pay 1' });
    expect(melt).toMatchObject({ done: true, value: 'paid' });
    expect(order).toEqual(['pay 1 starts', 'pay 1 ends', 'melt']);
    expect(g.melting(A)).toBe(false);
  });

  it('PAY builds at one mint take turns in arrival order; mints do not wait for each other', async () => {
    const { g } = gate();
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const run = (mint: MintUrl, i: number): Promise<void> =>
      g.pay(mint, g.now(), async () => {
        order.push(`start ${String(i)}`);
        await gates[i]!.promise;
        order.push(`end ${String(i)}`);
      });
    const p0 = run(A, 0);
    const p1 = run(A, 1);
    const p2 = run(B, 2);
    await tick();
    expect(order).toEqual(['start 0', 'start 2']); // B does not wait for A
    gates[1]!.resolve(); // 1 cannot finish before it starts
    await tick();
    expect(order).toEqual(['start 0', 'start 2']);
    gates[0]!.resolve();
    gates[2]!.resolve();
    await Promise.all([p0, p1, p2]);
    expect(order).toEqual(['start 0', 'start 2', 'end 0', 'end 2', 'start 1', 'end 1']);
  });

  it('the mark clears after a melt that throws, and after one that times out', async () => {
    const { g } = gate();
    await expect(g.melt(A, () => Promise.reject(new Error('mint-error: refused')))).rejects.toThrow(
      'refused',
    );
    expect(g.melting(A)).toBe(false);
    expect(await g.pay(A, g.now(), () => Promise.resolve('after a throw'))).toBe('after a throw');
    // A melt request cut off at its timeout: core rejects "melt outcome unknown" / "melt failed".
    const cut = deferred<never>();
    const melt = observe(g.melt(A, () => cut.promise));
    await tick();
    await expect(g.pay(A, g.now(), () => Promise.resolve('x'))).rejects.toBeInstanceOf(GateRefusal);
    cut.reject(new walletMod.WalletError('mint-error', 'melt failed (NetworkError)'));
    await tick();
    expect(melt.done).toBe(true);
    expect(g.melting(A)).toBe(false);
    expect(await g.pay(A, g.now(), () => Promise.resolve('after a timeout'))).toBe(
      'after a timeout',
    );
    // Two melts at once: the mark holds until the last one settles.
    const m1 = deferred<string>();
    const m2 = deferred<string>();
    const one = g.melt(A, () => m1.promise);
    const two = g.melt(A, () => m2.promise);
    m1.resolve('one');
    expect(await one).toBe('one');
    expect(g.melting(A)).toBe(true);
    m2.reject(new Error('two failed'));
    await expect(two).rejects.toThrow('two failed');
    expect(g.melting(A)).toBe(false);
  });

  it('the belt: a PAY whose turn comes later than PAY_BUILD_START_BY_MS after it arrived is refused and never built; the next one gets the turn', async () => {
    const { g, advance } = gate();
    const slow = deferred<string>();
    const first = g.pay(A, g.now(), () => slow.promise);
    let built = 0;
    const late = observe(
      g.pay(A, g.now(), () => {
        built++;
        return Promise.resolve('late');
      }),
    );
    advance(PAY_BUILD_START_BY_MS + 1);
    const fresh = g.pay(A, g.now(), () => Promise.resolve('fresh')); // arrived just now
    slow.resolve('slow');
    expect(await first).toBe('slow');
    expect(await fresh).toBe('fresh');
    expect(late.done).toBe(true);
    expect(refusal(late.error)).toBe(`rate-limited: ${PAY_TOO_LATE}`);
    expect(built).toBe(0);
    // An arrival comes from the gate's clock only: a wall-clock number does not type-check (against
    // the monotonic default it would read as a request from the future and switch the belt off).
    // @ts-expect-error — `Date.now()` is not an `Arrival`
    const wrongClock = (): Promise<void> => g.pay(A, Date.now(), () => Promise.resolve());
    expect(typeof wrongClock).toBe('function');
    // Exactly at the limit is still in time.
    const t0 = g.now();
    advance(PAY_BUILD_START_BY_MS);
    expect(await g.pay(A, t0, () => Promise.resolve('on time'))).toBe('on time');
  });

  it("a melt waits at most the worker's deadline for the PAY in flight: then it is refused unmelted and the mark clears", async () => {
    const { g, timers } = gate();
    const stuck = deferred<string>();
    const pay = g.pay(A, g.now(), () => stuck.promise);
    let melted = 0;
    const melt = observe(
      g.melt(A, () => {
        melted++;
        return Promise.resolve('paid');
      }),
    );
    await tick();
    expect(timers.armed.map((t) => t.ms)).toEqual([WORKER_HOST_REQUEST_TIMEOUT_MS]);
    timers.armed.shift()!.fn(); // the deadline passes (a fired timer is gone)
    await tick();
    expect(melt.done).toBe(true);
    expect(refusal(melt.error)).toBe(`rate-limited: ${PAY_STILL_BUILDING}`);
    expect(melted).toBe(0);
    expect(g.melting(A)).toBe(false);
    stuck.resolve('built');
    expect(await pay).toBe('built');
    // A melt that did not have to wait arms no timer; one that waited disarms its own.
    const quick = g.pay(A, g.now(), () => Promise.resolve('q'));
    const waited = g.melt(A, () => Promise.resolve('paid'));
    expect(await quick).toBe('q');
    expect(await waited).toBe('paid');
    expect(timers.armed).toEqual([]);
  });

  it('refuses durations that would switch a rule off (NaN, infinite, negative)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => new PayMeltGate({ startByMs: bad }), String(bad)).toThrow(RangeError);
      expect(() => new PayMeltGate({ meltWaitMs: bad }), String(bad)).toThrow(RangeError);
    }
    expect(() => new PayMeltGate({ startByMs: 0, meltWaitMs: 0 })).not.toThrow();
  });

  it('every refusal is a GateRefusal: code rate-limited, and it crosses the wire as such', () => {
    for (const detail of [MELT_AT_MINT, PAY_TOO_LATE, PAY_STILL_BUILDING]) {
      const e = new GateRefusal(detail);
      expect(e.code).toBe('rate-limited');
      expect(toWireError(e)).toEqual({ code: 'rate-limited', message: `rate-limited: ${detail}` });
    }
  });
});

describe('the money plane melts only through the gate', () => {
  it("core's CashuWallet pays an invoice through `melt` alone (a new melt-like method must be gated too)", () => {
    // `GatedCashuWallet` (money.ts) overrides `melt`. If core grows another way to melt, this
    // fails, and the new method needs the same override before the gate can be trusted again.
    const names = Object.getOwnPropertyNames(walletMod.CashuWallet.prototype).filter((n) =>
      /melt|invoice|lightning|bolt/i.test(n),
    );
    expect(names.sort()).toEqual(['melt', 'meltQuote']);
  });
});
