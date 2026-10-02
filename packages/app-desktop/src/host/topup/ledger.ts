/**
 * The auto top-up ledger (issue #2, security review F4): what auto top-ups moved in the last
 * 24 hours, what is in flight, and which mints the user has allowed to be funded unattended.
 * Persisted in userData `auto-topup.json` (the settings file's atomic `JsonFile`, mode 0600) so
 * the caps survive a restart.
 *
 * Fail CLOSED, never open:
 *   - a missing file is a first run (nothing moved, nothing allowed);
 *   - a file that is unreadable, not JSON, too large, of an unknown version or with any key or
 *     value out of shape is NEVER read as "missing": it is copied aside to `<name>.corrupt` and
 *     replaced by a ledger that records the whole daily cap as used NOW (`state: 'closed'`) and no
 *     allowed mints — auto top-ups stop for 24 hours and the first-funding question is asked again;
 *     if even that cannot be written, every top-up is refused for the rest of the run;
 *   - a reservation or an allowance that cannot be persisted refuses the top-up before anything
 *     moves; a settlement that cannot be persisted leaves the (larger) reservation on disk;
 *   - an entry whose outcome is unknown (a melt that failed or was not paid, a host that died
 *     mid-flight) keeps counting for its 24 hours;
 *   - an entry dated in the future (clock set back) still counts; more than
 *     `MAX_LEDGER_ENTRIES` entries in the window reads as the cap reached.
 *
 * The funding melts' wallet-history ids (the "top-up" label, `isTopUpMelt`) are kept in a list of
 * their own, bounded to the newest `MAX_TOP_UP_MELTS` and never pruned by the 24-hour window, so
 * this device keeps showing yesterday's top-up as one (independent review, finding 2).
 *
 * An OPEN top-up (cross-lane review round 4, money high): the target mint's quote of a top-up
 * whose melt may have paid it, or paid it before the target minted, is kept on its entry until it
 * is minted, provably unpaid, or (round 5) still unpaid a day after its invoice expired — `open`,
 * sealed to the identity that owns it (`owner`) by the
 * money plane (NIP-44 to self through the signer, how the NIP-60 proofs are kept): a quote the
 * mint did not lock to the wallet key (NUT-20; a signer-held key cannot lock one) is bearer money
 * once paid, whoever holds its id mints it. An entry with an open top-up is never pruned by the
 * window (it stops counting after 24 h like any other); at most `MAX_OPEN_TOP_UPS` are open.
 *
 * Nothing here logs a mint URL, an amount beyond the numbers, or anything secret.
 */
import { randomBytes } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MintUrl, NostrEventId, NostrPubkey } from '@sovit/core';
import { AUTO_TOP_UP_MAX_SATS_PER_DAY } from '@sovit/core';

import type { Guard } from '../../ipc/guards.js';
import { arrayOf, int, literal, matches, obj, oneOf } from '../../ipc/guards.js';
import { LIMITS } from '../../ipc/protocol.js';
import type { Logger } from '../log.js';
import { JsonFile } from '../settings/json-file.js';

export const TOP_UP_LEDGER_FILE = 'auto-topup.json';
const FILE_V = 1 as const;
/** The rolling window of the daily cap. */
export const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * More entries than this inside the window reads as the cap reached (fail closed; the host spaces
 * top-ups at least a minute apart, so a real day holds at most 1 440).
 */
export const MAX_LEDGER_ENTRIES = 2000;
/** The most one entry may count (twice the daily cap: any entry at the ceiling closes the day). */
const MAX_ENTRY_SATS = AUTO_TOP_UP_MAX_SATS_PER_DAY * 2;
/** Most mints remembered as allowed (the Settings mint list has the same cap). */
const MAX_ALLOWED = LIMITS.maxArray;
/**
 * Funding-melt history ids remembered for the "top-up" label, newest last; the oldest drops out
 * beyond this (a label, not a cap: losing one only shows an old top-up as "melt to Lightning").
 */
export const MAX_TOP_UP_MELTS = 256;
/**
 * Open top-ups kept at once (every identity together): one per target and identity at most, as
 * no new top-up runs into a target with one open. A reservation beyond this is refused.
 */
