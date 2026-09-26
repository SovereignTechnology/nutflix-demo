/**
 * The money plane's per-mint gate between PAY builds and melts (ADR 0012 amendment 2026-09-25,
 * lane I2-paygate; the numbers and why they fit: `ipc/deadlines.ts`).
 *
 * The fund loss it closes: core runs a wallet's operations at one mint one at a time, and a melt
 * holds that turn until the mint has paid the invoice (up to 300 s). The worker gives a
 * `pay.build` 300 s and the host cannot cancel one. A PAY queued behind a melt that ran long was
 * therefore built after the worker had given up: the viewer's proofs were swapped into P2PK sets
 * locked to the seeder and the creator, never delivered, with no way back.
 *
 * The rules, per mint:
 *
 *   - a melt marks its mint (pending), refuses the PAY builds waiting for their turn there, waits
 *     for the one in flight to finish, then melts; the mark clears once the melt settles — paid,
 *     unpaid, thrown or timed out. It waits at most `meltWaitMs` (the worker's deadline: by then
 *     the worker has given up on that PAY anyway) and is then refused without melting;
 *   - a PAY build is refused at once while its mint is marked — before any wallet call, so
 *     nothing is spent — with `rate-limited:`, which the worker's payer treats as "retry later"
 *     (the blocks stay owed; `worker/pay/viewer-payer.ts` asks again after a backoff);
 *   - PAY builds take turns, in arrival order. Core would run their wallet calls one at a time
 *     anyway, so nothing is lost, and the wait for a turn becomes visible here: a PAY that has not
 *     reached the wallet `startByMs` after its request arrived is refused (the belt).
 *
 * Every refusal is a `GateRefusal` (nothing reached the wallet): the auto top-up counts a refused
 * melt as nothing moved. Nothing here logs.
 */
import type { MintUrl } from '@sovit/core';

import { PAY_BUILD_START_BY_MS, WORKER_HOST_REQUEST_TIMEOUT_MS } from '../ipc/deadlines.js';
import { IpcError, wireError } from '../ipc/errors.js';

/** What a PAY refused because of a melt at its mint says (the worker logs it). */
export const MELT_AT_MINT =
  'a melt is in progress at this mint: the PAY is retried once it settles (nothing was spent)';
/** What a PAY that waited too long for its turn says. */
export const PAY_TOO_LATE =
  'the PAY waited too long for its turn at this mint: it is retried (nothing was spent)';
/** What a melt refused after waiting for a PAY in flight says. */
export const PAY_STILL_BUILDING =
  'a payment at this mint is still being built: nothing was melted, try again';

/** A refusal by the gate: nothing reached the wallet, nothing was spent. */
export class GateRefusal extends IpcError {
  constructor(detail: string) {
    const w = wireError('rate-limited', detail);
    super(w.code, w.message);
  }
}

export interface GateTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: GateTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface PayMeltGateOptions {
  /** A monotonic clock in ms (default `performance.now`). */
  readonly clock?: () => number;
  readonly timers?: GateTimers;
  /** The belt (default `PAY_BUILD_START_BY_MS`). */
  readonly startByMs?: number;
  /** How long a melt waits for the PAY build in flight (default the worker's deadline). */
  readonly meltWaitMs?: number;
}

interface Turn {
  readonly start: () => void;
  readonly refuse: (e: Error) => void;
}

interface AtMint {
  /** A PAY build holds the turn (at most one per mint). */
  busy: boolean;
  /** PAY builds waiting for the turn, in arrival order. */
  readonly waiting: Turn[];
  /** Melts pending or in flight. */
  melts: number;
  /** Melts waiting for the PAY build in flight to finish. */
  readonly idle: (() => void)[];
}

export class PayMeltGate {
  private readonly at = new Map<MintUrl, AtMint>();
  private readonly clock: () => number;
  private readonly timers: GateTimers;
  private readonly startByMs: number;
  private readonly meltWaitMs: number;

  constructor(o: PayMeltGateOptions = {}) {
    this.clock = o.clock ?? ((): number => performance.now());
    this.timers = o.timers ?? realTimers;
    this.startByMs = o.startByMs ?? PAY_BUILD_START_BY_MS;
    this.meltWaitMs = o.meltWaitMs ?? WORKER_HOST_REQUEST_TIMEOUT_MS;
  }

  /** The gate's clock: when a PAY request arrived, for `pay`'s belt. */
  now(): number {
    return this.clock();
  }

  /** A melt is pending or in flight at `mint` (PAY builds there are refused). */
  melting(mint: MintUrl): boolean {
    return (this.at.get(mint)?.melts ?? 0) > 0;
  }

  /**
   * Run one PAY build at `mint` when its turn comes. Refused at once while a melt is pending or in
   * flight there, and — at its turn — once `startByMs` has passed since `arrived` (`now()` when
   * the request came in). `build` is never called for a refused PAY.
   */
  async pay<T>(mint: MintUrl, arrived: number, build: () => Promise<T>): Promise<T> {
    const m = this.mint(mint);
    if (m.melts > 0) throw new GateRefusal(MELT_AT_MINT);
    if (m.busy)
      // `next` hands the turn over (busy stays set); a melt marking the mint refuses the wait.
      await new Promise<void>((start, refuse) => {
        m.waiting.push({ start, refuse });
      });
    else m.busy = true;
    try {
      if (this.clock() - arrived > this.startByMs) throw new GateRefusal(PAY_TOO_LATE);
      return await build();
    } finally {
      m.busy = false;
      this.next(mint, m);
    }
  }

  /**
   * Run a melt at `mint`: the mint is marked (new PAY builds refused, waiting ones refused now),
   * the PAY build in flight there is waited for, then `run` melts. The mark clears when `run`
   * settles, however it settles.
   */
  async melt<T>(mint: MintUrl, run: () => Promise<T>): Promise<T> {
    const m = this.mint(mint);
    m.melts++;
    try {
      for (const w of m.waiting.splice(0)) w.refuse(new GateRefusal(MELT_AT_MINT));
      if (m.busy) await this.idle(m);
      return await run();
    } finally {
      m.melts--;
      this.next(mint, m);
    }
  }

  /** Resolves once no PAY build holds the turn; refused after `meltWaitMs`. */
  private idle(m: AtMint): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onIdle = (): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        resolve();
      };
      const timer = this.timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        const i = m.idle.indexOf(onIdle);
        if (i >= 0) m.idle.splice(i, 1);
        reject(new GateRefusal(PAY_STILL_BUILDING));
      }, this.meltWaitMs);
      m.idle.push(onIdle);
    });
  }

  /** The turn is free: the next PAY build takes it, or the melts waiting go ahead. */
  private next(mint: MintUrl, m: AtMint): void {
    if (!m.busy) {
      const w = m.melts === 0 ? m.waiting.shift() : undefined;
      if (w !== undefined) {
        m.busy = true;
        w.start();
      } else for (const go of m.idle.splice(0)) go();
    }
    if (!m.busy && m.melts === 0 && m.waiting.length === 0 && m.idle.length === 0)
      this.at.delete(mint);
  }

  private mint(mint: MintUrl): AtMint {
    let m = this.at.get(mint);
    if (m === undefined) {
      m = { busy: false, waiting: [], melts: 0, idle: [] };
      this.at.set(mint, m);
    }
    return m;
  }
}
