/**
 * UpstreamPayer — the gateway (and the desktop worker, via `ViewerPayer`) as a VIEWER toward the
 * seeders it pulls from (build-plan §5 "pays upstream"; SECURITY.md invariant 1 "pay after
 * verify").
 *
 * Per (upstream peer, core) it counts Hypercore `download` events — each one is a block whose
 * Merkle proof already verified — and asks `PaymentEngineViewer.pay(range, seeder, policy)` for
 * a `PayMessage`, which it puts on the wire through the peer's `PayProtocol`.
 *
 * Rules (security review, docs/security-review.md):
 *
 *   - **The price is the manifest's (F1, F2).** `policyFor` returns the policy the user was
 *     shown — for the gateway, the per-core MANIFEST policy (`manifestPolicyResolver`); a core
 *     without one is not paid. The seeder's asking price (its HELLO, or a later `PRICE` from
 *     `effectiveFromBlock` on) may only LOWER it: a seeder that asks more than the manifest is
 *     not paid at all, and neither its split nor its mint list is taken on trust (the split is
 *     the manifest's; the mint must be one the seeder, our wallet and the manifest all accept).
 *   - **One unacknowledged PAY per peer × core, carry per channel (F30).** The creator's carry
 *     (ADR 0010 §3.1) is scoped to this `pay/1` channel: it starts at 0, travels as
 *     `opts.carryIn`, and advances only on the matching `ACK ok`. A rejected PAY leaves it where
 *     the seeder left it, so the next PAY is accepted; a new channel starts from 0 like the
 *     seeder's rebind does. Waiting for the ACK also batches: blocks that land meanwhile go
 *     into the next PAY (fewer PAYs, fewer DLEQ checks at the seeder — F5).
 *   - A rejected PAY is never re-sent: the seeder set is locked to the seeder, so a seeder that
 *     "rejects" and keeps the proofs must not be paid twice for the same blocks.
 *   - **A PAY that cannot be built stops only its own core (fix round 4).** `engine.pay` failing
 *     for one core (the desktop host refusing a core whose play session is gone, a wallet
 *     error) is logged by its outcome code alone and the peer's other cores are paid as usual.
 *     A range whose session is gone (`session-closed`) or whose PAY the host refuses for good
 *     (`forbidden`) is given up at once — that RANGE, not the core: another play session of the
 *     same core may still pay its own blocks (fix round 5) — and the core's next run is tried in
 *     the same pass, with a fresh streak (the core's failure streak is cleared: lane
 *     R6-reconcile). Given-up blocks are never paid, and `onUnpayable` reports them so the
 *     downloader settles them as unpaid, explicitly (the seeder still counts them against its
 *     window).
 *   - **A PAY refused "for now" is deferred (lane R6-reconcile, one mechanism for I2-paygate
 *     and fix round 5).** `rate-limited` is the desktop host's "retry later" (a melt at the PAY's
 *     mint, or a PAY that waited too long for its turn; nothing was spent, ADR 0012 amendment
 *     2026-09-25). A melt may hold it for 300 s, so it never counts toward giving up: the core
 *     is asked again after `PAY_RETRY_LATER_MS`, doubling per refusal in a row up to
 *     `PAY_RETRY_LATER_MAX_MS`, by its own retry timer or any later pass — never in a loop.
 *   - **Any other failure is transient (fix round 5): retried after a backoff, bounded in TIME.**
 *     The core waits `PAY_RETRY_BASE_MS`, doubling per failure up to `PAY_RETRY_MAX_MS`, and is
 *     then retried by the next pass of any kind (a block, an ACK, pool pressure, `flush()`) or by
 *     its own retry timer — a seeder at its cap sends nothing more and pressure may never come.
 *     Only a failure that has lasted `PAY_GIVE_UP_MS` over at least `MAX_PAY_FAILURES` attempts
 *     gives its range up (and, until a PAY of that core succeeds, each later failing range at
 *     once): a mint blip or an auto top-up in flight is waited out, and a burst of passes (a
 *     close drain polls every 25 ms) can never write a transient failure off in under a second.
 *     A streak is one kind: a deferred refusal ends a transient streak (its time does not count),
 *     and the next transient failure starts a new one.
 *   - **Time is monotonic (lane R6-reconcile).** Streaks, backoffs and the give-up read an
 *     injectable clock (`clock`; default `monotonicClock()`), never `Date.now()`: a wall-clock
 *     step (NTP, a resume from suspend) must neither write a transient failure off early nor hold
 *     a retry back. A retry timer that fires makes the backoffs due by then retryable whatever
 *     the clock reads, so a clock that stands still cannot stall a retry either. A reading that
 *     goes back, is not a finite number or throws counts as the latest good one: the clock stands
 *     still (nothing is given up, and the retry timers still bring every retry).
 *
 * Only peers that sent a verified `HELLO` (protocol `open`) are paid; blocks downloaded before
 * it are counted and become payable the moment it arrives. Every `BlockRange` carries `core`
 * (v3/v5).
 */