export const MAX_OPEN_TOP_UPS = 16;
/**
 * The longest sealed open top-up the file keeps: a NIP-44 payload of a record of at most ~7 KB
 * (`open-topup.ts` bounds its invoice); 16 of them keep the file far under its 1 MiB.
 */
const MAX_OPEN_CHARS = 16_384;

/**
 * `pending`  reserved, the melt not yet answered (counts its reservation);
 * `done`     paid and minted, or paid and not yet minted (counts what left the source mint);
 * `unknown`  the melt failed or was not paid: the sats may have left (counts its reservation);
 * `failed`   refused before anything moved (counts nothing);
 * `closed`   the marker a corrupt ledger was replaced by (counts the whole daily cap).
 */
export type LedgerState = 'pending' | 'done' | 'unknown' | 'failed' | 'closed';

export interface LedgerEntry {
  /** 16 hex characters. */
  readonly id: string;
  /** Wall-clock milliseconds when the entry was made. */
  readonly at: number;
  /** What counts toward the daily cap: the reservation (amount + fee reserve) or what moved. */
  readonly sats: number;
  /** The top-up amount (minted at the target); 0 for the `closed` marker. */
  readonly amount: number;
  readonly state: LedgerState;
  readonly target?: MintUrl;
  readonly from?: MintUrl;
  /** The funding melt's wallet-history id (NIP-60 kind 7376), shown as "top-up". */
  readonly melt?: NostrEventId;
  /** The identity whose wallet ran it (hex): only that identity finishes its open top-up. */
  readonly owner?: NostrPubkey;
  /**
   * The open top-up, sealed to `owner` (see the header); absent once it is finished — minted and
   * its melt's history line found (or the melt settled without one), or released.
   */
  readonly open?: string;
  /**
   * Minted at the target while its melt was still unresolved at the source: kept open only to
   * find the melt's history line once the journal settles it (the "top-up" label); it no longer
   * holds back a new top-up.
   */
  readonly minted?: true;
  /**
   * R5-R1 (Cameron, 2026-10-02: waive, keep watching): the user resumed auto top-ups into this
   * entry's target, in main's native confirm, while the open top-up was held. It no longer holds
   * back a new top-up, but it stays open and is still finished like any other — minted when the
   * target says PAID, released by the same rules — so a quote the target still owes is never
   * forfeited. It keeps counting toward `MAX_OPEN_TOP_UPS`.
   */
  readonly waived?: true;
}

interface LedgerRequired {
  readonly v: typeof FILE_V;
  readonly allowed: readonly MintUrl[];
  readonly entries: readonly LedgerEntry[];
}

interface LedgerOptional {
  /**
   * The funding melts' history ids, newest last, at most `MAX_TOP_UP_MELTS`, outside the rolling
   * window. Always written; optional on read (a file from before the list existed has none).
   */
  readonly melts: readonly NostrEventId[];
}

type LedgerFile = LedgerRequired & Partial<LedgerOptional>;

/**
 * A mint URL the ledger will store: printable ASCII `http(s)://…`, bounded. Looser than the
 * Settings guard (`https:` only) so the opt-in real-mint test's local mints persist too; harmless,
 * because entries are only ever compared by exact string with the (guarded) Settings mints.
 * Anything else is refused before it is written, so the ledger can never corrupt itself.
 */
export const isLedgerMint = matches(
  /^https?:\/\/[\x21-\x7e]+$/,
  LIMITS.maxServerUrl,
) as Guard<MintUrl>;

/**
 * A wallet-history id the ledger will store: a NIP-60 event id (64 hex) or an in-memory store's
 * label. Anything else is never written, so the ledger can never corrupt itself.
 */
export const isHistoryId = matches(/^[0-9A-Za-z_-]{1,64}$/, 64) as Guard<NostrEventId>;

/** An identity the ledger stores (a Nostr pubkey, 64 lowercase hex). */
const isOwner = matches(/^[0-9a-f]{64}$/, 64) as Guard<NostrPubkey>;
/** A sealed open top-up (NIP-44 payloads are base64), bounded. */
const isSealed = matches(/^[A-Za-z0-9+/=]+$/, MAX_OPEN_CHARS);

