# Pre-push review — the DLEQ thread in the packaged app (2026-09-25)

Diff: `9a20d30` (Stage 3 integration head: auto top-up #2, residuals #8, F33 #1, packaging #6)
→ `stage-3/int-dleq-packaging` (lane I1). A cross-lane gap between packaging (issue #6, ADR 0017)
and the residuals lane's DLEQ thread (issue #8 d, security review F5), and one test-hygiene Low
from the packaging lane's round-3 verifier. Method: the `differential-review` and `sharp-edges`
skills, run inline on the whole diff.

## The gap (reproduced before the fix)

`src/worker/adapters/bare.ts` resolved the thread entry as
`new URL('../pay/dleq-thread-entry.mjs', import.meta.url)` (`95a190a`, issue #8 d).

- In the dev layout, `adapters/bare.js` sits one level down, so that is
  `dist/worker/pay/dleq-thread-entry.mjs`. Correct.
- In the packaged layout, `adapters/bare.ts` is inlined into `worker/worker.mjs`, so `../pay/`
  climbs out of `worker/` to `<app.asar.unpacked>/pay/dleq-thread-entry.mjs`. Nothing is there,
  and staging never wrote the entry anywhere.

`bareDleqThread` then finds no regular file and returns `null`. `DleqThread` turns the thread off
for good, and `dleqVerifier` falls back to the chunked inline checks **without a word**: the only
warning was for a thread that failed a job, and a thread that never started never got that far.
So every packaged build ran F5's checks on the worker's event loop, and nothing said so.

Reproduced with the new packaged-worker assertion (mutation M1a below): with the old URL, the
staged worker's self-check line reads `where: "inline"`, `onThread: 0`, at warn level.

## What changed

- **`src/worker/worker-root.ts` (new).** It holds `WORKER_ROOT`, `DLEQ_THREAD_ENTRY_PATH`
  (`./pay/dleq-thread-entry.mjs`) and `DLEQ_THREAD_ENTRY`, each resolved from this module's own
  URL. The module sits at the worker root in both layouts: `dist/worker/worker-root.js` in dev,
  and inlined at the root of `worker/worker.mjs` when packaged. So the entry is
  `dist/worker/pay/…` in dev and `worker/pay/…` packaged. Only `./` paths live there.
- **`adapters/bare.ts`.** It takes the entry from `worker-root.ts` (and re-exports it).
  `bareDleqThread` now uses `lstat`, not `stat`, so a symlink in the entry's place is refused
  like a missing file.
- **`packaging/stage.ts`.** It builds `src/worker/pay/dleq-thread-entry.mts` into
  `worker/pay/dleq-thread-entry.mjs` as its own esbuild bundle (neutral platform, ESM, npm
  packages external, the D6 plugin), and adds three checks:
  - the source must exist;
  - the bundle's inputs must lie in `src/worker/pay/` or `src/ipc/`;
  - its externals (`@sovit/core`, `bare-encoding`) must be shipped packages.

  `StageReport.externals.dleqThread` lists them.

  Why a bundle and not a copy of `dist/worker/pay/dleq-thread-entry.mjs`: the dev entry imports
  `../bare-globals.js` and `./dleq-thread.js`, and neither exists next to it once the worker is a
  single file. Mutation M1c proves that such a copy starts, cannot load, answers FAIL, and leaves
  the checks inline. esbuild inlines the local imports as lazily run `__esm` modules, called from
  inside the entry's `try`. So the entry's rule, "nothing may throw outside the try" (an escaping
  exception aborts the whole Bare process), still holds. `stage.test.ts` checks that the bundle
  has no top-level `import` or `export`.
- **`packaging/identity.ts`.** New `PACKAGED_DLEQ_THREAD_ENTRY` and `UNPACKED_FILES` (boot
  module, bundle, thread entry).
- **`packaging/layout.ts`.** The postPackage layout gate requires each of `UNPACKED_FILES` to be
  an unpacked **regular file**. It refuses a missing file, a symlink, a directory, and a file
  under a symlinked directory. Before, it checked `existsSync` on the boot module and the bundle
  only.
- **`pay/dleq-thread.ts`.**
  - `DleqVerifier.answered()` counts the checks answered on each path (thread, inline).
  - The verifier says once which path is in use: `info` "DLEQ checks run on their own thread"
    the first time the thread answers, and `warn` "no DLEQ thread could start: checks run inline,
    in small chunks" when the runtime has threads but none could start. That warning is never
    given after `close`, and never for a runtime without threads.
  - `DleqThread.isClosed` separates "closed" from "failed" for that warning.
- **`dev/dleq-selfcheck.ts` (new) and its wiring in `host.ts`.** With `--dev-fixtures`, and only
  on a runtime that has threads (Bare), the worker checks four fixed vectors (three valid, one
  forged) through the same `dleqVerifier` the real providers use. It checks them once inline
  while the thread starts, then once on the thread, then stops the thread. It logs one line:
  `DEV FIXTURES: DLEQ self-check` with `where`, `onThread`, `inline`, `checks` and `verdicts`.
  The level is info when the checks ran on the thread with the right verdicts, warn when they
  ran inline, and error when a verdict was wrong. `WorkerHost.close()` stops and joins the
  self-check's thread before anything else (a parked Bare thread keeps `Bare.exit` from
  returning). The loader refuses to start a self-check once closing has begun.
- **`scripts/__tests__/release.test.ts` (TASK 2).** `ORIGINAL_TMPDIR` is recorded at module
  load. `afterEach` restores it (or its absence) before cleanup. `makerNames` now goes through
  `tmpdirInto(work)`, whose restore acts only while `TMPDIR` is still the one it set, so a maker
  run that outlived its test cannot take `TMPDIR` away from the test running now.
- **ADR 0017 §2 and §4.** A row for the new file in the layout table, and the stricter layout
  check.

## Risk classes and blast radius

- **HIGH** (decides what ships, or runs in the shipped worker):
  - `packaging/stage.ts`: one caller, `cli.ts stage|package|make`, plus the tests;
  - `packaging/layout.ts`: one caller, Forge `postPackage` through `assertLayout`;
  - `adapters/bare.ts` `bareDleqThread`: callers `bareRuntime()` ← `entry.ts` and
    `probe-entry.ts`;
  - `pay/dleq-thread.ts` `dleqVerifier`: callers `realProviders` (the seller engine's
    `PaymentEngineDeps.dleq`) and the dev self-check.
- **MEDIUM:** `host.ts` (the dev-only wiring and `close()` order); `dev/dleq-selfcheck.ts`
  (dev-only, but it ships in the bundle, like `dev-mocks.ts`).
- **LOW:** the tests, ADR text and `identity.ts` constants.

No security check was removed. The replaced `existsSync` in `layout.ts` became a stricter
`lstat` check. The replaced `statSync` in `bare.ts` became `lstatSync`: stricter, and it
follows no link. The verdict path is unchanged. The verifier's return values, its fallback
order, and "failure is never acceptance" are the same. Only counters and three once-only log
lines were added.

## Attacker models

- **A peer paying us (a buyer on the swarm).** The engine's DLEQ verdicts are unchanged. The
  only visible difference is where they are computed: now on the thread, as issue #8 d
  intended, in packaged builds too. A flood of PAYs costs the event loop less than before.
- **A hostile renderer or host message.** Nothing new is reachable. The self-check hangs off
  `init.dev.fixtures`, which the worker guards accept only with `dev.mocks`, on a loopback
  swarm. The host passes it only behind the CLI flags, and packaged builds refuse dev flags at
  startup (`main.ts`: `app.isPackaged && devFlagIn(...)`). No IPC message, event or guard
  changed.
- **Someone who can write the install directory.** They could replace
  `worker/pay/dleq-thread-entry.mjs` with an entry that answers `true` to every check. That is
  the same power they already have over `worker/worker.mjs`, which holds the verifier itself.
  Unpacked files are outside the asar integrity fuse: packaging review residual R1, open
  question 5. The new `lstat` checks, at runtime and in the layout gate, keep the entry itself
  and (in the gate) its directories from being links out of the app's tree. They do not
  authenticate content. Unchanged class; see R-1 below.
- **The build.** The entry bundle may only inline `src/worker/pay/` and `src/ipc/` (tested:
  an import of `src/worker/other.ts` is refused). Its npm imports must be shipped (tested:
  `left-pad` is refused). A missing source fails the stage instead of silently shipping a
  package without the thread.

## Sharp-edges pass

- **Silent failure (category 5): the finding this lane fixes.** A thread that could not start
  used to be indistinguishable from one that was never wanted. Now there is a runtime `warn`
  (every build), a dev self-check line (dev and test builds), a layout-gate refusal (every
  package), and packaged-worker and staging tests (CI).
- **Paths as strings (category 6).** `DLEQ_THREAD_ENTRY_PATH` is a constant under `./`, resolved
  against the module's own URL, and `bareRuntime()` passes no path at all. A test pins it to
  `identity.ts` through the real bundle location. It also checks the path has no `..`, no
  backslash, no leading `/` and no scheme, and that `DLEQ_THREAD_ENTRY` starts with
  `WORKER_ROOT`.
- **`bareDleqThread(entry)`** still takes any URL, as the real-Bare test needs. Only the default
  is used in the app. The API is internal to the worker, and misusing it takes deliberate code.
  Low; left as is.
- **Zero, empty and absent values.** `startDleqSelfCheck({ startMs })` goes through
  `timeoutOption` (NaN, negative or non-finite values fall back to the default). With
  `spawn: () => null` the self-check reports `inline`, `warn`. A `verify` that answers `true`
  to everything gives an `error` line (tested). `answered()` returns a copy, so a caller cannot
  change the counts.
- **The build is layout-dependent.** `worker-root.ts` is right only while esbuild inlines it at
  the root of the worker bundle. If the bundle moved to a subdirectory, `stage.test.ts` would
  fail (it resolves the path against `PACKAGED_WORKER_BUNDLE` and compares it with the staged
  file), and so would the packaged-worker test. Documented in the module.
- **Test hygiene (`tmpdirInto`).** The restore closure is idempotent and acts only while
  `TMPDIR` still holds the value it set. `afterEach` restores unconditionally. There is no
  global state beyond `TMPDIR`.

No finding needed a change beyond this diff. One hardening came out of this pass: the layout gate
now also refuses a symlinked **directory** on the way to an unpacked file (mutation P8).

## Mutation checks

Each mutation was applied alone and the named tests were run, then the mutation was reverted.
The runner applied it, ran vitest, and restored the file. Every mutation in the table made its
tests fail.

| # | Mutation | Test that failed |
|---|---|---|
| M1a | the old URL `new URL('../pay/dleq-thread-entry.mjs', import.meta.url)` as the default entry | packaged-worker integration: `where: "inline"`, `onThread: 0` (the original bug) |
| M1b | stage writes the entry under another name | packaged-worker integration: ENOENT on the entry, and `where: "inline"` |
| M1c | stage copies the unbundled `dist` entry instead of bundling | packaged-worker integration: `where: "inline"` (the thread cannot load `../bare-globals.js`) |
| L1 | `bareDleqThread` uses `statSync` (follows links) | `bare-dleq-thread.test.ts` (real Bare): a symlinked entry `started` |
| V1 | no "no DLEQ thread could start" warn | `dleq-thread.test.ts` "which path answered" |
| V2 | that warn given after `close` too | same |
| V3 | the thread count not kept | 3 tests (verifier counts, self-check report, host line) |
| V4 | no "thread up" info | "which path answered" |
| S1 | the self-check never waits for the thread | 2 self-check tests (`where` stays `inline`) |
| S2 | the forged vector not forged | 5 tests (vectors, verdicts, host line) |
| S3 | the self-check logs even when stopped | 2 tests (stopped / mid-start close) |
| S4 | wrong verdicts not logged as an error | "wrong verdicts are an error line" |
| H1 | the host never starts the self-check | 2 WorkerHost tests |
| H2 | `close()` does not stop the self-check | "WorkerHost closed while the self-check's thread starts" |
| P1' | the layout gate uses `stat` (follows links) | forge-config "requires the DLEQ thread entry…": the symlink case |
| P2 | the thread entry missing from `UNPACKED_FILES` | forge-config: the missing case |
| P3 | the entry bundle's allow-list widened to `src/worker/` | stage-guards "may bundle only src/worker/pay and src/ipc" |
| P4 | the entry's externals not checked as shipped | stage-guards "a package the DLEQ thread entry imports must be shipped" |
| P5 | no explicit missing-source check | stage-guards "must exist" |
| P6 | `DLEQ_THREAD_ENTRY_PATH = '../pay/…'` | forge-config pin, and stage.test "staged where the worker bundle resolves it" |
| P7 | no D6 plugin on the entry bundle (`../bare-globals.js` stays relative) | stage.test "every import dynamic…" |
| P8 | the layout gate ignores a symlinked parent directory | forge-config: the linked-directory case |
| R1 | `afterEach` does not restore `TMPDIR` | release.test: 12 failures, the ordered pair's second test first |
| R2 | a late restore clobbers the current `TMPDIR` | release.test "…its restore leaves the current test's TMPDIR alone" |

Mutation P1 (a bare `statSync` without importing it) failed for the wrong reason, a
ReferenceError, so it was rerun as P1' (`statSync as lstatSync` in the import). P1' failed exactly
the symlink case. One mutation survived: removing the loader's "closing already" guard in
`startDevDleqCheck`. `close()` awaits the pending loader and closes whatever it returns, which
covers the ordinary race on its own. The guard only matters for an `init` that arrives after
`close`, a path the host has no test for, because such an init would leave a listening server
behind. Kept as defence in depth; residual R-3.

**TASK 2, manual check (recorded).** The real-maker test's timeout was cut to 300 ms (60 s in the
file) and the whole file was run:

- before the fix: **11 failed** (the timeout, then 10 × `ENOENT … mkdtemp
  '/tmp/nutflix-release-…/tmp/nutflix-release-XXXXXX'`), 16 passed;
- after the fix: **1 failed** (the timeout alone), 29 passed. Neither run left anything in
  `/tmp`.

## Gates

- `npx vitest run packages/app-desktop scripts/__tests__ --maxWorkers=2`: 1604 passed,
  1 skipped.
- `npx vitest run --maxWorkers=2` (whole suite, once): 204 files passed, 3 skipped; 3113 tests
  passed, 21 skipped, 0 failed.
- After the late layout hardening (P8), the whole suite was run again with the same result,
  and `tsc -b --force`, the linters and both checks below were rerun.
- `npx tsc -b --force`: clean. `eslint` and `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK (no locked path touched). `npm run lint:electron`: OK, 0 violations.
- The Electron e2e was not run (per the lane brief).

## Residuals

- **R-1 [Low, unchanged class].** The thread entry joins the unpacked files that no integrity
  check covers. Anyone who can write the install directory can make it answer `true` to every
  check, exactly as they can edit `worker/worker.mjs`. This is ADR 0017 open question 5
  (digests of unpacked files); nothing new to decide.
- **R-2 [Low].** At runtime, `bareDleqThread` refuses a symlink only in the entry's own place,
  not a symlinked `worker/pay/` directory. The layout gate refuses both in every package, and
  the parent directories above the worker root may legitimately be links (a symlinked install,
  macOS translocation). Anyone who can plant such a link can replace the file anyway (R-1).
- **R-3 [Info].** The self-check loader's "closing already" guard has no test that fails without
  it (see Mutation checks). Adding one would mean exercising `init` after `close`, which leaks
  a listening server in the test process.
- **R-4 [Info, pre-existing].** In the dev-fixtures self-check, a Bare worker that dies through
  `uncaughtException` (entry.ts: `Bare.exit(1)` without `host.close()`) could hang in `Bare.exit`
  if the self-check thread is parked at that instant. The window is about a second at start-up,
  in dev only. The same holds, for the worker's whole life, for a real-payments seller's idle
  DLEQ thread (issue #8 d; the residuals lane recorded the Bare limit). Not introduced here.
- **R-5 [Info].** Production shows the thread in use only when a seller receives its first PAY
  (the info line), or when none could start (the warn). A viewer never loads the thread, as
  designed.
