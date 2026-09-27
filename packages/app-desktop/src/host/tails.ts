/**
 * Tail authorisations (lane P2-owed-viewer, ADR 0018 amendment 2026-09-26, Cameron): what the
 * money plane lets the worker pay LATER for the blocks of a play session that were still unpaid
 * when it closed — a session closed with a tail its drain could not pay, the app quitting, or the
 * worker gone.
 *
 * A seeder keeps counting blocks we never paid, across our runs; on a later connection it reports
 * them (`OWED`), and the worker pays those its own record says it received, under the id of the
 * session they were received for. A closed session's `pay.build` is then checked against this
 * book exactly like an open session's (`MoneyPlane.payBuild`): the same core, a range inside the
 * same blob, the same manifest terms (creator key, split, block size, mints, a price at most the
 * manifest's), and a block budget — never more than the session had left, never more than the
 * worker said was unpaid at its close (`play.close`; the session's remaining budget when the
 * worker could not say, it was gone), and never more than `MAX_TAIL_BLOCKS`. Each authorisation expires `TAIL_TTL_MS` after its
 * session closed; an expired one pays nothing (the seeder's count of those blocks is then only
 * respected, never paid).
 *
 * Persisted per identity — `<userData>/tails/<pubkey>.json`, a private file (0600 in a 0700
 * directory; a symlink or another user's file is refused and replaced) — so a quit or a crash of
 * the worker does not lose them. A PAY's blocks are taken off the budget ON DISK before the PAY is
 * built (and given back if it fails), so a crash can never leave more authorised than was left.
 * The file is bounded (`MAX_TAILS`, `MAX_TAIL_FILE_BYTES`) and checked entry by entry on load:
 * anything malformed or expired is dropped. It names cores and session ids (viewing history, like
 * the worker's own storage) and no secret; nothing here logs either.
 *
 * One book owns the file at a time (fix round 7): each money plane opens its own, and a plane that
 * closes (signed out, locked, another signer, shutdown) `close`s its book — the writes it started
 * still land, and `flush` waits for them; nothing later writes the file. The next plane's book
 * opens only once those have landed (`DesktopSigner.changed`), so it reads everything the closed
 * one wrote, and from then on it alone writes. Without the fence, a PAY that was waiting for its
 * turn at the mint when the plane closed gave its blocks back at its turn by saving the CLOSED
 * book, erasing whatever the next one had saved since. Those blocks stay off the budget on disk:
 * the conservative side (respected, never paid).
 */
import { join } from 'node:path';

import type { CoreKeyHex, NostrPubkey, PricePolicy } from '@sovit/core';

import { int, isCoreKey, isPricePolicy, isSessionId, obj } from '../ipc/guards.js';
import type { SessionId } from '../ipc/protocol.js';
import type { Logger } from './log.js';
import { ensurePrivateDir, readPrivateFile, writePrivateFile } from './signer/private-file.js';

