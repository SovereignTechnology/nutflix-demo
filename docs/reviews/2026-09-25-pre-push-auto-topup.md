# Pre-push review — auto top-ups execute (2026-09-25)

Diff: `c08c99f` (contracts v6 amendment) → `stage-3/auto-topup`. Issue #2, security review F4.
Method: `differential-review` and `sharp-edges`, run inline by the session that wrote the change
(a self-review: the mutation checks below are its only independence).

## Scope

- HIGH (moves the user's sats without a per-payment question):
  - `app-desktop/src/host/topup/auto-topup.ts` (new): due check, single flight, caps, the
    first-funding question, the quote checks, the melt, minting at the target, backoff;
  - `app-desktop/src/host/topup/ledger.ts` (new): the persisted rolling-24-h ledger and the
    allowed mints, failing closed;
  - `app-desktop/src/host/host.ts`: wiring (`MainBridge` now exists whenever real money can move),
    the top-up's wallet;
  - `app-desktop/src/host/adapter.ts`: triggers (balance events, `checkBalance` on play; since
    the independent review, `checkBalance` and the money plane's PAY only — `money.ts`).
- MEDIUM:
  - `app-desktop/src/ipc/guards.ts` + `protocol.ts`: `Settings.autoTopUp.amountSats`, the
    `top-up-first` question and answer, `LIMITS` pinned to core's caps at the type level;
  - `app-desktop/src/main/{prompt,main,money-gate}.ts`: main accepts the new answer; the settings
    gate asks when the amount changes;
  - `app-desktop/src/renderer/prompt/prompt.ts`: the trusted page's words;
  - `app-desktop/src/host/settings/json-file.ts`: `moveAsideCorrupt` option;
  - `app-desktop/src/host/{dispatch,topics}.ts`: the history relabel.
- LOW: `ui` (amount field, copy, the Wallet card keeps the amount, `historyLabel`),
  `core/src/mocks/test-mint.ts` (`TestLightning`, tests only), tests, docs.

Blast radius: `JsonFile` has two other users (settings, desktop config) — the new option defaults
to the old behaviour. `wallet.history` and `wallet.change` now pass through `relabel`, which only
ever changes the memo of an `out` "melt to Lightning" entry the ledger recorded (or the one new
line of a melt in flight). `MainBridge` is now built with an injected signer too; a
`prompt-answer` then reaches it instead of being wiped unread, and an unknown `req` is wiped there
(same outcome).

## Adversarial questions

- **A compromised renderer** (it handles relay and peer content).
  - *Can it make the host fund a mint of its choosing?* Only a mint in `defaultMints`
    (`autoTopUpDue`), and adding one is asked by main's native settings gate (F4/F8); so is
    switching auto top-up on, changing `belowSats`, `fromMint` or — new — `amountSats`
    (`money-gate.ts:192`). A manifest's mints are never topped up (tested in `auto-topup.test.ts`
    and `topup-host.test.ts`: a creator-run mint gets no request at all).
  - *Can it answer the first-funding question?* No: the answer is accepted only from the prompt
    window's own webContents, top frame, at `app://prompt` (`PromptService.accept`; tested with the
    app's frame URL). The question is data only (`isTopUpFirstForm`, `guards.ts:605`: two distinct
    `https:` mints, an amount ≤ 10 000, no other key); the page holds the words and shows hosts via
    `URL` (IDNA, no look-alike Unicode — tested with a Cyrillic host).
  - *Can it drain via plays?* Each play's session budget is unchanged; top-ups refill at most
    50 000 sats in 24 h (fees included), one at a time, a minute apart.
  - *Can it cause a question storm?* A declined question backs that mint off for an hour; one play
    asks about at most one mint (F2 below); attempts are a minute apart whatever the outcome. The
    backoff lives in memory, so a host restart re-arms it: at most one question per mint per restart
    or per hour.
- **A compromised worker** cannot trigger top-ups other than through `pay.build`
  (host-authorised, budgeted). Since the independent review (R1) that is the trigger itself: each
  authorised PAY, paid or short, calls `onPayment`. A short PAY costs no budget, so a worker can
  repeat it — but only for a mint of the open session's manifest, only a mint on the user's list
  is ever topped up, and the single flight, the minute between attempts, the backoffs and the
  caps bound what follows (at most one top-up a minute, 50 000 a day, one question per mint per
  hour). The `spend` event still drives only the `--dev-mocks` wallet.
