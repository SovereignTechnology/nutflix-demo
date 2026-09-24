/**
 * DLEQ checks off the event loop (security review F5): a small pool of `worker_threads`, each
 * running core's `proofDleqOk`. One seeder event loop serves every session; at ~20 ms per proof
 * under `--jitless`, checking a busy seeder's PAYs inline stalls all of them. The engine hands a
 * PAY's checks over in one call (`PaymentEngineDeps.dleq`); the pool splits them across its
 * workers and answers in order.
 *
 * Failure is never acceptance: a worker that errors, exits or times out rejects its jobs, and the
 * engine then runs the synchronous check itself. A dead worker is replaced on the next job.
 *
 * The worker file is the BUILT `dleq-worker.js` next to this module. Where it does not exist (the
 * TypeScript sources under vitest) `DleqPool.open` returns `null` and the engine checks inline.
 */
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { payment } from '@sovit/core';

import type { Logger } from '../log/logger.js';

export const DLEQ_WORKER_URL = new URL('./dleq-worker.js', import.meta.url);
/** A job not answered in this long is failed (the engine then checks inline). */
export const DLEQ_JOB_TIMEOUT_MS = 30_000;
/** Default threads: one per spare core, at most four. */
export function defaultDleqThreads(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

export interface DleqPoolOptions {
  /** Worker threads (≥ 1). */
  readonly size: number;
  readonly workerUrl?: URL;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
}

interface Job {
  readonly resolve: (r: boolean[]) => void;
  readonly reject: (e: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class Slot {
  worker: Worker | null = null;
  readonly jobs = new Map<number, Job>();
}

export class DleqPool {
  private readonly o: DleqPoolOptions;
  private readonly slots: Slot[];
  private next = 1;
  private turn = 0;
  private closed = false;

  private constructor(o: DleqPoolOptions) {
    this.o = o;
    this.slots = Array.from({ length: o.size }, () => new Slot());
  }

  /** A pool, or `null` when `size` is 0 or the worker file is missing (checks stay inline). */
  static open(o: DleqPoolOptions): DleqPool | null {
    if (!Number.isSafeInteger(o.size) || o.size < 1) return null;
    const url = o.workerUrl ?? DLEQ_WORKER_URL;
    if (url.protocol !== 'file:' || !existsSync(fileURLToPath(url))) {
      o.logger?.debug('DLEQ worker not built: checks run on the event loop');
      return null;
    }
    return new DleqPool(o);
  }

  get size(): number {
    return this.slots.length;
  }

  /** `PaymentEngineDeps.dleq`: the answers for `checks`, in order. */
  readonly verify = async (checks: readonly payment.DleqCheck[]): Promise<boolean[]> => {
    if (this.closed) throw new Error('DLEQ pool closed');
    if (checks.length === 0) return [];
    const parts = Math.min(this.slots.length, checks.length);
    const per = Math.ceil(checks.length / parts);
    const runs: Promise<boolean[]>[] = [];
    for (let i = 0; i < checks.length; i += per) runs.push(this.run(checks.slice(i, i + per)));
    const answers = await Promise.all(runs);
    const out = answers.flat();
    if (out.length !== checks.length) throw new Error('DLEQ pool answered the wrong count');
    return out;
  };

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      this.slots.map(async (s) => {
        this.fail(s, new Error('DLEQ pool closed'));
        const w = s.worker;
        s.worker = null;
        if (w !== null) await w.terminate();
      }),
    );
  }

  private run(checks: readonly payment.DleqCheck[]): Promise<boolean[]> {
    const slot = this.slots[this.turn % this.slots.length];
    this.turn++;
    if (slot === undefined) return Promise.reject(new Error('no DLEQ worker'));
    const worker = this.workerFor(slot);
    const id = this.next;
    this.next = this.next >= Number.MAX_SAFE_INTEGER ? 1 : this.next + 1;
    return new Promise<boolean[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!slot.jobs.delete(id)) return;
        reject(new Error('DLEQ worker timed out'));
        // A stuck worker is replaced; its other jobs fall back inline.
        this.retire(slot, new Error('DLEQ worker timed out'));
      }, this.o.timeoutMs ?? DLEQ_JOB_TIMEOUT_MS);
      timer.unref();
      slot.jobs.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, checks });
      } catch (e) {
        slot.jobs.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('DLEQ post failed'));
      }
    });
  }

  private workerFor(slot: Slot): Worker {
    if (slot.worker !== null) return slot.worker;
    // Workers inherit the process's flags (`--jitless` holds in them too). Passing them
    // explicitly is refused — V8 flags are process-wide — so `execArgv` is left alone. Started
    // from `node -e`, a worker cannot load at all: it errors and the engine checks inline.
    const w = new Worker(this.o.workerUrl ?? DLEQ_WORKER_URL);
    w.unref();
    w.on('message', (m: unknown) => {
      const r = m as { id?: unknown; results?: unknown } | null;
      if (typeof r?.id !== 'number' || !Array.isArray(r.results)) return;
      const job = slot.jobs.get(r.id);
      if (job === undefined) return;
      slot.jobs.delete(r.id);
      clearTimeout(job.timer);
      job.resolve(r.results.map((x) => x === true));
    });
    w.on('error', () => {
      this.o.logger?.warn('a DLEQ worker failed: its checks fall back to the event loop');
      this.retire(slot, new Error('DLEQ worker failed'), w);
    });
    w.on('exit', () => {
      this.retire(slot, new Error('DLEQ worker exited'), w);
    });
    slot.worker = w;
    return w;
  }

  private retire(slot: Slot, err: Error, which?: Worker): void {
    if (which !== undefined && slot.worker !== which) return;
    const w = slot.worker;
    slot.worker = null;
    this.fail(slot, err);
    if (w !== null) void w.terminate().catch(() => undefined);
  }

  private fail(slot: Slot, err: Error): void {
    for (const [, job] of slot.jobs) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    slot.jobs.clear();
  }
}
