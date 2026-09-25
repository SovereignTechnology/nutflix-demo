# Pre-push review — packaging (2026-09-25)

Diff: `c08c99f` (contracts v6) → `stage-3/packaging`. Issue #6, security review F21, ADR 0017.
Method: the `differential-review` and `sharp-edges` skills, inline. Baseline commit and
risk-classed file list below.

## Scope

- **HIGH** (runs in the shipped app, or decides what ships):
  - `app-desktop/src/host/worker/sidecar.ts`: `loadSidecar`. The host resolves bare-sidecar and
    the `bare` binary from `app.asar.unpacked`, and refuses a non-executable runtime (no `chmod`).
  - `app-desktop/src/main/args.ts` (`workerEntryFor`, `PACKAGED_WORKER_ENTRY`), `main.ts` (one
    call site), and `src/ipc/asar-path.ts` (`asarUnpacked`).
  - `app-desktop/packaging/stage.ts` and `closure.ts`: what is inside `app.asar`, what is
    unpacked, and which npm packages ship.
  - `app-desktop/packaging/fuses.ts`, `layout.ts` and `forge-config.ts`: the fuses, their
    read-back, and the layout gate.
  - `scripts/release-verify.mjs`: the check a user runs on a download.
- **MEDIUM** (build-time, sits on the release trust path):
  - `packaging/maker-appimage.ts`: runtime pin, AppDir, `mksquashfs`;
  - `packaging/maker-dmg.ts`;
  - `packaging/cli.ts`;
  - `scripts/release-manifest.mjs`;
  - `package.json` / `package-lock.json` (147 dev packages, §Supply chain);
  - `packaging/ci/release.gitlab-ci.yml` (inactive).
- **LOW:** tests; `.gitignore` (`packages/app-desktop/out/`); `docs/native-modules.txt` (one
  accepted line); the `vitest.config.ts` and `tsconfig.json` wiring.

No code was removed from a security path. `git blame` on the replaced lines of `sidecar.ts`
(`ebab012`, lane L6-B) shows a plain `createRequire(import.meta.url)('bare-sidecar')`, whose
comment already flagged the chmod-at-require for packaging. Blast radius: `spawnBareSidecar`
has one production caller (`host/main.ts`), `workerEntryFor` one (`main.ts`), and
`asarUnpacked` two.

## Attacker models and questions

- **Someone serving a download: a mirror, a relay, a `pear://` peer, or a MITM on a
  non-TLS path.**
  - `release-verify.mjs` accepts nothing but a SovTech-signed kind-30071 event whose sums match
    each file byte for byte.
  - A forged pubkey field breaks the signature (tested).
  - An event signed by any other key is refused (tested through the CLI).
  - An artifact tag such as `../../etc/passwd` is refused by `SAFE_NAME` before any file is
    opened.
- **Downgrade.** A genuine OLD release still verifies: a signature cannot say "latest". The
  verifier now prints the version and signing date (finding P4). Residual R3.
- **Environment injection into a launched app** (`NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`,
  `--inspect`, for example from a hostile `.desktop` file or a wrapper script). The fuses close
  all three and are read back from every built binary.
  - Proven on this box: `ELECTRON_RUN_AS_NODE=1 out/Nutflix-linux-x64/nutflix -e …` does NOT
    run as Node. It goes into Chromium startup, while the dev binary runs the script.
  - `NODE_OPTIONS` and `--inspect` are proven by the fuse read only, because the packaged
    binary aborts at the sandbox before Node starts (§Not verified).
- **A tampered install directory.** On macOS and Windows, EnableEmbeddedAsarIntegrityValidation
  covers main, the host and the renderer (all packed; the layout gate checks it). Not covered:
  Linux (no Electron support) and anything unpacked on any platform. Residual R1.
- **A read-only install.** The host never `chmod`s. A non-executable runtime fails closed with
  "reinstall the app" (tested with the default `fs.accessSync(X_OK)` check). The supervisor's
  crash budget bounds the retries.
- **A malicious or compromised build dependency.** It runs code on the build host, not in the
  app: no Forge package is staged into the app, and the closure test pins that dev tooling
  stays out.
  - All 646 installed packages have verified registry signatures, and 235 carry attestations
    (`npm audit signatures`).
  - Every new direct dependency has SLSA provenance except `electron-installer-debian` 3.2.0
    (§Supply chain).
  - `npm audit` reports 0 vulnerabilities.
- **The AppImage runtime (a non-npm download).** The pinned sha256 is compared before use. A
  wrong, moving or tampered runtime is refused; nothing is fetched by the build.
