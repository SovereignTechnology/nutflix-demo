# Pre-push review — lane R6-reconcile (`stage-3/int-reconcile`)

Diff `54f49bb..HEAD`: the first agent's unreviewed wip commit `30ce842` (stopped by a usage limit
on 2026-09-26) and the resumed lane's commits on top, `51a2409`, `1ed1cee`, `5014c6f`,
`dadd56f`, `a7828a4`, then this record and the lane report `docs/lanes/R6-reconcile.md`. Method: the
`differential-review` skill (risk triage, removed code with `git blame`, blast radius, test
coverage, an attacker model for the HIGH-risk files) and the `sharp-edges` skill (defaults,
injectable options, silent failures, configuration cliffs, stringly-typed decisions), on every
changed file, the wip commit read as critically as the new work. Date: 2026-09-27.

Contracts, locked paths, `docs/status.md` and `docs/security-review.md` are untouched; no
contract request. Nothing outward (no push, MR, issue edit, relay or bunker contact).

## Triage

| File | Risk | Why |
|---|---|---|
| `packages/gateway/src/upstream/payer.ts` | HIGH | value transfer: when a PAY is asked again, given up (its blocks settled unpaid) or never built; shared by the gateway and the desktop worker |
| `packages/app-desktop/src/worker/pay/viewer-payer.ts` | HIGH | a retry mechanism removed (lane I2's timer) |
| `packages/app-desktop/src/host/topup/auto-topup.ts` | HIGH | money plane: when a kept Lightning quote is released, when a funding melt may start |
| `packages/app-desktop/packaging/fuses.ts` | HIGH | security configuration of the packaged binary |
| `packages/app-desktop/src/host/adapter.ts` | MEDIUM | how long a play waits for a top-up |
| `packages/app-desktop/packaging/stage.ts` | MEDIUM | build integrity (a stale bundle staged) |
| `packages/app-desktop/src/host/{main,host}.ts`, `src/main/main.ts` | LOW | a constant moved; comments |
| tests, ADRs 0012 and 0017 | LOW (test integrity checked) | |

Codebase: large (monorepo). Strategy: FOCUSED — every changed line, and one hop of callers for
the HIGH files.

## Blast radius

- `UpstreamPayer`: two constructions (`gateway/src/gateway.ts`, `worker/pay/viewer-payer.ts`).
  `dispose()` has two callers, `Gateway.close` and `ViewerPayer.close`, both after `flush()` (the
  worker host calls `payer.flush()` then `payer.close()`); the stricter `dispose()` (inert
  afterwards) changes neither. The new `clock` option has no production caller.
- `payFailureClass` / the deferred set: every `engine.pay` failure of both payers. In the gateway
  the engine is its own wallet, whose errors carry no `rate-limited` code (core has none), so
  the gateway's behaviour is round 5's. On the desktop a PAY gets `rate-limited` only from the
  money plane's PAY/melt gate (`pay-melt-gate.ts`: a melt pending or in flight at its mint, or
  the per-PAY belt refusing a PAY that waited too long for its turn); the other `rate-limited`
  answers in the tree (the host's per-window call limit, the worker's inbound RPC limit, the
  signer's prompts) are on other paths.
- `AutoTopUp.checkForPlay`: one caller, `DesktopNetworkAdapter.checkBalance`, changed with it.
  `AutoTopUp` is built once per host (`host.ts`), so `startedAt` is once per run of the host.
- `FUSES`: `fuseConfig` (flip), `fuseMismatches`/`assertAppFuses` (read-back), through
  `forge-config.ts` only.
- `assertCurrentBuild`: `stageApp` (stage, package, make) and the stage tests.

## Removed code

- `viewer-payer.ts`: `retryLater`, `retrySoon`, `retryTimer`, `refusals`, `closed` — blame
  `6fd9525` (lane I2, "a PAY never waits behind a melt at its mint"). Replaced by the payer's
  deferred class. Every behaviour I2's tests protect is still asserted: the 5-minute melt test is
  unchanged but for faking `performance`; the second test is rewritten with a comment citing why;
  a third test covers a refusal after `close()`.
- `payer.ts`: round 5's `Date.now()` reads — blame `74cb163` (fix round 5). Replaced by the
  payer's monotonic clock. No check was removed.
- `auto-topup.ts`: `lapsed && source !== 'PAID'` — blame `5f7a9ad` (round 5). Replaced by a
  stricter condition (the source must answer). Round 5's restart fallback
  `e.at + MELT_REQUEST_TIMEOUT_MS`, replaced by a later bound.
- ADR 0017's separate 2026-09-26 amendment section: folded into the decision summary, §4 and
  open question 8 (answered).

## Findings

Findings on the diff, including the wip commit's, most severe first.

| # | Severity | Where | Finding | Outcome |
|---|---|---|---|---|
| R6-1 | MEDIUM (wip) | `host/adapter.ts:620`, `host/topup/auto-topup.ts:447` | The wip changed `checkForPlay(mint)` to `checkForPlay(mints)` without its caller or its tests. Scenario: `npx tsc -b` failed on the resumed branch (adapter and four test calls); had the old adapter loop been kept by casting, a video at two trusted mints still waited one full `PLAY_TOP_UP_WAIT_MS` per mint — 30 s instead of 15 s, the exact finding the verifier raised | **fixed** `51a2409`: the adapter makes one call for all of the video's mints. Pinned by a whole-host test (a video at two trusted mints, the first mint's run taking 60 % of the bound and ending not due: the play fails `no-balance` within one bound) — mutation MA |
| R6-2 | MEDIUM (wip) | `gateway/src/upstream/payer.ts:419` (`now()`) | The wip's injectable clock was read raw. Scenario: an injected clock that returns NaN makes every `retryAt` NaN, `armRetry` sets a 1 ms timer and `now < retryAt` never holds: a failing PAY is asked again in a tight loop (the new test saw 3 asks inside the first 249 ms, where one belongs). A clock that throws made `payFailed` throw: no streak, no retry timer, and every later pass (a block, the tail, a close drain's 25 ms polls) asked again with no backoff. A clock that runs backwards shortened backoffs. No production caller injects one (the default never returns NaN), so this is a future caller's footgun | **fixed** `1ed1cee`: `now()` takes a reading only when it is a finite number greater than the last; otherwise the last good reading stands (0 before any). A bad clock stands still: nothing is given up, and the retry timers still bring every retry on the backoff — mutation P7 |
| R6-3 | LOW (wip) | `host/topup/auto-topup.ts:578` | The melt's start-by was read after `ledger.reserve` resolved, while a restart counts from the entry's `at`, stamped when `reserve` is called. Scenario: a slow disk write of the reservation (seconds on a loaded laptop) extends the real start-by past `at + TOP_UP_MELT_START_BY_MS` by the write's time, so `TOP_UP_MELT_RETURNED_BY_MS` no longer bounds the melt from `at` | **fixed** `51a2409`: read just before `reserve` is called |
| R6-4 | LOW (test integrity) | `gateway/src/__tests__/upstream-payer.test.ts` (the dispose tests) | Two of the wip's three `dispose()` guards had no test that fails without them: armRetry's (mutation P8 survived: the stray timer woke a disposed payer that then did nothing) and the loop's (P8c: covered by the check at the top of `payPending`) | **fixed** `dadd56f`: the dispose test asserts no timer is left; a new test disposes while a PAY is being built (that PAY still goes out, since its proofs exist; the next core is not built). The top-of-`payPending` check (P8b) remains an equivalent mutant: the loop's check runs before anything is built |
| R6-5 | LOW (test integrity) | `host/__tests__/auto-topup.test.ts`, `topup-host.test.ts` | The play-bound tests' upper margins (1.3 W) left 0.6 s for late timers, and several tests this lane added or changed that run real top-ups sat near the 5 s default: in the mutation runs at load 20-28 on 8 cores, two of them ran past 5 s | **fixed** `dadd56f`: margins 1.45 W (unit, W = 2 s) and 1.4 W (whole host, W = 3 s); a mutation still gives at least 1.6 W because timers are never early. The real top-up tests take the file's 30 s for heavy tests (R5-4 precedent), with the measured 1.1-4.9 s in a note |
| R6-6 | LOW (test integrity, older test) | `host/__tests__/auto-topup.test.ts`, F3 "end to end: a melt that never answered, then a restart" | The whole suite at load ~20 failed it with `'cap'` where `'unresolved'` belongs. Its `waitFor` saw the fourth reservation and restarted the host before the run's seal and `attach` wrote the open top-up, so the restarted ledger held no open record. Not caused by this lane (the assertion is before the one line changed here) but exposed by the suite's load; it passed alone | **fixed** `a7828a4`: it waits for the melt itself to be called (the test's premise: the host died during the melt), with `waitFor` given 10 s |
| R6-7 | INFO (wip) | `docs/decisions/0017-packaging.md` §2 rule 3 | The wip made the freshness rule watch the bundle's configuration, but ADR 0017's rule 3 still listed only sources and the "second, stricter check" line | **fixed** `5014c6f`: rule 3 names the four files and the refusal of a missing one, and says exactly what the `src/` watch adds |

Checked and found right in the wip (kept as it was): the deferred class and its cadence; the
streak kind; the streak cleared on a final code; the retry timer ending due backoffs (the clock
may stand still); `dispose()` making the payer inert; `ViewerPayer`'s timer removed and the
constants re-exported; the lapse release needing an answering source; the tri-state
`meltPending`; the start-by check itself (`!(elapsed <= bound)`, so a NaN refuses); the restart
bound and its `startedAt` term; `QUIT_FLUSH_MS` moved to `host.ts`; the sixth fuse and its
read-back; the bundle configuration watch (lstat, fail closed); the ADR 0017 fold. Their tests
were read against the code, run, and mutated (below).

## Sharp edges checked

- **Injectable clocks** (`UpstreamPayerOptions.clock`, `AutoTopUpOptions.clock`). A caller could
  pass `Date.now` and bring back wall-clock steps; nothing can validate that a function is
  monotonic. The docs say "never the wall clock". The payer drops backward steps and bad readings
  (R6-2); a forward step of an injected wall clock would still count. In `AutoTopUp` a NaN clock
  fails closed: the start-by refuses the melt, and a play's bound is spent at once (the play fails
  `no-balance`, the top-up goes on). Residual RR-6.
