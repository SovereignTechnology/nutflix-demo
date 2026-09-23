/**
 * `ws` WebSocket ⇄ streamx `Duplex` (spike S-B: "a WebSocket→streamx Duplex adapter is
 * the only bridge code"). One WebSocket = one Hypercore replication stream: the raw side
 * of `seeder.replicate(false)` is piped into this and this back into it.
 *
 * Semantics chosen (and tested in `__tests__/ws-duplex.test.ts`):
 *   - Every message is a binary frame carrying raw Noise bytes. A TEXT frame is a protocol
 *     violation and destroys the stream (nothing on this socket is ever text).
 *   - Write backpressure is real: `_write` completes when `ws` has flushed the frame to the
 *     socket (`send(data, cb)`), so a slow browser stalls Hypercore instead of buffering
 *     unboundedly in the gateway.
 *   - Read backpressure is real: when `push()` reports a full buffer the socket is
 *     `pause()`d and `resume()`d from `_read` — but never once the duplex is destroying.
 *     A destroyed duplex has no reader, so frames that arrive after a destroy (after a
 *     seeder-side cut the viewer keeps sending until it reads our close frame) are DROPPED.
 *     Pausing for them would stop the socket from reading the viewer's close reply, and the
 *     closing handshake would then wait out `ws`'s `closeTimeout` (30 s) — the L3-flake bug,
 *     see docs/lanes/L3-flake.md.
 *   - Destroy is GRACEFUL where possible: a seeder-side cut (spike S-A) destroys the Noise
 *     stream, which destroys this duplex; we `close()` (not `terminate()`) so the frames
 *     already handed to the socket still reach the viewer — that is what makes "the viewer
 *     holds exactly `window` blocks" hold over a real socket. The close starts in
 *     `_predestroy`, i.e. AT the destroy: streamx defers `_destroy` until an in-flight
 *     `_write` calls back, and ours calls back only once `ws` has flushed the frame — never,
 *     while the peer does not read (L3-flake F2). The close frame still queues behind every
 *     frame already handed to `ws.send`. A peer that never completes the handshake is
 *     terminated by the bridge after `WS_CLOSE_GRACE_MS` (and by `ws`'s own `closeTimeout`,
 *     30 s, when used without the bridge).
 *   - The remote closing the socket destroys the duplex, which the streamx pipeline
 *     propagates to the Noise stream, which closes the seeder's `PeerSession`.
 *
 * `streamx` is a transitive dependency of `hypercore` (lockfile 2.28.1). It is imported
 * directly here because the Hypercore side of the pipe IS a streamx stream and mixing in
 * a `node:stream` Duplex costs a compatibility shim for nothing. See docs/lanes/L3.md.
 */
import { Duplex } from 'streamx';
import type { WebSocket } from 'ws';

export interface WsDuplexOptions {
  /** streamx highWaterMark for both sides (bytes). Default 1 MiB. */
  readonly highWaterMark?: number;
}

const OPEN = 1;
const CONNECTING = 0;

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class WsDuplex extends Duplex {
  private readonly ws: WebSocket;
  private remoteClosed = false;

  constructor(ws: WebSocket, opts: WsDuplexOptions = {}) {
    super({ highWaterMark: opts.highWaterMark ?? 1024 * 1024 });
    this.ws = ws;
    ws.binaryType = 'nodebuffer';

    ws.on('message', (data, isBinary) => {
      // streamx's destroy() sets the readable highWaterMark to 0, so push() would return
      // false for every late frame and the socket would be paused for good (see above).
      if (this.destroying) return;
      if (!isBinary) {
        this.destroy(new Error('ws-duplex: text frame on a binary-only socket'));
        return;
      }
      if (!this.push(toBuffer(data))) ws.pause();
    });
    ws.on('close', () => {
      this.remoteClosed = true;
      if (!this.destroyed) this.destroy();
    });
    ws.on('error', (err) => {
      if (!this.destroyed) this.destroy(err);
    });
  }

  override _read(cb: (err: Error | null) => void): void {
    if (this.ws.isPaused) this.ws.resume();
    cb(null);
  }

  override _write(data: unknown, cb: (err: Error | null) => void): void {
    if (this.ws.readyState !== OPEN) {
      cb(new Error('ws-duplex: socket not open'));
      return;
    }
    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null;
    if (buf === null) {
      cb(new Error('ws-duplex: non-binary write'));
      return;
    }
    this.ws.send(buf, { binary: true }, (err) => {
      cb(err ?? null);
    });
  }

  override _final(cb: (err: Error | null) => void): void {
    if (this.ws.readyState === OPEN) this.ws.close(1000);
    cb(null);
  }

  override _predestroy(): void {
    this.closeSocket();
  }

  override _destroy(cb: (err: Error | null) => void): void {
    this.closeSocket(); // idempotent; `_predestroy` has normally done it already
    cb(null);
  }

  /** Start the closing handshake (see the module comment). Idempotent. */
  private closeSocket(): void {
    // A socket paused for read backpressure never sees the peer's close frame; let it
    // flow again (frames arriving now are dropped, see `message`) so the handshake completes.
    if (this.ws.isPaused) this.ws.resume();
    if (this.remoteClosed) return;
    const state = this.ws.readyState;
    if (state === OPEN) this.ws.close(1000);
    else if (state === CONNECTING) this.ws.terminate();
  }
}
