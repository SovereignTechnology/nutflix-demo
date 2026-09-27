/**
 * fast-check arbitraries for every `pay/1` wire message, plus a structural validator used
 * to judge what `decode()` hands back for corrupted input. Test infrastructure only: no
 * crypto (challenge/signature/C/DLEQ are random hex, never real signatures), no codec.
 */
import * as fc from 'fast-check';

import { MAX_OWED_BLOCKS, MAX_OWED_RANGES } from '../../contracts/index.js';
import type {
  AckMessage,
  CashuP2pkPubkey,
  CashuProof,
  CoreKeyHex,
  HelloMessage,
  LockedProofSet,
  MintUrl,
  NostrPubkey,
  OwedMessage,
  OwedRange,
  PayMessage,
  PayProtocolMessage,
  PayWireMessage,
  PriceMessage,
  RejectReason,
  Sats,
  SerializedDleq,
} from '../../contracts/index.js';

// ---------------------------------------------------------------------------------------
// Constants taken from the contracts (kept in one place so the validator and the
// arbitraries cannot drift apart).
// ---------------------------------------------------------------------------------------

export const REJECT_REASONS = [
  'bad-dleq',
  'wrong-p2pk-target',
  'wrong-amount',
  'overpay',
  'mint-not-accepted',
  'missing-creator-set',
  'missing-seeder-set',
  'range-not-uploaded',
  'range-already-paid',
  'missing-dleq',
  'malformed',
  'peer-banned',
  'double-spend',
] as const satisfies readonly RejectReason[];
type _ReasonsExhaustive =
  Exclude<RejectReason, (typeof REJECT_REASONS)[number]> extends never ? true : never;
const _reasonsExhaustive: _ReasonsExhaustive = true;
export { _reasonsExhaustive as REJECT_REASONS_EXHAUSTIVE };

/** 21 M BTC in sats — the largest amount that can ever be on the wire. */
export const MAX_SATS = 2_100_000_000_000_000;
/** Hypercore block indices are array positions; keep them below 2^40 (a 64 PiB core). */
export const MAX_BLOCK = 2 ** 40;

/**
 * fast-check 4 `fc.record` builds NULL-PROTOTYPE objects (verified against 4.9.0). A codec
 * returns ordinary objects, and `toStrictEqual` treats the two as different types, so every
 * generated message is rebuilt as plain `Object.prototype` data before it leaves this module.
 */
export function plain<T>(x: T): T {
  if (Array.isArray(x)) return x.map((v: unknown) => plain(v)) as T;
  if (typeof x === 'object' && x !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = plain(v);
    return out as T;
  }
  return x;
}

// ---------------------------------------------------------------------------------------
// Leaf arbitraries
// ---------------------------------------------------------------------------------------

const hexOf = (bytes: number): fc.Arbitrary<string> =>
  fc
    .uint8Array({ minLength: bytes, maxLength: bytes })
    .map((u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join(''));

export const hex32Arb = hexOf(32);
export const hex64Arb = hexOf(64);
export const nostrPubkeyArb: fc.Arbitrary<NostrPubkey> = hex32Arb.map((h) => h as NostrPubkey);
export const p2pkArb: fc.Arbitrary<CashuP2pkPubkey> = fc
  .tuple(fc.constantFrom('02', '03'), hex32Arb)
  .map(([prefix, h]) => `${prefix}${h}` as CashuP2pkPubkey);
export const mintUrlArb: fc.Arbitrary<MintUrl> = fc
  .tuple(fc.constantFrom('https', 'http'), fc.domain({ size: 'small' }), fc.option(fc.nat(65535)))
  .map(
    ([scheme, host, port]) =>
      `${scheme}://${host}${port === null ? '' : `:${String(port)}`}` as MintUrl,
  );
export const satsArb: fc.Arbitrary<Sats> = fc
  .integer({ min: 0, max: MAX_SATS })
  .map((n) => n as Sats);
export const positiveSatsArb: fc.Arbitrary<Sats> = fc
  .integer({ min: 1, max: MAX_SATS })
  .map((n) => n as Sats);
export const blockIndexArb = fc.integer({ min: 0, max: MAX_BLOCK });

/** Any UTF-8-encodable string (fast-check's `binary` unit excludes lone surrogates). */
export const textArb = fc.oneof(
  { arbitrary: fc.string({ maxLength: 120 }), weight: 3 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 60 }), weight: 1 },
  { arbitrary: fc.constant(''), weight: 1 },
);

