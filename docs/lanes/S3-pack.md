# Lane S3-pack — packaging (issue #6, security review F21)

Branch `stage-3/packaging`, off `c08c99f` (contracts v6). Date: 2026-09-25. Decision record:
ADR 0017 (`docs/decisions/0017-packaging.md`). Review: `docs/reviews/2026-09-25-pre-push-packaging.md`.
There is no contract request, and no file under `packages/core/src/contracts/`, the locked
paths, `docs/status.md` or `docs/security-review.md` changed.

## Fix round 2 (verifier, 2026-09-25)

An independent verifier checked the fix pass and found one Low and one Info finding. Both
were reproduced by failing tests first, then fixed in commit `00221a0`. Details, mutations
R34–R40 and evidence: the review record, "Fix round 2".

- **Exact artifact names (Low).** `release-manifest.mjs` accepted the version followed by any
  `-`, `_` or `.`. A stale `Nutflix-0.1.0-rc.1-x64.AppImage` in `out/make` was signed into the
  0.1.0 manifest in positional mode (exit 0). A name must now be exactly one a maker writes for
  this version (`ARTIFACT_SHAPES`). The check is a string comparison with fixed tails per
  maker. A test pins the shapes to the Forge config, to `identity.ts` `BUILD_ARCHES` (now
  `cli.ts`'s arch list), to the AppImage runtime pins and to maker-deb's `debianArch`. Another
  compares them, as an exact set, with the real deb and AppImage makers' output. ADR 0017 §5
  and §8 now say "another version", and state the two limits: same-version builds (use
  `--made`), and a prerelease `.deb` (`~` in its Debian name, refused).
- **FIFO event file (Info).** `release-verify.mjs` opens the event file `O_NONBLOCK`, so
  `fstat` refuses a FIFO at once instead of blocking in `open`. The test runs the CLI under a
  bounded spawn (`runNode` `timeout`), so a regression fails instead of hanging.
- Files: `scripts/release-{manifest,verify}.mjs`, `scripts/__tests__/{release.test,helpers}.ts`,
  `packaging/{identity,cli}.ts`, a comment in `packaging/ci/release.gitlab-ci.yml`, ADR 0017,
  the review record and this file. No contract, locked path, `docs/status.md` or
  `docs/security-review.md` changed, and no dependency changed.
- Gates: `npx vitest run scripts/__tests__ packages/app-desktop` gave 1458 passing tests.
  `tsc -b --force`, eslint and prettier on the changed files, `check:locked` and
  `lint:electron` are all clean. The Electron e2e was not run.

## Independent review round (2026-09-25)

An independent reviewer returned "ship" with 7 low/info findings. The orchestrator raised two
to Medium and added eleven more from the same review. All 18 were checked against the code and
fixed, except the optional `pear build` job (deferred, Low). This round's own review found two
more (S1, S2), both fixed. Full table, mutations R1–R33 and evidence: the review record,
"Independent review".

- **Squirrel.Windows lifecycle** (Medium, `src/main/squirrel.ts`, `main.ts`). On packaged win32
  builds, main handles `--squirrel-install/updated/uninstall/obsolete` first: before the sandbox
  and dev-flag refusals, and before any window, host or worker. It runs Squirrel's
  `..\Update.exe --createShortcut|--removeShortcut=nutflix.exe` (execFileSync, fixed argv, no
  shell, 10 s), then exits. That happens only inside Squirrel's `app-<version>` layout (S1).
  `--squirrel-firstrun` starts normally.
- **AppImage and AppArmor** (Medium, docs). The `/tmp/.mount_*` userns profile is gone. ADR §7
  says why no profile may attach there, recommends the `.deb` on Ubuntu ≥ 24.04, and documents
  the only acceptable AppImage route: extracted into a root-owned `/opt/nutflix`, with a profile
  on that exact path (open question 4).
- **One release event per release.** Platform CI jobs only build. `cli.ts make` writes
  `out/make/<platform>-<arch>.artifacts.json`. A final `desktop-release-manifest` job runs
  `release-manifest.mjs --made …` once. `created_at` is the time the manifest is made (not the
  commit time), and the verifier prints "created".
- **Release manifest inputs.** `--made` lists hold only what the make produced; a list for
  another version is refused, and so are escaping paths. Every artifact name must carry the
  version, the Squirrel exe is now `Nutflix-<v>-Setup.exe`, and the dmg maker empties its output
  dir. `--out` defaults to `packages/app-desktop/out/release` (gitignored).
- **Verifier.** It checks the `size` tag against the total and a present `commit` tag (40 hex).
  The event file is read through one descriptor: a regular file of at most 256 KiB read. A
  symlinked download is refused. New tests cover the `files` tag, a symlink, an oversized
  event and `/dev/zero`.
- **The app's own archive** (`src/ipc/asar-path.ts`). The mapping is keyed on
  `appArchive(process.resourcesPath, realpathSync)`, not the first `*.asar` segment. It is
  resolved through symlinks (S2, found by the smoke run: a symlinked install or macOS
  translocation would otherwise never match `import.meta.url`).
- **Packaged builds refuse `--remote-debugging-port/-pipe`** (exit 78). The fuses do not cover
  Chromium's DevTools protocol.
- **Smaller fixes.**
  - The supervisor logs a `WorkerRuntimeError`'s reason, and only that error's text.
  - `runtimeClosure` refuses a copy nested under the app workspace.
  - The layout gate's `PACKED` list is derived from the staging lists (prompt window, both
    preloads, `renderer/index.html`).
  - The `maker-deb` sandbox comment and test are corrected (SUID `chrome-sandbox` by file mode;
    open question 10).
  - New open question 9: in-repo makers instead of Pear makers.
  - New `stage-guards.test.ts` covers the staging checks: the main/worker allow-lists, host
    inputs, a missing package, an unshipped import and bare-sidecar.

