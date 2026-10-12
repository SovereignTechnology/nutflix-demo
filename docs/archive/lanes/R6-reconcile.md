# Lane R6-reconcile — reconcile and small fixes on the integration base

Branch `stage-3/int-reconcile`, off `54f49bb` (the base for the next fan-out). Dates: 2026-09-26
(the first agent, stopped by a usage limit) and 2026-09-27 (resumed). Commits:

- `30ce842` wip(R6-reconcile): the first agent's partial work, committed as it was left
  (unreviewed). Read critically on resume: kept, with the fixes below.
- `51a2409` fix(money): the adapter and tests for the one-bound play, the start-by read before
  the reservation, the truthful restart bound, and the auto top-up tests.
- `1ed1cee` fix(p2p): the payer's clock is never read backwards, as NaN or through a throw.
- `5014c6f` docs(adr): ADR 0012 addendum, ADR 0017 §2 rule 3.
- `dadd56f` test: the `dispose()` guards pinned (from the mutation checks), timing margins for a
  loaded box, explicit 30 s on this lane's real top-up tests (measured times in a note).
- `a7828a4` test(money): F3's end to end waits for the melt in flight (a race the whole suite
  exposed at load ~20).
- then this report and the review record `docs/reviews/2026-09-26-pre-push-int-reconcile.md`
  (findings with file:line and scenario, sharp edges, the attacker model, 28 mutation checks).
- `522edd0` test(money), fix round 7: the start-by pinned to the reservation's stamp (R6-3 had
  no test; the verifier's mutant passed every host test). Then the review record's "Round 7"
  section and this report's updates.

No contract request: nothing needed from `packages/core/src/contracts/`. Nothing changed under
the contracts, the locked paths, `docs/status.md` or `docs/security-review.md`. Nothing outward:
no push, MR, issue edit, relay or bunker contact.

## What and why

### 1. The three failing tests on the base

- **packaging `stage.test` "host bundle carries none of core's test doubles"** pins the staged
  host bundle's exports to exactly `runHost`. The quit flush had added `QUIT_FLUSH_MS` as a second
  export of the entry module. It moved to `src/host/host.ts` (where `Host.shutdown` lives); the
  entry imports it. The pin was not widened. A new unit test pins the source entry the same way
  (`Object.keys(entry)` is `['runHost']`), so the property no longer needs a staged build to be
  checked, and pins `QUIT_FLUSH_MS > CLOSE_DRAIN_MS`.
- **the two viewer-payer "I2-paygate" tests.** Lane I2 gave `ViewerPayer` its own retry timer
  for the host's `rate-limited:` (2 s doubling to 30 s). Fix round 5 then gave the shared
  `UpstreamPayer` a per-core failure streak with its own timer, a give-up after
  `MAX_PAY_FAILURES` over `PAY_GIVE_UP_MS` (30 s), and a `flush()` that respects the backoff. So
  I2's timer brought no retry (the backoff held its flush back), and a melt of up to 300 s was
  written off after 30 s. Reconciled into ONE mechanism in `UpstreamPayer`:
  - `payFailureClass(code)`: `session-closed` and `forbidden` are **final** (the range is given
    up at once); `rate-limited` is **deferred**; everything else is **transient**.
  - A deferred refusal is retried on its own cadence (`PAY_RETRY_LATER_MS` = 2 s doubling to
    `PAY_RETRY_LATER_MAX_MS` = 30 s, the constants moved from `viewer-payer.ts`, re-exported
    there), by the payer's retry timer or any later pass, and never counts toward giving up.
  - A streak has one kind: a failure of the other kind starts a new streak (a deferred refusal
    ends a transient streak; its time does not count).
  - Transient failures behave as in round 5.
  - `ViewerPayer`'s timer, its `retryLater`/`retrySoon` and its `closed` flag are gone.
    `ViewerPayer.close()` cancels the payer's retries through `UpstreamPayer.dispose()`, which now
    also makes the payer inert: no PAY is built after it, and a PAY that fails after it arms no
    retry.
  - I2's second test ("only rate-limited brings the payer back by itself") had a premise round 5
    made untrue: round 5 retries every transient failure by itself. It is rewritten with a
    comment and keeps what it protected: the first ask after `rate-limited` waits exactly
    `PAY_RETRY_LATER_MS`, the asks are spaced (never a loop), nothing reaches the seeder, the owed
    block stays owed, and `close()` cancels. It now also pins that the transient one is given up
    after `PAY_GIVE_UP_MS` and the deferred one is not. I2's first test (a 5-minute melt, then
    the PAY goes through by itself) is unchanged but for faking `performance` beside the timers.
    A third test: a PAY refused after `close()` arms no retry.

