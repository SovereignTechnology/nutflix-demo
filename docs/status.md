# Status

Kept current by the orchestrator after every merge (execution plan §5.1).

## Stage 0 — scaffold, contracts, spikes: **DONE 2026-09-04**

| Deliverable | State |
|-------------|-------|
| Monorepo scaffold (npm workspaces, TS 6 strict, ESLint type-checked, Vitest, Prettier, `.npmrc` exact-pins + ignore-scripts) | done — `npm run ci` green |
| Lane guards: `scripts/pre-commit` path allowlist, `scripts/check-locked-dirs.sh`, `scripts/check-contracts-version.sh`, `.gitlab/CODEOWNERS`, `scripts/new-lane-worktree.sh` | done |
| CI skeleton | `ci/gitlab-ci.yml` — parked until a runner is registered (README caveat) |
| `docs/vendor/` (75 files: Pear docs + examples, Hypercore stack READMEs, BUD-01/02/03/04/06/09, 15 NIPs, 7 NUTs, cashu-ts, nostr-tools) + `MANIFEST.txt` | done — `scripts/vendor-docs.sh` refreshes |
| `SECURITY.md` threat model + invariants + locked dirs | done |
| Contracts | **v3, FROZEN** (v2 for Wave 1; bumped `7efcf0f`, ADR 0004) — Signer, Wallet, PaymentEngine, PayProtocol, NetworkAdapter, Manifest/NIP-71/HyperblobRef, Media |
| Mocks | `MockPaymentEngine` (honest + 6 cheat modes, rules-faithful `verify`), `MockWallet`, `MockNetworkAdapter` (12 fixture videos, 5 channels, error/latency switches); 20 tests |
| Spikes | S-A (A4 refined), S-B (A8 PASS), S-C (transcode → subprocess+ffmpeg) — `docs/spikes/` |
| Assumption resolutions | ADR 0003 |
| Prompts | `docs/prompts/{orchestrator,lane,stage-2-security}.md` |
| Lane briefs | `docs/lanes/BRIEFS.md` |

### Deviations from the plan, recorded

