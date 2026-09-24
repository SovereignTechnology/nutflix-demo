# Pre-push review — seeder payout and wallet encryption at rest (2026-09-24)

Diff: `stage-3/seeder-runtime` (`22b9dd5`) → `stage-3/seeder-payout`. Method: the
`differential-review` checklist and `sharp-edges` questions, run inline by the session that
wrote the change (a self-review; the tests that must fail without each guard are its only
independence).

## Scope

HIGH risk (value transfer, keys, money at rest):

- `packages/seeder/src/runtime/payout.ts`: an irreversible send of the whole balance to a key from
  a config file.
- `runtime/proof-file.ts`: the wallet file is sealed with NIP-44 through the signer.

MEDIUM: `cli/config-file.ts` (`payout` section), `runtime/index.ts` (wiring, the payout-to-self
refusal, shutdown order).

LOW: docs, tests.

## Adversarial questions

- **Can a payout go to the wrong key?**
  - The key comes only from the config file (root-owned, 0640, read-only to the daemon; whoever
    can edit it already owns the host).
  - A typo or mix-up is caught before anything leaves: the owner's own kind 10019 must name the
    same key. It is signed by `payout.pubkey`, verified at the boundary (`verifyIncoming`), and
    only the owner's signature counts: a 10019 re-signed by someone else under the owner's
    pubkey is dropped (tested).
  - A relay can withhold the 10019 (payout waits, money stays on the server) or serve a stale one
    (payouts stop). Neither misdirects.
  - A payout naming the node's own keys is refused at start.
  - Mutation checked: without the gate, the "another key stops payouts" test fails.
- **Can a payout happen twice?** One run at a time: concurrent calls share the run (tested). The
  balance leaves the wallet in the same commit that produces the locked set, so a later run sees
  what is left. A republish signs a new event for the same proofs; if the first publish had in
  fact landed, the owner's second redeem fails as spent (harmless).
- **Can a payout be lost?**
  - A set no relay accepted stays in `payouts.jsonl` (fsynced before the publish) and is
    published on the next run, also by a new process after a restart (tested).
  - Residual: a crash between the mint's swap and that append (F31 class; NUT-13).
- **What does the public see?** A payout nutzap links the seeder's pubkey to the owner's and
  shows the amount. Documented in the README, with the advice to use a dedicated wallet pubkey.
  Viewers are never named.
- **Encryption at rest.**
  - The key never leaves the signer (`nip44Encrypt(ownPubkey, …)`), and no crypto is written
    here.
  - Each chunk carries `index/count` inside its ciphertext. A flipped byte (MAC), a dropped,
    swapped or reordered chunk, or another node's key all stop the daemon without touching the
    file (tested). In practice a reordered or truncated document would also fail to parse as
    JSON; the index check is defence in depth for the cases where it would not.
  - Downgrade: someone with write access can replace the sealed file with a plaintext one, which
    is read and resealed (with a warning). That can hide or inject proofs but not reveal the
    sealed ones; write access could destroy the file anyway.
  - It does not protect a live compromise (the key is unlocked in the process). That is stated in
    the ADR, together with the real mitigation: payout keeps little on the server.
- **Cost.** Measured under the unit's `--jitless`: NIP-44 at 200 ms per 60 KB chunk (26 ms with
  the JIT), on the event loop. The whole file is resealed per commit, so the history went from
  1000 to 100 lines, which puts a typical file at ~40 KB (~130 ms per flush). Moving crypto off
  the event loop belongs with F5.

## Found by this review and fixed before commit

| # | Where | Finding | Fix |
|---|---|---|---|
| P1 | `payout.ts` | A payout to a mistyped `p2pk` would lock the money to a key nobody holds, and it is irreversible | the owner's kind 10019 must confirm the key first (fail-safe on mismatch, withheld or stale) |
| P2 | `proof-file.ts` | Resealing a 1000-line history per commit stalled the event loop ~0.8 s under `--jitless` | history cut to 100 lines; cost documented (ADR 0011 §2) |

## Residual

- The crash window between the payout swap and the log append (NUT-13).
- The owner must run a NIP-61 wallet that publishes a kind 10019 on the payout relays. Without
  one, payouts wait (the money stays on the server, safely, but stays).
- A payout recorded in `payouts.jsonl` that the owner's wallet never picks up can be recovered
  only by hand. A CLI that prints it as a cashu token would help.
- `pending.json` is not encrypted: its hook is synchronous and the signer is not, and its proofs
  are still P2PK-locked.

## Tests

- `npm run ci` green: 148 files passed, 2 skipped; 2401 tests passed, 7 skipped.
  `check-locked-dirs` OK.
- New:
  - payout (7): threshold, the owner redeems, a 100 ppk fee, a refused publish retried after a
    restart, the 10019 gate (mismatch, missing, forged), one run at a time, config.
  - encryption (2): sealed at rest with tamper cases; plaintext resealed.
  - payout-to-self refusal.
  - the swarm integration test's payout case (the owner redeems after a real flush).
  - the built entry under the unit flags with a payout block (the 10019 lookup over the `ws` pool
    runs, nothing is paid, the daemon keeps running).
