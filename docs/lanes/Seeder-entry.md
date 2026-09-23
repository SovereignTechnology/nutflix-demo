# Lane Seeder-entry — a real entry point behind `nutflix-seeder.service`

**Issued against `CONTRACTS_VERSION = 4`.** Date: 2026-09-23. Branch `lane/Seeder-entry`, base
`main @ 607abcc`. No contract change requested (`docs/contract-requests/Seeder-entry.md` does
not exist on purpose). Nothing here implements hashing, signatures, blinding or key derivation.

Follow-up 5 in `docs/status.md` ("`packages/seeder` ships no self-executing entry point, but
the unit points at `dist/index.js --config`") is done by this lane, with one catch the lane
found on the way: **the unit's own `--jitless` crashed the real entry on Node 22** (§4 below).

## 1. What was built

```
packages/seeder/src/
  index.ts             + isMainModule() and the main-module guard; exports main & friends
  cli/main.ts          NEW  main(argv, opts) → exit code; --config / --check / --help
  cli/config-file.ts   NEW  strict seeder.json parser + NUTFLIX_SEEDER_* overrides (pure)
  cli/providers.ts     NEW  Stage 2 seam: getRuntimeDeps() → undefined today
  cli/env.ts           NEW  env names + parsing rules shared with parseDaemonEnv (portable)
  cli/daemon.ts        doc comment rewritten; parseDaemonEnv uses cli/env.ts (stricter)
  __tests__/           NEW daemon-config, cli-main, entry, entry-import, entry-hygiene,
                       fake-process (helper); systemd.test.ts +1 case
deploy/systemd/
  nutflix-seeder.service   ExecStart += --no-experimental-websocket (the one unit change, §4)
  MDWE-RESULTS.md          §2 corrected, §4 decision block updated, new §6 (the finding)
  README.md                seeder now runnable / refuses 78 / --check; seeder.json example
```

The gateway's entry path is the model (`packages/gateway/src/index.ts` + `cli/{main,providers}.ts`
+ `config.ts`); names match it (`main`, `parseCliArgs`, `loadConfig`, `EXIT_CONFIG`, `USAGE`,
`MainOptions`, `ParsedArgs`, `getRuntimeDeps`, `MISSING_PROVIDERS_REASON`, `RuntimeDeps`,
`isMainModule`). The config parser is named for the daemon so it cannot be confused with the
seeder's existing `resolveConfig()`: `parseDaemonConfigText`, `validateDaemonConfig`,
`applyDaemonEnvOverrides`, `DAEMON_ENV`, `DaemonConfig`, `DaemonConfigResult`.

### Entry contract

`node --jitless --no-experimental-websocket …/dist/index.js --config /etc/nutflix/seeder.json`

| Flag / case | Result |
|---|---|
| `--config <path>` | the JSON file; `NUTFLIX_SEEDER_CONFIG` is the fallback, the flag wins; `--config=` (empty) counts as absent |
| `--check` | parse + validate (file and env), log `config ok`, exit **0**, or **78**. Never consults providers, never touches state |
| `--help` / `-h` | usage, exit 0 |
| unknown flag, positional, `--config` without a value | **78** + usage; the error is a fixed string (`unknown option`, …), never the token |
| no config path | **78**, `no config: pass --config <path> or set NUTFLIX_SEEDER_CONFIG` |
| unreadable file | **78**, `$: config file could not be read (ENOENT)`; only an errno-shaped code is shown, never the error message |
| invalid config | **78**, `invalid config — refusing to start` + the list of `<json path>: <expected shape>` |
| providers absent (Stage 1) | **78**, `refusing to start` + `MISSING_PROVIDERS_REASON` |
| provider throws | **78**, `runtime providers failed`, error through the redacting logger |
| `runDaemon()` throws | **1**, `seeder failed to start` |
| started | never resolves; `READY=1` (no-op without `NOTIFY_SOCKET`), a `warn` that pay/1 is not wired (§3), SIGTERM/SIGINT/SIGHUP → one `Seeder.close()` → exit 0 (1 on timeout/failure) through `runDaemon()`'s existing `installShutdownHooks` |

`index.ts` calls `process.exit(code)` as soon as `main()` resolves. It resolves only when the
daemon did not start or failed to start, so there is nothing to drain, and a half-opened
Corestore or swarm socket after a runtime failure cannot keep a dead unit "active" (the
gateway sets `process.exitCode` and waits instead). No `--dev-mocks`, as briefed.

## 2. Config file and precedence

