/**
 * Auto top-ups EXECUTE (issue #2, security review F4; Cameron 2026-09-24): when the balance at a
 * mint a payment draws from falls below `Settings.autoTopUp.belowSats`, the host moves sats there
 * from `fromMint` over Lightning — `mintQuote` at the target, `meltQuote` + `melt` at the source,
 * then `pollQuote` mints at the target.
 *
 * Triggers: ONLY the payment path — a play about to open (`DesktopNetworkAdapter.checkBalance`)
 * and the money plane paying for an open play session (`pay.build` → `paymentAt`). A wallet
 * balance event never starts one: it is also the user's own withdrawal, send or nutzap, or a
 * seeder melt (independent review, finding 1: the contract compares `belowSats` at "the mint a
 * payment is about to draw from").
 *
 * Guards, in the order they run (every one refuses before anything moves):
 *   1. due — `autoTopUpDue`: on (`belowSats > 0`), the target on the user's OWN list
 *      (`defaultMints`, never a mint first seen in a manifest), never `fromMint` itself;
 *   2. one at a time — a second trigger for the same mint joins the top-up in flight, any other
 *      is `busy`; after any attempt the next waits `TOP_UP_MIN_INTERVAL_MS`, a failure backs off
 *      exponentially (1 min … 1 h) and a declined question backs that mint off for an hour: no
 *      retry per payment, no storm, no re-prompt storm;
 *   3. the amount — `amountSats ?? AUTO_TOP_UP_MAX_SATS`, never above the max;
 *   4. the daily cap — what moved in the last 24 h plus everything in flight plus this top-up
 *      (its amount AND the source mint's Lightning fee reserve) at most
 *      `AUTO_TOP_UP_MAX_SATS_PER_DAY`, from the persisted ledger (`./ledger.ts`, fail closed);
 *   5. the first funding of a mint — main's trusted prompt window asks (target, amount, source);
 *      only an explicit yes is remembered (persisted); no, a closed window or the prompt's
 *      deadline moves nothing;
 *   6. the quotes — the source mint's melt quote must be for exactly the amount the target
 *      invoiced (a target cannot invoice more than asked), with fees (Lightning reserve + an
 *      input-fee allowance) of at most `maxFeeReserve(amount)`; the source must hold all of it;
 *   7. still wanted — right before the reservation and again right before the melt: the same
 *      wallet (no sign-out or signer switch meanwhile; a closed plane reads as none) and the same
 *      settings (still on and due, the same source and amount, the target still on the list);
 *   8. the reservation is persisted BEFORE the melt; a melt that throws or is not paid stays
 *      counted (its sats may have left) — except core's `insufficient-funds`, refused before the
 *      mint is asked, and the money plane's PAY/melt gate refusing it (`GateRefusal`: a PAY at the
 *      source mint was still being built; the melt never started — ADR 0012 amendment
 *      2026-09-25). What a paid melt moved is read from its own history line; without one, the
 *      whole reservation counts, or the source's balance drop when that is larger (input fees past
 *      the allowance — core does not say up front how many inputs it will spend).
 *
 * History (NIP-60 kind 7376): minting at the target already writes `in … "top-up"` and the melt
 * writes `out … "melt to Lightning"` at the source — nothing more is written (no double entry).
 * Core's melt takes no memo (contracts `Wallet.melt`; docs/contract-requests/S3-topup.md), so the
 * host shows that melt as "top-up" (`relabel`), by the history id the ledger recorded.
 *
 * Logs carry outcome codes and numbers only — never a mint URL, a quote, an invoice or a proof.
 */
import type {
  MintQuote,
  MintUrl,
  NostrEventId,
  Sats,
  Settings,
  Wallet,
  WalletChangeEvent,
  WalletHistoryEntry,
} from '@sovit/core';
import { AUTO_TOP_UP_MAX_SATS, wallet as walletMod } from '@sovit/core';

import type { Logger } from '../log.js';
import { GateRefusal } from '../pay-melt-gate.js';
import { autoTopUpDue } from '../settings/settings.js';
import type { TopUpLedger } from './ledger.js';
import { isHistoryId } from './ledger.js';

