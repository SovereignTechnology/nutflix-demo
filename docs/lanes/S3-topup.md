# Lane S3-topup — auto top-ups execute (issue #2, security review F4)

**Issued against `CONTRACTS_VERSION = 6`** (the c08c99f amendment: `Settings.autoTopUp.amountSats?`,
`AUTO_TOP_UP_MAX_SATS` = 10 000, `AUTO_TOP_UP_MAX_SATS_PER_DAY` = 50 000). Branch
`stage-3/auto-topup` off `c08c99f`. Cameron's rules (2026-09-24): off by default; when on, at
most 10 000 sats a top-up and 50 000 a day, only into mints on the user's own list, a native
confirm the first time a mint is funded, every top-up in wallet history.

No contract change; `docs/contract-requests/S3-topup.md` asks for a memo on `Wallet.melt` and for
one sentence on fees in the daily cap (both worked around). No dependency, lockfile or
`package.json` change. Nothing outside the allowlist.

## What changed and why

### The top-up (host)

`packages/app-desktop/src/host/topup/auto-topup.ts` — `AutoTopUp.check(mint, balance?)`, called
on every wallet balance change and by `play` when nothing at the video's mints can pay. With the
user's REAL wallet only; with `--dev-mocks` a due top-up is still just logged (SE-4 unchanged
there: fake sats, no prompt window).

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
7. **Money**: the reservation is persisted, then `melt`; a melt that throws (except core's
   pre-flight `insufficient-funds`) or is not paid stays counted; then `pollQuote` mints at the
   target; paid-but-unminted is counted and retried at the next trigger with the wallet that paid.

### The ledger

`packages/app-desktop/src/host/topup/ledger.ts` — userData `auto-topup.json` (the settings file's
atomic `JsonFile`, 0600): the entries of the last 24 h and the allowed mints. Fails CLOSED: a
corrupt, unknown-version or out-of-shape file is copied to `.corrupt` and replaced by a marker
counting the whole daily cap (top-ups pause 24 h, allowances forgotten, so the question comes
back); if that cannot be written, every top-up is refused for the run. It never writes a value its
own guard would refuse. `JsonFile` gained `moveAsideCorrupt` (default unchanged) so a corrupt
ledger is never read as "missing" on the next start.

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

### Mocks

`core/src/mocks/test-mint.ts`: `TestLightning` — TestMints sharing one pay each other's invoices
on melt (tests only; unchanged without the option). `MockNetworkAdapter` needed nothing (a plain
merge keeps `amountSats`).

## Files

- New: `app-desktop/src/host/topup/{auto-topup,ledger}.ts`; tests
  `host/__tests__/{auto-topup,topup-host,topup-real-mint.integration}.test.ts`;
  `docs/contract-requests/S3-topup.md`; `docs/reviews/2026-09-25-pre-push-auto-topup.md`; this file.
- Changed (app-desktop): `host/{adapter,dispatch,host,index,topics,wallet}.ts`,
  `host/settings/{json-file,settings}.ts`, `ipc/{guards,protocol}.ts`,
  `main/{main,money-gate,prompt}.ts`, `renderer/prompt/{prompt.ts,prompt.css}`; tests
  `host/__tests__/{adapter-play,conformance,desktop-signer,settings}.test.ts`,
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

## Mutation checks

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

## Residuals

- Other devices see the funding melt as "melt to Lightning" (contract request 1).
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

| Issue #2 — auto top-ups execute (F4) | `stage-3/auto-topup` | DONE: with the real wallet a due top-up runs (mint quote at the target, melt at `fromMint`), off by default, only into mints on the user's list, ≤ 10 000 per top-up and ≤ 50 000 per rolling 24 h (fees and in-flight included; ledger persisted, fails closed), first funding of a mint confirmed in main's prompt window (remembered only on yes), one at a time with backoff, both sides in wallet history; Settings amount field + cap copy. Review `docs/reviews/2026-09-25-pre-push-auto-topup.md`; contract request `S3-topup.md` (melt memo) |

## Proposed text for `docs/security-review.md`

F4 changes state (executed, not only evaluated). Proposed edits:

- §0 table, row F4 → `| F4 | **Fixed** | Auto top-ups execute (issue #2, `stage-3/auto-topup`): only into mints on the user's own `defaultMints` (never a manifest's, never `fromMint`), ≤ 10 000 sats each, ≤ 50 000 in any rolling 24 h (fees and in-flight included; persisted ledger that fails closed), the first top-up into each mint confirmed in main's trusted prompt window (only a yes is remembered), one at a time with backoff; main's settings gate also asks on an amount change |`
- SE-4 row → `| SE-4 | **Fixed** (`autoTopUpDue` false for `belowSats <= 0`, tested; v5 normative). Since issue #2 top-ups execute with the real wallet (F4); with `--dev-mocks` still only logged |`
- Open items, the F4 row → `| [Done] F4: auto top-ups execute — off by default, ≤ 10 000 sat per top-up, ≤ 50 000 sat per rolling 24 h (fees included), own mints only, first-time confirm in main's prompt window, every top-up in wallet history (`stage-3/auto-topup`). Residual [Low]: other devices label the funding melt "melt to Lightning" until `Wallet.melt` takes a memo (contract request S3-topup 1); deleting the ledger file resets the caps (same-user local access) |`
- §F4 body, append: **Status (2026-09-25).** Fixed as specified: the three tests named above
  exist (`host/__tests__/topup-host.test.ts`: an unknown mint gets no request and play fails
  `no-balance`; a trusted mint gets one top-up within the cap; `auto-topup.test.ts`: the top-up
  beyond the rolling cap is refused), plus: a declined first funding moves nothing, the ledger
  survives a restart, a corrupt ledger fails closed, two payments at once make one top-up, and an
  opt-in run against two Nutshell mints. Review:
  `docs/reviews/2026-09-25-pre-push-auto-topup.md` (five findings fixed, 22 mutation checks).
