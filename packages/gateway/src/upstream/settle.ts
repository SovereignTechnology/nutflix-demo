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
 *
 * Issue #8: a unit settled WITHOUT a payment (a rejected PAY, a peer gone with blocks owed) frees
 * the pool, but the seeder still counts those blocks against its window. `onChange` reports them
 * per peer (`unpaid`), and `SeederCredit` keeps them off that seeder's credit for good.
 */
import type {
  AckMessage,
  BlockRange,
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

/**
 * Something settled for peer `noiseHex`: an ACK (`unpaid` = the blocks of a REJECTED PAY, else 0)
 * or the peer's `pay/1` going away (`unpaid` = every block it was still owed).
 */
export type SettleListener = (noiseHex: string, unpaid: number) => void;

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
  private readonly listeners = new Set<SettleListener>();
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

  /** Blocks downloaded from `noiseHex` on its live `pay/1` link and not settled yet (all cores). */
  owedBy(noiseHex: string): number {
    const l = this.links.get(noiseHex);
    if (l === undefined || l.closed) return 0;
    let n = 0;
    for (const s of l.owed.values()) n += s.size;
    return n;
  }

  /**
   * Blocks of `core` (of every core without one) downloaded on live `pay/1` links and not settled
   * yet — owed until their PAY is ACKed (fix round 4: what a closing session waits for). With
   * `range`, only blocks `fromBlock..toBlock` of `core` count (fix round 5: a closing session's
   * own blocks — another session of the same core may be streaming beside it).
   */
  owedOn(core?: string, range?: { readonly fromBlock: number; readonly toBlock: number }): number {
    let n = 0;
    for (const l of this.links.values()) {
      if (l.closed) continue;
      if (core === undefined) for (const s of l.owed.values()) n += s.size;
      else if (range === undefined) n += l.owed.get(core)?.size ?? 0;
      else
        for (const b of l.owed.get(core) ?? []) if (b >= range.fromBlock && b <= range.toBlock) n++;
    }
    return n;
  }

  /** Whether blocks of `core` are paid for (and so owed until ACKed): the settler's own rule. */
  isPayable(core: CoreKeyHex): boolean {
    return this.o.payable(core);
  }

  /** Whether `noiseHex` has a live `pay/1` link (blocks from it are owed until ACKed). */
  linked(noiseHex: string): boolean {
    const l = this.links.get(noiseHex);
    return l !== undefined && !l.closed;
  }

  /** Called after every ACK and every link release (see `SettleListener`). */
  onChange(cb: SettleListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
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
      sendOwed: (o) => {
        protocol.sendOwed(o);
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

  /**
   * Fix round 4: blocks of `range` downloaded from `noiseHex` will never be paid (their PAY could
   * not be built — the desktop's play session is gone, the host refuses it). They settle now,
   * reported as UNPAID (`onChange`), so the seeder's credit keeps them for good instead of holding
   * pool units for ever. Blocks not owed on the live link are ignored. Returns how many settled.
   */
  settleUnpaid(noiseHex: string, range: BlockRange): number {
    const link = this.links.get(noiseHex);
    if (link === undefined || link.closed) return 0;
    const owed = link.owed.get(range.core);
    let n = 0;
    for (let b = range.fromBlock; b <= range.toBlock; b++) {
      if (owed?.delete(b) !== true) continue;
      n++;
      this.o.credit.settle(range.core, b);
    }
    if (n > 0) this.emit(noiseHex, n);
    return n;
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
    this.emit(link.noiseHex, ack.ok ? 0 : msg.range.toBlock - msg.range.fromBlock + 1);
  }

  /** The peer is gone: nothing it is owed will ever be acknowledged. */
  private release(link: Link): void {
    if (link.closed) return;
    link.closed = true;
    link.sent.splice(0);
    let unpaid = 0;
    for (const [core, set] of link.owed)
      for (const b of set) {
        unpaid++;
        this.o.credit.settle(core, b);
      }
    link.owed.clear();
    this.emit(link.noiseHex, unpaid);
  }

  private emit(noiseHex: string, unpaid: number): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(noiseHex, unpaid);
      } catch {
        // a listener's failure is its own
      }
    }
  }
}
