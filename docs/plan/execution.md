# Nutflix — Execution Plan: Opus 5 (high) parallel lanes + Fable 5.1 (high) security pass

Companion to `nutflix-build-plan.md` (the *what*). This is the *how*: which model does which work, in what order, with what isolation, and the prompts to drive it.

**Model split, stated once:**

| Model | Role | Runs |
|-------|------|------|
| **Opus 5, high effort** | Orchestrator + parallel lane subagents. Builds everything *except* the audit surface. | Stages 0, 1, 3 |
| **Fable 5.1, high effort** | Single serial session. Implements the audit surface against pre-written adversary tests, then reviews the seams the lanes produced. | Stage 2 |
| **Local models (GLM-5.2 / Kimi K2.6)** | Optional: substitute for Opus in lanes L4/L5/L9 (UI volume, docs, CI) if you want to save spend. Never in Stage 2. | — |

**Parallelism buys wall-clock, not tokens.** Expect ~10–20% *more* total tokens than a serial build (coordination, contract re-reads, merge fixes) and roughly 3–4× less calendar time on Stage 1. If your constraint is spend rather than time, run fewer lanes concurrently; the lane boundaries are the same either way.

---

## 0. Ground rules that make parallel agents safe

These are mechanical, not advisory. Encode them in the repo so a subagent cannot violate them by accident.

1. **Contracts freeze before fan-out.** `packages/core/src/contracts/*.ts` (interfaces only, no logic) is written by the orchestrator in Stage 0 and versioned (`CONTRACTS_VERSION`). A lane that needs a contract change stops and files an issue; the orchestrator changes it and re-broadcasts. No lane edits contracts.
2. **One lane = one git worktree = one package directory.** A lane's prompt names the directories it may write. A pre-commit hook rejects commits touching paths outside the lane's allowlist.
3. **Locked directories.** `packages/core/src/payment/`, `packages/core/src/signer/`, `packages/core/src/pay-protocol/`, `packages/core/src/wallet/spend.ts`, and `packages/gateway/src/auth/` contain only interfaces, a `MockPaymentEngine`, and tests until Stage 2. CODEOWNERS + a CI check fail any Stage 1 PR that adds implementation there.
4. **Mocks are explicit and cheatable.** `MockPaymentEngine` has `mode: 'honest' | 'stiff-creator' | 'stiff-seeder' | 'double-spend' | 'forge'`. Lanes integrate against `honest`; the adversary test suite (L10) asserts the real engine will reject the others. This is how the rest of the system gets built without waiting on the audit surface.
5. **Every lane leaves `npm test` and `npm run lint` green in its worktree** before the orchestrator merges. Merge order is fixed (§2). A red merge is reverted, not patched forward.
6. **Vendored docs, not memory.** `docs/vendor/` holds the current Pear guides (stream-stored-video, pear-electron, bare workers), the Hypercore/Hyperblobs/hypercore-blob-server READMEs, BUD-01/02/03/04/06/09, NIP-22/51/60/61/71, NUT-03/04/05/11/12. Every prompt says: *"the API is what is in `docs/vendor/` and `node_modules/`, not what you remember."* Refresh these at the start of each stage.
7. **Context per lane is scoped.** A lane gets: its section of the build plan, the contracts file, its package dir, the vendored docs it needs, `SECURITY.md`. It does not get the whole repo. Smaller context = fewer hallucinated cross-package edits and fewer tokens.
8. **Screenshots into the UI loop.** L4/L5 lanes run Storybook/Vite and capture PNGs of each component/screen into `artifacts/screens/`; the orchestrator (or you) reviews those, not the JSX.
9. **No model writes crypto.** Any lane that finds itself implementing hashing, signatures, blinding, or key derivation stops. The libraries are `@cashu/cashu-ts`, `sodium-native`/`sodium-universal`, `nostr-tools`, `hypercore`.

---

## 1. Stage 0 — Orchestrator setup (Opus 5 high, serial, ~1–2 days)

Deliverables, in order:

1. Monorepo scaffold: `packages/{core,seeder,gateway,ui,app-desktop,app-web}`, pnpm or npm workspaces, TypeScript strict, ESLint, Vitest, Storybook for `ui`, pre-commit path-allowlist hook, CODEOWNERS, CI skeleton.
2. `docs/vendor/` populated (rule 6). `docs/plan/` = the build plan split per package section.
3. `SECURITY.md` = threat model table verbatim from the build plan.
4. **Contracts** (`packages/core/src/contracts/`):
   - `Signer` — `getPublicKey`, `signEvent`, `nip44Encrypt/Decrypt`, optional `signSecret`.
   - `Wallet` — `balance(mint)`, `mintQuote`, `pollQuote`, `send(amount, {p2pk, mint})`, `receive(proofs)`, `melt(invoice)`, `history()`.
   - `PaymentEngine` — viewer side `pay(range, seederPubkey, creatorPubkey)`; seeder side `verify(payMsg) → Accept | Reject(reason)`; `window` accounting API.
   - `PayProtocol` — message types `HELLO/PAY/ACK/PRICE`, `attach(mux)`.
   - `NetworkAdapter` — everything the UI is allowed to call: `feed`, `video(id)`, `comments`, `react`, `subscribe`, `play(videoId, rendition) → MediaSource | URL`, `wallet`, `studio.upload`, `seeder.status`.
   - `Manifest` types; NIP-71 tag schema; Hyperblob reference type.
   - `MockPaymentEngine`, `MockNetworkAdapter` (fixture videos, fake sats).
5. Three spikes, run as parallel subagents (each is a throwaway worktree that writes a one-page result to `docs/spikes/`):
   - **S-A** Hypercore per-peer upload gating: is there an API, or is stream-destroy the tool?
   - **S-B** Current Hypercore + Hyperblobs in a browser over a WS bridge with in-memory storage + service worker → `<video>`. Pass/fail.
   - **S-C** `bare-ffmpeg` / `bare-media` capabilities for transcode + thumbnail; fallback to `bare-subprocess` + system ffmpeg.
6. Orchestrator reads spike results, resolves assumptions A4/A8/A9 and Spike-C, updates contracts if needed, bumps `CONTRACTS_VERSION`, and **freezes**.

---

## 2. Stage 1 — Parallel lanes (Opus 5 high subagents)

Ten lanes. Wave 1 has no cross-lane dependencies; Wave 2 depends on Wave 1 outputs but only through frozen contracts, so it can start as soon as the specific upstream artifact exists (not when the whole wave finishes).

### Wave 1 (start together)

| Lane | Package / dirs | Builds | Context it gets |
|------|----------------|--------|-----------------|
| **L1 nostr-data** | `core/src/nostr/`, `core/src/manifest/` | Relay pool, feeds (follows, tags, trending-by-9321), comments (NIP-22), reactions, NIP-51 sets incl. private, kind 10019 read, NIP-71 build/parse/verify, kind 0 profiles + NIP-05 | Plan §2.2, NIPs 22/51/61/71, contracts |
| **L2 seeder** | `packages/seeder/` | Corestore + Hyperblobs, swarm join per core, CAS + sha256 index, disk cap, per-pubkey rate limits + ban list, `upload` event accounting wired to `PaymentEngine.verify` (mock), batch swap/nutzap scheduler (calls `Wallet`), melt CLI, systemd unit, log-redaction layer | Plan §2.1/§2.3/§7, Pear stream-video guide, Hypercore/Hyperblobs docs, spike S-A |
| **L4 design-system** | `ui/src/tokens/`, `ui/src/components/` | Tokens, `VideoCard`, `Player` chrome (controls/keyboard/PiP/mini), `ChannelRow`, `SatsBadge`, `MintChip`, `PeerMeter`, `Skeleton`, `Sheet`, `Toast`, markdown-subset renderer (no raw HTML), Storybook + screenshot script | Plan §6.3/§6.2, frontend design reference you provide |
| **L8 transcode** | `packages/core/src/media/`, `app-desktop/src/worker/transcode/` | Probe, rendition ladder, faststart MP4, thumbnails, placeholder, storyboard sprite, write-to-Hyperblobs + sha256; `Studio.upload` implementation behind the adapter | Plan §6.4, spike S-C |
| **L9 ci-hardening** | `.github/` or CI dir, `deploy/`, root configs | Lockfile policy, `npm ci --ignore-scripts`, provenance checks, native-module inventory, reproducible web build + hash → Nostr event script, CSP/SRI generator, systemd hardening units, Electron security config lint | Plan §7 |
| **L10 adversary-tests** | `core/src/payment/__tests__/`, `core/src/pay-protocol/__tests__/`, `gateway/src/auth/__tests__/` | Property tests written **from `SECURITY.md`**, one test per threat row, targeting the *interfaces*. Must pass against `MockPaymentEngine('honest')` and fail (assert rejection) for every cheating mode. Fuzz harness for the `pay/1` codec. | `SECURITY.md`, contracts, NUT-11/12. **Writes tests only. No implementation.** |

