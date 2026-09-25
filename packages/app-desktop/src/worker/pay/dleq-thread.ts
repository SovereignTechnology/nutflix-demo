/**
 * DLEQ checks off the worker's event loop (security review F5, desktop half; issue #8 d). The
 * seeder daemon and the gateway run them on a `worker_threads` pool (`@sovit/seeder`'s
 * `DleqPool`); the desktop worker runs under Bare, which has no `worker_threads`. It has
 * `Bare.Thread` — a JavaScript entry point on its own OS thread, with its own isolate — and V8's
 * `SharedArrayBuffer` + `Atomics`, which is all this needs: no addon, no channel package.
 *
 *   mailbox   one SharedArrayBuffer: an Int32 control word pair [state, length] and a data area.
 *             The worker writes a job (JSON: the checks), sets REQ and notifies; the thread, parked
 *             in `Atomics.wait`, runs core's `proofDleqOk` on each (the engine's own rule, cashu-ts
 *             underneath), writes the answers (JSON booleans), sets RES and notifies; the worker
 *             is woken by `Atomics.waitAsync` — its event loop never blocks.
 *   one job   at a time, in order (a queue). A batch too large for the data area is split.
 *
 * Failure is never acceptance: a thread that does not start, answers FAIL, answers the wrong
 * count, or does not answer within `timeoutMs` rejects the job — and `dleqVerifier` then checks
 * inline, in small chunks that yield to the event loop between them (bounded work per turn), so a
 * broken thread costs latency, never a verdict and never a long stall. A stuck thread is
 * terminated and replaced once; a second failure to start leaves the chunked path on for good.
 *
 * The thread is started on the first job, not at init: a viewer that seeds nothing never pays for
 * a second isolate. Nothing here logs a proof; the thread logs nothing at all.
 */
import type { payment } from '@sovit/core';

import type { Logger } from '@sovit/seeder';

// The shared codec, not TextEncoder/TextDecoder: Bare has neither (D6), and this module also
// loads in the thread.
import { utf8 } from '../../ipc/codec.js';

/** What the runtime gives us: start a thread on the mailbox, and stop it. */
export interface DleqThreadHandle {
  /** Stop the thread as soon as possible. */
  terminate(): void;
  /** Wait for it to exit (blocking under Bare; call after `terminate` or QUIT). */
  join(): void;
}

/** Start the DLEQ thread over `mailbox`; `null` when this runtime cannot. */
export type SpawnDleqThread = (mailbox: SharedArrayBuffer) => DleqThreadHandle | null;

/** Mailbox states (the control word). */
export const MAILBOX = {
  BOOT: 0,
  IDLE: 1,
  REQ: 2,
  RES: 3,
  QUIT: 4,
  FAIL: 5,
} as const;
/** Control words, then the data area. */
export const MAILBOX_HEADER_BYTES = 16;
/** The data area: a whole PAY (≤ 128 proofs, ~90 KB of JSON) many times over. */
export const MAILBOX_DATA_BYTES = 1024 * 1024;
/** A thread that has not said it is ready in this long is given up. */
export const DLEQ_THREAD_START_MS = 15_000;
/** A job not answered in this long is failed (and checked inline instead). */
export const DLEQ_THREAD_JOB_MS = 30_000;
/**
 * Proofs checked per event-loop turn on the inline path (~5 ms a proof under Bare's JIT, measured
 * 4.7 ms: two proofs ≈ 10 ms, then the loop turns).
 */
export const DLEQ_INLINE_CHUNK = 2;

type Check = payment.DleqCheck;
type Verify = (proof: Check['proof'], keyset: Check['keyset']) => boolean;

/** `Atomics.waitAsync` (ES2024; in V8 under Bare and Node, typed here: the lib is ES2023). */
type WaitAsync = (
  a: Int32Array,
  index: number,
  value: number,
  timeoutMs?: number,
) =>
  | { readonly async: false; readonly value: 'not-equal' | 'timed-out' }
  | { readonly async: true; readonly value: Promise<'ok' | 'timed-out'> };

/** Wait until the control word leaves `from`, or `ms` pass. `true` when it changed. */
async function waitChange(ctl: Int32Array, from: number, ms: number): Promise<boolean> {
  const waitAsync = (Atomics as unknown as { readonly waitAsync: WaitAsync }).waitAsync;
  const r = waitAsync(ctl, 0, from, ms);
  const v = r.async ? await r.value : r.value;
  return v !== 'timed-out' || Atomics.load(ctl, 0) !== from;
}

