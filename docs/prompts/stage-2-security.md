# Stage 2 security session prompt (execution plan §5.3)

Single serial session, one worktree, no subagents. Run with `LOCKED_DIRS_UNLOCKED=1` so `scripts/check-locked-dirs.sh` permits implementation in the five locked paths.

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
