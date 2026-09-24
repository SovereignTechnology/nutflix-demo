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

/** Policy to pay `core` blocks from this peer under; `null` = do not pay (log + skip). */
export type UpstreamPolicyResolver = (
  core: CoreKeyHex,
  hello: HelloMessage,
  peer: string,
) => PricePolicy | null;

/** How long a short tail waits for more blocks before it is paid anyway. */
export const DEFAULT_TAIL_MS = 2000;

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
   * A run shorter than a batch is paid once this many ms pass without a new block from that peer
   * (default `DEFAULT_TAIL_MS`): the end of a video is not left unpaid until the session closes
   * (a crash meanwhile would never pay it). `0` = only at `flush()`.
   */
  readonly tailMs?: number;
  /** Mints the gateway can pay with; the first one the seeder also accepts is used. */
  readonly ownMints: readonly MintUrl[];
  readonly policyFor: UpstreamPolicyResolver;
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
  /** `flush()` is draining: runs unlocked by an ACK are paid however short. */
  draining: boolean;
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
  };

  constructor(o: UpstreamPayerOptions) {
    this.engine = o.engine;
    this.log = o.logger.child({ component: 'upstream-payer' });
    this.payEvery = Math.max(1, o.payEveryBlocks);
    this.ownMints = o.ownMints;
    this.policyFor = o.policyFor;
    this.credit = o.credit;
    this.tailMs = o.tailMs ?? DEFAULT_TAIL_MS;
    // Pressure: pay whatever is held so the pool can refill.
    this.offPressure =
      o.credit?.onPressure(() => {
        for (const s of this.peers.values()) this.schedule(s, s.draining);
      }) ?? ((): void => undefined);
  }

  /** Stop listening to the credit pool (the payer is being discarded). */
  dispose(): void {
    this.offPressure();
    for (const s of this.peers.values()) this.clearTail(s);
  }

  /** Blocks per PAY right now: `payEveryBlocks`, or with a pool half of it — 1 under pressure. */
  private batchBlocks(): number {
    const c = this.credit;
    if (c === undefined) return this.payEvery;
    if (c.pressured) return 1;
    return Math.max(this.payEvery, Math.floor(c.limit / 2));
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
      draining: false,
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
        this.schedule(state, state.draining);
      }),
      protocol.on('close', () => {
        state.closed = true;
      }),
    ];
    return () => {
      state.closed = true;
      this.clearTail(state);
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
    if (set.size >= this.payEvery) this.schedule(state, false);
    this.armTail(state);
  }

  /** (Re)start the peer's tail timer: a quiet peer's short runs get paid. */
  private armTail(state: PeerState): void {
    const ms = this.tailMs;
    if (ms <= 0) return;
    this.clearTail(state);
    const t = setTimeout(() => {
      state.tailTimer = null;
      if (!state.closed) this.schedule(state, true);
    }, ms);
    (t as { unref?: () => void }).unref?.();
    state.tailTimer = t;
  }

  private clearTail(state: PeerState): void {
    if (state.tailTimer !== null) clearTimeout(state.tailTimer);
    state.tailTimer = null;
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
    if (state.closed || state.hello === null) return;
    const hello = state.hello;
    const batch = this.batchBlocks();
    // The seeder's window counts this peer's blocks across cores: once the peer's pending total
    // reaches a batch, its runs are paid however short (per-core runs could otherwise each wait).
    let peerPending = 0;
    for (const set of state.pending.values()) peerPending += set.size;
    const due = force || (this.credit !== undefined && peerPending >= batch);
    for (const [core, set] of state.pending) {
      if (set.size === 0 || state.inflight.has(core)) continue;
      const sorted = [...set].sort((a, b) => a - b);
      const run = contiguousRuns(sorted).find(([from, to]) => due || to - from + 1 >= batch);
      if (run === undefined) continue;
      // One PAY per core in flight: the first price segment of the first payable run now, the
      // rest when its ACK arrives.
      const [range] = this.splitAtPrice(state, { core, fromBlock: run[0], toBlock: run[1] });
      if (range === undefined) continue;
      const policy = this.resolvePolicy(state, core, hello, range);
      if (policy === null) continue;
      const mint = hello.acceptedMints.find(
        (m) => this.ownMints.includes(m) && policy.mints.includes(m),
      );
      if (mint === undefined) {
        this.counters.skippedNoPolicy++;
        this.log.warn('no common mint with upstream — not paying', {
          peer: state.noiseHex,
          core,
        });
        continue;
      }
      const carryIn = state.carry.get(core) ?? 0;
      const amount = (range.toBlock - range.fromBlock + 1) * policy.satsPerBlock;
      const carryOut = payment.splitPay(amount, policy.split, carryIn).carryOut;
      const msg = await this.engine.pay(
        range,
        { pubkey: hello.pubkey, p2pk: hello.p2pk, mint },
        policy,
        { carryIn },
      );
      if (isClosed(state)) return;
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
    }
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
export { CreditSettler, type CreditSettlerOptions, type CreditSettlerStats } from './settle.js';
