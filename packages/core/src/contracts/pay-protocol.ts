import { NostrKind } from './nostr.js';
import type { PayMessage, RejectReason } from './payment.js';
import type {
  BlockIndex,
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
 * v6 amendment (2026-09-26, ADRs 0015 and 0018 amendments) — NORMATIVE for every seeder this
 * repository builds (the daemon, the gateway, the desktop worker's seeder, the dev fixtures).
 *
 * 1. **A core's PRICE before its first block.** Before a seeder sends a peer the first block of a
 *    core on a `pay/1` connection, it sends that core's `PRICE` on the same connection: priced
 *    (`effectiveFromBlock` = one past the highest block of that core it counted on this connection,
 *    0 when none), or `{ free: true }` for a core it serves outside payment. Protomux keeps one
 *    order per stream, so the `PRICE` precedes the block on the wire (a viewer must attach `pay/1`
 *    before it asks for blocks). It sends a new one whenever that changes: a price change (F9), a
 *    core that turns free, or a free core that turns sold (before the next block). A core with no
 *    terms at all (no price and not free) gets none — no seeder of this repository serves one.
 * 2. **OWED once both HELLOs verified.** When the connection opens (both HELLOs verified), the
 *    seeder sends one `OWED` per core where it still counts unpaid blocks for the viewer's HELLO
 *    pubkey — from this and from earlier connections, under any Noise key. Cores in the order the
 *    seeder first counted them for that pubkey, ranges in ascending block order (oldest first); the
 *    whole report is bounded by `MAX_OWED_RANGES` and `MAX_OWED_BLOCKS`, and what is past the caps
 *    is not reported (`ACK.outstanding` still counts it). Once per connection.
 * 3. **Owed blocks are payable at the core's terms.** Before a core's `OWED` the seeder sends that
 *    core's priced `PRICE` (unless it already did on this connection); an owed range is then an
 *    ordinary `PAY` on this connection, verified at the terms in force for its first block (that
 *    `PRICE`, or a later one), with `carryIn` 0 for that core on a new connection (ADR 0010). An
 *    accepted one clears those blocks. An `OWED` with no priced `PRICE` for its core before it names
 *    blocks the seeder counts but takes no payment for now (a core served free since, or one with
 *    no terms): the viewer counts them against the seeder's window and does not pay them.
 * 4. **`ACK.outstanding` in every ACK.**
 *
 * The viewer's side (ADR 0018 amendment): a viewer starts its credit toward a seeder from what the
 * seeder reports, and pays reported blocks only when its own durable record says it received them
 * from that seeder, at the terms it recorded — a seeder that claims more is respected (never asked
 * beyond its window) and never paid the difference.
 */

/** Most ranges one `OWED` names (and one connection's whole report). */
export const MAX_OWED_RANGES = 256 as const;
/**
 * Most blocks one `OWED` names in total (and one connection's whole report) — the viewer's credit
 * toward one seeder is itself capped at 1024 blocks (`MAX_SEEDER_CREDIT`), so a longer report
 * could only say "ask nothing", which a report at the cap already says.
 */
export const MAX_OWED_BLOCKS = 1024 as const;

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
  /**
   * v6 amendment (ADR 0018): the blocks of `core` the seeder counts unpaid for this peer's
   * account when the ACK is sent — after this PAY was applied (accepted or refused), and including
   * blocks sent since the PAY. Before HELLO that account is the provisional one (ADR 0004 d).
   * Every seeder this repository builds sends it; absent means the seeder did not say.
   */
  readonly outstanding?: number;
}

export interface PriceMessage {
  readonly type: 'PRICE';
  /** v5 (L3 observation, ADR 0005): prices are per video, so a new price names its core. */
  readonly core: CoreKeyHex;
  readonly satsPerBlock: Sats;
  /** Blocks at the old price still honoured; viewer may leave. */
  readonly effectiveFromBlock: number;
  /**
   * v6 amendment (ADR 0015): `true` = the seeder serves this core OUTSIDE payment: it counts none
   * of its blocks against the peer's window, never cuts for them, and no PAY for them is due.
   * `satsPerBlock` and `effectiveFromBlock` are 0 then (the codec refuses anything else). Absent
   * or `false`: a priced `PRICE`, as before. A viewer reading a core for display asks a peer for
   * its blocks only after that peer's `{ free: true }` for it.
   */
  readonly free?: boolean;
}

/** An inclusive block range of one core, `[fromBlock, toBlock]`. */
export type OwedRange = readonly [fromBlock: BlockIndex, toBlock: BlockIndex];

/**
 * v6 amendment (ADR 0018), seeder → viewer: the blocks of `core` the seeder still counts unpaid for
 * this viewer's HELLO pubkey (see the normative rules at the top). `ranges` is canonical: 1 …
 * `MAX_OWED_RANGES` ranges, each `fromBlock ≤ toBlock`, ascending, disjoint and not adjacent (one
 * encoding per set of blocks), `MAX_OWED_BLOCKS` blocks at most in total. The codec refuses
 * anything else.
 */
export interface OwedMessage {
  readonly type: 'OWED';
  readonly core: CoreKeyHex;
  readonly ranges: readonly OwedRange[];
}

export type PayProtocolMessage =
  | HelloMessage
  | PayWireMessage
  | AckMessage
  | PriceMessage
  | OwedMessage;

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
  /** v6 amendment: an `OWED` from the seeder (delivered only once the channel is `open`). */
  owed: (msg: OwedMessage) => void;
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
  /** v6 amendment: the seeder's report of what it still counts on one core (rule 2 above). */
  sendOwed(owed: Omit<OwedMessage, 'type'>): void;

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
