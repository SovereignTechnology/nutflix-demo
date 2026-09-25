/**
 * SeederCredit — the downloader's credit PER SEEDER (issue #8), and one seeder per block
 * (security review F33, Cameron 2026-09-24). Shared by the desktop worker's playback
 * (`ViewerPayer`) and the gateway's upstream reads, like the rest of this module.
 *
 * A seeder counts every block it sends us until our `PAY` for it is verified, and cuts and bans us
 * once that count passes its unpaid window. The window is the seeder's own: its HELLO announces
 * `windowBlocks`, and for a core it is `effectiveWindowBlocks(windowBlocks, policy)` — widened so
 * one minimum PAY fits (ADR 0007; the formula the `pay/1` contract gives the viewer, with the
 * core's MANIFEST policy). One global pool cannot respect windows that differ: sized to the
 * smallest it starves the large ones, sized larger it overruns the small ones. So:
 *
 *   - `OnePeerRouter` (`@sovit/seeder`) routes the core's requests: no block is asked of two
 *     seeders at once (F33), and a seeder is asked for a block only while
 *     `budget(seeder, core) − used(seeder) ≥ 1`, whichever blocks hypercore picks;
 *   - `budget` = its window − blocks it delivered that are not settled (`CreditSettler.owedBy`) −
 *     blocks it delivered that will never be paid (`unpaid`: rejected PAYs, blocks owed when its
 *     `pay/1` went away). `used` adds what is in flight, being verified, cancelled after sending
 *     or lost with a connection. Together they bound what the seeder can count against us;
 *   - no HELLO yet → budget 0 (the window is unknown); a `pay/1` link that closed → 0 (we could
 *     never pay what we took); a connection without `pay/1`, or a core with no manifest policy →
 *     `NO_PAY_INFLIGHT` in flight at a time (their blocks settle on arrival; this was the old
 *     global pool's size);
 *   - the `CreditPool` (the downloader's own budget) follows the sum of the connected seeders'
 *     windows, never below the size it was created with, so a large window is not starved;
 *   - the payer batches per seeder: half its window, and at once when it is at its cap.
 *
 * Everything is keyed by the seeder's Noise key, which is stable per seeder node, and remembered
 * after it disconnects (bounded): a seeder that reconnects still counts what we never paid it.
 * A seeder that comes back under a NEW Noise key but the same (signed) HELLO pubkey inherits what
 * its old connections left unpaid: its engine keeps our window per OUR pubkey, not per link.
 */
import { DEFAULT_WINDOW_BLOCKS, payment } from '@sovit/core';
import type { CoreKeyHex, HelloMessage, PayProtocol, PricePolicy } from '@sovit/core';
import { OnePeerRouter, toHex } from '@sovit/seeder';
import type { Logger, RoutableCore } from '@sovit/seeder';

import type { CreditPool } from './credit.js';
import type { CreditSettler } from './settle.js';

/** Upper bound on one seeder's credit, whatever its HELLO says (`hello.windowBlocks` ≤ 65 535). */
export const MAX_SEEDER_CREDIT = 1024;
/** Upper bound on the downloader's pool. */
export const MAX_POOL_CREDIT = 1024;
/** In flight at a time to a peer without `pay/1`, or for a core nobody pays for. */
export const NO_PAY_INFLIGHT = DEFAULT_WINDOW_BLOCKS;
/** Seeders remembered after they disconnect (their unpaid blocks). */
export const MAX_REMEMBERED_SEEDERS = 4096;

export interface SeederCreditOptions {
  readonly settler: CreditSettler;
  /** Resized to the sum of the seeders' windows; its size at construction is the floor. */
  readonly pool: CreditPool;
  /** The MANIFEST policy of a core (its price and minimum PAY widen the window). */
  readonly policyFor: (core: CoreKeyHex) => PricePolicy | null;
  /**
   * Whether blocks of `core` are paid for (the settler's rule). Default: a policy exists. A core
   * paid without a policy known here gets the seeder's bare `windowBlocks` (never wider).
   */
  readonly payable?: (core: CoreKeyHex) => boolean;
  readonly logger: Logger;
  /** `OnePeerRouter` failover delay (default `DEFAULT_STALL_MS`). */
  readonly stallMs?: number;
}

