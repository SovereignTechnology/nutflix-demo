# Pre-push review: the viewer pays what a seeder reports, and reads images only where "free" (2026-09-26)

Diff: `ea9d4dc` (this lane's base: `54f49bb`, with `stage-3/owed-seeder` and
`stage-3/int-reconcile` merged in) → `stage-3/owed-viewer`: `d06300e`, `8ae3f1a`, `17c838d`,
`3340a41`, and this record.

- **Method.** `differential-review` and `sharp-edges`, inline, on the whole diff. No subagent tool
  was available in this environment, so the adversarial pass is this author's own; see
  "Coverage limits".
- **Decisions.** Cameron 2026-09-26: the amendments at the end of ADR 0018 (the seeder's count,
  paying an old tail) and ADR 0015 (seeders say "free").
- **Lane record.** `docs/lanes/P2-owed-viewer.md`.

## Executive summary

| Severity | Found | Fixed in the lane | Open (residual) |
| -------- | ----- | ----------------- | --------------- |
| HIGH     | 0     | 0                 | 0               |
| MEDIUM   | 2     | 2                 | 0               |
| LOW      | 4     | 4                 | 0               |
| INFO     | 3     | 1                 | 2               |

Accepted residuals (R1–R8, below) are documented design limits, not open defects.

- **Overall risk: MEDIUM-HIGH.** The diff moves value: a closed session's tail becomes new
  spending authority on the host. It also changes what the viewer asks every seeder for, before
  and after that seeder's report, and a wrong budget there means a persisted ban. And it removes
  code from a security-fix commit (`dde4f2d`, fix round 4).
- **Recommendation: SHIP with the residuals below.** The whole suite is green: 3442 passed, 0
  failed, and the three known base failures owned by lane R6 pass after the merge.
  - The four reviewer scenarios of the unpaid tail pass end to end against a seeder daemon over
    hyperswarm, through the real framed IPC and the host money plane: graceful close, crash,
    over-claim, expiry.
  - The three image scenarios pass on the testnet.
  - 45 mutation checks are all caught. Two needed a new test first (M13, M40).
- **Files.** 43 changed, all read:
  - 18 source files: 6 in `gateway`/`seeder`, 12 in `app-desktop`. None is in a locked path, and
    no contract changed.
  - 22 tests: 5 new files.
  - 3 docs: 2 ADR sections and 1 contract request.
