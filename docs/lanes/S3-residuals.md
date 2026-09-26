# Lane S3-residuals: issue #8 residuals

Branch `stage-3/residuals`, on `c08c99f` (contracts v6). Contracts untouched: no contract
request. Issue #8 has five parts. This lane did four of them; the fifth, the credit pool,
belongs to another lane.

- (a) a durable desktop journal;
- (b) journaled melt change;
- (c) held inputs out of the balance;
- (d) DLEQ off the Bare worker's event loop.

An independent review of `c1cf406` returned fix-first (two medium liveness findings, two low,
two info). All six were verified; five are fixed and one info is deferred. See "Independent
review round" below and `docs/reviews/2026-09-25-pre-push-residuals.md` § Independent review.

## Independent review round

| # | Finding | Outcome |
|---|---|---|
| 1 | [Medium] Held inputs never came back by themselves: a settle ran only inside an operation at that mint or once at open, and the playback gate reads the balance first | **fixed**: `SettleLoop` (core) settles on a schedule, started by the money plane |
| 2 | [Medium] `DleqThread.retire()` could block the Bare worker's loop for ever (`terminate()` stops neither a busy nor an `Atomics.wait`-parked thread; the thread overwrote QUIT) | **fixed**: CAS transitions, an `exited` word, join only after it, background reap |
| 3 | [Low] Compaction could publish a deletion before the token carrying its proofs | **fixed**: `compactOutbox` keeps the new token in the first replaced token's place |
| 4 | [Low] `StaleKeysetError` (12xxx) and 429 read as ambiguous: inputs held, quote locked 10 min | **fixed**: `isDefinitive` takes exactly those two wrappers (not any coded `cause`) |
| 5 | [Info] A retry of a melt recovered earlier said "melt failed"; recovered lookup not kind-checked | **fixed**: a PAID quote answers paid without a request; recovered entries keyed by kind |
| 6 | [Info] The journal grows without bound during a long relay outage | **deferred** (info): documented in `nip60.ts` and the residuals |

What changed:

- **Finding 1.** `CashuWallet.settleSchedule()` reads the journal (count, the next wait, what is
  overdue). `SettleLoop` (`core/src/wallet/settle-loop.ts`, new) runs `recoverPending` at an
  entry's `created + PENDING_SETTLE_AFTER_S` + 5 s, retries overdue entries after 30 s doubling
  to 600 s (back to 30 s once a settle decides one), re-plans on balance events but only ever
  earlier, runs one settle at a time, and has an unref'd timer. `MoneyPlane` starts it after the
  startup settle and stops it in `close()` (`settleTimer` option for tests).
