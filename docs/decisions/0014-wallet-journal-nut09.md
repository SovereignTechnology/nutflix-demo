# 14. A lost mint answer loses nothing: a write-ahead journal and NUT-09 restore

Date: 2026-09-24

## Status

Accepted for Stage 3 (lane "F31 recovery", branch `stage-3/wallet-journal`). Implemented and
tested, including against Nutshell 0.21.0 and cdk-mintd 0.18.1. This departs from the security
review's suggested fix for F31 (NUT-13 deterministic secrets). The reasons are below; Cameron may
still want NUT-13 for seed backups (see Consequences).

## Context

Security review F31: a swap whose response is lost (a timeout or reset after the mint committed)
leaves the wallet with inputs that are spent and outputs it cannot unblind. It then retries, and
the mint answers "already spent". The engine no longer bans the honest viewer over it
(`spentByUs`, Stage 2). The money is still gone, though: the seeder's earnings for that batch, a
viewer's change on a PAY, or a whole top-up whose mint answer never arrived. Outputs are random,
so nothing can be restored.

The review proposed NUT-13: derive every secret and blinding factor from a seed and a counter,
then restore by counter range. That has three problems here:

- **It needs a new secret.** It would be a seed in the key file, or one derived from the wallet key
  by a derivation scheme this codebase would have to invent. The rule is libraries only, no
  crypto of our own.
- **It needs per-keyset counters that never repeat.** A NIP-60 wallet is multi-device by design.
  Two devices sharing a seed would derive the same secrets, and the mint refuses outputs it has
  already signed. Counters in NIP-60 have no standard home.
- **It is broader than F31 needs.** F31 needs the outputs of one operation back, not
  whole-wallet recovery from a seed. Proofs are already backed up: on relays (NIP-60), or in the
  sealed wallet file (the daemon).

## Decision

1. **Journal before the request.** A send, receive or mint prepares its outputs with cashu-ts
   (`prepareSwapToSend` / `prepareSwapToReceive` / `prepareMint`). It writes them to the
   `ProofStore` as a `PendingOp` (`OutputData.serialize`: blinded message, blinding factor,
   secret), then sends the request (`completeSwap` / `completeMint`). The operation's result is
   committed atomically with dropping the entry (`WalletTx.begin` / `settle`).
2. **Recover by NUT-09.** When a request fails without a mint error code (reset, timeout, 5xx),
   the wallet asks the mint for signatures on exactly those blinded messages (`POST /v1/restore`).
   cashu-ts unblinds them and checks the DLEQ (`OutputData.toProof`). Where the mint supports
   NUT-12, a restored signature must carry a DLEQ, the same rule cashu-ts applies to live
   answers. Signed outputs mean the operation executed, and its result is committed as if the
   answer had arrived:
   - a lost send still returns its locked set, post-conditions checked;
   - a lost receive returns its amount;
   - a lost top-up returns its minted sats, or is recovered by the next poll once the mint reports
     the quote ISSUED.
3. **Refusals are final.** A mint error code (HTTP 400 `{code, detail}`) means the request was
   refused, so the entry is dropped. The exception is "already signed" / "already issued", which
   may be our own earlier attempt, so it is restored instead.
4. **Retries reuse outputs.** A retried receive (same inputs) or mint (same quote) reuses the
   journaled outputs. If the first attempt did execute, the mint answers "already signed" and the
   outputs are restored. They are never minted twice.
5. **An unresolved send holds its inputs.** While a send is journaled and unresolved, its inputs
   are kept out of new selections (send and melt). They still count in the balance.
6. **Settle on every operation.** Before any operation at a mint, its journal there is settled:
   - what the mint signed is recovered;
   - an entry the mint shows no trace of is dropped after `PENDING_SETTLE_AFTER_S` (10 min: its
     request may still be in flight), and a send's inputs are then reconciled by NUT-07;
   - an entry the mint cannot be asked about stays.
   `CashuWallet.recoverPending()` settles every mint at startup: the seeder daemon and the gateway
   run it in the background, since operations settle anyway.
7. **Where the journal lives.**
   - `FileProofStore` (the daemon, the gateway): in the sealed wallet file, written and fsynced
     like the proofs. It survives a crash, and a damaged entry refuses the start like any
     damaged wallet file.
   - `MemoryProofStore`: in memory.
   - `Nip60ProofStore` (the desktop): in memory. NIP-60 has no event kind for it, and a relay
     round trip before every PAY is too slow. It recovers a lost answer within the session.
