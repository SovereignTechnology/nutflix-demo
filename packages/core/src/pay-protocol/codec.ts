/**
 * The `pay/1` wire codec (contracts `PayProtocolCodec`, compact-encoding; SECURITY.md T11,
 * invariant 4). `decode` is the first thing untrusted bytes touch, so it:
 *
 *   - never throws — any failure is `null`;
 *   - bounds everything before allocating: frame ≤ 1 MiB, strings ≤ 16 KiB, ≤ 256 proofs per set,
 *     ≤ 64 mints, integers safe (≤ 2^53 − 1) and the carry < 100;
 *   - requires the frame to be consumed EXACTLY (no trailing bytes), unknown flag bits to be 0,
 *     and a known message tag and reject-reason index;
 *   - requires every string to be strict UTF-8 and every uint (a string's length too) in its
 *     minimal encoding (F58, found by the fuzz campaign), so one message has one frame;
 *   - returns fresh plain objects with absent optional fields ABSENT (not `undefined`).
 *
 * `encode` throws on a message outside that grammar, so a local bug can never put an undecodable
 * frame on the wire. The codec checks shape and bounds only; what the fields MEAN (a valid
 * signature, a sane split, the right lock) is checked by the channel and the engine.
 *
 * Layout: `tag:uint8` then the fields of HELLO(1) / PAY(2) / ACK(3) / PRICE(4) / OWED(5), in the
 * order of the contract's interfaces. `core` is a fixed 32-byte field. Optional proof fields ride on
 * a flags byte (bit0 dleq, bit1 dleq.r, bit2 witness).
 *
 * v6 amendment (2026-09-26):
 *   - ACK's flags byte gains bit2 = `outstanding` present (a uint after the reason);
 *   - PRICE may end with a flags byte, written only when `free` is present: bit0 = present (must be
 *     set), bit1 = its value, every other bit 0 — so 1 (`free: false`) or 3 (`free: true`). With
 *     `free` absent there is no flags byte, and the frame is byte-for-byte the v5 PRICE (an older
 *     build still reads it); a flags byte of 0 or 2 is refused (one encoding per message).
 *     `free: true` requires `satsPerBlock` 0 and `effectiveFromBlock` 0;
 *   - OWED: `core`, a uint count n (1 … MAX_OWED_RANGES), then n × (fromBlock, toBlock) uints —
 *     canonical: each from ≤ to, ascending, disjoint and not adjacent, at most MAX_OWED_BLOCKS
 *     blocks in total. The count is checked before anything is read, the total as it is read.
 *
 * v7 amendment (2026-10-02, rule 5): OWED has one more form, the end of the report — `core` =
 * `OWED_END_CORE` (32 zero bytes) with a count of 0 and nothing after it. A count of 0 for any other
 * core, and `OWED_END_CORE` with any range, are refused both ways (one encoding per message).
 */
import c, { type State } from 'compact-encoding';

import { MAX_OWED_BLOCKS, MAX_OWED_RANGES, OWED_END_CORE } from '../contracts/index.js';
import type {
  AckMessage,
  CashuProof,
  CoreKeyHex,
  HelloMessage,
  LockedProofSet,
  MintUrl,
  NostrPubkey,
  OwedMessage,
  OwedRange,
  PayMessage,
  PayProtocolCodec,
  PayProtocolMessage,
  PriceMessage,
  RejectReason,
  Sats,
  UnixSeconds,
  CashuP2pkPubkey,
} from '../contracts/index.js';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_STRING_BYTES = 16 * 1024;
export const MAX_PROOFS = 256;
export const MAX_MINTS = 64;

const TAG = { HELLO: 1, PAY: 2, ACK: 3, PRICE: 4, OWED: 5 } as const;

