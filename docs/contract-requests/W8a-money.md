# Contract requests — lane W8a-money (final cross-lane review, money plane / NUT-13)

None blocks the lane: each is worked around in the host as described. They concern the Settings
screen (`packages/ui/src/screens/Settings/RecoverySection.tsx`, lane L5-Settings) and the frozen
seam's `RestoreOutcome` (`packages/core/src/wallet/recovery-api.ts`), both outside this lane.

## 1. A "not finished" restore outcome, and a Continue action

**Need.** The host now follows core's `resume` (`RestoreDetail.resume`, lane N1's contract request
item 7): up to `RESTORE_ROUNDS` (10) calls per phrase and mint in one restore, and a scan still
unfinished keeps its cursor in the host, so the next restore continues from there. The wire's
outcomes (`RestoreOutcomeWire` = the seam's `RestoreOutcome`) have no word for that, and the
Settings screen renders `OUTCOME[r.outcome]` from a fixed map.

**Workaround.** An unfinished mint with nothing restored reads `unreachable` ("could not be
reached") — the one existing outcome whose natural action, pressing Restore again, is the right
one. It used to read core's `refused` ("refused the restore"), which looks like a hostile mint. A
mint where something was restored reads `restored` with the sats so far.

**Proposal.** Add `'partial'` to `RestoreOutcome` (N1's item 7 proposes the same) and to
`RESTORE_OUTCOMES`; the Settings screen shows "not finished — press Restore again to continue"
(or a "Continue restore" button naming the same action; the cursor stays in the host). A host
change of a few lines follows: `restorePass` returns `partial` where it now says `unreachable` for
an unfinished scan.

## 2. The relay copy's "retrying" state

**Need.** The relay copy is retried with a bounded backoff until a relay takes it (the envelope's
`relayCopy: false` is the persisted pending flag). `RecoveryStatusWire.relayCopy` flips to `true`
once one lands, but the screen's text for `false` says "only your written words can bring this
phrase back", which reads as final.

**Proposal.** Either a `relayCopyPending: boolean` in `RecoveryStatusWire` (true while the host is
retrying) or, simpler, the text for `false`: "The encrypted copy has not reached your relays yet:
Nutflix keeps trying. Until then only your written words can bring this phrase back." And a
status refresh when the section regains focus, so a landed retry shows.

## 3. Dust keeps the backup "pending"

**Need.** A reissue now completes only when no journal entry and no dust (proofs the mint's input
fee would eat) is left outside the phrase at a mint — so the replaced phrase's relay copy is
retired only then (the round-8 finding's decision). A wallet with a few sats of dust keeps
`reissuePending: true`, and "Finish backup" then moves nothing (no fee dialog: nothing sensible to
move) until normal spending uses the dust.

**Proposal.** A `reissueBlocked` count (or reason: `in-flight` / `dust`) in `RecoverySetupWire`, so
the screen can say "a few sats stay outside the phrase until they are spent" instead of offering
"Finish backup" again.
