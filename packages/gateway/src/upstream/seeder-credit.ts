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
 *     what it counts from before (`old`, below). `used` adds what is in flight, being verified,
 *     cancelled after sending or lost with a connection. Together they bound what the seeder can
 *     count against us;
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
 * WHAT IT COUNTS FROM BEFORE (lane P2-owed-viewer, ADR 0018 amendment 2026-09-26, contracts v6).
 * Every seeder this repository builds says it: once both HELLOs are verified it sends one `OWED`
 * per core where it still counts blocks we never paid (earlier connections, earlier runs of ours),
 * and every `ACK` carries `outstanding` — what it counts on that core once the PAY was applied.
 * Its report is complete once anything it sent in answer to a frame we sent after our HELLO
 * arrives — a block we asked for, an ACK (the contract's order rule: it writes the whole report
 * before it handles any later frame) — or `REPORT_WAIT_MS` after the channel opened (its report
 * goes out the moment it binds our HELLO; the wait bounds a lost one). So, per connection:
 *   - BEFORE the report: `old` is what we know of (blocks left unpaid on earlier connections of
 *     this process, requests lost with them; with a `ledger`, the whole window when the durable
 *     ledger says an earlier run may have left the seeder counting that much), or the report so
 *     far if larger; and the seeder is asked ONE block at a time (`single`), so a report we have
 *     not seen can never be overrun by more than we could not avoid;
 *   - AT the report: what it says it counts replaces our estimate of everything before this
 *     connection — requests remembered as lost to it (`OnePeerRouter.forgive`), blocks settled
 *     unpaid, what other Noise keys of its pubkey left, the ledger's word for an earlier run;
 *   - AFTER: `old` = what it reported, re-based at each ACK of a core to `outstanding` less the
 *     blocks of that core still owed on the link (an upper bound: blocks in flight count twice),
 *     plus what this connection left unpaid since. A report that hit the contract's caps
 *     (`MAX_OWED_RANGES` / `MAX_OWED_BLOCKS`) may be short: nothing more is asked of it on that
 *     connection. Its claims are respected, never checked: over-claiming costs it our requests.
 * Paying the reported blocks is the downloader's (`ViewerPayer`: only those its own record says it
 * received, under the host's authorisation). The gateway has no such record and pays no old tail;
 * it only stays under what the seeder reports.
 *
 * IMAGE CORES (lane P2-owed-viewer, ADR 0015 amendment 2026-09-26). A core read for display
 * (`attachImageCore`: a creator's profile core — never paid, browsing never spends sats) is routed
 * so that a seeder is asked for its blocks ONLY once it said, on its current connection with both
 * HELLOs verified, `PRICE { free: true }` for that core: it then counts nothing it sends of it
 * (`NO_PAY_INFLIGHT` in flight, from its own cap — the router's `free` option keeps these
 * requests out of what it may count on the cores it sells, and a free read that times out or is
 * stopped leaves no debt). Silence, a priced `PRICE`, no `pay/1`, no HELLO: never asked, nothing
 * counted — no probe. A core it later turns sold is never asked again there; a block of it that
 * still lands afterwards is counted as unpaid (browsing never pays). The core a thumbnail URL
 * names may be a paid video: its honest seeders say its price, so it is simply never asked.
 */
import { DEFAULT_WINDOW_BLOCKS, MAX_OWED_BLOCKS, MAX_OWED_RANGES, payment } from '@sovit/core';
import type {
  AckMessage,
  CoreKeyHex,
  HelloMessage,
  OwedMessage,
  PayProtocol,
  PricePolicy,
} from '@sovit/core';
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
/** Cores a seeder said `free` for, remembered per connection; oldest go first. */
export const MAX_FREE_CORES_PER_SEEDER = 256;
/**
 * How long after its channel opened a seeder's report is taken as complete without any answer of
 * its own (lane P2-owed-viewer). Its `OWED`s go out the moment it binds our HELLO, one round trip
 * after our channel opened; a block we asked for or an ACK normally completes the report long
 * before. This bounds the wait of a seeder asked nothing meanwhile (the ledger says it may count
 * its whole window, and nothing it reported could be paid).
 */
export const REPORT_WAIT_MS = 10_000;
/** Pubkeys whose report came in during this process (the ledger's earlier-run word is then moot). */
const MAX_SETTLED_PUBKEYS = 4096;

/**
 * Lane P2-owed-viewer: the durable word, per seeder HELLO pubkey, on whether it may count its
 * whole window against us — kept by the desktop worker across runs (the gateway has none). Written
 * AHEAD: `markFull` must be durable before anything is asked that could bring what the seeder
 * counts to its bare window, so after a crash the ledger still covers it; the owner clears it
 * lazily once what the seeder may count is below (`seederReach`), never for a pubkey whose
 * earlier-run word is still open (its reach then includes it).
 */
export interface SeederLedger {
  /**
   * What the ledger said when this process started: an EARLIER run may have left `pubkey`
   * counting its whole window against us (moot once its report came in during this process).
   */
  fullBefore(pubkey: string): boolean;
  /** Durable now: `pubkey` may count its whole window against us. */
  full(pubkey: string): boolean;
  /** Make `full(pubkey)` durable now, synchronously. `false`: it could not be written. */
  markFull(pubkey: string): boolean;
}

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
  /** Lane P2-owed-viewer: the durable ledger (desktop only; see `SeederLedger`). */
  readonly ledger?: SeederLedger;
  /** How long a report may take before it is taken as complete (default `REPORT_WAIT_MS`). */
  readonly reportWaitMs?: number;
}

