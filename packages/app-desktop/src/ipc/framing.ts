/**
 * Host ⇄ worker framing (design §2): a 4-byte big-endian payload length, then that many
 * bytes of UTF-8 JSON. The pear-runtime/bare-sidecar IPC pipe is a byte stream with no
 * message boundaries, so every message is framed.
 *
 * Runtime-neutral: only `Uint8Array`, `DataView` and `JSON` — no `TextEncoder`/`TextDecoder`
 * (Bare 1.31 has neither), no `Buffer`, no imports from outside `src/ipc/`.
 *
 * Failure is terminal: an oversize length, invalid UTF-8, invalid JSON or a payload that is
 * not a JSON object makes the decoder throw a `FramingError` and every later `push` throws
 * the same error. There is no resynchronisation — after a bad frame the byte stream cannot be
 * trusted to be aligned, so the owner must tear the pipe down (kill the worker / exit).
 */
import { CodecError, utf8 } from './codec.js';
import type { TextCodec } from './codec.js';

/** Largest payload (bytes after the length prefix) either side accepts or produces. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const FRAME_HEADER_BYTES = 4;

export type FramingErrorCode =
  | 'frame-too-large'
  | 'frame-empty'
  | 'invalid-utf8'
  | 'invalid-json'
  | 'not-an-object'
  | 'unserialisable'
  | 'truncated';

export class FramingError extends Error {
  override readonly name = 'FramingError' as const;
  readonly code: FramingErrorCode;
  constructor(code: FramingErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export interface FramingOptions {
  /** Payload cap in bytes; default `MAX_FRAME_BYTES`, never larger. */
  readonly maxFrameBytes?: number;
  /** Text codec; default: the strict pure-TS UTF-8 codec in `./codec.ts`. */
  readonly codec?: TextCodec;
}

function capOf(opts: FramingOptions | undefined): number {
  const cap = opts?.maxFrameBytes ?? MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_FRAME_BYTES)
    throw new RangeError(`maxFrameBytes must be an integer in [1, ${MAX_FRAME_BYTES}]`);
  return cap;
}

/** Rejects values JSON would silently mangle (`Map` → `{}`, bytes → index objects). */
function strictReplacer(_key: string, value: unknown): unknown {
  if (
    value instanceof Map ||
    value instanceof Set ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  )
    throw new FramingError('unserialisable', 'Map/Set/bytes/function in a frame (use WireMap/hex)');
  return value;
}

/** One message → one frame. Throws `FramingError` for non-JSON values or an oversize payload. */
export function encodeFrame(msg: object, opts?: FramingOptions): Uint8Array {
  const cap = capOf(opts);
  let json: string | undefined;
  try {
    json = JSON.stringify(msg, strictReplacer);
  } catch (e) {
    if (e instanceof FramingError) throw e;
    throw new FramingError('unserialisable', 'value is not JSON-serialisable');
  }
  if (typeof json !== 'string' || !json.startsWith('{'))
    throw new FramingError('not-an-object', 'frames carry JSON objects only');
  const payload = (opts?.codec ?? utf8).encode(json);
  if (payload.length > cap)
    throw new FramingError('frame-too-large', `${payload.length} > ${cap} bytes`);
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Incremental decoder over arbitrary chunk splits. `push` delivers every complete message to
 * `onMessage` synchronously, in order; on a corrupt frame it throws (after delivering the
 * messages that preceded it) and stays failed.
 */
export class FrameDecoder {
  private readonly cap: number;
  private readonly codec: TextCodec;
  private readonly onMessage: (msg: unknown) => void;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  /** Payload length of the frame being assembled, once its header is complete. */
  private need: number | null = null;
  private failure: FramingError | null = null;

  constructor(onMessage: (msg: unknown) => void, opts?: FramingOptions) {
    this.onMessage = onMessage;
    this.cap = capOf(opts);
    this.codec = opts?.codec ?? utf8;
  }

  /** The error that made this decoder unusable, if any. */
  get error(): FramingError | null {
    return this.failure;
  }

  /** Bytes received but not yet delivered as a message. */
  get pendingBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): void {
    if (this.failure) throw this.failure;
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    for (;;) {
      if (this.need === null) {
        if (this.buffered < FRAME_HEADER_BYTES) return;
        const header = this.take(FRAME_HEADER_BYTES);
        const len = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
        // Checked before a single payload byte is buffered: a hostile length costs nothing.
        if (len > this.cap) this.fail('frame-too-large', `${len} > ${this.cap} bytes`);
        if (len === 0) this.fail('frame-empty', 'zero-length frame');
        this.need = len;
      }
      if (this.buffered < this.need) return;
      const payload = this.take(this.need);
      this.need = null;
      this.onMessage(this.parse(payload));
    }
  }

  /** Call when the stream ends: throws `truncated` if a partial frame is pending. */
  end(): void {
    if (this.failure) throw this.failure;
    if (this.buffered > 0 || this.need !== null)
      this.fail('truncated', `stream ended inside a frame (${this.buffered} bytes pending)`);
  }

  private parse(payload: Uint8Array): unknown {
    let text: string;
    try {
      text = this.codec.decode(payload);
    } catch (e) {
      return this.fail('invalid-utf8', e instanceof CodecError ? e.message : 'undecodable');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.fail('invalid-json', 'payload is not JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return this.fail('not-an-object', 'frames carry JSON objects only');
    return value;
  }

  private fail(code: FramingErrorCode, detail: string): never {
    this.failure = new FramingError(code, detail);
    this.chunks = [];
    this.buffered = 0;
    throw this.failure;
  }

  /** Removes and returns exactly `n` buffered bytes (caller checked `n <= buffered`). */
  private take(n: number): Uint8Array {
    const first = this.chunks[0];
    if (first === undefined) throw new RangeError('framing: buffer underflow');
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return out;
    }
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0];
      if (c === undefined) throw new RangeError('framing: buffer underflow');
      const k = Math.min(c.length, n - o);
      out.set(c.subarray(0, k), o);
      o += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.buffered -= n;
    return out;
  }
}
