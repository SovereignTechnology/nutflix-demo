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
 *
 * IMAGE CORES (fix round 4, ADR 0015 × F33): a core read for display (`attachImageCore`: a
 * creator's profile core — never paid, browsing never spends sats) is routed too, because the core
 * a thumbnail URL names may be a PAID one, whose honest seeders count every block they send us and
 * ban us past their window. The viewer cannot know which from the URL; the seeder says so on the
 * wire: a seeder that counts a core's blocks sends a `PRICE` for it before the first one
 * (`announceCorePrices`, on for every seeder this repository builds), and a free core gets none.
 * So, for a pay/1 seeder:
 *   - its budget on an image core is its BARE window (`windowBlocks`, the smallest it counts
 *     against) less what it may already count (owed, unpaid; the router subtracts what is in
 *     flight): even if it counted every image block we ask, it stays within its window;
 *   - until it has delivered one block of that core with no `PRICE` first, it is asked ONE block
 *     at a time (`probing`); after that it serves the core free, and nothing it serves there is
 *     ever counted against its credit (honest images never erode paid playback);
 *   - once it sent a `PRICE` for the core it is never asked for it again (remembered per seeder,
 *     across reconnects), and every block of it delivered after that PRICE is unpaid for good.
 * `onImageVerdict` reports the first `free` / `priced` answer per core (the host refuses a core
 * sold somewhere and served free nowhere, and stops its read).
 */
import { DEFAULT_WINDOW_BLOCKS, payment } from '@sovit/core';
import type { CoreKeyHex, HelloMessage, PayProtocol, PricePolicy } from '@sovit/core';
import { OnePeerRouter, toHex } from '@sovit/seeder';
import type { DownloadPeer, Logger, RoutableCore } from '@sovit/seeder';

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
/** Image cores remembered per seeder as sold (`PRICE`) or served free by it; oldest go first. */
export const MAX_IMAGE_VERDICTS_PER_SEEDER = 256;

/** What a seeder said about an image core (see the module comment). */
export type ImageVerdict = 'free' | 'priced';

/** Pools a live `SeederCredit` resizes. */
const managed = new WeakSet<CreditPool>();

export interface SeederCreditOptions {
  readonly settler: CreditSettler;
  /** Resized to the sum of the seeders' windows; its size at construction is the floor. */
  readonly pool: CreditPool;
  /**
   * The MANIFEST policy of a core (its price and minimum PAY widen the window). Whether a core is
   * paid for at all is the SETTLER's rule (`CreditSettler.isPayable`), so the two cannot disagree;
   * a paid core without a policy here gets the seeder's bare `windowBlocks` (never wider).
   */
  readonly policyFor: (core: CoreKeyHex) => PricePolicy | null;
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
  /** The current connection's HELLO (`null` until it arrives: nothing is asked before it). */
  hello: HelloMessage | null;
  /**
   * The pubkey its latest HELLO announced, kept across reconnects (what we never paid it follows
   * the pubkey, whose engine counts it); its `byPubkey` entry.
   */
  pubkey: string | null;
  /** Its current `pay/1` link is attached and open. */
  live: boolean;
  /** The current connection (a reconnect replaces it; the old one's events are ignored). */
  conn: object;
  /** Blocks it delivered that were settled without a payment: still outstanding at the seeder. */
  unpaid: number;
  /** Image cores it sent a `PRICE` for (never asked again; kept across reconnects). */
  readonly priced: Set<string>;
  /** Image cores it served free on its CURRENT connection (probing is over there). */
  free: Set<string>;
}

export interface SeederCreditStats {
  readonly seeders: number;
  readonly live: number;
  readonly unpaid: number;
  readonly failovers: number;
  readonly poolLimit: number;
  /** HELLO pubkeys indexed (at most one per seeder record). */
  readonly pubkeys: number;
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
  /** Image cores (fix round 4), reference counted. */
  private readonly images = new Map<string, number>();
  /** Image cores a verdict was reported for (the first `free` and the first `priced`). */
  private readonly told = new Map<string, Set<ImageVerdict>>();
  private readonly verdictListeners = new Set<(core: string, verdict: ImageVerdict) => void>();
  private readonly offSettler: () => void;
  private disposed = false;

  constructor(o: SeederCreditOptions) {
    // Two of them would resize the same pool against each other.
    if (managed.has(o.pool)) throw new Error('this CreditPool already has a SeederCredit');
    managed.add(o.pool);
    this.o = o;
    this.floor = o.pool.limit;
    this.router = new OnePeerRouter({
      budget: (remote, core) => this.budget(remote, core),
      probe: (remote, core) => this.probing(remote, core),
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
      pubkey: null,
      live: false,
      conn,
      unpaid: 0,
      priced: new Set(),
      free: new Set(),
    };
    // Most recently seen last: the eviction order.
    this.seeders.delete(noiseHex);
    this.seeders.set(noiseHex, seeder);
    this.evict();
    seeder.conn = conn;
    // A new connection re-probes: the seeder announces its prices per connection.
    seeder.free = new Set();
    this.setHello(noiseHex, seeder, protocol.peer);
    seeder.live = protocol.state !== 'closed';
    const offOpen = protocol.on('open', (hello) => {
      if (seeder.conn !== conn) return;
      this.setHello(noiseHex, seeder, hello);
      this.changed();
    });
    // Fix round 4: a PRICE for a core being read as an image — this seeder counts its blocks.
    const offPrice = protocol.on('price', (p) => {
      if (seeder.conn !== conn || !this.images.has(p.core)) return;
      remember(seeder.priced, p.core);
      seeder.free.delete(p.core);
      this.verdict(p.core, 'priced');
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
      offPrice();
      offClose();
      end();
    };
  }

  /**
   * Route a core read for DISPLAY only (fix round 4: a profile core's image — never paid). See the
   * module comment for the rules; blocks from a pay/1 seeder that priced the core are counted
   * unpaid. The core must be open; throws `RoutingUnsupported` like `attachCore` (fail closed).
   * Returns a detach function (reference counted).
   */
  attachImageCore(core: RoutableCore): () => void {
    const detach = this.router.attachCore(core);
    const key = toHex(core.key);
    this.images.set(key, (this.images.get(key) ?? 0) + 1);
    const onDownload = (_index: number, _bytes: number, peer: DownloadPeer): void => {
      this.onImageBlock(key, toHex(peer.remotePublicKey));
    };
    core.on('download', onDownload);
    this.changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      core.off('download', onDownload);
      detach();
      const n = (this.images.get(key) ?? 1) - 1;
      if (n <= 0) this.images.delete(key);
      else this.images.set(key, n);
      this.changed();
    };
  }

  /** The first `free` and the first `priced` verdict per image core. Returns an unsubscribe. */
  onImageVerdict(cb: (core: string, verdict: ImageVerdict) => void): () => void {
    this.verdictListeners.add(cb);
    return () => this.verdictListeners.delete(cb);
  }

  /**
   * Whether `remote` may be asked only ONE block of `core` at a time: an image core it has not yet
   * served free on this connection (the router's `probe`).
   */
  probing(remote: string, core: string): boolean {
    if (!this.images.has(core) || this.payable(core)) return false;
    return this.seeders.get(remote)?.free.has(core) !== true;
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
    if (s === undefined) return NO_PAY_INFLIGHT;
    if (!this.payable(core)) {
      if (!this.images.has(core)) return NO_PAY_INFLIGHT;
      // Fix round 4: an image core — the seeder may count it (see the module comment).
      if (!s.live || s.hello === null || !this.o.settler.linked(remote)) return 0;
      if (s.priced.has(core)) return 0;
      const bare = this.window(s.hello, null);
      return Math.max(0, bare - this.o.settler.owedBy(remote) - this.lostTo(remote, s));
    }
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
      pubkeys: this.byPubkey.size,
    };
  }

  /** Stop routing and listening (the downloader is going away). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offSettler();
    this.router.close();
    managed.delete(this.o.pool);
  }

  // -------------------------------------------------------------- private

  /** A verified block of image core `core` from `remote` (fix round 4). */
  private onImageBlock(core: string, remote: string): void {
    if (this.payable(core)) return; // a play session made it a paid core: the settler's now
    const s = this.seeders.get(remote);
    if (s === undefined || !s.live || s.hello === null) return; // no pay/1: nothing counts it
    if (s.priced.has(core)) {
      // Delivered after its PRICE: it counts the block, and we never pay for browsing.
      s.unpaid++;
      this.changed();
      return;
    }
    if (s.free.has(core)) return;
    // No PRICE before this block: it serves the core free. The probe is over.
    remember(s.free, core);
    this.verdict(core, 'free');
    this.changed();
  }

  private verdict(core: string, v: ImageVerdict): void {
    let said = this.told.get(core);
    if (said?.has(v) === true) return;
    if (said === undefined) {
      said = new Set();
      this.told.set(core, said);
      while (this.told.size > MAX_REMEMBERED_SEEDERS) {
        const oldest = this.told.keys().next();
        if (oldest.done === true) break;
        this.told.delete(oldest.value);
      }
    }
    said.add(v);
    for (const cb of [...this.verdictListeners]) {
      try {
        cb(core, v);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  /**
   * Blocks the seeder `remote` delivered that will never be paid: its own, plus — for its HELLO
   * pubkey — what its connections under OTHER Noise keys, now gone, left unpaid or lost.
   */
  private lostTo(remote: string, s: Seeder): number {
    let n = s.unpaid;
    const pk = s.pubkey;
    if (pk === null) return n;
    for (const other of this.byPubkey.get(pk) ?? []) {
      const o = this.seeders.get(other);
      if (other !== remote && o !== undefined && !o.live && o.pubkey === pk)
        n += o.unpaid + this.router.debt(other);
    }
    return n;
  }

  /**
   * `seeder`'s current HELLO is now `hello`. When it announces a pubkey other than the last one,
   * `byPubkey` follows: the Noise key leaves the old pubkey's set (the set goes when empty) and
   * joins the new one's. So `byPubkey` never holds more than one entry per seeder record — a peer
   * re-announcing fresh pubkeys under one Noise key cannot grow it (independent review
   * 2026-09-25). A connection without a HELLO yet keeps the last pubkey (and what it inherits).
   */
  private setHello(noiseHex: string, seeder: Seeder, hello: HelloMessage | null): void {
    seeder.hello = hello;
    if (hello === null || hello.pubkey === seeder.pubkey) return;
    if (seeder.pubkey !== null) this.unindex(noiseHex, seeder.pubkey);
    seeder.pubkey = hello.pubkey;
    let set = this.byPubkey.get(hello.pubkey);
    if (set === undefined) {
      set = new Set();
      this.byPubkey.set(hello.pubkey, set);
    }
    set.add(noiseHex);
  }

  private unindex(noiseHex: string, pubkey: string): void {
    const set = this.byPubkey.get(pubkey);
    set?.delete(noiseHex);
    if (set?.size === 0) this.byPubkey.delete(pubkey);
  }

  private payable(core: string): boolean {
    return this.o.settler.isPayable(core as CoreKeyHex);
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

  // (`remember` below keeps the per-seeder verdict sets bounded.)
  private evict(): void {
    for (const [remote, s] of this.seeders) {
      if (this.seeders.size <= MAX_REMEMBERED_SEEDERS) return;
      if (s.live) continue;
      this.seeders.delete(remote);
      if (s.pubkey !== null) this.unindex(remote, s.pubkey);
    }
  }
}

/** Add `core` to a per-seeder verdict set, dropping the oldest past the bound. */
function remember(set: Set<string>, core: string): void {
  set.delete(core);
  set.add(core);
  while (set.size > MAX_IMAGE_VERDICTS_PER_SEEDER) {
    const oldest = set.values().next();
    if (oldest.done === true) break;
    set.delete(oldest.value);
  }
}