8. **Only where NUT-09 exists.** A mint that does not advertise NUT-09 gets the old behaviour: no
   journal, reconcile, and `spentByUs` against false bans.
9. **Melt change is not journaled.** Melts are user-initiated and rare; its change outputs are
   left for later.

The engine is unchanged. With the journal, a lost redeem normally comes back as a success on the
same call, so the creator is paid, nobody is banned, and the seeder keeps its earnings. Two cases
still reach `spentByUs`: a batch that grew between attempts, and a startup sweep that recovered the
batch before the engine retried it. Its existing check reads the "spent" as our own, and the value
is counted once (tested).

## Consequences

- F31 is fixed, including across a crash on the daemon and the gateway, with no new secret and
  nothing multi-device-unsafe. Tested:
  - core, against the test mint (now with NUT-09: signatures remembered, never signed twice,
    `/v1/restore`): lost sends, receives and top-ups; retries; the settle wait; DLEQ-less restores;
    no NUT-09;
  - the engine: F31's own test (no ban, creator nutzapped, balance restored), a crash before
    recovery, and the startup-sweep order;
  - the sealed file: the journal survives a reopen, and a crash-and-restart recovers;
  - real mints: the same losses on Nutshell and cdk.
- Each journaled operation writes the store twice (begin, then result). On the daemon that is one
  more sealed file rewrite per redeem batch, since redeems are batched per flush.
- Residual [Low]:
  - the desktop's journal is in memory, so a crash between a lost answer and its recovery still
    loses that operation's outputs;
  - melt change is not journaled;
  - while a send is unresolved, its inputs still count in the balance.
- Not done: NUT-13 seed backup. If Cameron wants a wallet that can be rebuilt from words alone,
  that is a separate decision: the seed's source, per-device counters, and the relation to NIP-60.

## Amendment (2026-09-25): the three residuals (issue #8, lane `S3-residuals`)

The three [Low] residuals above are closed. Decisions 5, 7 (the desktop line) and 9 are
superseded as follows; everything else stands.

### (a) The desktop journal is durable, and sealed

`Nip60ProofStore` takes an optional `Nip60Journal`. The desktop host gives it one:
`SealedJournal` (`core/src/wallet/nip60-journal.ts`) over a private file,
`<userData>/wallet/journal-<pubkey>.sealed` (`app-desktop/src/host/wallet-journal.ts`).

- **What is in it.** The pending operations and the outbox of unpublished NIP-60 events, in one
  file. Both are written in the same write, so an operation's result (its new token event, still
  unpublished) and the removal of its entry land together. This restores decision 1's atomicity
  on a store whose proofs live on relays: without the outbox in the file, a crash between the
  relay publish and the journal write would either lose the proofs (outbox in memory) or replay
  an entry whose proofs were already committed and maybe spent. As the outbox grows during a
  relay outage, unpublished token events that a newer one supersedes are dropped from it. The
  newer token carries their proofs, and the kind-5 deletion still names them.
- **Write-ahead.** Every transition is written and fsynced before `commit` resolves. The file
  write uses a fresh exclusive temp file (0600), fsync, rename, then a directory fsync, the
  signer key file's rules. So a `begin` is on disk before `completeSwap` / `completeMint` /
  `completeMelt` sends the request. A write that fails rejects the commit and changes nothing,
  and the request is never sent. Writes to one path are serialised across wallet instances, and
  an open waits for the last one: a signer swap closes the old plane while one of its operations
  may still be writing. A closed journal (lock, sign-out, swap) wipes its key and refuses every
  later save.
