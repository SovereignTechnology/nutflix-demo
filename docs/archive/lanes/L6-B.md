# Lane L6-B — desktop host (the real `NetworkAdapter`)

**Issued against `CONTRACTS_VERSION = 4`** and the frozen L6-0 IPC foundation (`src/ipc/`).
Date: 2026-09-23. Branch `lane/L6-B` off `99b79be`. Spec: `docs/plan/L6-design.md` §6 row L6-B,
§1 (Host row, Settings, Wallet and engine, PlaySession across processes), §2 (the host's side of
both hops), §3 (images, IPC re-validation), §4 (session backstop), §5(a) fixtures seam, D2
(amended), D3, D5, SE-4, SE-5. Contract requests: `docs/contract-requests/L6-B.md`.
No dependency, `package.json`, lockfile, `src/ipc/` or `src/types/` change.

## What was built — `packages/app-desktop/src/host/`

| File | What |
|---|---|
| `adapter.ts` | `DesktopNetworkAdapter implements NetworkAdapter` (`platform: 'desktop'`). Reads through L1 (`NostrClient` over the injected `PoolLike`, rebuilt when the relays or the signer change); writes need a `Signer` (`no-signer:` first, before anything is fetched or built); `stats()` = L1 reactions minus NIP-09 deletions + `fetchPaidStats` + a bounded comment count + the catalogue's seeder count; `unreact` = kind-5 of the viewer's OWN kind-7 ids (SE-5); `openSession(owner, …)` (play); upload/publish; seeder over the worker; settings; notifications (L1 `watchNewVideos` + `watchReplies`); worker events (`spend` debits the dev wallet, `peers`, `seeder.status`, `upload.progress`, `dev.fixtures`) |
| `sessions.ts` | `HostPlaySession implements PlaySession` (host-minted 128-bit `sid`, separate 256-bit media token, `toWire()` → `PlaySessionWire`) and `SessionRegistry` (≤ 1 unpaused per owner, `closeOwner` for `wc-gone`, `dropAll` when the worker dies) |
| `dispatch.ts` | one handler per `MethodTable` entry (compile-checked), none for `EXCLUDED_METHODS` |
| `topics.ts` | `TopicRegistry`: the six topics per webContents, `subsPerWc` cap, duplicate subIds refused, session topics bound to the owning webContents and dropped when the session closes |
| `host.ts` | `Host` (the `HostIn` → `HostOut` loop: `isHostIn` again, one reply per call, `inflightPerWc`, `file` only with `studio.upload`, `wc-gone`, image requests, `refuse()` for malformed input) and `createHost()` (wires settings, pool, identity, wallet, images, adapter, supervisor; spawns the worker) |
| `main.ts` | the `utilityProcess` entry: `runHost({ parentPort, argv, log, spawn })`; self-starts only when `process.parentPort` exists; logs are JSON lines on stderr; exits 2 on bad arguments |
| `flags.ts` | strict argv: `--user-data-dir=<abs>`, `--worker-entry=<abs>`, `--dev-mocks`, `--dev-fixtures` (refused without `--dev-mocks`), `--dev-bootstrap=127.0.0.1:<port>[,…]` (refused without `--dev-mocks`, loopback only) |
| `worker/supervisor.ts` | `WorkerSupervisor`: spawn → framed `init` → ready (init-ack AND `ready` event) → requests; `isWorkerToHost` + `validateWorkerResult` on everything; answers the worker's `studio.publish`; drains stdout/stderr through the redacting logger (per-stream 50 lines/s); per-call timeouts; crash/corrupt frame/start timeout → `backend-down:` for everything outstanding → back-off restart (250 ms doubling to 30 s; > 5 starts in 60 s → `failed`); an init that fails its guard → `failed` at once |
| `worker/sidecar.ts` | `spawnBareSidecar` — `bare-sidecar` directly (D2 amended), loaded lazily |
| `images/net.ts` | `checkImageUrl`, `isNonPublicAddress` (v4 + v6 incl. mapped/NAT64/6to4), `safeLookup` (every DNS answer must be public), `httpsTransport` (`node:https`, identity encoding, timeout, no agent reuse) |
| `images/images.ts` | `ImageService`: `image(url, sha256?)` → `nf-media://img/<id>`, `serve(id)` for main, `registerFile(path)` for Studio thumbnail candidates (must live under the worker storage) |
| `settings/json-file.ts` | atomic JSON (temp 0600 `wx` → fsync → rename → dir fsync), serialised saves, corrupt → moved to `<name>.corrupt` + logged |
| `settings/settings.ts` | `SettingsStore` (`settings.json`, `{v:1, settings}`), `DEFAULT_SETTINGS`, `autoTopUpDue` (SE-4), `desktop.json` (`ffmpeg` paths) |
| `social/reactions.ts` | NIP-09: `buildUnreactDeletion`, `ownReactionIds`, `deletedReactionIds`, `fetchReactionSummary` |
| `catalog/catalog.ts` | `CatalogSource` seam + `NostrCatalog` (L1 feeds, search, related, profile) |
| `catalog/fixture-catalog.ts` | `FixtureCatalog` (`--dev-fixtures`): core's mock fixtures + the worker's live `dev.fixtures` manifests, loudly logged |
| `identity.ts` | signer seam: `IdentityProvider`, `NoIdentity` (Stage 1), `DevViewerIdentity` (`--dev-mocks`), `SignerIdentity` (a real `Signer`, Stage 2 / tests) |
| `wallet.ts` | `UnavailableWallet` (every call `payments-unavailable:`), `createWalletProvider` (`MockWallet` with 21 000 fake sats per fixture mint behind `--dev-mocks`) |
| `log.ts` | redacting logger (`redact`, `createLogger`, `memoryLogger`) |
| `errors.ts` | `hostError`/`fail` → `IpcError` with the `"<code>: "` prefix |
| `index.ts` | barrel |

