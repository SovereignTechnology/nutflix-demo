import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CodecError, decodeUtf8, encodeUtf8, fromHex, toHex } from '../codec.js';

// Node's WHATWG codecs are the oracle; the module under test must not use them (Bare has none).
const oracleEnc = new TextEncoder();
const oracleDec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Any UTF-16 string, lone surrogates included. */
const anyUtf16 = fc.string({
  unit: fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)),
});

describe('UTF-8 codec (no TextEncoder/TextDecoder)', () => {
  it('encodes exactly like TextEncoder, lone surrogates included', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary' }), anyUtf16), (s) => {
        expect(encodeUtf8(s)).toEqual(oracleEnc.encode(s));
      }),
      { numRuns: 1000 },
    );
  });

  it('round-trips every well-formed string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(decodeUtf8(encodeUtf8(s))).toBe(s);
      }),
      { numRuns: 1000 },
    );
  });

  it('decodes random bytes exactly like a fatal TextDecoder (same accept/reject, same text)', () => {
    const bytes = fc.oneof(
      fc.uint8Array({ maxLength: 64 }),
      // bias towards multi-byte lead/continuation bytes
      fc
        .array(
          fc.constantFrom(
            0x41,
            0x80,
            0xbf,
            0xc2,
            0xdf,
            0xe0,
            0xed,
            0xef,
            0xf0,
            0xf4,
            0xf5,
            0xff,
            0xa0,
            0x9f,
            0x90,
            0x8f,
          ),
          { maxLength: 16 },
        )
        .map((a) => Uint8Array.from(a)),
    );
    fc.assert(
      fc.property(bytes, (b) => {
        let expected: string | undefined;
        try {
          expected = oracleDec.decode(b);
        } catch {
          expected = undefined;
        }
        if (expected === undefined) expect(() => decodeUtf8(b)).toThrow(CodecError);
        else expect(decodeUtf8(b)).toBe(expected);
      }),
      { numRuns: 3000 },
    );
  });

  it('rejects the classic malformed sequences', () => {
    for (const bad of [
      [0xc0, 0x80], // overlong NUL
      [0xe0, 0x80, 0x80], // overlong
      [0xed, 0xa0, 0x80], // UTF-16 surrogate D800
      [0xf4, 0x90, 0x80, 0x80], // > U+10FFFF
      [0xe2, 0x82], // truncated
      [0x80], // lone continuation
      [0xff],
    ])
      expect(() => decodeUtf8(Uint8Array.from(bad))).toThrow(/invalid-utf8/);
  });

  it('handles large inputs (chunked String.fromCharCode)', () => {
    const s = 'aé€😀'.repeat(50_000);
    expect(decodeUtf8(encodeUtf8(s))).toBe(s);
  });
});

describe('hex', () => {
  it('round-trips and matches Buffer', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (b) => {
        const h = toHex(b);
        expect(h).toBe(Buffer.from(b).toString('hex'));
        expect(fromHex(h)).toEqual(b);
      }),
    );
  });

  it('is strict', () => {
    for (const bad of ['a', 'AB', 'zz', '0x00', 'ab '])
      expect(() => fromHex(bad)).toThrow(/invalid-hex/);
    expect(fromHex('')).toEqual(new Uint8Array(0));
  });
});