/** The least time between two top-up attempts (successful or not). */
export const TOP_UP_MIN_INTERVAL_MS = 60_000;
/** A failed top-up backs off this long, doubling per consecutive failure … */
export const TOP_UP_FAIL_BACKOFF_MS = 60_000;
/** … up to this. */
export const TOP_UP_MAX_BACKOFF_MS = 60 * 60_000;
/** A declined (or unanswered) first-funding question: that mint is not asked again for this long. */
export const TOP_UP_DECLINED_BACKOFF_MS = 60 * 60_000;
/** A refusal of the same kind is logged at most this often. */
export const TOP_UP_REFUSAL_LOG_EVERY_MS = 10 * 60_000;
/** Polls of the target's quote after the melt was paid (FakeWallet and most LNs settle at once). */
export const TOP_UP_POLL_ATTEMPTS = 20;
export const TOP_UP_POLL_INTERVAL_MS = 500;
/** Paid-but-not-minted top-ups kept for a retry. */
const MAX_UNISSUED = 16;
/** How much of the source mint's history is compared around the melt. */
const HISTORY_WINDOW = 20;
/** The memo core writes for a melt (`wallet/spend.ts`); the one the host relabels. */
const MELT_MEMO = 'melt to Lightning';
export const TOP_UP_MEMO = 'top-up';

/**
 * Input proofs the source mint's swap fee is reserved for (NUT-02 `input_fee_ppk` per input): the
 * reservation holds `ceil(ppk × 64 / 1000)` sats for them; what they really cost is read back from
 * the melt's own history line.
 */
export const TOP_UP_INPUT_ALLOWANCE = 64;

/**
 * The most fees (Lightning fee reserve + the input-fee allowance) a source mint may ask for an
 * unattended top-up of `amount`: 5 %, with a 10-sat floor (Nutshell asks max(2 sat, 1 %) and
 * 100 ppk per input). A mint asking more is refused.
 */
export function maxFeeReserve(amount: number): number {
  return Math.max(10, Math.ceil(amount / 20));
}

/** `Settings.autoTopUp.amountSats` → the amount to move, or `null` when it is not a valid one. */
export function topUpAmount(a: NonNullable<Settings['autoTopUp']>): number | null {
  const n = a.amountSats ?? AUTO_TOP_UP_MAX_SATS;
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return Math.min(n, AUTO_TOP_UP_MAX_SATS);
}

export type TopUpOutcome =
  /**
   * Not due: off, balance high enough, not a trusted mint, the source itself, or no wallet — or no
   * longer wanted mid-run (the settings or the wallet changed; nothing moved).
   */
  | 'not-due'
  /** Another top-up (for another mint) is in flight. */
  | 'busy'
  /** Too soon after the last attempt, a failure or a declined question. */
  | 'backoff'
  /** The rolling 24-h cap (or a ledger that failed closed). */
  | 'cap'
  /** The first-funding question was declined, closed or timed out. */
  | 'declined'
  /** The source mint holds less than amount + fee reserve. */
  | 'source-short'
  /** Refused on the quotes (amount mismatch, fee reserve too high) or an invalid amount. */
  | 'refused'
  | 'failed'
  | 'done';

export interface FirstFundingQuestion {
  readonly target: MintUrl;
  readonly source: MintUrl;
  readonly amount: Sats;
}

export interface AutoTopUpOptions {
  readonly settings: () => Settings;
  /**
   * The user's REAL wallet right now — the money plane's own, per signer (`undefined`: none —
   * signed out, locked, `--dev-mocks`). A run keeps the one it started with.
   */
  readonly wallet: () => Wallet | undefined;
  readonly ledger: TopUpLedger;
  /**
   * Main's trusted prompt window: `true` only for an explicit yes. Absent = nothing can be asked,
   * so no mint is ever funded for the first time (fail closed).
   */
  readonly askFirstFunding?: (q: FirstFundingQuestion) => Promise<boolean>;
  readonly log: Logger;
  /** Wall-clock milliseconds. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
}

interface Flight {
  readonly target: MintUrl;
  readonly done: Promise<TopUpOutcome>;
}

/**
 * The source mint's history just before the melt: a NEW melt line there, for between the top-up
 * amount and its whole reservation, is the melt's own (a user's own melt at the same mint, at the
 * same moment, for a different amount never is).
 */
interface Before {
  readonly mint: MintUrl;
  readonly ids: ReadonlySet<string>;
  /** The newest entry's time then (`Infinity` when the history could not be read: match none). */
  readonly newest: number;
  readonly min: number;
  readonly max: number;
}

export class AutoTopUp {
  private readonly o: AutoTopUpOptions;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private flight: Flight | null = null;
  /** No attempt before this (min interval, failure backoff). */
  private notBefore = 0;
  private failures = 0;
  /** Mints whose first-funding question was declined → not asked again before this. */
  private readonly declined = new Map<MintUrl, number>();
  /** A melt in flight at this source mint: a NEW melt entry there is shown as "top-up". */
  private meltInFlight: Before | null = null;
  /**
   * Paid at the source but not yet minted at the target: retried at the next trigger — only with
   * the wallet that paid (a signer change never mints one user's top-up into another's wallet).
   */
  private readonly unissued: { readonly quote: MintQuote; readonly wallet: Wallet }[] = [];
  private readonly lastRefusalLog = new Map<TopUpOutcome, number>();

