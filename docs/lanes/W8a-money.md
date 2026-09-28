# Lane W8a-money — the final cross-lane review's money plane / NUT-13 findings

Branch `stage-3/r8-money`, off `aca2d6a` (the merged Stage 3 head, integration fix 2 included).
Date: 2026-09-27. Findings: the round-8 panel's `money-nut13` and `tests` reviews (12 items: 1
high, 4 medium, 4 low, 3 info), with the orchestrator's decisions on each.

- Commits: `223a0a6` (core wallet), `16ef875` (desktop money plane and recovery), `9a233d9`
  (three more money-plane tests), `4cf3dc1` (sharp edges from the pre-push review), then this
  report, the review record, the contract request and the two ADR notes.
- Review record: `docs/reviews/2026-09-27-pre-push-w8a-money.md` — each finding reproduced or
  refuted, the differential review and the sharp edges, 43 mutation checks, the residuals.
- Contract request: `docs/contract-requests/W8a-money.md` (the Settings screen, outside this lane:
  a "not finished" restore outcome with a Continue action, the relay copy's retry wording, dust).
- Nothing changed under `packages/core/src/contracts/`, `docs/status.md` or
  `docs/security-review.md`. The locked `spend.ts` changed (no logging, no new import:
  `npm run check:locked` OK). Nothing outward: no push, MR or issue edit.

## Outcomes

| Finding | Outcome |
|---|---|
| [high] `files.ts:244` the counters file refuses core's state | **confirmed fixed** by int-fix-2 for the phrase binding; **fixed here** for the second trigger (a probed keyset's `published` 0 with no `next`), which int-fix-2 left refused — reproduced with core's real source: the next top-up failed `minting failed` |
| [medium] `spend.ts:1030` a restore holds the mint outside the PAY/melt gate | **fixed**: core's `holdMint` hook runs every restore (per mint), reissue, plan and journal settle inside the gate (`PayMeltGate.hold`); a PAY there is refused at once. The reviewer's reproduction now builds no P2PK set after the worker's deadline |
| [medium] `deadlines.ts:65` the PAY model assumes unseeded sends | **fixed**: the model counts a seeded send (restore + NUT-07, a probe, one capped collision batch, counters-file saves; seeded belt 12.6 s); core bounds a PAY's sends (`SendBound`: no collision re-run, one skip-ahead batch, a turn check); the mint is loaded and probed before the turn |
| [medium] `service.ts:736` restore drops core's `resume` | **fixed**: the restore follows `resume` until complete (at most 10 calls per phrase and mint, only while a call moves the scan on); an unfinished scan keeps its cursor for the next restore and reads `unreachable`, never `refused`. A phrase signed past counter 20 000 is restored whole in one restore (real core, TestMint) |
| [low] `service.ts:456` a reissue marked complete with held or dust proofs left | **fixed**: complete only when no journal entry and no dust is left at a mint; the replaced relay copy is retired only then |
| [low] `service.ts:380` the relay copy is never retried | **fixed**: retried with a bounded backoff (30 s doubling to 1 h) until a relay takes it; the envelope's `relayCopy` is the persisted pending flag, the status reads it |
| [low] `money.ts:527` close never closes the wallet or its counter source | counter source **confirmed fixed** by int-fix-2; **fixed here**: the plane runs `CashuWallet.close`, the swap awaits its drain (≤ 2 s) before a rotation and the next open, a late watermark write is skipped; one counters store per identity |
| [info] `money.ts:367` `restoreUnpublished()` never called | **fixed**: after the startup settle, inside the gate (`MoneyPlane.startupRestore`) |
| [info] `nip60.ts:450` a duplicate journal `begin` replaces the entry | **fixed**: refused (`JournalConflictError`) before anything changes, in both stores |
| [info] `service.ts:753` reopen and restore edge cases | (b) **fixed** for the public all-zero phrase (refused by name); (a) **narrowed** (sessions closed through the worker first), rest **deferred** (same class as the earlier residual 7); (c) **deferred** (defence in depth only) |
| [low] `money.ts:266` the NUT-13 wiring skips core's seed lifecycle (tests review) | **fixed** with the three items above |
| [info] `money.ts:519` extra tail authorisations on setup | **fixed**: play sessions close through the worker before each reopen (bounded 7 s), so a tail carries the reported unpaid count |

