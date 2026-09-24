/**
 * The real `PaymentEngine` (SECURITY.md invariants 1–6, threats T3–T8; contracts v5, ADR 0010).
 *
 * SEEDER SIDE — `verify` decides a PAY fully offline, before `ACK` (invariant 4), in the
 * contract's reason precedence: cheap structural and accounting checks first, the DLEQ math
 * last. Every check that matters is re-run synchronously in the same tick as the state change
 * it gates, so no interleaving — another peer's PAY, an upload, a `rebind` — can slip between a
 * check and its commit. PAYs from one peer are decided in arrival order (the carry chains them).
 *
 *   structure, range, core, carry     → malformed
 *   empty set whose share is > 0       → missing-seeder-set / missing-creator-set
 *   mint ∉ accepted ∩ policy           → mint-not-accepted          (T8)
 *   envelope not to own key / creator  → wrong-p2pk-target          (T4, T6)
 *   sums ≠ the carry-aware split       → overpay / wrong-amount     (invariant 2)
 *   a block not sent / already paid    → range-not-uploaded / range-already-paid (inv. 1)
 *   a proof without DLEQ               → missing-dleq
 *   DLEQ fails vs the cached keyset    → bad-dleq                   (T7)
 *   lock in the SECRET not a plain one
 *   to the recipient, or the creator
 *   set not bound to this seeder       → wrong-p2pk-target          (T4, T6, ADR 0010 §6)
 *   a secret already accepted          → double-spend + ban         (T5, invariant 6)
 *
 * `recordUpload` / `rebind` enforce the window synchronously (invariant 5): the crossing update
 * bans and fires `onWindowExceeded` before it returns. `flush` redeems the seeder sets at the mint
 * (a spent proof there is a double-spend: ban) and publishes the creator sets as NIP-61 nutzaps; a
 * mint or relay failure keeps the item for the next flush — the creator's money is never dropped.
 *
 * VIEWER SIDE — `pay` builds both locked sets through `Wallet.send` with the carry-aware split,
 * the creator set bound to the seeder (`['pay1', seeder P2PK]`). If the creator set cannot be
 * made after the seeder set was, the seeder set is kept and used first in the next PAY to that
 * seeder (it is locked to the seeder and cannot be taken back; this turns a loss into a delay).
 *
 * No cryptography here: DLEQ is cashu-ts `hasValidDleq`, secrets are parsed by cashu-ts, proofs
 * are made by the wallet. No proof material ever reaches a result, a detail, a callback or a
 * window snapshot (invariant 7).
 */
import { Amount, hasValidDleq } from '@cashu/cashu-ts';

import type {
  BanEntry,
  BlockRange,
  CashuP2pkPubkey,
  CashuProof,
  CoreKeyHex,
  LockedProofSet,
  MintKeyset,
  MintUrl,
  NostrPubkey,
  PayMessage,
  PaymentEngine,
  PaymentEngineConfig,
  PeerWindow,
  PricePolicy,
  RejectReason,
  Sats,
  UnixSeconds,
  VerifyResult,
  Wallet,
} from '../contracts/index.js';
import { checkPayLock, PAY1_TAG } from './lock.js';
import { RangeSet } from './range-set.js';
import { SeenSecrets } from './seen.js';
import {
  MAX_PAY_SATS,
  effectiveWindowBlocks,
  isValidCarry,
  isValidSplit,
  splitPay,
} from './split.js';

// ---------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------

export interface PaymentEngineDeps {
  readonly config: PaymentEngineConfig;
  readonly now?: () => UnixSeconds;
  /** Viewer side: the wallet that makes the locked sets. */
  readonly wallet?: Pick<Wallet, 'send'>;
  /**
   * Seeder side: a CACHED keyset for offline DLEQ verification (T7). Called only for mints the
   * PAY may use (accepted ∩ policy). Whether a miss triggers a fetch is the host's policy — keep
   * it rate-limited: a peer can name any keyset id.
   */
  readonly keyset?: (mint: MintUrl, keysetId: string) => Promise<MintKeyset | undefined>;
  /**
   * Seeder side: swap a seeder set into the node's own wallet (`Wallet.receive`). Must reject
   * with an error whose `code` is `'spent'` when the mint reports a proof already spent.
   */
  readonly redeem?: (set: {
    readonly mint: MintUrl;
    readonly proofs: readonly CashuProof[];
  }) => Promise<Sats>;
  /** Seeder side: publish a creator set as a NIP-61 nutzap (kind 9321). */
  readonly nutzap?: (
    set: LockedProofSet,
    ctx: {
      readonly peer: NostrPubkey;
      readonly core: CoreKeyHex;
      readonly fromBlock: number;
      readonly toBlock: number;
    },
  ) => Promise<void>;
  /** Seeder side: accepted proof secrets (restore from disk at start; persists new ones). */
  readonly seen?: SeenSecrets;
}