## How it maps to the design

- **§1 Host row.** Everything in the row lives here; the worker is spawned by the host with
  `bare-sidecar` (D2 amended — never `pear-runtime`, never `new PearRuntime()`).
- **§1 Settings.** The host owns `settings.json` (atomic) and pushes `seeder.configure` when
  `seeding` changes (a worker that is down gets the saved values in its next `init`, so that
  failure is logged, not thrown). `desktop.json` holds the ffmpeg paths (pre-v5).
- **§1 Wallet and engine.** `MockWallet` behind `--dev-mocks`, debited from each `spend` event
  (only for an open session and a mint of that video's price). Nothing executes a top-up (SE-4).
- **§1 PlaySession across processes.** Host-minted `sid`; the worker's link goes to MAIN as
  `media-link` BEFORE the reply that names the token; the renderer only ever gets
  `nf-media://play/<token>`; close revokes (`url: null`); worker death revokes all.
- **§2.** Both hops re-validated with L6-0's guards; errors only as `WireError`s; Maps dehydrated.
- **§3.** `image()` rules; IPC re-validation (`isHostIn`); D3/D5 unreachable.
- **§4.** Backstop: ≤ 1 unpaused session per webContents (others are paused before the worker
  opens a new one AND after it is registered, so concurrent opens cannot both play); `wc-gone`
  closes all of that webContents' sessions and subscriptions.
- **§5(a).** `FixtureCatalog` behind `--dev-fixtures`, refused without `--dev-mocks` (argv AND
  `createHost`), unsigned and loudly logged. With fixtures the relay layer is L1's in-memory
  `FakeRelayPool`, so a dev/e2e run never touches the public network.

## Deviations (and why)

1. **Dev viewer identity** (`DevViewerIdentity`, `--dev-mocks` only). Watch and Shorts refuse
   to play when `me() === null` (`stageGate` → `'signer'`), and Stage 1 has no signer, so the
   Stage 1 exit test could never press Play. Under `--dev-mocks` `me()` is the fixtures' `ME`
   pubkey, reported `locked: true`; writes still reject `no-signer:`. **Decision needed.**
2. **`seedersOnline` fails closed.** No swarm lookup exists on the host (nor a worker request for
   it): 0 unless the catalogue knows better (live dev fixtures → 1). Contract request 5/10.
3. **`play()` of an unknown rendition label is `not-found:`** — the mock silently falls back to
   the first rendition; opening a paid session at a price the screen did not show is worse.
4. **Signed-out reads are empty, writes are `no-signer:`.** The mock accepts writes signed out.
5. **`image()` returns `nf-media://img/<id>`** (L6-0 narrowed the result type); the mock echoes.
6. **No wallet without `--dev-mocks`**: every wallet call rejects `payments-unavailable:` (reads
   too — "0 sats" would be a lie on screen). `play()` checks this before the worker.
7. **`nutzap`** rejects `no-signer:` signed out, else `payments-unavailable:` (Stage 2).
8. **`studio.analytics().satsByRendition`** is an empty Map (no receipts until Stage 2).
9. **No live NIP-05 lookup** (it would fetch a URL named by a relay event); `unverified`.
10. **Stage 1 publishes no thumbnail** (no Blossom upload yet): `studio.publish` builds renditions
    without `image`. The publish path is implemented and tested with L1's `TestSigner`.
11. **First-run settings** (`DEFAULT_SETTINGS`): relays `relay.damus.io`, `nos.lol`,
    `relay.primal.net` (read+write); no default mint; seeding OFF; prefetch 30 s; theme
    `system`. **Decision needed** (public relays contacted on first run vs an empty first run).
12. **`autoTopUpDue` compares the balance at `fromMint`** (the contract does not say which).

## Security checklist items owned, and their tests

| Item | Where | Test |
|---|---|---|
| SE-5 `unreact`: kind-5 of the viewer's own kind-7 ids only, never a `-` | `social/reactions.ts`, `adapter.ts` | `adapter-social.test.ts` "unreact (SE-5)": exactly one kind-5, only own ids on that video (not the other user's, not the viewer's reaction on another video, not the video id), only `e`/`k` tags, no kind-7 published; relay lies (another author, forged) dropped; deletion by a third party ignored |
| SE-4 `belowSats <= 0` = off; nothing executes a top-up | `settings/settings.ts`, `adapter.ts` | `settings.test.ts` "autoTopUpDue (SE-4)" (0, −1, NaN, −∞ × balances; strict `<`); `adapter-play.test.ts` "SE-4": balances drained to 0 with `belowSats` 0 and 100 → `mintQuote` never called |
| T16 `image()`: https only, no credentials, 5 MiB, image MIME AND sniffed JPEG/PNG/WebP, ≤ 3 re-validated redirects, private/loopback/link-local literals AND DNS answers refused, sha256 | `images/*` | `images.test.ts` (66 cases incl. `0x7f.1`, `2130706433`, `[::ffff:127.0.0.1]`, 169.254.169.254, redirect to each, rebinding via DNS, SVG, lying Content-Type, declared and streamed size) |
| The blob-server link never reaches the renderer | `sessions.ts`, `adapter.ts` | `adapter-play.test.ts`, `host.test.ts` "play: media-link to main BEFORE the reply" |
| IPC re-validation, D3/D5 unreachable, SE-1 path only from main | `host.ts`, `dispatch.ts` | `host.test.ts` (bad args, junk, `wallet.send/receive/p2pkPubkey/keyset`, upload without/with `file`, `file` on another call) |
| Session backstop / `wc-gone` / worker death | `sessions.ts`, `host.ts` | `adapter-play.test.ts` backstop block, `host.test.ts` "wc-gone" |
| Caps: `subsPerWc`, `inflightPerWc` | `topics.ts`, `host.ts` | `host.test.ts` |
| Dev fences (`--dev-fixtures`/`--dev-bootstrap` need `--dev-mocks`; loopback bootstrap) | `flags.ts`, `host.ts`, `worker/supervisor.ts` | `flags.test.ts`, `main.test.ts`, `supervisor.test.ts` "an init that fails the guard" |
| Worker output drained + redacted; nothing secret in logs | `worker/supervisor.ts`, `log.ts` | `supervisor.test.ts`, `sidecar-supervisor.test.ts` (real bare writes ~300 KiB before answering init), `log.test.ts` (no 64-hex survives, fast-check) |
| Settings atomic, 0600, corrupt → defaults + logged | `settings/*` | `settings.test.ts` |
| Every consumer through `verifyIncoming` | L1 `NostrClient` everywhere | `adapter-social.test.ts` (tampered video / comment / reaction injected by a malicious relay are dropped) |

## What the other L6 lanes must know

**L6-A (main/preload/renderer).**
- Fork: `utilityProcess.fork(<dist/host/main.js>, ['--user-data-dir=<abs>',
  '--worker-entry=<abs>', …'--dev-mocks', '--dev-fixtures', '--dev-bootstrap=127.0.0.1:<p>'])`
  (ESM entry; logs = JSON lines on its stderr; exit code 2 = bad arguments). For the in-main
  fallback (risk 5) use `createHost({ …, post })` + `host.handle(msg)`.
- `HostOut` ordering: `media-link` is posted before the reply naming its token; `url: null`
  revokes (session closed, `wc-gone`, worker death). Sub acks come as `sub-reply`
  (`msg.id = subId`). Image requests are answered with `bytes: null, type: null` for unknown ids.
- The host also enforces `inflightPerWc` (same limit as main) and refuses a `file` on anything
  but `studio.upload` (`invalid-argument`), and `studio.upload` WITHOUT `file` with
  `file-token-invalid`.
- Send `wc-gone` when a webContents is destroyed: it closes that webContents' sessions (the
  worker is told) and subscriptions.