/**
 * One DLEQ thread behind a mailbox. `verify` answers `proofDleqOk` for each check, in order, or
 * rejects.
 */
export class DleqThread {
  private readonly spawn: SpawnDleqThread;
  private readonly startMs: number;
  private readonly jobMs: number;
  private readonly dataBytes: number;
  private mailbox: SharedArrayBuffer | null = null;
  private handle: DleqThreadHandle | null = null;
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Starts that failed; at two the thread is off for good. */
  private failedStarts = 0;
  private closed = false;

  constructor(o: {
    readonly spawn: SpawnDleqThread;
    readonly startMs?: number;
    readonly jobMs?: number;
    readonly dataBytes?: number;
  }) {
    this.spawn = o.spawn;
    this.startMs = o.startMs ?? DLEQ_THREAD_START_MS;
    this.jobMs = o.jobMs ?? DLEQ_THREAD_JOB_MS;
    this.dataBytes = o.dataBytes ?? MAILBOX_DATA_BYTES;
  }

  /** False once closed, or once the thread failed to start twice. */
  get usable(): boolean {
    return !this.closed && this.failedStarts < 2;
  }

  verify(checks: readonly Check[]): Promise<boolean[]> {
    const run = this.queue.then(() => this.run(checks));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Ask the thread to quit, stop it, and wait for it. Idempotent. */
  close(): void {
    this.closed = true;
    this.retire();
  }

  private async run(checks: readonly Check[]): Promise<boolean[]> {
    if (!this.usable) throw new Error('DLEQ thread unavailable');
    if (checks.length === 0) return [];
    const body = utf8.encode(JSON.stringify(checks));
    if (body.length > this.dataBytes) {
      if (checks.length === 1) throw new Error('DLEQ check too large for the mailbox');
      const half = Math.ceil(checks.length / 2);
      return [...(await this.run(checks.slice(0, half))), ...(await this.run(checks.slice(half)))];
    }
    await this.ensureStarted();
    const box = this.mailbox;
    if (box === null) throw new Error('DLEQ thread unavailable');
    const ctl = new Int32Array(box, 0, 2);
    const data = new Uint8Array(box, MAILBOX_HEADER_BYTES);
    data.set(body, 0);
    Atomics.store(ctl, 1, body.length);
    Atomics.store(ctl, 0, MAILBOX.REQ);
    Atomics.notify(ctl, 0);
    const answered = await waitChange(ctl, MAILBOX.REQ, this.jobMs);
    const state = Atomics.load(ctl, 0);
    if (!answered || state !== MAILBOX.RES) {
      // Stuck, dead or failed: this job fails (checked inline); a stuck thread is replaced.
      if (state === MAILBOX.FAIL) Atomics.store(ctl, 0, MAILBOX.IDLE);
      else this.retire();
      throw new Error(answered ? 'DLEQ thread failed the job' : 'DLEQ thread timed out');
    }
    const len = Atomics.load(ctl, 1);
    let out: unknown;
    try {
      out = len > 0 && len <= this.dataBytes ? JSON.parse(utf8.decode(data.slice(0, len))) : null;
    } catch {
      out = null;
    }
    Atomics.store(ctl, 0, MAILBOX.IDLE);
    if (!Array.isArray(out) || out.length !== checks.length)
      throw new Error('DLEQ thread answered the wrong count');
    return out.map((x) => x === true);
  }

  private ensureStarted(): Promise<void> {
    if (this.handle !== null && this.mailbox !== null) return Promise.resolve();
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const box = new SharedArrayBuffer(MAILBOX_HEADER_BYTES + this.dataBytes);
    const ctl = new Int32Array(box, 0, 2);
    let handle: DleqThreadHandle | null;
    try {
      handle = this.spawn(box);
    } catch {
      handle = null;
    }
    if (handle === null) {
      this.failedStarts = 2; // this runtime cannot: never try again
      throw new Error('DLEQ thread unavailable');
    }
    this.handle = handle;
    this.mailbox = box;
    const ready = await waitChange(ctl, MAILBOX.BOOT, this.startMs);
    if (!ready || Atomics.load(ctl, 0) !== MAILBOX.IDLE) {
      this.failedStarts++;
      this.retire();
      throw new Error('DLEQ thread did not start');
    }
  }

  /** Stop the current thread (a new one starts on the next job, unless closed). */
  private retire(): void {
    const h = this.handle;
    const box = this.mailbox;
    this.handle = null;
    this.mailbox = null;
    if (box !== null) {
      const ctl = new Int32Array(box, 0, 2);
      Atomics.store(ctl, 0, MAILBOX.QUIT);
      Atomics.notify(ctl, 0);
    }
    if (h === null) return;
    try {
      h.terminate();
      h.join();
    } catch {
      // already gone
    }
  }
}

/**
 * The thread side: serve `mailbox` with `verify` until told to quit. Never throws — under Bare an
 * exception that escapes a thread aborts the WHOLE worker process — so every failure is an answer.
 */
export function serveDleqMailbox(mailbox: SharedArrayBuffer, verify: Verify): void {
  const ctl = new Int32Array(mailbox, 0, 2);
  const data = new Uint8Array(mailbox, MAILBOX_HEADER_BYTES);
  let last: number = MAILBOX.IDLE;
  Atomics.store(ctl, 0, MAILBOX.IDLE);
  Atomics.notify(ctl, 0);
  for (;;) {
    Atomics.wait(ctl, 0, last);
    const st = Atomics.load(ctl, 0);
    if (st === MAILBOX.QUIT) return;
    if (st !== MAILBOX.REQ) {
      last = st;
      continue;
    }
    let answer: Uint8Array | null = null;
    try {
      const len = Atomics.load(ctl, 1);
      const job: unknown = JSON.parse(utf8.decode(data.slice(0, len)));
      if (Array.isArray(job)) {
        const results = job.map((c: Partial<Check> | null) => {
          try {
            return c?.proof !== undefined && c.keyset !== undefined && verify(c.proof, c.keyset);
          } catch {
            return false;
          }
        });
        answer = utf8.encode(JSON.stringify(results));
        if (answer.length > data.length) answer = null;
      }
    } catch {
      answer = null;
    }
    if (answer === null) {
      last = MAILBOX.FAIL;
      Atomics.store(ctl, 0, MAILBOX.FAIL);
    } else {
      data.set(answer, 0);
      Atomics.store(ctl, 1, answer.length);
      last = MAILBOX.RES;
      Atomics.store(ctl, 0, MAILBOX.RES);
    }
    Atomics.notify(ctl, 0);
  }
}

/**
 * Check inline, `chunk` proofs per event-loop turn (the fallback, and the only path where no
 * thread can run). The same rule; bounded work per turn instead of one long stall.
 */
export async function chunkedDleq(
  checks: readonly Check[],
  verify: Verify,
  chunk: number = DLEQ_INLINE_CHUNK,
): Promise<boolean[]> {
  const out: boolean[] = [];
  const step = Math.max(1, Math.floor(chunk));
  for (let i = 0; i < checks.length; i += step) {
    if (i > 0) await new Promise<void>((r) => setTimeout(r, 0));
    for (const c of checks.slice(i, i + step)) {
      try {
        out.push(verify(c.proof, c.keyset));
      } catch {
        out.push(false);
      }
    }
  }
  return out;
}

export interface DleqVerifier {
  /** `PaymentEngineDeps.dleq`. */
  readonly verify: (checks: readonly Check[]) => Promise<boolean[]>;
  close(): void;
}

/**
 * `PaymentEngineDeps.dleq` for the worker: the thread when there is one, else (or when it fails)
 * chunked inline checks. It never rejects for a thread failure, so the engine's own fallback —
 * one synchronous pass over every proof — does not run on this event loop.
 */
export function dleqVerifier(o: {
  readonly spawn: SpawnDleqThread | undefined;
  readonly verify: Verify;
  readonly logger?: Logger;
  readonly chunk?: number;
  readonly startMs?: number;
  readonly jobMs?: number;
}): DleqVerifier {
  const thread =
    o.spawn === undefined
      ? null
      : new DleqThread({
          spawn: o.spawn,
          ...(o.startMs === undefined ? {} : { startMs: o.startMs }),
          ...(o.jobMs === undefined ? {} : { jobMs: o.jobMs }),
        });
  let warned = false;
  return {
    verify: async (checks) => {
      if (thread?.usable === true) {
        try {
          return await thread.verify(checks);
        } catch {
          if (!warned) {
            warned = true;
            o.logger?.warn('the DLEQ thread failed: checks run inline, in small chunks');
          }
        }
      }
      return chunkedDleq(checks, o.verify, o.chunk);
    },
    close: () => {
      thread?.close();
    },
  };
}
