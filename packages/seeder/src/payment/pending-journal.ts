/**
 * The accepted-but-unflushed PAYs as an APPEND-ONLY journal — the runtime-neutral part, shared
 * by the seeder daemon (`runtime/engine-state.ts`, Node fs) and the desktop worker (Bare,
 * `StateFs`). ADR 0011 §12.
 *
 *   - One line per PAY added (`{"a": …}`) or gone (`{"d": key}`), after a header line. It is
 *     appended durably before the engine's synchronous `persistPending` hook returns, so before
 *     the ACK.
 *   - Compacted (rewritten atomically as just the live PAYs) once it holds more than
 *     `JOURNAL_COMPACT_FACTOR` lines per live PAY (and at least 64). Disk traffic stays
 *     proportional to changes, not to the queue: a whole-file rewrite per change is quadratic
 *     while a mint is down and the queue grows.
 *   - A torn LAST line is a crash mid-append and is skipped. Any other damage throws
 *     `JournalReadError`: the caller refuses to start rather than drop accepted payments.
 *
 * No I/O here: the caller passes `append` (durable) and `rewrite` (atomic, durable).
 */
import type { payment } from '@sovit/core';

type PendingPay = payment.PendingPay;

export const JOURNAL_FORMAT = 'nutflix-seeder-pending-journal';
/** Compact once the journal holds more than this many lines per live PAY (and at least 64). */
export const JOURNAL_COMPACT_FACTOR = 4;

/** A journal that does not replay (beyond a torn last line). */
export class JournalReadError extends Error {
  override readonly name = 'JournalReadError';
}

/**
 * Which PAY a journal line is about. The first proof secrets make it unique (a secret is accepted
 * once); stage and flags are part of it, so a PAY that moves on (redeem → nutzap, a redeem tried)
 * is one removal plus one addition.
 */
export function journalKey(p: PendingPay): string {
  const s = p.msg.seederProofs.proofs[0]?.secret ?? '';
  const c = p.msg.creatorProofs.proofs[0]?.secret ?? '';
  const r = p.msg.range;
  return [
    p.peer,
    r.core,
    `${String(r.fromBlock)}-${String(r.toBlock)}`,
    p.stage,
    p.creatorChecked === true ? 'c' : '',
    p.redeemTried === true ? 't' : '',
    s,
    c,
  ].join('|');
}

/** The journal as just `items` (what a compaction writes). */
export function journalText(items: Iterable<PendingPay>): string {
  let text = `${JSON.stringify({ format: JOURNAL_FORMAT, v: 1 })}\n`;
  for (const it of items) text += `${JSON.stringify({ a: it })}\n`;
  return text;
}

/**
 * Replay a journal's text into the PAYs it holds. Each item is re-checked by
 * `RealPaymentEngine.restorePending` (untrusted input there).
 */
export function replayJournal(text: string): PendingPay[] {
  const refuse = (): never => {
    throw new JournalReadError('the pending-PAY journal is unreadable');
  };
  const rows = text.split('\n');
  const last = rows.length - 1;
  const live = new Map<string, PendingPay>();
  let header = false;
  for (const [i, row] of rows.entries()) {
    if (row === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(row);
    } catch {
      // A crash mid-append leaves an UNTERMINATED last line; a bad line followed by a newline is
      // corruption, never a torn write.
      if (i === last) continue;
      return refuse();
    }
    const o = v as { format?: unknown; v?: unknown; a?: unknown; d?: unknown } | null;
    if (!header) {
      if (o?.format !== JOURNAL_FORMAT || o.v !== 1) return refuse();
      header = true;
      continue;
    }
    if (typeof o?.d === 'string') live.delete(o.d);
    else if (typeof o?.a === 'object' && o.a !== null) {
      let k: string;
      try {
        k = journalKey(o.a as PendingPay);
      } catch {
        return refuse();
      }
      live.set(k, o.a as PendingPay);
    } else return refuse();
  }
  return header ? [...live.values()] : refuse();
}

/** Where the journal's bytes go. Both must be durable (fsynced) before returning. */
export interface JournalIo {
  /** Append `text` to the journal. */
  append(text: string): void;
  /** Replace the journal with `text`, atomically. */
  rewrite(text: string): void;
}

/**
 * The journal's state machine: what is live, how many lines are on disk, when to compact. The
 * constructor does not write: call `compact()` once at open (a fresh journal of the loaded
 * state, before anything else is accepted).
 */
export class PendingJournalCore {
  private live = new Map<string, PendingPay>();
  private lines = 0;

  constructor(
    private readonly io: JournalIo,
    items: readonly PendingPay[],
  ) {
    for (const it of items) this.live.set(journalKey(it), it);
  }

  /** How many PAYs the journal holds. */
  get size(): number {
    return this.live.size;
  }

  /** `persistPending`: append what changed since the last snapshot, compact if due. Throws. */
  persist(items: readonly PendingPay[]): void {
    const next = new Map<string, PendingPay>();
    for (const it of items) next.set(journalKey(it), it);
    let out = '';
    let n = 0;
    for (const k of this.live.keys())
      if (!next.has(k)) {
        out += `${JSON.stringify({ d: k })}\n`;
        n++;
      }
    for (const [k, it] of next)
      if (!this.live.has(k)) {
        out += `${JSON.stringify({ a: it })}\n`;
        n++;
      }
    this.live = next;
    if (n === 0) return;
    if (this.lines + n > Math.max(64, JOURNAL_COMPACT_FACTOR * next.size)) {
      this.compact();
      return;
    }
    this.io.append(out);
    this.lines += n;
  }

  /** Rewrite the journal as just the live PAYs. */
  compact(): void {
    this.io.rewrite(journalText(this.live.values()));
    this.lines = this.live.size;
  }
}