- **Bare has no `performance`** (checked with the pinned `bare` binary: `typeof
  globalThis.performance` is `undefined`), so the desktop worker's payer clock is the steady
  fallback: `Date.now()`, never backwards, at most `MAX_CLOCK_STEP_MS` = 8 s per read. During a
  transient streak it is read at least every 4 s, so a give-up takes at least its 30 s of steady
  time; a forward NTP step shorter than 8 s between two reads still counts (residual RR-1).
  `bare-hrtime` (in the tree through `bare-http1`) would give a true monotonic clock but is a
  native addon the worker does not import directly: not added here.
- **Silent failures.** `now()` swallows a throwing clock without a log (deliberate: nothing
  secret, and the effect is fail-safe — nothing is ever given up). `dispose()` makes the payer
  inert, so a `flush()` after it resolves without paying: both callers flush first, and the doc
  comment says so (RR-5). `orNull` around the journal and source reads now keeps their failure
  distinct from an answer (tri-state), where round 5 read a failed source read as "not PAID".
- **Stringly-typed decisions across a process boundary.** The payer decides deferred / final /
  transient by the host's wire error code. Today only the PAY/melt gate answers a PAY with
  `rate-limited`; a future host refusal that reuses the code for something that will never
  clear would never be given up (nothing spent, asks spaced up to 30 s, ended by the session's
  close: RR-3). A new host code meaning "not now" would be transient (given up after 30 s) until
  added to the set. `payFailureClass` is pinned by a test.
