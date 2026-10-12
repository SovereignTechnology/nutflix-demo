# Lane C1-residuals — the small Stage 3 residuals (cloud session, 2026-10-02)

Branch `claude/focused-hamilton-6573si`, restarted from `main` at `de86d72` after
SovereignTechnology/nutflix-demo#1 merged. Run by a Claude Code cloud session under Cameron's
2026-10-02 decisions (status.md, Stage 3 inputs 20–31): tests run in the cloud container and in
GitHub Actions; the container runs as root and has no DHT networking, so the hyperswarm
integration tests and three unwritable-ledger cases fail there by environment (they pass in CI).

No contract request, nothing under `packages/core/src/contracts/` or the locked paths.

## What and why

### R9 — Bare's state files never synced their directory

`bareStateFs.writeAtomic` (`packages/app-desktop/src/worker/adapters/bare.ts`) wrote
`<path>.tmp`, fsynced it and renamed it, with no fsync of the directory: after a power loss the
rename could be lost and the old file come back (the unpaid record, the pending-PAY journal's
compactions). Now, like the seeder's Node twin (`packages/seeder/src/runtime/files.ts`):

- a failed rename removes the tmp file and rethrows;
- a successful rename is followed by a best-effort directory fsync (a filesystem, or Windows,
  that refuses one is not an error: the file's bytes are already synced);
- `appendDurable` syncs the directory only when its append created the file, so the per-PAY
  journal append costs no extra fsync.

Checked under bare-sidecar's prebuilt `bare` on Linux: `bare-fs` opens a directory read-only and
fsyncs it (a one-off probe, not kept). Test: `worker/__tests__/bare-state-fs.test.ts` fakes the
`bare-*` modules (they cannot load under Node) and pins the call order; 3 of its 4 cases fail on
the unfixed code (the fourth — a refused directory fsync is not an error — guards the fix).

### RR-1 — the payer's clock under Bare was a steadied wall clock

Bare has no `performance`, so `UpstreamPayer`'s `monotonicClock` fell back to `Date.now()` made
steady: never backwards, but a forward step of the system clock under `MAX_CLOCK_STEP_MS` (8 s)
per read still counted toward a give-up. Now `WorkerRuntime.monotonicNow` is required: Bare
supplies `bare-hrtime` (libuv's `uv_hrtime`, monotonic; whole microseconds before `Number()`,
exact for centuries of uptime), Node `performance.now()`. `ViewerPayer` takes an optional
`clock` and passes it to `UpstreamPayer`; the worker host passes the runtime's.

Tests: `viewer-payer.test.ts` "RR-1" — with a clock that stands still, a failure lasting a fake
minute is not given up (it fails without the pass-through: the payer read the faked
`performance.now()` and gave the block up); the day-1 probe gains a `runtime: monotonic clock`
step, run under Node (`server.test.ts`) and under the real Bare (`bare-probe.test.ts`).

## Native-module review

`docs/native-modules.txt` changed in one line: `bare-hrtime@2.1.2` is now pulled
`via @sovit/app-desktop>bare-hrtime` (a direct, exact-pinned dependency) instead of
`via @sovit/app-desktop>bare-http1>bare-hrtime`. Same package, same version, same lockfile
entry and integrity, already shipped in the packaged worker through `bare-http1`: no install lifecycle script
(its `package.json` `scripts` are `format`, `lint` and `test` only), prebuilds only (`prebuilds/<platform>/`), a `CMakeLists.txt` and
`binding.c` for rebuilding (nothing compiles at install). Accepted with
`scripts/native-module-inventory.sh --accept`.

## Residuals (unchanged here)

- `StateFs.rename` (the seen-secret log's rotation) still does not sync its directory: a lost
  rotation loses at most the rotated log, and the mint still catches a replay.
- Windows: a directory cannot be opened for fsync there; the rename's durability rests on NTFS.
