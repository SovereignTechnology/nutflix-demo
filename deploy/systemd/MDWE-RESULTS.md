# MemoryDenyWriteExecute vs the Node 22 JIT — empirical result

Build-plan §7 asks for `MemoryDenyWriteExecute` to be **tested** against the JS engine's
JIT rather than assumed. This is that test. Reproduce with
`bash deploy/systemd/test-hardening.sh` (user scope, no sudo needed).

- Date: 2026-09-04 · host: laptop2 (Ubuntu 24.04, kernel 7.0.0-31, systemd 255.4)
- Runtime: Node **v22.22.0** (V8 12.4), `systemd-run --user --wait --pipe -p MemoryDenyWriteExecute=yes`
- No sudo on this machine, so everything below is **user scope**. `ProtectSystem`,
  `ProtectHome`, `PrivateTmp`, `CapabilityBoundingSet` need a system manager and were not
  exercised; the seccomp-based directives, `MemoryDenyWriteExecute` and
  `RestrictAddressFamilies` are applied identically in both scopes.

## 1. Finding

| Case | Result |
|------|--------|
| `MemoryDenyWriteExecute=yes`, default JIT, `node -e 'console.log("ok")'` | **ABORTS** (`SIGTRAP`, core-dump) |
| `MemoryDenyWriteExecute=yes`, default JIT, hot loop | **ABORTS** |
| `MemoryDenyWriteExecute=no`, default JIT (control) | ok |
| `MemoryDenyWriteExecute=yes`, **`--jitless`**, hot loop | **ok** |
| `MemoryDenyWriteExecute=yes`, `--jitless`, `sodium-native` (hash, `sodium_malloc`, `mprotect`, `mlock`) | ok, `secure=true` |
| `MemoryDenyWriteExecute=yes`, `--jitless`, `udx-native` bind | ok |
| `MemoryDenyWriteExecute=yes`, `--jitless`, `corestore` → `rocksdb-native` append/get | ok |
| `MemoryDenyWriteExecute=yes`, `--jitless`, `WebAssembly` | **absent** (`typeof WebAssembly === 'undefined'`) |

**Node 22 with its default JIT does not survive `MemoryDenyWriteExecute=yes` at all** — it
dies during startup, before user code runs, so this is not something a "mostly interpreted"
workload can dodge. The abort is V8's own check, not a signal from the kernel:

```
# Fatal error in , line 0
# Check failed: 12 == (*__errno_location ()).
 2: V8_Fatal(char const*, ...)
 3: v8::base::OS::SetPermissions(void*, unsigned long, v8::base::OS::MemoryPermission)
 4: v8::internal::MemoryAllocator::SetPermissionsOnExecutableMemoryChunk(...)
 ...
11: v8::internal::Factory::CodeBuilder::AllocateUninitializedInstructionStream(bool)
```

V8 allocates a code-space page and `mprotect`s it executable; MDWE turns that into `EACCES`
(13); V8 only tolerates `ENOMEM` (12) there and calls `V8_Fatal`. `--jitless` makes V8 run
Ignition-only with no code space, so no page is ever made executable and MDWE is satisfied.

## 2. Cost of `--jitless`, measured

The seeder's CPU-bound JS is the NUT-12 DLEQ / secp256k1 work in `@noble/curves` (pure JS,
BigInt-heavy); Hypercore hashing is in `sodium-native` (native, unaffected).

| `@noble/curves` 2.4.0 secp256k1 verify ×200 | ms / verify |
|---|---|
| default JIT | 1.27 |
| `--jitless` | 2.11 (**1.66×**) |

Not free, but not the 5–10× a tight-loop benchmark suggests: noble spends its time in BigInt
runtime calls either way. At ~2 ms/verify one core still clears ~500 verifies/s, far above
the per-block payment rate of any plausible stream count. Native code (`sodium-native`,
`udx-native`, `rocksdb-native`) is unaffected.

`--jitless` also removes **WebAssembly** entirely. Nothing in the seeder/gateway runtime path
uses it (`nostr-tools`'s optional `nostr-wasm` is an opt-in subpath, `sodium-universal`
resolves to `sodium-native` under Node, `@cashu/cashu-ts` → `@noble/*` pure JS). If a future
dependency needs wasm on the server, the choice is between dropping MDWE and dropping that
dependency — record it here.

**Correction (2026-09-23, lane Seeder-entry): Node 22 itself needs it.** Node's built-in
`undici` (behind the global `WebSocket`/`fetch` and `http.WebSocket`) compiles its HTTP parser
to WebAssembly the moment it is loaded, so under `--jitless` loading it kills the process.
The real package entries hit that at startup; the `-e` rows above never did. See §6.

## 3. `RestrictAddressFamilies` — the plan's literal set breaks the swarm

Tested alongside, because it is the other §7 directive that can silently kill the daemon:

| `RestrictAddressFamilies=` | `os.networkInterfaces()` | `new HyperDHT().ready()` |
|---|---|---|
| `AF_INET AF_INET6 AF_UNIX` (§7 verbatim) | `ERR_SYSTEM_ERROR` | **throws `EAFNOSUPPORT` in the constructor** |
| `AF_INET AF_INET6 AF_UNIX AF_NETLINK` (units) | ok | ok, socket bound |

`hyperdht` → `dht-rpc/lib/io.js:39` → `udx.watchNetworkInterfaces()` → libuv `uv_interface_addresses` → `getifaddrs(3)`, which opens a `NETLINK_ROUTE` socket. Hence `AF_NETLINK` in both units. It is read-only route/interface enumeration; no capability is granted, and the units still have `CapabilityBoundingSet=` empty so `NET_ADMIN` operations over netlink are impossible.

