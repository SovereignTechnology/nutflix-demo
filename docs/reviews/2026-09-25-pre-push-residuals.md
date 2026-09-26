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