- **Defaults.** `PLAY_TOP_UP_WAIT_MS`, `TOP_UP_MELT_START_BY_MS`, `PAY_RETRY_LATER_*` are
  constants, not options; `playWaitMs` (tests only) that is not a number is spent at once (round
  5). `TOP_UP_MELT_RETURNED_BY_MS` is derived from the shared deadlines, pinned by a test.
- **Configuration cliffs.** `FUSES` is pinned as an exact object, so a fuse dropped from it (which
  would also drop it from the read-back) fails a test (mutation F1). `BUNDLE_CONFIG` is pinned
  against the script's `tsconfig:` lines and the `extends` chain both ways, so a tsconfig added
  to the bundle without being watched fails a test. A configuration file that is a symlink is
  refused (lstat): fail closed.

## Attacker model (HIGH files)

- **A seeder (remote peer) against the payer.** It cannot choose a PAY's failure class: codes
  come from the local engine / the host, never from the wire. It can make PAYs impossible (price
  above the manifest, no common mint): those paths are unchanged (no PAY built, counted). Many
  seeders each owed blocks at one mint queue PAYs there; the host's per-PAY belt refuses those
  that waited too long for their turn with `rate-limited`: deferred, nothing spent, each core's
  asks spaced 2-30 s — never a loop, never a PAY sent twice (the replay guard and the
  one-in-flight rule are unchanged). Exploitability of any spend: none found.
