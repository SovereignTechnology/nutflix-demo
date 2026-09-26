/**
 * Issue #8 review, finding 1: the journal settles by itself. Held inputs (an unresolved send or
 * melt) are out of the balance, and a settle used to run only inside an operation at that mint or
 * at startup — so a wallet whose balance was all held never got it back before a restart.
 *
 *   SettleLoop (a scripted wallet)   plans `recoverPending` at an entry's wait plus the margin;
 *                                    retries overdue entries 30 s, 60 s, … up to the wait, and
 *                                    from 30 s again once a settle decides something; a change
 *                                    event only ever moves the plan earlier; one settle at a time;
 *                                    stop cancels; a stamp in the future waits one wait at most.
 *   CashuWallet + TestMint           `settleSchedule` reads the journal; with only `balance()`
 *                                    called, a refused send's input comes back after the wait.
 */
import { getPubKeyFromPrivKey, type RequestFn } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';

import type {
  CashuP2pkPubkey,
  MintUrl,
  Sats,
  UnixSeconds,
  WalletChangeEvent,
} from '../../contracts/index.js';
import { TestMint } from '../../mocks/test-mint.js';
import {
  SETTLE_MARGIN_S,
  SETTLE_RETRY_MAX_S,
  SETTLE_RETRY_MIN_S,
  SettleLoop,
  type SettleLoopWallet,
} from '../settle-loop.js';
import { PENDING_SETTLE_AFTER_S } from '../spend.js';
import { MemoryProofStore, type ProofStore } from '../store.js';
import { CashuMintConnections, CashuWallet } from '../wallet.js';

const MINT = 'https://mint.settle-loop.example' as MintUrl;
const T0 = 1_900_000_000;

/** A timer the test fires by hand. */
function manualTimer() {
  const planned: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    planned,
    timer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      planned.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    /** The live (not cancelled, not fired) timers. */
    live: () => planned.filter((t) => !t.cancelled),
    fire: () => {
      const t = planned.filter((x) => !x.cancelled).at(-1);
      if (t === undefined) throw new Error('nothing planned');
      t.cancelled = true;
      t.fn();
    },
  };
}

/** A wallet whose journal the test scripts. */
function scripted(clock: { t: number }) {
  const w = {
    count: 0,
    overdue: 0,
    next: null as number | null,
    settles: 0,
    /** What the next settle does to the script. */
    onSettle: (): { recovered: number; left: number } => ({ recovered: 0, left: w.count }),
    listeners: new Set<(e: WalletChangeEvent) => void>(),
    emit: () => {
      for (const cb of w.listeners) cb({ type: 'balance', mint: MINT, balance: 0 as Sats });
    },
  };
  const wallet: SettleLoopWallet = {
    settleSchedule: () =>
      Promise.resolve({
        count: w.count,
        overdue: w.overdue,
        next: w.next === null ? null : (w.next as UnixSeconds),
      }),
    recoverPending: () => {
      w.settles++;
      return Promise.resolve(w.onSettle());
    },
    onChange: (cb) => {
      w.listeners.add(cb);
      return () => w.listeners.delete(cb);
    },
  };
  return { w, wallet, now: () => clock.t as UnixSeconds };
}