import type {
  BlockRange,
  CoreKeyHex,
  HelloMessage,
  MintUrl,
  PayMessage,
  PaymentEngineViewer,
  PayProtocol,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { payment } from '@sovit/core';
import type Hypercore from 'hypercore';
import type { Logger } from '@sovit/seeder';
import { toHex } from '@sovit/seeder';

import type { CreditPool } from './credit.js';
import type { SeederBatch } from './seeder-credit.js';

/** Policy to pay `core` blocks from this peer under; `null` = do not pay (log + skip). */
export type UpstreamPolicyResolver = (
  core: CoreKeyHex,
  hello: HelloMessage,
  peer: string,
) => PricePolicy | null;

/** How long a short tail waits for more blocks before it is paid anyway. */
export const DEFAULT_TAIL_MS = 2000;
/** Consecutive failures to build a PAY for one core before its blocks may be given up. */
export const MAX_PAY_FAILURES = 3;
/** Fix round 5: the first wait before a failed PAY is tried again (doubles per failure). */
export const PAY_RETRY_BASE_MS = 250;
/** Fix round 5: the longest wait between two tries of a failed PAY. */
export const PAY_RETRY_MAX_MS = 4000;
/**
 * Fix round 5: how long a core's PAYs must have kept failing (over at least `MAX_PAY_FAILURES`
 * attempts) before a failing range is given up. Longer than a mint blip or an auto top-up, and
 * longer than the desktop's close drain (5 s), which therefore never writes a transient failure
 * off itself: once the drain is over the session is gone and the next try is refused for good.
 */
export const PAY_GIVE_UP_MS = 30_000;
/**
 * Lane R6-reconcile (from I2-paygate): after a PAY refused "for now" (`rate-limited`), the core is
 * asked again after this long …
 */
export const PAY_RETRY_LATER_MS = 2_000;
/** … doubling per refusal in a row, up to this. A deferred refusal is never given up. */
export const PAY_RETRY_LATER_MAX_MS = 30_000;
/**
 * The most the fallback clock (`monotonicClock` where the runtime has no `performance`) advances
 * between two reads: a wall-clock step forward counts at most this much.
 */
export const MAX_CLOCK_STEP_MS = 2 * PAY_RETRY_MAX_MS;

/** The wait after the `n`th consecutive transient failure (n ≥ 1). */
function retryDelay(n: number): number {
  return Math.min(PAY_RETRY_MAX_MS, PAY_RETRY_BASE_MS * 2 ** Math.min(16, Math.max(0, n - 1)));
}
/** The wait after the `n`th consecutive deferred refusal (n ≥ 1). */
function laterDelay(n: number): number {
  return Math.min(
    PAY_RETRY_LATER_MAX_MS,
    PAY_RETRY_LATER_MS * 2 ** Math.min(16, Math.max(0, n - 1)),
  );
}
/** Outcome codes after which a core's blocks can never be paid: they are given up at once. */
const FINAL_OUTCOMES: ReadonlySet<string> = new Set(['session-closed', 'forbidden']);
/**
 * Outcome codes that mean "not now" (nothing was spent): retried on their own cadence
 * (`PAY_RETRY_LATER_MS`), never given up. The desktop host's `rate-limited` (ADR 0012 amendment
 * 2026-09-25).
 */
const DEFERRED_OUTCOMES: ReadonlySet<string> = new Set(['rate-limited']);

/** The two ways a failed PAY is retried (see the module comment). */
export type PayFailureKind = 'transient' | 'deferred';

/** How a failed PAY with outcome `code` is handled: given up at once, deferred or transient. */
export function payFailureClass(code: string): 'final' | PayFailureKind {
  if (FINAL_OUTCOMES.has(code)) return 'final';
  return DEFERRED_OUTCOMES.has(code) ? 'deferred' : 'transient';
}

/** What `monotonicClock` reads (the runtime's globals by default; tests pass their own). */
export interface ClockSources {
  readonly performance?: { readonly now?: unknown } | undefined;
  readonly dateNow?: () => number;
}

/**
 * A monotonic clock in ms for the payer's streaks, backoffs and give-up: `performance.now()` where
 * the runtime has it (Node: the gateway, the host, tests). Bare (the desktop worker) has no
 * `performance`: there it is `Date.now()` made steady — never backwards, and a step forward
 * counts at most `MAX_CLOCK_STEP_MS` per read. During a transient streak — the only thing whose
 * age matters (the give-up) — the payer reads it at least every `PAY_RETRY_MAX_MS`, so it keeps
 * time there; elsewhere (a deferred streak, spaced up to `PAY_RETRY_LATER_MAX_MS`; between
 * streaks) it may fall behind, which only delays a give-up. A retry timer that fires makes a
 * backoff due whatever this reads.
 */
export function monotonicClock(src: ClockSources = globalThis): () => number {
  const perf = src.performance;
  if (perf !== undefined && typeof perf.now === 'function') {
    const now = perf.now as () => number;
    return () => now.call(perf);
  }
  const wall = src.dateNow ?? Date.now;
  let last = wall();
  let t = 0;
  return () => {
    const w = wall();
    const d = w - last;
    last = w;
    // NaN (a clock that is not a number) and steps back count nothing.
    if (d > 0) t += Math.min(d, MAX_CLOCK_STEP_MS);
    return t;
  };
}

/**
 * The outcome code of a failed `engine.pay` (`<code>: …` errors, or a `code` field), for logs
 * and decisions — never the message, which may name a core or a peer. `error` when unknown.
 */
export function payOutcome(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z][a-z-]{0,39}$/.test(code)) return code;
  const msg = err instanceof Error ? err.message : '';
  const m = /^([a-z][a-z-]{0,39}):/.exec(msg);
  return m?.[1] ?? 'error';
}

