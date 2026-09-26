# 17. Packaging: Electron Forge, fuses, asar and Nostr-signed releases

Date: 2026-09-25

## Status

Accepted for Stage 3 (issue #6, security review F21). Cameron's decisions, 2026-09-24:

- Electron Forge plus Pear makers.
- Targets: Windows `.exe`, macOS `.dmg`, Linux `.deb`, Linux AppImage, and a `pear://` address.
- Fuses: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`
  off; `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` on.
- Every release is signed with the SovTech ngit Nostr key through Bunker46, as a Nostr-signed
  manifest of sha256 sums. The nsec is never written anywhere.
- Gatekeeper and SmartScreen warnings are accepted for now.

Implemented on `stage-3/packaging`. On Linux, this lane built the package and the `.deb`. The
AppImage, `.exe` and `.dmg` are configured but were not built (§7).

One part of the decision is **not** implemented as stated and waits for Cameron's sign-off: no
Pear maker is used. The makers are Forge's own plus two in-repo ones, because Holepunch's
AppImage maker adds `--no-sandbox` (§5, open question 9).

## Context

Nothing packaged the app before this. The dev build runs `dist/` through the `electron` npm
binary, so four things had to be settled:

- **The fuses.** They act before main's first line runs (`NODE_OPTIONS`, `--inspect`,
  `ELECTRON_RUN_AS_NODE`), so only the packaged binary can carry them. F21 recorded them as open.
- **Bare cannot read an asar archive.** The worker and every npm package it loads must stay
  real files. So must bare-sidecar's prebuilt `bare`, because a binary inside an archive cannot
  be spawned.
- **The npm workspace.** Dependencies are hoisted to the repo root and the workspace packages
  are symlinks. Forge's packager prunes by walking the app's own `node_modules`, so it cannot
  build the app's dependency tree by itself.
- **Two leftovers from Stage 1:**
  - a bundled worker needs an unbundled boot module that imports `bare-encoding/global`
    first (D6);
  - bare-sidecar `chmod`s its binary at require time, which throws on a read-only install.

## Decision

### 1. Toolchain

- Electron Forge **8.0.0-alpha.10**, pinned exactly. It is driven by `packaging/cli.ts`
  through Forge's API: the staged directory (§2) gets a virtual config
  (`utils.registerForgeConfigForDirectory`), so the staged tree carries no config file.
- **Why an alpha.** Forge 7.11.2's dependency tree brings high and critical advisories that
  CI's `npm audit --audit-level=high` gate refuses:
  - critical `tar` through `@electron/rebuild` → `node-gyp`;
  - `extract-zip` through `@electron/packager` 18, which has no fixed version;
  - `image-size` through `maker-dmg` → `appdmg`.

  8.0.0-alpha.10 moves to `@electron/packager` 20 and `@electron/rebuild` 4. With it the lockfile
  audits clean: 0 vulnerabilities, 147 packages added, no existing entry changed.
- Move to 8.0.0 when it is released. Holepunch's `hello-pear-electron` is waiting on the same
  release.
- Commands: `npm run -w packages/app-desktop stage|package|make`. Options: `--platform`,
  `--arch`, `--targets deb,appimage,squirrel,dmg`. Output goes to `packages/app-desktop/out/`,
  which is gitignored. `npm run build` must run first, and staging refuses a build older than
  its sources (§2, "The build it copies must be current").
- **Electron download.** Every Electron zip is checked against `checksums.json` from the
  lockfile-pinned `electron` package (`download.checksums`). `@electron/get` re-checks a cached
  zip against it, so nothing is fetched when the zip is already cached.
- **No native rebuild** (`rebuildConfig.onlyModules: []`). Every native module ships N-API or
  Bare prebuilds.

### 2. What is packaged: a staged app

`packaging/stage.ts` writes a standalone app directory. Its layout is the same as `dist/`, so
main's path logic is unchanged.

| Path | What | In the asar? |
|---|---|---|
| `package.json` | name `nutflix`, productName `Nutflix`, `main: main/main.js`, `type: module` | packed |
| `main/main.js` | Electron main, bundled. Allowed inputs: `src/main` and `src/ipc` only | packed |
| `host/main.js` | the host utilityProcess, bundled **with its npm code** (`@sovit/core`, cashu-ts, nostr-tools, @noble…). Only native packages stay external (sodium-native; bare-sidecar is loaded at runtime) | packed |
| `renderer/`, `prompt/`, `preload.cjs`, `prompt-preload.cjs` | copied from `scripts/bundle.ts` output | packed |
| `worker/boot.mjs` | the **unbundled boot module**: `import 'bare-encoding/global'`, then `import('./worker.mjs')` (D6) | unpacked |
| `worker/worker.mjs` | the worker bundle: our sources only. Every npm package stays an import that Bare resolves itself (export conditions, addons). This is the same shape the Stage 1 tests already ran under real Bare | unpacked |
| `worker/pay/dleq-thread-entry.mjs` | the DLEQ thread's entry (issue #8 d; added by lane I1), a bundle of its own: `src/worker/pay` and `src/ipc` only, every import dynamic and inside its `try`, `@sovit/core` and `bare-encoding/global` resolved by Bare from `node_modules/`. The worker finds it at `./pay/` from its root module (`src/worker/worker-root.ts`, inlined at the bundle's root), so it resolves inside `worker/` in both layouts | unpacked |
| `node_modules/` | the **lockfile runtime closure** (`packaging/closure.ts`), described below | unpacked |

How `node_modules/` is built:

- It holds the runtime closure of `@sovit/app-desktop`'s `dependencies`, resolved with npm's
  own nearest-`node_modules` rule. The versions are exactly what package-lock.json pins; nothing
  is re-resolved against the registry.
- Workspace packages become real directories holding `package.json` and their `files` list,
  without tests, source maps or `.d.ts` files.
- Native prebuilds are kept for the target platform only. bare-sidecar alone ships six runtimes
  of about 70 MB each.
- Symlinks are refused. File modes are normalised (0644, or 0755 if executable), and staging
  twice produces a byte- and mode-identical tree.
- Not shipped:
  - `react`, `react-dom` and `@sovit/ui` are already in the renderer bundle;
  - `pear-runtime`: the host spawns the worker with bare-sidecar directly (D2) and never
    constructs `PearRuntime`. Dropping it also removes `pear-runtime-updater`, `hyperdrive`,
    `msix-manager` and `bare-worker` from the install.

Why the host is bundled into the asar: the wallet and signer code then sit inside the archive.
On macOS and Windows, the integrity fuse covers that code.

**core's test doubles are not in the packaged host bundle** (cross-lane review, round 4). core's
barrel re-exports them (`export * as mocks`: TestMint, MockWallet, MockPaymentEngine, the
fixtures; and `nostr.FakeRelayPool`), so the bundler cannot drop them, although the host reaches
them only behind `--dev-mocks` / `--dev-fixtures`, which a packaged main refuses. The staging
step bundles those two modules (`HOST_TEST_DOUBLES`) as stubs with the same export names, each
a value that throws when touched, and fails if any other module of core's `mocks/` reaches the
host bundle. The dev host (tsc output) and the worker's copy of core keep the real modules. A
test loads the staged host bundle in plain Node, so no stub is touched at load time.

**The build it copies must be current** (cross-lane review, round 4). The staging step compiles
main, the host and the worker glue from `src/`, but it ships two things it never compiles:
every workspace package's `dist/` (copied into `node_modules/` and inlined into the host bundle
through the package exports) and `scripts/bundle.ts`'s output. The reviewer changed core's melt
timeout in `src/` and staged without rebuilding: staging succeeded, and both the host bundle and
the worker's copy of core carried the old value. Before touching `out`, `assertCurrentBuild`
refuses when:

1. `tsc -b --dry`, run through TypeScript's API over every workspace package the app is built
   from (core, gateway, seeder shipped; `@sovit/ui` bundled), would rebuild one of them. A
   project whose sources were only touched ("would update timestamps") counts as current;
2. a stylesheet a workspace builds beside tsc (`@sovit/ui`'s `dist/*.css`) is older than the
   package's newest `src/` stylesheet;
3. a bundle output the stage copies is older than the newest file the bundle reads: under
   `src/renderer`, `src/preload`, `src/ipc`, `static/`, `@sovit/ui`'s `dist/` or its `src/`
   (tests and stories excluded). The bundle reads the UI through its package exports, so from
   its `dist/` (`dist/*.js` and the copied `dist/ui.css`), never its `src/`: round 5 added
   `dist/` after a bundle made before `tsc` rebuilt the UI staged the old renderer. A test pins
   the watched set (`bundleInputDirs`) against the real renderer bundle's inputs.

(2) and (3) compare mtimes; `npm run build` rewrites each of those files on every run, so the
remedy is always `npm run build`. The stage never runs the build itself, so it still writes
nothing outside its output directory. The Stage tests (`stage.test.ts`, the packaged-worker
integration test) now need a current build too, including after `npx tsc -b --force`, which
rewrites the UI's `dist/` (round 5).

Asar settings: `asar: { unpackDir: '{worker,node_modules}' }`, `prune: false`. The staged tree
is the whole app.

For the linux-x64 build: 134 packages, 2,105 files, 128 MB staged. The `.deb` is 121 MB and
installs 405 MiB, most of it Electron itself.

### 3. The worker and read-only installs

**Worker entry.** In a packaged build, main's `dist` directory is `resources/app.asar`.
`workerEntryFor` in `src/main/args.ts` hands the host
`resources/app.asar.unpacked/worker/boot.mjs`. A dev build still spawns the `tsc` output
`dist/worker/entry.js`. `src/ipc/asar-path.ts` holds the shared string mapping.

The mapping is keyed on the app's **own** archive: `appArchive(process.resourcesPath,
realpathSync)`, which main and the host utilityProcess both compute (Electron gives the utility
process `resourcesPath` too; checked on Electron 44.2.0). Only a path that is that archive or
lies inside it is mapped. The archive path is resolved through symlinks, because the module
loader has already resolved `import.meta.url`: a symlinked install, or macOS app translocation
under `/var` → `/private/var`, would otherwise never match. It used to key on the first `*.asar`
segment of the path, so an install under any directory named `x.asar` mapped into the wrong tree
(independent review).

**bare-sidecar.** In a packaged build, `loadSidecar` in `src/host/worker/sidecar.ts`:

- loads bare-sidecar from `app.asar.unpacked/node_modules`, so the binary it resolves is a real
  file that can be spawned;
- first resolves the binary with bare-sidecar's own `require-asset` call, and refuses to
  continue unless that binary is **already** executable (`WorkerRuntimeError`, "reinstall the
  app").

So bare-sidecar's `chmod` never runs: a read-only `.deb`, AppImage or signed bundle is never
modified. The build keeps the binary's mode, and `layout.ts` checks that it is executable. A dev
build keeps upstream behaviour. The supervisor logs a `WorkerRuntimeError`'s reason when a spawn
fails, so "reinstall the app" reaches the log; any other spawn error's text (which could name a
path) is still dropped.

### 4. Fuses

- `packaging/fuses.ts` holds exactly the five settings. Every other fuse keeps Electron's
  default.
- They are flipped with `@electron/fuses` 2.1.3 (Electron org, zero dependencies, SLSA
  provenance) in Forge's `packageAfterCopy` hook. That is before packager renames and signs
  the binary, following the same rule as `@electron-forge/plugin-fuses`. That plugin is not
  used: 7.11.2 pins `@electron/fuses` ^1.
- They are **read back from every packaged binary** in `postPackage`, together with a layout
  check (`layout.ts`):
  - main, the host, both preloads, and every file of the app window and the prompt window are
    packed (derived from the staging step's file lists, so a file added there is checked too);
  - the worker and the runtime are unpacked, and the worker's three files (boot module,
    bundle, DLEQ thread entry: `identity.ts` `UNPACKED_FILES`) are regular files, not symlinks
    and not under a symlinked directory (lane I1). A package without the thread entry would
    still start, but its worker would run every DLEQ check on its event loop;
  - the runtime is executable;
  - no other platform's runtime is present;
  - there is no `resources/app/` folder.

  Any mismatch fails the build.
- **Chromium's DevTools protocol.** The fuses close Node's `--inspect` and `NODE_OPTIONS`, but
  not `--remote-debugging-port` or `--remote-debugging-pipe`. With either, a wrapper script or
  an edited `.desktop` line exposes CDP, which drives the renderer holding the preload API and
  the prompt window. A packaged build refuses both (exit 78, `security.ts`); main runs before
  the DevTools server starts. A dev build keeps them, because the e2e harness attaches through
  them (independent review).
- **The other switches a wrapper could add** (cross-lane review, round 4). Main's refusals run
  in this order (main.ts; pinned by main-wiring's refusal-order test): Squirrel's lifecycle
  launch, the sandbox switches (`SANDBOX_BYPASS_SWITCHES`, the first list below), the dev
  flags, the remote-debugging switches, and last `PACKAGED_REFUSED_SWITCHES` (the second list).
  Round 4 extended the first list and added the second:
  - `SANDBOX_BYPASS_SWITCHES`, refused in **every** build (D4), second after Squirrel, now
    thirteen: D4's `no-sandbox`, `disable-gpu-sandbox` and `no-zygote`, plus
    `no-zygote-sandbox`, `disable-seccomp-filter-sandbox`, `disable-namespace-sandbox`,
    `disable-setuid-sandbox`, `disable-landlock-sandbox`, `allow-sandbox-debugging`,
    `gpu-sandbox-allow-sysv-shm`, `disable-webnn-compiler-sandbox`, `single-process` and
    `in-process-gpu`;
  - `PACKAGED_REFUSED_SWITCHES`, refused in **packaged** builds, last: the process wrappers
    `renderer-cmd-prefix`, `utility-cmd-prefix` (the host is a utility process),
    `gpu-launcher`, `zygote-cmd-prefix` and `browser-subprocess-path`, V8's `js-flags`, and
    `disable-site-isolation-trials` and `disable-web-security`. A dev build keeps them for
    debugging.

  Every name is a string in Electron 44.2.0's Linux binary. Chromium may already have started
  its zygote and GPU process when main runs, so a prefix on those has run once; the refusal
  means the app never goes on (no window, host or worker). Not refused: the debug pauses
  (`*-startup-dialog`, `wait-for-debugger*`), and `--enable-features`/`--disable-features`
  (open question 11). No Electron was launched with these switches: this box cannot start the
  Chromium sandbox without Cameron's grant (e2e/support.ts), so the refusals are tested through
  main's fake-Electron wiring tests.
- Platform notes:
  - Electron implements `EnableEmbeddedAsarIntegrityValidation` on **macOS and Windows only**.
    On Linux the fuse is set but has no effect.
  - The macOS integrity digest is written into the framework binary only on a macOS host
    (packager 20). If the slot is left empty, Electron does not check.
  - On macOS, the ad-hoc signature is reset only for unsigned arm64 builds. Whether a build is
    signed follows `packagerConfig.osxSign`.

### 5. Makers

| Target | Maker | Build host |
|---|---|---|
| Windows `.exe` | `@electron-forge/maker-squirrel` (Squirrel.Windows `Nutflix-<version>-Setup.exe`, `noMsi`) | Windows (or wine + mono) |
| macOS `.dmg` | **in-repo** `packaging/maker-dmg.ts`: empty `out/make/dmg/<arch>`, `ditto` the `.app`, add an `/Applications` link, `hdiutil create -format UDZO`. The argv is built without a shell | macOS |
| Linux `.deb` | `@electron-forge/maker-deb` (electron-installer-debian) | Linux with `dpkg` and `fakeroot` |
| Linux AppImage | **in-repo** `packaging/maker-appimage.ts` | Linux with `mksquashfs` |
| `pear://` | the Pear CLI, from the artifacts above (§6) | any |

Why the in-repo makers:

- **AppImage.**
  - Holepunch's `pear-electron-forge-maker-appimage` 2.0.1 writes an `AppRun` that adds
    **`--no-sandbox` on Ubuntu ≥ 24**. Main refuses that switch (D4), so the app would not
    start, and the sandbox is not negotiable. It also pulls electron-builder's
    `app-builder-lib`.
  - `@reforged/maker-appimage` 5.3.1 downloads the AppImage runtime from a **moving** tag
    (`continuous`) at build time, unverified. It also depends on Forge 7's `maker-base`, which
    brings back the advisories above.

  Ours builds the AppDir with `AppRun` as a symlink to the Electron binary itself: no wrapper
  and no switches. It then runs `mksquashfs` (root-owned, no xattrs, fixed times under
  `SOURCE_DATE_EPOCH`) and prepends the **pinned** type-2 runtime: release `20251108`,
  `runtime-x86_64` sha256
  `2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d`, and `runtime-aarch64`
  sha256 `00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444`. The runtime file is
  placed by hand in `out/appimage-runtime/`; the build downloads nothing and refuses any other
  bytes.
- **dmg.** `maker-dmg` → `electron-installer-dmg` → `appdmg` brings the `image-size`
  advisory. Under `ignore-scripts` it would also need two native modules (`macos-alias`,
  `fs-xattr`) built by hand. A compressed image holding the app and an `/Applications` link is
  all the release needs.

Every artifact name carries the version, in one fixed shape per maker:
`nutflix_<v>_<amd64|arm64>.deb`, `Nutflix-<v>-<x64|arm64>.AppImage`,
`Nutflix-<v>-<x64|arm64>.dmg` and `Nutflix-<v>-Setup.exe`. The release manifest accepts exactly
these names and refuses any other (§8). So a stale artifact of **another version**, a
prerelease one included, cannot be signed by accident. A name cannot tell two builds of the
**same** version apart; only `--made` keeps an older same-version build out (§8).

**Deviation from "Pear makers".** Cameron's decision named Pear makers. None is used:

- Holepunch's `pear-electron-forge-maker-appimage` writes an `AppRun` that adds `--no-sandbox`
  on Ubuntu ≥ 24. Main refuses that switch (D4), so the app would not start there, and the
  sandbox is not negotiable.
- Pear's Windows format is `.msix`, and Cameron asked for an `.exe` (Squirrel).

The in-repo makers above take their place. This is put to Cameron as open question 9 rather
than decided here.

**Squirrel.Windows lifecycle** (`src/main/squirrel.ts`). Squirrel starts the installed app
with `--squirrel-install`, `--squirrel-updated`, `--squirrel-uninstall` or
`--squirrel-obsolete` as its first argument and expects it to do its part and exit. Without
handling, the installer would start the whole app (window, host, worker, DHT), create no
shortcut, and uninstall would launch the app instead of cleaning up (independent review). Main
now handles these **first**, before the sandbox and dev-flag refusals and before any window,
host or worker exists, on packaged win32 builds only:

| Argument | Action |
|---|---|
| `--squirrel-install`, `--squirrel-updated` | `..\Update.exe --createShortcut=nutflix.exe`, then exit 0 |
| `--squirrel-uninstall` | `..\Update.exe --removeShortcut=nutflix.exe`, then exit 0 |
| `--squirrel-obsolete` | exit 0 |
| `--squirrel-firstrun` | start normally |

- Update.exe runs through `execFileSync` with a fixed argv, no shell, hidden, and a 10 s bound
  (Squirrel kills a hook after 15 s). If it fails, main still exits.
- It runs only when the executable sits in Squirrel's `app-<version>` directory: a copied or
  unzipped build never runs whatever `Update.exe` might sit in the folder above it.
- The module is pure (the runner is injected), so it is unit-tested on Linux; the wiring is
  tested against the fake `electron` in `main-wiring.test.ts`. It has not run on Windows.
- `scripts/electron-security-lint.mjs` does not restrict `child_process`, so nothing there
  needed an exception.

### 6. `pear://`

The Pear flow for Electron apps today (`hello-pear-electron`, docs.pears.com "Ship your app"):

1. `forge make` runs on each OS.
2. `pear build --package=… --linux-x64-app X.AppImage --darwin-arm64-app X.app
   --win32-x64-app X.msix --target nutflix-<v>` assembles a deployment directory
   (`by-arch/<platform-arch>/app/…`).
3. `pear stage <link> <dir>` puts it in a Hyperdrive on a link made with `pear touch`.
4. `pear provision` copies it to a lean link, and `pear seed` keeps it online.

Decided here:

- The `pear://` address is a **P2P download channel for the same artifacts**. Their
  authenticity comes from the Nostr-signed manifest (§8), not from the Hypercore writer key.
- **No OTA.** Pear's in-app updater (`new PearRuntime({ upgrade })`) would replace the binary on
  the Hypercore key's authority alone, which bypasses the SovTech signature. The app never
  constructs it (D2), and `pear-runtime` is not even shipped.
- Pear expects **`.msix`** for Windows, not a Squirrel `.exe`. So Windows is on `pear://` only
  if an msix maker is added (open question).
- Not done here: `pear touch/stage/seed` need the Pear CLI and write keys, and they contact the
  DHT. This lane contacts nothing outside the npm registry.
- No CI job yet. What `pear build` is given depends on open questions 3 and 9, the Pear CLI
  would need an exact pin reviewed like any other dependency, and the link's write key stays on
  Cameron's machine, never on a runner. The commands above are the recipe.

### 7. The Chromium sandbox on Linux (never `--no-sandbox`)

- **`.deb`.** electron-installer-common makes `/usr/lib/nutflix/chrome-sandbox` **setuid root
  (4755)** while staging, and dpkg installs it that way. No maintainer script is involved. This
  is Chromium's audited helper and the standard Electron/Chrome `.deb` layout, so the sandbox
  starts on Ubuntu 24.04 without an AppArmor profile. A setuid-root binary is still a choice
  worth Cameron's explicit yes (open question 10).
- **AppImage.** FUSE mounts the image `nosuid`, so the SUID helper cannot work. The sandbox then
  needs unprivileged user namespaces:
  - Debian, Fedora and Arch allow them;
  - Ubuntu ≥ 24.04 restricts them (`kernel.apparmor_restrict_unprivileged_userns=1`). There the
    AppImage refuses to start: Chromium aborts, and main would refuse `--no-sandbox` anyway.
- **Recommendation for Ubuntu ≥ 24.04: install the `.deb`.**
- **Never attach a userns profile to the AppImage's mount point.** The runtime mounts the image
  under `/tmp/.mount_<name><random>`, and `/tmp` is writable by every local user. A userns
  profile attached to a pattern under that mount point lets **any** local user create a
  matching path, copy any binary there and get unprivileged user namespaces. That defeats
  `apparmor_restrict_unprivileged_userns` for the whole machine. The mount name also follows
  the AppImage's *file* name, so a renamed download would not even match. (An earlier draft of
  this ADR proposed exactly that profile; independent review.)
- **If the AppImage route is kept on Ubuntu ≥ 24.04**, it goes through a root-owned copy with a
  profile on that exact path:

  ```
  ./Nutflix-<v>-x64.AppImage --appimage-extract          # after release-verify.mjs on the file
  sudo mv squashfs-root /opt/nutflix
  sudo chown -R root:root /opt/nutflix
  sudo chmod -R go-w /opt/nutflix
  ```

  ```
  abi <abi/4.0>,
  include <tunables/global>
  profile nutflix-opt /opt/nutflix/usr/lib/nutflix/nutflix flags=(unconfined) {
    userns,
  }
  ```

  Only root can put a binary at that path, so the profile grants nothing to other users. At that
  point the extracted tree is a manual install, and the `.deb` does the same job with updates
  and removal handled by dpkg. Open question 4 asks whether to document this route at all.
- **The packaged binary on this dev box.** The D4 profile `/etc/apparmor.d/nutflix-electron`
  names only `…/node_modules/electron/dist/electron`, and the packaged `chrome-sandbox` is not
  root-owned. So `out/Nutflix-linux-x64/nutflix` aborts before any JavaScript runs:
  `FATAL:setuid_sandbox_host.cc:166 The SUID sandbox helper binary was found, but is not
  configured correctly`. To run it, and so prove the dev-flag refusal (exit 78) on a real
  packaged binary, Cameron would change the D4 profile's attachment to:

  ```
  profile nutflix-electron /home/<you>/nutflix/{,.worktrees/*/}{node_modules/electron/dist/electron,packages/app-desktop/out/Nutflix-linux-*/nutflix} flags=(unconfined) {
  ```

  The alternative is the SUID route (`chown root:root` + `chmod 4755` on
  `out/Nutflix-linux-x64/chrome-sandbox`), redone after every build. Like the D4 line it
  extends, that attachment is a developer-box grant: it lets whoever can write under
  `/home/<you>/nutflix` (its owner alone) run a binary there with user namespaces. It
  is never a pattern to ship to users (see the AppImage bullet above).

### 8. Release signing: a Nostr-signed manifest of sha256 sums

`scripts/release-manifest.mjs --made out/make/<platform>-<arch>.artifacts.json …` writes three
files to `packages/app-desktop/out/release/` (gitignored; `--out` overrides it):

- `SHA256SUMS`, in `sha256sum -c` format;
- `release-manifest.json`, with name, bytes and sha256 per artifact, plus version and commit;
- `release-event.unsigned.json`, an **unsigned** NIP-01 event:

| Field | Value |
|---|---|
| `kind` | 30071 (`NostrKind.ReleaseNotice`, contracts v3, the same kind as the web build's T13 notice) |
| `pubkey` | the SovTech key `npub1s0vtech…9adx` (hex `83d8bce2…3434`) |
| `tags` | `["d","nutflix-desktop"]`, `["version",v]`, `["commit",sha]`, `["x",sha256(content)]`, `["files",n]`, `["size",total]`, then `["artifact",name,sha256,bytes]` for each file |
| `content` | the `SHA256SUMS` text |
| `id`, `sig` | empty |

Inputs and rules:

- **One manifest per release.** Kind 30071 is addressable: relays keep one event per key, kind
  and `d`. Per-platform events would overwrite each other, and a Linux user comparing a download
  with "the current notice" would find no `.deb` in it (independent review). So the manifest is
  made once over every platform's artifacts (§9).
- **Only what the make produced.** `packaging/cli.ts make` writes
  `out/make/<platform>-<arch>.artifacts.json`: Forge's own list of the artifacts that make
  produced, relative to `out/make`, with the version. `--made` reads these lists. A list made
  for another version is refused, and so is any path in it that is absolute, uses backslashes or
  climbs out with `..`. Positional files and directories are still accepted for ad-hoc use.
- **Every artifact name is exactly one that a maker writes for this version:**
  `Nutflix-<v>-<x64|arm64>.AppImage`, `Nutflix-<v>-<x64|arm64>.dmg`,
  `nutflix_<v>_<amd64|arm64>.deb` or `Nutflix-<v>-Setup.exe`. The script's `ARTIFACT_SHAPES`
  is pinned by a test to the Forge config, to `BUILD_ARCHES` (the arches `cli.ts` builds) and
  to what the real deb and AppImage makers write. No prefix starts another and no tail ends
  another, so a name matches only an artifact made for exactly this version. Anything else is
  refused, in every mode. For release 0.1.0 that includes an older
  `Nutflix-0.0.9-x64.AppImage` left in `out/make`, a prerelease
  `Nutflix-0.1.0-rc.1-x64.AppImage` or `nutflix_0.1.0-rc1_amd64.deb`,
  `Nutflix-0.1.0.1-x64.AppImage`, and Squirrel's `nutflix-0.1.0-full.nupkg`. The first rule
  took the version followed by any `-`, `_` or `.`, so it accepted the last four (verifier,
  round 2).
- **What a name cannot show.**
  - A name cannot tell two builds of the *same* version apart. In positional mode, a stale
    artifact of the same version is still accepted. `--made` is the safe path, and the only
    one CI uses.
  - A prerelease cannot ship its `.deb` yet. electron-installer-debian writes the Debian form
    (`nutflix_0.1.0~rc.1_amd64.deb`), and `~` is not allowed in an artifact name, so the
    manifest refuses that file (fails closed).
- **`created_at` is the time the manifest is made**, never the commit time (`SOURCE_DATE_EPOCH`).
  A corrected manifest for the same commit must be newer than the event it replaces on the
  relays. `--created-at` overrides it.

Nothing in the repo signs. Cameron signs the event with the SovTech key through Bunker46, using
NIP-46 `sign_event` in his signer. The nsec never leaves the bunker, and no job, script or
agent holds it.

`scripts/release-verify.mjs <signed-event.json> <file>…` (or `--all <dir>`) accepts only an
event that passes all of these:

- nostr-tools `verifyEvent` verifies it (library crypto only). The event is first reduced to
  plain JSON, because nostr-tools trusts a cached "verified" symbol that object spread copies;
- its pubkey **is the SovTech key**. There is no option to trust any other key;
- it is kind 30071 with `d` = `nutflix-desktop`;
- its artifact tags, content, `x`, `files` (the count) and `size` (the total) tags agree with
  each other, and a `commit` tag, when present, is a full 40-hex sha;
- every named file is listed, and its size and sha256 match.

Artifact names may not contain path separators or whitespace. The event file is read through
one descriptor: a regular file of at most 256 KiB, counted in bytes actually read. It is opened
non-blocking, so a FIFO is refused at once instead of waiting for a writer (verifier, round 2). A download
that is a symlink is refused. The verifier also prints the release's version, commit and
**creation** date (`created_at`: when the manifest was made, before signing). An **older**
genuine release verifies as well, so these should be compared with the current notice on the
relays.

### 9. CI

`packages/app-desktop/packaging/ci/release.gitlab-ci.yml` defines manual jobs that run on
`desktop-v*` tags:

- `desktop-linux` (deb and AppImage), `desktop-macos` (runner tag `macos`, dmg for arm64 and
  x64) and `desktop-windows` (runner tag `windows`, Squirrel) only build. Each publishes
  `out/make/`, which includes its `<platform>-<arch>.artifacts.json`.
- `desktop-release-manifest` needs all three, receives their `out/make/` trees, and runs
  `release-manifest.mjs` **once** with the four lists. It publishes the artifacts, SHA256SUMS,
  the manifest and the one unsigned event.

The file is **not active**. `ci/gitlab-ci.yml` is parked (no runner yet) and is outside this
lane's allowlist. Enabling it takes one `include:` line, proposed in `docs/lanes/S3-pack.md`.

## Consequences

- F21's fuse half is closed for packaged builds, and the fuses are verified on every build.
  EnableEmbeddedAsarIntegrityValidation protects only on macOS and Windows.
- Unpacked files (the worker, `node_modules` and the native addons the host loads) are not
  covered by asar integrity on any platform. Once macOS builds are code-signed, the bundle
  signature will cover them there. On Windows and Linux, protection depends on the install
  location: `/usr/lib` for the `.deb`, the squashfs for the AppImage, and `%LocalAppData%` for
  Squirrel, which the user can write to.
- The packaged host bundle is exercised by a smoke run: the dev Electron loads the packaged
  `app.asar`, and the host and worker reach `ready` with the dev fixtures. The Electron e2e
  still runs the dev layout.
- Builds are not claimed reproducible. The staged tree is deterministic; the packager, asar
  and deb outputs were not checked.
- A Squirrel-installed Windows build makes and removes its own shortcuts; that path has only
  been exercised in unit tests.
- `app.isPackaged` keys on the executable's name. A same-user copy of the install renamed to
  `electron` counts as a dev build, which lifts the dev-flag and remote-debugging refusals. That
  copy is user-writable anyway (its `app.asar` can simply be edited), so this gives nothing
  beyond what the copy already allows.

## Open questions (Cameron)

1. App id `xyz.sovit.nutflix` and the `.deb` maintainer `SovTech <git@sovit.xyz>`. Keep them?
2. Brand icons: none exist in the repo. The installers currently show Electron's default icon.
3. `pear://` for Windows: add an msix maker (Pear's Windows format), or keep Windows
   `.exe`-only (then Windows is not on `pear://`)?
4. AppImage on Ubuntu ≥ 24.04: it cannot start there without a user-namespace grant, and a
   profile on its `/tmp` mount point would open user namespaces to every local user (§7). The
   recommendation is the `.deb`. Should the extract-to-root-owned-`/opt` route be documented for
   users, or should the AppImage simply be marked "not for Ubuntu ≥ 24.04"?
5. Should the host check the digests of the unpacked files it loads (bare-sidecar's JS,
   sodium-native's `.node`, the worker tree) against a list inside the asar before spawning, or
   is waiting for code signing enough?
6. `d` = `nutflix-desktop` keeps one replaceable "latest release" notice on relays, now one per
   release covering every platform. Use a per-version `d` instead, to keep history?
7. Confirm the pinned AppImage runtime digests, for example with
   `gh release view 20251108 -R AppImage/type2-runtime` or by checking the `.sig` files. They
   were read from GitHub's release listing. A wrong pin fails closed.
8. `GrantFileProtocolExtraPrivileges` (the app uses no `file://`) and `EnableCookieEncryption`
   keep their defaults because only five fuses were asked for. Flip them too? (Chromium's
   remote-debugging switches are now refused in packaged builds, §4.) The cross-lane review
   (round 4) read the packaged binary back with `@electron/fuses read`: the five chosen fuses
   are as intended, `GrantFileProtocolExtraPrivileges` is Enabled and `EnableCookieEncryption`
   Disabled. The app serves everything over its own `app:` scheme, and Electron's security
   guidance recommends turning the `file:` privilege fuse off. Left unchanged until you answer.
9. **The makers.** The decision said "Electron Forge plus Pear makers". This lane uses Forge's
   Squirrel and deb makers plus two in-repo makers (AppImage, dmg) instead, because Holepunch's
   AppImage maker adds `--no-sandbox` on Ubuntu ≥ 24 (main refuses it, D4) and pulls
   electron-builder's `app-builder-lib`, and the maintained dmg maker brings a high advisory.
   Approve the substitution, or name the Pear makers to use and accept what they bring?
10. **The setuid-root `chrome-sandbox` in the `.deb`** (§7). It is Chromium's standard Linux
    sandbox helper and what makes the sandbox start on Ubuntu 24.04 without a profile. Accept
    it, or ship an AppArmor userns profile for `/usr/lib/nutflix/nutflix` instead (a maintainer
    script that runs as root at install)?
11. **`--enable-features` / `--disable-features` in a packaged build** (cross-lane review,
    round 4). Some Chromium features are sandbox layers (the network service's sandbox, for
    one), so `--disable-features=…` or `--enable-features=NetworkServiceInProcess…` on an
    edited `.desktop` line could weaken a packaged build. Main does not refuse these switches:
    they carry a list, refusing them outright breaks Wayland users
    (`--enable-features=UseOzonePlatform,WaylandWindowDecorations`), and a list of dangerous
    feature names is specific to each Chromium version and cannot be checked here without
    launching Electron. Refuse named features (which list?), refuse the switches outright, or
    leave them?

## Amendment 2026-09-26 — a sixth fuse (Cameron)

`GrantFileProtocolExtraPrivileges` is turned **off** as well (Cameron, 2026-09-26): the app never
loads `file://`, so the privileges are defence-in-depth only. The build's fuse read-back checks
all six.