// ---------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------

const CORE_RE = /^[0-9a-f]{64}$/;
const COMPRESSED = /^0[23][0-9a-f]{64}$/;
const KEYSET_ID = /^[0-9a-f]{16}$|^[0-9a-f]{66}$/;
const HEX = /^[0-9a-f]+$/;
/** Hypercore block indexes are array positions; 2^40 is a 64 PiB core. */
const MAX_BLOCK = 2 ** 40;
/**
 * Most proofs one set may carry. A P2PK send splits into powers of two (≤ 41 proofs for any
 * amount up to 2^40) plus a few reused ones; every proof costs a DLEQ check (~14 ms in pure JS),
 * so an uncapped set is a CPU lever for any peer (T11).
 */
export const MAX_PROOFS_PER_SET = 64;

function isProofShape(x: unknown): x is CashuProof {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  if (typeof p['id'] !== 'string' || typeof p['secret'] !== 'string' || typeof p['C'] !== 'string')
    return false;
  if (!Number.isSafeInteger(p['amount']) || (p['amount'] as number) <= 0) return false;
  const d = p['dleq'];
  if (d !== undefined) {
    if (typeof d !== 'object' || d === null) return false;
    const q = d as Record<string, unknown>;
    if (typeof q['s'] !== 'string' || typeof q['e'] !== 'string') return false;
    if (q['r'] !== undefined && typeof q['r'] !== 'string') return false;
  }
  return p['witness'] === undefined || typeof p['witness'] === 'string';
}

function isSetShape(x: unknown): x is LockedProofSet {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s['mint'] === 'string' &&
    typeof s['lockedTo'] === 'string' &&
    s['unit'] === 'sat' &&
    Array.isArray(s['proofs']) &&
    s['proofs'].length <= MAX_PROOFS_PER_SET &&
    s['proofs'].every(isProofShape)
  );
}

/** Structural guard — `verify` never throws, never reads a field it has not checked. */
export function isPayMessageV5(x: unknown): x is PayMessage {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  const r = m['range'];
  if (typeof r !== 'object' || r === null) return false;
  const rr = r as Record<string, unknown>;
  const from = rr['fromBlock'];
  const to = rr['toBlock'];
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return false;
  if ((from as number) < 0 || (to as number) < (from as number) || (to as number) > MAX_BLOCK)
    return false;
  if (typeof rr['core'] !== 'string' || !CORE_RE.test(rr['core'])) return false;
  if (!isValidCarry(m['carryIn'])) return false;
  return isSetShape(m['seederProofs']) && isSetShape(m['creatorProofs']);
}

function isPolicyShape(p: unknown): p is PricePolicy {
  if (typeof p !== 'object' || p === null) return false;
  const q = p as Record<string, unknown>;
  return (
    Number.isSafeInteger(q['satsPerBlock']) &&
    (q['satsPerBlock'] as number) >= 0 &&
    isValidSplit(q['split']) &&
    Array.isArray(q['mints']) &&
    typeof q['creatorP2pk'] === 'string' &&
    COMPRESSED.test(q['creatorP2pk'].toLowerCase())
  );
}

function sum(proofs: readonly CashuProof[]): number {
  let n = 0;
  for (const p of proofs) n += p.amount;
  return n;
}

function blocksIn(r: BlockRange): number {
  return r.toBlock - r.fromBlock + 1;
}

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

interface CoreState {
  readonly sent: RangeSet;
  readonly paid: RangeSet;
  window: number;
  carry: number;
}

interface PeerState {
  readonly peer: NostrPubkey;
  banned: boolean;
  lastActivity: UnixSeconds;
  readonly cores: Map<CoreKeyHex, CoreState>;
}

interface Pending {
  peer: NostrPubkey;
  readonly msg: PayMessage;
  stage: 'redeem' | 'nutzap';
}

