# Lane L6-A — desktop shell: Electron main, preload, renderer

**Issued against `CONTRACTS_VERSION = 4`** (ADR 0007). Date: 2026-09-23. Branch `lane/L6-A`, rebased
onto `cc7185c` (the orchestrator's `packages/app-desktop/scripts/tsconfig.json`, asked for by this
lane so eslint's project service covers `scripts/bundle.ts`). Spec: `docs/plan/L6-design.md` §6 row
L6-A with §1 (Main, Renderer, PlaySession across processes), §2 (renderer ⇄ main, SE-1, rehydrate),
§3 (all rows except the worker playback server and host images), §4, §5(b), D3, D4, D5, risk 5.

No contract change requested (`docs/contract-requests/L6-A.md` does not exist on purpose). No
`src/ipc/` or `src/types/` edit, no dependency added, `package.json` and the lockfile untouched —
the script changes the orchestrator must make are listed below. One file outside the package, on
the orchestrator's instruction: `scripts/__tests__/electron-security-lint.test.ts` asserted "zero
windows in app-desktop/src (no Electron code yet)"; it now asserts EXACTLY one window constructor
and one webPreferences object with 0 violations (a second window must be a reviewed change), and
lands in the same commit as `src/main/window.ts`.

## What was built

```
packages/app-desktop/
  src/main/                     Electron main (only main.ts imports electron at runtime)
    main.ts                     lifecycle, wiring, host supervision, e2e counters (--e2e-hooks)
    window.ts                   the one BrowserWindow — literal posture
    security.ts                 web-contents-created hardening, permission handlers, session
                                policy, sandbox-bypass switch detection
    schemes.ts                  app: + nf-media: privileges, app-origin checks
    csp.ts                      the CSP (design §3, verbatim) + response headers
    app-protocol.ts             app://nutflix/… — static files, traversal guard, CSP header
    media.ts                    nf-media://play/<token> (net.fetch Range proxy) +
                                nf-media://img/<id> (host image bytes); media-link registry
    ipc-gate.ts                 nf:call / nf:sub / nf:grant-file gate → HostIn; replies/events back
    file-tokens.ts              SE-1 token registry (lstat, single use, per webContents, 10 min)
    host-link.ts                utilityProcess supervision: isHostOut, respawn budget
    money-gate.ts               Stage 2 hook (stub; fails closed without --dev-mocks)
    args.ts, log.ts             argv; redacting logger (event names + scalars only)
  src/preload/                  sandboxed preload, bundled to dist/preload.cjs
    preload.ts                  contextBridge.exposeInMainWorld('nutflix', …) — the only key
    bridge.ts                   the NetworkAdapter shape + desktop.ffmpeg; PlaySession around sid;
                                SE-1 File → path → token; D3/D5 stubs
    transport.ts                numbered calls, subscriptions, grants over ipcRenderer
    types.ts                    NutflixBridge (wire-typed)
  src/renderer/                 bundled to dist/renderer/app.js
    main.tsx                    boot: window.nutflix → rehydrate → coordinator → <Shell>
    model.ts                    createShellModel (coordinator + wrapped adapter + router)
    App.tsx                     <Shell>: header, sidebar, routed screens, mini-player, toasts
    coordinator.ts              the playback coordinator (SE-2/SE-3)
    router.ts                   in-memory history of {route, extras}
    adapter/rehydrate.ts        Maps from $map, Error .code from the prefix, PlaySession proxy
    bridge-types.ts             what the renderer expects at window.nutflix
    shell/{Header,Sidebar,MiniPlayer}.tsx, shell/hooks.ts, shell.css
  static/index.html             no inline anything; links ui.css + shell.css, loads app.js
  scripts/bundle.ts             esbuild: renderer ESM + preload CJS + static copies (+ checks)
  e2e/                          Electron suites — NOT in npm test (see "Running the Electron suites")
    stage1.e2e.ts               design §5(b)
    fidelity.e2e.ts + fidelity/ day-1 fidelity spike (risk 5)
    support.ts, tsconfig.json   launch/display/sandbox-precondition plumbing; lint-only config
```

## Mapping to the design

### §1 / §2 — processes and the renderer ⇄ main hop

- **Main is thin**: every module but `main.ts` is Electron-free (structural types), so each §3
  control is unit-tested with fakes; `main.ts` itself is tested against a fake `electron` module
  (`main-wiring.test.ts`).
- **PlaySession across processes**: the host's `media-link {token, url}` lands in `MediaLinks`
  (re-validated: `http://127.0.0.1:<port>/…` only, ≤ 256 links); the renderer only ever sees
  `nf-media://play/<token>`; `protocol.handle('nf-media')` forwards exactly one `Range` header via
  `net.fetch(url, {redirect: 'error'})` and streams the 200/206/416 back with a fixed
  `video/mp4`, `nosniff`, `no-store`, a `sandbox` CSP, and only `content-length`/`content-range`
  copied (well-formed only). The preload builds a real `PlaySession` whose methods close over the
  host-minted `sid`; `onPeers`/`onSpend` subscribe to `session.peers`/`session.spend`; `close()`
  drops those subscriptions and is idempotent.
- **Errors**: the preload rejects with L6-0's `fromWireError` (`IpcError`, message
  `"<code>: …"`); `contextBridge` keeps only the message, so `renderer/adapter/rehydrate.ts`
  rebuilds `IpcError` with `.code` from the prefix (also through Electron's
  `Error invoking remote method …: Error:` wrapper). Tested with the REAL screen classifiers
  (`classifyStudioError`, `shortsPlayErrorKind`, Watch `playErrorKind`).
