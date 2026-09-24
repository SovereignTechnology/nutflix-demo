# Pre-push review — the seeder daemon runtime (2026-09-24)

Diff: `stage-3/real-mint` (`e6e9bf6`) → `stage-3/seeder-runtime`. Method: the
`differential-review` checklist and `sharp-edges` questions, run inline by the session that
wrote the change (a self-review: the cold re-read of each changed function, and the tests that
had to fail without each fix, are its only independence).

## Scope

HIGH risk (keys, money at rest, external calls):

- `packages/seeder/src/runtime/identity.ts`: key-file unlock, passphrase from
  `$CREDENTIALS_DIRECTORY`, `--keygen`.
- `runtime/proof-file.ts`, `runtime/engine-state.ts`, `runtime/files.ts`: the wallet's proofs,
  pending PAYs and seen secrets on disk.
- `runtime/mint-http.ts` + `core/src/wallet/transport.ts`: every mint request.
- `runtime/nostr-publish.ts`: nutzaps (creator money) and kind 10019.
- `runtime/index.ts`: composition, the state lock.
- `core/src/signer/local.ts`: `walletP2pk` (locked audit surface).

MEDIUM: `runtime/pay-wiring.ts`, `runtime/keysets.ts`, `Seeder.onSessionReady`,
`cli/{main,daemon,providers,config-file}.ts`, `adapters/*/process.ts` (`readStdin`), the unit's
`LoadCredentialEncrypted=`.

LOW: docs, tests.

## Adversarial questions asked of each change

- **Can the passphrase or a key reach a log, argv, the environment or disk in clear?**
  - The passphrase is read only from the credential file (start) or stdin (`--keygen`, and a
    terminal is refused). It is wiped after use, and the config parser refuses
    `identity.passphrase`, `nsec` and `secretKey`.
  - Tests assert the passphrase never appears in the output: unit, CLI, and the built entry
    under the unit's flags.
  - Only the node's public key is logged, under `publicKey`, the redactor's own-key field.
- **Can a peer make the daemon contact an arbitrary host?**
  - The keyset hook is called only for mints in the accepted ∩ policy set (engine), and relays
    are config only.
  - The mint transport never follows a redirect (tested with a 302 to a link-local address).
  - A peer naming random keyset ids spends at most a 4-token bucket per mint.
- **Can a peer make the daemon ban an honest viewer?** An empty keyset bucket answers
  `unknown keyset`, which the engine refuses without a ban.
- **Can money be lost at rest?**
  - `proofs.json` and `pending.json` are rewritten atomically with fsync. An unparseable one
    stops the daemon rather than being overwritten (tested).
  - `pending.json` is on disk before the ACK; a crash before the flush is recovered by the next
    runtime (integration-tested over real hyperswarm).
  - Proofs in `pending.json` are still P2PK-locked (useless without the key file). Those in
    `proofs.json` are bearer: see residuals.
- **Can two daemons share one wallet?** See R6 and R7 and the residual.
- **Is the creator paid, and is anyone exposed?**
  - The nutzap names the creator (`p`), mint (`u`) and video (`e`), and carries the proofs with
    their DLEQ but never a witness. The creator redeems it (integration test).
  - The viewers whose PAYs it forwards are never named (tested).
  - Publish failure keeps the PAYs queued.
- **`walletP2pk` in the signer.** It derives the public half of the wallet key with cashu-ts
  `getPubKeyFromPrivKey`, once, at construction. It is public data and is kept after `lock()`.
  It adds no signing path: `signSecret` still signs only NUT-10 P2PK secrets.

## Found by this review and fixed before commit

