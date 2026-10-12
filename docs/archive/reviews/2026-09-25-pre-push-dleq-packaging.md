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

## Cross-lane review (round 4)

Findings: the cross-lane worker/P2P review, the I1 verifier and the test-integrity lens, on this
branch (`e55adf0`: the I1 fix on the Stage 3 integration head, with F33 #1, residuals #8 and
images over Pear #5). The orchestrator ruled on each finding; its decisions are applied below.
Cameron's rule for images: a thumbnail or avatar URL naming a paid core must never get the viewer
banned or charged, and browsing never spends sats. Each finding was reproduced by a test on the
unfixed code before it was fixed. The lane's `.lane` was widened to `packages/seeder/`,
`packages/gateway/src/` and `packages/core/src/mocks/` for this round (the last was not needed).

| # | Finding | Outcome |
|---|---|---|
| 1 | HIGH — `image.fetch` downloads any core a thumbnail URL names, unrouted and unpaid: the seeders of a paid video ban the viewer | **fixed** |
| 2 | HIGH — one core's PAY failure aborts `payPending` for the whole peer | **fixed** |
| 3 | HIGH — blocks owed at `play.close` or quit are never paid; the next start overruns the seeder | **fixed** (IR4 stays a residual) |
| 4 | MEDIUM — `image.fetch` marks a paid core free on our own seeder, and the mark outlives `serveImages` off | **fixed** |
| 5 | MEDIUM — a core closed by `closeCoreByKey` and reopened gets no upload gate | **fixed** |
| 6 | LOW — a profile replica opened with serving off still counts image blocks and can ban | **fixed** |
| 7 | MEDIUM (I1 verifier) — `Bare.exit` hangs on a parked DLEQ thread after an uncaught exception | **fixed** (R-4 closed) |
| 8 | INFO — `releaseImageCore` can close a core under a concurrent `playOpen` | **fixed** |
| 9 | INFO — routed cores are never detached on the desktop | **deferred** |
| 10 | INFO (test lens) — the end-to-end "never raced" tests do not detect a racing hotswap queue | **fixed** (a test) |
| 11 | INFO (test lens) — the real-mint blob wait went from 30 s to 60 s with no reason given | **fixed** (a comment) |
| 12 | INFO (test lens) — a dist-gated skip; app-desktop tests read siblings from `dist` | **deferred** |
| 13 | INFO (test lens) — a stale test title ("half the credit pool") | **fixed** |

### 1. `image.fetch` and paid cores (HIGH) — fixed

**Reproduced.** The new `images-paid-core.integration.test.ts` runs the reviewer's probe on the
dev fixture rig: S1 and S2 seed a 16-block paid video, the worker has seeding off, and one
`image.fetch` names the video's core. With the pre-fix `worker/host.ts` it fails with
`s1 bans: expected [ {…} ] to deeply equal []`: both fixture seeders banned the viewer, as the
reviewer measured (`{ uploaded: 6, paid: 0, windowBlocks: 5, banned: true }`).

**The mechanism** (design and trade-offs in `docs/contract-requests/I1-dleqpack.md`):

- **Refusal of known sold cores** (`WorkerHost.soldCore`). `image.fetch` refuses, before anything
  is opened, any core that is:
  - in `corePolicies` (a video played or opening; the policy is set before `playOpen` awaits);
  - in `coresAttached`;
  - priced by our own seeder (`corePolicyMap`: uploads, played cores);
  - PRICEd by a seeder on the image path while no seeder served it free.

  It checks again after the open is awaited.
- **Image cores are routed** (`ViewerPayer.attachImageCore` → `SeederCredit.attachImageCore`, on
  the same `OnePeerRouter`). For each `pay/1` seeder:
  - its budget on an image core is its BARE window, less what it may already count: owed and
    unpaid blocks, and (through the router's `used`) everything in flight on any core. So even a
    seeder that counts every image block stays within its window, and **no `pay/1` seeder is
    asked for more than its window by any path** (invariant 1);
  - until it has delivered one block of the core with no `PRICE` before it, it is asked one
    block at a time (new router option `probe`);
  - a seeder that sent a `PRICE` for the core is never asked for it again (remembered per
    seeder, across reconnects), and blocks it delivered after its `PRICE` are unpaid for good.

  No seeder without a HELLO is asked anything. A peer without `pay/1` keeps the old bounded burst.
  The payer and settler never watch image cores, so nothing is ever paid for them.
- **The signal.** A seeder that counts a core's blocks announces the core's price before the first
  one (`announceCorePrices`). This round turns it on everywhere this repository builds a seeder:
  - the desktop worker, dev mocks included (it was on only with real payments);
  - the dev fixture seeders;
  - the gateway;
  - the daemon (`runDaemon`, unless its config says otherwise).

  The `Seeder` default stays off, as its own test pins. A free core returns before the hook, so
  it never gets a `PRICE`.
- **The read stops** as soon as a seeder PRICEs the core (`onImageVerdict` → the host rejects the
  reads in flight with `forbidden`). The replica is released even while serving images, and the
  core is refused from then on, unless a seeder has served it free.
- **Free marking** (findings 4 and 6):
  - the image path marks free only a replica it opened itself (`entry.opened`), and does so
    while the replica is open, whatever the serving setting;
  - the mark is dropped only after the replica is closed;
  - `Seeder.setFreeCore` refuses a core with its own price policy, and `setCorePolicy` clears
    the mark.

**Invariants, with their tests** (`images-paid-core.integration.test.ts` unless named):

1. No `pay/1` seeder is asked for more than its window, through any path. The reviewer's probe:
   each fixture seeder uploads at most one block, `outstanding ≤ windowBlocks`, nobody is banned
   and nothing is paid, and the viewer counts every block they may count. Unit tests:
   `seeder-credit.test.ts` "image cores" (4 tests) and `one-peer-router.test.ts` "the probe
   option".
2. `image.fetch` refuses sold or attached cores, and never marks free a core it did not open.
   Covered by:
   - "a second read … refused at once" (nothing opened, nothing uploaded, under 2 s);
   - "once played, the core is refused as an image, and it is never marked free";
   - `seeder.test.ts` "setFreeCore refuses a core with its own price policy…".
3. Honest free profile-core serving keeps working. `images-over-pear.integration.test.ts` is
   unchanged and green. "An honest free image larger than the seeder's window loads" (6 blocks
   against a window of 4) covers images larger than a window.
4. Honest free image fetches do not erode paid playback credit. The same test finds S1 counting
   nothing, and the viewer's `unpaid` and S1's router debt still at 0. "The video still plays in
   full from the same seeders afterwards" then streams the paid video from S1 and S2 with every
   downloaded block paid and nobody banned.

### 2. The gateway payer (HIGH) — fixed

**Reproduced.** The reviewer's probe as a unit test (`upstream-payer.test.ts`, "a PAY that cannot
be built", first case): an engine rejecting CORE_A `session-closed`, one CORE_A block pending,
then 4 CORE_B blocks under a per-seeder batch of 2. Before the fix, `expected [] to deeply equal
[0, 1, 2, 3]`: no CORE_B PAY at all.

**Fix** (`UpstreamPayer.payPending` and `payFailed`):

- `engine.pay` is caught per core, and the peer's other cores are paid in the same pass.
- The failure is logged by its outcome code only (`payOutcome`: the `<code>:` prefix or a `code`
  field). No core, peer or message text goes in the log.
- `session-closed` (every pending block of that core) and `forbidden` (the range) are final, and
  so is a third failure in a row (`MAX_PAY_FAILURES`). Those blocks are given up: never paid,
  replay-guarded, and reported through the new `onUnpayable`. `ViewerPayer` and the gateway wire
  it to the new `CreditSettler.settleUnpaid`, which settles them now as UNPAID. The pool unit
  comes back, and `SeederCredit` keeps the blocks off that seeder's credit for good, so the debt
  is explicit.
- Any other outcome keeps the blocks owed. They are retried once per `flush()` or tail timer (an
  epoch), not on every pass the other cores cause.

Tests: 4 in `upstream-payer.test.ts` (the probe; a transient failure retried; giving up after
three; the log carries the code only) and 1 in `viewer-payer.test.ts` (settled unpaid, the
seeder's budget less one, the other core paid).

### 3. Owed blocks at `play.close` and at quit (HIGH) — fixed

**Reproduced** in `desktop-pays.integration.test.ts`: real payment providers, the host's real
money plane, a real seeder daemon. With the pre-fix `worker/host.ts`:

- "A tail pending at `play.close` is paid before `play.close` answers" failed with `outstanding: 5`
  (expected 0).
- "A quit mid-video pays its tail" failed.
- "The next start does not overrun the seeder" failed.

`topup-host.test.ts` "pay.build during play.close is paid" (real money plane, fake worker) failed
with the pre-fix host `sessions.ts`/`adapter.ts`: `expected [ 'session-closed' ] to deeply equal
[ 'paid' ]`.

**Fix** — the close is ordered so the flush completes first, each step bounded:

- **Worker.**
  - `closeSession` closes the gate and the link at once. It keeps the session (closed to the host,
    but still found by `sidFor`) while `ViewerPayer.drain` pays and settles its core's tail,
    bounded by `CLOSE_DRAIN_MS` (5 s): every PAY ACKed, nothing owed, nothing of the core in
    flight (new `CreditSettler.owedOn` and `OnePeerRouter.inflightOn`).
  - `play.close` answers only after the drain.
  - `sidFor` prefers an open session of the core and falls back to a closing one.
  - `close()` drains every session in parallel BEFORE the sessions go and before `node.destroy`.
  - Blocks still owed after the bound are settled as unpaid (finding 2).
- **Host.**
  - `HostPlaySession.closeAsync` closes to the renderer at once. The new `onSettled` hooks, where
    the adapter now revokes the money-plane session, run only after the worker answered
    `play.close`, or when that call failed or the worker is gone.
  - At quit, the host's SIGTERM runs `Host.shutdown(QUIT_FLUSH_MS = 7 s)`, which closes every
    session through the worker (`SessionRegistry.closeAll`) before stopping it.
- **Main.** `before-quit` holds the quit once, lets the host exit
  (`HostLink.stopAndWait(QUIT_GRACE_MS = 9 s)`), then quits.

Tests:

- `desktop-pays` × 3 (above);
- `topup-host` × 1;
- `adapter-play` × 4: settle after the answer; settle on failure or worker gone, once; adapter
  order; `shutdown` closes every session through the worker;
- `host-link.test.ts` × 1 (`stopAndWait`);
- `main-wiring.test.ts` "before-quit…", extended. It used to call the listener without an event;
  Electron always passes one. The kill and the no-respawn assertions stay, and it now also
  checks that the quit waits for the host's exit.

**IR4 stays a residual.** Debts across a crash are the seeder's own count, and only the v7
ACK-window request (S3-f33) fixes them. A graceful quit now pays its tail; a crash does not.

### 4–6. Free marking, the reopened gate, serving-off replicas — fixed

- **4 (MEDIUM).** Covered in 1. Tests: `seeder.test.ts` (the free-core rules) and
  `images-paid-core` step 5.
- **5 (MEDIUM).** `Seeder` keys its upload gates by the Hypercore SESSION: a reopen attaches a new
  gate. `BlobStore.closeCoreByKey` also reports the close (new `onCoreClosed`), and the gate goes
  with its session. Test: `seeder.test.ts` "a core closed by closeCoreByKey and reopened … gets
  its upload gate back". It checks `listenerCount('upload')` as the reviewer's probe did, and
  that `recordUpload` records a served block. Before the fix: `expected +0 to be 1`.
- **6 (LOW).** A replica the image path opened is free while open, served or not. Test: the
  honest-image case spies on `setFreeCore` with seeding off, and sees `[core, true]` then, once
  closed, `[core, false]`.

### 7. `Bare.exit` and a parked DLEQ thread (MEDIUM, I1 verifier) — fixed

`pay/dleq-thread.ts` keeps a module-level registry of live mailboxes: added at `start()` after
the spawn, removed once the reap ends. The new synchronous `quitDleqThreadsNow()` stores QUIT
and notifies on each one. `worker/exit.ts` `exitWorker(code)` calls it, then `Bare.exit`.
`entry.ts` uses it on every exit that does not follow `host.close()`:

- the uncaught-exception handler;
- a corrupt frame;
- the shutdown force timer;
- the normal end.

Test: `bare-exit.test.ts`, under real Bare through bare-sidecar, with the built worker. The real
`entry.js` installs its handlers, a real `bareDleqThread()` thread answers 4 checks and parks,
and an uncaught exception is thrown. Before the fix the process was `hung` 5 s later and had to
be SIGKILLed; now it exits 1 in milliseconds. Node unit tests in `dleq-thread.test.ts` show a
parked thread seeing QUIT and leaving, the registry forgetting it, and `exitWorker` quitting
threads before it exits. R-4 is closed: the verifier was right that this diff made it reachable
in shipped builds.

### 8–13. The INFO items

- **8 — fixed.** `releaseImageCore` leaves a core with a policy (a play open sets it before any
  await) as well as an attached one. `playOpen` refuses (`rate-limited`, retryable) a core with
  an image read in flight. Test: "a play open racing the release of an image replica keeps it
  open". A profile core is named as a video, and `serveImages` is switched off while the open
  awaits; the core stays open, is no longer free, and plays.
- **9 — deferred.** Detaching a routed core when no session plays it touches the new drain (a
  closing session's in-flight blocks must still be routed and settled), parking, and the
  settler's owed blocks. It is not cheap or safe in this round. Per-seeder caps hold, so the cost
  is extra `updateAll` work and smaller batches, bounded by the videos played in one run.
- **10 — fixed.** New `one-peer-router.test.ts` case: one seeder withholds the blocks it was
  asked, a second has spare capacity, and hypercore consults the queue for it on every pass.
  Each block is sent once, with no failover and nothing raced. The reviewer's mutation (the queue
  offering every in-flight block at once) fails it, together with two stall-timing tests.
- **11 — fixed.** A comment at the 60 s read deadline: routed pacing (each seeder is asked again
  only after a real-mint PAY round trip) and small windows. It is an in-test deadline, not a
  vitest timeout.
- **12 — deferred.** Failing instead of skipping (`NUTFLIX_REQUIRE_BUILT`) is only useful once CI
  sets it, and CI is the root `package.json`, outside this lane. The root `ci` script already
  builds before `npm test`, and this round's gates build with `tsc -b --force` first. The new
  real-Bare test uses the same dist gate.
- **13 — fixed.** The title now reads "half the seeder's window", with a comment.

### Mutation checks (round 4)

Each mutation was applied alone and the named tests were run, then the file was restored (and
`tsc -b` re-run where a consumer reads `dist`). The runner was a script in the scratchpad.

| # | Mutation | Result |
|---|---|---|
| P1 | `payPending` rethrows a PAY failure (no per-core catch) | caught: 4 `upstream-payer` tests |
| P2 | a final outcome is kept pending (never given up) | caught: 3 `upstream-payer` tests |
| P3 | `ViewerPayer` does not settle unpayable blocks | caught: `viewer-payer` "a core whose session is gone" |
| S1 | the gate attached only when none is recorded for the key | survived alone (see S1c) |
| S1b | `closeCoreByKey` does not report the close | survived alone (see S1c) |
| S1c | both (the original bug) | caught: `seeder.test` "…gets its upload gate back" |
| S2 | `setFreeCore` marks a priced core free | caught: `seeder.test` free-core rules |
| S3 | `setCorePolicy` leaves the free mark | caught: same |
| C1 | image cores get the old unrouted no-pay burst | caught: 2 `seeder-credit` image tests (and `images-paid-core`) |
| C2 | no probe | caught: 4 tests (`seeder-credit`, `images-paid-core`) |
| C3 | a PRICE on an image core is ignored | caught: `seeder-credit` "a seeder that PRICEs the core" |
| C4 | blocks after a PRICE not counted unpaid | caught: same |
| R1 | the router ignores `probe` | caught: `one-peer-router` "the probe option" |
| R2 | the no-race queue offers every in-flight block (the reviewer's mutation 1) | caught: the new spare-seeder case, and 2 stall-timing tests |
| H1 | no sold-core refusal at the start of `image.fetch` | caught: "a second read … refused at once" (nothing opened) |
| H2 | image cores not routed | caught: the reviewer's probe, and 2 more |
| H3 | an image replica marked free only while serving (the old rule) | caught: the honest-image case |
| H4 | `closeSession` deletes the session before its drain | caught: 3 `desktop-pays` tests |
| H5 | `sidFor` ignores a closing session | caught: 3 `desktop-pays` tests |
| A1 | fixture seeders do not announce core prices | caught: the reviewer's probe, and 2 more (the interim rests on the signal) |
| D1 | `quitDleqThreadsNow` tells nobody | caught: `bare-exit` and 2 `dleq-thread` tests |
| D2 | the entry exits through `Bare.exit` on an uncaught exception | caught: `bare-exit` |
| HS1 | the session settles (is revoked) before `play.close` answers | caught: `adapter-play` and `topup-host` |
| HS2 | `Host.shutdown` stops without closing the sessions | caught: `adapter-play` "quit: …" |
| HL1 | `stopAndWait` does not wait for the exit | caught: `host-link` |
| I1 | `releaseImageCore` ignores the play claim (policy) | caught: "a play open racing the release…" |
| — | whole-file reverts to `e55adf0`: `worker/host.ts`; host `sessions.ts` + `adapter.ts` | caught: the reproductions under 1, 3 |

**Survivors.** S1 and S1b are two independent layers for the reopened gate: the session-keyed
check, and the close report from `closeCoreByKey`. Each alone restores the gate, so only their
conjunction (S1c, the original bug) fails the test. Both are kept (defence in depth). No path in
this repository closes a by-key core other than `closeCoreByKey`, so the session key has no
separate test. H1 survived its first run, because the post-open re-check also refuses. The test
now also asserts that nothing is opened, and the rerun was caught.

### Gates (round 4)

- Touched packages: `npx vitest run packages/seeder packages/gateway --maxWorkers=2` gave 45
  files passed, 1 skipped (393 tests passed, 4 skipped). `packages/app-desktop scripts/__tests__`
  showed one failure: `main-wiring.test.ts` "before-quit…" called the listener without the event
  Electron passes. The test was extended (see 3), rerun and passed, and the whole suite below
  covers the package again.
- Whole suite, once: `npx vitest run --maxWorkers=2` gave 206 files passed, 3 skipped; 3144 tests
  passed, 21 skipped, 0 failed. The skips are the real-mint suites gated on
  `NUTFLIX_REAL_MINT_URL`.
- `npx tsc -b --force`: clean. `eslint` and `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK (no locked path touched). `npm run lint:electron`: OK, 0 violations.
- The Electron e2e was not run (per the brief).
- No test was deleted or weakened. Changed assertions:
  - the F5 batching test's title;
  - `main-wiring.test.ts` "before-quit…", which now passes an event and asserts more.

  Timeouts: the real-mint read deadline got a comment only; the new tests' in-test deadlines are
  their own.

### Residuals (round 4)

- **IR4.** Debts across a crash or restart are the seeder's own count, and only the v7
  ACK-window request (S3-f33) fixes them. A graceful quit or close now pays its tail; a crash
  does not.
- **The interim signal** (`docs/contract-requests/I1-dleqpack.md`). Invariant 1 on image reads
  rests on every seeder announcing a counted core's price before its first block. A seeder that
  counts in silence (announcing off, an older build, a third-party implementation, or a seeder
  with no policy at all for the core) is taken as free after the probe block, and can still cut
  the viewer. The request asks v7 for an explicit `PRICE.free` so that silence means "counted".
- **One probe block per seeder of a sold core** is unpaid for good, since browsing never pays. An
  attacker who publishes many thumbnails naming DIFFERENT paid cores of one seeder can use up that
  seeder's credit for the run, one block per core, without a ban or a sat spent. The v7 window
  report or the explicit signal removes this.
- **Windows quit.** The quit flush runs on SIGTERM (`utilityProcess.kill()`), which is graceful on
  Linux and macOS only. On Windows a quit still leaves the tail owed, as before.
- **Non-`pay/1` peers** are asked one image block at a time for good (never proven free): slower
  images from such peers, with no correctness cost.
- **Finding 9** (routed cores never detached) and **finding 12** (the dist-gated skip): deferred,
  see above.

## Round 5 — the verifier of fix round 4

Three findings on the round-4 fixes (`80f8dd5`), in the worker and the payer. The orchestrator
ruled on each; the rulings are applied below. Each finding was reproduced by a test on the round-4
code before it was fixed. **On hold, untouched** (they wait for Cameron's protocol decision): the
image-fetch probe, `PRICE` / `announceCorePrices` handling, and restart debt (IR4).

| # | Finding | Outcome |
|---|---|---|
| 1 | HIGH — `switchRendition` writes off the old session's tail: the PAY's session was resolved by core, preferring the new open one; the host refused the old tail as outside its video and round 4 gave it up for good | **fixed** |
| 2 | MEDIUM — after a transient PAY failure a seeder at its cap was never retried until flush/close; at close the drain's 25 ms passes wrote a still-transient failure off in under a second | **fixed** |
| 3 | MEDIUM — the close drain waited on the whole core, so every rendition switch froze for up to `CLOSE_DRAIN_MS` | **fixed** |

### 1. The old session's tail after a rendition switch (HIGH) — fixed

**Reproduced.** The reviewer's repro is a new `desktop-pays.integration.test.ts` case (real
providers, the host's real money plane, a real seeder daemon): A streams, `play.pause` A, the
host authorises B (the adapter's reopen) and the worker opens it on the same core, B starts
streaming, `play.close` A. Mutation H1 puts round 4's lookup back (by core, the open session
first, one session). The new case fails, and so do the two after it ("a quit mid-video…",
"the next start does not overrun the seeder"): the blocks written off at the switch stay
outstanding at the seeder, and the fresh worker is overrun. The reviewer saw the same thing.

**Also fixed: the harness.** `worker/__tests__/helpers/harness.ts` answered every host-handler
failure with `internal`, so no integration test ever saw the money plane's `forbidden` or
`session-closed`. The payer's decisions depend on exactly those codes. It now replies with
`toWireError(e)`, as the host's supervisor does (`onRequest`).

**Fix.**

- **The session a PAY is built for** (new `worker/pay/session-ranges.ts`):
  - `sessionsCovering(range, sessions)`: the sessions whose blob covers ALL of the range, open
    ones first, then those closing. Open-first applies only among the covering sessions.
  - Each worker `Session` records its blob's `first` and `last` block.
  - `real-providers.ts` takes `sidsFor(range)` (it was `sidFor(core)`) and asks the host for a
    session that covers the range.
- **A host refusal is not final while another covering session may pay** (the orchestrator's
  ruling). The worker's `pay` asks the covering sessions in order.
  - On `forbidden` or `session-closed` from one session, it asks the next.
  - Any other failure (`no-balance`, the host busy) goes back to the payer at once, since it
    would fail the same way for every session.
  - When every covering session refuses, the last refusal goes back.
  - When no session covers the range, the worker refuses `session-closed` without asking the
    host.
- **Two sessions on one core each pay their own blocks.**
  - `UpstreamPayer.payFailed` gives up only the refused RANGE. For `session-closed`, round 4
    gave up every pending block of the core, which would include the other session's blocks.
  - After a range is given up, the core's next run is tried in the same pass.
  - `boundToSessions` is passed to the payer as the new `boundRange` option. It ends a PAY where
    a session's blob ends. Renditions sit side by side in the core (measured in the suite: A at
    blocks 30–36, B at 37–60), so A's last block and B's first could otherwise merge into one
    run that no session covers.

Tests:

- `desktop-pays` × 2: the reviewer's repro above, and "renditions side by side".
- `session-ranges.test.ts` × 7: covering, open-first, none, the bound at each kind of boundary.
- `real-providers-sessions.test.ts` × 5: the range is asked for; the next covering session
  after `forbidden` or `session-closed`; the last refusal goes back; other codes are not tried
  elsewhere; with no cover the host is not asked.
- `upstream-payer.test.ts`: "a range refused for good gives up THAT range only" (for both
  `session-closed` and `forbidden`), and `boundRange` (plus five malformed answers, all ignored).
- `viewer-payer.test.ts`: `boundRange` reaches the payer.

### 2. A transient PAY failure at a seeder's cap (MEDIUM) — fixed

**Reproduced.** The reviewer's repro is a unit test (`upstream-payer.test.ts`): the engine refuses
`no-balance` for about 300 ms, the seeder is at its cap, `tailMs` is 30, and then the player
pressures the pool 10 times. On the round-4 payer the test fails with 2 calls and 0 PAYs. Three
more cases also fail there:

- "retried after its backoff even when nothing else happens";
- "a burst of flushes … never writes a transient failure off in under a second": round 4 gave it
  up after 3 flushes, in about 75 ms;
- "a PAY refused for ~1 s … is retried within the drain and paid" (`viewer-payer`).

**Fix** (`UpstreamPayer`): the round-4 epochs are gone.

- Each core keeps a streak of transient failures: how many, since when, and `retryAt`.
- The backoff is `PAY_RETRY_BASE_MS` (250 ms), doubling per failure up to `PAY_RETRY_MAX_MS`
  (4 s).
- Once the backoff is over, **any** pass retries the core: a block, an ACK, pool pressure or
  `flush()`. The failed run is then due however short, because it was due when it failed.
- A per-peer **retry timer** wakes the payer at `retryAt`. A seeder at its cap sends nothing,
  and pressure may never come, so without the timer nothing would retry. The timer is unref'd
  and cleared on detach and dispose.
- **The give-up is bounded in time.** A failing range is given up only after at least
  `MAX_PAY_FAILURES` (3) attempts over at least `PAY_GIVE_UP_MS` (30 s). After that, each later
  failing range of that core is given up at once, until a PAY of the core succeeds.
  - 30 s is longer than a mint blip or an auto top-up, and longer than the close drain (5 s). The
    drain therefore never writes a transient failure off itself: when it ends, the session is
    gone and the next try is refused `session-closed` (final).
  - `session-closed` and `forbidden` stay final at once.

Two round-4 tests asserted the behaviour this finding calls a defect. They were **changed, not
weakened**, each with a comment citing round 5:

- "retried at the next flush" now advances the clock past the backoff first. It also asserts
  that a flush inside the backoff does NOT retry.
- "given up after `MAX_PAY_FAILURES` attempts" now lets the clock run. It asserts that attempts
  alone never give up before `PAY_GIVE_UP_MS`, that the give-up happens after it, and that
  nothing is tried afterwards.

New tests (`upstream-payer.test.ts` × 5, `viewer-payer.test.ts` × 1):

- the reviewer's repro;
- the timer alone retries;
- a failed short tail is retried as a tail by its timer;
- a failed run is due by its own streak after another core's block;
- the burst;
- the drain with a ~1 s refusal.

### 3. The close drain waited on the whole core (MEDIUM) — fixed

**Reproduced.** The reviewer's repro in `desktop-pays` measures `play.close(A)` while B streams on
the same core and requires it to answer in under `CLOSE_DRAIN_MS`. Mutation H4 (`closeSession`
drains without a range, i.e. every tail and everything owed or in flight) fails that assertion.
The unit test "returns as soon as ITS tail is paid while another session of the same core has
blocks owed" fails when the settle check ignores the range (V1).

**Fix.**

- `ViewerPayer.drain(ms, range)` takes the closing session's blob range, and `closeSession`
  passes it.
- **Paying.** It pays only that range now: the new `UpstreamPayer.hurry(range)` makes that
  range's runs due however short, including a block of it that lands during the drain, until it
  is released. B keeps batching. Round 4 flushed every tail, and followed the peer's whole chain
  while B streamed.
- **Waiting.** It waits only for that range. The new `CreditSettler.owedOn(core, range)` counts
  owed blocks in the range. `OnePeerRouter.inflightOn(core, range)` counts the blocks of the
  range with a request out or being verified: the no-race queue's tracked block requests, which
  hypercore adds on send and removes on resolve (the pinned internals). Without a range, both
  keep their round-4 meaning.

Tests:

- `viewer-payer.test.ts` × 2: returns while B's block is owed and does not pay it; a block of
  the range that lands during the drain is paid.
- `seeder-credit.test.ts` × 1: `owedOn` with and without a range, and after a link goes.
- `one-peer-router.test.ts` × 1, on real corestores: two withheld requests, counted per range.
- `desktop-pays`: the timing assertion above.

### Mutation checks (round 5)

Each mutation was applied alone by a script in the scratchpad and the named tests were run. The
file was then restored, with `tsc -b` re-run where the consumer reads `dist`.

| # | Mutation | Result |
|---|---|---|
| — | whole-file revert of `payer.ts` to `80f8dd5` | caught: 8 `upstream-payer` tests (both changed round-4 tests and 6 new ones) |
| T1 | no retry timer | caught: 4 (the timer alone, the tail retry, the burst, the give-up) |
| T2 | no backoff (retry on every pass) | caught: 4 (the changed transient test, the repro, the burst, the timer) |
| T3 | give-up by count only (round 4) | caught: the burst and the changed give-up test; `viewer-payer` "refused for ~1 s" |
| T4 | no next run after a range is given up | caught: "gives up THAT range only" (after it was tightened, see below) |
| T6 | `boundRange` ignored | caught: the `boundRange` test |
| T7 | `hurry` ignored | caught: the `hurry` test |
| T8 | a failed run not due by its streak | caught: "due by its own streak" (a test added for it, see below) |
| T9 | a hurried block that lands does not schedule a pass | caught: the `hurry` test's `payEveryBlocks: 4` case (added, see below) |
| V1 | `drain` settles on the whole core | caught: `viewer-payer` "returns as soon as ITS tail is paid…" |
| V2 | the scoped drain flushes everything | caught: same (B's block paid) |
| V3 | the scoped drain pays nothing itself | caught: 2 `viewer-payer` drain tests |
| V4 | `ViewerPayer` does not pass `boundRange` on | caught: "boundRange reaches the payer" |
| H1 | round 4's lookup (by core, open first, one session) | caught: 3 `desktop-pays` tests (the repro, then the quit and next-start cases) |
| H1b | `sessionsCovering` by core only | caught: 2 `session-ranges` tests |
| H1c | closing sessions before open ones | caught: `session-ranges` "open sessions first" |
| H4 | `closeSession` drains without a range | caught: `desktop-pays` rendition switch (`play.close` timing) |
| H5 | no bound at session boundaries | caught: 3 `session-ranges` tests; **not** by `desktop-pays` (see below) |
| R1 | the first refusal is final | caught: 2 `real-providers-sessions` tests |
| R2 | any failure tries the next session | caught: "any other failure … is not tried on another session" |
| S1 | `countIn` ignores the range | caught: `one-peer-router` `inflightOn` |
| S2 | `inflightOn` ignores the range | caught: same |
| G1 | `owedOn` ignores the range | caught: `seeder-credit` `owedOn` |

**Survivors on the first run, and what was done.**

- **T4.** The first version of the test had passes from the downloads that also reached the
  second run. It now uses a batch of 8, so `flush()`'s single forced pass has to reach it.
- **T8.** The tail-retry test was forced anyway (`due` stays set after a tail), so it could not
  see T8. A new test ends the quiet spell with another core's block before the retry.
- **T9.** The `ViewerPayer` pays every block (`payEveryBlocks: 1`), so every download schedules a
  pass whatever `hurry` does. A gateway-style rig (`payEveryBlocks: 4`) was added.
- **H5 in the integration suite.** Measured (a probe in the test, then removed): each host
  `pay.build` takes about 1.5 s here. A's last block is always paid together with the block
  before it before B's first blocks land, so the two runs never merge in this suite, and
  "renditions side by side" stays a scenario test. The bound is proven at unit level
  (`session-ranges`, `upstream-payer`, and the `viewer-payer` wiring).

### Gates (round 5)

- Touched packages: `npx vitest run packages/gateway packages/seeder packages/app-desktop
  --maxWorkers=2` gave 3 failures, in `money.test.ts` (2) and `guards.test.ts` (1). Those files
  are untouched, each test took 6–8 s, and the load average was about 20. Rerun alone, both files
  passed (364 tests); every other test passed (1987 passed, 5 skipped).
- Whole suite, once: `npx vitest run --maxWorkers=2` gave 211 files (206 passed, 2 failed,
  3 skipped) and 3193 tests: 3169 passed, 21 skipped (the real-mint suites gated on
  `NUTFLIX_REAL_MINT_URL`) and 3 failed. All three were `Test timed out in 5000ms` in untouched
  files, `auto-topup.test.ts` (2) and `money.test.ts` (1), at a load average of about 20. Those
  files import nothing this round changed (only a type from the unchanged host supervisor). Each
  test passes alone, and `money.test.ts` passed alone as a whole file earlier.
- `npx tsc -b --force`: clean. `eslint` and `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK (no locked path touched). `npm run lint:electron`: OK, 0 violations.
- The Electron e2e was not run.
- **No test was deleted or weakened.** Changed tests:
  - the two round-4 payer tests above, with comments citing round 5;
  - `real-providers-journal.test.ts` and `dleq-thread.test.ts` pass `sidsFor: () => []` for
    `sidFor: () => undefined` (the option was renamed);
  - the harness now carries the host's real error codes.

  No timeout was raised. The new tests' in-test deadlines are their own.

### Residuals (round 5)

- **Two windows on the SAME rendition.** Closing one window while the other streams that blob:
  the drain waits for owed and in-flight blocks in its range, and the other window's blocks are
  in the same range. That close can run to `CLOSE_DRAIN_MS` (bounded, and it pays correctly). A
  rendition switch uses a different blob and is not affected. Telling the two apart needs
  per-session attribution of requests; the gate stops tracking at close.
- **One PAY per core in flight** (F30) still couples A's tail to a PAY of B's that is awaiting its
  ACK on the same core. That is one round trip, not a drain.
- **`flush()` respects the backoff.** A core backing off at the moment of a final flush (gateway
  shutdown, worker quit after its drains) is not retried by that flush. Its blocks stay owed, as
  they would if the retry had failed.
- **Spend attribution.** After a switch, A's tail PAY is still reported as a spend of the newest
  session of the core (`onPaid`), so it adds to B's totals. This is display only (the wallet was
  debited by `pay.build`). Reporting it under A would lose it, since the host ignores spends of a
  closed session. Pre-existing, and unchanged.
- **The bound's integration coverage** is timing-bound (see H5); it is proven at unit level.
- **On hold:** the image-fetch probe, `PRICE` / `announceCorePrices`, and IR4.