type Decision =
  | { readonly kind: 'result'; readonly result: VerifyResult }
  | { readonly kind: 'need-keysets'; readonly keys: readonly (readonly [MintUrl, string])[] };

export class RealPaymentEngine implements PaymentEngine {
  readonly config: PaymentEngineConfig;
  private readonly now: () => UnixSeconds;
  private readonly seen: SeenSecrets;
  private readonly peers = new Map<NostrPubkey, PeerState>();
  private readonly banMap = new Map<NostrPubkey, BanEntry>();
  private readonly pending: Pending[] = [];
  private readonly verifyChains = new Map<NostrPubkey, Promise<unknown>>();
  private readonly windowListeners = new Set<(w: PeerWindow) => void>();
  private readonly doubleSpendListeners = new Set<
    (peer: NostrPubkey, d: { readonly mint: MintUrl; readonly amount: Sats }) => void
  >();
  private flushing: Promise<{ swapped: Sats; nutzapped: Sats; failed: number }> | null = null;

  // viewer side
  private readonly viewerCarry = new Map<string, number>();
  private readonly spentPerPeer = new Map<NostrPubkey, number>();
  /** Seeder sets made for a PAY that never went out, by `seeder|p2pk|mint`: reused first. */
  private readonly orphans = new Map<string, CashuProof[]>();

  constructor(private readonly deps: PaymentEngineDeps) {
    const c = deps.config;
    if (!Number.isSafeInteger(c.windowBlocks) || c.windowBlocks < 1)
      throw new RangeError('PaymentEngine: windowBlocks must be a positive integer');
    if (!COMPRESSED.test(c.ownP2pk.toLowerCase()))
      throw new RangeError('PaymentEngine: ownP2pk must be a 33-byte compressed key (hex)');
    this.config = { ...c, acceptedMints: [...c.acceptedMints] };
    this.now = deps.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
    this.seen = deps.seen ?? new SeenSecrets();
  }

  // ===================================================================== viewer side

  async pay(
    range: BlockRange,
    seeder: {
      readonly pubkey: NostrPubkey;
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
    },
    policy: PricePolicy,
    opts?: { readonly carryIn?: number },
  ): Promise<PayMessage> {
    const wallet = this.deps.wallet;
    if (wallet === undefined) throw new Error('unsupported: this engine has no wallet to pay with');
    if (
      typeof range.core !== 'string' ||
      !CORE_RE.test(range.core) ||
      !Number.isSafeInteger(range.fromBlock) ||
      !Number.isSafeInteger(range.toBlock) ||
      range.fromBlock < 0 ||
      range.toBlock < range.fromBlock
    )
      throw new RangeError('pay: bad range');
    if (!isPolicyShape(policy)) throw new RangeError('pay: bad policy');
    if (!policy.mints.includes(seeder.mint))
      throw new RangeError('pay: the video does not accept this mint');
    if (!COMPRESSED.test(seeder.p2pk.toLowerCase()))
      throw new RangeError('pay: bad seeder P2PK key');

    const carryKey = `${seeder.pubkey}|${range.core}`;
    const carryIn = opts?.carryIn ?? this.viewerCarry.get(carryKey) ?? 0;
    const amount = blocksIn(range) * policy.satsPerBlock;
    if (amount > MAX_PAY_SATS) throw new RangeError('pay: amount too large');
    const split = splitPay(amount, policy.split, carryIn);
    const memo = `pay/1 ${String(blocksIn(range))} blocks`;

    const orphanKey = `${seeder.pubkey}|${seeder.p2pk}|${seeder.mint}`;
    const seederProofs = await this.seederShare(wallet, orphanKey, split.seederSats, seeder, memo);
    let creatorProofs: CashuProof[] = [];
    if (split.creatorSats > 0) {
      try {
        const set = await wallet.send(split.creatorSats as Sats, {
          p2pk: policy.creatorP2pk,
          mint: seeder.mint,
          tags: [[PAY1_TAG, seeder.p2pk]],
          memo,
        });
        creatorProofs = [...set.proofs];
      } catch (e) {
        // The seeder set exists and is locked to the seeder: keep it for the next PAY.
        if (seederProofs.length > 0)
          this.orphans.set(orphanKey, [...(this.orphans.get(orphanKey) ?? []), ...seederProofs]);
        throw e;
      }
    }
    this.viewerCarry.set(carryKey, split.carryOut);
    const paid = sum(seederProofs) + sum(creatorProofs);
    this.spentPerPeer.set(seeder.pubkey, (this.spentPerPeer.get(seeder.pubkey) ?? 0) + paid);
    return {
      range: { core: range.core, fromBlock: range.fromBlock, toBlock: range.toBlock },
      carryIn,
      seederProofs: { mint: seeder.mint, unit: 'sat', lockedTo: seeder.p2pk, proofs: seederProofs },
      creatorProofs: {
        mint: seeder.mint,
        unit: 'sat',
        lockedTo: policy.creatorP2pk,
        proofs: creatorProofs,
      },
    };
  }

