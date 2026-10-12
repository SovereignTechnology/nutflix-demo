# Lane L6-C — desktop worker (the Bare data plane, `packages/app-desktop/src/worker/`)

**Issued against `CONTRACTS_VERSION = 4`** and the frozen L6-0 IPC surface. Date: 2026-09-23.
Branch `lane/L6-C` off `99b79be` (+ `cc7185c` scripts tsconfig, + `778b32d` with L6-B and L6-A
merged). Spec: `docs/plan/L6-design.md` §6 row L6-C, §1 (Worker row, "PlaySession across
processes", "Pause/prefetch in the worker"), §3 (worker playback server), §5(a), D1, D2, D6,
risks 3 and 4. No dependency added; no `package.json`, lockfile, `src/ipc/`, `src/types/` or
`src/worker/transcode/` change. Contract requests: `docs/contract-requests/L6-C.md` (6 items, none
blocking).

## What was built

```
src/worker/
  entry.ts              Bare entry: D6 first (./bare-globals.js), Bare.IPC ⇄ WorkerRpc ⇄ WorkerHost;
                        exit 3 on a corrupt frame, graceful close + exit 0 when fd 3 ends/closes,
                        uncaught → log + exit 1, unhandled rejection → log
  bare-globals.ts       D6: bare-encoding's TextEncoder/TextDecoder installed as globals
  adapters/bare.ts      the Bare runtime: bare-fs SeederFs + media FsAdapter, bare-os env/platform,
                        L8's bare-subprocess ProcessRunner (the ONLY bare-* importer besides entry)
  runtime.ts            WorkerRuntime — what the runtime-neutral host needs injected
  host.ts               WorkerHost: init/play.*/seeder.*/studio.*; spend/peers/seeder.status/
                        upload.progress/dev.fixtures/log events; one Seeder + one PeerNode
  rpc.ts                WorkerRpc: L6-0 framing + worker guards both ways, error envelopes,
                        ready-after-init, worker→host requests (studio.publish)
  crypto.ts             libsodium sha256 (SeederCrypto + media Sha256Factory) and randomness
  log.ts                redacting logger → `log` events; every 64-hex cut to 8 chars
  providers.ts          Stage 2 seam: getWorkerProviders() → undefined (like L3)
  ffmpeg.ts             system ffmpeg probe (configured path, else PATH; `-version`)
  net/peer-node.ts      Hyperswarm per Seeder: firewall = ban list, seeder admission, Corestore
                        replication, pay/1 per connection, loopback-only DHT for dev
  pay/viewer-payer.ts   ViewerPayer: L3's UpstreamPayer + ACK settlement + spend attribution
  playback/credit.ts    CreditPool: the seeders' unpaid window, viewer side
  playback/gate.ts      PlaybackGate: per-session gate, GatedCoreAdapter (no `.core`)
  playback/server.ts    PlaybackServer: hypercore-blob-server behind a wrapper store + allowlist
  studio/upload.ts      studio.upload: L8's runStudioUpload, seeder sink, studio.publish request
  dev/loopback-pay.ts   D1 LoopbackPayHub (in-process pay/1 pairing by Noise handshake hash)
  dev/dev-mocks.ts      --dev-mocks providers, the fence, dev identities/HELLO, DEV_PRICE
  dev/dev-engine.ts     DevEngine: MockPaymentEngine with the non-prefix rule (contract request 1)
  dev/fixtures-net.ts   --dev-fixtures / §5(a) rig: testnet, S1+S2, split blobs, manifests,
                        NUTFLIX_DEV_FIXTURES_JSON seam
  probe.ts, probe-entry.ts   the day-1 probe (runtime-neutral body + Bare program)
  types/holepunch.d.ts  ambient hypercore/corestore/hyperblobs/hyperswarm/hyperdht(+testnet)/
                        hypercore-blob-server/sodium-native (superset of the seeder/gateway copies)
scripts/bare-probe.ts   node packages/app-desktop/scripts/bare-probe.ts — the probe under real bare
```

## Day-1 probe (under the real `bare`)

`scripts/bare-probe.ts` bundles `src/worker/probe-entry.ts` (our sources only; every npm package
stays an import that Bare resolves itself) and runs it with **bare-sidecar's prebuilt `bare`
1.31.0**, spawned the way the host spawns the worker. Result, 2026-09-23 (also asserted on every
CI run by `__tests__/bare-probe.test.ts`, and run from the unbundled `tsc` output
`dist/worker/probe-entry.js` — same result):

```
ok    globals: TextEncoder/TextDecoder
ok    imports: @sovit/seeder  (portable)        ← the `bare` export condition, no Node adapters
ok    imports: @sovit/core + mocks
ok    imports: @sovit/gateway/upstream
ok    seeder: putBytes  (4 blocks)               ← Seeder on a temp dir, bare-fs + libsodium
ok    seeder: sha256 (libsodium)
ok    seeder: getBlob round trip
ok    seeder: putFile dedupe                     ← bare-fs read stream
ok    blob server: listening on 127.0.0.1
ok    blob server: loopback link
ok    range: 206 / Content-Range / exact bytes / Content-Type video/mp4 / CSP sandbox / no CORS
ok    range: across a block boundary
ok    range: 416 past the end
ok    allowlist: unknown session → 404
ok    allowlist: closed session → 404, store untouched
PASS: 20/20 steps, probe ≈ 100 ms, bare process ≈ 400 ms, exit 0
```

Beyond the probe, `__tests__/bare-worker.test.ts` runs the **whole worker entry** under the real
bare over the framed pipe with `--dev-mocks --dev-fixtures`: init → ready → dev.fixtures (a
testnet + S1/S2 inside the Bare process, the clip made by the system ffmpeg through
bare-subprocess) → play.open → Node fetches the bytes over HTTP (sha256 = the manifest's) →
spend events add up to blocks × price → close → 404 → studio.ffmpeg → junk refused → fd 3 ends →
exit 0 (≈ 1 s). Risk 4 is retired for everything the worker runs: no `crypto`,
`AbortController` or `process` is needed at runtime (hygiene test), `TextDecoder` comes from D6.

**D6 and bundling (finding).** A bundle (esbuild, and any future packaging step) hoists every
external `import` of every module to its top level, in the bundler's module order — modules
reached through a dynamic `import()` first — so an INLINED globals module runs after
`@sovit/core`, which builds a `TextDecoder` at load, and the worker dies. The `tsc` output (what
the host spawns: `dist/worker/entry.js`) keeps `bare-globals.js` a separate module that evaluates
first, and works. The test harness and the probe start bundles through a two-line unbundled boot
module (`import 'bare-encoding/global'`, then `import('./worker.mjs')`); Stage 3 packaging must do
the same if it bundles the worker.

## Wrapper, not the fallback

The duck-typed wrapper held; the fallback `bare-http1` range server was not needed. How it works
against `hypercore-blob-server@1.15.0` (read in full):

- `resolve(key, info)` admits a request only when the URL's path token names a LIVE session and
  its core key, all four blob-id fields and `type` equal that session's exactly (`type` must be
  `video/mp4`: the blob server copies `type=` into `Content-Type`). Otherwise `null` → 404
  BEFORE `store.get`, so an unknown core is never opened.
- `resolve` returns an opaque per-session handle as `key`; `_getCore` passes it verbatim to
  `store.get({key})` (`const { key = k } = resolved`), and the wrapper store answers with that
  session's `GatedCoreAdapter`. No race between concurrent requests (no shared state between
  `resolve` and `get`), and the store never touches the Corestore.
