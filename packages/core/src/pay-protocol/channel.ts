/**
 * `PayChannel` — the `pay/1` state machine on a protomux shared with Hypercore replication
 * (contracts `PayProtocol`; build-plan §2.3, assumption A3).
 *
 *   idle ──sendHello──▶ hello-sent ──remote HELLO verified──▶ open ──cut / remote close──▶ closed
 *     └──remote HELLO verified first: kept; `open` fires when ours goes out──┘
 *
 * - One protomux channel `pay/1`, one message type carrying a codec frame (`codec.ts`).
 * - A remote HELLO must be bound to THIS connection (`hello.ts`) and signed by the pubkey it
 *   names. A second HELLO is ignored if it is byte-identical to the first and is a protocol
 *   error otherwise — another pubkey, or the same pubkey with other terms (price, P2PK, mints):
 *   the terms a peer opened with are the ones it keeps. `open` fires once, when both HELLOs
 *   are done.
 * - PAY, ACK and PRICE are delivered as they arrive, also before HELLO: Hypercore serves blocks
 *   from the first moment and the seeder accounts them under the provisional Noise identity
 *   (ADR 0004 d), so a PAY racing its sender's HELLO must not be dropped.
 * - OWED (v6 amendment) is delivered only once the channel is `open`: a seeder sends it after
 *   both HELLOs verified, after its own HELLO on the same ordered stream, and the viewer sent its
 *   HELLO before the seeder could verify it — so an OWED that arrives earlier breaks the protocol
 *   (it would name blocks for a pubkey nobody has bound yet) and is a protocol error.
 * - An undecodable frame or a bad HELLO closes the channel and emits `close('protocol-error')`;
 *   what that costs the peer (a cut, a ban) is the owner's decision — the seeder's session owns
 *   the ban + destroy. `cut()` closes the channel, runs the owner's `onCut` (hyperswarm
 *   `peerInfo.ban(true)`), and destroys the stream when asked, all synchronously (the window
 *   cut must happen inside Hypercore's `upload` handler, spike S-A).
 *
 * Nothing here logs; listener errors are contained.
 */
import c from 'compact-encoding';

import type {
  AckMessage,
  HelloMessage,
  MuxLike,
  OwedMessage,
  PayMessage,
  PayProtocol,
  PayProtocolCodec,
  PayProtocolEvents,
  PayProtocolMessage,
  PayProtocolState,
  PriceMessage,
} from '../contracts/index.js';
import { PAY_PROTOCOL_NAME } from '../contracts/index.js';
import { payCodec } from './codec.js';
import { bindingFromMux, helloChallenge, verifyHello, type ConnectionBinding } from './hello.js';

type CloseReason = Parameters<PayProtocolEvents['close']>[0];
type Listeners = { [K in keyof PayProtocolEvents]: Set<PayProtocolEvents[K]> };

/** The protomux channel surface this uses (protomux@3.11: createChannel → addMessage → open). */
interface ProtomuxChannel {
  addMessage(opts: { encoding: unknown; onmessage: (m: Uint8Array) => void }): {
    send(m: Uint8Array): boolean;
  };
  open(handshake?: unknown): void;
  close(): void;
}

export interface PayChannelOptions {
  /** The connection's handshake binding; derived from `mux.stream` at `attach` when absent. */
  readonly binding?: ConnectionBinding;
  readonly codec?: PayProtocolCodec;
  /** Runs synchronously inside `cut()` — e.g. hyperswarm `peerInfo.ban(true)`. */
  readonly onCut?: (reason: CloseReason) => void;
  /** Destroy the underlying stream on `cut()` (default true). */
  readonly destroyOnCut?: boolean;
  /** Told why a frame or HELLO was refused (a short reason, never key material). */
  readonly onProtocolError?: (why: string) => void;
}

export class PayChannel implements PayProtocol {
  private st: PayProtocolState = 'idle';
  private remote: HelloMessage | null = null;
  /** The remote HELLO's encoding, to recognise an identical re-send. */
  private remoteFrame: Uint8Array | null = null;
  private helloSent = false;
  private openFired = false;
  private channel: ProtomuxChannel | null = null;
  private message: { send(m: Uint8Array): boolean } | null = null;
  private mux: MuxLike | null = null;
  private binding: ConnectionBinding | null;
  private readonly codec: PayProtocolCodec;
  private readonly listeners: Listeners = {
    open: new Set(),
    pay: new Set(),
    ack: new Set(),
    price: new Set(),
    owed: new Set(),
    close: new Set(),
  };

  constructor(private readonly o: PayChannelOptions = {}) {
    this.binding = o.binding ?? null;
    this.codec = o.codec ?? payCodec;
  }

  get state(): PayProtocolState {
    return this.st;
  }

  /** The verified remote HELLO, once received. */
  get peer(): HelloMessage | null {
    return this.remote;
  }

  /** The challenge this end must sign (`buildHello` computes the same). */
  challenge(): string {
    const b = this.requireBinding();
    return helloChallenge(b.handshakeHash, b.localNoiseKey);
  }

