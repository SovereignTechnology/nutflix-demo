/**
 * ViewerPayer — the worker as a VIEWER toward the seeders it downloads from (build-plan §5
 * "pay after verify", SECURITY.md invariant 1): L3's `UpstreamPayer` (`@sovit/gateway/upstream`,
 * `range.core` on every `PAY`, replay guard, `PRICE` split, HELLO-gated) driven by an
 * INJECTED `pay(range, seeder, policy)` (design §1 "Wallet and engine": Stage 1 = the
 * `MockPaymentEngine`'s viewer side behind `--dev-mocks`; Stage 2 can move the engine to the
 * host behind the same function).
 *
 * What this adds around `UpstreamPayer`:
 *
 *   - **settlement for the `CreditPool`**: every block downloaded from a peer is owed until
 *     that peer ACKs the `PAY` covering it. The payer keeps a FIFO of the PAYs it put on the
 *     wire per peer (by decorating the peer's `sendPay`) and matches ACKs by
 *     `(core, fromBlock, toBlock)` — v5 `ACK` names its core (L6-C request 3), so two cores
 *     with coinciding ranges can no longer be confused. A block from a peer without `pay/1`, of a core we
 *     have no policy for, or owed to a peer that disconnected, settles at once (nothing more
 *     will ever be paid for it; the seeder decides what that means for us).
 *   - **spend events**: one `onPaid` per PAY (amount = both proof sets, mint, blocks), which
 *     the host uses to debit its wallet (design §1) and the session uses for its totals.
 *   - **policy**: always the MANIFEST policy of the core (what the user was shown and agreed
 *     to: price, split, creator P2PK). A seeder whose HELLO asks more per block than the
 *     manifest is not paid (never pay more than the price shown); the HELLO's own split is
 *     ignored (a seeder cannot re-route the creator's share); the mint paid at must be one
 *     the video lists (the host's wallet is debited there).
 *   - **one seeder per block, credit per seeder** (security review F33, issue #8): every core it
 *     watches is routed by the shared `SeederCredit` — a block is asked of one seeder at a time
 *     (hypercore's racing "hotswap" is off; a stalled request moves to another seeder, never to
 *     two), and a seeder is asked only while its own window (HELLO `windowBlocks`, widened for
 *     the manifest's minimum PAY) has room. The `CreditPool` follows the sum of those windows and
 *     PAYs batch to half each seeder's window.
 *   - **a PAY refused "for now"** (ADR 0012 amendment 2026-09-25): any failed PAY leaves its
 *     blocks owed — the session stays up and nothing reaches the seeder, so its window is never
 *     exceeded (no ban). The host answers `rate-limited:` while a melt runs at the PAY's mint
 *     (nothing spent). With every credit unit held by those owed blocks no download may come, so
 *     the payer asks again by itself. Lane R6-reconcile: that is `UpstreamPayer`'s one retry
 *     mechanism, no longer a timer of this class — `rate-limited` is DEFERRED there (asked again
 *     after `PAY_RETRY_LATER_MS`, doubling up to `PAY_RETRY_LATER_MAX_MS`, never given up: a melt
 *     may last 300 s), every other failure is transient (fix round 5: its own backoff, given up
 *     only after `PAY_GIVE_UP_MS`). Never in a loop: streaming pauses during the melt and resumes
 *     after it.
 *   - **the unpaid tail** (lane P2-owed-viewer, ADR 0018 amendment 2026-09-26). With a `record`
 *     (`UnpaidRecord`), every block received from a seeder with a verified HELLO is recorded
 *     under that seeder's pubkey and core, with the terms of the play session it was received for
 *     (`termsFor`); every ACK of it (accepted, or refused: a PAY is never re-sent) forgets it.
 *     What is left when a session closes, the app quits or the link drops is the tail. When a
 *     seeder later reports blocks it still counts (`OWED`), only those this record also holds are
 *     handed to the payer (`UpstreamPayer.addOwed`): paid at once, at the terms recorded, under
 *     that session's id (`payOwed`: the host checks it like any PAY — the session while it is
 *     open, its tail authorisation afterwards). An owed range the host refuses for good leaves the
 *     record (respected, never paid); what the seeder reports beyond the record is never paid, and
 *     `SeederCredit` keeps it off that seeder's credit. The record is also `SeederCredit`'s
 *     durable ledger (see `unpaid-record.ts`).
 *   - **images** (ADR 0015 amendment): `attachImageCore` routes a core read for display — a
 *     seeder is asked for it only after its `PRICE { free: true }`; nothing is paid or recorded.
 */
