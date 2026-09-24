/**
 * L10 provider indirection — the Stage 2 seam for the adversary suite.
 *
 * Every payment test in this directory reaches the engine ONLY through this module, so the
 * Stage 2 session that implements `packages/core/src/payment/` unskips nothing and rewires
 * one place: make `getSeederEngine()` return the real `PaymentEngine` (and, once a wallet
 * that can mint test proofs exists, make `getPair('honest').viewer` the real viewer side;
 * the cheating modes can stay on the mock or become mutators over real proofs).
 *
 * Why `.mts`: `packages/core/vitest.config.ts` includes `src/**\/__tests__/**\/*.ts`, so a
 * plain `provider.ts` would be collected as a test file and fail with "No test suite found".
 * `.mts` is not matched by that glob but is still typechecked, linted and Prettier-checked.
 *
 * Nothing here is crypto. Nothing here is implementation. Test infrastructure only.
 */
import type {
  BanEntry,
  BlockIndex,
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
  PaymentEngineViewer,
  PeerWindow,
  PricePolicy,
  Sats,
  UnixSeconds,
  VerifyResult,
} from '../../contracts/index.js';
import { DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_BLOCKS } from '../../contracts/index.js';
import { MockPaymentEngine, type MockPaymentMode } from '../../mocks/mock-payment-engine.js';
import { splitPay, splitSequence } from '../split.js';

// ---------------------------------------------------------------------------------------
// Modes — enumerated from the mock's `MockPaymentMode` type, checked exhaustive at compile
// time so a mode added to the mock without a test here fails `tsc`.
// ---------------------------------------------------------------------------------------

export type AdversaryMode = MockPaymentMode;

export const ALL_MODES = [
  'honest',
  'stiff-creator',
  'stiff-seeder',
  'double-spend',
  'forge',
  'overpay',
  'underpay',
] as const satisfies readonly MockPaymentMode[];

type MissingMode = Exclude<MockPaymentMode, (typeof ALL_MODES)[number]>;
type ExtraMode = Exclude<(typeof ALL_MODES)[number], MockPaymentMode>;
// Both must be `never`; if either is not, the assignment below fails to typecheck.
const _modesExhaustive: [MissingMode, ExtraMode] extends [never, never] ? true : never = true;

export type CheatingMode = Exclude<AdversaryMode, 'honest'>;
export const CHEATING_MODES: readonly CheatingMode[] = ALL_MODES.filter(
  (m): m is CheatingMode => m !== 'honest',
);

// ---------------------------------------------------------------------------------------
// Fixtures (mirrors the seed test in core/src/mocks/__tests__/mock-payment-engine.test.ts)
// ---------------------------------------------------------------------------------------

export const MINT_A = 'https://mint.fixture-a.example' as MintUrl;
export const MINT_B = 'https://mint.fixture-b.example' as MintUrl;
export const MINT_UNKNOWN = 'https://mint.unknown.example' as MintUrl;

export const SEEDER_P2PK = ('02' + 'ab'.repeat(32)) as CashuP2pkPubkey;
export const OTHER_SEEDER_P2PK = ('02' + 'ba'.repeat(32)) as CashuP2pkPubkey;
export const CREATOR_P2PK = ('02' + 'cc'.repeat(32)) as CashuP2pkPubkey;
export const ATTACKER_P2PK = ('02' + 'ee'.repeat(32)) as CashuP2pkPubkey;

export const SEEDER = 'cd'.repeat(32) as NostrPubkey;
export const OTHER_SEEDER = 'dc'.repeat(32) as NostrPubkey;
export const VIEWER = 'ef'.repeat(32) as NostrPubkey;
export const OTHER_VIEWER = 'fe'.repeat(32) as NostrPubkey;

export const sats = (n: number): Sats => n as Sats;
export const unix = (n: number): UnixSeconds => n as UnixSeconds;

/**
 * The generic policy. `minPaySats: 1` keeps the v5 effective window equal to the configured
 * one (`max(windowBlocks, ceil(minPaySats / satsPerBlock))`), so every window test written
 * before v5 keeps the meaning it was written with; the effective-window rule has its own
 * tests with the default (`DEFAULT_MIN_PAY_SATS`) in `split.test.ts` and the mock's tests.
 */