- **Maps**: every result and topic payload is `rehydrate`d in the renderer; the preload never
  touches them (they stay `$map` across `contextBridge`, whatever the fidelity spike finds).
- **SE-1** (see §3 below).

### §3 — security checklist (owned rows) and their tests

| Control | Where | Tests |
|---|---|---|
| literal `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (+ `nodeIntegrationInWorker/SubFrames: false`, `spellcheck: false`, `safeDialogs`, `navigateOnDragDrop: false`); `webSecurity`/`webviewTag` never mentioned | `main/window.ts` | `security.test.ts` (captured options, forbidden keys absent; `scripts/electron-security-lint.mjs` run on the package, must see ≥ 1 window); e2e reads `getLastWebPreferences()` |
| never `--no-sandbox` (D4): `app.enableSandbox()` before ready; main EXITS (78) if `no-sandbox`, `disable-gpu-sandbox` or `no-zygote` is present; nothing ever calls `appendSwitch` | `main/main.ts`, `main/security.ts` | `main-wiring.test.ts` (order `enableSandbox → registerSchemes → ready`, `appendSwitch` never called, refusal per switch); `security.test.ts`; e2e `hasSwitch('no-sandbox') === false` |
| preload surface = NetworkAdapter shape + `desktop.ffmpeg`, one key `nutflix` | `preload/bridge.ts`, `preload.ts` | `bridge.test.ts` (key tree == allowlist derived from `METHODS`/`EXCLUDED_METHODS`/`TOPIC_METHODS`; `preload.ts` under a mocked `electron` exposes exactly `nutflix`); renderer side in `rehydrate.test.ts`; e2e compares the live key tree |
| D3/D5: `wallet.send/receive/p2pkPubkey/keyset` reject `forbidden:` without IPC; the gate refuses them too | `preload/bridge.ts`, `main/ipc-gate.ts` | `bridge.test.ts`, `ipc-gate.test.ts` |
| CSP as a response header (design string verbatim) on every `app:` response | `main/csp.ts`, `main/app-protocol.ts` | `app-protocol.test.ts` (exact string; no `unsafe-*`/wildcards/remote); e2e: no violation; fidelity: inline script blocked |
| window-open deny; `will-navigate`/`will-redirect`/`will-frame-navigate`/`will-attach-webview` prevented, for every webContents | `main/security.ts` via `app.on('web-contents-created')` | `security.test.ts` (fake webContents), `main-wiring.test.ts`; e2e: a Markdown `_blank` link opens nothing |
| permissions: only `fullscreen` + `clipboard-sanitized-write`, top frame of `app://nutflix` only (request AND check handlers); device handler false; downloads prevented; spell-check dictionary downloads off | `main/security.ts` | `security.test.ts` (21 permission names × both handlers, subframe/origin/look-alike cases) |
| privileged `app` + `nf-media` (standard, secure, stream — nothing else); traversal guard; files only from `dist/renderer/` | `main/schemes.ts`, `main/app-protocol.ts` | `app-protocol.test.ts` (`..`, `%2e%2e`, `%2f`, `%5c`, backslash, NUL, hidden, empty segment, unknown extension, wrong host/scheme/user-info, symlink out of the root, tsc output next to the bundle) |
| IPC gate: sender frame (top frame, `app://nutflix`, a webContents main created, not destroyed), method allowlist, L6-0 guards, per-webContents caps (64 calls, 256 subs, 4 grants), SE-1 swap, money gate | `main/ipc-gate.ts` | `ipc-gate.test.ts` (subframe, other origin, `file:`, look-alike host, user-info, null frame, foreign/destroyed webContents; unknown/inherited/excluded methods, bad args, extra keys; raw path; flood; duplicate ids; host down; webContents gone) |
| SE-1 file tokens: grant only for an absolute non-empty path that `lstat`s as a REGULAR file (not symlink/dir/device/FIFO); `nf-file:<32 hex>`; single use; bound to the webContents (a foreign presentation burns it); 10-min TTL; ≤ 16 per webContents; swapped for `{path,name,size}` only on `studio.upload`; the preload refuses a string path before any IPC and asks for a grant only with `webUtils.getPathForFile(file)` (`''` for a page-built `File` → refused) | `main/file-tokens.ts`, `main/ipc-gate.ts`, `preload/bridge.ts` | `file-tokens.test.ts` (real fs: symlink to a file, symlink to `/etc/passwd`, directory, `/dev/null`, FIFO, missing, empty/blank/relative/non-string, reuse, other webContents, expiry, eviction), `ipc-gate.test.ts`, `bridge.test.ts`, chain tests in `transport.test.ts` and `rehydrate.test.ts` |
| money gate before `wallet.melt` / `seeder.melt` / `nutzap` | `main/money-gate.ts` (stub) | `ipc-gate.test.ts` (asked exactly for those three; a refusal is `forbidden` and never reaches the host) |
| main logs nothing identifying | `main/log.ts` | `host-link.test.ts` (strings/paths/URLs/non-`ErrorCode` codes dropped), `main-wiring.test.ts` (every line captured and pattern-checked; no token, link, path) |