export interface UpstreamPayerOptions {
  readonly engine: PaymentEngineViewer;
  readonly logger: Logger;
  /** The shortest run paid on its own (without `credit`, the batch size). */
  readonly payEveryBlocks: number;
  /**
   * The downloader's `CreditPool` (security review F5 batching, F37). Given, PAYs batch to half
   * the pool (`max(payEveryBlocks, ⌊limit / 2⌋)` blocks per peer) — fewer PAYs, fewer DLEQ checks
   * at the seeder — and the moment the pool is under pressure (full, or an acquirer waiting)
   * every pending block is paid, so batching can never stall a download that needs credit.
   */
  readonly credit?: Pick<CreditPool, 'limit' | 'pressured' | 'onPressure'>;
  /**
   * Issue #8: the batch for ONE seeder (`SeederCredit.seederBatch`): half that seeder's window,
   * and "pay now" once it is at its cap (nothing more can be asked of it until a PAY lands).
   * Given and known, it replaces the half-the-pool batch for that seeder; `null` = unknown.
   */
  readonly seederBatch?: (noiseHex: string) => SeederBatch | null;
  /**
   * A run shorter than a batch is paid once this many ms pass without a new block from that peer
   * (default `DEFAULT_TAIL_MS`): the end of a video is not left unpaid until the session closes
   * (a crash meanwhile would never pay it). `0` = only at `flush()`.
   */
  readonly tailMs?: number;
  /** Mints the gateway can pay with; the first one the seeder also accepts is used. */
  readonly ownMints: readonly MintUrl[];
  readonly policyFor: UpstreamPolicyResolver;
  /**
   * Blocks of `range` downloaded from `noiseHex` will never be paid (their PAY cannot be built:
   * see the module comment). The downloader settles them as UNPAID (`CreditSettler.settleUnpaid`)
   * so the seeder's credit keeps them for good. Called once per range given up.
   */
  readonly onUnpayable?: (noiseHex: string, range: BlockRange) => void;
  /**
   * Fix round 5: the longest prefix of `range` (same core, same first block) that ONE PAY may
   * cover — the desktop worker ends it where a play session's blob ends, because the host builds a
   * PAY for one session and only within that session's blocks; two renditions stored side by side
   * in one core would otherwise merge into a run no session covers. Anything else it returns (a
   * different core or first block, an empty or longer range, a throw) is ignored: the range is
   * paid as it is. Default: no bound.
   */
  readonly boundRange?: (range: BlockRange) => BlockRange;
  /**
   * Lane R6-reconcile: a monotonic clock in ms for failure streaks, backoffs and the give-up
   * (default `monotonicClock()`). Never the wall clock: see the module comment. A reading that
   * goes back, is not a finite number or throws is not taken (the latest good one stands).
   */
  readonly clock?: () => number;
}

interface PriceOverride {
  readonly satsPerBlock: Sats;
  readonly effectiveFromBlock: number;
}

interface InFlight {
  readonly fromBlock: number;
  readonly toBlock: number;
  /** The creator carry after this PAY — committed only if the seeder ACKs it ok. */
  readonly carryOut: number;
}

interface FailureStreak {
  /**
   * `transient` counts toward giving up, `deferred` (a PAY refused "for now") never does; a
   * failure of the other kind starts a new streak.
   */
  readonly kind: PayFailureKind;
  readonly n: number;
  /** The payer's clock at the streak's first failure. */
  readonly since: number;
  /** Not tried again before this (the payer's clock); `-Infinity` once its retry timer fired. */
  readonly retryAt: number;
}