/** A seeder's batch size for the payer (`UpstreamPayer`'s `seederBatch`). */
export interface SeederBatch {
  /** Half the seeder's credit, at least 1. */
  readonly batch: number;
  /** What it delivered unpaid fills its credit: pay what is pending now, however short. */
  readonly atCap: boolean;
}

interface Seeder {
  hello: HelloMessage | null;
  /** Its current `pay/1` link is attached and open. */
  live: boolean;
  /** The current connection (a reconnect replaces it; the old one's events are ignored). */
  conn: object;
  /** Blocks it delivered that were settled without a payment: still outstanding at the seeder. */
  unpaid: number;
}

export interface SeederCreditStats {
  readonly seeders: number;
  readonly live: number;
  readonly unpaid: number;
  readonly failovers: number;
  readonly poolLimit: number;
}

export class SeederCredit {
  readonly router: OnePeerRouter;
  private readonly o: SeederCreditOptions;
  private readonly floor: number;
  private readonly seeders = new Map<string, Seeder>();
  /** HELLO pubkey → the Noise keys that announced it. */
  private readonly byPubkey = new Map<string, Set<string>>();
  /** Routed cores (their policies size the pool and the batches). */
  private readonly cores = new Map<string, number>();
  private readonly offSettler: () => void;
  private disposed = false;

  constructor(o: SeederCreditOptions) {
    this.o = o;
    this.floor = o.pool.limit;
    this.router = new OnePeerRouter({
      budget: (remote, core) => this.budget(remote, core),
      logger: o.logger,
      ...(o.stallMs !== undefined ? { stallMs: o.stallMs } : {}),
    });
    this.offSettler = o.settler.onChange((noiseHex, unpaid) => {
      if (unpaid > 0) {
        const s = this.seeders.get(noiseHex);
        if (s !== undefined) s.unpaid += unpaid;
      }
      this.changed();
    });
  }

