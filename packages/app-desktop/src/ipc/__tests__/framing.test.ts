import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FrameDecoder, FramingError, MAX_FRAME_BYTES, encodeFrame } from '../framing.js';
import { WORKER_V } from '../worker-protocol.js';

function decodeAll(chunks: readonly Uint8Array[]): unknown[] {
  const out: unknown[] = [];
  const d = new FrameDecoder((m) => out.push(m));
  for (const c of chunks) d.push(c);
  d.end();
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Splits `bytes` at the given (sorted, deduplicated) cut points. */
function split(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let prev = 0;
  for (const p of [...points, bytes.length]) {
    out.push(bytes.subarray(prev, p));
    prev = p;
  }
  return out;
}

const header = (n: number): Uint8Array => {
  const h = new Uint8Array(4);
  new DataView(h.buffer).setUint32(0, n, false);
  return h;
};

/** JSON-safe objects (what the protocol carries). */
const jsonObject = fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 6 });

describe('framing', () => {
  it('encodes a 4-byte big-endian length then UTF-8 JSON', () => {
    const f = encodeFrame({ op: 'ev', e: 'ready', v: WORKER_V, port: 1234, s: 'é' });
    const json = '{"op":"ev","e":"ready","v":1,"port":1234,"s":"é"}';
    const bytes = new TextEncoder().encode(json);
    expect(Array.from(f.subarray(0, 4))).toEqual([0, 0, 0, bytes.length]);
    expect(f.subarray(4)).toEqual(bytes);
    expect(decodeAll([f])).toEqual([JSON.parse(json)]);
  });

  it('property: any sequence of messages survives any chunk split', () => {
    fc.assert(
      fc.property(
        fc.array(jsonObject, { maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        (msgs, cuts) => {
          const bytes = concat(msgs.map((m) => encodeFrame(m)));
          const decoded = decodeAll(split(bytes, cuts));
          expect(decoded).toEqual(JSON.parse(JSON.stringify(msgs)));
        },
      ),
      { numRuns: 400 },
    );
  });

  it('property: byte-at-a-time delivery', () => {
    fc.assert(
      fc.property(fc.array(jsonObject, { minLength: 1, maxLength: 3 }), (msgs) => {
        const bytes = concat(msgs.map((m) => encodeFrame(m)));
        const chunks = Array.from(bytes, (b) => Uint8Array.of(b));
        expect(decodeAll(chunks)).toEqual(JSON.parse(JSON.stringify(msgs)));
      }),
      { numRuns: 50 },
    );
  });

  it('works with the WHATWG TextEncoder/TextDecoder globals deleted (Bare has neither)', () => {
    const g = globalThis as { TextEncoder?: unknown; TextDecoder?: unknown };
    const saved = { TextEncoder: g.TextEncoder, TextDecoder: g.TextDecoder };
    const out: unknown[] = [];
    try {
      delete g.TextEncoder;
      delete g.TextDecoder;
      expect(typeof g.TextEncoder).toBe('undefined');
      expect(typeof g.TextDecoder).toBe('undefined');
      const msg = { op: 'req', id: 1, m: 'init', a: { s: 'héllo wörld 😀 ✓', n: [1, 2, 3] } };
      const f = encodeFrame(msg);
      const d = new FrameDecoder((m) => out.push(m));
      d.push(f.subarray(0, 3));
      d.push(f.subarray(3, 9));
      d.push(f.subarray(9));
      d.end();
      expect(out).toEqual([msg]);
    } finally {
      g.TextEncoder = saved.TextEncoder;
      g.TextDecoder = saved.TextDecoder;
    }
  });

  it('rejects an oversize length immediately, before buffering the payload', () => {
    const out: unknown[] = [];
    const d = new FrameDecoder((m) => out.push(m));
    const good = encodeFrame({ a: 1 });
    // A good frame, then a hostile header claiming 16 MiB + 1 in the same chunk.
    expect(() => {
      d.push(concat([good, header(MAX_FRAME_BYTES + 1)]));
    }).toThrow(FramingError);
    expect(out).toEqual([{ a: 1 }]);
    expect(d.error?.code).toBe('frame-too-large');
    expect(d.pendingBytes).toBe(0);
  });

  it('fails permanently: after a bad frame every push throws the same error (no resync)', () => {
    const d = new FrameDecoder(() => undefined);
    const bad = concat([header(3), Uint8Array.from([0x7b, 0x7d, 0x7d])]); // "{}}"
    expect(() => {
      d.push(bad);
    }).toThrow(/invalid-json/);
    const err = d.error;
    expect(err).toBeInstanceOf(FramingError);
    let again: unknown;
    try {
      d.push(encodeFrame({ ok: true }));
    } catch (e) {
      again = e;
    }
    expect(again).toBe(err);
    expect(() => {
      d.end();
    }).toThrow(err!);
  });

  it.each([
    ['invalid-utf8', concat([header(3), Uint8Array.from([0x7b, 0xc0, 0x7d])])],
    ['invalid-json', concat([header(1), Uint8Array.from([0x7b])])],
    ['not-an-object', concat([header(2), Uint8Array.from([0x5b, 0x5d])])], // []
    ['not-an-object', concat([header(4), Uint8Array.from([0x6e, 0x75, 0x6c, 0x6c])])], // null
    ['frame-empty', header(0)],
  ])('typed error: %s', (code, bytes) => {
    const d = new FrameDecoder(() => undefined);
    let err: unknown;
    try {
      d.push(bytes);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FramingError);
    expect((err as FramingError).code).toBe(code);
    expect((err as FramingError).message.startsWith(`${code}: `)).toBe(true);
  });

  it('end() inside a frame is `truncated`; end() on a boundary is fine', () => {
    const f = encodeFrame({ a: 1 });
    const d = new FrameDecoder(() => undefined);
    d.push(f.subarray(0, 5));
    expect(() => {
      d.end();
    }).toThrow(/truncated/);
    const ok = new FrameDecoder(() => undefined);
    ok.push(f);
    expect(() => {
      ok.end();
    }).not.toThrow();
  });

  it('encode refuses what JSON would mangle, non-objects and oversize payloads', () => {
    expect(() => encodeFrame({ m: new Map([['a', 1]]) })).toThrow(/unserialisable/);
    expect(() => encodeFrame({ b: new Uint8Array(2) })).toThrow(/unserialisable/);
    expect(() => encodeFrame({ f: () => 1 })).toThrow(/unserialisable/);
    expect(() => encodeFrame({ n: 1n })).toThrow(/unserialisable/);
    expect(() => encodeFrame([])).toThrow(/not-an-object/);
    expect(() => encodeFrame({ s: 'x'.repeat(100) }, { maxFrameBytes: 50 })).toThrow(
      /frame-too-large/,
    );
    expect(() => encodeFrame({}, { maxFrameBytes: MAX_FRAME_BYTES + 1 })).toThrow(RangeError);
  });

  it('a smaller decoder cap is honoured', () => {
    const d = new FrameDecoder(() => undefined, { maxFrameBytes: 10 });
    expect(() => {
      d.push(encodeFrame({ s: 'x'.repeat(20) }));
    }).toThrow(/frame-too-large/);
  });

  it('a JSON-parsed "__proto__" key stays an own data key (guards then reject it)', () => {
    const payload = new TextEncoder().encode('{"__proto__":{"polluted":true}}');
    const [m] = decodeAll([concat([header(payload.length), payload])]) as [object];
    expect(Object.getPrototypeOf(m)).toBe(Object.prototype);
    expect(Object.keys(m)).toEqual(['__proto__']);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('property: random garbage never escapes as anything but FramingError', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 32 }), { maxLength: 8 }), (chunks) => {
        const d = new FrameDecoder(() => undefined, { maxFrameBytes: 1024 });
        try {
          for (const c of chunks) d.push(c);
          d.end();
        } catch (e) {
          expect(e).toBeInstanceOf(FramingError);
        }
      }),
      { numRuns: 500 },
    );
  });
});
