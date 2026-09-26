# Lane S3-topup — auto top-ups execute (issue #2, security review F4)

**Issued against `CONTRACTS_VERSION = 6`** (the c08c99f amendment: `Settings.autoTopUp.amountSats?`,
`AUTO_TOP_UP_MAX_SATS` = 10 000, `AUTO_TOP_UP_MAX_SATS_PER_DAY` = 50 000). Branch
`stage-3/auto-topup` off `c08c99f`. Cameron's rules (2026-09-24): off by default; when on, at
most 10 000 sats a top-up and 50 000 a day, only into mints on the user's own list, a native
confirm the first time a mint is funded, every top-up in wallet history.

No contract change; `docs/contract-requests/S3-topup.md` asks for a memo on `Wallet.melt`, for
one sentence on fees in the daily cap, and (after the independent review) for a way to cap a
melt's input fees up front — all worked around. No dependency, lockfile or
`package.json` change. Nothing outside the allowlist.

## What changed and why

### The top-up (host)

`packages/app-desktop/src/host/topup/auto-topup.ts` — `AutoTopUp.check(mint, balance?)`, called
only from the payment path: by `play` (`checkBalance`: when nothing at the video's mints can pay,
awaited; otherwise fired for each of its mints) and — since the independent review (R1) — by the
money plane after each authorised PAY for an open play session (`MoneyPlaneOptions.onPayment` →
`AutoTopUp.paymentAt`, paid or short). A wallet balance event never starts one: it is also the
user's own withdrawal, send or nutzap, or a seeder melt. With the user's REAL wallet only; with
`--dev-mocks` a due top-up is still just logged on a balance change (SE-4 unchanged there: fake
sats, no prompt window).

1. **Due**: `autoTopUpDue` (unchanged): on, the target in `defaultMints`, never `fromMint`, balance
   below `belowSats` (re-read before anything moves). A mint first seen in a manifest is never
   topped up: `play` then fails `no-balance` with no request to that mint.
2. **One at a time**: a second trigger for the same mint joins the flight; another mint is `busy`.
   Attempts are ≥ 60 s apart; failures back off 1 min doubling to 1 h; a declined question backs
   that mint off for 1 h. A play asks about one mint at most.
3. **Amount**: `amountSats ?? 10 000`, never above 10 000.
4. **Daily cap**: what left the source in the last 24 h (amount + every fee) plus everything in
   flight plus this top-up's reservation (amount + Lightning fee reserve + an input-fee allowance
   of 64 inputs at `input_fee_ppk`) ≤ 50 000. Refused otherwise.
5. **First funding**: main's trusted prompt window asks (new `PromptForm` `top-up-first`: target,
   source, amount — data only; the page shows hosts, the caps, "Not now" is the default). Only an
   explicit yes is remembered, per mint, persisted. No, a closed window or the 5-min deadline moves
   nothing. The prompt window (`MainBridge`) now exists whenever real money can move — also with an
   injected signer — and never with `--dev-mocks`.
6. **Quotes**: `mintQuote(target, amount)` → `meltQuote(fromMint, bolt11)`; the melt quote must be
   for exactly the amount; fees > 5 % (10-sat floor) refused; the source must hold the whole
   reservation.
7. **Still wanted** (R4, R6): after the question, right before the reservation and right before
   the melt, the same wallet (the host hands over `MoneyPlane.liveWallet`, `undefined` once the
   plane is closed: signed out, locked, another signer) and the same settings (on and due, the
   same source and amount, the target still listed); otherwise nothing moves (`not-due`).
8. **Money**: the reservation is persisted, then `melt`; a melt that throws (except core's
   pre-flight `insufficient-funds`) or is not paid stays counted; then `pollQuote` mints at the
   target; paid-but-unminted is counted and retried at the next trigger with the wallet that paid.
   What a paid melt moved comes from its own history line; without one, the larger of the whole
   reservation and the source's balance drop (R5).

### The ledger

`packages/app-desktop/src/host/topup/ledger.ts` — userData `auto-topup.json` (the settings file's
atomic `JsonFile`, 0600): the entries of the last 24 h and the allowed mints. Fails CLOSED: a
corrupt, unknown-version or out-of-shape file is copied to `.corrupt` and replaced by a marker
counting the whole daily cap (top-ups pause 24 h, allowances forgotten, so the question comes
back); if that cannot be written, every top-up is refused for the run. It never writes a value its
own guard would refuse. `JsonFile` gained `moveAsideCorrupt` (default unchanged) so a corrupt
ledger is never read as "missing" on the next start. The funding melts' history ids are a list of
their own (`melts`, the newest 256, bounded by the file guard, optional on read), never pruned by
the 24-hour window, so this device keeps the "top-up" label (R2). Allowed mints and the daily cap
are per install, shared across identities, like the settings (R7, ADR 0012 addendum).

