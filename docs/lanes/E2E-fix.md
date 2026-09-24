# Lane E2E-fix — make the Stage 1 Electron end-to-end suites pass

**Issued against `CONTRACTS_VERSION = 4`**. Date: 2026-09-23. Branch `lane/E2E-fix` off `d4134dc`.
Spec: `docs/plan/L6-design.md` §5(b) and D4; the orchestrator's triage (five failures, each proven
by a reverted temporary patch). Allowlist: `packages/app-desktop/{src/main,src/host,src/preload,
src/renderer,src/worker,e2e}/`, `docs/lanes/{L6-A,E2E-fix}.md`. No contract request, no
`package.json`/lockfile change, no dependency, no renderer/preload/worker edit.

## Result

- **`fidelity.e2e.ts`: 3/3 green in a row, 5/5 tests each; `stage1.e2e.ts`: 3/3 green in a row,
  8/8 tests each** — on the final build (`5caf90b`), no code change between runs, serial, 1-min
  load average 2.7–4.1:

  | Run | fidelity (wall) | stage1 (wall) |
  | --- | --------------- | ------------- |
  | 1   | 5.4 s           | 10.8 s        |
  | 2   | 5.2 s           | 10.3 s        |
  | 3   | 5.2 s           | 11.0 s        |

  Per test (stage1 run 3): posture 11 ms, bridge allowlist 50 ms, price → Play → plays → seek
  3.3 s, WalletChip rate 9 ms, `_blank` 620 ms (a fixed 500 ms negative window), Watch → Home 102
  ms, Watch → Watch 1.2 s, CSP 0 ms. Fixture generation (two 90 s CBR MP4s) is ≈ 3–4 s of the wall
  time; the worker announces its fixtures ≈ 1.3 s after it is ready.

- Both suites in one serial invocation from `packages/app-desktop` (the command proposed for
  `test:e2e` below): 13/13 in 14.6 s.
- `npm run ci`: exit 0, 124 files, 2085 passed / 27 skipped (details under "Tests").
- The fidelity findings JSON and the working recipe are in `docs/lanes/L6-A.md` ("Running the
  Electron suites", "Fidelity findings (first run, 2026-09-23)").

## Every failure: root cause, owner, fix, test

### 1. Playwright adds `--no-sandbox`

- **Symptom**: fidelity reported `noSandboxSwitch: true`; stage1's main refuses that switch (exit
  78, `security.ts`), so it could not start at all.

- **Root cause**: playwright-core 1.63's `Electron.launch` prepends `--no-sandbox` on Linux unless
  `chromiumSandbox: true` is passed (`node_modules/playwright-core/lib/coreBundle.js`).
- **Owner**: `e2e/` (suite tooling).
- **Fix**: `launch()` passes `chromiumSandbox: true`, then `sandboxPosture()` + `assertSandboxed()`
  refuse the app unless main's `commandLine` and argv carry none of six sandbox-bypass switches and
  the window's renderer has `Seccomp: 2` and its own PID namespace (`NSpid`, `/proc/<pid>/status`).
- **Test**: runs on every launch; recorded in the fidelity findings (`launch.sandbox`,
  `noSandboxSwitch: false`); stage1 test 1.

### 2. Product bug — the host exited 2 and main respawned it until the budget was gone

- **Symptom**: every respawn reloaded the window ("context destroyed by navigation"); nothing loaded.
- **Root cause**: main's `hostArgs()` sent `--user-data=<dir>`; the host's strict `parseHostArgs`
  requires `--user-data-dir=<abs>` AND `--worker-entry=<abs>` ("unknown host argument").
- **Owner**: `src/main/` (`args.ts`, `main.ts`).
- **Fix**: main sends `--user-data-dir=` and `--worker-entry=<dist>/worker/entry.js`, resolved from
  main's own `dist/` (the tsc output, never a bundle — D6). `HOST_ENTRY`/`WORKER_ENTRY` moved to the
  Electron-free `args.ts`.