export const splitArb = fc.integer({ min: 0, max: 100 }).map((seeder) => ({
  seeder,
  creator: 100 - seeder,
}));

/** Contracts v3 (ADR 0004 (c)): `BlockRange.core`, a 64-char lower-case hex core key. */
export const coreKeyArb: fc.Arbitrary<CoreKeyHex> = hex32Arb.map((h) => h as CoreKeyHex);

/** v5 (ADR 0010): `core` is REQUIRED; the codec encodes it as a fixed 32-byte field. */
export const rangeArb: fc.Arbitrary<PayMessage['range']> = fc
  .tuple(blockIndexArb, fc.integer({ min: 0, max: 4096 }), coreKeyArb)
  .map(([from, len, core]) => ({
    core,
    fromBlock: from,
    toBlock: Math.min(from + len, MAX_BLOCK),
  }));

/** v5: `PayMessage.carryIn`, an integer in [0, 99]. */
export const carryArb = fc.integer({ min: 0, max: 99 });

/** v5: `HELLO.challenge` = `pay/1:<handshake hash hex>:<sender Noise key hex>`. */
export const challengeArb = fc
  .tuple(hex32Arb, hex32Arb)
  .map(([hash, key]) => `pay/1:${hash}:${key}`);

/** Unix seconds that fit the codec's uint (any time before 2106). */
export const unixArb = fc.integer({ min: 0, max: 2 ** 32 - 1 });

// ---------------------------------------------------------------------------------------
// Cashu shapes
// ---------------------------------------------------------------------------------------

export const dleqArb: fc.Arbitrary<SerializedDleq> = fc
  .tuple(hex32Arb, hex32Arb, fc.option(hex32Arb))
  .map(([s, e, r]) => (r === null ? { s, e } : { s, e, r }));

/** A NUT-11 P2PK well-known secret as it appears on the wire (JSON string) — or any text. */
export const secretArb = fc.oneof(
  { arbitrary: textArb, weight: 1 },
  {
    weight: 2,
    arbitrary: fc
      .tuple(hex32Arb, p2pkArb)
      .map(([nonce, data]) =>
        JSON.stringify(['P2PK', { nonce, data, tags: [['sigflag', 'SIG_INPUTS']] }]),
      ),
  },
);

export const proofArb: fc.Arbitrary<CashuProof> = fc
  .record({
    id: hexOf(8),
    amount: fc.integer({ min: 1, max: 2 ** 40 }),
    secret: secretArb,
    C: p2pkArb,
    dleq: fc.option(dleqArb, { freq: 6 }),
    witness: fc.option(
      hex64Arb.map((sig) => JSON.stringify({ signatures: [sig] })),
      { freq: 4 },
    ),
  })
  .map(({ id, amount, secret, C, dleq, witness }) => {
    const p: CashuProof = { id, amount, secret, C };
    return {
      ...p,
      ...(dleq === null ? {} : { dleq }),
      ...(witness === null ? {} : { witness }),
    };
  });

export const lockedSetArb: fc.Arbitrary<LockedProofSet> = fc.record({
  mint: mintUrlArb,
  unit: fc.constant<'sat'>('sat'),
  lockedTo: p2pkArb,
  proofs: fc.array(proofArb, { maxLength: 12 }),
});

export const payMessageArb: fc.Arbitrary<PayMessage> = fc
  .record({
    range: rangeArb,
    carryIn: carryArb,
    seederProofs: lockedSetArb,
    creatorProofs: lockedSetArb,
  })
  .map(plain);

// ---------------------------------------------------------------------------------------
// The four wire messages
// ---------------------------------------------------------------------------------------

export const helloArb: fc.Arbitrary<HelloMessage> = fc
  .record({
    type: fc.constant<'HELLO'>('HELLO'),
    version: fc.integer({ min: 0, max: 0xffff }),
    pubkey: nostrPubkeyArb,
    challenge: challengeArb,
    createdAt: unixArb.map((n) => n as HelloMessage['createdAt']),
    signature: hex64Arb,
    acceptedMints: fc.array(mintUrlArb, { maxLength: 6 }),
    satsPerBlock: satsArb,
    split: splitArb,
    p2pk: p2pkArb,
    windowBlocks: fc.integer({ min: 0, max: 0xffff }),
  })
  .map(plain);

