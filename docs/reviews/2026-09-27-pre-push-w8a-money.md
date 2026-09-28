# Pre-push review — W8a-money: the final cross-lane review's money plane / NUT-13 findings (2026-09-27)

Diff: `aca2d6a` (the merged Stage 3 head, integration fix 2 included) → `stage-3/r8-money`
(lane W8a-money): `223a0a6`, `16ef875`, `9a233d9`, `4cf3dc1`, then the docs. 25 source and test
files, +2 607 / −133. Method: the `differential-review` and `sharp-edges` skills, inline on the
whole diff, after every finding was first reproduced (or refuted) against the code.

- Nothing changed under `packages/core/src/contracts/`, `docs/status.md` or
  `docs/security-review.md`. The locked `packages/core/src/wallet/spend.ts` changed: no logging, no
  new import (`npm run check:locked`: OK).
- Contract request: `docs/contract-requests/W8a-money.md` (the Settings screen).
- Nothing outward: no push, MR or issue edit.

## 1. The findings, verified first

| # | Finding | Verified how | Outcome |
|---|---|---|---|
| 1 | [high] `files.ts:244` the counters file refuses core's state | Binding: int-fix-2's parser admits `ff…` → 0 (its tests and the host test green at the base). Second trigger (a keyset's `published` with no `next`): **reproduced** with core's real counter source over the desktop file — a probe that finds an earlier signature moves the cursor without a lease, `notePublished` moves the watermark, and the next lease save at another mint writes `published: { k: 0 }` with no `next[k]`: refused, and that top-up failed `mint-error: minting failed` | binding **confirmed fixed**; second trigger **fixed** (`parseCounterState` admits exactly 0 there) |
| 2 | [medium] `spend.ts:1030` a restore holds the mint outside the gate | **Reproduced** in the money plane (`money-w8a` "the reviewer's reproduction"): a restore's first batch held, a PAY requested, the clock past the worker's deadline, the batch released — at the base the PAY waited in core and its sends reached the mint after the deadline | **fixed**: `holdMint` → `PayMeltGate.hold` |
| 3 | [medium] `deadlines.ts:65` the model assumes unseeded sends | **Confirmed by reading** `sendOnce` / `resolve` / `ran` / `advanceKeysets`: a seeded send after a lost answer asks restore **and** NUT-07; the probe of an unknown keyset is one more batch; the collision path runs a second full send after up to 200 batches at a NUT-12 mint — no finite belt covers that | **fixed** (§3) |
| 4 | [medium] `service.ts:736` restore drops `resume` | **Reproduced** with real core (`recovery-host` "past 20 000 counters"): with one call per phrase the restore adds the 81 signatures below 20 000 and stops (the reviewer's "refused" when nothing is below) | **fixed** (§4) |
| 5 | [low] `service.ts:456` complete with held/dust proofs | **Confirmed by reading** `reissueAll`: planned from `balances()` (held proofs excluded), dust `continue`d, `complete: failed === 0`; a service test with a pending entry at a mint showed the replaced copy blanked | **fixed** |
| 6 | [low] `service.ts:380` relay copy never retried | **Confirmed**: `publishRelayCopy` only in `setupNow` | **fixed** |
| 7 | [low] `money.ts:527` close never closes wallet or counter source | Counter source: int-fix-2 closes it (`closeCounters`, confirmed). Wallet close / one store per identity: **confirmed** missing (`seedFor` built a new `FileCounterStore` per open) | **fixed** (§5) |
| 8 | [info] `money.ts:367` `restoreUnpublished()` never called | **Confirmed** (no caller in `packages/app-desktop`) | **fixed** (`startupRestore`) |
| 9 | [info] `nip60.ts:450` duplicate `begin` replaces | **Reproduced** (`nut13-bounds`: a counters file rolled back to 0 over a journal that still holds an entry — the next receive's `begin` replaced it at the base) | **fixed**: `JournalConflictError`, nothing changed |
| 10 | [info] `service.ts:753` edge cases | (a) reading: the reopen's worker restart can orphan a host `pay.build`; (b) reproduced: the typed all-zero phrase passes `fromIndices`, `toSeed` refuses it, every row read `unreachable`; (c) reading | (b) **fixed**; (a) **narrowed**, rest deferred; (c) **deferred** |
| 11 | [low] `money.ts:266` lifecycle (tests review) | = 7 and 8 | **fixed** |
| 12 | [info] `money.ts:519` extra tail authorisations | **Confirmed by reading**: `reopenMoney` → `MoneyPlane.close` → `keepTail(null)` per open session | **fixed**: sessions closed through the worker first |

## 2. What changed

**Core** (`packages/core/src/wallet/`):

- `wallet.ts` — `CashuWalletOptions.holdMint`: `reissuePlan`, `reissue`, each mint of
  `seeded.restoreFromSeed` and of `restoreUnpublished`, each mint of `recoverPending` run as
  `holdMint(mint, run)`. A mint the hook refuses before the scan is reported `unreachable` (the
  `resume` it was given kept); anything the scan throws is still thrown. The hook gets `run` once
  (a second call is refused; resolving without running it counts as a refusal).
  `close({ flush })`: asked after the drain, `false` skips the watermark write. `prepare(mint)`.
  `send(…, { bound })` passed through.
- `spend.ts` (locked) — `SendBound`; `send` with a bound awaits `onTurn` first thing inside the
  mint's lock (a throw refuses with nothing selected or journaled), runs `once` instead of `twice`,
  and marks the mint in `bounded` so `advanceKeysets` asks one batch (its `capped` flag; `collided`
  now takes the mint). `prepare(mint)`: load + `own(w)` (the probe), outside the lock.
- `store.ts` / `nip60.ts` — `checkBegin`: a `begin` whose id is still journaled after the
  transition's own `settle` rejects with `JournalConflictError` before anything changes.
- `index.ts` — exports `SendBound`, `JournalConflictError`, `counterBinding`.

**Desktop** (`packages/app-desktop/src/`):

- `host/pay-melt-gate.ts` — holds beside melts (`hold`, `refusal`, `HOLD_AT_MINT`,
  `PAY_STILL_BUILDING_HOLD`); a PAY hears the melt's reason first.
- `ipc/deadlines.ts` — the seeded terms, `payBuildWorstMs(pending, loaded, seeded, sends?)`,
  `payBuildStartByMs(pending, loaded, seeded)`, `sendStartByMs`, `PAY_BUILD_SEEDED_*`.
- `host/money.ts` — `holdMint`; `payBuild` checks the gate's mark, `prepare`s the mint, uses the
  seeded belt; the engine's wallet is `paySend` (bounded, `sendTurn`); `close` runs the wallet's
  close, `drained(ms)`; `startupRestore`; `pendingAt`; a failed open closes its counter source.
- `host/signer/desktop-signer.ts` — the swap awaits the old plane's drain before `beforeOpen` and
  the next open; `retire` adds it to what the quit waits for.
- `host/recovery/files.ts` — the parser (finding 1's second trigger).
- `host/recovery/service.ts` — per-identity counters store; `restorePass` (resume loop, cursor);
  reissue completeness (`clean`, `blocked`); the relay retry (`scheduleRelayRetry`,
  `relayRetryNow`, `relayRetryOnce`, `stop`); `closeSessions`; the all-zero typed phrase.
- `host/recovery/core.ts` — `seeded` typed `CoreSeededWallet`; `phraseTag` (core's binding).
- `host/host.ts` — `closeSessions` (bounded by `QUIT_FLUSH_MS`), `recovery.stop()` at stop.

## 3. The PAY deadline, seeded

A seeded send, per its worst path (read in `sendOnce`, `refused`, `resolve`, `ran`):

- continues the PAY: swap lost → NUT-09 restore → NUT-07 `ran` = yes → executed: **3** round trips,
  3 publishes;
- ends the PAY: swap lost → restore → `ran` = no → collision → skip-ahead: **4**, and core no
  longer runs it again for a bounded send; a refusal (restore + reconcile) ends it after 3.

So a seeded PAY at a loaded mint: 2 × 3 + 1 probe + 1 collision batch = 8 round trips × 30 s +
6 publishes × 7.4 s + 3 counters saves × 1 s = 287.4 s: **12.6 s** to start. Per journal entry:
2 round trips per send as before, plus one skip-ahead batch and one save. Not loaded, or any entry:
negative — refused. The not-loaded case would never recover by itself (a refused PAY never loads
the mint), so `payBuild` loads and probes first (`prepare`); that time counts from arrival.

The gate sees PAYs, melts and holds only. A redeem or a top-up can hold core's queue, and its own
settle may run the 200-batch skip-ahead. So each send asks again at its turn inside core
(`sendStartByMs(pending, loaded, seeded, sendsLeft)`: 12.6 s for the first of two seeded sends,
125.8 s for the last; 135.6 s / 217.8 s unseeded). Refused there: nothing selected, nothing
journaled; a refused second send leaves the seeder's share in the engine's orphans (reused by the
next PAY to that seeder — the engine's existing path for a failed creator send).

## 4. Restore, continued

`restorePass` calls `seeded.restoreFromSeed(seed, todo, progress, { resume })` in rounds: the
first with each mint's kept cursor (or none), then only the mints whose report carried `resume`
and whose scan moved (a keyset finished or a counter went up). At most `RESTORE_ROUNDS` = 10
rounds; each round is core's cap (200 batches a keyset). A report without `resume` ends that mint
with its own outcome; sats of every round add up; a mint with sats reads `restored`; one still
unfinished with none reads `unreachable` — never core's `refused`, which it returns for the cap.
Cursors are kept per identity, phrase (`phraseTag`: core's counters-file binding, a keyed BLAKE2b
— it can only confirm a guessed phrase; never logged) and mint, in memory.

## 5. The wallet's close

`MoneyPlane.close` keeps its synchronous fences (sessions → tails, the settle loop, the counter
source, the key, the journal, the seed wiped at once) and then starts `CashuWallet.close({ flush })`
(new operations refused, running ones ended, then the watermark). `drained(ms)` resolves when that
finished or after `ms` (2 s); on the timeout it marks the plane released, so the flush predicate
answers `false`, and waits for a flush that had already started (a local write). The signer's swap
awaits it before `between` (a rotation's `retireCounters`) and before the next plane's open; the
quit through `flushTails`. The integration fixer's `ENOTEMPTY` race: the write either lands before
the swap moves on or never.

## Differential review

**Risk per file.** HIGH: `spend.ts` (value transfer; locked), `wallet.ts`, `money.ts` (the money
boundary), `pay-melt-gate.ts`, `deadlines.ts` (the loss bound), `service.ts` (phrase handling,
reissue fees). MEDIUM: `store.ts`, `nip60.ts`, `files.ts`, `desktop-signer.ts`, `host.ts`. LOW:
`index.ts`, `core.ts`, tests.

**Removed or weakened code.** Three pinned test lines changed, each with the reason in place:
`money-seed` (the post-close refusal now comes from the closed wallet, earlier than the counter
source); `recovery-service` "fee eats the amount" (dust keeps the backup pending — the finding's
decision); `recovery-files` (two lines listed core's `published` 0 without `next` as damaged). No
validation removed: `parseCounterState` widened by exactly the value core writes (0), still
refusing any other watermark without a `next`.

**Blast radius.** `CashuWallet` is built in two production places: the desktop's
`GatedCashuWallet` (passes `holdMint`, uses `bound` and `prepare`) and the seeder daemon
(`packages/seeder/src/runtime/index.ts`: no hook, no bound — unchanged behaviour: `hold` runs at
once, `twice` as before, `close()` flushes by default). `checkBegin` sits under every store's
`commit`; only the `Spender`'s journal begins reach it, and a retry that reuses a prior entry never
begins again (`receiveOnce`, `mintOnce`), so only a repeated counter trips it.

**Test coverage of changed code.** Every changed branch in `spend.ts`, `wallet.ts`, `store.ts`,
`nip60.ts`, `pay-melt-gate.ts`, `deadlines.ts`, `money.ts`, `desktop-signer.ts`, `files.ts` and
`service.ts` has a test that fails when it is mutated (below), with two exceptions noted as
residuals: `host.ts`'s `closeSessions` closure and `recovery.stop()` wiring (the service's spy
covers the order), and the quit-path budget.

**Adversarial pass.** Attackers: a compromised worker (sends `pay.build`), a hostile mint, a
malicious relay.

- *Worker*: `paySend` refuses a send outside a PAY build; `onTurn` is the host's code, keyed by
  the mint of the build the gate let through; a worker cannot reach `holdMint`, `prepare` or the
  restore. A worker spamming `pay.build` during a restore is refused at once (no queue).
- *Hostile mint*: can answer slowly or sign everything. Slowly: it holds only its own mint's gate
  (PAYs elsewhere unaffected) for up to one call's scan; the drain bound keeps a sign-out from
  waiting on it. Signing everything: before this lane a restore stopped at core's cap; following
  `resume` could have been unbounded — now 10 calls (a tenfold longer hold at that mint, then the
  cursor waits for the next press). `resume` values come from core's own scan counters, not from
  the mint's answer; `moved()` stops a scan that does not advance. The startup range is this
  device's own counters file (a mint cannot stretch it).
- *Relay*: the retry republishes the same NIP-44 ciphertext the setup published; nothing new is
  exposed. The retirement retry runs only for a finished reissue, as before.
- *Logs*: new lines carry counts and allow-listed reason codes; the phrase tag, cursors, mint
  URLs and amounts are not logged. Every new constant message passes the phrase rule (`log.test`).

## Sharp edges checked

| API | Probe | Outcome |
|---|---|---|
| `holdMint` | a hook that runs `run` twice (a reissue twice), or resolves without it | **fixed**: `run` handed out once; not run = refusal |
| `SendBound.onTurn` | one presence toggles the turn check and the bounded collision path | kept together on purpose (both are what a deadline-bound caller needs), documented; `onTurn` not a function → `invalid-argument` before anything |
| `SendBound.onTurn` | slow or hanging `onTurn` holds the mint's turn | documented ("must answer at once"); the plane's reads the in-memory journal |
| `payBuildWorstMs` / `payBuildStartByMs` | `seeded` defaulted to `false` — the looser belt for a caller who forgets it | **fixed**: required |
| `payBuildWorstMs(…, sends)` | `0`, negative, NaN | read as the whole PAY (the larger worst: safe side) |
| entry counts | NaN, negative, fractional | read as infinite: refused (unchanged rule) |
| `MoneyPlane.drained(ms)` | `0`, negative, NaN; called on an open plane | `0`/negative/NaN release at once (skip the write — the safe side); open plane → rejects |
| `close({ flush })` | default | writes (the seeder daemon's shutdown keeps its flush) |
| `PayMeltGate.hold` | `meltWaitMs` 0 | refused at once if a PAY is building (constructor already validates durations) |
| `RESTORE_ROUNDS`, backoff | configurable? | constants; backoff exponent capped at 16, delay at 1 h |
| `JournalConflictError` | silent success? | rejects the whole transition; the operation fails before its request |
| `parseCounterState` | widened | exactly `published` 0 without `next`; any other value still refused |

## Mutation checks

Each mutation applied alone to the committed code, the named test run, the file restored.

| # | Mutation | Killed by |
|---|---|---|
| C1 | `onTurn` not awaited | `nut13-bounds` asked at its turn |
| C2 | a bounded send runs `twice` | `nut13-bounds` counter collision reported once |
| C3 | skip-ahead cap ignored | same |
| C4 | `prepare` probes nothing | `nut13-bounds` prepare |
| C5 | `holdMint` bypassed | `nut13-bounds` holdMint (3 tests) |
| C6 | a gate refusal rethrown | `nut13-bounds` asks the gate once per mint |
| C7 | `close` flush predicate ignored | `nut13-bounds` close |
| C8 | `checkBegin` a no-op (memory store) | `nut13-bounds` journal begin |
| C9 | `checkBegin` removed (NIP-60 store) | `nut13-bounds` Nip60ProofStore |
| C10 | `recoverPending` not held | `nut13-bounds` reissue and its plan… |
| C11 | `restoreUnpublished` not held | same |
| C12 | `reissue` not held | same |
| C13 | `holdMint` may run twice | `nut13-bounds` gets its operation once |
| C14 | `holdMint` may skip `run` | same |
| D1 | gate: holds do not mark | `pay-melt-gate` W8a |
| D2 | plane: no `holdMint` | `money-w8a` the reviewer's reproduction |
| D3 | plane: unseeded belt for a seeded PAY | `money-w8a` seeded belt — **survived at first** (each send's own check refused the PAY anyway, one step later); the test now asserts the refusal came before the wallet (the auto top-up hook heard only the first PAY): killed |
| D4 | plane: no `prepare` | `money-w8a` not loaded |
| D5 | plane: send turn not checked | `money-w8a` redeem |
| D6 | plane: late flush allowed | `money-w8a` drain |
| D7 | plane: no startup restore | `money-w8a` startup restore |
| D8 | plane: failed open leaves the counter source open | `money-w8a` fails after |
| D9 | deadlines: no seeded extra round trip | `deadlines` W8a |
| D10 | deadlines: counters saves free | same |
| D11 | deadlines: no collision batch | same |
| D12 | signer: swap does not await the drain | `desktop-signer` drains before |
| D13 | signer: quit does not wait for the drain | same |
| D14 | service: restore not continued | `recovery-service` continued |
| D15 | service: an unfinished scan reads core's `refused` | `recovery-service` bounded per restore |
| D16 | service: no-progress not detected | `recovery-service` does not move the scan on |
| D17 | service: cursor not kept | `recovery-service` bounded per restore |
| D18 | service: a journaled mint counted clean | `recovery-service` still journaled |
| D19 | service: dust not blocking | `recovery-service` fee eats the amount |
| D20 | service: no retry scheduled after a failed publish | **survived — equivalent**: the reopen just before the publish already scheduled one (`seedFor` reads the new envelope with `relayCopy: false`); kept as the explicit, fresh-backoff trigger |
| D21 | service: backoff not doubling | `recovery-service` bounded backoff |
| D22 | service: a plane open schedules no retry | `recovery-service` still unpublished |
| D23 | service: sessions not closed before the reopen | `recovery-service` closed through the worker |
| D24 | service: a counters store per open | `recovery-service` one counters store object |
| D25 | service: the typed zero phrase scanned | `recovery-service` all-zero phrase |
| D26 | service: `stop()` does not stop | `recovery-service` still unpublished |
| D27 | service: restore not continued (real core) | `recovery-host` past 20 000 counters (81 of 84 sats) |
| D28 | plane: the last send bounded like the whole PAY | `money-w8a` second send |
| F1 | `parseCounterState` refuses `published` 0 without `next` | `recovery-files` W8a (`minting failed`) |

43 mutations: 42 killed, 1 equivalent (D20).

## Gates

- Touched tests: every touched file green, file by file during the lane (36 new tests) and in the
  whole-suite run below.
- The whole suite once, on the final code, after `npm run build` (`npx vitest run
  --maxWorkers=2`): 237 files passed, 5 skipped; 3 866 tests passed, 30 skipped; 619.7 s; no
  timing failure to rerun. A local-run guard added to this machine later on 2026-09-27 blocks
  every run after it: all results here were taken before.
- `npx tsc -b --force`: clean. `npm run build`: clean.
- eslint + `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK. `npm run lint:electron`: OK (264 files, 0 violations).
- Real mints (`NUTFLIX_REAL_MINT_URL`, with `NUTFLIX_REAL_MINT_URL_2=http://127.0.0.1:3398`):
  `nut13-real-mint`, `journal-real-mint`, `recovery-real-mint`, `topup-real-mint`,
  `desktop-owed.integration` — 23/23 on Nutshell 0.21.0 (`:3399`), 23/23 on cdk-mintd 0.18.1
  (`:3397`).
- No Electron e2e (as briefed).

## Residuals

1. **No "not finished" in the UI.** An unfinished restore reads "could not be reached"; the
   Settings screen has no Continue (contract request 1). The cursor lives in this process: a
   restart starts that scan again from 0.
2. **A seeded PAY waits out any journal entry at its mint.** With one entry the seeded belt is
   negative: PAYs there are refused (`rate-limited`, retried) until the settle loop decides it — a
   young send entry up to `PENDING_SETTLE_AFTER_S` (10 min). Unseeded, one entry at a loaded mint
   still leaves 15.6 s.
3. **12.6 s is tight under slow relays.** A PAY build's six publishes can take longer than that;
   the next PAY at the same mint is then refused and retried (throughput, not loss).
4. **The first startup restore after this change** scans the whole `[published, next)` range of an
   install whose watermark never moved (restoreUnpublished never ran), uncapped, holding each mint.
   Once; the watermark then moves.
5. **This device's own phrase** is still scanned below its counters file's `next` in one core call
   (N1's design), so such a call — and the gate hold at that mint — has no cap.
6. **Dust keeps a backup pending**, and a replaced phrase's relay copy on the relays, until the dust
   is spent (contract request 3).
7. **The relay retry shares the flows' `busy` flag**: a flow started during a retry (one publish,
   ≤ 7.4 s) is refused "a recovery phrase window is already open".
8. **`COUNTER_SAVE_WORST_MS`** (1 s) is an allowance, not enforced; a keyset rotated twice inside
   one PAY would need a second probe (the model counts one). Each send's own turn check still
   bounds when it may start.
9. **Info (a)**: a host `pay.build` waiting on its swap when a reopen restarts the worker can still
   finish with no worker to deliver it; closing the sessions first narrows it (same class as the
   earlier lanes' residual 7).
10. **Info (c)**: `redact()` slices to 4 096 characters before the phrase rule (defence in depth;
    no code logs a phrase) — deferred: a correct fix needs the rule over a sliding window, not a
    one-line change.
11. **The quit** may spend up to 2 s more on the drain (only while an operation runs at a mint),
    inside main's 9 s grace after the 7 s session close; if main ends the process there, only the
    watermark write is lost.
12. **Untested wiring**: `host.ts`'s `closeSessions` closure and `recovery.stop()`.

## Fix round 8 (2026-09-27): F55, F56 and the relay retry's lock — tests written, NOT run

The round-8 verifier of this lane: two medium findings and an info item, all in
`packages/app-desktop/src/host/recovery/service.ts`. Commits `79b7474` (the fix, with the tests)
and `f8cf026` (two more tests). **The tests are written but NOT run**: since the local-run guard
(noted under Gates above) no test runner runs on this machine, so every test below runs later in CI.
Each one was reasoned through against the code instead; the "mutation checks" below are that
reasoning — what the test asserts, and why it fails without the fix — and are marked **not run**.

### The findings

| # | Finding | Verified how | Outcome |
|---|---|---|---|
| F55 | [medium] `service.ts:738` a mint blocked by a journal entry is moved but not recorded, so every "Finish backup" swaps its seeded balance again and charges the fee again | **Confirmed by reading**: `reissueAll` asked and moved the mint, then `clean(p.mint)` failed, so it was counted `blocked` and not `record`ed; the next `setup()` goes to `finishReissue`, core's `reissuePlan` → `spendable()` takes every proof held there (the seeded ones too) and the dialog asks again. The verifier's temporary test measured [100, fee 1], [99, fee 1], [98, fee 1] | **fixed** |
| F56 | [medium] `service.ts:672` dust, or an entry at a zero-balance mint, keeps `reissuePending` true for good, and "Replace phrase" with it | **Confirmed by reading**: dust and an unclean zero-balance mint were `blocked++`, `complete` stayed false, `setupNow` routes every `!reissued` envelope to `finishReissue`, and `RecoverySection.tsx` shows only "Finish backup" while `reissuePending` | **fixed**: the rule below |
| info | `service.ts:1066` the relay copy retry takes `busy`, so a Settings action during a retry is refused "a recovery phrase window is already open" (the screen then says "Too many windows were closed in a row") | **Confirmed by reading** `relayRetryNow` / `exclusive`; the same as residual 7 above | **fixed**: the retry no longer takes `busy`; a flow waits for it |

### The rule (decided here)

For each mint of the wallet, `reissueAll`:

1. **Recorded under this phrase** — done, never planned again (fix round 7).
2. **Nothing spendable** — done, whatever is journaled there. Nothing there can move, and an entry
   at a dead mint never settles: it must not keep the backup, and the next rotation, pending for
   good.
3. **Dust** (the plan's fee ≥ its amount) — done: never asked, never recorded. It is worth less
   than the fee to move it (and about that to spend it there).
4. **A balance worth moving while an operation is journaled there** (checked after the plan, which
   settles what it can first) — **not moved**, and the reissue stays pending (`blocked`, counted in
   `reissueFailed`) until the entry settles; "Finish backup" then moves it once. Bounded by the
   operation: a PAY whose answer was lost settles within 600 s, a melt when Lightning settles it.
5. **Otherwise** — planned, asked, moved and **recorded at once**, with no second look at the
   journal: the plan was taken clean and core's `reissue` refuses holdings that changed since the
   plan, so an entry there after the move was begun since, without the planned proofs, on the
   seeded wallet — under this phrase.

What rules 2 and 3 leave out keeps **a replaced phrase's relay copy**, not the backup: the copy is
retired only once `outsideLeft` finds no mint the new phrase did not record holding a spendable
balance (dust, or inputs an entry gave back) or a journal entry. Store reads only; no plane of the
identity, or a read that fails, counts as something left. It is checked at completion
(`finishReissue`), before a rotation (`retireReplaced`) and at every relay copy retry
(`relayRetryOnce`), which keeps looking with its backoff (30 s doubling to 1 h) until the copy goes.
This keeps the earlier decision's point (the old copy is not retired while the dust is restorable
only by it) without letting dust block a rotation.

The relay copy retry (info item): `relayRetryNow` no longer sets `busy`; it records its run in
`relayRun`, and `exclusive` awaits that run (errors swallowed) after taking `busy` and before the
flow. A retry never starts while `busy` or another retry's run is set, and `relayRun` is set before
anything is awaited, so no flow starts between the check and the set. The envelope writes stay
serialised; a Settings action is delayed by at most one retry's publishes instead of refused.

### Tests (written, NOT run — pending CI)

`packages/app-desktop/src/host/__tests__/recovery-service.test.ts`. Corrected, each with a comment
citing its finding (they pinned the behaviour the findings describe; none weakened):

- `guard rails` › "a reissue plan … whose fee eats the amount, is never asked": `reissuePending`
  `true` → `false`, `reissueFailed` `1` → `0` (F56); added: the envelope is `reissued: true` with
  `reissuedMints: []`, and nothing was reissued.
- `W8a: a reissue is complete…` › "an operation still journaled at a mint…": the rotation's
  `reissuedSats` `99` → `0` (F55); added: `feeSats` 0, one reissue dialog in all, one move under
  the first phrase, then exactly one more (99 sats, fee 1) once the entry cleared. Title corrected.
- same › "a mint whose whole balance is held…": was "… blocks it too" (`true` / `1`); now the backup
  is finished (`false` / `0`), a rotation runs while the entry is there, the replaced copy is kept
  (no NIP-09 deletion, the "relay copy is kept" log line), and the relay retry retires it once the
  entry cleared (F56).

New, `describe('fix round 8: F55, F56, the relay retry and the flows')`:

| Test | Mutation check (reasoned, **not run**) |
|---|---|
| F55: never moved while journaled; presses ask nothing, charge nothing; moved once when clean | Round-8 code: the rotation moves 99 → 98 (the fake's reissue mirrored into the balances), each press again (98 → 97, 97 → 96): `reissuedSats` 98 ≠ 0, `reissued` 4 entries ≠ 1, 3 dialogs ≠ 1 — **killed**. Moving the clean check before the plan: equivalent here (the fake's `pendingAt` is static; with real core the plan's settle can clear the entry, which is why it comes after) |
| F55: a moved mint is recorded at once despite an entry begun during the move | The fake's reissue journals an entry at the mint after moving. Round-8 code (or the post-move clean check restored): the mint is `blocked`, not recorded — `reissuePending` true, `reissuedMints` `[]` — **killed** |
| F56: dust with an entry at the same mint is still done | Round-8 code: dust `blocked` → pending — **killed**; the clean check placed before the dust check: `blocked` → pending — **killed** |
| F56: dust counts as done; "Replace phrase" rotates; the replaced copy stays until the dust is spent | Round-8 code: `r1` pending, and the second setup finishes the reissue instead of rotating (the verifier's probe) — **killed**. `outsideLeft` dropped from `finishReissue`: a blank is published at the rotation — **killed**. Dropped from `relayRetryOnce`: the first retry, dust still there, retires the copy — **killed**. `outsideLeft` reading entries only: the dust is not seen, the copy goes at the rotation — **killed** |
| F56: a copy kept for dust is not retired by the next setup either | `outsideLeft` dropped from `retireReplaced`: the blank and deletion go before the passphrase prompt — **killed**. Round-8 code: the third setup is a "Finish backup" and resolves instead of asking the passphrase — **killed** |
| info: a Settings action during a retry waits for it, never refused | The retry's publish is held open; `show()` is called. Round-8 code: refused `rate-limited` at once, so `shown` is the error, not `'shown'` — **killed**. `exclusive` not awaiting `relayRun`: the passphrase prompt is asked while the retry is held, `asked` is not `[]` after 30 ms — **killed** |

Not covered by a test (reasoning only): the `relayRun` check in `relayRetryNow` (needs two
identities' retries overlapping, one taking longer than the other's 30 s wait); `outsideLeft`'s
fail-safe branches (no plane of the identity, a read that throws).

### Static checks run here

- `npx tsc -b`: clean (the host project includes the tests).
- `npx eslint` and `npx prettier --check` on `service.ts` and `recovery-service.test.ts`: clean.
- `npm run check:locked`: OK (no locked path touched).
- `node scripts/electron-security-lint.mjs packages/app-desktop`: OK, 264 files, 0 violations.

### Differential review and sharp edges (inline, on this round's diff)

- **Blast radius**: `reissueAll` (called by `finishReissue` only), `finishReissue`,
  `retireReplaced`, `relayRetryNow` / `relayRetryOnce`, `exclusive` (every renderer flow). No wire,
  envelope or IPC change; nothing under `packages/core/src/contracts/`, `docs/status.md` or
  `docs/security-review.md`.
- **Money**: F55 removes a repeated charge; nothing now moves that did not before, except that a
  mint recorded after a clean plan is no longer left unrecorded by an entry begun during the move
  (rule 5 — the double move the post-move check could cause). Dust and zero-balance mints were
  never moved before either; only their effect on completion changed.
- **Fail-safe direction**: `outsideLeft` answers "something is left" on any doubt, so the only
  failure mode is a replaced relay copy kept longer (sealed to self, restores only what the old
  phrase covers) — never a copy retired while it may still restore funds.
- **Secrets / logs**: two new log lines, constant sentences, one field `mints` (a count). Nothing
  from the envelope, a mint URL or an amount is logged.
- **Sharp edge — the flow now waits instead of failing fast**: `exclusive` awaits the running
  retry, bounded only by the pool's publish timeouts (nostr-tools: about 7.4 s per publish, so at
  most about 15 s for a publish then a retirement). A pool whose publish never settled would hold
  every recovery flow; before this change the same retry held `busy` for good and refused them
  all, so nothing gets worse, and the production pool settles every publish.
- **Sharp edge — concurrency**: the retry's check-then-set of `relayRun` has no `await` between
  them; `exclusive` sets `busy` before awaiting, so a retry firing while a flow waits reschedules.

### Residuals of this round (supersede residuals 6 and 7 above)

1. **A replaced copy kept for leftovers may stay long.** `outsideLeft` cannot tell the phrases'
   proofs apart, so money that arrives later at a mint the new phrase did not record (a new mint,
   or the dust mint itself) keeps the copy too, and the retry looks again hourly for as long as the
   process runs. Harmless (the copy is NIP-44 to self), but not "retired once the dust is spent".
2. **Inputs a zero-balance mint's entry gives back after the backup finished** stay under the
   phrase (or random outputs) they were made under until the next rotation: the backup is not
   reopened for them (the screen has no state for it). A replaced copy, if any, is kept while they
   are there, so a restore still finds them; after a first setup there is no copy (random outputs,
   as before any phrase).
3. **A mint that keeps an operation pending keeps the backup pending**, and "Replace phrase" away,
   for as long as the operation lasts — bounded by the operation (600 s for a lost PAY answer; a
   stuck Lightning HTLC can take days), not forever; a hostile mint reporting PENDING for good
   could hold it. A dead mint with a spendable balance still keeps it pending (its plan fails:
   unchanged since fix round 7).
4. **A second rotation drops the older copy's tracking** (unchanged; now also when dust kept it):
   that copy stays on the relays.
5. **A reissue whose outcome was unknown** (core throws, the entry is its own) is not recorded;
   once settled, the next "Finish backup" moves that mint once more (one extra fee). Unchanged by
   this round.
6. **The screen** cannot say "waiting for a payment to settle" or "a few sats stay outside the
   phrase", and reads every `rate-limited` as the throttle (contract requests 3 and 4, revised).
