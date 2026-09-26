# Lane I1-dleqpack — the DLEQ thread in the packaged app, and a TMPDIR cascade

Branch `stage-3/int-dleq-packaging`, off the Stage 3 integration head `9a20d30` (auto top-up #2,
residuals #8, F33 #1, packaging #6 merged). Date: 2026-09-25. Commits: `4ca8b21` (task 1),
`47a3520` (task 2), then this report and the review record. Review record:
`docs/reviews/2026-09-25-pre-push-dleq-packaging.md`. ADR 0017 §2 and §4 were updated. There is
no contract request, and nothing under `packages/core/src/contracts/`, the locked paths,
`docs/status.md` or `docs/security-review.md` changed.

## Task 1: the DLEQ thread entry was never found in a packaged build

**What was wrong.** Issue #8 (d) moved a PAY's DLEQ checks onto a `Bare.Thread` (security review
F5). `adapters/bare.ts` located the thread's entry as `../pay/dleq-thread-entry.mjs` relative
to itself. That path is right in `dist/`. Packaging (ADR 0017) then bundled the worker into
`worker/worker.mjs`, where the same path climbs out of `worker/` to a file that does not exist,
and staging never wrote the entry at all. Every packaged build therefore fell back to the
chunked checks on the worker's event loop, and logged nothing. Reproduced by the new
packaged-worker assertion (`where: "inline"`, `onThread: 0`).

**What changed.**

- `src/worker/worker-root.ts` (new) resolves `./pay/dleq-thread-entry.mjs` from a module that
  sits at the worker root in both layouts: `dist/worker/` in dev, inlined at the root of
  `worker/worker.mjs` when packaged. It holds only `./` paths, so nothing it resolves can leave
  the worker directory. `adapters/bare.ts` takes the entry from it, and `bareDleqThread` now
  refuses a symlinked entry (`lstat`).
- `packaging/stage.ts` builds the entry into `worker/pay/dleq-thread-entry.mjs` as its own
  bundle, restricted to `src/worker/pay` and `src/ipc`. Its npm imports (`@sovit/core`,
  `bare-encoding/global`) must be shipped, and Bare resolves them from `worker/pay/` up to the
  staged `node_modules/`. It is a bundle, not a copy of the dev entry, because the dev entry's
  relative imports do not exist next to it once the worker is a single file (mutation M1c).
  esbuild keeps every inlined module lazy, so all of them still run inside the entry's `try`.
- `packaging/layout.ts` (the postPackage gate) requires `identity.ts` `UNPACKED_FILES` (the
  boot module, the bundle, the thread entry) to be unpacked regular files: not missing, not a
  symlink, not a directory, and not under a symlinked directory.
- **Diagnostics.**
  - `dleqVerifier` counts what each path answered (`answered()`).
  - It says once, at info, when the thread first answers.
  - It says once, at warn, when a runtime with threads cannot start one (the silent case).
- `--dev-fixtures` self-check (`src/worker/dev/dleq-selfcheck.ts`). On Bare, the worker checks
  four fixed test vectors (three valid, one forged) through the same verifier the real providers
  use, first inline and then on the thread. It logs one line: where they ran, the counts, and
  whether the verdicts were right. Nothing secret or peer-identifying is in it. `close()` stops
  and joins its thread before anything else. The vectors are fixed because Bare has no
  `crypto.getRandomValues` to issue proofs with. They come from core's in-process `TestMint`
  under a `.invalid` mint URL, and a Node test re-checks them with core's `proofDleqOk`.
- **The grep.** No other `new URL(…, import.meta.url)` or runtime-loaded file exists in
  `src/worker`. Every other dynamic `import()` there has a string literal, and esbuild inlines
  those (`dev/*`, `pay/real-providers.js`) or leaves them as npm packages resolved from
  `node_modules/`. ffmpeg is the system's (ADR 0005). The workspace packages' own
  `import.meta.url` uses (`@sovit/seeder`'s `dleq-pool.ts` and `mint-http.ts`, gateway) are
  Node-only and ship unbundled with their `dist/`.

**Proof.** `src/host/__tests__/packaged-worker.integration.test.ts` stages the real app, lays it
out as `resources/app.asar.unpacked`, and boots the staged worker through the staged
bare-sidecar and the real `WorkerSupervisor`. It now also asserts:

- the entry is a regular file at `worker/pay/dleq-thread-entry.mjs`;
- the staged worker's self-check line is `level: info`, `where: thread`, `onThread: 4`,
  `verdicts: right`.

A `Bare.Thread` started from the staged entry therefore loaded core from the staged
`node_modules` and answered as core does. With the old URL (M1a), with the entry staged under
another name (M1b), and with the unbundled dev entry copied in (M1c), the same test fails with
`where: inline`.

## Task 2: a timed-out real-maker test cascaded into 10 ENOENT failures

`scripts/__tests__/release.test.ts` now records `TMPDIR` at module load and restores it (or its
absence) in `afterEach`, before cleanup. `makerNames` goes through `tmpdirInto()`, whose restore
acts only while `TMPDIR` is still the one it set, so a late restore from an outlived run leaves
the next test's `TMPDIR` alone. Three ordered tests pin this:

1. one leaves `TMPDIR` in its own dir, as a timeout does;
2. the next finds it restored and can make a temp dir;
3. a late restore leaves the current value alone.

Manual check, with that test's timeout cut to 300 ms: before the fix, 11 failed (the timeout
plus 10 × ENOENT); after, 1 failed (the timeout). Nothing was left in `/tmp`.