- **The Chromium sandbox.** Never disabled.
  - The `.deb` installs `chrome-sandbox` setuid root: the electron-installer-common default and
    the Chromium-sanctioned helper.
  - The AppImage cannot use SUID (a `nosuid` FUSE mount), so on Ubuntu ≥ 24 it fails closed
    without an AppArmor profile (ADR 0017 §7).
  - We rejected Holepunch's AppImage maker because its `AppRun` adds `--no-sandbox` on Ubuntu
    ≥ 24.

## Findings (all fixed before push)

| # | Sev | Where | Scenario | Fix | Test |
|---|---|---|---|---|---|
| P1 | Medium | `scripts/release-verify.mjs:62` (`checkEvent`) | nostr-tools' `verifyEvent` returns a cached result stored under a symbol on the event object; `finalizeEvent` sets it, and `{ ...ev }` copies it. An in-process caller that verified an event, then edited `content` or `tags` in a spread copy, would get `true` without a re-check, so a tampered sums list would pass. (The CLI parses JSON, so it never carried the symbol; the library entry point could.) Found by the tampering test failing | The event is reduced to plain JSON (a JSON round trip) before `verifyEvent` | "Tampering after signing breaks the signature — even on an in-process copy…"; mutation M11 |
| P2 | Medium | `packaging/stage.ts:247` (`stageApp`) | `stageApp` deletes `out` before writing it. `node packaging/stage.ts --out ~/Projects` (a typo or a copy-paste) would have run `rm -rf ~/Projects` | `assertReplaceable`: `out` must be absent, empty, or a previous stage (its package.json names the app, and it has `worker/boot.mjs`) | "never deletes a directory it did not make"; mutation M7 |
| P3 | Low | `scripts/release-verify.mjs:119` (`verifyRelease`) | The trusted key was a required parameter. A caller writing `verifyRelease(ev, { expectedPubkey: ev.pubkey })` (self-referential trust) would accept any validly signed event from anyone | `trustedPubkey` now defaults to the SovTech key, the CLI passes none, a non-64-hex override is refused, and the doc says never derive it from the event | "defaults to the SovTech key and refuses a malformed trusted key"; source hygiene (the CLI never names a key); M18 |
| P4 | Low | `scripts/release-verify.mjs:106` | Downgrade: an older genuine release verifies, and the user could not see which one it was | Exactly one `version` tag is required; version and signing date are printed and returned | `verifyRelease` returns `{ version, createdAt }`; "exactly one version tag"; M20 |
| P5 | Low | `packaging/stage.ts:408` | npm extracts package files with the build user's umask (0664, 0775). The first `.deb` shipped group-writable files under `/usr/lib/nutflix` (root group) | `normalizeModes` (dirs 0755, files 0644 or 0755; symlinks refused) and `process.umask(0o022)` in the CLI. The rebuilt `.deb` holds only 0644/0755 plus the SUID helper | "modes are normalised"; M15 |
| P6 | Low | `packaging/closure.ts:170` | Following OPTIONAL peer dependencies shipped `typescript` (an optional peer of nostr-tools that is present only as dev tooling) inside the app | Optional peers are not followed; a required peer is | "follows required peers but not optional ones"; real-lockfile closure test |
| P7 | Low | `packaging/forge-config.ts:123` | The fuse flip took a hard-coded `signed=false`. When code signing is added, the ad-hoc signature would be reset before a real `osxSign`, and a future edit could get this wrong silently | Derived from `packagerConfig.osxSign`, as `@electron-forge/plugin-fuses` does | M19 (the flip itself); the forge-config hook test |
| P8 | Low | `src/host/worker/sidecar.ts:67` (`loadSidecar`) | The executable check was an injected function with no default, so a caller passing `() => {}` would silently disable it | The check defaults to `fs.accessSync(X_OK)`; production passes nothing | "packaged, default check (what the host uses)"; M1 |

## Sharp edges checked and left as is

- **`asarUnpacked` (`src/ipc/asar-path.ts:12`)** treats any path segment ending in `.asar` as an
  archive. Electron's own fs does the same. A dev checkout under such a directory would fail to
  start the worker (fail closed), never load the wrong code.
- **`MakerAppImage` `runtimes` override** exists for tests. `forge-config.ts` never passes it;
  an edited config could, which would be a deliberate act (Low).
- **`forgeConfig({ electronChecksums: {} })`.** `@electron/get` throws on an empty checksums
  object, and a zip missing from the list fails validation: fail closed.
- **The worker boot module** rethrows a failed `import()` as an unhandled rejection. Bare exits,
  and the host restarts it within its crash budget, then gives up.
