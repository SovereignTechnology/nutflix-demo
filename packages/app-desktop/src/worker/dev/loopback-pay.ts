/**
 * LoopbackPayHub — D1: Stage 1's in-process `pay/1` pairing, `--dev-mocks` only.
 *
 * `pay-protocol/` (the real codec + state machine on protomux) is locked until Stage 2 and
 * L3's dev `PayProtocol` sends nothing, so two peers in DIFFERENT processes cannot pay each
 * other in Stage 1. Peers in the SAME process can: every connection end registers here under
 * `(connection id, its own Noise key)` and the end registered under `(same connection id,
 * the remote's Noise key)` is its counterpart. The connection id is the Noise handshake hash,
 * which both ends of one connection share and no other connection has, so a reconnect can
 * never pair an end with a stale one. Replication still runs over real UDX on a local
 * hyperdht testnet; only
 * the payment side channel is an in-memory hop. Messages are structured-cloned (no shared
 * objects across the "wire"), delivered in order on a microtask, and queued (bounded) until
 * the counterpart registers. An end whose counterpart never appears (a peer in another
 * process) simply never pays or gets paid — that seeder will cut us, exactly as in L3's dev
 * mode.
 *
 * NOT a protocol implementation: HELLO "signatures" are not checked (they are the literal
 * `dev-unsigned`), there is no codec. The `--dev-mocks` fence (loopback-only DHT, loopback
 * bootstrap) keeps it off any real network.
 */
import type {
  AckMessage,
  HelloMessage,
  MuxLike,
  PayMessage,
  PayProtocol,
  PayProtocolEvents,
  PayProtocolState,
  PriceMessage,
} from '@sovit/core';

import type { PayLink } from '../net/peer-node.js';

type Listeners = { [K in keyof PayProtocolEvents]: Set<PayProtocolEvents[K]> };
type CloseReason = Parameters<PayProtocolEvents['close']>[0];

type Wire =
  | { readonly t: 'hello'; readonly m: HelloMessage }
  | { readonly t: 'pay'; readonly m: PayMessage }
  | { readonly t: 'ack'; readonly m: AckMessage }
  | { readonly t: 'price'; readonly m: PriceMessage }
  | { readonly t: 'close' };

/** Messages held for a counterpart that has not registered yet. */
const MAX_QUEUED = 256;

export class LoopbackEnd implements PayProtocol {
  state: PayProtocolState = 'idle';
  peer: HelloMessage | null = null;
  private readonly listeners: Listeners = {
    open: new Set(),
    pay: new Set(),
    ack: new Set(),
    price: new Set(),
    close: new Set(),
  };
  /** Set by the hub once the counterpart exists. */
  other: LoopbackEnd | null = null;
  readonly queue: Wire[] = [];
  private helloSent = false;
  dropped = 0;

  constructor(
    private readonly hub: LoopbackPayHub,
    readonly id: string,
    readonly mirrorId: string,
  ) {}

  attach(_mux: MuxLike): void {
    // In-memory: nothing is put on the protomux.
  }

  sendHello(hello: Omit<HelloMessage, 'type'>): void {
    if (this.state === 'closed') return;
    this.helloSent = true;
    if (this.state === 'idle') this.state = 'hello-sent';
    this.send({ t: 'hello', m: { type: 'HELLO', ...hello } });
  }

  sendPay(msg: PayMessage): void {
    this.send({ t: 'pay', m: msg });
  }

  sendAck(ack: Omit<AckMessage, 'type'>): void {
    this.send({ t: 'ack', m: { type: 'ACK', ...ack } });
  }

  sendPrice(price: Omit<PriceMessage, 'type'>): void {
    this.send({ t: 'price', m: { type: 'PRICE', ...price } });
  }

  cut(reason: CloseReason): void {
    if (this.state === 'closed') return;
    this.send({ t: 'close' });
    this.closeLocal(reason);
  }

  on<K extends keyof PayProtocolEvents>(event: K, cb: PayProtocolEvents[K]): () => void {
    const set = this.listeners[event] as Set<PayProtocolEvents[K]>;
    set.add(cb);
    return () => set.delete(cb);
  }

  /** The connection closed: tell the counterpart, leave the hub. */
  dispose(): void {
    if (this.state !== 'closed') {
      this.send({ t: 'close' });
      this.closeLocal('remote');
    }
    this.hub.remove(this);
  }

  private send(w: Wire): void {
    if (this.state === 'closed') return;
    const cloned = structuredClone(w);
    const other = this.other;
    if (other === null) {
      if (this.queue.length >= MAX_QUEUED) {
        this.queue.shift();
        this.dropped++;
      }
      this.queue.push(cloned);
      return;
    }
    queueMicrotask(() => {
      other.receive(cloned);
    });
  }

  /** Called by the hub when the counterpart registers: flush what waited. */
  link(other: LoopbackEnd): void {
    this.other = other;
    for (const w of this.queue.splice(0)) {
      queueMicrotask(() => {
        other.receive(w);
      });
    }
  }

  receive(w: Wire): void {
    if (this.state === 'closed') return;
    switch (w.t) {
      case 'hello':
        this.peer = w.m;
        if (this.helloSent) this.state = 'open';
        for (const cb of [...this.listeners.open]) cb(w.m);
        return;
      case 'pay':
        for (const cb of [...this.listeners.pay]) cb(w.m);
        return;
      case 'ack':
        for (const cb of [...this.listeners.ack]) cb(w.m);
        return;
      case 'price':
        for (const cb of [...this.listeners.price]) cb(w.m);
        return;
      case 'close':
        this.closeLocal('remote');
        return;
    }
  }

  private closeLocal(reason: CloseReason): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const cb of [...this.listeners.close]) cb(reason);
  }
}

export class LoopbackPayHub {
  private readonly ends = new Map<string, LoopbackEnd>();

  /** Registered ends (tests). */
  get size(): number {
    return this.ends.size;
  }

  /** The `PayWiring.protocol` factory: one end per connection, disposed when it closes. */
  endpoint(link: PayLink): LoopbackEnd {
    const id = `${link.connectionId}:${link.localNoise}`;
    const mirrorId = `${link.connectionId}:${link.remoteNoise}`;
    this.ends.get(id)?.dispose();
    const end = new LoopbackEnd(this, id, mirrorId);
    this.ends.set(id, end);
    const mirror = this.ends.get(mirrorId);
    if (mirror !== undefined) {
      end.link(mirror);
      mirror.link(end);
    }
    link.stream.once('close', () => {
      end.dispose();
    });
    return end;
  }

  remove(end: LoopbackEnd): void {
    if (this.ends.get(end.id) === end) this.ends.delete(end.id);
    const mirror = this.ends.get(end.mirrorId);
    if (mirror?.other === end) mirror.other = null;
  }
}