## Files

- New:
  - `packages/app-desktop/src/worker/worker-root.ts`
  - `packages/app-desktop/src/worker/dev/dleq-selfcheck.ts`
  - `docs/reviews/2026-09-25-pre-push-dleq-packaging.md`
  - this file
- Changed:
  - worker: `src/worker/adapters/bare.ts`, `src/worker/pay/dleq-thread.ts`,
    `src/worker/host.ts`;
  - packaging: `packaging/stage.ts`, `packaging/layout.ts`, `packaging/identity.ts`;
  - tests: `packaging/__tests__/{stage,stage-guards,forge-config}.test.ts`,
    `src/host/__tests__/packaged-worker.integration.test.ts`,
    `src/worker/__tests__/{dleq-thread,bare-dleq-thread}.test.ts`,
    `scripts/__tests__/release.test.ts`;
  - docs: `docs/decisions/0017-packaging.md`.
- No test was deleted or weakened. The only changed assertions are extensions:
  - `stage.test.ts`'s `worker/` listing gains `pay`;
  - `forge-config.test.ts`'s fake package writes every `UNPACKED_FILES` entry;
  - the stage-guards fixture gains a thread entry, so each existing case still breaks one rule.

## Tests and gates

- New tests:
  - staging: `stage.test.ts` 2 (where the bundle resolves the entry; every import dynamic, npm
    ones shipped and found from `node_modules/`), `stage-guards.test.ts` 3 (missing source,
    allow-list, unshipped import);
  - layout gate: `forge-config.test.ts` 2 (missing, symlink, directory and symlinked-directory
    cases; the pin between `worker-root.ts` and `identity.ts`);
  - worker: `dleq-thread.test.ts` 11 (counters and diagnostics; the self-check on a working
    thread, with none, with a thread failing at start, with wrong verdicts, and when stopped
    early; `WorkerHost` wiring and `close()` order, 3 tests), `bare-dleq-thread.test.ts` +1
    assertion (a symlinked entry, under real Bare);
  - integration: `packaged-worker.integration.test.ts` +2 assertions (real Bare, staged tree);
  - release: `release.test.ts` 3.
- Mutations: 25 applied one at a time (M1a–c, L1, V1–4, S1–4, H1–2, P1'–P8, R1–2). All were
  caught except the self-check loader's closing guard (defence in depth, residual R-3). Details:
  the review record.
- Gates:
  - `npx vitest run packages/app-desktop scripts/__tests__ --maxWorkers=2`: 1604 passed,
    1 skipped;
  - `npx vitest run --maxWorkers=2`: 3113 passed, 21 skipped, 0 failed;
  - `npx tsc -b --force`, eslint and `prettier --check` on the changed files: clean;
  - `npm run check:locked` and `npm run lint:electron`: OK;
  - the Electron e2e was not run.

## Residuals

Detail in the review record.

- **R-1** The unpacked thread entry is outside the asar integrity fuse, like the worker bundle
  (ADR 0017 open question 5).
- **R-2** At runtime only the entry itself is `lstat`ed. The layout gate also refuses symlinked
  directories.
- **R-3** The loader's closing guard has no failing test.
- **R-4** Pre-existing: `Bare.exit` after an uncaught exception can hang on a parked DLEQ thread.
  In dev this is a start-up window of about a second; for a real-payments seller it lasts the
  worker's life.
- **R-5** Production reports the thread only at a seller's first PAY, or when none could start.

## Proposed `docs/status.md` row (Stage 3 table)

| DLEQ thread in the packaged app (issue #8 d × #6, lane I1) | `stage-3/int-dleq-packaging` | **done**. The packaged worker never found its DLEQ thread entry (`../pay/` from an inlined module climbed out of `worker/`, and staging never wrote it), so every packaged build checked PAYs' DLEQ proofs inline on its event loop, and logged nothing. Now the entry is resolved from `src/worker/worker-root.ts` (the worker root in both layouts, `./` paths only). It is staged as its own bundle at `worker/pay/dleq-thread-entry.mjs` (`src/worker/pay` + `src/ipc` only, npm imports shipped), required by the layout gate as an unpacked regular file (no symlink, no symlinked directory), and a symlinked entry is refused at runtime. The verifier says which path is in use, and `--dev-fixtures` runs a one-line DLEQ self-check. The packaged-worker integration test (real Bare, staged tree) shows `where: thread` with core's verdicts. Also: a timed-out real-maker test no longer cascades into 10 ENOENT failures (`TMPDIR` restored in `afterEach`) |
