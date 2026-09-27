/**
 * UnpaidRecord — the worker's DURABLE record of blocks it received from a seeder and has not paid
 * yet (lane P2-owed-viewer, ADR 0018 amendment 2026-09-26, Cameron: "the seeder reports; the
 * viewer pays — only what its own durable record says it received").
 *
 * A seeder counts every block it sends us until our PAY for it is verified, per OUR pubkey and
 * across its connections and our runs. Blocks left unpaid when a session closes, the app quits or
 * crashes stay counted; on the next connection the seeder reports them (`OWED`). The viewer then
 * pays only the reported blocks that this record says it received from that seeder (by the
 * seeder's HELLO pubkey) on that core, at the terms recorded when it played them — and under the
 * host's authorisation for that session's tail. What the seeder reports beyond the record is
 * respected (never asked beyond its window) and never paid.
 *
 * Per seeder HELLO pubkey:
 *   - `blocks`: per core, the unpaid blocks, each with the session it was received for;
 *   - `full`: the WRITE-AHEAD word `SeederCredit` keeps as its `SeederLedger` — the seeder may
 *     count its whole window against us. It is written, synchronously, before anything is asked
 *     that could bring the seeder there, so after a crash the next run knows to wait for that
 *     seeder's report instead of asking it a block; it is cleared lazily, once what the seeder may
 *     count is below its window (`SeederCredit.seederReach`, at each flush).
 * Per session (`sid`): the terms needed to pay its blocks later — the core, the session's blob
 * range and the manifest policy.
 *
 * DURABILITY. One JSON file per identity (`<dir>/<our pubkey>.json`, 0600), rewritten atomically
 * (`StateFs.writeAtomic`: a temp file, fsync, rename): in batches at most every `FLUSH_MS` while
 * anything changed, at once for a write-ahead `full`, and at close. A crash loses at most the
 * last batch of block entries (those blocks are then respected, not paid) — never a `full`.
 * Lane W8b-p2p (round-8 review): nor a PAY's removal. Blocks a PAY is built for leave the file
 * BEFORE that PAY is sent (`removeNow`, write-ahead): after a crash the record never offers them
 * again, so a seeder that reports what it was already paid for (the ACK lost with the crash) is
 * never paid twice. Only when a removed block is in the file already — blocks received and paid
 * within one batch never were — so most PAYs cost no write.
 *
 * BOUNDS. Blocks and sessions older than `UNPAID_TTL_MS` (the host's tail authorisations expire
 * with them) are dropped at load; a seeder holds at most `MAX_BLOCKS_PER_SEEDER` blocks and the
 * record at most `MAX_SEEDERS` seeders (the least recently touched go first — their blocks are
 * then only respected). A `full` word is kept past the age-out, and the bound takes seeders
 * holding only blocks before any that holds it (independent review): a seeder keeps counting what
 * we forget, and one at its window asked a block before its report would cut and ban us. It goes
 * when the seeder's report says it counts less (the flush), or — only when every seeder beyond the
 * bound holds one — the least recently touched first. The file is local state, still checked
 * field by field on load: anything malformed is dropped, and a file that does not parse starts an
 * empty record (logged, counts only).
 *
 * Nothing here logs a key, a pubkey, a core or a block: counts only.
 */
import type { CoreKeyHex, OwedRange, PricePolicy } from '@sovit/core';
import type { SeederReach } from '@sovit/gateway/upstream';
import type { Logger } from '@sovit/seeder';

import type { StateFs } from '../runtime.js';

/** How long an unpaid block is kept (the host's tail authorisations last as long; a `full` word stays). */
export const UNPAID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Batches are written at most this often while anything changed. */
export const FLUSH_MS = 1000;
/** Blocks recorded per seeder (a seeder's credit is itself capped at 1024 blocks). */
export const MAX_BLOCKS_PER_SEEDER = 1024;
/** Seeders recorded (the least recently touched go first). */
export const MAX_SEEDERS = 512;

const HEX64 = /^[0-9a-f]{64}$/;
const SID = /^[0-9a-f]{32}$/;

/** What paying a block later needs: its session, that session's blob range, the manifest terms. */
export interface TailTerms {
  readonly sid: string;
  readonly core: CoreKeyHex;
  /** The session's blob: first and last block (a PAY never crosses it). */
  readonly first: number;
  readonly last: number;
  readonly policy: PricePolicy;
}