- **A failing or malicious mint against the auto top-up.** A source that stops answering after
  taking a melt now keeps the target's quote (it can no longer get it released by going silent
  past the lapse, which round 5 allowed). A source that answers UNPAID or PENDING past the lapse
  gets the quote released: an invoice a day past its expiry cannot be paid, so a later payment
  cannot land (the target's Lightning node refuses an expired invoice); the melt's inputs stay
  counted (`unknown`). A target that keeps saying UNPAID while it was paid needs the source to say
  PAID to keep the quote — unchanged from round 5. A restart cannot shorten the release guard: it
  counts from the later of the bound and the host's start.
- **A slow signer (NIP-46 bunker) before the melt.** A seal that takes more than 5 minutes now
  moves nothing (the entry settles `failed`, the quote is dropped: no melt was sent, so nothing can
  pay it), instead of melting at an unbounded time after the reservation.
- **A local user or wrapper against the packaged binary.** `GrantFileProtocolExtraPrivileges`
  off removes `file://` pages' extra privileges; the app loads none (both windows load `app://`,
  preloads are paths), so nothing it does is lost. A binary that still grants them fails the
  build's read-back.

## Mutation checks

Each mutation applied alone (scripted: exact string replacement, the named tests run, the file
restored from memory, the tree checked clean at the end). The first run used whole test files; on
this shared box (load average 20-28 on 8 cores) several older auto top-up tests timed out at 5 s
there, so the money-plane mutations were run again with a `-t` filter on the describes that pin
them (`lane R6-reconcile|round 5|review F3`), whose baseline passed (39/39). "Killed by" lists the
tests that fail because of the mutation; load timeouts in the same run are not counted. Payer
mutations that the desktop tests import were rebuilt into gateway's `dist/` for the run and
rebuilt back afterwards.

