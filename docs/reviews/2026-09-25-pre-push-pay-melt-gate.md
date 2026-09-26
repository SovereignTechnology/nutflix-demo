# Pre-push review: the per-mint PAY/melt gate (2026-09-25)

Diff: `9a20d30` (Stage 3 integration head) → `stage-3/int-pay-melt-gate`, lane I2-paygate.
Commits:

- `6fd9525` the gate, the belt, the shared deadlines and the worker retry;
- `33ebe36` two regression tests;
- `92cfc67` the sharp-edges fixes;
- then the docs.

Method: `differential-review` and `sharp-edges`, run inline. Then a pre-fix run of every new
test and seventeen targeted mutations. Contracts and locked paths are untouched:
`npm run check:locked` is OK. No contract request was needed.

## The finding this closes

Core runs a wallet's operations at one mint one at a time (`Spender.exclusive`, FIFO,
`core/src/wallet/spend.ts`). `Spender.melt` holds that turn through `completeMelt`, and since
issue #8 fix round 3 a melt request may take 300 s (the mint pays over Lightning before it
answers).

A video PAY at the same mint takes this path:

- `host/money.ts` `payBuild` → `RealPaymentEngine.pay` → two `wallet.send` calls;
- each send queues for the same turn;
- the worker waits 300 s for `pay.build` (`worker/rpc.ts`);
- the host cannot cancel a request (`host/worker/supervisor.ts` `onRequest`).

So a PAY queued behind a long melt was built after the worker had given up. Its proofs were
swapped into P2PK sets locked to the seeder and the creator, never delivered, with no refund.
There is a second path: the melt was queued *between* the PAY's two sends, and the creator send
then waited out the Lightning payment.

