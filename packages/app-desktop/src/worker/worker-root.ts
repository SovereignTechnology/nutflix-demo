/**
 * Files the worker loads at run time, by path (ADR 0017, issue #8 d). Each one is resolved from
 * THIS module, which is at the worker root in both layouts:
 *
 *   dev       dist/worker/worker-root.js   (tsc output; the host runs dist/worker/entry.js)
 *   packaged  worker/worker.mjs            (the bundle: packaging/stage.ts inlines this module)
 *
 * so `./pay/dleq-thread-entry.mjs` is dist/worker/pay/… in the one and worker/pay/… in the
 * other, where packaging/stage.ts writes the thread entry as its own bundle and
 * packaging/layout.ts requires it unpacked. A module one directory down (`adapters/`) cannot do
 * this: its `../pay/` is right in dev and points OUTSIDE the worker directory once bundled (the
 * gap this module closes — every packaged build fell back to the chunked checks).
 *
 * Only paths under `./` belong here: nothing resolved from this module can leave the worker's
 * own directory (a test pins every entry to `WORKER_ROOT`). A bundle made anywhere else (the
 * tests' `bundleForBare`) resolves them next to itself, finds no entry, and runs without the
 * thread, as documented in adapters/bare.ts.
 */

/** The worker's own directory (`dist/worker/`, or the packaged `worker/`). */
export const WORKER_ROOT: URL = new URL('./', import.meta.url);

/** The DLEQ thread's entry, relative to `WORKER_ROOT` (packaging/identity.ts pins the same). */
export const DLEQ_THREAD_ENTRY_PATH = './pay/dleq-thread-entry.mjs';

/**
 * The DLEQ thread's entry (a `Bare.Thread` file; see pay/dleq-thread-entry.mts). Resolved against
 * the module's own URL string, as `WORKER_ROOT` is (Bare's global `URL` is bare-url's).
 */
export const DLEQ_THREAD_ENTRY: URL = new URL(DLEQ_THREAD_ENTRY_PATH, import.meta.url);
