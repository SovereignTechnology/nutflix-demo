# Status

Kept current by the orchestrator after every merge (execution plan §5.1).

**If you are picking this up cold: read this file and `docs/security-review.md` first**
(the session handoffs that used to be the resume point were internal notes and are not published). **Stage 2 is DONE on branch `stage-2/2026-09-23` (2026-09-23),
awaiting Cameron's review before anything is pushed or merged:** contracts v5 (ADR 0010), the
five audit-surface modules implemented over cashu-ts / nostr-tools / sodium, all 27
Stage-2-gated tests running, and the PART B review (`docs/security-review.md`, 32 findings —
F1–F4 and F30, the blockers for wiring a real wallet, were fixed on `stage-2/review-fixes`
2026-09-24 with most of the rest — §0 of the review). `LOCKED_DIRS_UNLOCKED=1 npm run ci` on the A.5
commit: **143 files, 2298 passed / 0 skipped**; since the Stage 2 wrap-up commit, plain
`npm run ci` (the guard is now a standing audit-surface check). Stage 1 (DONE 2026-09-23): all
L5 screens, the L6 desktop app, e2e 13/13 with the Chromium sandbox on.
Design: `docs/plan/L6-design.md`; lane reports `docs/lanes/*.md`.

## Stage 0 — scaffold, contracts, spikes: **DONE 2026-09-04**

| Deliverable | State |
|-------------|-------|
| Monorepo scaffold (npm workspaces, TS 6 strict, ESLint type-checked, Vitest, Prettier, `.npmrc` exact-pins + ignore-scripts) | done — `npm run ci` green |
| Lane guards: `scripts/pre-commit` path allowlist, `scripts/check-locked-dirs.sh`, `scripts/check-contracts-version.sh`, `.gitlab/CODEOWNERS`, `scripts/new-lane-worktree.sh` | done |
| CI skeleton | `ci/gitlab-ci.yml` — parked until a runner is registered (README caveat) |
| `docs/vendor/` (75 files) + `MANIFEST.txt` | done — `scripts/vendor-docs.sh` refreshes |
| `SECURITY.md` threat model + invariants + locked dirs | done |
| Contracts | **v4, FROZEN** (ADR 0004, ADR 0007) — Signer, Wallet, PaymentEngine, PayProtocol, NetworkAdapter, Manifest/NIP-71/HyperblobRef, Media |
| Mocks | `MockPaymentEngine` (honest + 6 cheat modes), `MockWallet`, `MockNetworkAdapter` (12 fixture videos, 5 channels, error/latency switches) |
| Spikes | S-A (A4), S-B (A8 PASS), S-C (transcode → subprocess+ffmpeg) — `docs/spikes/` |
| Assumption resolutions | ADR 0003 |
| Prompts | `docs/prompts/{orchestrator,lane,stage-2-security}.md` |
| Lane briefs | `docs/lanes/BRIEFS.md` |

## Stage 1 — parallel lanes: **DONE 2026-09-23**

**Exit evidence (2026-09-23, the dev laptop, merged tree `3f005f4`):**

- **§5(a) two-seeder integration test** (`packages/app-desktop/src/worker/__tests__/two-seeders.integration.test.ts`)
  green in `npm test`: blocks `[0,16)` from S1 and `[16,32)` from S2, viewer spend = Σ spend
  events, each seeder `uploaded == paid`, no bans, downloads ≤ prefetch window, 404 after close.
- **§5(b) Electron e2e** — `NUTFLIX_E2E_APPARMOR_PROFILE=1 npm run -w packages/app-desktop test:e2e`
  (fidelity 5 + stage1 8, serial): **13/13 on 3 consecutive runs, 16.1 s / 14.6 s / 15.1 s** at
  load 3.8–4.6. The app plays a 90 s, 2 Mbit/s fixture served by two in-process seeders on the
  mock engine: price shown before Play; `currentTime > 1`, `videoWidth > 0`; a seek to 50 s
  answered 206 through `nf-media:` with a Range starting near the target; the WalletChip shows
  a sats/min rate; Watch → Home keeps one session playing in the mini-player; Watch → Watch
  leaves exactly one media link; a Markdown `_blank` link opens nothing; no CSP violation.
- **Sandbox proven at runtime, not just configured:** no bypass switch in main's command line
  (`noSandboxSwitch: false`), `webPreferences` literal (`contextIsolation`, `sandbox: true`,
  `nodeIntegration: false`), and the renderer process has a seccomp-bpf filter and its own PID
  namespace. D4 is met by Cameron's AppArmor profile `/etc/apparmor.d/nutflix-electron`
  (grants `userns` to `…/nutflix/{,.worktrees/*/}node_modules/electron/dist/electron` only).
- **Fidelity findings** (risk 5, all answered — `docs/lanes/L6-A.md` "Fidelity findings (first
  run, 2026-09-23)"): Maps cross `contextBridge` as real `Map`s; an Error keeps its
  `"<code>: "` message but loses `.code`; a page `File`/`Blob` arrives as a preload-world
  instance; `webUtils.getPathForFile` works in the sandboxed preload (`''` for a page-built
  File); Range seeking through `protocol.handle` + `net.fetch` works; an ESM `utilityProcess`
  and `bare-sidecar` spawned from it work; the CSP header blocks inline script.