interface PeerState {
  readonly noiseHex: string;
  readonly protocol: PayProtocol;
  hello: HelloMessage | null;
  /** core → the latest `PRICE` for it (v5: prices are per core). */
  readonly price: Map<CoreKeyHex, PriceOverride>;
  /** core → sorted set of downloaded-but-unpaid block indexes. */
  readonly pending: Map<CoreKeyHex, Set<number>>;
  /** core → indexes already paid (replay guard). */
  readonly paid: Map<CoreKeyHex, Set<number>>;
  /** core → the creator carry the seeder holds for this channel (ADR 0010 §3.1). */
  readonly carry: Map<CoreKeyHex, number>;
  /** core → the PAY awaiting its ACK (at most one per core). */
  readonly inflight: Map<CoreKeyHex, InFlight>;
  /**
   * core → its streak of failures to build a PAY (fix round 5; its kind: lane R6-reconcile): how
   * many, since when, and when it may be tried again. Cleared by the core's next PAY that is
   * built, and when one of its ranges is given up for good (`session-closed`, `forbidden`).
   */
  readonly failures: Map<CoreKeyHex, FailureStreak>;
  /** Wakes the peer when a failed core may be tried again (fix round 5). */
  retryTimer: { readonly at: number; readonly handle: ReturnType<typeof setTimeout> } | null;
  /** `flush()` is draining: runs unlocked by an ACK are paid however short. */
  draining: boolean;
  /**
   * The tail timer fired, or `flush()` ran: every pending run is paid however short, one per ACK
   * (one PAY per core in flight), until none is left or a new block arrives. Without it a quiet
   * peer's SCATTERED runs — hypercore spreads blocks over peers, so one peer's are rarely
   * contiguous — got one PAY from the timer and the rest waited forever once batches were
   * per seeder (issue #8; the old small pool's pressure used to mask it).
   */
  due: boolean;
  /** Pays the short tail after `tailMs` without a new block (reset per block). */
  tailTimer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
  closed: boolean;
}

export interface UpstreamPayerStats {
  readonly pays: number;
  readonly blocksPaid: number;
  readonly acksOk: number;
  readonly acksRejected: number;
  readonly skippedNoPolicy: number;
  /** PAYs not sent because the seeder asked more than the manifest price. */
  readonly skippedOverpriced: number;
  /** PAYs that could not be built (`engine.pay` failed). */
  readonly payFailures: number;
  /** Blocks given up: their PAY could not be built for good (settled as unpaid). */
  readonly unpayableBlocks: number;
}

/** Read through a function so TS's property narrowing does not survive the `await`s. */
function isClosed(s: PeerState): boolean {
  return s.closed;
}

function contiguousRuns(sorted: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  let start: number | null = null;
  let prev = 0;
  for (const i of sorted) {
    if (start === null) {
      start = i;
    } else if (i !== prev + 1) {
      runs.push([start, prev]);
      start = i;
    }
    prev = i;
  }
  if (start !== null) runs.push([start, prev]);
  return runs;
}

export class UpstreamPayer {
  private readonly engine: PaymentEngineViewer;
  private readonly log: Logger;
  private readonly payEvery: number;
  private readonly ownMints: readonly MintUrl[];
  private readonly policyFor: UpstreamPolicyResolver;
  private readonly credit: UpstreamPayerOptions['credit'];
  private readonly seederBatch: UpstreamPayerOptions['seederBatch'];
  private readonly onUnpayable: UpstreamPayerOptions['onUnpayable'];
  private readonly boundRange: UpstreamPayerOptions['boundRange'];
  private readonly clock: () => number;
  /** The latest good reading of `clock` (see `now`). */
  private lastClock = Number.NEGATIVE_INFINITY;
  /** `dispose()` ran: no timer is armed and no PAY is built any more. */
  private disposed = false;
  /** Ranges being paid now however short their runs (`hurry`: a closing session's tail). */
  private readonly hurried = new Set<BlockRange>();
  private readonly tailMs: number;
  private readonly offPressure: () => void;
  private readonly peers = new Map<string, PeerState>();
  private readonly counters = {
    pays: 0,
    blocksPaid: 0,
    acksOk: 0,
    acksRejected: 0,
    skippedNoPolicy: 0,
    skippedOverpriced: 0,
    payFailures: 0,
    unpayableBlocks: 0,
  };

  constructor(o: UpstreamPayerOptions) {
    this.engine = o.engine;
    this.log = o.logger.child({ component: 'upstream-payer' });
    this.payEvery = Math.max(1, o.payEveryBlocks);
    this.ownMints = o.ownMints;
    this.policyFor = o.policyFor;
    this.credit = o.credit;
    this.seederBatch = o.seederBatch;
    this.onUnpayable = o.onUnpayable;
    this.boundRange = o.boundRange;
    this.clock = o.clock ?? monotonicClock();
    this.tailMs = o.tailMs ?? DEFAULT_TAIL_MS;
    // Pressure: pay whatever is held so the pool can refill.
    this.offPressure =
      o.credit?.onPressure(() => {
        for (const s of this.peers.values()) this.schedule(s, s.draining || s.due);
      }) ?? ((): void => undefined);
  }

