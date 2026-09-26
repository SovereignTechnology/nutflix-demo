/**
 * SettleLoop — the wallet journal settles by itself (ADR 0014 amendment; issue #8 review,
 * finding 1). A journaled send or melt holds its inputs out of the balance until a settle decides
 * it, and a settle used to run only inside an operation at that mint, or once at startup. A wallet
 * whose balance was all held could start no operation — the playback gate reads the balance
 * first — so the held sats never came back before a restart. This loop runs `recoverPending`
 * whenever the journal next has something to decide:
 *
 *   - at `created + PENDING_SETTLE_AFTER_S` (plus a margin) of the earliest entry still young;
 *   - for entries past it already (a melt the mint still reports PENDING, a mint that could not
 *     be asked), again after a retry delay: 30 s, doubling while settles decide nothing, up to
 *     `PENDING_SETTLE_AFTER_S`; back to 30 s once one does;
 *   - planned again after every balance change event (an operation that journals an entry emits
 *     one), and only ever EARLIER: a stream of events cannot postpone a planned settle.
 *
 * One settle at a time. A stopped loop plans nothing and cancels its timer. The default timer is
 * unref'd, so it never keeps a process alive. Nothing here logs (the caller logs counts, from
 * `onSettled`), and nothing here decides anything about money: `recoverPending` is the same
 * settle every operation runs first.
 */
import type { UnixSeconds, WalletChangeEvent } from '../contracts/index.js';
import { PENDING_SETTLE_AFTER_S } from './spend.js';

/** After an entry's wait, the settle runs this much later (clock steps, timer slack). */
export const SETTLE_MARGIN_S = 5;
/** The first retry of an entry a settle could not decide. */
export const SETTLE_RETRY_MIN_S = 30;
/** The longest retry delay. */
export const SETTLE_RETRY_MAX_S = PENDING_SETTLE_AFTER_S;

/** Run `fn` in `ms` milliseconds; returns a cancel. */
export type SettleTimer = (fn: () => void, ms: number) => () => void;

/** What the loop needs of the wallet (`CashuWallet`). */
export interface SettleLoopWallet {
  settleSchedule(): Promise<{
    readonly count: number;
    readonly overdue: number;
    readonly next: UnixSeconds | null;
  }>;
  recoverPending(): Promise<{ readonly recovered: number; readonly left: number }>;
  onChange(cb: (e: WalletChangeEvent) => void): () => void;
}

export interface SettleLoopOptions {
  readonly wallet: SettleLoopWallet;
  /** The wallet's clock (the one its journal entries are stamped with). */
  readonly now?: () => UnixSeconds;
  /** Tests: the timer. Default: `setTimeout`, unref'd. */
  readonly timer?: SettleTimer;
  /** After each settle the loop ran, its counts (for a log line). */
  readonly onSettled?: (r: { readonly recovered: number; readonly left: number }) => void;
}

const defaultTimer: SettleTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  (t as unknown as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(t);
  };
};

export class SettleLoop {
  private readonly now: () => UnixSeconds;
  private readonly timer: SettleTimer;
  private cancel: (() => void) | null = null;
  /** When the planned settle runs (wallet clock, seconds), or `null`. */
  private at: number | null = null;
  /** Settles in a row that decided nothing while entries were overdue. */
  private streak = 0;
  private settling: Promise<void> | null = null;
  private planning: Promise<void> = Promise.resolve();
  private off: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly o: SettleLoopOptions) {
    this.now = o.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
    this.timer = o.timer ?? defaultTimer;
  }

  /** Follow the wallet's change events and plan the first settle. Idempotent. */
  start(): void {
    if (this.stopped || this.off !== null) return;
    this.off = this.o.wallet.onChange((e) => {
      if (e.type === 'balance') void this.plan();
    });
    void this.plan();
  }

  /** Plan nothing more; cancel the planned settle (one in flight finishes on its own). */
  stop(): void {
    this.stopped = true;
    this.off?.();
    this.off = null;
    this.clear();
  }

  /** When the planned settle runs (wallet clock), or `null` (tests, diagnostics). */
  get plannedAt(): UnixSeconds | null {
    return this.at === null ? null : (this.at as UnixSeconds);
  }

  /** The delay before an overdue entry is tried again, now. */
  get retryDelayS(): number {
    return Math.min(SETTLE_RETRY_MIN_S * 2 ** Math.max(0, this.streak - 1), SETTLE_RETRY_MAX_S);
  }

  /** Resolves once no plan and no settle is in flight (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const p = this.planning;
      const s = this.settling;
      await p;
      await s;
      if (p === this.planning && s === this.settling) return;
    }
  }

  /** Plan again from the journal (serialised; a planned settle only ever moves earlier). */
  plan(): Promise<void> {
    const run = this.planning.then(() => this.replan());
    this.planning = run.catch(() => undefined);
    return this.planning;
  }

  private clear(): void {
    this.cancel?.();
    this.cancel = null;
    this.at = null;
  }

  /** Stopped, or a settle is running (it plans again when it is over). */
  private busy(): boolean {
    return this.stopped || this.settling !== null;
  }

  private async replan(): Promise<void> {
    if (this.busy()) return;
    let s: Awaited<ReturnType<SettleLoopWallet['settleSchedule']>>;
    try {
      s = await this.o.wallet.settleSchedule();
    } catch {
      return; // the store is closed or unreadable: nothing to plan from
    }
    if (this.busy()) return; // stopped, or a settle began, while the journal was read
    if (s.overdue === 0) this.streak = 0;
    const now = this.now();
    let at: number | null = null;
    // A stamp in the future (the clock went back) waits at most one full wait.
    if (s.next !== null) at = Math.min(s.next, now + PENDING_SETTLE_AFTER_S) + SETTLE_MARGIN_S;
    if (s.overdue > 0) at = Math.min(at ?? Number.POSITIVE_INFINITY, now + this.retryDelayS);
    if (at === null) {
      this.clear(); // nothing journaled
      return;
    }
    if (this.at !== null && this.at <= at) return; // an earlier settle is planned already
    this.clear();
    this.at = at;
    this.cancel = this.timer(
      () => {
        this.fire();
      },
      Math.max(0, (at - now) * 1000),
    );
  }

  private fire(): void {
    this.cancel = null;
    this.at = null;
    if (this.busy()) return;
    const run = (async (): Promise<void> => {
      let before = -1;
      try {
        before = (await this.o.wallet.settleSchedule()).count;
      } catch {
        // counted as no progress below
      }
      try {
        const r = await this.o.wallet.recoverPending();
        const decided = r.recovered > 0 || (before >= 0 && r.left < before);
        this.streak = decided ? 0 : this.streak + 1;
        try {
          this.o.onSettled?.(r);
        } catch {
          // the caller's log line is its own
        }
      } catch {
        this.streak++;
      }
    })();
    this.settling = run.finally(() => {
      this.settling = null;
      void this.plan();
    });
  }
}
