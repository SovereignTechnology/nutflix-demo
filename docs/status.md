# Status

Kept current by the orchestrator after every merge (execution plan §5.1).

**If you are an agent picking this up cold:** all nine L5 screens are merged and contracts
are v4 (2026-09-23, section "Orchestrator actions — 2026-09-23" below). **Next: L4-fixes and
L5-fixes (ADR 0007), then L6** (desktop shell), then the Stage 1 exit. Cameron's 2026-09-23
answers: ADR 0007 and "Inputs from Cameron — ANSWERED 2026-09-23" below. Background and hard
rules: an internal session handoff (not published) §1–§3, §4.2, §5 (its §4.1 is done).

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

## Stage 1 — parallel lanes

`main` is green: **72 test files, 1014 passed / 27 skipped** (`npm run ci`, 2026-09-23, all nine
L5 screens merged). On the dev laptop L8's real-ffmpeg suite ran against the **system**
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
| **L3-flake** | `lane/L3-flake` | **in progress** — root cause is a real `ws-duplex.ts` bug (late frames pause a closing socket → held 30 s, uncounted); fix re-issued | — |
| L6 desktop-shell | `lane/L6` | **NEXT** (after L4-fixes / L5-fixes). No worktree on the dev laptop and no cached Electron binary here (`node node_modules/electron/install.js`) | — |
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

### Open contract-change requests (CONTRACTS_VERSION = 4, FROZEN — ADR 0007)

v4 (2026-09-23) was a small additive bump: reactions (`likes`/`dislikes`/`myReaction`,
`unreact`). Recorded for the Stage 2 bump, **now v5**:

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
6. **`Route` changes (orchestrator-owned `screens/shared/route.ts`, not contracts):** `library`
   gets `playlist?`, `watch` gets a playlist/list param, `search` gets filters, `studio` gets
   `videoId`, `wallet` gets an intent.

### Follow-ups owed by the orchestrator

1. **an internal session handoff (not published) §4.4 is stale** where it describes the flat
   `markupSatsPerBlock`; ADR 0005 supersedes it. (This file is correct.)
2. **`types/holepunch.d.ts` is duplicated** (seeder + gateway) and the two copies have
   **diverged** — the gateway's adds `userData`/`end()`, the seeder's adds `hyperdht` and more
   doc comments. Deduping needs a shared ambient-types package (`declare module` blocks are not
   emitted by `tsc` and cannot be re-exported), which is more than the "only if trivial" the
   brief allowed. **Left as is, deliberately.**
3. **DONE 2026-09-23 (UI-fixes).** ~~**L4 `VideoCardSkeleton` bug** (found by L5-Home): `.nf-card__text` has no `flex-grow`, so
   skeleton text lines render at 0 px. L5-Home works around it in `Home.css`; the rule belongs
   in `VideoCard.css`. Fix in the next lane that touches `packages/ui/src/components/`.~~
4. **Each L5 merge needs two wiring lines** from the orchestrator: the export in
   `packages/ui/src/screens/index.ts` and the `@import` in `packages/ui/src/screens/screens.css`.
5. `packages/seeder` still ships **no self-executing entry point**, but
   `deploy/systemd/nutflix-seeder.service` points at `dist/index.js --config`. Documented in
   `deploy/systemd/README.md`; a shell (L6 worker or a Stage 2 service entry) must call
   `runDaemon()`, or the seeder needs a `bin`.
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
8. **Root-caused 2026-09-23 (lane L3-flake): a real bug, not a flaky test** — `ws-duplex.ts` pauses an already-closing socket on late frames, so it is held 30 s and uncounted by `maxConnections`; fix in progress. Original note: **The gateway `ws-bridge` "non-paying WS client is cut" flake is now frequent** (≥ 5 hits
   this session at load 6–8; always green on re-run). Needs the durable fix in that test
   (L3's directory): raise its timeout or serialise it against the ffmpeg/Storybook load.
9. Worktrees of merged lanes (`L5-*`) are archaeology — remove when convenient (branches stay);
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
0009.** Taken so far: 0001–0005, 0007.

### Inputs from Cameron — ANSWERED 2026-09-23 (ADR 0007)

| Question | Answer |
|---|---|
| Creator share at small PAYs (ADR 0005 erratum) | **Minimum PAY size + carry the creator's fractional remainder** across PAYs. Design and proposed parameters (`minPaySats` 10, window ≥ one min PAY) in ADR 0007; implemented in Stage 2 (contracts v5) |
| Home card price vs Watch | **Default rendition's price** on every card (no "from") — L4-fixes |
| Un-like / dislikes | **Always show dislikes.** Contracts v4: `VideoStats.likes/dislikes/myReaction`, `unreact()` (NIP-09) so un-like is never a `-` — L5-fixes |
| Library privacy copy | **Watch later is encrypted; playlists can be public or private** — L5-fixes |
| Pear direction / nutflix-2f | **Ignore it here; continue the plan** (L6 = Electron + `pear-runtime` Bare worker, ADR 0003) |

**Nothing is currently blocked on Cameron.** `spec/nfx-suite-m0` (ADR 0006) stays unmerged.

## Stage 2 — audit surface (single Fable 5.1 session): NOT STARTED
## Stage 3 — integration and polish: NOT STARTED
