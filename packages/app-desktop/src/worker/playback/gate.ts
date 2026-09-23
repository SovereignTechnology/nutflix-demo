/**
 * PlaybackGate — "pause/prefetch in the worker" (design §1) for ONE play session.
 *
 * `hypercore-blob-server` streams a blob with `hypercore-byte-stream`, which prefetches the
 * WHOLE requested range with `core.download()` whenever the core it is given has a `.core`
 * property (`this._prefetch = prefetch !== false && core && core.core`) — `<video>` sends
 * `bytes=0-`, so the whole rendition would be downloaded and paid for (design §0.3, risk 3).
 * The gate hands the server a per-request adapter (`GatedCoreAdapter`: `opened`, `ready`,
 * `seek`, `get`, `close` and deliberately NO `.core`), so ByteStream reads block by block
 * through `get(i)`, and the gate decides what may reach the network:
 *
 *   - **paused** → `get(i)` waits (even for local blocks) and nothing new is requested.
 *     Blocks already in flight still land and are still paid (invariant 1): pause stops
 *     REQUESTING, it cannot recall bytes already sent.
 *   - **allowance** → a reader may make a block travel only while
 *     `i < anchor + prefetchBlocks + paced`, where `anchor` is the first block that reader
 *     asked for, `prefetchBlocks = ceil(prefetchSec × bytesPerSec / blockSize)` (design §1)
 *     and `paced = floor(playingSeconds × bytesPerSec × PACE_HEADROOM / blockSize)` grows with
 *     the time the session has been playing (not paused). Local blocks are always served —
 *     they cost nothing. This is what makes "buffer = money" hold against a greedy reader:
 *     a paused `<video>` or plain kernel socket buffers (≈ 2.7 MB measured on loopback) would
 *     otherwise pull the whole file through a merely on-demand gate. (Refinement of design §1,
 *     see docs/lanes/L6-C.md.)
 *   - **credit** → every network request first takes a unit from the worker-wide
 *     `CreditPool` (≤ the seeders' unpaid window), so an honest viewer is never cut.
 *   - **lookahead** → after serving block `i` the reader prefetches `(i, allowedEnd)` in the
 *     background with single-block `core.download()` ranges, as far as credit allows.
 *
 * Runtime-neutral: the hypercore is injected, timers go through an injectable clock.
 */
import type Hypercore from 'hypercore';
import type { HyperblobId } from '@sovit/core';
import type { Logger } from '@sovit/seeder';
import { toHex } from '@sovit/seeder';

import type { CreditPool, CreditWaiter } from './credit.js';
import { CreditCancelled } from './credit.js';

/** Paced allowance runs this much faster than the nominal bitrate (VBR peaks, 1.25× playback). */
export const PACE_HEADROOM = 1.25;
/** Assumed when neither `bitrateKbps` nor a duration is known (the 720p ladder rung). */
export const DEFAULT_BITRATE_KBPS = 2500;

/** What `hypercore-blob-server` + `hypercore-byte-stream` call on the "core" they are given. */
export interface GatedCoreAdapter {
  readonly opened: boolean;
  ready(): Promise<void>;
  seek(bytes: number): Promise<[number, number] | null>;
  get(index: number): Promise<Uint8Array | null>;
  /** Per-request: detaches the reader; never closes the session's core. */
  close(): Promise<void>;
}

export interface GateClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: GateClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface PlaybackGateOptions {
  readonly core: Hypercore;
  readonly blob: HyperblobId;
  readonly blockSize: number;
  /** Nominal rendition rate in bytes per second. */
  readonly bytesPerSec: number;
  readonly prefetchSeconds: number;
  readonly credit: CreditPool;
  readonly logger: Logger;
  readonly clock?: GateClock;
}

export class SessionClosedError extends Error {
  override readonly name = 'SessionClosedError';
  readonly code = 'session-closed' as const;
  constructor() {
    super('session-closed: the play session was closed');
  }
}

/** `prefetchSeconds` of playback in blocks — never less than the block being read. */
export function prefetchBlocksFor(seconds: number, bytesPerSec: number, blockSize: number): number {
  if (!(seconds > 0) || !(bytesPerSec > 0) || !(blockSize > 0)) return 1;
  return Math.max(1, Math.ceil((seconds * bytesPerSec) / blockSize));
}

/** Rendition rate: its `bitrateKbps`, else size × 8 / duration, else the default. */
export function bytesPerSecondOf(r: {
  readonly bitrateKbps?: number | undefined;
  readonly size: number;
  readonly durationSec?: number | undefined;
}): number {
  if (r.bitrateKbps !== undefined && r.bitrateKbps > 0) return (r.bitrateKbps * 1000) / 8;
  if (r.durationSec !== undefined && r.durationSec > 0 && r.size > 0) return r.size / r.durationSec;
  return (DEFAULT_BITRATE_KBPS * 1000) / 8;
}