- **Finding 2.** The thread moves the state word only by `Atomics.compareExchange` (BOOT → IDLE,
  REQ → RES/FAIL) and sets a new `exited` word on every way out (the entry's FAIL path too).
  `retire()` sets QUIT and reaps in the background: `join()` only after `exited` (immediate
  then), else a non-blocking `terminate()` after `reapMs` (60 s) and the handle is let go.
  `close()` returns a promise and never blocks. Self-review follow-ups: no new thread starts
  while a retired one is still leaving (no pile-up on a starved CPU); timeout options must be
  finite and ≥ 0, `dataBytes` a positive integer.
- **Finding 3.** `compactOutbox` (`nip60.ts`).
- **Findings 4 and 5** (`spend.ts`, locked; `check:locked` OK): `isDefinitive` accepts
  `StaleKeysetError` with a coded `cause` and `RateLimitError`; a coded `cause` under any other
  error stays ambiguous (a `MeltChangeError` means the melt went through). A melt of a quote the
  mint reports PAID returns `paid: true` (preimage, change 0) without a request. `settle`'s
  recovered map is keyed `kind:key`.
- ADR 0014 amendment: a section "After the independent review".

Commits: `7e6f6c4` (1), `a32b2ec` and `d2e18ce` (2), `4c2c219` (3 to 6), `914a44e` (self-review),
then the docs.

Tests this round: 29 new (27 always on, 2 opt-in real-mint), 1 changed.

- `core/src/wallet/__tests__/settle-loop.test.ts` (10, new): planning; no postponement by events
  for a wait or a retry; backoff and reset; one settle at a time; stop; a future stamp; a NaN
  clock; store and settle errors; the real wallet with only `balance()` read gets a refused
  send's input back, spendable once.
- `core/src/wallet/__tests__/journal-review.test.ts` (7, new): 12001 on a melt, 429 on a melt,
  12002 on a send (nothing held, payable at once); a `MeltChangeError` with a coded cause still
  restores the change; a lost answer stays ambiguous; a retry after a restart answers paid with
  no second request; a recovered top-up never passes for a melt with the same (malicious) id.
- `core/src/wallet/__tests__/nip60-journal.test.ts` (+2): the relay refusing token events after
  an outage gets no deletion ahead of the token; `compactOutbox` order cases.
- `core/src/wallet/__tests__/journal-residuals.test.ts` (1 changed): the refused-melt test makes
  the mint refuse by sending no inputs (a second melt of a paid quote is now answered locally,
  finding 5), and also checks the quote is payable right after.
- `core/src/wallet/__tests__/journal-real-mint.integration.test.ts` (+2, opt-in): held inputs
  come back by the loop (the mint's NUT-07 answer); a retry of a recovered melt answers paid.
- `app-desktop/src/host/__tests__/wallet-journal.test.ts` (+2): the money plane returns 16 sat
  after an hour of balance reads when its planned settle runs; `close()` cancels the plan.
- `app-desktop/src/worker/__tests__/dleq-thread.test.ts` (+6): mid-job and slow-start retire
  (QUIT kept, joined only after `exited`); a thread that never says it leaves is let go;
  `serveDleqMailbox` with QUIT before boot; no pile-up; timeout options. Existing tests now
  `await close()` and give stand-ins a short `reapMs` (comments cite the finding).
- `app-desktop/src/worker/__tests__/bare-dleq-thread.test.ts` (extended): under the real Bare,
  a job past `jobMs` and a start past `startMs` are given up on with the loop turning (max stall
  16 ms over 2 s of thread work), each thread and the broken entry are joined, `Bare.exit`
  returns.

Mutation checks this round: 22 (R1 to R22), every one killed; R2 first survived and got a test.
Table in the review record.

Checks: full suite `npx vitest run --maxWorkers=2` at `914a44e`: 179 files passed, 3 skipped;
2790 tests passed, 15 skipped (167 s). Real mints (Nutshell 0.21.0 on 3399, cdk-mintd 0.18.1 on
3397, second Nutshell 3398 for invoices): core 12/12 and gateway swarm 3/3 on each.
`npx tsc -b --force`, eslint, prettier, `check:locked`, `lint:electron`: clean. No dependency
changed.

Housekeeping note for the orchestrator: three `bare` processes from the reviewer's repro
(`node_modules/.cache/nf-review-race/boot.mjs`, started 17:17, orphaned, idle) are still running
in this worktree. They were not started by this lane and were left alone.

## What changed, and why

### (a) The desktop wallet journal is durable and sealed (ADR 0014 amendment)

Before, the desktop's `Nip60ProofStore` kept its journal in memory. A crash between a lost mint
answer and its recovery lost that operation's outputs.

- **The file.** One file per identity, `<userData>/wallet/journal-<pubkey>.sealed`, 0600 in a
  0700 directory (`host/wallet-journal.ts`, the signer key file's rules: no symlinks, no files
  of other users, no files others can read). Each write is an exclusive temp file, fsync, rename,
  then a directory fsync.
- **The seal** (`core/src/wallet/nip60-journal.ts`). A random journal key, wrapped with NIP-44 to
  self through the signer. That is the proofs' own protection on the relays: at least as strong,
  libraries only. Every write is sealed with XChaCha20-Poly1305 (sodium) under a fresh nonce,
  with the header as associated data. The signer is asked once per open, never on the payment
  path. A NIP-46 bunker is not asked for a relay round trip per PAY, which was the ADR's reason
  for keeping the journal in memory.
- **Write-ahead** (`core/src/wallet/nip60.ts`). Every transition goes through `apply`, one at a
  time. It is written durably before it becomes live and before `commit` resolves, so an entry is
  on disk before its request reaches the mint. The outbox of unpublished NIP-60 events is part
  of the sealed state, so an operation's result and the removal of its entry land in the same
  write. This keeps ADR 0014 decision 1's atomicity on a relay-backed store. During a relay
  outage, superseded unpublished token events are compacted away.
- **Recovery.** `MoneyPlane.open` reopens the journal. It merges the unpublished events into
  the relays' state and republishes them. When entries are left, it runs `recoverPending` in the
  background (`MoneyPlane.recovery`).
- **Fails loudly, keeps the file.** A journal that does not open refuses the wallet with
  `journal-unreadable` and writes nothing. This covers a damaged or planted file, a file that is
  not private, and anything over 32 MiB. The host logs an error, and the unavailable wallet says
  the journal is unreadable, not "no wallet". A signer that is merely away (a bunker timeout) is
  reported as itself, and the next unlock retries.
- **Closing.** A closed money plane (lock, sign-out, swap) wipes the journal key and refuses to
  journal anything more. A payment is then refused before its request. Writes to one path are
  serialised across instances, and an open waits for the last one.

### (b) Melt change is journaled

`Spender.melt` (the locked audit file) now prepares with `prepareMelt` and journals a `melt`
`PendingOp` (the NUT-08 blanks, the inputs, the quote id) before `completeMelt`.

- A lost answer restores the change by NUT-09. A blank takes the mint's amount, checked by its
  DLEQ; every other kind must match.
- `PENDING` keeps the entry.
- With no signatures, the inputs' NUT-07 state decides: PENDING waits; all SPENT after the wait
  means paid with no change.
- A refusal drops the entry.
- A second melt of an unresolved quote is refused locally, and a retry after recovery does not
  pay twice.
- The daemon's `FileProofStore` now uses core's shared `isPendingOp`, which knows the kind.

### (c) Held inputs are out of the balance

`CashuWallet.balance` / `balances()` subtract the inputs of journaled sends and melts, and the
change events and the header chip follow. Held inputs come back if the mint never executed, and
leave exactly once if it did. A melt cannot select them either. A failed operation now emits a
balance event too. Two existing F31 tests expected 16 while the input was held; they now expect
0, with a comment citing issue #8.

### (d) DLEQ off the Bare worker's event loop

- **Why not `bare-worker`.** Bare has no `worker_threads`. `bare-worker` and `bare-thread` are
  installed, transitively through pear-runtime, but not declared by `@sovit/app-desktop`.
  `bare-worker`'s `new Worker(path)` also bundles the entry synchronously on the event loop
  (about 240 ms for a trivial entry).
- **What is used instead.** The runtime's own `Bare.Thread` with a SharedArrayBuffer mailbox:
  `Atomics.waitAsync` on the worker side, `Atomics.wait` in the thread. No package, no addon
  (`worker/pay/dleq-thread.ts`). The thread runs core's `proofDleqOk`.
- **Never waits, never accepts on failure.** Verification never waits for the thread to start;
  the first PAY after launch is checked inline, chunked. A thread failure (no start, FAIL, wrong
  count, timeout) means chunked inline checks, two proofs per turn. It never means acceptance,
  and never the engine's one-pass synchronous fallback.
- **Two findings under the real runtime.**
  - An exception escaping a `Bare.Thread` aborts the whole worker process. So the entry imports
    nothing statically and answers FAIL through the mailbox, and a thread only starts from an
    entry file that exists.
  - A `.js` entry is parsed as CommonJS in a thread, where tsc's `export {}` is a SyntaxError
    that aborts the worker. So the entry is `.mts`, built to `.mjs`.
- **Measured under the real Bare 1.31**, a maximal PAY (128 proofs):

  | Path | Max stall | Total |
  |---|---|---|
  | Inline | 593 ms | |
  | Thread | 2 ms | 563 ms, plus a one-time start of 156 ms |
  | Chunked | 10 ms | |

  Under heavier load: 1231 / 5 / 38 ms. Same verdicts on every path.

## Files

- Core:
  - `wallet/store.ts`: the `melt` kind, `isPendingOp`, `isPendingOutput`, `isStoredProof`,
    `heldSecrets`, `PENDING_KINDS`;
  - `wallet/spend.ts` (locked; `check:locked` OK);
  - `wallet/nip60.ts`;
  - `wallet/nip60-journal.ts` (new);
  - `wallet/wallet.ts`;
  - `wallet/index.ts`.
- Seeder: `runtime/proof-file.ts`.
- Desktop host:
  - `wallet-journal.ts` (new);
  - `money.ts`: `journalDir` is required, `string | null`; `recovery`;
  - `host.ts`;
  - `wallet.ts`: `JOURNAL_UNREADABLE`, `unavailableReason`, `SwitchingWallet.set(w, why)`;
  - `signer/desktop-signer.ts`: `moneyError()`;
  - `signer/private-file.ts`: the error label.
- Desktop worker:
  - `pay/dleq-thread.ts` (new);
  - `pay/dleq-thread-entry.mts` (new);
  - `pay/real-providers.ts`;
  - `adapters/bare.ts`: `bareDleqThread`;
  - `runtime.ts`, `providers.ts`, `host.ts`.
- Docs:
  - `docs/decisions/0014-wallet-journal-nut09.md` (amendment);
  - `docs/reviews/2026-09-25-pre-push-residuals.md`;
  - this report.
- Review round: core `wallet/settle-loop.ts` (new), `wallet/wallet.ts` (`settleSchedule`),
  `wallet/index.ts`, `wallet/nip60.ts` (`compactOutbox`), `wallet/spend.ts` (locked:
  `isDefinitive`, the PAID answer, `opKey`); host `money.ts`; worker `pay/dleq-thread.ts`,
  `pay/dleq-thread-entry.mts`, `pay/real-providers.ts`.

## Tests

57 new tests, 3 changed.

- **Core.**
  - `wallet/__tests__/journal-residuals.test.ts` (14): (c) both outcomes, counted once, the
    change events; a melt cannot take held inputs; restore amounts; (b) a lost melt answer, the
    entry written before the request, a restart, PENDING, NUT-07 PENDING then SPENT, never seen,
    refused, a DLEQ-less restore, no blanks.
  - `wallet/__tests__/nip60-journal.test.ts` (11): the sealed file (round trip, nothing in
    clear, fresh nonces, every damage refused and kept, header bound, a signer away, closed); the
    store over it (begin durable before resolve, a failed write changes nothing, a crash during a
    relay outage, compaction, dedup).
  - `wallet/__tests__/wallet.test.ts`: 2 assertions updated for (c), with the reason.
  - Opt-in `wallet/__tests__/journal-real-mint.integration.test.ts` (3): held inputs, the sealed
    journal across a crash, melt change by NUT-09. **3/3 on Nutshell 0.21.0 (3399) and 3/3 on
    cdk-mintd 0.18.1 (3397)**, with external invoices from a second Nutshell (3398). The existing
    real-mint suites, 10/10 on each, still pass with the new melt path.
- **Seeder.** `runtime/__tests__/proof-file-melt.test.ts` (2): a melt entry survives a reopen,
  an unknown kind refuses the start, a melt lost before a crash is recovered. The lane may not
  commit under `seeder/src/__tests__/`, hence the location.
- **Desktop host.**
  - `wallet-journal.test.ts` (8): the file rules; a lost answer across close and reopen; closed
    means no request; a damaged journal refused and kept; the host's journal message.
  - `wallet-journal.integration.test.ts` (3): **crash injection across a real process.** A child
    process runs the money plane against a TestMint served over HTTP, and is SIGKILLed after the
    mint executed its swap or melt and before the answer. A new process recovers it (61 and 44
    sat back, then spent at the mint). A damaged journal is refused, kept byte for byte, then
    recovered from its original bytes.
  - `desktop-signer.test.ts` (+1): the loud failure, no create prompt.
- **Desktop worker.**
  - `dleq-thread.test.ts` (14): parity, liveness, splitting; every failure mode leads to the
    chunked path; never waits for a start; close; chunk sizes; the realProviders wiring with a
    real PAY from a real viewer wallet (valid passes, forged is refused and banned).
  - `bare-dleq-thread.test.ts` (1): under the real Bare runtime against `dist/`. Parity on all
    three paths, the stall measurement, a missing entry and a broken entry without aborting.

Commands:

- `npx vitest run packages/core/src/wallet`: 9 files, all pass (the opt-in real-mint file
  skipped).
- `npx vitest run packages/app-desktop/src/worker --maxWorkers=2`: 19 files, 134 tests, all pass
  (before the review fixes added 3 more).
- `npx vitest run packages/app-desktop/src/host`: all pass. `money.test.ts` timed out once at
  5 s under the full host run at load 8; it passes alone in 2.4 s. The timeout was not raised.
- Real mints: see above.
- The full suite, `npx vitest run --maxWorkers=2` (at `9e18488`): 177 files passed and 3
  skipped (the opt-in real-mint files); 2763 tests passed and 13 skipped; 207 s.
- `npx tsc -b --force`: clean.
- `npx eslint` on every changed file: clean. Prettier: clean.
- `npm run check:locked`, `npm run lint:electron`: OK. No dependency changed, so
  `check:native` was not needed.

## Mutation checks

28 guards were broken one at a time; each made at least one test fail. Three guards (M5, M19b,
M22) first survived and got a new test. Full table: `docs/reviews/2026-09-25-pre-push-residuals.md`.
Highlights:

- M1: write-ahead off, so the crash tests fail;
- M20: a thread from a missing entry, so Bare aborts in the test;
- M26: verification waits for the start;
- M27: the host does not pass the journal directory.

The independent review round added 22 more (R1 to R22), all killed; R2 (a change event
postponing an overdue retry) first survived and got a test. 50 in all.

## Residuals

- [Low] A result commit whose journal write fails after the mint executed. The entry stays on
  disk, and the keep outputs come back at the next settle, but a send's locked outputs reach
  nobody.
- [Low] Melt blanks at a mint without NUT-12 take the mint's amount on trust.
- [Low] A melt whose connection failed holds its inputs, and a retry of the quote is refused,
  until the mint shows its fate or 10 min pass; the settle loop then decides it by itself
  (review finding 1). A keyset refusal or a 429 is no longer held (finding 4).
- [Low] A mint (or proxy) that executes a request and then answers 429 or a keyset code loses
  that operation's outputs, like any coded answer after executing (review finding 4).
- [Low] The daemon has no settle loop: a payout send whose answer is unknown holds its inputs
  until the next receive at that mint (each flush that redeems runs one) or a restart.
- [Low] A retired DLEQ thread that never says it is leaving is let go after 60 s, unjoined (ours
  always says so after its job).
- [Info] Review finding 6, deferred: the journal grows by about 3 KB an operation during a relay
  outage, every save rewrites it, and at 32 MiB commits fail closed until the relays return.
- [Low] The journal key is a hex string while it passes through the signer's NIP-44, and cannot
  be wiped.
- [Low] Journals are per identity and never deleted; they settle when that identity unlocks.
- [Info] Up to three sealed writes per desktop operation, about 8 to 11 ms each here (ZFS).
- [Info] One DLEQ thread: PAYs from different peers queue on it.
- [Info] Packaging must ship `dist/worker/pay/dleq-thread-entry.mjs`. Without it, the checks run
  chunked.
- [Info] `bare-worker` / `bare-thread` are available transitively but are not dependencies here.
  This lane uses neither: `Bare.Thread` is the runtime's own.
- [Info] The UI still shows the unavailable-wallet text as it shows any `payments-unavailable`
  error. A dedicated "your journal needs attention" screen is renderer work, outside this lane.

## Proposed row for `docs/status.md` (Stage 3 table)

| Issue #8 residuals (ADR 0014 amendment, F5 desktop) | `stage-3/residuals` (on `c08c99f`) | **done** (independent review fix-first → fixed): (a) the desktop journal is a sealed file per identity. The key is wrapped with NIP-44 to self, then XChaCha20-Poly1305. Every transition, with the unpublished NIP-60 events, is fsynced before its request; `recoverPending` settles it at open and a `SettleLoop` settles later entries on a schedule; a damaged journal refuses the wallet loudly and is kept. Crash injection: SIGKILL between the journal write and the mint answer, recovered by a new process. (b) Melt change is journaled (NUT-08 blanks, NUT-09 restore, PENDING and NUT-07 handled). (c) Held inputs are out of the balance and the header chip, and come back by themselves. (d) DLEQ runs on a `Bare.Thread` over a SharedArrayBuffer mailbox, with chunked fallback, never acceptance; retiring a thread never blocks the loop. 128 proofs: 548 ms of stall before, 3 ms after. Real mints: Nutshell and cdk 5/5. 50 mutation checks |

## Proposed text for `docs/security-review.md`

- **F31** (state row): "**Fixed** (`stage-3/wallet-journal`, ADR 0014; residuals closed in
  `stage-3/residuals`, ADR 0014 amendment)". Replace the residual sentence with: "The desktop's
  journal is a sealed file (a key wrapped with NIP-44 to self, then XChaCha20-Poly1305), written
  and fsynced with the unpublished NIP-60 events before each request, and settled at the next
  open, then on a schedule (`SettleLoop`); crash injection is tested. Melt change is journaled.
  Held inputs are out of the balance and come back by themselves.
  Residual [Low]: a result commit whose journal write fails after the mint executed loses a
  send's locked outputs (the recipient never gets them)."
- **F5** (state row): replace "Open: the desktop's Bare worker still checks DLEQ inline" with
  "The desktop's Bare worker checks DLEQ on a `Bare.Thread` (SharedArrayBuffer mailbox; any
  thread failure means chunked inline checks, two proofs per turn, never acceptance; a thread
  given up on is stopped through the mailbox and joined only once it says it is leaving, so
  retiring it never blocks the loop): 128 proofs, 548 ms of event-loop stall before, 3 ms after,
  measured under Bare 1.31 (`stage-3/residuals`)". Keep "Open: the credit pool …" for the other
  lane.
- §0a / summary line 597: "[Done] F5 … Residual [Low]: a credit pool sized per seeder window"
  (drop "DLEQ in the desktop's Bare worker").
