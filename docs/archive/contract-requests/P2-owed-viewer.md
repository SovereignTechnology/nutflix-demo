# Contract request — lane P2-owed-viewer: an explicit end to a seeder's `OWED` report

**Answered 2026-10-02 (Cameron): option 1, contracts v7** (`pay-protocol.ts` rule 5,
`OWED_END_CORE`); review record `docs/reviews/2026-10-02-pre-push-pay-v7.md`.

Date: 2026-09-27. Lane P2-owed-viewer (the viewer side of the ADR 0018 amendment). Contracts are
frozen for this lane, so this is a request, and the lane's code does not depend on it. Lane
P1-owed-seeder asked a related question (its Q2).

## The problem

The amendment says a viewer "never asks beyond window minus the reported count". But v6 gives
the viewer no way to know the report is complete before it asks for something:

- a seeder sends one `OWED` per owed core, and nothing when nothing is owed;
- the order rule guarantees only that the whole report comes before the first block the viewer
  asked for after `open`. The viewer learns the report is complete by asking.

If a seeder already counts its whole window against the viewer (the viewer crashed at the cap,
say), asking even one block before the report is in overruns that seeder, and it bans the viewer.

## What the lane built instead (no contract change)

- Before a seeder's report is complete, it is asked ONE block at a time.
- The desktop keeps a durable, write-ahead word per seeder pubkey: "may count its whole window
  against us". A seeder with that word is asked nothing until its report is complete. Complete
  means one of:
  - an ACK arrived (the report then pays what the record holds);
  - a block arrived that was asked after `open`;
  - `REPORT_WAIT_MS` (10 s) passed.
- The gateway has no durable state. It keeps the one-block rule, and with it the risk that one
  ask overruns a seeder its own crash left exactly at its window.

Residuals of that design:

- 10 s of latency toward such a seeder after a crash;
- a report delayed past 10 s is taken as empty;
- the gateway risk above.

## Requested change (v7, additive)

One of these, in order of preference:

1. **`OWED` with zero ranges ends the report.** After the last `OWED` of the report, and when
   nothing is owed at all, the seeder sends one `OWED` whose `ranges` is empty, with its `core`
   all zeros. The codec change is small: the grammar gains that one form. A viewer then waits for
   that frame, with a bound, before its first ask. No write-ahead ledger is needed, and no timer
   decides completeness.
2. **`HELLO.owedBlocks`** (seeder → viewer): the total the seeder counts for the viewer's pubkey
   at bind time. That value is only known after the seeder has verified the viewer's HELLO,
   which comes after its own HELLO in one of the two orders. So this works only if the seeder's
   HELLO waits for the viewer's, which is a larger change.

Either would let the viewer drop `REPORT_WAIT_MS`, drop the gateway's residual, and use the
durable word only as a hint.
