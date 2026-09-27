# Pre-push review — NUT-13 seed backup, core (2026-09-26)

Diff: `54f49bb` → `stage-3/nut13-core` (lane N1-nut13-core; issue #3, ADR 0016). The branch holds
the vendored specs (`fc324fb`), a first agent's UNREVIEWED partial work (`88fafaf`, "wip", kept as
committed), and this session's review and fixes on top. Method: `differential-review` and
`sharp-edges`, run inline by the session that resumed the lane — for `88fafaf` that is a review by
a different session than the author; for the fixes it is a self-review, so the mutation checks
below are its only independence.

## Scope and risk

- HIGH (derives, holds or moves ecash; the audit surface):
  - `packages/core/src/wallet/seed.ts` (NEW, locked): phrase, seed in secure memory, the durable
    counter source;
  - `packages/core/src/wallet/spend.ts` (locked, +1 200 lines): explicit output types, the
    collision guard, `restoreFromSeed`, `restoreUnpublished`, reissue, `close`;
  - `packages/core/src/wallet/wallet.ts`: `CashuMintConnections({ seed })`, one counter source per
    store, `CashuWallet.seeded`, `restoreUnpublished`, `notePublished`, `close`.
- MEDIUM: `wallet/store.ts` (`ProofStore.unsynced?`, comment), `wallet/index.ts` (exports).
- LOW: `mocks/test-mint.ts`, `mocks/counter-store.ts` (test doubles, never on a production path),
  tests, `seeder/src/runtime/payout.ts` (comment), `docs/vendor/*` (vendored specs).

**Blast radius.** Production constructors of the changed classes: `app-desktop/src/host/money.ts`
(`CashuMintConnections`, `GatedCashuWallet`) and `seeder/src/runtime/index.ts`
(`CashuMintConnections`, `CashuWallet`); 21 test files. Neither passes `seed` yet (N2 will, for the
desktop), so for them the changes that apply UNSEEDED are:

1. every journaled restore now also asks the mint whether the operation ran (NUT-07, or the quote
   state) before committing it — one more request on a rare path; an `unknown` answer keeps the
   entry (availability, not safety);
2. a restored signature for another amount/keyset under one of our outputs, with the inputs
   UNSPENT, now drops the entry and retries once (before: kept "unknown"); with random outputs only
   a lying mint produces that, and dropping a never-executed entry returns its inputs;
3. `Spender.close()`, `idle()`; every operation counts itself while queued or running;
4. `CashuMintConnections` passes `secretsPolicy: 'random'` explicitly (was cashu-ts's `'auto'`
   with no seed: the same outputs).

The existing ADR 0014 suites (journal-retry/-residuals/-review, wallet, settle-loop, nip60-*) pass
unchanged, including the amount-lie test (`journal-residuals.test.ts`: executed + lie → kept).

## Findings in the wip commit (`88fafaf`), fixed in `af7af77` unless noted

