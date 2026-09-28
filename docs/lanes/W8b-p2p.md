# Lane W8b-p2p — round-8 findings on pay/1 and the worker

Branch `stage-3/r8-p2p`, off `aca2d6a` (the merged Stage 3 head). Takes the eleven findings of the
final cross-lane review panel on pay/1 and the desktop worker (`review:protocol`,
`review:tests`), with the orchestrator's decisions on them. Date: 2026-09-27.

- Commits: `ed8f124` (payer, viewer payer, unpaid record), `d6271aa` (seeder: persisted core
  policies, shared opens, the profile core), `25f5951` (the router's `room`), `21db130` (test
  integrity), `0121eab` (ADR notes), `675d8f1` (tests for the two mutations that survived the
  first round), then this record and the review record.
- Review record: `docs/reviews/2026-09-27-pre-push-p2p.md` — each finding verified and
  reproduced, the fix, the differential review and sharp edges, the mutation table, residuals.
- ADR notes: 0015 and 0018 gain "round-8 fixes" paragraphs.
- No contract request. Nothing under `packages/core/src/contracts/`, `docs/status.md` or
  `docs/security-review.md`; under the locked paths only a test comment
  (`npm run check:locked`: OK).
- Nothing outward: no push, MR or issue edit.

## Outcomes

| # | Finding | Outcome |
|---|---|---|
| 1 | [medium] an OWED on a second link of one seeder pubkey pays blocks pending on the first | **fixed**: never a block another live connection of that pubkey holds pending or in flight |
| 2, 7 | [medium, low] an owed range failing for 30 s with a temporary error leaves the record | **fixed**: never given up for a transient failure; retried, then on the deferred cadence; kept |
| 3 | [low] two image reads of one profile core open two sessions, one left ungated | **fixed**: one shared open per core |
| 4 | [info] the payer's free set unbounded, disagreeing with the settler's | **fixed**: one bounded answer (`servesFree`); prices bounded too |
| 5 | [info] free requests counted past the window when a core turns sold mid-flight | **fixed**: free requests share the window while in flight (router `room`) |
| 6 | [medium] after a restart an image read marks a stored paid video free | **fixed**: per-core policies kept across restarts |
| 8 | [low] a PAY's removal from the record lands only in the next batch | **fixed**: written ahead of the send when the blocks had reached the file |
| 9 | [info] our own profile core marked free after its open | **fixed**: free when ready, before its upload gate |
| 10 | [info] file-wide timeouts without a reason | **fixed**: stated, measured reasons |
| 11 | [info] `bare-exit` skips without `dist/` | **fixed**: fails under `NUTFLIX_REQUIRE_BUILT=1` (and `bare-dleq-thread`) |

Found in the lane's own review and fixed: with prices kept across restarts, a hostile manifest
naming OUR profile core as a video would have priced it for good. The worker refuses such a play
open and drops a price an earlier run left on it.

## How each was decided

- **Dedupe per pubkey, not over every link** (1). The reviewer's `settler.owes(core, i)` spans
  every seeder; a block now downloaded from Q and left unpaid at P by an earlier run is owed to
  both. Only connections of the same HELLO pubkey share a record entry, so only they are
  compared. The block goes to the connection that holds it; if that one drops it unpaid, the
  record keeps it for the seeder's next report ("waits").