  /** The seeder share: orphaned proofs first (exact subset-sum not needed — use whole orphans ≤ share). */
  private async seederShare(
    wallet: Pick<Wallet, 'send'>,
    orphanKey: string,
    share: number,
    seeder: { readonly p2pk: CashuP2pkPubkey; readonly mint: MintUrl },
    memo: string,
  ): Promise<CashuProof[]> {
    if (share === 0) return [];
    const orphans = this.orphans.get(orphanKey) ?? [];
    const use: CashuProof[] = [];
    const keep: CashuProof[] = [];
    let covered = 0;
    for (const p of [...orphans].sort((a, b) => b.amount - a.amount)) {
      if (covered + p.amount <= share) {
        use.push(p);
        covered += p.amount;
      } else keep.push(p);
    }
    if (covered < share) {
      const set = await wallet.send((share - covered) as Sats, {
        p2pk: seeder.p2pk,
        mint: seeder.mint,
        memo,
      });
      use.push(...set.proofs);
    }
    if (keep.length > 0) this.orphans.set(orphanKey, keep);
    else this.orphans.delete(orphanKey);
    return use;
  }

  spent(): { readonly total: Sats; readonly perPeer: ReadonlyMap<NostrPubkey, Sats> } {
    let total = 0;
    const perPeer = new Map<NostrPubkey, Sats>();
    for (const [k, v] of this.spentPerPeer) {
      total += v;
      perPeer.set(k, v as Sats);
    }
    return { total: total as Sats, perPeer };
  }

  // ===================================================================== seeder side

  verify(peer: NostrPubkey, msg: PayMessage, policy: PricePolicy): Promise<VerifyResult> {
    const prev = this.verifyChains.get(peer) ?? Promise.resolve();
    const run = prev.then(
      () => this.verifyOne(peer, msg, policy),
      () => this.verifyOne(peer, msg, policy),
    );
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.verifyChains.set(peer, settled);
    void settled.then(() => {
      if (this.verifyChains.get(peer) === settled) this.verifyChains.delete(peer);
    });
    return run;
  }

  private async verifyOne(
    peer: NostrPubkey,
    msg: PayMessage,
    policy: PricePolicy,
  ): Promise<VerifyResult> {
    try {
      const first = this.decide(peer, msg, policy, null);
      if (first.kind === 'result') return first.result;
      const keysets = new Map<string, MintKeyset>();
      const lookup = this.deps.keyset;
      if (lookup !== undefined) {
        for (const [mint, id] of first.keys) {
          let ks: MintKeyset | undefined;
          try {
            ks = await lookup(mint, id);
          } catch {
            ks = undefined;
          }
          if (ks !== undefined) keysets.set(`${mint}|${id}`, ks);
        }
      }
      const second = this.decide(peer, msg, policy, keysets);
      return second.kind === 'result' ? second.result : reject('bad-dleq', 'keyset unavailable');
    } catch {
      return reject('malformed');
    }
  }

