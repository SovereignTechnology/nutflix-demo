# Lane I4-intfix — integration fix 2: N1's real core in N2's seam

Branch `stage-3/int-fix-2`, off `30e4aea`: the fully merged Stage 3 integration head, with lane N1's
NUT-13 core wired into lane N2's seam at `packages/app-desktop/src/host/recovery/core.ts`
`recoveryCore()`. Date: 2026-09-27.

- Commits: `8479fc9` (the log rule and the two messages), `0d1f830` (the mint-transport pin),
  `e0afbf1` (the desktop on core's real NUT-13 code), then this report and the review record.
- Review record: `docs/reviews/2026-09-27-pre-push-int-fix-2.md`. It has each cause, the
  measurements, the sharp edges, the mutation table and the residuals.
- No contract request.
- Nothing changed under `packages/core/src/contracts/`, the locked paths, `docs/status.md` or
  `docs/security-review.md`. Core is not touched; every change is in `packages/app-desktop/`.
- Nothing outward: no push, MR or issue edit.

## Outcomes

| Item | Outcome |
|---|---|
| `log.test`: two P2 messages swallowed by the phrase rule | **fixed**: the messages reworded (`… is not valid JSON: starting empty`); the rule's 8-word threshold kept |
| `mint-transport` pin: `host/recovery/core.ts` among the hits | **fixed**: the pin parses the source (TypeScript API); a type or a comment is not a construction, an alias now is |
| `money-seed`: fake seeds refused by the real connections | **fixed**: core's real phrases and seeds; the one stand-in left is the lost seed option |
| `recovery-host`: status `unavailable`, nothing reissued | **fixed** at both causes: the fake seed, then the counters file refusing core's phrase binding |
| N2 verifier [low]: JSON `\n` / `\t` / `\r\n` pass the phrase rule | **fixed**: backslash escapes (also `\u`, `\x`, and `%5C` inside a URL) are separator units |
| N2 verifier [info]: lone `%` before hex-letter words | **fixed**: a one- or two-letter remainder after an escape counts as a word |

Found along the way, and fixed:

- **The desktop's counters file refused core's phrase binding.** On the merged build, once a
  device had a phrase, every seeded operation that needed a lease failed before reaching the mint:
  the reissue, a top-up's mint, a send's or PAY's change. `parseCounterState` now admits exactly
  core's entry: one `published` `ff` + 32 hex → 0, with no `next`.
- **`MoneyPlane.open` left the seed to its caller** when the signer or NIP-60 failed. It now wipes
  the seed on any failure.
- **The plane's close left the NUT-13 counter source open.** After a rotation, an operation still
  queued in the old wallet could hand the new phrase's counters file back to the old phrase. The
  source is now closed with the plane.
- **The first draft of the remainder rule dropped numbered words** (`\tag1` read as a key). The
  review caught it: a remainder is always a word.

## How each was decided

- **The rule or the messages.** The threshold is what stops part of a phrase leaking: 8 of 12
  words leave 2^40 candidates. The test's comment already prescribes rewording. Both guarantees
  hold: the rule still redacts 8 words, and the test still fails on any constant message it
  swallows.
- **The pin.** The hit was a comment. Moving the type into money.ts would have kept a text pin
  that misses aliases, so the pin now tells a construction or value use from a type. It still
  catches a second construction site, and now an alias too; the tsc check of the seed key stays.
- **Real code where the plane and the host run; fakes where the plane is a stub.** money-seed and
  recovery-host run core's `recoveryCore()` through a pass-through spy (`support/real-recovery.ts`).
  The service's unit tests keep the fakes, whose scripted plans and failures are the point there.
- **Why the host read `unavailable`.** The reopened plane threw at the connections: core refuses a
  seed it did not make. With real seeds it reached `covered` and then failed every lease. One run
  with core's `dist` instrumented showed `not a counter state (not saved)` from
  `FileCounterStore.save`.
- **Counter source, not `CashuWallet.close()`.** The wallet's close flushes the watermark whenever
  running operations end. That write could land after a quit's disk writes, or race the next
  rotation. The first draft's host test hit exactly that: `ENOTEMPTY`, a write into a deleted
  profile.

## Confirmed with tests

- **`CashuWallet.seeded` reads the seed through the plane's one connections instance.**
  - The spy saw one `seedOption` call, with the plane's material, and `seeded` asked about the
    plane's wallet only.
  - The counters store got a lease.
  - The words alone restore the plane's ecash on another wallet.
  - Four mutations of that wiring fail.
- **A wiped seed is refused at derivation time.** Under an open plane, a mint request and a send's
  change are refused before any request, with the balance intact. Before the mint loaded, the load
  is refused. Handed to `open`, the plane does not open.
- **End to end, in-process** (TestMint at 100 ppk):
  - device A: setup, fee confirm, 1 999 reissued (fee 1), `covered`;
  - device B: the same identity, on a fresh profile whose relays lost the ecash events. B sets up
    its own phrase, then restores `1 999` from A's relay copy.
- **End to end, real mints** (`recovery-real-mint.integration.test.ts`, opt-in): the same two
  devices, the mint's real fee shown and paid, and B spends part of what it restored.
  - Passed on Nutshell 0.21.0 (`:3399`) and cdk-mintd 0.18.1 (`:3397`).
  - On the merged build, with `NUTFLIX_REAL_MINT_URL_2=:3398`, also passed on both mints:
    core's `nut13-real-mint` + `journal-real-mint` (17/17 each), and app-desktop's
    `topup-real-mint`, `desktop-owed.integration` and the new test (6/6 each).

Run it:

```
NUTFLIX_REAL_MINT_URL=http://127.0.0.1:3399 \
  npx vitest run packages/app-desktop/src/host/__tests__/recovery-real-mint.integration.test.ts
```

## The phrase rule, measured

Leaks were counted over 2 000 random phrases, the verifier's method:

- **At the base:** JSON CRLF 2000/2000 (8+ words present), JSON LF 341, TAB 341, `\u000b` 349,
  lone `%` 168.
- **Now:** 0 with even 2 words present, in every form, `%5Cn` included.

A differential run compared both rules on 40 000 generated strings: 22 905 base matches, **no
character the base redacted left unredacted**, and 8 469 strings redacted more widely.

## Gates

- `app-desktop` tests (`--maxWorkers=2`): 107 files, 2 022 passed, 2 skipped (the opt-in
  real-mint files).
- The whole suite, once, after a fresh `npm run build` (`npx vitest run --maxWorkers=2`): 235 files passed, 5 skipped; 3 829 tests passed, 30 skipped; 972.6 s; no timing failure to rerun.
- `npx tsc -b --force`: clean. `npm run build`: clean.
- eslint + `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK. `npm run lint:electron`: OK (263 files, 0 violations).
- Mutation checks: 38 mutations. All are killed except three that are equivalent in output
  (L4, L5, L9: they only keep the parse unique). The table is in the review record.
- No Electron e2e (as briefed).

## Residuals

See the review record's Residuals; in short:

1. The desktop never calls `restoreUnpublished()` (core's contract request 4). A crash-lost range
   comes back only through an explicit restore. Wiring a startup scan of every mint is its own
   decision.
2. The watermark is not flushed at plane close. That matters only once 1 is wired.
3. Core reports a foreign seed as "wiped" (N1's message).
4. The seam's `CounterState` comment does not mention the binding (N1's contract request 7).
5. The phrase rule still misses double-encoded escapes (`%252C`, `%255Cn`), white space over 256,
   keys over 16 letters, and Title Case / UPPER CASE words.
6. The real-mint host test is opt-in; CI stays offline.

## Proposed row for `docs/status.md`

| Integration fix 2 — N1's real NUT-13 core in N2's desktop seam | `stage-3/int-fix-2` | DONE. The five failures of the merge fixed at their causes:<br>• the host and money-plane tests on core's real phrases and seeds (a pass-through spy; fakes kept for the service's stub-plane unit tests);<br>• the desktop counters file admits core's phrase binding (without it every seeded operation failed on the merged build);<br>• the plane closes its NUT-13 counter source and wipes its seed on any failed open;<br>• the mint-transport pin parses the source (a type is not a construction; an alias now is);<br>• two P2 log messages reworded.<br>The phrase log rule takes backslash escapes (`\n` `\t` `\r\n` `\u` `\x`, `%5C`) and remainders after an escape (the verifier's low and info).<br>Setup → reissue → restore from the relay copy on a fresh profile, end to end in-process and against Nutshell and cdk-mintd. Review `docs/reviews/2026-09-27-pre-push-int-fix-2.md` (38 mutation checks) |