import type {
  BlockRange,
  CoreKeyHex,
  HelloMessage,
  MintUrl,
  NostrPubkey,
  OwedMessage,
  PayMessage,
  PaymentEngineViewer,
  PayProtocol,
  PricePolicy,
  Sats,
} from '@sovit/core';
import type Hypercore from 'hypercore';
import { CreditSettler, SeederCredit, UpstreamPayer } from '@sovit/gateway/upstream';
/**
 * After a PAY the host refused "for now" (`rate-limited:`), what is owed is asked again after
 * `PAY_RETRY_LATER_MS`, doubling per refusal in a row up to `PAY_RETRY_LATER_MAX_MS` — by
 * `UpstreamPayer` (lane R6-reconcile; re-exported here, where lane I2-paygate defined them).
 */
export { PAY_RETRY_LATER_MAX_MS, PAY_RETRY_LATER_MS } from '@sovit/gateway/upstream';
import type { Logger } from '@sovit/seeder';
import { toHex } from '@sovit/seeder';

import type { CreditPool } from '../playback/credit.js';
import type { TailTerms, UnpaidRecord } from './unpaid-record.js';

export type PayFn = PaymentEngineViewer['pay'];

/**
 * Lane P2-owed-viewer: build a PAY for blocks of a session's tail — `sid` is the session they
 * were received for (open or closed: the host checks its session or its tail authorisation).
 */
export type PayOwedFn = (
  sid: string,
  range: BlockRange,
  seeder: Parameters<PayFn>[1],
  policy: PricePolicy,
  carryIn: number,
) => Promise<PayMessage>;

export interface PaidEvent {
  readonly core: CoreKeyHex;
  readonly seeder: NostrPubkey;
  readonly mint: MintUrl;
  /** Sats in this PAY (seeder set + creator set). */
  readonly amount: Sats;
  readonly blocks: number;
}

export interface ViewerPayerOptions {
  readonly pay: PayFn;
  /** Mints the viewer's wallet can pay with. */
  readonly ownMints: readonly MintUrl[];
  readonly credit: CreditPool;
  readonly logger: Logger;
  /** The manifest policy of a core being watched; `null` = not ours to pay. */
  readonly policyFor: (core: CoreKeyHex) => PricePolicy | null;
  readonly onPaid?: (e: PaidEvent) => void;
  /** A request unanswered this long moves to another seeder (`OnePeerRouter`; tests shorten it). */
  readonly stallMs?: number;
  /**
   * Fix round 5: the longest prefix of `range` one PAY may cover — the worker ends it where the
   * play session holding `range.fromBlock` ends (the host builds a PAY for one session, within its
   * blob). Passed to `UpstreamPayer` as `boundRange`.
   */
  readonly boundRange?: (range: BlockRange) => BlockRange;
  /**
   * Lane P2-owed-viewer: the durable record of blocks received and not paid (see the header),
   * also `SeederCredit`'s ledger. Absent: nothing is recorded and no old tail is paid.
   */
  readonly record?: UnpaidRecord;
  /** The terms of the play session block `index` of `core` is received for (`null`: none). */
  readonly termsFor?: (core: CoreKeyHex, index: number) => TailTerms | null;
  /** Builds a PAY of owed blocks under their session's id. Absent: no old tail is paid. */
  readonly payOwed?: PayOwedFn;
  /** How long a seeder's report may take (`SeederCredit`; tests shorten it). */
  readonly reportWaitMs?: number;
}