  /**
   * The whole decision, synchronous. With `keysets === null` it stops before the DLEQ stage and
   * asks for the keysets it needs; with keysets it runs every check again (state may have moved
   * while they loaded) and, on acceptance, commits in the same tick.
   */
  private decide(
    peer: NostrPubkey,
    msg: PayMessage,
    policy: PricePolicy,
    keysets: ReadonlyMap<string, MintKeyset> | null,
  ): Decision {
    const out = (reason: RejectReason, detail?: string): Decision => ({
      kind: 'result',
      result: reject(reason, detail),
    });
    if (this.banMap.has(peer)) return out('peer-banned');
    if (!isPayMessageV5(msg)) return out('malformed');
    if (!isPolicyShape(policy)) return out('malformed', 'policy');
    const { range, carryIn, seederProofs, creatorProofs } = msg;
    const st = this.peers.get(peer);
    const cs = st?.cores.get(range.core);
    const carry = cs?.carry ?? 0;
    if (carryIn !== carry) return out('malformed', 'carryIn does not match');

    const blocks = blocksIn(range);
    const amount = blocks * policy.satsPerBlock;
    if (amount > MAX_PAY_SATS) return out('malformed', 'amount too large');
    const owed = splitPay(amount, policy.split, carryIn);
    if (seederProofs.proofs.length === 0 && owed.seederSats > 0) return out('missing-seeder-set');
    if (creatorProofs.proofs.length === 0 && owed.creatorSats > 0)
      return out('missing-creator-set');

    for (const set of [seederProofs, creatorProofs]) {
      if (!this.config.acceptedMints.includes(set.mint) || !policy.mints.includes(set.mint))
        return out('mint-not-accepted');
    }
    const own = this.config.ownP2pk.toLowerCase();
    const creator = policy.creatorP2pk.toLowerCase();
    if (seederProofs.lockedTo.toLowerCase() !== own) return out('wrong-p2pk-target', 'seeder set');
    if (creatorProofs.lockedTo.toLowerCase() !== creator)
      return out('wrong-p2pk-target', 'creator set');

    const gotSeeder = sum(seederProofs.proofs);
    const gotCreator = sum(creatorProofs.proofs);
    if (gotSeeder > owed.seederSats || gotCreator > owed.creatorSats) return out('overpay');
    if (gotSeeder !== owed.seederSats || gotCreator !== owed.creatorSats)
      return out('wrong-amount');

    if (st === undefined || !cs?.sent.hasAll(range.fromBlock, range.toBlock))
      return out('range-not-uploaded');
    if (cs.paid.hasAny(range.fromBlock, range.toBlock)) return out('range-already-paid');

    const all = [...seederProofs.proofs, ...creatorProofs.proofs];
    for (const p of all) if (p.dleq === undefined) return out('missing-dleq');

    // DLEQ against the cached keyset of the set's mint (T7).
    const needed: [MintUrl, string][] = [];
    for (const set of [seederProofs, creatorProofs]) {
      for (const p of set.proofs) {
        if (!KEYSET_ID.test(p.id)) return out('bad-dleq', 'keyset id');
        if (!needed.some(([m, id]) => m === set.mint && id === p.id)) needed.push([set.mint, p.id]);
      }
    }
    if (keysets === null) return { kind: 'need-keysets', keys: needed };
    for (const set of [seederProofs, creatorProofs]) {
      for (const p of set.proofs) {
        const ks = keysets.get(`${set.mint}|${p.id}`);
        // An unknown keyset may be the seeder's stale cache (a rotation): refuse, never ban.
        if (ks?.unit !== 'sat' || ks.id !== p.id) return out('bad-dleq', 'unknown keyset');
        if (!dleqOk(p, ks)) {
          // A DLEQ that fails against a KNOWN keyset is a forgery, never an honest mistake — and
          // every attempt costs this seeder real CPU. Ban (T7, T11).
          if (!this.banMap.has(peer)) this.ban(peer, 'forged-proof');
          return out('bad-dleq');
        }
      }
    }

    // The lock inside each secret (the envelope is untrusted input).
    for (const p of seederProofs.proofs) {
      const v = checkPayLock(p.secret, own);
      if (!v.ok) return out('wrong-p2pk-target', `seeder secret: ${v.reason}`);
    }
    for (const p of creatorProofs.proofs) {
      const v = checkPayLock(p.secret, creator, { binding: own });
      if (!v.ok) return out('wrong-p2pk-target', `creator secret: ${v.reason}`);
    }

    // Local double-spend: a secret this seeder already accepted, or one repeated in this PAY.
    const secrets = all.map((p) => p.secret);
    if (new Set(secrets).size !== secrets.length || secrets.some((s) => this.seen.has(s))) {
      this.doubleSpend(peer, seederProofs.mint, amount);
      return out('double-spend');
    }

    // Accept — every state change in this tick.
    this.seen.add(secrets);
    cs.paid.add(range.fromBlock, range.toBlock);
    cs.carry = owed.carryOut;
    st.lastActivity = this.now();
    this.pending.push({ peer, msg, stage: 'redeem' });
    return { kind: 'result', result: { ok: true, credited: amount as Sats, blocks } };
  }