Files this round:

- New: `src/main/squirrel.ts`, `src/main/__tests__/squirrel.test.ts`,
  `packaging/__tests__/stage-guards.test.ts`.
- Changed:
  - app sources: `src/main/{main,args,security,log}.ts`, `src/ipc/asar-path.ts`,
    `src/host/worker/{sidecar,supervisor}.ts`;
  - packaging: `packaging/{cli,closure,forge-config,identity,layout,maker-dmg}.ts`,
    `packaging/ci/release.gitlab-ci.yml`;
  - scripts: `scripts/release-{manifest,verify}.mjs`;
  - tests: `closure`, `forge-config`, `makers`, `sidecar-loader`,
    `packaged-worker.integration`, `supervisor`, `asar-path`, `main-wiring`, `security`,
    `worker-entry`, `scripts/__tests__/release`;
  - docs: ADR 0017, the review record, this file.
- Unchanged: no contract, locked path, `docs/status.md` or `docs/security-review.md`; no
  dependency change.

## What changed and why (first round)

- **Electron Forge build** (`packages/app-desktop/packaging/`; `npm run -w packages/app-desktop
  stage|package|make`).
  - `stage.ts` writes a standalone app from the lockfile runtime closure (`closure.ts`):
    - main and the host are bundled into `app.asar`. The host is bundled with its npm code, so
      the wallet and signer code are covered by the integrity fuse on macOS and Windows.
    - The renderer bundles are copied in.
    - The worker ships as an **unbundled boot module** (`worker/boot.mjs`: `bare-encoding/global`
      first, D6) plus the bundle of our sources. It is unpacked with `node_modules`, because Bare
      cannot read an archive.
    - Target-platform prebuilds only; `pear-runtime` is not shipped.
    - Symlinks are refused, modes normalised, and the output is deterministic. `out` is deleted
      only if it is empty or a previous stage.
  - `cli.ts` registers the Forge config for the staged directory and runs Forge 8.0.0-alpha.10.
    Forge 7.11.2's tree fails the CI advisory gate: critical `tar`, and `extract-zip`, which has
    no fixed version.
- **Makers.**
  - Official: Squirrel `.exe`, `.deb`.
  - In-repo `.dmg` (`ditto` + `hdiutil`).
  - In-repo AppImage: pinned type2-runtime `20251108` digest, and `AppRun` is the Electron binary
    itself. Holepunch's maker was rejected because its `AppRun` adds `--no-sandbox` on Ubuntu
    ≥ 24, and `@reforged`'s because it downloads a moving runtime tag unverified.
  - `pear://`: the Pear CLI stages the same artifacts. Distribution only, no OTA (ADR 0017 §6).