**Pre-fix reproduction** (the new `money.test.ts` scenario on `9a20d30`'s `money.ts`): the melt
was held and failed with a timeout at t = 300 s. The PAY asked for at t = 0 then made **two
P2PK swaps at t = 300 000 ms**, at the worker's deadline:

```
AssertionError: expected [ …(2) ] to deeply equal []
+   { "at": 300000, "path": "POST /v1/swap" }, …
```

## Scope and risk

- HIGH (value transfer):
  - `host/pay-melt-gate.ts` (new): the gate;
  - `host/money.ts`: `GatedCashuWallet` (core's `CashuWallet`, `melt` overridden), and `payBuild`
    running inside the gate with a re-check at its turn;
  - `host/topup/auto-topup.ts`: a melt the gate refused counts as nothing moved.
- MEDIUM:
  - `worker/pay/viewer-payer.ts`: the retry after `rate-limited:`;
  - `ipc/deadlines.ts` (new): the shared numbers;
  - `worker/rpc.ts`, `host/mint-transport.ts`: use the shared numbers, same values as before.
- LOW: `ipc/index.ts` (a re-export), tests, ADR 0012.

**Blast radius.**

- `MoneyPlane.wallet` is now a `GatedCashuWallet`, and it is the wallet of every desktop spend:
  - the adapter's wallet (`host.ts`: `SwitchingWallet.set(flow.money()?.wallet)`, or
    `fixedMoney.wallet`);
  - the auto top-up (`liveWallet`);
  - the viewer engine and the settle loop.
- Only `melt` changed behaviour. The other methods are inherited unchanged:
  `instanceof CashuWallet` still holds, `recoverPending` and `settleSchedule` are the same.
- `payBuild` has one caller, the supervisor's `pay.build` handler.
- `ViewerPayer` has one constructor site (`worker/host.ts`).
- `WorkerRpc`'s default deadline is the same 300 s. `hostMintRequest`'s timeouts are the same
  30 s / 300 s (core's defaults, now passed explicitly).

**Melt call sites.** Found by grepping for `melt(` across `packages/app-desktop/src`:

| Call site | Path | Gated |
|---|---|---|
| The user's withdrawal | renderer `wallet.melt` → main's money gate (native confirm) → `dispatch.ts` → `adapter.wallet.melt` → the plane's wallet | yes (tested through the whole host) |
| An auto top-up's funding melt | `auto-topup.ts` `w.melt` on `money()?.liveWallet` | yes (tested through the whole host) |
| Seeder earnings | renderer `seeder.melt` → worker, which refuses it (`payments-unavailable: … lands with the Stage 2 wallet`); the daemon's earnings melt was dropped (ADR 0011 §8) | no host melt exists |
| Settle loop, startup recovery | `recoverPending` → `resolveMelt`: checks a melt quote's state and restores change, never pays | not a melt |

## Adversarial questions

- **Can a PAY still be built behind a melt?**
  - A melt increments the mark synchronously, before any await, and refuses every waiting PAY.
  - A PAY checks the mark synchronously on entry, then takes or waits for the turn. A waiting PAY
    is refused when the mark is set, and a running one holds the turn, which the melt waits for.
  - Core's lock is per wallet and the gate is per plane (one per wallet).
  - So no PAY of this wallet enters core's queue while a melt of this wallet is pending or in
    flight at that mint.
  - Tested: melt in flight → refused at once, no request reached the mint. PAY in flight → the
    melt's first request at the mint comes after both of the PAY's swaps. A PAY waiting its turn
    when the melt is marked → refused.
- **Can the mark stick?** `melt` decrements in a `finally` around the wait and `run`. That covers
  a thrown melt, a timed-out melt, a refused wait, and several melts at once (a counter).
  Mutation M3 kills three tests.
- **Can the gate deadlock?**
  - PAY builds never wait for melts: they are refused.
  - A melt waits only for the PAY holding the turn, at most `meltWaitMs`.
  - The auto top-up that a PAY triggers (`paidAt`) is deferred, never awaited by the PAY, and its
    melt is at `fromMint`, never the PAY's mint (`autoTopUpDue` refuses the source itself).
  - Nothing inside `viewer.pay` melts.
- **Can a compromised worker starve the user's withdrawal?**
  - It can only send authorised PAYs: an open session, the manifest's terms, the budget.
  - While a melt is marked, each of them is refused at once, so a melt waits for at most the one
    PAY that holds the turn.
  - Queued PAYs are bounded by each session's budget, reserved when the PAY is queued.
- **Can a PAY waiting its turn be built for something that ended?** At its turn it re-checks
  `open()` (a sign-out closes the plane) and that its session's budget object is still the
  registered one. Test: the session closed while waiting gives `session-closed`, and a
  sign-out gives `payments-unavailable`. Mutation M8 kills it.
- **Budget accounting.** Blocks are reserved before the gate, as before, and returned on any
  failure, a gate refusal included. The belt test checks that five more PAYs fit after a
  refusal.
- **Does the worker ban-loop, loop, or tear the session down?**
  - `UpstreamPayer.payPending` rejects. The chain's `catch` logs `upstream pay failed`. The
    blocks stay in `pending` and nothing is sent.
  - The seeder never sees a PAY, and `SeederCredit` never asks beyond its window, so there is no
    `window-exceeded` cut or ban. The session is untouched.
  - Before this lane the payer retried only on its next trigger: a download, an ACK, credit
    pressure, or a tail. With every credit unit held by owed blocks, none of those may come, so
    streaming could stall until the viewer seeked. See finding F3 below.
- **Does anything log a secret or a peer?**
  - The gate logs nothing.
  - Its refusal texts are constants and name no mint.
  - The worker's existing `upstream pay failed` line carries the refusal text, redacted by the
    worker logger as before.

## Findings

| # | Severity | Finding | Outcome |
|---|---|---|---|
| F1 | MEDIUM (sharp edge) | `PayMeltGate.pay(mint, arrived, …)` took a bare `number`. A caller passing `Date.now()` against the gate's monotonic default (`performance.now`) would read as a request from the future and switch the belt off, silently | **fixed** (`92cfc67`): `now()` returns an `Arrival` (branded number), and `pay` takes only that. A `@ts-expect-error` in the test pins it (mutation M17 fails `tsc -b`) |
| F2 | LOW (sharp edge) | `startByMs: NaN` would switch the belt off (`x > NaN` is false), and `Infinity` would too. `meltWaitMs` failed closed either way | **fixed** (`92cfc67`): both must be finite and ≥ 0, or the constructor throws `RangeError` (mutation M16) |
| F3 | MEDIUM (liveness) | A refused PAY is retried only at the payer's next trigger, which may never come when every credit unit is held. A melt at the streaming mint would have stalled playback until the viewer acted | **fixed** (`6fd9525`): after `rate-limited:`, the viewer payer flushes what is owed on a backoff (2 s doubling to 30 s, one timer, reset by a PAY that goes through, cancelled by `close`). Other codes behave as before (mutations M9, M14, M15) |
| F4 | LOW | With PAYs taking turns in the host, a PAY could wait across a session close or a sign-out and be built afterwards | **fixed** (`6fd9525`, test `33ebe36`): re-checked at its turn (mutation M8) |
| F5 | LOW | The auto top-up's ledger counted any melt failure except core's `insufficient-funds` as `unknown`, so a melt the gate refused before it started would have used daily cap for nothing | **fixed** (`6fd9525`, test `33ebe36`): a `GateRefusal` settles `failed` (mutation M10) |
| F6 | INFO | The gate covers melts through the plane's wallet only. A future second `CashuWallet` in the host, or a new melt-like method on core's class, would bypass it | **guarded**: a test fails if `CashuWallet.prototype` grows a method matching `melt/invoice/lightning/bolt` besides `melt` and `meltQuote`. `mint-transport.test.ts` already allows exactly one `CashuMintConnections(` in the desktop (in `money.ts`). A second wallet over those same connections inside `money.ts` is still possible (residual R6) |

## Mutation checks

**Pre-fix run** (`9a20d30`'s `money.ts`, `auto-topup.ts` and `viewer-payer.ts`, with the new
tests): every new behaviour test failed.

- the melt-in-flight, PAY-in-flight, verifier, belt and turn re-check tests in `money.test.ts`;
- both whole-host tests;
- the top-up ledger test;
- both viewer-payer tests.

Only one new test passed pre-fix: "the mark clears after a melt that throws". It guards the new
mark, which does not exist before the fix.

Each mutation was applied alone and the relevant files were run. Each was restored from HEAD
afterwards, with a clean tree checked after every run.

| # | Mutation | Killed by |
|---|---|---|
| M1 | a PAY is not refused while its mint is marked | 8 tests (gate unit, money plane, whole host) |
| M2 | a melt does not wait for the PAY in flight | 5 (gate unit ×2, money plane, whole host ×2) |
| M3 | the mark is not cleared when the melt throws | 4 (gate unit ×2, money plane ×2) |
| M4 | `GatedCashuWallet.melt` calls `super.melt` directly | 5 (money plane ×3, whole host ×2) |
| M5 | belt removed | 2 (gate unit, money plane) |
| M6 | waiting PAYs not refused when a melt marks the mint | 1 (gate unit) |
| M7 | the melt's wait never times out | 1 (gate unit) |
| M8 | no re-check of plane and session at the PAY's turn | 1 (money plane) |
| M9 | the viewer payer does not retry after `rate-limited:` | 2 (viewer payer) |
| M10 | the top-up counts a gate-refused melt as `unknown` | 1 (auto top-up) |
| M11 | `WorkerRpc`'s default deadline is 600 s instead of the constant | 1 (rpc) |
| M12 | the host transport passes no timeouts, while the constant moves to 20 s | 1 (mint transport) |
| M13 | 9 mint round trips in the model (worst time above the deadline) | 2 (deadlines) |
| M14 | the retry has no backoff (0 ms) | 2 (viewer payer) |
| M15 | the retry backoff never grows | 1 (viewer payer) |
| M16 | gate durations not validated | 1 (gate unit) |
| M17 | `pay` takes a plain `number` again | `tsc -b` (unused `@ts-expect-error`) |

## Residuals

- **R1: other operations at the same mint are not gated.** A redeem (`seller.redeem`, or the
  user's own creator share), a NUT-07 check (`seller.checkSpent` / `spentByUs`), a top-up's mint
  at the target mint, and the journal's settle loop all take core's turn too. Each is a few mint
  round trips of 30 s, and core's queue does not show them to the host, so the belt cannot see a
  PAY waiting behind them. A PAY queued behind several of them, on a slow mint, could still
  finish after the worker's deadline. Closing that fully needs core to check a deadline when it
  grants the turn, for example a `notAfter` on `Spender.send` checked inside `exclusive`. That is
  a locked-path change. The required fix did not need it, so no contract request was filed; it is
  a candidate for the next core lane.
- **R2: bunker latency is outside the model.** A NIP-46 bunker's latency while the wallet's
  events are signed (`Nip60ProofStore.commit`: `signEvent`, `nip44Encrypt`) is not in
  `PAY_BUILD_WORST_MS`. A key held in memory takes microseconds.
- **R3: a withdrawal can wait silently.** It waits for a PAY in flight at its mint, normally
  milliseconds, but up to 300 s if that PAY hangs. Nothing on screen says why, and after 300 s
  it fails with `rate-limited: a payment at this mint is still being built: nothing was melted,
  try again`.
- **R4: the belt starts at the host.** It measures from the moment the request reaches
  `payBuild`, not from the worker's send. Pipe latency and a host event loop blocked before the
  handler runs are not counted (milliseconds normally).
- **R5: batching dips after a melt.** The retry uses `UpstreamPayer.flush()`, which pays every
  pending run however short. `UpstreamPayer` is in `@sovit/gateway`, outside this lane.
- **R6: a second wallet would bypass the gate.** A second `CashuWallet` built in `money.ts` over
  the same connections would not go through the gate. Only review catches that; F6's tripwire
  covers new methods, not new instances.
- **R7: the host still cannot cancel a request.** A PAY that started inside the belt but whose
  sends ran past the model (R1, R2) can still finish after the deadline. The gate removes the
  300 s melt case, which is the only unbounded one the host could see.
- **R8: e2e not run.** The Electron e2e was not run, per the lane rules.

## Checks

- Touched package, `npx vitest run packages/app-desktop --maxWorkers=2` at `6fd9525`: 88 files
  passed, 1 skipped; 1556 tests passed, 1 skipped. The later commits' tests all passed in their
  own files and in the whole suite.
- Whole suite, `npx vitest run --maxWorkers=2` at `92cfc67` plus ADR 0012: 205 files passed,
  3 skipped, and 1 failed. The failure was one test, `auto-topup.test.ts` "no melt line to read…",
  which timed out at 5 s under load. It uses a plain `CashuWallet` (no gate). Rerun alone: the
  file passed 56/56 twice, and the single test passed. That makes 3120 tests passed and 21
  skipped.
- `npx tsc -b --force`: clean.
- `eslint` and `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK.
- `npm run lint:electron`: OK (227 files, 0 violations).

## Cross-lane review (round 4)

Findings of the money-plane cross-lane review (lanes #2 auto top-up × #8 residuals) and of the
I2 verifier, fixed on this branch with the top-up and residuals lanes merged into its base.
Commits: `bc0e36d` (TestMint: `holdNextMelt`, `settleMelts`, `failNextMelt`), `c2f7312` (the
fixes and their tests), `aecddbc` (a test race fixed, the review's scenario (c) added), then
this record, ADR 0012's round-4 addendum and the lane report. Contracts and locked paths are
untouched; no contract request.

**Reproduced first.** A scratch test with the real `CashuWallet` over a `MemoryProofStore` and two
TestMints joined by TestLightning (fund 20 000 at the source, `belowSats` 1 000, `amountSats`
2 000): the funding melt answered PENDING, then settled paid, then the settle loop
(`recoverPending`), then the next trigger. Pre-fix, for the target's invoice paid at the melt
and at the settle alike: Lightning paid twice, the target at 2 000, the source 20 000 → 16 000,
the ledger `[unknown 2 002, done 2 000]`, one paid quote never minted
(`pendingMintQuotes().length === 1`). These are the reviewer's numbers.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| R4-1 | HIGH | `auto-topup.ts:342`: a funding melt whose outcome is unclear — answered PENDING (Lightning in flight), a lost answer or the 300 s timeout before any change is restorable, a result commit that throws after the mint paid (a signer timeout, a lock, a disk error) — settled the entry `unknown` and dropped the target's quote. The journal later settled the melt as paid, the quote was never minted, and the next PAY ran a second top-up (repeating with backoff up to the daily cap); the settled line was not labelled "top-up" | **fixed** (`c2f7312`). The target's quote is kept BEFORE the melt: sealed to the identity by the money plane (`MoneyPlane.topUpVault().seal`: NIP-44 to self through the signer) and written on the ledger entry (`TopUpLedger.attach`: `owner`, `open`) in a write that must succeed before the melt runs. It stays whenever the melt may have run: every throw except a provable nothing-sent (R4-6), and every not-paid. It is finished by the run's own retry, by every later trigger, and by `AutoTopUp.resume()`, which the host calls when a money plane opens (the start, an unlock, a signer swap). It is minted exactly once when the target says PAID, through core's journaled `pollQuote`, so a lost mint answer is restored, never minted twice. It is released only once the melt is settled as not paid — no journal entry left at the source, and the source mint's own quote state UNPAID, read after the target read UNPAID — and the entry then stays counted. No new top-up runs into a target whose earlier one is open (`unresolved`, paced to one retry a minute). When the journal settles the melt as paid, its history line is found by an anchor the record keeps (the source's history before the melt), recorded, and shown as "top-up" (core's settled memos, "(change recovered)" and "(settled after the answer, no change)", are recognised); the entry says `done` with what left the source. A top-up minted while its melt is still unresolved at the source stays open, marked `minted`, only to find that line; it holds nothing back. Only its owner identity finishes it |
| R4-2 | MEDIUM (test-integrity lens; the same defect) | the melt ends unresolved, the paid NUT-20 quote lives only in `CashuWallet`'s in-memory map, and no test covers it (the old "melt throws / not paid" test stubs the melt without the mint paying) | **fixed** with R4-1; tests with the real wallet and mints below |
| R4-3 | LOW | a paid-but-unminted top-up was retried only with the `CashuWallet` instance that paid, so a lock/unlock of the same identity (or `close()` during the target's mint) stranded it within the session | **fixed** (`c2f7312`): open top-ups are keyed on the identity and persisted; a new wallet unseals them again with its own plane. `MoneyPlane.close()` no longer matters to them |
| R4-4 | LOW (test-integrity lens) | the retry ran only inside a due run, so a target that recovered another way (a deposit, a nutzap) never retried its paid quote | **fixed** (`c2f7312`): every trigger (`check`, `paymentAt`, a play) finishes open top-ups before its due check, paced to once per 30 s per wallet, never beside a run (a run finishes them first) — also with the top-up turned off since |
| R4-5 | MEDIUM (I2 verifier) | the belt's 194.4 s worst case left out the journal settle inside each PAY send (a NUT-09 restore and a NUT-07 check per entry at the mint, twice per PAY), and the gated melt is what leaves such an entry. With one entry the real worst was 284.4 s (no mint load) and a PAY could start up to 105.6 s late, finishing past the worker's 300 s | **fixed** (`c2f7312`), as the verifier suggested and with its test. `ipc/deadlines.ts` models the worst per PAY, `payBuildWorstMs(entries, loaded)` = (1 load round trip unless loaded + 2 × (2 + 2 × entries)) × 30 s + 6 × 7.4 s, and the belt `payBuildStartByMs` = min(105.6 s, 300 s − worst). The money plane owns the store: at the PAY's turn it reads the entries at the mint, and whether it has loaded that mint (a wrapper over its `CashuMintConnections`), and passes that bound to `PayMeltGate.pay`, which refuses when it is past it (a NaN or throwing bound refuses). One entry at a loaded mint leaves 15.6 s; one at a mint not loaded, or two, leave none — every PAY there is refused (`rate-limited:`, retried) until the settle loop clears them. `payBuildWorstMs(0, false)` is the pinned 194.4 s; no PAY gets more time than before. `deadlines.ts`, `deadlines.test.ts` and ADR 0012 say so |
| R4-6 | INFO | every `WalletError` but `insufficient-funds` settled `unknown`, also when no request reached the mint, keeping the whole reservation against the cap for 24 h | **fixed where provable** (`c2f7312`): `meltSentNothing` recognises, besides the gate and `insufficient-funds`, core's refusals thrown before its melt request — the melt quote could not be read, the mint changed the amount or raised the fee reserve, an earlier melt of the quote is unresolved — by code and message (a changed message reads as "may have run": fail closed). A coded refusal after the request, a failed `prepareMelt` and a failed journal begin share wording or error types with failures after the request, so they stay `unknown` (R4-R3) |
| R4-7 | INFO | opening a play at zero balance awaited the whole top-up, up to ~5 minutes with 300 s melts | **fixed** (`c2f7312`), bound stated: `PLAY_TOP_UP_WAIT_MS` = 15 s. A play first lets open top-ups finish (at most 15 s), then waits for the run at most 15 s once it is past the first-funding question (the user's own interaction, bounded by the prompt's 5 minutes). Past that it fails `no-balance` ("a top-up is on its way to this mint: try again in a moment") and the top-up finishes in the background; a fast top-up (seconds) still lets the play go ahead |
| R4-8 | INFO | right after a restart a top-up could read the target's balance before the startup settle restored an earlier top-up's minted proofs | **fixed** (`c2f7312`): a run, and a trigger's finishing of open top-ups, await the plane's `recovery` first. (The open top-up of R4-1 would also have caught this case.) |

**Where the quote is kept, and why sealed** (the orchestrator's question). What a quote id alone
lets someone do decides it:

- for a quote the mint locked to the wallet key (NUT-20), the id is a read handle — state, amount
  and invoice — and minting needs a signature by that key; the ledger already holds the same facts
  (target, source, amount, time);
- for an unlocked quote the id is bearer money once paid: whoever presents it first mints the
  amount. The desktop takes unlocked quotes whenever the wallet key is held by the signer
  (`signSecret`: cashu-ts needs the key as a string to sign NUT-20), and at any mint without
  NUT-20. The host cannot tell from the contract's `MintQuote` which one it has.

So every record is sealed to the identity, the way the NIP-60 proofs are, and another identity
can neither open nor mint it (F5's concern). It lives on the ledger entry, not in the sealed wallet
journal, for two reasons. The journal's body is core's exact format (`{v, ops, outbox}`, every
entry a `PendingOp`, refused otherwise), so a record there needs a core change outside this lane.
And the entry's state and the record must change together (`unknown` → `done`, the label). The
ledger's open entries are never pruned by the 24-hour window, at most `MAX_OPEN_TOP_UPS` = 16 are
kept, the record is read back strictly (`open-topup.ts`), and one that does not unseal, or names
another entry's mints or amount, is kept — never minted, never released.

**Tests** (new, all against the real `CashuWallet` and TestMints where money moves):

- `auto-topup.test.ts`, +23:
  - PENDING then settled paid, invoice paid at the melt or at the settle (2 cases): minted
    exactly once, Lightning paid once, the entry `done` at 2 000, the settled line "top-up",
    nothing unminted, nothing new moving while pending;
  - the melt throws after the mint executed: a lost answer while in flight; without a journal
    (no NUT-09); and the result commit failing after the mint paid (scenario (c));
  - PENDING where core cannot journal: kept while the source says PENDING;
  - a restart before and after the settle (2 cases);
  - a lock/unlock before the settle;
  - settled not paid: released, still counted, then a fresh top-up;
  - another identity neither polls nor releases, and is not blocked;
  - a record that does not unseal is kept;
  - paid-not-minted then a lock/unlock;
  - a not-due trigger finishes it;
  - provable nothing-sent (3 of core's refusals), and the classifier over real core errors;
  - a coded refusal after the request: counted, then released;
  - the startup settle first;
  - the play's bound past the question;
  - the ledger's open entries (kept past the window, bounded, dropped by `failed` or
    `open: null`) and a file with an out-of-shape one failing closed;
  - the record's strict round trip, and its refusals.
- `money.test.ts`, +3:
  - the verifier's scenario: a melt timed out at the mint leaves its entry, and a PAY queued
    behind another is refused before any swap past 15.6 s (well inside the old 105.6 s). Each of
    the first PAY's sends did restore and checkstate before its swap;
  - two entries: every PAY refused at once, nothing spent;
  - `topUpVault`: NIP-44 through a real `LocalSigner`, another identity cannot unseal, the
    largest record fits the ledger's bound, `meltPending` and `meltState` follow a PENDING melt
    to PAID, a closed plane refuses.
- `pay-melt-gate.test.ts`, +1: the per-PAY bound is read at the turn; shorter refuses, longer
  never extends, and NaN, negative or throwing refuses.
- `deadlines.test.ts`, +1: the per-PAY model pinned (194.4 s unchanged, 284.4 s for one entry at
  a loaded mint, 15.6 s belt, none for a cold mint or two entries, never looser than 105.6 s, a
  bad count refuses).
- `topup-host.test.ts`, +2, the whole host:
  - a PENDING melt with the target already paid: the quote is kept sealed (neither the file nor
    the decoded blob holds the invoice), and the next play mints it once and goes ahead;
  - a slow top-up fails the play `no-balance` in the bound, and the next play goes ahead once
    it finishes in the background.
- core `test-mint.test.ts`, +2: the new TestMint hooks behave like a mint.

No test was deleted or weakened. The harness changes are a vault per test wallet (`testVault`, a
reversible test double; the real sealing is `money.test.ts`'s) and the real-mint test's vault.

**Mutation checks (round 4)**: each mutation applied alone to the committed fix, the relevant
test files run, the file restored from a copy afterwards (the tree checked clean at the end).

| # | Mutation | Killed by |
|---|---|---|
| M18a | an ambiguous melt throw drops the quote (pre-fix behaviour) | 3 (a lost answer, no journal, a coded refusal after the request); rerun with scenario (c) added: 4 |
| M18b | a PENDING (not paid) melt drops the quote (pre-fix behaviour) | 8 |
| M18c | a new top-up runs into a target with an open one | 4 |
| M18d | a quote is released without the source mint saying UNPAID | 1 (PENDING without a journal) |
| M18e | the retry stays with the wallet instance that paid (the LOW) | 2 (lock/unlock ×2) |
| M18f | the ledger prunes open top-ups with the window | 1 |
| M18g | core's refusals before the request read as `unknown` | 2 |
| M18h | a run does not wait for the startup settle | 1 (the startup-settle test; the first pass also timed out the play-bound test — a race, fixed in `aecddbc`) |
| M18i | a play waits for the whole top-up | 1 (timed out) |
| M18j | only the exact melt memo is relabelled | 3 |
| M18k | another identity finishes an open top-up | 2 |
| M18l | minted while its melt is pending: closed at once, never labelled | 2 |
| M18m | the quote is kept unsealed (plain base64) | 1 (whole host) |
| M18n | a not-due trigger does not finish open top-ups | 1 |
| M18o | `payBuild` passes no per-PAY bound (pre-fix behaviour) | 2 (money plane) |
| M18p | journal entries cost the model nothing | 3 (deadlines, money plane) |
| M18q | the gate ignores the per-PAY bound | 1 (gate unit) |
| M18r | a NaN bound lets a PAY through | 1 (gate unit) |
| M18s | a loaded mint still counts its load | 2 (money plane, incl. the verifier's round-3 scenario) |
| M18t | a `failed` settle keeps the quote open | 1 |

The pre-fix behaviour of each finding is itself one of these mutations (M18a, M18b, M18e, M18n,
M18o, M18g, M18i, M18h), since the new tests need the new API (the vault) to run at all. The first
pass of M18h also exposed a race in the play-bound test (a `release()` that could come before
the melt installed it); fixed in `aecddbc`, the file passed three runs in a row.

**Residuals (round 4)**:

- **R4-R1: a record that does not unseal holds its target back.** A damaged or tampered ledger
  entry is kept (it may be money) and keeps `unresolved` for that target and identity, with no
  in-app way to clear it. The same stance as a wallet journal that does not open. A corrupt ledger
  file is still replaced by the closed marker, so its open top-ups survive only in the
  `.corrupt` copy.
- **R4-R2: a melt request arriving late.** A quote is released when the source mint reads UNPAID
  with nothing journaled. A melt request that the transport gave up on but that reaches the mint
  after that read could still pay an unkept quote. The resolution runs at the next trigger, at
  least seconds after the melt returned; noted, not closed.
- **R4-R3: not provable, still counted.** A coded refusal after the melt request (nothing
  executed), a failed `prepareMelt` and a journal begin that could not be written are
  indistinguishable in core's errors from failures after the request. They stay `unknown` (their
  quote is released once the source says UNPAID), so a flaky source can still use the day's cap
  without moving anything. A "not executed" flag on core's error would let the host settle them
  `failed`, but that is a locked-path change (`wallet/spend.ts`), not filed.
- **R4-R4: availability under a stuck melt.** One unresolved entry at a loaded mint leaves PAYs
  15.6 s to start. One at a mint not loaded, or two, refuses every PAY there until the settle loop
  clears them: fail-safe, but streaming at that mint pauses meanwhile.
- **R4-R5: host wiring of `resume()` on a signer swap** is covered at the `AutoTopUp` level
  (`resume` after a new wallet of the same identity) and by the injected-signer start. A
  lock/unlock through `DesktopSigner` is not driven end to end in a host test.
- **R4-R6: labels.** The settled line is looked for in the source's newest 100 history lines,
  for between the amount and the reservation. Input fees past the allowance, or a long busy
  history, leave it labelled "melt to Lightning (…)". Only a label.
- **R4-R7: core, seen here.** Against a mint without NUT-09, core's melt answered PENDING keeps
  the pending inputs spendable in the store (its reconcile drops only SPENT ones), so the source's
  balance over-reads until a later spend there reconciles them. This is core's locked path; the
  top-up's quote handling is correct regardless (tested).
- **R4-R8: invoice length.** A target invoice longer than 4 096 characters refuses the top-up
  before anything moves. The bound keeps a sealed record inside the ledger's 16 KiB per record.

**Checks (round 4)**, at `aecddbc` plus these docs:

- the touched packages, `npx vitest run packages/app-desktop packages/core --maxWorkers=2`:
  138 files passed, 2 skipped; 2227 tests passed, 17 skipped;
- the whole suite, `npx vitest run --maxWorkers=2`: 206 files passed, 3 skipped; 3152 tests passed,
  21 skipped (no timing failure; no timeout raised);
- `npx tsc -b --force`: clean;
- `eslint` and `prettier --check` on the 17 changed `.ts` files and the three docs: clean;
- `npm run check:locked`: OK;
- `npm run lint:electron`: OK (229 files, 0 violations);
- the Electron e2e was not run (lane rule).

## Round 5

Four items from the verifier of the round-4 fixes (money plane), handled as the orchestrator
decided. Commits: `f9b7e1f` (TestMint: `quoteExpiry`), `5f7a9ad` (the fixes and their tests),
`959fbbf` (one more explicit test timeout, R5-4), then this record, ADR 0012's round-5 addendum
and the lane report. Contracts and locked paths are untouched; no contract request.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| R5-1 | LOW | `auto-topup.ts:427`: the 15 s bound on a zero-balance play started only once the run was past the first-funding question. The run's wait for the startup settle (`v.recovery()`) and its own `resolveOpen` came before that point and were not bounded. The verifier measured 3 205 ms instead of ~30 ms with a 3 s settle; with the settle spending 30 s per request at a blackholed mint, a play waited all of that and then 15 s more | **fixed** (`5f7a9ad`). `checkForPlay` now has one bound, `PLAY_TOP_UP_WAIT_MS` in all, starting when the play asks. It covers open top-ups finishing, the settle, the run's own finishing, the quotes, the melt and the polls. The only time set aside is while the run's first-funding question is open (`QuestionClock`, on the monotonic clock: `open`/`close` around `ask`, and closed again when the flight ends). `within` pauses while the question is open and gives the rest of the budget after it. A bound that is not a number is spent at once. Verified before the fix: the two new tests, run against the round-4 `auto-topup.ts`, fail. The play is still waiting after the tests' 2 s cap, with a settle that never ends and with a slow poll in the run's own `resolveOpen` |
| R5-2 | INFO | `auto-topup.ts:673`: an open top-up whose source is gone for good (or forgets the quote) blocks auto top-ups into its target forever. `meltPending` stays true (core can never ask the source), or `meltState` throws, so every run reads `unresolved`. The record's `quote.expiry` was never used | **fixed** (`5f7a9ad`) as decided. When the target still says UNPAID `TOP_UP_EXPIRED_RELEASE_AFTER_MS` = 24 h after the later of the quote's expiry and the reservation, the kept quote is released unless the source says PAID. That includes a source whose melt is still journaled or PENDING, or that cannot be asked at all. An expired invoice can no longer be paid. The margin covers clocks that disagree, and a target mint that reads its stored UNPAID while its own Lightning backend cannot be asked (a mint may answer that way when its backend check fails). The release settles `unknown`, never `failed`: counted like any melt that may have run, for its 24-hour window. By the time this release happens that window has passed, since it comes at least 24 h after the reservation. It logs `auto top-up invoice expired unpaid: its quote is released`. A quote without an expiry (0) is kept, and so is one whose source says PAID (the target owes it). TestMint gained `quoteExpiry` so a test can use a near expiry. The remaining manual-clear gap is R5-R1 |
| R5-3 | INFO | R4-R2's justification ("at least seconds after the melt returned") was not guaranteed. `run()` never updated `lastResolve`, so the first trigger after a failed run could resolve within milliseconds of the melt throwing. For a melt that is not journaled, a request that reaches the source late could pay a quote already released | **fixed in code, by a different mechanism than the one suggested.** Updating `lastResolve` at the end of a run would pace every finishing of open top-ups, including minting a quote the target already says PAID. With it, the whole-host test "a funding melt answered PENDING while the target already has the payment … the next play mints it once and goes ahead" fails: the next play's finishing is paced, its check reads `backoff`, and the play fails `no-balance`. Only a release is unsafe early, so the release itself is guarded. An open top-up is released no sooner than `TOP_UP_RELEASE_AFTER_MS` = 600 s after its melt returned (`meltReturned`, kept in memory per entry and dropped when the top-up is closed). That is core's own `PENDING_SETTLE_AFTER_S`, the age at which core settles a journaled melt it cannot find. After a restart, when that time is not known, it counts from the latest the melt can have returned: the reservation plus `MELT_REQUEST_TIMEOUT_MS` (300 s), so 900 s after the reservation. Minting a PAID quote never waits. R4-R2 is reworded below |
| R5-4 | INFO | `auto-topup.test.ts`: tests that do several real top-ups time out under load at the default 5 s | **fixed**: an explicit 30 s timeout (the file's precedent for heavy tests), with a comment giving the measured times. It is on the two named tests ("rolling 24 h…", "smaller top-ups…") and on three tests of the same shape that also timed out in this round's runs (load average 18-24 on 8 cores): "the ledger survives a restart" (four real top-ups and a restart, 5 089 ms at HEAD), F3's "end to end: a melt that never answered…" (three real top-ups, a reserved fourth and a restart, 5 146 ms at HEAD), and "an explicit yes is remembered…" (four real top-ups, two P2PK sends and a restart; it timed out in the whole-suite run, took 5.8-6.5 s alone on the round-4 code, and was given 30 s in `959fbbf`). No code path is timed by them |

**One existing test changed, with a comment** (R5-3): F3's "end to end: a melt that never
answered, then a restart". Its restart used to release the quote of a melt that never answered
at once, then read `cap`. That immediate release is exactly the R4-R2 hazard. The test now first
asserts `unresolved` right after the restart (nothing moves, the balance is unchanged). It then
moves the clock past the reservation + melt timeout + `TOP_UP_RELEASE_AFTER_MS` and asserts the
same `cap` and balance as before. Nothing was deleted or weakened; the harness gained `second`
(the third TestMint) and `targetQuoteExpiry`.

**Tests** (new, 8):

- `auto-topup.test.ts`, +7:
  - R5-1: a startup settle that never ends until the test releases it, so the play fails
    `in-flight` within the bound and the top-up finishes `done` once the settle is over; a slow
    target poll inside the run's own `resolveOpen` (the trigger's finishing paced by a `resume()`
    just before), so the play fails in the bound and the run then reads `unresolved`;
  - R5-3: the next trigger right after the melt returned, and one 1 ms before 600 s, keep the
    quote; at 600 s it is released (settled `unknown`, still counted 2 002) and the next top-up
    runs. After a restart it is kept until reservation + 300 s + 600 s − 1 ms and released at
    that moment;
  - R5-2: the source goes offline for good and the user switches to a second source. Kept while
    the source cannot be asked, still kept 1 ms before the lapse. At the lapse it is released,
    `settle(…, { state: 'unknown', open: null })`, with the log line and no mint URL or invoice
    in the logs, and the next top-up from the new source runs (one Lightning payment, 2 000 at
    the target). Two more cases are kept a day past the lapse: a source that says PAID (then
    minted once when the target sees the payment), and a quote without an expiry.
- core `test-mint.test.ts`, +1: a mint quote carries the expiry the test set, 2100-01-01 by
  default, and stays payable.

**Mutation checks (round 5)**: each mutation applied alone to the fix, the round-5 tests and the
round-4 release and play tests run (`-t` filter), and the file restored from a copy afterwards.
The tree was checked clean at the end.

| # | Mutation | Killed by |
|---|---|---|
| M19a | the play's bound starts past the question (round 4's behaviour: the question held "open" from the run's start) | 2 (slow settle, slow own finishing) |
| M19b | no release guard (round 4's behaviour) | 3 (next trigger, restart, F3 end to end) |
| M19c | after a restart, the guard counts from the reservation (no melt timeout) | 1 (restart) |
| M19d | no release on a lapsed invoice (round 4's behaviour) | 1 (source gone) |
| M19e | a lapsed invoice is released even when the source says PAID | 1 |
| M19f | an expiry of 0 counts as lapsed | 1 |
| M19g | a lapsed invoice is released without the 24 h margin | 1 (1 ms before the lapse) |
| M19h | the lapse release settles `failed` (uncounted) | 1 |
| M19i | the question's time counts toward the play's bound | 1 (the round-4 play-bound test) |

The round-4 behaviour of each finding is one of these (M19a, M19b, M19d). The new tests were
also run against the round-4 `auto-topup.ts` itself (restored afterwards). Five fail: both R5-1
tests (the play is still waiting at the 2 s cap), the R5-3 in-session test at its first assertion
(released at the very next trigger), the R5-3 restart test, and the R5-2 release (`unresolved`
at the lapse). The restart test needs the new constant, so its failure there says little; M19b
and M19c cover it. The two "kept past the lapse" cases pass there, as they should: round 4 kept
everything.

**Residuals (round 5)**:

- **R5-R1: kept with no in-app clear.** Each of these holds back auto top-ups into its target for
  that identity: a target that forgets the quote (answers not found, so no UNPAID is ever read),
  a target that says UNPAID while the source says PAID (the target owes the sats), a quote without
  an expiry, and a record that does not unseal (R4-R1). They are fail-safe (nothing moves) and
  visible only in a throttled `unresolved` log line and in plays that fail `no-balance` at that
  target. Manual top-ups are unaffected. Clearing one needs a user action the app does not have
  yet.
- **R5-R2: the lapse margin trades delay for safety.** A source that is gone for good holds its
  target back for about 24 h past the invoice's expiry. A shorter margin would unblock sooner but
  would release a quote a target had been paid for if its Lightning backend link stayed down for
  longer than the margin.
- **R4-R2, reworded: a melt request arriving late.** A quote is released when the source mint
  reads UNPAID with nothing journaled, but never sooner than 600 s after the melt returned (900 s
  after the reservation, after a restart). Only a melt request that the transport gave up on and
  that reaches the mint later than that could still pay a quote no longer kept.
- **R5-R3: the play's bound is 15 s in all.** A play whose open top-ups take most of it leaves the
  run little time, so the play fails `no-balance` sooner than under round 4's two 15 s phases. The
  top-up still finishes in the background and the next play goes ahead.

**Checks (round 5)**, at `5f7a9ad` plus these docs:

- the touched packages, `npx vitest run packages/app-desktop packages/core --maxWorkers=2` (at
  `5f7a9ad`'s code): 136 files passed, 2 failed, 2 skipped; 2232 tests passed, 3 failed, 17
  skipped. All three failures were timeouts at load average ~24 on 8 cores, and each passed when
  rerun alone: `money.test.ts` "only for a registered session…" and "onPayment names the mint…",
  and `auto-topup.test.ts` "an explicit yes is remembered…";
- the whole suite, `npx vitest run --maxWorkers=2`, at `5f7a9ad`: 205 files passed, 1 failed, 3
  skipped; 3159 tests passed, 1 failed, 21 skipped. The failure was "an explicit yes is
  remembered…" again, a timeout (5 540 ms). Rerun alone it also timed out (5 110 ms). Timed back
  to back against the round-4 code it took 5.8-6.5 s there and 5.7-7.3 s on round 5's, so it is
  load, not the change. It got the same explicit 30 s as the caps tests, with those times in its
  comment (`959fbbf`), and then passed alone (6 078 ms). No other timeout was raised;
- `npx tsc -b --force`: clean;
- `eslint` and `prettier --check` on the 7 changed `.ts` files and these docs: clean;
- `npm run check:locked`: OK;
- `npm run lint:electron`: OK (229 files, 0 violations);
- the Electron e2e was not run (lane rule).