### §4 — renderer

- **Bundling** (`scripts/bundle.ts`): renderer → `dist/renderer/app.js` (ESM, browser, minified,
  `process.env.NODE_ENV=production`), preload → `dist/preload.cjs` (CJS, `electron` external),
  `static/index.html`, `@sovit/ui/ui.css` and `src/renderer/shell.css` copied and linked. The script
  FAILS if the renderer bundle contains `packages/core`, nostr-tools, cashu, `@noble`/`@scure`,
  electron or a `node:` builtin, or if the preload bundle contains anything outside
  `src/preload` + `src/ipc`. `bundle.test.ts` runs the real script into a temp dir (outputs are
  exactly the four `APP_FILES` + `preload.cjs`; preload `require`s only `electron`; the page has no
  inline script/style/handler and no remote reference). Renderer bundle ≈ 585 KB (React + `@sovit/ui`).
- **Router** (`router.ts`): history of `{route, extras}` (extras: Search filters, Wallet intent,
  Library `playlistId`, Watch playlist, Watch `resumeSession`), back/forward on Alt+←/→ (not in text
  fields) and mouse buttons 3/4, header buttons. Same route → no push (extras merge), `shorts →
  shorts` replaces, ≤ 100 entries. Screens are keyed by route NAME: Watch is not remounted
  watch → watch, Shorts not shorts → shorts, Studio not across tabs (tested with recording stubs).
- **Chrome**: `Header` (back/forward, brand → Home, search → `search` route, `WalletChip` with
  the total from `wallet.balances()` + `wallet.onChange` balance events and the coordinator's rate,
  avatar → own channel; signed out → "Connect signer" → Settings, and no wallet call at all),
  `Sidebar` (Home, Shorts, Subscriptions, Library, Studio, Wallet, Settings; `aria-current`), one
  shell `ToastStack` fed by Settings' `onToast`.
- **Playback coordinator** (`coordinator.ts`): wraps the adapter once; owners are screen
  INSTANCES (the key set in a layout effect, before any screen effect can call `play()`) or the
  mini-player; a new session and every wrapped `resume()` pause all others (a rendition switch's
  replacement does not pause its predecessor); Watch hand-offs go to the mini-player and close what
  it held; a hand-off whose video differs from the watch route being navigated to (watch → watch
  remount) is closed; Shorts' `onPlaybackStart` pauses the mini; dismiss closes; expand (and
  navigating to the mini's own video) returns an updated `WatchHandoff` as Watch's `resumeSession`;
  after each commit, sessions owned by neither the mounted screen nor the mini are closed; a
  `play()` resolving after its screen unmounted is closed at once; a session it never issued is
  closed on hand-off. `canResume` stops a stale history entry from re-offering a closed session.