- Desktop shell is Electron + `pear-runtime` Bare worker (upstream's current shape), not `pear-electron` — ADR 0003.
- `MockPaymentEngine` lives in `core/src/mocks/`, not inside the locked `payment/` dir, so the locked-dir check can be strict (interfaces + tests only).
- TypeScript pinned at 6.0.3, not 7.x: `typescript-eslint@8.69` supports `<6.1`. jsdom 29.1.1 (30.x wants Node ≥22.22.2; this box has 22.22.0).
- No `.gitlab-ci.yml` at root (no runner); `ci/gitlab-ci.yml` is the skeleton.

## Stage 1 — parallel lanes: **Wave 1 MERGED 2026-09-04**, Wave 2 **L3 MERGED 2026-09-05**, rest blocked on L4

`main` after L3: `npm run ci` green — 56 test files, **530 passed / 25 skipped**
(the 25 are L10's codec-fuzz + BlossomAuth suites, `skipIf` no implementation until Stage 2).
Wave 1 was 48 files / 459 passed; Stage 0 baseline was 20 tests. `npm run ci` also runs
`check:native` and `lint:electron` (L9).

| Lane | Worktree | Branch | State | Contract requests |
|------|----------|--------|-------|-------------------|
| L9 ci-hardening | `.worktrees/L9` | `lane/L9` | **merged** `85ebbb2` (43 tests) | `docs/contract-requests/L9.md` — non-blocking, see below |
| L1 nostr-data | `.worktrees/L1` | `lane/L1` | **merged** `2cfe533` + wiring `e42aa60` (190 tests) | — |
| L10 adversary-tests | `.worktrees/L10` | `lane/L10` | **merged** `8acd13c` (66 pass / 25 skipped) | — |
| L2 seeder | `.worktrees/L2` | `lane/L2` | **merged** `f160584` → reverted `1a0d438` (red `check:native`) → **reapplied** `002fce7` with reviewed inventory (100 tests) | — |
| L8 transcode | `.worktrees/L8` | `lane/L8` | **merged** `2cd9dde` + wiring `3cc5830` (140 tests with ffmpeg, 136+4 skipped without) | — |
| L3 gateway | `.worktrees/L3` | `lane/L3` | **merged** (v3) `fc27d7e` + `08779e9` → merge `270a08f` (64 pass / 13 skipped in-project) | — (two v3-shape notes in L3.md, no request) |
| L4 design-system | — | — | **blocked — needs design reference from Cameron** | — |
| L5 screens | — | — | blocked on L4 | — |
| L6 desktop-shell | — | — | blocked on L4 (L1, L2 done) | — |
| L7 web-shell | — | — | blocked on L4 (L1, L3 done) | — |

Lane reports: `docs/lanes/L1.md`, `L2.md`, `L3.md`, `L8.md`, `L9.md`, `L10.md`. Wave 1 lanes
were issued at **v2**, L3 at **v3**. Worktrees are left in place for archaeology; delete with
`git worktree remove .worktrees/<L>` when convenient.

### Orchestrator actions during Wave 1 (not lane work)

- `ec12b7b` pinned the `docs/vendor/versions.txt` runtime deps before fan-out (lanes cannot
  edit the lockfile): core ← nostr-tools, @cashu/cashu-ts; seeder ← hypercore, hyperblobs,
  corestore, hyperswarm, protomux, compact-encoding; app-desktop ← bare-subprocess.
- Lane allowlists were widened minimally where BRIEFS.md's definition of done required it:
  L9 +`docs/native-modules.txt`, lockfile, `.prettierignore`, `README.md`; L10
  +`core/src/mocks/__tests__/` (the seed it must extend); L1/L8 + own `package.json` + lockfile.
- `ced4241` added `.worktrees/**` to the ESLint ignore list — flat config does not read
  `.gitignore`, and type-checked linting of five lane checkouts OOM'd `main`'s lint after L9.
  Pre-existing scaffold gap, not a lane defect; no revert.
- **L2 merge was reverted and reapplied.** L2 declares `hyperdht@6.34.0` as a direct
  devDependency (offline testnet); that changed the *shortest dependency chain* annotation for
  `udx-native` in `docs/native-modules.txt`, so L9's `check:native` went red on `main`. The
  native-module SET was unchanged (31 packages, same versions, no scripts). Reviewed and
  `--accept`ed inside the reapply commit `002fce7` so `main` never carries a red tip.
- Export wiring (orchestrator-owned `index.ts`): `@sovit/core` exports `nostr`, `manifest`,
  `media` namespaces plus a `./media/node` subpath (keeps `node:` out of the root barrel);
  `@sovit/app-desktop` exports `transcode`.

### Orchestrator actions between Wave 1 and Wave 2 (2026-09-04/05)

- **Contracts v3, `7efcf0f`** — ADR `docs/decisions/0004-contracts-v3.md`. Additive; all
  Wave 1 code compiles untouched. (a) `NostrKind.ReleaseNotice = 30071` (L9's 30063 is
  NIP-51 "Release artifact sets", a different shape — request file marked resolved);
  `scripts/reproducible-build.mjs` defaults to it and a scripts test pins the default to the
  contract. (b) `hyperUrl`/`CoreKeyHex` doc comments now state the hex grammar L1/L8/fixtures
  implement. (c) **L2 flag 1 accepted:** `BlockRange.core?` + `recordUpload(peer, blocks,
  core?)` — one `pay/1` channel spans many cores and `PricePolicy` is per video, so a PAY
  without its core makes T4 and invariant 2 unverifiable; optional at v3, **required at the
  Stage 2 bump**. (d) **L2 flag 2 accepted:** `PaymentEngineSeeder.rebind(from, to)` with
  sum-merge, ban-sticks, synchronous invariant-5 enforcement. `MockPaymentEngine` implements
  both (+7 tests). `mocks/fixtures.ts` + `MockNetworkAdapter.comment()` now emit NIP-22
  `E/K/P` + `e/k/p` via `commentTags()` instead of `['A','21:<id>']`.
- `9b7db9c` pinned gateway deps before L3 fan-out: hypercore-blob-server@1.15.0, ws@8.21.3,
  the Hypercore stack, devDeps nostr-tools@2.25.2 + @types/ws. Native inventory `--accept`ed
  inside that commit: one NEW native package, `bare-hrtime@2.1.2` (via
  hypercore-blob-server>bare-http1; Bare-only `.bare` prebuilds, never loads under Node,
  scripts=none); everything else was shortest-chain annotation moving seeder→gateway (31→32).
- **L3 review before merge:** allowlist clean, `src/auth/` byte-identical, lockfile untouched,
  no crypto libs in runtime src (sha256 for BUD-02 is `node:crypto`), no `console.*`.
  One finding fixed in-lane before merge (`08779e9`): `--dev-mocks` (accept-all `BlossomAuth`
  + mock engine) now refuses to start on a non-loopback `listen.host` (exit 78).

### Open contract-change requests (CONTRACTS_VERSION = 3, FROZEN)

None. L3 filed no request; two v3-shape observations are recorded in `docs/lanes/L3.md`
for the Stage 2 (v4) bump: `PRICE` carries no core (per-core prices need it), and BUD-09
reports reach `BlossomAuth` as a synthetic `Nostr <base64(kind-1984)>` header under verb
`report` (Stage 2 may prefer a second method on the interface).

### Follow-ups owed by the orchestrator (not on Wave 2's critical path)

1. **Re-issue L2 at v3** — the concrete list is `docs/lanes/L3.md` "What the seeder's v3
   re-issue must change": forward `core` in `PeerSession.onUpload` → `recordUpload`; replace
   replay-on-bind with `engine.rebind(noiseHex, pubkey)`; reject a core-less `PAY` as
   `malformed` on multi-core streams; resolve policy per `range.core` in the pay bridge;
   `BlobStore.putStream` opens its second `source()` eagerly and orphans it on dedupe/cap
   early return (uncaught ENOENT — L3 works around it by deciding dedupe/cap first);
   reconcile `renderSystemdUnit()`/`HARDENING_DIRECTIVES` with the canonical
   `deploy/systemd/` set (MDWE=yes + `--jitless`, `AF_NETLINK`, `Type=simple`). Until (1)
   lands, the mock's per-core `range-not-uploaded` check cannot fire for downstream WS peers
   (aggregate fallback) — a money-path hole across cores on a multi-video gateway.
2. **Re-issue L10 at v3** — named tests for T4-across-cores, cheap-price-across-cores, per-core
   replay, `rebind` merge/ban semantics.
3. `deploy/systemd/README.md`: document `NUTFLIX_GATEWAY_PUBLIC_URL` (or `blossom.publicUrl`)
   and `http.trustProxy` (only when the listener is reachable solely via the proxy). L3
   confirmed the canonical `ExecStart` is right as written; no gateway-side renderer shipped
   by design.
4. Consider pinning `streamx@2.28.1` in `packages/gateway/package.json` (L3 imports it
   directly; today it is transitive via hypercore). Consider moving the duplicated ambient
   `types/holepunch.d.ts` (seeder + gateway) into `@sovit/core` or emitting it from the seeder.

### Findings to act on (non-contract, orchestrator-owned)

- **Spec gap found by L10 (needs Cameron, ties to Q1):** with `satsPerBlock: 1` and a 1-block
  PAY at a 50/50 split the seeder share rounds to 0, so an *honest* PAY is rejected
  `missing-seeder-set`. Needs a minimum-batch or rounding rule in the spec; L10's property tests
  filter to shares ≥ 1 until then.
- ~~`mocks/fixtures.ts` comments use `['A', '21:<id>']`~~ **fixed in `7efcf0f`** (NIP-22
  `E/K/P` + `e/k/p` via `commentTags()`). L1's lenient `A` parsing can go once nothing emits it.
- **Two seeder systemd units exist:** `deploy/systemd/nutflix-seeder.service` (L9 —
  `MemoryDenyWriteExecute=yes` + `node --jitless`, 13/13 hardening cases pass) and
  `packages/seeder/systemd/nutflix-seeder.service` + `renderSystemdUnit()` (L2 — MDWE off).
  L9's is canonical (tested). **Gateway side resolved by L3** (no renderer, canonical unit
  confirmed); the seeder renderer is follow-up 1 above.
- **L3 `--dev-mocks`** is the one flag-gated dynamic import of `@sovit/core` mocks from a
  runtime path (execution plan §0 rule 4 exception): loud `warn` on start, loopback-only,
  exists so L7 has a gateway to develop against before Stage 2. Delete `cli/dev-mocks.ts` +
  the branch in `cli/main.ts` if this is not wanted.
- **L3 Blossom decisions to confirm:** `GET /list/<pubkey>` is served unauthenticated
  (BUD-12 is not vendored); `PUT /mirror` is off by default and host-allowlisted; `DELETE` →
  405 (operator action). Q4 gateway markup is a flat `markupSatsPerBlock` (default 0),
  disclosed in `HELLO`; Q8 untouched (uploads stored verbatim, `allowedMimeTypes` is the lever).
- **MDWE finding (L9, L2 independently):** Node 22 default JIT aborts at startup under
  `MemoryDenyWriteExecute`; `--jitless` survives incl. sodium-native/udx/rocksdb/HyperDHT at
  ~1.66× cost on secp256k1 verify. `RestrictAddressFamilies` needs **`AF_NETLINK`** in addition
  to the plan's literal set (hyperdht's `getifaddrs` opens NETLINK_ROUTE). `deploy/systemd/MDWE-RESULTS.md`.
