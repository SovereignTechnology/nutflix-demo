# Lane S3-pack — packaging (issue #6, security review F21)

Branch `stage-3/packaging`, off `c08c99f` (contracts v6). Date: 2026-09-25. Decision record:
ADR 0017 (`docs/decisions/0017-packaging.md`). Review: `docs/reviews/2026-09-25-pre-push-packaging.md`.
There is no contract request, and no file under `packages/core/src/contracts/`, the locked
paths, `docs/status.md` or `docs/security-review.md` changed.

## What changed and why

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

80 new tests in 10 files (per-file counts in the review record).

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

The integration test that crosses the process boundary is
`packaged-worker.integration.test.ts`. It stages the app, lays it out as `resources/app.asar` +
`app.asar.unpacked`, and runs `loadSidecar` → staged bare-sidecar → staged `bare` → `boot.mjs`
→ bundle under the host's real `WorkerSupervisor`. It then runs the dev fixtures (a local
hyperdht testnet and two seeders inside Bare) → `play.open` → HTTP → sha256 match.

## Mutation checks

Twenty guards were each broken, and at least one test failed every time (list in the review
record). One mutation, M16 (the symlink refusal), first survived because the generic
"unsupported entry" guard also threw. The test now asserts the specific refusal.

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

- Unpacked files, and all of Linux, are outside asar integrity.
- No platform code signing yet (accepted).
- Downgrade: authenticity is shown, not freshness.
- The AppImage needs an AppArmor profile on Ubuntu ≥ 24.
- The Forge alpha.
- `electron-installer-debian` has no provenance.
- Squirrel installs to a user-writable directory.
- The AppImage runtime pin should be confirmed against its `.sig`.

Details: the review record, R1–R7.

## Proposed `docs/status.md` row (Stage 3 table)

| Packaging (issue #6, F21, ADR 0017) | `stage-3/packaging` | **done (Linux built; Windows/macOS configured)** — Electron Forge 8.0.0-alpha.10 (7.x fails the advisory gate) drives a staged app: main + host bundled into `app.asar`, the Bare worker as an unbundled boot module (`bare-encoding/global` first) + bundle, unpacked with the lockfile runtime closure (target prebuilds only, no pear-runtime). Fuses set (RunAsNode, NODE_OPTIONS, --inspect off; asar integrity, only-from-asar on) and read back from every binary, plus a layout gate. Makers: Squirrel `.exe`, `.deb`, in-repo `.dmg` (hdiutil) and AppImage (pinned runtime; no `--no-sandbox`). The host never chmods bare-sidecar's runtime (fails closed on a read-only install). `scripts/release-manifest.mjs` writes SHA256SUMS + an UNSIGNED kind-30071 event for the SovTech npub (signed via Bunker46), `release-verify.mjs` checks it (SovTech key only). Built here: package + `.deb`; the packaged binary needs the D4 profile extended to start (ADR 0017 §7) |

## Proposed `docs/security-review.md` text

Row F21 (§0 table):

> | F21 | **Fixed** (`stage-3/f21-dev-flags`, `stage-3/packaging`) | A packaged build refuses `--dev-mocks`, `--dev-fixtures` and `--e2e-hooks` (exit 78, tested). Packaged builds (ADR 0017, Electron Forge) set the fuses `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` off and `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar` on; every packaged binary's fuses are read back and the build fails on a mismatch (verified on the Linux build with `@electron/fuses read`; `ELECTRON_RUN_AS_NODE` shown inert). Main, the host (with its npm code) and the renderer are inside `app.asar`. Residual: Electron checks asar integrity on macOS and Windows only, and the unpacked worker, `node_modules` and native addons are outside it on every platform (ADR 0017 open question 5); no platform code signing yet (accepted, Cameron 2026-09-24); releases are instead a SovTech-signed Nostr manifest of sha256 sums (`scripts/release-verify.mjs`). The packaged binary's exit-78 refusal was not exercised on the dev box (the D4 AppArmor profile does not cover its path; unit-tested) |

§6 roadmap row: change `[Low] F21: packaging …` to `[Done] F21: packaging (ADR 0017)`, with the
residuals above.

§7 "Not verified": add

> - Packaged builds: the dev-flag refusal on the packaged binary (sandbox profile), `NODE_OPTIONS`/`--inspect` behaviour beyond the fuse read, Windows/macOS builds, AppImage on Ubuntu ≥ 24, reproducibility of packaged outputs.

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
4. The questions for Cameron are in ADR 0017, "Open questions".
