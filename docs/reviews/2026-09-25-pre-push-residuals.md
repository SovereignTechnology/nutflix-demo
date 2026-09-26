# Pre-push review: issue #8 residuals (2026-09-25)

Diff: `c08c99f` (contracts v6) → `stage-3/residuals`. Method: `differential-review` and
`sharp-edges`, inline, plus a mutation pass over every guard added. Issue #8 covers (a) a
durable desktop journal, (b) journaled melt change, (c) held inputs out of the balance, and
(d) DLEQ off the Bare worker's event loop. The credit pool is another lane's. ADR 0014 has
an amendment for (a) to (c).

## Scope and risk

- HIGH (value transfer, crypto at rest, a thread that could abort the worker):
  - `core/src/wallet/spend.ts` (locked audit surface). Changes:
    - the melt path is journaled (`prepareMelt` / `completeMelt`);
    - `resolveMelt` (NUT-07 for a melt with no signatures);
    - `restoreOp` takes the mint's amount for melt blanks only;
    - melt selection skips held inputs;
    - a second melt of an unresolved quote is refused.
    `npm run check:locked`: OK. No new import, nothing logs.
  - `core/src/wallet/nip60-journal.ts` (new): the sealed journal. A random key wrapped with
    NIP-44 to self through the signer, then XChaCha20-Poly1305 (sodium) with the header as
    associated data. Strict parse, refuse-and-keep.
  - `core/src/wallet/nip60.ts`:
    - the journal port;
    - the outbox made durable and compacted;
    - transitions serialised (`apply`) and written before they become live;
    - `proofs()` deduplicated by secret.
  - `app-desktop/src/host/wallet-journal.ts` (new), `host/money.ts`, `host/host.ts`: the file
    (0600 in 0700, the signer key file's rules), the money plane over it, the startup settle.
  - `app-desktop/src/worker/pay/dleq-thread.ts` and `dleq-thread-entry.mts` (new),
    `worker/adapters/bare.ts`, `worker/pay/real-providers.ts`: DLEQ on a `Bare.Thread`.
- MEDIUM:
  - `core/src/wallet/wallet.ts`: the balance excludes held inputs; failed operations emit a
    balance event;
  - `core/src/wallet/store.ts`: the `melt` kind, `isPendingOp` shared with the daemon,
    `heldSecrets`;
  - `seeder/src/runtime/proof-file.ts`: uses core's validator, so it reads melt entries;
  - `host/signer/desktop-signer.ts`, `host/wallet.ts`: the loud failure.
- LOW:
  - `host/signer/private-file.ts` (an error label);
  - `worker/runtime.ts`, `worker/providers.ts`, `worker/host.ts` (seams);
  - tests and docs.

Blast radius: `CashuWallet.balance` has every wallet user as a caller: desktop, daemon payout,
melt CLI, gateway. Only the melt path of `Spender` changed behaviour. Send, receive and mint
keep their paths, apart from the shared `heldSecrets`. `Nip60ProofStore` has one caller
(`MoneyPlane`). `FileProofStore` gains a kind it reads.

## Adversarial questions

- **Is the write-ahead real?** `begin` goes through `apply`, which awaits `journal.save` before
  the entry becomes live. `SealedJournal.save` awaits `writePrivateFile`: a temp file opened `wx`
  0600, fsync, rename, directory fsync. `spend.ts` sends the request only after `commit(begin)`
  resolves. Proven with a SIGKILL in the window: the child's swap or melt reaches the mint, the
  mint executes it, the parent kills the child before any answer, and a new process recovers it.
  Mutation M1 (journal-only commits not written) fails that test and two unit tests.
- **Result and settle atomic on a relay-backed store?** The new token event (unpublished) and the
  removal of the entry go in one `save`. The outbox is part of the sealed state. A crash after it
  replays the unpublished events at load; it never replays an entry whose proofs were committed
  (and maybe spent since).
- **What does a thief of the disk get?** A ciphertext under a random key that only the user's
  signer can unwrap (NIP-44 to self), the same protection as the NIP-60 proofs on the relays.
  Tested: no secret, blinding factor, spent proof or retry key appears in the file.
- **A damaged or planted file?** Every failure refuses the open (`journal-unreadable`) and writes
  nothing:
  - not JSON, a wrong format or version, extra fields, another identity;
  - a key that will not unwrap, a tampered body, nonce or truncation;
  - the same key under another wrap (the associated data);
  - a malformed or duplicate entry, a forged, foreign or wrong-kind outbox event;
  - more than 32 MiB;
  - a symlink, another user's file, one others can read.
  The wallet stays closed, the host logs an error, and the unavailable wallet names the journal.
  Proven across a process boundary: byte for byte kept, then the original bytes recovered.
- **A forged outbox event resurrecting proofs?** Outbox events are signature-verified, must be by
  us, and of kind 7375, 5 or 7376. They sit inside the AEAD, so forging one needs the journal key.
- **A signer swap racing a write?** `MoneyPlane.close` wipes the journal key, and `save` then
  refuses before writing. Writes to one path are serialised across instances, and an open waits
  for the last one. A payment on a closed plane is refused before its request (tested: no swap
  reaches the mint).
- **Held inputs double-spent or lost?** They are out of every selection (send and melt) and out
  of the balance. They leave exactly once when the mint executed the operation, and come back
  (spendable) when it did not. Tested both outcomes on the test mint and on Nutshell and cdk: the
  inputs are spent once at the mint, and what the wallet holds afterwards is unspent.
- **Melt change: a mint lying about amounts?** Only melt blanks take the mint's amount, and the
  DLEQ against the key for that amount checks it where the mint supports NUT-12. Every other kind
  still requires the journaled amount. Tested with a mint that advertises no NUT-12 and doubles
  the restored amounts: refused, nothing inflated. Mutation M8 fails it.
- **DLEQ thread: can a failure turn into acceptance?** No path does:
  - the worker trusts only a RES answer of the right length, and anything else fails the job;
  - `dleqVerifier` then checks inline, two proofs per turn, with core's `proofDleqOk`;
  - a check that throws is a failure, on the thread and inline;
  - `PaymentEngineDeps.dleq` never rejects for a thread failure, so the engine's synchronous
    fallback does not stall the loop.
  A forged DLEQ still bans the peer through the wiring (tested with a real PAY from a real viewer
  wallet).
- **Can the thread take the worker down?** An exception escaping a `Bare.Thread` aborts the
  process. Verified on Bare 1.31, and it was the first finding here. So the entry imports nothing
  statically, answers FAIL through the mailbox when it cannot load, and is only started from a
  file that exists. Mutation M20 (no existence check) aborts Bare in the test. The second
  finding: a `.js` entry is parsed as CommonJS in a thread, and tsc's `export {}` there is a
  SyntaxError that aborts the worker. Hence `.mts`, built to `.mjs`.

## Findings (all fixed before this report)

1. **[Medium, fixed] The first PAY after launch waited for the DLEQ thread to start.**
   Scenario: `dleqVerifier.verify` awaited `DleqThread.verify`, which awaited the start. The
   start took about 150 to 350 ms on this laptop, and up to `DLEQ_THREAD_START_MS` (15 s) on a
   slow disk or a thread that never starts. The seller's ACK waited as long, and the viewer
   could time out. Fix (`worker/pay/dleq-thread.ts` `tryVerify`): verification never waits.
   Until the thread is up, the checks run on the chunked path, and that PAY begins the start.
   Test: "never waits for a start" (under 4 s against a 5 s start); mutation M26 fails it.
2. **[Low, fixed] A signer that was not there read as a damaged journal.** Scenario: a NIP-46
   bunker that times out on the unwrap made `SealedJournal.open` throw `journal-unreadable`. The
   UI then said the journal was unreadable when the signer was only away. Fix
   (`core/src/wallet/nip60-journal.ts` `signerUnavailable`): `remote-signer:`, `no-signer:`,
   `signer-locked:` and `cancelled:` errors go up unchanged. Any other refusal to unwrap is still
   the journal's. The wallet stays closed either way. Test and mutations M24 and M25.
3. **[Low, fixed] A journal file that is not private was reported as a generic refusal.**
   Scenario: a 0644 or symlinked journal made the file layer throw `forbidden: journal-<pubkey>…
   is readable by other users`. That message names the file, and so the pubkey. It was not logged
   (only code prefixes are), but the UI said "no wallet". Fix (`host/wallet-journal.ts`): refused
   as `journal-unreadable` with a reason that names no path. Tests updated; mutation M13.
4. **[Low, fixed; sharp edge] The durable journal was optional by omission.**
   `MoneyPlaneOptions.journalDir?` meant a caller that forgot it got a memory-only journal
   silently. Fix: `journalDir: string | null` is required, and the tests pass `null`. The host
   test "createHost with a damaged journal" pins that production passes it; mutation M27 fails it.
5. **[Low, fixed; sharp edge] `chunkedDleq(…, NaN)` checked nothing.** With a NaN chunk size, the
   `slice` was empty and the answer had the wrong length. The engine then fell back to its
   synchronous pass: no acceptance, but the stall this lane removes. Fix: a chunk that is not a
   positive integer means the default. Test with 0, −1, NaN and 1.5; mutation M28.

What the mutation pass found untested, now pinned (commit `5d87ce8`): a melt selecting a pending
send's inputs (M7); restore amounts for non-melt outputs where no DLEQ stands in (M8); the header
bound to the body (M5 survived until a re-wrap test was added); a throwing check on the thread
(M19b survived until the THROWING entry was added); a Bare thread that cannot load answering FAIL
quickly rather than by timeout (M22 survived until the timing assertion was added).

## Mutation checks

Each guard was broken, the named tests run, and the guard restored. The source was restored from
a copy, and the dist rebuilt where the test reads `dist/`.

| # | Guard broken | Result |
|---|---|---|
| M1 | journal-only commits not written (write-ahead) | 2 unit tests fail, and all 3 crash-injection tests fail |
| M2 | memory updated before the journal write | "a journal write that fails … changes nothing" fails |
| M3 | an AEAD failure read as an empty journal | "damaged or foreign file is refused" fails |
| M4 | malformed entries accepted | "a body this build cannot read exactly …" fails |
| M5 | associated data made constant | survived; re-wrap case added, then fails |
| M6 | balance ignores the journal | 11 tests fail (issue #8 c, the melt tests, the updated F31 tests) |
| M7 | melt ignores held inputs | "a melt cannot select the inputs an unresolved send holds" fails |
| M8 | restore amounts relaxed for every kind | "a restore that names other amounts … is refused" fails |
| M9 | second melt of an unresolved quote allowed | "the journal entry is written BEFORE the melt request …" fails |
| M10 | a PENDING melt drops its entry | "a melt the mint reports PENDING keeps its blanks journaled …" fails |
| M11 | PENDING inputs settle after the wait | "inputs PENDING at the mint keep the entry …" fails |
| M12 | a refused melt keeps its entry | "a melt the mint refuses … drops its entry at once" fails |
| M13 | the journal read without the private-file checks | "refuses a symlinked or readable-by-others journal" fails |
| M14 | the pubkey check on the journal path removed | "… a non-pubkey name is refused" fails |
| M15 | a closed journal still saves | "a closed journal refuses to save" fails |
| M16 | the unavailable wallet never names the journal | SwitchingWallet test fails; `createHost` variant (M16b) fails |
| M17 | thread failure answers all-true | 6 `dleqVerifier` tests fail |
| M18 | a wrong-count answer accepted | "a thread that answers the wrong count" fails |
| M19 | inline: a throwing check passes | chunked test fails |
| M19b | thread: a throwing check passes | survived; THROWING entry added, then fails |
| M20 | the thread started from a missing entry file | Bare aborts (`exited (null)`), the Bare test fails |
| M21 | a journal failure logged as info, not error | desktop-signer test fails |
| M22 | the thread entry rethrows instead of answering FAIL | survived (the outer `.catch` saves it, a 5 s timeout later); timing assertion added, then fails |
| M23 | no melt `begin` | 6 melt tests fail |
| M24 | a signer-unavailable error mapped to `journal-unreadable` | the signer-away test fails |
| M25 | every unwrap error treated as signer-unavailable | 2 tests fail |
| M26 | verification waits for the thread start | "never waits for a start" fails (5.2 s) |
| M27 | the host does not pass `journalDir` | the `createHost` damaged-journal test fails |
| M28 | the NaN chunk size guard removed | chunked test fails |

## Measurements

- DLEQ, one maximal PAY (2 × 64 = 128 proofs, one in eight forged), under the real Bare 1.31
  (bare-sidecar prebuilt), this 8-core laptop shared with other lanes:

  | Path | Max event-loop stall | Total |
  |---|---|---|
  | Inline (the engine before) | 593 ms (1231 ms under heavier load) | 593 ms |
  | `Bare.Thread` | 2 ms (5 ms) | 563 ms, after a one-time start of 156 ms (348 ms) |
  | Chunked fallback (two proofs a turn) | 10 ms (38 ms) | 579 ms |

  Same verdicts on every path. `NUTFLIX_DLEQ_MEASURE=<file>` makes the test write its numbers.
- Journal: about 8 ms per durable save (one pending send, ZFS), 11 ms with three unpublished
  events; 44 ms for the first open (key wrap). Up to three saves per desktop operation.

## Residuals

- [Low] A result commit whose journal write fails after the mint executed. The entry stays on
  disk, and the keep outputs come back at the next settle. A send's locked outputs reach nobody:
  the payment is lost to the payer, as it always was when a commit failed.
- [Low] Melt blanks at a mint without NUT-12 take the mint's amount on trust. A lying mint could
  hand us a proof it will not honour, which is no worse than a mint refusing its own proofs.
- [Low] A melt whose connection failed holds its inputs, and a retry of the same quote is refused,
  until the mint shows its fate or `PENDING_SETTLE_AFTER_S` (10 min) passes. This is the rule
  sends already had. A mint that strips DLEQ from restored change leaves the entry, and the held
  inputs, until it answers honestly.
- [Low] The journal key passes through the signer's NIP-44 as a hex string, which cannot be wiped
  (the NIP-60 wallet key's limit). The plaintext journal is a JS string while it is sealed.
- [Low] Journals are per identity and never deleted, since they may hold money. An identity's
  pending entries settle only when it is unlocked again.
- [Info] One DLEQ thread: PAYs from different peers queue on it. It keeps the loop free, not the
  throughput up. A packaging step must ship `dist/worker/pay/dleq-thread-entry.mjs` next to the
  worker. Without it the checks run chunked, bounded but on the loop.
- [Info] `bare-dleq-thread.test.ts` reads the built `dist/` (skipped when it is not built, like
  the daemon's DLEQ pool test). CI builds first; a stale `dist/` tests the older build.

## Independent review (2026-09-25)

An independent reviewer examined the lane at `c1cf406` and returned **fix-first**: two medium
findings (both liveness; neither loses or double-spends money), two low and two info. Each was
checked against the code first; all six hold. Fixes are on `stage-3/residuals`, `7e6f6c4` to
`914a44e`.

| # | Finding | Outcome |
|---|---|---|
| 1 | [Medium] Held inputs never come back by themselves on the desktop | **fixed** (`7e6f6c4`) |
| 2 | [Medium] `DleqThread.retire()` can block the Bare worker's loop for ever | **fixed** (`a32b2ec`, `d2e18ce`) |
| 3 | [Low] Outbox compaction can publish a deletion before the token that carries its proofs | **fixed** (`4c2c219`) |
| 4 | [Low] A refusal cashu-ts wraps (`StaleKeysetError`, 429) read as ambiguous | **fixed** (`4c2c219`) |
| 5 | [Info] A retry of a melt recovered earlier says "melt failed"; recovered lookup not kind-checked | **fixed** (`4c2c219`) |
| 6 | [Info] The journal grows without bound during a long relay outage | **deferred** (documented; info) |

### 1. Held inputs never came back by themselves — fixed

Verified: `recoverPending` ran once at open (and only when the journal had entries), and a
settle otherwise ran only inside an operation at that mint. `adapter.checkBalance` reads only
`wallet.balance()`, so with the whole balance held no operation could start, and nothing
settled the entry before a restart. The lane's tests called `recoverPending()` by hand, which
hid it. Reproduced with the new host test before the fix: balance 0 after an hour of reads.

Fix:

- `core/src/wallet/wallet.ts` `CashuWallet.settleSchedule()`: reads the journal only (`count`,
  `next` = the earliest `created + PENDING_SETTLE_AFTER_S` still in the future, `overdue`).
- `core/src/wallet/settle-loop.ts` (new) `SettleLoop`:
  - runs `recoverPending` at an entry's wait plus 5 s;
  - retries overdue entries (a melt still PENDING, a mint that could not be asked) after 30 s,
    doubling while settles decide nothing, up to 600 s; back to 30 s once one does;
  - plans again on every balance event, but only ever earlier, so a stream of PAYs cannot
    postpone a settle;
  - one settle at a time; `stop()` cancels; the default timer is unref'd; nothing logs; a clock
    that is not a number plans nothing.
- `app-desktop/src/host/money.ts`: the money plane starts the loop after the startup settle and
  stops it in `close()`. `onSettled` logs counts only.

Tests: `settle-loop.test.ts` (10: planning, no postponement by events for a wait or a retry,
backoff and reset, one at a time, stop, a future stamp, a NaN clock, store and settle errors;
the real wallet with only `balance()` read gets a refused send's input back, spendable once, and
the change event carries it). Host (`wallet-journal.test.ts`, +2): the money plane over the
sealed journal, an hour of balance reads, then the planned settle returns 16 sat; `close()`
cancels the planned settle. Real mints (opt-in, +1): the input comes back by the mint's own
NUT-07 answer on Nutshell 0.21.0 and cdk-mintd 0.18.1.

The daemon has the same shape (a payout send's held inputs), but it settles at every receive,
which every flush runs; see the residuals.

### 2. `retire()` could hang the Bare worker — fixed

Verified under the real Bare 1.31 (bare-sidecar prebuilt), with standalone programs:
`terminate()` returned at once but interrupted neither a busy thread (the following `join()`
returned only when its 3 s loop ended) nor one parked in `Atomics.wait` (`join()` never
returned; the process had to be killed). `Bare.exit` also hangs while a thread is parked, and
`terminate()` does stop a thread idle in its own event loop, cleanly. The thread stored RES
(after a job) and IDLE (after its boot) with plain stores over a QUIT the worker had set, then
parked for good. So a job timeout (30 s) or a slow start (15 s) blocked the worker's loop for
ever.

Fix (`worker/pay/dleq-thread.ts`, `dleq-thread-entry.mts`):

- the thread moves the state word only by `Atomics.compareExchange` from the state it expects
  (BOOT → IDLE, REQ → RES/FAIL), so a QUIT is never overwritten; it returns on QUIT, and sets a
  new `exited` control word on every way out (a `finally`; the entry's FAIL path too, FAIL only
  over BOOT);
- `retire()` sets QUIT and reaps in the background: `join()` only once `exited` is set (then it
  is immediate), otherwise a non-blocking `terminate()` after `reapMs` (60 s) and the handle is
  let go unjoined; `close()` resolves once every retired thread is reaped and never blocks.

Tests: Node stand-ins (+4): a job past `jobMs` (the thread keeps QUIT, leaves after its job, is
joined only then); a start past `startMs` (QUIT, not IDLE; joined); a thread that never says it
leaves (let go, never joined); `serveDleqMailbox` with QUIT before boot returns at once. The
real Bare runtime (`bare-dleq-thread.test.ts`): both cases given up on with the loop turning,
each thread joined, the broken entry joined too, and `Bare.exit` returns (a parked thread would
hold it). Existing tests now `await close()` and give stand-in threads a short `reapMs`, with a
comment citing this finding.

Measured on the final build (128-proof PAY, load 1.6):

| Path | Max stall | Total |
|---|---|---|
| Inline | 548 ms | 548 ms |
| Thread | 3 ms | 542 ms (start 143 ms) |
| Chunked | 11 ms | 575 ms |
| Retire: job past `jobMs` (2 s of thread work) | 16 ms | 2020 ms |
| Retire: start past `startMs` (2 s) | 16 ms | 2021 ms |

Before the fix the two retire rows do not finish: the loop stops.

### 3. Compaction order — fixed

Verified: commit B spends from published T1 (`[T2, K5(T1), H]`); commit C spends from
unpublished T2, and T2 was filtered out with T3 appended: `[K5(T1), H, T3, K5(T2), H]`. A drain
that published K5(T1) and then failed on T3 left the relays with T1 deleted and no token holding
its unspent proofs. Fix (`core/src/wallet/nip60.ts` `compactOutbox`): the new token takes the
first replaced token's place, ahead of every deletion it covers. Tests (+2): a relay that refuses
token events after the outage publishes no deletion ahead of the token (a fresh load still sees
`secret-1`), then the exact state once it takes everything; `compactOutbox` order cases.

### 4. Wrapped refusals — fixed

Verified in cashu-ts 4.10.0: `withStaleKeysetRepair` rethrows a 12xxx `MintOperationError` as a
`StaleKeysetError` with the code only in `.cause`, around swap, mint and melt; a 429 is a
`RateLimitError` (an `HttpResponseError`, no `code`). Both went to the ambiguous path: inputs
held, and for a melt the quote locked locally for 10 min. Fix (`spend.ts`, locked;
`check:locked` OK, the imports are cashu-ts's): `isDefinitive` accepts exactly these two
wrappers. **Not** any coded `cause`: cashu-ts's `MeltChangeError` means the melt went through,
and its `cause` can carry a code (a keyset fetch the mint refused); dropping that entry would
lose the change. Tests (+5): a melt refused 12001 drops its entry at once and the quote is
payable; a 429 likewise; a send refused 12002 holds nothing; a `MeltChangeError` with a coded
cause still restores the change by NUT-09; a lost answer stays ambiguous. The same rule also
stops a receive or top-up retry from reusing outputs on a stale keyset for 10 min.

### 5. A melt recovered earlier — fixed

Verified: a lost melt answer recovered by the startup `recoverPending`, then a retry of the same
quote: the settle found nothing, a fresh entry was journaled, the mint refused ("quote already
paid"), and the user saw "melt failed" for a paid invoice (no double payment: the mint enforces
that). Fix (`spend.ts`): a quote the mint reports PAID answers `paid: true` (its preimage,
change 0; the change is already in the wallet and the history has its line) without a request.
Recovered entries are keyed by kind, so a recovered top-up whose quote id a malicious mint
reused never answers a melt. Tests (+2, and +1 opt-in real-mint): the retry after a restart
answers paid with no second request; a top-up recovered in the melt's own settle does not pass
for the melt, which runs and reports its own change. The existing refused-melt test used a
second melt of a paid quote to get a refusal; it now makes the mint refuse by sending no inputs
(11002), with a comment citing this finding, and also checks the quote is payable right after.

### 6. Journal growth during a relay outage — deferred (info)

Holds: only superseded token events are compacted, so each operation adds a deletion and a
history event (about 3 KB once sealed and hex-encoded) and every save rewrites the whole file;
at `MAX_JOURNAL_BYTES` (32 MiB, about 10,000 operations) commits fail closed until the relays
take the events. Deferred: it is a performance cliff after a long outage, not a loss, and it
fails closed. Coalescing needs re-signed deletions or dropping history lines, a design change of
its own. Documented in `nip60.ts`'s header and the residuals.

### Self-review of the fix diff (`differential-review`, `sharp-edges`)

Risk: HIGH for `spend.ts` (locked; value transfer: which failures drop an entry) and the thread
protocol; MEDIUM for `SettleLoop` and the money plane; LOW for tests and docs. Blast radius:
`isDefinitive` decides for send, receive, mint and melt; `CashuWallet.settleSchedule` and
`SettleLoop` have one production caller (`MoneyPlane`); `compactOutbox` one (`apply`).

Adversarial questions:

- **A mint answering 429 or 12xxx after executing?** It loses the change, as it already could
  with any coded error (the existing rule for coded answers). NUT-07 reconcile still removes only
  proofs the mint reports SPENT. See the residuals.
- **A mint answering PAID for a quote it never paid?** The wallet sends nothing and says paid;
  the same mint could take the proofs and say PAID. No new capability.
- **A mint that never answers restores?** The loop retries at most every 10 min: bounded load.
- **Many PAYs while a retry is planned?** Never postponed (only ever earlier; tested for waits
  and retries).

Findings, fixed in `914a44e`:

- S1 [Low] After a job timeout, the next PAY started a new thread while the retired one still
  computed. On a starved CPU each would slow the next job past its timeout too, and they would
  pile up. Fix: `tryVerify` starts no thread while a retired one is still leaving (the chunked
  path answers). Mutation R19.
- S2 [Low, sharp edge] `startMs` / `jobMs` / `reapMs` of NaN waited for ever (`waitAsync` reads
  NaN as +∞); `dataBytes` of NaN made a zero-byte mailbox. Fix: `timeoutOption` (finite, ≥ 0,
  else the default); `dataBytes` a positive integer, else the default. Mutations R20, R22.
- S3 [Low, sharp edge] A `SettleLoop` clock that is not a number planned a settle for "now"
  again and again. Fix: no plan. Mutation R21.
- The mutation pass found the "only ever earlier" guard unpinned for overdue retries (R2
  survived): a test with PAYs every 10 s against a 30 s retry now pins it.

### Mutation checks (this round)

Each guard broken, the named tests run, the guard restored with `git checkout`, and `dist/`
rebuilt where the test reads it (runner in the lane's scratch directory).

| # | Guard broken | Result |
|---|---|---|
| R1 | the money plane never starts the settle loop | 2 host tests fail |
| R2 | a change event may postpone the plan | survived; retry test added, then fails |
| R3 | `settleSchedule` does not count overdue entries | `settleSchedule` test fails |
| R4 | progress does not reset the retry | backoff test fails |
| R5 | `stop()` leaves the timer planned | "one settle at a time; stop cancels" fails |
| R6 | `close()` does not stop the loop | 2 host tests fail |
| R7 | thread BOOT → IDLE by plain store | Node slow-start test fails ("condition not met"); the whole run hangs on the parked thread |
| R8 | thread REQ → RES by plain store | Node mid-job test and the Bare test fail |
| R9 | join without waiting for `exited` | 9 tests fail |
| R10 | `retire()` joins synchronously (the old code) | the Bare test fails (the loop stalls behind the join) |
| R11 | `exited` never set | 9 tests fail |
| R12 | the entry's FAIL path does not set `exited` | the Bare test fails (broken entry let go, not joined) |
| R13 | `compactOutbox` appends the new token | 2 tests fail |
| R14 | `StaleKeysetError` not a refusal | 2 tests fail |
| R15 | 429 not a refusal | the 429 test fails |
| R16 | any coded `cause` is a refusal | the `MeltChangeError` test fails (change lost) |
| R17 | no PAID short-circuit | the retry-after-restart test fails |
| R18 | recovered entries not keyed by kind | the malicious-ids test fails |
| R19 | a new thread starts beside a retired one | the no-pile-up test fails |
| R20 | `timeoutOption` accepts any number | its test fails |
| R21 | a NaN clock plans a settle | its test fails |
| R22 | `dataBytes` not validated | the options test fails |

### Checks run

- `npx vitest run --maxWorkers=2` (at `914a44e`): 179 files passed, 3 skipped (opt-in); 2790
  tests passed, 15 skipped; 167 s.
- Real mints, `NUTFLIX_REAL_MINT_URL` set, `NUTFLIX_REAL_MINT_URL_2` = Nutshell 3398: core's
  two real-mint files 12/12 and the gateway's real-mint swarm 3/3, on Nutshell 0.21.0 (3399) and
  on cdk-mintd 0.18.1 (3397).
- `npx tsc -b --force`: clean. `npx eslint` and `npx prettier --check` on every changed file:
  clean. `npm run check:locked`: OK. `npm run lint:electron`: OK. No dependency changed.

### Residuals after this round

- [Low] A mint (or a proxy in front of it) that executes a request and then answers 429 or a
  keyset code loses that operation's outputs, like any coded answer after executing. Both are
  refusals before processing by design (a rate limiter, and the keyset check, run before the
  request is executed); an honest mint does not answer either after executing.
- [Low] The daemon has no settle loop: a payout send whose answer is unknown holds its inputs
  until the next receive at that mint (every flush that redeems runs one) or a restart. A node
  that stops earning keeps them held, not lost.
- [Low] A retired DLEQ thread that never says it is leaving is let go after 60 s, unjoined. Ours
  always says so after its job; a thread stuck for ever in its own code would also keep
  `Bare.exit` from returning (a Bare limit, not this code's).
- [Info] Finding 6: the journal's growth during a long relay outage, deferred as above.
- [Info] A second melt of a quote whose first is still unresolved locally is refused ("still
  unresolved at the mint") even when the mint already reports it PAID; the loop settles it within
  the wait and the retry then answers paid.

## Fix round 2 (2026-09-25)

An independent verifier checked the fix pass (`7e6f6c4` to `c8ce8c2`). It found one high
regression, caused by the finding-4 fix, and two low findings. All three were checked against the
code and hold. All three are fixed on `stage-3/residuals`, `68440fe` to `15c3ea2`, then the docs.

| # | Finding | Outcome |
|---|---|---|
| HIGH | A 429 read as a refusal loses the outputs when a retrying transport meets it after the first attempt executed. The desktop used cashu-ts's retrying fetch transport. | **fixed**: `68440fe` (429 ambiguous), `88a6476` and `7609e1f` (single-attempt transport), `15c3ea2` (doc) |
| LOW 1 | Jobs queued through `verify()` start DLEQ threads beside one that is still leaving | **fixed**: `694046a` |
| LOW 2 | The settle loop's backoff never grows for a mint the wallet cannot load | **fixed**: `8af6d3a` |

### HIGH: a 429 after a retry is not a refusal — fixed

What was checked, in cashu-ts 4.10.0:

- `Mint` uses `customRequest ?? <default>`. The default wraps every request in a retry loop.
  The loop runs when the endpoint is one of the mint's NUT-19 `cached_endpoints` and a ttl is set.
  It retries a `NetworkError` or a 5xx up to 9 times within the ttl. The delay is jittered, capped
  at min(2^n × 100 ms, 1 s).
- `requestWithAuth` spreads the mint's NUT-19 parameters into every request.
- cdk-mintd 0.18.1 (3397) advertises ttl 60, with swap, mint and melt cached. Nutshell 0.21.0
  (3399) advertises no NUT-19.
- `MoneyPlane` passed no request function, and `createHost` never passes one in production, so
  the desktop used that transport.

The verifier's run was reproduced two ways. In process, with a TestMint advertising NUT-19 behind
a stubbed `fetch`. On cdk-mintd, with the 429 rule put back (M2): `mint-error: P2PK swap failed
(RateLimitError)`, the entry dropped, the balance 0.

The same retry also breaks the rule for coded answers, not only the 429. Take a mint whose NUT-19
cache misses (for example, more than one instance). The retry of a swap that executed is then
answered 11001 ("already spent"), which also reads as a refusal. So the transport sending each
request once is what makes the coded rule true at all.

Fix, part 1: the desktop money plane sends each request once.

- `host/mint-transport.ts` (new): `hostMintRequest()` is core's `cashuRequestFn` over
  `node:http(s)`. `MoneyPlane` uses it for every mint. It also uses it for any mint that an
  injected (test) `mintRequest` answers `undefined` for. `createNodeRuntime` does the same for the
  daemons.
- The raw HTTP is reused, not copied. `httpModuleRawHttp` moved from the seeder's `mint-http.ts`
  into `core/src/wallet/http-module.ts`. The caller hands in the modules, so core still has no
  `node:` import. The seeder binds it with its `createRequire`-loaded modules (F16), and the host
  binds it with its own.
- Why not import `nodeMintRequest` from `@sovit/seeder`? The seeder's Node entry would load into
  the process that spends. Measured: +175 ms, and five native addons (rocksdb-native,
  fs-native-extensions, simdle-native, quickbit-native, udx-native).

What the default transport gave, and what the new one keeps (checked in the cashu-ts source):

| | cashu-ts fetch transport (before) | host transport (now) |
|---|---|---|
| Attempts | up to 10 per request at a NUT-19 mint | 1 |
| Timeout | none of its own (undici's 300 s header and body timeouts) | 30 s for the whole exchange, or cashu-ts's `requestTimeout` |
| Redirects | followed (refused only with auth headers) | never followed: a 3xx is an `HttpResponseError` |
| Response size | unbounded | 4 MiB |
| Schemes | whatever `fetch` takes (http, https, data, blob) | http and https only |
| Errors | `MintOperationError` / `RateLimitError` / `HttpResponseError` / `NetworkError` | the same classes (`cashuRequestFn`'s contract) |
| Headers | `Accept: application/json, text/plain, */*`, `User-Agent: Mozilla/5.0` | `Accept: application/json`, no User-Agent |
| Cookies, cache, referrer | none (`credentials: omit`, `no-store`, `no-referrer`) | none |

https-only is not enforced by either transport. The desktop's own mint settings are https only
(`isMintUrl`). A manifest's mint list accepts `http(s)` (`manifest/parse.ts`). That is unchanged
and listed in the residuals.

Fix, part 2: `isDefinitive` (`spend.ts`, locked; `check:locked` OK; one cashu-ts import removed)
no longer treats `RateLimitError` as a refusal. A 429 is resolved like a lost answer: the inputs
are held, NUT-09 restores what the mint signed, and after the wait NUT-07 decides.

A `StaleKeysetError` with a coded `cause` stays a refusal, because every production transport
now sends each request once:

- the desktop: the money plane's connections, with no other path (below);
- the seeder daemon and the gateway: `createNodeRuntime` gives every mint `nodeMintRequest`;
  neither CLI passes `mintRequest`;
- cashu-ts over a custom transport sends a swap, melt or mint once. `withStaleKeysetRepair`
  converts, it does not resend. `withLegacyQuoteSigFallback` resends a mint only after a coded
  20008 refusal of the first, which is definitive by itself;
- cashu-ts's retrying default remains only in the opt-in real-mint tests, which construct
  `CashuMintConnections()` bare. It is documented on `CashuMintConnections`.

Nothing else in the desktop reaches a mint:

- `inputFeePpk`, `keyset` (behind `seller.keyset`), mint info (`loadMint`), quotes, every spend,
  `checkSpent`, `spentByUs` and `recover` all go through `this.o.mints.wallet(mint)`, which is the
  money plane's connections;
- the worker imports no cashu-ts, and reaches a mint only through the host's `seller.*` handlers;
- main's only `fetch` is the loopback media proxy (`LOOPBACK_LINK`).

A source test pins this: `host/money.ts` is the only desktop file with a cashu-ts import,
`new Mint(` or `CashuMintConnections(`, and it passes the fallback request.

Cost, accepted by the orchestrator's decision: a 429 on a request that never ran now holds its
inputs, and locks a melt's quote locally, for `PENDING_SETTLE_AFTER_S`. That is the cost finding 4
had removed. The daemon has no settle loop, so it holds a payout's inputs until the next receive
after the wait.

Tests:

- `core/src/wallet/__tests__/journal-retry.test.ts` (new, 5):
  - with a retrying stand-in transport (the first request executes and its answer is lost, the
    retry is answered 429): the send completes from NUT-09; with the restore down too, the entry
    is kept and a later settle recovers it (61 sat, the history line 3 sat); a melt is held, then
    its change is restored (44 sat) and a retry answers paid;
  - a 429 on a request that never ran is held until the wait, then comes back;
  - the verifier's scenario in process, with cashu-ts's own fetch transport against a NUT-19
    TestMint: the swap is POSTed twice, and nothing is lost.
- `journal-review.test.ts`: the finding-4 test that expected a 429 to drop the entry at once
  asserted the defect. It now asserts the entry is held (no second melt request), settled after
  the wait, and the quote payable, with a comment citing this round.
- `core/src/wallet/__tests__/http-module.test.ts` (new, 3):
  - exact bytes and `Content-Length`, lower-case and joined headers, a BOM kept;
  - no redirect, the size cap, the timer, other schemes refused;
  - under `cashuRequestFn`, a dropped connection is one request even with NUT-19 hints.
- `app-desktop/src/host/__tests__/mint-transport.test.ts` (new, 4):
  - the money plane with no `mintRequest`, over real HTTP to a NUT-19 TestMint that loses the
    first swap answer and answers any retry 429: one swap reaches the mint, no 429 is served, the
    send completes (28 sat), and the headers are the host transport's;
  - a mint an injected transport leaves out gets the host transport;
  - `hostMintRequest` ignores NUT-19 hints;
  - the source pin above.
- `seeder/src/runtime/__tests__/mint-transport.test.ts` (new, 1): a mint the injected transport
  leaves out gets `node:http`, not cashu-ts's fetch.
- Real mints (opt-in, +3 in `journal-real-mint.integration.test.ts`):
  - a retrying transport meeting a 429 after the swap ran loses nothing (cdk-mintd and Nutshell);
  - cashu-ts's own fetch transport, the verifier's run: two swap POSTs on cdk-mintd, one on
    Nutshell (no NUT-19), nothing lost;
  - the production Node transport sends a lost swap once, and the send completes.
  - With the 429 rule put back (M2), the first two fail on cdk-mintd and the first on Nutshell.

### LOW 1: a DLEQ thread beside a leaving one, via queued jobs — fixed

Verified: the "no new thread while a retired one is leaving" guard was only in `tryVerify`. Jobs
already queued through `verify()` reached `run()` → `ensureStarted()` after the thread was retired
for a timeout, and each spawned a thread. With a stand-in that boots but never answers, three
queued PAYs made three threads.

Fix (`worker/pay/dleq-thread.ts`): `run()` rejects at once when no thread is up and a retired one
is still reaping. The caller checks the job on the chunked path.

Tests (`dleq-thread.test.ts`):

- +1: three PAYs queued on the HANG stand-in. The first times out, the other two fail at once
  ("still leaving"), and one thread is spawned. Through `dleqVerifier`, the verdicts come from the
  chunked path and no thread is added.
- The start-retry test tried its second start at once, beside the first thread. It now shows the
  immediate refusal, and makes the second start once that thread is let go, with a comment citing
  this round.
- The real Bare run (`bare-dleq-thread.test.ts`, on the rebuilt `dist/`) still passes.

### LOW 2: the settle loop never backed off from a mint it could not load — fixed

Verified: `recoverPending` skipped a mint whose `spender.recover` threw (for example, `loadMint`
refused), and returned `{0, 0}` for a mint that no longer offers NUT-09. Neither counted its
entries in `left`. So `left < before` read as progress, and the delay stayed at 30 s.

Fix (`core/src/wallet/wallet.ts`): `left` counts every entry still in the journal after the
settle, a skipped mint's included. The balance event fires only when that count moved. The
startup log and the daemon's "still unresolved" warning now report the true count.

Tests (`settle-loop.test.ts`, +2), both over the real wallet:

- a mint whose `wallet()` rejects: `left` is 1, and the delays go 30, 30, 60, 120, 240, 480, 600,
  600. The entry is kept, and decided once the mint is back (the input returns, 16 sat);
- a mint that stopped advertising NUT-09: `left` is 1, and the delay grows.

Before the fix, both stayed at 30 s.

### Self-review of this round (`differential-review`, `sharp-edges` method)

Risk:

- HIGH: `spend.ts` (which failures drop an entry, for send, receive, mint and melt, desktop and
  daemons).
- HIGH: the transport swap (every desktop mint request, and the daemons' raw HTTP moved).
- LOW: `dleq-thread.ts` and the `recoverPending` counts.

Blast radius:

- `isDefinitive`: four operations, two hosts;
- `httpModuleRawHttp`: all Node mint traffic (seeder, gateway, desktop);
- `recoverPending`: the startup settles (desktop and daemon) and `SettleLoop`.

Adversarial questions:

- **A mint that answers 429 to everything?** Every operation holds its inputs for the wait. Then
  NUT-07 gives them back, and the loop backs off to 10 min. Liveness, not loss.
- **A mint that executes and then answers a coded error?** Unchanged: that operation's outputs are
  lost, as with any coded answer (residual).
- **An injected transport that retries?** Test seams only (`mintRequest` on `MoneyPlaneOptions`,
  `HostOptions`, `NodeRuntimeOptions`). Each documents that it must not retry.
- **Did the moved raw HTTP change a byte?**
  - The body is written as the encoded `Uint8Array`, and `Content-Length` is its length (was
    `Buffer.byteLength` of the string: same value).
  - The answer is decoded with `TextDecoder` and `ignoreBOM: true`, which keeps a BOM as
    `Buffer#toString` did.
  - Limits and timer unchanged.
  - The seeder's own `nodeRawHttp` tests pass unchanged against it.
- **Does dropping the User-Agent break a mint?** No: both real mints pass every real-mint test
  without one. The daemons never sent one.

Found and fixed during the round:

- S4 [Low]: the first version of the host default used the single-attempt transport only when
  `mintRequest` was absent. The seeder runtime's did the same. A mint that an injected transport
  answered `undefined` for fell through to cashu-ts's fetch. Fixed in `88a6476`, with tests in
  `7609e1f` (M4, M5).

### Mutation checks (fix round 2)

Each guard was broken, the named tests run, and the guard restored with `git checkout`. Core's
`dist/` was rebuilt where a desktop test reads `@sovit/core` (M3b).

| # | Guard broken | Result |
|---|---|---|
| pre | the new tests against the unfixed code | `journal-retry` 5/5 fail; host default test fails (2 swap POSTs); LOW 1 test fails (second job starts a thread, times out); LOW 2 delays stay 30 s |
| M1 | `RateLimitError` definitive again | 6 core tests fail (5 new, the rewritten finding-4 test) |
| M2 | the same, on real mints | cdk-mintd: 2 real-mint tests fail (`RateLimitError`, entry dropped). Nutshell: 1 fails; cashu-ts does not retry there (no NUT-19) |
| M3 | the money plane's default back to cashu-ts's fetch | 3 host tests fail (2 swap POSTs; its headers; the source pin) |
| M3b | M3 and M1 together (the defect as shipped) | the host send fails: `P2PK swap failed (RateLimitError)` |
| M4 | seeder runtime: fallback only without `mintRequest` | the seeder transport test fails |
| M5 | host: fallback only without `mintRequest` | the host fallback test fails |
| M6 | no guard in `run()` | 2 tests fail (queued jobs; start retry) |
| M7 | a skipped mint's entries not counted | the ECONNREFUSED backoff test fails |
| M8 | `left` from `spender.recover` again | the NUT-09 backoff test fails |

### Checks run (fix round 2)

- `npx vitest run --maxWorkers=2` (at `8af6d3a`, plus the `15c3ea2` comment): 183 files passed, 3
  skipped (opt-in); 2806 tests passed, 18 skipped; 176 s.
- Real mints, with `NUTFLIX_REAL_MINT_URL` set and `NUTFLIX_REAL_MINT_URL_2` = Nutshell 3398. The
  files are core's `real-mint.integration.test.ts` and `journal-real-mint.integration.test.ts`,
  and the gateway's `real-mint-swarm.integration.test.ts`. The gateway's daemon wallet now runs on
  the moved raw HTTP.
  - Nutshell 0.21.0 (3399): 3 files, 18/18 (core 7, journal 8, gateway swarm 3).
  - cdk-mintd 0.18.1 (3397): 3 files, 18/18.
- `npx tsc -b --force`: clean.
- `npx eslint` and `npx prettier --check` on every changed file: clean.
- `npm run check:locked`: OK. `npm run lint:electron`: OK.
- The Electron e2e was not run (not asked). No dependency changed.

### Residuals after fix round 2

- [Low] A 429 on a request that never ran holds its inputs for `PENDING_SETTLE_AFTER_S`, and locks
  a melt's quote locally for as long. This is finding 4's cost, taken back deliberately. The
  daemon has no settle loop, so it holds them until the next receive after the wait.
- [Low] A mint (or a proxy in front of it) that executes a request and then answers with a NUT
  error code, or a keyset code, loses that operation's outputs. The same holds for any coded answer
  after executing. An honest mint does not do this, and with one attempt per request no retry can
  produce it. This replaces round 1's residual, which also named the 429.
- [Low] Core's `CashuMintConnections` with no `request` is still cashu-ts's retrying fetch
  transport. No production wallet uses it: it is documented on the class, and pinned by the host
  source test and the seeder runtime test. Only opt-in real-mint tests construct it bare.
- [Info] A manifest's mint list accepts `http://` and any host, LAN included. The money plane
  contacts such a mint when a PAY names it, as the fetch transport did before. Not changed by
  this round.
- Still open from round 1:
  - the daemon has no settle loop;
  - a retired DLEQ thread that never says it is leaving is let go after 60 s;
  - finding 6: the journal's growth during a relay outage;
  - a second melt of a quote that is still unresolved locally is refused.

## Fix round 3 (2026-09-25)

The verifier of fix round 2 reported one low and one info finding, the info one to be fixed too.
Both were checked against the code and hold. Both are fixed on `stage-3/residuals`, `fea148b` and
`0a32cb4`, then the docs.

| # | Finding | Outcome |
|---|---|---|
| LOW | `hostMintRequest()` gave a melt the 30 s whole-exchange default; a Lightning payment of 30 to 60 s or more was cut off | **fixed**: `fea148b` |
| INFO | `CashuMintConnections` with no request function still fell back to cashu-ts's retrying fetch transport; a coded answer to a retry drops the journal entry (the verifier lost 64 sat to an 11001) | **fixed**: `0a32cb4` |

### LOW: a melt was cut off at 30 s — fixed

Verified:

- cashu-ts 4.10.0 sends `POST /v1/melt/{method}` through `requestWithAuth` with no
  `requestTimeout`, so `cashuRequestFn` applied its 30 s default. The mint pays the invoice
  before it answers.
- Nutshell's LND backends allow 60 s for a payment. Before round 2 the desktop's transport was
  cashu-ts's fetch, with undici's 300 s header and body timeouts.
- `spend.ts`: a melt with change blanks that times out is held ("outcome unknown") until a settle
  decides it. One with no blanks (a fee reserve of 0) is not journaled, and the user is told
  "melt failed" for an invoice that may then get paid.
- Main, the preload bridge and the host dispatch put no deadline of their own in front of a melt.
  So the transport's timeout is the only one.

Fix (`core/src/wallet/transport.ts`):

- `cashuRequestFn` gives `POST …/v1/melt/{method}` 300 s (`meltTimeoutMs`), matched on the tail of
  the path, so a mint URL with a path prefix is covered.
- Melt quotes (`…/v1/melt/quote/…`), quote checks, swaps and mints keep 30 s. cashu-ts's own
  `requestTimeout` still wins.
- The desktop (`hostMintRequest`) and the daemons (`nodeMintRequest`, whose only melt is the
  operator's `melt` command) get it through the shared function. Comments updated in
  `host/mint-transport.ts` and `seeder/src/runtime/mint-http.ts`.

Tests:

- `transport.test.ts` (+1): which requests get which timeout.
  - 300 s: bolt11, bolt12, and a path prefix.
  - 30 s: the melt quote, the quote check, swap, mint, the mint quote, a longer path, and a GET of
    the melt path.
  - `requestTimeout` and both options are honoured.
- `host/__tests__/mint-transport.test.ts` (+2), over a local mint that holds its answers, with
  fake timers:
  - a melt answered after 45 s succeeds;
  - a melt with no answer is a `NetworkError` at 300 s, not before;
  - a mint quote, a melt quote, a swap and a quote check each time out at 30 s, not before.

### INFO: the retrying default — fixed

Verified: `CashuMintConnections` built `new Mint(mint)` with no `customRequest` whenever `request`
was absent or answered `undefined`, so cashu-ts used its default request function, the NUT-19
retry loop around `fetch`.
In process, with the verifier's network (the first swap executes and its answer is lost; a retry
reaches the mint), the send failed with `P2PK swap failed (MintOperationError 11001)`.

Fix: the default is now single-attempt, `cashuRequestFn` over a new fetch-based raw HTTP
(`core/src/wallet/fetch-http.ts`, `fetchRawHttp`, exported). It is bounded like
`httpModuleRawHttp`:

- one timer for the whole exchange, to the last byte of the body;
- the body is read incrementally and refused past the cap, and a larger `Content-Length` is
  refused before reading;
- `redirect: 'manual'`: Node's fetch hands back the 3xx, a browser an opaque redirect (status 0).
  Either is an `HttpResponseError`;
- http(s) only, checked before anything is sent;
- no cookies, cache or referrer;
- the caller's abort signal.

It works in Node and in browsers. `fetch` is looked up per request, so nothing loads at import.
cashu-ts's retrying transport is no longer reachable through `CashuMintConnections` at all; the
option to request "no custom transport" does not exist.

Construction sites, all compiling unchanged (`npx tsc -b --force` clean):

- desktop `host/money.ts` and the seeder `runtime/index.ts`: they pass `cashuRequestFn` over
  `node:http(s)` for every mint. That stays: the daemons run `--jitless`, where `fetch`'s
  WebAssembly parser crashes;
- the gateway: through the seeder runtime; its real-mint swarm test builds a bare
  `CashuMintConnections()` and now gets the single-attempt default;
- app-web: builds none;
- the tests: every other site passes a `TestMint` request. Core's `real-mint.integration.test.ts`
  and `journal-real-mint`'s invoice helper use the default.

Tests:

- `fetch-http.test.ts` (4, new), against Node's real `fetch` and a local server:
  - exact bytes both ways, with no cookie or referer sent;
  - a redirect is not followed (the target is never requested);
  - both size caps;
  - a stalled body times out;
  - the caller's abort;
  - schemes, and the `fetch` init;
  - one request under `cashuRequestFn` with NUT-19 ttl and cached endpoints.
- `journal-retry.test.ts` (+2):
  - no `request`: at a NUT-19 `TestMint` whose first swap answer is lost, where a retry would be
    answered 11001, exactly ONE swap attempt is made, and the send completes from NUT-09
    (balance 61, nothing pending, nothing spent);
  - the same for a request function that answers `undefined`.
- The round-2 test of cashu-ts's own transport got it from `new CashuMintConnections()`. It now
  builds that transport explicitly (`__tests__/cashu-ts-own-transport.ts`, a test helper with its
  own check, since core's vitest config runs every file under `__tests__`). A comment cites this
  round, and the assertions are unchanged: two swap POSTs, nothing lost.
- `journal-real-mint.integration.test.ts` (+1, opt-in): the default on a real mint, with a retry
  that would reach the mint. The cashu-ts-transport test there builds it explicitly too.
- The host and seeder transport tests tell `node:http` from any `fetch` by the `User-Agent` Node's
  `fetch` adds. Their comments now say so. Round 2's M4 and M5, re-run against the new default,
  are still killed.

### Self-review of this round (`differential-review`, `sharp-edges` method)

Risk:

- MEDIUM: the default transport of `CashuMintConnections`. No production wallet uses it: the
  desktop and daemons pass their own for every mint.
- LOW: the melt timeout (every desktop and daemon melt).

`spend.ts` is unchanged (`check:locked` OK).

Blast radius:

- `cashuRequestFn`: all mint traffic of the desktop and daemons;
- `DEFAULT_REQUEST`: tests, the gateway's real-mint swarm, and any future caller that passes no
  transport.

Adversarial questions:

- **A mint that holds every melt open?** Each is bounded at 300 s, and melts are user- or
  operator-initiated. Liveness only, and the same as before round 2.
- **Can another request be made to match the melt pattern?** The endpoint is built by cashu-ts
  from the configured mint URL, and a match only lengthens a timeout. A GET, a melt quote and a
  longer path do not match (tested).
- **A payment longer than 300 s?** With blanks, held and settled; with none, "melt failed", as
  before round 2 (residual).
- **The fetch default in a daemon?** It is never reached: the runtime falls back to `node:http`
  for every mint, and the seeder test pins it. Under `--jitless` the default would crash at the
  first request, not retry.
- **The fetch default in a browser?** An opaque redirect is refused (status 0,
  `HttpResponseError`, held then settled). A browser mint needs CORS, as it did before. No browser
  wallet exists today.
- **Compressed answers?** undici decodes them, and the streamed cap counts decoded bytes. The
  `Content-Length` pre-check counts encoded bytes, which is conservative.
- **Shared state in `DEFAULT_REQUEST`?** None: `cashuRequestFn` and `fetchRawHttp` are closures
  with no state; each request has its own timer and controller.

Found and fixed during the round:

- the first matcher also excluded a bare `…/v1/melt/quote`, which is not an endpoint (and would
  have left a surviving mutant). Dropped: a quote path has more segments.
- core's vitest config runs every file under `__tests__`, so the test helper failed as "no test
  suite". It now carries its own check, like `nostr/__tests__/helpers.ts`.

### Mutation checks (fix round 3)

Each guard was broken, the named tests run, and the guard restored from a saved copy. Core's
`dist/` was rebuilt where a desktop test reads `@sovit/core`.

| # | Guard broken | Result |
|---|---|---|
| pre-a | the new timeout tests against the unfixed transport | core timeout test fails (all 30 s); host 45 s melt test fails (done at 30 s) |
| pre-b | the new default tests against the unfixed `wallet.ts` | 2 `journal-retry` tests fail (`P2PK swap failed (MintOperationError 11001)`); the real-mint test fails on cdk-mintd and passes on Nutshell (no NUT-19, so no retry) |
| T1 | melt matcher anchored at the start of the path | core timeout test fails (path prefix) |
| T2 | no method check | core timeout test fails (a GET of the melt path) |
| T3 | 300 s for every request | host 30 s test fails |
| T4 | the default only without a `request` option (an `undefined` answer gets cashu-ts's transport) | the `undefined`-answer test fails |
| T5 | `redirect: 'follow'` | 2 `fetch-http` tests fail |
| T6 | no streamed cap | `fetch-http` cap test fails |
| T7 | timer cleared at the headers | `fetch-http` stall test fails |
| T8 | no `Content-Length` pre-check | `fetch-http` declared-length test fails |
| T9 | no scheme check | 2 `fetch-http` tests fail |
| T10 | `credentials: 'include'` | `fetch-http` init test fails |
| T11 | round 2's M4 and M5 together, against the new default | 3 fail (seeder transport, host fallback, host source pin) |

### Checks run (fix round 3)

- `npx vitest run --maxWorkers=2` at `0a32cb4`: 186 files passed, 2 skipped (opt-in); 2818 tests
  passed, 19 skipped; 170 s. The helper's check runs in each file that imports it, so
  `journal-real-mint` no longer counts as a skipped file.
- Touched packages (`packages/core`, `packages/seeder`, `packages/app-desktop/src/host`): 102 files
  passed, 1 skipped; 1167 tests passed, 16 skipped.
- Real mints, with `NUTFLIX_REAL_MINT_URL` set and `NUTFLIX_REAL_MINT_URL_2` = Nutshell 3398. The
  files are core's `real-mint.integration.test.ts` and `journal-real-mint.integration.test.ts`,
  and the gateway's `real-mint-swarm.integration.test.ts`. The wallets they build with no request
  function (core's real-mint wallets, the swarm's viewer, the invoice helper) now run on the
  fetch default, melts included.
  - Nutshell 0.21.0 (3399): 3 files, 20/20 (core 7, journal 9, the helper's check 1, gateway
    swarm 3).
  - cdk-mintd 0.18.1 (3397): 3 files, 20/20.
- `npx tsc -b --force`: clean.
- `npx eslint` and `npx prettier --check` on every changed file: clean.
- `npm run check:locked`: OK. `npm run lint:electron`: OK.
- The Electron e2e was not run (not asked). No dependency changed.

### Residuals after fix round 3

- Closed: round 2's "[Low] Core's `CashuMintConnections` with no `request` is still cashu-ts's
  retrying fetch transport".
- [Low] A melt whose Lightning payment takes longer than 300 s is still cut off. With change
  blanks it is held and settled later; with none, the user is told "melt failed" although the
  invoice may still be paid. This is the bound undici gave before round 2.
- [Info] The fetch default sends `fetch`'s own `User-Agent` (`node` in Node, the browser's in a
  browser). `node:http` sends none. No production wallet uses the default.
- [Info] The test helper's own check runs in every file that imports it (core's vitest config), as
  `nostr/__tests__/helpers.ts` does.
- Unchanged from fix round 2:
  - a 429 on a request that never ran holds its inputs for the wait;
  - a mint that executes and then answers with a code loses that operation's outputs;
  - `http://` and LAN mints named by a manifest are contacted;
  - the daemon has no settle loop;
  - a retired DLEQ thread that never says it is leaving is let go after 60 s;
  - finding 6: the journal's growth during a relay outage;
  - a second melt of a quote that is still unresolved locally is refused.
