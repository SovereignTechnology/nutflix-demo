# Stage 2 security session prompt (execution plan §3, §5.3)

## Before starting

- **Cameron starts Stage 2.** An orchestrator never starts it on its own. The plan says one
  serial session, one worktree, no subagents, on **Fable 5.1 (high)** (execution plan §3). Confirm
  the model and session with Cameron first.
- Prerequisites: Stage 1 is tagged `stage-1`, `npm run ci` is green on `main`, and a fresh branch
  `stage-2/<date>` exists off `main`.
- Run with `LOCKED_DIRS_UNLOCKED=1` so `scripts/check-locked-dirs.sh` permits implementation in
  the five locked paths: `packages/core/src/{payment,signer,pay-protocol}`,
  `packages/core/src/wallet/spend.ts` and `packages/gateway/src/auth`.

## What changed since the plan was written (2026-09-04 → 2026-09-23)

The session prompt below already cites these; this list is for the person starting it.

- **Contracts are at v4** (ADR 0004, ADR 0007). **Stage 2 owns the v5 bump.** The input list is
  `docs/status.md` → "Open contract-change requests", items 1–9 (full text in
  `docs/contract-requests/*.md`).
- **ADR 0007 per-PAY split:** a minimum PAY size (proposed `minPaySats` 10, with the credit
  window ≥ one minimum PAY) plus the creator's fractional remainder carried per pay/1 channel ×
  core. `carryIn` goes on the wire, the carry advances only on an accepted PAY, and there is no
  end-of-stream flush. This replaces ADR 0005 Q1's bare `ceil` (see ADR 0005's erratum).
- **`MockPaymentEngine` has two money-path bugs** (found by L6-C, `docs/contract-requests/L6-C.md`):
  `recordUpload` treats a block index as a count, so a seeder serving a non-prefix set can never
  be paid, and two mock wallets mint identical secrets, which triggers a false double-spend ban.
  The desktop worker runs on a dev-only `DevEngine` wrapper
  (`packages/app-desktop/src/worker/dev/dev-engine.ts`) until the mock is fixed. **L10's
  adversary suite runs against this mock, so re-check its expectations when it changes.**
- **The desktop app exists** (L6, `docs/plan/L6-design.md`, `docs/lanes/L6-*.md`). Stage 2 hooks
  already in place:
  - `packages/app-desktop/src/main/money-gate.ts`: a stub for a native confirm before
    `wallet.melt` / `seeder.melt` / `nutzap`. It fails closed outside `--dev-mocks`.
  - `EXCLUDED_METHODS` in `src/ipc/protocol.ts`: the renderer can never reach
    `wallet.send/receive/p2pkPubkey/keyset` (D3, D5).
  - The residual SE-1 risk: a compromised renderer *process* can request a file token for any
    regular file it can name. Pick upload files through a main-process `dialog` instead.
- **Provider seams return `undefined` in Stage 1:** the gateway's `cli/providers.ts`, the seeder's
  `cli/providers.ts`, the desktop worker's `src/worker/providers.ts`, and the host's
  `src/host/wallet.ts` and `src/host/identity.ts` (`NoIdentity`). Implementing the audit surface
  is Stage 2. Wiring real providers into these seams is Stage 3 integration, unless the Stage 2
  exit criteria need it.
  **The standalone seeder daemon needs more than a provider:** it does not yet attach pay/1 to
  swarm sessions or send HELLO, and `session.mux` is still null at the seeder's own
  `session-open` (a hook in `seeder.ts`, or a daemon-owned swarm like the desktop worker's
  `PeerNode`). See `packages/seeder/src/cli/providers.ts` and `docs/lanes/Seeder-entry.md`.
- **There is no web portal.** L7 was never started, and the TS app is Pear/desktop-only (ADR
  0006, unmerged, on `spec/nfx-suite-m0`). Part B's web items cover only what exists, i.e. the
  gateway's Blossom HTTP responses.
- **The next ADR here is 0010.** 0006 and 0008 are reserved for the NFX suite and the nfx master
  plan.

## The session prompt

