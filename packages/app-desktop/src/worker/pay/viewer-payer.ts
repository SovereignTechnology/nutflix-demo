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
 *     that peer ACKs the `PAY` covering it. `pay/1`'s ACK carries no core, so the payer keeps a
 *     FIFO of the PAYs it put on the wire per peer (by decorating the peer's `sendPay`) and
 *     matches ACKs by `(fromBlock, toBlock)`. A block from a peer without `pay/1`, of a core we
 *     have no policy for, or owed to a peer that disconnected, settles at once (nothing more
 *     will ever be paid for it; the seeder decides what that means for us).
 *   - **spend events**: one `onPaid` per PAY (amount = both proof sets, mint, blocks), which
 *     the host uses to debit its wallet (design §1) and the session uses for its totals.
 *   - **policy**: always the MANIFEST policy of the core (what the user was shown and agreed
 *     to: price, split, creator P2PK). A seeder whose HELLO asks more per block than the
 *     manifest is not paid (never pay more than the price shown); the HELLO's own split is
 *     ignored (a seeder cannot re-route the creator's share).
 */
import type {
  AckMessage,
  CoreKeyHex,
  HelloMessage,
  MintUrl,
  NostrPubkey,
  PayMessage,
  PaymentEngineViewer,
  PayProtocol,
  PayProtocolEvents,
  PricePolicy,
  Sats,
} from '@sovit/core';
import type Hypercore from 'hypercore';
import type { ReplicationPeer } from 'hypercore';
import { UpstreamPayer } from '@sovit/gateway/upstream';
import type { Logger } from '@sovit/seeder';
import { toHex } from '@sovit/seeder';

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
}

interface Link {
  readonly noiseHex: string;
  /** PAYs on the wire awaiting their ACK, oldest first. */
  readonly sent: PayMessage[];
  /** core → blocks downloaded from this peer and not yet settled. */
  readonly owed: Map<string, Set<number>>;
  closed: boolean;
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
  private readonly links = new Map<string, Link>();
  private acksRejected = 0;
  private unmatchedAcks = 0;

  constructor(o: ViewerPayerOptions) {
    this.o = o;
    this.log = o.logger.child({ component: 'viewer-payer' });
    const engine: PaymentEngineViewer = {
      pay: async (range, seeder, policy) => {
        const msg = await o.pay(range, seeder, policy);
        const amount = proofSum(msg);
        if (range.core !== undefined && amount > 0)
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
    this.upstream = new UpstreamPayer({
      engine,
      logger: o.logger,
      // Pay every verified block as it lands (runs landing in one tick still batch into one
      // PAY): the credit window is small, so a tail must never wait for more blocks.
      payEveryBlocks: 1,
      ownMints: o.ownMints,
      policyFor: (core, hello) => this.resolvePolicy(core, hello),
    });
  }

  stats(): ReturnType<UpstreamPayer['stats']> & {
    readonly acksRejected: number;
    readonly unmatchedAcks: number;
    readonly owed: number;
  } {
    let owed = 0;
    for (const l of this.links.values()) for (const s of l.owed.values()) owed += s.size;
    return {
      ...this.upstream.stats(),
      acksRejected: this.acksRejected,
      unmatchedAcks: this.unmatchedAcks,
      owed,
    };
  }

  /** A peer's `pay/1` instance (one per connection). Returns a detach function. */
  attachPeer(noiseHex: string, protocol: PayProtocol): () => void {
    const link: Link = { noiseHex, sent: [], owed: new Map(), closed: false };
    const previous = this.links.get(noiseHex);
    if (previous !== undefined) this.release(previous);
    this.links.set(noiseHex, link);
    const decorated: PayProtocol = {
      get state() {
        return protocol.state;
      },
      get peer() {
        return protocol.peer;
      },
      attach: (mux) => {
        protocol.attach(mux);
      },
      sendHello: (h) => {
        protocol.sendHello(h);
      },
      sendPay: (msg) => {
        if (!link.closed) link.sent.push(msg);
        protocol.sendPay(msg);
      },
      sendAck: (a) => {
        protocol.sendAck(a);
      },
      sendPrice: (p) => {
        protocol.sendPrice(p);
      },
      cut: (reason) => {
        protocol.cut(reason);
      },
      on: <K extends keyof PayProtocolEvents>(event: K, cb: PayProtocolEvents[K]) =>
        protocol.on(event, cb),
    };
    const offAck = protocol.on('ack', (ack) => {
      this.onAck(link, ack);
    });
    const offClose = protocol.on('close', () => {
      this.release(link);
    });
    const detachUpstream = this.upstream.attachPeer(noiseHex, decorated);
    return () => {
      offAck();
      offClose();
      detachUpstream();
      this.release(link);
      if (this.links.get(noiseHex) === link) this.links.delete(noiseHex);
    };
  }

  /** Watch a core's verified downloads. Returns a detach function. */
  attachCore(core: Hypercore): () => void {
    const keyHex = toHex(core.key);
    const onDownload = (index: number, _bytes: number, peer: ReplicationPeer): void => {
      const link = this.links.get(toHex(peer.remotePublicKey));
      if (link === undefined || link.closed || this.o.policyFor(keyHex as CoreKeyHex) === null) {
        this.o.credit.settle(keyHex, index);
        return;
      }
      let set = link.owed.get(keyHex);
      if (set === undefined) {
        set = new Set();
        link.owed.set(keyHex, set);
      }
      set.add(index);
    };
    core.on('download', onDownload);
    const detachUpstream = this.upstream.attachCore(core);
    return () => {
      core.off('download', onDownload);
      detachUpstream();
    };
  }

  /** Pay every pending tail now (session close, shutdown, tests). */
  flush(): Promise<void> {
    return this.upstream.flush();
  }

  private resolvePolicy(core: CoreKeyHex, hello: HelloMessage): PricePolicy | null {
    const policy = this.o.policyFor(core);
    if (policy === null) return null;
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

  private onAck(link: Link, ack: AckMessage): void {
    const i = link.sent.findIndex(
      (m) => m.range.fromBlock === ack.fromBlock && m.range.toBlock === ack.toBlock,
    );
    if (i === -1) {
      this.unmatchedAcks++;
      this.log.warn('ACK for no outstanding PAY', { from: ack.fromBlock, to: ack.toBlock });
      return;
    }
    const [msg] = link.sent.splice(i, 1);
    if (!ack.ok) {
      this.acksRejected++;
      this.log.warn('seeder rejected our PAY', { reason: ack.reason ?? 'unknown' });
    }
    const core = msg?.range.core;
    if (msg === undefined || core === undefined) return;
    const owed = link.owed.get(core);
    for (let b = msg.range.fromBlock; b <= msg.range.toBlock; b++) {
      owed?.delete(b);
      this.o.credit.settle(core, b);
    }
  }

  /** The peer is gone: nothing it is owed will ever be acknowledged. */
  private release(link: Link): void {
    if (link.closed) return;
    link.closed = true;
    link.sent.splice(0);
    for (const [core, set] of link.owed) for (const b of set) this.o.credit.settle(core, b);
    link.owed.clear();
  }
}