  /**
   * The payer is being discarded (after `flush()`): stop listening to the credit pool, cancel
   * every tail and retry timer, and build no PAY from now on — a PAY that fails after this arms no
   * new retry (lane R6-reconcile: the desktop's `ViewerPayer.close()` relies on it to cancel a
   * retry of a PAY refused "for now").
   */
  dispose(): void {
    this.disposed = true;
    this.offPressure();
    for (const s of this.peers.values()) {
      this.clearTail(s);
      this.clearRetry(s);
    }
  }

  /** Read through a method so TS's narrowing of the field does not survive the `await`s. */
  private isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * The payer's time: `clock`, never read backwards. A reading that is not a finite number, one
   * that goes back, or a clock that throws gives the latest good reading (0 before any) — a bad
   * injected clock stands still, which gives nothing up (a streak never ages) and cannot loop (a
   * backoff it cannot end is ended by its retry timer).
   */
  private now(): number {
    let t: number;
    try {
      t = this.clock();
    } catch {
      t = Number.NaN;
    }
    if (Number.isFinite(t) && t > this.lastClock) this.lastClock = t;
    return Number.isFinite(this.lastClock) ? this.lastClock : 0;
  }

  /**
   * Blocks per PAY to this peer right now: 1 under pool pressure or at the seeder's cap; else
   * half the seeder's window (issue #8) when known, else half the pool, never below
   * `payEveryBlocks`; without either, `payEveryBlocks`.
   */
  private batchBlocks(state: PeerState): number {
    const c = this.credit;
    if (c?.pressured === true) return 1;
    const own = this.seederBatch?.(state.noiseHex) ?? null;
    if (own !== null) {
      if (own.atCap) return 1;
      // A malformed batch (NaN, < 1) must not stop payments: fall back to one block.
      const b = Number.isSafeInteger(own.batch) && own.batch >= 1 ? own.batch : 1;
      return Math.max(this.payEvery, b);
    }
    if (c === undefined) return this.payEvery;
    return Math.max(this.payEvery, Math.floor(c.limit / 2));
  }

  /** The seeder can be asked for nothing more until it is paid (issue #8). */
  private atCap(state: PeerState): boolean {
    return this.seederBatch?.(state.noiseHex)?.atCap === true;
  }

  stats(): UpstreamPayerStats {
    return { ...this.counters };
  }

  /** Register a peer's `pay/1` instance. Returns a detach function. */
  attachPeer(noiseHex: string, protocol: PayProtocol): () => void {
    const state: PeerState = {
      noiseHex,
      protocol,
      hello: protocol.peer,
      price: new Map(),
      pending: new Map(),
      paid: new Map(),
      carry: new Map(),
      inflight: new Map(),
      failures: new Map(),
      retryTimer: null,
      draining: false,
      due: false,
      tailTimer: null,
      chain: Promise.resolve(),
      closed: false,
    };
    this.peers.set(noiseHex, state);
    const offs = [
      protocol.on('open', (hello) => {
        state.hello = hello;
        this.log.info('upstream HELLO', {
          peer: noiseHex,
          pubkey: hello.pubkey,
          satsPerBlock: hello.satsPerBlock,
        });
        // Pre-HELLO downloads become payable now; runs shorter than `payEveryBlocks`
        // wait for more blocks or for `flush()` (close), like any other tail.
        this.schedule(state, false);
      }),
      protocol.on('price', (p) => {
        state.price.set(p.core, {
          satsPerBlock: p.satsPerBlock,
          effectiveFromBlock: p.effectiveFromBlock,
        });
        this.log.info('upstream PRICE', {
          peer: noiseHex,
          core: p.core,
          satsPerBlock: p.satsPerBlock,
          effectiveFromBlock: p.effectiveFromBlock,
        });
      }),
      protocol.on('ack', (ack) => {
        if (ack.ok) this.counters.acksOk++;
        else {
          this.counters.acksRejected++;
          this.log.warn('upstream rejected PAY', {
            peer: noiseHex,
            fromBlock: ack.fromBlock,
            toBlock: ack.toBlock,
            reason: ack.reason,
          });
        }
        const f = state.inflight.get(ack.core);
        if (f?.fromBlock !== ack.fromBlock || f.toBlock !== ack.toBlock) return;
        state.inflight.delete(ack.core);
        // The carry moves only when the seeder accepted the PAY that moved it.
        if (ack.ok) state.carry.set(ack.core, f.carryOut);
        this.schedule(state, state.draining || state.due);
      }),
      protocol.on('close', () => {
        state.closed = true;
      }),
    ];
    return () => {
      state.closed = true;
      this.clearTail(state);
      this.clearRetry(state);
      for (const off of offs) off();
      if (this.peers.get(noiseHex) === state) this.peers.delete(noiseHex);
    };
  }

