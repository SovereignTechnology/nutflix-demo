/**
 * `pay/1` codec fuzz harness (execution plan §2 L10; contracts/pay-protocol.ts
 * `PayProtocolCodec`: "Must never throw on arbitrary bytes: return `null`").
 *
 * Two always-on tests pin the protocol constants and self-check the arbitraries. Everything
 * else is real and skipped only while `getCodec()` returns `undefined` — Stage 2 wires the
 * compact-encoding codec in `provider.mts` and this suite runs unchanged.
 *
 * Threat rows served: T11 (a peer feeding garbage must not crash the seeder/gateway —
 * `decode` is the first thing untrusted bytes touch) and INV4 (a PAY that decodes must be a
 * structurally complete message before `verify` sees it).
 */
import c from 'compact-encoding';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type {
  CoreKeyHex,
  OwedMessage,
  PayProtocolCodec,
  PayProtocolMessage,
  PriceMessage,
  Sats,
} from '../../contracts/index.js';
import {
  MAX_OWED_BLOCKS,
  MAX_OWED_RANGES,
  OWED_END_CORE,
  PAY_PROTOCOL_NAME,
  PAY_PROTOCOL_VERSION,
} from '../../contracts/index.js';
import {
  REJECT_REASONS,
  REJECT_REASONS_EXHAUSTIVE,
  ackArb,
  helloArb,
  isOwedRanges,
  isPayProtocolMessage,
  messageArb,
  owedArb,
  payWireArb,
  plain,
  priceArb,
} from './arbitraries.mjs';
import { SKIP_REASON, getCodec } from './provider.mjs';

const codec: PayProtocolCodec | undefined = getCodec();

/** Never let a throw escape `decode`; report it as a property failure with the input. */
function decodeSafely(c: PayProtocolCodec, buf: Uint8Array): { threw: unknown; out: unknown } {
  try {
    return { threw: undefined, out: c.decode(buf) };
  } catch (e: unknown) {
    return { threw: e ?? new Error('threw undefined'), out: undefined };
  }
}

describe('pay/1 protocol constants', () => {
  it('protocol name and version are the frozen wire identifiers', () => {
    expect(PAY_PROTOCOL_NAME).toBe('pay/1');
    expect(PAY_PROTOCOL_VERSION).toBe(1);
    expect(REJECT_REASONS_EXHAUSTIVE).toBe(true);
    expect(new Set(REJECT_REASONS).size).toBe(REJECT_REASONS.length);
  });

  it('harness self-check: every generated message is a structurally valid PayProtocolMessage', () => {
    fc.assert(
      fc.property(messageArb, (m) => {
        expect(isPayProtocolMessage(m)).toBe(true);
        expect(['HELLO', 'PAY', 'ACK', 'PRICE', 'OWED']).toContain(m.type);
      }),
      { numRuns: 300 },
    );
    // And the validator is not vacuous.
    for (const junk of [
      null,
      1,
      'PAY',
      {},
      { type: 'PAY' },
      { type: 'NOPE' },
      { type: 'ACK', ok: 1 },
      // v6 amendment: a free PRICE with a price, an OWED with no / touching / unsorted ranges.
      { type: 'PRICE', core: 'ab'.repeat(32), satsPerBlock: 1, effectiveFromBlock: 0, free: true },
      { type: 'OWED', core: 'ab'.repeat(32), ranges: [] },
      {
        type: 'OWED',
        core: 'ab'.repeat(32),
        ranges: [
          [0, 3],
          [4, 5],
        ],
      },
      {
        type: 'OWED',
        core: 'ab'.repeat(32),
        ranges: [
          [9, 9],
          [0, 1],
        ],
      },
    ]) {
      expect(isPayProtocolMessage(junk)).toBe(false);
    }
  });
});

