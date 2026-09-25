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