- **A malicious target mint** (on the user's list, first funding confirmed): it invoices the
  top-up. `CashuWallet.mintQuote` refuses a quote for another amount, and the source mint's melt
  quote must name exactly the amount (`auto-topup.ts:277`): a larger invoice is refused (tested).
  It can keep the sats and never issue — the ledger counts them, the loss is bounded by the caps.
- **A malicious or greedy source mint**: fees (Lightning reserve + an input-fee allowance of 64
  inputs at the keyset's `input_fee_ppk`) above 5 % (10-sat floor) are refused
  (`auto-topup.ts:282`, tested for both parts). A melt that is not paid, or throws after the mint
  was asked, stays counted.
- **Local state.** The ledger (`auto-topup.json`, 0600, atomic) fails closed on every bad form:
  not JSON, a bare array, an unknown version, an unknown key, a negative count (tested), too large;
  copied aside and replaced by a marker that counts the whole daily cap; if the marker cannot be
  written, everything is refused for the run (tested with a read-only directory). A deleted file
  reads as a first run — the same local user could equally edit settings; noted as residual.
- **Logs.** Outcome codes and numbers only; tests assert no mint host, invoice or quote in the
  lines (`auto-topup.test.ts`, `topup-host.test.ts`, the real-mint test).
- **Dev flags.** With `--dev-mocks` nothing is constructed (no ledger, no prompt window); a due
  top-up is logged as before. No dev flag reaches the confirm or the caps.

## Found by this review and fixed (`8289eed`; tests sharpened by the mutation checks in the next commit)

| # | Severity | Finding (file:line at `11cc61b`) | Scenario | Fix |
|---|---|---|---|---|
| F1 | Medium | The funding melt's history line was found as "the first new `out` melt line at the source" (`auto-topup.ts` `findMelt`), and its amount was used as what moved | The user withdraws 120 000 sats from `fromMint` in the Wallet screen while a 2 000-sat top-up's melt runs: that line is taken as the top-up's — labelled "top-up" for good, and 120 000 is written as the entry's count, above the ledger guard's own ceiling, so the next start reads the ledger as corrupt and pauses top-ups for a day (and forgets the allowances) | A line matches only if new, at the source, for between the amount and the whole reservation, and the only such line (`isNewMelt`, `auto-topup.ts:428`; `found.length === 1`, `:396`); the ledger clamps counts at twice the daily cap and refuses to store a mint or an amount its guard would refuse (`ledger.ts:283`, `:249`). Tested with concurrent 7 000- and 500-sat user melts and a 10¹² count |
| F2 | Low | `checkBalance` tried every mint of the video until one was topped up (`adapter.ts` loop, `=== 'done'`) | A video paid at three trusted mints the user has never funded: declining the first question opens a second, then a third, for the same play | The first mint that is due decides (`adapter.ts:615`, `!== 'not-due'`); tested at the host with a clock that passes the minute between attempts at every read: one question |
| F3 | Low | The page said later top-ups run "at most {amount} each" | The user allows 1 000; later raises the amount to 10 000 (main's settings gate asks, and they agree): top-ups into the allowed mint are 10 000 without a second first-funding question, and the page's words were wrong | "each at most the amount set in Settings (never more than 10,000 sats)" (`prompt.ts`), pinned by the page test |
| F4 | Low (sharp edge) | `createHost` spread its test hook `HostOptions.topUp` over the top-up's options | A programmatic caller passing `topUp: { askFirstFunding: () => true }` (the TypeScript type forbids it; JavaScript does not) would have replaced main's question | The clock, sleep and polling are picked one by one (`host.ts:385`); tested by smuggling a "yes" and a `settings` through the hook |
| F5 | Low | A paid-but-unminted top-up was retried with whatever wallet was current | The user signs out and in as another identity before the retry: an unlocked (non-NUT-20) quote would have been minted into the other identity's wallet | Retries are bound to the wallet that paid; the host hands the top-up the money plane's own wallet, never the switching facade (`host.ts:374`, `auto-topup.ts:357`); tested |

Found earlier while writing, before the first commit: a local-mint URL (`http:` in the opt-in
real-mint test) failed the ledger's `https:`-only guard and would have corrupted the ledger on its
next load — the ledger now stores `http(s)` printable ASCII, compared only by exact string with
the guarded Settings mints (`ledger.ts:87`); and the input fees of the melt were not counted
(found by the real-mint test: 1 002 left the source for a 1 000 top-up) — the reservation now holds
an input-fee allowance and the settled count is the melt's own history line.

## Sharp edges (API and configuration)

- `Settings.autoTopUp.amountSats`: 0, negative, fractional, non-number, above 10 000 and
  present-as-`undefined` are refused (patch and stored file; the stored file then reads as the
  defaults: off). Absent = 10 000 is the contract's default; main's gate states it in the question.
- `belowSats <= 0` = off (a patch cannot delete the key); negatives are refused by the guard.
- `AutoTopUpOptions.askFirstFunding` absent → no mint is ever funded for the first time (tested).
  `wallet()` → `undefined` → nothing is due. A `balance` hint that is stale-high only skips.
  `pollAttempts: 0` moves nothing extra: the paid top-up is counted and retried.
- `TopUpLedger.settle(id, { state: 'failed' })` uncounts: only the pre-flight `insufficient-funds`
  path (core refuses before asking the mint) uses it after a reservation. Internal API; documented.
- `JsonFile`'s `moveAsideCorrupt` defaults to `true` (settings' behaviour: defaults on corruption).
  A future security-relevant state file must pass `false` or it would read "missing" on the next
  load; the option's doc says so. Left as is (changing the default changes settings).

## Mutation checks

Each guard broken on its own, the named test files run, then restored (`git diff` empty after):

| # | Guard broken | Reported by the lane | Re-run at the new HEAD |
|---|---|---|---|
| M1 | `autoTopUpDue` without the `defaultMints` check (a manifest's mint) | 7 | 5 (`auto-topup`, `topup-host` "unknown mint", `settings`; the independent re-run at `0cd3d30` found 3 — the lane's 7 did not hold; two of the new tests also exercise it) |
| M2 | daily cap doubled (`ledger.fits`) | 8 | 11 (rolling-24-h, restart, corrupt-ledger, pending-after-restart) |
| M3 | no per-top-up max (`topUpAmount` returns `amountSats`) | 5 | 1 — only the arithmetic test; a behavioural test added (an amount of 50 000 in the settings moves 10 000) → 2 |
| M4 | first-funding question skipped | 14 | 18 (unit and host) |
| M5 | no backoff after a declined question | 1 | 1 ("no re-prompt storm") |
| M6 | a corrupt ledger read as empty | 6 | 7 (the corrupt-ledger cases and the 257-id file) |
| M7 | no single flight | 2 | 2 (two payments at once, unit and host) |
| M8 | melt quote amount not compared with the invoice | 1 | 1 |
| M9 | fee cap off | 5 | 2 (the lane's 5 did not hold) |
| M10 | a melt that threw uncounted (`state: 'failed'`) | 1 | 1 |
| M11 | no prompt window = yes | 1 | 1 |
| M12 | no source balance check | 1 | 1 |
| M13 | melt-line lower amount bound dropped | 1 (after a 500-sat case was added) | 1 |
| M14 | ledger count clamp dropped | 1 | 1 |
| M15 | paid-but-unminted retry with any wallet | 1 | 1 |
| M16 | play tries every trusted mint (`=== 'done'`) | 1 (after the clock change) | 1 |
| M17 | `HostOptions.topUp` spread over the options | 1 | 1 (a smuggled "yes") |
| M18 | `amountSats` guard widened to 0 … 21 M BTC | 2 | 2 (guards, settings) |
| M19 | question guard allows target = source | 1 | 1 |
| M20 | settings gate ignores an amount change | 1 | 1 |
| M21 | ledger stores mints/amounts its guard refuses | 1 | 1 |
| M22 | `LIMITS.maxAutoTopUpAmountSats` = 10 001 | `tsc -b` fails | `tsc -b` fails (`topUpMax` pin in `protocol.ts`) |

Runner: `scratchpad/S3-topup/mutate.py` (exact-string patch, `npx vitest run <files>`, restore);
the tree was clean after every run. Re-run after the independent review with the same patches
(`mutate2.py`: M5 now names the decline path, since an `allow()` failure sets the same backoff;
the failure count is read from vitest's summary line only).

## Tests

- `app-desktop/src/host/__tests__/auto-topup.test.ts` (new, 31 at `0cd3d30` — the lane first said 32; 55 after the independent review): real `CashuWallet` over two
  TestMints joined by `TestLightning` — executes with both history sides; default amount; not due
  (off, balance, manifest mint, `fromMint`); declined / closed / failed prompt and its backoff; no
  prompt window; the yes remembered (and across a restart); settings changed during the question;
  two payments at once; the rolling cap (10 000 × 4 then refused, 9 000 × 5 then refused, the
  window rolls); fees counted; the ledger across a restart (file 0600); five corrupt forms; a corrupt
  ledger that cannot be replaced; `JsonFile` keeping a corrupt file; an unwritable ledger; source
  short; a target invoicing more; fees above 5 %; failure backoff doubling; melt throws / not paid /
  pre-flight `insufficient-funds`; paid-but-unminted retry bound to the paying wallet; a concurrent
  user melt (7 000 and 500) neither labelled nor counted; count clamp and unstorable entries; the
  history label. Added after the independent review (24): an amount above the max moves 10 000;
  the label a day later and after a restart; the 256-id bound (and a 257-id file fails closed; a
  file without the list reads fine); a pending reservation after a reopen, and end to end after a
  melt that never answered; signed out / switched during the question, during the pre-reservation
  read, and at the last look (3); settings changed while the quotes were fetched (4); no melt line
  → the whole reservation; 120 one-sat proofs → exactly what left the source; an unrecordable yes
  backs off like a decline; a melt quote for another mint; bad ppk values (5); `paymentAt`.
- `app-desktop/src/host/__tests__/topup-host.test.ts` (new, 6 at `0cd3d30`; 8 after the independent review): the whole host
  with the money plane on a FakeRelayPool, a real LocalSigner and TestMints; renderer calls over
  the host's IPC; "main" answering the `prompt` HostOut — unknown mint → `no-balance`, no question,
  no request; trusted mint → one question (target, amount, source), one top-up, play proceeds,
  history "top-up" both sides; declined → nothing moves, not re-asked; two trusted mints → one
  question; two plays at once → one top-up; and (independent review) the user's own withdrawal
  that empties an allowed mint moves nothing, while a PAY for the open session (the fake worker's
  `pay.build` into the host's money plane) that leaves the mint below its threshold tops it up.
- `app-desktop/src/host/__tests__/topup-real-mint.integration.test.ts` (new, 1, opt-in): Nutshell
  FakeWallet mints 3399 → 3398; **run: 1 passed** (`NUTFLIX_REAL_MINT_URL=http://127.0.0.1:3399
  NUTFLIX_REAL_MINT_URL_2=http://127.0.0.1:3398`); skipped without them.
- `money.test.ts` (+2, independent review): `onPayment` names the mint of a paid and a short
  PAY, never of a refused one, and a throwing or rejecting hook never breaks the PAY (no
  unhandled rejection); `liveWallet` is `undefined` after `close`.
- Extended: `settings.test.ts` (+2: `amountSats` accepted 1/2 500/10 000, refused 8 bad values in
  a patch and in the stored file), `guards.test.ts` (+4: caps pinned to core, `amountSats`, the
  question, the answer), `prompt.test.ts` (+1, +3 refused answers), `prompt-page.test.ts` (+1),
  `money-gate.test.ts` (+1), `conformance.test.ts` (+1 case), ui `model.test.ts` (+1),
  `settings.test.ts` (+2), `wallet.test.ts` (+1, +1 assertion), `components.test.ts` (+1).
- Package runs at `0cd3d30` (`npx vitest run <pkg> --maxWorkers=2`): app-desktop 69 files, 1346
  passed / 1 skipped; ui 18 files, 493 passed; core 41 files, 571 passed / 7 skipped.
- Whole suite at `0cd3d30` (`npx vitest run --maxWorkers=2`): 172 files passed / 3 skipped, 2764 tests passed / 11 skipped, exit 0 (255.80s; skips are opt-in or environment-gated suites, e.g. the real-mint ones).
- After the independent review: the affected files (`auto-topup`, `topup-host`, `money`,
  `adapter-play`, `settings`, `guards`, ui `screens/Settings`) pass; the opt-in real-mint test
  passes again against the two Nutshell mints; whole suite 172 files passed / 3 skipped,
  **2792 passed / 11 skipped** (+28: 24 `auto-topup`, 2 `topup-host`, 2 `money`), exit 0
  (325.47 s). `npx tsc -b --force`, `eslint` and `prettier --check` on every changed file,
  `npm run check:locked`, `npm run lint:electron`: clean.
- `npx tsc -b --force`, `eslint` and `prettier --check` on every changed file, `npm run
  check:locked`, `npm run lint:electron`: clean (no dependency change, so no `check:native`).

## Residuals

- **Other devices see "melt to Lightning".** The NIP-60 event of the funding melt carries core's
  memo; the host relabels it locally (contract request 1: a memo on `Wallet.melt`).
- **Fees are counted in the daily cap** (a decision, contract request 2): with a charging source
  mint, four 10 000-sat top-ups fit in a day, not five. The screens say "fees included".
- **Deleting `auto-topup.json` resets the caps and the allowances** (a first run). Same-user
  local access only; a clock set forward by a day and back likewise ages entries out early. A clock
  set back keeps counting future-dated entries (fail closed).
- **A paid-but-unminted top-up is retried in memory only.** After a restart the quote id is gone
  (it is bearer where the mint has no NUT-20, so it is not written to disk); the sats stay counted
  and the NIP-60 journal does not cover an unminted quote.
- **The first-funding question uses main's trusted prompt window** (ADR 0013), not the OS dialog
  of the renderer money gate: the host initiates it, and the window has the queue, the deadline and
  the cancel the host needs. It is a separate `app://prompt` window, never the app renderer.
- **The Electron e2e was not run in this lane** (the orchestrator runs it serially).

## Independent review (2026-09-25, after `0cd3d30`)

An independent reviewer re-ran the lane's tests, the opt-in real-mint test, the package suites,
`tsc -b` and three of the mutation checks, added three mutations of its own, and returned
**ship** with five low and six info findings. The orchestrator decided how each is handled; each
was first checked against the code. Fixed on `stage-3/auto-topup` in the commit after `0cd3d30`.

| # | Sev. | Finding | Outcome |
|---|---|---|---|
| R1 | Low | Any balance drop at an allowed trusted mint started an unattended top-up (`adapter.ts:183` → `checkAutoTopUp` → `AutoTopUp.check`) — including the user's own withdrawal from that mint, a send, a nutzap or a seeder melt | **Fixed** (verified: the constructor's `onChange` listener called `check` for every `balance` event with the real wallet). A top-up now starts only from the payment path, as the contract says (`belowSats` is compared at "the mint a payment is about to draw from"): a play opening (`checkBalance`, unchanged) and a PAY the money plane builds for an open play session — new `MoneyPlaneOptions.onPayment(mint)`, called in `payBuild`'s `finally` after the PAY's authorisation passed (paid or short; never for a refused PAY; a throw is swallowed), wired in `host.ts` to `AutoTopUp.paymentAt`, which reads the balance first so a not-due PAY never holds the single flight. A balance event only logs, and only with `--dev-mocks` (`adapter.ts` `logAutoTopUpDue`). Tests: `topup-host.test.ts` "the user withdrawing an allowed trusted mint to zero: nothing moves" and "a PAY for the open session leaves the mint below its threshold: topped up, unattended" (the fake worker's real `pay.build` through the host); `money.test.ts` (the hook's mint for a paid and a short PAY, none for two refused ones, a throwing hook never breaks the PAY); `auto-topup.test.ts` `paymentAt` |
| R2 | Low | The funding melt's "top-up" label was lost after 24 h: `persist()` pruned the entry holding the melt id (`ledger.ts:309`) | **Fixed** (verified). The ids are a list of their own in the ledger file (`melts`), the newest `MAX_TOP_UP_MELTS` = 256, never pruned by the window; the file guard bounds it (`arrayOf(isHistoryId, 256)`: more fails closed like any corrupt ledger); optional on read, always written. Tests: the label survives the prune a day later and a restart; 300 settles keep the newest 256; a 257-id file fails closed; a file without the key reads fine |
| R3 | Low | No test pinned that a pending reservation counts after a restart (the reviewer's mutation MX survived 37/37) | **Fixed** (the code was right: `counts()` includes `pending`; only the guard was missing). Tests: reserve, reopen the ledger — `used()` includes the reservation and `fits()` refuses one sat more than what is left; and end to end, a melt that never answers, then a restart: the next top-up that no longer fits is `cap`. MX now fails 2 |
| R4 | Low | After the first-funding question (open up to 5 min) the wallet was not re-checked: a sign-out or signer switch meanwhile still ran the top-up with the old plane's wallet | **Fixed** (verified: only the settings were re-read). `stillWanted` requires `this.o.wallet() === w` (before and after its own balance read) and the same settings, after the question, right before the reservation and right before the melt (a failed last look settles the reservation `failed`: nothing moved). The host hands the top-up `MoneyPlane.liveWallet`, `undefined` once the plane is closed. Tests: signed out / switched during the question; switched during the pre-reservation balance read; signed out / switched / turned off at the last look; `liveWallet` after `close` |
| R5 | Low | Input fees beyond the 64-input allowance were neither capped by the 5 % check nor fully counted | **Partly fixed, partly deferred.** Accounting fixed (verified: with more inputs than allowed, the melt line exceeds the reservation, `isNewMelt` rejects it, and the fallback counted `reserved − change`, less than what left): when no melt line matches, the ledger counts the larger of the whole reservation and the source's balance drop (read right before and after the melt; a concurrent spend there over-counts, never under). Tests: no line → the whole reservation (not less the change); 120 one-sat proofs at 100 ppk → 114 inputs, 12 sats of input fees against 7 allowed: the ledger counts exactly what left the source. **Deferred** (low): refusing such a melt up front — the `Wallet` contract does not expose how many inputs core's `melt` will select (the selection happens inside `wallet/spend.ts`, a locked path); contract request S3-topup 3 proposes `melt(quote, { maxInputFee })`. The docs now say the 5 % check covers the Lightning reserve and the allowance, not input fees past it |
| R6 | Info | Outside the first-funding path, settings were not re-read between the due check and the melt | **Fixed** with R4's `stillWanted` (turned off, another source, another amount, the target taken off the list: nothing reserved, nothing moves; tested for each) |
| R7 | Info | Allowed mints and the daily cap are per install, not per identity | **Not a defect; documented** (orchestrator's decision): the same model as the settings the top-up reads. ADR 0012's addendum now says so |
| R8 | Info | `AUTO_TOP_UP_MAX_SATS` meant 10 000 000 (threshold) in the UI model and 10 000 (amount) in core; `LIMITS.maxAutoTopUpSats` likewise | **Fixed**: the UI's threshold constants are `AUTO_TOP_UP_THRESHOLD_MAX_SATS` / `AUTO_TOP_UP_THRESHOLD_DEFAULT_SATS`, the limit is `LIMITS.maxAutoTopUpThresholdSats`; `AUTO_TOP_UP_MAX_SATS` now means only core's per-top-up amount |
| R9 | Info | A ledger that cannot record the yes re-asked after every failure backoff (1, 2, 4 … 60 min) | **Fixed** (verified): an `allow()` failure also backs that mint off for the hour, like a decline. Test: no second question before the hour |
| R10 | Info | Counts in the lane report did not match the re-runs (32 vs 31 tests; M1 "7" vs 3) | **Fixed**: `auto-topup.test.ts` had 31 tests at `0cd3d30`; the lane's mutation table was re-run at the new HEAD (the "Mutation checks" table above) and both documents carry those numbers |
| R11 | Info | Two defensive checks had no test (`melt.mint !== from`, the ppk validation) | **Fixed**: a melt quote for another mint → `refused`, nothing moves; ppk NaN, −10, −1 000, 1.5, ∞ → `refused`, nothing moves |

### Found while fixing

- **M3 (no per-top-up max) was caught by one arithmetic test only.** Re-running the lane's own
  mutation table showed one failure, not the five it claimed: nothing behavioural ran an amount
  above 10 000 (the guards refuse it, and the ledger's `isEntryAmount` would refuse the
  reservation). Added: settings holding `amountSats` 50 000 (as if a guard were bypassed) move
  exactly 10 000.
- **An async `onPayment` hook would escape the swallow.** `paidAt`'s `try` catches a throw, not
  a returned rejected promise (TypeScript lets an async function stand in for a `void` one). The
  host's hook never rejects (`void paymentAt(…)`, which never rejects), but `paidAt` now also
  swallows a returned promise's rejection, so the next caller cannot turn it into an unhandled
  rejection in the host process.

### Mutation checks for these fixes

Each broken on its own, the named test files run, then restored (exact-string patch; runner
`scratchpad/S3-topup/mut.py`):

| # | Guard broken | Result |
|---|---|---|
| R1 | a real-wallet balance event starts a top-up again (`adapter.ts`) | 1 fails (`topup-host` withdrawal) |
| R1b | the money plane never calls `onPayment` | 2 fail (`money.test`, `topup-host` PAY) |
| R1c | the host does not wire `onPayment` to `paymentAt` | 1 fails (`topup-host` PAY) |
| R2 | `isTopUpMelt` reads only the windowed entries | 2 fail |
| R2b | the melt-id list unbounded | 1 fails |
| R3 (= MX) | `pending` not counted | 2 fail |
| R4a | no re-check after the question | 2 fail |
| R4b | both wallet-identity checks removed | 3 fail |
| R4b2 | only the post-read identity check removed | survived at first (the check before the read and the last look covered the tests); a test switching the wallet during that read → 1 fails |
| R4c | no last look before the melt | 3 fail |
| R4d | `liveWallet` returns the wallet after `close` | 1 fails |
| R6 | no re-check before the reservation | 4 fail |
| R5 | the old fallback (`reserved − change`) | 2 fail |
| R5b | the balance drop ignored (`reserved` only) | 1 fails (the 120-proof case) |
| R9 | an `allow()` failure not backed off | 1 fails |
| R11a | `melt.mint !== from` removed | 1 fails |
| R11b | ppk validation removed | 4 fail (NaN, −10, −1 000, 1.5) |
| R12 | `paidAt` back to a plain `try` (an async hook's rejection escapes) | 1 fails (`money.test`: the unhandled rejection is caught by the test) |
| M3 | no per-top-up max, re-run with the new behavioural test | 2 fail (the arithmetic test and "an amount above the max moves only 10 000") |

The lane's own mutation table (M1–M22) was re-run at the new HEAD; the numbers are in the table
under "Mutation checks" above, next to the ones the lane first reported.

### Timeouts

Two new tests carry an explicit 30 s timeout, each with the reason in a comment: the 256-id
bound (300 atomic ledger writes, each with a file and a directory fsync: about 1 s alone, and it
passed the default 5 s once while the mutation runner loaded the box) and the 120-proof input-fee
case (120 mint quotes and a 114-input melt, about 3 s alone). No existing timeout was changed.

### Residuals after the independent review

- Input fees past the 64-input allowance still cannot be refused before the melt (contract
  request S3-topup 3); they are counted in the daily cap afterwards.
- `MoneyPlane.wallet` keeps returning the wallet after `close` (many existing callers); the
  top-up uses `liveWallet`, and the getter's doc says an unattended caller must too.
- Allowed mints and the daily cap are per install (R7), as documented in ADR 0012.
- The trigger is a PAY for an open session or a play opening. The PAY that takes a mint below
  its threshold triggers the top-up right after it (as its balance event did before); a balance
  that fell below the threshold some other way (the user's own withdrawal) is topped up only at
  the next play or PAY that draws from that mint — by design (R1).