  /** Subscribe to a core's `download` events. Returns a detach function. */
  attachCore(core: Hypercore): () => void {
    const coreHex = toHex(core.key) as CoreKeyHex;
    const handler = (
      index: number,
      _byteLength: number,
      peer: { remotePublicKey: Uint8Array },
    ): void => {
      this.onDownload(coreHex, index, toHex(peer.remotePublicKey));
    };
    core.on('download', handler);
    return () => {
      core.off('download', handler);
    };
  }

  /** A verified block arrived from `noiseHex` for `core`. Synchronous; pays asynchronously. */
  onDownload(core: CoreKeyHex, index: number, noiseHex: string): void {
    const state = this.peers.get(noiseHex);
    if (!state || state.closed) return;
    if (state.paid.get(core)?.has(index)) return;
    let set = state.pending.get(core);
    if (!set) {
      set = new Set();
      state.pending.set(core, set);
    }
    set.add(index);
    state.due = false; // not quiet any more: batching resumes, the tail timer restarts
    if (set.size >= this.payEvery || this.atCap(state) || this.isHurried(core, index, index))
      this.schedule(state, false);
    this.armTail(state);
  }

  /**
   * Fix round 5: pay every block of `range` that is pending — and every one that lands later — at
   * once, however short its runs, until the returned function is called (the desktop's close
   * drain: a closing session's tail, and nothing else, is paid now; the other sessions of that core
   * keep batching). One PAY per core stays in flight, so a run waits for the ACK before it.
   */
  hurry(range: BlockRange): () => void {
    const r: BlockRange = { core: range.core, fromBlock: range.fromBlock, toBlock: range.toBlock };
    this.hurried.add(r);
    for (const s of this.peers.values()) this.schedule(s, s.draining || s.due);
    return () => {
      this.hurried.delete(r);
    };
  }

  /** Blocks `from..to` of `core` overlap a hurried range. */
  private isHurried(core: CoreKeyHex, from: number, to: number): boolean {
    for (const r of this.hurried)
      if (r.core === core && r.fromBlock <= to && from <= r.toBlock) return true;
    return false;
  }

  /** (Re)start the peer's tail timer: a quiet peer's short runs get paid. */
  private armTail(state: PeerState): void {
    const ms = this.tailMs;
    if (ms <= 0 || this.disposed) return;
    this.clearTail(state);
    const t = setTimeout(() => {
      state.tailTimer = null;
      if (state.closed) return;
      state.due = true;
      this.schedule(state, true);
    }, ms);
    (t as { unref?: () => void }).unref?.();
    state.tailTimer = t;
  }

  private clearTail(state: PeerState): void {
    if (state.tailTimer !== null) clearTimeout(state.tailTimer);
    state.tailTimer = null;
  }

  /**
   * Fix round 5: wake the peer at `at` (a failed core may be tried again then), unless it is woken
   * earlier already. The pass it runs is an ordinary one: the failed core's run is due by its own
   * streak (see `payPending`), the other cores batch as usual.
   */
  private armRetry(state: PeerState, at: number): void {
    if (state.closed || this.disposed) return;
    if (state.retryTimer !== null && state.retryTimer.at <= at) return;
    this.clearRetry(state);
    const handle = setTimeout(
      () => {
        state.retryTimer = null;
        if (state.closed) return;
        // The timer measured the wait (the runtime's own timers are monotonic): every backoff due
        // by `at` is over, whatever the clock reads now — a clock that stands still (the steady
        // fallback after a step back) cannot hold a retry back (lane R6-reconcile).
        for (const [core, f] of state.failures)
          if (f.retryAt <= at)
            state.failures.set(core, { ...f, retryAt: Number.NEGATIVE_INFINITY });
        this.schedule(state, state.draining || state.due);
      },
      Math.max(1, at - this.now()),
    );
    (handle as { unref?: () => void }).unref?.();
    state.retryTimer = { at, handle };
  }

  private clearRetry(state: PeerState): void {
    if (state.retryTimer !== null) clearTimeout(state.retryTimer.handle);
    state.retryTimer = null;
  }

  /**
   * Pay every pending run for every peer (or one peer), shorter ones included. Used at close and
   * by tests. A core with a PAY awaiting its ACK pays its next run when the ACK arrives; this
   * resolves once no more work is queued (it does not wait for ACKs that never come).
   */
  async flush(noiseHex?: string): Promise<void> {
    const targets = noiseHex === undefined ? [...this.peers.values()] : [this.peers.get(noiseHex)];
    for (const s of targets) {
      if (!s) continue;
      s.draining = true;
      s.due = true;
      try {
        this.schedule(s, true);
        // ACKs that arrive while we wait schedule more work on the same chain: follow it.
        let seen: Promise<void> | null = null;
        while (seen !== s.chain) {
          seen = s.chain;
          await seen;
        }
      } finally {
        s.draining = false;
      }
    }
  }