export const payWireArb: fc.Arbitrary<PayWireMessage> = fc
  .record({
    type: fc.constant<'PAY'>('PAY'),
    payload: payMessageArb,
  })
  .map(plain);

export const ackArb: fc.Arbitrary<AckMessage> = fc
  .record({
    core: coreKeyArb,
    fromBlock: blockIndexArb,
    toBlock: blockIndexArb,
    ok: fc.boolean(),
    reason: fc.option(fc.constantFrom(...REJECT_REASONS)),
    // v6 amendment: the seeder's count after the PAY (any safe count; 0 is common).
    outstanding: fc.option(fc.oneof(fc.constant(0), fc.nat(64), fc.maxSafeNat())),
  })
  .map(({ core, fromBlock, toBlock, ok, reason, outstanding }) => {
    let base: AckMessage = { type: 'ACK', core, fromBlock, toBlock, ok };
    if (reason !== null) base = { ...base, reason };
    return outstanding === null ? base : { ...base, outstanding };
  })
  .map(plain);

/** A priced PRICE: `free` absent (the v5 shape) or `false`. */
const pricedArb: fc.Arbitrary<PriceMessage> = fc
  .record({
    core: coreKeyArb,
    satsPerBlock: satsArb,
    effectiveFromBlock: blockIndexArb,
    free: fc.option(fc.constant(false)),
  })
  .map(({ core, satsPerBlock, effectiveFromBlock, free }) => {
    const base: PriceMessage = { type: 'PRICE', core, satsPerBlock, effectiveFromBlock };
    return free === null ? base : { ...base, free };
  });

/** v6 amendment: `{ free: true }` — no price, from block 0. */
const freePriceArb: fc.Arbitrary<PriceMessage> = coreKeyArb.map((core) => ({
  type: 'PRICE',
  core,
  satsPerBlock: 0 as Sats,
  effectiveFromBlock: 0,
  free: true,
}));

export const priceArb: fc.Arbitrary<PriceMessage> = fc
  .oneof({ arbitrary: pricedArb, weight: 3 }, { arbitrary: freePriceArb, weight: 1 })
  .map(plain);

/**
 * v6 amendment: OWED with canonical ranges (ascending, disjoint, not adjacent), within the caps.
 * Built from a start and (gap, length) steps: every gap ≥ 1 keeps ranges apart; lengths ≤ 16 over
 * ≤ 64 steps keep the total ≤ 1024 = MAX_OWED_BLOCKS; a second shape is one long range.
 */
export const owedArb: fc.Arbitrary<OwedMessage> = fc
  .oneof(
    {
      weight: 4,
      arbitrary: fc
        .tuple(
          coreKeyArb,
          blockIndexArb,
          fc.array(
            fc.tuple(fc.integer({ min: 1, max: 2 ** 20 }), fc.integer({ min: 1, max: 16 })),
            {
              minLength: 1,
              maxLength: 64,
            },
          ),
        )
        .map(([core, start, steps]) => {
          const ranges: OwedRange[] = [];
          let at = start;
          for (const [gap, len] of steps) {
            ranges.push([at, at + len - 1]);
            at += len + gap;
          }
          return { type: 'OWED' as const, core, ranges };
        }),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(coreKeyArb, blockIndexArb, fc.integer({ min: 1, max: MAX_OWED_BLOCKS }))
        .map(([core, from, len]) => ({
          type: 'OWED' as const,
          core,
          ranges: [[from, from + len - 1] as const],
        })),
    },
  )
  .map(plain);

export const messageArb: fc.Arbitrary<PayProtocolMessage> = fc.oneof(
  helloArb,
  payWireArb,
  ackArb,
  priceArb,
  owedArb,
);