- Under `--dev-mocks` `me()` is non-null (see deviation 1), so Watch's Play button is enabled.
- `session.close` for an unknown/foreign sid resolves (idempotent); other `session.*` calls on
  it reject `session-closed:`.

**L6-C (worker).**
- `init` carries `storage = <userData>/worker`. Thumbnail candidates in `upload.progress` must be
  absolute paths UNDER that directory; others are dropped (logged). `ready {v, port}` may come
  before or after the `init` response; the host needs both.
- `spend` must be per PAY with `mint` ∈ the session's `policy.mints`; spends for unknown sids or
  other mints are ignored. The host debits its dev wallet by `amount`.
- `dev.fixtures` manifests: the host credits 21 000 fake sats at every mint they list (once), so
  they are playable; they are shown first in the fixture catalogue with `seedersOnline: 1`.
- The host answers an invalid worker request with `invalid-argument`, drops invalid events,
  kills the worker on a corrupt frame, and restarts it with back-off (250 ms doubling; more than
  5 starts in 60 s → it stays down). After a restart it does NOT re-send `play.close` for the
  sessions it dropped — the new worker starts clean.
- Timeouts: `studio.upload` none; `seeder.melt` 120 s; `studio.ffmpeg` 60 s; others 30 s; start
  (spawn → ready) 20 s.
