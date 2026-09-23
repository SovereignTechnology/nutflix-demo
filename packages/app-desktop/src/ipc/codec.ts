/**
 * Byte ⇄ text codecs for the IPC layer that need NO globals beyond `Uint8Array`: Bare 1.31
 * has no `TextEncoder`/`TextDecoder` (verified against the bare-sidecar prebuilt, see
 * docs/lanes/L6-0.md), and `@sovit/app-desktop` declares no `b4a` dependency.
 *
 * UTF-8 decoding is STRICT (fatal): overlong forms, surrogate code points, values above
 * U+10FFFF and truncated sequences throw `CodecError` instead of becoming U+FFFD, so a
 * corrupted frame is an error rather than a silently different message. Encoding matches
 * `TextEncoder` (a lone surrogate becomes U+FFFD; `JSON.stringify` never produces one).
 */

export class CodecError extends Error {
  override readonly name = 'CodecError' as const;
  readonly code: 'invalid-utf8' | 'invalid-hex';
  constructor(code: 'invalid-utf8' | 'invalid-hex', message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** A text codec; `framing.ts` takes one so a runtime-native codec can be injected. */
export interface TextCodec {
  encode(text: string): Uint8Array;
  /** Must throw on invalid input (never substitute U+FFFD). */
  decode(bytes: Uint8Array): string;
}

export function encodeUtf8(s: string): Uint8Array {
  // Worst case 3 bytes per UTF-16 code unit.
  const out = new Uint8Array(s.length * 3);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        c = 0xfffd; // lone surrogate, as TextEncoder does
      }
    }
    if (c < 0x80) {
      out[o++] = c;
    } else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6);
      out[o++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[o++] = 0xe0 | (c >> 12);
      out[o++] = 0x80 | ((c >> 6) & 0x3f);
      out[o++] = 0x80 | (c & 0x3f);
    } else {
      out[o++] = 0xf0 | (c >> 18);
      out[o++] = 0x80 | ((c >> 12) & 0x3f);
      out[o++] = 0x80 | ((c >> 6) & 0x3f);
      out[o++] = 0x80 | (c & 0x3f);
    }
  }
  return out.slice(0, o);
}

const CHUNK = 8192;

export function decodeUtf8(b: Uint8Array): string {
  const parts: string[] = [];
  let units: number[] = [];
  const bad = (i: number): never => {
    throw new CodecError('invalid-utf8', `invalid UTF-8 at byte ${i}`);
  };
  const cont = (i: number): number => {
    const x = b[i] ?? -1;
    if ((x & 0xc0) !== 0x80) bad(i);
    return x & 0x3f;
  };
  let i = 0;
  while (i < b.length) {
    const x = b[i] ?? 0;
    let cp: number;
    if (x < 0x80) {
      cp = x;
      i += 1;
    } else if (x >= 0xc2 && x <= 0xdf) {
      cp = ((x & 0x1f) << 6) | cont(i + 1);
      i += 2;
    } else if (x >= 0xe0 && x <= 0xef) {
      const y = b[i + 1] ?? -1;
      // E0 needs A0..BF (no overlong); ED needs 80..9F (no surrogates).
      if ((x === 0xe0 && (y < 0xa0 || y > 0xbf)) || (x === 0xed && (y < 0x80 || y > 0x9f)))
        bad(i + 1);
      cp = ((x & 0x0f) << 12) | (cont(i + 1) << 6) | cont(i + 2);
      i += 3;
    } else if (x >= 0xf0 && x <= 0xf4) {
      const y = b[i + 1] ?? -1;
      // F0 needs 90..BF (no overlong); F4 needs 80..8F (≤ U+10FFFF).
      if ((x === 0xf0 && (y < 0x90 || y > 0xbf)) || (x === 0xf4 && (y < 0x80 || y > 0x8f)))
        bad(i + 1);
      cp = ((x & 0x07) << 18) | (cont(i + 1) << 12) | (cont(i + 2) << 6) | cont(i + 3);
      i += 4;
    } else {
      return bad(i);
    }
    if (cp >= 0x10000) {
      cp -= 0x10000;
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      units.push(cp);
    }
    if (units.length >= CHUNK) {
      parts.push(String.fromCharCode(...units));
      units = [];
    }
  }
  if (units.length > 0) parts.push(String.fromCharCode(...units));
  return parts.join('');
}

/** The default codec: pure TypeScript, identical under Node, Electron and Bare. */
export const utf8: TextCodec = { encode: encodeUtf8, decode: decodeUtf8 };

const HEX = '0123456789abcdef';

/** Lower-case hex (the wire form for keys, blob ids and small byte payloads). */
export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += HEX.charAt(x >> 4) + HEX.charAt(x & 15);
  return s;
}

function nibble(c: number, at: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  throw new CodecError('invalid-hex', `not lower-case hex at ${at}`);
}

/** Strict inverse of `toHex`: even length, lower-case only. */
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new CodecError('invalid-hex', 'odd length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = (nibble(s.charCodeAt(2 * i), 2 * i) << 4) | nibble(s.charCodeAt(2 * i + 1), 2 * i + 1);
  return out;
}
