# Lane I3-pack-lows — packaging lows from the cross-lane review (rounds 4 and 5)

Branch `stage-3/int-packaging-lows`, off `e55adf0` (lane I1's head: the packaged DLEQ thread
fix, on the Stage 3 integration head with packaging #6 merged). Date: 2026-09-25. Commits:
`c7d44f5` (the switches), `b2f0762` (staging: freshness and test doubles), then this report,
the review record and ADR 0017. Review record: `docs/reviews/2026-09-25-pre-push-int-packaging-lows.md`, whose "Cross-lane review
(round 4)" section has each finding and its mutation checks. ADR 0017 §1, §2 and §4 and its open
questions were updated.

- No contract request.
- Nothing changed under `packages/core/src/contracts/`, the locked paths, `docs/status.md` or
  `docs/security-review.md`.
- Nothing outward: no push, MR or issue edit.

## The four findings

| Finding | Outcome |
|---|---|
| LOW: stage/package/make shipped workspace `dist/` without checking it is current | **fixed**: `stageApp` refuses a build older than its sources |
| LOW: a packaged build let other sandbox-weakening and process-wrapper switches through | **fixed**: 10 more sandbox switches refused in every build; 8 process/V8/isolation switches refused when packaged |
| INFO: core's mocks were in the packaged host bundle | **fixed**, packaged host bundle only: stubs that throw, plus a fail-closed guard |
| INFO: `GrantFileProtocolExtraPrivileges` still Enabled | **deferred**: Cameron's fuse question, ADR 0017 open question 8, now with the reviewer's read-back |

### 1. The build the stage copies must be current

The stage compiles main, the host and the worker glue from `src/`, but it ships two things it
never compiles:

- the workspace packages' `dist/`, copied into `node_modules/` for the worker and inlined into
  the host bundle;
- `scripts/bundle.ts`'s output: the renderer, the prompt and the preloads.

Reproduced on the base: I changed core's `meltTimeoutMs` default in `src/` and ran
`node packaging/stage.ts`. It exited 0, and the staged core still said `3e5`.

`assertCurrentBuild` (in `packaging/stage.ts`) now runs before `out` is touched. It refuses when
any of these holds:

- TypeScript's own `tsc -b --dry`, through its API, would rebuild core, gateway, seeder or
  `@sovit/ui`. A touched-only source ("would update timestamps") counts as current. A shipped
  package must also have its `main` and `exports` files, because the dry run does not notice
  outputs deleted by hand.
- `@sovit/ui`'s `dist/*.css` is older than its `src/` stylesheets.
- A bundle output the stage copies is older than the newest file the bundle reads: under
  `src/renderer`, `src/preload`, `src/ipc`, `static/`, or `@sovit/ui`'s `dist/` (round 5) or
  `src/`. Tests and stories do not count.

With the reviewer's mutation, the stage now exits 1 and names `packages/core/tsconfig.json`; the
previous stage is left as it was. Refusing was chosen over rebuilding:

- the packaged-worker integration test spawns the stage during the suite, so a rebuild there
  would rewrite `dist/` under the other test files running in parallel;
- `npm` cannot be spawned the same way on Windows runners;
- the stage keeps writing nothing outside `out`.

**For whoever runs the suite next:** `stage.test.ts` and `packaged-worker.integration.test.ts`
now need a current build. After a merge that touches core, gateway, seeder, ui, or the app's
renderer, preload, ipc or static sources, run `npm run build` before `npx vitest run`.
Otherwise those two files fail with a StageError naming what is stale. Since round 5 this also
applies after `npx tsc -b --force`: it rewrites ui's `dist/`, so the bundle has to be rebuilt.

### 2. The other switches a wrapper could add

Main's refusals keep their order: Squirrel, then sandbox, dev flags, remote debugging, and the
new step last.

- **Every build (D4).** `SANDBOX_BYPASS_SWITCHES` grows from 3 to 13. It adds the reviewer's
  `disable-seccomp-filter-sandbox`, `disable-namespace-sandbox`, `disable-setuid-sandbox` and
  `no-zygote-sandbox`, and also `disable-landlock-sandbox`, `allow-sandbox-debugging`,
  `gpu-sandbox-allow-sysv-shm`, `disable-webnn-compiler-sandbox`, `single-process` and
  `in-process-gpu`.
- **Packaged builds only** (new, after remote debugging). `PACKAGED_REFUSED_SWITCHES`:
  `renderer-cmd-prefix`, `utility-cmd-prefix` (the host is a utility process), `gpu-launcher`,
  `zygote-cmd-prefix`, `browser-subprocess-path`, `js-flags`, `disable-site-isolation-trials`
  and `disable-web-security`. Refusing one logs `app.process-switch-refused` and exits 78. A
  dev build keeps them.
- **Checked:** every name is a string in Electron 44.2.0's Linux binary.
- **Not checked:** no Electron was launched, because this box cannot start Chromium's sandbox
  without Cameron's grant.
- **Deferred:** `--enable-features` / `--disable-features` are ADR 0017 open question 11.

### 3. core's test doubles out of the packaged host bundle

core's barrel re-exports `mocks` (TestMint, MockWallet, MockPaymentEngine, the fixtures) and
`nostr.FakeRelayPool`, so the bundler could not drop them from the host bundle. The host
reaches them only behind `--dev-mocks` / `--dev-fixtures`, which a packaged main refuses.

The host build now bundles those two modules as stubs. Each stub has the same export names, and
each export throws when touched. A guard fails the stage if any other module of core's `mocks/`
gets in.

- The staged host bundle loads in plain Node, which a test checks.
- It carries no build-machine path, and it shrank by about 72 KB.
- The dev host and the worker's copy of core are unchanged.

## Round 5 (the round-4 verifier's findings)

Commits: `26f4e98` (the rule and its tests), then this report, the review record and ADR 0017.
Review record: the "Round 5" section of `docs/reviews/2026-09-25-pre-push-int-packaging-lows.md`.

| Finding | Outcome |
|---|---|
| LOW: the renderer freshness rule watched `@sovit/ui`'s `src/`, but the bundle reads its `dist/`, so a bundle made from an old ui `dist/` staged | **fixed**: rule (3) also watches each bundled workspace's `dist/` (`bundleInputDirs`) |
| INFO: ADR 0017 §4 listed `SANDBOX_BYPASS_SWITCHES` after the remote-debugging check | **fixed**, doc only: §4 gives main.ts's order with each list named where it runs |

- **The renderer rule.** The verifier's probe: edit a ui source, bundle (as `npm start` does),
  `tsc -b packages/ui`, then stage. On the round-4 code it exited 0 and shipped the old
  renderer. `scripts/bundle.ts` reads the UI through its package exports: 74 renderer inputs
  lie under `packages/ui/dist`, none under `src/`, and it copies `dist/ui.css`. The watched
  set is now `BUNDLE_SOURCES` plus each bundled workspace's `dist/` and `src/`. On the real
  worktree the probe and its CSS form now exit 1 and name a ui `dist/` file. After the file is
  restored and rebuilt in order, the stage exits 0.
- **New tests.** Two synthetic cases in `stage-guards.test.ts`: the probe, and its CSS form.
  Each is refused, then re-bundled, staged, and the new value ships. One real-app pin in
  `stage.test.ts`: the renderer bundle's metafile inputs and the copied stylesheet must all
  lie under `bundleInputDirs`.
- **One changed assertion.** In the round-4 ui case, the refusal now names ui's
  `dist/ui.css`, the file the bundle copies, instead of `src/ui.css`. It is commented in
  place, and it is still exact.
- **Mutations.** M5a: the round-4 rule put back fails 4 tests. M5b: `src/ipc` dropped from
  `BUNDLE_SOURCES` is caught by the new pin; the round-4 pin missed it. M5c and M5d: the real
  probes.
- **Gates.** Packaging tests: 44 passed. Whole suite (`--maxWorkers=2`, after
  `npm run build`): 3166 passed, 21 skipped, 6 failed. All 6 are 5 s timeouts in
  `host/__tests__/{auto-topup,money}.test.ts`, under a load average of 23–26 on 8 cores; this
  round neither touches nor imports those files. Rerun alone, both pass (55/55 and 8/8), and
  the packaged-worker integration test passes (2/2). `tsc -b --force`, eslint, prettier,
  `check:locked` and `lint:electron`: clean. No timeout was raised. No Electron e2e.
- **New residual R-8.** ui's whole `dist/` is watched, so files the renderer never imports can
  refuse a stage: extra refusals, never missed ones. `tsc -b --force` needs `npm run build`
  after it.

## Files

- New:
  - `docs/reviews/2026-09-25-pre-push-int-packaging-lows.md`
  - this file
- Changed:
  - packaging: `packaging/stage.ts`, `packaging/cli.ts` (comment);
  - main: `src/main/security.ts`, `src/main/main.ts`, `src/main/log.ts`;
  - tests: `packaging/__tests__/{stage,stage-guards}.test.ts`,
    `src/main/__tests__/{security,main-wiring}.test.ts`;
  - docs: `docs/decisions/0017-packaging.md`.
- Round 5 changed: `packaging/stage.ts`, `packaging/__tests__/{stage,stage-guards}.test.ts`,
  `docs/decisions/0017-packaging.md` (§1 rule 3, §4 order), the review record and this file.
- No test was deleted or weakened. The stage-guards fixture now writes its bundle outputs
  after its sources, as a real build leaves them; this is commented in place.

## Tests and gates

- New tests:
  - `security.test.ts`: 23 (13 + 8 it.each cases, 2 list checks);
  - `main-wiring.test.ts`: 19 (10 sandbox cases, dev and packaged; 8 packaged-only cases; the
    order test);
  - `stage-guards.test.ts`: 11 (the shipped workspace case covers stale, rebuilt and touched;
    a deleted entry point; a missing tsconfig; 4 bundle-source cases; the ui case; 3
    test-double cases);
  - `stage.test.ts`: 3 (the real lockfile's workspaces; `BUNDLE_SOURCES` against
    `scripts/bundle.ts`; the real host bundle).
- Mutations: 12 applied one at a time (M1a–f, M2a–c, M3a–c; M1f is the reviewer's case, run
  on the base and on this lane). All were caught; see the review record.
- Gates:
  - `npx vitest run --maxWorkers=2` in `packages/app-desktop`: 1605 passed, 1 skipped (before
    the entry-point check and the stub helper's rename, both covered by the full run below);
  - `npx vitest run --maxWorkers=2` (whole suite, final code): 3169 passed, 21 skipped,
    0 failed. An earlier whole run had 1 failure in `stage-guards.test.ts`; that file was being
    edited while the run was going. It was not a timing failure, and the final run is clean;
  - `npx tsc -b --force` (final code), eslint and `prettier --check` on the changed files:
    clean;
  - `npm run check:locked` and `npm run lint:electron`: OK;
  - the Electron e2e was not run.

## Residuals

Detail in the review record.

- **R-1** The freshness rules, TypeScript's included, trust mtimes. A source restored with an
  older mtime (`tar -x`, `cp -p`) is not seen as stale.
- **R-2** A file deleted by hand deep inside a shipped `dist/` is not detected; only the entry
  points are checked.
- **R-3** npm packages inlined into the renderer (react, uqr) are not freshness inputs.
- **R-4** The packaged host's module graph differs from the dev host's in the two stubbed
  modules. The clean fix is a `@sovit/core/mocks` subpath (outside this lane). The worker's
  `node_modules/` copy of core still has `mocks/`.
- **R-5** The switch refusals were not run in a real Electron: the sandbox cannot start here.
- **R-6** `e2e/support.ts` still says "main refuses the first three". That file is outside this
  lane.
- **R-7** For Cameron: ADR 0017 open questions 8 (fuses) and 11 (feature switches).
- **R-8** (round 5) ui's whole `dist/` is a freshness input, including files the renderer
  never imports: extra refusals (after `npx tsc -b --force`, until `npm run build`), never
  missed ones.

## Proposed `docs/status.md` row (Stage 3 table)

| Packaging lows, cross-lane review round 4 (issue #6, lane I3-pack-lows) | `stage-3/int-packaging-lows` | **done**. The stage now refuses a build older than its sources, before touching `out`: TypeScript's own dry build over core, gateway, seeder and ui (a touched-only source counts as current; a shipped package's entry points must exist), ui's stylesheets, and the renderer/prompt/preload bundles against everything they read, ui's built `dist/` included (round 5). So a local `make` can no longer ship a stale core, as the reviewer's melt-timeout mutation showed it could. `stage.test.ts` and the packaged-worker integration test therefore need `npm run build` after source changes. Main refuses 10 more sandbox switches in every build (seccomp, namespaces, setuid, zygote sandbox, Landlock, sandbox debugging, single-process, in-process GPU…) and, when packaged, the process wrappers (`renderer/utility-cmd-prefix`, `gpu-launcher`, `zygote-cmd-prefix`, `browser-subprocess-path`), `js-flags` and the isolation overrides, in the existing order. The packaged host bundle carries stubs instead of core's test doubles, and a guard fails the stage if any gets in. Deferred to Cameron: `GrantFileProtocolExtraPrivileges` (open question 8) and `--enable/disable-features` (open question 11) |
