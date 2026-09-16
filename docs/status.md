# Status

Kept current by the orchestrator after every merge (execution plan §5.1).

**If you are an agent picking this up cold: read an internal session handoff (not published)
first.** It is the resume point — what is done, what is in flight, and the exact next actions.

## Stage 0 — scaffold, contracts, spikes: **DONE 2026-09-04**

| Deliverable | State |
|-------------|-------|
| Monorepo scaffold (npm workspaces, TS 6 strict, ESLint type-checked, Vitest, Prettier, `.npmrc` exact-pins + ignore-scripts) | done — `npm run ci` green |
| Lane guards: `scripts/pre-commit` path allowlist, `scripts/check-locked-dirs.sh`, `scripts/check-contracts-version.sh`, `.gitlab/CODEOWNERS`, `scripts/new-lane-worktree.sh` | done |
| CI skeleton | `ci/gitlab-ci.yml` — parked until a runner is registered (README caveat) |
| `docs/vendor/` (75 files) + `MANIFEST.txt` | done — `scripts/vendor-docs.sh` refreshes |
| `SECURITY.md` threat model + invariants + locked dirs | done |
| Contracts | **v3, FROZEN** (ADR 0004) — Signer, Wallet, PaymentEngine, PayProtocol, NetworkAdapter, Manifest/NIP-71/HyperblobRef, Media |
| Mocks | `MockPaymentEngine` (honest + 6 cheat modes), `MockWallet`, `MockNetworkAdapter` (12 fixture videos, 5 channels, error/latency switches) |
| Spikes | S-A (A4), S-B (A8 PASS), S-C (transcode → subprocess+ffmpeg) — `docs/spikes/` |
| Assumption resolutions | ADR 0003 |
| Prompts | `docs/prompts/{orchestrator,lane,stage-2-security}.md` |
| Lane briefs | `docs/lanes/BRIEFS.md` |

## Stage 1 — parallel lanes

`main` is green: **61 test files, 647 passed / 31 skipped** (`npm run ci`, 2026-09-05).

> **Skip count note.** 27 of the 31 are Stage-2-gated by design (13 BlossomAuth, 10 pay/1
> codec, 4 `it.skipIf(usingMock())` payment tests). The other **4 are L8's real-ffmpeg suite**,
> which `skipIf`s when no binary is found: the dev copy lives at `/tmp/opencode/ffmpeg/` and
> **`/tmp` gets cleaned**, so a fresh session usually starts at 31 skipped. Restore it with the
> recipe in `packages/core/src/media/FFMPEG-PIN.md` ("Install for tests") and the count returns
> to 647+4 passed / 27 skipped. Neither number is a regression.

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
| L5 — Watch, Channel, Search, Shorts, Library, Studio, Wallet, Settings | `lane/L5-<Screen>` | **NOT STARTED** — worktrees + branches exist, `npm ci` + build done, prompts drafted | — |
| L6 desktop-shell | `lane/L6` | **NOT STARTED** — worktree ready, Electron binary installed, prompt drafted | — |
| L7 web-shell | `lane/L7` | **NOT STARTED** — worktree ready, prompt drafted | — |

Lane reports: `docs/lanes/L1.md`, `L2.md` (incl. v3 section), `L3.md` (incl. markup section),
`L4.md`, `L5-Home.md`, `L8.md`, `L9.md`, `L10.md` (incl. v3 section).

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

### Open contract-change requests (CONTRACTS_VERSION = 3, FROZEN)

None. Recorded for the Stage 2 (v4) bump:

1. `BlockRange.core` and `recordUpload`'s `core` become **required** (ADR 0004).
2. **`PRICE` carries no core** — per-core prices need it (L3 observation).
3. **Q1 rounding rule becomes contract text**: `seederSats = ceil(amount × seederPct / 100)`,
   `creatorSats = amount − seederSats` (ADR 0005).
4. BUD-09 reports reach `BlossomAuth` as a synthetic `Nostr <base64(kind-1984)>` header under
   verb `report`; Stage 2 may prefer a second method on the interface.

### Follow-ups owed by the orchestrator

1. **an internal session handoff (not published) §4.4 is stale** where it describes the flat
   `markupSatsPerBlock`; ADR 0005 supersedes it. (This file is correct.)
2. **`types/holepunch.d.ts` is duplicated** (seeder + gateway) and the two copies have
   **diverged** — the gateway's adds `userData`/`end()`, the seeder's adds `hyperdht` and more
   doc comments. Deduping needs a shared ambient-types package (`declare module` blocks are not
   emitted by `tsc` and cannot be re-exported), which is more than the "only if trivial" the
   brief allowed. **Left as is, deliberately.**
3. **L4 `VideoCardSkeleton` bug** (found by L5-Home): `.nf-card__text` has no `flex-grow`, so
   skeleton text lines render at 0 px. L5-Home works around it in `Home.css`; the rule belongs
   in `VideoCard.css`. Fix in the next lane that touches `packages/ui/src/components/`.
4. **Each L5 merge needs two wiring lines** from the orchestrator: the export in
   `packages/ui/src/screens/index.ts` and the `@import` in `packages/ui/src/screens/screens.css`.
5. `packages/seeder` still ships **no self-executing entry point**, but
   `deploy/systemd/nutflix-seeder.service` points at `dist/index.js --config`. Documented in
   `deploy/systemd/README.md`; a shell (L6 worker or a Stage 2 service entry) must call
   `runDaemon()`, or the seeder needs a `bin`.

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

**Nothing is currently blocked on Cameron.**

## Stage 2 — audit surface (single Fable 5.1 session): NOT STARTED
## Stage 3 — integration and polish: NOT STARTED