/** How often `drain` looks again while a tail settles. */
const DRAIN_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proofSum(msg: PayMessage): number {
  let n = 0;
  for (const p of msg.seederProofs.proofs) n += p.amount;
  for (const p of msg.creatorProofs.proofs) n += p.amount;
  return n;
}

export class ViewerPayer {
  private readonly o: ViewerPayerOptions;
  private readonly log: Logger;
  private readonly upstream: UpstreamPayer;
  private readonly settler: CreditSettler;
  /** Per-seeder credit and one-seeder-per-block routing (F33, issue #8). */
  readonly seeders: SeederCredit;
  /** Noise key → the pubkey of its current connection's verified HELLO (the record's key). */
  private readonly pubkeys = new Map<string, string>();
  /** Seeder pubkey → core → blocks handed to the payer as owed (paid under their session's id). */
  private readonly owed = new Map<string, Map<string, Set<number>>>();
  private readonly counters = { owedReported: 0, owedRecorded: 0 };

  constructor(o: ViewerPayerOptions) {
    this.o = o;
    this.log = o.logger.child({ component: 'viewer-payer' });
    const engine: PaymentEngineViewer = {
      pay: async (range, seeder, policy) => {
        // A refusal (`rate-limited:` included) goes back to UpstreamPayer, which retries it.
        const msg = await o.pay(range, seeder, policy);
        this.paid(range, seeder.pubkey, msg);
        return msg;
      },
      spent: () => ({ total: 0 as Sats, perPeer: new Map() }),
    };
    this.settler = new CreditSettler({
      credit: o.credit,
      logger: o.logger,
      payable: (core) => o.policyFor(core) !== null,
      // ADR 0015 amendment: blocks of a core a seeder serves free are owed nothing.
      servesFree: (noiseHex, core) => this.seeders.servesFree(noiseHex, core),
    });
    this.seeders = new SeederCredit({
      settler: this.settler,
      pool: o.credit,
      policyFor: o.policyFor,
      logger: o.logger,
      ...(o.stallMs !== undefined ? { stallMs: o.stallMs } : {}),
      ...(o.record !== undefined ? { ledger: o.record } : {}),
      ...(o.reportWaitMs !== undefined ? { reportWaitMs: o.reportWaitMs } : {}),
    });
    o.record?.attachReach(() => this.seeders.seederReach());
    // Every ACK — accepted, or refused (a PAY is never re-sent) — ends what the record owes.
    this.settler.onAck((noiseHex, ack) => {
      const pk = this.pubkeys.get(noiseHex);
      if (pk === undefined) return;
      o.record?.remove(pk, ack.core, ack.fromBlock, ack.toBlock);
      this.forgetOwed(pk, ack.core, ack.fromBlock, ack.toBlock);
    });
    const payOwed = o.payOwed;
    this.upstream = new UpstreamPayer({
      engine,
      logger: o.logger,
      // Batch to half each seeder's window (issue #8), pay at once when a seeder is at its cap,
      // and pay everything the moment the pool is under pressure — so a tail never waits on
      // blocks that credit keeps from coming (F5 batching).
      payEveryBlocks: 1,
      credit: o.credit,
      seederBatch: (noiseHex) => this.seeders.seederBatch(noiseHex),
      ownMints: o.ownMints,
      policyFor: (core, hello) => this.resolvePolicy(core, hello),
      // Fix round 4: a PAY that can never be built (the core's play session is gone) settles
      // its blocks as unpaid, explicitly — the seeder still counts them, so its credit does too.
      // Lane P2-owed-viewer: such blocks stay in the record (the tail, paid on a later OWED),
      // unless they were an owed range the host refused for good (then never payable).
      onUnpayable: (noiseHex, range) => {
        this.settler.settleUnpaid(noiseHex, range);
        const pk = this.pubkeys.get(noiseHex);
        if (pk !== undefined && this.isOwed(pk, range)) {
          o.record?.remove(pk, range.core, range.fromBlock, range.toBlock);
          this.forgetOwed(pk, range.core, range.fromBlock, range.toBlock);
        }
      },
      boundRange: (range, noiseHex) => this.bound(range, noiseHex),
      ...(o.record !== undefined && payOwed !== undefined
        ? {
            owed: {
              policyFor: (core, _hello, peer, range) =>
                range === undefined ? null : (this.owedTerms(peer, range)?.policy ?? null),
              pay: async (range, seeder, policy, opts, peer) => {
                const t = this.owedTerms(peer, range);
                if (t === null) throw new Error('forbidden: those blocks are not in the record');
                const msg = await payOwed(t.sid, range, seeder, policy, opts.carryIn);
                // Not this session's spend (the host's wallet shows it): no `onPaid`.
                return msg;
              },
            },
          }
        : {}),
    });
  }

