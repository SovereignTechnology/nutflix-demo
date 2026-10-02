# nutflix-demo

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

> **The Pear-runtime demo — working.** A Nostr-native peer-to-peer video network where seeders
> are paid per block in Cashu ecash, the creator picks the mint, and the UI aims at YouTube
> rather than at a protocol demo. This repository is the JavaScript implementation on Electron +
> the Pear runtime (Hypercore/Hyperblobs over Hyperswarm). **For the Rust/iroh implementation,
> see nfx** (published separately).
>
> Status: Stages 0–2 done; Stage 3 (integration and polish) in review. See
> [`docs/status.md`](docs/status.md) and the security review
> [`docs/security-review.md`](docs/security-review.md).

The source of truth is on Nostr (NIP-34, via [ngit](https://ngit.dev)); GitHub is a mirror.

**"Nutflix" is the brand name only.** Package scope is `@sovit/*`, the wire protocol is
`pay/1`, and nothing in the code depends on the brand (build plan §9.11).

## Read first

| Document | What it is |
|----------|------------|
| [`docs/plan/build-plan.md`](docs/plan/build-plan.md) | The *what*: assumptions, threat model, architecture, data model, `pay/1`, payment flow, UI, hardening, phases, open questions |
| [`docs/plan/execution.md`](docs/plan/execution.md) | The *how*: ground rules for parallel agents, stages, lanes, merge order, prompts |
| [`SECURITY.md`](SECURITY.md) | Threat table (normative for the adversary suite), money-path invariants, locked directories |
| [`docs/decisions/`](docs/decisions/) | ADRs — from 0002 (stack) to 0018 (one seeder per block); 0014 wallet journal, 0015 images over Pear, 0016 NUT-13 seed backup, 0017 packaging |
| [`docs/security-review.md`](docs/security-review.md) | The security review: every finding, its state and residuals |
| [`docs/reviews/`](docs/reviews/) | Pre-push review records (differential review + sharp edges) for each change |
| [`docs/spikes/`](docs/spikes/) | S-A per-peer gating, S-B browser Hypercore, S-C transcode |
| [`docs/lanes/BRIEFS.md`](docs/lanes/BRIEFS.md) | Per-lane allowlists, context, definition of done |
| [`docs/vendor/`](docs/vendor/) | Pinned upstream specs and READMEs. **The API is what is in here and in `node_modules/`, not what you remember.** |

## Layout

```
packages/core         @sovit/core        runtime-agnostic protocol lib: contracts, mocks, (nostr, manifest, media, payment…)
packages/seeder       @sovit/seeder      Corestore + Hyperblobs seeder daemon, pay/1 server side
packages/gateway      @sovit/gateway     seeder + WS bridge + Blossom HTTP
packages/ui           @sovit/ui          React design system + screens, talks only to NetworkAdapter
packages/app-desktop  @sovit/app-desktop Electron + pear-runtime Bare worker shell
packages/app-web      @sovit/app-web     static web shell: in-page Hypercore over WS, service-worker player
```

`packages/core/src/contracts/` is the frozen interface surface (`CONTRACTS_VERSION`).
`payment/`, `signer/`, `pay-protocol/`, `wallet/spend.ts`, `wallet/seed.ts` and
`gateway/src/auth/` are the **audit surface**: nothing there logs, and they import only the
audited libraries (`scripts/check-locked-dirs.sh`, [SECURITY.md](SECURITY.md#locked)).

## Getting started

```sh
git clone nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/nutflix-demo
# or the mirror: git clone https://github.com/SovereignTechnology/nutflix-demo.git
cd nutflix-demo
npm ci --ignore-scripts     # .npmrc already sets ignore-scripts + exact pins
npm run hooks:install       # pre-commit: lane path allowlist + locked-dir check
npm run build               # typecheck + bundles; tests run in CI (below)
```

Requires Node ≥ 22.12. Refresh vendored docs with `scripts/vendor-docs.sh`.

### Working in a lane

```sh
scripts/new-lane-worktree.sh L2 packages/seeder/
cd .worktrees/L2            # .lane holds the allowlist; the hook enforces it
```

## CI and hardening

CI runs on GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): the
supply-chain gates (lockfile drift, registry-only resolutions, `npm audit signatures`,
advisories), lint, typecheck, the audit-surface and contracts-version checks, the native-module
inventory, the Electron security lint, the test suite, the Electron e2e (Chromium's sandbox on,
under xvfb) and the packaging stage gates. A fuzz campaign over the pay/1 codec and the payment
parsers runs on demand ([`.github/workflows/fuzz.yml`](.github/workflows/fuzz.yml), Actions tab →
fuzz → Run workflow; its targets also run briefly in every CI run). [`ci/gitlab-ci.yml`](ci/gitlab-ci.yml) mirrors the
same gates for a GitLab runner.

`npm run ci` = lint → typecheck/build → test → locked-dir check → native-module inventory
(`docs/native-modules.txt`, `scripts/native-module-inventory.sh --check`) → Electron
security lint (`scripts/electron-security-lint.mjs`). Other tooling from build-plan §7:

| Tool | Purpose |
|------|---------|
| `scripts/reproducible-web-build.sh --twice` | Clean build → deterministic tree hash → unsigned Nostr event template (`artifacts/web-build/`) |
| `scripts/csp-sri.mjs <index.html>` | SRI on every script/stylesheet + strict CSP as `<meta>` and a headers file; fails on inline or third-party code |
| `deploy/systemd/` | Hardened seeder/gateway units, directive-by-directive README, and the measured `MemoryDenyWriteExecute` result |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues: see [SECURITY.md](SECURITY.md) — do not open a public issue.

## Licence

Copyright (C) 2026 Cameron. AGPL-3.0-or-later — see [LICENSE](LICENSE).