- **Provenance (L9):** `hyperswarm@4.17.0` and `nostr-tools@2.25.2` publish no npm provenance —
  the only two direct runtime deps without it. `npm audit signatures` is wired into CI.
- **Mock vs SECURITY.md (L10, reported not fixed):** the mock's P2PK check is envelope-only and it
  never checks `C`; the two Stage-2-only tests (`T6 re-labelled captured PAY`, `T7 altered C`)
  are `it.skipIf(usingMock())`. A rejected cheat does not ban in the mock (SECURITY.md only
  mandates bans for T3/T5).
- ~~`nostr-tools` resolves in `packages/gateway` only via hoisting~~ **fixed in `9b7db9c`**.
- L1: `nostr-tools` `verifyEvent({...verified, content:'evil'})` returns **true** (spread copies
  the cached verified symbol); `nostr/event.ts` rebuilds a fresh object before verifying and a
  test pins this. Every consumer must go through `verifyIncoming`.
- L2: over real hyperswarm (UDX) the viewer ends with **≤ window** (transport buffer dropped on
  destroy); the exact-`window` result holds on piped replication streams. Both documented in L2.md.
- L8: dev/CI `ffmpeg` pin is a GPL BtbN static build (`media/FFMPEG-PIN.md`, sha256 recorded);
  binary path is injected config everywhere, so the shipped-binary decision is independent.

### Inputs still needed from Cameron

1. **Frontend design reference** for L4 (build-plan §6.3 "frontend design reference you provide").
   **L4 gates L5, L6 and L7 — with L3 merged this is now the ONLY thing Wave 2 waits on.**
2. Answers to build-plan §9 open questions that affect Stage 1 defaults — at minimum **Q1
   price/window** (contracts default `windowBlocks=4`; **now also the rounding rule above**),
   **Q2 mints per video** (contracts allow several), **Q6 subscriptions = NIP-51 set** (L1
   implements the kind-30000 `channels` set with kind-3 fallback), **Q8 web-upload transcode at
   gateway** (L3/L8 scope).
3. Whether a shipped `ffmpeg` binary is acceptable in the desktop bundle (S-C open question 1).
   L8's design is indifferent (injected path), so this now only affects L6 packaging.

## Stage 2 — audit surface (single security session): NOT STARTED
## Stage 3 — integration and polish: NOT STARTED
