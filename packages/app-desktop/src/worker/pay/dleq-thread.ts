/**
 * DLEQ checks off the worker's event loop (security review F5, desktop half; issue #8 d). The
 * seeder daemon and the gateway run them on a `worker_threads` pool (`@sovit/seeder`'s
 * `DleqPool`); the desktop worker runs under Bare, which has no `worker_threads`. It has
 * `Bare.Thread` — a JavaScript entry point on its own OS thread, with its own isolate — and V8's
 * `SharedArrayBuffer` + `Atomics`, which is all this needs: no addon, no channel package.
 *
 *   mailbox   one SharedArrayBuffer: Int32 control words [state, length, exited] and a data
 *             area. The worker writes a job (JSON: the checks), sets REQ and notifies; the thread,
 *             parked in `Atomics.wait`, runs core's `proofDleqOk` on each (the engine's own rule,
 *             cashu-ts underneath), writes the answers (JSON booleans), sets RES and notifies; the
 *             worker is woken by `Atomics.waitAsync` — its event loop never blocks.
 *   one job   at a time, in order (a queue). A batch too large for the data area is split.
 *
 * Failure is never acceptance: a thread that does not start, answers FAIL, answers the wrong
 * count, or does not answer within `jobMs` rejects the job — and `dleqVerifier` then checks
 * inline, in small chunks that yield to the event loop between them (bounded work per turn), so a
 * broken thread costs latency, never a verdict and never a long stall. A thread given up on is
 * retired and a new one starts on the next job; a second failure to start leaves the chunked path
 * on for good.
 *
 * Retiring never blocks the event loop (issue #8 review, finding 2). Under Bare, `terminate()`
 * interrupts neither a busy thread nor one parked in `Atomics.wait`, and `join()` blocks until the
 * thread's JavaScript returns (measured on Bare 1.31). So a thread is stopped by the mailbox
 * alone: the worker sets QUIT, and the thread moves the state word only by `compareExchange` from
 * the state it expects (BOOT → IDLE, REQ → RES/FAIL), so a QUIT is never overwritten — it sees it
 * after its boot or its job, and returns, setting the `exited` word. The worker joins a retired
 * thread only once that word is set (the join is then immediate), and lets go of one that does
 * not set it in `reapMs` (it exits by itself when its job ends).
 *
 * The thread is started on the first job, not at init: a viewer that seeds nothing never pays for
 * a second isolate. Verification never waits for it to start: until it is up (a few hundred ms)
 * the checks run on the chunked path. Nothing here logs a proof; the thread logs nothing at all.
 */
import type { payment } from '@sovit/core';

import type { Logger } from '@sovit/seeder';

// The shared codec, not TextEncoder/TextDecoder: Bare has neither (D6), and this module also
// loads in the thread.
import { utf8 } from '../../ipc/codec.js';

