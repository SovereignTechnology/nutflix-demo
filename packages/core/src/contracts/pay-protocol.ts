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
 * v6 amendment (2026-09-26, Cameron; ADRs 0015 and 0018 amendments) — NORMATIVE for every seeder
 * this repository builds (the daemon, the gateway, the desktop worker's seeder, the dev fixtures).
 * Additive: `PAY_PROTOCOL_VERSION` stays 1 (see `version.ts`).
 *
 * 1. **A core's terms when the peer opens it, and before its first block.** As soon as a peer has
 *    a core open with the seeder on a connection with `pay/1` attached (both ends of the core's
 *    replication channel open — whichever of that and the `pay/1` attach comes last), the seeder
 *    sends that core's `PRICE` on the same connection, unprompted: priced, or `{ free: true }` for
 *    a core it serves outside payment. A viewer can therefore wait for the terms before it asks
 *    for anything (ADR 0015: an image read asks a peer only after its `{ free: true }`), and
 *    silence means the peer has no terms to say. In any case the `PRICE` goes out before the
 *    first block of the core to that peer; Protomux keeps one order per stream, so it precedes the
 *    block on the wire (a viewer attaches `pay/1` before it asks for blocks). Priced:
 *    `effectiveFromBlock` is one past the highest block of that core the seeder COUNTED on this
 *    connection (0 when none). It sends a new `PRICE` for the core whenever what it serves changes
 *    — a price change (security review F9), a core that turns free, or a free core that turns
 *    sold (at once to a peer that has the core open, and in any case before its next block) — and
 *    never repeats the terms it last said on this connection. A core with no terms at all (no
 *    price of its own, no default, not free) gets no `PRICE`; its blocks are counted and cannot
 *    be paid, so no seeder of this repository should serve one (see the lane record for the one
 *    known window).
 * 2. **`OWED` once, when both HELLOs are verified.** When the connection opens (both HELLOs
 *    verified and the viewer's pubkey bound; a banned pubkey is cut instead), the seeder sends one
 *    `OWED` per core where it counts unpaid blocks for the viewer's HELLO pubkey — blocks sent on
 *    earlier connections under any Noise key, and on this one before its HELLO. Cores in the order
 *    the seeder first counted them for that pubkey, each core's ranges ascending: oldest first. The
 *    whole report (every `OWED` of the connection together) is bounded by `MAX_OWED_RANGES` and
 *    `MAX_OWED_BLOCKS`; what is past the caps is left out, and a range crossing the block cap is
 *    cut short. What is left out is still counted: `ACK.outstanding` includes it. Nothing owed:
 *    no `OWED` for any core (v7: the report still ends with the end marker, below). Once per
 *    connection; later blocks are reported by `ACK.outstanding` only.
 *    **Order:** the seeder handles the HELLO that opens the connection — binds the pubkey and
 *    writes every `OWED` of the report — before it handles any frame that follows that HELLO on
 *    the stream, and when its own HELLO goes out last, the report follows it directly. So a viewer
 *    that asks for no block before its channel is `open` receives the whole report before the
 *    first block it asked for: once any block it asked for after `open` arrives, silence means
 *    nothing is owed. Blocks it asks for earlier are counted under the provisional identity and
 *    merged into the pubkey's count when the HELLO binds — a merge past the window is a cut.
 * 3. **Owed blocks are payable at the core's terms.** Before a sold core's `OWED` the seeder sends
 *    that core's priced `PRICE` (unless it already did on this connection). An owed range is then
 *    an ordinary `PAY` on this connection: verified at the terms this connection was told for its
 *    first block (that `PRICE`, or a later one), inside this connection's carry chain for that
 *    core (ADR 0010). The chain restarts at 0 on a new channel and moves with every accepted PAY
 *    of the core, owed or not: an owed range's `carryIn` is 0 only when it is the first PAY of
 *    that core on this connection, else the `carryOut` of the last accepted one (a PAY with any
 *    other `carryIn` is refused as `malformed`). An accepted one clears those blocks. An `OWED`
 *    whose core got no priced `PRICE` on this connection names blocks the seeder counts but takes
 *    no payment for here (a core it serves free since, or one with no terms): `free` covers the
 *    blocks served while it holds, not blocks counted before it. The viewer counts them against
 *    the seeder's window and does not pay them.
 * 4. **`ACK.outstanding` in every ACK:** after the PAY was applied, the blocks of the ACK's core
 *    the seeder counts unpaid for this account (see `AckMessage.outstanding`).
 *
 * The viewer's side (ADR 0018 amendment): `OWED`, `ACK.outstanding` and `free` are the seeder's
 * CLAIMS. A viewer starts its credit toward a seeder from what the seeder reports, and pays
 * reported blocks only when its own durable record says it received them from that seeder, at the
 * terms it recorded — a seeder that claims more is respected (never asked beyond its window) and
 * never paid the difference. An honest seeder sends one `OWED` per core per connection; a viewer
 * may ignore any later one for the same core. An `OWED` before the channel is `open` is a
 * protocol error (`PayProtocolEvents.owed`).
 *
 * v7 amendment (2026-10-02, Cameron; ADR 0018 amendment, R3/R4,
 * `docs/contract-requests/P2-owed-viewer.md` option 1) — NORMATIVE for every seeder this
 * repository builds:
 *
 * 5. **The report ends with an end marker.** Right after the last `OWED` of rule 2's report —
 *    and when nothing is owed, right after the HELLO that opens the connection — the seeder sends
 *    one `OWED` whose `core` is `OWED_END_CORE` and whose `ranges` is empty. Once per connection,
 *    under rule 2's order, so it too precedes the first block the viewer asked for after `open`.
 *    It names no blocks and is outside the report's caps. A viewer that has it knows the report
 *    is complete and need not wait (a viewer of an older seeder, which sends none, keeps its
 *    bounded wait). `PAY_PROTOCOL_VERSION` stays 1, as in v6: an older build's codec refuses the
 *    marker and closes `pay/1` (no deployed base yet).
 */

/**
 * v7: the `core` of the end-of-report marker (rule 5): 32 zero bytes, which no Hypercore key is
 * (a public key of all zeros is not a valid ed25519 point).
 */
export const OWED_END_CORE = '0'.repeat(64) as CoreKeyHex;

/** Most ranges one `OWED` names (and one connection's whole report). */
export const MAX_OWED_RANGES = 256 as const;
/**
 * Most blocks one `OWED` names in total (and one connection's whole report). A viewer's credit
 * toward one seeder is itself capped at 1024 blocks (the gateway's `MAX_SEEDER_CREDIT`), so a
 * longer report could only say "ask nothing", which a report at the cap already says.
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
   * v6 amendment (ADR 0018): the blocks of `core` the seeder counts unpaid for this peer's account
   * when the ACK is sent — after this PAY was applied (accepted or refused), including blocks sent
   * while it was verified and blocks left out of an `OWED` by its caps. Before HELLO that account
   * is the provisional one (ADR 0004 d). Every seeder this repository builds sends it; absent means
   * the seeder did not say (an older seeder).
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
   * v6 amendment (ADR 0015): `true` = from now on the seeder serves this core OUTSIDE payment: it
   * counts none of the blocks it sends of it against the peer's window, never cuts for them, and no
   * PAY for them is due (blocks it counted before stay counted — rule 3). `satsPerBlock` and
   * `effectiveFromBlock` are 0 then (the codec refuses anything else). Absent or `false`: a priced
   * `PRICE`, as before (`false` is never sent by this repository's seeders). Only `true` means
   * free: `{ satsPerBlock: 0 }` WITHOUT `free` is a sold core at no price — its blocks are counted
   * and cleared only by (empty-set) PAYs, like any other sold core. A viewer reading a core for
   * display asks a peer for its blocks only after that peer's `{ free: true }` for it.
   */
  readonly free?: boolean;
}

/** An inclusive block range of one core, `[fromBlock, toBlock]`. */
export type OwedRange = readonly [fromBlock: BlockIndex, toBlock: BlockIndex];

/**
 * v6 amendment (ADR 0018), seeder → viewer: the blocks of `core` the seeder still counts unpaid for
 * this viewer's HELLO pubkey (rules 2 and 3 at the top). `ranges` is canonical: 1 …
 * `MAX_OWED_RANGES` ranges, each `fromBlock ≤ toBlock`, ascending, disjoint and not adjacent (one
 * encoding per set of blocks), `MAX_OWED_BLOCKS` blocks at most in total. v7 (rule 5): the one
 * other form is the end marker — `core` `OWED_END_CORE` with `ranges` empty; `OWED_END_CORE` with
 * any range, or an empty `ranges` for any other core, is refused. The codec refuses anything else,
 * both ways.
 */
export interface OwedMessage {
  readonly type: 'OWED';
  readonly core: CoreKeyHex;
  readonly ranges: readonly OwedRange[];
}

export type PayProtocolMessage =
  HelloMessage | PayWireMessage | AckMessage | PriceMessage | OwedMessage;

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
  /**
   * v6 amendment: an `OWED` from the seeder, delivered only once the channel is `open` — one that
   * arrives earlier closes the channel as a protocol error (it names blocks for a pubkey nobody
   * has bound yet).
   */
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
  /** v6 amendment: the seeder's report of what it still counts on one core (rules 2–3 above). */
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
