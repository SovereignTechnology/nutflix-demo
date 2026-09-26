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
 *      counted (its sats may have left) — except a refusal that provably sent nothing to the
 *      mint's melt endpoint (`meltSentNothing`: core's `insufficient-funds` and its other checks
 *      before the request, and the money plane's PAY/melt gate refusing it — `GateRefusal`: a PAY
 *      at the source mint was still being built; ADR 0012 amendment 2026-09-25). What a paid melt
 *      moved is read from its own history line; without one, the whole reservation counts, or the
 *      source's balance drop when that is larger (input fees past the allowance — core does not
 *      say up front how many inputs it will spend).
 *
 * Open top-ups (cross-lane review round 4, money high): the target's quote is kept — sealed to
 * the identity, on the ledger entry (`./open-topup.ts`, `TopUpLedger.attach`) — BEFORE the melt,
 * and stays kept whenever the melt may have paid it (it threw ambiguously, answered PENDING, or
 * paid before the target minted). Whoever runs next with that identity's wallet — this run's
 * retry, the next trigger, a new wallet after a lock/unlock or a signer swap, the next start —
 * finishes it first (`resolveOpen`): minted exactly once when the target says PAID (core's
 * journaled `pollQuote`), released only once the melt is settled as not paid (no journal entry
 * left, the source mint's own quote state UNPAID) while the quote is still UNPAID. No new top-up
 * runs into a target with one open (`unresolved`). When the journal settles the melt as paid, its
 * history line is found by the anchor the record keeps and reads "top-up"; the entry says `done`.
 * Every run waits for the money plane's startup settle first (what a crash cut off at the target
 * is restored before its balance is read).
 *
 * History (NIP-60 kind 7376): minting at the target already writes `in … "top-up"` and the melt
 * writes `out … "melt to Lightning"` at the source — nothing more is written (no double entry).
 * Core's melt takes no memo (contracts `Wallet.melt`; docs/contract-requests/S3-topup.md), so the
 * host shows that melt as "top-up" (`relabel`), by the history id the ledger recorded.
 *
 * A play at zero balance waits for its top-up at most `PLAY_TOP_UP_WAIT_MS` once past the
 * first-funding question (`checkForPlay`); a slower one finishes in the background.
 *
 * Logs carry outcome codes and numbers only — never a mint URL, a quote, an invoice or a proof.
 */
