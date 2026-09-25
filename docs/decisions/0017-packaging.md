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
  which is gitignored. `npm run build` must run first.
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

Asar settings: `asar: { unpackDir: '{worker,node_modules}' }`, `prune: false`. The staged tree
is the whole app.

For the linux-x64 build: 134 packages, 2,105 files, 128 MB staged. The `.deb` is 121 MB and
installs 405 MiB, most of it Electron itself.

### 3. The worker and read-only installs

**Worker entry.** In a packaged build, main's `dist` directory is `resources/app.asar`.
`workerEntryFor` in `src/main/args.ts` hands the host
`resources/app.asar.unpacked/worker/boot.mjs`. A dev build still spawns the `tsc` output
`dist/worker/entry.js`. `src/ipc/asar-path.ts` holds the shared string mapping.

**bare-sidecar.** In a packaged build, `loadSidecar` in `src/host/worker/sidecar.ts`:

- loads bare-sidecar from `app.asar.unpacked/node_modules`, so the binary it resolves is a real
  file that can be spawned;
- first resolves the binary with bare-sidecar's own `require-asset` call, and refuses to
  continue unless that binary is **already** executable (`WorkerRuntimeError`, "reinstall the
  app").

So bare-sidecar's `chmod` never runs: a read-only `.deb`, AppImage or signed bundle is never
modified. The build keeps the binary's mode, and `layout.ts` checks that it is executable. A dev
build keeps upstream behaviour.

### 4. Fuses

- `packaging/fuses.ts` holds exactly the five settings. Every other fuse keeps Electron's
  default.
- They are flipped with `@electron/fuses` 2.1.3 (Electron org, zero dependencies, SLSA
  provenance) in Forge's `packageAfterCopy` hook. That is before packager renames and signs
  the binary, following the same rule as `@electron-forge/plugin-fuses`. That plugin is not
  used: 7.11.2 pins `@electron/fuses` ^1.
- They are **read back from every packaged binary** in `postPackage`, together with a layout
  check (`layout.ts`):
  - main, host and renderer are packed;
  - the worker and the runtime are unpacked;
  - the runtime is executable;
  - no other platform's runtime is present;
  - there is no `resources/app/` folder.

  Any mismatch fails the build.
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
| Windows `.exe` | `@electron-forge/maker-squirrel` (Squirrel.Windows `Nutflix-Setup.exe`, `noMsi`) | Windows (or wine + mono) |
| macOS `.dmg` | **in-repo** `packaging/maker-dmg.ts`: `ditto` the `.app`, add an `/Applications` link, `hdiutil create -format UDZO`. The argv is built without a shell | macOS |
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

### 7. The Chromium sandbox on Linux (never `--no-sandbox`)

- **`.deb`.** electron-installer-common installs `/usr/lib/nutflix/chrome-sandbox` **setuid
  root (4755)**. This is Chromium's audited helper and the standard Electron/Chrome `.deb`
  layout, so the sandbox starts on Ubuntu 24 without an AppArmor profile. There are no
  maintainer scripts.
- **AppImage.** FUSE mounts the image `nosuid`, so the SUID helper cannot work. The sandbox then
  needs unprivileged user namespaces:
  - Debian, Fedora and Arch allow them;
  - Ubuntu ≥ 24 restricts them (`kernel.apparmor_restrict_unprivileged_userns=1`), and there
    the AppImage refuses to start (Chromium aborts, and main would refuse `--no-sandbox` anyway)
    unless the user installs a profile. The profile needs the same shape as the dev box's D4
    profile:

  ```
  abi <abi/4.0>,
  include <tunables/global>
  profile nutflix-appimage /tmp/.mount_Nutfli*/usr/lib/nutflix/nutflix flags=(unconfined) {
    userns,
  }
  ```

  The AppImage runtime's mount point is `/tmp/.mount_<first 6 letters of the name><random>`.
  The `.deb` is the recommended Linux format on Ubuntu.
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
  `out/Nutflix-linux-x64/chrome-sandbox`), redone after every build.

### 8. Release signing: a Nostr-signed manifest of sha256 sums

`scripts/release-manifest.mjs <out/make> --out <dir>` writes three files:

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

Nothing in the repo signs. Cameron signs the event with the SovTech key through Bunker46, using
NIP-46 `sign_event` in his signer. The nsec never leaves the bunker, and no job, script or
agent holds it.

`scripts/release-verify.mjs <signed-event.json> <file>…` (or `--all <dir>`) accepts only an
event that passes all of these:

- nostr-tools `verifyEvent` verifies it (library crypto only). The event is first reduced to
  plain JSON, because nostr-tools trusts a cached "verified" symbol that object spread copies;
- its pubkey **is the SovTech key**. There is no option to trust any other key;
- it is kind 30071 with `d` = `nutflix-desktop`;
- its artifact tags, content, `x` and `files` tags agree with each other;
- every named file is listed, and its size and sha256 match.

Artifact names may not contain path separators or whitespace. The verifier also prints the
release's version and signing date: an **older** genuine release verifies as well, so the
version and date should be compared with the current notice on the relays.

### 9. CI

`packages/app-desktop/packaging/ci/release.gitlab-ci.yml` defines manual jobs that run on
`desktop-v*` tags: Linux (deb and AppImage), macOS (runner tag `macos`, dmg for arm64 and x64)
and Windows (runner tag `windows`, Squirrel). Each job publishes the artifacts, SHA256SUMS and
the unsigned event.

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

## Open questions (Cameron)

1. App id `xyz.sovit.nutflix` and the `.deb` maintainer `SovTech <git@sovit.xyz>`. Keep them?
2. Brand icons: none exist in the repo. The installers currently show Electron's default icon.
3. `pear://` for Windows: add an msix maker (Pear's Windows format), or keep Windows
   `.exe`-only?
4. AppImage on Ubuntu ≥ 24: document the AppArmor profile (§7) and recommend the `.deb`, or drop
   the AppImage there?
5. Should the host check the digests of the unpacked files it loads (bare-sidecar's JS,
   sodium-native's `.node`, the worker tree) against a list inside the asar before spawning, or
   is waiting for code signing enough?
6. `d` = `nutflix-desktop` keeps one replaceable "latest release" notice on relays. Use a
   per-version `d` instead, to keep history?
7. Confirm the pinned AppImage runtime digests, for example with
   `gh release view 20251108 -R AppImage/type2-runtime` or by checking the `.sig` files. They
   were read from GitHub's release listing. A wrong pin fails closed.
8. `GrantFileProtocolExtraPrivileges` (the app uses no `file://`) and `EnableCookieEncryption`
   keep their defaults because only five fuses were asked for. Flip them too?
