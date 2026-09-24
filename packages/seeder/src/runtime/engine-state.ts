/**
 * The payment engine's durable state (security review F12, and the seen set):
 *
 *   - `pending.json` — every accepted PAY not yet redeemed or nutzapped. The engine's
 *     `persistPending` hook is SYNCHRONOUS and runs before the ACK, so this is a synchronous
 *     atomic write (`writeFileAtomicSync`): once a viewer is told "paid", its proofs are on disk.
 *     The proofs are spendable by this seeder and the creator, so the file is 0600 and a file that
 *     does not parse stops the daemon rather than being dropped.
 *   - `seen.jsonl` (+ `seen.jsonl.1`) — accepted proof secrets, one JSON string per line,
 *     appended as they are accepted and rotated every `capacity` lines. A cache: after a restart
 *     a replayed PAY is refused at `verify` instead of one flush later at the mint. An unreadable
 *     line is skipped.
 *
 * Node only; reachable from `cli/providers.ts`, never from `portable.ts`.
 */
import { appendFileSync, renameSync } from 'node:fs';

import type { payment } from '@sovit/core';

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

/**
 * The engine's `persistPending` hook: a durable snapshot before the ACK goes out. The engine
 * swallows a hook's exception (a failing disk must not stop payments), so `onError` is where a
 * failed write becomes visible.
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