  constructor(o: AutoTopUpOptions) {
    this.o = o;
    this.log = o.log.child('topup');
    this.now = o.now ?? Date.now;
    this.sleep =
      o.sleep ??
      ((ms) =>
        new Promise((r) => {
          setTimeout(r, ms);
        }));
  }

  /**
   * A payment is about to draw from `mint` (a play opening, a PAY for an open session): run its
   * top-up if one is due. `balance`, when known, spares a wallet read for the common not-due case.
   * Never rejects. Never called for a mere balance change (see the header).
   */
  check(mint: MintUrl, balance?: Sats): Promise<TopUpOutcome> {
    try {
      const f = this.flight;
      if (f !== null) return f.target === mint ? f.done : Promise.resolve('busy');
      const s = this.o.settings();
      // The settings half of `autoTopUpDue` (the balance is re-read inside).
      if (!autoTopUpDue(s, mint, balance ?? (0 as Sats))) return Promise.resolve('not-due');
      if (this.o.wallet() === undefined) return Promise.resolve('not-due');
      const now = this.now();
      if (now < this.notBefore || (this.declined.get(mint) ?? 0) > now)
        return Promise.resolve('backoff');
      const done = this.run(mint)
        .catch((): TopUpOutcome => 'failed')
        .then((out) => {
          this.after(out);
          return out;
        })
        .finally(() => {
          this.flight = null;
        });
      this.flight = { target: mint, done };
      return done;
    } catch {
      return Promise.resolve('failed');
    }
  }

  /**
   * The money plane just paid (or failed to pay, short) for an open play session at `mint`: the
   * mint the next PAY draws from. Reads its balance first, so a not-due PAY never holds the single
   * flight another mint's top-up may need. Never rejects.
   */
  async paymentAt(mint: MintUrl): Promise<TopUpOutcome> {
    try {
      const w = this.o.wallet();
      if (w === undefined || !autoTopUpDue(this.o.settings(), mint, 0 as Sats)) return 'not-due';
      return await this.check(mint, await w.balance(mint));
    } catch {
      return 'failed';
    }
  }

  /** The top-up in flight, if any (tests, shutdown). */
  get inFlight(): Promise<TopUpOutcome> | null {
    return this.flight?.done ?? null;
  }

  /** A wallet-history entry as the user should see it: an auto top-up's funding melt says so. */
  relabel(e: WalletHistoryEntry): WalletHistoryEntry {
    if (e.direction !== 'out' || e.memo !== MELT_MEMO) return e;
    const f = this.meltInFlight;
    const inFlight = f !== null && isNewMelt(e, f);
    return inFlight || this.o.ledger.isTopUpMelt(e.id) ? { ...e, memo: TOP_UP_MEMO } : e;
  }

  /** `relabel` over a wallet change event. */
  relabelChange(e: WalletChangeEvent): WalletChangeEvent {
    return e.type === 'history' ? { type: 'history', entry: this.relabel(e.entry) } : e;
  }

  // ---- the run -----------------------------------------------------------------------------

