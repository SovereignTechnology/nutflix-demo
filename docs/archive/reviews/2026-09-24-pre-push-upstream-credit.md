# Pre-push review — upstream credit and batching (2026-09-24)

Diff: `stage-3/dleq-batching` (`6680fe4`) → `stage-3/upstream-credit`. Method: the
`differential-review` checklist and `sharp-edges` questions, inline, by the session that wrote the
change.

## Scope

- HIGH (payment pacing: an error here gets honest viewers banned, or seeders unpaid):
  - `gateway/src/upstream/payer.ts` (batching, pressure, tail timer);
  - `upstream/credit.ts` (moved + pressure);
  - `upstream/settle.ts` (extracted settlement);
  - `gateway.ts` (`readUpstreamBlob`, wiring);
  - `app-desktop/src/worker/pay/viewer-payer.ts` (refactor onto the shared pieces).
- MEDIUM: `gateway/src/config.ts` (`upstream.creditBlocks`).
- LOW: tests, docs.

## Adversarial questions

- **Can batching get an honest viewer banned?**
  - Worst case, a seeder has sent `limit` unpaid blocks: every block needs a unit first, and a
    unit returns only on an ACK or when nothing is owed.
  - With `limit` = the minimum window (4), no seeder ever exceeds its window, whatever the batch
    size.
  - Batching changes WHEN a PAY goes out, never how many blocks travel unpaid.
  - The full-speed swarm test measures the upstream's outstanding count throughout (never above
    the pool, no `window-exceeded`).
- **Can batching stall a download?** It could have — several seeders each holding a short run
  below the batch fill the pool, and nothing pays. Pressure fixes it:
  - an acquire that queues, or a refused `tryAcquire`, triggers "pay everything pending";
  - `payPending` re-reads `pressured` on every run, so blocks that land while the pool is still
    full are paid at once.
  - Tested with an acquirer queued behind a full pool (it gets its unit after the forced PAY's
    ACK).
- **Can a tail stay unpaid (seeders never paid if the app dies)?** It was the case at `flush()`
  only. The tail timer pays short runs after 2 s of quiet per peer (tested with fake timers,
  including the reset).
- **Settlement correctness after the refactor.** `CreditSettler` is `ViewerPayer`'s code moved
  as is (FIFO of sent PAYs, ACK matched by core + range, rejection settles, peer loss settles,
  non-`pay/1` peers and unpaid cores settle at once). The desktop's existing settlement tests
  run unchanged against it.
- **The gateway reader.**
  - A block that turns out local, or comes from a peer without `pay/1`, is settled by the reader
    (`owes` false).
  - A failed or timed-out get settles its unit.
  - Prefetch uses only free units (`tryAcquire`), and its rejections are surfaced when the reader
    reaches the block, never unhandled.
  - An abandoned reader leaves in-flight gets to settle themselves (owed → the ACK; not owed →
    the `finally`).
- **Config.** `upstream.creditBlocks` is bounded [1, 1024]. Setting it above an upstream
  seeder's window re-opens F37 for that seeder; the default is every seeder's minimum, and the
  doc says so.

## Found and fixed before commit

| # | Severity | Finding | Fix |
|---|---|---|---|
| R1 | Medium | With batching, a short final run waited for the session's `flush()`; a crash meanwhile would never pay it (and the desktop's own end-to-end test waits for every block's spend) | The tail timer (2 s of quiet per peer) |
| R2 | Medium | The per-core batch threshold could let a seeder's short runs across several cores add up without a PAY | The batch counts a peer's pending blocks across cores (tested) |
| R3 | Low | The first swarm test run raced the last ACK (credit checked before it arrived) | The test waits for the gateway's credit to drain |

## Residual

- The pool is sized to the minimum window (4); a per-seeder window (HELLO `windowBlocks` × the
  policy's `minPaySats`) would batch more, but needs per-peer accounting instead of one global
  pool.
- DLEQ in the desktop's Bare worker stays inline (ADR 0011 §10).

## Tests

- New:
  - gateway `credit` (pressure, 2);
  - `upstream-payer` tail timer (2);
  - `config` `creditBlocks`;
  - desktop `viewer-payer` batching (3: half-pool batches, pressure pays under a full pool,
    cross-core counting).
- Changed, with reasons:
  - the desktop `viewer-payer` rig uses a pool of 2 (a batch of 1): those tests are about
    settlement, matching and policy;
  - the gateway swarm test reads at full speed through `readUpstreamBlob` instead of pacing by
    hand, samples the upstream's outstanding count, and requires no `window-exceeded`.
- Mutation: an unlimited pool fails the swarm test (the gateway is cut).
- `npm run ci` green: 162 files passed, 2 skipped; 2598 tests passed, 7 skipped; all gates OK. `npm run test:e2e`: 16 passed.