/** A recorded block with its terms. */
export interface RecordedBlock {
  readonly index: number;
  readonly terms: TailTerms;
}

interface SessionTerms extends TailTerms {
  /** When it was first recorded (ms). */
  readonly at: number;
}

interface SeederEntry {
  /** core → block index → sid. */
  readonly blocks: Map<string, Map<number, string>>;
  full: boolean;
  /** Last touched (ms): eviction order, and the `full` word's age. */
  at: number;
}

export interface UnpaidRecordOptions {
  readonly state: StateFs;
  /** The record's directory (created 0700); the file is `<dir>/<pubkey>.json`. */
  readonly dir: string;
  readonly join: (...p: string[]) => string;
  /** Our identity (HELLO pubkey): the seeders count per it, so the record is per it. */
  readonly pubkey: string;
  readonly logger: Logger;
  /** Wall clock in ms (default `Date.now`): entry ages. */
  readonly now?: () => number;
  /** Batch interval (default `FLUSH_MS`; tests shorten it). */
  readonly flushMs?: number;
}

export class UnpaidRecord {
  private readonly o: UnpaidRecordOptions;
  private readonly path: string;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly seeders = new Map<string, SeederEntry>();
  private readonly terms = new Map<string, SessionTerms>();
  /** The `full` words as loaded: what an EARLIER run left (`SeederLedger.fullBefore`). */
  private readonly before = new Set<string>();
  private reach: (() => readonly SeederReach[]) | null = null;
  private dirty = false;
  /**
   * Lane W8b-p2p: blocks (`seeder/core/index`) added since the last write that were not in the
   * record at it — not in the file, so taking one out needs no write-ahead (`removeNow`).
   */
  private readonly unsaved = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Writes that failed (diagnostics). */
  private failures = 0;

  constructor(o: UnpaidRecordOptions) {
    if (!HEX64.test(o.pubkey)) throw new Error('invalid-argument: the record needs a hex pubkey');
    this.o = o;
    this.now = o.now ?? Date.now;
    this.log = o.logger.child({ component: 'unpaid-record' });
    o.state.mkdirp(o.dir);
    this.path = o.join(o.dir, `${o.pubkey}.json`);
    this.load();
    const every = o.flushMs ?? FLUSH_MS;
    const t = setInterval(
      () => {
        this.tick();
      },
      Number.isFinite(every) && every >= 10 ? every : FLUSH_MS,
    );
    (t as { unref?: () => void }).unref?.();
    this.timer = t;
  }

  /** Where `SeederCredit` says what each seeder may count now (the `full` words' lazy clear). */
  attachReach(reach: () => readonly SeederReach[]): void {
    this.reach = reach;
  }

  // ---------------------------------------------------------------- SeederLedger

  fullBefore(pubkey: string): boolean {
    return this.before.has(pubkey);
  }

  full(pubkey: string): boolean {
    return this.seeders.get(pubkey)?.full === true;
  }

  /** Write-ahead: durable before this returns `true`. */
  markFull(pubkey: string): boolean {
    if (this.closed || !HEX64.test(pubkey)) return false;
    const e = this.entry(pubkey);
    if (e.full) return true;
    e.full = true;
    e.at = this.now();
    if (this.write()) return true;
    e.full = false;
    return false;
  }

  // ---------------------------------------------------------------- the record

  /** Block `index` of `core` arrived from `seeder`, unpaid, for the session in `terms`. */
  add(seeder: string, core: string, index: number, terms: TailTerms): void {
    if (this.closed || !HEX64.test(seeder) || !validTerms(terms) || terms.core !== core) return;
    if (!Number.isSafeInteger(index) || index < terms.first || index > terms.last) return;
    const e = this.entry(seeder);
    let m = e.blocks.get(core);
    if (m === undefined) {
      m = new Map();
      e.blocks.set(core, m);
    }
    if (m.get(index) === terms.sid) return;
    const fresh = !m.has(index);
    if (fresh && count(e) >= MAX_BLOCKS_PER_SEEDER) return; // respected, not recorded
    m.set(index, terms.sid);
    // A new block is in no file yet; one re-recorded under another session may be (kept "saved").
    if (fresh) this.unsaved.add(blockKey(seeder, core, index));
    if (!this.terms.has(terms.sid)) this.terms.set(terms.sid, { ...terms, at: this.now() });
    e.at = this.now();
    this.dirty = true;
  }