/** What the runtime gives us: start a thread on the mailbox, and stop it. */
export interface DleqThreadHandle {
  /** Ask the runtime to stop the thread. Never blocks; under Bare it cannot stop a busy thread. */
  terminate(): void;
  /**
   * Wait for the thread to exit. BLOCKING under Bare, for as long as the thread's JavaScript
   * runs: called only once the thread has set the `exited` word.
   */
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
/** The control words: the state, the data length, and the thread's "I am leaving" flag. */
export const WORD = { STATE: 0, LENGTH: 1, EXITED: 2 } as const;
/** How many control words there are (the header has room for four). */
export const MAILBOX_WORDS = 3;
/** Control words, then the data area. */
export const MAILBOX_HEADER_BYTES = 16;
/** The data area: a whole PAY (≤ 128 proofs, ~90 KB of JSON) many times over. */
export const MAILBOX_DATA_BYTES = 1024 * 1024;
/** A thread that has not said it is ready in this long is given up. */
export const DLEQ_THREAD_START_MS = 15_000;
/** A job not answered in this long is failed (and checked inline instead). */
export const DLEQ_THREAD_JOB_MS = 30_000;
/**
 * A retired thread that has not said it is leaving in this long is let go without a join (a
 * thread busy with a job it was given up on finishes the job first).
 */
export const DLEQ_THREAD_REAP_MS = 60_000;
/**
 * Proofs checked per event-loop turn on the inline path (~5 ms a proof under Bare's JIT, measured
 * 4.7 ms: two proofs ≈ 10 ms, then the loop turns).
 */
export const DLEQ_INLINE_CHUNK = 2;

type Check = payment.DleqCheck;
type Verify = (proof: Check['proof'], keyset: Check['keyset']) => boolean;

/**
 * A timeout option: a finite number of milliseconds ≥ 0, else `dflt`. NaN would wait for ever
 * (`Atomics.waitAsync` reads it as +∞); 0 gives up at once, which only ever means the chunked path.
 */
export function timeoutOption(v: number | undefined, dflt: number): number {
  return v !== undefined && Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** `Atomics.waitAsync` (ES2024; in V8 under Bare and Node, typed here: the lib is ES2023). */
type WaitAsync = (
  a: Int32Array,
  index: number,
  value: number,
  timeoutMs?: number,
) =>
  | { readonly async: false; readonly value: 'not-equal' | 'timed-out' }
  | { readonly async: true; readonly value: Promise<'ok' | 'timed-out'> };

/** Wait until control word `index` leaves `from`, or `ms` pass. `true` when it changed. */
async function waitWord(
  ctl: Int32Array,
  index: number,
  from: number,
  ms: number,
): Promise<boolean> {
  const waitAsync = (Atomics as unknown as { readonly waitAsync: WaitAsync }).waitAsync;
  const r = waitAsync(ctl, index, from, ms);
  const v = r.async ? await r.value : r.value;
  return v !== 'timed-out' || Atomics.load(ctl, index) !== from;
}

/** Wait until the state word leaves `from`, or `ms` pass. `true` when it changed. */
function waitChange(ctl: Int32Array, from: number, ms: number): Promise<boolean> {
  return waitWord(ctl, WORD.STATE, from, ms);
}

/**
 * One DLEQ thread behind a mailbox. `verify` answers `proofDleqOk` for each check, in order, or
 * rejects.
 */
export class DleqThread {
  private readonly spawn: SpawnDleqThread;
  private readonly startMs: number;
  private readonly jobMs: number;
  private readonly reapMs: number;
  private readonly dataBytes: number;
  private mailbox: SharedArrayBuffer | null = null;
  private handle: DleqThreadHandle | null = null;
  private starting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Starts that failed; at two the thread is off for good. */
  private failedStarts = 0;
  private closed = false;
  /** Retired threads not yet joined or let go. */
  private readonly reaping = new Set<Promise<void>>();
  private readonly reaped = { joined: 0, abandoned: 0 };

  constructor(o: {
    readonly spawn: SpawnDleqThread;
    readonly startMs?: number;
    readonly jobMs?: number;
    readonly reapMs?: number;
    readonly dataBytes?: number;
  }) {
    this.spawn = o.spawn;
    this.startMs = timeoutOption(o.startMs, DLEQ_THREAD_START_MS);
    this.jobMs = timeoutOption(o.jobMs, DLEQ_THREAD_JOB_MS);
    this.reapMs = timeoutOption(o.reapMs, DLEQ_THREAD_REAP_MS);
    const d = o.dataBytes;
    this.dataBytes = d !== undefined && Number.isSafeInteger(d) && d > 0 ? d : MAILBOX_DATA_BYTES;
  }

  /** False once closed, or once the thread failed to start twice. */
  get usable(): boolean {
    return !this.closed && this.failedStarts < 2;
  }

  /** True while a thread is up and serving (started, not retired). */
  get started(): boolean {
    return this.handle !== null && this.mailbox !== null && this.starting === null;
  }

  /** The checks on the thread, waiting for it to start if need be. */
  verify(checks: readonly Check[]): Promise<boolean[]> {
    const run = this.queue.then(() => this.run(checks));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The checks on the thread if it is up; otherwise `null` — and a start is begun in the
   * background, so a later job finds it (the caller checks this one elsewhere, now).
   */
  tryVerify(checks: readonly Check[]): Promise<boolean[]> | null {
    if (!this.usable) return null;
    if (this.started) return this.verify(checks);
    // A retired thread is still leaving (its job outlived `jobMs`, or its start `startMs`): no
    // second thread beside it. On a starved CPU each new one would slow the next job past its
    // timeout too, and they would pile up. The chunked path answers until it is gone.
    if (this.reaping.size > 0) return null;
    if (this.starting === null) void this.ensureStarted().catch(() => undefined);
    return null;
  }

  /** Resolves once the start in progress (if any) is over: `true` when a thread is up. */
  async ready(): Promise<boolean> {
    await this.starting?.catch(() => undefined);
    return this.started;
  }

  /** Retired threads so far: joined once they said they were leaving, or let go (tests). */
  get reaps(): { readonly joined: number; readonly abandoned: number } {
    return { ...this.reaped };
  }

  /**
   * Ask the thread to quit. Never blocks the event loop; resolves once every retired thread is
   * joined or let go. Idempotent.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.retire();
    await Promise.all([...this.reaping]);
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
    // A retired thread is still leaving and none is up: no new one beside it — here too, not only
    // in `tryVerify`, since jobs queued while a thread was up reach this after it was retired (fix
    // round 2). The caller checks this job on the chunked path.
    if (this.handle === null && this.reaping.size > 0)
      throw new Error('DLEQ thread unavailable: a retired thread is still leaving');
    await this.ensureStarted();
    const box = this.mailbox;
    if (box === null) throw new Error('DLEQ thread unavailable');
    const ctl = new Int32Array(box, 0, MAILBOX_WORDS);
    const data = new Uint8Array(box, MAILBOX_HEADER_BYTES);
    data.set(body, 0);
    Atomics.store(ctl, WORD.LENGTH, body.length);
    Atomics.store(ctl, WORD.STATE, MAILBOX.REQ);
    Atomics.notify(ctl, WORD.STATE);
    const answered = await waitChange(ctl, MAILBOX.REQ, this.jobMs);
    const state = Atomics.load(ctl, WORD.STATE);
    if (!answered || state !== MAILBOX.RES) {
      // Stuck, dead or failed: this job fails (checked inline); a stuck thread is retired.
      if (state === MAILBOX.FAIL) Atomics.store(ctl, WORD.STATE, MAILBOX.IDLE);
      else this.retire();
      throw new Error(answered ? 'DLEQ thread failed the job' : 'DLEQ thread timed out');
    }
    const len = Atomics.load(ctl, WORD.LENGTH);
    let out: unknown;
    try {
      out = len > 0 && len <= this.dataBytes ? JSON.parse(utf8.decode(data.slice(0, len))) : null;
    } catch {
      out = null;
    }
    Atomics.store(ctl, WORD.STATE, MAILBOX.IDLE);
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
    const ctl = new Int32Array(box, 0, MAILBOX_WORDS);
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
    if (!ready || Atomics.load(ctl, WORD.STATE) !== MAILBOX.IDLE) {
      this.failedStarts++;
      this.retire();
      throw new Error('DLEQ thread did not start');
    }
  }

  /**
   * Stop using the current thread (a new one starts on the next job, unless closed): QUIT, which
   * the thread never overwrites, then a reap in the background. Never blocks.
   */
  private retire(): void {
    const h = this.handle;
    const box = this.mailbox;
    this.handle = null;
    this.mailbox = null;
    if (box === null) return;
    const ctl = new Int32Array(box, 0, MAILBOX_WORDS);
    Atomics.store(ctl, WORD.STATE, MAILBOX.QUIT);
    Atomics.notify(ctl, WORD.STATE);
    if (h === null) return;
    const reap = this.reap(h, ctl);
    this.reaping.add(reap);
    void reap.finally(() => this.reaping.delete(reap));
  }

  /**
   * Join a retired thread once it has said it is leaving (the join is then immediate); a thread
   * that has not said so in `reapMs` is let go unjoined — `join()` would block this event loop
   * until it returned. `terminate()` never blocks: it stops a thread idle in its own loop, and
   * is a no-op on one still running.
   */
  private async reap(h: DleqThreadHandle, ctl: Int32Array): Promise<void> {
    const exited = await waitWord(ctl, WORD.EXITED, 0, this.reapMs);
    try {
      h.terminate();
      if (exited) h.join();
    } catch {
      // already gone
    }
    if (exited) this.reaped.joined++;
    else this.reaped.abandoned++;
  }
}

/**
 * The thread side: serve `mailbox` with `verify` until told to quit. Never throws — under Bare an
 * exception that escapes a thread aborts the WHOLE worker process — so every failure is an answer.
 */
export function serveDleqMailbox(mailbox: SharedArrayBuffer, verify: Verify): void {
  const ctl = new Int32Array(mailbox, 0, MAILBOX_WORDS);
  const data = new Uint8Array(mailbox, MAILBOX_HEADER_BYTES);
  try {
    // BOOT → IDLE only if the worker has not given up on this thread meanwhile (a slow start):
    // stored over its QUIT, IDLE would park this thread in Atomics.wait for good — nothing can
    // interrupt that under Bare — and the worker could never join it.
    if (Atomics.compareExchange(ctl, WORD.STATE, MAILBOX.BOOT, MAILBOX.IDLE) !== MAILBOX.BOOT)
      return;
    Atomics.notify(ctl, WORD.STATE);
    let last: number = MAILBOX.IDLE;
    for (;;) {
      Atomics.wait(ctl, WORD.STATE, last);
      const st = Atomics.load(ctl, WORD.STATE);
      if (st === MAILBOX.QUIT) return;
      if (st !== MAILBOX.REQ) {
        last = st;
        continue;
      }
      const answer = answerJob(data, Atomics.load(ctl, WORD.LENGTH), verify);
      if (answer !== null) {
        data.set(answer, 0);
        Atomics.store(ctl, WORD.LENGTH, answer.length);
      }
      const next = answer === null ? MAILBOX.FAIL : MAILBOX.RES;
      // REQ → RES / FAIL only if the job is still wanted: a worker that timed it out has set
      // QUIT, and QUIT stays.
      if (Atomics.compareExchange(ctl, WORD.STATE, MAILBOX.REQ, next) !== MAILBOX.REQ) return;
      last = next;
      Atomics.notify(ctl, WORD.STATE);
    }
  } finally {
    // Leaving: the worker joins this thread only once it sees this (join blocks under Bare).
    Atomics.store(ctl, WORD.EXITED, 1);
    Atomics.notify(ctl, WORD.EXITED);
  }
}

/** One job's answers (JSON booleans), or `null` for FAIL. Never throws. */
function answerJob(data: Uint8Array, len: number, verify: Verify): Uint8Array | null {
  try {
    const job: unknown = JSON.parse(utf8.decode(data.slice(0, len)));
    if (!Array.isArray(job)) return null;
    const results = job.map((c: Partial<Check> | null) => {
      try {
        return c?.proof !== undefined && c.keyset !== undefined && verify(c.proof, c.keyset);
      } catch {
        return false;
      }
    });
    const answer = utf8.encode(JSON.stringify(results));
    return answer.length > data.length ? null : answer;
  } catch {
    return null;
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
  // A chunk that is not a positive integer (0, NaN, -1) means the default, never "no checks".
  const step = Number.isSafeInteger(chunk) && chunk > 0 ? chunk : DLEQ_INLINE_CHUNK;
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
  /** Resolves once a thread start in progress is over: `true` when the thread is up (tests). */
  ready(): Promise<boolean>;
  /** Stop the thread; never blocks, resolves once it is joined or let go. */
  close(): Promise<void>;
}

/**
 * `PaymentEngineDeps.dleq` for the worker: the thread when it is up, else (while it starts, when
 * it fails, or where there is none) chunked inline checks. It never waits for a thread to start,
 * and never rejects for a thread failure, so the engine's own fallback — one synchronous pass over
 * every proof — does not run on this event loop.
 */
export function dleqVerifier(o: {
  readonly spawn: SpawnDleqThread | undefined;
  readonly verify: Verify;
  readonly logger?: Logger;
  readonly chunk?: number;
  readonly startMs?: number;
  readonly jobMs?: number;
  readonly reapMs?: number;
}): DleqVerifier {
  const thread =
    o.spawn === undefined
      ? null
      : new DleqThread({
          spawn: o.spawn,
          ...(o.startMs === undefined ? {} : { startMs: o.startMs }),
          ...(o.jobMs === undefined ? {} : { jobMs: o.jobMs }),
          ...(o.reapMs === undefined ? {} : { reapMs: o.reapMs }),
        });
  let warned = false;
  return {
    verify: async (checks) => {
      const onThread = thread?.tryVerify(checks) ?? null;
      if (onThread !== null) {
        try {
          return await onThread;
        } catch {
          if (!warned) {
            warned = true;
            o.logger?.warn('the DLEQ thread failed: checks run inline, in small chunks');
          }
        }
      }
      return chunkedDleq(checks, o.verify, o.chunk);
    },
    ready: () => thread?.ready() ?? Promise.resolve(false),
    close: () => thread?.close() ?? Promise.resolve(),
  };
}
