/**
 * CreditSettler — gives `CreditPool` units back when the blocks they paid for are SETTLED
 * (security review F37; extracted from the desktop worker's `ViewerPayer` so the gateway's upstream
 * reads settle the same way).
 *
 * Every block downloaded from a peer is owed until that peer ACKs the `PAY` covering it. The
 * settler keeps a FIFO of the PAYs put on the wire per peer (by decorating the peer's `sendPay`)
 * and matches ACKs by `(core, fromBlock, toBlock)` — v5 `ACK` names its core, so two cores with
 * coinciding ranges cannot be confused. A block from a peer without `pay/1`, of a core nobody pays
 * for, or owed to a peer that disconnected, settles at once: nothing more will ever be paid for
 * it (the seeder decides what that means for us). A rejected PAY settles too — it is never re-sent.
 */
import type {
  AckMessage,
  CoreKeyHex,
  PayMessage,
  PayProtocol,
  PayProtocolEvents,
} from '@sovit/core';
import type Hypercore from 'hypercore';
import type { ReplicationPeer } from 'hypercore';
import type { Logger } from '@sovit/seeder';
import { toHex } from '@sovit/seeder';

import type { CreditPool } from './credit.js';

export interface CreditSettlerOptions {
  readonly credit: CreditPool;
  readonly logger: Logger;
  /** `false` for a core nobody pays for (its blocks settle on arrival). */
  readonly payable: (core: CoreKeyHex) => boolean;
}

interface Link {
  readonly noiseHex: string;
  /** PAYs on the wire awaiting their ACK, oldest first. */
  readonly sent: PayMessage[];
  /** core → blocks downloaded from this peer and not yet settled. */
  readonly owed: Map<string, Set<number>>;
  closed: boolean;
}

export interface CreditSettlerStats {
  readonly acksRejected: number;
  readonly unmatchedAcks: number;
  /** Blocks downloaded and not yet settled. */
  readonly owed: number;
}

export class CreditSettler {
  private readonly o: CreditSettlerOptions;
  private readonly log: Logger;
  private readonly links = new Map<string, Link>();
  private acksRejected = 0;
  private unmatchedAcks = 0;

  constructor(o: CreditSettlerOptions) {
    this.o = o;
    this.log = o.logger.child({ component: 'credit-settler' });
  }

  stats(): CreditSettlerStats {
    let owed = 0;
    for (const l of this.links.values()) for (const s of l.owed.values()) owed += s.size;
    return { acksRejected: this.acksRejected, unmatchedAcks: this.unmatchedAcks, owed };
  }

  /** Whether a downloaded block is waiting for its ACK (a reader settles a block it never owed). */
  owes(core: string, index: number): boolean {
    for (const l of this.links.values()) if (l.owed.get(core)?.has(index) === true) return true;
    return false;
  }

  /**
   * A peer's `pay/1` instance (one per connection). Returns the protocol to hand the payer —
   * `sendPay` is tracked until its ACK — and a detach function.
   */
  attachPeer(
    noiseHex: string,
    protocol: PayProtocol,
  ): { readonly protocol: PayProtocol; readonly detach: () => void } {
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
    return {
      protocol: decorated,
      detach: () => {
        offAck();
        offClose();
        this.release(link);
        if (this.links.get(noiseHex) === link) this.links.delete(noiseHex);
      },
    };
  }

  /** Watch a core's verified downloads. Returns a detach function. */
  attachCore(core: Hypercore): () => void {
    const keyHex = toHex(core.key);
    const onDownload = (index: number, _bytes: number, peer: ReplicationPeer): void => {
      const link = this.links.get(toHex(peer.remotePublicKey));
      if (link === undefined || link.closed || !this.o.payable(keyHex as CoreKeyHex)) {
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
    return () => {
      core.off('download', onDownload);
    };
  }

  private onAck(link: Link, ack: AckMessage): void {
    const i = link.sent.findIndex(
      (m) =>
        m.range.core === ack.core &&
        m.range.fromBlock === ack.fromBlock &&
        m.range.toBlock === ack.toBlock,
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
    if (msg === undefined) return;
    const core = msg.range.core;
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
