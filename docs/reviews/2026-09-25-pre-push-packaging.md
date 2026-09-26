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

## Independent review (2026-09-25)

An independent reviewer examined the lane (verdict: ship; every finding low or info) and the
orchestrator ruled on each finding, raising two to Medium. Each finding was first checked
against the code. All were real. Every fix has a test that fails without it (mutation checks
R1–R33 below). The same `differential-review` and `sharp-edges` pass then ran on the fix diff,
and two more defects were found (S1, S2). Fixes: commit `c9fa673`. Commands, counts and
evidence are at the end.

| # | Sev (ruling) | Finding | Outcome |
|---|---|---|---|
| IR1 | Low | `ci/release.gitlab-ci.yml`: the Linux, macOS and Windows jobs each made a kind-30071 event with `d` = `nutflix-desktop`. The event is addressable, so relays would keep one of the three, and a Linux user comparing a download with "the current notice" would get `… is not part of this release`. `created_at` defaulted to `SOURCE_DATE_EPOCH`, so a corrected manifest for the same commit could lose to the stale one, and the verifier printed that commit time as "signed" | **Fixed.** Platform jobs only build. `cli.ts make` writes `out/make/<platform>-<arch>.artifacts.json`, and one final `desktop-release-manifest` job (`needs` all three) runs `release-manifest.mjs` once with the four lists. `created_at` is now the time the manifest is made (`--created-at` overrides), and the verifier prints "created". Tests: "the CI makes ONE release event…", "created_at is NOW by default…". Mutations R14, R32 |
| IR2 | Medium | ADR §7 told Ubuntu ≥ 24 AppImage users to install a userns profile on `/tmp/.mount_Nutfli*/…`. `/tmp` is world-writable, so any local user could create that path and get unprivileged user namespaces. The pattern also misses a renamed download | **Fixed (docs).** §7 now says plainly that no profile may attach to the mount point, and why. It recommends the `.deb` on Ubuntu ≥ 24.04. If the AppImage route is kept, it goes through `--appimage-extract` into a root-owned `/opt/nutflix`, with a profile on that exact path. The bad profile line is gone from the ADR, and no copy-pasteable form remains. Open question 4 was rewritten. No code involved |
| IR3 | Medium | Squirrel `.exe` configured, but main ignored `--squirrel-*`: the installer would start the full app (host, worker, DHT) and make no shortcut, and uninstall would launch the app | **Fixed.** `src/main/squirrel.ts` is pure, with an injected runner. Main runs it first, before the sandbox and dev-flag refusals and before any window, host or worker, on packaged win32 only. install/updated run `..\Update.exe --createShortcut=nutflix.exe`, uninstall runs `--removeShortcut`, and obsolete just exits; each then exits 0. `--squirrel-firstrun` starts normally. Update.exe runs through `execFileSync` with a fixed argv, no shell, `windowsHide` and a 10 s bound. The electron security lint does not restrict `child_process`, so no exception was needed. Tests: `squirrel.test.ts` (10), `main-wiring.test.ts` (+6). Mutations R3, R4, R5, R29 |
| IR4 | Low | The ADR presented "Forge + Pear makers" as decided although no Pear maker is used, and never asked Cameron; `pear://` had no configuration at all | **Fixed (docs)** for the sign-off: a Status note, a "Deviation" paragraph in §5 (Holepunch's AppImage maker adds `--no-sandbox`; Pear wants msix, not the `.exe` Cameron asked for), and open question 9. §6 records why there is no job. **Deferred (Low):** the optional inactive `pear build` job. Its inputs depend on open questions 3 and 9, the Pear CLI would need an exact pin reviewed like any dependency, and a draft built on unverified flags would mislead. One was drafted and dropped for those reasons |
| IR5 | Info | `supervisor.ts`: the spawn `catch` had no binding, so `WorkerRuntimeError`'s "reinstall the app" never reached the log | **Fixed.** `WorkerRuntimeError` now lives in `supervisor.ts` (re-exported by `sidecar.ts`). The catch logs `error` and `reason` for that class only. Any other error's text, which could hold a path, is still dropped. Test: "a spawn refused as a WorkerRuntimeError logs its reason; any other error text is dropped". Mutation R7 |
| IR6 | Info | `release-verify.mjs`: the `files`-tag check and the regular-file refusal survived mutation. `MAX_EVENT_BYTES` had no test and used `lstat`, which measures a symlink, not its target | **Fixed.** Added tests for a wrong `files` tag, a symlinked download and an oversized event (directly and through a symlink), plus `/dev/zero`. The event file is now read through one descriptor: `fstat` must say regular file, and at most 256 KiB is read, counted in bytes actually read. Mutations R17, R20, R21, R22 |
| IR7 | Info | A packaged build did not refuse `--remote-debugging-port` / `--remote-debugging-pipe` (CDP on the renderer and the prompt window), which the fuses do not cover | **Fixed.** `REMOTE_DEBUGGING_SWITCHES` in `security.ts`. A packaged build refuses them (exit 78, `app.debug-switch-refused`) before Chromium starts its DevTools server. A dev build keeps them for the e2e harness. Tests in `security.test.ts` and `main-wiring.test.ts`. Mutation R6 |
| IR8 | Low | `runtimeClosure` mapped a copy nested under the app workspace itself (`packages/app-desktop/node_modules/x`) through the workspace link to `node_modules/@sovit/app-desktop/node_modules/x`, where nothing resolves it, so the hoisted version would load silently | **Fixed.** `ClosureError` (fail closed; "hoist it"). Today's lockfile has no such entry, and the real-lockfile test still passes. Mutation R8 |
| IR9 | Low | `release-manifest.mjs` took everything with a release extension under `out/make`, so a stale artifact from an older make could be signed. `Nutflix-Setup.exe` carried no version, and the dmg maker never cleared its output dir | **Fixed.** `--made` lists hold exactly Forge's own artifact list. A list made for another version, and any absolute, backslashed or `..` path in one, is refused. Every artifact name must carry the version as a whole field, in every mode. The setup exe is now `Nutflix-<v>-Setup.exe` (`ForgeConfigOptions.version`, validated). The dmg maker empties `out/make/dmg/<arch>` first (`ensureDirectory`, as Forge's own makers do). Mutations R10–R13, R15, R16 |
| IR10 | Low | Negative tests missing: the stage host-bundle input check, a missing closure package, the main and worker bundle allow-lists, bare-sidecar not shipped; also the verifier's files tag and oversized event | **Fixed.** New `packaging/__tests__/stage-guards.test.ts` (8) drives `stageApp` over a synthetic repo, breaking one rule per case. It covers: main importing renderer code; the worker importing host code; the host importing worker, main or renderer code; the host inlining a native package through a relative path; a lockfile package not installed; a bundle import the closure does not ship; no bare-sidecar. The verifier cases are under IR6. Mutations R23–R28 |
| IR11 | Low | The layout gate's `PACKED` list omitted the prompt window's files, `prompt-preload.cjs` and `renderer/index.html` | **Fixed.** `PACKED` is derived from `PRELOAD_FILES`, `RENDERER_FILES` and `PROMPT_FILES`, the lists the staging step copies. The real `make` passed the stricter gate. Mutation R9 |
| IR12 | Info | The `maker-deb` comment and test name said the sandbox setup was left to a decision. In fact the package ships `chrome-sandbox` setuid root through its file modes | **Fixed.** The comment is corrected, and the test is renamed; it now also pins that electron-installer-common sets 4755 on the staged helper. ADR §7 is corrected, and open question 10 asks Cameron to accept the SUID helper |
| IR13 | Info | Verifier: the `size` tag was not checked against the artifact total, and a present `commit` tag was not checked | **Fixed.** The `size` tag is required and equals the total. At most one `commit` tag, which must be 40 hex; it is returned and printed. Mutations R18, R19 |
| IR14 | Info | `--out` defaulted to the working directory | **Fixed.** The default is `packages/app-desktop/out/release` (under the existing gitignored `packages/app-desktop/out/`). The CI job uses that default, so no root `release/` entry was needed. Mutation R33 |
| IR15 | Info | `asarUnpacked` keyed on the first `*.asar` path segment, not the app's own archive | **Fixed.** `asarUnpacked(p, archive)` maps only the archive itself or paths inside it, case-insensitively for Windows paths. `appArchive(process.resourcesPath, realpathSync)` names the archive in main and in the host (a probe confirmed Electron 44.2.0 gives the utility process `resourcesPath`). Mutations R1, R2; see S2 |
| IR16 | Info | No ADR question put the in-repo-makers substitution to Cameron | **Fixed:** open question 9 (see IR4) |