### 2. Payer items from the round-5 verifier

- **A final give-up ends the core's streak.** A range given up with `session-closed` or
  `forbidden` deletes the core's failure streak, so a later transient failure (another play
  session's blocks of the same core) starts a fresh streak. The reviewer's sequence is a test:
  session A's range fails transiently for 8 s, A closes (given up, final), 40 s later session B's
  range fails once, transiently: B's range is NOT written off, and is paid when the failure
  clears. On the base it was written off at that first failure (n ≥ 3, its streak about 50 s old).
- **A monotonic, injectable clock.** Streaks, backoffs and the give-up read `clock` (default
  `monotonicClock()`: `performance.now()` where the runtime has it). The desktop worker runs on
  Bare, which has no `performance` (checked with the pinned `bare` binary: `typeof
  globalThis.performance` is `undefined`), so there the default is `Date.now()` made steady: never
  backwards, at most `MAX_CLOCK_STEP_MS` (8 s) per read. A retry timer that fires makes the
  backoffs due by then retryable whatever the clock reads. Resumed work added a guard: a reading
  that is not a finite number, goes back, or throws counts as the last good one. Before it, a
  clock returning NaN made every backoff NaN and armed 1 ms timers: a failing PAY was asked again
  in a tight loop (the new test saw 3 asks in the first 249 ms).

### 3. Packaging

- **`GrantFileProtocolExtraPrivileges` off** (Cameron, 2026-09-26): `packaging/fuses.ts` holds six
  settings, flipped in `packageAfterCopy` and read back from every packaged binary; a binary
  that still grants `file://` its privileges fails the build. The app loads no `file://` page
  (both windows load `app://…`; the preloads are paths). ADR 0017's 2026-09-26 amendment is folded
  into the decision summary, §4 and open question 8 (answered); the separate amendment section is
  gone. `EnableCookieEncryption` keeps its default: the decision named only the `file:` fuse.
- **The freshness rule watches the bundle's own configuration**: `scripts/bundle.ts`,
  `tsconfig.renderer.json`, `tsconfig.preload.json` (package-relative, `BUNDLE_CONFIG`) and
  `tsconfig.base.json` (repo-relative, `BUNDLE_CONFIG_ROOT`). A bundle output older than any of
  them is refused; a configuration file that is missing or not a regular file is refused (the
  rule could not be checked). A test pins the list against the script (every `tsconfig:` it
  names) and the `extends` chain of those tsconfigs, both ways.
- **"src/ stays as a second check"**: stated exactly and tested. A real edit in `@sovit/ui`'s
  `src/` is refused first by rule 1 (tsc would rebuild) or rule 2 (a stylesheet older than its
  source), so the `src/` watch refuses the same stale build a second time. On its own it fires
  only for a `src/` file touched without a content change, or one that is neither a tsc input nor
  a stylesheet: false alarms, cleared by `npm run build`. The test touches a ui source (tsc's dry
  run calls it current) and sees the stage refuse, then accept once the bundle is newer.

### 4. The money plane (`host/topup/auto-topup.ts`)

- **A failed source read after the lapse keeps the quote.** Past the lapse, a kept quote is
  released only when the source mint ANSWERS short of PAID (UNPAID, or its payment stuck
  PENDING). Round 5 also released when the source could not be read at all; a read that failed
  says nothing, and the melt may have paid. A source gone for good therefore holds its target
  back again (residual R5-R1).
- **`meltPending` is three states.** Only an answered "nothing journaled" lets a quote go; a
  journal read that fails keeps it (pinned: mutation MF).