describe('SettleLoop — when the journal settles by itself', () => {
  it('plans a settle at the entry’s wait plus the margin, and nothing when nothing is journaled', async () => {
    const clock = { t: T0 };
    const { w, wallet, now } = scripted(clock);
    const tm = manualTimer();
    const loop = new SettleLoop({ wallet, now, timer: tm.timer });
    loop.start();
    await loop.idle();
    expect(tm.live()).toHaveLength(0);
    expect(loop.plannedAt).toBeNull();
    // A send is journaled at T0 (its operation emits a balance event).
    w.count = 1;
    w.next = T0 + PENDING_SETTLE_AFTER_S;
    w.emit();
    await loop.idle();
    expect(loop.plannedAt).toBe(T0 + PENDING_SETTLE_AFTER_S + SETTLE_MARGIN_S);
    expect(tm.live().map((t) => t.ms)).toEqual([(PENDING_SETTLE_AFTER_S + SETTLE_MARGIN_S) * 1000]);
    // The wait passes; the settle decides it (dropped, the inputs back).
    clock.t = T0 + PENDING_SETTLE_AFTER_S + SETTLE_MARGIN_S;
    w.onSettle = () => {
      w.count = 0;
      w.next = null;
      return { recovered: 0, left: 0 };
    };
    tm.fire();
    await loop.idle();
    expect(w.settles).toBe(1);
    expect(tm.live()).toHaveLength(0); // nothing left to plan
    loop.stop();
  });

  it('a stream of change events never postpones a planned settle; an earlier entry moves it earlier', async () => {
    const clock = { t: T0 };
    const { w, wallet, now } = scripted(clock);
    const tm = manualTimer();
    const loop = new SettleLoop({ wallet, now, timer: tm.timer });
    w.count = 1;
    w.next = T0 + 100;
    loop.start();
    await loop.idle();
    expect(loop.plannedAt).toBe(T0 + 100 + SETTLE_MARGIN_S);
    // PAYs keep emitting while the plan stands; a later entry does not push it out.
    for (let i = 0; i < 5; i++) {
      clock.t += 10;
      w.count++;
      w.emit();
      await loop.idle();
    }
    expect(loop.plannedAt).toBe(T0 + 100 + SETTLE_MARGIN_S);
    expect(tm.live()).toHaveLength(1);
    // An overdue entry (its mint could not be asked) is retried sooner: the plan moves earlier.
    w.overdue = 1;
    w.emit();
    await loop.idle();
    expect(loop.plannedAt).toBe(clock.t + SETTLE_RETRY_MIN_S);
    expect(tm.live()).toHaveLength(1);
    loop.stop();
  });

  it('a retry is not pushed out by events either: PAYs every 10 s still let the 30 s retry run', async () => {
    // The retry is planned relative to "now"; recomputed at every event it would always be 30 s
    // away and never run (the mutation pass found this unpinned).
    const clock = { t: T0 };
    const { w, wallet, now } = scripted(clock);
    const tm = manualTimer();
    const loop = new SettleLoop({ wallet, now, timer: tm.timer });
    w.count = 1;
    w.overdue = 1;
    loop.start();
    await loop.idle();
    expect(loop.plannedAt).toBe(T0 + SETTLE_RETRY_MIN_S);
    for (const dt of [10, 20, 29]) {
      clock.t = T0 + dt;
      w.emit();
      await loop.idle();
      expect(loop.plannedAt).toBe(T0 + SETTLE_RETRY_MIN_S);
    }
    expect(tm.live()).toHaveLength(1);
    loop.stop();
  });

  it('a clock that is not a number plans nothing (no settle "now", again and again)', async () => {
    const clock = { t: Number.NaN };
    const { w, wallet, now } = scripted(clock);
    const tm = manualTimer();
    const loop = new SettleLoop({ wallet, now, timer: tm.timer });
    w.count = 1;
    w.overdue = 1;
    loop.start();
    await loop.idle();
    expect(tm.live()).toHaveLength(0);
    loop.stop();
  });

  it('retries overdue entries 30 s, 60 s, … up to the wait; from 30 s again once a settle decides one', async () => {
    const clock = { t: T0 };
    const { w, wallet, now } = scripted(clock);
    const tm = manualTimer();
    const loop = new SettleLoop({ wallet, now, timer: tm.timer });
    // A melt the mint still reports PENDING, long past its wait: every settle leaves it.
    w.count = 1;
    w.overdue = 1;
    loop.start();
    await loop.idle();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      delays.push((loop.plannedAt ?? 0) - clock.t);
      clock.t = loop.plannedAt ?? clock.t;
      tm.fire();
      await loop.idle();
    }
    expect(delays).toEqual([30, 30, 60, 120, 240, 480, SETTLE_RETRY_MAX_S]);
    expect(w.settles).toBe(7);
    // It settles now (the payment went through): the next overdue entry starts again at 30 s.
    w.onSettle = () => ({ recovered: 1, left: 1 });
    clock.t = loop.plannedAt ?? clock.t;
    tm.fire();
    await loop.idle();
    expect((loop.plannedAt ?? 0) - clock.t).toBe(SETTLE_RETRY_MIN_S);
    loop.stop();
  });

  it('one settle at a time; stop cancels the plan and plans nothing more', async () => {
    const clock = { t: T0 };
    const { w, wallet, now } = scripted(clock);
    const tm = manualTimer();
    let release: () => void = () => undefined;
    let inFlight = 0;
    let most = 0;
    const slow: SettleLoopWallet = {
      ...wallet,
      recoverPending: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise<void>((r) => {
          release = r;
        });
        inFlight--;
        w.settles++;
        return { recovered: 0, left: w.count };
      },
    };
    const loop = new SettleLoop({ wallet: slow, now, timer: tm.timer });
    w.count = 1;
    w.overdue = 1;
    loop.start();
    await loop.idle();
    tm.fire();
    while (inFlight === 0) await new Promise((r) => setTimeout(r, 0));
    // While it runs, events plan nothing (the settle plans again when it is over).
    w.emit();
    w.emit();
    await new Promise((r) => setTimeout(r, 0));
    expect(tm.live()).toHaveLength(0);
    release();
    await loop.idle();
    expect(most).toBe(1);
    expect(tm.live()).toHaveLength(1);
    loop.stop();
    expect(tm.live()).toHaveLength(0);
    w.emit();
    await loop.idle();
    expect(tm.live()).toHaveLength(0);
    loop.start(); // a stopped loop stays stopped
    await loop.idle();
    expect(tm.live()).toHaveLength(0);
  });

  it('an entry stamped in the future (the clock went back) waits one full wait at most', async () => {
    const clock = { t: T0 };
    const { w, wallet, now } = scripted(clock);
    const tm = manualTimer();
    const loop = new SettleLoop({ wallet, now, timer: tm.timer });
    w.count = 1;
    w.next = T0 + 30 * 24 * 3600;
    loop.start();
    await loop.idle();
    expect(loop.plannedAt).toBe(T0 + PENDING_SETTLE_AFTER_S + SETTLE_MARGIN_S);
    loop.stop();
  });

  it('a store that cannot be read plans nothing; a settle that throws is retried like one that decided nothing', async () => {
    const clock = { t: T0 };
    const { w, wallet, now } = scripted(clock);
    const tm = manualTimer();
    let broken = true;
    const flaky: SettleLoopWallet = {
      ...wallet,
      settleSchedule: () =>
        broken ? Promise.reject(new Error('journal closed')) : wallet.settleSchedule(),
      recoverPending: () => Promise.reject(new Error('mint down')),
    };
    const loop = new SettleLoop({ wallet: flaky, now, timer: tm.timer });
    w.count = 1;
    w.overdue = 1;
    loop.start();
    await loop.idle();
    expect(tm.live()).toHaveLength(0);
    broken = false;
    w.emit();
    await loop.idle();
    expect(loop.plannedAt).toBe(T0 + SETTLE_RETRY_MIN_S);
    clock.t = loop.plannedAt ?? clock.t;
    tm.fire();
    await loop.idle();
    clock.t = loop.plannedAt ?? clock.t;
    tm.fire();
    await loop.idle();
    expect((loop.plannedAt ?? 0) - clock.t).toBe(2 * SETTLE_RETRY_MIN_S);
    loop.stop();
  });
});

