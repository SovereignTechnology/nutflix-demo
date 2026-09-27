/**
 * MockPaymentEngine — execution plan §0 rule 4.
 *
 * Lanes integrate against `mode: 'honest'`. The adversary suite (L10) drives the cheating
 * modes and asserts rejection. The seeder-side `verify()` here is a *reference model of the
 * rules* in SECURITY.md and contracts v5 (amounts with the creator carry, the effective
 * window, targets, sets, per-block replay, mint allowlist, double-spend), with the
 * cryptographic checks replaced by structural stand-ins:
 *
 *   - DLEQ valid          ⇔ `proof.dleq` present, `dleq.s`/`dleq.e` ≠ FORGED, secret starts `mock:`
 *   - P2PK lock (NUT-11)  ⇔ the secret's target segment is `lockedTo.slice(2, 10)`
 *   - `pay1` binding      ⇔ a creator-set secret ends `:pay1=<seeder p2pk .slice(2, 10)>`
 *   - double-spend        ⇔ a secret this seeder already accepted (at `verify`, v5) or a
 *                           SEEDER-set secret marked spent at the "mint" (`markSpentAtMint`,
 *                           found when `flush()` swaps it)
 *
 * Secret format: `mock:<instance>.<n>:<target8>[:pay1=<seeder8>]`. The instance part is
 * random per engine (v5 fix, L6-C request 2): two mock wallets paying one seeder used to
 * mint identical secrets and trip a false double-spend ban.
 *
 * The real engine (Stage 2, `payment/`) replaces the stand-ins with cashu-ts calls and must
 * pass the same tests. Nothing here is crypto. Nothing here may be imported by production
 * code.
 */
import type {
  BanEntry,
  BlockRange,
  CashuP2pkPubkey,
  CashuProof,
  CoreKeyHex,
  LockedProofSet,
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
} from '../contracts/index.js';
import {
  OWED_LIMITS,
  boundOwed,
  type OwedCore,
  type OwedLimits,
  type UnpaidLedger,
} from '../payment/owed.js';
import { RangeSet } from '../payment/range-set.js';
import { effectiveWindowBlocks, isValidCarry, isValidSplit, splitPay } from '../payment/split.js';

export type MockPaymentMode =
  'honest' | 'stiff-creator' | 'stiff-seeder' | 'double-spend' | 'forge' | 'overpay' | 'underpay';

export const FORGED = 'FORGED' as const;

export interface MockPaymentEngineOptions {
  readonly mode?: MockPaymentMode;
  readonly config?: Partial<PaymentEngineConfig>;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => UnixSeconds;
  /** Viewer's own pubkey (used in `spent()` accounting only). */
  readonly viewerPubkey?: NostrPubkey;
}

const DEFAULT_CONFIG: PaymentEngineConfig = {
  windowBlocks: 4,
  acceptedMints: ['https://mint.fixture-a.example', 'https://mint.fixture-b.example'] as MintUrl[],
  ownP2pk: ('02' + 'ab'.repeat(32)) as CashuP2pkPubkey,
  ownPubkey: 'cd'.repeat(32) as NostrPubkey,
  flushEveryBlocks: 64,
  flushEveryMs: 60_000,
};

const CORE_RE = /^[0-9a-f]{64}$/;

/** Per (peer, core) state: block indexes sent and paid, the effective window, the carry. */
interface CoreState {
  readonly uploaded: Set<number>;
  readonly paid: Set<number>;
  /** Effective window this core's policy asks for (ADR 0007). */
  window: number;
  carry: number;
}

interface MutableWindow {
  peer: NostrPubkey;
  banned: boolean;
  lastActivity: UnixSeconds;
  readonly cores: Map<CoreKeyHex, CoreState>;
}

function blocksIn(r: BlockRange): number {
  return r.toBlock - r.fromBlock + 1;
}

function sum(proofs: readonly CashuProof[]): number {
  return proofs.reduce((a, p) => a + p.amount, 0);
}

