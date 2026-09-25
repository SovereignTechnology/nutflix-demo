import { NostrKind } from './nostr.js';
import type { PayMessage, RejectReason } from './payment.js';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  Sats,
  UnixSeconds,
} from './primitives.js';

/**
 * `pay/1` — the payment side channel muxed onto the Hypercore replication stream
 * (build-plan §2.3, assumption A3). Protocol name on the wire: `pay/1`.
 *
 * Message codec = `compact-encoding`. State machine and protomux attach land in Stage 2
 * (`core/src/pay-protocol/`, locked). The fuzz harness (L10) targets the codec.
 */

export const PAY_PROTOCOL_NAME = 'pay/1' as const;
export const PAY_PROTOCOL_VERSION = 1 as const;

/**
 * v5 (ADR 0010): the Nostr event kind a `HELLO` signature is made over. Ephemeral range
 * (NIP-01 20000–29999), never published to a relay; it exists so the key-possession proof
 * is an ordinary NIP-01 signature any `Signer.signEvent` can produce and `nostr-tools`
 * `verifyEvent` can check. Appears in no vendored spec.
 */
export const PAY_HELLO_KIND = NostrKind.PayHello;

export interface HelloMessage {
  readonly type: 'HELLO';
  readonly version: number;
  readonly pubkey: NostrPubkey;
  /**
   * v5: binds the HELLO to ONE connection and ONE direction:
   * `pay/1:<Noise handshake hash, hex>:<sender's Noise static public key, hex>`. The
   * receiver refuses a HELLO whose hash is not its own connection's or whose key is not the
   * remote's, so a HELLO cannot be replayed on another connection or reflected back.
   */
  readonly challenge: string;
  /** v5: `created_at` of the signed event (see `signature`). */
  readonly createdAt: UnixSeconds;
  /**
   * BIP-340 signature by `pubkey` over the NIP-01 event id of `{ kind: PAY_HELLO_KIND,
   * pubkey, created_at: createdAt, tags: [['challenge', challenge]], content: '' }`.
   */
  readonly signature: string;
  /**
   * Seeder → viewer: the mints this seeder accepts and its base price/split. Per-core
   * prices come from the signed manifest (and `PRICE`); a viewer pays the MANIFEST policy,
   * never more per block than it (ADR 0010). Viewer → seeder: the mints it can pay with.
   */
  readonly acceptedMints: readonly MintUrl[];
  readonly satsPerBlock: Sats;
  readonly split: { readonly seeder: number; readonly creator: number };
  /** Seeder's own P2PK pubkey (lock target for `seederProofs`, and the creator set's `pay1` binding). */
  readonly p2pk: CashuP2pkPubkey;
  /**
   * v5 (L6-C request 3): seeder → viewer, the seeder's configured unpaid window in blocks.
   * The window a viewer must stay under for a core is
   * `max(windowBlocks, min(ceil(minPaySats / satsPerBlock), MAX_MIN_PAY_WINDOW_BLOCKS))`
   * (`effectiveWindowBlocks`).
   * Viewer → seeder: 0.
   */
  readonly windowBlocks: number;
}

export interface PayWireMessage {
  readonly type: 'PAY';
  readonly payload: PayMessage;
}

export interface AckMessage {
  readonly type: 'ACK';
  /** v5 (L6-C request 3): the core of the PAY this answers — ranges on two cores can coincide. */
  readonly core: CoreKeyHex;
  readonly fromBlock: number;
  readonly toBlock: number;
  readonly ok: boolean;
  readonly reason?: RejectReason;
}

export interface PriceMessage {
  readonly type: 'PRICE';
  /** v5 (L3 observation, ADR 0005): prices are per video, so a new price names its core. */
  readonly core: CoreKeyHex;
  readonly satsPerBlock: Sats;
  /** Blocks at the old price still honoured; viewer may leave. */
  readonly effectiveFromBlock: number;
}

export type PayProtocolMessage = HelloMessage | PayWireMessage | AckMessage | PriceMessage;

export type PayProtocolState =
  | 'idle'
  | 'hello-sent'
  | 'open' // both HELLOs verified
  | 'closed';

/**
 * Minimal view of a protomux instance the protocol attaches to. Kept structural so the
 * contract has no dependency on `protomux`; the implementation narrows it.
 */
export interface MuxLike {
  createChannel(opts: {
    protocol: string;
    id?: Uint8Array | null;
    onopen?: () => void;
    onclose?: () => void;
    ondestroy?: () => void;
  }): unknown;
}

export interface PayProtocolEvents {
  open: (peer: HelloMessage) => void;
  pay: (msg: PayMessage) => void;
  ack: (msg: AckMessage) => void;
  price: (msg: PriceMessage) => void;
  /** Local decision to cut the stream (window exceeded / banned / protocol error). */
  close: (reason: 'window-exceeded' | 'banned' | 'protocol-error' | 'remote' | 'local') => void;
}

export interface PayProtocol {
  readonly state: PayProtocolState;
  readonly peer: HelloMessage | null;

  /** Attach to a mux shared with Hypercore replication on the same stream. */
  attach(mux: MuxLike): void;

  sendHello(hello: Omit<HelloMessage, 'type'>): void;
  sendPay(msg: PayMessage): void;
  sendAck(ack: Omit<AckMessage, 'type'>): void;
  sendPrice(price: Omit<PriceMessage, 'type'>): void;

  /**
   * Cut this peer. Per spike S-A there is no per-peer upload pause in Hypercore, so this is
   * `peerInfo.ban(true)` (hyperswarm, prevents reconnect) followed by `stream.destroy()`.
   * For `window-exceeded` it MUST run synchronously inside the `upload` handler (no await,
   * no ACK first); for protocol decisions an `ACK{ok:false}` may be sent before the cut.
   */
  cut(reason: Parameters<PayProtocolEvents['close']>[0]): void;

  on<K extends keyof PayProtocolEvents>(event: K, cb: PayProtocolEvents[K]): () => void;
}

/**
 * Codec contract, fuzzed by L10. Must never throw on arbitrary bytes: return `null`.
 * `encode` throws on a message that does not satisfy the field grammar (so a local bug can
 * never put an undecodable frame on the wire); `decode(encode(m))` deep-equals `m`.
 */
export interface PayProtocolCodec {
  encode(msg: PayProtocolMessage): Uint8Array;
  decode(buf: Uint8Array): PayProtocolMessage | null;
}