  stats(): ReturnType<UpstreamPayer['stats']> & {
    readonly acksRejected: number;
    readonly unmatchedAcks: number;
    readonly owed: number;
    /** Lane P2-owed-viewer: blocks seeders reported as owed, and those the record also held. */
    readonly owedReported: number;
    readonly owedRecorded: number;
  } {
    return { ...this.upstream.stats(), ...this.settler.stats(), ...this.counters };
  }

  /** A peer's `pay/1` instance (one per connection). Returns a detach function. */
  attachPeer(noiseHex: string, protocol: PayProtocol): () => void {
    const settled = this.settler.attachPeer(noiseHex, protocol);
    const detachCredit = this.seeders.attachPeer(noiseHex, protocol);
    const detachUpstream = this.upstream.attachPeer(noiseHex, settled.protocol);
    this.pubkeys.delete(noiseHex);
    if (protocol.state === 'open' && protocol.peer !== null)
      this.pubkeys.set(noiseHex, protocol.peer.pubkey);
    const offOpen = protocol.on('open', (hello) => {
      this.pubkeys.set(noiseHex, hello.pubkey);
    });
    // After UpstreamPayer's own listeners (attached above): the core's priced PRICE is known.
    const offOwed = protocol.on('owed', (m) => {
      this.onOwed(noiseHex, m);
    });
    return () => {
      offOpen();
      offOwed();
      detachUpstream();
      detachCredit();
      settled.detach();
    };
  }

  /**
   * Watch a core's verified downloads and route its requests (one seeder per block, per-seeder
   * credit). The core must be open. Throws `RoutingUnsupported` (fail closed) when hypercore's
   * internals are not the ones the router is pinned to. Returns a detach function.
   */
  attachCore(core: Hypercore): () => void {
    const detachRoute = this.seeders.attachCore(core);
    const detachSettler = this.settler.attachCore(core);
    const detachUpstream = this.upstream.attachCore(core);
    const keyHex = toHex(core.key) as CoreKeyHex;
    const onDownload = (
      index: number,
      _bytes: number,
      peer: { readonly remotePublicKey: Uint8Array },
    ): void => {
      this.record(keyHex, index, toHex(peer.remotePublicKey));
    };
    core.on('download', onDownload);
    return () => {
      core.off('download', onDownload);
      detachRoute();
      detachSettler();
      detachUpstream();
    };
  }

  /**
   * ADR 0015 amendment: route a core read for DISPLAY only — an image in a creator's profile core,
   * never paid. A seeder is asked for its blocks only after its `PRICE { free: true }` for it, on
   * an open channel; nothing it serves there counts against its credit, and a read that times out
   * or is stopped leaves no debt (`SeederCredit.attachImageCore`). Not watched by the payer, the
   * settler or the record. Throws `RoutingUnsupported` like `attachCore`. Returns a detach.
   */
  attachImageCore(core: Hypercore): () => void {
    return this.seeders.attachImageCore(core);
  }

  /** Pay every pending tail now (session close, shutdown, tests). */
  flush(): Promise<void> {
    return this.upstream.flush();
  }