- `GatedCoreAdapter` has `opened`/`ready`/`seek`/`get`/`close` and NO `.core`, so
  `hypercore-byte-stream` sets `_prefetch = false` and reads block by block through `get(i)`.
- Two secrets per link: the server's 256-bit token (the blob server's own check) + a 128-bit
  per-session path token. 127.0.0.1 only, random port, `CSP: sandbox`, no CORS header.

What would break it: a blob-server release that stops forwarding `resolved.key` or starts
reading `.core`/other members. The version is pinned; `server.test.ts`, the probe and §5(a)
would all fail loudly.

## How it maps to the design

| Design | Where | Notes |
|---|---|---|
| §1 Worker: one Corestore + one Hyperswarm, firewall = ban list | `host.ts`, `net/peer-node.ts` | the Seeder's Corestore; the swarm key pair is `store.createKeyPair('nutflix-desktop-swarm')` (stable per storage dir, so bans stick) |
| §1 seeder with Bare adapters | `adapters/bare.ts`, `crypto.ts` | bare-fs, libsodium sha256; bare condition → `dist/portable.js` (probe) |
| §1 viewer payer, injected `pay(range, seeder, policy)` | `pay/viewer-payer.ts` | `WorkerProviders.pay`; dev = the mock's viewer side |
| §1 `MockPaymentEngine('honest')` behind a provider seam | `providers.ts`, `dev/dev-mocks.ts` | undefined by default; `--dev-mocks` loads mocks by dynamic `import()` only |
| §1 PlaySession across processes | `host.ts` `play.*`, `playback/server.ts` | worker keys sessions by the host's `sid`; the link goes to the host (→ main) only |
| §1 Pause/prefetch | `playback/gate.ts` | see deviations 1–2 |
| §1 ffmpeg probe, L8 transcode, `studio.publish` | `ffmpeg.ts`, `studio/upload.ts` | `ffmpeg-not-found` when neither init nor the probe finds one |
| §3 worker playback server row | `playback/server.ts` | all five controls, tested (`server.test.ts`, probe, §5(a)) |
| §5(a) | `__tests__/two-seeders.integration.test.ts`, `dev/fixtures-net.ts` | green, see below |
| D1 loopback pay/1, `--dev-mocks` fence | `dev/loopback-pay.ts`, `dev/dev-mocks.ts`, `net/peer-node.ts` | fence in the guard AND in code (mocks need an all-127.0.0.1 bootstrap or the worker's own testnet; the DHT binds 127.0.0.1) |
| D2 bare-sidecar | host spawns `entry.ts`'s output | tests spawn through bare-sidecar too |
| D6 | `entry.ts` → `bare-globals.ts` | first import; asserted by `hygiene.test.ts` |
| Risk 3 (bulk prefetch) | gate + wrapper | "downloaded ≤ window after `bytes=0-` + 1 s" asserted in §5(a) |
| Risk 4 (Bare 1.31) | probe, `bare-worker.test.ts`, hygiene | retired for the worker |

## Deviations from the design, and why

1. **Paced allowance in the gate (refines §1's lookahead).** The design bounds downloads by a
   lookahead `download({start: i, end: i + prefetchBlocks})` from the block being read. That
   bounds nothing against a greedy reader: measured on this box, a Node client that pauses its
   response still lets the kernel absorb **≈ 2.7 MB** (42 blocks of 64 KiB) of a `bytes=0-`
   response — more than the §5(a) file — and Chromium's media cache reads ahead ≥ 2 MB. So a
   reader may make block `i` travel only while `i < anchor + prefetchBlocks + paced`, `anchor` =
   its first block, `paced = floor(playingSeconds × bytesPerSec × 1.25 / blockSize)` (playing
   time excludes pauses; 1.25 = VBR/1.25× playback headroom). Local blocks are always served
   (free). This is what makes "after `bytes=0-` + 1 s, downloaded ≤ prefetch window" true.
   `bytesPerSec` = the rendition's `bitrateKbps`, else size / duration, else 2 500 kbps.
2. **CreditPool (not in the design; required for "no bans").** At a 30 s prefetch and 2.5 Mbps
   the design's lookahead requests ~144 blocks at once; hypercore pipelines 16+ requests per
   peer and every seeder cuts and bans at `uploaded − paid > 4`. Every network request first
   takes a unit from a worker-wide pool of `creditBlocks` (= the contract's
   `DEFAULT_WINDOW_BLOCKS`, 4), returned when the block's PAY is ACKed (or it came from a peer we
   do not pay, or the request died). Global across peers/cores/sessions, so no seeder's window
   can be exceeded whatever peers hypercore picks. Blocking reads are served FIFO before
   lookahead. Throughput cost: ≤ 4 blocks per payment round trip (loopback: negligible).
3. **§5(a) split made disjoint.** The design has S2 mirror the blob and S1 clear `[16, 32)`; then
   blocks `[0, 16)` may come from either seeder and "attributed to both seeders" is not
   deterministic. S2 mirrors only `[16, 32)` (as a paying, credit-gated viewer of S1), then S1
   clears it: S1 holds exactly `[0, 16)`, S2 exactly `[16, 32)`. The test asserts the split.
4. **`DevEngine` instead of the bare mock** (contract requests 1–2): the mock refuses to be paid
   for a non-prefix block set and mints colliding secrets across wallets; `DevEngine` fixes
   exactly those two things and delegates everything else. Dev and tests only.
5. **`DEV_PRICE = 2`.** The v4 split rounds the seeder share down; at 1 sat/block a one-block
   PAY carries an empty seeder set (`missing-seeder-set`). The worker pays each block as it lands.
6. **`./bare-globals.ts` instead of a literal `import 'bare-encoding/global'`.** Same effect
   (bare-encoding's root export assigned to the globals), but importing `bare-encoding/global`
   from TypeScript also loads its `declare global` block, which retypes `TextDecoder` for the
   whole worker project and broke an L6-0 test's typing. Still the entry's first import.
7. **The worker owns its swarm** (`PeerNode`) instead of the seeder's `SwarmManager`, which can
   neither bind the DHT to loopback (the D1 fence) nor hand out connections for `pay/1`
   (contract request 5). Same admission/replication calls.
8. **No providers (Stage 1 production) → no seeder, no swarm.** `play.open`/`studio.upload`
   reject `payments-unavailable:`; `ready`, `studio.ffmpeg`, `seeder.status` (disabled) work.
   `seeder.melt` is `payments-unavailable:` in every mode (Stage 2 wallet).
9. **What the viewer pays:** always the MANIFEST policy (price, split, creator P2PK). A seeder
   whose HELLO asks more per block is not paid; the mint must be one the seeder, the wallet
   AND the video accept (the host debits there).
10. **Studio sink:** the pipeline streams each rendition through the sink while hashing; the sink
    drains it and has the seeder `putFile` the (verified) file — the seeder needs a re-readable
    source — and refuses a sha256/size mismatch (`hash-mismatch`). Disk cap full →
    `process-failed` "disk cap reached".
11. **`seeder.status` approximations:** `earned.total` = mock swaps seen at flush,
    `unswapped` 0, `byMint` empty; `videos` = open cores. `seeder.configure`'s disk cap applies
    at the next start (contract request 6); `enabled` re-announces every topic immediately.
12. **Worker → host requests are validated before they leave** (`validateHostArgs`), like events
    and results.

## Security checklist items this lane owns

| Control | Where | Test |
|---|---|---|
| Playback server: 127.0.0.1, random port, 256-bit token + per-session path token, `resolve` allowlist, `CSP: sandbox`, no CORS, fixed `video/mp4` | `playback/server.ts` | `server.test.ts` (9 refusal variants incl. wrong type/token/blob/core/session, POST/DELETE; admitted count unchanged), probe, §5(a) |
| Unknown core → 404 and never opened; closed session → 404 | `playback/server.ts` | `server.test.ts`, §5(a) ("store never asked", no core in the seeder) |
| Buffer = money: pause stops requesting; downloads ≤ window (+ pacing) | `playback/gate.ts` | `gate.test.ts`, §5(a) |
| Never exceed a seeder's unpaid window (no self-inflicted bans) | `playback/credit.ts`, `pay/viewer-payer.ts` | `credit.test.ts`, `viewer-payer.test.ts`, §5(a) "no bans" |
| Pay after verify, never more than the manifest price, creator share to the manifest's P2PK, mint the video accepts, no double payment | `pay/viewer-payer.ts` (+ UpstreamPayer) | `viewer-payer.test.ts` |
| Every incoming message guarded (L6-0 guards); junk refused; corrupt frame = exit, no resync | `rpc.ts`, `entry.ts` | `rpc.test.ts` incl. 3 fast-check properties (300 runs each), `bare-worker.test.ts` |
| `--dev-mocks` fence (loopback bootstrap, loopback DHT, fixtures need mocks) | `dev/dev-mocks.ts`, `net/peer-node.ts` | `dev.test.ts` (9 cases), `host.test.ts` |
| No `console`; logs redacted, every 32-byte value cut to 8 hex, clamped | `log.ts` | `hygiene.test.ts` |
| argv-only subprocesses; configured ffmpeg path reported, never silently replaced | `ffmpeg.ts` (L8 runner) | `ffmpeg.test.ts` |
| Hashing/randomness only through libsodium; nothing implemented | `crypto.ts` | probe (sha256 vs the CAS id) |

Accepted, documented: the blob server compares its token with `!==` (not constant time) — a
same-user local process is outside the threat model (design §3), and the per-session token is a
`Map` lookup.

## What the other L6 lanes must know

**L6-B (host):**
- Spawn `dist/worker/entry.js` (the `tsc` output) with bare-sidecar. Do not bundle it naively
  (D6 finding above). The worker exits 0 when its fd 3 ends or closes (host death); `destroy()`
  is a SIGTERM (no graceful close — contract request 4). Exit codes: 3 corrupt frame, 10 no IPC,
  1 uncaught exception.
- `init` may fail (fence, storage); the worker is then half-started (its playback server may be
  listening) — restart the process, do not re-`init`.
- `ready {v, port}` is sent right after the `init` response. `port` is informational: the link
  in `play.open`'s result is the only way in.
- `spend` is per PAY, `mint` ∈ the policy's mints, attributed to the newest live session on
  that core — or, for blocks landing after `play.close`, to the last session that played it:
  **debit those too** (the proofs were minted). `peers` follows every `spend`.
- `seeder.status` is pushed (≤ 1/s) after sessions, flushes and bans change.
- Thumbnail candidates live under `<storage>/tmp/nutflix-upload-*/`; `<storage>/tmp` is emptied
  at every `init`. `studio.upload` requires dev mocks (or Stage 2 providers).
- `log` events are already redacted (and every 64-hex cut); do not re-parse them for data.

**L6-A (shell / e2e):**
- The §5(b) seam is honoured exactly as `e2e/stage1.e2e.ts` assumes:
  `NUTFLIX_DEV_FIXTURES_JSON='[{"path":…,"title":…,"description":…}]'` in the environment with
  `--dev-mocks --dev-fixtures` → the worker publishes each file (≤ 8, ≤ 512 MiB each) as a
  `dev.fixtures` video with that title/description, duration by ffprobe (6 s without it), served
  by S1 + S2 split in halves; a malformed list is logged and replaced by the worker's own 6 s
  testsrc clip. No change needed in the e2e (`fixtures-seam.test.ts` covers the seam).
- Fixture prices are 2 sats/block at `https://mint.fixture-a.example`; the WalletChip rate is
  the trailing 60 s spend of the session.

## Tests

Worker suites: **14 files, 101 tests** under `src/worker/__tests__/` (+ L8's transcode suite,
untouched: 9). All deterministic: injected clocks and fake cores for the
gate, event-driven bounded waits (`until`/`within`, clear timeout messages); the only real-time
waits are the two 1 s windows §5(a) asserts ON ("after 1 s", "no new download while paused").

| File | Tests | What |
|---|---|---|
| `two-seeders.integration.test.ts` | 3 | **§5(a)** — see below |
| `bare-probe.test.ts` | 1 | day-1 probe under real bare (20 steps, portable seeder entry) |
| `bare-worker.test.ts` | 1 | the whole entry under real bare, end to end, clean exit |
| `server.test.ts` | 5 | allowlist variants, HEAD/ranges, revoke, per-session links; the probe under Node |
| `gate.test.ts` | 11 | no `.core`, window, pacing (fake clock), credit, pause, close, idle |
| `credit.test.ts` | 7 | limit, FIFO before lookahead, settle/notify, cancel |
| `viewer-payer.test.ts` | 6 | HELLO-gated pay, manifest split, ACK FIFO match, free/unwatched, price cap, mint rule, no double pay |
| `rpc.test.ts` | 12 | dispatch, ready-after-init, codes, result/event/arg validation, rate limit, EOF/corrupt; **3 fast-check fuzzes** (bytes, request-shaped junk, any JSON) |
| `host.test.ts` | 11 | not initialised, Stage 1 no-providers paths, fence at init, sessions, MAX_SESSIONS, status push |
| `dev.test.ts` | 15 | fence matrix, identities, LoopbackPayHub pairing/close, DevEngine rules |
| `fixtures-seam.test.ts` | 13 | `NUTFLIX_DEV_FIXTURES_JSON` parsing + publish/play end to end |
| `upload.test.ts` | 2 | studio.upload with the system ffmpeg (progress, seeder, publish draft); `ffmpeg-not-found` |
| `ffmpeg.test.ts` | 6 | PATH/Windows candidates, version, configured-path rule, spawn failure, real probe |
| `hygiene.test.ts` | 8 | log redaction/clamp, no console, bare-* confinement, D6 first import, no Bare-missing globals |

### §5(a) — `two-seeders.integration.test.ts`

Local hyperdht testnet (127.0.0.1); S1 writes 32 × 64 KiB; S2 mirrors `[16, 32)` paying S1
over the loopback hub; S1 clears `[16, 32)`; the WorkerHost under Node (Node runtime,
`--dev-mocks`, same hub) driven through the real framed wire. Asserts: the split and the paid
mirror; unknown core → 404, `resolve` refused, store never asked, no core opened; `bytes=0-` held
unread + 1 s → downloads ≤ 4 (the prefetch window at 64 kbps / 30 s; the pacing term, computed
from the elapsed time, is 0 for < 6.5 s); pause + window grown to 600 s → no new request/download
for 1 s; resume → all 32; exact bytes: the held `bytes=0-` body (206), a full GET (200,
`video/mp4`, `CSP: sandbox`, no CORS), mid-file 206 with `Content-Range`, 416 at and past the end;
blocks `[0,16)` from S1's Noise key and `[16,32)` from S2's; viewer engine spend = 32 × 2 = 64 =
Σ `spend` events (mint = the video's); last `peers` = both seeders × 16 blocks; each seeder engine
after flush: `uploaded 16 = paid 16`, outstanding 0, nothing pending; no bans in any seeder, ban
list or engine; close (twice) → 404, then `session-closed`; no frame refused by the host guard.

**Runtime:** 2.1–2.4 s for the three tests (≈ 3.3 s file incl. transform) idle; **5/5 green in a
row**; green **while `npm run ci` ran its test phase in another process** (load ≈ 6–7): 6.1 s.

`npm run ci` (after merging `778b32d`, on `91b3c2d`): **exit 0** — lint + prettier, build,
**123 test files, 2070 passed / 27 skipped** repo-wide, check:locked OK, check:native OK (42),
lint:electron OK (158 files, 0 violations).

## Open questions / decisions

1. **Contract requests 1–3 (core):** index (or the count rule) for `range-not-uploaded`, mock
   secret namespacing, `core` on ACK/PRICE and `windowBlocks` in HELLO. Until then every dev
   path goes through `DevEngine` and a 4-block credit window.
2. **Contract request 4:** a `shutdown` worker request (graceful stop from a live host).
3. **Credit window vs throughput:** 4 blocks per round trip is fine on loopback and LAN; over
   a 100 ms WAN it caps a viewer at ≈ 2.6 MB/s. Stage 2 may want a larger negotiated window.
4. **Requests nobody can serve hold credit** until the block arrives (the gate never cancels a
   request — a cancel after the seeder sent would leave that block unpaid forever). A future
   timeout-and-forget needs the index-aware accounting of request 1.
5. **Seeding what you watch:** watched cores are opened in the seeder and announced when
   seeding is on; they do not count against the disk cap (the CAS index only knows `put` blobs).