/** Wire indexes of the reject reasons — append only, never reorder. */
export const REJECT_REASON_CODES = [
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
type _Exhaustive =
  Exclude<RejectReason, (typeof REJECT_REASON_CODES)[number]> extends never ? true : never;
/** Compile-time proof the wire list covers every `RejectReason`. */
export const REJECT_REASONS_ON_WIRE: _Exhaustive = true;

class CodecError extends Error {
  override readonly name = 'CodecError';
}

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------
// Primitive helpers (bounded)
// ---------------------------------------------------------------------------------------

function need(ok: boolean, what: string): void {
  if (!ok) throw new CodecError(what);
}

const utf8 = new TextEncoder();

/** A lone UTF-16 surrogate: `TextEncoder` would write U+FFFD for it, not the string. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function checkString(s: unknown, what: string): string {
  need(typeof s === 'string', `${what}: not a string`);
  // F58: only a well-formed string has an encoding that decodes back to it.
  need(!LONE_SURROGATE.test(s as string), `${what}: not well-formed UTF-16`);
  need(utf8.encode(s as string).byteLength <= MAX_STRING_BYTES, `${what}: too long`);
  return s as string;
}

function checkUint(n: unknown, what: string): number {
  need(Number.isSafeInteger(n) && (n as number) >= 0, `${what}: not a safe unsigned integer`);
  return n as number;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Bytes compact-encoding writes for `n` (1, 3, 5 or 9). */
function uintSize(n: number): number {
  const st = { start: 0, end: 0, buffer: null } as unknown as State;
  c.uint.preencode(st, n);
  return st.end;
}

/**
 * A uint in its MINIMAL encoding only (F58, the fuzz campaign): compact-encoding also reads 0
 * written as `0xfd 0 0`, so one message would have many frames.
 */
function readMinimalUint(state: State, what: string): number {
  const at = state.start;
  const n = c.uint.decode(state);
  need(Number.isSafeInteger(n) && n >= 0, `${what}: out of range`);
  need(state.start - at === uintSize(n), `${what}: not in its minimal encoding`);
  return n;
}

function readUint(state: State, what: string): number {
  return readMinimalUint(state, what);
}

function readString(state: State, what: string): string {
  // Peek the length prefix before letting compact-encoding allocate.
  const save = state.start;
  const len = readMinimalUint(state, `${what} length`);
  need(len <= MAX_STRING_BYTES, `${what}: too long`);
  const begin = state.start;
  state.start = save;
  const s = c.string.decode(state);
  // F58 (the fuzz campaign): strict UTF-8. compact-encoding decodes invalid bytes to U+FFFD, so
  // two different frames read as one message; only bytes that ARE the string's encoding pass.
  const raw = state.buffer;
  need(
    raw !== null && sameBytes(utf8.encode(s), raw.subarray(begin, state.start)),
    `${what}: not valid UTF-8`,
  );
  return s;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readCore(state: State): CoreKeyHex {
  return bytesToHex(c.fixed32.decode(state)) as CoreKeyHex;
}

function writeCore(state: State, core: string, pre: boolean): void {
  need(typeof core === 'string' && HEX64.test(core), 'core: not 64 lower-case hex');
  if (pre) c.fixed32.preencode(state, hexToBytes(core));
  else c.fixed32.encode(state, hexToBytes(core));
}

/**
 * The OWED grammar, one step: range `[from, to]` after a range ending at `prevTo` (`null` before
 * the first), with `total` blocks so far. Returns the new total. Canonical: from ≤ to, ascending,
 * disjoint and not adjacent; the total never passes `MAX_OWED_BLOCKS` (checked per range, so the
 * running sum stays small whatever the indexes are).
 */
function owedStep(from: number, to: number, prevTo: number | null, total: number): number {
  need(from <= to, 'owed: a range ends before it starts');
  need(prevTo === null || from > prevTo + 1, 'owed: ranges must be ascending and not touch');
  const len = to - from + 1;
  need(len <= MAX_OWED_BLOCKS - total, 'owed: more blocks than MAX_OWED_BLOCKS');
  return total + len;
}

/** v7 rule 5: the end marker is the only OWED with no ranges, and names no ranges itself. */
function checkOwed(core: unknown, ranges: unknown): readonly OwedRange[] {
  need(Array.isArray(ranges), 'owed.ranges: not an array');
  if ((ranges as readonly unknown[]).length === 0) {
    need(core === OWED_END_CORE, 'owed.ranges: none, for a core that is not the end marker');
    return [];
  }
  need(core !== OWED_END_CORE, 'owed: the end marker with ranges');
  return checkOwedRanges(ranges);
}

function checkOwedRanges(ranges: unknown): readonly OwedRange[] {
  need(Array.isArray(ranges), 'owed.ranges: not an array');
  const list = ranges as readonly unknown[];
  need(list.length >= 1 && list.length <= MAX_OWED_RANGES, 'owed.ranges: count out of bounds');
  let prevTo: number | null = null;
  let total = 0;
  for (const r of list) {
    need(Array.isArray(r) && r.length === 2, 'owed.range: not a [from, to] pair');
    const [from, to] = r as readonly unknown[];
    const f = checkUint(from, 'owed.fromBlock');
    const t = checkUint(to, 'owed.toBlock');
    total = owedStep(f, t, prevTo, total);
    prevTo = t;
  }
  return list as readonly OwedRange[];
}

// ---------------------------------------------------------------------------------------
// Encoder: one walk used for both preencode (sizing) and encode (writing)
// ---------------------------------------------------------------------------------------

type Writer = (state: State, pre: boolean) => void;

function w<T>(
  enc: { preencode(s: State, v: T): void; encode(s: State, v: T): void },
  v: T,
): Writer {
  return (state, pre) => {
    if (pre) enc.preencode(state, v);
    else enc.encode(state, v);
  };
}

function proofWriters(p: CashuProof, out: Writer[]): void {
  const raw: unknown = p; // the type says CashuProof; a local bug may say otherwise
  need(typeof raw === 'object' && raw !== null, 'proof: not an object');
  const d = p.dleq;
  const flags =
    (d !== undefined ? 1 : 0) | (d?.r !== undefined ? 2 : 0) | (p.witness !== undefined ? 4 : 0);
  need(
    Number.isSafeInteger(p.amount) && p.amount >= 1,
    'proof.amount: not a positive safe integer',
  );
  out.push(w(c.uint8, flags));
  out.push(w(c.string, checkString(p.id, 'proof.id')));
  out.push(w(c.uint, p.amount));
  out.push(w(c.string, checkString(p.secret, 'proof.secret')));
  out.push(w(c.string, checkString(p.C, 'proof.C')));
  if (d !== undefined) {
    out.push(w(c.string, checkString(d.s, 'dleq.s')));
    out.push(w(c.string, checkString(d.e, 'dleq.e')));
    if (d.r !== undefined) out.push(w(c.string, checkString(d.r, 'dleq.r')));
  }
  if (p.witness !== undefined) out.push(w(c.string, checkString(p.witness, 'proof.witness')));
}

function setWriters(s: LockedProofSet, out: Writer[]): void {
  const raw: unknown = s;
  need(
    typeof raw === 'object' && raw !== null && (raw as { unit?: unknown }).unit === 'sat',
    'set: bad shape or unit',
  );
  need(Array.isArray(s.proofs) && s.proofs.length <= MAX_PROOFS, 'set.proofs: too many');
  out.push(w(c.string, checkString(s.mint, 'set.mint')));
  out.push(w(c.string, checkString(s.lockedTo, 'set.lockedTo')));
  out.push(w(c.uint, s.proofs.length));
  for (const p of s.proofs) proofWriters(p, out);
}

function messageWriters(m: PayProtocolMessage): Writer[] {
  const out: Writer[] = [];
  switch (m.type) {
    case 'HELLO': {
      need(
        Array.isArray(m.acceptedMints) && m.acceptedMints.length <= MAX_MINTS,
        'hello.acceptedMints',
      );
      out.push(w(c.uint8, TAG.HELLO));
      out.push(w(c.uint, checkUint(m.version, 'hello.version')));
      out.push(w(c.string, checkString(m.pubkey, 'hello.pubkey')));
      out.push(w(c.string, checkString(m.challenge, 'hello.challenge')));
      out.push(w(c.uint, checkUint(m.createdAt, 'hello.createdAt')));
      out.push(w(c.string, checkString(m.signature, 'hello.signature')));
      out.push(w(c.uint, m.acceptedMints.length));
      for (const mint of m.acceptedMints) out.push(w(c.string, checkString(mint, 'hello.mint')));
      out.push(w(c.uint, checkUint(m.satsPerBlock, 'hello.satsPerBlock')));
      out.push(w(c.uint, checkUint(m.split.seeder, 'hello.split.seeder')));
      out.push(w(c.uint, checkUint(m.split.creator, 'hello.split.creator')));
      out.push(w(c.string, checkString(m.p2pk, 'hello.p2pk')));
      out.push(w(c.uint, checkUint(m.windowBlocks, 'hello.windowBlocks')));
      break;
    }
    case 'PAY': {
      const p = m.payload;
      need(Number.isSafeInteger(p.carryIn) && p.carryIn >= 0 && p.carryIn < 100, 'pay.carryIn');
      out.push(w(c.uint8, TAG.PAY));
      out.push((s, pre) => {
        writeCore(s, p.range.core, pre);
      });
      out.push(w(c.uint, checkUint(p.range.fromBlock, 'pay.fromBlock')));
      out.push(w(c.uint, checkUint(p.range.toBlock, 'pay.toBlock')));
      out.push(w(c.uint8, p.carryIn));
      setWriters(p.seederProofs, out);
      setWriters(p.creatorProofs, out);
      break;
    }
    case 'ACK': {
      const reason = m.reason;
      const idx = reason === undefined ? -1 : REJECT_REASON_CODES.indexOf(reason);
      need(reason === undefined || idx >= 0, 'ack.reason: unknown');
      need(typeof m.ok === 'boolean', 'ack.ok');
      const outstanding = m.outstanding;
      if (outstanding !== undefined) checkUint(outstanding, 'ack.outstanding');
      out.push(w(c.uint8, TAG.ACK));
      out.push((s, pre) => {
        writeCore(s, m.core, pre);
      });
      out.push(w(c.uint, checkUint(m.fromBlock, 'ack.fromBlock')));
      out.push(w(c.uint, checkUint(m.toBlock, 'ack.toBlock')));
      out.push(
        w(
          c.uint8,
          (m.ok ? 1 : 0) | (reason !== undefined ? 2 : 0) | (outstanding !== undefined ? 4 : 0),
        ),
      );
      if (reason !== undefined) out.push(w(c.uint8, idx));
      if (outstanding !== undefined) out.push(w(c.uint, outstanding));
      break;
    }
    case 'PRICE': {
      const free: unknown = m.free;
      need(free === undefined || typeof free === 'boolean', 'price.free: not a boolean');
      const sats = checkUint(m.satsPerBlock, 'price.satsPerBlock');
      const from = checkUint(m.effectiveFromBlock, 'price.effectiveFromBlock');
      need(free !== true || (sats === 0 && from === 0), 'price.free: a free core has no price');
      out.push(w(c.uint8, TAG.PRICE));
      out.push((s, pre) => {
        writeCore(s, m.core, pre);
      });
      out.push(w(c.uint, sats));
      out.push(w(c.uint, from));
      if (free !== undefined) out.push(w(c.uint8, free ? 3 : 1));
      break;
    }
    case 'OWED': {
      const ranges = checkOwed(m.core, m.ranges);
      out.push(w(c.uint8, TAG.OWED));
      out.push((s, pre) => {
        writeCore(s, m.core, pre);
      });
      out.push(w(c.uint, ranges.length));
      for (const [from, to] of ranges) {
        out.push(w(c.uint, from));
        out.push(w(c.uint, to));
      }
      break;
    }
    default:
      throw new CodecError('unknown message type');
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------------------

function readProof(state: State): CashuProof {
  const flags = c.uint8.decode(state);
  need((flags & ~7) === 0 && !((flags & 2) !== 0 && (flags & 1) === 0), 'proof.flags');
  const id = readString(state, 'proof.id');
  const amount = readUint(state, 'proof.amount');
  need(amount >= 1, 'proof.amount: zero');
  const secret = readString(state, 'proof.secret');
  const C = readString(state, 'proof.C');
  let dleq: CashuProof['dleq'];
  if ((flags & 1) !== 0) {
    const s = readString(state, 'dleq.s');
    const e = readString(state, 'dleq.e');
    dleq = (flags & 2) !== 0 ? { s, e, r: readString(state, 'dleq.r') } : { s, e };
  }
  const witness = (flags & 4) !== 0 ? readString(state, 'proof.witness') : undefined;
  return {
    id,
    amount,
    secret,
    C,
    ...(dleq === undefined ? {} : { dleq }),
    ...(witness === undefined ? {} : { witness }),
  };
}

function readSet(state: State): LockedProofSet {
  const mint = readString(state, 'set.mint') as MintUrl;
  const lockedTo = readString(state, 'set.lockedTo') as CashuP2pkPubkey;
  const n = readUint(state, 'set.proofs');
  need(n <= MAX_PROOFS, 'set.proofs: too many');
  const proofs: CashuProof[] = [];
  for (let i = 0; i < n; i++) proofs.push(readProof(state));
  return { mint, unit: 'sat', lockedTo, proofs };
}

function readMessage(state: State): PayProtocolMessage {
  const tag = c.uint8.decode(state);
  switch (tag) {
    case TAG.HELLO: {
      const version = readUint(state, 'hello.version');
      const pubkey = readString(state, 'hello.pubkey') as NostrPubkey;
      const challenge = readString(state, 'hello.challenge');
      const createdAt = readUint(state, 'hello.createdAt') as UnixSeconds;
      const signature = readString(state, 'hello.signature');
      const nMints = readUint(state, 'hello.acceptedMints');
      need(nMints <= MAX_MINTS, 'hello.acceptedMints: too many');
      const acceptedMints: MintUrl[] = [];
      for (let i = 0; i < nMints; i++)
        acceptedMints.push(readString(state, 'hello.mint') as MintUrl);
      const satsPerBlock = readUint(state, 'hello.satsPerBlock') as Sats;
      const seeder = readUint(state, 'hello.split.seeder');
      const creator = readUint(state, 'hello.split.creator');
      const p2pk = readString(state, 'hello.p2pk') as CashuP2pkPubkey;
      const windowBlocks = readUint(state, 'hello.windowBlocks');
      const hello: HelloMessage = {
        type: 'HELLO',
        version,
        pubkey,
        challenge,
        createdAt,
        signature,
        acceptedMints,
        satsPerBlock,
        split: { seeder, creator },
        p2pk,
        windowBlocks,
      };
      return hello;
    }
    case TAG.PAY: {
      const core = readCore(state);
      const fromBlock = readUint(state, 'pay.fromBlock');
      const toBlock = readUint(state, 'pay.toBlock');
      const carryIn = c.uint8.decode(state);
      need(carryIn < 100, 'pay.carryIn');
      const seederProofs = readSet(state);
      const creatorProofs = readSet(state);
      const payload: PayMessage = {
        range: { core, fromBlock, toBlock },
        carryIn,
        seederProofs,
        creatorProofs,
      };
      return { type: 'PAY', payload };
    }
    case TAG.ACK: {
      const core = readCore(state);
      const fromBlock = readUint(state, 'ack.fromBlock');
      const toBlock = readUint(state, 'ack.toBlock');
      const flags = c.uint8.decode(state);
      need((flags & ~7) === 0, 'ack.flags');
      let ack: AckMessage = { type: 'ACK', core, fromBlock, toBlock, ok: (flags & 1) !== 0 };
      if ((flags & 2) !== 0) {
        const idx = c.uint8.decode(state);
        const reason = REJECT_REASON_CODES[idx];
        if (reason === undefined) throw new CodecError('ack.reason: unknown');
        ack = { ...ack, reason };
      }
      if ((flags & 4) !== 0) ack = { ...ack, outstanding: readUint(state, 'ack.outstanding') };
      return ack;
    }
    case TAG.PRICE: {
      const core = readCore(state);
      const satsPerBlock = readUint(state, 'price.satsPerBlock') as Sats;
      const effectiveFromBlock = readUint(state, 'price.effectiveFromBlock');
      const price: PriceMessage = { type: 'PRICE', core, satsPerBlock, effectiveFromBlock };
      // v6 amendment: the optional trailing flags byte (absent = the v5 PRICE, `free` absent).
      if (state.start === state.end) return price;
      const flags = c.uint8.decode(state);
      need(flags === 1 || flags === 3, 'price.flags');
      const free = flags === 3;
      need(!free || (satsPerBlock === 0 && effectiveFromBlock === 0), 'price.free: priced');
      return { ...price, free };
    }
    case TAG.OWED: {
      const core = readCore(state);
      const n = readUint(state, 'owed.ranges');
      if (core === OWED_END_CORE) {
        // v7 rule 5: the end of the report — a count of 0 and nothing after it.
        need(n === 0, 'owed: the end marker with ranges');
        const end: OwedMessage = { type: 'OWED', core, ranges: [] };
        return end;
      }
      need(n >= 1 && n <= MAX_OWED_RANGES, 'owed.ranges: count out of bounds');
      const ranges: OwedRange[] = [];
      let prevTo: number | null = null;
      let total = 0;
      for (let i = 0; i < n; i++) {
        const from = readUint(state, 'owed.fromBlock');
        const to = readUint(state, 'owed.toBlock');
        total = owedStep(from, to, prevTo, total);
        prevTo = to;
        ranges.push([from, to]);
      }
      const owed: OwedMessage = { type: 'OWED', core, ranges };
      return owed;
    }
    default:
      throw new CodecError('unknown tag');
  }
}

export const payCodec: PayProtocolCodec = {
  encode(msg: PayProtocolMessage): Uint8Array {
    const writers = messageWriters(msg);
    const state = c.state();
    for (const f of writers) f(state, true);
    need(state.end <= MAX_FRAME_BYTES, 'frame too large');
    state.buffer = new Uint8Array(state.end);
    for (const f of writers) f(state, false);
    return state.buffer;
  },

  decode(buf: Uint8Array): PayProtocolMessage | null {
    try {
      if (!(buf instanceof Uint8Array) || buf.byteLength === 0 || buf.byteLength > MAX_FRAME_BYTES)
        return null;
      const state = c.state(0, buf.byteLength, buf);
      const msg = readMessage(state);
      return state.start === state.end ? msg : null;
    } catch {
      return null;
    }
  },
};
