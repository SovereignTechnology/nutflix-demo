# Pre-push review — R5-R1: resuming auto top-ups past a held one (2026-10-02)

Diff: `main` at `546c9bd` → the Resume branch (lane C3-topup-resume, a Claude Code cloud session).
Cameron's decisions (status.md, Stage 3 input 30, and 2026-10-02 follow-ups): a Resume action in
Settings, confirmed in main's **native** dialog; a resumed hold is **waived, not deleted** ("waive,
keep watching"); Resume is offered for **every** reason, an unreadable record included (the dialog
says the signer may just be offline).

- No contract change (a shell-only path, like ADR 0016's recovery phrase); no locked path.
- Money path: the top-up ledger (`host/topup/ledger.ts`) and `AutoTopUp` (`host/topup/auto-topup.ts`).

## The problem

An open auto top-up (a target mint's quote whose melt may have paid it) holds back every new
top-up into that target until it is minted, provably unpaid, or lapsed and answered. Some holds
never end by themselves — a source mint gone for good, a target that forgot the quote, a quote
with no expiry, a record that does not unseal (R5-R1) — and the only trace was a throttled log line
and plays failing `no-balance`.

## Why not delete the hold

The open record is the only copy of the target's quote id, and a quote the mint did not lock
(NUT-20; a signer-held key cannot lock one) is bearer money once paid. In the `owed` case — the
melt paid, or the source says PAID, while the target still says UNPAID — the target owes the sats;
deleting the record would forfeit them if it credits them later. So a resumed hold is **waived**:
`LedgerEntry.waived: true`, persisted before it counts (`TopUpLedger.waive`), carried across every
`settle`. `hasOpen` skips waived entries (the target is no longer held back); `resolveOpen` still
polls them, mints them on PAID and releases them by the same rules.

## What changed

| Layer | Change |
|---|---|
| Ledger | `waived?: true` (type, file guard, `settle` carries it); `hasOpen` skips it; `waive(id, owner)` refuses an unknown, closed, minted or other identity's entry and persists first |
| `AutoTopUp` | `resolveOpen` records why each open top-up holds (`unreadable`, `unreachable`, `owed`, `waiting`; `checking` before the first look); `holds()` lists the signed-in identity's; `resumeHold(id)` asks `confirmResume` (absent: `unavailable`, never resumed), then RE-CHECKS (a signer swap, or the hold ending during the dialog: `not-found`, nothing changes) before `waive` |
| IPC | `desktop.wallet.topUp.holds` / `.resume(id)` (an id of 16 hex only); `ConfirmForm` `topup-resume` (target, amount, reason — data only, `isConfirmForm`) |
| Main | `describeHostConfirm` words the dialog: the mint by its ASCII host, the amount, the reason, that the earlier top-up is still watched; for `owed`, that the mint could be topped up twice; for `unreadable`, that the signer may just be offline |
| Host | `confirmResume` = `bridge.confirm`, pre-checked by `isConfirmForm`; adapter/dispatch: `forbidden` where top-ups do not run, `not-found` for no such hold, `false` when not confirmed |
| Preload / renderer | `desktop.wallet.topUp.{holds,resume}` (only the first argument of `resume` crosses); `topUpHoldsFromBridge`; the Shell passes it to Settings |
| UI | `TopUpHolds` in Settings › Mints and top-up › Auto top-up: one note per hold with Resume; nothing without controls or holds |

## Tests (each mutation checked)

- `auto-topup.test.ts` "R5-R1" (4): the whole story — held with `owed`; cancelled changes nothing;
  confirmed waives (record kept); new top-ups run again (paid twice, as the dialog warns); the
  target pays at last and BOTH quotes are minted. Fail-closed cases (no dialog, unknown id, signer
  swap during the dialog). A hold that ends during the dialog → `not-found`. The waiver on disk
  survives a restart and a `settle`; only the owner may waive. Mutations: `hasOpen` ignoring the
  waiver (2 tests fail), `settle` dropping it (1), the post-dialog re-check removed (1).
- `main/__tests__/topup-resume.test.ts`: wording per reason, the IDNA host, the form guard.
- `preload/__tests__/bridge.test.ts`, `host/__tests__/host.test.ts` (dev-mocks: none listed,
  resume `forbidden`, malformed ids `invalid-argument`), `ipc` samples and the method count.
- `ui/.../topup-holds.test.ts`: hidden without controls or holds; text and Resume; confirmed /
  not confirmed / error.

## Attacker model

- **A compromised renderer** can list holds (mints, amounts, reasons — what Settings already shows)
  and ask to resume one; it cannot skip the dialog: the HOST asks main's native dialog itself, and
  only main's yes waives. It cannot word the dialog (data only). A waiver forfeits nothing.
- **A compromised host** could waive without asking — it already holds the wallet; nothing new.
- **A hostile mint** that never answers keeps a hold `unreachable`; the user may resume, and the
  quote is still polled.

## Residuals

- Waived entries still count toward `MAX_OPEN_TOP_UPS` (16, every identity): a user who resumes
  past many stuck holds can reach it, and new top-ups are then refused (fail-safe) until some end.
- An older build reading a ledger with `waived` refuses it as corrupt (its strict file guard): top-ups
  pause for 24 h and the allowed-mint list is cleared. No deployed base yet; after the first
  release, a ledger field needs a version step.
- The reason is kept in memory: after a restart a hold reads `checking` until the next look.
