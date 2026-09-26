# Pre-push review — packaging lows from the cross-lane review (2026-09-25)

Diff: `e55adf0` (lane I1's head: the packaged DLEQ thread fix, on the Stage 3 integration head
with packaging #6 merged) → `stage-3/int-packaging-lows` (lane I3-pack-lows). The lane takes the
four packaging findings of the cross-lane review, round 4: two Lows and two Infos. Method: the
`differential-review` and `sharp-edges` skills, run inline on the whole diff. Nothing under
`packages/core/src/contracts/`, the locked audit paths, `docs/status.md` or
`docs/security-review.md` changed, and there is no contract request.

## What changed

- **`packaging/stage.ts`.**
  - `assertCurrentBuild` refuses to stage a build older than its sources. It runs before `out`
    is touched, so a refused stage leaves the previous stage in place. There are three rules:
    1. `tsc -b --dry`, run through TypeScript's API over every workspace package the app is
       built from (`builtFromWorkspaces`: core, gateway and seeder are shipped, `@sovit/ui` is
       bundled), would rebuild none of them. Each shipped package also has every file its
       `package.json` points at;
    2. a workspace's `dist/*.css` (`@sovit/ui`'s build:css) is at least as new as the package's
       newest `src/` stylesheet;
    3. each bundle output the stage copies is at least as new as the newest file under
       `BUNDLE_SOURCES` (`src/renderer`, `src/preload`, `src/ipc`, `static`) and `@sovit/ui`'s
       `src/`, not counting tests and stories.
  - core's test doubles are no longer in the packaged host bundle. `stubTestDoubles`, an esbuild
    plugin used for the host build only, bundles core's `dist/mocks/index.js` and
    `dist/nostr/fake-relay.js` (`HOST_TEST_DOUBLES`) as stubs. A stub has the same export names,
    and each export throws when touched. The stub's module name is relative, so no build-machine
    path lands in the bundle. A new guard fails the stage if any other module of core's
    `mocks/` reaches the host bundle.
  - The closure is computed earlier, before the freshness check; it is used as before.
- **`src/main/security.ts`, `main.ts`, `log.ts`.** `SANDBOX_BYPASS_SWITCHES` grows from 3 to 13.
  These are refused in every build (D4). The new `PACKAGED_REFUSED_SWITCHES` (8 switches) is
  refused in packaged builds only, checked last, after the remote-debugging switches. That check
  logs the new fixed event `app.process-switch-refused` and exits with 78.
- **`packaging/cli.ts`.** The header comment only.
- **ADR 0017.**
  - §1 and §2: the freshness check and the host-bundle stubs.
  - §4: the switch lists and the order of the refusals.
  - Open question 8 gains the reviewer's fuse read-back.
  - New open question 11: `--enable-features` / `--disable-features`.

## Sharp edges checked

- **The dry run writes nothing.** I built a scratch composite project, then ran
  `createSolutionBuilder(…, { dry: true }).build()` over it. The `.tsbuildinfo` mtime did not
  change, so "never writes outside `out`" still holds.
- **Touched is not stale.** When sources are only touched, TypeScript 6.0.3 updates only the
  root `.tsbuildinfo`, not `dist/`. On the real repo, `touch` on `wallet/transport.ts`
  followed by `tsc -b` changed 0 files in `dist/`. So a rule comparing `src/` with `dist/`
  mtimes would refuse forever after a `git checkout` round trip, and `npm run build` would not
  clear it.
  - The TypeScript check therefore uses the dry run's own verdict: diagnostic 6357 ("would
    build") means stale; 6374 ("would update timestamps") means current.
  - Mutation M1b (6374 counted as stale) fails the new touch test and blocks the real repo's
    own staging.
- **Deleted outputs.** TypeScript's dry run reports "up to date" (6361) when `dist/` or one of
  its files has been deleted by hand. I checked this in the scratch project, and a plain
  `tsc -b` would not rebuild either. So each shipped package's `main` and `exports` targets must
  exist; the remedy given is `npx tsc -b --force`.
  - A deleted file deeper in `dist/` is still not detected (residual R-2).
