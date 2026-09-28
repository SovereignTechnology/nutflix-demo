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
 *     reached the wallet `startByMs` after its request arrived is refused (the belt) — or sooner,
 *     by the bound its caller computes at its turn (the money plane's `payBuildStartByMs`: less
 *     time with journal entries left at the mint; cross-lane review round 4).
 *
 * A HOLD is marked like a melt (lane W8a, final cross-lane review): the wallet's long operations
 * at a mint — a NUT-13 restore, a reissue and its plan, the journal settle (core's
 * `CashuWalletOptions.holdMint`) — hold the mint's turn for many round trips (a restore is not
 * bounded by the PAY model at all), so a PAY queued behind one would be built after the worker gave
 * up on it. While one is pending or running there, PAY builds are refused at once like during a
 * melt, and it waits for the PAY in flight first (at most `meltWaitMs`, then refused unrun).
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
/** What a PAY refused because of a restore, reissue or settle at its mint says (W8a). */
export const HOLD_AT_MINT =
  'a wallet restore or reissue is running at this mint: the PAY is retried once it ends (nothing was spent)';
/** What a hold refused after waiting for a PAY in flight says (W8a). */
export const PAY_STILL_BUILDING_HOLD =
  'a payment at this mint is still being built: the wallet operation did not start, try again';

/** A refusal by the gate: nothing reached the wallet, nothing was spent. */
export class GateRefusal extends IpcError {
  constructor(detail: string) {
    const w = wireError('rate-limited', detail);
    super(w.code, w.message);
  }
}

/**
 * When a PAY request arrived, on the gate's own clock: only `PayMeltGate.now()` makes one, so a
 * wall-clock time (`Date.now()`, another base) cannot be passed by mistake — against the
 * monotonic default it would read as a request from the future and switch the belt off.
 */
export type Arrival = number & { readonly __arrival: unique symbol };

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
  /** The belt (default `PAY_BUILD_START_BY_MS`); a finite number ≥ 0, else the constructor throws. */
  readonly startByMs?: number;
  /**
   * How long a melt waits for the PAY build in flight (default the worker's deadline); a finite
   * number ≥ 0, else the constructor throws.
   */
  readonly meltWaitMs?: number;
}

/** A duration option: `NaN` would switch the belt off (`x > NaN` is false), so none is taken. */
function durationMs(name: string, v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isFinite(v) || v < 0)
    throw new RangeError(`PayMeltGate: ${name} must be a finite number of ms ≥ 0`);
  return v;
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
  /** Holds (W8a: restores, reissues, settles) pending or running. */
  holds: number;
  /** Melts and holds waiting for the PAY build in flight to finish. */
  readonly idle: (() => void)[];
}

/** Why a PAY at `m` is refused at once, or `undefined` while nothing marks it. */
function markedBy(m: AtMint | undefined): string | undefined {
  if (m === undefined) return undefined;
  if (m.melts > 0) return MELT_AT_MINT;
  if (m.holds > 0) return HOLD_AT_MINT;
  return undefined;
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
    this.startByMs = durationMs('startByMs', o.startByMs, PAY_BUILD_START_BY_MS);
    this.meltWaitMs = durationMs('meltWaitMs', o.meltWaitMs, WORKER_HOST_REQUEST_TIMEOUT_MS);
  }

  /** The gate's clock: when a PAY request arrived, for `pay`'s belt. */
  now(): Arrival {
    return this.clock() as Arrival;
  }

  /** A melt is pending or in flight at `mint` (PAY builds there are refused). */
  melting(mint: MintUrl): boolean {
    return (this.at.get(mint)?.melts ?? 0) > 0;
  }

  /**
   * The refusal a PAY at `mint` meets right now — a melt or a hold marks it — or `undefined`
   * (W8a: the money plane asks before it prepares the mint for a PAY).
   */
  refusal(mint: MintUrl): GateRefusal | undefined {
    const why = markedBy(this.at.get(mint));
    return why === undefined ? undefined : new GateRefusal(why);
  }

  /**
   * Run one PAY build at `mint` when its turn comes. Refused at once while a melt is pending or in
   * flight there, and — at its turn — once `startByMs` has passed since `arrived` (`now()` when
   * the request came in), or the bound `startBy` answers then, if sooner (read at the turn, the
   * clock after it; a bound that is not a number, or that throws, refuses). `build` is never
   * called for a refused PAY.
   */
  async pay<T>(
    mint: MintUrl,
    arrived: Arrival,
    build: () => Promise<T>,
    startBy?: () => number | Promise<number>,
  ): Promise<T> {
    const m = this.mint(mint);
    const marked = markedBy(m);
    if (marked !== undefined) throw new GateRefusal(marked);
    if (m.busy)
      // `next` hands the turn over (busy stays set); a melt marking the mint refuses the wait.
      await new Promise<void>((start, refuse) => {
        m.waiting.push({ start, refuse });
      });
    else m.busy = true;
    try {
      let limit = this.startByMs;
      if (startBy !== undefined) {
        let own: number;
        try {
          own = await startBy();
        } catch {
          own = Number.NaN;
        }
        limit = Math.min(limit, own);
      }
      // `!(… <= limit)`: a NaN bound refuses (`x > NaN` would let it through).
      if (!(this.clock() - arrived <= limit)) throw new GateRefusal(PAY_TOO_LATE);
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
    return this.mark(mint, 'melts', run);
  }

  /**
   * Run one of the wallet's long operations at `mint` (W8a: a NUT-13 restore, a reissue or its
   * plan, the journal settle — core's `holdMint`), marked like a melt: PAY builds there refused at
   * once, the one in flight waited for (at most `meltWaitMs`, then refused unrun with
   * `PAY_STILL_BUILDING_HOLD`). The mark clears when `run` settles, however it settles.
   */
  async hold<T>(mint: MintUrl, run: () => Promise<T>): Promise<T> {
    return this.mark(mint, 'holds', run);
  }

  private async mark<T>(mint: MintUrl, kind: 'melts' | 'holds', run: () => Promise<T>): Promise<T> {
    const m = this.mint(mint);
    m[kind]++;
    try {
      const why = markedBy(m) ?? MELT_AT_MINT;
      for (const w of m.waiting.splice(0)) w.refuse(new GateRefusal(why));
      if (m.busy)
        await this.idle(m, kind === 'melts' ? PAY_STILL_BUILDING : PAY_STILL_BUILDING_HOLD);
      return await run();
    } finally {
      m[kind]--;
      this.next(mint, m);
    }
  }

  /** Resolves once no PAY build holds the turn; refused after `meltWaitMs`. */
  private idle(m: AtMint, why: string): Promise<void> {
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
        reject(new GateRefusal(why));
      }, this.meltWaitMs);
      m.idle.push(onIdle);
    });
  }

  /** The turn is free: the next PAY build takes it, or the melts waiting go ahead. */
  private next(mint: MintUrl, m: AtMint): void {
    const marked = m.melts + m.holds > 0;
    if (!m.busy) {
      const w = marked ? undefined : m.waiting.shift();
      if (w !== undefined) {
        m.busy = true;
        w.start();
      } else for (const go of m.idle.splice(0)) go();
    }
    if (!m.busy && !marked && m.waiting.length === 0 && m.idle.length === 0) this.at.delete(mint);
  }

  private mint(mint: MintUrl): AtMint {
    let m = this.at.get(mint);
    if (m === undefined) {
      m = { busy: false, waiting: [], melts: 0, holds: 0, idle: [] };
      this.at.set(mint, m);
    }
    return m;
  }
}