  /** Blocks `from..to` of `core` from `seeder` were paid, or refused for good: forget them. */
  remove(seeder: string, core: string, from: number, to: number): void {
    this.take(seeder, core, from, to);
  }

  /**
   * Lane W8b-p2p (round-8 review): a PAY was built for blocks `from..to` of `core` from `seeder` —
   * forget them, and when any of them is in the file, write the record NOW, synchronously, before
   * the PAY is sent (write-ahead: a crash after the send never brings them back to be paid
   * twice). Returns `false` only when that write failed (logged and counted; the next batch
   * retries it) — the PAY's proofs are built, so its caller sends it all the same.
   */
  removeNow(seeder: string, core: string, from: number, to: number): boolean {
    if (!this.take(seeder, core, from, to) || this.closed) return true;
    return this.write();
  }

  /**
   * Forget blocks `from..to` of `core` from `seeder`. Returns whether any of them was in the file
   * (recorded before the last write).
   */
  private take(seeder: string, core: string, from: number, to: number): boolean {
    const e = this.seeders.get(seeder);
    const m = e?.blocks.get(core);
    if (e === undefined || m === undefined) return false;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) return false;
    const gone: number[] = [];
    if (to - from < m.size) {
      for (let i = from; i <= to; i++) if (m.delete(i)) gone.push(i);
    } else
      for (const i of [...m.keys()])
        if (i >= from && i <= to) {
          m.delete(i);
          gone.push(i);
        }
    if (m.size === 0) e.blocks.delete(core);
    if (gone.length > 0) this.dirty = true;
    let saved = false;
    // A block not added since the last write is in the file.
    for (const i of gone) if (!this.unsaved.delete(blockKey(seeder, core, i))) saved = true;
    return saved;
  }

  /** The recorded blocks of `core` from `seeder` inside `ranges` (a seeder's `OWED`), ascending. */
  recorded(seeder: string, core: string, ranges: readonly OwedRange[]): RecordedBlock[] {
    const m = this.seeders.get(seeder)?.blocks.get(core);
    if (m === undefined) return [];
    const out: RecordedBlock[] = [];
    for (const [index, sid] of m) {
      const t = this.terms.get(sid);
      if (t === undefined || !inRanges(ranges, index)) continue;
      out.push({ index, terms: t });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /** The terms block `index` of `core` from `seeder` was recorded at (`null`: not recorded). */
  termsOf(seeder: string, core: string, index: number): TailTerms | null {
    const sid = this.seeders.get(seeder)?.blocks.get(core)?.get(index);
    return sid === undefined ? null : (this.terms.get(sid) ?? null);
  }

  /** Blocks recorded for session `sid`, whichever seeder (a closing session's unpaid tail). */
  unpaidFor(sid: string): number {
    let n = 0;
    for (const e of this.seeders.values())
      for (const m of e.blocks.values()) for (const s of m.values()) if (s === sid) n++;
    return n;
  }

  /** Diagnostics and tests: seeders, blocks, sessions, `full` words, failed writes. */
  stats(): {
    readonly seeders: number;
    readonly blocks: number;
    readonly sessions: number;
    readonly full: number;
    readonly failures: number;
  } {
    let blocks = 0;
    let full = 0;
    for (const e of this.seeders.values()) {
      blocks += count(e);
      if (e.full) full++;
    }
    return {
      seeders: this.seeders.size,
      blocks,
      sessions: this.terms.size,
      full,
      failures: this.failures,
    };
  }

  /** Write now if anything changed (the batch). Returns whether the file is current. */
  flush(): boolean {
    if (this.closed) return false;
    this.refreshFull();
    if (!this.dirty) return true;
    return this.write();
  }

  /** The last write (quit, shutdown); nothing more is recorded afterwards. */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Stop writing without a last write (a test's "crash": what the last write recorded is what the
   * next run finds).
   */
  abandon(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------- private

  private tick(): void {
    if (this.closed) return;
    this.flush();
  }

  /** Clear `full` where what the seeder may count is below its window; set it where it is not. */
  private refreshFull(): void {
    const reach = this.reach;
    if (reach === null) return;
    let list: readonly SeederReach[];
    try {
      list = reach();
    } catch {
      return; // keep every word as it is
    }
    for (const r of list) {
      if (!HEX64.test(r.pubkey)) continue;
      const window = Math.max(1, r.window);
      const full = r.reach >= window;
      const e = this.seeders.get(r.pubkey);
      if (e === undefined) {
        if (!full) continue;
        this.entry(r.pubkey).full = true;
        this.dirty = true;
        continue;
      }
      if (e.full !== full) {
        e.full = full;
        if (full) e.at = this.now();
        this.dirty = true;
      }
    }
  }

  private entry(pubkey: string): SeederEntry {
    let e = this.seeders.get(pubkey);
    if (e === undefined) {
      e = { blocks: new Map(), full: false, at: this.now() };
      this.seeders.set(pubkey, e);
      // Never the entry just made: its caller is about to fill it (a block, a `full` word).
      this.evict(pubkey);
    }
    return e;
  }

  /**
   * Beyond `MAX_SEEDERS`: the least recently touched seeder holding only blocks goes first; a
   * `full` word only when every other seeder holds one (see the header).
   */
  private evict(keep?: string): void {
    while (this.seeders.size > MAX_SEEDERS) {
      let oldest: string | null = null;
      let oldestFull: string | null = null;
      let at = Number.POSITIVE_INFINITY;
      let atFull = Number.POSITIVE_INFINITY;
      for (const [pk, e] of this.seeders) {
        if (pk === keep) continue;
        if (!e.full && e.at < at) {
          at = e.at;
          oldest = pk;
        } else if (e.full && e.at < atFull) {
          atFull = e.at;
          oldestFull = pk;
        }
      }
      const gone = oldest ?? oldestFull;
      if (gone === null) return;
      const e = this.seeders.get(gone);
      for (const [core, m] of e?.blocks ?? [])
        for (const i of m.keys()) this.unsaved.delete(blockKey(gone, core, i));
      this.seeders.delete(gone);
      this.dirty = true;
    }
  }

  /** Synchronous atomic rewrite. `false` (logged, counted) when it fails. */
  private write(): boolean {
    let text: string;
    try {
      text = this.serialise();
    } catch {
      this.failures++;
      return false;
    }
    try {
      this.o.state.writeAtomic(this.path, text);
      this.dirty = false;
      this.unsaved.clear(); // every block in memory is in the file now
      return true;
    } catch {
      this.failures++;
      this.log.warn('the unpaid record could not be written', { failures: this.failures });
      return false;
    }
  }

  private serialise(): string {
    const used = new Set<string>();
    const seeders: Record<string, unknown> = {};
    for (const [pk, e] of this.seeders) {
      const cores: Record<string, [number, number, string][]> = {};
      for (const [core, m] of e.blocks) {
        const runs = toRuns(m);
        if (runs.length === 0) continue;
        cores[core] = runs;
        for (const r of runs) used.add(r[2]);
      }
      if (Object.keys(cores).length === 0 && !e.full) continue;
      seeders[pk] = { full: e.full, at: e.at, blocks: cores };
    }
    const terms: Record<string, unknown> = {};
    for (const [sid, t] of this.terms) {
      if (!used.has(sid)) continue;
      terms[sid] = { core: t.core, first: t.first, last: t.last, policy: t.policy, at: t.at };
    }
    // Sessions nobody refers to any more are gone from memory too.
    for (const sid of [...this.terms.keys()]) if (!used.has(sid)) this.terms.delete(sid);
    return JSON.stringify({ v: 1, seeders, terms });
  }

  private load(): void {
    let text: string | null;
    try {
      text = this.o.state.readText(this.path);
    } catch {
      this.log.warn('the unpaid record could not be read: starting empty');
      return;
    }
    if (text === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.log.warn('the unpaid record is not valid JSON: starting empty');
      return;
    }
    const doc = raw as { v?: unknown; seeders?: unknown; terms?: unknown } | null;
    if (doc?.v !== 1 || !isRecord(doc.seeders) || !isRecord(doc.terms)) {
      this.log.warn('the unpaid record is not one this build reads: starting empty');
      return;
    }
    const now = this.now();
    const fresh = (at: unknown): at is number =>
      typeof at === 'number' &&
      Number.isFinite(at) &&
      at <= now + 60_000 &&
      now - at < UNPAID_TTL_MS;
    for (const [sid, x] of Object.entries(doc.terms)) {
      if (!SID.test(sid) || !isRecord(x) || !fresh(x['at'])) continue;
      const terms = {
        sid,
        core: x['core'],
        first: x['first'],
        last: x['last'],
        policy: x['policy'],
      };
      if (!validTerms(terms)) continue;
      this.terms.set(sid, { ...terms, at: x['at'] });
    }
    let dropped = 0;
    for (const [pk, x] of Object.entries(doc.seeders)) {
      if (!HEX64.test(pk) || !isRecord(x)) {
        dropped++;
        continue;
      }
      const at = x['at'];
      const full = x['full'] === true;
      // A `full` word outlives the age-out (see the header): kept, with no blocks, when old.
      if (!fresh(at) && !full) {
        dropped++;
        continue;
      }
      const e: SeederEntry = {
        blocks: new Map(),
        full,
        at: typeof at === 'number' && Number.isFinite(at) ? Math.min(at, now) : now,
      };
      const blocks = fresh(at) ? x['blocks'] : undefined;
      if (isRecord(blocks))
        for (const [core, runs] of Object.entries(blocks)) {
          if (!HEX64.test(core) || !Array.isArray(runs)) continue;
          const m = new Map<number, string>();
          for (const r of runs as unknown[]) {
            if (!Array.isArray(r) || r.length !== 3) continue;
            const [f, l, sid] = r as [unknown, unknown, unknown];
            if (!isCount(f) || !isCount(l) || typeof sid !== 'string') continue;
            const t = this.terms.get(sid);
            if (t?.core !== core || f > l || f < t.first || l > t.last) continue;
            for (let i = f; i <= l && m.size < MAX_BLOCKS_PER_SEEDER; i++) m.set(i, sid);
          }
          if (m.size > 0) e.blocks.set(core, m);
        }
      if (e.blocks.size === 0 && !e.full) continue;
      if (e.full) this.before.add(pk);
      this.seeders.set(pk, e);
    }
    this.evict();
    const s = this.stats();
    if (s.seeders > 0 || dropped > 0)
      this.log.info('unpaid record loaded', {
        seeders: s.seeders,
        blocks: s.blocks,
        full: s.full,
        dropped,
      });
  }
}

/** A block's key in `unsaved`. */
function blockKey(seeder: string, core: string, index: number): string {
  return `${seeder}/${core}/${String(index)}`;
}

function count(e: SeederEntry): number {
  let n = 0;
  for (const m of e.blocks.values()) n += m.size;
  return n;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function inRanges(ranges: readonly OwedRange[], i: number): boolean {
  for (const r of ranges) if (i >= r[0] && i <= r[1]) return true;
  return false;
}

/** Ascending runs of consecutive blocks with one sid: `[from, to, sid]`. */
function toRuns(m: ReadonlyMap<number, string>): [number, number, string][] {
  const sorted = [...m].sort((a, b) => a[0] - b[0]);
  const runs: [number, number, string][] = [];
  for (const [i, sid] of sorted) {
    const last = runs[runs.length - 1];
    if (last?.[2] === sid && last[1] === i - 1) last[1] = i;
    else runs.push([i, i, sid]);
  }
  return runs;
}

/**
 * Terms this record will keep: a session id, a core, a blob range and a manifest policy. Checked
 * on what it is given and on what it reads back from disk alike (the file is local, still
 * checked).
 */
function validTerms(t: unknown): t is TailTerms {
  if (!isRecord(t)) return false;
  const { sid, core, first, last, policy } = t;
  if (typeof sid !== 'string' || !SID.test(sid)) return false;
  if (typeof core !== 'string' || !HEX64.test(core)) return false;
  if (!isCount(first) || !isCount(last) || last < first) return false;
  if (!isRecord(policy)) return false;
  const { satsPerBlock, blockSize, mints, creatorP2pk, split } = policy;
  return (
    isCount(satsPerBlock) &&
    isCount(blockSize) &&
    Array.isArray(mints) &&
    mints.every((m) => typeof m === 'string') &&
    typeof creatorP2pk === 'string' &&
    isRecord(split) &&
    isCount(split['seeder']) &&
    isCount(split['creator'])
  );
}

/** A safe integer ≥ 0. */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
