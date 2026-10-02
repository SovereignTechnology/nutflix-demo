# Pre-push review — pay/1 v7: an explicit end to the `OWED` report (2026-10-02)

Diff: `main` at `068a432` → the v7 branch (lane C2-pay-v7, a Claude Code cloud session).
Cameron's decision (status.md, Stage 3 input 29): **yes, pay/1 v7** for R3/R4, option 1 of
`docs/contract-requests/P2-owed-viewer.md`. Method: the change written against the contract
request, every layer given a test that fails without its part (below), then a differential read
of the whole diff and the attacker model.

- **Contracts changed: v6 → v7** (`check-contracts-version.sh`: version bumped). Additive: rule 5
  in `pay-protocol.ts`, `OWED_END_CORE`, the `OwedMessage` doc. `PAY_PROTOCOL_VERSION` stays 1.
- **Locked path changed:** `packages/core/src/pay-protocol/codec.ts` (Cameron, 2026-10-02:
  locked paths are editable; the guard still holds — no new import, no logging).
- Nothing outward beyond the PR.

## What changed

| Layer | Change | Test that fails without it |
|---|---|---|
| Contract | Rule 5: after rule 2's report — and alone when nothing is owed — the seeder sends one `OWED` with `core` = `OWED_END_CORE` (32 zero bytes) and `ranges` empty; once per connection, under rule 2's order | — (`CONTRACTS_VERSION` 7) |
| Codec | The end marker is the one `OWED` with a count of 0; a count of 0 for any other core, the zero core with ranges, and trailing bytes are refused both ways | `codec.fuzz.test.ts` "v7" (2 tests) and 7 fuzz properties now generating the marker: 9 fail on the v6 codec |
| Seeder | `announceOwed` sends the marker after its loop — never after a report that failed part-way (the throw leaves first), never to a pubkey cut at HELLO, never twice | `owed-terms.test.ts` (6 cases updated; "no end marker after a short report" made explicit); `owed.integration.test.ts` through the real codec on a real replication stream |
| Gateway `SeederCredit` | The marker completes the report at once (the `REPORT_WAIT_MS` timer cleared); a malformed marker, or one after completion, is ignored | `seeder-credit.test.ts` "v7": fails with the branch removed |
| Desktop `ViewerPayer` | `onOwed` returns on the marker (it named nothing to pay; the credit side completes the report) | — (it already reduced to a no-op; the return makes it explicit) |
| Fuzz harness | `owedArb` draws the marker; report cores exclude `OWED_END_CORE` (fast-check leans to all-zero bytes); the structural self-check knows rule 5 | the harness self-check failed until it did |

## Compatibility

- **v7 viewer, v6 seeder:** no marker arrives; the viewer keeps today's completions (an ACK, a
  block asked after `open`, or `REPORT_WAIT_MS`). Unchanged behaviour.
- **v6 viewer, v7 seeder:** the v6 codec refuses the marker as an undecodable frame and closes
  `pay/1`. Accepted as in v6 (`version.ts`: "no deployed base yet"); `verifyHello` refuses any
  `HELLO.version` but 1, so a version bump is not a way out. **Before the first public release
  this stops being free**: from then on a grammar change needs negotiation (a HELLO capability)
  rather than this rule.

## Attacker model

- **A seeder that sends the marker early** (before its real report): the viewer treats the report
  as complete and may ask up to its window minus what was reported — a seeder that then counts
  more and cuts the viewer harms only its own service. No money moves on a claim: the viewer pays
  only blocks its durable record holds (ADR 0018 amendment). Same as a seeder that under-reports
  today.
- **A seeder that never sends it:** the v6 bound applies (`REPORT_WAIT_MS`).
- **A forged marker on the wire:** `pay/1` rides the Noise-encrypted replication stream; nobody
  but the seeder can write a frame on it.
- **The zero core as a real core:** an all-zero ed25519 public key is not a valid point, so no
  Hypercore has it; the codec refuses it with ranges anyway.
- **Parser surface:** one more branch in `decode`, taken only when the 32 bytes are all zero; the
  count is read, must be 0, and the frame must end there.

## Residuals

- R3 and R4 are closed toward v7 seeders. Toward a v6 seeder the old wait and the gateway's
  crash-at-window residual remain; every seeder this repository builds is v7.
- The desktop's durable "may be at its window" word is now only a hint toward v7 seeders: the
  marker ends the wait, as the contract request intended.