- **Theme**: `applyTheme(settings.theme)` when the shell mounts (boot) and on every Settings
  `onSettingsChange`; `hoverPreview` for Home comes from the same settings.
- **Every prop** in `docs/status.md` "Shell contract": see the table at the top of `App.tsx`;
  `shell-props.test.tsx` checks each one with recording stubs (Channel `seedingVideos` present and
  `undefined`, Settings has no `onChangeSigner`, Studio `resolveFile` is identity, `ffmpeg` +
  `onRecheckFfmpeg` from `desktop.ffmpeg`, Wallet `intent`, Search `filters` + `onFiltersChange`
  kept in the history entry and restored by Back, Library `playlistId`, Watch `startAtSec`,
  `onMiniPlayer`, `playlist`, Shorts `onPlaybackStart`, every screen the SAME wrapped adapter).

### §5(b), D4, risk 5 — GREEN (lane E2E-fix, 2026-09-23)

`e2e/stage1.e2e.ts` and the fidelity spike `e2e/fidelity.e2e.ts` (+ `e2e/fidelity/*`) run on
the dev laptop since Cameron installed the AppArmor profile (D4), and each passes 3/3 in a row on
the final build. Lane E2E-fix (`docs/lanes/E2E-fix.md`) lists the eight failures found on the
way: two product bugs (the main → host argv, the dev-fixture boot race) and six suite/tooling
assumptions. Both are `node --test` suites (Node 24 type stripping, no vitest), skipped unless
`NUTFLIX_E2E=1`, and check their prerequisites first (the sandbox check REPORTS; it never works
around).

## Running the Electron suites

Prerequisites (the dev laptop, verified 2026-09-23):

1. **D4 — Chromium's sandbox must be able to start.** Cameron installed
   `/etc/apparmor.d/nutflix-electron`, which grants `userns` (the namespace sandbox under
   `kernel.apparmor_restrict_unprivileged_userns=1`) to
   `…/nutflix/{,.worktrees/*/}node_modules/electron/dist/electron`. Say so with
   `NUTFLIX_E2E_APPARMOR_PROFILE=1` (a profile cannot be detected without root). The alternative,
   per checkout (`npm ci` replaces the file): `sudo chown root:root
   node_modules/electron/dist/chrome-sandbox && sudo chmod 4755
   node_modules/electron/dist/chrome-sandbox`. **Never `--no-sandbox`, never
   `chromiumSandbox: false`, never any sandbox-weakening switch**: main refuses them (exit 78).
2. `node node_modules/electron/install.js` once per checkout (extracts the cached zip).
3. `npm run build` (tsc + `ui.css` + the bundle) after every source change — `tsc -b` is
   incremental, never hand-edit `dist/`. System `ffmpeg` (the fixtures are made per run).
4. **An X11 display.** `DISPLAY` if the shell has one; otherwise the suites discover GNOME's
   Xwayland themselves (`/tmp/.X11-unix/X<n>` owned by you + mutter's
   `/run/user/<uid>/.mutter-Xwaylandauth.*`, whose PATH is passed as `XAUTHORITY` — the cookie is
   never read). That X screen has no monitor (0×0), so the window opens clamped to its minimum size
   and the suites resize it to 1280×800 after launch; nothing appears on the user's screen.

Commands (from the repo root; serially, never alongside `npm run ci` — risk 9):

```
NUTFLIX_E2E=1 NUTFLIX_E2E_APPARMOR_PROFILE=1 node --test packages/app-desktop/e2e/fidelity.e2e.ts  # ≈ 5 s
NUTFLIX_E2E=1 NUTFLIX_E2E_APPARMOR_PROFILE=1 node --test packages/app-desktop/e2e/stage1.e2e.ts    # ≈ 11 s
```

Both at once, serially, from `packages/app-desktop` (≈ 15 s):
`NUTFLIX_E2E=1 NUTFLIX_E2E_APPARMOR_PROFILE=1 node --test --test-concurrency=1 e2e/fidelity.e2e.ts e2e/stage1.e2e.ts`. `NUTFLIX_E2E_LOG=<file>` appends the app's own log lines
(main, host, worker — already redacted) to a file for triage.