Found along the way, and fixed:

- **The pre-PAY probe would have made the second counters-file trigger ordinary** (a probe with
  no lease after it, then a watermark move) — the parser fix covers it.
- **Any operation's settle can run the 200-batch collision skip-ahead** holding the mint's turn
  (a redeem, a top-up). The per-send turn check (`SendBound.onTurn`) refuses a PAY send whose turn
  comes too late, whatever held the mint.
- **A hostile mint could stretch a resumed restore without bound** — the ten-call bound.
- **A `holdMint` hook could run an operation twice** — `run` is handed out once.
- **`seeded` defaulted to the looser belt** — now a required argument.

## How each was decided

- **Gate, not unlocked scan.** The orchestrator chose the gate. It is a hook in core
  (`CashuWalletOptions.holdMint`) rather than overrides in the desktop, so every caller of a
  restore, reissue or settle goes through it — including the startup restore, which loops over
  mints inside core.
- **The model had to shrink the collision path to be honest.** Unbounded, a collision inside a PAY
  costs a second full send and up to 200 NUT-09 batches: no belt covers that. Bounded sends report
  the collision (nothing spent; the next PAY derives past it).
- **Loaded and probed before the turn.** Counted inside the build, a seeded PAY at a mint not yet
  loaded has no start early enough, and a refused PAY never loads the mint: payments there would
  stall for good. `prepare` spends nothing and runs outside the mint's lock.
- **Each send asks again at its own turn.** The gate sees PAYs, melts and holds, not a redeem or a
  top-up; core's queue is FIFO. `sendStartByMs` gives each send what is left for it (the last send
  125.8 s seeded, 217.8 s unseeded).
- **Drain bounded, then no write.** Awaiting `CashuWallet.close()` whole could hold a sign-out for
  as long as a melt or a restore; not awaiting it let its watermark write land after the next
  plane's (int-fix-2's `ENOTEMPTY`). The swap waits 2 s; after that the write is skipped.
- **Restore bound: 10 calls, cursor kept.** Each call is core's cap (200 batches a keyset); ten
  reach 200 000 counters (about twelve hours of heavy streaming). The next restore continues.
- **"Could not be reached", not "refused".** The wire has no "not finished" outcome and the Settings
  screen is another lane's; `unreachable` tells the user to try again, which continues the scan.

## Gates

- Every touched test file green (36 new tests).
- The whole suite once, on the final code, after `npm run build` (`npx vitest run
  --maxWorkers=2`): 237 files passed, 5 skipped; 3 866 tests passed, 30 skipped; 619.7 s; no
  timing failure to rerun.