- **Blast radius:**
  - `SeederCredit.budget` is read by hypercore before every request to every seeder, on the
    desktop and on the gateway.
  - `OnePeerRouter` routes every core both compositions download.
  - `MoneyPlane.payBuild` gates every PAY the desktop makes.
  - `revokeSession` has 3 production call sites (the adapter's two; `close()` converts).
  - `play.close` has 1 host caller (`HostPlaySession.closeAsync`).

## Scope and risk

- **HIGH** (value transfer, authorisation, the ban window):
  - `app-desktop/src/host/money.ts`. `pay.build` accepts a closed session's tail, `revokeSession`
    creates tails, and `close()` converts open sessions.
  - `app-desktop/src/host/tails.ts` (new). The persisted authorisations.
  - `gateway/src/upstream/seeder-credit.ts`. Credit from the seeder's report, the pre-report
    rule, the durable ledger, and free-only image budgets.
  - `seeder/src/net/one-peer.ts`. The `single` and `free` options, `forgive`, and which requests
    count as debt.
  - `gateway/src/upstream/payer.ts`. `addOwed` and the owed engine pay money; a free PRICE is no
    longer a price.
  - `app-desktop/src/worker/pay/viewer-payer.ts`. `OWED` ∩ record, the owed bound and policy.
  - `app-desktop/src/worker/pay/unpaid-record.ts` (new). The durable record and the write-ahead
    ledger.
- **MEDIUM:**
  - `app-desktop/src/worker/host.ts`: the image path, the record's lifecycle, `play.close`'s
    count.
  - `ipc/worker-protocol.ts` and `ipc/worker-guards.ts`: the new `play.close` result.
  - `host/sessions.ts` and `host/adapter.ts`: `unpaid` passed on.
  - `host/host.ts`: quit waits for the tail writes.
  - `gateway/src/upstream/settle.ts`: `onAck`, `owedByOn`, `servesFree`.
  - `worker/pay/real-providers.ts` and `worker/dev/dev-mocks.ts`: `payOwed`.
- **LOW:** `gateway.ts` (the settler's `servesFree`, a comment), `worker/providers.ts` (a type),
  the test support files, and the docs.

## Removed code (history)

Removed from the fix-round-4 security commit `dde4f2d` ("image reads cannot overrun a paid core's
seeders"):

- the router's `probe` option;
- `SeederCredit.probing`, `onImageVerdict`, `verdict` and the per-seeder `priced` memory;
- `MAX_IMAGE_VERDICTS_PER_SEEDER`;
- the worker's `imageSold` / `imageFree` sets, `onImageVerdict`, and the read's `stops` and
  `stopped` race.

Justification:

- **The property that commit protected still holds, strictly stronger.** It protected "an image
  URL naming a paid core never overruns or bans". Before, each seeder was asked one block before
  it could answer. Now no block is asked of any seeder that has not said `free`. It is pinned by
  `images-paid-core.integration` (`sent` is 0, and a priced PRICE for the core did reach the
  worker) and by `images-free-only.integration`, scenario 3.
- **The known-sold refusal (`soldCore`) stays:** a manifest policy here, a routed core, a core
  our own seeder prices. `images-paid-core` "once played, refused" pins it (M34).
- **The removed memory "sold somewhere and free nowhere → refuse" was itself a defect** under
  the amendment. It stopped an honest free image the moment a gateway that prices the same
  profile core answered first, and refused that image for the rest of the process.
  `images-free-only`, scenario 1, pins the corrected behaviour.
- **Two assertions of the old tests encoded the probe:** "the probe reached a seeder" and "a
  second read is refused at once". They were replaced, each with a comment citing the amendment
  and a non-vacuity check in its place (the PRICE spy). Neither was deleted outright.

## Findings

Each finding: where it is, the scenario, the fix, and the mutation check that pins it.

### MEDIUM

**F1: a seeder that takes a PAY and drops before its ACK is paid again for the same blocks.**
Fixed in `8ae3f1a`.

- **Where.** `viewer-payer.ts:173` and `:240`, in `d06300e`. Recorded blocks left the record only
  on an ACK.
- **Scenario.** A malicious seeder reports block 5 owed. The worker pays under the tail
  authorisation. The seeder keeps the proofs, drops the connection without ACKing, reconnects,
  and reports block 5 again. The record still held it, so it was paid again, and again, until the
  host's budget ran out. With a mid-session reconnect, that is the session's whole budget:
  `2 × blob + window`.
- **Fix.** A block leaves the record the moment a PAY is built for it, the same rule
  `UpstreamPayer` already applies to a refused PAY: never paid twice. A PAY built but not sent (its
  connection closed during the build) then leaves those blocks unpaid. That is respected, never
  overrun, and rare.
- **Test.** `viewer-payer.test` "a PAY built for recorded blocks takes them out at once…".
  **Mutation:** M24.

**F2: replies to requests made before a seeder's `pay/1` attached could complete its report
early.** Fixed in `8ae3f1a`.

- **Where.** `seeder-credit.ts:635`, `delivered()`.
- **Scenario.** A gateway session replicates before `onSessionReady` attaches `pay/1`. The peer
  is unknown then, so its budget is `NO_PAY_INFLIGHT`. Requests go out, `pay/1` attaches, both
  HELLOs verify, and the seeder writes its `OWED`. But the replies to the pre-attach requests were
  queued before the report on the stream. The first one to land completed the report with no
  claims. The gateway then asked up to its full window on top of what the seeder counts, and was
  banned. The desktop is not exposed: `PeerNode` attaches `pay/1` synchronously at connection,
  and the budget before HELLO is 0.
- **Fix.** The requests in flight when `pay/1` attaches (`early`) are counted, and that many
  deliveries do not complete the report.
- **Test.** `seeder-credit.test` "replies to requests in flight when its pay/1 attached…".
  **Mutation:** M17.

### LOW

**F3: a tail authorisation was worth a closed session's whole remaining budget.** Fixed in
`8ae3f1a`.

- **Where.** `money.ts:587` `keepTail`; `tails.ts:139`.
- **Scenario.** A compromised worker answers `play.close` with a huge `unpaid`, or crashes itself,
  which gives `null`. The host then kept `budgetBlocks − paidBlocks`, up to twice the blob, as
  spending authority for 7 days. The total a session could spend was not raised, but the window
  in which it could be spent was.
- **Fix.** Every tail is capped at `MAX_TAIL_BLOCKS` = 1024: the downloader's pool cap, so no
  honest close leaves more. A file entry claiming more is refused at load.
- **Test.** `tails.test` "a tail is never more than MAX_TAIL_BLOCKS…". **Mutation:** M31.

**F4 (sharp edge): `MoneyPlane`'s `tailDir` was optional.** Fixed in `8ae3f1a`.

- **Where.** `money.ts:120`.
- **Scenario.** A composition that forgot `tailDir` kept tails in memory only, silently. After a
  restart, every old tail is refused: respected, not paid.
- **Fix.** Required, like `journalDir` ("so no caller loses durability by leaving it out"). The
  12 test call sites pass `null` explicitly.
- **Pinned by:** the type.

**F5 (sharp edge): `reportWaitMs: 0` took every report as complete at once.** Fixed in
`8ae3f1a`.

- **Where.** `seeder-credit.ts:256`.
- **Scenario.** 0 is a plausible "no wait" value. It completed the report before the seeder's
  `OWED` could arrive, and undid the pre-report rule.
- **Fix.** Only a positive finite wait is taken; anything else is the default (10 s). The option
  is test-only in practice (`WorkerHostOptions`, never over IPC).
- **Test.** The junk values in `seeder-credit.test` "a report is complete REPORT_WAIT_MS…".
  **Mutation:** M18.

**F6: mutation-check gaps.** Fixed in `3340a41`. Two guards had no test that could see them:

- The truncated-report cut (M13). In the caps test, the claimed blocks alone already exceeded the
  window. The malformed-report case now completes the report and still asks nothing.
- The settler's `servesFree` (M40). The desktop tests read the built gateway, so a gateway `src`
  mutation is invisible to them. It now has a gateway-side unit test, including a throwing
  predicate (M42).

### INFO

**I1: a free core's requests counted as debt when `pay/1` closed before hypercore's
`peer-remove`.** Found during the build and fixed before `d06300e`.

- If `servesFree` depended on the connection being live, a free read in flight at a disconnect
  became debt. The free word therefore outlives the close and is reset by the next connection
  (`seeder-credit.ts:444`).
- A reconnect whose `attachPeer` runs before the old connection's `peer-remove` still counts the
  old free requests. That errs toward debt: the safe side.

**I2: the write-ahead ledger writes about once a second per seeder being streamed from.** Open,
accepted.

- The `full` word is set synchronously (an atomic snapshot rewrite with fsync) inside the budget
  read, before an ask that could reach the window. The next flush clears it once the seeder is
  below its window, and it is set again at the next such ask.
- The snapshot is a few kilobytes.

**I3: an honest free image whose only holders never say `free`** (older or third-party seeders)
**shows the placeholder** after `IMAGE_FETCH_TIMEOUT_MS`. Open: as ADR 0015's amendment states.

## Adversarial analysis

**A. A compromised worker against the host money plane.** The worker handles peer data and is
less trusted.

- **Tails.** The worker controls `unpaid` at `play.close`, and can crash to get `null`. So it can
  keep up to `MAX_TAIL_BLOCKS` of each closed session's remaining budget as spending authority for
  7 days. Every tail PAY is still checked like a session's:
  - the session's core;
  - a range inside its blob;
  - the manifest terms: creator key, split, block size, mints, a price at most the manifest's;
  - a mint the manifest lists.

  It can therefore pay only that video's seeders and creator, on those terms. The seeder pubkey,
  P2PK and mint are worker-supplied, as for any PAY. Residual R1.
- **Sids.** Tails are keyed by host-minted 128-bit sids, and the worker cannot mint one. An unknown
  sid is `session-closed`, an expired one `forbidden`.
- **Races.** A tail PAY's blocks come off the budget on disk before the build (`money.ts:546`).
  Two concurrent PAYs cannot both pass the budget check: the check and the increment are
  synchronous, before the first await. A failed write refuses the PAY (M32).

**B. A malicious seeder.**

- **Over-claiming.** It is respected, never paid: `OWED` ∩ record only (M23). Every `ACK` re-bases
  to its `outstanding` (M9, M11). Its credit shrinks and nobody else's does.
  `desktop-owed` scenario C pins "never beyond window minus the claim" against a real engine.
- **Under-claiming.** We then ask more, and it can cut us, which it could do anyway. It gains
  nothing.
- **Take and drop.** F1, fixed.
- **Junk `OWED`** (the loopback end does not run the codec). Taken as truncated: that seeder is
  asked nothing more on that connection (M13).
- **Never completing its report.** One block at a time, and `REPORT_WAIT_MS` ends the wait.
- **Lying `free` for a paid core.** We read that core's blocks from it free. Any `OWED` for them
  later is not in the record, so it is never paid. Its own lie costs only itself.
- **Lying `free` for an image core, then counting.** It can only ban us from itself.

**C. A malicious thumbnail URL naming a paid core.** Nothing is asked of any seeder that prices
it, and our own seeder marks the replica free only while the read lasts. Pinned by
`images-free-only` scenario 3, `images-paid-core`, and M6/M7/M8.

**D. A local attacker who can edit the worker's record or the host's tails** (same user; outside
the threat model).

- A forged record entry can make the worker offer a PAY only under an existing host
  authorisation's terms and budget.
- A forged `full` word only delays a seeder by up to `REPORT_WAIT_MS`.
- The tail file must be a private regular file (0600, owned by the user, not a symlink); anything
  else is refused and replaced.

## Sharp edges (API surface)

| API | Edge probed | Verdict |
| --- | --- | --- |
| `OnePeerRouter` `free` | throw, misuse on a paid core | A throw counts (M5). `SeederCredit` only says free for image cores that are not payable. |
| `OnePeerRouter` `single` | throw | A throw narrows (the probe's rule, kept). |
| `forgive(remote, n)` | 0, negative, NaN, ∞, unknown remote | Ignored (tested). |
| `SeederLedger` | a throwing `fullBefore`, `markFull` | `fullBefore` throwing → full (asks nothing before the report). `markFull` failing → credit held below the window (M16). |
| `reportWaitMs` | 0, negative, NaN, ∞ | The default (F5). |
| `CreditSettler.servesFree` | throw | Owed (M42). |
| `UpstreamPayer.addOwed` | no owed engine, no priced PRICE, a free core, closed peer, junk indexes | Takes nothing (M20, M22); junk skipped. The gateway cannot pay an old tail by construction. |
| `UnpaidRecord` | `flushMs` < 10, a bad pubkey, bad terms or index, a damaged file, `abandon()` | Clamped / throws / refused / an empty record (logged by count). `abandon` is named for tests and used only there. |
| `TailBook` | `dir: null`, a non-private file, a future-dated or oversize entry | Memory (tests; `tailDir` is required now); refused; dropped (M37). |
| `revokeSession(sid, unpaid = 0)` | default, junk | The default makes no tail: forgetting it never creates spending authority. Junk → 0; `null` = unknown → capped remaining. |
| `play.close { unpaid }` | shape | Exact keys, `int(0, 2^20)` (M33). |
| `WorkerHostOptions` test bounds | junk | Programmatic only, never over IPC. A bad `imageTimeoutMs` fails the read (safe); `unpaidFlushMs` is clamped. |

## Mutation checks

Each breaks one guard in `src`, runs the named tests (`scratchpad/…/mutate.py`), and restores it
with `git checkout`. All 45 are caught.

| # | Guard broken | Caught by |
| - | - | - |
| M1 | router: a released free core remembers its requests as lost | one-peer-router "free option" |
| M2 | router: `used()` counts a free core's load | one-peer-router "free option" |
| M3 | router: a free core capped by credit − used | one-peer-router "free option" |
| M4 | router: `single` ignored | one-peer-router "single option"; seeder-credit "before its report" |
| M5 | router: a throwing `free` reads as free | one-peer-router "free option" |
| M6 | credit: an image core asked of a seeder that never said free (a probe back) | seeder-credit image cores (4 tests) |
| M7 | credit: an image core asked before the channel is open | seeder-credit image cores |
| M8 | credit: any PRICE counts as free | seeder-credit image cores (2) |
| M9 | credit: the report not subtracted after completion | seeder-credit report (6); upstream-payer gateway "stays under what the upstream reports" |
| M10 | credit: the report so far ignored before completion | seeder-credit report (3) |
| M11 | credit: `ACK.outstanding` re-based a block too low | seeder-credit "an ACK completes the report…" |
| M12 | credit: the report does not replace in-process debts | seeder-credit "the report replaces our estimate…" |
| M13 | credit: a truncated report not enforced | seeder-credit "at the caps (or malformed)" (after F6) |
| M14 | credit: the ledger's earlier-run word ignored | seeder-credit durable ledger (2) |
| M15 | credit: no write-ahead mark | seeder-credit "write-ahead" |
| M16 | credit: a failed ledger write not capping the credit | seeder-credit "cannot be written" |
| M17 | credit: pre-attach replies complete the report | seeder-credit "in flight when its pay/1 attached" |
| M18 | credit: a report wait of 0 taken | seeder-credit "REPORT_WAIT_MS" |
| M19 | payer: a free PRICE becomes a 0-sat price | upstream-payer "not a price" |
| M20 | payer: owed blocks taken without the core's priced PRICE | upstream-payer owed |
| M21 | payer: owed and fresh blocks share a PAY | upstream-payer "paid at once and apart" |
| M22 | payer: owed blocks paid with no owed engine (the gateway) | upstream-payer owed |
| M23 | viewer: an OWED paid in full, not only what the record holds | viewer-payer "an OWED: only reported blocks…" |
| M24 | viewer: a built PAY leaves its blocks in the record (F1) | viewer-payer "not paid twice" |
| M25 | viewer: blocks from a free-serving seeder owed | viewer-payer "serves free" |
| M26 | viewer: given-up blocks leave the record (no tail) | viewer-payer "given up stays" |
| M27 | host: a tail pays another core | tails "checked like an open session" |
| M28 | host: a tail's budget unchecked | tails "its budget" and one more; topup-host "tail authorisation on the money plane" |
| M29 | host: an expired tail still pays | tails "persisted…expired" (2) |
| M30 | host: the worker's unpaid count ignored | tails "its budget"; topup-host (3 in all) |
| M31 | host: no `MAX_TAIL_BLOCKS` cap | tails "never more than MAX_TAIL_BLOCKS" |
| M32 | host: a tail PAY built before its budget is on disk | tails "persisted" (a failing write must refuse) |
| M33 | guards: `play.close` accepts any result | worker-guards |
| M34 | worker: a known-sold core read as an image | images-paid-core "once played, refused" |
| M35 | record: a block outside its session's blob recorded | unpaid-record "refuses what cannot be paid later" |
| M36 | record: `markFull` claims success without a durable write | unpaid-record SeederLedger (2) |
| M37 | tails: malformed entries loaded | tails "drops malformed…" |
| M38 | session: `onSettled` told 0 whatever the worker reported | adapter-play "onSettled learns…"; topup-host |
| M39 | adapter: the unpaid count dropped at revocation | topup-host "tail authorisation on the money plane" |
| M40 | settler: blocks from a free-serving seeder owed on arrival | seeder-credit "CreditSettler — servesFree" (after F6) |
| M41 | payer: owed blocks paid after their core turned free | upstream-payer "turns free after" |
| M42 | settler: a throwing `servesFree` reads as free | seeder-credit "CreditSettler — servesFree" |
| M43 | worker: no durable record | desktop-owed A (end to end) |
| M44 | worker: a tail paid under another session id | desktop-owed A (the host refuses it) |
| M45 | record: the earlier run's "whole window" word ignored after a restart | desktop-owed A: **the daemon bans the viewer** ("the seeder banned the viewer (an overrun of its window)"). This is the end-to-end evidence that the write-ahead ledger is needed. |

## Tests

New test files:

- `images-free-only.integration`: the image scenarios.
- `desktop-owed.integration`: the tail scenarios A–D against a seeder daemon.
- `unpaid-record.test`.
- `tails.test`: the `TailBook` and the money plane's tails.

Extended test files:

- `one-peer-router`: `single`, `free` on two cores over one stream, `forgive`.
- `seeder-credit`: free-only images, the report, the ledger, the settler's `servesFree`.
- `upstream-payer`: free PRICE, owed, and a gateway against a real seeder's report.
- `viewer-payer`: record, `OWED`, never paid twice, free.
- `adapter-play` and `topup-host`: `unpaid` passed on; a tail on the real plane.
- `worker-guards`, `rpc`: `play.close`'s result.

Corrected, each with a comment citing why:

- `images-paid-core`: tests 2 and 3, and one outstanding check that allowed a probe block;
- `rpc.test`: its void-result case now uses `play.pause`;
- `worker-guards.test`: the `play.close` result;
- `topup-host` and `fake-worker`: `play.close` returns `{ unpaid }`;
- the rig and `main.test` teardowns wait for the tail writes.

No test was deleted or weakened. The fix-round-4 probe tests went with the probe; their
replacements pin the stronger rule.

Real mints (`NUTFLIX_REAL_MINT_URL` at Nutshell 0.21.0 `:3399`, with `_URL_2` `:3398`, and
cdk-mintd 0.18.1 `:3397`):

- `gateway/real-mint-swarm.integration` and `seeder/owed.integration`: 11 of 11 at each mint.
- `desktop-owed` runs on the TestMint only. The worker's IPC guard admits only `https` mint URLs
  (by design) and the local mints are `http`.

## Residuals

- **R1: tails outlive their session.**
  - A compromised worker keeps up to `MAX_TAIL_BLOCKS` of each closed session's budget as spending
    authority for 7 days, on that video's terms.
  - Tightening this further needs a host-side view of what seeders reported, which the host does
    not have.
- **R2: full-app crash.** A crash of the whole app (host and worker) leaves no tail
  authorisation: the task creates tails at close or quit, and the host's session budgets are in
  memory. A worker crash is covered, because the host drops the sessions and keeps their tails.
  After a full crash, the worker's record still offers the tail and the host refuses it
  (`session-closed`). It is respected, never paid.
- **R3: a report delayed past `REPORT_WAIT_MS`.** For a seeder the ledger says may be at its
  window, the report is taken as empty after 10 s. An `OWED` that arrives later than that and says
  the seeder is at its window would be overrun by the first ask.
  `docs/contract-requests/P2-owed-viewer.md` asks for an explicit end to the report.
- **R4: the gateway after its own crash.** It has no durable ledger. After its own crash at a
  seeder's exact window, the one block asked before the report overruns that seeder. With no crash
  (a graceful stop flushes), or any count below the window, it is safe.
- **R5: price change between connections.** Owed blocks are priced at the seeder's current PRICE
  (lane P1's R4). If that is above the price the viewer recorded, they are not paid: respected.
- **R6: seeders that never say `free`** (older or third-party). Their images show the placeholder
  (I3).
- **R7: ledger writes.** About one per second per active seeder (I2).
- **R8: two live connections under different Noise keys with one seeder pubkey.** Each budget
  ignores the other's live blocks. This is pre-existing (issue #8's design) and unchanged.

## Coverage limits

- The adversarial pass was not independent: no subagent tool was available here. An independent
  review is recommended before merge, as lane P1 had.
- The Electron e2e was not run (as the task instructs). `packaging/stage.test` "host bundle…" is
  lane R6's.

## Gates

On `3340a41`:

- `tsc -b --force`, the build, eslint and prettier on the changed files, `check:locked`,
  `lint:electron` and `check:native`: all clean.
- The whole suite: 3442 passed, 22 skipped, 0 failed.
- Real-mint lanes: 11 of 11 at Nutshell and at cdk-mintd.

The details are in the lane record, `docs/lanes/P2-owed-viewer.md`, under "Gates".
