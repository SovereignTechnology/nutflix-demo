/**
 * The payment engine's durable state (security review F12, and the seen set):
 *
 *   - `pending.jsonl` — every accepted PAY not yet redeemed or nutzapped, as an APPEND-ONLY
 *     journal (`PendingJournal`): one line per PAY added or gone, fsynced before the engine's
 *     synchronous `persistPending` hook returns (so before the ACK), compacted when it grows past
 *     a few times the live queue. It replaces `pending.json`, rewritten whole on every change —
 *     quadratic disk traffic while a mint is down and the queue grows (the seeder-runtime review's
 *     residual); an old `pending.json` is migrated at start. The proofs are spendable by this
 *     seeder and the creator, so the file is 0600, and a journal that does not parse (beyond a
 *     torn last line) stops the daemon rather than being dropped.
 *   - `seen.jsonl` (+ `seen.jsonl.1`) — accepted proof secrets, one JSON string per line,
 *     appended as they are accepted and rotated every `capacity` lines. A cache: after a restart
 *     a replayed PAY is refused at `verify` instead of one flush later at the mint. An unreadable
 *     line is skipped.
 *
 * Node only; reachable from `cli/providers.ts`, never from `portable.ts`.
 */
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';

import type { payment } from '@sovit/core';

import { JournalReadError, PendingJournalCore, replayJournal } from '../payment/pending-journal.js';

import {
  RuntimeSetupError,
  assertPrivateSync,
  readTextIfExistsSync,
  writeFileAtomicSync,
} from './files.js';

type PendingPay = payment.PendingPay;

const PENDING_FORMAT = 'nutflix-seeder-pending';

/** Read `pending.json`. Missing → none; present but unreadable → refuse to start. */
export function loadPending(path: string): PendingPay[] {
  assertPrivateSync(path, 'the pending-PAY file');
  const text = readTextIfExistsSync(path);
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const o = raw as { format?: unknown; v?: unknown; items?: unknown } | null;
  if (o?.format !== PENDING_FORMAT || o.v !== 1 || !Array.isArray(o.items))
    throw new RuntimeSetupError(
      `the pending-PAY file ${path} is unreadable — refusing to start rather than drop accepted payments`,
    );
  // Each item is re-checked by `RealPaymentEngine.restorePending` (it is untrusted input there).
  return o.items as PendingPay[];
}

export { JOURNAL_COMPACT_FACTOR } from '../payment/pending-journal.js';

/**
 * The accepted-but-unflushed PAYs as an append-only journal (see the module comment). `items`
 * is what was on disk at open; `persist` is the engine's `persistPending` hook.
 */
export class PendingJournal {
  private fd = -1;
  private readonly core: PendingJournalCore;

  private constructor(
    private readonly path: string,
    readonly items: readonly PendingPay[],
    private readonly onError: (err: unknown) => void,
  ) {
    this.core = new PendingJournalCore(
      {
        append: (text) => {
          writeAll(this.fd, text);
          fsyncSync(this.fd);
        },
        // Rewrite atomically as just the live PAYs, then keep appending to the new file.
        rewrite: (text) => {
          this.close();
          writeFileAtomicSync(this.path, text);
          this.fd = openSync(this.path, 'a', 0o600);
        },
      },
      items,
    );
  }

  /**
   * Load the journal at `path` (migrating `legacyPath`, the old whole-file snapshot, if it is
   * still there). Unreadable → refuse to start.
   */
  static open(path: string, legacyPath: string, onError: (err: unknown) => void): PendingJournal {
    let items: PendingPay[];
    const journal = readTextIfExistsSync(path);
    if (journal !== null) {
      assertPrivateSync(path, 'the pending-PAY journal');
      items = replay(path, journal);
    } else {
      items = readTextIfExistsSync(legacyPath) === null ? [] : loadPending(legacyPath);
    }
    const j = new PendingJournal(path, items, onError);
    // A fresh compacted journal: the loaded state, fsynced, before anything else is accepted.
    j.core.compact();
    if (readTextIfExistsSync(legacyPath) !== null) unlinkSync(legacyPath);
    return j;
  }