class Reader implements GatedCoreAdapter {
  anchor: number | null = null;
  /** Last block handed to (or being fetched for) ByteStream. */
  position = -1;
  playedMs = 0;
  since: number | null = null;
  closed = false;
  pumping = false;
  repump = false;

  constructor(private readonly gate: PlaybackGate) {}

  get opened(): boolean {
    return this.gate.core.opened;
  }
  ready(): Promise<void> {
    return this.gate.core.ready();
  }
  seek(bytes: number): Promise<[number, number] | null> {
    return this.gate.core.seek(bytes);
  }
  get(index: number): Promise<Uint8Array | null> {
    return this.gate.readerGet(this, index);
  }
  close(): Promise<void> {
    this.gate.detach(this);
    return Promise.resolve();
  }
}

export class PlaybackGate {
  readonly core: Hypercore;
  readonly keyHex: string;
  private readonly blobStart: number;
  private readonly blobEnd: number;
  private readonly blockSize: number;
  private readonly bytesPerSec: number;
  private readonly credit: CreditPool;
  private readonly clock: GateClock;
  private readonly log: Logger;
  private prefetch: number;
  private paused = false;
  private closedFlag = false;
  private readonly readers = new Set<Reader>();
  /** Blocks this gate asked the network for that have not arrived yet. */
  private readonly inflight = new Set<number>();
  private readonly creditWaits = new Set<CreditWaiter>();
  private change = deferred();
  private idleWaiters: (() => void)[] = [];
  private pacer: { at: number; handle: unknown } | null = null;
  private readonly offDownload: () => void;
  private readonly offCredit: () => void;
  /** Blocks this gate has requested from the network, ever (tests, stats). */
  requestedTotal = 0;

  constructor(o: PlaybackGateOptions) {
    this.core = o.core;
    this.keyHex = toHex(o.core.key);
    this.blobStart = o.blob.blockOffset;
    this.blobEnd = o.blob.blockOffset + o.blob.blockLength;
    this.blockSize = o.blockSize;
    this.bytesPerSec = o.bytesPerSec;
    this.credit = o.credit;
    this.clock = o.clock ?? realClock;
    this.log = o.logger.child({ component: 'gate' });
    this.prefetch = prefetchBlocksFor(o.prefetchSeconds, o.bytesPerSec, o.blockSize);
    const onDownload = (index: number): void => {
      if (!this.inflight.delete(index)) return;
      if (this.inflight.size === 0) this.flushIdle();
    };
    this.core.on('download', onDownload);
    this.offDownload = () => {
      this.core.off('download', onDownload);
    };
    this.offCredit = this.credit.onAvailable(() => {
      this.wake();
    });
  }

  get isPaused(): boolean {
    return this.paused;
  }
  get isClosed(): boolean {
    return this.closedFlag;
  }
  get prefetchBlocks(): number {
    return this.prefetch;
  }
  /** Requested from the network and not arrived yet. */
  get pendingRequests(): number {
    return this.inflight.size;
  }

  /** A fresh adapter for one HTTP request (the blob server's `store.get()`). */
  adapter(): GatedCoreAdapter {
    if (this.closedFlag) throw new SessionClosedError();
    const r = new Reader(this);
    this.readers.add(r);
    return r;
  }

  pause(): void {
    if (this.paused || this.closedFlag) return;
    this.paused = true;
    const now = this.clock.now();
    for (const r of this.readers) {
      if (r.since !== null) {
        r.playedMs += now - r.since;
        r.since = null;
      }
    }
    this.disarmPacer();
    this.wake();
  }

  resume(): void {
    if (!this.paused || this.closedFlag) return;
    this.paused = false;
    const now = this.clock.now();
    for (const r of this.readers) if (r.anchor !== null) r.since = now;
    this.wake();
  }

  setPrefetchSeconds(seconds: number): void {
    this.prefetch = prefetchBlocksFor(seconds, this.bytesPerSec, this.blockSize);
    this.wake();
  }

  /** Resolves once nothing this gate requested is still in flight. */
  idle(): Promise<void> {
    if (this.inflight.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const w of [...this.creditWaits]) w.cancel();
    this.creditWaits.clear();
    for (const r of this.readers) r.closed = true;
    this.readers.clear();
    this.disarmPacer();
    this.offCredit();
    this.offDownload();
    // In-flight blocks are NOT cancelled: they still land, are still paid, and give their
    // credit back through the payer (a cancel after the seeder sent would leave it unpaid).
    this.flushIdle();
    this.change.resolve();
  }

  detach(r: Reader): void {
    r.closed = true;
    this.readers.delete(r);
  }

  // ------------------------------------------------------------------ reads