## 4. Decision (as shipped in the units)

```
MemoryDenyWriteExecute=yes
ExecStart=/usr/bin/node --jitless --no-experimental-websocket …   # seeder, since 2026-09-23 (§6)
ExecStart=/usr/bin/node --jitless …                               # gateway: BROKEN on Node 22, §6
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
```

Reasoning: MDWE removes the W^X bypass class entirely (a memory-corruption bug in a native
addon or in V8 cannot stage shellcode), the measured cost is ~1.7× on the one CPU-bound JS
path, and every native module the seeder/gateway load was verified to work under it. If a
host proves CPU-bound, the operator's escape hatch is a drop-in that sets
`MemoryDenyWriteExecute=no` AND removes `--jitless` **together** — one without the other is a
crash loop (see the last row of the test table).

## 5. Last full run of `test-hardening.sh`

```
node v22.22.0, systemd 255, kernel 7.0.0-31-generic
PASS | MDWE=yes, default JIT, trivial script (dies at startup, not at tier-up)  | rc=1 | # Check failed: 12 == (*__errno_location ()).
PASS | MDWE=yes, default JIT, hot loop                                          | rc=1 | # Check failed: 12 == (*__errno_location ()).
PASS | MDWE=no,  default JIT, hot loop (control)                                | rc=0 | ok 12499997500000
PASS | MDWE=yes, --jitless, hot loop                                            | rc=0 | ok 12499997500000
PASS | MDWE=yes, --jitless, WebAssembly is absent (expected, documented)        | rc=0 | ok wasm-absent
PASS | MDWE=yes, --jitless, sodium-native hash + secure buffer + mlock          | rc=0 | ok sodium true
PASS | MDWE=yes, --jitless, udx-native socket bind                              | rc=0 | ok udx true
PASS | MDWE=yes, --jitless, rocksdb-native via corestore append/get             | rc=0 | ok corestore b
PASS | plan RAF (no NETLINK), --jitless: os.networkInterfaces()                 | rc=0 | ERR ERR_SYSTEM_ERROR
PASS | plan RAF (no NETLINK), --jitless: new HyperDHT().ready()                 | rc=0 | ERR EAFNOSUPPORT
PASS | unit RAF (+AF_NETLINK), --jitless: new HyperDHT().ready()                | rc=0 | ok dht true
PASS | FULL portable set + MDWE + unit RAF, --jitless: dht + sodium + http + worker | rc=0 | ok full true 77
PASS | FULL portable set, default JIT (what the unit would do WITHOUT --jitless) | rc=1 | # Check failed: 12 == (*__errno_location ()).
hardening test: 13 passed, 0 failed
```

## 6. `--jitless` vs Node 22's lazy `undici` — the real entries crash at startup (2026-09-23)

Found by lane Seeder-entry when the seeder got a real entry point, by running the built
`dist/index.js` with the unit's own flags (the §5 rows only ever ran `-e` scripts that
`require()` modules, never the package entries). Node v22.22.0; reproducers need no systemd:

| Command (Node 22.22.0) | Result |
|---|---|
| `node --jitless --input-type=module -e "try{WebSocket}catch{}; setTimeout(()=>{},50)"` | **dies**: `ReferenceError: WebAssembly is not defined` at `lazyllhttp` (undici) |
| same, `--jitless --no-experimental-websocket` | ok (the global `WebSocket` does not exist) |
| `node --jitless --input-type=module -e "import 'node:http'; setTimeout(()=>{},50)"` | **dies**, same error, **with or without** `--no-experimental-websocket` |
| `node --jitless --input-type=module -e "import {createRequire} from 'node:module'; createRequire(import.meta.url)('node:http')"` | ok |
| every row above on Node v24.18.0 | ok (and v24 still accepts `--no-experimental-websocket`) |

Mechanism: touching the lazy global `WebSocket` loads Node's bundled `undici`, whose HTTP/1
client calls `WebAssembly.compile(llhttp)` at load; under `--jitless` `WebAssembly` is
undefined, the promise rejects unhandled, and Node exits 1 one tick later — after the entry
has already started, so a quick `--help` still "works". An ESM `import … from 'node:http'`
does the same through a different door: the ESM facade of a builtin reads **every** export,
including Node 22's lazy `http.WebSocket` getter. A CJS `require('http')` builds no facade,
which is why §5's `http` row passed.

Who triggers it:
- **seeder** (`packages/seeder/dist/index.js`): `nostr-tools/lib/esm/pool.js` reads the global
  `WebSocket` at import (`try { _WebSocket = WebSocket } catch {}`), pulled in through
  `@sovit/core`'s barrel. **Fixed in the unit**: `--no-experimental-websocket`. Guarded by
  `packages/seeder/src/__tests__/entry.test.ts`, which spawns the built entry with the node
  flags READ FROM `nutflix-seeder.service` (fails with this exact `ReferenceError` if the flag
  is dropped).
- **gateway** (`packages/gateway/dist/index.js`): the same `nostr-tools` access, **plus** its
  ESM `import … from 'node:http'`, which no flag fixes. `node --jitless
  --no-experimental-websocket packages/gateway/dist/index.js --check --config <valid>` still
  dies on Node 22. **Open, not fixed here** (gateway code is lane L3's; its `cli.test.ts` pins
  the current ExecStart): load `http` via `createRequire` in the gateway, or require Node ≥ 24
  on the host, or drop the MDWE + `--jitless` pair for the gateway (§4 escape hatch). The
  gateway unit also needs `--no-experimental-websocket` in any Node 22 fix.