- **Fuses** (`fuses.ts`, `@electron/fuses` 2.1.3): exactly the five Cameron chose. They are
  flipped in `packageAfterCopy` and **read back from every packaged binary** in `postPackage`,
  together with a layout gate (`layout.ts`: code packed; worker and runtime unpacked; runtime
  executable; no other platform's runtime; no `resources/app/`). A mismatch fails the build.
- **Read-only installs** (`src/host/worker/sidecar.ts`). In a packaged build the host loads
  bare-sidecar from `app.asar.unpacked` (so its `bare` is spawnable). It refuses a runtime that
  is not already executable, before bare-sidecar's require-time `chmod` can run.
  - `src/main/args.ts` `workerEntryFor` hands the host `app.asar.unpacked/worker/boot.mjs`;
    `src/ipc/asar-path.ts` holds the shared mapping.
- **Release manifest** (`scripts/release-manifest.mjs`): `SHA256SUMS`, `release-manifest.json`
  and an **unsigned** kind-30071 event for the SovTech npub, to be signed later through Bunker46.
  Nothing signs, no key, no relay, no bunker.
  - `scripts/release-verify.mjs`: nostr-tools `verifyEvent` on plain JSON, SovTech key only (the
    default; no CLI override), kind, `d`, tag and content consistency, and every file's size and
    sha256. It prints the release version and date (downgrade visibility).
- **CI definitions:** `packages/app-desktop/packaging/ci/release.gitlab-ci.yml` (manual jobs on
  `desktop-v*` tags for linux, macos and windows). Inactive: `ci/` is outside this lane's
  allowlist, so the include line is proposed below.

## Files

- New:
  - `packages/app-desktop/packaging/{cli,closure,fuses,forge-config,identity,layout,maker-appimage,maker-dmg,stage}.ts`
    and `packaging/tsconfig.json` (composite, noEmit; in `tsc -b`);
  - `packaging/ci/release.gitlab-ci.yml`;
  - `packaging/__tests__/{closure,forge-config,fuses,makers,stage}.test.ts`;
  - `packages/app-desktop/src/ipc/asar-path.ts`;
  - `src/host/__tests__/{sidecar-loader,packaged-worker.integration}.test.ts`,
    `src/main/__tests__/worker-entry.test.ts`, `src/ipc/__tests__/asar-path.test.ts`;
  - `scripts/release-manifest.mjs`, `scripts/release-verify.mjs`,
    `scripts/__tests__/release.test.ts`;
  - `docs/decisions/0017-packaging.md`, `docs/reviews/2026-09-25-pre-push-packaging.md`, this
    file.
- Changed:
  - `packages/app-desktop/src/host/worker/sidecar.ts`, `src/main/args.ts`, `src/main/main.ts`
    (one line);
  - `src/ipc/__tests__/boundaries.test.ts` (module-list pin plus `asar-path.ts`, with a comment
    citing issue #6);
  - `packages/app-desktop/{package.json,tsconfig.json,vitest.config.ts}`, root `package.json`
    (`nostr-tools` devDependency, the same version core already uses), `package-lock.json`;
  - `.gitignore` (`packages/app-desktop/out/`);
  - `docs/native-modules.txt` (one line, reviewed below).

## Native-module review (`docs/native-modules.txt`, one added line)

`electron-installer-debian@3.2.0`, marked `platform-pkg` because its package.json has
`"os": ["darwin","linux"]`. It is pure JS: no `.node`, no `binding.gyp`, no prebuilds, and no
lifecycle scripts. Dev-only, via `@electron-forge/maker-deb`. Accepted.

Not a native-module line, but reviewed: `electron-winstaller` has an `install` script (skipped
under `ignore-scripts`) that copies `vendor/7z-<arch>.exe/.dll` to `vendor/7z.exe/.dll`. The
Windows CI job runs it explicitly. Its `vendor/` holds prebuilt Windows tools (Squirrel,
nuget, signtool, rcedit, 7-Zip) that only a Windows build host runs.

## Tests

First round: 80 new tests in 10 files (per-file counts in the review record). Independent-review
round: +50 (two new files, `squirrel.test.ts` 10 and `stage-guards.test.ts` 8, and additions in
nine others). The 16 lane-touched test files now hold 212 tests.

| Command | Result |
|---|---|
| `npx vitest run packages/app-desktop scripts/__tests__` (before the review fixes) | 81 files, 1,400 tests: 1,399 passed, 1 failed (the native inventory before `--accept`; passes after) |
| `npx vitest run <the 12 new or touched test files>` (final) | 106/106 passed |
| `npx vitest run --maxWorkers=2` (whole suite, on `67b9f6d`) | 180 files passed, 2 skipped; 2,789 tests passed, 10 skipped, 0 failed (212 s) |
| `npx vitest run --maxWorkers=2` (whole suite, final `254972a` + docs) | 180 files passed, 2 skipped; 2,791 tests passed, 10 skipped, 0 failed (180 s) |
| `npx tsc -b --force` | exit 0 |
| `npx eslint <changed files>`, `npx prettier --check <changed files>` | clean |
| `npm run check:locked`, `npm run lint:electron` (204 files, 0 violations), `npm run check:native` (43 match) | OK |
| `npm audit`, `npm audit signatures` | 0 vulnerabilities; 646 packages with verified registry signatures, 235 with verified attestations |
| Independent-review round: `npx vitest run --maxWorkers=2 <the 16 lane files>` | 212/212 passed |
| Independent-review round: `npx vitest run --maxWorkers=2` (whole suite) | 182 files passed, 2 skipped; 2,841 tests passed, 10 skipped, 0 failed (227 s) |
| Independent-review round: `npx tsc -b --force`, eslint and prettier on changed files, `npm run check:locked`, `npm run lint:electron` | tsc exit 0; eslint and prettier clean; check:locked OK; lint:electron 207 files, 0 violations; check:native OK, 43 native packages match (no dependency change) |

The integration test that crosses the process boundary is
`packaged-worker.integration.test.ts`. It stages the app, lays it out as `resources/app.asar` +
`app.asar.unpacked`, and runs `loadSidecar` → staged bare-sidecar → staged `bare` → `boot.mjs`
→ bundle under the host's real `WorkerSupervisor`. It then runs the dev fixtures (a local
hyperdht testnet and two seeders inside Bare) → `play.open` → HTTP → sha256 match.

## Mutation checks

First round: twenty guards were each broken, and at least one test failed every time (list in
the review record). One mutation, M16 (the symlink refusal), first survived because the generic
"unsupported entry" guard also threw. The test now asserts the specific refusal.

Independent-review round: R1–R33, each caught by at least one failing test (list in the review
record). One first draft survived: resolving the resources directory before the archive was
redundant, and it was removed.

## Built on this box (Linux x64)

- **Package:** `out/Nutflix-linux-x64/`. `npx @electron/fuses read` shows the five fuses as set,
  and `ELECTRON_RUN_AS_NODE=1 …/nutflix -e …` does not run as Node (RunAsNode off). The asar
  holds 16 packed and 2,436 unpacked entries.
- **`.deb`:** `out/make/deb/x64/nutflix_0.0.0_amd64.deb` (121 MB; setuid `chrome-sandbox`; all
  other modes 0644/0755). The release manifest was generated for it, and the verifier refuses
  the unsigned event.
- **The packaged `app.asar` runs:** under the dev Electron, the bundled host and the unpacked
  worker reach `ready`, and the dev fixtures go live.
- **The packaged binary itself aborts at Chromium's sandbox check** before JavaScript runs. The
  D4 AppArmor profile does not cover its path, and its `chrome-sandbox` is not root-owned. So
  exit 78 could not be shown on it. The exact profile line is in ADR 0017 §7. Nothing was
  weakened.
- **AppImage not built:** the pinned runtime is a non-npm download. The maker refuses with
  instructions; its pipeline passes in tests with a fixture runtime.
- **Windows and macOS: configured only.**

## Residuals

- The AppImage cannot start on Ubuntu ≥ 24.04 without a userns grant. The only acceptable
  grant is a profile on a root-owned extracted copy; the `.deb` is recommended there.
- The Squirrel lifecycle has run only in unit tests (no Windows build).
- Pear makers were replaced by in-repo makers, and `pear://` has no job yet (open questions 3
  and 9).
- `release-manifest.mjs` still accepts positional directories. The name rule is exact, so it
  refuses artifacts of every other version, but it cannot tell two builds of the same version
  apart. `--made` is the safe path, and the only one CI uses.
- A prerelease cannot release its `.deb`: electron-installer-debian's `~rc` name is refused
  (fails closed; ADR 0017 §8).
- Unpacked files, and all of Linux, are outside asar integrity.
- No platform code signing yet (accepted).
- Downgrade: authenticity is shown, not freshness.
- The Forge alpha.
- `electron-installer-debian` has no provenance.
- Squirrel installs to a user-writable directory.
- The AppImage runtime pin should be confirmed against its `.sig`.

Details: the review record, R1–R11.

## Proposed `docs/status.md` row (Stage 3 table)

| Packaging (issue #6, F21, ADR 0017) | `stage-3/packaging` | **done (Linux built; Windows/macOS configured; independent review addressed)** — Electron Forge 8.0.0-alpha.10 (7.x fails the advisory gate) drives a staged app: main + host bundled into `app.asar`, the Bare worker as an unbundled boot module (`bare-encoding/global` first) + bundle, unpacked with the lockfile runtime closure (target prebuilds only, no pear-runtime), located through the app's own archive (`realpath(resourcesPath)/app.asar`). Fuses set (RunAsNode, NODE_OPTIONS, --inspect off; asar integrity, only-from-asar on) and read back from every binary, plus a layout gate covering every packed file; packaged builds also refuse Chromium's remote-debugging switches. Makers: Squirrel `.exe` (main handles the Squirrel lifecycle first, packaged win32 only), `.deb`, in-repo `.dmg` (hdiutil) and AppImage (pinned runtime; no `--no-sandbox`); in-repo makers instead of Pear makers await Cameron (ADR Q9). The host never chmods bare-sidecar's runtime (fails closed on a read-only install). `scripts/release-manifest.mjs` makes ONE UNSIGNED kind-30071 event per release for the SovTech npub (signed via Bunker46) from each make's own artifact list (exact maker names for the version only, created_at = now), `release-verify.mjs` checks it (SovTech key only; files/size/commit tags; a FIFO or device event file refused). Built here: package + `.deb`; the packaged binary needs the D4 profile extended to start (ADR 0017 §7); AppImage on Ubuntu ≥ 24.04: use the `.deb` |

## Proposed `docs/security-review.md` text

Row F21 (§0 table):

> | F21 | **Fixed** (`stage-3/f21-dev-flags`, `stage-3/packaging`) | A packaged build refuses `--dev-mocks`, `--dev-fixtures` and `--e2e-hooks` (exit 78, tested), and Chromium's `--remote-debugging-port`/`--remote-debugging-pipe` (exit 78, tested; independent review). Packaged builds (ADR 0017, Electron Forge) set the fuses `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` off and `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar` on; every packaged binary's fuses are read back and the build fails on a mismatch (verified on the Linux build with `@electron/fuses read`; `ELECTRON_RUN_AS_NODE` shown inert). Main, the host (with its npm code) and the renderer are inside `app.asar`. Residual: Electron checks asar integrity on macOS and Windows only, and the unpacked worker, `node_modules` and native addons are outside it on every platform (ADR 0017 open question 5); no platform code signing yet (accepted, Cameron 2026-09-24); releases are instead a SovTech-signed Nostr manifest of sha256 sums (`scripts/release-verify.mjs`). The packaged binary's exit-78 refusal was not exercised on the dev box (the D4 AppArmor profile does not cover its path; unit-tested) |

§6 roadmap row: change `[Low] F21: packaging …` to `[Done] F21: packaging (ADR 0017)`, with the
residuals above.

§7 "Not verified": add

> - Packaged builds: the dev-flag and remote-debugging refusals on the packaged binary (sandbox profile), `NODE_OPTIONS`/`--inspect` behaviour beyond the fuse read, Windows/macOS builds (including the Squirrel lifecycle, unit-tested only), AppImage on Ubuntu ≥ 24.04 (use the `.deb`; never a userns profile on the `/tmp` mount point), reproducibility of packaged outputs.

## For the orchestrator

1. **Enable the CI jobs** once runners exist. Add to `ci/gitlab-ci.yml`:
   ```yaml
   include:
     - local: packages/app-desktop/packaging/ci/release.gitlab-ci.yml
   ```
   Also add `npm run -w packages/app-desktop stage` to the `build` job if packaging should be
   checked on every MR. It needs no network: about 2 s and 130 MB on disk.
2. `vitest.config.ts` in app-desktop now includes `packaging/__tests__/**`, and
   `packages/app-desktop/tsconfig.json` references `./packaging`.
3. The e2e suites still run the dev layout. The packaged layout is covered by the integration
   test and by the `app.asar` smoke run described above.
4. The questions for Cameron are in ADR 0017, "Open questions" (now ten; 9 and 10 are new:
   the maker substitution, and the setuid-root `chrome-sandbox`).
5. The CI file's last job, `desktop-release-manifest`, is the only place a release event is
   made. Enabling the include line enables all four jobs.
6. Two pre-existing timing-sensitive tests timed out during a targeted run while the box was at
   load average ~14: `src/ipc/__tests__/guards.test.ts` ("validateArgs[setProfilePicture]
   rejects the hand-picked invalid samples") and `codec.test.ts`. This lane does not touch
   them, and both passed in the whole-suite run above (load ~6). No timeout was changed for
   them.
