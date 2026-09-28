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

## 3. What the backup leaves outside the phrase (revised in fix round 8)

**Need.** Fix round 8 (F56) changed the rule this item first described. Dust (proofs the mint's
input fee would eat whole) and a mint with nothing spendable — whatever is journaled there — now
count as done for the backup: `reissuePending` turns `false` and "Replace phrase" is offered, so
dust can no longer block a rotation for good. They keep a replaced phrase's relay copy instead
(retired once no mint left out of the backup holds a balance or a journal entry). A mint with a
balance worth moving and an operation in flight is not moved until the operation settles, and
keeps `reissuePending: true` ("Finish backup" moves it then). The screen cannot say either:
`reissueFailed` no longer counts dust, and nothing tells the user that a few sats stay outside the
phrase, or that "Finish backup" is waiting for a payment to settle.

**Proposal.** In `RecoverySetupWire`, a `reissueWaiting` count (mints whose balance waits for an
operation in flight: "a payment is still in flight at 1 mint: finish the backup once it settles")
and a `dustLeft` count ("a few sats at 1 mint cost more in fees than they are worth: they stay
outside the phrase"). The host has both counts already (`reissueAll`'s `blocked` and `dust`).

**Revised in fix round 9.** A mint with an operation journaled there now keeps `reissuePending:
true` only while the operation is young (under 10 min) and the mint answers, whatever is spendable
there. Once every entry is overdue, the mint counts done but watched. So does a mint that cannot
be asked, whatever it holds. The host reopens the backup (`reissuePending` turns `true` again) once
a watched mint shows a balance worth moving. Two things the screen does not handle yet:

- `reissueFailed` can be above 0 while `reissuePending` is `false`: a watched mint's balance is not
  covered. The success line then says "finish the backup later", while the button reads "Replace
  phrase". Proposal: a `reissueWatched` count, worded "the balance at 1 mint could not be moved yet
  (the mint did not answer, or a payment is still settling): Nutflix offers "Finish backup" again
  once it can be".
- The status can flip back to `reissuePending: true` with no action from the user. A status refresh
  when the section regains focus (item 2) covers that.

## 4. Two different `rate-limited` refusals read as one (fix round 8, info item)

**Need.** The screen's `flowError` renders every `rate-limited` as "Too many windows were closed in
a row. Try again in a minute." The host sends that code for two things: the throttle (dismissed
windows) and a second action while a recovery window is already open ("a recovery phrase window is
already open"). Fix round 8 took the relay copy retry off that lock (a Settings action now waits
for a retry instead of being refused), so only a real second window triggers it now — but the
screen still names the wrong cause.

**Proposal.** Show the host's own sentence for `rate-limited` (the part after the code, as for
every other code), or tell the two apart by it: "A recovery window is already open: finish or
close it first."

**Fix round 9.** A flow waits for a running relay copy retry for at most 22.2 s. Past that it is
refused with `remote-signer` (a NIP-46 signer that has not answered) or `relay-down`, with the
host's sentence. The screen already shows that sentence for both codes, so nothing is needed there
beyond the item above.