- **Sealing: at least the proofs' protection, libraries only.** A random 32-byte journal key
  (sodium `randombytes_buf`, held in secure memory) is wrapped with NIP-44 to the user's own
  pubkey through the signer, which is exactly how NIP-60 protects the proofs. Every write is
  sealed with XChaCha20-Poly1305 (sodium, the key file's AEAD) under a fresh 24-byte nonce, with
  the header (format, version, pubkey, wrapped key) as associated data. The signer is asked once
  per open (to unwrap) or once per identity (to wrap a new key), never on the payment path. A
  NIP-46 signer is therefore not asked for a relay round trip before every PAY. That round trip
  was decision 7's reason for keeping the journal in memory. Measured on this laptop (ZFS): about
  8 ms per durable save for one pending send, 11 ms with three unpublished events.
- **Recovery.** `MoneyPlane.open` loads the journal, merges its unpublished events into what the
  relays hold (and publishes them again), and, when entries are left, runs
  `Wallet.recoverPending` in the background (`MoneyPlane.recovery`). Every operation at a mint
  settles it first anyway.
- **A journal that does not open fails loudly and is kept.** This covers a bad header, another
  identity, a key the signer cannot unwrap, a tag that does not verify, a body that is not
  exactly a journal (every entry is checked with core's `isPendingOp`, now shared with the
  daemon's `FileProofStore`; every outbox event is signature-verified, by us, of a NIP-60 kind),
  or a file past 32 MiB. `open` throws `journal-unreadable`, writes nothing, and the wallet does
  not open. It never starts without the journal: an unreadable entry may be money. The host logs
  an error, and the unavailable wallet says the journal is unreadable, not "no wallet". A
  symlinked file, a file owned by another user, or a file others can read is refused the same
  way.

### (b) Melt change is journaled

A melt is prepared with cashu-ts `prepareMelt` (NUT-08 blanks) and journaled as a `melt`
`PendingOp`: `keep` holds the blanks, `spends` the inputs, `key` the quote id. Only then is the
request sent (`completeMelt`). The cases:

- a refusal (a mint error code) drops the entry and reconciles the inputs, as before;
- a lost answer restores the change by NUT-09. A blank's amount is the one the mint assigned when
  it signed it, so a restored signature's amount is the mint's, checked by its DLEQ against the
  key for that amount. Every other kind still requires the journaled amount;
- a melt the mint reports `PENDING` keeps its entry. Its change is restored once the mint signs it;
- with no signatures, the inputs' NUT-07 state decides:
  - PENDING: wait, however old the entry;
  - all SPENT after `PENDING_SETTLE_AFTER_S`: paid with no change, committed as paid;
  - anything else after the wait: dropped like a send the mint never saw;
- a second melt of a quote whose first is unresolved is refused locally;
- a retry after recovery returns the first melt's result without paying twice;
- a melt with nothing to come back (no blanks) is not journaled.

`FileProofStore` (the daemon, whose `melt` CLI goes through it) reads melt entries too.

### (c) Held inputs are out of the balance

`CashuWallet.balance` (and so `balances()`, the change events, and the desktop's header chip)
subtracts the inputs of every journaled operation that spends: a send or a melt. They are held
out of every new selection, as before, and out of the balance, because they are not spendable
until the mint answers. They come back if the mint never executed the operation, and leave with
it if it did, exactly once. A failed send now emits a balance event too. The daemon's payout,
which sends "the whole balance", no longer tries to spend held inputs.

### Consequences of the amendment

- Tests:
  - crash injection across a real process kill: the host's money plane in a child process,
    SIGKILLed after the mint executed and before its answer, for a send and a melt, then
    recovered by a new process;
  - a damaged journal (refused, byte for byte kept, then recovered from its original bytes);
  - the sealed file's every failure mode;
  - melt change on the test mint and on Nutshell 0.21.0 and cdk-mintd 0.18.1;
  - held inputs across both outcomes.
- Each desktop operation now costs up to three sealed writes (begin, result, and the outbox
  shrink once the relays took the events).
- Residual [Low]:
  - a result commit whose journal write fails after the mint executed leaves the entry on disk.
    The keep outputs come back at the next settle, but a send's locked outputs reach nobody
    (they are the recipient's, and the recipient never got them);
  - melt blanks at a mint without NUT-12 take the mint's amount on trust: a lying mint could
    hand us a proof it will not honour, which is no worse than any mint refusing to honour its
    proofs;
  - the journal key passes through the signer's NIP-44 as a hex string, which cannot be wiped
    (the NIP-60 wallet key's limit).

### After the independent review (same day)

- **Held inputs come back by themselves.** A settle used to run only inside an operation at that
  mint or once at open, so a wallet whose whole balance was held could start no operation (the
  playback gate reads the balance first) and got nothing back before a restart. The desktop's
  money plane now runs `SettleLoop` (`core/src/wallet/settle-loop.ts`): `recoverPending` at an
  entry's `created + PENDING_SETTLE_AFTER_S` (+5 s), overdue entries (a melt still PENDING, a
  mint that could not be asked) retried after 30 s doubling to 10 min, re-planned on every
  balance event but only ever earlier. The daemon settles at every receive, which each flush
  runs.
- **The outbox keeps deletions behind their token.** A compacted token's replacement takes its
  place in the outbox, ahead of every deletion it covers, so a drain that fails part-way never
  leaves the relays with an old token deleted and no token holding its proofs.
- **Refusals cashu-ts wraps are refusals.** A keyset refusal (12xxx, thrown as a
  `StaleKeysetError` with the code in its `cause`) drops the entry at once, like any coded answer.
  A coded `cause` under any other error does not: cashu-ts's `MeltChangeError` means the melt went
  through, and its change is restored by NUT-09. (This bullet first named a 429 too; fix round 2
  below reverses that.)
- **A paid quote answers paid.** A melt of a quote the mint reports PAID (a retry after the
  startup settle restored its change) returns `paid: true` without a request. Recovered entries
  are matched by kind as well as key.
- Deferred [Info]: the journal grows by about 3 KB an operation during a relay outage, and at
  32 MiB commits fail closed until the relays take the events.

### Fix round 2 (same day): one attempt per request, and a 429 is ambiguous

An independent verifier found that the 429 rule above could lose money on the desktop, and
reproduced it on cdk-mintd 0.18.1. The money plane gave `CashuMintConnections` no request
function, so cashu-ts used its own fetch transport. That transport retries `/v1/swap`,
`/v1/melt/bolt11` and `/v1/mint/bolt11` after a network error or a 5xx, up to 9 times within the
ttl, whenever the mint advertises NUT-19 (cdk-mintd does, ttl 60). If the first attempt executed
and its answer was lost, a rate limiter could answer the retry with 429. The wallet then dropped
the entry and reconciled the inputs away, and the outputs the mint had signed were lost.

- **Every production transport sends each request once.** The desktop money plane now uses
  core's `cashuRequestFn` over `node:http(s)` (`host/mint-transport.ts`), the same
  implementation as the daemons and the gateway. `httpModuleRawHttp` moved from the seeder into
  core for this. The host and the seeder runtime fall back to it for any mint an injected (test)
  transport leaves out. So cashu-ts's retrying transport is reachable only from opt-in real-mint
  tests. Over a custom transport, cashu-ts sends a swap, melt or mint once: its keyset repair does
  not resend, and the NUT-20 legacy fallback resends only after a coded 20008 refusal.
- **A coded answer stays a refusal because of that.** A coded answer, or a `StaleKeysetError`
  with a coded `cause`, is the mint's answer to our one request.
- **A 429 is not a refusal.** A transport may retry, and the wallet cannot tell a limiter's 429
  before the request from one on a retry of a request that executed. So a 429 is resolved like a
  lost answer: the inputs are held, NUT-09 restores what the mint signed, and after the wait NUT-07
  decides. A 429 on a request that never ran therefore holds its inputs, and locks a melt's quote
  locally, for `PENDING_SETTLE_AFTER_S`. That is the cost finding 4 had removed, taken back
  deliberately.
- **The settle loop backs off from a mint it cannot decide.** `recoverPending`'s `left` now
  counts every entry still journaled, a skipped mint's included. Before, a mint whose wallet did
  not load (or that stopped offering NUT-09) read as progress, and the loop retried every 30 s
  for ever.

### Fix round 3 (same day): no retrying default, and a melt gets time to pay

The verifier of fix round 2 found one low and one info finding. Both are fixed.

- **`CashuMintConnections` has no retrying default any more.** With no request function, or one
  answering `undefined` for a mint, it used to build a cashu-ts `Mint` with no custom transport,
  so cashu-ts's retrying fetch transport was one omission away. A coded answer to a retry drops
  the entry: the verifier lost 64 sat to an 11001 on a retried swap. The default is now
  `cashuRequestFn` over `fetch` (`fetchRawHttp`), one attempt per request. It has the same bounds
  as the Node transport. It works in Node and in browsers, so no caller can reach the retrying
  transport through this class. The Node wallets still pass `node:http(s)`: the daemons run
  `--jitless`, where `fetch` (undici's WebAssembly parser) crashes. This replaces round 2's "so
  cashu-ts's retrying transport is reachable only from opt-in real-mint tests": it is reachable
  from none.
- **A melt gets 300 s.** Round 2's transport gave every request 30 s for the whole exchange.
  cashu-ts passes no timeout for `POST /v1/melt/bolt11`, where the mint pays the invoice before
  it answers. A Lightning payment of 30 to 60 s or more (Nutshell's LND backends allow 60 s) was
  cut off. Such a melt read as unknown and was held until the settle loop decided it. With no
  change blanks (a fee reserve of 0), the user was told "melt failed" for an invoice that then
  got paid. `cashuRequestFn`
  now gives `POST …/v1/melt/{method}` 300 s, what undici gave cashu-ts's transport before round 2.
  Quotes, quote checks, swaps and mints keep 30 s. The daemons get the same, through the shared
  `cashuRequestFn`.
