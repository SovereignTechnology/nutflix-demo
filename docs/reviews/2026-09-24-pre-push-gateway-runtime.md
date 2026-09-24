# Pre-push review — the gateway runtime (2026-09-24)

Diff: `stage-3/seeder-payout` (`9e30b78`) → `stage-3/gateway-runtime`. Method: the
`differential-review` checklist and `sharp-edges` questions, run inline by the session that
wrote the change (a self-review; the tests that must fail without each fix are its only
independence).

## Scope

HIGH risk:

- `packages/gateway/src/cli/providers.ts`: identity, two engines on one wallet, auth.
- `gateway.ts`: pay/1 attach moved to `onSessionReady`.
- `seeder/src/runtime/index.ts`: `createNodeRuntime` extracted, the daemon's behaviour kept.
- `seeder/src/log/redact.ts`: the `ownP2pk` exception.

MEDIUM:

- `gateway/src/config.ts`: new fields, and `identityOptional` for `--keygen`.
- `gateway/src/cli/main.ts`: async providers, attach/close order, `--keygen`, fixed-string
  argument errors.
- `seeder/src/runtime/identity.ts`: the credential id is now a parameter.

LOW: the unit's `LoadCredentialEncrypted=`, docs, tests.

## Adversarial questions

- **Can the gateway advertise a key it cannot redeem with?** No. The runtime compares
  `identity.pubkey`/`identity.p2pk` with the key file and refuses to start, closing the runtime
  and freeing the lock. Tested, including that the right identity then starts.
- **Can `--keygen`'s relaxed parse leak into a normal start?** No. `identityOptional` is set only
  when `--keygen` is on the command line; without it the identity values stay required (tested).
- **Does the redaction exception widen what reaches journald?** Only a field literally named
  `ownP2pk` whose value is a well-formed compressed key passes whole. `p2pk`, free text and
  malformed values are still truncated (tested). The value is the node's own P2PK key: public
  (it is in its kind 10019).
- **Credential id as a parameter.** It is checked against `^[a-z0-9][a-z0-9_-]{0,63}$` before it
  is joined to `$CREDENTIALS_DIRECTORY`, so no path traversal. Callers pass constants.
- **Two engines, one wallet.**
  - The seeder side receives (redeem) and the viewer side sends (upstream PAYs).
  - The Spender serialises operations per mint.
  - A payout could empty the wallet the upstream payments draw on. That is an operator
    trade-off (threshold); an upstream PAY that cannot be covered fails, and the upstream window
    then cuts. Recorded as a residual.
- **Did the refactor change the daemon?** Its whole suite passes unchanged, apart from a mapping
  that moved (`createSeederRuntime` → `createNodeRuntime`).
- **Argument errors.** The gateway forwarded `node:util`'s message, which quotes the offending
  token (a mis-pasted secret would have reached journald). Now fixed strings, like the seeder
  (tested).

## Found by this lane

| # | Severity | Finding | State |
|---|---|---|---|
| F38 | High | The gateway attached pay/1 on `session-open`, before a swarm connection has a Protomux: it never paid an upstream swarm peer | **fixed**: `onSessionReady`; the swarm integration test fails without it (run) |
| F37 | High | Upstream fetches are not paced to the unpaid window: with real engines a fast reader outruns its PAYs and the upstream seeder cuts and **bans** the gateway (6 outstanding vs window 5, every run, with the core correctly watched) | **open**: the next lane (credit pool + ACK settlement in the shared `UpstreamPayer`); the integration test paces its reader meanwhile; README warns operators |
| — | Low | Gateway argument errors echoed the offending token | fixed |

Also caught while writing the test (not a product bug): opening an upstream core with
`seeder.blobs.openCoreByKey` bypasses the payer. `Gateway.openUpstreamCore` is the entry that
pays.

## Residual

- F37 (above) blocks relying on the gateway for upstream fetches.
- A payout threshold low enough to drain the wallet leaves the gateway unable to pay upstream.
  Operators should set it above their upstream spend, or run without payout on a busy gateway.
- The gateway's `identity` block duplicates what the key file holds. It is kept because the
  config is validated before the key is unlocked (and dev-mocks needs it), and the mismatch check
  makes it safe.

## Tests

- `npm run ci` green: 149 files passed, 2 skipped; 2411 tests passed, 7 skipped.
  `check-locked-dirs` OK.
- New:
  - config (5): the runtime fields, refusals, `identityOptional`.
  - CLI: the real providers without a key file; `--keygen` then an identity mismatch then a real
    start; fixed-string argument errors.
  - The built gateway under the unit flags: `--keygen` from a pipe, a real start with a
    credential directory, a mint over HTTP, clean SIGTERM, lock freed.
  - Redaction.
  - The swarm integration test: gateway ⇄ upstream seeder daemon over hyperswarm with both real
    runtimes; paid exactly blocks × price; the upstream redeems. Passed 3/3.
- Mutation run: the gateway attaching on `session-open` makes the swarm test time out.