What `e2e/support.ts` guarantees on every launch:

- **`chromiumSandbox: true`** — playwright-core's `_electron.launch` otherwise PREPENDS
  `--no-sandbox` on Linux (the first fidelity attempt reported `noSandboxSwitch: true` because of
  it), and then **asserts the sandbox is really on** before any test runs: no bypass switch
  (`no-sandbox`, `disable-gpu-sandbox`, `no-zygote`, `disable-setuid-sandbox`,
  `disable-namespace-sandbox`, `disable-seccomp-filter-sandbox`) in main's command line or argv,
  and the window's renderer has `Seccomp: 2` and its own PID namespace (`NSpid`, both from
  `/proc/<pid>/status`). A regression stops the suite with "the Chromium sandbox is NOT on".
- **Display = X11 only by default.** `--ozone-platform=headless` SEGFAULTS Electron 44.2.0 in the
  main process at `new BrowserWindow` (a null function call; reproduced with a 10-line app, sandbox
  on or off, with or without `--use-angle=swiftshader`/`--disable-gpu`), and
  `--ozone-platform=wayland` hangs before `ready`. Both remain explicit opt-ins for a later
  Electron (`NUTFLIX_E2E_DISPLAY=headless|wayland`); the default never tries them.
- **Fixtures**: 90 s lavfi `testsrc`/`testsrc2` at a forced 2 Mbit/s (CBR x264, `nal-hrd=cbr`,
  keyframe every 2 s, `+faststart`, `ultrafast`: ≈ 2 s each, ≈ 22.5 MB ≈ 343 blocks). The design's
  6 s clip was one 64 KiB block: no second Range, barely a rate, and the video had ended before the
  mini-player steps.

The fidelity run prints `FIDELITY FINDINGS {…}` (below: "Fidelity findings").

## Fidelity findings (first run, 2026-09-23)

Electron 44.2.0 (Chrome 152, Node 24.20.0), sandboxed, GNOME Xwayland `:0`; the output of the last
of three consecutive green runs of `fidelity.e2e.ts` (temp directory name elided):

```json
{
  "rangeRequests": [
    "bytes=0-",
    "bytes=524288-",
    "bytes=917504-",
    "bytes=14974976-"
  ],
  "statuses": [
    206,
    206,
    206,
    206
  ],
  "noSandboxSwitch": false,
  "webPreferences": {
    "allowRunningInsecureContent": false,
    "contextIsolation": true,
    "disableDialogs": false,
    "disablePopups": false,
    "enableBlinkFeatures": "",
    "experimentalFeatures": false,
    "javascript": true,
    "nodeIntegration": false,
    "nodeIntegrationInSubFrames": false,
    "nodeIntegrationInWorker": false,
    "safeDialogs": false,
    "safeDialogsMessage": "",
    "sandbox": true,
    "webSecurity": true,
    "webviewTag": false
  },
  "utility": {
    "esm": true,
    "node": "24.20.0",
    "bare": "ping"
  },
  "page": {
    "mapIsMap": true,
    "mapShape": "[object Map]",
    "mapEntries": [
      [
        "https://mint.example",
        21
      ]
    ],
    "wireMap": {
      "$map": [
        [
          "https://mint.example",
          21
        ]
      ]
    },
    "bytesIsUint8Array": true,
    "errorName": "Error",
    "errorMessage": "no-seeders: nobody is seeding",
    "errorCode": null,
    "sessionSid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sessionPause": "paused",
    "callbackValue": 7,
    "unsubscribe": "unsubscribed",
    "constructedFilePath": "",
    "kinds": {
      "fileIsFile": true,
      "blobIsBlob": true
    },
    "inlineScriptRan": false,
    "hasRequire": "undefined",
    "pickedPath": "/tmp/nf-fidelity-<random>/fixture.mp4",
    "seekedTo": 60.000271,
    "videoWidth": 640
  },
  "launch": {
    "display": "x11 (GNOME Xwayland :0)",
    "sandbox": {
      "bypassSwitches": [],
      "rendererSeccompFilter": true,
      "rendererPidNamespace": true
    }
  }
}
```

- **Maps across `contextBridge`**: a `Map` arrives as a `Map` (`mapIsMap: true`). The shell does not
  rely on it — results stay `$map` on the wire and `rehydrate` rebuilds them (no change needed).