  /**
   * Fix round 4: pay a tail and wait, at most `ms`, until what was downloaded of it is SETTLED —
   * every PAY ACKed, nothing of it owed, no request of it still in flight (a block that lands
   * meanwhile is paid too). Session close and shutdown call it while the play session still
   * authorises PAYs. Never rejects; `true` when everything settled in time.
   *
   * Fix round 5: with `range` (a closing session's blocks) only that range is paid now (`hurry`)
   * and waited for. Another session streaming the same core — the new rendition after a switch —
   * keeps batching, and its blocks owed or in flight do not hold this close up. Without `range`,
   * every pending tail is flushed and everything is waited for.
   */
  async drain(ms: number, range?: BlockRange): Promise<boolean> {
    const until = Date.now() + Math.max(0, ms);
    if (range !== undefined) {
      const release = this.upstream.hurry(range);
      try {
        for (;;) {
          if (this.settled(range)) return true;
          const left = until - Date.now();
          if (left <= 0) return false;
          await sleep(Math.min(DRAIN_POLL_MS, left));
        }
      } finally {
        release();
      }
    }
    for (;;) {
      const left = until - Date.now();
      // A PAY is built by the host: a flush waits on it, so the wait is bounded too.
      const flushed = await Promise.race([
        this.upstream.flush().then(
          () => true,
          () => true,
        ),
        sleep(Math.max(0, left)).then(() => false),
      ]);
      if (flushed && this.settled()) return true;
      if (Date.now() >= until) return false;
      await sleep(Math.min(DRAIN_POLL_MS, Math.max(0, until - Date.now())));
    }
  }

  /** Nothing of `range` (of any core without one) owed, and nothing of it in flight. */
  private settled(range?: BlockRange): boolean {
    return (
      this.settler.owedOn(range?.core, range) === 0 &&
      this.seeders.router.inflightOn(range?.core, range) === 0
    );
  }

  /** Stop routing and paying (shutdown, after `flush()`): timers (the payer's retries) and hooks go. */
  close(): void {
    this.seeders.dispose();
    this.upstream.dispose();
  }

  // -------------------------------------------------------------- private

  /** One PAY went out for blocks of this connection: the session's spend. */
  private paid(range: BlockRange, seeder: NostrPubkey, msg: PayMessage): void {
    const amount = proofSum(msg);
    if (amount > 0)
      this.o.onPaid?.({
        core: range.core,
        seeder,
        mint: msg.seederProofs.mint,
        amount: amount as Sats,
        blocks: range.toBlock - range.fromBlock + 1,
      });
  }

  /** A verified block of a paid core from `noiseHex`: into the record, with its session's terms. */
  private record(core: CoreKeyHex, index: number, noiseHex: string): void {
    const rec = this.o.record;
    const termsFor = this.o.termsFor;
    if (rec === undefined || termsFor === undefined) return;
    const pk = this.pubkeys.get(noiseHex);
    // No verified HELLO: nothing will pay it (and nothing was asked of it).
    if (pk === undefined || !this.settler.linked(noiseHex)) return;
    if (this.o.policyFor(core) === null || this.seeders.servesFree(noiseHex, core)) return;
    let terms: TailTerms | null;
    try {
      terms = termsFor(core, index);
    } catch {
      terms = null;
    }
    if (terms !== null) rec.add(pk, core, index, terms);
  }

  /**
   * An `OWED` from `noiseHex` (ADR 0018 amendment): hand the payer the reported blocks the record
   * also holds for that seeder and core — nothing else is ever paid.
   */
  private onOwed(noiseHex: string, m: OwedMessage): void {
    const rec = this.o.record;
    const pk = this.pubkeys.get(noiseHex);
    if (!Array.isArray(m.ranges)) return;
    let reported = 0;
    for (const r of m.ranges) if (Array.isArray(r)) reported += Math.max(0, r[1] - r[0] + 1);
    this.counters.owedReported += Number.isSafeInteger(reported) ? reported : 0;
    if (rec === undefined || this.o.payOwed === undefined || pk === undefined) return;
    const blocks = rec.recorded(pk, m.core, m.ranges);
    if (blocks.length === 0) return;
    const indexes = blocks.map((b) => b.index);
    const taken = this.upstream.addOwed(noiseHex, m.core, indexes);
    if (taken === 0) return;
    let byCore = this.owed.get(pk);
    if (byCore === undefined) {
      byCore = new Map();
      this.owed.set(pk, byCore);
    }
    let set = byCore.get(m.core);
    if (set === undefined) {
      set = new Set();
      byCore.set(m.core, set);
    }
    for (const i of indexes) set.add(i);
    this.counters.owedRecorded += taken;
    // Counts only: never a key, a core or a block.
    this.log.info('owed blocks from before: paying those in the record', {
      reported,
      recorded: taken,
    });
  }

