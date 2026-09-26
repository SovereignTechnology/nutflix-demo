/**
 * The DLEQ thread's entry point (`Bare.Thread`, issue #8 d; `dleq-thread.ts`). It runs on its own
 * OS thread with its own isolate: it loads core, then serves the mailbox it was handed as the
 * thread's data until told to quit.
 *
 * It must never throw: under Bare an exception that escapes a thread aborts the WHOLE worker
 * process (verified on Bare 1.31). So nothing is imported statically — every import is dynamic,
 * inside the try — and a failure to load is reported through the mailbox (FAIL), which the worker
 * reads as "no thread" and checks inline instead. It holds public data only (proofs and mint
 * keys) and logs nothing.
 *
 * `.mts` (built to `.mjs`) on purpose: a `Bare.Thread` entry does not take its module type from
 * package.json — a `.js` entry is parsed as CommonJS, tsc's `export {}` is a SyntaxError there, and
 * that SyntaxError escapes the thread and aborts the worker (found by `bare-dleq-thread.test.ts`).
 */
// MAILBOX / WORD from dleq-thread.ts, spelled out: this file imports nothing statically.
const MAILBOX_BOOT = 0;
const MAILBOX_FAIL = 5;
const WORD_STATE = 0;
const WORD_EXITED = 2;

interface ThreadSelf {
  readonly data?: unknown;
}

async function main(): Promise<void> {
  const self = (globalThis as { Bare?: { Thread?: { self?: ThreadSelf | null } } }).Bare?.Thread
    ?.self;
  const box = self?.data;
  if (!(box instanceof SharedArrayBuffer)) return;
  try {
    // D6 first (core builds a TextDecoder at load), exactly as the worker entry does.
    await import('../bare-globals.js');
    const { payment } = await import('@sovit/core');
    const { serveDleqMailbox } = await import('./dleq-thread.js');
    serveDleqMailbox(box, (proof, keyset) => payment.proofDleqOk(proof, keyset));
  } catch {
    const ctl = new Int32Array(box, 0, 3);
    // FAIL only over BOOT: a worker that gave up on this start meanwhile has set QUIT, which
    // stays (issue #8 review, finding 2). Then "leaving", so the worker can join this thread.
    Atomics.compareExchange(ctl, WORD_STATE, MAILBOX_BOOT, MAILBOX_FAIL);
    Atomics.notify(ctl, WORD_STATE);
    Atomics.store(ctl, WORD_EXITED, 1);
    Atomics.notify(ctl, WORD_EXITED);
  }
}

void main().catch(() => undefined);