Shape, defaults and an annotated example: `deploy/systemd/README.md` "Seeder configuration".
Result = `{ seeder: SeederConfig, logLevel }`. Every `SeederConfig` field is covered:
`dataDir`, `storageDir`, `blockSize`, `diskCapBytes`, `rateLimits` (any subset, each an int ≥ 1),
`swarm`, `policy`, `flushEveryBlocks`, `flushEveryMs`. `logLevel` is the one daemon-only key.

**Precedence decision (mirrors the gateway exactly):**
`NUTFLIX_SEEDER_*` env **>** file **>** `STATE_DIRECTORY` (fills `dataDir` only, when neither the
file nor `NUTFLIX_SEEDER_DATA_DIR` has one) **>** default. Config path: `--config` **>**
`NUTFLIX_SEEDER_CONFIG`.

- Reconciliation with `parseDaemonEnv()`: the daemon does NOT use it. It reads the same three
  variables (`NUTFLIX_SEEDER_DATA_DIR`, `…_DISK_CAP_BYTES`, `…_MAX_STREAMS` → `rateLimits.maxStreams`)
  as overrides on top of the file, plus the new `NUTFLIX_SEEDER_LOG_LEVEL` and
  `NUTFLIX_SEEDER_CONFIG`. An env-only daemon is impossible by construction because `policy` is
  required and has no env form. `parseDaemonEnv()` stays public (embedders) and now shares the
  parsing rules in `cli/env.ts`.
- **Behaviour change in `parseDaemonEnv()`** (it was lenient in a way that mattered): numbers
  must be decimal digits (`Number()` accepted `1e3`, `0x10`, `1.5`, ` 5`), and an empty
  assignment is unset (`NUTFLIX_SEEDER_DISK_CAP_BYTES=` used to mean a 0-byte cap via
  `Number('') === 0`; now it means the 50 GiB default). Nobody calls it in the repo.
- Env value errors name the path and the variable, not the value:
  `$.diskCapBytes (from NUTFLIX_SEEDER_DISK_CAP_BYTES): expected integer in [0, …]`.
- `STATE_DIRECTORY` holding a `:`-joined list (several `StateDirectory=` entries) is ignored
  rather than guessed at, so `dataDir` is then reported as required.

**Where it is stricter than the gateway's `config.ts`** (the seeder cannot import
`@sovit/gateway`, since the dependency runs gateway → seeder, so these are mirrored rules, not
shared code; **the two should converge**, ideally into one validator in `@sovit/seeder` that the
gateway reuses for its seeder-shaped fields):

| Rule | Seeder daemon | Gateway today |
|---|---|---|
| unknown keys | rejected at every level | top level only (nested typos are silently ignored) |
| odd key names in errors | printed as `[…]` unless `^[A-Za-z_][A-Za-z0-9_]{0,63}$` | printed verbatim |
| `policy` | required | required (★) but each field defaulted |
| `policy.satsPerBlock` | required | default 0 (a free gateway by omission) |
| `policy.creatorP2pk` | required, `^0[23][0-9a-f]{64}$` (as `@sovit/core` uses) | default `''`; when set, any 66 hex |
| `policy.mints` | required, ≥ 1, `nostr.normalizeMintUrl(u) === u`, no duplicates | default `[]`; regex |
| `policy.blockSize` | optional, must equal `$.blockSize` | not a key (silently ignored) |
| `swarm.bootstrap[i]` | exact `{host: non-empty, port: 1–65535}` | `{host: string, port: integer}` |
| `swarm.keyPair` / `swarm.seed` | refused (key material) | ignored |
| `swarm` absent | ON (`{}`), as `parseDaemonEnv()` | OFF (`null`); the gateway has the WS bridge, a standalone seeder has no other transport |
| `swarm.server` and `client` both false | refused (joins nothing) | accepted |
| env numbers | decimal digits only; empty = unset | `Number(x)` (so `''` → 0) |

## 3. Stage 2 seam — what Stage 2 must still do (NOT a one-function change)

`RuntimeDeps` is `{ engine: SeederDeps['engine'] }`: exactly what `runDaemon()` consumes today.
I deliberately did not add `payProtocol` / `identity` fields that nothing would read. The
daemon does not attach `pay/1` to swarm sessions or send `HELLO` (the gateway and the desktop
worker each do that in their own shell), so a daemon started with only an engine serves every
peer `windowBlocks` unpaid blocks and then cuts it. `main()` logs a `warn` saying exactly that
on every start. Stage 2 must, together:

1. return the real engine from `getRuntimeDeps()` (async is allowed: the seam `await`s it);
2. add a `PayProtocol` factory and a HELLO identity (pubkey, P2PK, challenge signing) to
   `RuntimeDeps`. `SeederConfig` has no identity field, and `config.ts` was outside this lane.
   Either the Signer supplies the public values or the file grows an `identity` key like the
   gateway's;
3. wire them: on each admitted swarm session, attach to `session.mux`, call
   `seeder.attachPayProtocol()`, send `HELLO` from `seeder.policy()`. **Trap:** the seeder's
   own `SwarmManager` admits a connection (`session-open` fires) BEFORE `Seeder.onSwarmSession`
   runs `store.replicate(conn)`, so `session.mux` is still `null` at `session-open`. Either
   `Seeder` grows an on-session hook (`seeder.ts`) or the daemon owns the swarm the way the
   desktop worker's `PeerNode` does;
4. delete the start-up `warn` in `cli/main.ts`.

This is written in the `cli/providers.ts` header too, so whoever fills the seam reads it.

## 4. Finding: `--jitless` killed the real entry on Node 22; the unit changed

The first run of the built entry with the unit's flags died one tick after start:
`ReferenceError: WebAssembly is not defined` at `lazyllhttp` in Node's bundled `undici`.
`--jitless` removes WebAssembly, and `undici` compiles its HTTP parser to wasm when it loads.
`nostr-tools/lib/esm/pool.js` (reached through `@sovit/core`'s barrel, which every seeder
module imports) reads the global `WebSocket` at import, and that lazily loads `undici`. The
earlier hardening run (`test-hardening.sh`) never saw it because its rows are `-e` scripts that
`require()` modules, not the package entries. Reproducers and the Node 24 check:
`deploy/systemd/MDWE-RESULTS.md` §6.

- **Unit change (the only one):** `ExecStart=/usr/bin/node --jitless --no-experimental-websocket …`.
  The flag removes the global, and the entry then runs the full `--check` / no-providers paths.
  On Node v24.18.0 neither trigger crashes and the flag is still accepted. The unit comment and
  the README say why.
- **Regression guard:** `entry.test.ts` spawns the BUILT `dist/index.js` with the node flags
  READ FROM the unit file. Mutation-checked: dropping the flag from the unit makes it fail with
  this exact `ReferenceError`.
- **The gateway is broken the same way, and worse (open, lane L3):** besides the same
  `nostr-tools` access, its ESM `import … from 'node:http'` makes Node build the builtin's ESM
  facade, which reads every export, including Node 22's lazy `http.WebSocket` getter. No flag
  fixes that. `node --jitless --no-experimental-websocket packages/gateway/dist/index.js --check
  --config <valid>` dies on Node 22 and passes on Node 24. I did not touch the gateway unit: it
  would be half a fix, and the gateway's `cli.test.ts` pins its current `ExecStart` byte for byte.

## 5. Security-relevant behaviour and its tests

| Behaviour | Test |
|---|---|
| config errors are `<json path>: <expected shape>`; no value from the file or env is ever printed (sentinels, 64-hex, `nsec1…`, numbers, URLs checked absent) | `daemon-config.test.ts` "wrong types…", "empty assignments…", "swarm: key material…"; `cli-main.test.ts` "invalid config" |
| `JSON.parse`'s message (which quotes the text) is never forwarded | `daemon-config.test.ts` "not JSON"; `cli-main.test.ts` "invalid config" |
| odd key names are not echoed (`$[…]`); `__proto__` is just an unknown key, no prototype pollution | `daemon-config.test.ts` "unknown keys at EVERY level" |
| argv errors are fixed strings (a stray token is never printed) | `cli-main.test.ts` "parseCliArgs", "bad argv" |
| read errors show an errno-shaped code only, never the message | `cli-main.test.ts` "missing / unreadable file" |
| `swarm.keyPair` / `swarm.seed` refused: key material never comes from the config file | `daemon-config.test.ts` "swarm: key material…" |
| provider errors go through the redacting logger | `cli-main.test.ts` "a provider that throws" |
| `--check` and every refusal start nothing: no READY, providers not consulted, `dataDir` not created | `cli-main.test.ts` "--check…", "Stage 1…"; `entry.test.ts` built entry (`data/` absent) |
| importing `@sovit/seeder` runs nothing (no `main()`, no signal handlers, no exit code) | `entry-import.test.ts` (mutation-checked: an unconditional guard fails it) |
| `portable.ts` (Bare) reaches no `node:`/builtin module, not `cli/main.ts`, `cli/providers.ts`, `adapters/node/` or `index.ts`; a positive control proves the walker finds them from `index.ts` | `entry-hygiene.test.ts` |
| a failed start exits instead of hanging (`process.exit(code)`) | `cli-main.test.ts` runtime failure → `main()` resolves 1; `entry.test.ts` covers the self-exec exit for the 0/78 paths. Not covered end to end: the exit-1 path with handles already open, which would need a provider inside the built entry |
| no `console.*` / raw stdio anywhere in `src/` | existing `no-console.test.ts` (covers the new files) |