### History

Core already writes both sides: minting `in … "top-up"` at the target, the melt `out … "melt to
Lightning"` at the source. Nothing more is written (no double entry). Core's melt takes no memo, so
the host shows the funding melt as "top-up" (`wallet.history`, the `wallet.change` topic) by the
history id the ledger recorded — only a new line at the source, for between the amount and the
reservation, and only if it is the only one.

### Guards, main, prompt page

- `updateSettings` / `parseStoredSettings`: `amountSats` only as an integer 1 … 10 000
  (`LIMITS.maxAutoTopUpAmountSats`, pinned to core's constant at the type level in `protocol.ts`
  and by a test). Anything else refuses the patch, and a stored file reads as the defaults (off).
- Main's settings gate asks when `amountSats` changes too; its text states the amount, the 50 000
  daily cap (fees included) and the first-time confirm.
- `PromptAnswer` `top-up-first` `{confirm}`: main's `toPromptAnswer`, `promptAnswerFits`,
  `summarizeAnswer` (e2e), the page's view (`dl.facts`, CSS) and local cap constants pinned by a
  test (the page bundle imports nothing).

### UI

- Settings › Mints and top-up: an "Each top-up" field (default and max 10 000, parsed by
  `parseTopUpAmountSats`), every edit keeps the amount, the summary now says what the contract
  means ("when a mint on your list that you pay from drops below X, moves Y there from Z" — the old
  copy compared the balance at `fromMint`, which is wrong since v5), and a note: at most 50 000 in
  any 24 hours, Lightning fees included; the first top-up into each mint asks in a separate window;
  mints not on the list are never topped up. Off by default (unchanged).
- Wallet › Auto top-up card: saving keeps `amountSats`; its hint states the amount, the cap and the
  first-time confirm. `historyLabel`: an `out` "top-up" reads "Auto top-up (moved to another mint)".
- `UI_AUTO_TOP_UP_MAX_SATS` / `UI_AUTO_TOP_UP_PER_DAY_SATS` in `components/shared/format.ts`,
  pinned to core's by a test (the UI imports no core runtime code).
- R8: the Settings model's THRESHOLD constants are `AUTO_TOP_UP_THRESHOLD_MAX_SATS` (10 000 000)
  and `AUTO_TOP_UP_THRESHOLD_DEFAULT_SATS` (1 000), and the IPC limit is
  `LIMITS.maxAutoTopUpThresholdSats`, so `AUTO_TOP_UP_MAX_SATS` means only core's per-top-up
  amount (10 000).

### Mocks

`core/src/mocks/test-mint.ts`: `TestLightning` — TestMints sharing one pay each other's invoices
on melt (tests only; unchanged without the option). `MockNetworkAdapter` needed nothing (a plain
merge keeps `amountSats`).

## Files

- New: `app-desktop/src/host/topup/{auto-topup,ledger}.ts`; tests
  `host/__tests__/{auto-topup,topup-host,topup-real-mint.integration}.test.ts`;
  `docs/contract-requests/S3-topup.md`; `docs/reviews/2026-09-25-pre-push-auto-topup.md`; this file.
- Changed (app-desktop): `host/{adapter,dispatch,host,index,money,topics,wallet}.ts`,
  `host/settings/{json-file,settings}.ts`, `ipc/{guards,protocol}.ts`,
  `main/{main,money-gate,prompt}.ts`, `renderer/prompt/{prompt.ts,prompt.css}`; tests
  `host/__tests__/{adapter-play,conformance,desktop-signer,money,settings}.test.ts`,
  `host/__tests__/support/rig.ts`, `ipc/__tests__/guards.test.ts`,
  `main/__tests__/{money-gate,prompt}.test.ts`, `renderer/__tests__/prompt-page.test.ts`.
- Changed (ui): `components/{index.ts,shared/format.ts}`,
  `screens/Settings/{WalletSection.tsx,model.ts}`, `screens/Wallet/Wallet.tsx`; tests
  `components/__tests__/components.test.ts`, `screens/Settings/__tests__/{model,settings}.test.ts`,
  `screens/Wallet/__tests__/wallet.test.ts`.