- **mtime rules (2) and (3).** Each run of `scripts/bundle.ts` rewrites all nine outputs.
  I measured this by bundling twice into a temp directory: every mtime advanced, including
  copies whose content did not change. `build-css.ts` rewrites with `writeFileSync`. So a
  refusal always clears after `npm run build`.
  - The inputs are over-inclusive rather than precise. A touched renderer file also refuses,
    until the next `npm run build`.
  - A source restored with an OLDER mtime than the last build (`tar -x`, `cp -p`,
    `rsync -a`) is not detected (residual R-1). This affects TypeScript's own check as well.
  - `newestInput` does not follow symlinks. Our source trees have none.
- **What the bundles read.** The esbuild metafile inputs of the four bundle entry points (listed
  once by hand) are `src/{ipc,preload,renderer}`, `@sovit/ui`'s `dist/` and npm packages (react,
  react-dom, scheduler, uqr); `static/` is copied. A test pins `BUNDLE_SOURCES` against
  `scripts/bundle.ts`'s entry points and copies. npm packages are not inputs to the check:
  their change is a lockfile change plus `npm ci` (residual R-3).
- **The stubs.**
  - The Proxy traps `get`, `set`, `has`, `deleteProperty`, `ownKeys`, `defineProperty`,
    `getOwnPropertyDescriptor`, `apply` and `construct`, so `new X()`, `X()`, `x.a`,
    `instanceof X`, `'a' in x`, `Object.keys(x)` and string conversion all throw. `typeof`
    does not trap (it gives `'function'`).
  - esbuild's `__export` getters return the binding without touching it. A test loads the
    staged host bundle in plain Node (`exports: runHost`), which proves no stub is touched at
    load.
  - Every reference in the host is behind `--dev-mocks` / `--dev-fixtures` (`host.ts:290, 295,
    358`, `wallet.ts:196`). The host's flags come only from the argv main builds, and a
    packaged main refuses those flags with exit 78.
  - core has no production importer of `mocks/` or `fake-relay`, and the host bundle inlines
    only core (64 modules), not seeder or gateway.
  - Export names are checked to be identifiers (not `default`, not the helper's name). A clash
    fails the stage loudly.
  - The tree stays deterministic: `stage.test.ts`'s byte-identity test passes, and the stub
    comment is `// nutflix-packaged-test-double:mocks/index.js`.
- **The switches.**
  - `hasSwitch` is Chromium's own parse, so `-x`, `--x` and `--x=v` are all caught, and on
    Windows the names are lower-cased. Every listed name is a string in Electron 44.2.0's Linux
    binary (`strings`).
  - Chromium's zygote and GPU process may already exist when main runs. So a
    `--zygote-cmd-prefix` or `--gpu-launcher` program has run once before the refusal; the
    refusal means the app never goes on. The same was already true of the existing refusals.
  - The new log line is a fixed event name with no switch name or value in it (the logger
    admits literals only).
- **Supply chain.** `typescript` 6.0.3 is imported by build-time packaging code only; it is
  already the root's pinned devDependency. Nothing new ships.

## Cross-lane review (round 4)

### [low] stage/package/make shipped the workspace `dist/` folders without checking they are current → **fixed**

Verified first. On this branch's base, I changed `meltTimeoutMs ?? 300_000` to `123_456` in
`packages/core/src/wallet/transport.ts` and ran the base's `packaging/stage.ts` (from
`git show e55adf0:…`) without rebuilding. It exited 0, and the staged
`node_modules/@sovit/core/dist/wallet/transport.js` still held `3e5` and no `123_456`.

Orchestrator's choice: refuse or rebuild, whichever is safer and simpler. I chose **refuse**,
inside `stageApp`, so every caller is covered: `cli.ts` stage/package/make,
`node packaging/stage.ts`, the tests, and the packaged-worker integration test that spawns
it. Rebuilding inside the stage was rejected for three reasons:

- the packaged-worker integration test spawns `packaging/stage.ts` during the suite, so a build
  there would rewrite `dist/` under the other test files running in parallel;
- `npm run build` cannot be spawned the same way on Windows runners (`npm.cmd` needs a shell);
- the stage would stop being a function of its inputs that writes only `out`.

With the same mutation, the fixed stage exits 1 with `a workspace build is older than its
sources (A non-dry build would build project '…/packages/core/tsconfig.json'): run \`npm run
build\` (tsc, ui css, bundle) first`, and the previous stage directory is untouched. After
`git checkout` of the file (content restored, mtime new), it stages again: timestamps only.