- **Test**: `host-link.test.ts` feeds main's `hostArgs()` for four argv sets to the host's REAL
  `parseHostArgs()` (cross-project import by path) and checks the meaning survives; shows the old
  spelling is refused; checks both entries exist under `dist/`. `main-wiring.test.ts` feeds the argv
  `main.ts` really forks with to the host parser.

### 3. Product bug — Home showed only the mock catalogue ("E2E fixture A" never appeared)

- **Root cause**: boot race. Home fetches its feed once, at mount, ≈ 0.9 s before the worker's
  `dev.fixtures` event reaches `FixtureCatalog`, and never refetches.
- **Owner**: `src/host/` (`catalog/fixture-catalog.ts`, `host.ts`).
- **Fix**: under `--dev-fixtures`, `feed`/`video`/`videos`/`related`/`search`/`seedersOnline` wait
  for the first `dev.fixtures`, bounded by `FIXTURE_WAIT_MS` = 15 s from construction (clamped);
  the wait ends at once when the worker is `failed` or `stopped` (`host.ts` `onState`; `down`
  restarts and re-announces, so it keeps waiting); past the bound reads answer with what is there
  and it is logged once. `profile()` never reads the live set and does not wait. Non-fixture paths
  are unchanged.
- **Test**: `fixture-catalog.test.ts` (6, manual clock): reads pending until the event, then live
  first; the bound (pending at −1 ms, answers at the bound, logged once, later reads immediate, a
  late event still applies); `workerGone` ends the wait and clears the timer; the clamp; `profile`.
  `adapter-studio.test.ts`: a feed read before the event resolves with the live fixture first; a
  worker that fails for good, and a stopped host, release waiting reads. Mutation-checked: removing
  the wait fails 4 tests.

### 4. The fixtures were too small

- **Symptom**: the seek never needed a second Range, there was barely a streaming rate, and the
  video had ended (t = 6, paused) before the WalletChip and mini-player steps.
- **Root cause**: the 6 s lavfi `testsrc` MP4 is 39 977 bytes — one 64 KiB block.
- **Owner**: `e2e/support.ts`.
- **Fix**: 90 s at a forced 2 Mbit/s (CBR x264 `nal-hrd=cbr`, keyframe every 2 s, `+faststart`,
  `ultrafast`): ≈ 22.5 MB ≈ 343 blocks, ≈ 2 s to make. A size check fails loudly if CBR is not
  honoured.
- **Test**: both suites.

### 5. Display: headless segfaults, Wayland hangs, the X11 window was 360×480

- **Root cause**: Electron 44.2.0 null-calls at `new BrowserWindow` under
  `--ozone-platform=headless` and hangs before `ready` under Wayland; GNOME's Xwayland screen has
  no monitor (0×0), so the window is clamped to `minWidth`.
- **Owner**: `e2e/support.ts`.
- **Fix**: X11 only by default — `DISPLAY`, else GNOME's Xwayland discovered (`/tmp/.X11-unix/X<n>`
  owned by the user + mutter's auth FILE path as `XAUTHORITY`; the cookie is never read).
  Headless/Wayland only via `NUTFLIX_E2E_DISPLAY`, with the reason documented. The window is
  `setSize(1280, 800)` after launch (test-only; the app's own window options are untouched).
- **Test**: both suites.

### 6. The seek assertions could pass without the seek (found here)

- **Root cause**: Chromium re-requests near the start on its own within the first second
  (`bytes=524288-`, `bytes=917504-`/`bytes=1048576-`), so stage1's "a 206 after the seek" and
  fidelity's "a range other than `bytes=0-`" were satisfiable by those. The old 4 s target was also
  inside every read-ahead window.
- **Owner**: `e2e/` + `src/main/main.ts` (test hook).
- **Fix**: seek targets past the gate's lookahead and Chromium's read-ahead (stage1 50 s: beyond the
  30 s prefetch window + the paced allowance, L6-C deviation 1; fidelity 60 s). Both suites require
  a NEW 206 whose Range STARTS at ≥ (target − 4 s) × bytes/s (the fixture is CBR). Main records the
  start offsets of 206 Ranges behind `--e2e-hooks` (`mediaRangeStarts()`, numbers only).
- **Test**: `main-wiring.test.ts` (the hook counts statuses and 206 Range starts; absent without
  `--e2e-hooks`); both suites.

### 7. The `_blank` test could pass vacuously (found here)

- **Root cause**: `if ((await link.count()) > 0) click` — a missing link skipped the click.
- **Owner**: `e2e/stage1.e2e.ts`.
- **Fix**: exactly one `a[href^="https://example.com"][target="_blank"]` must be rendered; after the
  click there is no `window` event, one window, and the same URL.
- **Test**: stage1 test 5.

### 8. No app logs during triage

- **Root cause**: playwright pipes Electron's stdio.
- **Owner**: `e2e/support.ts`.
- **Fix**: `NUTFLIX_E2E_LOG=<file>` appends the app's stdout/stderr (main, host and worker lines,
  already redacted by their loggers). Off by default.

