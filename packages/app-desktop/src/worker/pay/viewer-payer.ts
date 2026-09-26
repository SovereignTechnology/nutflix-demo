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
 */
import type {
  CoreKeyHex,
  HelloMessage,
  MintUrl,
  NostrPubkey,
  PayMessage,
  PaymentEngineViewer,
  PayProtocol,
  PricePolicy,
  Sats,
} from '@sovit/core';
import type Hypercore from 'hypercore';
import { CreditSettler, SeederCredit, UpstreamPayer } from '@sovit/gateway/upstream';
import type { Logger } from '@sovit/seeder';

import type { CreditPool } from '../playback/credit.js';

export type PayFn = PaymentEngineViewer['pay'];

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

  constructor(o: ViewerPayerOptions) {
    this.o = o;
    this.log = o.logger.child({ component: 'viewer-payer' });
    const engine: PaymentEngineViewer = {
      pay: async (range, seeder, policy) => {
        const msg = await o.pay(range, seeder, policy);
        const amount = proofSum(msg);
        if (amount > 0)
          o.onPaid?.({
            core: range.core,
            seeder: seeder.pubkey,
            mint: msg.seederProofs.mint,
            amount: amount as Sats,
            blocks: range.toBlock - range.fromBlock + 1,
          });
        return msg;
      },
      spent: () => ({ total: 0 as Sats, perPeer: new Map() }),
    };
    this.settler = new CreditSettler({
      credit: o.credit,
      logger: o.logger,
      payable: (core) => o.policyFor(core) !== null,
    });
    this.seeders = new SeederCredit({
      settler: this.settler,
      pool: o.credit,
      policyFor: o.policyFor,
      logger: o.logger,
      ...(o.stallMs !== undefined ? { stallMs: o.stallMs } : {}),
    });
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
    });
  }

  stats(): ReturnType<UpstreamPayer['stats']> & {
    readonly acksRejected: number;
    readonly unmatchedAcks: number;
    readonly owed: number;
  } {
    return { ...this.upstream.stats(), ...this.settler.stats() };
  }

  /** A peer's `pay/1` instance (one per connection). Returns a detach function. */
  attachPeer(noiseHex: string, protocol: PayProtocol): () => void {
    const settled = this.settler.attachPeer(noiseHex, protocol);
    const detachCredit = this.seeders.attachPeer(noiseHex, protocol);
    const detachUpstream = this.upstream.attachPeer(noiseHex, settled.protocol);
    return () => {
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
    return () => {
      detachRoute();
      detachSettler();
      detachUpstream();
    };
  }

  /** Pay every pending tail now (session close, shutdown, tests). */
  flush(): Promise<void> {
    return this.upstream.flush();
  }

  /** Stop routing and paying (shutdown, after `flush()`): timers and hooks go. */
  close(): void {
    this.seeders.dispose();
    this.upstream.dispose();
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