Consequence: `stage.test.ts` and `packaged-worker.integration.test.ts` now need a CURRENT build.
After a merge or edit that touches core, gateway, seeder, ui, or the app's renderer, preload,
ipc or static sources, run `npm run build` before `npx vitest run`, or those two files fail with
the StageError naming what is stale. This is by design: they were already running against
whatever `dist/` held.

### [low] a packaged build let other sandbox-weakening and process-wrapper switches through → **fixed**

Verified against the code: before this change `SANDBOX_BYPASS_SWITCHES` held only `no-sandbox`,
`disable-gpu-sandbox` and `no-zygote`, and main refused nothing else but the two
remote-debugging switches. Not verified at runtime: this box cannot start Chromium's sandbox
(`chrome-sandbox` is not root-owned 4755, and `kernel.apparmor_restrict_unprivileged_userns=1`),
and `--no-sandbox` is never an option.

- **Every build**, in the sandbox step (D4): the reviewer's `disable-seccomp-filter-sandbox`,
  `disable-namespace-sandbox`, `disable-setuid-sandbox` and `no-zygote-sandbox`, plus
  `disable-landlock-sandbox`, `allow-sandbox-debugging`, `gpu-sandbox-allow-sysv-shm`,
  `disable-webnn-compiler-sandbox`, `single-process` and `in-process-gpu`. Each one turns a
  sandbox layer off, or runs sandboxed code inside the unsandboxed browser process, which is
  what D4 already forbids. The e2e harness passes none of them; it asserts six of them absent.
- **Packaged builds only**, after the remote-debugging step:
  - the process wrappers `renderer-cmd-prefix`, `utility-cmd-prefix` (the host is a utility
    process), `gpu-launcher`, `zygote-cmd-prefix` and `browser-subprocess-path`;
  - V8's `js-flags`;
  - `disable-site-isolation-trials` and `disable-web-security`.

  A dev build keeps these, for debugging with gdb or V8 flags.
- The order is unchanged: Squirrel, sandbox, dev flags, remote debugging, and the new step last.
  A test pins it.
- Not refused, with reasons:
  - the debug pauses (`*-startup-dialog`, `wait-for-debugger*`): they pause a process and
    widen nothing;
  - `--enable-features` / `--disable-features`: deferred as ADR 0017 open question 11, since
    refusing them breaks Wayland users and a feature denylist is version-specific.

### [info] the spending host bundle carried core's mocks → **fixed** (packaged host bundle only)

