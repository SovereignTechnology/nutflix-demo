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
| Contracts | **v2, FROZEN** — Signer, Wallet, PaymentEngine, PayProtocol, NetworkAdapter, Manifest/NIP-71/HyperblobRef, Media |
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

## Stage 1 — parallel lanes: **Wave 1 MERGED 2026-09-04**, Wave 2 not started

`main` after Wave 1: `npm run ci` green — 48 test files, **459 passed / 25 skipped**
(the 25 are L10's codec-fuzz + BlossomAuth suites, `skipIf` no implementation until Stage 2).
Baseline was 20 tests. `npm run ci` now also runs `check:native` and `lint:electron` (L9).

| Lane | Worktree | Branch | State | Contract requests |
|------|----------|--------|-------|-------------------|
| L9 ci-hardening | `.worktrees/L9` | `lane/L9` | **merged** `85ebbb2` (43 tests) | `docs/contract-requests/L9.md` — non-blocking, see below |
| L1 nostr-data | `.worktrees/L1` | `lane/L1` | **merged** `2cfe533` + wiring `e42aa60` (190 tests) | — |
| L10 adversary-tests | `.worktrees/L10` | `lane/L10` | **merged** `8acd13c` (66 pass / 25 skipped) | — |
| L2 seeder | `.worktrees/L2` | `lane/L2` | **merged** `f160584` → reverted `1a0d438` (red `check:native`) → **reapplied** `002fce7` with reviewed inventory (100 tests) | — |
| L8 transcode | `.worktrees/L8` | `lane/L8` | **merged** `2cd9dde` + wiring `3cc5830` (140 tests with ffmpeg, 136+4 skipped without) | — |
| L3 gateway | — | — | **unblocked** — L2 public API in `docs/lanes/L2.md` | — |
| L4 design-system | — | — | pending (needs design reference from Cameron) | — |
| L5 screens | — | — | blocked on L4 | — |
| L6 desktop-shell | — | — | blocked on L4 (L1, L2 done) | — |
| L7 web-shell | — | — | blocked on L3, L4 (L1 done) | — |

Lane reports: `docs/lanes/L1.md`, `L2.md`, `L8.md`, `L9.md`, `L10.md`. Worktrees are left in
place for archaeology; delete with `git worktree remove .worktrees/<L>` once Wave 2 starts.

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

### Open contract-change requests (CONTRACTS_VERSION stays 2 — batch into v3 before Wave 2)

1. **L9: `NostrKind.ReleaseNotice`** (`docs/contract-requests/L9.md`) for the reproducible-build
   hash event; script defaults `--kind 30063` meanwhile. Non-blocking; no vendored NIP backs the
   number — pick one in the addressable range at v3.
2. **`hyperUrl` grammar (doc-only):** `contracts/manifest.ts:54` says z32; L1 and L8 both
   implement `hyper://<hex core key>/<blockOffset>-<blockLength>[+<byteOffset>]` because that
   is what `mocks/fixtures.ts` encodes. Fix the comment at v3; the code is consistent.
3. **L2 flags for consideration:** `PayMessage` carries no core key, so the seeder verifies with
   one `PricePolicy` per seeder (multi-video seeders need it per core); pre-`HELLO` uploads are
   accounted under the Noise-key hex as a provisional pubkey and replayed on bind — an engine
   `rebind(from, to)` would be cleaner.

### Findings to act on (non-contract, orchestrator-owned)

- **Spec gap found by L10 (needs Cameron, ties to Q1):** with `satsPerBlock: 1` and a 1-block
  PAY at a 50/50 split the seeder share rounds to 0, so an *honest* PAY is rejected
  `missing-seeder-set`. Needs a minimum-batch or rounding rule in the spec; L10's property tests
  filter to shares ≥ 1 until then.
- **`mocks/fixtures.ts` comments use `['A', '21:<id>']`;** NIP-22 addresses regular events (kinds
  21/22) with `E`/`e`. L1 parses `A` leniently but `fetchComments` filters on `#E`. Align the
  mock fixtures (orchestrator, before L5 consumes them).
- **Two seeder systemd units exist:** `deploy/systemd/nutflix-seeder.service` (L9 —
  `MemoryDenyWriteExecute=yes` + `node --jitless`, 13/13 hardening cases pass) and
  `packages/seeder/systemd/nutflix-seeder.service` + `renderSystemdUnit()` (L2 — MDWE off).
  L9's is canonical (tested); reconcile L2's renderer to emit the L9 set in Wave 2 (L3 owns the
  gateway unit; the seeder one needs an orchestrator/L2 follow-up).
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
- `nostr-tools` resolves in `packages/gateway` only via hoisting (L10's auth tests); add it as a
  gateway devDependency when L3 starts.
- L1: `nostr-tools` `verifyEvent({...verified, content:'evil'})` returns **true** (spread copies
  the cached verified symbol); `nostr/event.ts` rebuilds a fresh object before verifying and a
  test pins this. Every consumer must go through `verifyIncoming`.
- L2: over real hyperswarm (UDX) the viewer ends with **≤ window** (transport buffer dropped on
  destroy); the exact-`window` result holds on piped replication streams. Both documented in L2.md.
- L8: dev/CI `ffmpeg` pin is a GPL BtbN static build (`media/FFMPEG-PIN.md`, sha256 recorded);
  binary path is injected config everywhere, so the shipped-binary decision is independent.

### Inputs still needed from Cameron

1. **Frontend design reference** for L4 (build-plan §6.3 "frontend design reference you provide").
   L4 gates L5, L6 and L7 — this is the Wave 2 critical path.
2. Answers to build-plan §9 open questions that affect Stage 1 defaults — at minimum **Q1
   price/window** (contracts default `windowBlocks=4`; **now also the rounding rule above**),
   **Q2 mints per video** (contracts allow several), **Q6 subscriptions = NIP-51 set** (L1
   implements the kind-30000 `channels` set with kind-3 fallback), **Q8 web-upload transcode at
   gateway** (L3/L8 scope).
3. Whether a shipped `ffmpeg` binary is acceptable in the desktop bundle (S-C open question 1).
   L8's design is indifferent (injected path), so this now only affects L6 packaging.

## Stage 2 — audit surface (single security session): NOT STARTED
## Stage 3 — integration and polish: NOT STARTED