```
You are the security implementer and reviewer for the Nutflix monorepo. Everything except the audit surface has been built by other agents against interfaces and a MockPaymentEngine. Your job, in this single session:

PART 0 — contracts v5, before any implementation:
Bump CONTRACTS_VERSION to 5 with an ADR (0010). The input list is docs/status.md "Open contract-change requests" items 1–9 and docs/contract-requests/*.md; accept, amend or defer each item in writing. The load-bearing ones: the ADR 0007 per-PAY split (minimum PAY size + creator carry, carryIn on the wire, carry advances only on an accepted PAY, no end-of-stream flush) replacing ADR 0005 Q1's bare ceil; BlockRange.core and recordUpload's core become required (ADR 0004), and recordUpload carries the block index, or the count rule is written down; core in pay/1 ACK and PRICE, windowBlocks in HELLO; NostrKind.Deletion; seedersOnline able to say "unknown"; the signer connect/lock surface; upload abort; the UploadInput.file text (a main-minted file token on desktop, SE-1). Fix MockPaymentEngine's two bugs found by L6-C (block index treated as a count; identical secrets across mock wallets), then re-run L10's adversary suite and re-check every expectation that relied on the old mock behaviour. Say which of those expectations changed and why.

PART A — implement, in this order, making the pre-written adversary tests pass:
1. packages/core/src/signer/  2. packages/core/src/wallet/spend.ts  3. packages/core/src/payment/  4. packages/core/src/pay-protocol/  5. packages/gateway/src/auth/
Constraints: thin wrappers over @cashu/cashu-ts, sodium-native/universal, nostr-tools, hypercore, protomux — read their source in node_modules before use; never reimplement a primitive. Never delete or weaken a test; if a test is wrong, say why in the PR and fix the test with justification. After each module, add adversary cases the existing tests missed and state why they were missed. Key material lives only in secure buffers and is zeroized; nothing in these directories may log a proof, token, or key. Pay-after-verify ordering, exact-amount checks, DLEQ verification, P2PK target checks, window accounting, and ban-on-double-spend are non-negotiable and are specified in SECURITY.md and docs/plan/build-plan.md §1–§3. The per-PAY split is ADR 0007 as amended by your v5 ADR. The 27 Stage-2-gated skips (13 BlossomAuth, 10 pay/1 codec, 4 skipIf(usingMock())) must all run and pass at the end.

PART B — review the seams and write docs/security-review.md:
Electron (docs/plan/L6-design.md §3 security checklist, D1–D6): preload surface and EXCLUDED_METHODS, IPC gate and guards, file tokens (SE-1 and its residual renderer-process risk), CSP, webPreferences, the nf-media proxy and the worker's gated playback server (buffer = money: the resolve allowlist, pacing, credit pool), the money-gate stub, host image fetch (T16); seeder and gateway rate limits, ban persistence, log redaction coverage (inspect every logger call), key file permissions, systemd units; dependency inventory vs lockfile, install scripts, provenance; Nostr read paths (signature verification everywhere, including the nostr-tools verifyEvent spread pitfall in docs/status.md), markdown renderer escaping, thumbnail hash checks; any UI path where the price shown can differ from the price charged (rendition default, rendition switch, autoplay, Shorts swipe, the mini-player); SE-1…SE-5 in docs/reviews/2026-09-23-pre-push-l5-v4.md. There is no web portal; review only the web-facing responses the gateway serves.
Rank findings, give a concrete fix for each, and file them as issues tagged stage-3. Do not fix them yourself outside the five directories above (the contracts and mocks bump in PART 0 is the exception).

Inputs: docs/plan/ (incl. L6-design.md), SECURITY.md, packages/core/src/contracts/, the adversary test suites, docs/decisions/ (0003, 0004, 0005 + erratum, 0007), docs/status.md (v5 list, findings), docs/contract-requests/, docs/lanes/L6-*.md, docs/vendor/{NUT-03,04,05,11,12, NIP-60, NIP-61}, and read access to the full repo. Deliver PART 0 and each Part A module as one PR each and Part B as a single document. Be explicit about anything you could not verify.
```