/** A seeder's batch size for the payer (`UpstreamPayer`'s `seederBatch`). */
export interface SeederBatch {
  /** Half the seeder's credit, at least 1. */
  readonly batch: number;
  /** What it delivered unpaid fills its credit: pay what is pending now, however short. */
  readonly atCap: boolean;
}

/** One connection's report of what the seeder still counts from before it (see the header). */
interface Report {
  /** Complete: its claims replaced our estimate of everything before this connection. */
  done: boolean;
  /** core → blocks it says it still counts (its `OWED`, re-based at each ACK of that core). */
  readonly claimed: Map<string, number>;
  /** The report so far, against the contract's caps. */
  ranges: number;
  blocks: number;
  /** It hit a cap (or was malformed): it may be short — nothing more is asked on this connection. */
  truncated: boolean;
  /** `OnePeerRouter.lostOf` when the connection began: what the report replaces. */
  readonly lostAtStart: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Seeder {
  /**
   * The current connection's HELLO, once its channel is OPEN (both HELLOs done; `null` before:
   * nothing is asked before it, so everything asked comes after its report on the stream).
   */
  hello: HelloMessage | null;
  /**
   * The pubkey its latest HELLO announced, kept across reconnects (what we never paid it follows
   * the pubkey, whose engine counts it); its `byPubkey` entry.
   */
  pubkey: string | null;
  /** Its bare `windowBlocks` from its latest HELLO (0 before any). */
  bare: number;
  /** Its current `pay/1` link is attached and open. */
  live: boolean;
  /** The current connection (a reconnect replaces it; the old one's events are ignored). */
  conn: object;
  /** Blocks it counts that nothing will pay and no report of it covers (see the header). */
  unpaid: number;
  /** Cores it said `free` for on its CURRENT connection (the last word per core; bounded). */
  free: Set<string>;
  report: Report;
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

/** What a seeder said on its current connection about what it counts (diagnostics, tests). */
export interface SeederReport {
  readonly done: boolean;
  /** Blocks it says it counts from before (its `OWED`, re-based by `ACK.outstanding`). */
  readonly claimed: number;
  readonly truncated: boolean;
}

/** What one seeder pubkey may count against us now, and its bare window (the ledger's flush). */
export interface SeederReach {
  readonly pubkey: string;
  readonly reach: number;
  readonly window: number;
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
  /** Image cores, reference counted. */
  private readonly images = new Map<string, number>();
  /** Pubkeys whose report came in during this process. */
  private readonly settled = new Set<string>();
  private readonly offSettler: () => void;
  private readonly offAck: () => void;
  private readonly reportWaitMs: number;
  private disposed = false;

  constructor(o: SeederCreditOptions) {
    // Two of them would resize the same pool against each other.
    if (managed.has(o.pool)) throw new Error('this CreditPool already has a SeederCredit');
    managed.add(o.pool);
    this.o = o;
    this.floor = o.pool.limit;
    const wait = o.reportWaitMs ?? REPORT_WAIT_MS;
    this.reportWaitMs = Number.isFinite(wait) && wait >= 0 ? wait : REPORT_WAIT_MS;
    this.router = new OnePeerRouter({
      budget: (remote, core) => this.budget(remote, core),
      single: (remote) => this.awaitingReport(remote),
      free: (remote, core) => this.servesFreeImage(remote, core),
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
    // After the settler applied it: `owedByOn` no longer counts the blocks it settled.
    this.offAck = o.settler.onAck((noiseHex, ack) => {
      this.onAck(noiseHex, ack);
    });
  }

  /**
   * A peer's `pay/1` (one per connection; the settler's link must be attached too). Learns its
   * HELLO, its terms per core, its report and its close. Returns a detach function.
   */
  attachPeer(noiseHex: string, protocol: PayProtocol): () => void {
    const conn = {};
    const seeder: Seeder = this.seeders.get(noiseHex) ?? {
      hello: null,
      pubkey: null,
      bare: 0,
      live: false,
      conn,
      unpaid: 0,
      free: new Set(),
      report: newReport(0),
    };
    // Most recently seen last: the eviction order.
    this.seeders.delete(noiseHex);
    this.seeders.set(noiseHex, seeder);
    this.evict();
    seeder.conn = conn;
    // Terms and report are per connection: the seeder says them again on each.
    seeder.free = new Set();
    if (seeder.report.timer !== null) clearTimeout(seeder.report.timer);
    seeder.report = newReport(this.router.lostOf(noiseHex));
    // Only an OPEN channel's HELLO: before our own HELLO went out, a request would be counted
    // under the provisional identity, ahead of the seeder's report.
    this.setHello(noiseHex, seeder, protocol.state === 'open' ? protocol.peer : null);
    if (seeder.hello !== null) this.armReport(noiseHex, seeder, conn);
    seeder.live = protocol.state !== 'closed';
    const offOpen = protocol.on('open', (hello) => {
      if (seeder.conn !== conn) return;
      this.setHello(noiseHex, seeder, hello);
      this.armReport(noiseHex, seeder, conn);
      this.changed();
    });
    // ADR 0015 amendment: its terms per core — only `free: true` makes a core askable for display.
    const offPrice = protocol.on('price', (p) => {
      if (seeder.conn !== conn || typeof p.core !== 'string') return;
      if (p.free === true) remember(seeder.free, p.core);
      else seeder.free.delete(p.core);
      this.changed();
    });
    // ADR 0018 amendment: what it still counts from before this connection.
    const offOwed = protocol.on('owed', (m) => {
      if (seeder.conn !== conn) return;
      this.onOwed(seeder, m);
    });
    const end = (): void => {
      if (seeder.conn !== conn || !seeder.live) return;
      seeder.live = false;
      this.fold(seeder);
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
      offOwed();
      offClose();
      end();
    };
  }

  /**
   * Route a core read for DISPLAY only (a profile core's image — never paid): a seeder is asked
   * for its blocks only after its `PRICE { free: true }` for it (see the header). The core must be
   * open; throws `RoutingUnsupported` like `attachCore` (fail closed). Returns a detach function
   * (reference counted).
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
      // Routed off first, while the core still counts as an image core: its requests on a seeder
      // that serves it free are released owed nothing (the router's `free`).
      detach();
      const n = (this.images.get(key) ?? 1) - 1;
      if (n <= 0) this.images.delete(key);
      else this.images.set(key, n);
      this.changed();
    };
  }

  /** Route a core's requests (one seeder per block, per-seeder caps). Returns a detach function. */
  attachCore(core: RoutableCore): () => void {
    const detach = this.router.attachCore(core);
    const key = toHex(core.key);
    this.cores.set(key, (this.cores.get(key) ?? 0) + 1);
    // A block we asked for (after its channel opened) came after its report on the stream.
    const onDownload = (_index: number, _bytes: number, peer: DownloadPeer): void => {
      this.delivered(toHex(peer.remotePublicKey));
    };
    core.on('download', onDownload);
    this.changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      core.off('download', onDownload);
      detach();
      const n = (this.cores.get(key) ?? 1) - 1;
      if (n <= 0) this.cores.delete(key);
      else this.cores.set(key, n);
      this.changed();
    };
  }

  /**
   * The `OnePeerRouter` budget: blocks `remote` may have outstanding toward us for a request on
   * `core` (see the header). Never `Infinity`.
   */
  budget(remote: string, core: string): number {
    const s = this.seeders.get(remote);
    if (!this.payable(core) && this.images.has(core)) {
      // ADR 0015 amendment: only a seeder that said `free` for it, on an open channel.
      if (s === undefined || !s.live || s.hello === null) return 0;
      return s.free.has(core) ? NO_PAY_INFLIGHT : 0;
    }
    if (s === undefined) return NO_PAY_INFLIGHT;
    if (!this.payable(core)) return NO_PAY_INFLIGHT;
    if (!s.live || s.hello === null || !this.o.settler.linked(remote)) return 0;
    const win = this.window(s.hello, this.o.policyFor(core as CoreKeyHex));
    const base = this.o.settler.owedBy(remote) + this.old(remote, s);
    return this.reserve(remote, s, base, Math.max(0, win - base));
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
      this.windowOver(s.hello, Math.min) - this.old(remote, s) - this.router.debt(remote);
    // At its cap when what it delivered fills its credit: blocks still in flight can no longer
    // complete a batch, and nothing more will be asked of it until a PAY is acknowledged.
    const atCap = this.o.settler.owedBy(remote) >= credit;
    return { batch: Math.max(1, Math.floor(credit / 2)), atCap };
  }

  /**
   * Whether the seeder `noiseHex` serves `core` outside payment on its current connection (its
   * `PRICE { free: true }`, the last word per core): the settler and the payer owe nothing for
   * such blocks. The word outlives the connection's close — requests of a free core released
   * after it are still owed nothing — and a new connection starts without it.
   */
  servesFree(noiseHex: string, core: string): boolean {
    return this.seeders.get(noiseHex)?.free.has(core) === true;
  }

  /** What `remote` said on its current connection about what it counts from before. */
  reportOf(remote: string): SeederReport | null {
    const s = this.seeders.get(remote);
    if (s === undefined) return null;
    return {
      done: s.report.done,
      claimed: sum(s.report.claimed),
      truncated: s.report.truncated,
    };
  }

  /**
   * Per seeder HELLO pubkey: what it may count against us right now (an upper bound: owed,
   * reported, lost, in flight) and its bare window — for the durable ledger's lazy clear.
   */
  seederReach(): SeederReach[] {
    const byPk = new Map<string, { live: number | null; dead: number; window: number }>();
    for (const [remote, s] of this.seeders) {
      if (s.pubkey === null) continue;
      const e = byPk.get(s.pubkey) ?? { live: null, dead: 0, window: s.bare };
      e.window = Math.max(e.window, s.bare);
      if (s.live && s.hello !== null) {
        const r = this.o.settler.owedBy(remote) + this.old(remote, s) + this.router.used(remote);
        e.live = Math.max(e.live ?? 0, r);
      } else e.dead += s.unpaid + sum(s.report.claimed) + this.router.lostOf(remote);
      byPk.set(s.pubkey, e);
    }
    return [...byPk].map(([pubkey, e]) => ({
      pubkey,
      // A live connection's estimate covers its pubkey's dead ones (before its report) or
      // replaced them (after): only without one do the dead ones add up.
      reach: e.live ?? e.dead,
      window: e.window,
    }));
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
    this.offAck();
    for (const s of this.seeders.values()) {
      if (s.report.timer !== null) clearTimeout(s.report.timer);
      s.report.timer = null;
    }
    this.router.close();
    managed.delete(this.o.pool);
  }

  // -------------------------------------------------------------- private

  /**
   * What `remote` counts against us from before this connection (see the header): its report
   * once complete, else what we know of (or its report so far, if larger), plus the whole window
   * when the ledger says an earlier run may have left it there.
   */
  private old(remote: string, s: Seeder): number {
    const claimed = sum(s.report.claimed);
    if (s.report.done) {
      const cut = s.report.truncated ? MAX_SEEDER_CREDIT : 0;
      return s.unpaid + claimed + cut;
    }
    const known = this.lostTo(remote, s) + this.earlier(s);
    return Math.max(known, claimed, s.report.truncated ? MAX_SEEDER_CREDIT : 0);
  }

  /** The ledger's word for an earlier run: `pubkey` may count its whole window (moot once reported). */
  private earlier(s: Seeder): number {
    const pk = s.pubkey;
    const ledger = this.o.ledger;
    if (ledger === undefined || pk === null || this.settled.has(pk)) return 0;
    let full: boolean;
    try {
      full = ledger.fullBefore(pk);
    } catch {
      full = true; // a ledger that cannot say: the safe side
    }
    return full ? MAX_SEEDER_CREDIT : 0;
  }

  /**
   * The ledger's write-ahead (see `SeederLedger`): before `credit` could bring what `remote`
   * counts to its bare window, `full` must be durable; if it cannot be written, the credit stops
   * one short of that window.
   */
  private reserve(remote: string, s: Seeder, base: number, credit: number): number {
    const ledger = this.o.ledger;
    const pk = s.pubkey;
    if (ledger === undefined || pk === null || credit < 1) return credit;
    const reach = base + credit;
    if (reach < s.bare) return credit;
    let ok: boolean;
    try {
      ok = ledger.full(pk) || ledger.markFull(pk);
    } catch {
      ok = false;
    }
    if (ok) return credit;
    this.o.logger.warn('the seeder ledger could not be written: credit held below the window');
    return Math.max(0, Math.min(credit, s.bare - 1 - base));
  }

  /** The router's `single`: an open seeder whose report is not in yet (one block at a time). */
  private awaitingReport(remote: string): boolean {
    const s = this.seeders.get(remote);
    return s !== undefined && s.live && s.hello !== null && !s.report.done;
  }

  /** The router's `free`: an image core `remote` serves outside payment on its connection. */
  private servesFreeImage(remote: string, core: string): boolean {
    return this.images.has(core) && !this.payable(core) && this.servesFree(remote, core);
  }

  /** Start the report's bound once the channel is open (see `REPORT_WAIT_MS`). */
  private armReport(remote: string, s: Seeder, conn: object): void {
    if (s.report.done || s.report.timer !== null || this.disposed) return;
    const t = setTimeout(() => {
      s.report.timer = null;
      if (s.conn === conn && s.live) this.complete(remote, s);
    }, this.reportWaitMs);
    (t as { unref?: () => void }).unref?.();
    s.report.timer = t;
  }

  /** An `OWED` on `s`'s current connection (the first per core; later ones are ignored). */
  private onOwed(s: Seeder, m: OwedMessage): void {
    const r = s.report;
    if (r.done || typeof m.core !== 'string' || r.claimed.has(m.core)) return;
    const n = owedBlocks(m.ranges);
    if (n === null) {
      r.truncated = true; // malformed: it may count anything
    } else {
      r.claimed.set(m.core, n);
      r.ranges += m.ranges.length;
      r.blocks += n;
      if (r.ranges >= MAX_OWED_RANGES || r.blocks >= MAX_OWED_BLOCKS) r.truncated = true;
    }
    this.changed();
  }

  /** An ACK from `remote`, applied by the settler: the report is in; re-base that core. */
  private onAck(remote: string, ack: AckMessage): void {
    const s = this.seeders.get(remote);
    if (s === undefined || !s.live || s.hello === null) return;
    this.complete(remote, s);
    const out = ack.outstanding;
    if (
      typeof ack.core === 'string' &&
      typeof out === 'number' &&
      Number.isSafeInteger(out) &&
      out >= 0
    ) {
      // What it counts on that core, less what is still owed on the link: an upper bound on the
      // rest (blocks it sent that are still in flight count twice — the safe side).
      const onLink = this.o.settler.owedByOn(remote, ack.core);
      s.report.claimed.set(ack.core, Math.max(0, out - onLink));
    }
    this.changed();
  }

  /** A block `remote` delivered on a routed core: asked after its channel opened, so its report is in. */
  private delivered(remote: string): void {
    const s = this.seeders.get(remote);
    if (s === undefined || !s.live || s.hello === null || s.report.done) return;
    this.complete(remote, s);
    this.changed();
  }

  /**
   * `remote`'s report is complete: what it said it counts replaces our estimate of everything
   * before this connection (see the header).
   */
  private complete(remote: string, s: Seeder): void {
    const r = s.report;
    if (r.done) return;
    r.done = true;
    if (r.timer !== null) clearTimeout(r.timer);
    r.timer = null;
    this.router.forgive(remote, r.lostAtStart);
    s.unpaid = 0;
    const pk = s.pubkey;
    if (pk === null) return;
    for (const other of this.byPubkey.get(pk) ?? []) {
      const o = this.seeders.get(other);
      if (other === remote || o === undefined || o.live || o.pubkey !== pk) continue;
      o.unpaid = 0;
      o.report.claimed.clear();
      this.router.forgive(other, this.router.lostOf(other));
    }
    this.settled.delete(pk);
    this.settled.add(pk);
    while (this.settled.size > MAX_SETTLED_PUBKEYS) {
      const oldest = this.settled.values().next();
      if (oldest.done === true) break;
      this.settled.delete(oldest.value);
    }
  }

  /**
   * `s`'s connection ended: what it reported and did not get paid stays counted (the next
   * connection starts from what we know again, until its own report).
   */
  private fold(s: Seeder): void {
    const r = s.report;
    if (r.timer !== null) clearTimeout(r.timer);
    r.timer = null;
    s.unpaid += sum(r.claimed) + (r.truncated ? Math.max(1, s.bare) : 0);
    r.claimed.clear();
    r.truncated = false;
  }

  /** A verified block of image core `core` from `remote`. */
  private onImageBlock(core: string, remote: string): void {
    if (this.payable(core)) return; // a play session made it a paid core: the settler's now
    const s = this.seeders.get(remote);
    if (s === undefined || !s.live || s.hello === null) return; // never asked: nothing counts it
    if (!s.report.done) this.complete(remote, s);
    if (s.free.has(core)) {
      this.changed();
      return;
    }
    // It turned the core sold while a request was out: it counts the block, we never pay for
    // browsing.
    s.unpaid++;
    this.changed();
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
    if (hello === null) return;
    seeder.bare = this.window(hello, null);
    if (hello.pubkey === seeder.pubkey) return;
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
    let total = 0;
    for (const [remote, s] of this.seeders) {
      if (!s.live || s.hello === null) continue;
      // The pool spans cores: the seeder's LARGEST window is what it may hold in all.
      const lost = this.old(remote, s) + this.router.debt(remote);
      total += Math.max(0, this.windowOver(s.hello, Math.max) - lost);
    }
    this.o.pool.setLimit(Math.max(this.floor, Math.min(MAX_POOL_CREDIT, total)));
    this.router.refresh();
  }

  private evict(): void {
    for (const [remote, s] of this.seeders) {
      if (this.seeders.size <= MAX_REMEMBERED_SEEDERS) return;
      if (s.live) continue;
      this.seeders.delete(remote);
      if (s.pubkey !== null) this.unindex(remote, s.pubkey);
    }
  }
}

/** Pools a live `SeederCredit` resizes. */
const managed = new WeakSet<CreditPool>();

function newReport(lostAtStart: number): Report {
  return {
    done: false,
    claimed: new Map(),
    ranges: 0,
    blocks: 0,
    truncated: false,
    lostAtStart,
    timer: null,
  };
}

function sum(m: ReadonlyMap<string, number>): number {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
}

/**
 * Blocks in an `OWED`'s ranges; `null` when they are not what the contract allows (the real codec
 * refuses those, a loopback end does not): the report may then count anything.
 */
function owedBlocks(ranges: unknown): number | null {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > MAX_OWED_RANGES) return null;
  let n = 0;
  let prev = -2;
  for (const r of ranges as unknown[]) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [from, to] = r as [unknown, unknown];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
    const f = from as number;
    const t = to as number;
    if (f < 0 || t < f || f <= prev + 1) return null;
    n += t - f + 1;
    if (n > MAX_OWED_BLOCKS) return null;
    prev = t;
  }
  return n;
}

/** Add `core` to a per-seeder set, dropping the oldest past the bound. */
function remember(set: Set<string>, core: string): void {
  set.delete(core);
  set.add(core);
  while (set.size > MAX_FREE_CORES_PER_SEEDER) {
    const oldest = set.values().next();
    if (oldest.done === true) break;
    set.delete(oldest.value);
  }
}
