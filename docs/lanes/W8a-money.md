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

| W8a-money — final review, money plane / NUT-13 | `stage-3/r8-money` | DONE. The round-8 panel's money findings, each with a test that failed before its fix:<br>• restores, reissues, plans and journal settles hold their mint in the PAY/melt gate (core `holdMint`); the PAY-behind-restore loss reproduced and closed;<br>• the PAY deadline model counts a seeded send (seeded belt 12.6 s); PAY sends bounded in core (`SendBound`: turn check, no collision re-run, one skip-ahead batch); the mint loaded and probed before the turn;<br>• restore follows core's `resume` (10 calls, cursor kept; a phrase past 20 000 counters restored whole);<br>• a reissue completes only with no journal entry or dust left; the relay copy retried with a bounded backoff;<br>• the plane runs the wallet's close (drain bounded, no late watermark write), the startup restore, one counters store per identity; the counters file takes core's probed-keyset entry;<br>• a repeated journal `begin` refused; play sessions closed before a reopen.<br>Nutshell and cdk real-mint suites green. Review `docs/reviews/2026-09-27-pre-push-w8a-money.md` (43 mutation checks) |