import type {
  MeltQuote,
  MintQuote,
  MintUrl,
  NostrEventId,
  NostrPubkey,
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
import type { LedgerEntry, TopUpLedger } from './ledger.js';
import { MAX_OPEN_TOP_UPS, isHistoryId } from './ledger.js';
import type { OpenTopUp } from './open-topup.js';
import { MAX_ANCHOR_IDS, parseOpenTopUp, serializeOpenTopUp } from './open-topup.js';

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
/** Open top-ups are finished at a trigger at most this often (each run finishes them first). */
export const TOP_UP_RESOLVE_EVERY_MS = 30_000;
/**
 * A play at zero balance waits at most this long for its top-up once past the first-funding
 * question (which the user answers in main's window, bounded by its own deadline): quotes, a melt
 * (up to 300 s) and the target's polls may take minutes; a fast Lightning top-up takes seconds.
 * Past it the play fails `no-balance` and the top-up finishes in the background.
 */
export const PLAY_TOP_UP_WAIT_MS = 15_000;
/** How much of the source mint's history is compared around the melt. */
const HISTORY_WINDOW = MAX_ANCHOR_IDS;
/** How far back the source's history is searched for a melt the journal settled later. */
const SETTLED_WINDOW = 100;
/** The memo core writes for a melt (`wallet/spend.ts`); the one the host relabels. */
const MELT_MEMO = 'melt to Lightning';
/**
 * Every memo core writes for a melt (`wallet/spend.ts`): answered, then settled by the journal
 * after a lost or PENDING answer (with change restored, or with none due).
 */
const MELT_MEMOS: ReadonlySet<string> = new Set([
  MELT_MEMO,
  'melt to Lightning (change recovered)',
  'melt to Lightning (settled after the answer, no change)',
]);
export const TOP_UP_MEMO = 'top-up';

/**
 * Core's melt refusals thrown BEFORE its request to the mint's melt endpoint (`wallet/spend.ts`:
 * the melt quote could not be read, the mint changed its amount or raised its fee reserve since
 * the quote was shown, an earlier melt of this quote is still unresolved), by code and message.
 * A message that changes reads as "may have run" — fail closed.
 */
const BEFORE_THE_REQUEST: readonly (readonly [walletMod.WalletErrorCode, string])[] = [
  ['mint-error', 'melt quote lookup failed ('],
  ['bad-mint-response', 'the mint changed the melt amount since the quote was shown'],
  ['bad-mint-response', 'the mint asks a larger fee reserve than the quote that was shown'],
  ['mint-error', 'an earlier melt of this quote is still unresolved at the mint'],
];

/**
 * Whether a melt's failure provably sent nothing to the mint's melt endpoint (round 4, info): the
 * PAY/melt gate refused it before it started, core refused it while choosing proofs
 * (`insufficient-funds`), or one of core's checks before the request (`BEFORE_THE_REQUEST`).
 * Everything else — a coded refusal after the request (core words it like a melt that may have
 * run), a lost answer, a commit that failed after the mint paid — is not provable: `false`.
 */
export function meltSentNothing(err: unknown): boolean {
  if (err instanceof GateRefusal) return true;
  if (!(err instanceof walletMod.WalletError)) return false;
  if (err.code === 'insufficient-funds') return true;
  return BEFORE_THE_REQUEST.some(
    ([code, prefix]) => err.code === code && err.message.startsWith(`${code}: ${prefix}`),
  );
}

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
  /**
   * An earlier top-up into this mint is still open (its melt's outcome unknown, or paid and not
   * minted yet): it is finished first, nothing new moves (round 4).
   */
  | 'unresolved'
  | 'failed'
  | 'done';

export interface FirstFundingQuestion {
  readonly target: MintUrl;
  readonly source: MintUrl;
  readonly amount: Sats;
}

/**
 * What the money plane holding a wallet lends its top-ups besides the wallet (`MoneyPlane.
 * topUpVault`, round 4).
 */
export interface TopUpVault {
  /** The identity (Nostr pubkey) the wallet belongs to: only it finishes its open top-ups. */
  readonly owner: NostrPubkey;
  /** Seal `plain` to the identity (NIP-44 to self through its signer), and open it again. */
  seal(plain: string): Promise<string>;
  unseal(sealed: string): Promise<string>;
  /** Whether the wallet's journal still holds a melt of `quoteId` at `mint` (outcome unknown). */
  meltPending(mint: MintUrl, quoteId: string): Promise<boolean>;
  /** The mint's own state of its melt quote `quoteId` (NUT-05, read only). */
  meltState(mint: MintUrl, quoteId: string): Promise<MeltQuote['state']>;
  /** The plane's startup settle of the journal: a run reads no balance before it is over. */
  recovery(): Promise<unknown>;
}

export interface AutoTopUpOptions {
  readonly settings: () => Settings;
  /**
   * The user's REAL wallet right now — the money plane's own, per signer (`undefined`: none —
   * signed out, locked, `--dev-mocks`). A run keeps the one it started with.
   */
  readonly wallet: () => Wallet | undefined;
  /**
   * The vault of the money plane whose live wallet is `w`; `undefined` otherwise. Without one
   * nothing moves (an open top-up could not be kept).
   */
  readonly vault: (w: Wallet) => TopUpVault | undefined;
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
  /** A play's wait for its top-up past the question (default `PLAY_TOP_UP_WAIT_MS`). */
  readonly playWaitMs?: number;
}

interface Flight {
  readonly target: MintUrl;
  readonly done: Promise<TopUpOutcome>;
  /** Resolved once the run is past the first-funding question (or asked none). */
  readonly asked: Promise<void>;
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
   * Open top-ups already unsealed, for this wallet only (a new wallet — a lock/unlock, a signer
   * swap — unseals them again with its own plane).
   */
  private opened: { readonly wallet: Wallet; readonly byEntry: Map<string, OpenTopUp> } | null =
    null;
  /** Open top-ups being finished at a trigger (a run waits for it). */
  private resolving: Promise<void> | null = null;
  /** When open top-ups were last finished at a trigger, and with which wallet. */
  private lastResolve: { readonly wallet: Wallet | null; readonly at: number } = {
    wallet: null,
    at: Number.NEGATIVE_INFINITY,
  };
  /** An open top-up that could not be read was logged (once per run of the host). */
  private unreadableLogged = false;
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
      // Every trigger finishes open top-ups first (paced; never awaited here): also when the
      // top-up is off now, or the target recovered another way — they are the user's sats.
      void this.resolveSoon();
      const s = this.o.settings();
      // The settings half of `autoTopUpDue` (the balance is re-read inside).
      if (!autoTopUpDue(s, mint, balance ?? (0 as Sats))) return Promise.resolve('not-due');
      if (this.o.wallet() === undefined) return Promise.resolve('not-due');
      const now = this.now();
      if (now < this.notBefore || (this.declined.get(mint) ?? 0) > now)
        return Promise.resolve('backoff');
      let pastQuestion: () => void = () => undefined;
      const asked = new Promise<void>((resolve) => {
        pastQuestion = resolve;
      });
      const done = this.run(mint, pastQuestion)
        .catch((): TopUpOutcome => 'failed')
        .then((out) => {
          this.after(out);
          return out;
        })
        .finally(() => {
          pastQuestion();
          this.flight = null;
        });
      this.flight = { target: mint, done, asked };
      return done;
    } catch {
      return Promise.resolve('failed');
    }
  }

  /**
   * A play about to open at zero balance (round 4, info): the identity's open top-ups are finished
   * first (one may hold the sats this play needs), then `check` — each waited for at most
   * `playWaitMs`, the run's wait starting once past the first-funding question (the user's own,
   * bounded by the prompt's deadline). `in-flight`: still running (the play fails `no-balance`
   * and may be retried; the top-up goes on). Never rejects.
   */
  async checkForPlay(mint: MintUrl): Promise<TopUpOutcome | 'in-flight'> {
    const waitMs = this.o.playWaitMs ?? PLAY_TOP_UP_WAIT_MS;
    if ((await within(this.resolveSoon(), Promise.resolve(), waitMs)) === 'late')
      return 'in-flight';
    const done = this.check(mint, 0 as Sats);
    const f = this.flight;
    if (f?.target !== mint) return done;
    const out = await within(done, f.asked, waitMs);
    return out === 'late' ? 'in-flight' : out;
  }

  /**
   * A money plane just opened (the host's start, an unlock, a signer swap): finish its identity's
   * open top-ups now, once its startup settle is over. Never rejects.
   */
  resume(): Promise<void> {
    return this.resolveSoon(true);
  }

  /**
   * The money plane just paid (or failed to pay, short) for an open play session at `mint`: the
   * mint the next PAY draws from. Reads its balance first, so a not-due PAY never holds the single
   * flight another mint's top-up may need. Never rejects.
   */
  async paymentAt(mint: MintUrl): Promise<TopUpOutcome> {
    try {
      void this.resolveSoon();
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
    if (e.direction !== 'out' || e.memo === undefined || !MELT_MEMOS.has(e.memo)) return e;
    const f = this.meltInFlight;
    const inFlight = e.memo === MELT_MEMO && f !== null && isNewMelt(e, f);
    return inFlight || this.o.ledger.isTopUpMelt(e.id) ? { ...e, memo: TOP_UP_MEMO } : e;
  }

  /** `relabel` over a wallet change event. */
  relabelChange(e: WalletChangeEvent): WalletChangeEvent {
    return e.type === 'history' ? { type: 'history', entry: this.relabel(e.entry) } : e;
  }

  // ---- the run -----------------------------------------------------------------------------

  private async run(target: MintUrl, pastQuestion: () => void): Promise<TopUpOutcome> {
    const w = this.o.wallet();
    if (w === undefined) return 'not-due';
    const v = this.o.vault(w);
    if (v === undefined) return 'not-due';
    // Round 4 (info): what a crash cut off (a top-up minting at the target) is restored first.
    await settledQuietly(v.recovery());
    if (this.o.wallet() !== w) return 'not-due';
    // Round 4 (money high): this identity's open top-ups first — retry the old quote, never
    // start a second top-up into a target whose first may still be paid.
    await settledQuietly(this.resolving);
    await this.resolveOpen(w, v);
    if (this.o.ledger.hasOpen(v.owner, target)) {
      this.notBefore = this.now() + TOP_UP_MIN_INTERVAL_MS;
      return 'unresolved';
    }
    const s = this.o.settings();
    const a = s.autoTopUp;
    if (a === undefined) return 'not-due';
    if (!autoTopUpDue(s, target, await w.balance(target))) return 'not-due';
    const amount = topUpAmount(a);
    if (amount === null) return 'refused';
    const from = a.fromMint;
    // Every attempt from here on spaces the next one.
    this.notBefore = this.now() + TOP_UP_MIN_INTERVAL_MS;
    if (!this.o.ledger.fits(amount) || this.o.ledger.openCount() >= MAX_OPEN_TOP_UPS) return 'cap';

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
    pastQuestion();

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
    // Round 4 (money high): the target's quote is kept — sealed to this identity, on disk —
    // BEFORE the melt, so whatever becomes of the melt a later run can mint what it paid.
    const open: OpenTopUp = {
      quote,
      melt: { mint: from, quoteId: melt.quoteId },
      before: Number.isFinite(before.newest)
        ? { newest: before.newest, ids: [...before.ids] }
        : null,
    };
    try {
      await this.o.ledger.attach(entry, {
        owner: v.owner,
        open: await v.seal(serializeOpenTopUp(open)),
      });
    } catch {
      await this.o.ledger.settle(entry, { state: 'failed' }); // nothing moved
      return 'failed';
    }
    this.openedFor(w).set(entry, open);
    // The last look, right before the melt (the reservation's write and the reads awaited).
    if (!(await this.stillWanted(w, target, from, amount))) {
      await this.close(w, entry, { state: 'failed' }); // nothing moved
      return 'not-due';
    }
    this.meltInFlight = before;
    let paid: { paid: boolean; change: Sats };
    try {
      paid = await w.melt(melt);
    } catch (err) {
      this.meltInFlight = null;
      // Refused before the request reached the mint's melt endpoint (core's checks, the PAY/melt
      // gate): nothing moved, and nothing can pay the quote. Any other failure may have moved
      // sats — counted, and the quote stays open until the melt's outcome is known.
      const short = err instanceof walletMod.WalletError && err.code === 'insufficient-funds';
      if (meltSentNothing(err)) {
        await this.close(w, entry, { state: 'failed' });
        return short ? 'source-short' : 'failed';
      }
      await this.o.ledger.settle(entry, { state: 'unknown' });
      this.log.warn('auto top-up melt outcome unknown; its quote is kept until it is');
      return 'failed';
    }
    if (!paid.paid) {
      // Journaled PENDING (the Lightning payment in flight), or not paid: the quote stays open.
      this.meltInFlight = null;
      await this.o.ledger.settle(entry, { state: 'unknown' });
      this.log.warn('auto top-up melt not paid yet; its quote is kept until it is settled');
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
    if (await this.mintAtTarget(w, quote)) {
      await this.close(w, entry, { state: 'done' });
      return 'done';
    }
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

  /**
   * At a trigger (paced by `TOP_UP_RESOLVE_EVERY_MS` per wallet unless `force`), finish the live
   * identity's open top-ups — never beside a run (it finishes them first). Never rejects.
   */
  private resolveSoon(force = false): Promise<void> {
    try {
      if (this.resolving !== null) return this.resolving;
      if (this.flight !== null) return Promise.resolve();
      const w = this.o.wallet();
      const v = w === undefined ? undefined : this.o.vault(w);
      if (w === undefined || v === undefined) return Promise.resolve();
      if (this.o.ledger.openEntries(v.owner).length === 0) return Promise.resolve();
      const now = this.now();
      const last = this.lastResolve;
      if (!force && last.wallet === w && now < last.at + TOP_UP_RESOLVE_EVERY_MS)
        return Promise.resolve();
      this.lastResolve = { wallet: w, at: now };
      const run = (async (): Promise<void> => {
        await settledQuietly(v.recovery());
        if (this.o.wallet() === w) await this.resolveOpen(w, v);
      })()
        .catch(() => undefined)
        .finally(() => {
          this.resolving = null;
        });
      this.resolving = run;
      return run;
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Round 4 (money high): finish `v.owner`'s open top-ups with `w`. Each is minted once its target
   * says PAID (`pollQuote` mints it — journaled by core, so a lost answer is restored, never minted
   * twice), or released once the melt is settled as not paid while the quote is still UNPAID.
   * Anything else — a mint that cannot be asked, a melt still pending, a record that does not
   * open — leaves it open for the next time. Never rejects.
   */
  private async resolveOpen(w: Wallet, v: TopUpVault): Promise<void> {
    for (const e of this.o.ledger.openEntries(v.owner)) {
      if (this.o.wallet() !== w) return; // a sign-out or signer swap: its own wallet finishes it
      try {
        const open = await this.openRecord(w, v, e);
        if (open === null) continue;
        if (e.minted === true) {
          // Minted already: only the melt's history line is left to find, once it is settled.
          if (!(await v.meltPending(open.melt.mint, open.melt.quoteId)))
            await this.labelled(w, e, open);
          continue;
        }
        const r = await w.pollQuote(open.quote);
        if (r.state === 'ISSUED') {
          this.log.info('auto top-up minted at the target on retry');
          // Its melt still unresolved at the source (the target had the payment first): the
          // entry stays open, minted, until the journal settles the melt and its line is found.
          if (e.melt === undefined && (await v.meltPending(open.melt.mint, open.melt.quoteId)))
            await this.o.ledger.settle(e.id, { state: 'done', minted: true });
          else await this.labelled(w, e, open);
          continue;
        }
        // UNPAID. A melt that paid (`done`) will reach the target: keep polling it.
        if (r.state !== 'UNPAID' || e.state === 'done') continue;
        // Released only when the melt can no longer pay it: nothing journaled at the source, and
        // the source mint's own quote UNPAID (PAID and PENDING are not; UNPAID after the target
        // read UNPAID means the melt never paid before it either).
        if (await v.meltPending(open.melt.mint, open.melt.quoteId)) continue;
        if ((await v.meltState(open.melt.mint, open.melt.quoteId)) !== 'UNPAID') continue;
        // Still counted (the melt reached the mint; its inputs may have been lost there).
        await this.close(w, e.id, { state: e.state === 'failed' ? 'failed' : 'unknown' });
        this.log.info('auto top-up melt not paid: its quote is released');
      } catch {
        // a mint, the signer or the ledger could not answer: next time
      }
    }
  }

  /**
   * A minted top-up whose melt is settled: `done`, labelled by the melt's history line when it is
   * found (what left the source counted then), and no longer open.
   */
  private async labelled(w: Wallet, e: LedgerEntry, open: OpenTopUp): Promise<void> {
    const line = e.melt === undefined ? await this.findMelt(w, anchorOf(open, e), true) : undefined;
    await this.close(w, e.id, {
      state: 'done',
      ...(line === undefined ? {} : { melt: line.id, sats: Math.max(e.amount, line.amount) }),
    });
  }

  /** End entry `id`'s open top-up (the ledger) and forget its unsealed record. */
  private async close(
    w: Wallet,
    id: string,
    patch: {
      readonly state: 'done' | 'unknown' | 'failed';
      readonly sats?: number;
      readonly melt?: NostrEventId;
    },
  ): Promise<void> {
    this.openedFor(w).delete(id);
    await this.o.ledger.settle(id, { ...patch, open: null });
  }

  /** The unsealed records of `w` (a new wallet starts empty: its plane unseals them again). */
  private openedFor(w: Wallet): Map<string, OpenTopUp> {
    if (this.opened?.wallet !== w) this.opened = { wallet: w, byEntry: new Map() };
    return this.opened.byEntry;
  }

  /** Entry `e`'s open top-up, unsealed by `v`; `null` when it does not open (it stays kept). */
  private async openRecord(w: Wallet, v: TopUpVault, e: LedgerEntry): Promise<OpenTopUp | null> {
    const cached = this.openedFor(w).get(e.id);
    if (cached !== undefined) return cached;
    if (e.open === undefined) return null;
    let open: OpenTopUp | null;
    try {
      open = parseOpenTopUp(await v.unseal(e.open));
    } catch {
      open = null;
    }
    // Exactly this entry's top-up, or nothing (a swapped record is never minted or released).
    if (
      open === null ||
      open.quote.mint !== e.target ||
      open.melt.mint !== e.from ||
      open.quote.amount !== e.amount
    ) {
      if (!this.unreadableLogged) {
        this.unreadableLogged = true;
        this.log.warn('an open auto top-up could not be read; it is kept');
      }
      return null;
    }
    this.openedFor(w).set(e.id, open);
    return open;
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

  /**
   * The melt's own history entry (best effort; its amount and the "top-up" label). `settled`: the
   * line the journal wrote when it settled the melt later (any of core's melt memos, further back).
   */
  private async findMelt(
    w: Wallet,
    before: Before | null,
    settled = false,
  ): Promise<{ readonly id: NostrEventId; readonly amount: number } | undefined> {
    if (before === null) return undefined;
    try {
      const h = await w.history({
        limit: settled ? SETTLED_WINDOW : HISTORY_WINDOW,
        mint: before.mint,
      });
      const found = h.filter(
        (x) =>
          x.direction === 'out' &&
          x.memo !== undefined &&
          (settled ? MELT_MEMOS.has(x.memo) : x.memo === MELT_MEMO) &&
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
    // `unresolved` backs off nothing (the old quote is retried at the next trigger), but logs.
    const last = this.lastRefusalLog.get(out) ?? 0;
    if (last > 0 && now - last < TOP_UP_REFUSAL_LOG_EVERY_MS) return;
    this.lastRefusalLog.set(out, now);
    this.log.warn('auto top-up not done', { outcome: out });
  }
}

/**
 * `p`, or `'late'` when it has not settled `ms` after `from` resolved (an unref'd timer, cleared
 * once either wins).
 */
async function within<T>(p: Promise<T>, from: Promise<void>, ms: number): Promise<T | 'late'> {
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = from.then(
    () =>
      new Promise<'late'>((resolve) => {
        if (over) return;
        timer = setTimeout(() => {
          resolve('late');
        }, ms);
        timer.unref();
      }),
  );
  try {
    return await Promise.race([p, late]);
  } finally {
    over = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Waits for `p` to settle, whichever way (never rejects). */
async function settledQuietly(p: Promise<unknown> | null): Promise<void> {
  try {
    await p;
  } catch {
    // its outcome is its owner's
  }
}

/**
 * An open top-up's anchor as a `Before` (its melt's line: new since then, at the source, for
 * between the amount and the reservation), or `null` when the history was not read then.
 */
function anchorOf(open: OpenTopUp, e: LedgerEntry): Before | null {
  if (open.before === null) return null;
  return {
    mint: open.melt.mint,
    ids: new Set(open.before.ids),
    newest: open.before.newest,
    min: e.amount,
    max: Math.max(e.amount, e.sats),
  };
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
