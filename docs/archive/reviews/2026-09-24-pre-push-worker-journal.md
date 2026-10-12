# Pre-push review — the worker's pending-PAY journal (2026-09-24)

Diff: `stage-3/external-links` (`0f80427`) → `stage-3/worker-journal`. Method:
`differential-review` and `sharp-edges`, inline.

## Scope

- MEDIUM (durability of accepted payments):
  - `seeder/src/payment/pending-journal.ts` (new, runtime-neutral: the logic moved out of
    `runtime/engine-state.ts`);
  - `engine-state.ts` (`PendingJournal` now wraps it; same API, files and behaviour);
  - `app-desktop/src/worker/pay/real-providers.ts` (journal, migration, cap);
  - `worker/runtime.ts` + `adapters/bare.ts` (`StateFs.appendDurable`, `remove`);
  - `worker/host.ts` (`accepting` to the `Seeder`).
- LOW: `portable.ts` exports, tests, docs.

## Adversarial questions

- **Durability before the ACK.** The worker's `appendDurable` opens, writes everything, fsyncs,
  then closes. The engine's `persistPending` is synchronous, so the ACK follows the fsync. A
  failed append throws and is logged; the engine swallows it, as before.
- **Refactor regressions.** The daemon's journal code moved verbatim into the core:
  - line format, key, compaction threshold and torn-tail rule are unchanged;
  - the daemon keeps its open descriptor, with append + `fsyncSync`, and rewrite as close +
    atomic write + reopen.
  - All 183 seeder tests pass unchanged, including the journal's compaction, torn-tail and
    migration tests.
- **Migration.** The journal is written (compacted) before the old `pending.json` is removed, so
  a crash between the two leaves both. The next start then reads the journal and ignores the old
  file. An unreadable journal refuses payments ("payments stay off rather than drop them"),
  tested.
- **Cap.** 1024 for one user's node. `accepting` goes to the `Seeder` like the daemon's, so a
  full queue cuts sessions locally, with no ban. An injected 0 fails closed (tested).
- **Bare safety.** The neutral module imports only a type from `@sovit/core` and uses no
  `node:*` or globals beyond JSON. It is exported from `portable.ts` (entry hygiene tests pass).

## Found and fixed before commit

- The unreadable-journal error now keeps its cause (lint `preserve-caught-error`).

## Tests

- Seeder `pending-journal.test.ts` (3): only changes are appended and replay round-trips; it
  compacts; torn tail versus damage.
- Desktop `real-providers-journal.test.ts` (4): a fresh journal and serving below the cap; the
  cap reaches the seeder; migration; an unreadable journal refuses.
- Existing: the daemon's journal tests, and the desktop real-payments integration
  (`desktop-pays.integration.test.ts`), unchanged and green.
- Mutations (all caught): replay errors swallowed; no compaction at open.