const isEntry: Guard<LedgerEntry> = obj(
  {
    id: matches(/^[0-9a-f]{16}$/, 16),
    at: int(0, Number.MAX_SAFE_INTEGER),
    sats: int(0, MAX_ENTRY_SATS),
    amount: int(0, LIMITS.maxAutoTopUpAmountSats),
    state: oneOf(['pending', 'done', 'unknown', 'failed', 'closed'] as const),
  },
  {
    target: isLedgerMint,
    from: isLedgerMint,
    melt: isHistoryId,
    owner: isOwner,
    open: isSealed,
    minted: literal(true),
    waived: literal(true),
  },
);

const isLedgerFile: Guard<LedgerFile> = obj<LedgerRequired, LedgerOptional>(
  {
    v: literal(FILE_V),
    allowed: arrayOf(isLedgerMint, MAX_ALLOWED),
    // The window's entries plus the open top-ups older than it.
    entries: arrayOf(isEntry, MAX_LEDGER_ENTRIES + MAX_OPEN_TOP_UPS),
  },
  { melts: arrayOf(isHistoryId, MAX_TOP_UP_MELTS) },
);

/** The numbers of a reservation fit the file's own bounds (so writing it cannot corrupt it). */
function isEntryAmount(e: { readonly amount: number; readonly sats: number }): boolean {
  return (
    Number.isSafeInteger(e.amount) &&
    e.amount >= 1 &&
    e.amount <= LIMITS.maxAutoTopUpAmountSats &&
    Number.isSafeInteger(e.sats) &&
    e.sats >= e.amount &&
    e.sats <= MAX_ENTRY_SATS
  );
}