- **The restart bound covers the seal and the gate wait.** Round 5 counted the reservation plus
  `MELT_REQUEST_TIMEOUT_MS`; the seal (through the signer, possibly a bunker asking its user) and
  the PAY/melt gate's wait come between the reservation and the melt request. Now:
  - a melt starts within `TOP_UP_MELT_START_BY_MS` = 5 min of its reservation, or never (the
    entry settles `failed`, nothing moved, a log line with no mint or quote). The start-by is read
    as the ledger stamps the entry, not after the write (resumed work; pinned since round 7 by a
    reservation whose write takes 1 ms: mutation MS3);
  - after a restart the guard counts from the later of the reservation plus
    `TOP_UP_MELT_RETURNED_BY_MS` (the start-by, 5 min, + the gate's wait,
    `WORKER_HOST_REQUEST_TIMEOUT_MS`, 5 min, + the melt request, `MELT_REQUEST_TIMEOUT_MS`, 5 min:
    15 min) and this run of the host's start. What
    is still outside the bound (core's own turn at the source, its round trips before the
    request) has no fixed bound; the host's start covers it because a melt request never outlives
    the process that sent it (the startup settle only reads a journaled melt) and a host starts
    only after the previous one exited (main respawns it on exit only, under the single-instance
    lock). All of this is stated in the code and ADR 0012.
- **One bound for the whole play.** `checkForPlay` takes all of a video's mints, and the adapter
  calls it once: `PLAY_TOP_UP_WAIT_MS` (15 s) covers the open top-ups' finishing and every mint's
  run together, the questions' time aside across mints. The wip had changed the signature but not
  the adapter or the tests (tsc failed on the resume); fixed. The play's bound, the question's
  time and the start-by read a monotonic `clock` (default `performance.now()`), the ledger, the
  release guard and an invoice's expiry stay on the wall clock they are compared with.

## Files

- `packages/gateway/src/upstream/payer.ts`: failure classes, deferred cadence, streak kind,
  streak cleared on final, monotonic clock and its guard, `dispose()` inert.
- `packages/app-desktop/src/worker/pay/viewer-payer.ts`: its own retry timer removed; constants
  re-exported.
- `packages/app-desktop/src/host/topup/auto-topup.ts`, `src/host/adapter.ts`: item 4.
- `packages/app-desktop/src/host/{main,host}.ts`, `src/main/main.ts` (comment): item 1a.
- `packages/app-desktop/packaging/{fuses,stage}.ts`: item 3.
- Tests: `gateway/src/__tests__/upstream-payer.test.ts`, `worker/__tests__/viewer-payer.test.ts`,
  `host/__tests__/{auto-topup,topup-host,main}.test.ts`,
  `packaging/__tests__/{fuses,forge-config,stage,stage-guards}.test.ts`.
- `docs/decisions/0012-desktop-money-plane.md` (addendum 2026-09-27),
  `docs/decisions/0017-packaging.md` (§2 rule 3, §4, open question 8).

## Tests

New: 27 test declarations (34 cases) across eight files, and a third case in round 5's "kept
past the lapse" table — the review record lists each. In short:

- payer (`upstream-payer.test.ts`, 12 / 14 cases): the classification; a 5-minute
  `rate-limited` never given up and paid once accepted; a deferred refusal ends a transient
  streak; the verifier's sequence; a final code frees the next run; the injected clock with wall
  steps; a clock that stands still; NaN / throws / backwards; `dispose()` with a late failure (no
  timer left); `dispose()` while a PAY is being built; `monotonicClock` with and without
  `performance`.