- **Errors**: the message crosses with its `"<code>: "` prefix; the custom `.code` is dropped
  (`errorCode: null`) — which is why `rehydrate.ts` rebuilds `.code` from the prefix.
- **Functions and callbacks**: an object of functions (a PlaySession) and a callback subscription
  are proxied and callable (`sessionPause`, `callbackValue: 7`, `unsubscribe`).
- **`File` as a preload-world instance**: yes — a page `File`/`Blob` is `instanceof` the preload
  world's `File`/`Blob` (`kinds`). The preload's shape check (deviation 11) stays as defence.
- **`webUtils.getPathForFile` in a sandboxed preload**: works — a picked file gives its real path; a
  page-constructed `File` gives `''`, so SE-1's refusal holds.
- **Range seeking via `protocol.handle` + `net.fetch`**: works — every answer is a 206 through
  `nf-media:`, and the seek to 60 s issues its own `bytes=14974976-`. Chromium also re-requests near
  the start by itself (`bytes=524288-`, `bytes=917504-`); the suites no longer count those as the
  seek's request.
- **ESM `utilityProcess`**: starts (`esm: true`, Node 24.20.0).
- **`bare-sidecar` from a `utilityProcess`**: works — Bare echoes `ping` over its IPC pipe.
- **CSP blocks inline script**: yes (`inlineScriptRan: false`); the page has no `require`.
- **Sandbox posture** (checked since E2E-fix): no bypass switch; the renderer runs under a
  seccomp-bpf filter in its own PID namespace; `webPreferences.sandbox: true`.

## Deviations from the design (and why)

1. **`app:` serves an explicit file allowlist** (`APP_FILES`: `index.html`, `app.js`, `ui.css`,
   `shell.css`) on top of the traversal guard and the real-path check: `tsc -b` also emits the
   renderer's modules into `dist/renderer/` (the part configs share `outDir: dist`), and none of them
   should be loadable. Extensions: `.html`/`.js`/`.css` only (no fonts or images are used by `ui.css`).
2. **The mini-player is rendered once at shell level**, not in each screen's `miniPlayer` slot, so its
   `<video>` survives navigation (a slot per screen would remount it and re-fetch on every route).
3. **Screens are keyed by route name** (design said "Watch is not re-keyed"; applied to all: Shorts
   and Studio must not remount either, and a name change is exactly "the mounted screen changed").
4. **Navigating to the mini-player's own video expands it** (router `intercept`), so a card click on
   the playing video re-adopts the session instead of starting a second one.
5. **Toasts**: only Settings has an `onToast` prop in the v4 screens; Library and Studio keep their
   own stacks (they have no prop to hand toasts over). The design's "one ToastStack fed by
   Settings/Library/Studio" needs those props first (screen lanes / orchestrator).
6. **Money gate stub fails closed**: allows only under `--dev-mocks` (mock sats), `forbidden`
   otherwise, so a Stage 2 wallet wired without the dialog cannot silently skip it.
7. **Grant failure codes**: shape problems are `invalid-argument`; a missing or non-regular file is
   `unsupported-input`, which Studio already shows as "Could not open that file".
8. **Range proxy never widens**: a malformed or multi-range `Range` is answered 416 instead of being
   dropped (dropping it would ask the worker for the whole rendition — buffer = money).
9. **A page reload is `wc-gone`**: main posts `wc-gone` on `did-start-navigation` (main frame, new
   document) and on `render-process-gone`, not only on `destroyed`; the same webContents id then
   comes back with a fresh page. After a host respawn main reloads the window so the renderer
   re-subscribes (host restart budget: 3 per minute).
10. **No application menu** on Linux/Windows (no default Reload / Toggle DevTools accelerators); on
    macOS only the app and Edit menus (copy/paste shortcuts).
11. **Preload checks `File`/`Blob` by shape**, not `instanceof` (a page object crossing
    `contextBridge` is not guaranteed to be a preload-world instance; the spike records which);
    `webUtils.getPathForFile` itself rejects non-Files and `''` is refused. Thumbnail bytes are
    re-checked by the guards (≤ 5 MiB, JPEG/PNG/WebP).
12. **The preload strips `undefined`-valued keys** from call arguments (L6-0's `obj` guards treat
    optional keys as absent-only; JavaScript callers routinely write `{ cursor: undefined }`).
13. **The coordinator pauses the page's `<video>` elements when the mini-player resumes** (Watch's
    element-pause handler then pauses its session and shows "Paused — not paying"). Shorts has no
    element-pause handler, so a short paused this way stops paying but its element plays out its
    buffer — cosmetic; noted for the Shorts owner.
