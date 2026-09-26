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