  recordUpload(
    peer: NostrPubkey,
    blocks: BlockRange,
    policy: Pick<PricePolicy, 'satsPerBlock' | 'minPaySats'>,
  ): PeerWindow {
    if (
      typeof blocks.core !== 'string' ||
      !CORE_RE.test(blocks.core) ||
      !Number.isSafeInteger(blocks.fromBlock) ||
      !Number.isSafeInteger(blocks.toBlock) ||
      blocks.fromBlock < 0 ||
      blocks.toBlock < blocks.fromBlock
    )
      throw new RangeError('recordUpload: bad block range');
    const st = this.peerFor(peer);
    const cs = this.coreFor(st, blocks.core);
    cs.window = effectiveWindowBlocks(this.config.windowBlocks, policy);
    cs.sent.add(blocks.fromBlock, blocks.toBlock);
    st.lastActivity = this.now();
    return this.enforceWindow(st);
  }

  rebind(from: NostrPubkey, to: NostrPubkey): PeerWindow {
    if (from === to) return this.snapshot(this.peerFor(to));
    const src = this.peers.get(from);
    const srcBan = this.banMap.get(from);
    const dst = this.peerFor(to);
    // A new pay/1 channel for `to`: its carries restart from `from`'s (0 where `from` has none).
    for (const cs of dst.cores.values()) cs.carry = 0;
    if (src === undefined && srcBan === undefined) return this.snapshot(dst);
    if (src !== undefined) {
      for (const [core, s] of src.cores) {
        const d = this.coreFor(dst, core);
        d.sent.merge(s.sent);
        d.paid.merge(s.paid);
        d.window = Math.max(d.window, s.window);
        d.carry = s.carry;
      }
      this.peers.delete(from);
    }
    dst.lastActivity = this.now();
    if (srcBan !== undefined) {
      this.banMap.delete(from);
      if (!this.banMap.has(to)) this.ban(to, srcBan.reason, srcBan.noiseKey);
    }
    for (const p of this.pending) if (p.peer === from) p.peer = to;
    return this.enforceWindow(dst);
  }

  private enforceWindow(st: PeerState): PeerWindow {
    const snap = this.snapshot(st);
    if (snap.outstanding > snap.windowBlocks && !st.banned) {
      this.ban(st.peer, 'window-exceeded');
      const after = this.snapshot(st);
      for (const cb of this.windowListeners)
        safeCall(() => {
          cb(after);
        });
      return after;
    }
    return snap;
  }

  window(peer: NostrPubkey): PeerWindow | undefined {
    const st = this.peers.get(peer);
    return st === undefined ? undefined : this.snapshot(st);
  }

  windows(): readonly PeerWindow[] {
    return [...this.peers.values()].map((st) => this.snapshot(st));
  }

  onWindowExceeded(cb: (w: PeerWindow) => void): () => void {
    this.windowListeners.add(cb);
    return () => this.windowListeners.delete(cb);
  }

  onDoubleSpend(
    cb: (peer: NostrPubkey, detail: { readonly mint: MintUrl; readonly amount: Sats }) => void,
  ): () => void {
    this.doubleSpendListeners.add(cb);
    return () => this.doubleSpendListeners.delete(cb);
  }

  /**
   * Redeem the accepted seeder sets and publish the creator sets. One flush at a time; a
   * concurrent call waits for (and returns) the running one. A PAY whose seeder set the mint
   * reports spent is a double-spend: the peer is banned and its creator set is not published.
   * A mint or relay failure keeps the item for the next flush.
   */
  flush(): Promise<{ readonly swapped: Sats; readonly nutzapped: Sats; readonly failed: number }> {
    if (this.flushing !== null) return this.flushing;
    const run = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    this.flushing = run;
    return run;
  }

