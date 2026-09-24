# Pre-push review — the pending-PAY journal and cap (2026-09-24)

Diff: `stage-3/upstream-credit` (`bb80344`) → `stage-3/pending-journal`. Method: the
`differential-review` checklist and `sharp-edges` questions, inline, by the session that wrote the
change.

## Scope

- HIGH (durability of accepted payments):
  - `seeder/src/runtime/engine-state.ts` (`PendingJournal`, replay, migration);
  - `runtime/index.ts` (wiring, `accepting`).
- MEDIUM (serving decisions):
  - `seeder/src/net/peer-session.ts` + `session-registry.ts` + `seeder.ts` (the `accepting`
    gate);
  - the daemon and gateway entry points.
- LOW: tests, docs.

## Adversarial questions

- **Can an ACKed PAY be lost?**
  - The hook still returns only after the append is fsynced (or after a compaction's atomic
    write).
  - A crash mid-append leaves an unterminated last line (skipped: that PAY was never ACKed — the
    hook had not returned).
  - A crash mid-compaction leaves the old journal (the atomic write renames only a complete
    file).
  - A write failure is reported and thrown, as before.
  - Migration writes the journal (fsynced) before it removes `pending.json`; a crash between the
    two re-migrates the same PAYs, which replay idempotently (same keys).
- **Can a damaged journal be half-read silently?** Only an unterminated last line is forgiven.
  A bad line followed by a newline, a missing header, an unknown record, an unkeyable item, or a
  file others can read refuses to start (tested). Items remain untrusted input to
  `restorePending`.
- **Key collisions.** Keys are made of the peer, the core and range, the stage and flags, and the
  first seeder and creator proof secrets. A secret is accepted once (the seen set), so two live
  PAYs cannot share a key. The key sits next to the proofs themselves in a 0600 file.
- **Does the cap hurt honest viewers?**
  - A viewer is never banned for it (a `local` cut, tested).
  - PAYs for blocks already sent are still accepted, so the viewer is not left owing for blocks
    it got. The gate runs BEFORE the upload is recorded and before the block leaves (the same
    tick as the window cut), so nothing unpaid is counted.
  - Reconnects are bounded by the existing connection rate limits.
- **Can a peer drive the queue past the cap?** Only by what is already in flight: at most one
  window per session, since new blocks stop.

## Found and fixed before commit

| # | Severity | Finding | Fix |
|---|---|---|---|
| S1 | Low | The first replay forgave a bad SECOND-to-last line too; a torn write can only leave an unterminated last line | Only the last line is forgiven |
| S2 | Low | The integration test looked for the cut session among live ones (a cut session is gone) | It waits for the cut's log line |

## Residual

- The desktop worker's queue (one user) is still snapshotted whole and uncapped.

## Tests

- New:
  - `runtime-units` journal (4): appends only what changed (earlier lines untouched), replays
    the live set, compacts to a bounded size over 500 changes, torn tail vs damage, migration;
  - `peer-session` (1): not accepting → no block, a local cut, nothing recorded, no ban;
  - the daemon integration (1): at `maxPendingPays: 1` the next block is not served, no ban,
    serving resumes after a flush.
- The daemon integration's F12 test runs on the journal (restart recovery).
- Mutation: without the gate, both cap tests fail.
- `npm run ci` green: 162 files passed, 2 skipped; 2604 tests passed, 7 skipped; all gates OK.