### Wave 2 (start when the named upstream exists)

| Lane | Package / dirs | Builds | Depends on |
|------|----------------|--------|------------|
| **L3 gateway** | `packages/gateway/` | WS bridge (replication stream + `pay/1` mux over WebSocket), Blossom HTTP BUD-01/02/03/04/06/09 backed by seeder's sha256 index, `HELLO` price disclosure, upstream paying via `PaymentEngine` (mock). `auth/` stays interface + tests. | L2 seeder API |
| **L5 screens** | `ui/src/screens/` — **fan out one subagent per screen**: Home, Watch, Channel, Search, Shorts, Library, Studio, Wallet, Settings | Each screen against `MockNetworkAdapter`, using L4 components only; empty/error states; screenshot per state | L4 components |
| **L6 desktop-shell** | `packages/app-desktop/` | pear-electron shell, Bare worker hosting seeder + `hypercore-blob-server`, preload bridge exposing only `NetworkAdapter`, `contextIsolation`/`sandbox`/no `nodeIntegration`, local encrypted signer + NIP-46 adapter, real `NetworkAdapter` over worker IPC | L2, L1, L4 |
| **L7 web-shell** | `packages/app-web/` | Static shell, `NetworkAdapter` over WS to gateway, in-page Hypercore + service worker player (or MSE fallback per S-B), NIP-07/46 signer adapter with `signSecret` detection, in-memory NIP-60 (no persistence), CSP/SRI wiring from L9 | L3, L1, L4, spike S-B |

### Merge order (orchestrator, strict)

L9 → L1 → L10 → L4 → L2 → L8 → L3 → L5 (screens in any order) → L6 → L7. Each merge: run full workspace test, run screenshot diff for UI, update `docs/status.md`.

**Stage 1 exit:** the desktop app plays a fixture video from two seeders with the *mock* payment engine; the web portal does the same through a gateway; adversary tests are green against the honest mock and red-as-expected against cheating modes; every locked directory is still interface-only.

---

## 3. Stage 2 — Fable 5.1 (high), single serial session

This is one session, one worktree, no subagents. It needs the whole picture of the money path in one context, and it needs to be reviewable as a single set of PRs.

**Inputs:** the full build plan, `SECURITY.md`, contracts, L10's adversary tests, the vendored NUT-03/04/05/11/12 and NIP-60/61 specs, `node_modules/@cashu/cashu-ts` source, and read access to the whole repo.

**Part A — Implement the audit surface (in this order):**

1. `core/src/signer/` — local encrypted key (argon2id, `sodium-native` secure memory, zeroize), NIP-46, NIP-07 adapter, `signSecret` detection.
2. `core/src/wallet/spend.ts` — proof selection, NUT-11 P2PK send producing two locked sets, DLEQ inclusion, NIP-60 state transitions (7375 with `del`, 7376 history), receive/swap, melt. Thin over cashu-ts; no crypto.
3. `core/src/payment/` — real `PaymentEngine`: viewer `pay()`, seeder `verify()` (DLEQ against cached keyset, P2PK target check, exact amounts, mint allowlist, overpay rejection), window accounting, async swap batching with double-spend → ban.
4. `core/src/pay-protocol/` — `HELLO/PAY/ACK/PRICE` codec (compact-encoding), state machine, protomux attach alongside Hypercore replication, stream-destroy-on-window-exceeded (or the finer API if S-A found one).
5. `gateway/src/auth/` — kind 24242 verification for BUD-02/04/09, replay protection, expiry, pubkey allow/deny.