  private async flushOnce(): Promise<{ swapped: Sats; nutzapped: Sats; failed: number }> {
    let swapped = 0;
    let nutzapped = 0;
    let failed = 0;
    const batch = this.pending.splice(0);
    const retry: Pending[] = [];
    for (const item of batch) {
      const { seederProofs, creatorProofs, range } = item.msg;
      if (item.stage === 'redeem' && seederProofs.proofs.length > 0) {
        const redeem = this.deps.redeem;
        if (redeem === undefined) {
          retry.push(item);
          continue;
        }
        try {
          await redeem({ mint: seederProofs.mint, proofs: seederProofs.proofs });
        } catch (e) {
          if ((e as { code?: unknown } | null)?.code === 'spent') {
            failed++;
            this.doubleSpend(
              item.peer,
              seederProofs.mint,
              sum(seederProofs.proofs) + sum(creatorProofs.proofs),
            );
          } else retry.push(item);
          continue;
        }
        swapped += sum(seederProofs.proofs);
      }
      item.stage = 'nutzap';
      if (creatorProofs.proofs.length > 0) {
        const nutzap = this.deps.nutzap;
        if (nutzap === undefined) {
          retry.push(item);
          continue;
        }
        try {
          await nutzap(creatorProofs, {
            peer: item.peer,
            core: range.core,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
          });
        } catch {
          retry.push(item);
          continue;
        }
        nutzapped += sum(creatorProofs.proofs);
      }
    }
    this.pending.unshift(...retry);
    return { swapped: swapped as Sats, nutzapped: nutzapped as Sats, failed };
  }

  /** Accepted PAYs whose redemption or nutzap has not completed yet. */
  pendingCount(): number {
    return this.pending.length;
  }

  ban(peer: NostrPubkey, reason: string, noiseKey?: Uint8Array): void {
    const entry: BanEntry =
      noiseKey === undefined
        ? { pubkey: peer, reason, at: this.now() }
        : { pubkey: peer, noiseKey, reason, at: this.now() };
    this.banMap.set(peer, entry);
    const st = this.peers.get(peer);
    if (st !== undefined) st.banned = true;
  }

  unban(peer: NostrPubkey): void {
    this.banMap.delete(peer);
    const st = this.peers.get(peer);
    if (st !== undefined) st.banned = false;
  }

  isBanned(peer: NostrPubkey): boolean {
    return this.banMap.has(peer);
  }

  bans(): readonly BanEntry[] {
    return [...this.banMap.values()];
  }

  // ------------------------------------------------------------------ internals

  private doubleSpend(peer: NostrPubkey, mint: MintUrl, amount: number): void {
    if (!this.banMap.has(peer)) this.ban(peer, 'double-spend');
    for (const cb of this.doubleSpendListeners)
      safeCall(() => {
        cb(peer, { mint, amount: amount as Sats });
      });
  }

  private peerFor(peer: NostrPubkey): PeerState {
    let st = this.peers.get(peer);
    if (st === undefined) {
      st = { peer, banned: this.banMap.has(peer), lastActivity: this.now(), cores: new Map() };
      this.peers.set(peer, st);
    }
    return st;
  }

  private coreFor(st: PeerState, core: CoreKeyHex): CoreState {
    let cs = st.cores.get(core);
    if (cs === undefined) {
      cs = {
        sent: new RangeSet(),
        paid: new RangeSet(),
        window: this.config.windowBlocks,
        carry: 0,
      };
      st.cores.set(core, cs);
    }
    return cs;
  }

  private snapshot(st: PeerState): PeerWindow {
    let uploaded = 0;
    let paid = 0;
    let windowBlocks = this.config.windowBlocks;
    for (const cs of st.cores.values()) {
      uploaded += cs.sent.size;
      paid += cs.paid.size;
      windowBlocks = Math.max(windowBlocks, cs.window);
    }
    return {
      peer: st.peer,
      uploaded,
      paid,
      outstanding: uploaded - paid,
      windowBlocks,
      banned: st.banned,
      lastActivity: st.lastActivity,
    };
  }
}

function reject(reason: RejectReason, detail?: string): VerifyResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/** NUT-12 proof-side DLEQ (needs `r`) against `ks`; any parse or curve error is a failure. */
function dleqOk(p: CashuProof, ks: MintKeyset): boolean {
  const d = p.dleq;
  if (d?.r === undefined || !HEX.test(d.s) || !HEX.test(d.e) || !HEX.test(d.r)) return false;
  try {
    return hasValidDleq(
      {
        id: p.id,
        amount: Amount.from(p.amount),
        secret: p.secret,
        C: p.C,
        dleq: { s: d.s, e: d.e, r: d.r },
      },
      { id: ks.id, keys: { ...ks.keys } },
    );
  } catch {
    return false;
  }
}

function safeCall(f: () => void): void {
  try {
    f();
  } catch {
    // a listener's failure is its own; the engine's state change already happened
  }
}