- viewer payer (`viewer-payer.test.ts`, 1): a PAY refused after `close()` arms no retry.
- auto top-up (`auto-topup.test.ts`, 7 / 8 cases, and the table's third case): the journal that
  cannot be read; the source that cannot be read past the lapse; one bound across the finishing
  and the run, across two mints, and the question's time across mints; the start-by at and past
  its edge, and past it by a reservation's 1 ms write (round 7); a restart long after the
  reservation.
- whole host (`topup-host.test.ts`, 1): a play at two trusted mints waits one bound in all.
- host entry (`main.test.ts`, 1): exports `runHost` only; `QUIT_FLUSH_MS > CLOSE_DRAIN_MS`.
- packaging (`fuses`, `stage-guards`, `stage`: 5 / 8 cases): the read-back refuses a binary with
  `file://` privileges; a bundle older than each configuration file; a missing or non-regular
  configuration file; the ui `src/` watch firing on its own; `BUNDLE_CONFIG` pinned both ways.

Changed with comments citing why (none deleted or weakened): I2's second viewer-payer test (its
premise); the round-5 restart test (the new bound; still kept at round 5's moment); F3's end to end
(the clock moves to the new bound; waits for the melt in flight); the round-5 lapse release (the
source answers; the offline source moved to the "kept" table); the fuse tests (six).

Removed from the base's failing list: packaging `stage.test` "host bundle carries none of core's
test doubles" and both viewer-payer "I2-paygate" tests now pass.

## Gates

Full detail in the review record. At the head: `npx tsc -b --force` clean (at `dadd56f`, and
`tsc -b` at the head); the whole suite `npx vitest run --maxWorkers=2` at load 18-24 on 8 cores:
3331 passed, 3 failed, 21 skipped — two `money.test.ts` 5 s timeouts (known under load; pass
alone) and F3's end-to-end race (passes alone; fixed in `a7828a4`); the touched packages' tests
pass; real mints (Nutshell :3399 → :3398 and cdk-mintd :3397 → :3398):
`topup-real-mint.integration` and gateway `real-mint-swarm.integration` 5/5 each; `eslint` and
`prettier --check` on every changed file clean; `check:locked` OK; `lint:electron` OK (237 files, 0
violations); `check:native` not needed (no dependency changed). No Electron e2e (lane rule).

## Mutation checks

29 mutations, each applied alone and restored (scripted, tree checked clean): 28 killed, 1
equivalent (P8b: the check at the top of `payPending` is covered by the loop's). P8 (`armRetry`
ignoring `dispose()`) survived its first run and is killed since `dadd56f`. Highlights: a
deferred refusal counting toward the give-up (P1) or classified transient (P2); the streak kept
after a final code (P3, the verifier's sequence); `Date.now()` for the give-up (P5); the clock
guard removed (P7); `ViewerPayer.close()` not disposing (V1); the verifier's **ME** (a phase or a
mint with a bound of its own: ME, ME2, and ME3 for the question's time across mints) and **MF**
(`meltPending`'s failed read taken as "nothing journaled"); the lapse releasing on a failed source
read (MG); no start-by, a strict one, or one read after the reservation's write (MS, MS2, MS3,
the last from fix round 7); round 5's restart bound or no host start (MR,
MR2); the adapter's per-mint loop (MA); the sixth fuse dropped (F1); the bundle configuration or
ui `src/` not watched (S1-S4); `QUIT_FLUSH_MS` exported from the entry (H1). The verifier's own
ME and MF definitions are not in the repo; these are this lane's, named after them and stated
exactly in the table.

## Fix round 7

The lane's independent verifier found that R6-3 (the melt's start-by read before
`ledger.reserve`, not after its write) was recorded as fixed with nothing to pin it. With the
read moved back after the write, every host test still passed. `522edd0` adds a third case to the
start-by table:
- the reservation's write takes 1 ms on the monotonic clock, and the seal takes exactly
  `TOP_UP_MELT_START_BY_MS`;
- counted from the stamp, that is 1 ms past the start-by, so nothing melts;
- the mutant (the read after the write) lets it melt and fails the case (MS3).

Gates, with detail in the review record's "Round 7":
- `tsc -b --force` clean.
- `app-desktop` tests pass. Its only failures in the loaded run were the stale build after
  `--force` (they pass after `npm run build`) and a 5 s timeout in an untouched auto top-up test
  (the file passes alone, 96/96).
- The whole suite: 3334 passed, 1 failed, 21 skipped. The failure is a `seeder` router test
  that also fails alone about half the time. The lane's diff does not touch seeder, core or any
  dependency, and seeder is outside this lane's allowlist, so it is reported, not fixed.
- `eslint`/`prettier` clean, `check:locked` OK, `lint:electron` OK.

## Residuals

- **RR-1** Bare has no `performance`: the worker's payer clock is `Date.now()` made steady (8 s
  per read at most). A forward step shorter than 8 s still counts toward a transient give-up.