Verified: the base stage's `host/main.js` had path comments for `../core/dist/mocks/{index,
fixtures,mock-network-adapter,mock-payment-engine,mock-wallet,test-mint}.js` and
`../core/dist/nostr/fake-relay.js`. The orchestrator's condition was a small, safe change that
touches only the packaged host bundle.

- The stub plugin and the fail-closed guard are about 80 lines of `stage.ts`, comments
  included. The dev host, core and the worker's copy of core are unchanged.
- The packaged host bundle shrank from 1,081,093 to 1,008,655 bytes.
- A clean fix would be a `@sovit/core/mocks` subpath. That needs core's `package.json` and
  barrel and the host's imports, all outside this lane, so it is left as residual R-4.

### [info] `GrantFileProtocolExtraPrivileges` is still Enabled → **deferred** (Cameron's call)

Not flipped, per the orchestrator: Cameron has not answered the fuse question. It was already
ADR 0017 open question 8. That question now also records the reviewer's `@electron/fuses read`
result: the five chosen fuses as intended, `GrantFileProtocolExtraPrivileges` Enabled,
`EnableCookieEncryption` Disabled, and the `app:`-only serving that makes the first one
unnecessary. `fuses.ts` is unchanged.

### Mutation checks (each guard broken, at least one test failed, guard restored)

| # | Mutation | Caught by |
|---|---|---|
| M1a | `stageApp` does not call `assertCurrentBuild` | stage-guards round-4: 7 tests (shipped workspace, missing tsconfig, 4 × bundle sources, ui) |
| M1b | a touched-only project (6374) counts as stale | the touch case of the shipped-workspace test; the real `stage.test.ts` staging is refused too |
| M1c | `builtFromWorkspaces` returns no bundled workspace | `stage.test.ts` (core, gateway, seeder shipped; ui bundled) and the ui test |
| M1d | `isBuildInput` counts tests, snapshots and stories | 4 × "tests and stories are not inputs" |
| M1e | the entry-point existence check never fails | "a shipped workspace package whose entry point was deleted" |
| M1f | the reviewer's case on the real repo (`meltTimeoutMs ?? 123_456`, no rebuild): base `stage.ts` → exit 0 with the old value staged; this lane's → exit 1, previous stage untouched | manual, recorded above |
| M2a | `disable-seccomp-filter-sandbox` removed from the sandbox list | 4 tests (security it.each + count, main-wiring dev/packaged, order) |
| M2b | main's packaged process-switch check disabled | 9 tests (8 × packaged refusal, order) |
| M2c | the process-switch check moved before remote debugging | the order test |
| M3a | the stub plugin removed from the host build | the new guard fires on the real staging (`stage.test.ts` beforeAll) and the fixture test fails |
| M3b | the test-double guard never fails | "a test double reached past the barrel (a deep import) is refused" |
| M3c | the stub keeps the absolute path as its module name | both "no build-machine path" assertions (fixture and real) |

### Tests added

- `security.test.ts`:
  - 13 it.each cases, one per sandbox switch, plus a count;
  - 8 it.each cases, one per packaged-only switch, plus a count, disjointness and name-shape
    test.
- `main-wiring.test.ts`:
  - 10 new sandbox switches, each refused with exit 78 in both a dev and a packaged build, with
    nothing started;
  - 8 packaged-only switches, each refused with exit 78 when packaged, while the dev build
    starts;
  - one order test that checks all four steps and their log events.
- `stage-guards.test.ts`, with the fixture's bundle outputs now written after the sources, as
  `npm run build` leaves them:
  - freshness: the shipped workspace (stale → refused with the old stage intact → rebuilt →
    staged with the new value → touched → staged), a deleted entry point, a missing tsconfig,
    4 × bundle sources, and ui;
  - test doubles: stubs throw when touched and the worker copy is intact; a deep import is
    refused; the stub unit test.
- `stage.test.ts` (the real app):
  - `builtFromWorkspaces` on the real lockfile;
  - `BUNDLE_SOURCES` pinned against `scripts/bundle.ts`;
  - the real host bundle has no test doubles, only stubs, no repo path, and loads in plain Node.

No test was deleted or weakened. The only existing-test change is the stage-guards fixture's
write order: bundle outputs after sources, as a real build leaves them, commented in place.

### Gates

- `npx vitest run --maxWorkers=2`, whole suite, final code: 3169 passed, 21 skipped, 0 failed.
  An earlier whole run had 1 failure in `stage-guards.test.ts`, caused by editing that file
  during the run.
- `npx tsc -b --force`: clean.
- eslint and `prettier --check` on the changed files: clean.
- `npm run check:locked` and `npm run lint:electron`: OK.
- The Electron e2e was not run.

### Residuals

- **R-1** mtime rules (2) and (3), and TypeScript's own check, trust mtimes. A source restored
  with an older mtime than the last build is not seen as stale. git always writes current
  mtimes.
- **R-2** A file deleted by hand deep inside a shipped `dist/` is not detected. The entry points
  are checked, and TypeScript calls such a project up to date.
- **R-3** npm packages inlined into the renderer bundle (react, react-dom, uqr) are not
  freshness inputs.
- **R-4** The test doubles are stubbed by the bundler, so the packaged host's module graph
  differs from the dev host's in those two modules. The clean fix is a `@sovit/core/mocks`
  subpath (core and the host, outside this lane). The worker's copy of core still ships
  `mocks/` in `node_modules/` (unpacked, reachable only behind the refused dev flags).
- **R-5** The switch refusals were not exercised in a real Electron. The sandbox cannot start
  on this box without Cameron's grant.
- **R-6** `e2e/support.ts`'s comment "main refuses the first three" is now stale (main refuses
  all six in its list). That file is outside this lane's allowlist.
- **R-7** Open questions for Cameron: ADR 0017 8 (fuses) and 11 (feature switches).