  /** How many PAYs the journal holds. */
  get size(): number {
    return this.core.size;
  }

  /** `persistPending`: append what changed since the last snapshot, fsync, compact if due. */
  readonly persist = (items: readonly PendingPay[]): void => {
    try {
      this.core.persist(items);
    } catch (err) {
      this.onError(err);
      throw err;
    }
  };

  close(): void {
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }
}

/** The PAYs a journal file holds (read-only; tests and diagnostics). Unreadable → throws. */
export function readPendingJournal(path: string): PendingPay[] {
  const text = readTextIfExistsSync(path);
  return text === null ? [] : replay(path, text);
}

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** Replay a journal (`replayJournal`); unreadable → refuse to start, naming the file. */
function replay(path: string, text: string): PendingPay[] {
  try {
    return replayJournal(text);
  } catch (err) {
    if (!(err instanceof JournalReadError)) throw err;
    throw new RuntimeSetupError(
      `the pending-PAY journal ${path} is unreadable — refusing to start rather than drop accepted payments`,
    );
  }
}

/**
 * The engine's `persistPending` hook: a durable snapshot before the ACK goes out. The engine
 * swallows a hook's exception (a failing disk must not stop payments), so `onError` is where a
 * failed write becomes visible. Superseded by `PendingJournal` (kept for its tests and callers
 * that want a single snapshot file).
 */
export function pendingWriter(
  path: string,
  onError: (err: unknown) => void,
): (items: readonly PendingPay[]) => void {
  return (items) => {
    try {
      writeFileAtomicSync(path, JSON.stringify({ format: PENDING_FORMAT, v: 1, items }));
    } catch (err) {
      onError(err);
      throw err;
    }
  };
}

/**
 * The seen-secret log: `seen.jsonl`, rotated to `seen.jsonl.1` every `capacity` lines, so the disk
 * holds at most ~2 × `capacity` secrets however long the daemon runs (a busy seeder accepts
 * hundreds of secrets a second). `load()` returns the newest `capacity` of both files; `append` is
 * the `SeenSecrets` `persist` hook.
 */
export class SeenLog {
  private lines = 0;

  constructor(
    private readonly path: string,
    private readonly capacity: number,
    private readonly onError: (err: unknown) => void,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('seen log: capacity must be a positive integer');
  }

  private get previous(): string {
    return `${this.path}.1`;
  }

  private read(path: string): { secrets: string[]; lines: number } {
    assertPrivateSync(path, 'the seen-secrets file');
    const text = readTextIfExistsSync(path);
    if (text === null) return { secrets: [], lines: 0 };
    const lines = text.split('\n').filter((l) => l.length > 0);
    const secrets: string[] = [];
    for (const line of lines) {
      try {
        const v: unknown = JSON.parse(line);
        if (typeof v === 'string' && v.length > 0) secrets.push(v);
      } catch {
        // a torn last line after a crash, or damage: the mint still catches a replay
      }
    }
    return { secrets, lines: lines.length };
  }

  /** The newest `capacity` secrets on disk (oldest first, as `SeenSecrets.restore` wants them). */
  load(): string[] {
    const older = this.read(this.previous);
    const current = this.read(this.path);
    this.lines = current.lines;
    if (this.lines >= this.capacity) this.rotate();
    return [...older.secrets, ...current.secrets].slice(-this.capacity);
  }

  /**
   * The `persist` hook: append each batch, JSON-encoded so no secret spans lines. It runs inside
   * `verify`; a failed write is reported and never thrown — the set is a cache.
   */
  readonly append = (secrets: readonly string[]): void => {
    try {
      appendFileSync(this.path, secrets.map((x) => JSON.stringify(x)).join('\n') + '\n', {
        mode: 0o600,
      });
      this.lines += secrets.length;
      if (this.lines >= this.capacity) this.rotate();
    } catch (err) {
      this.onError(err);
    }
  };

  private rotate(): void {
    renameSync(this.path, this.previous); // atomic; replaces the older generation
    this.lines = 0;
  }
}