  private async run(target: MintUrl): Promise<TopUpOutcome> {
    const w = this.o.wallet();
    if (w === undefined) return 'not-due';
    await this.retryUnissued(w);
    const s = this.o.settings();
    const a = s.autoTopUp;
    if (a === undefined) return 'not-due';
    if (!autoTopUpDue(s, target, await w.balance(target))) return 'not-due';
    const amount = topUpAmount(a);
    if (amount === null) return 'refused';
    const from = a.fromMint;
    // Every attempt from here on spaces the next one.
    this.notBefore = this.now() + TOP_UP_MIN_INTERVAL_MS;
    if (!this.o.ledger.fits(amount)) return 'cap';

    if (!this.o.ledger.isAllowed(target)) {
      const yes = await this.ask({ target, source: from, amount: amount as Sats });
      if (!yes) {
        this.declined.set(target, this.now() + TOP_UP_DECLINED_BACKOFF_MS);
        return 'declined';
      }
      try {
        await this.o.ledger.allow(target);
      } catch {
        // Not remembered, nothing moves — and, like a decline, not asked again for the hour (a
        // ledger that cannot be written would otherwise re-ask after every failure backoff).
        this.declined.set(target, this.now() + TOP_UP_DECLINED_BACKOFF_MS);
        return 'failed';
      }
      // The question may have stayed open for minutes: go on only if it is still wanted.
      if (!(await this.stillWanted(w, target, from, amount))) return 'not-due';
    }

    const quote = await w.mintQuote(target, amount as Sats);
    const melt = await w.meltQuote(from, quote.bolt11);
    if (melt.mint !== from || melt.amount !== amount) return 'refused';
    const ppk = await w.inputFeePpk(from);
    if (!Number.isSafeInteger(ppk) || ppk < 0) return 'refused';
    const inputAllowance = Math.ceil((ppk * TOP_UP_INPUT_ALLOWANCE) / 1000);
    if (!Number.isSafeInteger(melt.feeReserve) || melt.feeReserve < 0) return 'refused';
    if (melt.feeReserve + inputAllowance > maxFeeReserve(amount)) return 'refused';
    // Counted toward the daily cap until the melt answers: the amount and every fee it may cost.
    const reserved = amount + melt.feeReserve + inputAllowance;
    if ((await w.balance(from)) < reserved) return 'source-short';
    // The quotes took seconds: the user may have turned it off, changed the source or the amount,
    // taken the target off the list, or signed out meanwhile.
    if (!(await this.stillWanted(w, target, from, amount))) return 'not-due';
    if (!this.o.ledger.fits(reserved)) return 'cap';
    const entry = await this.o.ledger.reserve({ amount, sats: reserved, target, from });

    const before = await this.historyBefore(w, from, amount, reserved);
    const sourceBefore = await balanceOrNull(w, from);
    // The last look, right before the melt (the reservation's write and the reads awaited).
    if (!(await this.stillWanted(w, target, from, amount))) {
      await this.o.ledger.settle(entry, { state: 'failed' }); // nothing moved
      return 'not-due';
    }
    this.meltInFlight = before;
    let paid: { paid: boolean; change: Sats };
    try {
      paid = await w.melt(melt);
    } catch (err) {
      this.meltInFlight = null;
      // Core refuses `insufficient-funds` while choosing proofs, before the mint is asked (input
      // fees on top of amount + reserve): nothing moved. Neither did a melt the money plane's
      // PAY/melt gate refused before it started. Any other failure may have moved sats.
      const short = err instanceof walletMod.WalletError && err.code === 'insufficient-funds';
      const unmoved = short || err instanceof GateRefusal;
      await this.o.ledger.settle(entry, { state: unmoved ? 'failed' : 'unknown' });
      return short ? 'source-short' : 'failed';
    }
    if (!paid.paid) {
      this.meltInFlight = null;
      await this.o.ledger.settle(entry, { state: 'unknown' });
      return 'failed';
    }
    const line = await this.findMelt(w, before);
    this.meltInFlight = null;
    // What left the source: core's history line says (amount + Lightning fee + input fees).
    // Without it, fail safe: the whole reservation, or the source's balance drop when larger
    // (input fees past the allowance; a concurrent spend there over-counts, never under).
    let moved: number;
    if (line !== undefined) moved = Math.max(amount, line.amount);
    else {
      const sourceAfter = await balanceOrNull(w, from);
      const drop =
        sourceBefore !== null && sourceAfter !== null ? sourceBefore - sourceAfter : reserved;
      moved = Math.max(reserved, drop);
    }
    await this.o.ledger.settle(entry, {
      state: 'done',
      sats: moved,
      ...(line === undefined ? {} : { melt: line.id }),
    });
    if (await this.mintAtTarget(w, quote)) return 'done';
    if (this.unissued.length >= MAX_UNISSUED) this.unissued.shift();
    this.unissued.push({ quote, wallet: w });
    this.log.warn('auto top-up paid but not yet minted at the target; retried later');
    return 'failed';
  }

  /**
   * Whether the top-up the run started is still wanted: the same wallet (no sign-out or signer
   * switch — the host reads a closed money plane as no wallet) and the same settings (on, due at
   * `target`, the target on the list, the same source and amount).
   */
  private async stillWanted(
    w: Wallet,
    target: MintUrl,
    from: MintUrl,
    amount: number,
  ): Promise<boolean> {
    if (this.o.wallet() !== w) return false;
    const cur = this.o.settings();
    const a = cur.autoTopUp;
    if (a?.fromMint !== from || topUpAmount(a) !== amount) return false;
    const due = autoTopUpDue(cur, target, await w.balance(target));
    return due && this.o.wallet() === w;
  }

