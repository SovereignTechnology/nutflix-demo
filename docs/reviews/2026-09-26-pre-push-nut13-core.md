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