/** `raw` → a ledger, or `null` for anything not exactly one (never throws). */
export function parseLedger(raw: unknown): LedgerFile | null {
  try {
    return isLedgerFile(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Whether an entry counts toward the daily cap. */
function counts(e: LedgerEntry): boolean {
  return e.state !== 'failed';
}

export class TopUpLedger {
  private readonly file: JsonFile<LedgerFile>;
  private readonly log: Logger;
  private readonly now: () => number;
  private allowed: readonly MintUrl[] = [];
  private entries: readonly LedgerEntry[] = [];
  /** Funding-melt history ids, newest last (never pruned by the window; bounded). */
  private melts: readonly NostrEventId[] = [];
  /** The corrupt-ledger marker could not be written: refuse everything this run. */
  private hardClosed = false;

  private constructor(userData: string, log: Logger, now: () => number) {
    this.log = log;
    this.now = now;
    this.file = new JsonFile(join(userData, TOP_UP_LEDGER_FILE), parseLedger, log, {
      moveAsideCorrupt: false,
    });
  }

  /** Reads (or, when corrupt, replaces) the ledger. Never throws. */
  static async open(
    userData: string,
    log: Logger,
    now: () => number = Date.now,
  ): Promise<TopUpLedger> {
    const l = new TopUpLedger(userData, log.child('topup-ledger'), now);
    await l.load();
    return l;
  }

  private async load(): Promise<void> {
    let r: Awaited<ReturnType<JsonFile<LedgerFile>['load']>>;
    try {
      r = await this.file.load();
    } catch {
      r = { kind: 'corrupt', reason: 'unreadable' };
    }
    if (r.kind === 'missing') return;
    if (r.kind === 'ok') {
      this.allowed = r.value.allowed;
      this.entries = r.value.entries;
      this.melts = r.value.melts ?? [];
      return;
    }
    // Fail closed: the cap reads as reached for 24 h, and nothing is remembered as allowed.
    this.log.warn('the auto top-up ledger is unreadable: auto top-ups pause for 24 hours');
    try {
      await copyFile(this.file.path, `${this.file.path}.corrupt`);
    } catch {
      // Could not keep a copy; the marker below still fails closed.
    }
    const marker: LedgerEntry = {
      id: newId(),
      at: this.now(),
      sats: AUTO_TOP_UP_MAX_SATS_PER_DAY,
      amount: 0,
      state: 'closed',
    };
    this.allowed = [];
    this.entries = [marker];
    this.melts = [];
    try {
      await this.file.save({ v: FILE_V, allowed: [], entries: [marker], melts: [] });
    } catch {
      this.hardClosed = true;
      this.log.error('the auto top-up ledger cannot be replaced (auto top-ups stay off this run)');
    }
  }

  /** Entries inside the rolling window (a future-dated one included). */
  private window(now: number): LedgerEntry[] {
    return this.entries.filter((e) => e.at > now - DAY_MS);
  }

  /** Sats counted toward the daily cap right now: what moved plus everything in flight. */
  used(now: number = this.now()): number {
    if (this.hardClosed) return AUTO_TOP_UP_MAX_SATS_PER_DAY;
    let n = 0;
    for (const e of this.window(now)) if (counts(e)) n += e.sats;
    return n;
  }

  /** Whether `sats` more fit under the daily cap now. */
  fits(sats: number, now: number = this.now()): boolean {
    if (this.hardClosed) return false;
    if (this.window(now).length >= MAX_LEDGER_ENTRIES) return false;
    return this.used(now) + sats <= AUTO_TOP_UP_MAX_SATS_PER_DAY;
  }

  /** The user said yes to funding `mint` unattended (persisted). */
  isAllowed(mint: MintUrl): boolean {
    return !this.hardClosed && this.allowed.includes(mint);
  }

  /** Remember an explicit yes for `mint`. Rejects (and remembers nothing) when it cannot persist. */
  async allow(mint: MintUrl): Promise<void> {
    if (this.hardClosed) throw new Error('ledger closed');
    if (!isLedgerMint(mint)) throw new Error('not a mint URL the ledger stores');
    if (this.allowed.includes(mint)) return;
    const allowed = [...this.allowed, mint].slice(-MAX_ALLOWED);
    this.entries = await this.persist(allowed, this.entries);
    this.allowed = allowed;
  }

  /**
   * Reserve `sats` for a top-up before anything moves. Rejects — and nothing may move — when the
   * reservation does not fit or cannot be persisted.
   */
  async reserve(e: {
    readonly amount: number;
    readonly sats: number;
    readonly target: MintUrl;
    readonly from: MintUrl;
  }): Promise<string> {
    const now = this.now();
    if (!this.fits(e.sats, now)) throw new Error('over the daily cap');
    if (!isLedgerMint(e.target) || !isLedgerMint(e.from) || !isEntryAmount(e))
      throw new Error('not an entry the ledger stores');
    const entry: LedgerEntry = { id: newId(), at: now, state: 'pending', ...e };
    // Only once it is on disk does it count here — and only then may anything move.
    this.entries = await this.persist(this.allowed, [...this.entries, entry]);
    return entry.id;
  }

  /**
   * Keep reservation `id`'s top-up open (the target's quote, sealed to `owner`) — before its melt
   * runs. Rejects, and keeps nothing, when it cannot be persisted, would not be stored as it is,
   * or `MAX_OPEN_TOP_UPS` are open already: the caller then moves nothing.
   */
  async attach(
    id: string,
    o: { readonly owner: NostrPubkey; readonly open: string },
  ): Promise<void> {
    if (this.hardClosed) throw new Error('ledger closed');
    if (!isOwner(o.owner) || !isSealed(o.open))
      throw new Error('not an open top-up the ledger stores');
    if (this.openCount() >= MAX_OPEN_TOP_UPS) throw new Error('too many open top-ups');
    const entries = this.entries.map((e) =>
      e.id === id ? { ...e, owner: o.owner, open: o.open } : e,
    );
    if (!entries.some((e) => e.id === id)) throw new Error('no such reservation');
    // Only once it is on disk may the melt run.
    this.entries = await this.persist(this.allowed, entries);
  }

  /** How many top-ups are open (every identity). */
  openCount(): number {
    return this.entries.filter((e) => e.open !== undefined).length;
  }

  /** `owner`'s open top-ups, oldest first (all of them: the window does not end one). */
  openEntries(owner: NostrPubkey): readonly LedgerEntry[] {
    return this.entries.filter((e) => e.open !== undefined && e.owner === owner);
  }

  /** Whether `owner` has an open top-up into `target` not minted yet, and not waived (R5-R1). */
  hasOpen(owner: NostrPubkey, target: MintUrl): boolean {
    return this.openEntries(owner).some(
      (e) => e.target === target && e.minted !== true && e.waived !== true,
    );
  }

  /**
   * R5-R1: `owner`'s open top-up `id` stops holding back its target (see `LedgerEntry.waived`).
   * Only once that is on disk does it count here; rejects, and changes nothing, when it cannot be
   * persisted or `id` is not one of `owner`'s open, unminted top-ups.
   */
  async waive(id: string, owner: NostrPubkey): Promise<void> {
    if (this.hardClosed) throw new Error('ledger closed');
    const e = this.entries.find((x) => x.id === id);
    if (e?.open === undefined || e.owner !== owner || e.minted === true)
      throw new Error('no such open top-up');
    if (e.waived === true) return;
    const entries = this.entries.map((x) => (x.id === id ? { ...x, waived: true as const } : x));
    this.entries = await this.persist(this.allowed, entries);
  }

  /**
   * Record how reservation `id` ended. Applied in memory first (this run counts it at once); a
   * failed write is logged and leaves the reservation on disk, which counts at least as much.
   * `open: null` ends its open top-up (finished, or provably unpaid); so does `failed` (nothing
   * moved, so nothing can pay the quote). `minted: true` marks it minted, still open.
   */
  async settle(
    id: string,
    patch: {
      readonly state: Exclude<LedgerState, 'pending' | 'closed'>;
      readonly sats?: number;
      readonly melt?: NostrEventId;
      readonly open?: null;
      readonly minted?: true;
    },
  ): Promise<void> {
    const melt = patch.melt !== undefined && isHistoryId(patch.melt) ? patch.melt : undefined;
    if (melt !== undefined && !this.melts.includes(melt))
      this.melts = [...this.melts, melt].slice(-MAX_TOP_UP_MELTS);
    const close = patch.open === null || patch.state === 'failed';
    this.entries = this.entries.map((e) => {
      if (e.id !== id) return e;
      // Never lower a count below the amount that reached (or may have reached) the target, and
      // never write a number the file's own guard would refuse (a self-corrupted ledger would
      // fail closed for a day): the ceiling is already twice the daily cap.
      const want = patch.sats === undefined ? e.sats : Math.max(patch.sats, e.amount);
      const sats = Number.isSafeInteger(want) ? Math.min(want, MAX_ENTRY_SATS) : MAX_ENTRY_SATS;
      const { open, minted, waived, ...rest } = e;
      const keep = !close && open !== undefined;
      return {
        ...rest,
        state: patch.state,
        sats,
        ...(melt === undefined ? {} : { melt }),
        ...(keep ? { open } : {}),
        ...(keep && (minted === true || patch.minted === true) ? { minted: true as const } : {}),
        ...(keep && waived === true ? { waived: true as const } : {}),
      };
    });
    try {
      this.entries = await this.persist(this.allowed, this.entries);
    } catch {
      this.log.error('an auto top-up could not be recorded (its reservation still counts)');
    }
  }

  /**
   * Whether `historyId` is the melt that funded an auto top-up — also after its entry left the
   * rolling window (the bounded `melts` list).
   */
  isTopUpMelt(historyId: string): boolean {
    return (
      this.melts.includes(historyId as NostrEventId) ||
      this.entries.some((e) => e.melt === historyId)
    );
  }

  /**
   * Writes the ledger, keeping the rolling window of entries and every open top-up (the bounded
   * melt-id list is written whole); resolves the entries written.
   */
  private async persist(
    allowed: readonly MintUrl[],
    entries: readonly LedgerEntry[],
  ): Promise<readonly LedgerEntry[]> {
    const now = this.now();
    const kept = entries.filter((e) => e.at > now - DAY_MS || e.open !== undefined);
    await this.file.save({ v: FILE_V, allowed, entries: kept, melts: this.melts });
    return kept;
  }

  /** Tests: the in-memory entries. */
  snapshot(): { readonly allowed: readonly MintUrl[]; readonly entries: readonly LedgerEntry[] } {
    return { allowed: this.allowed, entries: this.entries };
  }

  /** Tests: the funding-melt ids kept for the "top-up" label. */
  topUpMelts(): readonly NostrEventId[] {
    return this.melts;
  }
}

function newId(): string {
  return randomBytes(8).toString('hex');
}