14. **`getLastWebPreferences()`** (design §3 e2e) is not in Electron 44's typings; the e2e reaches it
    through a structural cast and asserts it exists.
15. **Cross-project test imports** are dynamic imports by path (main ↔ preload ↔ renderer are
    separate composite TypeScript projects that cannot reference each other, and the tsconfigs are
    outside this lane's allowlist) — same technique as L6-0's tests for `@sovit/ui` sources.
16. **`e2e/tsconfig.json`** (lint-only, `allowImportingTsExtensions`, not referenced by the solution)
    so eslint's project service type-checks the suites.

## What the other L6 lanes must know

**L6-B (host)**

- Entry: main forks **`dist/host/main.js`** (`HOST_ENTRY` in `main/args.ts`) as an ESM
  `utilityProcess` with `serviceName: 'nutflix-host'`, `stdio: 'inherit'` and argv
  `--user-data-dir=<userData>` `--worker-entry=<dist>/worker/entry.js` plus `--dev-mocks` /
  `--dev-fixtures` when main got them — exactly what L6-B's `parseHostArgs` accepts. (It sent
  `--user-data=<userData>` until lane E2E-fix; the host exited 2 on it. `host-link.test.ts` now
  round-trips main's argv through the host's real parser.)
- Every `HostOut` is `isHostOut`-checked; anything else is dropped (logged as a count). Media-link
  tokens must match `[A-Za-z0-9_-]{16,128}` — make them ≥ 128 bits random (the `nf-media:` proxy
  answers any registered token; the token is the only thing between another page and the bytes).
  Send `media-link` BEFORE the reply naming it, and `url: null` on close.
- **Always answer**: `reply` for every call (void → `result: undefined`), `sub-reply` for every
  `sub`/`unsub` (a refused sub → `ok: false`, e.g. `session-closed` for an unknown `sid`). Main
  keeps calls in flight until you answer, the host dies, or the page goes away (no timeouts), and
  at most 64 per webContents.
- `wc-gone` means "that page is gone" — also after a reload, after which the SAME `wc` id sends
  again. Close its sessions, drop its subscriptions.
- `session.close` for an already-closed `sid` may answer `session-closed` or `not-found` — the
  preload treats both as success. `session.switchRendition` closing the old session is fine; Watch
  closes the old one itself afterwards.
- `HostIn.file` (SE-1) is present only on `studio.upload` and is the ONLY path you get; `args[0].file`
  is the (already consumed) token. `name` is `basename(path)`, `size` from `lstat`.
- `image` requests arrive for any id the page asks for — answer `bytes: null` for ids you did not
  mint for that purpose (main answers 404 on `null` and after 30 s).
- Main's money gate sits in front of `wallet.melt`, `seeder.melt`, `nutzap` (allows only under
  `--dev-mocks` in Stage 1).

**L6-C (worker) / L6-B (fixtures)** — `e2e/stage1.e2e.ts` passes its two lavfi fixture MP4s as
`NUTFLIX_DEV_FIXTURES_JSON='[{"path":…,"title":"E2E fixture A","description":…},…]'` to the
Electron process (inherited by host and worker) and expects `--dev-fixtures` to publish them as
playable videos (design §5a `fixture-catalog.ts` + `fixtures-net.ts`). Adjust whichever side when
B and C are merged; the suite is written to be edited then.

**Orchestrator — `package.json` changes this lane needed** (made on main since; E2E-fix asks for
`--test-concurrency=1` in `test:e2e`, see `docs/lanes/E2E-fix.md`)

- `packages/app-desktop/package.json` scripts:
  - `"bundle": "node scripts/bundle.ts"`
  - `"start": "npm run bundle && electron dist/main/main.js --dev-mocks --dev-fixtures"`
  - `"test:e2e": "NUTFLIX_E2E=1 node --test e2e/fidelity.e2e.ts e2e/stage1.e2e.ts"`
- root `package.json`: `"build": "tsc -b && npm run -w packages/ui build:css && npm run -w packages/app-desktop bundle"`
  (the bundle needs `ui.css`, so after `build:css`). `bundle.test.ts` runs the script into a temp
  dir during `npm test` and needs only the `tsc`/`build:css` outputs, which CI's build already makes.