  attach(mux: MuxLike): void {
    if (this.mux !== null) throw new Error('pay/1: already attached');
    this.mux = mux;
    this.binding ??= bindingFromMux(mux);
    const channel = mux.createChannel({
      protocol: PAY_PROTOCOL_NAME,
      id: null,
      onclose: () => {
        this.closeWith('remote');
      },
      ondestroy: () => {
        this.closeWith('remote');
      },
    }) as ProtomuxChannel | null;
    if (channel === null) {
      // protomux: a duplicate channel, or one the remote already closed.
      this.closeWith('protocol-error');
      return;
    }
    this.channel = channel;
    this.message = channel.addMessage({
      encoding: c.raw,
      onmessage: (buf) => {
        this.onFrame(buf);
      },
    });
    channel.open();
  }

  sendHello(hello: Omit<HelloMessage, 'type'>): void {
    if (this.st === 'closed') return;
    if (hello.challenge !== this.challenge())
      throw new Error('pay/1: the HELLO is not signed for this connection');
    this.send({ type: 'HELLO', ...hello });
    this.helloSent = true;
    if (this.st === 'idle') this.st = 'hello-sent';
    this.maybeOpen();
  }

  sendPay(msg: PayMessage): void {
    this.send({ type: 'PAY', payload: msg });
  }

  sendAck(ack: Omit<AckMessage, 'type'>): void {
    this.send({ type: 'ACK', ...ack });
  }

  sendPrice(price: Omit<PriceMessage, 'type'>): void {
    this.send({ type: 'PRICE', ...price });
  }

  /**
   * v6 amendment: only on an `open` channel — the remote closes the channel on an OWED that
   * arrives before both HELLOs, so sending one earlier is a local bug: it throws rather than cost
   * the connection. On a closed channel it is dropped, like every other message.
   */
  sendOwed(owed: Omit<OwedMessage, 'type'>): void {
    if (this.st === 'closed') return;
    if (this.st !== 'open') throw new Error('pay/1: OWED is sent only once both HELLOs are done');
    this.send({ type: 'OWED', ...owed });
  }

  cut(reason: CloseReason): void {
    if (this.st === 'closed') return;
    this.st = 'closed';
    try {
      this.o.onCut?.(reason);
    } catch {
      // the owner's hook failing must not stop the cut
    }
    this.channel?.close();
    if (this.o.destroyOnCut ?? true) {
      const stream = (this.mux as { stream?: { destroy?: () => void } } | null)?.stream;
      stream?.destroy?.();
    }
    this.emit('close', reason);
  }

  on<K extends keyof PayProtocolEvents>(event: K, cb: PayProtocolEvents[K]): () => void {
    const set = this.listeners[event] as Set<PayProtocolEvents[K]>;
    set.add(cb);
    return () => set.delete(cb);
  }

  // ------------------------------------------------------------------ internals

  private requireBinding(): ConnectionBinding {
    if (this.binding === null)
      throw new Error('pay/1: no connection binding (attach a Noise-backed mux, or pass one)');
    return this.binding;
  }

  private send(m: PayProtocolMessage): void {
    if (this.st === 'closed' || this.message === null) return;
    this.message.send(this.codec.encode(m));
  }

  private onFrame(buf: Uint8Array): void {
    if (this.st === 'closed') return;
    const m = this.codec.decode(buf);
    if (m === null) {
      this.protocolError('undecodable frame');
      return;
    }
    switch (m.type) {
      case 'HELLO': {
        const b = this.binding;
        if (b === null) {
          this.protocolError('HELLO on a connection without a binding');
          return;
        }
        const verdict = verifyHello(m, b);
        if (!verdict.ok) {
          this.protocolError(`HELLO refused: ${verdict.reason}`);
          return;
        }
        if (this.remote !== null) {
          if (this.remote.pubkey !== m.pubkey)
            this.protocolError('a second HELLO names another pubkey');
          else if (!sameBytes(this.remoteFrame, buf))
            this.protocolError('a second HELLO changes the terms');
          return;
        }
        this.remote = m;
        this.remoteFrame = Uint8Array.from(buf);
        this.maybeOpen();
        return;
      }
      case 'PAY':
        this.emit('pay', m.payload);
        return;
      case 'ACK':
        this.emit('ack', m);
        return;
      case 'PRICE':
        this.emit('price', m);
        return;
      case 'OWED':
        if (this.st !== 'open') {
          this.protocolError('OWED before both HELLOs');
          return;
        }
        this.emit('owed', m);
        return;
    }
  }

  private maybeOpen(): void {
    if (this.openFired || !this.helloSent || this.remote === null || this.st === 'closed') return;
    this.openFired = true;
    this.st = 'open';
    this.emit('open', this.remote);
  }

  private protocolError(why: string): void {
    try {
      this.o.onProtocolError?.(why);
    } catch {
      // contained
    }
    if (this.st === 'closed') return;
    this.st = 'closed';
    this.channel?.close();
    this.emit('close', 'protocol-error');
  }

  private closeWith(reason: CloseReason): void {
    if (this.st === 'closed') return;
    this.st = 'closed';
    this.emit('close', reason);
  }

  private emit<K extends keyof PayProtocolEvents>(
    event: K,
    ...args: Parameters<PayProtocolEvents[K]>
  ): void {
    for (const cb of this.listeners[event]) {
      try {
        (cb as (...a: Parameters<PayProtocolEvents[K]>) => void)(...args);
      } catch {
        // a listener's failure is its own
      }
    }
  }
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a?.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