- **All subprocesses** (`mksquashfs`, `ditto`, `hdiutil`) are `execFile` with argv. The only
  interpolated value in the AppImage desktop entry is checked for line breaks, and
  `SOURCE_DATE_EPOCH` must be all digits.

## Supply chain (new dependencies)

All pinned exactly, all resolved from registry.npmjs.org, lockfile-only install
(`ignore-scripts`).

| Package | Version | Publisher / provenance | Why |
|---|---|---|---|
| `@electron-forge/core` | 8.0.0-alpha.10 | electron/forge, GitHub Actions trusted publishing, SLSA v1 | Forge API (package/make). 7.11.2 fails the advisory gate (critical `tar`, unfixable `extract-zip`) |
| `@electron-forge/maker-base`, `@electron-forge/shared-types` | 8.0.0-alpha.10 | same | base class and types for the in-repo makers |
| `@electron-forge/maker-deb` | 8.0.0-alpha.10 | same | `.deb` (uses `electron-installer-debian`) |
| `@electron-forge/maker-squirrel` | 8.0.0-alpha.10 | same | Squirrel.Windows `.exe` (uses `electron-winstaller`) |
| `@electron/fuses` | 2.1.3 | electron-cfa, GitHub Actions, SLSA v1, zero dependencies | flip and read the fuses |
| `@electron/asar` | 4.3.0 | electron, GitHub Actions, SLSA v1 (already transitive) | the layout gate reads the archive header |
| `nostr-tools` (root devDependency) | 2.25.2 | already a dependency of `@sovit/core`; declared for `scripts/` | `verifyEvent`, `nip19` |

Transitive packages worth naming:

- `@electron/packager` 20.3.0 (SLSA).
- `@electron/rebuild` 4.2.0 (SLSA; `onlyModules: []` so it builds nothing).
- `electron-winstaller` 5.4.4 (SLSA). It ships prebuilt Windows binaries: `Squirrel.exe`,
  `Setup.exe`, `nuget.exe`, `signtool.exe`, `rcedit.exe`, 7-Zip. Its `install` script, skipped
  here, only copies `vendor/7z-<arch>.exe` to `vendor/7z.exe`; the Windows CI job runs it
  explicitly.
- `electron-installer-debian` 3.2.0 (electron-userland; published by a maintainer, **no
  provenance**; pure JS). Accepted into `docs/native-modules.txt` as `platform-pkg`, dev-only.
- `node-gyp` 12.4.0 and `postject` (via packager/rebuild; unused at runtime and never shipped).

Rejected: `pear-electron-forge-maker-appimage` 2.0.1 (`--no-sandbox` AppRun, app-builder-lib),
`@reforged/maker-appimage` 5.3.1 (moving runtime tag, Forge 7 maker-base),
`@electron-forge/maker-dmg` (appdmg → image-size advisory, native modules),
`@electron-forge/plugin-fuses` 7.11.2 (pins `@electron/fuses` ^1).

`npm audit`: 0 vulnerabilities. Lockfile: 147 packages added, 0 changed, 0 removed.

## Tests

80 new tests in 10 files, plus one updated pin:

- `packaging/__tests__/`:
  - `fuses.test.ts` (11): the five settings; flip and read-back on a synthetic binary carrying
    Electron's sentinel;
  - `closure.test.ts` (9);
  - `stage.test.ts` (14): determinism, layout, the D6 boot module, host/worker externals,
    pruning, modes, the delete guard;
  - `makers.test.ts` (9): the full AppImage pipeline with a fixture runtime and real
    `mksquashfs`, checked with `unsquashfs`;
  - `forge-config.test.ts` (12): hooks, layout gate, CLI parser, constants pinned to the app's.
- `src/host/__tests__/`:
  - `sidecar-loader.test.ts` (4);
  - `packaged-worker.integration.test.ts` (2): the staged tree run under real Bare through the
    host's `WorkerSupervisor`, testnet fixtures, and a sha256-checked HTTP read.
- `src/main/__tests__/worker-entry.test.ts` (3); `src/ipc/__tests__/asar-path.test.ts` (5).
- `scripts/__tests__/release.test.ts` (11). The throwaway key lives in memory only. The CLI
  refuses it and a forged-pubkey copy; the file checks run through the library.