export const POLICY: PricePolicy = {
  satsPerBlock: sats(2),
  blockSize: DEFAULT_BLOCK_SIZE,
  mints: [MINT_A],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
  minPaySats: sats(1),
};

export function policyWith(overrides: Partial<PricePolicy>): PricePolicy {
  return { ...POLICY, ...overrides };
}

export const SEEDER_INFO = { pubkey: SEEDER, p2pk: SEEDER_P2PK, mint: MINT_A } as const;

// ---------------------------------------------------------------------------------------
// Contracts v3 (ADR 0004 (c)/(d)) fixtures: two cores on one `pay/1` channel, and the
// provisional (pre-HELLO) identity the transport accounts under before `rebind`.
// ---------------------------------------------------------------------------------------

/** Video A's core (creator A = `CREATOR_P2PK`, priced by `POLICY`). The default core. */
export const CORE_A = 'a1'.repeat(32) as CoreKeyHex;
/** Video B's core (creator B = `CREATOR_B_P2PK`; price per test). */
export const CORE_B = 'b2'.repeat(32) as CoreKeyHex;
/** A core nobody uploaded anything from. */
export const CORE_NONE = 'c3'.repeat(32) as CoreKeyHex;
export const CREATOR_B_P2PK = ('02' + 'dd'.repeat(32)) as CashuP2pkPubkey;

/** Provisional ids: the peer's Noise static key as hex (same 32-byte shape as a pubkey). */
export const NOISE_ID = '77'.repeat(32) as NostrPubkey;
export const OTHER_NOISE_ID = '78'.repeat(32) as NostrPubkey;
/** A pubkey no window or ban was ever recorded for. */
export const UNKNOWN_ID = '00'.repeat(32) as NostrPubkey;

/**
 * The per-core policy lookup the seeder transport (L2 / L3) does before calling `verify`:
 * `PricePolicy` is per video, so the policy handed to the engine is chosen by `range.core`.
 * The engine itself is policy-agnostic — that lookup is exactly what ADR 0004 (c) makes
 * possible, and these tests model it as a map. Throws on a core the seeder does not serve
 * (test infrastructure: a real seeder would reject such a PAY before verify).
 */
export function policyByCore(
  policies: ReadonlyMap<CoreKeyHex, PricePolicy>,
): (range: BlockRange) => PricePolicy {
  return (range) => {
    const p = policies.get(range.core);
    if (!p) throw new Error(`policyByCore: no policy for core ${range.core}`);
    return p;
  };
}

// ---------------------------------------------------------------------------------------
// Contracts v5 (ADR 0010): every range names a core, and uploads are recorded per block.
// ---------------------------------------------------------------------------------------

/** `[fromBlock, toBlock]` on `core` (default `CORE_A`). */
export function range(fromBlock: BlockIndex, toBlock: BlockIndex, core = CORE_A): BlockRange {
  return { core, fromBlock, toBlock };
}

/** Next block index the helpers below will send, per engine × peer × core. */
const nextBlock = new WeakMap<object, Map<string, number>>();

/**
 * Send `n` blocks of `core` to `peer`, one `recordUpload` per block the way the seeder's
 * `upload` handler does, and return the window after the last one. By default the blocks
 * continue where the previous `upload()` to the same peer and core stopped (a peer
 * streaming a core front to back); `opts.from` sends `[from, from + n)` instead (a seek, a
 * second seeder's half, or a different session sending different blocks). `n` must be ≥ 1.
 */