/** v6 amendment: whether `x` is canonical OWED ranges within the caps (the codec's grammar). */
export function isOwedRanges(x: unknown): x is readonly OwedRange[] {
  if (!Array.isArray(x) || x.length < 1 || x.length > MAX_OWED_RANGES) return false;
  let prev = -2;
  let total = 0;
  for (const r of x as unknown[]) {
    if (!Array.isArray(r) || r.length !== 2) return false;
    const [from, to] = r as unknown[];
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return false;
    const f = from as number;
    const t = to as number;
    if (f < 0 || t < f || f <= prev + 1) return false;
    total += t - f + 1;
    if (total > MAX_OWED_BLOCKS) return false;
    prev = t;
  }
  return true;
}

// ---------------------------------------------------------------------------------------
// Structural validator: what a *decoded* value must look like to count as a message at all
// ---------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isStr = (x: unknown): x is string => typeof x === 'string';
const isUint = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const isNoExtraUndefined = (o: Record<string, unknown>): boolean =>
  Object.values(o).every((v) => v !== undefined);

function isDleq(x: unknown): x is SerializedDleq {
  return (
    isObj(x) &&
    isStr(x['s']) &&
    isStr(x['e']) &&
    (x['r'] === undefined ? !('r' in x) : isStr(x['r']))
  );
}

function isProof(x: unknown): x is CashuProof {
  if (!isObj(x)) return false;
  if (!isStr(x['id']) || !isUint(x['amount']) || x['amount'] < 1) return false;
  if (!isStr(x['secret']) || !isStr(x['C'])) return false;
  if ('dleq' in x && !isDleq(x['dleq'])) return false;
  if ('witness' in x && !isStr(x['witness'])) return false;
  return isNoExtraUndefined(x);
}

function isLockedSet(x: unknown): x is LockedProofSet {
  return (
    isObj(x) &&
    isStr(x['mint']) &&
    x['unit'] === 'sat' &&
    isStr(x['lockedTo']) &&
    Array.isArray(x['proofs']) &&
    x['proofs'].every(isProof)
  );
}

const isCoreKey = (x: unknown): x is CoreKeyHex => isStr(x) && /^[0-9a-f]{64}$/.test(x);

function isRange(x: unknown): x is PayMessage['range'] {
  return isObj(x) && isUint(x['fromBlock']) && isUint(x['toBlock']) && isCoreKey(x['core']);
}

export function isPayMessageShape(x: unknown): x is PayMessage {
  return (
    isObj(x) &&
    isRange(x['range']) &&
    isUint(x['carryIn']) &&
    x['carryIn'] < 100 &&
    isLockedSet(x['seederProofs']) &&
    isLockedSet(x['creatorProofs'])
  );
}

export function isPayProtocolMessage(x: unknown): x is PayProtocolMessage {
  if (!isObj(x) || !isStr(x['type'])) return false;
  switch (x['type']) {
    case 'HELLO':
      return (
        isUint(x['version']) &&
        isStr(x['pubkey']) &&
        isStr(x['challenge']) &&
        isUint(x['createdAt']) &&
        isStr(x['signature']) &&
        Array.isArray(x['acceptedMints']) &&
        x['acceptedMints'].every(isStr) &&
        isUint(x['satsPerBlock']) &&
        isObj(x['split']) &&
        isUint(x['split']['seeder']) &&
        isUint(x['split']['creator']) &&
        isStr(x['p2pk']) &&
        isUint(x['windowBlocks'])
      );
    case 'PAY':
      return isPayMessageShape(x['payload']);
    case 'ACK':
      return (
        isCoreKey(x['core']) &&
        isUint(x['fromBlock']) &&
        isUint(x['toBlock']) &&
        typeof x['ok'] === 'boolean' &&
        (x['reason'] === undefined
          ? !('reason' in x)
          : (REJECT_REASONS as readonly string[]).includes(x['reason'] as string)) &&
        (x['outstanding'] === undefined ? !('outstanding' in x) : isUint(x['outstanding']))
      );
    case 'PRICE':
      return (
        isCoreKey(x['core']) &&
        isUint(x['satsPerBlock']) &&
        isUint(x['effectiveFromBlock']) &&
        (x['free'] === undefined
          ? !('free' in x)
          : x['free'] === false ||
            (x['free'] === true && x['satsPerBlock'] === 0 && x['effectiveFromBlock'] === 0))
      );
    case 'OWED':
      return isCoreKey(x['core']) && isOwedRanges(x['ranges']);
    default:
      return false;
  }
}
