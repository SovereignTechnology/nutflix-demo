import type { LockedProofSet } from './cashu.js';
import type { PricePolicy } from './manifest.js';
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
 * PaymentEngine — the audit surface (build-plan §2.3, §3; SECURITY.md invariants 1–6).
 *
 * Two roles share one interface so a gateway, which is both a viewer (upstream) and a
 * seeder (downstream), instantiates it once per side.
 *
 * Real implementation lands in Stage 2 (`core/src/payment/`, locked). Until then every
 * consumer uses `MockPaymentEngine` from `core/src/mocks/`, whose `mode` lets the
 * adversary suite (L10) assert what the real engine must reject.
 */

/**
 * Inclusive block range `[fromBlock, toBlock]` within one core.
 *
 * `core` names that core. A Corestore replication stream carries MANY cores over ONE
 * `pay/1` channel, and `PricePolicy` (mint, split, `creatorP2pk`) is per video — so
 * without `core` the seeder cannot pick the policy to verify against (invariant 2 exact
 * amount, T4 creator set) nor check `range-not-uploaded` / `range-already-paid` per core.
 * v3 made it optional (ADR 0004); **v5 makes it required** (ADR 0010): a `PAY` without a
 * well-formed `core` is `malformed`, whatever the stream carries.
 */
export interface BlockRange {
  readonly core: CoreKeyHex;
  readonly fromBlock: BlockIndex;
  readonly toBlock: BlockIndex;
}

/**
 * What goes on the wire in a `PAY` message. Both sets are P2PK-locked and carry DLEQ.
 *
 * v5 (ADR 0007 as amended by ADR 0010) — the per-PAY split. For `amount = blocks ×
 * satsPerBlock` and a split with creator percentage `c`, both sides compute
 *
 *     units       = amount × c + carryIn
 *     creatorSats = floor(units / 100)       carryOut   = units mod 100
 *     seederSats  = amount − creatorSats
 *
 * (`splitPay()` in `payment/split.ts` is the one implementation both sides use). Over a
 * stream of accepted PAYs totalling `T` sats the creator receives `floor(T × c / 100)`.
 * `carryIn` is the carry the payer split THIS PAY with; the seeder refuses a PAY whose
 * `carryIn` differs from its own carry for (peer, core) as `malformed` — a desync is loud,
 * never a silent split dispute. The carry advances only on an ACCEPTED PAY, is scoped to
 * one `pay/1` channel × one core (it restarts at 0 on a new channel, see `rebind`), and is
 * never flushed at the end of a stream (the creator loses < 1 sat per stream).
 *
 * A set whose share is 0 sats by the formula is legitimately EMPTY (`proofs: []`, still
 * addressed to its recipient). Every proof in the creator set carries the NUT-10 tag
 * `['pay1', <seeder P2PK pubkey>]` in its P2PK secret, binding it to the seeder it pays
 * through (ADR 0010 §binding) — proofs lifted from a public nutzap cannot be re-presented to
 * another seeder as a new creator share.
 */
export interface PayMessage {
  readonly range: BlockRange;
  /** v5: integer in [0, 99] — the creator carry this PAY was split with. */
  readonly carryIn: number;
  readonly seederProofs: LockedProofSet;
  readonly creatorProofs: LockedProofSet;
}

export type RejectReason =
  | 'bad-dleq' // T7: DLEQ failed against cached keyset
  | 'wrong-p2pk-target' // T4/T6: a set is not locked to the expected recipient
  | 'wrong-amount' // invariant 2: under- or overpayment (see `overpay`)
  | 'overpay' // invariant 2: strictly more than owed
  | 'mint-not-accepted' // mint not in the seeder's allowlist for this video
  | 'missing-creator-set' // T4
  | 'missing-seeder-set'
  | 'range-not-uploaded' // paying for blocks this seeder never sent to this peer
  | 'range-already-paid' // replay
  | 'missing-dleq' // proof without DLEQ is not verifiable offline
  | 'malformed' // shape, range, core, or a `carryIn` that does not match the seeder's carry
  | 'peer-banned'
  /**
   * v5 (ADR 0010): a proof whose secret this seeder has already accepted (in an earlier PAY
   * or twice in this one). Detected at `verify`, before `ACK`; the peer is banned at once
   * and `onDoubleSpend` fires (T5, invariant 6). A proof spent elsewhere is still caught by
   * the async swap in `flush()`.
   */
  | 'double-spend';

