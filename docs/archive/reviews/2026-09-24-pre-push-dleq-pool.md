# Pre-push review — DLEQ checks off the event loop (2026-09-24)

Diff: `stage-3/desktop-signer` (`2f5b682`) → `stage-3/dleq-batching`. Method: the
`differential-review` checklist and `sharp-edges` questions, inline, by the session that wrote the
change.

## Scope

- HIGH (the locked audit surface, verification of payment):
  - `core/src/payment/engine.ts`: `PaymentEngineDeps.dleq`, a third decision phase
    (`need-dleq`), `proofDleqOk` exported.
- MEDIUM:
  - `seeder/src/runtime/dleq-pool.ts` + `dleq-worker.ts` (the pool);
  - `runtime/index.ts` (wiring; `dleqThreads`, `dleqWorkerUrl`).
- LOW: tests, docs.

## Adversarial questions

- **Can a PAY be accepted without a valid DLEQ?**
  - Only if the injected verifier says `true` for a bad proof. The pool runs core's own
    `proofDleqOk` (the same function the inline path uses), and answers must match the call's
    length or they are discarded.
  - A throwing, timing-out, crashing or miscounting worker leaves the answer map empty, and the
    engine then runs `dleqOk` itself for every proof.
  - Tested: a verifier answering `false` bans (forgery); a throwing one and a short answer both
    fall back, and a forged PAY is still refused on the fallback. The mutation that ignores the
    answers fails the tests.
  - An embedder's own lying verifier is outside the model: it runs in the seeder's process with
    the seeder's authority.
- **TOCTOU across the await.**
  - The decision is recomputed from scratch on the answers: ban, epoch, carry, amounts, ranges,
    locks, and the double-spend set all run again, and acceptance commits in the same tick.
  - `verify` stays serialised per peer.
  - Tested: a peer that blows its window while its PAY is being checked is refused `peer-banned`.
- **Answer mix-up between proofs.** Answers are keyed by
  `mint|keyset|amount|C|secret`. A duplicate secret inside one PAY is refused anyway (the local
  double-spend check), so two proofs cannot share a key and an answer.
- **CPU amplification.** Unchanged: the cheap checks (caps on proofs per set, amounts, ranges,
  locks' shape) still run before any DLEQ work. The pool bounds concurrency to its size, and a
  flood queues in the workers instead of stalling every session's event loop.
- **Data to workers.** Proofs and one public mint key per proof — no secrets, no wallet key. The
  worker never logs.
- **Process flags.** Workers inherit `--jitless` (tested under the unit's own `ExecStart` flags).
  Found while verifying: Node refuses `--jitless` passed explicitly in `execArgv`, so an
  inherit-and-filter approach was dropped. Started from `node -e`, workers cannot load; they
  error and the engine checks inline (safe, and only ad-hoc runs start that way).

## Found and fixed before commit

| # | Severity | Finding | Fix |
|---|---|---|---|
| Q1 | Low | A worker-argv filter written first (to keep `-e` out) split two-token flags (`--conditions node`) and passed `--jitless` explicitly, which Node refuses — every worker failed and everything fell back inline | Removed: default inheritance, documented |
| Q2 | Low | The runtime's integration test ran from sources, where the pool is off, so the real pool never saw real PAYs | `dleqWorkerUrl` seam; the daemon integration pays through the built pool and asserts it ran |

## Residual

- Explicit `minPaySats` batching: with F37 (the credit pool in the shared payer; batching
  against the desktop's global pool can deadlock).
- The desktop's Bare worker checks inline (single user; `bare-worker` would be a new native
  dependency).

## Tests

- New: `seeder` `dleq-pool` (6):
  - answers equal `proofDleqOk`;
  - the event loop keeps ticking during a 64-proof batch;
  - crash / silent / miscounting workers reject;
  - a closed pool fails pending work;
  - the pool works in a child process started with the systemd unit's flags.
- New in core `engine` (4): one call per PAY with per-amount keys; `false` bans; fallback on a
  throw or a wrong count; state moved during the await.
- The daemon integration test pays through the built pool.
- `npm run ci` green: 161 files passed, 2 skipped; 2590 tests passed, 7 skipped; all gates OK.