| # | Mutation | Killed by |
|---|---|---|
| P1 | a deferred refusal counts toward the give-up | 4: both I2 viewer-payer tests (the 5-minute melt; the cadence test), the payer's 5-minute `rate-limited`, "a deferred refusal ends a transient streak" |
| P2 | `rate-limited` classified transient (the deferred set empty) | 5: the four above and the classification test |
| P3 | a final give-up keeps the core's streak (round 5) | 1: the verifier's sequence (B's range written off at its first failure) |
| P4 | a streak ignores its kind | 1: "a deferred refusal ends a transient streak" |
| P5 | the give-up reads `Date.now()` | 7, among them "a wall-clock step writes nothing off" |
| P6 | a fired retry timer does not end the backoffs due by then | 5: the clock that stands still, NaN / throws / backwards, "the final code also frees the core's next run" |
| P7 | the clock guard removed (raw readings) | 3: NaN, throws, backwards |
| P8 | `armRetry` ignores `dispose()` | first run: SURVIVED (R6-4); after `dadd56f`: 1 (a timer left after dispose) |
| P8b | `payPending`'s disposed check at its top removed | SURVIVED — equivalent: the loop's check runs before anything is built |
| P8c | the loop's disposed check removed | 1: dispose while a PAY is being built (the next core was built) |
| P9 | a deferred refusal on the transient cadence | 3: both I2 tests' cadence, the payer's 5-minute test ("not the transient cadence") |
| V1 | `ViewerPayer.close()` does not dispose the payer | 2: the I2 cadence test's close, a refusal after close |
| MF | `meltPending`'s failed read taken as "nothing journaled" (`pending !== true`) | 1: the journal that cannot be read |
| MG | the lapse releases on a failed source read (round 5's `source !== 'PAID'`) | 2: "kept past the lapse when the source cannot be read", "past the lapse, a source that cannot be read keeps the quote" |
| ME | the run gets a whole `playWaitMs` of its own (`within(done, waitMs, …)`) | 2: the finishing-and-run test, the two-mint test |
| ME2 | each mint's run starts a fresh bound | 2: the same two |
| ME3 | a first mint's question time not carried to the next mint | 1: "the time a first mint's question was open stays aside" |
| MS | no start-by | 1: 1 ms past it (the melt ran) |
| MS2 | the start-by strict (`<`) | 1: exactly at it (refused) |
| MR | round 5's restart bound (reservation + melt timeout) | 1: the restart test (released at round 5's moment) |
| MR2 | the restart bound without this run's start | 1: a restart long after the reservation (released at once) |
| MA | the adapter asks once per mint (the old loop) | 1: the whole-host two-mint play |
| F1 | the sixth fuse dropped from `FUSES` | 4: the settings pin, the config, the flip + read-back, the read-back refusing a binary with `file://` privileges |
| S1 | the bundle configuration not watched | 5: the four configuration files, the missing-file refusal |
| S3 | a missing configuration file tolerated | 1 |
| S2 | the ui `src/` watch dropped (`bundleInputDirs` keeps only `dist/`) | 1: "watching @sovit/ui's src/ refuses on its own" |
| S4 | `tsconfig.preload.json` dropped from `BUNDLE_CONFIG` | 1: the `BUNDLE_CONFIG` pin in `stage.test.ts` (against the script's `tsconfig:` lines) |
| H1 | the entry exports `QUIT_FLUSH_MS` again | 1: the entry's export pin (`main.test.ts`); the staged bundle's pin is the same property |

28 mutations: 27 killed, 1 equivalent (P8b); P8 survived its first run and was killed after
`dadd56f`.

## Tests added and changed

Added (all run in the whole suite):

- `gateway/src/__tests__/upstream-payer.test.ts`, 12 (14 cases): the classification; a 5-minute
  `rate-limited` never given up and paid once accepted; a deferred refusal ends a transient
  streak; the verifier's sequence; the final code frees the next run; streaks on the injected
  clock with wall steps; a clock that stands still; NaN / throws / backwards (3); `dispose()`
  with a late failure; `dispose()` while a PAY is being built; `monotonicClock` (2).
- `worker/__tests__/viewer-payer.test.ts`, 1: a PAY refused after `close()` arms no retry.
- `host/__tests__/auto-topup.test.ts`, 7 (8 cases): the journal that cannot be read; the source
  that cannot be read past the lapse; one bound across the finishing and the run; across two
  mints; the question's time across mints; the start-by at and past its edge (2); a restart long
  after the reservation. And a third case in round 5's "kept past the lapse" table: the source
  that cannot be read.
- `host/__tests__/topup-host.test.ts`, 1: a whole-host play at two trusted mints waits one bound.
- `host/__tests__/main.test.ts`, 1: the entry exports `runHost` only; `QUIT_FLUSH_MS >
  CLOSE_DRAIN_MS`.
- `packaging/__tests__/fuses.test.ts`, 1: the read-back refuses a binary that still grants
  `file://` its privileges.
- `packaging/__tests__/stage-guards.test.ts`, 3 (6 cases): a bundle older than each configuration
  file (4); a missing / not-regular configuration file; the ui `src/` watch firing on its own.
- `packaging/__tests__/stage.test.ts`, 1: `BUNDLE_CONFIG` pinned against the script and the
  `extends` chain.

Changed, each with a comment citing why (none deleted, none weakened):

- viewer-payer "only rate-limited brings the payer back by itself" → "rate-limited is deferred
  …": round 5 retries every transient failure by itself, so the premise was untrue; everything it
  protected is still asserted, plus the give-up of the transient one. Its sibling (the 5-minute
  melt) only fakes `performance` too.
- auto-topup "after a restart … kept until the reservation plus the melt timeout plus
  TOP_UP_RELEASE_AFTER_MS": still kept at round 5's moment; released at the new bound.
- auto-topup F3 "end to end: a melt that never answered, then a restart": the clock moves to the
  new bound; the outcome asserted is unchanged.
- auto-topup R5-2 "released once the target still says UNPAID a day past its invoice's expiry":
  the source now answers (its payment stuck PENDING) instead of going offline; the offline case
  moved to the "kept past the lapse" table as a third case (stricter). Every other assertion kept.
- auto-topup F3 "end to end" again (`a7828a4`): it also waits for the melt to be in flight (R6-6).
- The lane's tests that run real top-ups got explicit 30 s timeouts (`dadd56f`), with measured
  times in a note (R6-5).
- fuses: "five" → "six" in three titles and the expected settings; the wire diff counts 6.
- forge-config: a title ("six fuses").

## Gates

- **The three known failures of the base now pass**: packaging `stage.test` "host bundle carries
  none of core's test doubles" (the staged host bundle exports `runHost` only), and both
  viewer-payer "I2-paygate" tests.
- `npx tsc -b --force` (at `dadd56f`): clean; `npx tsc -b` at the head: clean.
- `npm run build` before the suite (the stage tests need a current build; `tsc --force` rewrites
  ui's `dist/`).
- **The whole suite**, `npx vitest run --maxWorkers=2` at `dadd56f`, load average 18-24 on 8 cores
  (a shared box): 213 files — 208 passed, 2 failed, 3 skipped; 3355 tests — 3331 passed, 3
  failed, 21 skipped; 842.65 s. The failures: `money.test.ts` "only for a registered session…"
  and "the belt: a PAY that waited…" (timeouts at 5 s, the same two round 5 recorded under load;
  both pass alone, 2/2), and auto-topup F3 "end to end" (a race in the test, R6-6: passes alone;
  fixed in `a7828a4` and passes alone after). No timeout was raised for a failure of the suite
  run; the explicit 30 s on this lane's heavy top-up tests came from the mutation runs (R6-5).
- **Touched packages' tests** (in the suite; also alone): `upstream-payer.test.ts`,
  `viewer-payer.test.ts`, `auto-topup.test.ts`, `topup-host.test.ts`, `main.test.ts`, the
  packaging tests (`fuses`, `forge-config`, `stage`, `stage-guards`) — all pass.
- **Across process and network boundaries**: `topup-host.test.ts` (the whole host over IPC, a
  real money plane, main answering prompts), `desktop-pays.integration.test.ts` (in the suite:
  host + worker over a local hyperdht testnet, real pays). **Real mints**, opt-in:
  `topup-real-mint.integration.test.ts` and gateway `real-mint-swarm.integration.test.ts`, with
  `NUTFLIX_REAL_MINT_URL=http://127.0.0.1:3399` (Nutshell) `NUTFLIX_REAL_MINT_URL_2=
  http://127.0.0.1:3398`: 5/5; with `NUTFLIX_REAL_MINT_URL=http://127.0.0.1:3397` (cdk-mintd) and
  `_URL_2` :3398: 5/5.
- `eslint` and `prettier --check` on every changed `.ts` and `.md` file: clean.
- `npm run check:locked`: OK. `npm run lint:electron`: OK (237 files, 3 window constructors, 0
  violations). `npm run check:native`: not run — no dependency changed.
- The Electron e2e was not run (lane rule).

## Residuals

- **RR-1: Bare's steady clock.** The desktop worker has no `performance`; a forward wall-clock
  step shorter than 8 s between two reads still counts toward a transient give-up, and a longer
  one counts 8 s. A suspend never writes a failure off early.
- **RR-2: a source gone for good holds its target back again** (R5-R1 grows back its "source
  gone" case): past the lapse only an answering source releases a kept quote. Fail-safe; no
  in-app clear; manual top-ups unaffected.
- **RR-3: `rate-limited` is never given up.** Today only the PAY/melt gate answers a PAY with it
  (a melt at the mint, up to 300 s; or the per-PAY belt). A refusal that never clears keeps the
  blocks owed for as long as the session is up: nothing is spent, the asks are spaced up to
  30 s, and the session's close ends them (its drain settles what is still owed as unpaid).
- **RR-4: a release after a restart waits `TOP_UP_RELEASE_AFTER_MS` (10 min) of host uptime.** A
  host that never stays up that long never releases a kept quote (fail-safe). The bound still
  relies on "a melt request never outlives the process that sent it": a request that reaches the
  mint more than 10 minutes after that process died could still pay a released quote (R4-R2, as
  before).
- **RR-5: `UpstreamPayer.dispose()` is final.** A caller that disposes before flushing loses the
  tail without a word; both callers flush first.
- **RR-6: an injected wall clock** would bring back forward steps (the payer drops backward ones).
  No production caller injects a clock.
- **RR-7: the timing tests use real timers** (W = 2 s / 3 s) with margins of 0.9 s / 1.2 s for
  late timers; a box loaded beyond that can fail them (a mutation cannot pass them: it gives at
  least 1.6 W).
- **RR-8: the fuse was not seen on a real packaged binary here** (no `npm run package`, no
  Electron e2e: lane rule); the flip and read-back run for real on a synthetic binary.