/** Split an integer into power-of-two denominations, largest first. */
export function denominate(amount: number): number[] {
  const out: number[] = [];
  let bit = 1;
  while (amount > 0) {
    if (amount & 1) out.unshift(bit);
    amount >>= 1;
    bit <<= 1;
  }
  return out;
}

let instances = 0;
/** Non-cryptographic, per-engine namespace for mock secrets (Bare has no `crypto`). */
function newNamespace(): string {
  instances++;
  return `${Math.random().toString(36).slice(2, 8)}${instances.toString(36)}`;
}

/** The mock's stand-in for the P2PK target a secret is locked to. */
function target8(p2pk: string): string {
  return p2pk.slice(2, 10);
}

export class MockPaymentEngine implements PaymentEngine, UnpaidLedger {
  readonly config: PaymentEngineConfig;
  mode: MockPaymentMode;

  private readonly now: () => UnixSeconds;
  private readonly ns = newNamespace();
  private readonly windowMap = new Map<NostrPubkey, MutableWindow>();
  private readonly banMap = new Map<NostrPubkey, BanEntry>();
  /** Secrets accepted in any PAY (v5 local double-spend check). */
  private readonly seenSecrets = new Set<string>();
  /** Secrets the stand-in "mint" reports as already spent (see `markSpentAtMint`). */
  private readonly spentAtMint = new Set<string>();
  private readonly pending: { peer: NostrPubkey; msg: PayMessage }[] = [];
  private readonly windowListeners = new Set<(w: PeerWindow) => void>();
  private readonly doubleSpendListeners = new Set<
    (peer: NostrPubkey, d: { mint: MintUrl; amount: Sats }) => void
  >();

  // viewer side
  private seq = 0;
  private lastSent: { seeder: LockedProofSet; creator: LockedProofSet } | null = null;
  private readonly spentPerPeer = new Map<NostrPubkey, number>();
  /** Running carry per (seeder pubkey, core), advanced on every PAY produced. */
  private readonly viewerCarry = new Map<string, number>();

  /** Test hooks — visible on purpose so the adversary suite can assert internal effects. */
  readonly log: {
    at: UnixSeconds;
    kind: 'ban' | 'unban' | 'window-exceeded' | 'double-spend' | 'flush' | 'rebind';
    peer?: NostrPubkey;
    detail?: string;
  }[] = [];

  constructor(opts: MockPaymentEngineOptions = {}) {
    this.mode = opts.mode ?? 'honest';
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.now = opts.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  }

  // ------------------------------------------------------------------ viewer side

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
    const carryKey = `${seeder.pubkey}|${range.core}`;
    const carryIn = opts?.carryIn ?? this.viewerCarry.get(carryKey) ?? 0;
    const amount = blocksIn(range) * policy.satsPerBlock;
    const split = splitPay(amount, policy.split, carryIn);
    this.viewerCarry.set(carryKey, split.carryOut);
    let seederAmt = split.seederSats;
    let creatorAmt = split.creatorSats;

    if (this.mode === 'overpay') seederAmt += 1;
    if (this.mode === 'underpay') creatorAmt = Math.max(0, creatorAmt - 1);

    let seederSet = this.mint(seeder.mint, seeder.p2pk, seederAmt);
    let creatorSet = this.mint(seeder.mint, policy.creatorP2pk, creatorAmt, seeder.p2pk);

    switch (this.mode) {
      case 'stiff-creator':
        // Lock the creator's share to the seeder instead of the creator.
        creatorSet = this.mint(seeder.mint, seeder.p2pk, creatorAmt, seeder.p2pk);
        break;
      case 'stiff-seeder':
        seederSet = { ...seederSet, proofs: [] };
        break;
      case 'double-spend':
        // Replay the previous PAY's proofs for a new range; the first PAY is honest.
        if (this.lastSent) {
          seederSet = this.lastSent.seeder;
          creatorSet = this.lastSent.creator;
        }
        break;
      case 'forge':
        seederSet = {
          ...seederSet,
          proofs: seederSet.proofs.map((p) => ({ ...p, dleq: { s: FORGED, e: FORGED } })),
        };
        break;
      case 'honest':
      case 'overpay':
      case 'underpay':
        break;
    }