  async readerGet(r: Reader, index: number): Promise<Uint8Array | null> {
    if (index < this.blobStart || index >= this.blobEnd)
      throw new RangeError('gate: block outside the session blob');
    for (;;) {
      this.assertOpen(r);
      if (this.paused) {
        await this.change.promise;
        continue;
      }
      if (r.anchor === null) {
        r.anchor = index;
        r.since = this.clock.now();
      }
      r.position = index;
      if (await this.core.has(index)) {
        if (this.halted(r)) continue;
        break;
      }
      if (this.halted(r)) continue;
      if (this.inflight.has(index)) break;
      if (index >= this.allowedEnd(r)) {
        this.armPacer(r, index);
        await this.change.promise;
        continue;
      }
      if (!this.credit.holds(this.keyHex, index)) {
        const w = this.credit.acquire(this.keyHex, index);
        this.creditWaits.add(w);
        try {
          await w.promise;
        } catch (err) {
          if (err instanceof CreditCancelled) continue;
          throw err;
        } finally {
          this.creditWaits.delete(w);
        }
        if (this.halted(r)) {
          // Got a unit but may no longer request: give it back unless the block is on its way.
          if (!this.inflight.has(index)) this.credit.settle(this.keyHex, index);
          continue;
        }
      }
      this.markRequested(index);
      break;
    }
    void this.pump(r);
    try {
      return await this.core.get(index);
    } catch (err) {
      await this.forgetIfMissing(index);
      throw err;
    }
  }

  private isDead(r: Reader): boolean {
    return this.closedFlag || r.closed;
  }

  /** Re-read after every `await`: pause/close may have happened meanwhile. */
  private halted(r: Reader): boolean {
    return this.paused || this.isDead(r);
  }

  private assertOpen(r: Reader): void {
    if (this.isDead(r)) throw new SessionClosedError();
  }

  private allowedEnd(r: Reader): number {
    if (r.anchor === null) return this.blobStart;
    const played = r.playedMs + (r.since === null ? 0 : this.clock.now() - r.since);
    const paced = Math.floor(((played / 1000) * this.bytesPerSec * PACE_HEADROOM) / this.blockSize);
    return Math.min(this.blobEnd, r.anchor + this.prefetch + paced);
  }

  /** Background lookahead for one reader: `(position, allowedEnd)`, as far as credit goes. */
  private async pump(r: Reader): Promise<void> {
    if (r.pumping) {
      r.repump = true;
      return;
    }
    r.pumping = true;
    try {
      do {
        r.repump = false;
        const end = this.allowedEnd(r);
        for (let j = r.position + 1; j < end; j++) {
          if (this.halted(r)) return;
          if (this.inflight.has(j) || this.credit.holds(this.keyHex, j)) continue;
          if (await this.core.has(j)) continue;
          if (this.halted(r)) return;
          if (this.inflight.has(j) || this.credit.holds(this.keyHex, j)) continue;
          if (!this.credit.tryAcquire(this.keyHex, j)) break;
          this.markRequested(j);
          const range = this.core.download({ start: j, end: j + 1 });
          void range.done().catch(() => this.forgetIfMissing(j));
        }
      } while (again(r));
    } catch (err) {
      this.log.warn('lookahead failed', { error: err });
    } finally {
      r.pumping = false;
    }
  }

  private markRequested(index: number): void {
    this.inflight.add(index);
    this.requestedTotal++;
  }

  /** A request died: if the block never arrived, its credit unit is free again. */
  private async forgetIfMissing(index: number): Promise<void> {
    const have = await this.core.has(index).catch(() => false);
    if (have) return;
    if (this.inflight.delete(index) && this.inflight.size === 0) this.flushIdle();
    this.credit.settle(this.keyHex, index);
  }

  private wake(): void {
    const c = this.change;
    this.change = deferred();
    c.resolve();
    if (this.paused || this.closedFlag) return;
    for (const r of this.readers) if (r.anchor !== null) void this.pump(r);
  }

  private armPacer(r: Reader, index: number): void {
    if (this.paused || r.since === null || r.anchor === null) return;
    const need = index - (r.anchor + this.prefetch) + 1;
    const rate = (this.bytesPerSec * PACE_HEADROOM) / 1000; // bytes per ms
    const playedNeeded = Math.ceil((need * this.blockSize) / rate);
    const played = r.playedMs + (this.clock.now() - r.since);
    const at = this.clock.now() + Math.max(1, playedNeeded - played);
    if (this.pacer !== null && this.pacer.at <= at) return;
    this.disarmPacer();
    const handle = this.clock.setTimeout(() => {
      this.pacer = null;
      this.wake();
    }, at - this.clock.now());
    this.pacer = { at, handle };
  }

  private disarmPacer(): void {
    if (this.pacer === null) return;
    this.clock.clearTimeout(this.pacer.handle);
    this.pacer = null;
  }

  private flushIdle(): void {
    const ws = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of ws) w();
  }
}

/** A pump request arrived while pumping (read through a call: it changes across awaits). */
function again(r: Reader): boolean {
  return r.repump;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