- Changed (core): `mocks/test-mint.ts`.
- Docs: `docs/decisions/0012-desktop-money-plane.md` (addendum).

Existing tests changed, not weakened: `adapter-play.test.ts` SE-4 — with `--dev-mocks` nothing
executes, as before; only the log line's wording changed ("not executed with --dev-mocks"), comment
cites issue #2. `conformance.test.ts` — the settings result guard admits the new optional
`amountSats` (plus a new case exercising it). `desktop-signer.test.ts` — its exhaustive prompt
switch names the new kind (answers `null`).

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

## Mutation checks

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

## Independent review (after `0cd3d30`)

Verdict **ship**; five low and six info findings, each checked against the code first. Full
record: `docs/reviews/2026-09-25-pre-push-auto-topup.md`, "Independent review".

| # | Finding | Outcome |
|---|---|---|
| R1 | any balance drop at an allowed mint (the user's own withdrawal too) started a top-up | fixed — payment path only (`checkBalance`, the money plane's PAY via `onPayment` → `paymentAt`) |
| R2 | the "top-up" label lost after 24 h | fixed — bounded list of 256 melt ids outside the window |
| R3 | no test for a pending reservation after a restart | fixed — tests added (the code was right) |
| R4 | no wallet re-check after the question | fixed — `stillWanted` (same wallet, same settings) after the question, before the reservation and before the melt; `MoneyPlane.liveWallet` |
| R5 | input fees past the allowance uncapped and under-counted | accounting fixed (the larger of the reservation and the balance drop); up-front refusal deferred — contract request 3 |
| R6 | settings not re-read before the melt | fixed with R4 |
| R7 | allowed mints and the cap are per install | not a defect — documented in ADR 0012 |
| R8 | threshold vs amount constant names | fixed — `AUTO_TOP_UP_THRESHOLD_*`, `LIMITS.maxAutoTopUpThresholdSats` |
| R9 | an unrecordable yes re-asked after every failure backoff | fixed — backs off like a decline |
| R10 | counts in this report | fixed — 31 tests at `0cd3d30`; mutation table re-run below |
| R11 | two defensive checks untested | fixed — tests added |

Also found while fixing: M3 was caught by one arithmetic test only (a behavioural test added),
and an async `onPayment` hook's rejection would have escaped the swallow (fixed, tested).

### Mutation checks for the review fixes