| # | Severity | Where | Finding | Fix | Test that fails without it |
|---|---|---|---|---|---|
| R1 (security review **F36**) | **High** | every mint request | Node 22's global `fetch` is undici, whose parser is WebAssembly; under the unit's `--jitless` the first mint request **crashes the process** (reproduced; MDWE-RESULTS.md §7). The daemon would have died at its first PAY. Every money-path test ran in vitest, never under the unit's flags | `wallet.cashuRequestFn` (cashu-ts's `RequestFn` error contract over an injected raw call) + `mint-http.ts` (`node:http(s)` via `createRequire`); the daemon loads every accepted mint at start. Verified under the unit's flags against Nutshell 0.21.0: fund, P2PK send, receive, and a replay reads as `spent` | `entry.test.ts` (built entry, unit flags, a mint over real HTTP): with the default transport it dies with `WebAssembly is not defined` — **run** |
| R2 | Medium | `mint-http.ts` | An oversize body or a stall after the response started called `req.destroy(err)`, which then does not reach the handlers: an **unhandled** error, and `end` resolved a truncated body as success | settle first, then `destroy()` without an error | `runtime-units` "never follows a redirect … oversize … times out" — **found by that test on its first run** |
| R3 | Medium | `engine-state.ts` | `seen.jsonl` was compacted only at start; a busy seeder appends hundreds of secrets a second (GB per day) | `SeenLog` rotates to `seen.jsonl.1` every `capacity` lines: at most 2 × 250 000 on disk | `runtime-units` "rotates every `capacity` lines" (by construction: the old code had no rotation) |
| R4 | Low | `files.ts` | A leftover `.tmp` was opened with `w`: it kept its old mode, and a symlink planted there was followed (the wallet JSON written through it, the symlink renamed over the wallet) | remove the `.tmp`, create it `wx` | `runtime-units` "a leftover .tmp … never written through" — **run**: the old code writes the wallet into the symlink's target |
| R5 | Low | `runtime/index.ts` | An existing `wallet/` directory kept whatever mode it had | `chmod 0700` after `mkdir` | built-entry test asserts 0700 |
| R6 | Low | state lock | A lock naming our own pid counted as stale (needed after a reboot), so a second runtime in the same process could take over a live lock; the public `pid` option was a test seam that could fake it | an in-process registry refuses a second holder; the `pid` option is gone; the cross-process case is tested with a real live child process | `runtime-units` "a lock held by a live process is refused; a second runtime in this process is refused …" |
| R7 | Low | state lock | Two starts racing over one stale lock can each remove it and create their own | re-read after creating; the loser refuses. Narrows, does not close: see residuals | — |

## Residual (recorded, not fixed here)

- **Pending queue during a mint outage.**
  - While the mint is down, accepted PAYs cannot be redeemed, the engine's queue grows without
    bound, and `pending.json` is rewritten whole on every change. That is quadratic disk
    traffic, and eventually the daemon stalls.
  - Normal operation keeps the queue small (a flush every 64 blocks / 60 s).
  - Fix later: an append-only pending journal, plus an engine cap that refuses new PAYs above N
    queued (an engine change). Worth a `stage-3` issue.
- **A failed wallet commit after a successful swap loses that swap's output.** This is the
  F31 / NUT-13 residual; `spend.ts` commits before returning. Deterministic outputs (NUT-13) with
  NUT-09 restore are the fix.
- **`proofs.json` is bearer ecash.** File mode, `StateDirectoryMode=0700`, the dedicated user
  and `ProtectHome`/`ProtectSystem` protect it (ADR 0011 §2, question for Cameron).
- **State-lock race (R7).** Only two daemons started at the same instant over a stale lock can
  both win, and then only if they also use different `storageDir`s (Corestore's own lock stops a
  shared one). Node has no `flock`.
- **The seen set covers minutes, not days, on a busy seeder** (250 000 secrets). Older replays
  are refused at the mint on their first redeem, with a ban (the F31 first-attempt rule). That
  costs the seeder up to one window of blocks per replay.
- **Nutzap relays** are the configured ones. The creator's own kind 10019 relays are not
  consulted yet, so the creator must read one of them.
- **Melt-out is not wired** (ADR 0011 §7.4).

## Tests

- `npm run ci`: 147 files passed, 2 skipped; 2390 tests passed, 7 skipped. `check-locked-dirs`
  OK (the signer and `wallet/transport.ts` import only allowed modules).
- New: config fields and refusals; the runtime's parts (21); the transport (6); the built entry
  under the unit's flags (`--keygen` from a pipe, a real start with a credential directory, a
  mint over HTTP, READY, clean SIGTERM); the runtime over real hyperswarm with the TestMint (2).
- Mutation checks run:
  - Without `onSessionReady` on the swarm path, the integration test times out waiting for the
    daemon's HELLO.
  - With cashu-ts's default transport, the built entry dies (R1).
  - The old `.tmp` handling writes through the symlink (R4).
- Real mint: the wallet over `cashuRequestFn` + `nodeRawHttp` under `--jitless` against
  Nutshell 0.21.0 on 127.0.0.1:3399 (manual; the repo's real-mint suites stay opt-in).
