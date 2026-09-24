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