export type VerifyResult =
  | { readonly ok: true; readonly credited: Sats; readonly blocks: number }
  | { readonly ok: false; readonly reason: RejectReason; readonly detail?: string };

/** Per-peer accounting the seeder side maintains (invariant 5). */
export interface PeerWindow {
  readonly peer: NostrPubkey;
  /** v5: DISTINCT blocks (core, index) sent to this peer — a re-sent block counts once. */
  readonly uploaded: number;
  readonly paid: number; // blocks paid for by this peer
  /** `uploaded − paid`. Past `windowBlocks` the stream is destroyed and the peer banned. */
  readonly outstanding: number;
  /**
   * v5: the EFFECTIVE window — `max(config.windowBlocks, ceil(minPaySats / satsPerBlock))`
   * over the policies of every core recorded for this peer (ADR 0007: the unpaid window must
   * fit one minimum PAY). `effectiveWindowBlocks()` in `payment/split.ts` computes it.
   */
  readonly windowBlocks: number;
  readonly banned: boolean;
  readonly lastActivity: UnixSeconds;
}

export interface PaymentEngineViewer {
  /**
   * Viewer side. Called after Hypercore has emitted `download` for every block in `range`
   * from `seeder` (invariant 1). Produces both locked sets via `Wallet.send`, updates
   * NIP-60, and returns the message to put on the wire. Never sends more than
   * `blocks × price` (invariant 2).
   *
   * v5: the split uses `opts.carryIn` when given; otherwise the engine's running carry for
   * (`seeder.pubkey`, `range.core`), which advances on every PAY this method produces — right
   * whenever every PAY is accepted in order. A transport that saw a rejected `ACK`, or opened
   * a new channel to the same seeder, passes the carry it reconstructed (ADR 0010 §viewer).
   * The creator set is bound to `seeder.p2pk` (`['pay1', …]` tag).
   */
  pay(
    range: BlockRange,
    seeder: {
      readonly pubkey: NostrPubkey;
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
    },
    policy: PricePolicy,
    opts?: { readonly carryIn?: number },
  ): Promise<PayMessage>;

  /** Running totals for the wallet chip / peer panel. */
  spent(): { readonly total: Sats; readonly perPeer: ReadonlyMap<NostrPubkey, Sats> };
}

export interface PaymentEngineSeeder {
  /**
   * Seeder side. Fully offline verification BEFORE `ACK` (invariant 4):
   * DLEQ against cached keyset, P2PK targets (own pubkey + creator pubkey), exact amount
   * for `range` under `policy`, mint allowlist, range was actually uploaded to `peer` and
   * not already paid. On success credits the peer's window and queues the proofs for the
   * async swap batch. Never throws for a bad message — returns a `RejectReason`.
   *
   * v5: also the carry (`PayMessage`), the P2PK secret policy (data = recipient, no
   * `locktime`/`refund`/`pubkeys`, `n_sigs` ≤ 1, `SIG_INPUTS`, the creator set's `pay1`
   * binding) and the local double-spend check. A PAY below `minPaySats` is NOT refused (the
   * minimum is a batching target, ADR 0010 §minimum). PAYs from one peer are decided in
   * arrival order (the carry chains them). Reason precedence when several apply:
   * peer-banned → malformed → missing-*-set → mint-not-accepted → wrong-p2pk-target
   * (envelope) → overpay / wrong-amount → range-not-uploaded → range-already-paid →
   * missing-dleq → bad-dleq → wrong-p2pk-target (secret) → double-spend. Cheap checks first;
   * the expensive DLEQ math runs last.
   */
  verify(peer: NostrPubkey, msg: PayMessage, policy: PricePolicy): Promise<VerifyResult>;