  private schedule(state: PeerState, force: boolean): void {
    state.chain = state.chain
      .then(() => this.payPending(state, force))
      .catch((err: unknown) => {
        this.log.error('upstream pay failed', { peer: state.noiseHex, error: err });
      });
  }

  private async payPending(state: PeerState, force: boolean): Promise<void> {
    if (state.closed || this.disposed || state.hello === null) return;
    const hello = state.hello;
    const batch = this.batchBlocks(state);
    // The seeder's window counts this peer's blocks across cores: once the peer's pending total
    // reaches a batch, its runs are paid however short (per-core runs could otherwise each wait).
    let peerPending = 0;
    for (const set of state.pending.values()) peerPending += set.size;
    const batching = this.credit !== undefined || this.seederBatch !== undefined;
    const due = force || (batching && peerPending >= batch);
    for (const [core, set] of state.pending) {
      // Fix round 5: a range given up for good does not end the core's turn — its next run (the
      // blocks of another play session of the same core) is tried in the same pass.
      for (;;) {
        // `dispose()` may run while a PAY is being built: nothing more is built after it.
        if (this.isDisposed()) return;
        if (set.size === 0 || state.inflight.has(core)) break;
        // A core whose last PAY failed waits out its backoff (fix round 5: bounded in time, not in
        // passes); once it is over, its run is due however short — it was due when it failed.
        const failed = state.failures.get(core);
        if (failed !== undefined && this.now() < failed.retryAt) {
          this.armRetry(state, failed.retryAt);
          break;
        }
        const sorted = [...set].sort((a, b) => a - b);
        const run = contiguousRuns(sorted).find(
          ([from, to]) =>
            due || failed !== undefined || to - from + 1 >= batch || this.isHurried(core, from, to),
        );
        if (run === undefined) break;
        // One PAY per core in flight: the first price segment of the first payable run now, the
        // rest when its ACK arrives.
        const [split] = this.splitAtPrice(state, { core, fromBlock: run[0], toBlock: run[1] });
        if (split === undefined) break;
        const range = this.bound(split);
        const policy = this.resolvePolicy(state, core, hello, range);
        if (policy === null) break;
        const mint = hello.acceptedMints.find(
          (m) => this.ownMints.includes(m) && policy.mints.includes(m),
        );
        if (mint === undefined) {
          this.counters.skippedNoPolicy++;
          this.log.warn('no common mint with upstream — not paying', {
            peer: state.noiseHex,
            core,
          });
          break;
        }
        const carryIn = state.carry.get(core) ?? 0;
        const amount = (range.toBlock - range.fromBlock + 1) * policy.satsPerBlock;
        const carryOut = payment.splitPay(amount, policy.split, carryIn).carryOut;
        let msg: PayMessage;
        try {
          msg = await this.engine.pay(
            range,
            { pubkey: hello.pubkey, p2pk: hello.p2pk, mint },
            policy,
            { carryIn },
          );
        } catch (err) {
          // Fix round 4: this core only — the peer's other cores are paid as usual.
          if (isClosed(state)) return;
          if (this.payFailed(state, core, set, range, payOutcome(err))) continue;
          break;
        }
        if (isClosed(state)) return;
        state.failures.delete(core);
        state.inflight.set(core, { fromBlock: range.fromBlock, toBlock: range.toBlock, carryOut });
        state.protocol.sendPay(msg);
        this.counters.pays++;
        this.counters.blocksPaid += range.toBlock - range.fromBlock + 1;
        let paidSet = state.paid.get(core);
        if (!paidSet) {
          paidSet = new Set();
          state.paid.set(core, paidSet);
        }
        for (let i = range.fromBlock; i <= range.toBlock; i++) {
          paidSet.add(i);
          set.delete(i);
        }
        this.log.debug('PAY sent upstream', {
          peer: state.noiseHex,
          core,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        });
        break;
      }
    }
    let left = 0;
    for (const set of state.pending.values()) left += set.size;
    if (left === 0) state.due = false;
  }