  /** Whether every block of `range` was handed to the payer as owed by `pk`. */
  private isOwed(pk: string, range: BlockRange): boolean {
    const set = this.owed.get(pk)?.get(range.core);
    if (set === undefined) return false;
    for (let i = range.fromBlock; i <= range.toBlock; i++) if (!set.has(i)) return false;
    return true;
  }

  private forgetOwed(pk: string, core: string, from: number, to: number): void {
    const byCore = this.owed.get(pk);
    const set = byCore?.get(core);
    if (byCore === undefined || set === undefined) return;
    if (to - from < set.size) for (let i = from; i <= to; i++) set.delete(i);
    else for (const i of [...set]) if (i >= from && i <= to) set.delete(i);
    if (set.size === 0) byCore.delete(core);
    if (byCore.size === 0) this.owed.delete(pk);
  }

  /** The recorded terms of owed `range` from `peer`, when all of it shares them. */
  private owedTerms(peer: string, range: BlockRange): TailTerms | null {
    const pk = this.pubkeys.get(peer);
    const rec = this.o.record;
    if (pk === undefined || rec === undefined || !this.isOwed(pk, range)) return null;
    const t = rec.termsOf(pk, range.core, range.fromBlock);
    if (t === null || range.fromBlock < t.first || range.toBlock > t.last) return null;
    for (let i = range.fromBlock + 1; i <= range.toBlock; i++)
      if (rec.termsOf(pk, range.core, i)?.sid !== t.sid) return null;
    return t;
  }

  /**
   * The longest prefix of `range` one PAY may cover: for owed blocks, those of one recorded
   * session within its blob; otherwise the worker's session bound (fix round 5).
   */
  private bound(range: BlockRange, noiseHex: string): BlockRange {
    const pk = this.pubkeys.get(noiseHex);
    const rec = this.o.record;
    if (
      pk !== undefined &&
      rec !== undefined &&
      this.owed.get(pk)?.get(range.core)?.has(range.fromBlock) === true
    ) {
      const t = rec.termsOf(pk, range.core, range.fromBlock);
      if (t === null) return range;
      let to = range.fromBlock;
      while (
        to < range.toBlock &&
        to < t.last &&
        rec.termsOf(pk, range.core, to + 1)?.sid === t.sid
      )
        to++;
      return to === range.toBlock
        ? range
        : { core: range.core, fromBlock: range.fromBlock, toBlock: to };
    }
    return this.o.boundRange?.(range) ?? range;
  }

  private resolvePolicy(core: CoreKeyHex, hello: HelloMessage): PricePolicy | null {
    const policy = this.o.policyFor(core);
    if (policy === null) return null;
    // UpstreamPayer pays at the seeder's first accepted mint our wallet also has; it must be
    // one the VIDEO accepts too (the creator's share is spendable only there, and the host
    // debits its wallet at that mint).
    const mint = hello.acceptedMints.find((m) => this.o.ownMints.includes(m));
    if (mint === undefined || !policy.mints.includes(mint)) {
      this.log.warn('no mint shared by seeder, wallet and video — not paying', { core });
      return null;
    }
    if (hello.satsPerBlock > policy.satsPerBlock) {
      this.log.warn('seeder asks more than the manifest price — not paying', {
        core,
        asked: hello.satsPerBlock,
        manifest: policy.satsPerBlock,
      });
      return null;
    }
    return policy;
  }
}