    this.lastSent = { seeder: seederSet, creator: creatorSet };
    this.spentPerPeer.set(
      seeder.pubkey,
      (this.spentPerPeer.get(seeder.pubkey) ?? 0) + sum(seederSet.proofs) + sum(creatorSet.proofs),
    );
    return Promise.resolve({ range, carryIn, seederProofs: seederSet, creatorProofs: creatorSet });
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

  private mint(
    mint: MintUrl,
    lockedTo: CashuP2pkPubkey,
    amount: number,
    bindTo?: CashuP2pkPubkey,
  ): LockedProofSet {
    const bind = bindTo === undefined ? '' : `:pay1=${target8(bindTo)}`;
    const proofs: CashuProof[] = denominate(amount).map((amt) => ({
      id: 'mockkeyset00',
      amount: amt,
      secret: `mock:${this.ns}.${String(++this.seq)}:${target8(lockedTo)}${bind}`,
      C: 'mock',
      dleq: { s: 'mock-s', e: 'mock-e' },
    }));
    return { mint, unit: 'sat', lockedTo, proofs };
  }

  // ------------------------------------------------------------------ seeder side

  verify(peer: NostrPubkey, msg: PayMessage, policy: PricePolicy): Promise<VerifyResult> {
    return Promise.resolve(this.verifySync(peer, msg, policy));
  }

  private verifySync(peer: NostrPubkey, msg: PayMessage, policy: PricePolicy): VerifyResult {
    const reject = (reason: RejectReason, detail?: string): VerifyResult =>
      detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

    if (this.banMap.has(peer)) return reject('peer-banned');
    if (!isPayMessage(msg)) return reject('malformed');
    if (!isValidSplit(policy.split) || !Number.isSafeInteger(policy.satsPerBlock))
      return reject('malformed', 'policy');
    const { range, carryIn, seederProofs, creatorProofs } = msg;
    if (range.toBlock < range.fromBlock || range.fromBlock < 0)
      return reject('malformed', 'bad range');
    const w = this.windowMap.get(peer);
    const cs = w?.cores.get(range.core);
    const carry = cs?.carry ?? 0;
    if (carryIn !== carry) return reject('malformed', `carryIn ${carryIn} != ${carry}`);

    const amount = blocksIn(range) * policy.satsPerBlock;
    const owed = splitPay(amount, policy.split, carryIn);
    if (seederProofs.proofs.length === 0 && owed.seederSats > 0)
      return reject('missing-seeder-set');
    if (creatorProofs.proofs.length === 0 && owed.creatorSats > 0)
      return reject('missing-creator-set');

    for (const set of [seederProofs, creatorProofs]) {
      if (!this.config.acceptedMints.includes(set.mint) || !policy.mints.includes(set.mint))
        return reject('mint-not-accepted', set.mint);
    }
    if (seederProofs.lockedTo !== this.config.ownP2pk)
      return reject('wrong-p2pk-target', 'seeder set');
    if (creatorProofs.lockedTo !== policy.creatorP2pk)
      return reject('wrong-p2pk-target', 'creator set');

    const gotSeeder = sum(seederProofs.proofs);
    const gotCreator = sum(creatorProofs.proofs);
    if (gotSeeder > owed.seederSats || gotCreator > owed.creatorSats)
      return reject(
        'overpay',
        `${gotSeeder}+${gotCreator} > ${owed.seederSats}+${owed.creatorSats}`,
      );
    if (gotSeeder !== owed.seederSats || gotCreator !== owed.creatorSats)
      return reject(
        'wrong-amount',
        `${gotSeeder}+${gotCreator} != ${owed.seederSats}+${owed.creatorSats}`,
      );

    if (w === undefined || cs === undefined) return reject('range-not-uploaded', 'nothing sent');
    for (let b = range.fromBlock; b <= range.toBlock; b++) {
      if (!cs.uploaded.has(b)) return reject('range-not-uploaded', `block ${b}`);
    }
    for (let b = range.fromBlock; b <= range.toBlock; b++) {
      if (cs.paid.has(b)) return reject('range-already-paid', `block ${b}`);
    }

    const all = [...seederProofs.proofs, ...creatorProofs.proofs];
    for (const p of all) if (!p.dleq) return reject('missing-dleq');
    for (const p of all) {
      if (p.dleq?.s === FORGED || p.dleq?.e === FORGED || !p.secret.startsWith('mock:'))
        return reject('bad-dleq');
    }
    for (const p of seederProofs.proofs) {
      if (secretTarget(p.secret) !== target8(this.config.ownP2pk))
        return reject('wrong-p2pk-target', 'seeder secret');
    }
    for (const p of creatorProofs.proofs) {
      if (secretTarget(p.secret) !== target8(policy.creatorP2pk))
        return reject('wrong-p2pk-target', 'creator secret');
      if (secretBinding(p.secret) !== target8(this.config.ownP2pk))
        return reject('wrong-p2pk-target', 'creator binding');
    }

    const secrets = all.map((p) => p.secret);
    if (new Set(secrets).size !== secrets.length || secrets.some((s) => this.seenSecrets.has(s))) {
      this.doubleSpend(peer, seederProofs.mint, amount, 'reused secret at verify');
      return reject('double-spend');
    }

    // Accept: credit the window, advance the carry, queue proofs for the async swap batch.
    for (const s of secrets) this.seenSecrets.add(s);
    for (let b = range.fromBlock; b <= range.toBlock; b++) cs.paid.add(b);
    cs.carry = owed.carryOut;
    w.lastActivity = this.now();
    this.pending.push({ peer, msg });
    return { ok: true, credited: amount as Sats, blocks: blocksIn(range) };
  }