Found by this round's own review:

| # | Sev | Finding | Outcome |
|---|---|---|---|
| S1 | Low | `squirrelStartup` would run `..\Update.exe` from whatever directory sits above the exe. A copied or unzipped build (in `Downloads\Nutflix\`) launched with `--squirrel-install` would run a `Downloads\Update.exe`. Anyone able to launch it with arguments could run that file directly, so this is no privilege gain; it was still a needless footgun | **Fixed.** Update.exe runs only when the exe's directory is Squirrel's `app-<version>`; otherwise main exits without running anything. Mutation R29 |
| S2 | Low | Keying on the raw `resourcesPath` breaks when the install path involves a symlink. The module loader resolves `import.meta.url` through symlinks, and `resourcesPath` need not be resolved. Found by the smoke run: with `app.asar` symlinked into the dev Electron's resources, the worker failed six times ("could not spawn"), then `failed`. Real cases include a symlinked install and macOS app translocation (`/var` → `/private/var`). Fail closed (no worker), but fatal | **Fixed.** `appArchive` resolves the archive path with the caller's `realpathSync`, falling back to the path as given when it does not resolve. The same smoke then reached `ready` with live fixtures. Mutations R30, R31 |

Sharp edges checked and left as is (this round):

- `loadSidecar`'s `appArchive` is a required key (it may be `undefined`), so a caller has to
  decide. A packaged host that passed `undefined` would take the dev path, and spawning a
  binary inside an archive fails: fail closed.
- `MakerDmg`'s `exec` option exists for tests, and `forge-config.ts` never sets it. This is the
  same shape as the AppImage maker's `runtimes` (Low).
- Positional directories are still accepted by `release-manifest.mjs` for ad-hoc use. A
  same-version artifact from another commit could slip in that way. `--made` is the documented
  path and the only one the CI uses (residual R8).
- `app.isPackaged` keys on the executable's name. A same-user copy renamed `electron` is a dev
  build, but that copy is user-writable anyway (ADR Consequences).

### Mutation checks (each guard broken, at least one test failed, guard restored)

R1 `asarUnpacked` ignores the archive prefix (3 fail) · R2 old first-`*.asar`-segment rule (3)
· R3 Squirrel handled in a dev build (1) · R4 a Squirrel launch continues into the app (4) · R5
exe-name check dropped (1) · R6 packaged build accepts remote debugging (2) · R7 supervisor
logs any spawn error's text (1) · R8 closure accepts a copy nested under the app (1) · R9
`PACKED` without the prompt window (2) · R10 Setup.exe without the version (1) · R11 made list
accepts a path outside `out/make` (1) · R12 dmg maker keeps old output (1) · R13 manifest
accepts a name without the version (1) · R14 `created_at` from `SOURCE_DATE_EPOCH` (1) · R15
made list for another version accepted (1) · R16 made-list path escape accepted (1) · R17
verifier `files` check off (1) · R18 `size` check off (1) · R19 `commit` check off (1) · R20
symlinked download followed (1) · R21 event size limit off (1) · R22 event regular-file check
off (1) · R23 stage main allow-list off (1) · R24 worker allow-list off (1) · R25 host input
check off (2) · R26 uninstalled closure package accepted (1) · R27 unshipped bundle import
accepted (1) · R28 bare-sidecar not required (1) · R29 Update.exe run outside `app-<version>`
(1) · R30 archive not resolved through symlinks (1) · R31 unresolvable archive dropped instead
of used as given (1) · R32 CI back to a manifest per platform job (1) · R33 `--out` defaults to
the working directory (1).

One first draft survived: resolving the resources *directory* before the archive. The archive's
own resolution already covered every case the test could build, so the directory step was
redundant and was removed (R30 then targets the remaining step).

### Tests and evidence

- New or changed in this round, +50 tests: `squirrel.test.ts` (10, new), `stage-guards.test.ts`
  (8, new), `release.test.ts` (11 → 21), `forge-config.test.ts` (12 → 17), `main-wiring.test.ts`
  (23 → 31), `asar-path.test.ts` (5 → 9), and one each in `closure`, `makers`, `supervisor`,
  `security` and `worker-entry`. The 16 lane-touched files hold 212 tests, all passing.
- Existing tests that changed meaning, each with a comment citing this review:
  - `asar-path.test.ts`: the "first segment" case now asserts the archive-keyed rule;
  - `worker-entry.test.ts` and `sidecar-loader.test.ts` pass the archive;
  - `release.test.ts`: the Setup.exe fixture is versioned, and the duplicate-name case passes
    `--version`;
  - `forge-config.test.ts`: `fakeOutput` writes every `PACKED` file, and the deb test is
    renamed.
- `stage-guards.test.ts` has a 30 s describe timeout. The cases run up to three esbuild builds;
  the first was measured at 6.8 s in a full parallel run (5 s default). `stage.test.ts` gives the
  real staging 120 s.
- **Rebuilt on the dev laptop:** `npm run build`, then `make --targets deb`. `postPackage`
  passed the stricter layout gate. `@electron/fuses read` showed the five settings unchanged.
  `out/make/linux-x64.artifacts.json` listed the `.deb` (`nutflix_0.0.0_amd64.deb`,
  120,621,266 bytes, sha256 `c0099eecc65792fefc5755558e9ae86f017f9cf7a6ff8fb36e7bc1b7f9f4d42a`,
  a local build, not a release; all entries root/root, 0644/0755 plus the one setuid
  `chrome-sandbox`). `release-manifest.mjs --made …` wrote `packages/app-desktop/out/release/`,
  and `release-verify.mjs` refused that unsigned event.
- **Smoke run of the final code:** the packaged `app.asar`, symlinked into the dev Electron's
  own `resources/` (so `process.resourcesPath` is the archive's directory, as when packaged), ran
  with `--dev-mocks --dev-fixtures`. The host spawned, `media worker state` went `starting` →
  `ready`, and "live manifests from the worker" followed. Before S2 the same setup failed six
  spawns. The link was removed afterwards (`resources/` again holds only `default_app.asar`).
- Still not verified: the Squirrel path on Windows; the remote-debugging and dev-flag refusals
  on the packaged binary itself, which aborts at the sandbox on this box (unchanged, §7).

### Residuals (additions and changes)

- **R4 (changed).** The AppImage cannot start on Ubuntu ≥ 24.04 without a user-namespace grant.
  The only acceptable grant is a profile on a root-owned extracted copy. Recommend the `.deb`
  there (ADR §7, open question 4).
- **R8.** `release-manifest.mjs` still accepts positional directories. `--made` is the safe
  path, and the CI uses only it.
- **R9.** The Squirrel lifecycle has run only in unit tests (no Windows build).
- **R10.** Pear makers were replaced by in-repo makers, and `pear://` has no job yet. Both wait
  on Cameron (open questions 3 and 9).

## Fix round 2 (verifier, 2026-09-25)

An independent verifier checked the fix pass (`c9fa673`, `163d6c8`). It found one Low and one
Info finding. Both were reproduced before any fix: new tests failed on the old code. The 0.1.0
manifest took a stale `Nutflix-0.1.0-rc.1-x64.AppImage` from `out/make` and exited 0. The
verifier CLI blocked on a FIFO until the test's 8 s bound killed it (`SIGTERM`). The same
`differential-review` and `sharp-edges` pass then ran on this diff. Fixes: commit `00221a0`.

| # | Sev | Finding | Outcome |
|---|---|---|---|
| V1 | Low | `release-manifest.mjs` `nameCarriesVersion` took the version followed by any `-`, `_` or `.`. For 0.1.0 it accepted `Nutflix-0.1.0-rc.1-x64.AppImage`, `nutflix_0.1.0-rc1_amd64.deb`, `Nutflix-0.1.0.1-x64.AppImage` and `nutflix-0.1.0-full.nupkg`. In positional mode, a stale rc artifact left in `out/make` could be signed into the 0.1.0 manifest, though ADR §5 and §8 said it could not | **Fixed.** A name must be exactly one a maker writes for this version: `<prefix><version><tail>`, with the tails fixed per maker in `ARTIFACT_SHAPES`. These are `Nutflix-<v>-<x64\|arm64>.AppImage`, `Nutflix-<v>-<x64\|arm64>.dmg`, `nutflix_<v>_<amd64\|arm64>.deb` and `Nutflix-<v>-Setup.exe`. The check is string equality; no regex is built from the version. No prefix starts another and no tail ends another, so a name matches only an artifact made for exactly this version (a test asserts both properties). The shapes are pinned to the makers. The prefixes come from `APP`. The arches are `identity.ts` `BUILD_ARCHES`, now also `cli.ts`'s list, and equal the AppImage runtime pins. The deb arches are maker-deb's own `debianArch`, and Squirrel's name is the Forge config's `setupExe`. The set of accepted names is also compared, as an exact set, with what the real makers write: the dmg maker with hdiutil stubbed, and the real deb maker (electron-installer-debian, dpkg + fakeroot) and AppImage maker (mksquashfs, fixture runtime) where the box has them. ADR §5 and §8 are corrected: they now say "another version", and state the two limits (residuals R8, R11). Tests: the verifier's four examples plus 19 more refused; each real maker name accepted; positional mode and a direct file argument refuse the stale names. Mutations R34–R36, R38, R39 |
| V2 | Info | `release-verify.mjs` `readEventFile` said a FIFO is refused, but `openSync(path, 'r')` blocks on a FIFO until a writer appears, so the `fstat` check never ran | **Fixed.** The file is opened `O_RDONLY \| O_NONBLOCK` (Windows has no such flag, so `0`). A FIFO opens at once and `fstat` refuses it. Nothing changes for a regular file. The test makes a FIFO with `mkfifo` and runs the CLI under a bounded spawn: `runNode` gained a `timeout` option and returns the `signal`. A regression therefore fails instead of hanging the suite; `spawnSync` blocks the event loop, so vitest's own timeout could not fire. Mutations R37, R40 |

Found by this round's own review:

| # | Sev | Finding | Outcome |
|---|---|---|---|
| S3 | Info | Deriving the names from the real deb maker showed that electron-installer-debian writes a prerelease in Debian form (`0.1.0-rc.1` → `nutflix_0.1.0~rc.1_amd64.deb`). `SAFE_NAME` does not allow `~`, so a prerelease release cannot carry its `.deb`. The manifest refuses it as an unsafe name, which fails closed | **Documented, not changed.** Allowing `~` would widen the name rule that the verifier also applies, just to support a prerelease channel that nobody has asked for. The limit is recorded in ADR §8 and pinned by the real-maker test (the rc `.deb` names fail `SAFE_NAME`). Residual R11 |

Sharp edges checked and left as is (this round):

- `RELEASE_EXTENSIONS` still lists `.msix`, `.zip` and `.rpm`, which no configured maker
  writes. In a directory, such a file is now collected and then refused by the name rule, a
  hard error, where before a versioned one would have been signed. It fails closed. A stray
  file stops the run so someone looks at it, instead of being skipped with a note.
- Both scripts `lstat` a downloaded or collected artifact and then open it again by path to
  hash it. Someone who can write that directory could swap in a FIFO between the two calls and
  make the run hang. They could not change a verdict: a swapped-in file is hashed and compared
  with the signed sum. The event file, which the verifier reads first, has no such gap.
- The tails name only the arches `cli.ts` builds (`x64`, `arm64`). Adding an arch means
  changing `BUILD_ARCHES`, and the pin test then fails until `ARTIFACT_SHAPES` and the AppImage
  runtime pins agree (mutation R38).

### Mutation checks (each guard broken, at least one test failed, guard restored)

R34 the old whole-field regex back (4 fail) · R35 an extra `-universal.dmg` tail (3) · R36 a
tail that ends another (`.AppImage`) (2) · R37 the blocking open back (1: the FIFO test,
killed by its 8 s bound, not hung) · R38 `BUILD_ARCHES` drifts from the runtime pins (3) · R39
a deb tail with the Forge arch (`_x64.deb`) (18) · R40 the `fstat` refusal dropped, the
non-blocking open kept (2: the FIFO and `/dev/zero` cases).

Before the fix, six of the new tests failed. The refusal list failed at
`Nutflix-0.1.0-rc.1-x64.AppImage: expected true to be false`. Positional mode exited 0. The
FIFO case was killed with `SIGTERM`. The three shape tests failed because `ARTIFACT_SHAPES`,
`BUILD_ARCHES` and `releaseArtifactNames` did not exist yet.

### Tests and evidence

- `release.test.ts` went from 21 to 27 tests. No existing test changed. The whole-field test
  still passes as written, since the new rule is stricter.
- `npx vitest run scripts/__tests__ packages/app-desktop`: 83 files, 1458 tests, all passing.
  `npx tsc -b --force` is clean; `tsconfig.scripts.json` typechecks the scripts' tests.
  eslint and `prettier --check` are clean on the changed files. `npm run check:locked` and
  `npm run lint:electron` report OK (207 files, 0 violations).
- The real-maker test ran here: dpkg, fakeroot and mksquashfs are present. It takes 0.8 s and
  skips itself where those tools are missing; the pure pins still run there.
- `release-manifest.mjs --made` over this box's real `out/make/linux-x64.artifacts.json`
  (`nutflix_0.0.0_amd64.deb`, sha256 `c0099eec…d42a`, the local build recorded above) still
  passes, with output to a scratch directory.

### Residuals (additions and changes)

- **R8 (changed).** The name rule is now exact, so positional mode refuses artifacts of every
  other version. It still cannot tell two builds of the same version apart. `--made` is the
  safe path, and the only one CI uses.
- **R11 (new).** A prerelease cannot release its `.deb`: the Debian-form name contains `~`, and
  the manifest refuses it (fails closed; ADR §8).

## Fix round 3 (verifier, 2026-09-25)

The verifier of round 2 found one Low finding, about test hygiene. It was reproduced before
the fix: the new assertions failed on the old code and listed the four staging dirs that run
had just left in `/tmp`. Fix: commit `e159210`, a change to the test file only.

| # | Sev | Finding | Outcome |
|---|---|---|---|
| V3 | Low | The real-maker test in `scripts/__tests__/release.test.ts` runs maker-deb. Its electron-installer-common stages each `.deb` in `tmp.dir()` and removes it only in tmp's graceful-cleanup exit hook, which never runs in a vitest worker. Every run left four `electron-installer-*` dirs (about 0.5 MB each on disk) in the real `os.tmpdir()` | **Fixed.** `makerNames` points `TMPDIR` at `<work>/tmp` while the makers run and restores it afterwards in a `finally`: the old value, or no key at all if there was none. tmp calls `os.tmpdir()` each time it makes a dir, so the staging goes into the test's own temp dir, which `afterEach`'s cleanup already removes. The test lists `electron-installer-*` in the real `os.tmpdir()` before and after. It asserts that no new entry belongs to this process (tmp puts the pid in the name, and another process or session may stage there at the same time). It also asserts that the four staging dirs (two arches, two versions) are in the test's dir under this pid, so the comparison is not vacuous, and that `TMPDIR` is restored. Mutations R41–R44 |

Sharp edges checked and left as is (this round):

- `process.env` is global to the worker. Anything else in the same worker that called
  `os.tmpdir()` while the makers ran would also land in the test's dir. Tests in a file run
  one at a time, and the `finally` bounds the window to the `makerNames` call.
- If tmp's exit hook ever runs (a runner that exits normally), its dirs are already gone. Its
  garbage collector catches each removal error ("already removed?"), so nothing throws at exit.

### Mutation checks (each guard broken, at least one test failed, guard restored)

R41 no redirect, the old code (1: the four `electron-installer--<pid>-*` dirs of that run
listed as left in `/tmp`) · R42 redirect with no restore (1: `TMPDIR` still the test's dir) ·
R43 an unconditional restore, which sets the string `'undefined'` when `TMPDIR` was unset (1)
· R44 redirect to a sibling dir outside `work`, which leaks and is not in `/tmp` itself (1: the
positive control found 0 staging dirs, not 4).

### Tests and evidence

- The real-maker test gained five `expect` lines. No test was removed or weakened, and
  `release.test.ts` still has 27 tests.
- `npx vitest run scripts/__tests__`: 5 files, 51 tests, all passing. The listings of
  `/tmp/electron-installer-*` and `/tmp/nutflix-release-*` were identical before and after
  that run.
- `npx tsc -b --force` is clean. eslint and `prettier --check` are clean on the changed file,
  and `npm run check:locked` reports OK. `npm run lint:electron` was not run, since
  app-desktop did not change. The Electron e2e was not run.

### /tmp cleanup

- **Removed: 84 dirs.** 80 were left by this lane's runs from 20:02 to 20:19 (round-2
  development and its verifier), and 4 by this round's failing pre-fix run (pid 3338068).
  Until `stage-3/integration` merged this branch at 20:57:44, this worktree was the only one
  with the fixture. A script checked each dir without following symlinks, and removed only
  the ones that passed every check:
  - It is a real directory owned by the developer, named `electron-installer--<pid>-<12 alnum>`,
    and the pid that made it is no longer running.
  - It holds exactly one child, `nutflix_<0.1.0|0.1.0~rc.1>_<amd64|arm64>`. Every file in it
    is owned by the developer, the only symlink is `usr/bin/nutflix -> ../lib/nutflix/nutflix`, and
    the total is under 2 MB.
  - It carries the fixture's own bytes. `usr/lib/nutflix/nutflix` is `#!/bin/sh\n` (a real
    build stages an Electron ELF), `version` is `44.2.0`, and `resources/app/package.json`
    is exactly the fixture's object for that version.
- Four of the 84 were earlier drafts of the same fixture. They were accepted only because
  they predate the round-2 commit `00221a0` (20:12:19). Three, from 20:02, have a five-field
  package.json with description `x`. One, from 20:08, stages an `i386` probe with the final
  package.json.
- Mutation R44 made its own `/tmp/m3-<pid>`. It was checked by hand before removal: owned by
  the developer, created by that run, holding only four `electron-installer--<that pid>-*` staging
  dirs, with no symlink except each tree's `usr/bin/nutflix`.
- **Left alone:** four `electron-installer--3346135-*` dirs, made at 21:02 by a `vitest run`
  in the `stage-3/integration` worktree, which has the round-2 version of this test. Each run
  there leaves four more until that branch takes `e159210`.