  private async ask(q: FirstFundingQuestion): Promise<boolean> {
    const ask = this.o.askFirstFunding;
    if (ask === undefined) return false;
    try {
      // Exactly `true`, nothing merely truthy.
      const yes: unknown = await ask(q);
      return yes === true;
    } catch {
      return false;
    }
  }

  /** Polls the target's quote; mints when paid. `true` once issued. */
  private async mintAtTarget(w: Wallet, quote: MintQuote): Promise<boolean> {
    const attempts = this.o.pollAttempts ?? TOP_UP_POLL_ATTEMPTS;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await w.pollQuote(quote);
        if (r.state === 'ISSUED') return true;
      } catch {
        // a mint hiccup: poll again
      }
      if (i + 1 < attempts) await this.sleep(this.o.pollIntervalMs ?? TOP_UP_POLL_INTERVAL_MS);
    }
    return false;
  }

  /** Top-ups paid at the source whose target had not minted yet: try once more. */
  private async retryUnissued(w: Wallet): Promise<void> {
    for (const u of [...this.unissued]) {
      if (u.wallet !== w) continue;
      try {
        const r = await w.pollQuote(u.quote);
        if (r.state !== 'ISSUED') continue;
      } catch {
        continue;
      }
      this.unissued.splice(this.unissued.indexOf(u), 1);
      this.log.info('auto top-up minted at the target on retry');
    }
  }

  /** The source mint's recent history before the melt (never rejects). */
  private async historyBefore(w: Wallet, mint: MintUrl, min: number, max: number): Promise<Before> {
    try {
      const h = await w.history({ limit: HISTORY_WINDOW, mint });
      const newest = Math.max(0, ...h.map((e) => e.at));
      return { mint, ids: new Set(h.map((e) => e.id)), newest, min, max };
    } catch {
      return { mint, ids: new Set(), newest: Number.POSITIVE_INFINITY, min, max };
    }
  }

  /** The melt's own history entry (best effort; its amount and the "top-up" label). */
  private async findMelt(
    w: Wallet,
    before: Before,
  ): Promise<{ readonly id: NostrEventId; readonly amount: number } | undefined> {
    try {
      const h = await w.history({ limit: HISTORY_WINDOW, mint: before.mint });
      const found = h.filter(
        (x) =>
          x.direction === 'out' &&
          x.memo === MELT_MEMO &&
          isNewMelt(x, before) &&
          !this.o.ledger.isTopUpMelt(x.id) &&
          isHistoryId(x.id),
      );
      // Exactly one candidate, or none: an ambiguous history labels and counts nothing by it.
      const e = found.length === 1 ? found[0] : undefined;
      return e === undefined ? undefined : { id: e.id, amount: e.amount };
    } catch {
      return undefined;
    }
  }

  /** Backoff bookkeeping and one log line per outcome (refusals throttled). */
  private after(out: TopUpOutcome): void {
    const now = this.now();
    if (out === 'done') {
      this.failures = 0;
      this.log.info('auto top-up done');
      return;
    }
    if (out === 'failed' || out === 'source-short' || out === 'refused') {
      const backoff = Math.min(
        TOP_UP_FAIL_BACKOFF_MS * 2 ** Math.min(this.failures, 16),
        TOP_UP_MAX_BACKOFF_MS,
      );
      this.failures++;
      this.notBefore = Math.max(this.notBefore, now + backoff);
    }
    if (out === 'not-due' || out === 'busy' || out === 'backoff') return;
    const last = this.lastRefusalLog.get(out) ?? 0;
    if (last > 0 && now - last < TOP_UP_REFUSAL_LOG_EVERY_MS) return;
    this.lastRefusalLog.set(out, now);
    this.log.warn('auto top-up not done', { outcome: out });
  }
}

/** `w.balance(mint)`, or `null` when it cannot be read. */
async function balanceOrNull(w: Wallet, mint: MintUrl): Promise<number | null> {
  try {
    const b = await w.balance(mint);
    return Number.isSafeInteger(b) ? b : null;
  } catch {
    return null;
  }
}

/** An entry at `b.mint`, new since `b` was taken, for an amount the top-up's melt can have. */
function isNewMelt(e: WalletHistoryEntry, b: Before): boolean {
  return (
    e.mint === b.mint &&
    !b.ids.has(e.id) &&
    e.at >= b.newest &&
    Number.isSafeInteger(e.amount) &&
    e.amount >= b.min &&
    e.amount <= b.max
  );
}