  recordUpload(
    peer: NostrPubkey,
    blocks: BlockRange,
    policy: Pick<PricePolicy, 'satsPerBlock' | 'minPaySats'>,
  ): PeerWindow {
    const w = this.windowFor(peer);
    const cs = this.coreFor(w, blocks.core);
    cs.window = effectiveWindowBlocks(this.config.windowBlocks, policy);
    for (let b = blocks.fromBlock; b <= blocks.toBlock; b++) cs.uploaded.add(b);
    w.lastActivity = this.now();
    return this.enforceWindow(w);
  }

  rebind(from: NostrPubkey, to: NostrPubkey): PeerWindow {
    if (from === to) return this.snapshot(this.windowFor(to));
    const src = this.windowMap.get(from);
    const srcBan = this.banMap.get(from);
    const dst = this.windowFor(to);
    // A new channel for `to`: its carries restart from `from`'s.
    for (const cs of dst.cores.values()) cs.carry = 0;
    if (!src && !srcBan) return this.snapshot(dst);
    if (src) {
      for (const [core, s] of src.cores) {
        const d = this.coreFor(dst, core);
        for (const b of s.uploaded) d.uploaded.add(b);
        for (const b of s.paid) d.paid.add(b);
        d.window = Math.max(d.window, s.window);
        d.carry = s.carry;
      }
      this.windowMap.delete(from);
    }
    dst.lastActivity = this.now();
    if (srcBan && !this.banMap.has(to)) {
      this.banMap.delete(from);
      this.ban(to, srcBan.reason, srcBan.noiseKey);
    } else if (srcBan) {
      this.banMap.delete(from);
    }
    for (const p of this.pending) if (p.peer === from) p.peer = to;
    this.log.push({ at: this.now(), kind: 'rebind', peer: to, detail: `from=${from}` });
    return this.enforceWindow(dst);
  }

