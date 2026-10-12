# Pre-push review — the security-review fixes (2026-09-24)

Diff: `stage-2/2026-09-23` (`26b7a8c`) → `stage-2/review-fixes`. Method: the
`differential-review` checklist and `sharp-edges` questions (CLAUDE.md "Before any push/PR"),
run inline by the session that wrote the fixes, so it is a self-review, and the cold read of
each changed function is its only independence.

## Scope

Every fix in `docs/security-review.md` §0. HIGH-risk changes, each read in full after writing:
`gateway/src/upstream/payer.ts` (price, carry, in-flight gating), `core/src/payment/engine.ts`
(proof cap, flush: `checkSpent` / `spentByUs` / `persistPending`), `core/src/wallet/spend.ts`
(`checkSpent`, `spentByUs`, melt fee reserve), `app-desktop/src/main/{money-gate,ipc-gate,main}.ts`
(native confirm dialog, single-instance lock), `gateway/src/blossom/handler.ts` (served
types, pre-auth spooling), `seeder/src/seeder.ts` (price history), `seeder/src/log/redact.ts`
(peer aliases). MEDIUM: `gateway/src/{gateway,config}.ts`, `app-desktop/src/host/settings`,
`core/src/wallet/nip60.ts`, `ui/src/screens/Watch/Watch.tsx`, the systemd unit + deploy docs.

## Found by this review and fixed before commit

| # | Where | Finding | Fix |
|---|---|---|---|
| A1 | `wallet/spend.ts` `melt` | The new native dialog shows the quote's `feeReserve`, which the renderer supplies; `melt` re-checked only the AMOUNT against the mint, so a compromised renderer could show a 1-sat reserve while the mint reserved more | `melt` refuses when the mint's `fee_reserve` exceeds the quote's (test: nothing leaves the wallet) |
| A2 | `payment/engine.ts` F11 | "check the creator set once" was an in-memory flag: after a crash + `restorePending`, the check re-ran, and a creator who had already redeemed a landed nutzap would read as a double-spend | `creatorChecked` travels in `PendingPay` through `persistPending` / `restorePending` |
| A3 | lint | `checkProofsStates` with `secret` only is deprecated in cashu-ts (the keyset id selects the hash-to-curve variant in its v5) | Both new calls pass `{ secret, id }` |

## Behaviour changes worth knowing (not defects)

- **The gateway pays upstream only for cores with a manifest policy** (`config.upstream.policies`
  / `setUpstreamPolicy`). Before, it fell back to the seeder's HELLO terms and the gateway's own
  creator key, which the seeder rejected anyway (`wrong-p2pk-target`). So nothing that worked
  stops working, but an unconfigured core is now visibly unpaid (`skippedNoPolicy`).
- **One unacknowledged PAY per peer × core.** A PAY waits one round trip for the previous one's
  ACK. The desktop credit pool already settled units only on ACK, so throughput is unchanged;
  payment latency per block is up to one RTT. A seeder that never ACKs is not paid again — and
  cuts the viewer, which is the intended outcome.
- **Log lines name peers as `peer#N`**, stable within a process only. Cross-restart correlation
  needs the ban list, which keeps full keys.
- **Default Blossom upload types are a media allowlist**; an operator who wants any type writes
  `"allowedMimeTypes": null` explicitly. Stored active types are served as downloads.
- **Uploads over 8 MiB must send `X-SHA-256`** (nostr-tools' client always does).
- **`autoTopUpDue` changed direction** to match the v5 contract (it answered for `fromMint`,
  which the contract says never fires). Nothing executes top-ups yet.

## Residual notes

- The gateway's 429 response sets its headers directly and so lacks `nosniff` / CSP. Its body is
  empty; no change.
- `money-gate` shows the melt destination only for `seeder.melt` (its args carry the invoice);
  `wallet.melt` shows amount, fee reserve and mint. The host re-checks both against the mint
  (A1).
- F6 (real mint), F17 (NUT-20), NUT-13 recovery and the runtime wiring of the new engine hooks
  stay open. See `docs/security-review.md` §6.

## Tests

Every fix has a test that fails without it, except the user-agent removal (a production-only
transport) and the `lock.ts`-style defensive reads noted in the code. Counts are in the commit
message; the run is `npm run ci` without `LOCKED_DIRS_UNLOCKED`.