- **"Wait on backoff" means on the same connection** (2/7). A scope-`connection` give-up would have
  kept the record but left the blocks unpaid until a reconnect, while the seeder's window stays
  full (the reviewer's starvation). The owed range stays owed instead, retried on the transient
  backoff and past `PAY_GIVE_UP_MS` every ≤ 30 s. Owed and fresh blocks back off on separate
  streaks so a long owed retry never holds this connection's blocks back. A core no longer priced
  on the connection now drops owed blocks with scope `connection` too (kept in the record).
- **Viewer side for 5.** The seeder cannot tell a request made while it said free from one made
  after (hypercore reports uploads, not request arrivals), and a gateway paying that core counts
  the same blocks as sold. So the viewer keeps free requests inside what the seeder may still
  count, while in flight; they still never become debt. Cost: images from a seeder whose window is
  full of video wait for room.
- **Persist the prices, don't guess from the disk** (6). Refusing free for any core already on
  disk would also refuse honest image replicas an earlier run cached. The seeder's per-core
  policies are kept in `core-policies.json` and loaded back, so the existing rule (`setFreeCore`
  refuses a core with a policy; the worker refuses a known-sold core) holds across restarts — and
  a stored video is priced again after a restart instead of served unpriced.
- **Write-ahead, not "prove it cannot double pay"** (8). It can: after a crash the host keeps the
  session's remaining budget as a tail, and a seeder that reports blocks it was already paid for
  would be paid again under it. The removal is written before the send — only when a removed
  block had reached the file, so most PAYs cost no write.
- **Shared opens** (3): the first of the reviewer's two options; it also removes the leak when a
  name open and a key open of one core race.

## Confirmed with tests

32 new tests, each failing before its fix (see the mutation table in the review record):

- gateway `upstream-payer` (7): an owed range never given up and paid on the same connection
  after 90 s of `no-balance`; separate streaks both ways, and one retry pass with both kinds due;
  scope `connection` when no longer priced, none for `forbidden`; `holds`; `servesFree` as the
  answer; bounded free set and prices.
- gateway `seeder-credit` (1): `roomOf` and the router's cap through it.
- seeder `one-peer-router` (1): the `room` option on real Corestores.
- seeder `blob-store` (3), `seeder` (3), `core-policies` (3): shared opens, the rename race, a
  failed open; policies across a restart, the file checked on load, `openCore(free)` before the
  gate; the store's bound, coalesced writes and write failures.
- app-desktop `viewer-payer` (8): the reviewer's double pay, a block being paid as owed on another
  link, a dropped block paid on the next report; `no-balance` and `internal` for 45 s then paid;
  no longer priced kept in the record; the file at each send; no write for a block paid within a
  batch.
- app-desktop `unpaid-record` (3): `removeNow` writes only when needed, a re-recorded block, a
  failed write.
- app-desktop `images-paid-core` (3): two concurrent reads share one session and it is closed;
  after a restart with seeding on, the attacker's thumbnail of a played video and of an upload is
  refused (an honest image still loads); our profile core never priced.

## Gates

- Tests of the touched packages (`seeder`, `gateway`, `app-desktop`; `--maxWorkers=2`), mid-lane:
  159 files, 2 498 passed, 30 skipped; two packaging files failed only because a source was
  edited during that run ("a workspace build is older than its sources"): both passed in the whole
  suite below. Every changed test file passed again after the last change.
- The whole suite, once, after `npx tsc -b --force` and `npm run build`
  (`npx vitest run --maxWorkers=2`): 241 files — 235 passed, 5 skipped, 1 failed; 3 860 passed,
  30 skipped, 1 failed; 915 s. The failure was a timing one outside the diff
  (`host/__tests__/money.test.ts`, "onPayment names the mint…", 5 s default): re-run alone it
  passed (3.3 s; the file 17/17). No timeout raised.
- `npx tsc -b --force`: clean (83 s). `npm run build`: clean.
- eslint and `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK. `npm run lint:electron`: OK (263 files, 0 violations).
- Real mints, opt-in (money paths changed: the payer's owed retries and scope, the router, the
  seeder's persisted prices): `NUTFLIX_REAL_MINT_URL` at Nutshell `:3399` and cdk-mintd `:3397`,
  each passing — gateway `real-mint-swarm` + seeder `owed.integration` 11/11;
  app-desktop `desktop-owed` 4/4 (TestMint, the worker's owed path end to end); app-desktop
  `topup-real-mint` 1/1 (with `NUTFLIX_REAL_MINT_URL_2=:3398`).
- Mutation checks: 31, all killed (the table is in the review record).
- No Electron e2e (as briefed).

## Residuals

See the review record's Residuals; in short: a hostile manifest's price on another creator's
profile core is sticky; a corrupt policy file starts empty (logged); an image read of our own
profile core racing its first open (pre-existing); the write-ahead's synchronous write; a PAY
built for a connection that closes meanwhile (pre-existing); images wait for room at a full
seeder; `NUTFLIX_REQUIRE_BUILT=1` is set by no gate yet.

**Proposed for the CI owner** (outside this lane): set `NUTFLIX_REQUIRE_BUILT: '1'` in the test
job of `ci/gitlab-ci.yml` (it runs after the build), so the real-Bare tests fail instead of
skipping there.

## Proposed row for `docs/status.md`

| W8b-p2p — round-8 findings on pay/1 and the worker | `stage-3/r8-p2p` | DONE. Eleven findings of the final panel (3 medium, 2 low, 6 info), all fixed with tests that fail before the fix:<br>• an OWED on a second node of one seeder key never pays a block pending on the first (the reviewer's double pay);<br>• an owed range failing for now is never forgotten: retried on its backoff and paid on the same connection (separate streaks from fresh blocks);<br>• a PAY's blocks leave the unpaid record on disk before the PAY is sent;<br>• per-core prices kept across restarts: an attacker's thumbnail can no longer make our node serve a video it played or uploaded free; our own profile core is never priced;<br>• one Hypercore session per core under concurrent opens; our profile core free before its gate;<br>• free image requests share the seeder's window while in flight; one bounded answer for `free`;<br>• stated timeout reasons; `NUTFLIX_REQUIRE_BUILT=1` makes the real-Bare tests fail instead of skip.<br>Review `docs/reviews/2026-09-27-pre-push-p2p.md` (31 mutation checks) |

## Addendum — F54 (the round-8 verifier, medium; 2026-09-27)

**The tests are written but NOT run, pending CI** (GitHub Actions). Cameron's rule of 2026-09-27
allows no test runner on this machine. What each test would catch is reasoned against the code in
the review record's F54 addendum (five mutation checks, none run).

| # | Finding | Outcome |
|---|---|---|
| F54 | Kept core policies made the worker's HELLO ceiling permanent, and desktop viewers refused any seeder whose HELLO was above the manifest price | **fixed**, in two places. The ceiling is `servedPriceCeiling`: the highest price among the cores open in this run, never a policy kept from an earlier one, while kept policies still refuse free. `ViewerPayer` no longer compares the HELLO with the manifest: `UpstreamPayer` compares the price asked for the blocks (the core's `PRICE`, else the HELLO), and the host still refuses terms above the manifest |
| F54 (second half) | Incoming PAYs checked against a kept policy that may be stale | **deferred**. Read from the code, a kept policy prices only owed blocks from an earlier run, at the terms they were sold at. A mismatch needs two manifests naming one core, as within one run before. It needs its own decision (like D2) |

- Commit: `e753de0` (the fix and its tests), then these notes.
- New test file: `packages/app-desktop/src/worker/__tests__/hello-ceiling.test.ts`. It covers a
  restart of a real `Seeder`: the ceiling is 0, then 2, while `setFreeCore` stays refused.
- Two new tests in `viewer-payer.test.ts`: a HELLO ceiling above the manifest is paid at the
  core's `PRICE`, and a `PRICE` above the manifest is not paid whatever the HELLO says.
- ADR 0012 §4 has an F54 amendment note.
- Static gates only: `npx tsc -b` (clean, and the new file is proven to be type-checked), eslint
  and prettier on the changed files, `check:locked`, the electron security lint, and
  `npm run build`, all clean.
- Residual: the host's one-line wiring of `priceCeiling` is covered by `tsc` alone.

## Round 9 (the static reviewer of the F54 fix; 2026-09-28)

**The tests are written but NOT run, pending CI** (GitHub Actions). Cameron's rule of 2026-09-27
allows no test runner on this machine. What each test catches is reasoned against the code in the
review record's Round 9 section (eleven mutation checks, none run; two survive, both explained
there).

| # | Finding | Outcome |
|---|---|---|
| F57 | Corestore 7.12.2's `replicate` opened any core in storage that a remote named by discovery key, and served it without the seeder's upload gate: no `PRICE`, nothing counted. After a restart, a sold core could be fetched free | **confirmed by reading `node_modules`, fixed**. BlobStore's Corestore (`GatedCorestore`) replaces that catch-all on every stream. A remote may open only a core BlobStore has open, which is the gated session. Anything else is refused. This covers the desktop worker, the daemon and the gateway, since all of them replicate through `blobs.store`. A core that is already open reached this way was always the gated one: it is the same `Core`, and `upload` goes to every listening session |
| low (money) | `UpstreamPayer` kept one `PRICE` per core, so blocks pending below a second `PRICE` were asked at the HELLO's price (0 at a fresh desktop seeder). That built a 0-sat PAY, which the seeder refuses, and dropped the blocks from the viewer's record | **fixed**. Price segments per core: each `PRICE` applies from its `effectiveFromBlock`, and one from block 0 replaces the rest, as the seeder keeps them. There is never a 0-sat PAY for a core whose manifest price is above 0. Such blocks stay pending, and owed ones are given up on that connection only |
| low | The host's `priceCeiling` closure had no test, only the helper | **fixed**. `hello-ceiling-host.test.ts` captures the closure `host.ts` passes to `realProviders` and checks it after a restart: 0, then 2, then 5 as videos open |
| low (record) | The F54 addendum's claim that a lower ceiling cannot make a payer underpay | **corrected** in the review record, struck through with the reason |

- Commit: `faa329a` (the fixes and their tests), then these notes.
- New tests, written and not run:
  - `packages/seeder/src/__tests__/stored-core-gate.integration.test.ts` covers
    `Seeder.replicate` and `blobs.store.replicate`. A stored, sold core that is not open is not
    served. Once opened, it is served with its `PRICE` first and counted.
  - `packages/app-desktop/src/worker/__tests__/hello-ceiling-host.test.ts`.
  - Four new tests in `packages/gateway/src/__tests__/upstream-payer.test.ts`.
- Changed code:
  - `packages/seeder/src/blobs/blob-store.ts` (the gate).
  - `packages/seeder/src/types/holepunch.d.ts` (the muxer's type).
  - `packages/gateway/src/upstream/payer.ts` (the segments and the zero guard).
  - Comments only in `seeder.ts`, `peer-node.ts` and `real-providers.ts`.
- Behaviour change: after a restart, a node serves a stored core only once it opens it again (the
  next play or upload on the desktop; at start for the daemon's configured cores). Opening all of
  storage again at start, gated, would be a feature of its own.
- Residuals:
  - R9-a (pre-existing, free image replicas only): a core closed by `closeCoreByKey` stays
    attached to the connections it had while the peer keeps downloading, and for Hypercore's
    20–40 s linger.
  - R9-b (pre-existing): blocks sent before a connection's first `PRICE` are asked at the HELLO's
    price. After round 9 that is never a 0-sat PAY.
  - R9-c: the 64-segment bound per core.
- Static gates only, all clean:
  - `npx tsc -b`. Each new test file is proven to be type-checked by a deliberate error, which was
    then removed.
  - eslint and prettier on the changed files.
  - `check:locked`, the electron security lint and `npm run build`.