  /**
   * Record that the blocks in `blocks` (one core, usually a single index) were uploaded to
   * `peer`. MUST be called synchronously from inside Hypercore's `upload` event handler:
   * spike S-A established that `upload` fires BEFORE the block is written to the wire, so a
   * stream destroy in the same tick prevents the block that crosses the window from ever
   * leaving. `onWindowExceeded` callbacks therefore fire synchronously from this call, and
   * the returned window is post-update.
   *
   * v5 (ADR 0010, L6-C request 1): the record carries block INDEXES, so `range-not-uploaded`
   * means "not every block of this PAY was sent to you" — a viewer that seeks, or splits a
   * core across several seeders, pays each for exactly what it sent. A block already
   * recorded for (peer, core) is not counted again. `policy` is the core's price policy (only
   * its price and minimum PAY are read); it sets the peer's effective window
   * (`PeerWindow.windowBlocks`). A core served without a price passes `{ satsPerBlock: 0 }`
   * (the configured window). The window itself (invariant 5) stays per peer, summed over
   * cores.
   */
  recordUpload(
    peer: NostrPubkey,
    blocks: BlockRange,
    policy: Pick<PricePolicy, 'satsPerBlock' | 'minPaySats'>,
  ): PeerWindow;

  /**
   * Move the accounting kept under `from` onto `to` and drop `from` (v3, ADR 0004).
   *
   * Hypercore starts serving the moment the replication channel opens; `pay/1`'s `HELLO`
   * — which binds the Nostr pubkey — races it. The transport therefore accounts pre-`HELLO`
   * uploads under a provisional id (the peer's Noise key as hex, same 32-byte shape; it is
   * authenticated by the Noise handshake) and calls `rebind(noiseHex, pubkey)` once `HELLO`
   * verifies. Semantics: `uploaded`/`paid`/paid ranges are SUMMED into `to` (a pubkey that
   * already has a window from another session keeps it); a ban on either side sticks to
   * `to`; `from` is removed. If the merged `outstanding` exceeds the window the engine bans
   * `to` and fires `onWindowExceeded` synchronously, exactly as `recordUpload` would. Returns
   * the post-merge window. Idempotent for an unknown `from` (returns `to`'s window).
   *
   * v5: `rebind` marks a NEW `pay/1` channel for `to`: its per-core carries are replaced by
   * `from`'s (0 where `from` has none) — also when `from` is unknown. A pubkey with two live
   * channels to one seeder is not supported.
   */
  rebind(from: NostrPubkey, to: NostrPubkey): PeerWindow;

  window(peer: NostrPubkey): PeerWindow | undefined;
  windows(): readonly PeerWindow[];

  /**
   * Fires when a peer crosses the window. The transport layer (pay-protocol/seeder)
   * destroys the stream on this signal; the engine bans the pubkey itself.
   */
  onWindowExceeded(cb: (w: PeerWindow) => void): () => void;

  /**
   * Fires when the async swap at the mint reported a spent proof, or (v5) `verify` saw a
   * proof secret it had already accepted (double-spend, T5). The engine has already banned
   * the peer; this is for logging (redacted) and UI.
   */
  onDoubleSpend(
    cb: (peer: NostrPubkey, detail: { readonly mint: MintUrl; readonly amount: Sats }) => void,
  ): () => void;

  /**
   * Process the swap batch now (normally every N blocks or 60 s). Swaps own proofs into
   * the wallet, publishes creator proofs as kind 9321 nutzaps. Returns what happened.
   */
  flush(): Promise<{ readonly swapped: Sats; readonly nutzapped: Sats; readonly failed: number }>;

  /**
   * Bans are keyed on the Nostr pubkey bound in `HELLO`; the transport layer additionally
   * bans the Noise key (`hyperswarm` `peerInfo.ban(true)`) so the peer cannot reconnect.
   * Both keys are persisted by the seeder (SECURITY.md invariant 6).
   */
  ban(peer: NostrPubkey, reason: string, noiseKey?: Uint8Array): void;
  unban(peer: NostrPubkey): void;
  isBanned(peer: NostrPubkey): boolean;
  bans(): readonly BanEntry[];
}

export interface BanEntry {
  readonly pubkey: NostrPubkey;
  readonly noiseKey?: Uint8Array;
  readonly reason: string;
  readonly at: UnixSeconds;
}

/** Full engine = both sides plus configuration. */
export interface PaymentEngine extends PaymentEngineViewer, PaymentEngineSeeder {
  readonly config: PaymentEngineConfig;
}

export interface PaymentEngineConfig {
  readonly windowBlocks: number;
  /** Mints this node will accept payment at. */
  readonly acceptedMints: readonly MintUrl[];
  /** This node's own P2PK pubkey (seeder side). */
  readonly ownP2pk: CashuP2pkPubkey;
  readonly ownPubkey: NostrPubkey;
  /** Swap batch triggers. */
  readonly flushEveryBlocks: number;
  readonly flushEveryMs: number;
}