describe.skipIf(codec === undefined)(`PayProtocolCodec fuzz (${SKIP_REASON})`, () => {
  const c = (): PayProtocolCodec => codec!;

  it('decode(arbitrary bytes) never throws and returns null or a structurally valid message', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const { threw, out } = decodeSafely(c(), bytes);
        expect(threw).toBeUndefined();
        expect(out === null || isPayProtocolMessage(out)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('decode of the empty buffer and of small fixed patterns is null, not a throw', () => {
    const patterns = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0xff]),
      new Uint8Array(16).fill(0),
      new Uint8Array(16).fill(0xff),
      new Uint8Array([0xfd, 0xff, 0xff]), // compact-encoding uint16 prefix with nothing after
      new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      new TextEncoder().encode('{"type":"PAY"}'),
      new TextEncoder().encode(PAY_PROTOCOL_NAME),
    ];
    for (const p of patterns) {
      const { threw, out } = decodeSafely(c(), p);
      expect(threw, `pattern ${Array.from(p).join(',')}`).toBeUndefined();
      expect(out === null || isPayProtocolMessage(out)).toBe(true);
    }
    expect(decodeSafely(c(), new Uint8Array(0)).out).toBeNull();
  });

  it('decode(encode(msg)) round-trips every valid PayProtocolMessage exactly', () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        const bytes = c().encode(msg);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBeGreaterThan(0);
        const back = c().decode(bytes);
        // `toStrictEqual`: optional fields that were absent must come back absent, not
        // `undefined` (contracts are compiled with `exactOptionalPropertyTypes`).
        expect(back).toStrictEqual(msg);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trip per message type (so a regression names the message, not just "oneof")', () => {
    for (const [name, arb] of [
      ['HELLO', helloArb],
      ['PAY', payWireArb],
      ['ACK', ackArb],
      ['PRICE', priceArb],
      ['OWED', owedArb],
    ] as const) {
      fc.assert(
        fc.property(arb as fc.Arbitrary<PayProtocolMessage>, (msg) => {
          const back = c().decode(c().encode(msg));
          expect(back, name).toStrictEqual(msg);
          expect(back?.type).toBe(name);
        }),
        { numRuns: 150 },
      );
    }
  });

  it('encode is deterministic: the same message always yields the same bytes', () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        expect(c().encode(msg)).toEqual(c().encode(structuredClone(msg)));
      }),
      { numRuns: 200 },
    );
  });

  it('encode never throws on any valid message, and its output is a fresh Uint8Array', () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        const a = c().encode(msg);
        const b = c().encode(msg);
        expect(a).not.toBe(b); // not a shared scratch buffer the caller could mutate
        a.fill(0);
        expect(c().decode(b)).toStrictEqual(msg); // b unaffected by mutating a
      }),
      { numRuns: 100 },
    );
  });

  it('every truncation of a valid encoding is rejected without throwing', () => {
    fc.assert(
      fc.property(messageArb, fc.double({ min: 0, max: 1, noNaN: true }), (msg, frac) => {
        const full = c().encode(msg);
        const cut = Math.floor(full.length * frac);
        fc.pre(cut < full.length);
        const { threw, out } = decodeSafely(c(), full.subarray(0, cut));
        expect(threw).toBeUndefined();
        // A strict prefix of an encoding cannot be the same message; the codec may either
        // reject it or (if the prefix happens to decode) return something structurally valid.
        expect(out === null || isPayProtocolMessage(out)).toBe(true);
        if (out !== null) expect(out).not.toStrictEqual(msg);
      }),
      { numRuns: 300 },
    );
  });

  it('trailing garbage after a valid encoding never throws', () => {
    fc.assert(
      fc.property(messageArb, fc.uint8Array({ minLength: 1, maxLength: 64 }), (msg, tail) => {
        const full = c().encode(msg);
        const buf = new Uint8Array(full.length + tail.length);
        buf.set(full, 0);
        buf.set(tail, full.length);
        const { threw, out } = decodeSafely(c(), buf);
        expect(threw).toBeUndefined();
        expect(out === null || isPayProtocolMessage(out)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('random byte flips / insertions / deletions in a valid encoding never throw and never yield a malformed message', () => {
    const mutation = fc.oneof(
      fc.record({
        kind: fc.constant<'flip'>('flip'),
        at: fc.nat(),
        bits: fc.integer({ min: 1, max: 255 }),
      }),
      fc.record({ kind: fc.constant<'insert'>('insert'), at: fc.nat(), byte: fc.nat(255) }),
      fc.record({ kind: fc.constant<'delete'>('delete'), at: fc.nat() }),
      fc.record({ kind: fc.constant<'set'>('set'), at: fc.nat(), byte: fc.nat(255) }),
    );
    fc.assert(
      fc.property(messageArb, fc.array(mutation, { minLength: 1, maxLength: 8 }), (msg, muts) => {
        let buf = c().encode(msg);
        for (const m of muts) {
          if (buf.length === 0) break;
          const at = m.at % (m.kind === 'insert' ? buf.length + 1 : buf.length);
          switch (m.kind) {
            case 'flip':
              buf[at] = buf[at]! ^ m.bits;
              break;
            case 'set':
              buf[at] = m.byte;
              break;
            case 'insert': {
              const next = new Uint8Array(buf.length + 1);
              next.set(buf.subarray(0, at), 0);
              next[at] = m.byte;
              next.set(buf.subarray(at), at + 1);
              buf = next;
              break;
            }
            case 'delete': {
              const next = new Uint8Array(buf.length - 1);
              next.set(buf.subarray(0, at), 0);
              next.set(buf.subarray(at + 1), at);
              buf = next;
              break;
            }
          }
        }
        const { threw, out } = decodeSafely(c(), buf);
        expect(threw).toBeUndefined();
        expect(out === null || isPayProtocolMessage(out)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('large but valid payloads (many proofs, long secrets) round-trip', () => {
    const bigPay = fc.record({
      type: fc.constant<'PAY'>('PAY'),
      payload: fc.record({
        // v5 (ADR 0010): `core` and `carryIn` are required on every PAY — this fixture was
        // written against v3, where both were absent; the rest of it is unchanged.
        range: fc.constant({ core: 'ab'.repeat(32), fromBlock: 0, toBlock: 63 }),
        carryIn: fc.constant(37),
        seederProofs: fc.record({
          mint: fc.constant('https://mint.example'),
          unit: fc.constant<'sat'>('sat'),
          lockedTo: fc.constant('02' + '11'.repeat(32)),
          proofs: fc.array(
            fc.record({
              id: fc.constant('0011223344556677'),
              amount: fc.integer({ min: 1, max: 2 ** 31 }),
              secret: fc.string({ minLength: 200, maxLength: 2000 }),
              C: fc.constant('02' + '22'.repeat(32)),
              dleq: fc.constant({ s: '33'.repeat(32), e: '44'.repeat(32) }),
            }),
            { minLength: 32, maxLength: 128 },
          ),
        }),
        creatorProofs: fc.record({
          mint: fc.constant('https://mint.example'),
          unit: fc.constant<'sat'>('sat'),
          lockedTo: fc.constant('02' + '55'.repeat(32)),
          proofs: fc.constant([]),
        }),
      }),
    });
    fc.assert(
      fc.property(bigPay, (msg) => {
        const m = plain(msg as unknown as PayProtocolMessage);
        expect(c().decode(c().encode(m))).toStrictEqual(m);
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------------------
// v6 amendment (2026-09-26): PRICE.free, OWED, ACK.outstanding — the grammar at its edges
// ---------------------------------------------------------------------------------------

const CORE = 'ab'.repeat(32) as CoreKeyHex;

/** Hand-built frame bytes, bypassing `encode` (whose guards are what the decode tests go around). */
function frame(write: (s: ReturnType<typeof c.state>, pre: boolean) => void): Uint8Array {
  const st = c.state();
  write(st, true);
  st.buffer = new Uint8Array(st.end);
  write(st, false);
  return st.buffer;
}

function u(s: ReturnType<typeof c.state>, pre: boolean, n: number): void {
  if (pre) c.uint.preencode(s, n);
  else c.uint.encode(s, n);
}

function u8(s: ReturnType<typeof c.state>, pre: boolean, n: number): void {
  if (pre) c.uint8.preencode(s, n);
  else c.uint8.encode(s, n);
}

function core32(s: ReturnType<typeof c.state>, pre: boolean): void {
  const b = new Uint8Array(32).fill(0xab);
  if (pre) c.fixed32.preencode(s, b);
  else c.fixed32.encode(s, b);
}

/** An OWED frame with these raw ranges (and this count, default their number). */
function owedFrame(ranges: readonly (readonly [number, number])[], count = ranges.length) {
  return frame((s, pre) => {
    u8(s, pre, 5);
    core32(s, pre);
    u(s, pre, count);
    for (const [a, b] of ranges) {
      u(s, pre, a);
      u(s, pre, b);
    }
  });
}

/** A PRICE frame; `flags` null = no flags byte (the v5 layout, and v6 with `free` absent). */
function priceFrame(sats: number, from: number, flags: number | null): Uint8Array {
  return frame((s, pre) => {
    u8(s, pre, 4);
    core32(s, pre);
    u(s, pre, sats);
    u(s, pre, from);
    if (flags !== null) u8(s, pre, flags);
  });
}

/** v7: an OWED frame with a zero core (the end marker's), this count and these ranges, then `extra`. */
function endFrame(
  ranges: readonly (readonly [number, number])[],
  count = ranges.length,
  extra = 0,
) {
  return frame((s, pre) => {
    u8(s, pre, 5);
    const zero = new Uint8Array(32);
    if (pre) c.fixed32.preencode(s, zero);
    else c.fixed32.encode(s, zero);
    u(s, pre, count);
    for (const [a, b] of ranges) {
      u(s, pre, a);
      u(s, pre, b);
    }
    for (let i = 0; i < extra; i++) u8(s, pre, 0);
  });
}

/** `n` one-block ranges two apart (canonical), starting at 0. */
const spaced = (n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [2 * i, 2 * i] as [number, number]);

describe.skipIf(codec === undefined)(
  'pay/1 v6 amendment grammar (OWED, PRICE.free, ACK.outstanding)',
  () => {
    const k = (): PayProtocolCodec => codec!;

    it('OWED: the caps are inclusive — exactly MAX_OWED_RANGES ranges and exactly MAX_OWED_BLOCKS blocks round-trip', () => {
      expect(MAX_OWED_RANGES).toBe(256);
      expect(MAX_OWED_BLOCKS).toBe(1024);
      const many: OwedMessage = { type: 'OWED', core: CORE, ranges: spaced(MAX_OWED_RANGES) };
      expect(k().decode(k().encode(many))).toStrictEqual(many);
      const long: OwedMessage = {
        type: 'OWED',
        core: CORE,
        ranges: [[7, 7 + MAX_OWED_BLOCKS - 1]],
      };
      expect(k().decode(k().encode(long))).toStrictEqual(long);
      const top = Number.MAX_SAFE_INTEGER;
      const high: OwedMessage = { type: 'OWED', core: CORE, ranges: [[top, top]] };
      expect(k().decode(k().encode(high))).toStrictEqual(high);
    });

    it('OWED: encode refuses anything outside the grammar, and decode returns null for the same bytes built by hand', () => {
      const bad: [string, readonly (readonly [number, number])[]][] = [
        ['no ranges', []],
        ['one range too many', spaced(MAX_OWED_RANGES + 1)],
        ['one block too many', [[0, MAX_OWED_BLOCKS]]],
        [
          'the cap crossed by the sum',
          [
            [0, 511],
            [513, 1025],
          ],
        ],
        ['a range that ends before it starts', [[5, 4]]],
        [
          'overlapping',
          [
            [0, 5],
            [5, 9],
          ],
        ],
        [
          'adjacent (not canonical)',
          [
            [0, 5],
            [6, 9],
          ],
        ],
        [
          'descending',
          [
            [10, 12],
            [0, 1],
          ],
        ],
        ['a huge range (length past 2^53)', [[0, Number.MAX_SAFE_INTEGER]]],
      ];
      for (const [why, ranges] of bad) {
        expect(() => k().encode({ type: 'OWED', core: CORE, ranges }), why).toThrow();
        expect(k().decode(owedFrame(ranges)), why).toBeNull();
      }
      // Shapes only a local bug (or a peer, by hand) could produce.
      for (const ranges of [
        [[1.5, 2]],
        [[-1, 2]],
        [[0]],
        [[0, 1, 2]],
        'nope',
        null,
        [[0, Number.MAX_SAFE_INTEGER + 1]],
      ])
        expect(() => k().encode({ type: 'OWED', core: CORE, ranges } as never)).toThrow();
      expect(() =>
        k().encode({ type: 'OWED', core: 'AB'.repeat(32), ranges: [[0, 0]] } as never),
      ).toThrow();
      // A count that claims more ranges than follow, or more than the cap before anything is read.
      expect(k().decode(owedFrame([[0, 0]], 2))).toBeNull();
      expect(k().decode(owedFrame([[0, 0]], MAX_OWED_RANGES + 1))).toBeNull();
      expect(k().decode(owedFrame([[0, 0]], 2 ** 40))).toBeNull();
      // The hand-built frame decodes when it is canonical (the builder is not the reason for null).
      expect(
        k().decode(
          owedFrame([
            [0, 0],
            [2, 3],
          ]),
        ),
      ).toStrictEqual({
        type: 'OWED',
        core: CORE,
        ranges: [
          [0, 0],
          [2, 3],
        ],
      });
    });

    it('OWED: every decoded OWED is canonical, whatever the bytes (fuzz over OWED-tagged frames)', () => {
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 600 }), (tail) => {
          const buf = new Uint8Array(1 + 32 + tail.length);
          buf[0] = 5;
          buf.fill(0xab, 1, 33);
          buf.set(tail, 33);
          const { threw, out } = decodeSafely(k(), buf);
          expect(threw).toBeUndefined();
          if (out !== null) {
            expect((out as PayProtocolMessage).type).toBe('OWED');
            expect(isOwedRanges((out as OwedMessage).ranges)).toBe(true);
          }
        }),
        { numRuns: 2000 },
      );
    });

    it('PRICE.free: free:true only with no price from block 0; the flags byte is there only with `free`, and 0, 2 or unknown bits are refused', () => {
      const free: PriceMessage = {
        type: 'PRICE',
        core: CORE,
        satsPerBlock: 0 as Sats,
        effectiveFromBlock: 0,
        free: true,
      };
      expect(k().decode(k().encode(free))).toStrictEqual(free);
      expect(k().decode(priceFrame(0, 0, 3))).toStrictEqual(free);
      // `free: false` and an absent `free` are distinct, and both round-trip exactly.
      const priced = {
        type: 'PRICE',
        core: CORE,
        satsPerBlock: 3 as Sats,
        effectiveFromBlock: 9,
      } as const;
      expect(k().decode(k().encode(priced))).toStrictEqual(priced);
      expect(k().decode(k().encode({ ...priced, free: false }))).toStrictEqual({
        ...priced,
        free: false,
      });
      // Additive on the wire: with `free` absent the frame has no flags byte — exactly the v5
      // PRICE layout, so an older build reads a priced PRICE of this one, and this one reads the
      // older build's. An explicit flags byte of 0 would be a second encoding: refused.
      expect(k().encode(priced)).toEqual(priceFrame(3, 9, null));
      expect(k().decode(priceFrame(3, 9, null))).toStrictEqual(priced);
      expect(k().decode(priceFrame(3, 9, 0))).toBeNull();
      expect(k().encode({ ...priced, free: false })).toEqual(priceFrame(3, 9, 1));
      expect(k().decode(priceFrame(3, 9, 1))).toStrictEqual({ ...priced, free: false });
      expect(k().encode(free)).toEqual(priceFrame(0, 0, 3));
      // A free core with a price, or from another block: refused both ways.
      for (const [sats, from] of [
        [1, 0],
        [0, 1],
        [5, 7],
      ] as const) {
        expect(() =>
          k().encode({ ...free, satsPerBlock: sats as Sats, effectiveFromBlock: from }),
        ).toThrow();
        expect(k().decode(priceFrame(sats, from, 3))).toBeNull();
      }
      expect(() => k().encode({ ...free, free: 'yes' } as never)).toThrow();
      for (const flags of [0, 2, 4, 5, 7, 0x80, 0x81, 0xff])
        expect(k().decode(priceFrame(0, 0, flags))).toBeNull();
      // Nothing may follow the flags byte.
      const trailing = frame((s, pre) => {
        u8(s, pre, 4);
        core32(s, pre);
        u(s, pre, 0);
        u(s, pre, 0);
        u8(s, pre, 3);
        u8(s, pre, 0);
      });
      expect(k().decode(trailing)).toBeNull();
    });

    it('ACK.outstanding: present or absent round-trips exactly; a negative or fractional count is refused; unknown ACK flag bits are refused', () => {
      const base = { type: 'ACK', core: CORE, fromBlock: 0, toBlock: 3, ok: true } as const;
      for (const m of [
        base,
        { ...base, outstanding: 0 },
        { ...base, outstanding: 17 },
        { ...base, ok: false, reason: 'wrong-amount', outstanding: 4 },
        { ...base, ok: false, reason: 'range-already-paid' },
      ] as const)
        expect(k().decode(k().encode(m))).toStrictEqual(m);
      for (const outstanding of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
        expect(() => k().encode({ ...base, outstanding })).toThrow();
      const ackFrame = (flags: number, tail: number[]): Uint8Array =>
        frame((s, pre) => {
          u8(s, pre, 3);
          core32(s, pre);
          u(s, pre, 0);
          u(s, pre, 3);
          u8(s, pre, flags);
          for (const n of tail) u(s, pre, n);
        });
      expect(k().decode(ackFrame(5, [12]))).toStrictEqual({ ...base, outstanding: 12 });
      expect(k().decode(ackFrame(5, []))).toBeNull(); // the bit says a count follows
      expect(k().decode(ackFrame(8 | 1, []))).toBeNull();
      expect(k().decode(ackFrame(0x80 | 1, []))).toBeNull();
    });
  },
);

describe.skipIf(codec === undefined)(
  'pay/1 v7 amendment grammar (the end of the OWED report)',
  () => {
    const k = (): PayProtocolCodec => codec!;
    const END: OwedMessage = { type: 'OWED', core: OWED_END_CORE, ranges: [] };

    it('the end marker round-trips: tag, 32 zero bytes, a count of 0 — and nothing else', () => {
      const bytes = k().encode(END);
      expect(bytes).toEqual(endFrame([]));
      expect(bytes.byteLength).toBe(1 + 32 + 1);
      expect(k().decode(bytes)).toEqual(END);
    });

    it('refuses, both ways, the end marker with ranges and an empty report for any other core', () => {
      const withRange: OwedMessage = { type: 'OWED', core: OWED_END_CORE, ranges: [[0, 0]] };
      expect(() => k().encode(withRange)).toThrow();
      expect(k().decode(endFrame([[0, 0]]))).toBeNull();
      expect(() => k().encode({ type: 'OWED', core: CORE, ranges: [] })).toThrow();
      expect(k().decode(owedFrame([]))).toBeNull();
      // A count of 0 with ranges after it, a count with none, trailing bytes: refused.
      expect(k().decode(endFrame([[0, 0]], 0))).toBeNull();
      expect(k().decode(endFrame([], 1))).toBeNull();
      expect(k().decode(endFrame([], 0, 1))).toBeNull();
    });
  },
);