- **RR-2** A source gone for good holds its target back again (R5-R1): past the lapse only an
  answering source releases a kept quote. Fail-safe; no in-app clear; manual top-ups unaffected.
- **RR-3** `rate-limited` is never given up; today only the PAY/melt gate answers a PAY with it.
  Nothing is spent; asks spaced up to 30 s; the session's close ends them.
- **RR-4** After a restart a release waits 10 minutes of host uptime; the bound still relies on a
  melt request never outliving the process that sent it (R4-R2, as before).
- **RR-5** `UpstreamPayer.dispose()` is final: flush first (both callers do).
- **RR-6** An injected wall clock would bring forward steps back (no production caller injects one).
- **RR-7** The play-bound tests use real timers with 0.9 s / 1.2 s margins for late timers.
- **RR-8** The sixth fuse was flipped and read back on a synthetic binary only (no `npm run
  package`, no e2e here).

## Proposed `docs/status.md` row

| Reconcile and small fixes on the integration base (lane R6-reconcile: the three base failures, the round-5 verifier's payer and money-plane items, the sixth fuse) | `stage-3/int-reconcile` (on `54f49bb`) | **done** — The staged host bundle exports `runHost` only again (`QUIT_FLUSH_MS` moved to `host.ts`). One retry mechanism for a refused PAY: `UpstreamPayer` classifies failures as final (`session-closed`, `forbidden`: given up, the core's streak ended), deferred (`rate-limited`: 2 s doubling to 30 s, never given up — a melt may take 300 s) or transient (round 5); `ViewerPayer`'s own timer is gone and `close()` cancels the payer's. The payer's time is monotonic and injectable (`performance.now()`, a steady `Date.now()` on Bare), and a bad clock stands still. Auto top-up: one 15 s bound for the whole play, every mint included (the adapter asked once per mint); a kept quote goes only on answers (a failed journal or source read keeps it; past the lapse the source must answer); a melt starts within 5 min of its reservation or never, and after a restart the release guard counts from the later of reservation + 15 min and the host's start. Packaging: `GrantFileProtocolExtraPrivileges` off and read back (ADR 0017 §4); the freshness rule watches `scripts/bundle.ts` and its tsconfigs. 35 new test cases, 29 mutations (28 killed, 1 equivalent). Open: a source gone for good holds its target back again (R5-R1); `rate-limited` is never given up; Bare's clock is a steady wall clock (RR-1) |

## Proposed `docs/security-review.md` text

Under the desktop money plane (ADR 0012) and the upstream payer:

> **Lane R6-reconcile (2026-09-27, the verifier of fix round 5).** A PAY the host refuses "for
> now" (`rate-limited`: a melt at its mint, or the per-PAY belt) is retried by the shared
> `UpstreamPayer` on its own cadence (2 s doubling to 30 s) and never given up; every other
> failure keeps round 5's time-bounded give-up, and a range given up for good ends its core's
> streak. The worker's own retry timer (lane I2) is gone: it was held back by round 5's backoff,
> and round 5's give-up would have written a 300 s melt off after 30 s. The payer measures time on
> a monotonic clock, so a wall-clock step does not write a failure off early (on Bare, which has no
> `performance`, `Date.now()` made steady: a forward step counts at most 8 s), and a bad clock
> reading stands still instead of looping. In the auto top-up, a kept Lightning quote
> is released only on answers: a journal or source read that fails keeps it, including past the
> invoice's lapse (a source gone for good therefore holds its target back, fail-safe). A funding
> melt starts within 5 minutes of its reservation or not at all, so after a restart the release
> guard can count from the later of the reservation plus 15 minutes (start-by, the PAY/melt gate's
> wait, the melt request) and the host's own start. A play at zero balance waits 15 s in all,
> every mint included.

Under the packaging (F21, ADR 0017):

> **Six fuses** (Cameron, 2026-09-26): `GrantFileProtocolExtraPrivileges` is off as well, and the
> build's read-back refuses a binary that still grants `file://` pages their extra privileges. The
> app loads no `file://` page. The stage's freshness rule also watches the renderer bundle's own
> configuration (`scripts/bundle.ts`, its two tsconfigs and `tsconfig.base.json`).