The steps that had never run — the seek's 206, the WalletChip rate, Watch → Home keeping the one
session in the mini-player, Watch → Watch leaving exactly one media link — all passed on their
first run once 1–5 were fixed: no further product bug surfaced. No security or money assertion was
changed except to make it stricter (6, 7, and the sandbox precondition in 1).

## Security-relevant behaviour

- **D4 is enforced by the harness, not just by main**: the suites cannot hand a test an app whose
  renderer lacks the seccomp-bpf filter or its PID namespace, or whose command line carries any of
  six sandbox-bypass switches. No switch was added anywhere; `chromiumSandbox: true` only stops
  playwright from adding one.
- **The main → host argv is pinned from both ends** (round trip through the host's real parser);
  the host stays strict (an unknown argument still exits 2).
- **The fixture wait is dev-only and bounded**: `FixtureCatalog` exists only under `--dev-fixtures`
  (itself refused without `--dev-mocks`, argv and `createHost`); the wait is ≤ 15 s once per host
  start, never per read, and ends when the worker is gone; production (`NostrCatalog`) is untouched.
- **The new e2e hook exposes numbers only** (206 Range start offsets, ≤ 4096), main-process only,
  only with `--e2e-hooks`; never a token, URL or path.
- Display discovery passes mutter's auth file PATH; the cookie is never read or printed.

## Deviations

1. **Seek targets and fixture shape differ from design §5(b)** (4 s seek, 6 s clip): both were too
   small to exercise a second Range, a rate, or the later steps (failures 4 and 6).
2. **Display order differs from design §5(b)** ("try headless, then Wayland, else xvfb"): X11 first
   and only, by measurement (failure 5).
3. **`e2e` hook added in `main.ts`** (`mediaRangeStarts`) — test plumbing behind `--e2e-hooks`, like
   L6-A's existing counters.

## Tests

`@sovit/app-desktop`: **52 files, 1055 tests** (was 51 / 1040): +1 file (`fixture-catalog.test.ts`,
6), `host-link.test.ts` +6, `adapter-studio.test.ts` +2, `main-wiring.test.ts` +1. All
deterministic (manual clock; the rig tests wait on events with bounded `eventually`).

`npm run ci` after the last code commit (`5caf90b`), after the three green runs of each suite:
**exit 0** — lint + prettier, build, **124 test files, 2085 passed / 27 skipped** repo-wide,
check:locked OK, check:native OK (42), lint:electron OK (159 files, 2 window constructors, 0
violations).

## Open questions / for the orchestrator

1. **`test:e2e` script** (`packages/app-desktop/package.json`): `node --test` runs files in
   parallel by default, which starts two Electrons at once (risk 9). Proposed:
   `"test:e2e": "NUTFLIX_E2E=1 node --test --test-concurrency=1 e2e/fidelity.e2e.ts e2e/stage1.e2e.ts"`
   (verified: 13/13, 14.6 s; the caller still sets `NUTFLIX_E2E_APPARMOR_PROFILE=1` on this box).
2. The e2e suites are not in CI (they need D4 and a display). Run them before merging anything under
   `packages/app-desktop/src/{main,host,worker,preload,renderer}`.
