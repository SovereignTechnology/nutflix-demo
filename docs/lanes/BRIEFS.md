# Stage 1 lane briefs (CONTRACTS_VERSION = 2)

Fill the lane prompt (`docs/prompts/lane.md`) from this table. Every lane gets, in addition
to what is listed: `packages/core/src/contracts/`, `SECURITY.md`, `docs/decisions/0003-*.md`
(spike resolutions), and this file's row. Nothing else. Create the worktree with
`scripts/new-lane-worktree.sh <LANE> <allowed paths…>`.

Merge order (strict): **L9 → L1 → L10 → L4 → L2 → L8 → L3 → L5 (any order) → L6 → L7.**

## Wave 1

| Lane | Allowed paths | Plan sections | Vendored docs | Lane-specific done |
|------|---------------|---------------|---------------|--------------------|
| **L1 nostr-data** | `packages/core/src/nostr/`, `packages/core/src/manifest/` | build-plan §2.2 | NIP-01, 05, 22, 25, 50, 51, 56, 61, 65, 71, 92; `nostr-tools.md` | Every read path verifies event signatures (T9); `manifest` build/parse/verify round-trips the fixtures in `core/src/mocks/fixtures.ts`; NIP-51 private sets encrypt via `Signer.nip44*` only |
| **L2 seeder** | `packages/seeder/` | build-plan §2.1, §2.3, §7; spike S-A | `hypercore.md`, `hyperblobs.md`, `corestore.md`, `hyperswarm.md`, `protomux.md`, `pear-store-and-serve-large-media-with-hyperblobs.md`, `examples/hyperblobs-*` | Two seeder instances on separate ports replicate a fixture Hyperblob and `upload`-event accounting matches; **runtime-verify S-A finding 3** (destroy inside `upload` leaves the viewer with exactly `window` blocks); ban list persisted on Noise key + Nostr pubkey; every logger call goes through the redaction layer |
| **L4 design-system** | `packages/ui/src/tokens/`, `packages/ui/src/components/`, `packages/ui/.storybook/` | build-plan §6.2, §6.3 | — (plus the frontend design reference Cameron supplies) | Storybook runs; a PNG per component state in `artifacts/screens/components/`; markdown-subset renderer has a test proving raw HTML never renders |
| **L8 transcode** | `packages/core/src/media/`, `packages/app-desktop/src/worker/transcode/` | build-plan §6.4; spike S-C; `contracts/media.ts` | `bare-subprocess.md`, `bare-subprocess-reference.md`, `bare-ffmpeg.md`, `bare-media.md` | Pure-planning `MediaPipeline` with injected `ProcessRunner`/`FsAdapter`; Node adapter tested against a real `ffmpeg` (document how the binary is obtained/pinned); every emitted MP4 verified faststart by reading the box order; **note `bare-subprocess.spawn()` throws synchronously on ENOENT** |
| **L9 ci-hardening** | `ci/`, `.gitlab/`, `deploy/`, `scripts/`, root configs (`package.json`, `.npmrc`, `eslint.config.js`, `tsconfig*.json`, `vitest.config.ts`) | build-plan §7 | — | `scripts/native-module-inventory.sh --accept` produces `docs/native-modules.txt` and `--check` passes; reproducible web build script emits a hash + Nostr event template; systemd units for seeder/gateway with the §7 hardening set and a test of `MemoryDenyWriteExecute` against the JS engine; Electron security config lint |
| **L10 adversary-tests** | `packages/core/src/payment/__tests__/`, `packages/core/src/pay-protocol/__tests__/`, `packages/gateway/src/auth/__tests__/` | SECURITY.md (threat table + invariants) | NUT-11, NUT-12, BUD-01, BUD-02, BUD-04, BUD-09 | One named test per SECURITY.md threat row T1–T16 and per invariant 1–8, targeting the **interfaces**; all pass on `MockPaymentEngine('honest')` and assert rejection on every cheating mode (`core/src/mocks/__tests__/mock-payment-engine.test.ts` is the seed — extend, do not duplicate); `fast-check` fuzz harness for the `pay/1` codec against `PayProtocolCodec` (must never throw). **Writes tests only.** |

## Wave 2 (start when the named upstream exists)

| Lane | Allowed paths | Plan sections | Vendored docs | Depends on | Lane-specific done |
|------|---------------|---------------|---------------|------------|--------------------|
| **L3 gateway** | `packages/gateway/` (except `src/auth/` implementation) | build-plan §5; spike S-B | BUD-01, 02, 03, 04, 06, 09; `hypercore-blob-server.md`; `hypercore.md` | L2 seeder API | WS bridge: one WebSocket = one replication stream + `pay/1` mux (Duplex adapter per S-B); Blossom `GET/HEAD /<sha256>` with ranges from the sha256→blob index; `HELLO` discloses gateway price; upstream paying via `PaymentEngine` (mock); `auth/` stays interface + tests |
| **L5 screens** | `packages/ui/src/screens/<Screen>/` — one subagent per screen | build-plan §6.1, §6.2 | — | L4 | Each screen against `MockNetworkAdapter` (use `failWith`/`latencyMs` for empty/error/loading states); L4 components only; a PNG per state in `artifacts/screens/<screen>/`; price shown before any playback starts |
| **L6 desktop-shell** | `packages/app-desktop/` | build-plan §2.1, §7; ADR 0003 (Electron + `pear-runtime` Bare worker, **not** `pear-electron`) | `pear-desktop-architecture.md`, `pear-workers.md`, `pear-start-from-hello-pear-electron.md`, `pear-stream-stored-video.md`, `examples/video-stream/`, `examples/hello-pear-electron/`, `hypercore-blob-server.md` | L2, L1, L4 | Bare worker hosts seeder + `hypercore-blob-server`; preload exposes only `NetworkAdapter`; `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` asserted by a test; signer is `Signer` interface only (local encrypted signer lands in Stage 2) |
| **L7 web-shell** | `packages/app-web/` | build-plan §5; spike S-B (shim list) | `hypercore.md`, `hyperblobs.md`, NIP-07, NIP-46, NIP-60; `pear-ref-protomux.md` | L3, L1, L4 | In-page Hypercore over WS with the S-B shims (in-memory `hypercore-storage` backend, sodium polyfill) and a service worker answering `<video>` range requests; MSE fallback path exists; NIP-07/46 adapter detects `signSecret` and the UI states the mode; **no proofs or keys in `localStorage`/`IndexedDB`** (test greps the bundle); CSP/SRI wired from L9 |

## Spike-derived facts every lane should know

- `upload` fires **before** the block is sent; window cuts happen synchronously there (S-A).
- Browser Hypercore needs `rocksdb-native` → in-memory shim and a `crypto_scalarmult_ed25519_noclamp` polyfill (S-B). No `udx-native` in the browser bundle.
- No `bare-*` addon loads under Node; `bare-ffmpeg` has no H.264 encoder, no faststart, no seek (S-C).
- Hyperblobs block size default 64 KiB; id `{byteOffset, blockOffset, blockLength, byteLength}` (A9).
- `bare` runtime binary from npm lands mode 0664 with no `.bin/bare` link under `--ignore-scripts` (S-C finding 1).
