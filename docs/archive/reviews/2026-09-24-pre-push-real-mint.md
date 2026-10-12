# Pre-push review — the real-mint lane (2026-09-24)

Diff: `stage-2/review-fixes` (`7d78dad`) → `stage-3/real-mint`. Method: the
`differential-review` checklist and `sharp-edges` questions, run inline by the session that
wrote the change (a self-review; the cold re-read of each changed function is its only
independence).

## Scope

HIGH risk: `core/src/payment/engine.ts` — per-mint batched redeems with per-PAY attribution
(`redeemAll` / `redeemGroup`), batched nutzaps (`forwardAll`), per-account channel epochs, the
F31 "retried only" rule; `seeder/src/net/{peer-session,session-registry}.ts` — superseding older
sessions of a pubkey. MEDIUM: `core/src/mocks/test-mint.ts` (witnesses, lost replies, refusing
empty swaps); the two opt-in real-mint suites; `scripts/real-mint/*`. The rest is docs.

## Adversarial questions asked of each change

- **Batched redeem.** Can one PAY's fault spill onto another? A "spent" batch is attributed per
  PAY with NUT-07 (`checkSpent`); without it the engine falls back to per-PAY redeems, so the old
  behaviour is the floor. A mint outage or dust leaves every PAY of the group queued. Can a
  replay slip through a batch? A replayed set's first attempt is a double-spend whatever its
  witness (F31 rule), in a batch or alone — tested.
- **Batched nutzaps.** Could a creator be paid another creator's proofs? Groups key on the
  creator key × mint × core, so no. Could one viewer's fraud cost another viewer? The F11 check
  runs per group, and only the PAYs whose creator proofs are spent are dropped and banned —
  tested.
- **Channel epochs.** Could an honest PAY be refused? Only one queued under a channel that was
  replaced before it was decided. By then the viewer has a new channel with carry 0, and the old
  PAY's blocks stay outstanding (the same outcome as a PAY lost in the drop). A PAY on the
  provisional identity keeps its existing semantics (the epoch key is the account it was queued
  under).
- **Superseding sessions.** Could an attacker cut someone else's session? Only by binding their
  pubkey, which needs a HELLO signed by that key and bound to the attacker's own Noise handshake
  — unforgeable. The cut is `local` (no ban), so a viewer's own reconnect never bans it.
- **TestMint now refuses empty swaps** like Nutshell, so the dust case is reproduced in plain
  `npm test` (the engine dust test), not only against a real mint.

## Found by this review and fixed before commit

| # | Where | Finding | Fix |
|---|---|---|---|
| B1 | `scripts/real-mint/nutshell.sh` | The throwaway mint key was passed as an `env -i` ARGUMENT, briefly visible in the process list (a worthless FakeWallet key, but the script claimed otherwise) | Exported in the subshell and everything else unset; verified the mint's environment holds only the intended names and argv carries no key |

## Residual notes

- **F33 stays open** (duplicate deliveries paid twice). It needs a product decision.
- The engine's `epochs` map holds one number per account ever bound — negligible memory.
- `SessionRegistry.supersede` scans live sessions linearly per bind, bounded by the global
  session cap.
- The real-mint suites are opt-in; nothing in CI exercises a real mint. The engine dust test and
  the TestMint changes keep the regressions visible offline.

## Tests

New behaviour has tests that fail without it. Verified by running: removing the epoch check
fails the stale-channel test. By construction: the one-swap-per-mint test fails on the per-PAY
engine (two redeems instead of one), and the replay-after-restart test fails without the
"retried only" rule (the replay's witness is ours, so it would read as our own spend). The dust
test alone does not tell the engines apart — a lone dust PAY is refused either way; it pins that
dust is kept, not dropped or banned. Real-mint suites: 4 + 3
scenarios pass on Nutshell 0.21.0 and on cdk-mintd 0.18.1; the network-drop scenario passed 8/8
after the supersede fix (it failed about one run in four before).