| # | Guard broken | Result |
|---|---|---|
| R1 | a real-wallet balance event starts a top-up again | 1 fails |
| R1b | the money plane never calls `onPayment` | 2 fail |
| R1c | the host does not wire `onPayment` | 1 fails |
| R2 | `isTopUpMelt` reads only the windowed entries | 2 fail |
| R2b | the melt-id list unbounded | 1 fails |
| R3 | `pending` not counted (the reviewer's MX, which survived) | 2 fail |
| R4a | no re-check after the question | 2 fail |
| R4b | both wallet-identity checks removed | 3 fail |
| R4b2 | only the post-read identity check removed | survived at first → a test switching the wallet during that read → 1 fails |
| R4c | no last look before the melt | 3 fail |
| R4d | `liveWallet` returns the wallet after `close` | 1 fails |
| R6 | no re-check before the reservation | 4 fail |
| R5 | the old fallback (`reserved − change`) | 2 fail |
| R5b | the balance drop ignored | 1 fails |
| R9 | an `allow()` failure not backed off | 1 fails |
| R11a | `melt.mint !== from` removed | 1 fails |
| R11b | ppk validation removed | 4 fail |
| R12 | an async hook's rejection unhandled | 1 fails |

Runner: `scratchpad/S3-topup/mut.py` (one exact-string patch, `npx vitest run <files>`, restore).

## Residuals

- Other devices see the funding melt as "melt to Lightning" (contract request 1). This device
  keeps the label for the newest 256 top-ups (R2).
- Input fees past the 64-input allowance cannot be refused up front: the `Wallet` contract does
  not say how many inputs core's melt will select (contract request 3, R5). They are counted in
  the daily cap afterwards (the melt's line, else the larger of the reservation and the source's
  balance drop), so the 5 % fee check covers the Lightning reserve and the allowance only.
- Allowed mints and the daily cap are per install, shared by every identity on it, like the
  settings (R7; ADR 0012 addendum).
- `MoneyPlane.wallet` still returns the wallet after `close`; the top-up uses `liveWallet`. A
  future unattended caller must use `liveWallet` too (documented on the getter).
- Fees count toward the daily cap (contract request 2): four 10 000-sat top-ups a day with a
  charging source mint, not five.
- Deleting `auto-topup.json` resets caps and allowances (same-user local access); clock jumps can
  age entries early (forward) or hold them longer (back, fail closed).
- A paid-but-unminted top-up is retried in memory only; after a restart its quote id is gone (not
  written: bearer without NUT-20), the sats stay counted.
- The first-funding question is main's trusted prompt window (ADR 0013), not the renderer money
  gate's OS dialog (the host initiates it; the window has the queue, deadline and cancel it needs).
- Electron e2e not run here (the orchestrator runs it serially). The prompt page's new view is
  covered by jsdom tests only.

## Proposed row for `docs/status.md`

| Issue #2 — auto top-ups execute (F4) | `stage-3/auto-topup` | DONE: with the real wallet a due top-up runs from the payment path only (a play opening, a PAY for an open session; never the user's own withdrawal or any other balance change) — mint quote at the target, melt at `fromMint` — off by default, only into mints on the user's list, ≤ 10 000 per top-up and ≤ 50 000 per rolling 24 h (fees and in-flight included; ledger persisted, fails closed), first funding of a mint confirmed in main's prompt window (remembered only on yes), re-checked (same wallet, same settings) before the reservation and the melt, one at a time with backoff, both sides in wallet history; Settings amount field + cap copy. Review `docs/reviews/2026-09-25-pre-push-auto-topup.md` (self-review + independent review: 11 findings — 9 fixed, 1 fixed in part with the up-front input-fee refusal deferred, 1 not a defect and documented); contract request `S3-topup.md` (melt memo, fees in the cap, melt input-fee cap) |

## Proposed text for `docs/security-review.md`

F4 changes state (executed, not only evaluated). Proposed edits:

- §0 table, row F4 → `| F4 | **Fixed** | Auto top-ups execute (issue #2, `stage-3/auto-topup`), started only from the payment path (a play opening, a PAY for an open session — never a balance change such as the user's own withdrawal): only into mints on the user's own `defaultMints` (never a manifest's, never `fromMint`), ≤ 10 000 sats each, ≤ 50 000 in any rolling 24 h (fees and in-flight included; persisted ledger that fails closed), the first top-up into each mint confirmed in main's trusted prompt window (only a yes is remembered), one at a time with backoff; main's settings gate also asks on an amount change |`
- SE-4 row → `| SE-4 | **Fixed** (`autoTopUpDue` false for `belowSats <= 0`, tested; v5 normative). Since issue #2 top-ups execute with the real wallet (F4); with `--dev-mocks` still only logged |`
- Open items, the F4 row → `| [Done] F4: auto top-ups execute — off by default, ≤ 10 000 sat per top-up, ≤ 50 000 sat per rolling 24 h (fees included), own mints only, first-time confirm in main's prompt window, every top-up in wallet history (`stage-3/auto-topup`). Residuals [Low]: other devices label the funding melt "melt to Lightning" until `Wallet.melt` takes a memo (contract request S3-topup 1); input fees past the 64-input allowance are counted but cannot be refused up front until `Wallet.melt` can cap them (contract request S3-topup 3); deleting the ledger file resets the caps (same-user local access); allowed mints and the cap are per install, shared across identities |`
- §F4 body, append: **Status (2026-09-25).** Fixed as specified: the three tests named above
  exist (`host/__tests__/topup-host.test.ts`: an unknown mint gets no request and play fails
  `no-balance`; a trusted mint gets one top-up within the cap; `auto-topup.test.ts`: the top-up
  beyond the rolling cap is refused), plus: a declined first funding moves nothing, the ledger
  survives a restart, a corrupt ledger fails closed, two payments at once make one top-up, and an
  opt-in run against two Nutshell mints; and, from the independent review, the user's own
  withdrawal that empties an allowed mint moves nothing while a PAY that leaves it below the
  threshold tops it up, a sign-out during the first-funding question moves nothing, and a pending
  reservation still counts after a restart. Review:
  `docs/reviews/2026-09-25-pre-push-auto-topup.md` (self-review: five findings fixed; independent
  review: eleven findings — nine fixed, one fixed in part with the up-front input-fee refusal
  deferred as contract request 3, one not a defect and documented; 22 + 18 mutation checks).