export function upload(
  seeder: Pick<PaymentEngine, 'recordUpload'>,
  peer: NostrPubkey,
  n: number,
  opts: { readonly core?: CoreKeyHex; readonly from?: number; readonly policy?: PricePolicy } = {},
): PeerWindow {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('upload(): n must be a positive integer');
  const core = opts.core ?? CORE_A;
  let perEngine = nextBlock.get(seeder);
  if (!perEngine) {
    perEngine = new Map();
    nextBlock.set(seeder, perEngine);
  }
  const key = `${peer}|${core}`;
  let at = opts.from ?? perEngine.get(key) ?? 0;
  let w = seeder.recordUpload(peer, range(at, at, core), opts.policy ?? POLICY);
  for (let i = 1; i < n; i++) {
    at++;
    w = seeder.recordUpload(peer, range(at, at, core), opts.policy ?? POLICY);
  }
  perEngine.set(key, Math.max(at + 1, perEngine.get(key) ?? 0));
  return w;
}

/**
 * For scenarios that are NOT about the window (amounts, DLEQ, ranges…): a window wide
 * enough that uploading the whole scenario up-front never trips the T3/INV5 cut.
 */
export const WIDE_WINDOW: EngineOptions = { config: { windowBlocks: 1_000 } };

/** Deterministic, strictly increasing clock. */
export function clock(start = 1_000): { now: () => UnixSeconds; current: () => UnixSeconds } {
  let t = start;
  return { now: (): UnixSeconds => unix(t++), current: (): UnixSeconds => unix(t) };
}

// ---------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------

export interface EngineOptions {
  readonly config?: Partial<PaymentEngineConfig>;
  readonly now?: () => UnixSeconds;
}

/**
 * Seeder-side engine under test (the audit surface: `verify`, `recordUpload`, windows,
 * bans, `flush`). Stage 2: return the real engine here.
 */
export function getSeederEngine(opts: EngineOptions = {}): PaymentEngine {
  const config: Partial<PaymentEngineConfig> = {
    windowBlocks: DEFAULT_WINDOW_BLOCKS,
    ownP2pk: SEEDER_P2PK,
    ownPubkey: SEEDER,
    acceptedMints: [MINT_A],
    ...opts.config,
  };
  return opts.now
    ? new MockPaymentEngine({ mode: 'honest', config, now: opts.now })
    : new MockPaymentEngine({ mode: 'honest', config });
}

/**
 * Viewer-side message producer for a given adversary mode. `honest` must produce a PAY the
 * seeder accepts; every other mode must produce one it rejects (or, for `double-spend`, one
 * the swap batch catches).
 */
export function getViewerEngine(
  mode: AdversaryMode,
  opts: EngineOptions = {},
): PaymentEngineViewer {
  return opts.now
    ? new MockPaymentEngine({ mode, now: opts.now, viewerPubkey: VIEWER })
    : new MockPaymentEngine({ mode, viewerPubkey: VIEWER });
}

/**
 * True while the seam still returns the reference model. Tests that pin behaviour the mock
 * deliberately stands in for (real NUT-11 secret parsing, real DLEQ) are `it.skipIf(usingMock())`
 * with a full body, so they run the moment Stage 2 rewires `getSeederEngine()`.
 */
export function usingMock(): boolean {
  return getSeederEngine() instanceof MockPaymentEngine;
}

/**
 * Make the mint behind `seeder` report `proofs` as already spent, as if they had been
 * redeemed by a route this engine never saw. Drives the async-swap (flush) half of T5.
 */
export function spendAtMint(seeder: PaymentEngine, proofs: readonly CashuProof[]): Promise<void> {
  if (seeder instanceof MockPaymentEngine) {
    seeder.markSpentAtMint(proofs.map((p) => p.secret));
    return Promise.resolve();
  }
  return Promise.reject(new Error('spendAtMint: no test mint wired for this engine'));
}

export interface AdversaryPair {
  readonly viewer: PaymentEngineViewer;
  readonly seeder: PaymentEngine;
  readonly clock: ReturnType<typeof clock>;
}

export function getPair(mode: AdversaryMode = 'honest', opts: EngineOptions = {}): AdversaryPair {
  const c = clock();
  const now = opts.now ?? c.now;
  const seederOpts: EngineOptions = opts.config ? { now, config: opts.config } : { now };
  return {
    viewer: getViewerEngine(mode, { now }),
    seeder: getSeederEngine(seederOpts),
    clock: c,
  };
}