  /** Window rule (invariant 5): ban + synchronous `onWindowExceeded` on the crossing update. */
  private enforceWindow(w: MutableWindow): PeerWindow {
    const snap = this.snapshot(w);
    if (snap.outstanding > snap.windowBlocks && !w.banned) {
      this.log.push({
        at: this.now(),
        kind: 'window-exceeded',
        peer: w.peer,
        detail: `outstanding=${snap.outstanding}`,
      });
      this.ban(w.peer, 'window-exceeded');
      const after = this.snapshot(w);
      for (const cb of this.windowListeners) cb(after);
      return after;
    }
    return snap;
  }

  window(peer: NostrPubkey): PeerWindow | undefined {
    const w = this.windowMap.get(peer);
    return w ? this.snapshot(w) : undefined;
  }

  windows(): readonly PeerWindow[] {
    return [...this.windowMap.values()].map((w) => this.snapshot(w));
  }

  /** `UnpaidLedger` (pay/1 v6 amendment): the reference model of the real engine's. */
  outstandingOn(peer: NostrPubkey, core: CoreKeyHex): number {
    const cs = this.windowMap.get(peer)?.cores.get(core);
    if (cs === undefined) return 0;
    let n = 0;
    for (const b of cs.uploaded) if (!cs.paid.has(b)) n++;
    return n;
  }