- **N1 (HIGH) — a collision at different amounts froze the entry and held the inputs forever.**
  `spend.ts` `restoreOp` threw `bad-mint-response` for any restored signature whose amount or
  keyset differed from our output; `resolveSafe` read that as `unknown`, so the collision branch
  (`ran() === 'no'`) was never reached. A collision means ANOTHER wallet's output at our counter —
  usually another amount. Scenario: two wallets on one phrase; B's send derives its change at
  counter 0 (32 sat) where A had signed 4 sat; the mint answers "already signed"; B's journal entry
  stays unresolved at every settle, B's 64-sat input held out of the balance indefinitely.
  **Fix:** such signatures count as `foreign`; `resolve` asks whether the operation ran: never ran
  → collision (drop, advance, retry once); ran → a lie, entry kept (ADR 0014 behaviour).
  Mutation M15 (the wip's throw restored) fails the collision tests.
- **N2 (HIGH) — the guard trusted the 10002 code; real mints do not send it.** Measured on the
  real-mint lane: Nutshell 0.21.0 answers a colliding mint, swap or melt with 11003 "outputs
  already signed"; cdk-mintd 0.18.1 with 20006 "Invoice already paid or pending" (mint, melt) and
  11008 "Duplicate outputs" (swap). With the wip, cdk's answers were plain refusals: "minting failed
  (MintOperationError 20006)", the entry dropped, and every retry burned the next colliding
  counter. **Fix:** `refused()` — on a coded refusal of a SEEDED operation, ask NUT-09 whether our
  outputs are signed; if so, `resolve` decides (collision or our own earlier attempt). `isOutputSigned`
  also knows 11003. Mutation M16 fails the test that rewrites TestMint's 10002 into cdk's codes; the
  real-mint test passes on both mints.
- **N3 (MEDIUM) — no collision guard without a journal.** A store without `pending` took a 10002
  on seeded outputs as a failure. **Fix:** `collided()` in every non-journaled path (advance,
  retry once). Code-based there (residual 1). M17.
- **N4 (MEDIUM, sharp edge) — a `MintConnections` wrapper that drops `seeding` silently degrades.**
  `CashuWallet` reads `mints.seeding`; the desktop's money plane wraps its connections in
  `{ wallet: … }` (`app-desktop/src/host/money.ts:282`). Once N2 passes `seed`, the wallets would
  derive nothing (spend.ts passes explicit `random`), `seeded` would be absent, and `close()` would
  wipe nothing — no error anywhere. **Fix (`fc7c4de`):** `CashuMintConnections` marks each seeded
  cashu-ts wallet (`markSeeded`); the Spender refuses (`invalid-argument`, "a MintConnections wrapper
  must forward it") to operate on one whose context has no or another seeding. M32. Contract
  request 5 tells N2.
- **N5 (MEDIUM, sharp edge) — two counter sources over one store repeat counters.**
  `CashuMintConnections` built a new `DurableCounterSource` per instance, and the package exported
  the class. Two connections from one `SeedMaterial` (a reconnect) each loaded the same `next` and
  handed out the same counters (the guard would then recover, at a cost of 10002s and retries).
  **Fix (`b2b7195`):** one live source per `CounterStore` object (a closed one replaced by a fresh
  source that starts from disk); the class exported as a type only; `save()` re-reads the store and
  never writes a lower lease (a closed source flushing late). M12, M13.
- **N6 (MEDIUM) — wiped entropy produced a public phrase.** `toSeed`/`toIndices` accepted 16 zero
  bytes — exactly what `wipeEntropy` leaves — whose phrase is "abandon ×11 about": outputs anyone
  can restore. **Fix:** `checkLive` refuses all-zero entropy (`RecoverySeedError('wiped')`). M1.
- **N7 (LOW) — two history lines and "refused" dust at a mint without NUT-12.** `adopt` counted
  DLEQ-carrying proofs as they were and swapped the rest (two transitions), and reported a swap the
  input fee made impossible as `refused`. **Fix:** per mint — NUT-12 advertised: every proof carries
  a checked DLEQ, one transition; otherwise everything unspent is swapped first (one history line),
  dust below the fee is left and reported `nothing`. M26.
- **N8 (LOW, test double) — TestMint paid a melt, then refused its already-signed blanks.** Real
  mints refuse before spending or paying (measured on both); the double hid that path. **Fixed**;
  the real-mint melt test checks the invoice is paid once.
- **N9 (LOW, test double) — `MemoryCounterStore` normalised what it stored**, so a malformed file
  could not be tested (it became valid). **Fixed** (a deep copy of exactly what was written).
- **N10 (LOW) —** the re-check of `closed` after the probe's `await` tripped
  `no-unnecessary-condition`; read through the getter now.
- **N11 (INFO) —** `payout.ts` named NUT-13 as the fix for a lost payout; it recovers the change,
  not the P2PK payout (ADR 0016 related finding 2). Comment corrected (`aaf39b6`).

Checked and found right in the wip: the lease-before-hand-out ordering and serialisation of the
counter source; the probe (per unknown keyset, not only on a missing file — stricter than the ADR's
text, same cost after the first use); the published watermark and its clamping; the guarded output
creator (wiped/foreign seed, 2^31); `restoreBatch`'s checks (our `B_` once, keyset, amount with a
key, DLEQ at NUT-12 mints verified by cashu-ts against the claimed amount); three empty batches;
the 32-keyset/200-batch caps (tighten-only test hook); NUT-07 filtering and dedupe; reissue's plan
binding (exact proofs, fee, single use); `close()` ordering (source closed → locks idle → flush →
wipe); explicit output types in every call that makes outputs.

## Adversarial questions

- **A hostile mint, amounts.** At a NUT-12 mint a signature without a DLEQ refuses the whole answer;
  cashu-ts verifies the DLEQ against the key of the amount the mint CLAIMS, so doubling an amount
  fails (TestMint and both real mints). Without NUT-12, restored proofs are swapped before they
  count: a lied amount does not verify at the mint's own swap (tested). Keys are the mint's own
  (cashu-ts verifies keyset ids against keys on load).
- **A hostile mint, shape.** Outputs we never asked for, one twice, more than asked, another keyset,
  an amount with no key: `RestoreRefused` for the whole mint — nothing from it counts (tested).
- **A hostile mint, amplification.** At most 32 keysets × 200 batches; one signature per batch keeps
  a scan alive, so the worst case is the cap (residual 4); the test hook can only tighten it.
- **A hostile mint making us drop a live entry.** It could answer a fresh operation with a code,
  show "signatures" on our outputs and claim our inputs UNSPENT: we drop the entry and retry; if it
  had in fact spent the inputs, the retry meets "already spent" and reconciles them as lost. That
  is the ADR's accepted "claims spent, refuses restore" — the mint holds the money anyway; nothing
  here lets a mint take what it does not hold.
- **Another wallet on this phrase** (the user restored it elsewhere): collisions are retried once,
  a second in a row is reported; inputs are never dropped while NUT-07 says unspent (tested with
  TestMint and both real mints, including a melt refused before it pays).
- **Counter reuse.** Lease on disk before hand-out; a failed save hands out nothing; a lost file is
  probed; one source per store; a late flush cannot lower a lease; 2^31 never crossed (tested; M6–M13).
- **Seed misuse.** A wiped or foreign seed never reaches a derivation (guarded creator, `seedBytes`);
  `close` wipes only after every lock is idle and the source refuses new reservations — an
  operation reaching for counters after close began fails before anything is sent (tested).
- **Secrets in logs and errors.** `seed.ts` and `spend.ts` never log (`check:locked`); errors carry
  codes and amounts; `RecoveryPhraseError` never quotes a word (asserted for every refusal); cashu-ts
  errors are reduced to class + code (`errorName`). `wallet.ts` logs nothing.
- **Timing.** Seed comparison is `sodium_memcmp`; the all-zero check folds with OR; the typed-word
  lookup is a `Map` (local process only — residual 7).
- **Renderer / worker / IPC.** No IPC or desktop change in this lane (N2).

## Sharp edges (API misuse resistance)

| Edge | Before | Now |
| --- | --- | --- |
| cashu-ts `'auto'` half-switches a seeded wallet | spend.ts passed explicit types; connections left `'auto'` unseeded | explicit `'deterministic'` / `'random'` everywhere, never `'auto'` |
| a wrapper drops `MintConnections.seeding` | silent random outputs, no wipe | refused at the first operation (N4) |
| two `DurableCounterSource`s over one store | possible (class exported, one per connections) | one live source per store object; type-only export (N5) |
| wiped entropy used | public phrase derived | refused (N6) |
| seed wiped under a running operation | guarded creator refused zeros | unchanged, plus close waits (tested) |
| `restoreLimits: { maxBatches: 0 }` or huge | — | only a value in `[1, cap)` tightens; anything else is the cap |
| `lease` option `0` / huge | — | refused (`1..10000`) |
| a corrupt counters file | — | refused, not guessed (fail closed; contract request 3 asks the shell to move it aside and answer `null`) |
| `entropyFromBytes` and the caller's buffer | — | copied; the caller's plaintext left for the caller to zero (documented) |
| a forged/stale reissue plan | — | compared with the wallet's own latest plan, the exact proofs and the fee; single use |
| two `CounterStore` objects over one file, two processes | — | not coordinated by core (residual 2) |

## Mutation checks

Each guard broken alone, the named tests run, the file restored with `git checkout --` (script in
the lane's scratchpad; working tree verified clean afterwards). A mutation counts as caught when
the named tests fail.

| # | Guard broken | File | Caught by | Result |
| --- | --- | --- | --- | --- |
| M1 | wiped (all-zero) entropy accepted | `seed.ts` `checkLive` | seed.test "wipeEntropy zeroes it…" | caught |
| M2 | a typed word not checked against the list | `seed.ts` `fromWords` | seed.test "refusals name the problem" (a bad word reads `checksum`) | caught |
| M3 | a wiped seed lent to cashu-ts | `seed.ts` `seedBytes` | seed.test "…a wiped seed is zero and refused" | caught |
| M4 | foreign seed bytes derived from | `spend.ts` `seedGuardedOutputs` | seed.test "a seed core did not make is refused" | caught |
| M5 | a range running past 2^31 derived | `spend.ts` `seedGuardedOutputs` | seed.test "counters at or past 2^31…" | caught ¹ |
| M6 | counters handed out before the lease is on disk | `seed.ts` `handOut` | seed.test "a failed save hands out nothing" | caught |
| M7 | no lease written at all | `seed.ts` `handOut` | seed.test / nut13-wallet "…restart…" | caught |
| M8 | an unknown keyset derived without a probe | `seed.ts` `usable` | seed.test / nut13-wallet "…probe…" | caught |
| M9 | no probe answer, still derived | `seed.ts` `usable` | seed.test "nobody can answer…" | caught |
| M10 | `reserveAt` below the cursor accepted | `seed.ts` `reserveAt` | seed.test "reserveAt…" | caught |
| M11 | a closed source still reserves | `seed.ts` `usable` | seed.test "closed…" | caught |
| M12 | a late flush moves a stored lease back | `seed.ts` `save` | seed.test "a closed source flushing late…" | caught |
| M13 | a second live counter source per store | `wallet.ts` `counterSourceFor` | nut13-wallet "…share ONE counter source…" | caught |
| M14 | restored signatures committed without NUT-07 proof the operation ran | `spend.ts` `resolve` | nut13-wallet collision guard tests | caught |
| M15 | a foreign signature throws (the wip's behaviour) | `spend.ts` `restoreOp` | nut13-wallet collision guard tests | caught |
| M16 | the mint's code trusted (no NUT-09 check on a refusal) | `spend.ts` `refused` | nut13-wallet "the mint’s code is not trusted…" | caught |
| M17 | no collision guard without a journal | `spend.ts` `collided` | nut13-wallet "without a journal…" | caught |
| M18 | no retry after a collision | `spend.ts` `twice` | nut13-wallet collision guard tests | caught |
| M19 | a restore without DLEQ accepted at a NUT-12 mint | `spend.ts` `restoreBatch` | nut13-restore "a NUT-12 mint must send a DLEQ…" | caught |
| M20 | a restored amount taken without its DLEQ check | `spend.ts` `restoreBatch` | nut13-restore "an amount lie…" | caught |
| M21 | a restore answer naming outputs we never asked for accepted | `spend.ts` `restoreBatch` | nut13-restore "…never asked for, or one twice…" | caught |
| M22 | one empty batch ends the scan | `spend.ts` `scan` | nut13-restore "three empty batches of 100…" | caught |
| M23 | the batch cap not honoured (test hook ignored) | `spend.ts` `limit` | nut13-restore "a hostile mint…held to the batch cap" | caught |
| M24 | NUT-07 ignored (every restored proof read UNSPENT) | `spend.ts` `adopt` | nut13-restore "restores what is unspent…" | caught ² |
| M25 | held proofs added again | `spend.ts` `adopt` | nut13-restore "a second run adds nothing…" | caught |
| M26 | no swap before counting at a mint without NUT-12 | `spend.ts` `adopt` | nut13-restore "…without NUT-12…" | caught |
| M27 | counters advanced for another device's phrase | `spend.ts` `restoreFromSeed` | nut13-restore "…another device’s phrase…" | caught ³ |
| M28 | reissue after the holdings changed | `spend.ts` `reissue` | nut13-restore "refused when the holdings changed…" | caught |
| M29 | reissue where outputs cannot be restored | `spend.ts` `reissue` | nut13-restore "…(no NUT-09)…" | caught |
| M30 | the seed wiped before the running operation finished | `wallet.ts` `close` | nut13-wallet "close waits before it wipes the seed" | caught |
| M31 | `Spender.close` does not wait for the locks | `spend.ts` `close` | nut13-wallet "close waits…" | caught |
| M32 | a wrapper that dropped `seeding` not noticed | `spend.ts` `seededAt` | nut13-wallet "a MintConnections wrapper that drops `seeding`…" | caught |
| M33 | own outputs random when seeded | `spend.ts` `own` | nut13-wallet "output types are explicit per operation" | caught |
| M34 | the watermark moved while an operation is unresolved | `wallet.ts` `notePublished` | nut13-wallet "…watermark…" | caught |
| M35 | a malformed counters file accepted | `seed.ts` `isCounterState` | seed.test "a malformed counters file is refused…" | caught |

¹ First run reported "missed": the `-t` filter contained `^` (a regex anchor), so no test ran;
re-run with a plain filter, caught. ² The first form (`else if (mine === undefined)`) was not a
guard — the SPENT branch is tested first and the UNSPENT test repeats it; the mutation that
removes the filter (NUT-07 ignored) is caught. ³ First run MISSED: the other device's last
signature lay inside this device's lease, so advancing changed nothing observable; the test now
puts the other device at counter 100+ and also checks the cursor (`441d663`), caught.

## Tests and gates

New: `seed.test.ts` (36), `nut13-wallet.test.ts` (26), `nut13-restore.test.ts` (21), the rig's own
check, and the opt-in `nut13-real-mint.integration.test.ts` (5, green on Nutshell 0.21.0 and
cdk-mintd 0.18.1). Whole suite, `tsc -b --force`, eslint/prettier, `check:locked`: see
`docs/lanes/N1-nut13-core.md` §Tests (only the three known R6 failures remain once timing
failures are re-run alone and the build is fresh).

## Residuals

See `docs/lanes/N1-nut13-core.md` §Residuals (11 items): the code-based guard without a journal; one
counters store per identity per process; a malformed counters file fails closed; restore cost and
the mint lock; PENDING proofs left out; linking; unwipeable strings and library intermediates; a
non-NUT-12 mint restoring more than `max_array_length`; legacy base64 keysets; https-only URLs are
the prompt window's; the daemons unseeded.

## Independent review (2026-09-27) and the fixes

An independent session reviewed `54f49bb..c7f81b8` and found 1 high, 2 medium, 1 low and 5 info
items. Every finding was checked first by a test written against the reviewed code:
`wallet/__tests__/nut13-review.test.ts` was run with `c7f81b8`'s five source files swapped in, and
all 18 of its tests failed. The fixed files were then put back and checked by sha256. With the fixes,
all of them pass. None of the findings turned out to be wrong.

### The findings

| # | Sev. | Verdict | Reproduced by (`nut13-review.test.ts` unless named) | Fix |
| --- | --- | --- | --- | --- |
| 1 | high | confirmed | "own phrase restores through its counters file's high-water mark" (on `c7f81b8`: 7 of 15 sat); "startup restore scans all of [published, next), newest first" (`[]`); "a scan the cap stops carries where to resume"; "a capped scan that restored nothing is not `nothing`" | partly in core, rest for Cameron (below) |
| 2 | medium | confirmed | "another mint announcing the same keyset id is never asked" (on `c7f81b8`: `nothing`); "a probe moves the cursor by at most one batch" (200 requests); "a probe counts a signature only when its DLEQ verifies"; "the collision guard skips ahead past verified signatures only" | `spend.ts:400` `own` probes at the operating mint only; `seed.ts:475` `ensureProbed`, capped at `COUNTER_PROBE_SPAN` (`seed.ts:351`); `spend.ts:2193` `signedIndices` counts DLEQ-verified signatures; `spend.ts:2261` `counterProbe` asks one batch |
| 3 | medium | confirmed | "a rotated phrase … starts at its own counter 0" (on `c7f81b8`: leased from 483, restore `nothing`); "after a restart too"; "a counters store a live wallet of another phrase is using is refused" | `seed.ts:318` `counterBinding` (keyed BLAKE2b of the seed, libsodium) stored as a `published` entry `ff…`; `seed.ts:617` `ours`: another phrase's file reads as no state; `seed.ts:705` `save` takes it over, or writes nothing when this source is closed (`:710`); `wallet.ts:87` refuses a live store bound to another phrase |
| 4 | low | confirmed | "an unseeded wallet's lost answer is recovered on its signatures alone" (on `c7f81b8`: `receive failed`) | `store.ts:72` `PendingOp.seeded`; `spend.ts:1539` `mayCollide`: NUT-07 only when the entry is seeded **or the wallet is** (fails closed if a store drops the flag) |
| 5 | info | confirmed | `seed.test` "two sources over one file never hand out the same counter" | `seed.ts:705` `save` moves the cursor past a lease another writer took; `seed.ts:665` `handOut` leases again from there (`reserveAt` refuses) |
| 6 | info | confirmed | "a reconnect over one counters store: the old connection going down cannot block a new keyset" (on `c7f81b8`: `minting failed`) | the probe registry is gone (`wallet.ts` no longer calls `addProbe`) |
| 7 | info | confirmed | "a keyset whose keys cannot be fetched keeps what the others restored" (on `c7f81b8`: `unreachable`, 0) | `spend.ts:1051` per-keyset isolation; a dishonest answer (`RestoreRefused`) still refuses the whole mint |
| 8 | info | confirmed | "a restore and a later settle … write its amount into the history once" (on `c7f81b8` the history summed to 118 against a balance of 59) | `spend.ts:1613` `resolve` leaves out outputs the store already holds; a zero-amount `in` line is not written |
| 9 | info | confirmed | `seed.test` "zeroed entropy is refused before it is written as a relay copy" | `seed.ts:249` `entropyToHex` uses `checkLive` |

**Finding 1: what core fixes, and what it cannot.** The cap stays at 200 batches per keyset per call
(ADR 0016 §5), but it no longer hides lost money:

- **This device's own phrase** (`sameSeed`) is scanned at least to the counters file's `next` for
  each keyset (`spend.ts:1023`, `DurableCounterSource.leases`), whatever the gaps and the cap. Past
  that point the three-empty-batches rule and the cap apply (`spend.ts:1295` `scan`). This is ADR
  0016's first loss case: the relays dropped this device's 7375 events.
- **The startup restore** scans all of `[published, next)`, newest batch first, with no cap
  (`spend.ts:1340` `scanRange`). The range comes from this device's own file, so no mint can stretch
  it.
- **Any other scan the cap stops is reported** (`spend.ts:158` `RestoreDetail.resume`,
  `spend.ts:2078` `incomplete`). The report carries where to resume, and
  `CashuWallet.seeded.restoreFromSeed(…, { resume })` continues from there. `isResume` at
  `spend.ts:1929` validates the cursor. With nothing restored, the outcome is `refused` (only the
  cap stopped it) or `unreachable` (something could not be asked), never `nothing`.

The reviewer's first option was to stop only after N batches that bring back nothing verified and
unspent. It was considered and not taken. An honest long history's early batches are ALL spent, so
that rule stops an honest restore just as early. And a hostile mint can sign anything under its own
keys (DLEQ included) and call it spent or unspent as it likes. From counter 0, the two look the same.

Bounding the scan of a phrase with no known high-water mark (another device's, or this one after
losing its counters file) without cutting off an honest history needs information from outside the
mint. So it is Cameron's decision, set out in `docs/contract-requests/N1-nut13-core.md` item 7: keep
per-call caps with resume, raise the cap, or add checkpoints to the relay copy. The seam part of item
7 asks for a `'partial'` outcome and a `resume` field.

### Found while fixing (this round's own differential-review and sharp-edges pass)

The same method as above, run on the fix diff. Risk: `seed.ts`, `spend.ts` and `wallet.ts` HIGH;
`store.ts` and `index.ts` MEDIUM; tests LOW. Blast radius: the production constructors are
`app-desktop/src/host/money.ts` (unseeded until N2) and `seeder/src/runtime/index.ts` (unseeded,
D6). For both, the only behavioural change this round is finding 4: unseeded journal entries are
resolved as in ADR 0014 again. Everything else applies only to seeded connections.
`isPendingOp` now also refuses a `seeded` that is not `true`. Earlier sealed journals carry no such
field, so they still open.

- **A. A restore of this device's own phrase advanced its counters past UNVERIFIED signatures.**
  Scenario: a mint without NUT-12 announces another mint's keyset id (for example a URL typed into
  the restore window). Its unprovable "signatures" moved that keyset's cursor up to about 20 000
  ahead: the restore analog of finding 2. **Fix:** `spend.ts:1328`: `last` counts DLEQ-verified
  finds only. Test: "a restore of this device's own phrase advances its counters only past
  DLEQ-verified signatures". On the unfixed code the cursor goes past 900 (computed from the test's
  set-up; mutation S1 confirms it breaks the test's bound of 200); with the fix it measured 103.
  Mutation S1.
- **B. The collision guard's skip-ahead trusted a mint without NUT-12 for 200 batches.** **Fix:**
  `spend.ts:1756`: one batch without NUT-12. Test: "the collision guard at a mint without NUT-12
  skips at most one batch". Mutation S2.
- **C. A startup restore that did not finish still let the watermark move.** This was already on the
  branch before this round. `restoreUnpublished` was followed by `notePublished`, which moved
  `published` past the range it had failed to scan, so the next start skipped it. My first fix held
  the watermark GLOBALLY, and the sharp-edges pass caught the footgun in it: a mint that stays down
  would freeze every keyset and make each start rescan growing ranges everywhere. **Fix:** a hold
  per keyset. `wallet.ts:268` `held`: `Spender.restoreUnpublished` reports the keysets whose whole
  range was scanned and adopted, and `markPublished(hold)` (`seed.ts:568`, `hold` required) skips
  the rest. Tests: "the mint was unreachable at startup: operations do not move `published` until a
  restore finishes" and "per keyset: a mint that stays down holds back only its own keysets'
  watermark". Mutations R15, R15b, S5.
- **D. `ensureProbed` held the counter source's serial chain across the network probe**, so a slow
  mint (up to the transport's 30 s) stalled seeded reservations at every mint. **Fix:** the mint is
  asked outside the chain (`seed.ts:475`); the answer is applied in a second serial step, after
  checking again that the source is not closed and the keyset not yet probed. Test (`seed.test`): "a
  slow probe at one mint does not hold up reservations under keysets already known". Mutation S4.
- **E. Sharp edge: `PendingOp.seeded` failed OPEN.** A store that dropped the unknown field would
  have taken a seeded wallet back to "signatures alone", which is the wip's original high finding.
  **Fix:** `mayCollide` (`spend.ts:1539`) is strict when the entry is marked OR the wallet is seeded
  now. Tests: "a seeded wallet fails closed if a store ever drops the flag" and "a seeded entry read
  by an unseeded wallet still waits for NUT-07". Mutations R9d and R9e.
- **F. Sharp edge: `markPublished()` had a default that silently discarded the hold.** `hold` is now
  required. Mutation S5 covers the skip itself.
- **G. A regression caught by an existing test while fixing:** the async `own()` first checked
  `seeding === undefined`, which skipped `seededAt`'s refusal of a wrapper that dropped `seeding`.
  The existing test "a MintConnections wrapper that drops `seeding` is refused loudly" failed. Now
  `seededAt` runs first. Mutation R16.

Adversarial re-check of the new surface:

- **Hostile mint sharing a keyset id.** At a NUT-12 mint it cannot move counters: it cannot sign
  under keys it only copied, and every path counts verified signatures only. Without NUT-12 the
  probe and the guard move at most one batch, and a restore moves nothing.
- **Hostile OPERATING mint (NUT-12).** It can sign our blinded messages on demand, so the guard may
  skip up to 200 batches there. A later restore at the same mint sees those same signatures, unless
  the mint forgets them, and that mint holds the money anyway. Residual.
- **`resume`.** It is host-side only (N2 must keep it out of the renderer) and validated. A bogus
  cursor only skips counters, so a restore from 0 finds them again.
- **Binding tag.** 16 bytes of keyed BLAKE2b of the seed, in a 0600 file. It can confirm a guessed
  phrase, but not against 128 bits of entropy. Nothing logs it.
- **Secrets.** No new log line and no error text carries a word, seed, proof or counter secret.
  `own()` wraps counter errors as `mint-error` plus the class name.

### Mutation checks (final code; script `mutate.py` in the lane scratchpad)

Each guard was broken alone and the named tests were run. The file was then restored from a backup
and checked by sha256. All 30 are caught.

| # | Guard broken | Caught by |
| --- | --- | --- |
| R1 | own-phrase floor ignored (`floors = {}`) | "own phrase restores through…" |
| R2 | the cap ends a scan silently (`break`, no `stopped`) | "a scan the cap stops carries where to resume" |
| R3 | a capped scan that restored nothing reads `nothing` | "…restored nothing is not `nothing`" |
| R4 | startup restore oldest-first with the cap (`scan` instead of `scanRange`) | "startup restore scans all…" |
| R5a | a probe's advance not capped at one batch | `seed.test` "at most one batch" |
| R5b | the probe asks 200 batches | "a probe moves the cursor by at most one batch" |
| R6 | DLEQ not checked when counting signed outputs | "…only when its DLEQ verifies", "…verified signatures only" |
| R7a | another phrase's file read as ours | "rotated phrase…", "after a restart too" |
| R7b | a closed source writes over a file another phrase took over | `seed.test` "…flushing late leaves the file…alone" |
| R8 | a live store of another phrase not refused | "…another phrase is using is refused" |
| R9a | NUT-07 required for every entry | "unseeded wallet's lost answer…" |
| R9b | NUT-07 never required | nut13-wallet collision guard (6 tests) |
| R9c | a coded refusal never checked by NUT-09 | nut13-wallet "the mint's code is not trusted" |
| R9d | the entry's flag ignored (wallet only) | "a seeded entry read by an unseeded wallet…" |
| R9e | the wallet's seeding ignored (flag only) | "…fails closed if a store ever drops the flag" |
| R10 | `isPendingOp` accepts any `seeded` | "`seeded` is `true` or absent" |
| R11 | another writer's lease does not move the cursor | `seed.test` "two sources over one file…" |
| R12 | one failing keyset throws away the mint's restore | "…keys cannot be fetched keeps…" |
| R13 | already-held outputs counted again in the history | "…history once" |
| R14 | `entropyToHex` takes wiped entropy | `seed.test` "…relay copy" |
| R15 | the watermark ignores the hold | "unreachable at startup…", "…holds back only…" |
| R15b | the hold is global (nothing released per keyset) | "…holds back only its own keysets…" |
| R16 | `own()` skips `seededAt` without seeding | nut13-wallet "…drops `seeding`…" |
| R17 | a malformed `resume` accepted | "…restored nothing is not `nothing`" |
| R18 | `reserve` derives under an unprobed keyset | `seed.test` "reserve never asks anyone by itself" |
| S1 | a restore advances past unverified signatures | "…only past DLEQ-verified signatures" |
| S2 | the guard skips 200 batches without NUT-12 | "the collision guard at a mint without NUT-12…" |
| S4 | the probe runs inside the serial chain | `seed.test` "a slow probe…" ¹ |
| S5 | `markPublished` ignores `hold` | `seed.test` "markPublished leaves the keysets…" |

¹ The first form of S4, `this.serial(() => probe(…))`, was reported MISSED. That mutation queued the
probe BEHIND the reservation already waiting, so it did not reproduce the old structure, where the
probe ran in the same serial step as the load. The faithful mutation (probe inside the first serial
step) is caught.

### Tests and gates of this round

- New: `nut13-review.test.ts` (23), 2 real-mint tests, and in `seed.test.ts` the probe tests through
  `ensureProbed`, two writers, the binding (4), a slow probe, the hold, and `entropyToHex`. Three
  expectations changed, each with a comment citing the finding: the registry's two probe tests, a
  first-probe answer 137 → 37, and the hostile-cap test now expecting `resume`.
- Whole suite once (after `npm run build`): 3413 passed; the 3 failures are the known R6 ones.
  `tsc -b --force`, eslint, prettier, `check:locked`: clean. Real mints: `nut13-real-mint` (7) and
  `journal-real-mint` (10) green on Nutshell 0.21.0 and cdk-mintd 0.18.1.

### Residuals after this round (added to the list above)

- **The restore bound for phrases with no known high-water mark.** This covers another device's
  phrase, or this one after losing its counters file. It is 200 batches per keyset per call,
  reported and resumable, until Cameron decides (contract request 7). Until the seam has
  `'partial'`, a capped call that restored nothing reads `refused`.
- **A keyset whose mint is not among the wallet's mints** (its proofs were all lost with the outbox,
  and it is not configured) keeps its startup range unscanned and its watermark held until the mint
  is added. Core cannot tell which mint a keyset belongs to: the seam's `CounterState` has no mint.
- **Finding 8 edge.** If the restored change was spent before the late settle, the settle adds it
  back. A later spend meets "already spent" and reconciles it with a loss line, so it heals itself.
- **Without NUT-12,** a restore of this device's own phrase does not advance its counters, and the
  guard skips one batch per collision. Both real mints advertise NUT-12.
- **Two writers over one counters file.** A read-then-write race in `save` can still lose an update
  (residual 2, narrowed by finding 5's fix). The shell keeps one writer.
- **The counters file carries a 16-byte binding tag** of the seed.