// ---------------------------------------------------------------------------------------
// Pure helpers over the wire types (object spreads only — no crypto, no primitives)
// ---------------------------------------------------------------------------------------

export function blocksIn(range: PayMessage['range']): number {
  return range.toBlock - range.fromBlock + 1;
}

export function sumProofs(proofs: readonly CashuProof[]): number {
  return proofs.reduce((a, p) => a + p.amount, 0);
}

/**
 * The v5 split (ADR 0007/0010, `splitPay`): creator share floored with the carry, the seeder
 * takes the rest. With `carryIn = 0` this is ADR 0005's `seederSats = ceil(amount × s / 100)`.
 * (Before v5 the reference model floored the SEEDER share — the opposite of ADR 0005.)
 */
export function expectedShares(
  blocks: number,
  policy: PricePolicy,
  carryIn = 0,
): {
  readonly total: number;
  readonly seeder: number;
  readonly creator: number;
  readonly carryOut: number;
} {
  const total = blocks * policy.satsPerBlock;
  const s = splitPay(total, policy.split, carryIn);
  return { total, seeder: s.seederSats, creator: s.creatorSats, carryOut: s.carryOut };
}

/** Totals of a sequence of accepted PAYs of `blocks[i]` blocks each on one channel × core. */
export function expectedSequence(
  blocks: readonly number[],
  policy: PricePolicy,
  carryIn = 0,
): { readonly total: number; readonly seeder: number; readonly creator: number } {
  const amounts = blocks.map((b) => b * policy.satsPerBlock);
  const { splits } = splitSequence(amounts, policy.split, carryIn);
  return {
    total: amounts.reduce((a, b) => a + b, 0),
    seeder: splits.reduce((a, x) => a + x.seederSats, 0),
    creator: splits.reduce((a, x) => a + x.creatorSats, 0),
  };
}

export function withSeederSet(msg: PayMessage, set: Partial<LockedProofSet>): PayMessage {
  return { ...msg, seederProofs: { ...msg.seederProofs, ...set } };
}

export function withCreatorSet(msg: PayMessage, set: Partial<LockedProofSet>): PayMessage {
  return { ...msg, creatorProofs: { ...msg.creatorProofs, ...set } };
}

export function mapProofs(
  set: LockedProofSet,
  f: (p: CashuProof, i: number) => CashuProof,
): LockedProofSet {
  return { ...set, proofs: set.proofs.map(f) };
}

/** Every string that would identify proof material if it leaked (T14 / INV7). */
export function proofMaterial(msg: PayMessage): readonly string[] {
  const out: string[] = [];
  for (const set of [msg.seederProofs, msg.creatorProofs]) {
    for (const p of set.proofs) {
      out.push(p.secret, p.C);
      if (p.dleq) {
        out.push(p.dleq.s, p.dleq.e);
        if (p.dleq.r !== undefined) out.push(p.dleq.r);
      }
      if (p.witness !== undefined) out.push(p.witness);
    }
  }
  // Mock stand-ins like "mock" / "mock-s" are shared by every proof; they still must not
  // appear in observable state, but only meaningfully-unique strings are worth asserting on.
  return out.filter((s) => s.length >= 6);
}

/** Everything a consumer could observe from the seeder side after a verify. */
export function observableState(
  seeder: PaymentEngine,
  peer: NostrPubkey,
  extras: {
    readonly result?: VerifyResult;
    readonly windowEvents?: readonly PeerWindow[];
    readonly doubleSpendEvents?: readonly unknown[];
    readonly flushResult?: unknown;
  } = {},
): string {
  const state: {
    window: PeerWindow | undefined;
    windows: readonly PeerWindow[];
    bans: readonly BanEntry[];
    spent: unknown;
    extras: unknown;
  } = {
    window: seeder.window(peer),
    windows: seeder.windows(),
    bans: seeder.bans(),
    spent: seeder.spent(),
    extras,
  };
  return JSON.stringify(state, (_k, v: unknown) =>
    v instanceof Uint8Array ? `u8[${String(v.length)}]` : v,
  );
}