  unpaid(peer: NostrPubkey, limits: OwedLimits = OWED_LIMITS): readonly OwedCore[] {
    const w = this.windowMap.get(peer);
    if (w === undefined) return [];
    return boundOwed(
      [...w.cores].map(([core, cs]) => {
        const left = new RangeSet();
        for (const b of cs.uploaded) if (!cs.paid.has(b)) left.add(b, b);
        return [core, left.intervals()] as const;
      }),
      limits,
    );
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

  flush(): Promise<{ readonly swapped: Sats; readonly nutzapped: Sats; readonly failed: number }> {
    let swapped = 0;
    let nutzapped = 0;
    let failed = 0;
    const batch = this.pending.splice(0);
    for (const { peer, msg } of batch) {
      const all = [...msg.seederProofs.proofs, ...msg.creatorProofs.proofs];
      // The seeder swaps only its own set; the creator set is published, not swapped, so only a
      // spent SEEDER proof is a double-spend the batch can see (as in the real engine).
      if (msg.seederProofs.proofs.some((p) => this.spentAtMint.has(p.secret))) {
        failed++;
        this.doubleSpend(peer, msg.seederProofs.mint, sum(all), 'spent at mint');
        continue;
      }
      for (const p of msg.seederProofs.proofs) this.spentAtMint.add(p.secret);
      swapped += sum(msg.seederProofs.proofs);
      nutzapped += sum(msg.creatorProofs.proofs);
    }
    this.log.push({
      at: this.now(),
      kind: 'flush',
      detail: `swapped=${swapped} nutzapped=${nutzapped} failed=${failed}`,
    });
    return Promise.resolve({ swapped: swapped as Sats, nutzapped: nutzapped as Sats, failed });
  }

  ban(peer: NostrPubkey, reason: string, noiseKey?: Uint8Array): void {
    this.banMap.set(
      peer,
      noiseKey
        ? { pubkey: peer, noiseKey, reason, at: this.now() }
        : { pubkey: peer, reason, at: this.now() },
    );
    const w = this.windowMap.get(peer);
    if (w) w.banned = true;
    this.log.push({ at: this.now(), kind: 'ban', peer, detail: reason });
  }

  unban(peer: NostrPubkey): void {
    this.banMap.delete(peer);
    const w = this.windowMap.get(peer);
    if (w) w.banned = false;
    this.log.push({ at: this.now(), kind: 'unban', peer });
  }

  isBanned(peer: NostrPubkey): boolean {
    return this.banMap.has(peer);
  }

  bans(): readonly BanEntry[] {
    return [...this.banMap.values()];
  }

  /** Test hook: pending (unswapped) proof count. */
  pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Test hook: the stand-in mint reports these secrets as already spent — a proof redeemed
   * somewhere this engine never saw (another instance with the same key, a restart that lost
   * the seen set). The next `flush()` bans whoever paid with one.
   */
  markSpentAtMint(secrets: readonly string[]): void {
    for (const s of secrets) this.spentAtMint.add(s);
  }

  private doubleSpend(peer: NostrPubkey, mint: MintUrl, amount: number, how: string): void {
    this.log.push({
      at: this.now(),
      kind: 'double-spend',
      peer,
      detail: `${how} amount=${amount}`,
    });
    if (!this.banMap.has(peer)) this.ban(peer, 'double-spend');
    for (const cb of this.doubleSpendListeners) cb(peer, { mint, amount: amount as Sats });
  }

  private windowFor(peer: NostrPubkey): MutableWindow {
    let w = this.windowMap.get(peer);
    if (!w) {
      w = { peer, banned: this.banMap.has(peer), lastActivity: this.now(), cores: new Map() };
      this.windowMap.set(peer, w);
    }
    return w;
  }

  private coreFor(w: MutableWindow, core: CoreKeyHex): CoreState {
    let cs = w.cores.get(core);
    if (!cs) {
      cs = { uploaded: new Set(), paid: new Set(), window: this.config.windowBlocks, carry: 0 };
      w.cores.set(core, cs);
    }
    return cs;
  }

  private snapshot(w: MutableWindow): PeerWindow {
    let uploaded = 0;
    let paid = 0;
    let windowBlocks = this.config.windowBlocks;
    for (const cs of w.cores.values()) {
      uploaded += cs.uploaded.size;
      paid += cs.paid.size;
      windowBlocks = Math.max(windowBlocks, cs.window);
    }
    return {
      peer: w.peer,
      uploaded,
      paid,
      outstanding: uploaded - paid,
      windowBlocks,
      banned: w.banned,
      lastActivity: w.lastActivity,
    };
  }
}

/** `mock:<ns>.<n>:<target8>[:pay1=<seeder8>]` → `<target8>` (or `undefined`). */
function secretTarget(secret: string): string | undefined {
  return secret.split(':')[2];
}

/** `…:pay1=<seeder8>` → `<seeder8>` (or `undefined`). */
function secretBinding(secret: string): string | undefined {
  const tail = secret.split(':')[3];
  return tail?.startsWith('pay1=') ? tail.slice(5) : undefined;
}

/** Structural guard used before touching any field — `verify` must never throw (invariant 4). */
export function isPayMessage(x: unknown): x is PayMessage {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  const r = m['range'];
  if (typeof r !== 'object' || r === null) return false;
  const rr = r as Record<string, unknown>;
  if (!Number.isSafeInteger(rr['fromBlock']) || !Number.isSafeInteger(rr['toBlock'])) return false;
  const core = rr['core'];
  if (typeof core !== 'string' || !CORE_RE.test(core)) return false;
  if (!isValidCarry(m['carryIn'])) return false;
  return isLockedSet(m['seederProofs']) && isLockedSet(m['creatorProofs']);
}

function isLockedSet(x: unknown): x is LockedProofSet {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  if (typeof s['mint'] !== 'string' || typeof s['lockedTo'] !== 'string' || s['unit'] !== 'sat')
    return false;
  const proofs = s['proofs'];
  if (!Array.isArray(proofs)) return false;
  return proofs.every((p: unknown) => {
    if (typeof p !== 'object' || p === null) return false;
    const q = p as Record<string, unknown>;
    return (
      typeof q['id'] === 'string' &&
      Number.isSafeInteger(q['amount']) &&
      (q['amount'] as number) > 0 &&
      typeof q['secret'] === 'string' &&
      typeof q['C'] === 'string'
    );
  });
}