  /**
   * A peer's `pay/1` (one per connection; the settler's link must be attached too). Learns its
   * HELLO and its close. Returns a detach function.
   */
  attachPeer(noiseHex: string, protocol: PayProtocol): () => void {
    const conn = {};
    const seeder: Seeder = this.seeders.get(noiseHex) ?? {
      hello: null,
      live: false,
      conn,
      unpaid: 0,
    };
    // Most recently seen last: the eviction order.
    this.seeders.delete(noiseHex);
    this.seeders.set(noiseHex, seeder);
    this.evict();
    seeder.conn = conn;
    seeder.hello = protocol.peer;
    if (seeder.hello !== null) this.index(noiseHex, seeder.hello);
    seeder.live = protocol.state !== 'closed';
    const offOpen = protocol.on('open', (hello) => {
      if (seeder.conn !== conn) return;
      seeder.hello = hello;
      this.index(noiseHex, hello);
      this.changed();
    });
    const end = (): void => {
      if (seeder.conn !== conn) return;
      seeder.live = false;
      this.changed();
    };
    const offClose = protocol.on('close', end);
    this.changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      offOpen();
      offClose();
      end();
    };
  }

  /** Route a core's requests (one seeder per block, per-seeder caps). Returns a detach function. */
  attachCore(core: RoutableCore): () => void {
    const detach = this.router.attachCore(core);
    const key = toHex(core.key);
    this.cores.set(key, (this.cores.get(key) ?? 0) + 1);
    this.changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      detach();
      const n = (this.cores.get(key) ?? 1) - 1;
      if (n <= 0) this.cores.delete(key);
      else this.cores.set(key, n);
      this.changed();
    };
  }

  /**
   * The `OnePeerRouter` budget: blocks `remote` may have outstanding toward us for a request on
   * `core` (see the module comment). Never `Infinity`.
   */
  budget(remote: string, core: string): number {
    const s = this.seeders.get(remote);
    if (s === undefined || !this.payable(core)) return NO_PAY_INFLIGHT;
    if (!s.live || s.hello === null || !this.o.settler.linked(remote)) return 0;
    const win = this.window(s.hello, this.o.policyFor(core as CoreKeyHex));
    return Math.max(0, win - this.o.settler.owedBy(remote) - this.lostTo(remote, s));
  }

  /** `remote`'s window for `core` (`null` before its HELLO). */
  windowOf(remote: string, core: string): number | null {
    const hello = this.seeders.get(remote)?.hello ?? null;
    if (hello === null) return null;
    return this.window(hello, this.o.policyFor(core as CoreKeyHex));
  }

  /** The payer's batch for `remote` (`null` = no window known: the payer's own rule). */
  seederBatch(remote: string): SeederBatch | null {
    const s = this.seeders.get(remote);
    if (s === undefined || !s.live || s.hello === null) return null;
    // Batching must fit the SMALLEST window among the cores being paid for.
    const credit =
      this.windowOver(s.hello, Math.min) - this.lostTo(remote, s) - this.router.debt(remote);
    // At its cap when what it delivered fills its credit: blocks still in flight can no longer
    // complete a batch, and nothing more will be asked of it until a PAY is acknowledged.
    const atCap = this.o.settler.owedBy(remote) >= credit;
    return { batch: Math.max(1, Math.floor(credit / 2)), atCap };
  }

  stats(): SeederCreditStats {
    let live = 0;
    let unpaid = 0;
    for (const s of this.seeders.values()) {
      if (s.live) live++;
      unpaid += s.unpaid;
    }
    return {
      seeders: this.seeders.size,
      live,
      unpaid,
      failovers: this.router.stats().failovers,
      poolLimit: this.o.pool.limit,
    };
  }

  /** Stop routing and listening (the downloader is going away). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offSettler();
    this.router.close();
  }

  // -------------------------------------------------------------- private

  /**
   * Blocks the seeder `remote` delivered that will never be paid: its own, plus — for its HELLO
   * pubkey — what its connections under OTHER Noise keys, now gone, left unpaid or lost.
   */
  private lostTo(remote: string, s: Seeder): number {
    let n = s.unpaid;
    const pk = s.hello?.pubkey;
    if (pk === undefined) return n;
    for (const other of this.byPubkey.get(pk) ?? []) {
      const o = this.seeders.get(other);
      if (other !== remote && o !== undefined && !o.live && o.hello?.pubkey === pk)
        n += o.unpaid + this.router.debt(other);
    }
    return n;
  }

  private index(noiseHex: string, hello: HelloMessage): void {
    let set = this.byPubkey.get(hello.pubkey);
    if (set === undefined) {
      set = new Set();
      this.byPubkey.set(hello.pubkey, set);
    }
    set.add(noiseHex);
  }

  private payable(core: string): boolean {
    const c = core as CoreKeyHex;
    return this.o.payable !== undefined ? this.o.payable(c) : this.o.policyFor(c) !== null;
  }

  /** The seeder's window under `policy`; its bare `windowBlocks` without one. Clamped. */
  private window(hello: HelloMessage, policy: PricePolicy | null): number {
    const w =
      policy === null
        ? hello.windowBlocks
        : payment.effectiveWindowBlocks(hello.windowBlocks, policy);
    return Math.max(0, Math.min(MAX_SEEDER_CREDIT, Number.isSafeInteger(w) ? w : 0));
  }

  /** `pick` (min or max) of the seeder's windows over the routed, paid cores. */
  private windowOver(hello: HelloMessage, pick: (a: number, b: number) => number): number {
    let win: number | null = null;
    for (const core of this.cores.keys()) {
      if (!this.payable(core)) continue;
      const w = this.window(hello, this.o.policyFor(core as CoreKeyHex));
      win = win === null ? w : pick(win, w);
    }
    return win ?? this.window(hello, null);
  }

  /** Budgets may have changed: resize the pool and let hypercore ask again. */
  private changed(): void {
    if (this.disposed) return;
    let sum = 0;
    for (const [remote, s] of this.seeders) {
      if (!s.live || s.hello === null) continue;
      // The pool spans cores: the seeder's LARGEST window is what it may hold in all.
      const lost = this.lostTo(remote, s) + this.router.debt(remote);
      sum += Math.max(0, this.windowOver(s.hello, Math.max) - lost);
    }
    this.o.pool.setLimit(Math.max(this.floor, Math.min(MAX_POOL_CREDIT, sum)));
    this.router.refresh();
  }

  private evict(): void {
    for (const [remote, s] of this.seeders) {
      if (this.seeders.size <= MAX_REMEMBERED_SEEDERS) return;
      if (s.live) continue;
      this.seeders.delete(remote);
      const pk = s.hello?.pubkey;
      const set = pk === undefined ? undefined : this.byPubkey.get(pk);
      set?.delete(remote);
      if (pk !== undefined && set?.size === 0) this.byPubkey.delete(pk);
    }
  }
}