  /**
   * `engine.pay` failed for `range` of `core` with outcome `code` (see the module comment): give
   * the range up when it can never be paid, else keep it owed and back the core off — deferred
   * (never given up) or transient (given up once the streak has lasted). Returns whether the
   * range was given up (the core's next run may be tried at once).
   */
  private payFailed(
    state: PeerState,
    core: CoreKeyHex,
    set: Set<number>,
    range: BlockRange,
    code: string,
  ): boolean {
    this.counters.payFailures++;
    const kind = payFailureClass(code);
    let final = kind === 'final';
    if (kind === 'final') {
      // Lane R6-reconcile (the round-5 verifier): the streak ends with the range it gave up, so
      // a later transient failure of the core (another play session's blocks) starts afresh
      // instead of inheriting an old streak and being written off at once.
      state.failures.delete(core);
    } else {
      const now = this.now();
      const prev = state.failures.get(core);
      const same = prev?.kind === kind ? prev : undefined;
      const n = (same?.n ?? 0) + 1;
      const since = same?.since ?? now;
      // Only a transient streak gives up, once it has lasted long enough; a deferred one never.
      final = kind === 'transient' && n >= MAX_PAY_FAILURES && now - since >= PAY_GIVE_UP_MS;
      const retryAt = now + (kind === 'deferred' ? laterDelay(n) : retryDelay(n));
      state.failures.set(core, { kind, n, since, retryAt });
      if (!final) this.armRetry(state, retryAt);
    }
    // The outcome code only: the message may name a core, a peer or a range.
    this.log.warn('a PAY could not be built — that core is skipped', {
      outcome: code,
      givenUp: final,
    });
    if (!final) return false;
    let paidSet = state.paid.get(core);
    if (!paidSet) {
      paidSet = new Set();
      state.paid.set(core, paidSet);
    }
    for (let i = range.fromBlock; i <= range.toBlock; i++) {
      set.delete(i);
      paidSet.add(i); // never paid: a re-download owes nothing new
    }
    this.counters.unpayableBlocks += range.toBlock - range.fromBlock + 1;
    try {
      this.onUnpayable?.(state.noiseHex, range);
    } catch {
      // the listener's failure is its own
    }
    return true;
  }

  /** `range` cut to what one PAY may cover (`boundRange`); a bad answer is ignored. */
  private bound(range: BlockRange): BlockRange {
    const f = this.boundRange;
    if (f === undefined) return range;
    let b: BlockRange;
    try {
      b = f(range);
    } catch {
      return range;
    }
    if (
      b.core !== range.core ||
      b.fromBlock !== range.fromBlock ||
      !Number.isSafeInteger(b.toBlock) ||
      b.toBlock < range.fromBlock ||
      b.toBlock > range.toBlock
    )
      return range;
    return b.toBlock === range.toBlock
      ? range
      : { core: range.core, fromBlock: range.fromBlock, toBlock: b.toBlock };
  }

  private splitAtPrice(state: PeerState, r: BlockRange): BlockRange[] {
    const p = state.price.get(r.core);
    if (p === undefined || p.effectiveFromBlock <= r.fromBlock || p.effectiveFromBlock > r.toBlock)
      return [r];
    return [
      { core: r.core, fromBlock: r.fromBlock, toBlock: p.effectiveFromBlock - 1 },
      { core: r.core, fromBlock: p.effectiveFromBlock, toBlock: r.toBlock },
    ];
  }

  /**
   * The policy to pay `range` under: the manifest's (`policyFor`), at the seeder's asking price
   * for that range when it is not above the manifest price. `null` = do not pay (counted).
   */
  private resolvePolicy(
    state: PeerState,
    core: CoreKeyHex,
    hello: HelloMessage,
    range: BlockRange,
  ): PricePolicy | null {
    const base = this.policyFor(core, hello, state.noiseHex);
    if (base === null) {
      this.counters.skippedNoPolicy++;
      this.log.warn('no policy for upstream core — not paying', { peer: state.noiseHex, core });
      return null;
    }
    const p = state.price.get(core);
    const asked =
      p !== undefined && range.fromBlock >= p.effectiveFromBlock
        ? p.satsPerBlock
        : hello.satsPerBlock;
    if (asked > base.satsPerBlock) {
      this.counters.skippedOverpriced++;
      this.log.warn('upstream asks more than the manifest price — not paying', {
        peer: state.noiseHex,
        core,
        asked,
        manifest: base.satsPerBlock,
      });
      return null;
    }
    return asked === base.satsPerBlock ? base : { ...base, satsPerBlock: asked };
  }
}

/**
 * The gateway's resolver: the per-core MANIFEST policy (`config.upstream.policies` /
 * `setUpstreamPolicy`), or `null` — never the seeder's HELLO terms (security review F2). Without
 * the manifest there is no trustworthy price, split or creator key, so nothing is paid.
 */
export function manifestPolicyResolver(
  perCore: () => ReadonlyMap<CoreKeyHex, PricePolicy>,
): UpstreamPolicyResolver {
  return (core) => perCore().get(core) ?? null;
}
export { CreditCancelled, CreditPool, type CreditWaiter } from './credit.js';
export {
  CreditSettler,
  type CreditSettlerOptions,
  type CreditSettlerStats,
  type SettleListener,
} from './settle.js';
export {
  MAX_IMAGE_VERDICTS_PER_SEEDER,
  MAX_POOL_CREDIT,
  MAX_REMEMBERED_SEEDERS,
  MAX_SEEDER_CREDIT,
  NO_PAY_INFLIGHT,
  SeederCredit,
  type ImageVerdict,
  type SeederBatch,
  type SeederCreditOptions,
  type SeederCreditStats,
} from './seeder-credit.js';
