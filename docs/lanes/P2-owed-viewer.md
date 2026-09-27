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
- then this record and the review record.

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

**Mutation checks:** 45, all caught (the review record has the table). M13 and M40 needed a new
test first. M43–M45 are end to end; with M45 (the ledger's earlier-run word ignored) the daemon
bans the viewer.

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
| Viewer pays the seeder's count + images only where "free" (ADRs 0015/0018 amendments 2026-09-26) | `stage-3/owed-viewer` (off `54f49bb`, owed-seeder + int-reconcile merged) | **done (viewer side)** — image reads ask a seeder only after its `PRICE { free: true }` (no probe; router `free`: a free read that times out leaves no debt; a pricing gateway no longer stops an honest free image); `SeederCredit` starts each seeder from its report (one block at a time until it is in, then window − `OWED`, re-based by every `ACK.outstanding`); the worker keeps a durable record of blocks received and unpaid per seeder pubkey + core with their session terms, plus a write-ahead "may be at its window" ledger; on `OWED` it pays only reported ∩ recorded blocks under the recorded session's id; `play.close` answers the unpaid tail and the host keeps per-identity tail authorisations (≤ 1024 blocks, 7 days, checked like any PAY, budget on disk before the build); the gateway gets credit-from-report and pays no old tail. Four tail scenarios end to end against a seeder daemon over hyperswarm (graceful close, crash, over-claim, expiry), three image scenarios on the testnet, 45 mutation checks, real-mint lanes green at Nutshell and cdk-mintd. Open: R1 (tails outlive their session, capped), R2 (full-app crash leaves no tail authorisation), R3/R4 (no end-of-report marker: 10 s wait; gateway crash-at-window) |
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
> - Logs carry counts only.
>
> **Residual:**
> - [Low] A compromised worker keeps up to 1024 blocks of each closed session's budget as spending
>   authority for 7 days, on that video's terms (R1).
> - [Low] A full-app crash's tail is not paid, only respected (R2).
> - [Low] A report delayed past 10 s for a seeder at its window; the gateway after its own crash
>   at a seeder's window (R3, R4; contract request for an end-of-report marker).
