# Pre-push review — the wallet journal and NUT-09 restore (2026-09-24)

Diff: `stage-3/nut20-quotes` (`30f92fb`) → `stage-3/wallet-journal`. Method: `differential-review`
and `sharp-edges`, inline.

## Scope

- HIGH (value transfer, a locked audit dir):
  - `core/src/wallet/spend.ts`:
    - send, receive and mint journal their outputs before the request;
    - `settle` / `resolve` / `restoreOp` (NUT-09);
    - `afterFailure`;
    - `recover`, `recoverMint`;
    - pending sends' inputs are kept out of send and melt selection.
- MEDIUM:
  - `core/src/wallet/store.ts` (`PendingOp`, `WalletTx.begin` / `settle`, `ProofStore.pending`,
    the memory journal);
  - `wallet.ts` (clock to the spender, `pollQuote` recovers an ISSUED quote, `recoverPending`);
  - `nip60.ts` (in-memory journal; journal-only commits publish nothing);
  - `seeder/src/runtime/proof-file.ts` (the journal in the sealed file, validated on open);
  - `runtime/index.ts` (startup sweep).
- LOW: `core/src/mocks/test-mint.ts` (NUT-09: signatures remembered, never signed twice,
  `/v1/restore`), tests, docs.

## Adversarial questions

- **A mint that lies in `/v1/restore`.**
  - Signatures are matched to OUR blinded messages by `B_`; anything else is ignored.
  - Each signature must name the output's keyset and amount, and carry a DLEQ wherever the mint
    supports NUT-12 (tested: a stripped DLEQ commits nothing and the entry stays).
  - cashu-ts `toProof` verifies that DLEQ with our blinding factor. A swapped same-amount
    signature therefore fails the DLEQ instead of producing a bad proof.
  - A malformed list throws; the entry stays, and no proofs are added.
- **A mint that claims a send ran when it did not.** To "claim" it, the mint must sign our
  outputs. We then hold valid proofs for them, and a mint that signs without spending the inputs
  is giving value away. It cannot make us drop inputs without signatures, and without signatures
  a send's inputs are reconciled by NUT-07 only after the settle wait.
- **Misreading a failure.**
  - Only a mint-answered 400 `{code, detail}` (`MintOperationError`) counts as "refused, nothing
    ran" (`isDefinitive`, checked against the transport and the cashu-ts error classes). A reset,
    timeout, 5xx, 429 or `NetworkError` is ambiguous, so the wallet restores.
  - "Already signed" (10002) and "already issued" (20002) are mint codes but are treated as maybe
    ours.
  - A wrong "definitive" would drop the entry and reconcile, which is the pre-journal behaviour.
    It is never worse.
- **Double counting.**
  - An entry is settled atomically with the proofs it produced. A recovered op is gone before any
    retry sees it.
  - A retry reuses the same outputs, so the mint cannot sign them twice (10002 in the test mint,
    as in Nutshell and cdk).
  - The startup sweep plus the engine's retry counts the value once (engine test).
  - The real-mint test checks at the mint: the recipient's proofs are unspent and the set spent.
- **Selecting maybe-spent proofs.** An unresolved send's inputs are filtered from send and melt
  selection (tested). They are only freed once NUT-07 says they are unspent after
  `PENDING_SETTLE_AFTER_S`, or once restore shows the op ran.
- **Dropping an entry whose request is still in flight.** Entries with no trace are dropped only
  after 10 minutes. The daemon's and gateway's transport (`cashuRequestFn`) times out at 30 s, so
  none of their requests outlives the wait. The desktop uses cashu-ts's default fetch; its journal
  lasts only the session anyway.
- **Unbounded journal.**
  - Receive and mint retries reuse their entry (same key).
  - Sends are bounded by the proofs they hold out of selection.
  - A mint without NUT-09 journals nothing, so it can never block proofs forever.
  - Worst case, a mint that answers every restore with junk keeps its entries, and each
    operation there costs one restore request per entry.
- **Secrets at rest.**
  - Journal entries hold secrets and blinding factors: bearer ecash once signed.
  - `FileProofStore` seals them with the proofs (NIP-44 to the node key, fsynced), and a damaged
    entry refuses the start (tested) rather than being silently dropped.
  - The NIP-60 and memory journals never leave the process.
  - No journal content is logged or put in an error message. Errors carry codes and counts;
    `recoverPending` logs counts only.
- **The key.** The NUT-20 key is lent only to `prepareMint`, which computes the signatures.
  `completeMint` never sees it (its legacy fallback uses the signature prepared then).
- **Locked-dir rules.** `spend.ts` imports only `@cashu/cashu-ts` and relatives. No
  cryptography of its own: serialize, deserialize, restore and unblind are cashu-ts calls.

## Found and fixed before commit

- Restored signatures were first accepted without a DLEQ on a NUT-12 mint (live answers are
  refused for that). They now meet the same rule.
- `structuredClone` is not guaranteed in every runtime core runs in (the Bare worker), so the
  journal copies are JSON copies.
- The five older lost-answer tests encoded the pre-journal loss. They now run on a mint without
  NUT-09, where that behaviour still applies, and new tests cover the journaled path. No test or
  assertion was removed.

## Residual

- [Low] The desktop's journal is in memory, so a crash between a lost answer and its recovery
  loses that operation's outputs, as before.
- [Low] Melt change is not journaled.
- While a send is unresolved, its inputs still count in the balance.
- Decision for Cameron: NUT-13 seed backup (ADR 0014, Consequences).

## Tests

- Core `wallet.test.ts`, "F31: a lost answer loses nothing" (7):
  - a lost send completes;
  - a lost receive is recovered;
  - a lost top-up is minted, and recovered by the next poll when restore was down;
  - a retried receive reuses outputs;
  - a never-seen send holds its inputs until the wait;
  - a DLEQ-less restore is refused;
  - no NUT-09 means no journal.
- Core `engine.test.ts` (3):
  - F31 with NUT-09 (no ban, creator nutzapped, balance restored);
  - a crash before recovery;
  - the startup-sweep order.
- Core `nip60.test.ts` (1): a journal-only commit publishes nothing.
- Seeder `runtime-units.test.ts` (3):
  - the journal survives a reopen;
  - a damaged entry refuses;
  - a crash-and-restart recovers from the mint.
- Real mints: `real-mint.integration.test.ts` F31 passes on Nutshell (3399) and cdk (3397), 6/6
  each (melt via the other mint). Gateway real-mint swarm: 3/3 each.
- Mutations (all caught):
  - no write-ahead;
  - no output reuse;
  - no busy filter;
  - no DLEQ rule;
  - no settle wait;
  - no ISSUED recovery;
  - no restore recovery.