// ---- the real wallet ------------------------------------------------------------------------

function pub(fill: number): CashuP2pkPubkey {
  return Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(fill))).toString(
    'hex',
  ) as CashuP2pkPubkey;
}

/** A transport that refuses the next swap before it reaches the mint (connection refused). */
function refusing(inner: RequestFn) {
  const st = { refuseSwap: 0 };
  const request: RequestFn = async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
    if (st.refuseSwap > 0 && args.endpoint.endsWith('/v1/swap')) {
      st.refuseSwap--;
      throw new Error('connect ECONNREFUSED');
    }
    return inner<T>(args);
  };
  return { st, request };
}

describe('CashuWallet.settleSchedule + SettleLoop (issue #8 review, finding 1)', () => {
  it('settleSchedule reads the journal: count, the next wait, what is overdue', async () => {
    const clock = { t: T0 };
    const mint = new TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x71) });
    const net = refusing(mint.request);
    const store = new MemoryProofStore();
    const wallet = new CashuWallet({
      mints: new CashuMintConnections({ request: () => net.request }),
      store,
      now: () => clock.t as UnixSeconds,
    });
    expect(await wallet.settleSchedule()).toEqual({ count: 0, overdue: 0, next: null });
    const q = await wallet.mintQuote(MINT, 16 as Sats);
    mint.payQuote(q.quoteId);
    await wallet.pollQuote(q);
    net.st.refuseSwap = 1;
    await expect(wallet.send(4 as Sats, { p2pk: pub(9), mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await wallet.settleSchedule()).toEqual({
      count: 1,
      overdue: 0,
      next: T0 + PENDING_SETTLE_AFTER_S,
    });
    clock.t = T0 + PENDING_SETTLE_AFTER_S;
    expect(await wallet.settleSchedule()).toEqual({ count: 1, overdue: 1, next: null });
    // A store without a journal has nothing to schedule.
    const noJournal: ProofStore = {
      mints: () => store.mints(),
      proofs: (m) => store.proofs(m),
      commit: (tx) => store.commit(tx),
      history: (o) => store.history(o),
    };
    const plain = new CashuWallet({
      mints: new CashuMintConnections({ request: () => mint.request }),
      store: noJournal,
    });
    expect(await plain.settleSchedule()).toEqual({ count: 0, overdue: 0, next: null });
  });

  it('with only balance() read, a refused send’s input comes back after the wait — no restart, no other payment', async () => {
    const clock = { t: T0 };
    const mint = new TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x72) });
    const net = refusing(mint.request);
    const store = new MemoryProofStore();
    const wallet = new CashuWallet({
      mints: new CashuMintConnections({ request: () => net.request }),
      store,
      now: () => clock.t as UnixSeconds,
    });
    const q = await wallet.mintQuote(MINT, 16 as Sats);
    mint.payQuote(q.quoteId);
    await wallet.pollQuote(q);
    const tm = manualTimer();
    const loop = new SettleLoop({ wallet, now: () => clock.t as UnixSeconds, timer: tm.timer });
    loop.start();
    await loop.idle();
    expect(tm.live()).toHaveLength(0);
    const balances: number[] = [];
    wallet.onChange((e) => {
      if (e.type === 'balance') balances.push(e.balance);
    });
    // The swap never reaches the mint; the wallet cannot know that, so the input is held.
    net.st.refuseSwap = 1;
    await expect(wallet.send(4 as Sats, { p2pk: pub(9), mint: MINT })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await wallet.balance(MINT)).toBe(0);
    await loop.idle();
    expect(loop.plannedAt).toBe(T0 + PENDING_SETTLE_AFTER_S + SETTLE_MARGIN_S);
    // An hour of reading the balance changes nothing by itself…
    clock.t = T0 + 3600;
    expect(await wallet.balance(MINT)).toBe(0);
    // …the loop's settle does: the mint never saw the swap, the input is unspent — it is back.
    tm.fire();
    await loop.idle();
    expect(await wallet.balance(MINT)).toBe(16);
    expect(balances.at(-1)).toBe(16); // and the header chip hears of it
    expect(await store.pending(MINT)).toEqual([]);
    expect(mint.calls.filter((c) => c === 'POST /v1/swap')).toHaveLength(0);
    // Spendable, exactly once.
    await wallet.send(16 as Sats, { p2pk: pub(9), mint: MINT });
    expect(await wallet.balance(MINT)).toBe(0);
    loop.stop();
  });
});
