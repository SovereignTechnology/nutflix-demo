# Lane P2-owed-viewer: the viewer pays what a seeder reports; images only where "free"

Branch `stage-3/owed-viewer`, off `54f49bb`. Date: 2026-09-26/27.

Merged first, as the task asked, with no conflicts:

- `stage-3/owed-seeder` (`2557426`: the v6 contract and lane P1's seeder side);
- `stage-3/int-reconcile` (`ea9d4dc`: lane R6's payer reconcile).

Commits:

- `d06300e`: the implementation;
- `8ae3f1a`: the review's fixes;
- `17c838d`: lint on old test call sites;
- `3340a41`: mutation-check gaps closed, ADR and contract-request text;
- `8d14a2f`: this record and the review record;
- then the independent review's fixes (section 3 below), with this record and the review record
  updated;
- then fix round 7 (section 4 below), with this record and the review record ("Round 7")
  updated.

Review record: `docs/reviews/2026-09-26-pre-push-owed-viewer.md`. Decisions: Cameron 2026-09-26,
the amendments at the end of ADR 0018 (the seeder's count, paying an old tail) and ADR 0015
(seeders say "free"). ADRs 0015 and 0018 each gained a "viewer side as built" section.
`docs/status.md` and `docs/security-review.md` were not edited; the text proposed for each is at
the end.

## What changed, and why

### 1. Free images: no probe (ADR 0015 amendment)

Before, an image read probed each seeder of the named core with one unpaid block, and stopped at
the first `PRICE`. A paid core named by a thumbnail therefore still cost one counted block per
seeder, which a restart turned into a ban. The early stop, and the worker's "sold somewhere, free
nowhere" memory, also refused an honest free image whenever a gateway that prices the same
profile core answered first.

Now:

- **Free only.** `SeederCredit.attachImageCore` asks a seeder for an image core's blocks only
  while it is on an open channel (both HELLOs) and its last word for that core on this connection
  is `PRICE { free: true }`. It is then asked up to `NO_PAY_INFLIGHT` in flight. Silence, a priced
  `PRICE`, no `pay/1`, no HELLO: never asked, nothing counted.
- **No debt from a free core.** The router's new `free` option keeps a free core's requests out
  of `used`, `inflight` and `debt`, and out of what a released peer leaves as lost. So:
  - a free read that times out, or is stopped, leaves no debt at the free seeder;
  - it never holds back, or is held back by, what that seeder may count on the cores it sells.
- **The probe is removed**, with the rules it needed:
  - the router's `probe` option;
  - `SeederCredit.probing`, `onImageVerdict` and the per-seeder "priced" memory;
  - the worker's `imageSold` / `imageFree` sets and the read's early stop.

  The worker still refuses cores it knows are sold: a manifest policy here, a routed core, one our
  own seeder prices.
- **Free, then sold.** A core that turns sold is not asked again. A block of it still landing
  afterwards counts as unpaid for good (browsing never pays).
- **R9 closed** (lane P1's residual). A replica the image path opens is marked free on our own
  seeder, by key, BEFORE the open. A peer pairing on it hears `free`, never silence first.
- **`{ free: true }` is not a price.** `UpstreamPayer` used to store any `PRICE` as a price
  override, so `free` became a 0-sat price. Now blocks of a core a seeder serves free are neither
  pended nor paid, and the settler settles them on arrival (`servesFree`).

### 2. The unpaid tail (ADR 0018 amendment)

**Credit from the report** (`SeederCredit`, shared by the desktop and the gateway):

- **When the report is complete.** Per connection, the seeder's report is complete when either:
  - the first thing it sent in answer to a frame we sent after our HELLO arrives: a block asked
    after `open` (replies to requests already in flight when its `pay/1` attached are counted out:
    `early`), or an ACK;
  - or `REPORT_WAIT_MS` (10 s) after the channel opened.
- **Before it:**
  - `old` is what this process knows of, or the report so far if larger;
  - the seeder is asked ONE block at a time (the router's new `single` option).
- **At it,** what the seeder says it counts replaces our estimate of everything before this
  connection:
  - requests remembered as lost (`OnePeerRouter.forgive`, new);
  - blocks settled unpaid;
  - its other Noise keys' debts;
  - the ledger's earlier-run word.
- **After it,** `old` is what it reported, plus what this connection left unpaid since. Each
  `ACK` re-bases its core to `outstanding` less the blocks of that core still owed on the link.
  That is an upper bound: blocks in flight count twice.
- **A report at the contract's caps,** or a malformed one (a loopback end does not run the codec),
  may be short. Nothing more is asked of that seeder on that connection.
- **Its claims are respected, never checked.** Over-claiming shrinks only its own credit.

**The worker's durable record** (`worker/pay/unpaid-record.ts`, new):

- **Contents.** Per our identity: blocks received and not paid, per seeder HELLO pubkey and core.
  Each block carries its session's id, blob range and manifest policy.
- **Durability.** `<storage>/unpaid/<pubkey>.json`, 0600. Rewritten atomically (temp file, fsync,
  rename) in 1 s batches and at close; 7-day TTL; bounded. A block leaves it when a PAY is built
  for it (never paid twice) or when an ACK names it.
- **The write-ahead ledger.** It is also `SeederCredit`'s `SeederLedger`: a per-seeder word, "may
  count its whole window against us". The word is written synchronously before anything is asked
  that could bring a seeder there, and cleared at a flush once the seeder is below its window.
  After a crash, a seeder with that word is asked nothing until its report is in. Without it, the
  one block asked before the report overruns a seeder that the crash left exactly at its window,
  which is what `desktop-owed` shows (mutation M45: the daemon bans the viewer).
- **Not under `--dev-mocks`.** That identity is new every run, so nothing it left could ever be
  reported back to it.

**Paying what the seeder reports:**

- On `OWED`, `ViewerPayer` hands `UpstreamPayer.addOwed` only the reported blocks that the record
  also holds for that seeder and core, and only after the core's priced `PRICE` on this connection
  (contract rule 3).
- They are paid at once and apart: a PAY never mixes owed blocks of two sessions, nor owed with
  fresh blocks. They go on this connection's carry chain, at the recorded terms: the asked price
  may only lower them.
- They are paid under the recorded session's id (`payOwed` → `pay.build`).
- What the seeder claims beyond the record is never paid.
- An owed range the host refuses for good (expired, over budget) leaves the record: respected.

**The host's tail authorisations** (`host/tails.ts`, new):

- **`play.close` reports the tail.** It answers `{ unpaid }`: the session's blocks still in the
  record once its drain ended.
- **The host keeps it.** `MoneyPlane.revokeSession(sid, unpaid)` keeps a tail authorisation:
  - the session's core, blob range and manifest terms;
  - a budget of `min(unpaid, what the session had left, MAX_TAIL_BLOCKS = 1024)`;
  - 7 days;
  - persisted per identity in `<userData>/tails/<pubkey>.json`, a private file.
- **When the worker could not say** (it was gone, a quit past its bound, a sign-out with sessions
  open: `close()`), the host keeps the session's remaining budget, with the same cap.
- **`pay.build` under a closed session's id** is checked against its tail exactly like an open
  session: core, range, terms, budget. The tail's blocks come off its budget on disk before the
  PAY is built. An expired tail is refused `forbidden`.
- **Quit** (`Host.shutdown`) waits for the tail writes.

**The gateway** gets the credit-from-report part, including the one-block rule before the
report. It pays no old tail: there is no owed engine, so `addOwed` takes nothing. It has no
durable record and no host to authorise a closed session's tail. What its previous run left
unpaid stays counted at the seeder, and the gateway stays under it until that seeder forgets it
(its own restart). This is documented in `gateway.ts` and in `SeederCredit`'s header.

### 3. The independent review's fixes (2026-09-27)

An independent reviewer made 9 findings on `8d14a2f`; building the test for its HIGH found one
more defect. The review record ("Independent review") has each finding, scenario and mutation.

- **The carry of every PAY reaches the host (HIGH).** The worker's payer dropped `opts`, so the
  host split every fresh PAY with `carryIn` 0; after any PAY that left a carry the seeder refused
  the next one `malformed`, its proofs spent. The wrapper forwards the carry; the worker's pay
  function now refuses a PAY without one before asking the host (fail closed); the dev wiring
  forwards it too. Owed and fresh PAYs share one chain.
- **An empty creator share is a valid PAY (HIGH, new).** At a split where a small PAY gives the
  creator 0 sats (90/10 at 2 or 3 sats/block), the worker's guard refused the host's PAY after it
  was built (the contract allows an empty set), and the payer built another: 6 were thrown away
  in the measured run. A PAY's sets may now be empty; a PAY carries at least one proof in total.
- **Quit waits for the signer flow's tail writes (MEDIUM).** `DesktopSigner` keeps the tail writes
  of the planes it closes and `adapter.flushTails()` waits for them, so a quit on the production
  signer path no longer exits with them in flight. The next plane for an identity opens only after
  the closed one's writes landed (INFO 5).
- **Gateway report rule (LOW).** When the channel opens, what is in flight then is counted as
  `early`, so a reply to a free-core request made before our HELLO no longer completes the report
  ahead of the `OWED`.
- **INFO.** A test for the tail re-check at the gate's turn; `onOwed` marks only the blocks the
  payer took (`addOwedIndexes`); an owed range with no shared mint stays in the record for a later
  connection (`onUnpayable` scope `'connection'`); the record's `full` word survives the seeder
  bound and the age-out.
- **Deferred.** The directory fsync in Bare's `writeAtomic` (R9); a write-ahead tail for a
  full-app crash (R2, Cameron's call).

### 4. Fix round 7 (2026-09-27): a closed plane's tail book writes nothing

The lane's verifier found that finding 5 (sign-out then quick sign-in) was not fully closed; the
orchestrator decided to close it fully. The review record ("Round 7") has the detail.

- **The race.** A tail's PAY waiting for its turn at the mint (behind a PAY whose swap is slow)
  when the plane closed was refused at its turn (`payments-unavailable`) and gave its blocks back
  by saving the CLOSED plane's book (`money.ts`, the `payBuild` catch). That write was outside
  what `DesktopSigner` waited for, so it could land after the next plane had read the file and
  saved a tail of its own, erasing that tail from disk until the next plane's next write.
- **The fix.** One tail book owns the identity's file at a time. `TailBook.close()` fences a
  book: the writes it started still land (`flush` waits for them and never for more); every later
  `add` and `save` rejects at once and writes nothing. `MoneyPlane.close()` keeps its open
  sessions' tails (the book's last writes), then closes the book. The late rollback is therefore
  refused, and the blocks it would have given back stay off the budget on disk: the conservative
  side (respected, never paid). `DesktopSigner`'s wait for the closed plane's writes is now a
  wait for every write that plane will ever make.
- **Tests** (each failed before the fix): `tails` "a closed book…" (the fence, file and memory
  books), `tails` "a tail PAY still waiting at the mint when the plane closes…" (the verifier's
  sequence on two real planes over one directory), and `signer-host` "sign out, then sign in at
  once, with a tail PAY waiting at the mint" (the production path: the signer flow's sign-out and
  connect through the host, the worker restarted around each plane change).
- **Mutations** M63–M66, 4 of 4 caught.

## Files

- **Seeder:** `packages/seeder/src/net/one-peer.ts`: `single`, `free`, `lostOf`, `forgive`.
  `probe` is removed.
- **Gateway:**
  - `upstream/seeder-credit.ts`: rewritten (report, ledger, free-only images);
  - `upstream/settle.ts`: `onAck`, `owedByOn`, `servesFree`;
  - `upstream/payer.ts`: `addOwed`, the owed engine, free PRICE, range-aware resolver and bound;
  - `gateway.ts`.
- **Desktop worker:**
  - `worker/pay/unpaid-record.ts` (new);
  - `worker/pay/viewer-payer.ts`;
  - `worker/host.ts`;
  - `worker/providers.ts`, `worker/pay/real-providers.ts`, `worker/dev/dev-mocks.ts`: `payOwed`.
- **IPC:** `ipc/worker-protocol.ts` and `ipc/worker-guards.ts`: the `play.close` result.
- **Host:**
  - `host/tails.ts` (new);
  - `host/money.ts`;
  - `host/sessions.ts`;
  - `host/adapter.ts`;
  - `host/host.ts`.
- **Tests** (new):
  - `worker/__tests__/images-free-only.integration.test.ts`;
  - `host/__tests__/desktop-owed.integration.test.ts`;
  - `worker/__tests__/unpaid-record.test.ts`;
  - `host/__tests__/tails.test.ts`.
- **Tests** (extended): see "Tests".
- **Docs:**
  - ADRs 0015 and 0018 ("viewer side as built");
  - `docs/contract-requests/P2-owed-viewer.md`;
  - this record and the review record.
- **Independent review fixes:**
  - `worker/pay/viewer-payer.ts` (the carry forwarded; accepted owed indexes; the connection
    scope), `worker/pay/real-providers.ts` (no PAY without a carry), `worker/dev/dev-mocks.ts`,
    `worker/dev/fixtures-net.ts`;
  - `ipc/worker-guards.ts` (a PAY's empty share);
  - `host/signer/desktop-signer.ts` (`retiring`, `flushTails`), `host/adapter.ts`,
    `host/host.ts` (a comment);
  - `gateway/src/upstream/seeder-credit.ts` (`early` at open), `gateway/src/upstream/payer.ts`
    (`addOwedIndexes`, `onUnpayable` scope);
  - `worker/pay/unpaid-record.ts` (the `full` word kept);
  - tests: `host/__tests__/desktop-carry.integration.test.ts` (new); `viewer-payer`,
    `real-providers-sessions`, `worker-guards`, `desktop-signer`, `signer-host`, `tails`,
    `unpaid-record`, `seeder-credit` extended;
  - ADR 0018 "viewer side as built" updated.
- **Fix round 7:** `host/tails.ts` (`close`, the fence), `host/money.ts` (`close` closes the
  book), `host/signer/desktop-signer.ts` (comments); tests `tails` and `signer-host` extended;
  ADR 0018 "viewer side as built" (one book owns the file).

## Tests

**The reviewer's scenarios, end to end:**

- **Images** (`images-free-only.integration`): a local testnet, the fixture rig, a third seeder
  that SELLS the profile core (standing for a gateway), and the worker under a stable identity so
  that a restart is the same viewer.
  1. A free image with the pricing seeder present loads. Only the free seeder is asked; the
     pricing one counts nothing. Both words reached the worker (a PRICE spy).
  2. A free read that times out (the free seeder takes the requests and answers none) leaves no
     debt: no unpaid, no lost request, `used` 0, `reach` 0.
  3. A paid core named by a thumbnail: nothing requested from its seeders (their price reached the
     worker; nobody said free), no ban. After a restart, the video plays in full, every block paid,
     nothing reported owed.
- **The tail** (`desktop-owed.integration`): a seeder daemon (real runtime and engine, real
  `pay/1` over hyperswarm), the real framed worker IPC with real providers, and the host money
  plane with a real signer. Every full stream fails at once if the daemon bans the viewer.
  - **A. Graceful close with an unpaid tail** (PAYs refused "for now", a full window unpaid):
    - `play.close` reports 5;
    - the host re-opens its plane from disk;
    - after a worker restart, the seeder's `OWED` is paid under the tail;
    - the new video streams; the wallet pays each block once; no ban.
  - **B. A crash** (the worker's disk stops after block 0 was written, two more blocks arrive,
    the connections drop with no close):
    - the one block the last write held is paid;
    - the two it did not are respected, never paid;
    - no ban.
  - **C. Over-claim** (the daemon reports and ACKs 2 blocks it never sent):
    - only the recorded block is paid;
    - the real count never passes window − 2;
    - no ban.
  - **D. Expiry** (the tail clock 8 days on):
    - the host refuses it, nothing is paid, the record drops it;
    - the seeder's count is respected; no ban.
- **The gateway** (`upstream-payer` "the gateway stays under what the upstream reports…"): a real
  upstream `Seeder` whose engine counts 2 old blocks for the gateway. The gateway reads a 9-block
  blob, pays those 9, pays none of the old 2, never passes the window, and is never banned.

**Units:**

- `one-peer-router`: `single`; `free` on two cores over one stream; `forgive`.
- `seeder-credit`: free-only images, the report (before, at and after it; `ACK` re-base; the
  timer; caps and junk; one `OWED` per core; close; open-only HELLO; early replies;
  `seederReach`), the ledger (earlier-run word, write-ahead, failing and throwing ledgers), and
  the settler's `servesFree`.
- `upstream-payer`: a free PRICE is not a price; owed blocks (the guards, apart from fresh ones,
  the carry chain, terms, turned free).
- `viewer-payer`: record, `OWED` ∩ record, rule 3, a final refusal, never mixed, never paid twice,
  free.
- `unpaid-record`, `tails`, `adapter-play`, `topup-host`, `worker-guards`, `rpc`.

**Corrected** (comments cite why; nothing deleted or weakened):

- `images-paid-core` tests 2 and 3, and one outstanding check that allowed a probe block;
- `rpc.test`: its void-result case uses `play.pause`;
- `worker-guards.test`: the `play.close` result;
- `topup-host` and `fake-worker`: `play.close` returns `{ unpaid }`;
- the rig and `main.test` teardowns wait for the tail writes.

The fix-round-4 probe tests went with the probe (the task: "remove the probe code and the interim
rules it needed"); `single` replaces the router's probe test with the same shape.

**The independent review's tests:**

- `desktop-carry.integration` (new; seeder daemon over hyperswarm, real framed IPC, real
  providers, the host money plane; 3 sats/block at 90/10, so no PAY under 10 blocks leaves a
  carry of 0 and small PAYs have an empty creator set):
  - A. a whole video: the first PAY at carry 0, every later one at the non-zero carry its chain
    held, none refused, every block paid, no ban, the wallet down by exactly the blocks paid;
  - B. a 1-block tail, a restart, then a new video: the owed PAY opens the chain at 0 and leaves
    30, every fresh PAY after it carries on; none refused, every block paid, no ban.
  Before the fixes A failed (5 `invalid-argument`, then `forbidden`) and B timed out.
- `signer-host` (new describe): a quit on the signer flow's plane leaves the tail on disk when
  `Host.shutdown` resolves, both when `play.close` reports a tail and when the bound runs out.
- Units: `viewer-payer` (the carry of fresh PAYs; owed then fresh on one chain; accepted owed
  indexes only; no shared mint keeps the record), `real-providers-sessions` (no PAY without a
  carry), `worker-guards` (empty shares), `desktop-signer` (the closed plane's writes: the next
  open and `flushTails` wait), `tails` (the tail expiring at the gate's turn), `unpaid-record`
  (the `full` word and the bound, the age-out), `seeder-credit` (a pre-open free-core reply).

**Fix round 7's tests** (each failed before the fix):

- `tails` "a closed book: writes started before the close land…; later ones write nothing and
  reject": a write started before `close` lands and `flush` waits for it; the next book saves a
  tail; the closed book's `save` and `add` reject and the file keeps the next book's content; a
  memory-only book is fenced alike.
- `tails` "a tail PAY still waiting at the mint when the plane closes…": an open session's PAY
  holds the mint's turn (its swap held at the TestMint); a tail's PAY takes its block off the
  budget on disk and waits; the plane closes; a second plane opens on the same directory and saves
  a tail; the turn comes: `payments-unavailable`, and the file still lists all three tails, the
  first with its block still taken. The next plane's book agrees (budget refusals, before the
  wallet). Before the fix the next plane's tail was gone from the file.
- `signer-host` "sign out, then sign in at once, with a tail PAY waiting at the mint": the same
  sequence on the production path (`desktop.signer.signOut`, then `desktop.signer.connect`, which
  unlocks the kept key file; the worker restarted around each plane change). Before the fix the
  next plane's tail was gone from the file.

**Mutation checks:** 45 in the lane's own review, all caught (the review record has the table).
M13 and M40 needed a new test first. M43–M45 are end to end; with M45 (the ledger's earlier-run
word ignored) the daemon bans the viewer. The independent review added M46–M62 (its table; M61 and M62 end to end), plus
the reviewer's own survivor (money.ts:565), now M54 and caught. Fix round 7 added M63–M66 (the
review record's "Round 7"), 4 of 4 caught.

**Real mints:** `gateway/real-mint-swarm.integration` and `seeder/owed.integration`, with
`NUTFLIX_REAL_MINT_URL` at Nutshell 0.21.0 (`:3399`, `_URL_2` `:3398`) and cdk-mintd 0.18.1
(`:3397`), 11 of 11 at each. `desktop-owed` is TestMint-only: the worker's IPC guard admits only
`https` mint URLs (by design), and the local mints are `http`.

## Gates

Run on the final code (`3340a41`; this record and the review record change no code):

- **`npx tsc -b --force`:** clean. **`npm run build`:** clean.
- **eslint and prettier** on every changed file (40 TypeScript files, plus the docs): clean.
- **`npm run check:locked`:** OK (no locked file changed).
- **`npm run lint:electron`:** OK (244 files, 0 violations).
- **`npm run check:native`:** OK (43 native packages). No dependency changed.
- **Touched packages** (`seeder`, `gateway`, `app-desktop`, core `payment` / `pay-protocol`), on
  the review fixes: 155 files, 2391 passed, 6 skipped, 0 failed.
- **Whole suite,** `npx vitest run --maxWorkers=2`, on a shared box (load 7–11 on 8 cores):
  - 222 files: 219 passed, 3 skipped;
  - 3442 tests passed, 22 skipped, **0 failed**;
  - no timing reruns were needed;
  - the three known base failures owned by lane R6 (the packaging `stage.test` "host bundle…"
    and two viewer-payer "I2-paygate rate-limited") pass here, after the `int-reconcile` merge.
- **Real mints:** see Tests: 11 of 11 at Nutshell and at cdk-mintd.
- **Mutation checks:** 45 of 45 caught.
- **Not run:** the Electron e2e (as instructed).

### After the independent review

- **`npx tsc -b --force`**, **`npm run build`** (again after the forced `tsc`, which made the
  packaging tests' freshness check fail until the bundle was rebuilt), **eslint** and
  **prettier** on every changed file, **`check:locked`**, **`lint:electron`** (245 files, 0
  violations), **`check:native`** (43; no dependency changed): all clean.
- **Touched suites** (23 files, the five desktop integrations and the new `desktop-carry`
  included): 373 of 373.
- **Whole suite,** `--maxWorkers=2`, load 12–15 on 8 cores: 223 files; 3432 passed, 2 failed
  (`auto-topup.test` at its 5 s timeout, a file this lane never touched; 95 of 95 alone, no
  timeout raised), 45 skipped (23 of them the two packaging files stopped by the stale build; 23
  of 23 after the rebuild). Net: 3457 passed, 22 skipped, 0 failed. Lane R6's three base failures
  pass.
- **Mutation checks:** M46–M62, 17 of 17 caught (M52 after its test was tightened).
- **Real mints:** `gateway/real-mint-swarm.integration` and `seeder/owed.integration` with `NUTFLIX_REAL_MINT_URL` at Nutshell `:3399` and at cdk-mintd `:3397` (`_URL_2` `:3398`): 11 of 11 at each. `desktop-carry`, like `desktop-owed`, is TestMint-only (the worker's guard admits only `https` mints).

### After fix round 7

- **`npx tsc -b --force`** (clean once the new host test's session ids were typed one by one),
  **`npm run build`** (after the forced `tsc`), **eslint** and **prettier** on every changed file
  (5 TypeScript files, 3 docs), **`check:locked`**, and **`lint:electron`** (245 files, 0
  violations): all clean. No dependency changed.
- **Touched suites** (`tails`, `signer-host`, `desktop-signer`, `money`, `host`,
  `desktop-owed.integration`): 80 of 80.
- **Whole suite,** `--maxWorkers=2`, load 13–20 on 8 cores: 223 files; 3457 passed, 3 failed, 22
  skipped. The 3 failures were `money.test` cases at their 5 s timeout. None reaches the changed
  code. Rerun alone under the same load they failed the same way on HEAD's sources too; alone at
  load 8.9 with the default timeout they passed 17 of 17. No timeout was raised. Net: 3460
  passed, 22 skipped, 0 failed.
- **Mutation checks:** M63–M66, 4 of 4 caught.
- **Not re-run:** the real-mint lanes (no mint path changed) and the Electron e2e.

## Residuals

- **R1: tails outlive their session.** A compromised worker keeps up to `MAX_TAIL_BLOCKS` of each
  closed session's budget as spending authority for 7 days, on that video's terms only.
- **R2: full-app crash.** It leaves no tail authorisation: tails are created at close or quit, as
  the task specifies, and the host's session budgets are in memory. The tail is then respected,
  not paid. A worker crash is covered.
- **R3: a report delayed past `REPORT_WAIT_MS`.** For a seeder the ledger says may be at its
  window, the report is taken as empty after 10 s. A later `OWED` at the window would be overrun
  by one block. See the contract request.
- **R4: the gateway after its own crash.** No durable ledger: after its own crash at a seeder's
  exact window, the one pre-report block overruns that seeder.
- **R5: price change between connections.** Owed blocks priced above the recorded price are not
  paid, only respected (lane P1's R4).
- **R6: seeders that never say `free`.** Their images show the placeholder.
- **R7: ledger writes.** About one small atomic write per second per active seeder.
- **R8: two live connections with one seeder pubkey.** Each budget ignores the other's live
  blocks. Pre-existing.
- **R9: power loss** (independent review, finding 8, deferred). Bare's `writeAtomic` does not
  fsync the directory after its rename: the record's write-ahead word is durable against a
  process crash, not a power loss.
- **R10: an unbounded wait on the disk** (independent review). A sign-in after a sign-out waits
  for the closed plane's tail writes, as the quit does; a disk that never answers holds it.
- **R11: the blocks of a tail PAY that fails after its plane closed** (fix round 7): refused at
  its turn at the mint, or failing in flight. The closed plane's book writes nothing, so the blocks
  that PAY took off the tail's budget on disk are not given back: respected, never paid. At most
  one PAY's range per such PAY, and only when a sign-out, lock, signer swap or quit lands while it
  waits or runs. No fund loss and no ban.
- **Lane P1's R1 is resolved:** the viewer no longer reads `free` as sold. **P1's R9 is
  resolved:** the image path marks free before the open.

## Questions for Cameron

1. **R2.** Should the host also persist an open session's budget (a pre-authorisation, converted
   into a tail at the next start), so that a full-app crash's tail can be paid too? The task
   limits tails to close or quit, so the lane did not.
2. **R1.** Is `MAX_TAIL_BLOCKS` = 1024 for 7 days the right bound for what a compromised worker
   can keep? Would a shorter expiry (for example 24 h) serve, given that seeders forget on
   restart anyway?
3. **R3 and R4.** Is an explicit end-of-report marker (`docs/contract-requests/P2-owed-viewer.md`,
   also lane P1's Q2) worth a v7 change? It would remove the 10 s wait and the gateway's crash
   residual.

## Proposed `docs/status.md` row

```
| Viewer pays the seeder's count + images only where "free" (ADRs 0015/0018 amendments 2026-09-26) | `stage-3/owed-viewer` (off `54f49bb`, owed-seeder + int-reconcile merged) | **done (viewer side)** — image reads ask a seeder only after its `PRICE { free: true }` (no probe; router `free`: a free read that times out leaves no debt; a pricing gateway no longer stops an honest free image); `SeederCredit` starts each seeder from its report (one block at a time until it is in, then window − `OWED`, re-based by every `ACK.outstanding`); the worker keeps a durable record of blocks received and unpaid per seeder pubkey + core with their session terms, plus a write-ahead "may be at its window" ledger; on `OWED` it pays only reported ∩ recorded blocks under the recorded session's id; `play.close` answers the unpaid tail and the host keeps per-identity tail authorisations (≤ 1024 blocks, 7 days, checked like any PAY, budget on disk before the build); the gateway gets credit-from-report and pays no old tail. Four tail scenarios end to end against a seeder daemon over hyperswarm (graceful close, crash, over-claim, expiry), three image scenarios on the testnet, 45 mutation checks, real-mint lanes green at Nutshell and cdk-mintd. Independent review fixed: every desktop PAY now carries its chain's `carryIn` (fresh PAYs went out with 0 — refused `malformed` after any carry, proofs spent) and none is built without one; a PAY with an empty creator share is admitted (the worker's guard refused it after the host built it); quit waits for the signer flow's tail writes; the gateway's report ignores replies to requests made before our HELLO; the record's write-ahead word survives its bound and age-out; `desktop-carry` end to end at 3 sats/block, 90/10. Fix round 7: a closed plane's tail book writes nothing more, so a tail PAY waiting at the mint across a sign-out and quick sign-in can no longer overwrite the next plane's tails; 66 mutation checks. Open: R1 (tails outlive their session, capped), R2 (full-app crash leaves no tail authorisation), R3/R4 (no end-of-report marker: 10 s wait; gateway crash-at-window), R9 (no directory fsync in Bare's `writeAtomic`) |
```

## Proposed `docs/security-review.md` text (§5 or §6)

> **pay/1 v6 amendment, viewer side (lane P2-owed-viewer, 2026-09-27).**
>
> **Holds:**
> - An image core's blocks are asked of a seeder only after its `PRICE { free: true }` on an open
>   channel. A thumbnail URL naming a paid core asks nothing of its seeders. A free read's
>   requests are never counted as debt.
> - A seeder's credit starts from its own report, and it is asked one block at a time until that
>   report is in. The desktop's write-ahead ledger keeps a seeder that may be at its window from
>   being asked anything before its report, even after a crash.
> - The worker pays only blocks that are both reported (`OWED`) and in its own durable record for
>   that seeder pubkey and core. A block is never paid twice: it leaves the record when its PAY is
>   built. Claims beyond the record are respected, never paid.
> - A closed session's tail is paid only under a host tail authorisation: the same core, blob
>   range and manifest terms; at most `min(unpaid, remaining, 1024)` blocks; 7 days; persisted
>   per identity as a private file; each PAY's blocks off the budget on disk before the build.
> - The gateway pays no old tail.
> - Every desktop PAY, owed or fresh, is split with the carry of its channel's chain for the core
>   (ADR 0010); the worker refuses to build one without it, before the host is asked (independent
>   review: fresh PAYs went out with 0 and were refused `malformed` after their proofs were
>   spent).
> - A PAY whose creator (or seeder) share is 0 sats carries an empty set, as contracts v5 allow;
>   the worker's guard admits it and refuses a PAY with no proof at all (independent review: it
>   refused the host's PAY after it was built, and the payer built another).
> - The quit waits for every tail-authorisation write, the signer flow's closed plane included.
>   One tail book owns the identity's file at a time: a closed plane's book writes nothing more,
>   so a tail PAY still waiting at a mint across a sign-out and quick sign-in cannot overwrite
>   the next plane's book (fix round 7).
> - Logs carry counts only.
>
> **Residual:**
> - [Low] A compromised worker keeps up to 1024 blocks of each closed session's budget as spending
>   authority for 7 days, on that video's terms (R1).
> - [Low] A full-app crash's tail is not paid, only respected (R2).
> - [Low] A report delayed past 10 s for a seeder at its window; the gateway after its own crash
>   at a seeder's window (R3, R4; contract request for an end-of-report marker).
> - [Low] Power loss: Bare's `writeAtomic` does not fsync the directory after its rename, so the
>   record's write-ahead word is durable against a process crash only (R9).