- stdout/stderr are drained and logged (debug/warn, 50 lines/s per stream, redacted). Exit when
  fd 3 closes (if you attach a `'close'` listener to `Bare.IPC`, bare-sidecar no longer exits for
  you — L6-0 finding), or a dead host leaves an orphan worker.
- `studio.publish` needs a signer in the host; Stage 1 answers `no-signer`. `studio.upload` is
  refused by the host before it reaches the worker when there is no signer.

## Tests

`npm run ci` → **exit 0**: lint, build, **94 test files, 1704 passed / 27 skipped** (whole repo),
check:locked, check:native, lint:electron all OK.
`@sovit/app-desktop`: **22 files, 674 tests** (was 10 / 422): **12 new files, 252 tests** under
`src/host/__tests__/` (plus `support/`), all under plain Node; one
(`sidecar-supervisor.test.ts`) spawns the real `bare` through bare-sidecar. The 252 include six
copies of L1's one-test `TestSigner` self-check (see below).

| File | What |
|---|---|
| `conformance.test.ts` | the same 48 happy scenarios + 12 failWith-equivalents against `MockNetworkAdapter` and `DesktopNetworkAdapter` (FakeWorker + FakeRelayPool): same exact-keys wire guard after dehydrate + structured clone; same `WireError` code; the real Watch/Shorts/Studio classifiers agree; 4 deliberate differences asserted |
| `adapter-social.test.ts` | SE-5, deletion-aware stats, comments, no-signer writes (11), L1 reads incl. tamper drops, relay-down, the NIP-51 library round trip |
| `adapter-play.test.ts` | sessions, media links, backstop (incl. concurrent opens), switchRendition, spend/peers, worker death, SE-4 |
| `adapter-studio.test.ts` | upload progress mapping + scrubbing, publish via `studio.publish`, seeder + settings side effects, `--dev-fixtures` |
| `host.test.ts` | the `HostIn` loop (see the security table) |
| `supervisor.test.ts` | supervision with a manual clock |
| `sidecar-supervisor.test.ts` | the real bare: drain, request, crash → restart |
| `images.test.ts`, `settings.test.ts`, `log.test.ts`, `flags.test.ts`, `main.test.ts` | as named |

L1's `TestSigner` is loaded from core's source (`support/core-helpers.ts`, a runtime URL import
like L6-0's ui classifiers); that module also registers L1's one-test self-check in each suite
that imports it.

## Open questions / decisions for the orchestrator

1. **Dev viewer identity** (deviation 1) — or should Watch/Shorts allow signed-out playback?
2. **First-run relays** (deviation 11): three public relays, or none?
3. **`seedersOnline`** fails closed in Stage 1 (deviation 2); v5 `seedersOnline?` + a worker
   `swarm.seeders` request would fix it (contract requests 5, 10).
4. L1 follow-ups: NIP-09-aware counts in L1, `trendingFeed` kinds, NIP-05 fetch policy
   (contract requests 1–3).
5. `mocks` (core's `MockWallet`, fixtures) are imported by host runtime code, behind
   `--dev-mocks`/`--dev-fixtures` only — as the design specifies, but contrary to the comment in
   `core/src/mocks/index.ts` ("never imported by production code paths"). Fine for Stage 1?