Each step: make L10's tests pass, add any adversary case the tests missed (and say why it was missed), no test deleted or weakened without a written justification in the PR.

**Part B — Security review of the seams (produce `docs/security-review.md`):**

- Electron: preload surface, IPC message validation, CSP, `webPreferences`.
- Web: CSP/SRI as built, service worker scope, anything touching `localStorage`/`IndexedDB` (must be nothing), signer capability messaging.
- Seeder/gateway: rate limits actually enforced per pubkey, ban persistence, log redaction coverage (grep every logger call), key file permissions, systemd unit effectiveness.
- Dependencies: native module inventory vs lockfile, install scripts, provenance.
- Nostr data layer: event signature verification on every read path, markdown renderer escapes, thumbnail hash verification before display.
- UI: any place a user could be tricked into paying more than displayed (price shown vs price charged; rendition switch; autoplay).

Findings ranked, each with a concrete fix, filed as issues tagged `stage-3`.

**Stage 2 exit:** adversary suite green against the real engine; `docs/security-review.md` written; you have personally read every diff in the five locked directories.

---

## 4. Stage 3 — Integration and polish (Opus 5 high subagents)

- One lane per `stage-3` finding from the review, same isolation rules.
- Real-mint testing lane: testnet mint, three seeders, live double-spend attempts, network drops mid-`PAY`.
- UI polish loop: you review `artifacts/screens/`, write notes, one subagent per screen applies them. Cap at three rounds per screen; if a screen isn't landing by round three, the problem is the design reference, not the model.
- Fuzz runs on `pay/1` codec and `payment` parsers, 24 h continuous, findings back to a **Fable 5.1 mini-session** (not Opus) if any touch the locked directories.
- Release: reproducible build hash → Nostr event; Pear stage/release from the offline-key machine.

---

## 5. Prompts

Three prompts. Use them verbatim as system prompts (Claude Code `.claude/agents/*.md` or your OpenClaw/LiteLLM harness); fill the `{{...}}` slots.

### 5.1 Orchestrator (Opus 5, high)

```
You are the orchestrator for the Nutflix monorepo. You do not write feature code. You:
- maintain packages/core/src/contracts/ and CONTRACTS_VERSION; you are the only writer of that directory;
- spawn lane subagents with the lane prompt (docs/prompts/lane.md), giving each ONLY the context listed for its lane in docs/plan/execution.md §2;
- enforce the locked directories in docs/plan/execution.md §0 rule 3 — reject any lane output that adds implementation there;
- merge lanes in the fixed order in §2, running the full workspace test and the screenshot diff before each merge; on red, revert, never patch forward;
- keep docs/status.md current after every merge: what merged, what is blocked, open contract-change requests.
Rules: the API is what is in docs/vendor/ and node_modules/, not what you remember. No model writes cryptographic primitives. If a lane requests a contract change, evaluate it against the build plan's threat model, change the contract yourself, bump the version, and re-issue affected lanes with the new version. Never let a lane proceed on a stale CONTRACTS_VERSION.
Current stage: {{stage}}. Lanes to run now: {{lanes}}.
```

### 5.2 Lane subagent template (Opus 5, high; or local model for L4/L5/L9)