- `npx tsc -b --force`: clean. `npm run build`: clean.
- eslint + `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK. `npm run lint:electron`: OK (264 files, 0 violations).
- Opt-in real mints (money paths changed): `nut13-real-mint`, `journal-real-mint`,
  `recovery-real-mint`, `topup-real-mint`, `desktop-owed.integration` — 23/23 on Nutshell 0.21.0
  (`:3399`) and 23/23 on cdk-mintd 0.18.1 (`:3397`), with `NUTFLIX_REAL_MINT_URL_2=:3398`.
- Mutation checks: 43, all killed but one equivalent (the review record's table).
- No Electron e2e (as briefed).

## Residuals

See the review record's Residuals; the main ones:

1. The Settings screen cannot say "not finished" or offer Continue (contract request); an
   unfinished restore's cursor lives in this process only.
2. A seeded PAY has no start early enough while any journal entry is at its mint: paid playback
   there waits for the settle loop (a young entry: up to 10 min).
3. The first startup restore on an install whose watermark never moved scans its whole unpublished
   range, holding each mint meanwhile.
4. Dust keeps a backup pending (and a replaced relay copy on the relays) until it is spent.

## Proposed row for `docs/status.md`

| W8a-money — final review, money plane / NUT-13 | `stage-3/r8-money` | DONE. The round-8 panel's money findings, each with a test that failed before its fix:<br>• restores, reissues, plans and journal settles hold their mint in the PAY/melt gate (core `holdMint`); the PAY-behind-restore loss reproduced and closed;<br>• the PAY deadline model counts a seeded send (seeded belt 12.6 s); PAY sends bounded in core (`SendBound`: turn check, no collision re-run, one skip-ahead batch); the mint loaded and probed before the turn;<br>• restore follows core's `resume` (10 calls, cursor kept; a phrase past 20 000 counters restored whole);<br>• a reissue: nothing moves at a mint while an operation is journaled there, and a young entry at a mint that answers keeps it pending; an overdue entry, or a mint that cannot be asked, counts as done but watched, and the backup reopens once that mint shows a balance worth moving; dust and empty mints with nothing journaled count as done; the replaced relay copy is retired only once nothing is left outside the new phrase; the relay copy retried with a bounded backoff, a Settings action during a stuck retry refused after a bound;<br>• the plane runs the wallet's close (drain bounded, no late watermark write), the startup restore, one counters store per identity; the counters file takes core's probed-keyset entry;<br>• a repeated journal `begin` refused; play sessions closed before a reopen.<br>Nutshell and cdk real-mint suites green. Review `docs/reviews/2026-09-27-pre-push-w8a-money.md` (43 mutation checks) |

## Fix round 8 (2026-09-27): F55, F56 and the relay retry's lock — tests written, NOT run

The round-8 verifier's two medium findings and one info item on this lane's recovery service.
Commits `79b7474` (fix and tests) and `f8cf026` (two more tests); the review record's "Fix round
8" section has the verification, the rule, the reasoned mutation checks and the residuals.

**The tests are written but NOT run**: no test runner runs on this machine (the local-run guard),
so they run later in CI. Each was traced against the code; its mutation check is recorded as
reasoning, marked "not run". Static checks run here: `npx tsc -b`, eslint and `prettier --check`
on the changed files, `npm run check:locked`, the Electron security lint — all clean.

| Finding | Outcome |
|---|---|
| [medium] F55 `service.ts:738` a journaled mint moved but not recorded, moved and charged again at every "Finish backup" | **fixed**: a mint with a balance worth moving and a journal entry (after the plan's settle) is not moved until the entry settles, and keeps the reissue pending; a mint that moved is recorded at once (core refuses holdings changed since the clean plan) |
| [medium] F56 `service.ts:672` dust, or an entry at a zero-balance mint, keeps the backup pending and "Replace phrase" away for good | **fixed**: dust and a mint with nothing spendable count as done for the backup; they keep a replaced phrase's relay copy instead, retired once no unrecorded mint holds a balance or an entry (checked at completion, before a rotation and at every relay retry) |
| [info] `service.ts:1066` the relay retry takes the flows' lock | **fixed**: the retry no longer takes `busy`; a flow started during a retry waits for it (bounded by the relay timeouts) instead of being refused |

**The rule, stated**: recorded → done; nothing spendable → done (whatever is journaled there);
dust (fee ≥ amount) → done, never asked; a balance worth moving with an operation in flight →
not moved, pending until it settles; otherwise asked, moved, recorded. What the backup leaves out
keeps the replaced relay copy, not the backup.

Tests: three W8a tests corrected (each with a comment citing F55 or F56: they pinned the behaviour
the findings describe), six new ones (`fix round 8: …`). Contract request 3 revised and 4 added
(the screen's wording for what stays outside the phrase, and its one sentence for two different
`rate-limited` refusals).

Residual 4 above ("Dust keeps a backup pending") is superseded: dust no longer keeps the backup
pending, only a replaced relay copy — which money arriving later at a mint the new phrase did not
record keeps as well (the store cannot tell the phrases' proofs apart). A mint that keeps an
operation pending keeps the backup pending for as long as the operation lasts (a lost PAY answer
600 s, a stuck HTLC possibly days).

## Round 9 (2026-09-28): the F56 regression, watched mints, the bounded wait — tests written, NOT run

The static reviewer of the F55/F56 fix: one medium finding and three lows. Commits `5cb42e7` (the
fix), `d7ad130` (its tests) and `1005d14` (the rule applied to every journaled mint, one more test).
The review record's "Round 9" section has the verification, the final rule, the reasoned mutation
checks and the residuals.

**The tests are written but NOT run**: no test runner runs on this machine (the local-run guard),
so they run later in CI. Each was traced against the code, and its mutation check is recorded as
reasoning, marked "not run". Static checks run here were all clean: `npx tsc -b` and `--force`,
eslint and `prettier --check` on the changed files, `npm run check:locked`, and the Electron
security lint.

| Finding | Outcome |
|---|---|
| [medium] `service.ts:717` a mint whose balance is in a live journal entry (a PENDING melt, a lost send answer) counted as reissued, so what came back stayed under the replaced, possibly leaked, phrase for good | **fixed**. A young entry at a mint that answers keeps the reissue pending. Once every entry is overdue, the mint counts done but **watched** (the envelope's `watchedMints`), and "Replace phrase" stays available. The relay copy retry reopens the backup (`reissued: false`, "Finish backup" offered again) once a watched mint has no entry left and shows a spendable balance worth moving. The F56 test that pinned the wrong premise is corrected, with a comment |
| [low] `service.ts:1337` a Settings action during a retry stuck on a NIP-46 signer hung | **fixed**: a flow waits at most 22.2 s (three relay publishes), then is refused `remote-signer` (NIP-46) or `relay-down`, and the lock is released |
| [low] `service.ts:719` any balance at an unreachable mint kept `reissuePending` true for good | **fixed**: done but watched, dust included; it still counts in `reissueFailed`. A plan the PAY/melt gate refused stays pending, as before |
| [low] ADR 0016 note, proposed status row and `pendingAt` comment stated the superseded rule | **fixed**: all three, and the service's comments, state the final rule |

**The final rule**:

- Recorded under this phrase: done.
- Nothing spendable and nothing journaled: done.
- The plan fails (the mint cannot be asked): done but watched.
- An entry journaled there: nothing moves. A young entry blocks; all entries overdue: done but
  watched.
- Nothing journaled and nothing worth moving (dust, or nothing spendable): done.
- Otherwise: asked, moved, and recorded at once.

A watched mint is looked at by every retry (its wait capped at 10 min). If an entry is still
there, the mint stays watched. With nothing left, it is dropped. With a balance worth moving, the
backup reopens; with dust, it is dropped. What the backup leaves out keeps a replaced phrase's relay
copy (`outsideLeft`, unchanged).

**Decided here**: the orchestrator's "only entries that are overdue or at an unreachable mint count
as done" is applied to every journaled mint, a balance worth moving included (`1005d14`). Nothing
moves at a journaled mint (F55 stands). A stuck HTLC, or a mint reporting PENDING for good, no
longer hides "Replace phrase" for as long as it lasts (round 8's residual 3).

Tests: one corrected ("F56, round 9: dust with a YOUNG operation …"), one comment added ("a mint
whose whole balance is held …": in the fake its mint cannot be asked). New: six in `fix round 9: …`
and one in `recovery-files.test.ts` (`watchedMints` on disk). Contract request 3 is revised
(`reissueFailed` with no reissue pending, and the reopen), and item 4 names the two new refusal
codes.

Residuals (the review record has all eight):

- A spurious reopen once, if a watched mint received ecash under the new phrase meanwhile.
- The reopen lands up to one retry wait (at most 10 min) after the inputs come back.
- A mint that loaded earlier in this process and then died is not "cannot be asked" until a
  restart.
- A build from before this round reads an envelope carrying `watchedMints` as damaged.
- A retry stuck on the signer stays stuck (flows are refused, not hung).