/** `<userData>/<this>`: the tail authorisations' directory. */
export const TAIL_DIR = 'tails';
/** How long a closed session's tail may still be paid (the worker's record keeps as long). */
export const TAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The most blocks one tail authorises (review finding, lane P2-owed-viewer). The worker's
 * downloader never has more than 1 024 blocks outstanding across all its seeders at once (its
 * credit pool's cap, `MAX_POOL_CREDIT`), so an honest close leaves no larger tail; a larger count
 * (a compromised worker's claim) or an unknown one (the worker gone) is cut to it. Without the
 * cap a closed session kept its whole remaining budget — up to twice its blob — for 7 days.
 */
export const MAX_TAIL_BLOCKS = 1024;
/** Tail authorisations kept per identity (the oldest expiring go first beyond it). */
export const MAX_TAILS = 1024;
/** The largest tail file read (1 024 entries are far below it). */
export const MAX_TAIL_FILE_BYTES = 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;

/** One closed session's tail: what may still be paid for it, and until when. */
export interface TailAuth {
  readonly sid: SessionId;
  readonly core: CoreKeyHex;
  /** The session's blob: first and last block. */
  readonly first: number;
  readonly last: number;
  /** The manifest terms the session was opened with. */
  readonly policy: PricePolicy;
  /** Blocks it may pay for in all. */
  readonly budgetBlocks: number;
  /** Blocks paid (or being paid) under it. */
  paidBlocks: number;
  /** Wall-clock ms after which it pays nothing. */
  readonly expiresAt: number;
}

const isEntry = obj({
  sid: isSessionId,
  core: isCoreKey,
  first: int(0, Number.MAX_SAFE_INTEGER),
  last: int(0, Number.MAX_SAFE_INTEGER),
  policy: isPricePolicy,
  budgetBlocks: int(1, MAX_TAIL_BLOCKS),
  paidBlocks: int(0, Number.MAX_SAFE_INTEGER),
  expiresAt: int(0, Number.MAX_SAFE_INTEGER),
});

export interface TailBookOptions {
  /** The directory (`<userData>/tails`); `null` keeps the book in memory (tests). */
  readonly dir: string | null;
  readonly pubkey: NostrPubkey;
  readonly log: Logger;
  /** Wall clock in ms (default `Date.now`). */
  readonly now?: () => number;
}

export class TailBook {
  private readonly tails = new Map<string, TailAuth>();
  private readonly path: string | null;
  private readonly now: () => number;
  private readonly log: Logger;
  private chain: Promise<void> = Promise.resolve();
  /** Its plane closed: the file is the next book's (see the module comment). */
  private closed = false;

  private constructor(o: TailBookOptions, path: string | null) {
    this.path = path;
    this.now = o.now ?? Date.now;
    this.log = o.log;
  }

  /** The identity's book (a missing file is an empty one; a refused or damaged file too). */
  static async open(o: TailBookOptions): Promise<TailBook> {
    if (!HEX64.test(o.pubkey)) throw new Error('invalid-argument: not a pubkey');
    if (o.dir === null) return new TailBook(o, null);
    await ensurePrivateDir(o.dir, 'the tail directory');
    const book = new TailBook(o, join(o.dir, `${o.pubkey}.json`));
    await book.load();
    return book;
  }

  /**
   * The authorisation for `sid` if it has not expired (an expired one is dropped). Its budget is
   * the caller's to check: a spent one is kept until it expires (a PAY in flight may give blocks
   * back).
   */
  get(sid: string): TailAuth | undefined {
    const t = this.lookup(sid);
    return t === 'expired' ? undefined : t;
  }

  /** Like `get`, but says `'expired'` for one that just expired (dropped now). */
  lookup(sid: string): TailAuth | 'expired' | undefined {
    const t = this.tails.get(sid);
    if (t === undefined) return undefined;
    if (this.now() >= t.expiresAt) {
      this.tails.delete(sid);
      void this.save().catch(() => undefined);
      return 'expired';
    }
    return t;
  }

  /** Keep a closed session's tail (persisted; replaces any earlier one of the same session). */
  add(t: Omit<TailAuth, 'paidBlocks' | 'expiresAt'>): Promise<void> {
    if (this.closed) return Promise.reject(closedError());
    if (!(t.budgetBlocks >= 1) || !isSessionId(t.sid)) return Promise.resolve();
    const budgetBlocks = Math.min(MAX_TAIL_BLOCKS, Math.floor(t.budgetBlocks));
    this.tails.set(t.sid, {
      ...t,
      budgetBlocks,
      paidBlocks: 0,
      expiresAt: this.now() + TAIL_TTL_MS,
    });
    this.prune();
    return this.save();
  }

  /**
   * Write the book as it is now (serialised after any write in flight). Rejects when the write
   * fails (the caller decides what that refuses), and at once, writing nothing, once the book is
   * closed.
   */
  save(): Promise<void> {
    if (this.closed) return Promise.reject(closedError());
    const path = this.path;
    if (path === null) return Promise.resolve();
    const run = this.chain.then(() =>
      writePrivateFile(path, new TextEncoder().encode(this.serialise())),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every write already started has finished (the host's quit waits for it). */
  flush(): Promise<void> {
    return this.chain;
  }

  /**
   * Its plane closed: the writes already started still land (`flush` waits for them, and never
   * waits for more), and every later `add` and `save` rejects, writing nothing — the next plane's
   * book owns the file (see the module comment).
   */
  close(): void {
    this.closed = true;
  }

  /** Diagnostics and tests. */
  size(): number {
    return this.tails.size;
  }

  // ---------------------------------------------------------------- private

  /** Beyond `MAX_TAILS`, the ones expiring first go. Expired ones always go. */
  private prune(): void {
    const now = this.now();
    for (const [sid, t] of this.tails) if (now >= t.expiresAt) this.tails.delete(sid);
    if (this.tails.size <= MAX_TAILS) return;
    const byExpiry = [...this.tails.values()].sort((a, b) => a.expiresAt - b.expiresAt);
    for (const t of byExpiry.slice(0, this.tails.size - MAX_TAILS)) this.tails.delete(t.sid);
  }

  private serialise(): string {
    return JSON.stringify({ v: 1, tails: [...this.tails.values()] });
  }

  private async load(): Promise<void> {
    const path = this.path;
    if (path === null) return;
    let bytes: Uint8Array | null;
    try {
      bytes = await readPrivateFile(path, MAX_TAIL_FILE_BYTES);
    } catch {
      this.log.warn('the tail file is refused (not a private regular file): starting empty');
      return;
    }
    if (bytes === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      this.log.warn('the tail file does not parse: starting empty');
      return;
    }
    const doc = raw as { v?: unknown; tails?: unknown } | null;
    if (doc?.v !== 1 || !Array.isArray(doc.tails)) {
      this.log.warn('the tail file is not one this build reads: starting empty');
      return;
    }
    const now = this.now();
    let dropped = 0;
    for (const e of doc.tails as unknown[]) {
      if (!isEntry(e) || e.last < e.first || e.expiresAt > now + TAIL_TTL_MS + 60_000) {
        dropped++;
        continue;
      }
      if (now >= e.expiresAt || e.paidBlocks > e.budgetBlocks) continue;
      this.tails.set(e.sid, { ...e });
    }
    this.prune();
    if (dropped > 0) this.log.warn('malformed tail authorisations dropped', { dropped });
  }
}

/** A closed book's refusal (never shown: every caller of a late write swallows it). */
function closedError(): Error {
  return new Error('payments-unavailable: the tail book is closed');
}
