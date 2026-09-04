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

## Stage 1 — parallel lanes: **NOT STARTED**

Ready to fan out. Wave 1: L1, L2, L4, L8, L9, L10. Wave 2: L3, L5, L6, L7.

| Lane | Worktree | Branch | State | Contract requests |
|------|----------|--------|-------|-------------------|
| L1 | — | — | pending | — |
| L2 | — | — | pending | — |
| L3 | — | — | blocked on L2 | — |
| L4 | — | — | pending (needs design reference from Cameron) | — |
| L5 | — | — | blocked on L4 | — |
| L6 | — | — | blocked on L1, L2, L4 | — |
| L7 | — | — | blocked on L1, L3, L4 | — |
| L8 | — | — | pending | — |
| L9 | — | — | pending | — |
| L10 | — | — | pending | — |

### Inputs still needed from Cameron

1. **Frontend design reference** for L4 (build-plan §6.3 "frontend design reference you provide").
2. Answers to build-plan §9 open questions that affect Stage 1 defaults — at minimum **Q1 price/window** (contracts default `windowBlocks=4`), **Q2 mints per video** (contracts allow several), **Q6 subscriptions = NIP-51 set** (contracts assume the set, kind 30000), **Q8 web-upload transcode at gateway** (L3/L8 scope).
3. Whether a shipped `ffmpeg` binary is acceptable in the desktop bundle (S-C open question 1) — affects L8's desktop adapter.

## Stage 2 — audit surface (single security session): NOT STARTED
## Stage 3 — integration and polish: NOT STARTED