- **The first e2e run found 3 product bugs and 2 harness bugs** (`docs/lanes/E2E-fix.md`): main
  and host disagreed on the host's argv (`--user-data` vs `--user-data-dir` + `--worker-entry`),
  so the host crash-looped — each side's unit tests passed against its own spelling, now a
  round-trip test; the dev-fixture catalogue answered Home before the worker announced its
  fixtures; playwright-core's `_electron.launch` silently ADDS `--no-sandbox` on Linux unless
  `chromiumSandbox: true` (main refused it, correctly); `--ozone-platform=headless` segfaults
  Electron 44.2.0 at `new BrowserWindow` (X11 via GNOME's Xwayland is the default now); the
  6 s lavfi fixtures were a single 64 KiB block.
- Out of scope by decision: the web-portal half (the TS app is Pear/desktop-only, ADR 0006).

`main` is green: **129 test files, 2126 passed / 27 skipped** (`npm run ci`, 2026-09-23, after
the Stage 1 exit lanes). Earlier: 73 files, 1039 passed / 27 skipped after the L5 screens,
contracts v4, UI-fixes and L3-flake. On the dev laptop L8's real-ffmpeg suite ran against the **system**
`/usr/bin/ffmpeg` 6.1.1 (it resolves `NUTFLIX_FFMPEG`, then `/tmp/opencode/ffmpeg/`, then PATH),
not the pinned dev build. On 2026-09-05 the tree reported 651 passed / 27 skipped with an ffmpeg
present and 647 / 31 without one — that suite `skipIf`s when no binary is found; both are green.

> **Skip count.** The 27 are Stage-2-gated by design: 13 BlossomAuth, 10 pay/1 codec, 4
> `it.skipIf(usingMock())` payment tests. The extra 4 skips in an ffmpeg-less environment are
> L8's real-ffmpeg suite (`describe.skipIf`), whose dev binary lives in `/tmp/opencode/ffmpeg/`
> — **`/tmp` gets cleaned, so a fresh session normally starts there.** Restore it with
> `packages/core/src/media/FFMPEG-PIN.md`.
>
> **ffmpeg pin was re-pinned 2026-09-05.** L8's original URL (`autobuild-2026-09-04-14-01`)
> was **404 within a day**: BtbN keeps only ~12 daily autobuild releases plus one month-end
> snapshot per month. The pin is now the month-end `autobuild-2026-08-31-13-27` (same FFmpeg
> revision `n8.1.2-50-g1a748fe2cd`, different build bytes), verified against the release's own
> `checksums.sha256`, the GitHub API asset `digest`, and a passing run of the suite.
>
> **RESOLVED 2026-09-23 (lane L3-flake, `docs/lanes/L3-flake.md`) — it was a real bug.** Old note:
> **Known flake (intermittent, not a regression):** `packages/gateway` →
> `ws-bridge.integration.test.ts` → "a non-paying WS client is cut by the seeder window" times
> out at 20 s under full-suite CPU load — it waits on Hypercore's `REQUEST_TIMEOUT` after a cut
> (L2 documented the same sensitivity). Seen twice, both times with the CPU-heavy real-ffmpeg
> transcodes running concurrently; passes in isolation every time (`npx vitest run --project
> gateway`, ~8 s) and passed on the immediately following full run. **If you hit it, re-run
> before believing it.** A durable fix belongs in that test (raise its timeout or serialise the
> two suites) and is L3's directory, not the orchestrator's.

### Lane table

| Lane | Branch | State | Merge |
|------|--------|-------|-------|
| L9 ci-hardening | `lane/L9` | **merged** (43 tests) | `85ebbb2` |
| L1 nostr-data | `lane/L1` | **merged** (190 tests) | `2cfe533` + wiring `e42aa60` |
| L10 adversary-tests | `lane/L10` | **merged** (66 pass / 25 skip) | `8acd13c` |
| L2 seeder | `lane/L2` | **merged** (100 tests) | `002fce7` (after one revert, see below) |
| L8 transcode | `lane/L8` | **merged** (140 with ffmpeg) | `2cd9dde` + wiring `3cc5830` |
| L3 gateway | `lane/L3` | **merged** (64 pass / 13 skip) | `270a08f` |
| **L2-v3 seeder re-issue** | `lane/L2-v3` | **merged 2026-09-05** (seeder 87 tests) | `503bdf8` |
| **L10-v3 adversary re-issue** | `lane/L10-v3` | **merged 2026-09-05** (+15 pass / +2 skip) | `f58d5f6` |
| **L3-markup** | `lane/L3-markup` | **merged 2026-09-05** (gateway 69 pass / 13 skip) | `28b56ed` |
| **L4 design-system** | `lane/L4` | **merged 2026-09-05** (ui 69 tests, 132 PNGs) | merge + wiring `b71e921` |
| **L5-Home** | `lane/L5-Home` | **merged 2026-09-05** (24 tests, 38 PNGs) | `dfc520d` + wiring `f1c2d37` |
| **L5-Channel** | `lane/L5-Channel` | **merged 2026-09-23** (46 tests, 46 PNGs) | `fb3a00a` + wiring `af560ac` |
| **L5-Settings** | `lane/L5-Settings` | **merged 2026-09-23** (44 tests, 32 PNGs) | `8cdcc0b` + wiring `19a0329` |
| **L5-Library** | `lane/L5-Library` | **merged 2026-09-23** (37 tests, 56 PNGs) | `6720248` + wiring `e91a929` |
| **L5-Watch** | `lane/L5-Watch` | **merged 2026-09-23** (58 tests, 36 PNGs) | `5554c14` + wiring `da491d9` |
| **L5-Shorts** | `lane/L5-Shorts` | **merged 2026-09-23** (33 tests, 36 PNGs) | `4f8cfb7` + wiring `55f9050` |
| **L5-Search** | `lane/L5-Search` | **merged 2026-09-23** (36 tests, 32 PNGs) | `5eaa808` + wiring `b9f2f01` |
| **L5-Wallet** | `lane/L5-Wallet` | **merged 2026-09-23** (55 tests, 54 PNGs) | `2dee7bb` + wiring `611624e` |
| **L5-Studio** | `lane/L5-Studio` | **merged 2026-09-23** (54 tests, 50 PNGs) | `65e1579` + wiring `f2ef017` |
| **UI-fixes** (ADR 0007) | `lane/UI-fixes` | **merged 2026-09-23** (ui 456 → 472 tests, 534 PNGs) | see git log |
| **L3-flake** | `lane/L3-flake` | **merged 2026-09-23** — real bug, not a flake: late WS frames paused a closing socket (30 s stall); cut sockets left `maxConnections` accounting (F1) and a cut mid-stalled-write never started the close (F2). Fixed + 8 deterministic tests; A/B under load 4/10 → 0/10 failures | see git log |
| **L6-0 IPC foundation** | `lane/L6-0` | **merged 2026-09-23** (app-desktop 13 → 422 tests; 49-method table exact against v4) | see git log |
| **L6-B host** | `lane/L6-B` | **merged 2026-09-23** (app-desktop 422 → 674 tests; real `DesktopNetworkAdapter`, SE-4/SE-5, T16 image fetch with DNS-answer checks, 48+12-path conformance vs the mock) | see git log |
| **L6-A shell** | `lane/L6-A` | **merged 2026-09-23** (app-desktop 674 → 687+ tests; Electron main/preload/renderer, IPC gate, SE-1 tokens, playback coordinator; Electron e2e + fidelity spike written; **first run 2026-09-23 via E2E-fix, green**) | see git log |
| **L6-C worker** | `lane/L6-C` | **merged 2026-09-23** (Bare data plane; day-1 probe 20/20 under real `bare`; gated playback server; credit-paced payer; **§5(a) two-seeder Stage 1 test green, ~2.2 s, 5/5 + under load**) | see git log | No worktree on the dev laptop and no cached Electron binary here (`node node_modules/electron/install.js`) | — |
| **UI-followups** | `lane/UI-followups` | **merged 2026-09-23** (Library `onToast` → shell stack, Shorts element-pause stops paying, shell toast actions close their toast; ui 481 tests, app-desktop 1043; repo 2082 passed / 27 skipped) | `a2ea58d` |
| **Seeder-entry** | `lane/Seeder-entry` | **merged 2026-09-23** (daemon entry behind `nutflix-seeder.service`, strict `seeder.json`, Stage 2 seam; seeder 116 tests; repo 128 files, 2111 passed / 27 skipped) | `c68232e` |
| **E2E-fix** (Stage 1 exit) | `lane/E2E-fix` | **merged 2026-09-23** — host argv round-trip (main ↔ host), dev-fixture boot wait, sandboxed X11 launch (`chromiumSandbox: true` + runtime seccomp/PID-namespace checks), 90 s CBR fixtures, seeks past the prefetch window; e2e 13/13 × 3; app-desktop 52 files / 1055 tests | `d0cebfa` |
| L7 web-shell | `lane/L7` | **NOT STARTED** — out of scope if ADR 0006 (unmerged, "Pear-runtime-only v0") is adopted | — |

Lane reports: `docs/lanes/L1.md`, `L2.md` (incl. v3 section), `L3.md` (incl. markup section),
`L4.md`, `L5-{Home,Channel,Settings,Library,Watch,Shorts,Search,Wallet,Studio}.md`, `L8.md`,
`L9.md`, `L10.md` (incl. v3 section). Contract notes: `docs/contract-requests/L5-*.md`.

### Orchestrator actions — Wave 1 (2026-09-04)

- `ec12b7b` pinned runtime deps before fan-out (lanes cannot edit the lockfile).
- Lane allowlists widened minimally where BRIEFS.md's definition of done required it.
- `ced4241` added `.worktrees/**` to the ESLint ignore list (flat config does not read
  `.gitignore`; linting five lane checkouts OOM'd `main`).
- **L2 merge was reverted and reapplied** (`002fce7`): a devDependency changed the shortest
  dependency-chain annotation in `docs/native-modules.txt`, so `check:native` went red. Native
  module SET was unchanged; reviewed and `--accept`ed inside the reapply so `main` never
  carried a red tip.
- Export wiring (orchestrator-owned `index.ts`): `@sovit/core` exports `nostr`, `manifest`,
  `media` + a `./media/node` subpath; `@sovit/app-desktop` exports `transcode`.

### Orchestrator actions — between waves (2026-09-04/05)

- **Contracts v3, `7efcf0f`** — ADR 0004. Additive: `NostrKind.ReleaseNotice = 30071`;
  `hyperUrl` hex grammar documented; **`BlockRange.core?`** + `recordUpload(peer, blocks, core?)`;
  **`PaymentEngineSeeder.rebind(from, to)`**. Fixtures/`MockNetworkAdapter.comment()` emit NIP-22.
- `9b7db9c` pinned gateway deps before L3; native inventory `--accept`ed in the same commit.
- **L3 review before merge:** one finding fixed in-lane (`08779e9`) — `--dev-mocks` now refuses
  to start on a non-loopback `listen.host` (exit 78).

### Orchestrator actions — this session (2026-09-05)

- `f780abb` **design brief recorded** (`docs/design/README.md`) — Cameron: YouTube first,
  Rumble second, "clean experience like these mainstream sites"; light+dark following system.
- `503bdf8` **L2-v3 merged**: per-core `recordUpload`, `rebind` on HELLO bind, core-less PAY
  refused as `malformed` on multi-core streams, per-core policy resolution, lazy `putStream`
  second open, `PeerSession.mux`. **`renderSystemdUnit()` was DELETED** (item 7 decision) —
  `deploy/systemd/` is now the only unit source.
- `f58d5f6` **L10-v3 merged**: T4-across-cores, cheap-price-across-cores, per-core replay,
  `rebind` sum-merge/ban-sticks/sync-callback/idempotent, core shape validation. Two Stage-2
  skips added for things the mock cannot express (below).
- `307e2ac` **chores**: `streamx@2.28.1` pinned as a direct gateway dep;
  `deploy/systemd/README.md` documents `NUTFLIX_GATEWAY_PUBLIC_URL` / `blossom.publicUrl`,
  `http.trustProxy`, proxy requirements, and the seeder unit's missing entry point.
- `1e3326a` **Wave 2 deps pinned + ADR 0005**: electron 44.2.0 (approved), pear-runtime 1.3.1,
  hypercore-blob-server 1.15.0, sodium-javascript 0.8.0, @noble/curves 1.9.7, esbuild 0.28.2,
  playwright-core 1.63.0. Native inventory reviewed 32 → 42 and `--accept`ed in the same commit.
- `28b56ed` **L3-markup merged**: `markupPercent` (ceil) replaces `markupSatsPerBlock`; a config
  still carrying the old key is rejected with a path-only error.
- **L4 merged** + `b71e921` wiring: `@sovit/ui` barrel exports, `./ui.css` / `./tokens.css` /
  `./components.css` subpath exports, `build` emits `dist/*.css`.
- `aa30e8a` + `b21af20` **mocks fix**: `fakeHex64` collided — ~21 000 distinct seeds produced
  only **16** outputs, so channels shared pubkeys (found by L4). Replaced the mixer, pinned it
  with a uniqueness test. Knock-on: L1's `relatedVideos` test asserted 3 related videos, which
  was only true because two channels collided; the assertion now derives from the fixtures.
- `ccafa90` **shared screen contract**: `Route` / `RouteName` / `ScreenProps` in
  `packages/ui/src/screens/shared/` so nine independent L5 lanes cannot invent nine navigation
  shapes. Screens get `adapter` + `navigate`; routing belongs to the shells.
- screenshots script now routes `Screens/*` stories to `artifacts/screens/<screen>/` and prunes
  only directories it wrote to (so a `--filter` run cannot delete another screen's PNGs).
- `dfc520d` **L5-Home merged** + `f1c2d37` wiring (screens barrel, `screens.css` flattened into
  `dist/ui.css`, `./screens.css` export).

### Orchestrator actions — 2026-09-23 (the dev laptop, Claude Code; branch `orch/2026-09-23-l5`)

- **All eight remaining L5 screens merged** (table above). `npm run ci` on the merged tree:
  **72 files, 1014 passed / 27 skipped** (without the dev ffmpeg). Each lane was reviewed
  mechanically (allowlist, locked dirs, no pkg changes, runtime grep, no attribution trailers)
  and CI was re-run on the merged tree after every merge.
- **Incident:** Watch/Channel/Search worktrees held uncommitted 2026-09-20 drafts from a
  then-live opencode session; resume agents were launched into them before that was known, and
  the Channel agent overwrote four draft files. Agents were paused, the originals recovered
  byte-exact from the agent transcript, and the work resumed only after the other session
  closed. Lesson: check for a live session before touching uncommitted worktree files.
- **The drafts had real money-path bugs** that the lanes fixed with tests: Watch priced the
  cheapest rendition but `play()` defaulted to 1080p (price shown ≠ price charged), never called
  `<video>.play()/pause()`, and wiped the resume point on exit; Search re-ran `adapter.search`
  on every re-render (clock in the effect deps) and could append a stale query's page 2.
- `684faa4` **dep pin: `uqr@0.1.3`** in `@sovit/ui` (Wallet's LN invoice QR). Zero deps, no
  install scripts, tarball audited, integrity verified, native inventory unchanged (42). Only
  `encode()` (boolean matrix → React `<rect>`s) may be used; `renderSVG()` output never.
  **The QR has not been scanned with a phone yet** — scan `artifacts/screens/wallet/Wallet--fund-invoice--dark.png`
  (in the L5-Wallet worktree) once.
- `8be6353` fixture comment fix (`FIXTURE_NOW` is 15:33:20Z). `6911d98` **ADR 0005 erratum**
  (see Inputs — OPEN).
- Screen barrel now also exports `WalletChip` (header chip for the shell) and Studio's shell
  types `FfmpegStatus`, `ResolveUploadFile`, `StudioFile`.

### Shell contract the screens expect (L6 must honour)

**Security requirements first — `docs/reviews/2026-09-23-pre-push-l5-v4.md` SE-1…SE-5:** Studio
uploads take an opaque main-minted file token, never a renderer-supplied path (SE-1, High); one
app-wide playback coordinator owns every `PlaySession` — at most one paying, hand-offs adopted
or closed, never leaked (SE-2/SE-3); `autoTopUp.belowSats <= 0` means disabled (SE-4);
`unreact` = NIP-09 deletion of the viewer's own reaction ids, never a `-` (SE-5).

- **Watch mini-player:** `onMiniPlayer(session, videoId, handoff)` transfers ownership of a live
  `PlaySession` to the shell (it must `close()` it on dismiss); hand it back via
  `resumeSession`. Watch also hands off on unmount while live — a shell that remounts Watch
  video→video is handed the old session and must close it. Details: `docs/lanes/L5-Watch.md`.
- **Shorts** `onPlaybackStart(videoId)` — the shell must pause the mini-player's session, or two
  streams bill at once.
- **Settings** `onChangeSigner?`, `onToast?`, `onSettingsChange(s)`; the shell applies
  `settings().theme` at boot and on every change (screens never touch `document`).
  Name clash: component `Settings` vs core type `Settings` — alias one in the shell.
- **Studio:** `resolveFile(file)` maps a DOM `File` to a path on desktop
  (`webUtils.getPathForFile`); `ffmpeg={found,path?,version?,os?}` + `onRecheckFfmpeg` from the
  shell's system-ffmpeg probe; keep Studio mounted across `studio` tab routes or a running
  upload's progress view is lost. An Electron IPC hop drops `error.code`; Studio falls back to
  matching the ENOENT message.
- **Wallet** `intent` prop (fund/withdraw deep link); `WalletChip` in the header.
- **Channel** `seedingVideos?` (from a kind-10019 lookup); **Search** `filters` +
  `onFiltersChange`; **Library** own `ToastStack` (→ `onToast` if the shell owns toasts).

### Contract-change requests for v5 — DECIDED (CONTRACTS_VERSION = 5, ADR 0010)

**Every item below was decided in ADR 0010 §1 (Stage 2 PART 0; item 4 in PART A step 5,
ADR 0010 §8).** Kept as the record of what was asked. v4 (2026-09-23) was a small additive
bump: reactions (`likes`/`dislikes`/`myReaction`, `unreact`). The list as recorded for v5:

1. `BlockRange.core` and `recordUpload`'s `core` become **required** (ADR 0004).
2. **`PRICE` carries no core** — per-core prices need it (L3 observation).
3. **Per-PAY split becomes contract text** — ADR 0007 (minimum PAY + creator carry), replacing
   ADR 0005 Q1's bare `ceil`.
4. BUD-09 reports reach `BlossomAuth` as a synthetic `Nostr <base64(kind-1984)>` header under
   verb `report`; Stage 2 may prefer a second method on the interface.
5. **From the L5 lanes (2026-09-23), all non-blocking, worked around with screen props** — full
   text in `docs/contract-requests/L5-*.md`: signer connect/disconnect/lock/`onSigner`
   (Settings); `updateSettings` cannot clear `autoTopUp` under `exactOptionalPropertyTypes`
   (Settings + Wallet write `belowSats: 0` = off — **the auto-top-up implementation must treat 0
   as disabled**); `unreact(videoId)` (un-like currently sends a NIP-25 `-` dislike — Watch and
   Shorts); `seederAnnouncement(pubkey)` (Channel); `searchChannels`, `AbortSignal`/`limit` on
   `search` (Search); upload abort signal, `chooseThumbnail` callback, `{url, sha256}` thumbnail
   candidates (today bare paths, not hash-checked), error code on the `error` progress stage,
   `studio.ffmpeg()` + `Settings.ffmpegPath`, `firstPaidAt` (Studio); `pendingMintQuotes()` —
   an unpaid invoice is forgotten when the fund sheet closes (Wallet); per-video resume lookup,
   `nostr:` ref → profile resolution, throughput for Auto quality, session-closed flag (Watch).
6. **From L6-B (`docs/contract-requests/L6-B.md`):** `NostrKind.Deletion = 5`;
   `VideoStats.seedersOnline` must be able to say "unknown" (the host reports 0 on real relays in
   Stage 1, so Watch/Shorts block Play there — plus a worker request that counts a core's
   seeders); `SignerStatus` "none"; which balance `autoTopUp` compares; `satsByRendition` source;
   upload abort (`studio.cancel`). L1: reaction/comment-like counts ignore NIP-09 deletions (the
   host filters them); `trendingFeed` has no kinds filter; NIP-05 fetch policy.
7. **From L6-C (`docs/contract-requests/L6-C.md`) — money-path bugs in the MOCK, worked around
   by a dev-only `DevEngine`:** `MockPaymentEngine` treats a block index as a count (a seeder
   serving a non-prefix set can never be paid — breaks seeking and multi-seeder), and two mock
   wallets mint identical secrets (false double-spend ban). v5: `recordUpload` carries the block
   index (or the count rule is written down) and the mock is fixed; each mock wallet gets its own
   secret namespace. pay/1: `core` in ACK/PRICE, `windowBlocks` in HELLO (credit window 4 caps a
   viewer at ~2.6 MB/s over 100 ms RTT). Worker protocol: a `shutdown` request (bare-sidecar
   `end()` never reaches the child). Seeder: loopback-bindable swarm + per-session hook, runtime
   disk-cap setter. Packaging: a bundled worker needs an unbundled boot module importing
   `bare-encoding/global` first (bundlers hoist externals). **L10's adversary suite runs against
   the mock — re-check its expectations when the mock is fixed.**
8. **`UploadInput.file` doc** says "Desktop: absolute path", but under SE-1 the desktop shell
   passes a main-minted file token across IPC (L6-0) — fix the contract text at v5.
9. **`Route` changes (orchestrator-owned `screens/shared/route.ts`, not contracts):** `library`
   gets `playlist?`, `watch` gets a playlist/list param, `search` gets filters, `studio` gets
   `videoId`, `wallet` gets an intent.

### Follow-ups owed by the orchestrator

1. **The wave-2 handoff (an internal session note, not published) §4.4 is stale** where it describes the flat
   `markupSatsPerBlock`; ADR 0005 supersedes it. (This file is correct.)
2. **`types/holepunch.d.ts` exists in three diverged copies** (seeder, gateway, and since L6-C
   the desktop worker's `src/worker/types/holepunch.d.ts`, a superset of the other two) — the
   gateway's adds `userData`/`end()`, the seeder's adds `hyperdht` and more doc comments. Deduping needs a shared ambient-types package (`declare module` blocks are not
   emitted by `tsc` and cannot be re-exported), which is more than the "only if trivial" the
   brief allowed. **Left as is, deliberately** (re-checked 2026-09-23 with the third copy: still
   not cheap — a shared ambient-types workspace package means a `package.json` + lockfile change
   and a tsconfig reference in three packages, for types that only ever widen).
3. **DONE 2026-09-23 (UI-fixes).** ~~**L4 `VideoCardSkeleton` bug** (found by L5-Home): `.nf-card__text` has no `flex-grow`, so
   skeleton text lines render at 0 px. L5-Home works around it in `Home.css`; the rule belongs
   in `VideoCard.css`. Fix in the next lane that touches `packages/ui/src/components/`.~~
4. **Each L5 merge needs two wiring lines** from the orchestrator: the export in
   `packages/ui/src/screens/index.ts` and the `@import` in `packages/ui/src/screens/screens.css`.
5. **DONE 2026-09-23 (lane Seeder-entry, `docs/lanes/Seeder-entry.md`).** `dist/index.js` is now
   the daemon entry when it is the main module (`cli/main.ts`: `--config`, `--check`, exit
   0/1/78; strict `seeder.json`, errors name paths never values; key material refused in
   config). It refuses with 78 until Stage 2 providers exist (`cli/providers.ts`); `--check`
   works today. **Found on the way:** `--jitless` removes WebAssembly and Node 22's undici needs
   it on the first touch of the global `WebSocket` (nostr-tools, via `@sovit/core`) — the seeder
   unit gained `--no-experimental-websocket` (a spawn test guards it; `MDWE-RESULTS.md` §6).
   **Still open — the GATEWAY unit is broken the same way on Node 22** and a flag alone does not
   fix it (its ESM `import … from 'node:http'` also loads undici): `node --jitless
   --no-experimental-websocket packages/gateway/dist/index.js --check` dies on Node 22 and
   works on Node 24. Owner L3 (Stage 3 deploy): load `http` via `createRequire` + the flag +
   the `ExecStart` pin in `cli.test.ts`, or require Node ≥ 24 on hosts, or drop the MDWE +
   `--jitless` pair. Also: converge the seeder's and the gateway's config validators (table in
   the lane doc §2); `--check` does not report missing providers (a real start still refuses).
6. **DONE 2026-09-23 (UI-fixes)** except the text-field component (still none). ~~**L4 component fixes owed** (hit by 4 lanes, each worked around in its own CSS): list-layout
   `.nf-card__body` also needs `flex-grow` (item 3 is one level of it); `VideoCardSkeleton` needs
   a `hideChannel` option; `Sheet` focuses Close first; **a11y bug: `VideoCard`'s thumbnail
   button has `aria-label={title}`, so screen readers never hear the `SatsBadge` price** (put the
   price in the label); no text-field component; missing icons (lock, clock, thumbs-up, comment,
   share, playlist).~~
7. **DONE 2026-09-23 (UI-fixes)** — Playwright-Chromium fallback, per-file prune, 10 s image wait. ~~**`scripts/screenshots.ts`:** a partial `--filter` deletes the other PNGs in that screen's
   folder (prune per file, not per directory); it waits with no timeout for every lazy thumbnail
   and hangs on long pages; its default Chromium path does not exist on latitude — lanes used
   `NUTFLIX_CHROMIUM=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`.~~
8. **DONE 2026-09-23 (lane L3-flake): a real bug, not a flaky test** — `ws-duplex.ts` paused an already-closing socket on late frames (30 s stall); cut sockets are now tracked until their own close and terminated after `WS_CLOSE_GRACE_MS` = 5 s. Still load-sensitive: the seeder's "cut inside `upload` leaves EXACTLY windowBlocks" test (hit once at load ~20, green in isolation). Original note: **The gateway `ws-bridge` "non-paying WS client is cut" flake is now frequent** (≥ 5 hits
   this session at load 6–8; always green on re-run). Needs the durable fix in that test
   (L3's directory): raise its timeout or serialise it against the ffmpeg/Storybook load.
9. **DONE 2026-09-23 (lane UI-followups, `docs/lanes/UI-followups.md`)** except the SE-1
   residual. Library takes `onToast` (shell stack; late outcomes and their Undo/Retry still work
   after unmount); Studio unchanged on purpose — it raises no toasts, every notice is in-place
   state; Shorts pauses its session when its `<video>` pauses on its own (PiP, media keys, OS,
   the coordinator) and resumes on an outside `play` while paused, never after `ended`; the
   shell's `pushToast` wraps toast actions (dismiss, then run once — this also fixes Settings'
   Retry toast, which never closed). The fixture seam `NUTFLIX_DEV_FIXTURES_JSON` was confirmed
   by L6-C. **Still open:** residual SE-1 risk — a compromised renderer *process* can request a
   token for any regular file it can name → pick upload files via a main-process `dialog`
   (outside the five Stage 2 directories, so filed as `docs/security-review.md` F7 for
   Stage 3). **New, from UI-followups (Stage 3 polish):** Watch, Wallet and Shorts still render
   their own `ToastStack`, fixed bottom-left like the shell's, so two stacks can overlap — a
   true single stack needs `onToast` on those three; repeated identical Settings failures stack
   instead of replacing (a `replaceKey` on `ToastItem`, `packages/ui/src/components/`); a
   media-key `play` after a short or video has ended does not resume paying (Replay stays
   explicit — Watch and Shorts agree). L6-A deviation 13 was imprecise: the coordinator already
   paused the short's element; the real gap was an outside pause leaving the session paying.
10. Worktrees of merged lanes (`L5-*`) are archaeology — remove when convenient (branches stay);
   the PNGs live only in them (gitignored).

### Findings to act on (non-contract, orchestrator-owned)

- **Two Stage-2 skips L10-v3 could not express against the mock** (full bodies, `skipIf`):
  (a) a core-less PAY on a multi-core stream → `malformed` — the mock has no notion of "cores
  this stream replicates" (the **seeder** enforces it, and L2-v3 has a real test); (b) a PAY
  naming a core with **no** recorded uploads → `range-not-uploaded` — the mock's per-core check
  only engages for cores that have an upload count, which matches ADR 0004's interim wording.
- **Mock vs SECURITY.md (L10):** the mock's P2PK check is envelope-only and never checks `C`;
  T6/T7 stay `skipIf(usingMock())`. A rejected cheat does not ban in the mock (SECURITY.md only
  mandates bans for T3/T5).
- **MDWE (L9, L2):** Node 22's default JIT aborts under `MemoryDenyWriteExecute`; `--jitless`
  works at ~1.66× cost on secp256k1 verify. `RestrictAddressFamilies` needs **`AF_NETLINK`**.
- **Provenance (L9):** `hyperswarm@4.17.0` and `nostr-tools@2.25.2` publish no npm provenance.
- **L1:** `nostr-tools` `verifyEvent({...verified, content:'evil'})` returns **true** (spread
  copies the cached verified symbol); every consumer must go through `verifyIncoming`.
- **L2:** over real hyperswarm the viewer ends with **≤ window** (transport drops bytes on
  destroy); exact-`window` holds on piped replication streams.
- **L3:** `--dev-mocks` is the one flag-gated import of core mocks on a runtime path
  (loopback-fenced, loud warn). Delete `cli/dev-mocks.ts` + the branch in `cli/main.ts` if
  unwanted.
- **L5-Home judgement calls** to accept or reject: kind-22 items in a feed page render as a
  horizontal "Shorts" shelf below the grid (YouTube's own answer to 9:16 cards breaking the
  grid); `followedTags` is a screen prop, not a contract method; signed-out visitors land on
  Trending.

### Inputs from Cameron — ALL ANSWERED 2026-09-05 (ADR 0005)

| Question | Answer |
|---|---|
| Frontend design reference (L4) | Written brief: YouTube first, Rumble second, "clean like these mainstream sites". No files. `docs/design/README.md` |
| L4 theme | Light + dark, follow system, toggle in Settings |
| Q1 window + rounding | Keep `windowBlocks = 4`; **round the seeder share UP** (`ceil`), creator takes the remainder |
| Q2 mints per video | **Several** (unchanged) |
| Q4 gateway markup | **Percentage** (`markupPercent`, ceil), not flat — implemented in `28b56ed` |
| Q8 gateway transcode of web uploads | **Stage 3**, not Stage 1/2 |
| Shipped `ffmpeg` | **No** — require a system ffmpeg; Studio shows an "ffmpeg not found" state |
| L3 Blossom defaults | All four confirmed as built (unauthenticated `/list`, `/mirror` off, `DELETE` 405, `--dev-mocks` kept) |
| Electron pin | **Approved** — `electron@44.2.0` devDep of app-desktop |

### ADR numbering — reserved numbers (Cameron, 2026-09-23)

**0006 = NFX suite** (on the unmerged `spec/nfx-suite-m0`), **0008 = nfx master plan** (written in
`~/Projects/nfx`, forked from `spec/nfx-suite-m0`). This repo never uses either number, so a later
merge between the two histories cannot produce two ADRs with one number. **The next ADR here is
0014.** Taken so far: 0001–0005, 0007, 0009, 0010, 0011, 0012, 0013.

### Inputs from Cameron — ANSWERED 2026-09-23 (ADR 0007)

| Question | Answer |
|---|---|
| Creator share at small PAYs (ADR 0005 erratum) | **Minimum PAY size + carry the creator's fractional remainder** across PAYs. Design and proposed parameters (`minPaySats` 10, window ≥ one min PAY) in ADR 0007; implemented in Stage 2 (contracts v5) — **the minimum is a batching target, not a rejection** (ADR 0010 §3.3 amendment; an enforced minimum deadlocks multi-seeder viewers) |
| Home card price vs Watch | **Default rendition's price** on every card (no "from") — L4-fixes |
| Un-like / dislikes | **Always show dislikes.** Contracts v4: `VideoStats.likes/dislikes/myReaction`, `unreact()` (NIP-09) so un-like is never a `-` — L5-fixes |
| Library privacy copy | **Watch later is encrypted; playlists can be public or private** — L5-fixes |
| Pear direction / nutflix-2f | **Ignore it here; continue the plan** (L6 = Electron + `pear-runtime` Bare worker, ADR 0003) |

### Inputs from Cameron — ANSWERED 2026-09-23 (ADR 0009)

| Question | Answer |
|---|---|
| First-run relays (the host ships damus, nos.lol, primal; a fresh install contacts them) | **Keep the three defaults** — works out of the box; the privacy cost is accepted for v0 and revisited in Stage 3 (ADR 0009) |

**Cameron, 2026-09-23:** `stage-1` tagged (on `1b0b4d9`, pushed to origin and the backup mirror); **Stage 2
approved to start now in a fresh session** per `docs/prompts/stage-2-security.md`. Still open:
one phone scan of the Wallet QR (pass = decodes to text starting `lnbc5000n1pj9x7`) — **passed 2026-09-24**. `spec/nfx-suite-m0` (ADR 0006) stays unmerged.

## Stage 2 — audit surface (single session): DONE 2026-09-23, awaiting review

Prompt: `docs/prompts/stage-2-security.md`. One session (Opus 5.5 high, Cameron's choice), one
worktree (`.worktrees/stage-2`), no subagents. One branch per deliverable, all stacked on
`stage-2/2026-09-23` (off `stage-1`); **nothing pushed** — Cameron reviews first.

| Deliverable | Commit | Branch | What |
|---|---|---|---|
| PART 0 | `be228a2` | `stage-2/part0-contracts-v5` | Contracts v5 + mock fixes (ADR 0010), consumers adapted |
| A.1 signer | `0b91d2d` | `stage-2/a1-signer` | Key file (argon2id + XChaCha20-Poly1305), `LocalSigner`, NIP-46/NIP-07 adoption, `SignerManager` |
| A.2 wallet | `0ece03a` | `stage-2/a2-wallet` | `spend.ts` over cashu-ts (P2PK send with post-checks, receive, melt, mint, NUT-07 reconcile), NIP-60 store, `TestMint` |
| A.3 payment | `17d636a` | `stage-2/a3-payment` | `RealPaymentEngine`: offline verify, windows, bans, flush, carry-aware viewer; the whole L10 suite over real ecash |
| A.4 pay/1 | `39cdaeb` | `stage-2/a4-pay-protocol` | Codec, connection-bound HELLO, `PayChannel` on protomux; real replication integration test |
| A.5 gateway auth | `f398f9f` | `stage-2/a5-gateway-auth` | `BlossomAuthImpl` (kind 24242 + BUD-09 report), ADR 0010 §8 |
| PART B | `bc12485` | `stage-2/part-b-security-review` | `docs/security-review.md` (F30–F32 and the review fixes added in the wrap-up) |
| Wrap-up | `26b7a8c` | `stage-2/2026-09-23` | Pre-push differential + sharp-edges review and its fixes, standing audit-surface guard, status, handoff |
| Review fixes | (this commit) | `stage-2/review-fixes` | Cameron asked for the fixes (2026-09-24): F1–F4, F7–F9, F11–F16, F19, F20, F22, F23, F30, F31 fixed, F5/F18/F26 partly — `docs/security-review.md` §0 |

Test counts: all 27 Stage-2-gated tests run (13 BlossomAuth, 10 pay/1 codec fuzz, 4
`skipIf(usingMock())`); adversary cases added after every module, each with why it was missed.

**For Cameron:** (1) ADR 0010 §3.3 amends ADR 0007 — the minimum PAY is a batching target,
not a rejection (an enforced minimum deadlocks multi-seeder viewers); revisit if you disagree.
(2) The `pay1` creator-set tag is verified only against the in-process `TestMint` — Stage 3
must run it against nutshell/cdk (F6). (3) Approve filing the `docs/security-review.md` §6
issues on GitLab and pushing the branches. (4) From Stage 1: the phone scan of the Wallet QR —
**passed 2026-09-24** (it decodes to text starting `lnbc5000n1pj9x7`).

## Stage 3 — integration and polish: STARTED 2026-09-24

| Lane | Branch | Status |
|---|---|---|
| Real-mint testing (execution plan §4) | `stage-3/real-mint` (on `stage-2/review-fixes`) | **done** — Nutshell 0.21.0 and cdk-mintd 0.18.1 (FakeWallet, 100 ppk fee): the `pay1` tag verified (F6), three seeders + viewer, double-spends, a network drop; fixed what it found (F34 dust → batched redeems and nutzaps, F35 stale-channel PAYs, F27 superseded sessions, F31 replay-after-restart); open: F33 duplicate deliveries (decision). `scripts/real-mint/README.md` |
| Seeder daemon runtime (build plan Phase 3) | `stage-3/seeder-runtime` (on `stage-3/real-mint`) | **done** — `nutflix-seeder.service` runs for real (ADR 0011): key file + `seeder-key-passphrase` systemd credential (`--keygen` from stdin), 0600 wallet file, the real engine with every hook (pending PAYs and seen secrets on disk, rate-limited keysets, NUT-07), NIP-61 nutzaps + kind 10019 over a `ws` relay pool, `pay/1` + HELLO on swarm sessions (`Seeder.onSessionReady`), one daemon per data dir. F10, F12, F24 (daemon) done; F11/F31 wired. Found and fixed **F36**: Node 22's global `fetch` crashes a `--jitless` daemon at the first mint request — mint requests now go over `node:http(s)` (`wallet.cashuRequestFn`), verified under the unit flags against Nutshell. |
| Seeder payout + wallet encryption (ADR 0011 §2, §7) | `stage-3/seeder-payout` (on `stage-3/seeder-runtime`) | **done** — Cameron's answers 2026-09-24 (ADR 0011 §8): the wallet file is NIP-44 sealed to the node key (chunked, tamper-evident; plaintext files resealed at open); earnings leave as a NIP-61 nutzap locked to the owner's wallet key above `payout.thresholdSats`, only after the owner's own kind 10019 confirms the key; failed publishes retried from `payouts.jsonl`. Melt on the server dropped (the owner melts from their wallet); no NIP-60 on the server; paid views → sats per video (UI polish lane) |
| Gateway runtime (ADR 0011 §9) | `stage-3/gateway-runtime` (on `stage-3/seeder-payout`) | **done** — the gateway runs on the seeder's runtime (`createNodeRuntime`): key file + `gateway-key-passphrase` credential, identity checked against the key file (`--keygen` prints it), sealed wallet shared by the seeder-side and upstream engines, `BlossomAuthImpl` on the public host, nutzaps, payout. Fixed **F38**: the gateway never paid upstream swarm peers (pay/1 attached before the Protomux existed). Open F37 (latent: nothing in the gateway fetches upstream on its own yet): `openUpstreamCore` does not pace to the unpaid window — required before upstream fetching is wired |
| Desktop money plane (ADR 0012) | `stage-3/desktop-runtime` (on `stage-3/gateway-runtime`) | **done** — the host spends, the worker asks: the host's money plane holds the user's NIP-60 wallet (kind 17375 key, never created by accident — fixed a startup path that would have replaced it on a relay outage) and the viewer engine, and authorises every worker request (a PAY only for a host-registered session's core, range, manifest terms and budget; HELLO signatures only over a pay/1 challenge; seller hooks only at own mints); the worker runs the seeder engine with host-backed hooks and per-core `PRICE` announcements. Tested end to end over hyperswarm against a seeder daemon. |
| Desktop signer (ADR 0013) | `stage-3/desktop-signer` (on `stage-3/desktop-runtime`) | **done** — Cameron's choice 2026-09-24: the user picks how the key unlocks — a passphrase typed in main's trusted prompt window at each launch, the OS keychain (`safeStorage`; never Linux `basic_text`), or a NIP-46 bunker ("remember" seals the session in the keychain; core `resumeBunker`). The renderer names a kind only; every secret and choice is typed in the prompt window — its own origin `app://prompt`, its own sandboxed process and two-call preload, data-only questions, answers that must fit (checked in main and the host). Key file 0600/0700 (F24 desktop half). Every signer change swaps the money plane with the worker restarted around it; a new key gets a wallet at once, an existing identity is asked (default Not now). Header Unlock / Lock / Sign out (native confirm). Review fixed F39 (bunker `auth_url` to the console), a prompt throttle, pool disposal. Addendum (§7): "remove this key" (a forgotten passphrase) and NIP-46 approval links (real host shown, main opens on click). Electron e2e `e2e/signer.e2e.ts` |
| DLEQ off the event loop (F5, ADR 0011 §10) | `stage-3/dleq-batching` (on `stage-3/desktop-signer`) | **done** — the seeder daemon and the gateway check a PAY's DLEQ proofs on a `worker_threads` pool (core `PaymentEngineDeps.dleq`, one call per PAY, every other check re-run on the answers; any worker failure falls back to the synchronous check, never to acceptance); proven under the unit's `--jitless` flags. Explicit `minPaySats` batching moves to the F37 lane (same mechanism: the credit pool in the shared payer) |
| Upstream credit + batching (F37, F5, ADR 0011 §11) | `stage-3/upstream-credit` (on `stage-3/dleq-batching`) | **done** — the credit pool and ACK settlement moved into the shared `@sovit/gateway/upstream` (`CreditPool` with a pressure signal, `CreditSettler`); `UpstreamPayer` batches to half the pool per seeder, pays everything under pressure and short tails after 2 s; the gateway reads upstream through `readUpstreamBlob` on credit (`upstream.creditBlocks`) — the full-speed swarm test stays inside the window and fails with pacing off. The desktop's `ViewerPayer` runs on the same pieces |
| Pending-PAY journal + cap (ADR 0011 §12) | `stage-3/pending-journal` (on `stage-3/upstream-credit`) | **done** — accepted PAYs go to an append-only, self-compacting `pending.jsonl` (fsynced before the ACK; torn tail tolerated, other damage refuses; old `pending.json` migrated) instead of a whole-file rewrite per change; at `maxPendingPays` (4096) queued PAYs the daemon and the gateway stop serving (local cut, no ban) until a flush drains the queue |
| Upload quota (F15) | `stage-3/upload-quota` (on `stage-3/pending-journal`) | **done** — `blossom.maxBytesPerPubkey` (default 8 GiB, `null` = none): the bytes a pubkey owns on the gateway (uploaded, mirrored, or claimed by re-uploading), enforced on `PUT /upload`, `PUT /mirror` and authenticated `HEAD /upload`; a declared body is refused before it is spooled, and concurrent uploads hold their bytes. The default is Cameron's to change (with the pending allow-list-only decision) — **2 GiB since 2026-09-25** (`stage-3/pear-only`) |
| NUT-20 quotes (F17) | `stage-3/nut20-quotes` (on `stage-3/upload-quota`) | **done** — mint quotes are locked to the wallet key where the mint advertises NUT-20 and the key is in the process (the NIP-60 wallet), and the mint request is signed (amended message, legacy fallback — both via cashu-ts); an answer locked to another key is refused. Proven on Nutshell 0.21.0 and cdk-mintd 0.18.1. Quote ids no longer reach the desktop renderer: it gets opaque handles, scoped to the wallet that issued them (a signer change forgets them) |
| Wallet journal (F31, ADR 0014) | `stage-3/wallet-journal` (on `stage-3/nut20-quotes`) | **done** — a mint answer lost after the mint executed no longer loses money: sends, receives and top-ups journal their outputs in the store before the request and restore what the mint signed with NUT-09 (a lost send still returns its locked set; a lost redeem is a success on the same call — no ban, creator paid, earnings kept). Retries reuse the journaled outputs; an unresolved send's inputs stay out of new selections. The daemon's and gateway's journal is in the sealed wallet file (survives a crash; swept at startup); the desktop's is in memory. Chosen over the review's NUT-13 suggestion (no new secret, safe for a multi-device NIP-60 wallet); NUT-13 seed backup is Cameron's call. Proven on Nutshell 0.21.0 and cdk-mintd 0.18.1 |
| Packaged builds refuse dev flags (F21, part) | `stage-3/f21-dev-flags` (on `stage-3/wallet-journal`) | **done** — `app.isPackaged` + `--dev-mocks` / `--dev-fixtures` / `--e2e-hooks` exits 78 before anything is registered. The fuses wait for the packaging lane (they are set on the packaged binary) |
| External links (F25) | `stage-3/external-links` (on `stage-3/f21-dev-flags`) | **done** — a link clicked in the app (Markdown `_blank`) is denied as a window-open, then main asks in its trusted prompt window, which shows the real host (IDNA ASCII) and a warning that link text may lie; main opens its own copy only on "Open in browser". `https:` only, app webContents only, one question at a time, ≤ 5/min (ADR 0013 §8). Electron e2e updated: the click shows `example.com`, Cancel opens nothing |
| Worker pending-PAY journal (ADR 0011 §12) | `stage-3/worker-journal` (on `stage-3/external-links`) | **done** — the journal's logic is now runtime-neutral (`PendingJournalCore` in the seeder's portable entry). The daemon keeps its behaviour, and the desktop's Bare worker uses it for `payments/pending.jsonl` (append + fsync before the ACK, compaction, the old `pending.json` migrated, an unreadable journal keeps payments off). The worker stops serving at 1024 queued PAYs until a flush drains them |
| NIP-71 `minpay` (ADR 0010 §3.2 amendment) | `stage-3/manifest-minpay` (on `stage-3/worker-journal`) | **done** — the manifest builder emits and the parser reads `minpay` (1 … 1 000 000 sat, else `bad-price`), so a creator can raise the batching target. The minimum's contribution to the unpaid window is capped at 64 blocks (`MAX_MIN_PAY_WINDOW_BLOCKS`): an untrusted tag cannot open huge unpaid windows. Found on the way: the desktop's exact-key IPC guards would have refused every manifest carrying it (fixed: `minPaySats` optional, bounded) |
| Pear-only media (issue #4) | `stage-3/pear-only` (on `stage-3/manifest-minpay`) | **done** — contracts **v6**: `UploadInput.mirrorTo` and the `mirroring` stage are gone. Studio has no Mirrors field or step; the host names no Blossom server in the manifests it signs; the IPC guards refuse a mirror list. Other publishers' `blossom` / `fallback` tags are still parsed and never fetched. The gateway's Blossom endpoints stay (an HTTP face over its Pear seeder); per-pubkey quota default 2 GiB. Studio's mirroring had never been executed on the desktop: it only wrote the listed servers into the manifest, claiming copies that did not exist |
| Image privacy (F18, issue #5 part a) | `stage-3/image-privacy` (on `stage-3/pear-only`) | **done** — `Settings.loadRemoteImages` (contracts v6, default **off**): the desktop host refuses an image without a signed sha256 before any request, and the UI keeps its placeholder. Hash-addressed images always load, verified. The setting takes effect live, even for a URL already cached. Settings › Appearance › "Load images from any website" |
| Thumbnails over Pear (ADR 0015, issue #5 part b) | `stage-3/images-over-pear` (on `stage-3/image-privacy`) | **done** — each creator has a **profile core** (`nutflix-profile`); Studio writes the chosen thumbnail into it, and the manifest names it (`hyper://` + `image-x` + new `image-size`). A viewer's `image(url, sha256, size)` for a `hyper://` image is read over Pear by the worker (length and sha256 checked there and again in the host, type sniffed): no `https:` request. Seeders serve profile cores **outside payment** (`Seeder.setFreeCore`: no `recordUpload`, no window, no PRICE). The worker shares what it has shown only while seeding with `Settings.seeding.serveImages` (default on); off, a replica opened for display is closed, so it is never announced, replicated or counted. Kind 0 `picture_sha256` / `picture_size` parsed, and the UI passes hash and size everywhere. Proven on a local testnet (creator → worker, free, released on switch-off) and with the real ffmpeg Studio test |
| Profile picture over Pear (ADR 0015, issue #5 part c) | `stage-3/profile-picture` (on `stage-3/images-over-pear`) | **done** — `NetworkAdapter.setProfilePicture({ bytes, type })` (v6). The host sniffs the bytes (JPEG, PNG or WebP, at most 5 MiB), the worker writes them into our profile core (`profile.putImage`), and our newest verified kind 0 is re-published with every other field kept (`mergeProfileEvent`, unknown fields included) and `picture` / `picture_sha256` / `picture_size`. Settings › Account › "Change picture"; the mock supports it for the UI |
| Mint fees in the price (issue #7) | `stage-3/fees-in-price` (on `stage-3/profile-picture`) | **done** — display only (Cameron: the minimum PAY stays a target). `Wallet.inputFeePpk(mint)` (v6; cashu-ts `Keyset.fee`, verified against Nutshell's 100 ppk and cdk), and Watch shows "+ ≈ N sats in mint fees" beside the pre-play price when the paying mint charges: ⌈price / minPaySats⌉ PAYs × ⌈2 inputs × ppk / 1000⌉ sats. Also fixed: Watch's channel avatar now passes its hash and size |
| Issue #2 — auto top-ups execute (F4) | `stage-3/auto-topup` | DONE: with the real wallet a due top-up runs from the payment path only (a play opening, a PAY for an open session; never the user's own withdrawal or any other balance change) — mint quote at the target, melt at `fromMint` — off by default, only into mints on the user's list, ≤ 10 000 per top-up and ≤ 50 000 per rolling 24 h (fees and in-flight included; ledger persisted, fails closed), first funding of a mint confirmed in main's prompt window (remembered only on yes), re-checked (same wallet, same settings) before the reservation and the melt, one at a time with backoff, both sides in wallet history; Settings amount field + cap copy. Review `docs/reviews/2026-09-25-pre-push-auto-topup.md` (self-review + independent review: 11 findings — 9 fixed, 1 fixed in part with the up-front input-fee refusal deferred, 1 not a defect and documented); contract request `S3-topup.md` (melt memo, fees in the cap, melt input-fee cap) |
| One seeder per block, credit per seeder window (F33, issue #8) | `stage-3/f33-one-peer` (on `c08c99f`) | **done** — each block is asked of ONE seeder: `OnePeerRouter` (`@sovit/seeder`) replaces hypercore 11.35.3's racing hotswap queue with a failover-only one (a request stalled 4 s moves to one other peer, the stalled one cancelled; a peer that stalled gets one request at a time until it delivers) and caps each replication peer's in-flight requests at its credit. It is pinned by tests that fail loudly if the internals move, and fails closed at runtime. `SeederCredit` (shared upstream module) sizes that credit per seeder: its HELLO window widened for the manifest's minimum PAY, less blocks unACKed or never to be paid (rejected PAYs, blocks owed at a drop, cancels after sending — kept across reconnects and by HELLO pubkey). The pool follows the sum of the windows, and PAYs batch to half each seeder's window. The desktop and the gateway's upstream reads both use it. Fixed on the way: the payer's tail paid only a quiet peer's first scattered run. Measured: 48 of 48 delivered and paid, where the pre-lane stack paid 49–51 and was banned by the window-4 and window-1 seeders; real mint 24 of 24 (unrouted baseline 25–27). Independent review answered: shutdown can no longer hand a replicating core back to hypercore's scheduler (released cores are parked, connections close first), stall = silent peer, fixed gateway lookahead, bounded pubkey index; viewer-restart debts deferred to the v7 ACK-window request. ADR 0018. |
| Issue #8 residuals (ADR 0014 amendment, F5 desktop) | `stage-3/residuals` (on `c08c99f`) | **done** (independent review fix-first → fixed): (a) the desktop journal is a sealed file per identity. The key is wrapped with NIP-44 to self, then XChaCha20-Poly1305. Every transition, with the unpublished NIP-60 events, is fsynced before its request; `recoverPending` settles it at open and a `SettleLoop` settles later entries on a schedule; a damaged journal refuses the wallet loudly and is kept. Crash injection: SIGKILL between the journal write and the mint answer, recovered by a new process. (b) Melt change is journaled (NUT-08 blanks, NUT-09 restore, PENDING and NUT-07 handled). (c) Held inputs are out of the balance and the header chip, and come back by themselves. (d) DLEQ runs on a `Bare.Thread` over a SharedArrayBuffer mailbox, with chunked fallback, never acceptance; retiring a thread never blocks the loop. 128 proofs: 548 ms of stall before, 3 ms after. Real mints: Nutshell and cdk 5/5. 50 mutation checks. Fix rounds 2 and 3 (independent verifier): every mint request is sent once (no retrying transport as a default anywhere), a 429 is ambiguous (held, then NUT-09 / NUT-07), a melt gets 300 s to pay; 10 and 13 more mutation checks; real mints 20/20 on each |
| Packaging (issue #6, F21, ADR 0017) | `stage-3/packaging` | **done (Linux built; Windows/macOS configured; independent review addressed)** — Electron Forge 8.0.0-alpha.10 (7.x fails the advisory gate) drives a staged app: main + host bundled into `app.asar`, the Bare worker as an unbundled boot module (`bare-encoding/global` first) + bundle, unpacked with the lockfile runtime closure (target prebuilds only, no pear-runtime), located through the app's own archive (`realpath(resourcesPath)/app.asar`). Fuses set (RunAsNode, NODE_OPTIONS, --inspect off; asar integrity, only-from-asar on) and read back from every binary, plus a layout gate covering every packed file; packaged builds also refuse Chromium's remote-debugging switches. Makers: Squirrel `.exe` (main handles the Squirrel lifecycle first, packaged win32 only), `.deb`, in-repo `.dmg` (hdiutil) and AppImage (pinned runtime; no `--no-sandbox`); in-repo makers instead of Pear makers await Cameron (ADR Q9). The host never chmods bare-sidecar's runtime (fails closed on a read-only install). `scripts/release-manifest.mjs` makes ONE UNSIGNED kind-30071 event per release for the SovTech npub (signed via Bunker46) from each make's own artifact list (exact maker names for the version only, created_at = now), `release-verify.mjs` checks it (SovTech key only; files/size/commit tags; a FIFO or device event file refused). Built here: package + `.deb`; the packaged binary needs the D4 profile extended to start (ADR 0017 §7); AppImage on Ubuntu ≥ 24.04: use the `.deb` |
| PAY/melt gate (fund loss from the residuals round-3 verifier, ADR 0012 amendment) + cross-lane review round 4 | `stage-3/int-pay-melt-gate` (on `9a20d30`, with lanes #2 and #8 merged) | **done** — a PAY queued behind a melt at its mint (melts may take 300 s since issue #8 fix round 3) was built after the worker's 300 s `pay.build` deadline, its P2PK proofs lost. The money plane's per-mint gate (`host/pay-melt-gate.ts`): a melt marks its mint, refuses waiting PAYs, waits for the one in flight, and clears however it settles; a PAY is refused at once (`rate-limited:`, nothing spent) while its mint is marked; PAY builds take turns and each must start within its own belt. Every desktop melt goes through it (`GatedCashuWallet`). Shared deadlines in `ipc/deadlines.ts`; round 4 made the belt per PAY (`payBuildStartByMs`: journal entries at the mint cost each send a restore and a check — 105.6 s with none, 15.6 s with one at a loaded mint, none otherwise). The worker's payer retries a `rate-limited` PAY on a 2 → 30 s backoff. Round 4 also fixed a HIGH in the auto top-up: a funding melt whose outcome was unclear dropped the target's quote, and a later paid settle left it unminted while a second top-up ran (reproduced: Lightning paid twice). The quote is now kept before the melt, sealed to the identity (NIP-44 via the signer) on the ledger entry, minted exactly once when PAID or released once the melt is settled unpaid, finished by any trigger, a restart, an unlock or a signer swap; no second top-up into a target with one open; the settled melt reads "top-up". Also: provable nothing-sent melt refusals settle `failed`, a run waits for the startup settle. Round 5: a play at zero balance waits at most 15 s in all (the first-funding question aside); a kept quote is never released within 600 s of its melt returning; a quote whose target still says UNPAID a day after the invoice expired is released unless the source says PAID (a source gone for good no longer blocks its target forever). 66 new tests over three rounds, 46 mutations killed. Open: other operations at the same mint are not gated (R1); a coded refusal after the melt request still counts against the cap (core has no "not executed", R4-R3); a target that forgets a kept quote, or says UNPAID while the source says PAID, holds auto top-ups into it with no in-app clear (R5-R1) |
| DLEQ thread in the packaged app (issue #8 d × #6, lane I1), and cross-lane fix round 4 | `stage-3/int-dleq-packaging` | **done**. Fix round 4 (cross-lane review, worker/P2P): an image URL naming a PAID core can no longer get the viewer banned or charged. Known sold cores are refused; image cores are routed so no `pay/1` seeder is asked more than its window, probed one block at a time until it serves the core free and never asked again once it PRICEd it; every seeder the repo builds announces a counted core's price before its first block (contract request `I1-dleqpack`: an explicit free signal for v7). A seeder's other cores are still paid when one core's PAY fails, and blocks that can never be paid are settled as unpaid, explicitly. A session's tail is paid before the worker deletes it and before the host revokes it (`play.close`, shutdown, and the app quit, each bounded). `setFreeCore` refuses a priced core; a reopened core gets its upload gate back; a serving-off replica never counts. The worker exits on an uncaught exception even with a DLEQ thread parked (real-Bare test). IR4 stays tied to the v7 ACK window. Before that, lane I1: The packaged worker never found its DLEQ thread entry (`../pay/` from an inlined module climbed out of `worker/`, and staging never wrote it), so every packaged build checked PAYs' DLEQ proofs inline on its event loop, and logged nothing. Now the entry is resolved from `src/worker/worker-root.ts` (the worker root in both layouts, `./` paths only). It is staged as its own bundle at `worker/pay/dleq-thread-entry.mjs` (`src/worker/pay` + `src/ipc` only, npm imports shipped), required by the layout gate as an unpacked regular file (no symlink, no symlinked directory), and a symlinked entry is refused at runtime. The verifier says which path is in use, and `--dev-fixtures` runs a one-line DLEQ self-check. The packaged-worker integration test (real Bare, staged tree) shows `where: thread` with core's verdicts. Also: a timed-out real-maker test no longer cascades into 10 ENOENT failures (`TMPDIR` restored in `afterEach`) |
| Packaging lows, cross-lane review round 4 (issue #6, lane I3-pack-lows) | `stage-3/int-packaging-lows` | **done**. The stage now refuses a build older than its sources, before touching `out`: TypeScript's own dry build over core, gateway, seeder and ui (a touched-only source counts as current; a shipped package's entry points must exist), ui's stylesheets, and the renderer/prompt/preload bundles against everything they read, ui's built `dist/` included (round 5). So a local `make` can no longer ship a stale core, as the reviewer's melt-timeout mutation showed it could. `stage.test.ts` and the packaged-worker integration test therefore need `npm run build` after source changes. Main refuses 10 more sandbox switches in every build (seccomp, namespaces, setuid, zygote sandbox, Landlock, sandbox debugging, single-process, in-process GPU…) and, when packaged, the process wrappers (`renderer/utility-cmd-prefix`, `gpu-launcher`, `zygote-cmd-prefix`, `browser-subprocess-path`), `js-flags` and the isolation overrides, in the existing order. The packaged host bundle carries stubs instead of core's test doubles, and a guard fails the stage if any gets in. Deferred to Cameron: `GrantFileProtocolExtraPrivileges` (open question 8) and `--enable/disable-features` (open question 11) |
| NUT-13 seed backup — design (issue #3, ADR 0016) | `stage-3/integration` | **design accepted 2026-09-25** with Cameron's answers: a new 12-word phrase per device, sealed on the device and copied to the user's relays NIP-44-encrypted to self (kind 30078, one per device); one phrase per device (counters from 0, no slots); the existing balance reissued once into seeded outputs (fee shown first); `@scure/bip39` 2.0.1 pinned (the tarball nostr-tools already locked) and allowed in the locked `wallet/seed.ts`. The core/desktop seam is frozen in `core/src/wallet/recovery-api.ts`. Implementation: lanes `stage-3/nut13-core` and `stage-3/nut13-desktop` |
| Stage 3 fan-out orchestration (2026-09-25/26) | `stage-3/fanout-base` → `stage-3/integration` | Cameron asked for parallel sub-agents without losing quality. Each lane ran in its own worktree with a `.lane` allow-list off a base the orchestrator froze first (the only contract change, `autoTopUp.amountSats` + the two caps, landed before the fan-out); each lane was independently reviewed (differential-review + sharp-edges), fixed, and the fix pass checked by a third agent; a cross-lane panel (money plane, worker/P2P, packaging, test integrity) then reviewed the merged tree and its findings went through the same loop. That loop caught, among others: a 429 counted as a refusal losing a proof on a NUT-19 mint (cashu-ts's retrying fetch; fixed with single-attempt transports everywhere), a PAY queued behind a 300 s melt being built after the worker gave up (PAY/melt gate), an auto top-up paying Lightning twice when its melt outcome was unclear, a thumbnail URL naming a paid core getting the viewer banned, and the packaged app never finding its DLEQ thread |
| Seeder's count + "free" per core (ADRs 0015/0018 amendments 2026-09-26) | `stage-3/owed-seeder` (off `54f49bb`) | **done (seeder side; lands with P2's viewer side)** — pay/1 gains, additively in v6, `PRICE.free`, `OWED` (tag 5; ≤ 256 ranges / 1024 blocks, canonical) and `ACK.outstanding`; a priced PRICE is byte-for-byte v5. Every seeder the repo builds (daemon, gateway, desktop worker, dev fixtures) sends a core's PRICE — priced, or `{ free: true }` — unprompted as soon as the peer has the core open, and in any case before its first block (`announceCorePrices` removed; a block whose PRICE cannot be sent is not sent), reports each returning viewer's unpaid blocks per core once the HELLOs verify (priced PRICE first; the whole report before any later frame, so a viewer that waits for `open` knows when it is complete; a report that fails part-way cuts the session), accepts a PAY for them at the core's terms inside the connection's carry chain (clears them), and puts `outstanding` in every ACK. Tested on real streams for each composition (also with nothing asked), at two real mints, 42 mutation checks; independent review 2026-09-27 (1 HIGH, 1 LOW fixed). Open: R1 (the current viewer reads `free` as sold, and one image test's probe check expects a probe — P2), R4 (owed blocks at current, not delivery-time, terms), R10 (pre-existing: a stored core the Seeder has not opened is served ungated — needs its own lane) |
| Viewer pays the seeder's count + images only where "free" (ADRs 0015/0018 amendments 2026-09-26) | `stage-3/owed-viewer` (off `54f49bb`, owed-seeder + int-reconcile merged) | **done (viewer side)** — image reads ask a seeder only after its `PRICE { free: true }` (no probe; router `free`: a free read that times out leaves no debt; a pricing gateway no longer stops an honest free image); `SeederCredit` starts each seeder from its report (one block at a time until it is in, then window − `OWED`, re-based by every `ACK.outstanding`); the worker keeps a durable record of blocks received and unpaid per seeder pubkey + core with their session terms, plus a write-ahead "may be at its window" ledger; on `OWED` it pays only reported ∩ recorded blocks under the recorded session's id; `play.close` answers the unpaid tail and the host keeps per-identity tail authorisations (≤ 1024 blocks, 7 days, checked like any PAY, budget on disk before the build); the gateway gets credit-from-report and pays no old tail. Four tail scenarios end to end against a seeder daemon over hyperswarm (graceful close, crash, over-claim, expiry), three image scenarios on the testnet, 45 mutation checks, real-mint lanes green at Nutshell and cdk-mintd. Independent review fixed: every desktop PAY now carries its chain's `carryIn` (fresh PAYs went out with 0 — refused `malformed` after any carry, proofs spent) and none is built without one; a PAY with an empty creator share is admitted (the worker's guard refused it after the host built it); quit waits for the signer flow's tail writes; the gateway's report ignores replies to requests made before our HELLO; the record's write-ahead word survives its bound and age-out; `desktop-carry` end to end at 3 sats/block, 90/10. Fix round 7: a closed plane's tail book writes nothing more, so a tail PAY waiting at the mint across a sign-out and quick sign-in can no longer overwrite the next plane's tails; 66 mutation checks. Open: R1 (tails outlive their session, capped), R2 (full-app crash leaves no tail authorisation), R3/R4 (no end-of-report marker: 10 s wait; gateway crash-at-window), R9 (no directory fsync in Bare's `writeAtomic`) |
| Reconcile and small fixes on the integration base (lane R6-reconcile: the three base failures, the round-5 verifier's payer and money-plane items, the sixth fuse) | `stage-3/int-reconcile` (on `54f49bb`) | **done** — The staged host bundle exports `runHost` only again (`QUIT_FLUSH_MS` moved to `host.ts`). One retry mechanism for a refused PAY: `UpstreamPayer` classifies failures as final (`session-closed`, `forbidden`: given up, the core's streak ended), deferred (`rate-limited`: 2 s doubling to 30 s, never given up — a melt may take 300 s) or transient (round 5); `ViewerPayer`'s own timer is gone and `close()` cancels the payer's. The payer's time is monotonic and injectable (`performance.now()`, a steady `Date.now()` on Bare), and a bad clock stands still. Auto top-up: one 15 s bound for the whole play, every mint included (the adapter asked once per mint); a kept quote goes only on answers (a failed journal or source read keeps it; past the lapse the source must answer); a melt starts within 5 min of its reservation or never, and after a restart the release guard counts from the later of reservation + 15 min and the host's start. Packaging: `GrantFileProtocolExtraPrivileges` off and read back (ADR 0017 §4); the freshness rule watches `scripts/bundle.ts` and its tsconfigs. 35 new test cases, 29 mutations (28 killed, 1 equivalent). Open: a source gone for good holds its target back again (R5-R1); `rate-limited` is never given up; Bare's clock is a steady wall clock (RR-1) |
| NUT-13 seed backup, core (issue #3, ADR 0016) | `stage-3/nut13-core` | **done (core), one decision open** — a 12-word phrase per device (`@scure/bip39`, entropy and seed in secure memory, errors never quote a word); durable counters leased ahead and bound to their phrase (a crash never repeats one; a lost file is probed at the operating mint, one batch, verified signatures only; one source per store; a rotated phrase starts at 0); deterministic change/receive/mint/melt/reissue outputs, P2PK sends unchanged; the collision guard (NUT-07 decides for seeded entries; the mint's code is not trusted — Nutshell 11003, cdk 20006/11008); restore from any phrase (three empty batches of 100, this device's own phrase through its counters file's high-water mark, DLEQ required at NUT-12 mints, amount lies refused, spent filtered, one history line; a scan either cap stops — 200 batches, 32 keysets — is reported with a resume cursor, never as nothing); reissue with the fee shown; startup restore of `[published, next)`, whole and newest first, its watermark held from the counters file's load until it has scanned; close waits before wiping. Independent review: 9 findings fixed; the verifier's round 7: 3 more fixed. Open for Cameron: the restore bound for phrases with no known high-water mark (contract request 7). Proven on Nutshell 0.21.0 and cdk-mintd 0.18.1. Desktop wiring: lane N2 |
| Issue #3 — NUT-13 recovery phrase, desktop side (ADR 0016) | `stage-3/nut13-desktop` | DONE (desktop half; lane N1's core wired at merge through `host/recovery/core.ts` `recoveryCore()`): one 12-word phrase per device, sealed in `<userData>/wallet/recovery-<pubkey>.sealed` (NIP-44 to self, 0600/0700, fails loudly and is kept when damaged) and copied to the user's relays (kind 30078, `d` = `nutflix/nut13/<device id>`, read only by an explicit restore); counters file for core (atomic, fsynced, fails loudly); main's prompt window shows the words from its own bundled BIP-39 list (indices on the wire), content protection on, hidden after 2 min or on blur, no copy; confirm three words; the old balance reissued after main's native fee dialog (each mint's plan checked, one it cannot show left out and counted; each mint recorded as it moves, so a retry never moves or charges a covered mint again); show again after the passphrase (native confirm for NIP-46, its own question for a rotation); restore from this device's phrases, every relay copy, a typed phrase and typed https mint addresses, with progress and a per-mint report; Settings › Recovery phrase (web: "not covered"); log rule for word phrases (JSON arrays, quoted words, query strings, URL-encoded lists and JSON, pretty-printed JSON) with a canary. Review `docs/reviews/2026-09-26-pre-push-nut13-desktop.md` (self-review of resumed WIP: 12 findings fixed, 32 mutation checks; independent review: 11 findings addressed, 19 mutation checks; fix round 7: 3 findings fixed, 14 mutation checks); contract request `N2-nut13-desktop.md` (6 items, worked around) |
| Integration fix 2 — N1's real NUT-13 core in N2's desktop seam | `stage-3/int-fix-2` | DONE. The five failures of the merge fixed at their causes:<br>• the host and money-plane tests on core's real phrases and seeds (a pass-through spy; fakes kept for the service's stub-plane unit tests);<br>• the desktop counters file admits core's phrase binding (without it every seeded operation failed on the merged build);<br>• the plane closes its NUT-13 counter source and wipes its seed on any failed open;<br>• the mint-transport pin parses the source (a type is not a construction; an alias now is);<br>• two P2 log messages reworded.<br>The phrase log rule takes backslash escapes (`\n` `\t` `\r\n` `\u` `\x`, `%5C`) and remainders after an escape (the verifier's low and info).<br>Setup → reissue → restore from the relay copy on a fresh profile, end to end in-process and against Nutshell and cdk-mintd. Review `docs/reviews/2026-09-27-pre-push-int-fix-2.md` (38 mutation checks) |
| W8a-money — final review, money plane / NUT-13 | `stage-3/r8-money` | DONE. The round-8 panel's money findings, each with a test that failed before its fix:<br>• restores, reissues, plans and journal settles hold their mint in the PAY/melt gate (core `holdMint`); the PAY-behind-restore loss reproduced and closed;<br>• the PAY deadline model counts a seeded send (seeded belt 12.6 s); PAY sends bounded in core (`SendBound`: turn check, no collision re-run, one skip-ahead batch); the mint loaded and probed before the turn;<br>• restore follows core's `resume` (10 calls, cursor kept; a phrase past 20 000 counters restored whole);<br>• a reissue completes only with no journal entry or dust left; the relay copy retried with a bounded backoff;<br>• the plane runs the wallet's close (drain bounded, no late watermark write), the startup restore, one counters store per identity; the counters file takes core's probed-keyset entry;<br>• a repeated journal `begin` refused; play sessions closed before a reopen.<br>Nutshell and cdk real-mint suites green. Review `docs/reviews/2026-09-27-pre-push-w8a-money.md` (43 mutation checks) |
| W8b-p2p — round-8 findings on pay/1 and the worker | `stage-3/r8-p2p` | DONE. Eleven findings of the final panel (3 medium, 2 low, 6 info), all fixed with tests that fail before the fix:<br>• an OWED on a second node of one seeder key never pays a block pending on the first (the reviewer's double pay);<br>• an owed range failing for now is never forgotten: retried on its backoff and paid on the same connection (separate streaks from fresh blocks);<br>• a PAY's blocks leave the unpaid record on disk before the PAY is sent;<br>• per-core prices kept across restarts: an attacker's thumbnail can no longer make our node serve a video it played or uploaded free; our own profile core is never priced;<br>• one Hypercore session per core under concurrent opens; our profile core free before its gate;<br>• free image requests share the seeder's window while in flight; one bounded answer for `free`;<br>• stated timeout reasons; `NUTFLIX_REQUIRE_BUILT=1` makes the real-Bare tests fail instead of skip.<br>Review `docs/reviews/2026-09-27-pre-push-p2p.md` (31 mutation checks) |
| Round 8 — prompt window and packaging (final panel) | `stage-3/r8-prompt` | DONE. Five findings fixed:<br>• the recovery word fields draw their own suggestions in the page (no `<datalist>`, whose popup is its own window, outside content protection on macOS);<br>• a host confirm nobody waits for is closed: `HostOut` `confirm-cancel` on the host's deadline and at shutdown, main aborts the dialog (also when the host goes away), drops the late answer and refuses nothing after;<br>• staging refuses a prompt bundle older than the installed `@scure/bip39` and its dependencies (resolved from the lockfile);<br>• the prompt bundle's npm allow-list checks the whole package chain from this package's or the repo's `node_modules`;<br>• `[hidden]` always hides in the prompt window.<br>Review `docs/reviews/2026-09-27-pre-push-r8-prompt.md` (35 mutation checks) |
| Second fan-out and final panel (2026-09-26/27) | `stage-3/integration` (`539b6aa`) | pay/1 `OWED` + `PRICE.free` (seeder, then viewer), the payer reconcile, NUT-13 core and desktop, each built, independently reviewed, fixed and checked; the build agents were cut off once by the weekly usage limit and resumed from WIP commits. Wiring N1's core into N2's seam exposed a real bug on the merged build (the desktop counters file refused core's phrase binding, so every seeded operation failed) — fixed, and NUT-13 ran end to end on Nutshell and cdk (setup, reissue at the real fee, a second device restoring from the relay copy and spending). A final four-lens panel over everything since `9a20d30` found 1 high (already fixed) and 7 mediums, fixed in round 8. Last full CI (`npm run ci`) green at `1ca6b63`: 3829 passed / 30 skipped, e2e 16/16 at `82e79aa`; round 8's lanes each ran the whole suite before Cameron's 2026-09-27 rule moved every test run off this laptop (GitLab `kata-ci-*` runners only). After the round-8 merge only `tsc -b`, eslint/prettier on the changed files, `check:locked` and `lint:electron` were run here: all clean. Found by round 8's checks and fixed afterwards with tests WRITTEN BUT NOT RUN (the laptop may not run tests; they run in GitHub Actions once `nutflix-demo` is published): F54 (HELLO price ceiling), F55 (repeated reissue fee), F56 (dust blocked rotation; its first fix regressed and was re-fixed in round 9), F57 (corestore served stored cores behind the upload gate — found by round 9's review, confirmed by reading the library sources), a 0-sat underpay path, and the prompt paste low. Static checks after the last merge (`dfff073`): `tsc -b`, eslint/prettier on the changed files, `check:locked`, `lint:electron` — clean |
| First CI run on the public repo (2026-10-02) | `claude/focused-hamilton-6573si` (on `9a2f94d`) | **done** — GitHub Actions ran the suite for the first time since Cameron's 2026-09-27 rule: `package` and `e2e` green; `test` 3960 passed / 1 failed / 36 skipped, so the round-8/9 tests written but not run (F54, F55, F56, F57, the 0-sat underpay guard, the prompt paste low) now have a run behind them. Two failures fixed: (1) `log.test.ts` — two new W8a log messages in `host/recovery/service.ts` were swallowed by the ADR 0016 phrase rule (8+ lower-case words); reworded ("counted as done", "refused, as the relay copy retry is still running"), the rule unchanged as the test asks; (2) `npm audit --audit-level=high` stopped `verify` before lint/typecheck/locked-dirs ran — `brace-expansion` 5.0.9 (dev-only, via `minimatch` 10.2.6, GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p) moved to 5.0.12 inside the existing `^5.0.8` range: one lock entry, no manifest change. Checked in a cloud container (not the laptop): every `verify` gate clean; full suite 3942 passed / 23 failed / 32 skipped, the 23 the container's own: the hyperswarm/DHT integration tests (seeder, gateway, desktop pays/carry/owed) and three `auto-topup.test.ts` unwritable-ledger cases (the container runs as root, which writes through a read-only file) — the same tests fail identically on the untouched base there and passed on GitHub's non-root runner. `log.test.ts` passes. CI on the pushed branch is the run that counts |

### Inputs from Cameron — ANSWERED 2026-09-24 (Stage 3)

Asked one by one, multiple choice; these supersede the open questions above.

| # | Decision | Answer |
|---|---|---|
| 1 | F33 duplicate block deliveries | **One peer per range**: request each range from a single seeder, so there are no duplicates and seeders are paid fairly |
| 2 | F4 auto top-up | **Off by default**; when on, at most **10 000 sat per top-up and 50 000 sat per day**, only into mints on the user's own list, native confirm the first time a mint is funded, each top-up in wallet history |
| 3 | NUT-13 seed backup | **Yes, in Stage 3** (design + ADR first: the seed's source, per-device counters, the relation to NIP-60) |
| 4 | Minimum PAY (ADR 0010 §3.3) | Stays a batching target; **expected mint fees are shown in the price** (display only, no protocol change) |
| 5 | Blossom vs Pear | **Pear only** — refined 2026-09-25 after a correction (the gateway has no separate disk store: its Blossom endpoints are an HTTP face over its own Pear seeder): **drop third-party mirroring only**. Studio no longer mirrors to Blossom servers and our manifests carry sha256 + `hyper://` only (contracts v6); the gateway's Nostr-signed Blossom endpoints stay, reading and writing Pear; the web MSE fallback keeps working |
| 6 | Per-pubkey upload quota | **2 GiB** (the gateway's Blossom uploads, which land in its Pear seeder) |
| 7 | F18 images | **Hash-addressed only** by default, with a "Load remote images" setting |
| 8 | Thumbnails | In the video's own Hyperblobs core, fetched from its seeders; **each seeder chooses** whether to charge; default **free**; a charging seeder's thumbnail shows a **placeholder** — browsing never spends sats |
| 9 | Avatars | A **per-creator Pear profile core** named in kind 0, fetched P2P for free, identicon until it arrives |
| 10 | `minpay` window cap | **64 blocks** (kept) |
| 11 | Packaging | **Electron Forge + Pear makers**; targets **Windows .exe, macOS .dmg, Linux .deb, Linux AppImage** and a **`pear://` address** |
| 12 | Signing | Every release **signed with the SovTech ngit Nostr key** (through Bunker46; the nsec is never written): a Nostr-signed manifest of sha256 sums. macOS Gatekeeper / Windows SmartScreen warnings **accepted for now** |
| 13 | Outward | **Push** all `stage-2/*` and `stage-3/*` branches to origin and the backup mirror, **one MR** from `stage-3/manifest-minpay` to `main`; **file the open §6 issues** on GitLab; the Wallet QR phone scan now. Done 2026-09-24: 26 branches on origin and the backup mirror, MR !1, issues #1–#8, and the Wallet QR scan **passed** (the Storybook fund-invoice QR decodes to `lnbc5000n1pj9x7…`) |
| 14 | NUT-13 seed source and storage (2026-09-25) | **A new 12-word phrase, kept on the device AND an encrypted relay copy** (kind 30078, NIP-44 to self): the nsec plus the relays recover every device's phrase; the accepted cost is that an nsec compromise exposes that phrase's future seeded outputs until it is rotated |
| 15 | NUT-13 devices (2026-09-25) | **One phrase per device** (no counter slots or registry); with the relay copies the nsec recovers them all, without relays each device's words are needed |
| 16 | NUT-13 existing balance and library (2026-09-25) | **Reissue once into seeded outputs** (the mint's fee shown first); **`@scure/bip39` 2.0.1** pinned and added to the locked allow-list |
| 17 | Unpaid tail after a close, quit or crash (2026-09-26) | **The seeder reports; the viewer pays**: pay/1 `OWED` at session start and `ACK.outstanding`; the viewer pays old blocks it can prove it received, under a persisted host authorisation, and respects (never pays) anything claimed beyond that |
| 18 | Free thumbnails and avatars (2026-09-26) | **Seeders say "free" per core** (`PRICE.free`); viewers fetch image blocks only from seeders that said so — no probe; images held only by older or third-party seeders show the placeholder |
| 19 | F33 failover delay; a sixth fuse (2026-09-26) | **4 s** kept; **`GrantFileProtocolExtraPrivileges` off** as well |

Owed from Stage 2 (ADR 0010 Consequences, `docs/security-review.md` §0 and §6). The F1–F4 and
F30 blockers were fixed on `stage-2/review-fixes` (2026-09-24); F6 verified on two real mints
(`stage-3/real-mint`); the seeder daemon's runtime is done (`stage-3/seeder-runtime`, ADR 0011).
Still owed: "paid views" → sats per video (ADR 0011 §8.4, UI polish);
a contract-level `NetworkAdapter` signer control for the web shell (the desktop uses shell
methods, ADR 0013) + `SignerStatus` "none"; the deferred
L5/L6-B/L6-C requests.