- `src/ipc/__tests__/boundaries.test.ts`: the module list pin now includes `asar-path.ts`
  (issue #6), which is held to the same rules as the rest of `src/ipc`.

## Mutation checks (each guard broken, at least one test failed, guard restored)

M1 packaged non-executable runtime accepted (2 fail) · M2 `RunAsNode` left on (9) · M3 fuse
read-back never mismatches (1) · M4 layout accepts a non-executable runtime (1) · M5 dev-only
lockfile entry accepted (1) · M6 every platform's prebuilds kept (1) · M7 stage deletes `out`
unchecked (1) · M8 AppImage runtime sha256 not compared (1) · M9 desktop-entry line injection
allowed (1) · M10 any signing key accepted (2) · M11 cached verified flag trusted (1) · M12
path-like artifact names accepted by the verifier (1) · M13 unsafe names accepted by the
manifest (1) · M14 packaged worker entry left inside app.asar (1) · M15 modes not normalised (1)
· M16 symlinks in packages copied (1; the test was tightened first, because the generic
"unsupported entry" guard had masked it) · M17 sha256 mismatch accepted (1) · M18 malformed
trusted key accepted (1) · M19 fuses not flipped after copy (1) · M20 version tag unchecked (1).

## Built and proven on the dev laptop (Linux x64)

- `electron-forge package` → `out/Nutflix-linux-x64/`. `npx @electron/fuses read --app …/nutflix`
  reports `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and
  `EnableNodeCliInspectArguments` Disabled; `EnableEmbeddedAsarIntegrityValidation` and
  `OnlyLoadAppFromAsar` Enabled; the others at defaults.
- The asar holds 16 packed entries (main, host, renderer, prompt, preloads, package.json) and
  2,436 unpacked (`worker/`, `node_modules/`).
- `.deb`: `out/make/deb/x64/nutflix_0.0.0_amd64.deb`, 120,602,320 bytes. sha256
  `6d52f6d1468d0f423080a81364c5ce00757f932bc1815d0218d935dd87c1c032` (a local build, not a
  release). Modes are 0644/0755 plus the setuid `chrome-sandbox`. `release-manifest.mjs` wrote
  its sums and the unsigned event, and `release-verify.mjs` refuses that unsigned event.
- **Host and worker boot from the packaged archive.** The dev Electron (covered by the D4
  profile) was run on `out/Nutflix-linux-x64/resources/app.asar --dev-mocks --dev-fixtures`.
  Main started from the asar, the bundled host utilityProcess spawned, the worker came up from
  `app.asar.unpacked` through the unpacked bare-sidecar, `media worker state` reached `ready`,
  and the fixture manifests went live.
- **AppImage: not built.** The pinned runtime is a non-npm download, and this lane contacts
  nothing else. The maker refused with its instructions, as designed. Its whole pipeline passes
  in `makers.test.ts` with a fixture runtime.
- **Windows and macOS: configured, never built here.**

## Not verified

- **The dev-flag refusal (exit 78) on the packaged binary.** Chromium aborts at the sandbox
  check (`setuid_sandbox_host.cc:166`) before any JavaScript runs, because the D4 AppArmor
  profile names only `node_modules/electron/dist/electron`. `main-wiring.test.ts` covers the
  refusal. The profile line that would allow the packaged binary is in ADR 0017 §7.
- `NODE_OPTIONS` and `--inspect` behaviour on the packaged binary: shown by the fuse read only.
- Reproducibility of the packaged outputs (the staged tree is deterministic).

## Residuals

- **R1.** Unpacked files are not covered by asar integrity on any platform: the worker, its
  `node_modules`, bare-sidecar's JS, and the `sodium-native` `.node` the host loads. On Linux,
  asar integrity does not exist at all. A writer to the install directory can change code the
  host or worker runs. Mitigations: install location (root-owned `/usr/lib`, read-only
  squashfs), and the future macOS bundle signature. Proposal: a digest list inside the asar,
  checked by the host before loading or spawning (ADR 0017 open question 5).
- **R2.** No platform code signing: Gatekeeper and SmartScreen warn (accepted). Unsigned
  macOS/Windows builds let a local writer re-point the integrity hash too.
- **R3.** Downgrade: verification proves authenticity, not freshness. The version and date are
  shown; the relay's current kind-30071 notice is the freshness source.
- **R4.** The AppImage fails closed on Ubuntu ≥ 24 without an AppArmor profile (§7).
- **R5.** Forge is an alpha (8.0.0-alpha.10): bump to 8.0.0 when released.
  `electron-installer-debian` has no provenance.
- **R6.** Squirrel installs per user under `%LocalAppData%`, which the user can write to.
- **R7.** The pinned AppImage runtime digests were read from GitHub's release listing. Cameron
  should confirm them against the release's `.sig` files before the first AppImage release (a
  wrong pin fails closed).