## 6. Deviations from the brief

- **The unit file changed** (brief: only if something is actually wrong). It was: §4.
- **`RuntimeDeps` carries only the engine**, not the PayProtocol / identity the brief names
  as Stage 2 inputs, because nothing in the daemon consumes them yet (§3). The missing-providers
  reason still names all three.
- **`policy` is required** in `seeder.json` although `SeederConfig.policy` is optional: a daemon
  without a price cannot verify any `PAY` (`Seeder.policy()` throws). The gateway requires it too.
- **`swarm` defaults ON** (unlike the gateway), matching `parseDaemonEnv()`.
- **`parseDaemonEnv()` got stricter** (§2). It is in the allowlisted `cli/` and it was the
  "reconcile" item. Existing tests pass unchanged, and one case was added.
- The provider seam accepts a Promise (the gateway's is sync), because Stage 2 will likely open
  a wallet asynchronously.
- `index.ts` exits with `process.exit(code)`, where the gateway uses `process.exitCode` (§1).

## 7. Tests

`npx vitest run --project seeder`: **20 files, 116 tests** (was 15 / 87 at L2-v3; +5 files,
+29 tests): `daemon-config` 12, `cli-main` 10, `entry` 3, `entry-hygiene` 2, `entry-import` 1,
`systemd` +1. Deterministic: no fixed sleeps. Waits are bounded polls with a failure message
(`fake-process.ts` `until`), and the subprocess runs have a 30 s kill timeout that prints the
child's output. No network: every started seeder has `swarm: null`, and the built entry never
gets past the provider refusal. The built-entry block is `describe.skipIf` when `dist/` predates
the entry (`npm run ci` builds before it tests).

`npm run ci` (worktree root): see the final report for the exit code and repo-wide counts.

## 8. For the orchestrator

- **`package.json`: no change needed.** The unit runs `dist/index.js` directly, and `main` /
  `exports["."].default` already point there (asserted read-only in `entry.test.ts`). A `bin`
  would add nothing for systemd, and a shebang'd bin would run without `--jitless` /
  `--no-experimental-websocket`, so I recommend against one. Unrelated leftover:
  `packages/seeder/package.json` `"files": ["dist", "systemd"]` still lists the `systemd/` dir
  that L2-v3 deleted. It is harmless; drop `"systemd"` when convenient.
- **Gateway under Node 22 + `--jitless` crashes at startup** (§4): a lane-L3 fix (load `http` via
  `createRequire`, plus `--no-experimental-websocket` in its unit and its `cli.test.ts` pin), or
  pin Node ≥ 24 on hosts. Until then `nutflix-gateway.service` does not stay up on Node 22.
- `docs/status.md` follow-up 5 and an internal session handoff (not published) §3.4's seeder
  bullet can be struck. Replace them with "seeder entry exists and refuses (78) until Stage 2;
  Stage 2 must wire pay/1 + HELLO in the daemon (Seeder-entry §3)".
- `packages/seeder/src/portable.ts`'s header says "`index.ts` is this module plus the Node
  adapters". It is now that plus the daemon CLI. That is a one-line comment fix outside this
  lane's allowlist.
- `docs/lanes/L2.md` "Public API" gains: `main`, `parseCliArgs`, `loadConfig`, `EXIT_CONFIG`,
  `USAGE`, `isMainModule`, `parseDaemonConfigText`, `validateDaemonConfig`,
  `applyDaemonEnvOverrides`, `DAEMON_ENV`, `getRuntimeDeps`, `MISSING_PROVIDERS_REASON` and
  the types `MainOptions`, `ParsedArgs`, `DaemonConfig`, `DaemonConfigResult`, `RuntimeDeps`.
  All come from `index.ts` only, never from the `bare` condition.
- Converge the gateway's and the daemon's config validation (§2 table).

## 9. Open questions

- Should `--check` also report whether providers are wired? I kept it config-only, like the
  gateway, because calling a Stage 2 provider could open a wallet. As a result, `--check` passes
  today while a real start refuses with 78. The README says so.
- Where should the standalone seeder's HELLO identity live: in `seeder.json` (like the gateway's
  `identity`) or only in the Signer? Decide with Stage 2 (§3 item 2).
