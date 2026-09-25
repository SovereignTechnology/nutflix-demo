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
  - `app-desktop/src/host/adapter.ts`: triggers (balance events, `checkBalance` on play).
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
- **A compromised worker** cannot trigger top-ups other than by spending through `pay.build`
  (host-authorised, budgeted) — which moves balances and so fires balance events. The caps bound
  the refill. The `spend` event still drives only the `--dev-mocks` wallet.
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

| # | Guard broken | Result |
|---|---|---|
| M1 | `autoTopUpDue` without the `defaultMints` check (a manifest's mint) | 7 fail (`auto-topup`, `topup-host` "unknown mint", `settings`) |
| M2 | daily cap doubled (`ledger.fits`) | 8 fail (rolling-24-h, restart, corrupt-ledger tests) |
| M3 | no per-top-up max (`topUpAmount` returns `amountSats`) | 5 fail |
| M4 | first-funding question skipped | 14 fail (unit and host) |
| M5 | no backoff after a declined question | 1 fails ("no re-prompt storm") |
| M6 | a corrupt ledger read as empty | 6 fail (all corrupt-ledger cases) |
| M7 | no single flight | 2 fail (two payments at once, unit and host) |
| M8 | melt quote amount not compared with the invoice | 1 fails |
| M9 | fee cap off | 5 fail |
| M10 | a melt that threw uncounted (`state: 'failed'`) | 1 fails |
| M11 | no prompt window = yes | 1 fails |
| M12 | no source balance check | 1 fails |
| M13 | melt-line lower amount bound dropped | survived at first; the concurrent-user-melt test gained a 500-sat case → 1 fails |
| M14 | ledger count clamp dropped | 1 fails |
| M15 | paid-but-unminted retry with any wallet | 1 fails |
| M16 | play tries every trusted mint (`=== 'done'`) | survived at first (the minute between attempts also stopped it); the host test now uses a clock that passes the minute at every read → 1 fails |
| M17 | `HostOptions.topUp` spread over the options | 1 fails (a smuggled "yes") |
| M18 | `amountSats` guard widened to 0 … 21 M BTC | 2 fail (guards, settings) |
| M19 | question guard allows target = source | 1 fails |
| M20 | settings gate ignores an amount change | 1 fails |
| M21 | ledger stores mints/amounts its guard refuses | 1 fails |
| M22 | `LIMITS.maxAutoTopUpAmountSats` = 10 001 | `tsc -b` fails (`topUpMax` pin in `protocol.ts`) |

Runner: `scratchpad/S3-topup/mutate.py` (exact-string patch, `npx vitest run <files>`, restore);
the tree was clean after every run.

## Tests

- `app-desktop/src/host/__tests__/auto-topup.test.ts` (new, 32): real `CashuWallet` over two
  TestMints joined by `TestLightning` — executes with both history sides; default amount; not due
  (off, balance, manifest mint, `fromMint`); declined / closed / failed prompt and its backoff; no
  prompt window; the yes remembered (and across a restart); settings changed during the question;
  two payments at once; the rolling cap (10 000 × 4 then refused, 9 000 × 5 then refused, the
  window rolls); fees counted; the ledger across a restart (file 0600); five corrupt forms; a corrupt
  ledger that cannot be replaced; `JsonFile` keeping a corrupt file; an unwritable ledger; source
  short; a target invoicing more; fees above 5 %; failure backoff doubling; melt throws / not paid /
  pre-flight `insufficient-funds`; paid-but-unminted retry bound to the paying wallet; a concurrent
  user melt (7 000 and 500) neither labelled nor counted; count clamp and unstorable entries; the
  history label.
- `app-desktop/src/host/__tests__/topup-host.test.ts` (new, 5 + L1's self-check): the whole host
  with the money plane on a FakeRelayPool, a real LocalSigner and TestMints; renderer calls over
  the host's IPC; "main" answering the `prompt` HostOut — unknown mint → `no-balance`, no question,
  no request; trusted mint → one question (target, amount, source), one top-up, play proceeds,
  history "top-up" both sides; declined → nothing moves, not re-asked; two trusted mints → one
  question; two plays at once → one top-up.
- `app-desktop/src/host/__tests__/topup-real-mint.integration.test.ts` (new, 1, opt-in): Nutshell
  FakeWallet mints 3399 → 3398; **run: 1 passed** (`NUTFLIX_REAL_MINT_URL=http://127.0.0.1:3399
  NUTFLIX_REAL_MINT_URL_2=http://127.0.0.1:3398`); skipped without them.
- Extended: `settings.test.ts` (+2: `amountSats` accepted 1/2 500/10 000, refused 8 bad values in
  a patch and in the stored file), `guards.test.ts` (+4: caps pinned to core, `amountSats`, the
  question, the answer), `prompt.test.ts` (+1, +3 refused answers), `prompt-page.test.ts` (+1),
  `money-gate.test.ts` (+1), `conformance.test.ts` (+1 case), ui `model.test.ts` (+1),
  `settings.test.ts` (+2), `wallet.test.ts` (+1, +1 assertion), `components.test.ts` (+1).
- Package runs (`npx vitest run <pkg> --maxWorkers=2`): app-desktop 69 files, 1346 passed /
  1 skipped; ui 18 files, 493 passed; core 41 files, 571 passed / 7 skipped.
- Whole suite (`npx vitest run --maxWorkers=2`): 172 files passed / 3 skipped, 2764 tests passed / 11 skipped, exit 0 (255.80s; skips are opt-in or environment-gated suites, e.g. the real-mint ones).
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
