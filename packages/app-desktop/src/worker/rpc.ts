/**
 * The worker's side of the host ⇄ worker wire (design §2 "Host ⇄ worker", L6-0's
 * `ipc/framing.ts` + `ipc/worker-guards.ts`). Runtime-neutral: it is handed a `write`
 * function and fed raw chunks, so tests drive it directly and the Bare entry wires it to
 * `Bare.IPC`.
 *
 *   - every decoded frame goes through `isHostToWorker` (a request with valid arguments, or a
 *     response); junk is refused — a request-shaped frame with a usable `id` gets an
 *     `invalid-argument` response, anything else is dropped — and never reaches the handler;
 *   - requests run concurrently up to `maxInflight` (then `rate-limited`); a handler failure
 *     becomes a `WireError` via `toWireError` (known codes kept, everything else `internal`);
 *     a result that fails `validateWorkerResult[m]` is replaced by an `internal` error (the
 *     host would drop it anyway);
 *   - the `ready` event follows a successful `init` response;
 *   - outgoing events are checked with `validateWorkerEvent` and dropped if invalid;
 *   - worker → host requests (`studio.publish`) are checked with `validateHostArgs[m]`
 *     before they leave, numbered, bounded in time, and their results checked with
 *     `validateHostResult[m]`;
 *   - a corrupt stream (`FramingError`) is terminal: `onFatal`, no resync (the entry exits 3).
 *
 * `push()` never throws.
 */
import type { Guard } from '../ipc/protocol.js';
import { fromWireError, toWireError, wireError } from '../ipc/errors.js';
import { FrameDecoder, FramingError, encodeFrame } from '../ipc/framing.js';
import {
  isHostToWorker,
  validateHostArgs,
  validateHostResult,
  validateWorkerEvent,
  validateWorkerResult,
} from '../ipc/worker-guards.js';
import type { HostMethod, HostMethodTable, WorkerEvent } from '../ipc/worker-protocol.js';
import type { WorkerRequest } from './host.js';

export interface WorkerRpcHandler {
  handle(req: WorkerRequest): Promise<unknown>;
  readyEvent(): WorkerEvent;
}

export interface WorkerRpcOptions {
  /** Bytes to the host (one frame per call). */
  readonly write: (bytes: Uint8Array) => void;
  readonly handler: WorkerRpcHandler;
  /** The stream is corrupt: tear the process down (no resync). */
  readonly onFatal: (err: FramingError) => void;
  /** Concurrent host requests in flight (default 64). */
  readonly maxInflight?: number;
  /** Worker → host request deadline in ms (default 5 min: publishing goes to relays). */
  readonly requestTimeoutMs?: number;
}

export interface WorkerRpcStats {
  readonly requests: number;
  readonly refused: number;
  readonly droppedEvents: number;
  readonly droppedFrames: number;
}