```
You are lane {{lane_id}} ({{lane_name}}) for the Nutflix monorepo, working in git worktree {{worktree_path}}.
You may write ONLY under: {{allowed_paths}}. A pre-commit hook enforces this; do not try to work around it.
You may NOT modify: packages/core/src/contracts/ (frozen at CONTRACTS_VERSION={{version}}), or any directory listed as locked in SECURITY.md §locked. If you need a contract change, stop, write the request to docs/contract-requests/{{lane_id}}.md, and end your turn.
Your task: {{lane_task_from_execution_plan}}.
Your context: {{plan_sections}}, packages/core/src/contracts/, docs/vendor/{{docs_list}}, SECURITY.md. The API is what is in docs/vendor/ and node_modules/, not what you remember — read the actual source before calling anything.
Integrate against MockPaymentEngine('honest') and MockNetworkAdapter where a real implementation is not yet merged.
Definition of done: npm test and npm run lint green in your worktree; {{lane_specific_done}}; a short docs/lanes/{{lane_id}}.md stating what you built, what you assumed, and anything you were unsure about. Do not implement hashing, signatures, blinding, or key derivation — call the libraries. If you find yourself doing so, stop and report.
```

Lane-specific `{{lane_specific_done}}` examples: L4/L5 — "a PNG per component/screen state in artifacts/screens/"; L2 — "two seeder instances on separate ports replicate a fixture Hyperblob and the upload-event accounting matches"; L10 — "every SECURITY.md threat row has a named test; all pass on 'honest' and assert rejection on each cheating mode".

### 5.3 Fable 5.1 (high) — Stage 2 session

```
You are the security implementer and reviewer for the Nutflix monorepo. Everything except the audit surface has been built by other agents against interfaces and a MockPaymentEngine. Your job, in this single session:

PART A — implement, in this order, making the pre-written adversary tests pass:
1. packages/core/src/signer/  2. packages/core/src/wallet/spend.ts  3. packages/core/src/payment/  4. packages/core/src/pay-protocol/  5. packages/gateway/src/auth/
Constraints: thin wrappers over @cashu/cashu-ts, sodium-native/universal, nostr-tools, hypercore, protomux — read their source in node_modules before use; never reimplement a primitive. Never delete or weaken a test; if a test is wrong, say why in the PR and fix the test with justification. After each module, add adversary cases the existing tests missed and state why they were missed. Key material lives only in secure buffers and is zeroized; nothing in these directories may log a proof, token, or key. Pay-after-verify ordering, exact-amount checks, DLEQ verification, P2PK target checks, window accounting, and ban-on-double-spend are non-negotiable and are specified in SECURITY.md and docs/plan/build-plan.md §1–§3.

PART B — review the seams and write docs/security-review.md:
Electron preload/IPC/CSP; web CSP/SRI/service-worker/storage (must be no browser persistence of proofs or keys); seeder and gateway rate limits, ban persistence, log redaction coverage (inspect every logger call), key file permissions, systemd units; dependency inventory vs lockfile, install scripts, provenance; Nostr read paths (signature verification everywhere), markdown renderer escaping, thumbnail hash checks; any UI path where the price shown can differ from the price charged.
Rank findings, give a concrete fix for each, and file them as issues tagged stage-3. Do not fix them yourself outside the five directories above.

Inputs: docs/plan/, SECURITY.md, packages/core/src/contracts/, the adversary test suites, docs/vendor/{NUT-03,04,05,11,12, NIP-60, NIP-61}, and read access to the full repo. Deliver Part A as one PR per module and Part B as a single document. Be explicit about anything you could not verify.
```

---

## 6. Sequencing summary

| Stage | Model | Parallel? | Rough wall-clock |
|-------|-------|-----------|------------------|
| 0 — scaffold, contracts, spikes | Opus 5 high | spikes only (3) | 1–2 days |
| 1 — lanes | Opus 5 high (± local for L4/L5/L9) | yes, up to ~10 + per-screen fan-out | 1–2 weeks |
| 2 — audit surface + review | **Fable 5.1 high** | no | 2–4 days plus your review time |
| 3 — findings, real-mint tests, polish | Opus 5 high | yes | 1–2 weeks |

Your own time is on the critical path in three places and nowhere else: freezing the contracts at the end of Stage 0, reading the locked-directory diffs at the end of Stage 2, and reviewing screenshots in Stage 3. Everything else the orchestrator can run while you sleep.
