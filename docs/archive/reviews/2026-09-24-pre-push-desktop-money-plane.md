# Pre-push review — the desktop money plane (2026-09-24)

Diff: `stage-3/gateway-runtime` (`a37dae3`) → `stage-3/desktop-runtime`. Method: the
`differential-review` checklist and `sharp-edges` questions, run inline by the session that
wrote the change (a self-review; the tests that must fail without each guard are its only
independence).

## Scope

HIGH risk (value transfer across a process boundary, keys):

- `app-desktop/src/host/money.ts`: the host's money plane and its authorisation.
- `core/src/wallet/nip60-wallet.ts`: kind 17375, the wallet key.
- `app-desktop/src/ipc/worker-protocol.ts` / `worker-guards.ts`: the new worker → host money
  calls.
- `app-desktop/src/worker/pay/real-providers.ts`: the worker's real engines.

MEDIUM:

- `seeder/src/seeder.ts` + `net/{peer-session,session-registry}.ts` (`announceCorePrices`).
- `worker/net/peer-node.ts` (async, connection-bound HELLO).
- `host/{host,adapter}.ts` (wiring, session authorisation, wallet provider).
- `host/worker/supervisor.ts` (optional money handlers).
- `worker/runtime.ts` + adapters (`StateFs`).

LOW:

- `core` moves: `guardedKeyset`, `nutzapPublisher`.
- `WorkerHostOptions.testBootstrap`.
- Docs and tests.

## Adversarial questions (the worker as the attacker: it handles peer data)

- **Can a compromised worker spend the user's money?** Only through `pay.build`, and only:
  - for a session the HOST registered on a user's play (the worker cannot create one);
  - for that session's core and blob range;
  - on the manifest's creator key, split, block size and mints, at a price ≤ the manifest's;
  - within a budget of 2 × the blob's blocks + one window.

  Worst case: the user pays twice the price of the video they chose to watch. Every refusal is
  tested; without `authorizeSession` the end-to-end test fails (run).
- **Can it get the user's key to sign something else?** `pay.hello` signs a host-built
  `{kind: PAY_HELLO, tags: [["challenge", c]], content: ""}`, with `c` matching
  `pay/1:<hex>:<64 hex>` (guard, tested against `helloChallenge()`'s own output). The event kind
  confines it to `pay/1` HELLOs, and the worker can already make connections as the user.
- **Can it move the user's existing proofs?** No.
  - `seller.redeem` swaps proofs the WORKER supplies (from peers), locked to the user's key, into
    the wallet: it can only add.
  - `seller.nutzap` publishes proofs the worker supplies, locked to a creator, to a creator the
    host saw in a manifest.
  - The user's own creator share is redeemed, not nutzapped.
- **Can a relay make the host replace the user's wallet key?** It could have, and this lane fixed
  it (see D1 below).
- **Error channel.**
  - A spent proof travels as data (`{ok: false, spent}`); an `internal` code would have silently
    broken double-spend detection across the boundary.
  - The host logs only an error's code prefix.
- **Mocks and money together?** Refused by the init guard (tested). The dev-mocks path is
  unchanged.
- **Per-core prices.** A payer never pays above the manifest and keeps blocks owed until a PRICE
  arrives, so the HELLO ceiling plus a PRICE per core from block 0 cannot overcharge. The PRICE is
  sent from the synchronous upload hook, before the block is written.

## Found by this review and fixed before commit

| # | Severity | Finding | Fix |
|---|---|---|---|
| D1 | **High** | The host opened the NIP-60 wallet at startup and CREATED a new wallet key whenever its relay query came back empty. An empty answer also means "relays unreachable", and kind 17375 is replaceable, so a transient outage would have replaced the user's real wallet key on their relays and stranded every proof locked to it. Found by an existing test whose relay list pointed nowhere at startup | `openNip60Wallet` creates only with `create: true`; the host never creates at startup (payments stay off, logged `no-wallet`); creation is an explicit user action (next lane). Tested: a miss publishes nothing |
| D2 | Medium | Worker `payments` with an empty mint list (Settings default) made the init invalid, so the worker never became ready | payments are enabled only when the wallet lists a mint; a warning otherwise |
| D3 | Medium | A wallet `spent` error would have crossed IPC as `internal` | `seller.redeem` returns a result union; the worker rethrows with `code: 'spent'` |
| D4 | Medium | The host would have loaded `@sovit/seeder` (corestore, hyperswarm, native addons) for two pure helpers | `guardedKeyset` and `nutzapPublisher` moved to core; the seeder re-exports them |
| D5 | Low | The HELLO challenge guard first assumed 64 hex | matches `helloChallenge()`'s real shape, pinned by a test against it |
| D6 | Low | Bare has no global `Buffer` and forbids direct `new TextEncoder` | `StateFs` uses the shared `utf8` codec; short writes loop |

## Residual

- **The signer connect flow is not wired.**
  - The money plane opens only when the host starts with a signer (tests inject one).
  - The trusted passphrase prompt, the file `KeyStore`, the Settings bridge, "create my wallet",
    and restarting the worker on connect / lock / sign-out are the next lane.
- `seller.checkSpent` / `spentByUs` are not rate-limited: a compromised worker could have the
  host query the mint repeatedly. Read-only, and bounded by the IPC in-flight caps.
- The decrypted 17375 rows are a JS string, which cannot be wiped (documented). A signer with
  `signSecret` for the wallet key avoids it.
- The session budget (2×) tolerates duplicate deliveries. F33's product decision could tighten it.

## Tests

- `npm run ci` green: 152 files passed, 2 skipped; 2434 tests passed, 7 skipped. `check-locked-dirs`,
  native-module inventory and the Electron security lint OK.
- New:
  - core `nip60-wallet` (4).
  - Worker guards: samples for every money call, and refusals.
  - Money plane (6): the wallet opens and is never created by accident; `pay.build` authorisation
    with every refusal, budget and `no-balance`; a HELLO verified by the peer's view and refused
    on another connection; seller hooks; nutzaps.
  - Host: money calls without a money plane are refused.
  - Seeder: `announceCorePrices`.
  - End to end: the desktop worker with real providers streams from a seeder daemon over
    hyperswarm, the host's NIP-60 wallet pays exactly blocks × price, the seeder is paid in full
    and nutzaps the creator. Passed 3/3.
- Mutation run: without the host authorising the session, the end-to-end test fails.