- The `description` of `@sovit/app-desktop` still says "pear-electron shell" (ADR 0003 moved to
  Electron + `pear-runtime`); cosmetic.

## Tests

`@sovit/app-desktop`: **25 files, 687 tests** (L6-0 had 10 files / 422). This lane adds 15 files,
265 tests, all deterministic (manual tick drivers, injected clocks, fake timers for the image
timeout; no sleeps as synchronisation):

| File | Tests | What |
|---|---|---|
| `main/__tests__/ipc-gate.test.ts` | 50 | sender check, shape check, SE-1 swap, caps/flood, money gate (incl. a page gone while the confirmation is pending), events, lifecycle, host error codes — against `FakeHost` |
| `main/__tests__/file-tokens.test.ts` | 18 | SE-1 registry on the real filesystem |
| `main/__tests__/app-protocol.test.ts` | 35 | CSP string; traversal guard; handler on a real directory |
| `main/__tests__/media.test.ts` | 25 | media links; Range proxy; images; URL parsing |
| `main/__tests__/security.test.ts` | 17 | hardening, permissions, session policy, schemes, window options, the security lint |
| `main/__tests__/main-wiring.test.ts` | 11 | `main.ts` against a fake `electron` (order, sandbox refusal, wiring, crash/respawn, quit, log lines) |
| `main/__tests__/host-link.test.ts` | 10 | supervision, logger, argv |
| `main/__tests__/bundle.test.ts` | 6 | the real bundle script into a temp dir; `index.html` |
| `preload/__tests__/bridge.test.ts` | 21 | key-tree allowlist, D3/D5, PlaySession around sid, SE-1 upload, `preload.ts` wiring |
| `preload/__tests__/transport.test.ts` | 10 | transport; preload ⇄ real IPC gate ⇄ FakeHost chain (reads, errors, a session, an upload, a refused symlink) |
| `renderer/__tests__/rehydrate.test.ts` | 13 | `rebuildError` with the real screen classifiers; the whole chain through an emulated `contextBridge`; renderer key tree |
| `renderer/__tests__/coordinator.test.ts` | 16 | the coordinator rules one by one, counted at the mock |
| `renderer/__tests__/shell.test.tsx` | 14 | real screens in jsdom: Watch→Home, expand, own-video expand, stale back entry, Watch→Watch (with and without a mini), Shorts over the mini (both directions), theme at boot and on change, header chip, search/sidebar, back/forward, Studio ffmpeg |
| `renderer/__tests__/shell-props.test.tsx` | 11 | every screen prop, with recording stubs |
| `renderer/__tests__/router.test.ts` | 8 | router rules |

`FakeHost` (`main/__tests__/fake-host.ts`) speaks the real `HostIn`/`HostOut` protocol over
structured clone, re-runs `isHostIn` on everything main posts (no test ever saw a rejection), and
dispatches to `MockNetworkAdapter` (dehydrated results, `toWireError` failures, sids and media
links, session topics, SE-1 uploads with progress, `wc-gone`, images, a ≤ 1-unpaused backstop).
The coordinator/shell suites were mutation-checked: removing "a new session pauses the others", the
post-commit sweep or the watch→watch remount rule each fails at least one test.

`npm run ci` on the branch (after the last code commit): **exit 0** — lint, build, **97 test files,
1717 passed / 27 skipped** repo-wide, check:locked OK, check:native OK (42), lint:electron OK
(81 files, 2 window constructors — the app's and the fidelity spike's — 0 violations).

## Open questions / decisions

1. ~~L6-B host entry path and flags~~ — resolved by lane E2E-fix (main now sends the host's
   spelling; round-trip tested).
2. ~~Dev fixture seam for §5(b)~~ — `NUTFLIX_DEV_FIXTURES_JSON` as merged by L6-C; the host
   catalogue now waits for the worker's first `dev.fixtures` (E2E-fix).
3. **Toasts**: add `onToast` to Library and Studio (screen change) so the shell owns one stack?
4. **Shorts element pause** (deviation 13): should Shorts listen to its element's `pause` like Watch?
5. **Residual SE-1 risk**: a fully compromised RENDERER PROCESS (not page script — context
   isolation stops that) can send `nf:grant-file` with any path it guesses; main still requires a
   regular, non-symlink file and the Publish click happens in the renderer. Stage 2 could move file
   choice to a main-process `dialog.showOpenDialog` for the picker path (drag-and-drop would still
   need `webUtils`).