interface Pending {
  readonly m: HostMethod;
  readonly resolve: (r: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const MAX_MSG_ID = 0x7fffffff;

function usableId(x: unknown): number | null {
  if (typeof x !== 'object' || x === null) return null;
  let id: unknown;
  let op: unknown;
  try {
    id = (x as { id?: unknown }).id;
    op = (x as { op?: unknown }).op;
  } catch {
    return null;
  }
  return op === 'req' && Number.isInteger(id) && (id as number) >= 0 && (id as number) <= MAX_MSG_ID
    ? (id as number)
    : null;
}

export class WorkerRpc {
  private readonly o: WorkerRpcOptions;
  private readonly decoder: FrameDecoder;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private inflight = 0;
  private dead = false;
  private readonly counters = { requests: 0, refused: 0, droppedEvents: 0, droppedFrames: 0 };

  constructor(o: WorkerRpcOptions) {
    this.o = o;
    this.decoder = new FrameDecoder((msg) => {
      this.onMessage(msg);
    });
  }

  stats(): WorkerRpcStats {
    return { ...this.counters };
  }

  /** Raw bytes from the host. Never throws. */
  push(chunk: Uint8Array): void {
    if (this.dead) return;
    try {
      this.decoder.push(chunk);
    } catch (err) {
      this.die(
        err instanceof FramingError ? err : new FramingError('invalid-json', 'decode failed'),
      );
    }
  }

  /** The pipe ended: a partial frame is corrupt; pending requests fail. */
  end(): void {
    if (this.dead) return;
    try {
      this.decoder.end();
    } catch (err) {
      this.die(err instanceof FramingError ? err : new FramingError('truncated', 'stream ended'));
      return;
    }
    this.failPending('backend-down', 'host pipe closed');
  }

  /** Send an event (dropped if it would fail the host's guard). */
  emit(ev: WorkerEvent): void {
    const g = validateWorkerEvent[ev.e] as Guard<unknown>;
    if (!g(ev)) {
      this.counters.droppedEvents++;
      return;
    }
    this.send(ev);
  }

  /** A worker → host request (`studio.publish`); arguments the host would refuse fail here. */
  request<M extends HostMethod>(m: M, a: HostMethodTable[M][0]): Promise<HostMethodTable[M][1]> {
    if (this.dead)
      return Promise.reject(fromWireError(wireError('backend-down', 'host pipe closed')));
    if (!(validateHostArgs[m] as Guard<unknown>)(a))
      return Promise.reject(
        fromWireError(wireError('invalid-argument', `${m} arguments are invalid`)),
      );
    const id = this.nextId;
    this.nextId = this.nextId >= MAX_MSG_ID ? 1 : this.nextId + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id))
          reject(fromWireError(wireError('backend-down', `host did not answer ${m} in time`)));
      }, this.o.requestTimeoutMs ?? 300_000);
      this.pending.set(id, {
        m,
        resolve: resolve as (r: unknown) => void,
        reject,
        timer,
      });
      if (!this.send({ op: 'req', id, m, a })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(fromWireError(wireError('invalid-argument', `${m} arguments are not serialisable`)));
      }
    });
  }

  private onMessage(msg: unknown): void {
    if (!isHostToWorker(msg)) {
      const id = usableId(msg);
      this.counters.refused++;
      if (id === null) {
        this.counters.droppedFrames++;
        return;
      }
      this.send({
        op: 'res',
        id,
        ok: false,
        e: wireError('invalid-argument', 'message failed validation'),
      });
      return;
    }
    if (msg.op === 'res') {
      const p = this.pending.get(msg.id);
      if (p === undefined) {
        this.counters.droppedFrames++;
        return;
      }
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (!msg.ok) {
        p.reject(fromWireError(msg.e));
        return;
      }
      const g = validateHostResult[p.m] as Guard<unknown>;
      if (g(msg.r)) p.resolve(msg.r);
      else
        p.reject(
          fromWireError(wireError('invalid-argument', `host returned an invalid ${p.m} result`)),
        );
      return;
    }
    this.counters.requests++;
    const max = this.o.maxInflight ?? 64;
    if (this.inflight >= max) {
      this.send({
        op: 'res',
        id: msg.id,
        ok: false,
        e: wireError('rate-limited', 'too many requests in flight'),
      });
      return;
    }
    this.inflight++;
    const req = msg;
    void this.o.handler
      .handle(req)
      .then(
        (r) => {
          const g = validateWorkerResult[req.m] as Guard<unknown>;
          if (!g(r)) {
            this.send({ op: 'res', id: req.id, ok: false, e: toWireError(new Error('internal')) });
            return;
          }
          const sent =
            r === undefined
              ? this.send({ op: 'res', id: req.id, ok: true })
              : this.send({ op: 'res', id: req.id, ok: true, r });
          if (!sent) {
            this.send({ op: 'res', id: req.id, ok: false, e: toWireError(new Error('internal')) });
            return;
          }
          if (req.m === 'init') this.emit(this.o.handler.readyEvent());
        },
        (err: unknown) => {
          this.send({ op: 'res', id: req.id, ok: false, e: toWireError(err) });
        },
      )
      .finally(() => {
        this.inflight--;
      });
  }

  /** Frame and write; `false` when the message could not be framed. */
  private send(msg: object): boolean {
    if (this.dead) return false;
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(msg);
    } catch {
      return false;
    }
    try {
      this.o.write(bytes);
    } catch {
      return false;
    }
    return true;
  }

  private die(err: FramingError): void {
    if (this.dead) return;
    this.failPending('backend-down', 'host pipe corrupt');
    this.dead = true;
    this.o.onFatal(err);
  }

  private failPending(code: 'backend-down', detail: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(fromWireError(wireError(code, detail)));
    }
  }
}
