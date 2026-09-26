# Pre-push review — one seeder per block, credit per seeder window (2026-09-25)

Diff: `c08c99f` (contracts v6) → `stage-3/f33-one-peer`. Method: the `differential-review`
checklist (risk triage, blast radius, adversarial questions) and the `sharp-edges` questions, both
inline, by the session that wrote the change. Security review F33 (Cameron, 2026-09-24: "request
each range from a single seeder — no duplicates, seeders paid fairly") and issue #8 ("the credit
pool is not sized per seeder window").

## Scope

- HIGH (what a viewer pays, and whether an honest viewer is window-cut and banned):
  - `seeder/src/net/one-peer.ts` (new): `OnePeerRouter`. It reaches into hypercore 11.35.3's
    replicator: it replaces the hotswap queue and caps each replication peer's `getMaxInflight()`.
  - `gateway/src/upstream/seeder-credit.ts` (new): `SeederCredit`, the per-seeder budget, the pool
    size and the per-seeder batch.
  - `gateway/src/upstream/payer.ts`: per-seeder batch, the at-cap trigger, and the tail `due` fix.
  - `gateway/src/upstream/settle.ts`: `owedBy`, `linked`, `isPayable`, and `onChange` (blocks
    settled without a payment).
  - `gateway/src/upstream/credit.ts`: `setLimit`.
  - `app-desktop/src/worker/pay/viewer-payer.ts`, `host.ts`, `gateway/src/gateway.ts`: wiring.
- MEDIUM: `gateway/src/config.ts` (the meaning of `creditBlocks`), `seeder/src/portable.ts`
  (exports), `app-desktop/src/worker/dev/*` (per-seeder windows for the fixtures).
- LOW: tests and docs.

Blast radius: every paid download goes through this code — the desktop's playback (`ViewerPayer`,
one per worker) and the gateway's upstream reads (`watchCore` / `readUpstreamBlob`). The fixture
mirror in `--dev-fixtures` uses it too. Nothing in the seeder's serving path changed.

## Why reach into hypercore

Hypercore picks the peer for each request and has no public way to choose it. Its normal paths
already give a block to one peer at a time (a queued `get` is taken by one peer; a range block is
skipped while a request for it is in flight). The one path that asks a second peer is the hotswap
(`Replicator._updateHotswap`). Any peer with spare capacity re-requests blocks already in flight
elsewhere, up to three peers per block. The first answer wins; the others are cancelled, too late
once sent.

The router changes the smallest surface that closes this:

1. **The hotswap queue.** It becomes a queue that yields a block only after its single request
   has stalled for `stallMs`. The stalled request is then cancelled: a failover to one other peer.
2. **The per-peer pipelining cap.** It is capped by that peer's credit. This is the only knob
   hypercore reads before every request it makes.

Two alternatives were rejected:

- **Pinning requests ourselves:** calling `_requestBlock` on a chosen peer reaches deeper into the
  internals and still leaves the hotswap in place.
- **A separate block protocol:** our own Merkle verification, which is ours to get wrong.

`__tests__/one-peer-router.test.ts` pins the internals the router uses:

- the version;
- the members, checked on real objects;
- the source lines whose order the router depends on:
  - `_sendBlockRequest` pushes, then calls `hotswaps.add`, then sends;
  - `_updatePeer` and `_updatePeerNonPrimary` gate on `inflight >= getMaxInflight()`;
  - `dataProcessing` spans the verify, before the download event;
  - `peer-add` fires in the same call as `_addPeer`;
  - `_includeLastBlock` is off by default;
- `PRIORITY.CANCELLED` = 255.

At runtime, `attachCore` throws `RoutingUnsupported` when the shape is not the pinned one (fail
closed).

## Adversarial questions

- **Can a viewer still pay twice for a block?** Only a failover can put a block at two peers. The
  stalled request is cancelled as the replacement goes out. If the stalled seeder had already sent
  the block, hypercore drops the late answer (the request id is gone). That seeder is then never
  paid for it, and its budget carries the block as a debt for good. No path pays two seeders for
  one block.
  - Three full seeders racing on the desktop path: 48 deliveries for 48 blocks, the seeders'
    engines counted exactly those, and the viewer spent exactly 48 × price. On the pre-lane stack:
    49–51, and 98–100 sats spent.
  - The same holds on the gateway path.
- **Can an honest viewer be window-cut?** Before a request goes to seeder S on core X, the router
  checks
  `inflight(S) + verifying(S) + cancelled-after-send(S) + lost-with-connection(S) < window_S(X) − owed(S) − unpaid(S)`.
  - `owed` is what S delivered that is not ACKed.
  - `unpaid` is what S delivered that was settled without payment: rejected PAYs, and blocks owed
    when its `pay/1` went away. It is inherited by S's HELLO pubkey across a new Noise key.
  - Across cores this holds by induction: any held unit of a core with window ≤ w was acquired
    while the total was ≤ w. S's window at an upload is the maximum over the cores it recorded
    plus the one being sent.
  - The in-flight to owed hand-off is atomic: `dataProcessing` drops, then the `download` event
    (the settler's `owed++`), then `updatePeer`, all synchronously.
  - Tested: a window-1 seeder among 8/4 seeders is never above 1, and nobody bans the viewer. The
    same test on the pre-lane stack: the window-4 and window-1 seeders reached 5 and 2 and banned
    the viewer in every run.
- **What does a malicious seeder gain?**
  - A huge HELLO `windowBlocks` is clamped to 1024. It only increases what the seeder risks
    itself.
  - `windowBlocks: 0` or no HELLO: nothing is asked of it. Before, a HELLO-less `pay/1` peer took
    blocks that were never paid and held pool credit until it disconnected.
  - Answering every PAY with `ACK ok:false` while keeping the proofs: each rejected batch now
    counts as unpaid, so the seeder stops receiving requests after about one window. Before, this
    was unbounded.
  - Claiming another seeder's pubkey to merge debts into its budget: the HELLO is signed and bound
    to the connection (v5).
  - Withholding blocks: see R3.
- **Denial of service by resources.** Every map is bounded (the `byPubkey` index was not until the
  independent review's IR2, below):
  - the router's lost-request and stalled-remote maps: 4096 remotes each;
  - `SeederCredit`'s records: 4096, evicting disconnected seeders first.
  The failover ticker runs only while blocks are tracked, is unref'd, and stops at `close()`.
- **Logs.** The router logs a core key and a block index, never a peer key. `SeederCredit` logs
  nothing. Worker logs still pass through the redacting worker logger.
- **Money path untouched.** Nothing in `core/src/{payment,signer,pay-protocol}`, `wallet/spend.ts`
  or the contracts changed. `check:locked` is OK. `UpstreamPayer` still pays only the manifest
  policy, at most the manifest price, one PAY per core in flight.

## Found and fixed before push

| # | Severity | Finding (file:line at HEAD) | Scenario | Fix |
|---|---|---|---|---|
| R1 | High | `gateway/src/upstream/payer.ts:344` — the tail timer paid only the FIRST of a quiet peer's short runs. Hypercore spreads blocks over peers, so one peer's are rarely contiguous. With per-seeder batches (no small pool to force pressure), the other runs waited forever. | The fixture mirror's credit never drained, and the desktop test timed out "waiting for every PAY ACKed". The same would leave a real seeder unpaid and the viewer's credit stuck. | A sticky per-peer `due`, set by the tail timer and by `flush()`, keeps paying one run per ACK until nothing is pending (`:290`, `:453`). Tests: scattered runs after the tail; `flush()` with ACKs that arrive after it returned. |
| R2 | Medium | `app-desktop/src/worker/host.ts:539` — the core was marked attached BEFORE `payer.attachCore`. | The first `play.open` throws `RoutingUnsupported`. A retry then skips the attach and downloads the core unrouted (fail open). | Mark only after a successful attach. Test in `host.test.ts`: two refused opens both reach the router; the third, allowed, attaches. |
| R3 | Medium | `seeder/src/net/one-peer.ts:558` — a withholding peer (takes requests, answers none) got a fresh batch after every failover. | Each block it took waited `stallMs`. Hotswap used to hide such a peer by racing it. | A peer that stalled gets ONE request at a time until it delivers a block (`:576`). The failover delay drops from 8 s to 4 s (`:52`). Test: after a failover, a budget of 4 still lets the stalled seeder take only one more request; delivering lifts the limit. |
| R4 | Low | `gateway/src/upstream/seeder-credit.ts:250` — debts were keyed by Noise key only. | A seeder restarting under a new swarm key but with the same engine state (same HELLO pubkey) got a clean slate. It still counts our unpaid blocks, so we could overrun it by that many. | `lostTo` adds what the pubkey's other, disconnected links left unpaid or lost. Test. |
| R5 | Medium | `seeder/src/net/one-peer.ts:555` (sharp edge) — a budget of `Infinity` meant "no cap". | A budget computed as `x / 0` uncaps a peer silently. | "No cap" is now only an explicit `null`. Every non-finite or sub-1 value asks nothing. Test covers `±Infinity`, `NaN`, 0.5, negatives and a throw. |
| R6 | Medium | `seeder/src/net/one-peer.ts:338` (sharp edge) — `stallMs` went through `Math.max(1, x)`. | `NaN` becomes `NaN`, and every request counts as "stalled" at once: mass failovers, and a debt on every seeder. `0` gives the same. | `RangeError` unless finite and ≥ 50 ms. Test. |
| R7 | Medium | `gateway/src/upstream/seeder-credit.ts:272` (sharp edge) — `SeederCredit` had its own "is this core paid" rule. | If it disagreed with the settler's, a paid core would get the no-pay burst budget while its blocks piled up as owed: overrun. | It reads `CreditSettler.isPayable`. Test: a policy without settler ownership gets the bounded burst, never the window. |
| R8 | Low | `gateway/src/upstream/seeder-credit.ts:108` | Two `SeederCredit`s on one pool would resize it against each other. | Refused until the first is disposed. Test. |
| R9 | Low | `gateway/src/upstream/payer.ts:216` | A malformed batch (`NaN`) disabled batch-triggered payments (only the tail and pressure would pay). | Falls back to one block. Test. |
| R10 | Low | `gateway/src/__tests__/gateway-runtime-swarm.integration.test.ts` asserted `worst ≤ creditBlocks` (4). | That is the old global bound. The gateway may now use the upstream's whole effective window (5 = 4 widened for the 10-sat minimum PAY at 2 sats/block). | Asserts `worst ≤` the upstream engine's own window, which is also checked to equal `effectiveWindowBlocks(4, policy)`. It is still paired with "no window-exceeded". |

Found on the way (explains a pre-lane measurement, now handled): a raced loser whose answer
arrives after the cancel is dropped by hypercore and never paid, yet the seeder counts it. That is
why the old global pool of 4 still let a window-8 seeder reach 7 outstanding. The router counts
every cancel after sending as a debt (`peer.stats.wireCancel.tx`).

## Mutation checks

Each guard was broken on purpose. At least one test failed each time, and the guard was restored.

| # | Mutation | Failing test(s) |
|---|---|---|
| M1 | Racing left on (the router does not install its queue) | Seeder: racing (83 raced requests), disconnect (50 deliveries / 48), stall, raced-count. Desktop: both integration tests (the mirror setup stalls). Gateway: "upstream 1 sent 5, delivered 4" (64 KiB blocks; at 16 KiB the gateway test missed it, so the block size was raised). |
| M2 | Per-peer cap off (credit = 1 000 000) | Seeder budget test (window-1 seeder at 12); stall; cap. Desktop: "seeder 1 sent 13, delivered 9" (cut). Gateway: "upstream 1 sent 5, delivered 4" (cut). |
| M3 | A throwing budget → `Infinity` | Cap test |
| M3b | NaN budget → uncapped | Cap test |
| M4 | No HELLO → no-pay burst instead of 0 | Two `SeederCredit` tests |
| M5 | Closed link keeps its window | Link-away test |
| M6 | Rejected PAY not reported as unpaid | Rejected-PAY test and settler test |
| M7 | Link release not reported as unpaid | Link-away test and settler test |
| M8 | Unpaid not carried across a reconnect (fresh record) | Link-away test |
| M9 | Window clamp removed | Huge-HELLO test |
| M10 | An old connection's close ends the new one | Link-away test |
| M11 | `host.ts` marks attached before attaching | `host.test.ts` fail-closed retry |
| M12 | Tail `due` removed | Scattered-runs test |
| M13 | At-cap trigger removed from `onDownload` | At-cap test (after isolating it from `payEveryBlocks`: the first version of the test did not catch it) |
| M13b | At-cap no longer forces a batch of 1 | At-cap test |
| M14 | Pool floor removed | Pool test and dispose test |
| M14b | Pool cap removed | Pool test |
| M16 | Second router on one core allowed | Refusal test |
| M17 | Stalled request not cancelled at failover | Stall test (debt 0) |
| M17b | Cancelled request left in `block.inflight` | New test: the replacement's seeder vanishes; the block gets stuck. The original tests missed this, so the test was added. |
| M18 | Gateway `watchCore` does not route | Gateway integration |
| M19 | `atCap` never true | Batch test |
| M21 | `ViewerPayer.attachCore` does not route | Desktop integration |
| M22 | Stalled-peer limit removed | Stall test ("expected 3 to be 2") |
| M22b | Stalled limit never lifted | Stall test |
| M23 | Pubkey inheritance off | Pubkey test |
| M24 | `Infinity` budget accepted | Cap test |
| M25 | `stallMs` validation off | `stallMs` test |
| M26 | Pool ownership guard off | One-pool test |
| M27 | Separate payable rule | Settler-rule test |
| M28 | Batch sanitising off | Malformed-batch test |

## Measurements (duplicates paid per N blocks)

- **Piped streams**: three full seeders, 48 × 64 KiB blocks read at once.
  - Plain hypercore: 55, 62, 65, 66 and 67 deliveries (7–19 duplicates), with 81–89 raced
    requests per run.
  - Routed: 48, with 0 raced requests, every run.
  - With 1 KiB blocks, hypercore still raced 85–89 requests, but the duplicates were cancelled
    before leaving the seeder.
- **Desktop path**: `WorkerHost` + gate + `--dev-mocks`; three fixture seeders with windows
  8 / 4 / 1; 48 blocks, prefetch covering the file.
  - Pre-lane stack (recreated by switching off the router, the pool resize and the per-seeder
    batch): 49, 50, 50, 51 deliveries, so 1–3 duplicates paid per 48 blocks; 98–100 sats spent
    against the 96 shown.
  - On that stack the window-4 and window-1 seeders reached 5 and 2 outstanding and banned the
    viewer in every completed run, and 2 of 6 runs never finished the fixture mirroring.
  - Routed: 48 / 48 every run; 96 sats spent; each seeder's worst outstanding exactly its window
    (8, 4, 1: the big windows are used, not starved); no bans; the pool at 13.
- **Real-mint lane** (security review §0a): 29 deliveries for 24 blocks, on the bare
  `UpstreamPayer` rig. That rig is not routed and was not re-run here (it needs a live mint).

## Residual

- **Pinned internals.** The router depends on hypercore 11.35.3 internals.
  - A hypercore bump must re-verify `net/one-peer.ts`. The pin test fails first.
  - At runtime a replicator of the wrong shape is refused.
  - A replication peer INSTANCE missing the pinned fields is logged as an error and keeps
    hypercore's own cap. That is fail-open for that peer, and unreachable on 11.35.3. *(Fixed by
    IR6 below: such a peer is refused at attach and asked for nothing when it joins later.)*
- **Withholding peers.** Each one delays one block at a time by `stallMs` (4 s). Hotswap masked
  them by racing, at the price of paying duplicates. Many Sybil withholders can still slow
  playback.
- **Permanent, conservative debts.** Debts last for the worker's or gateway's life: cancelled after
  sending, lost with a connection, rejected, and unpaid at a link drop. An honest seeder that drops
  mid-flight or stalls repeatedly loses budget, possibly to 0, for the session. An ACK carrying
  the seeder's `outstanding` would let the viewer resync (`docs/contract-requests/S3-f33.md`).
- **Wall-clock steps.** Stall detection compares hypercore's `Date.now()` request timestamps. A
  forward clock step larger than `stallMs` fails over every in-flight request, costing each seeder
  one debt per request.
- **Unpaid blocks after a drop.** Blocks a seeder delivered before its link dropped are not paid on
  its next connection; they are debited instead. The seeder's range sets would accept such a PAY
  (fair pay for them is a follow-up).
- **Pre-HELLO wait.** Requests to a `pay/1` peer wait for its HELLO: one round trip at connect.
  Upgrades and seeks are gated like blocks, so a seeder at its cap answers no seek until an ACK.
  Other peers still can.
- **Seeder policy mismatch.** The window is computed with the MANIFEST policy, as the `pay/1`
  contract says. A seeder whose own policy has a smaller minimum PAY than the manifest's is
  misconfigured against the contract, and could be overrun.
- **Real-mint test.** It still pays through a bare `UpstreamPayer` (no `SeederCredit`, no router)
  and its F33 comment describes that rig. Converting it needs a real-mint run. *(Done after the
  independent review: routed, with a labelled unrouted baseline. See below.)*

## Tests

- New:
  - seeder `one-peer-router.test.ts` (14);
  - gateway `seeder-credit.test.ts` (21);
  - gateway `one-peer.integration.test.ts` (1);
  - desktop `one-peer.integration.test.ts` (2, hyperdht testnet);
  - desktop `host.test.ts` (+1).
- Changed, with reasons in the files:
  - `viewer-payer.test.ts`: a fake replicator for the router; HELLO windows and a 2-sat minimum
    PAY so the batch stays one block (it was half the pool, now half the seeder's window, issue
    #8); the F5 tests announce a window of 8, keeping their batch of 4.
  - `gateway-runtime-swarm.integration.test.ts`: R10.
- `npx vitest run --maxWorkers=2`: 174 files passed, 2 skipped; 2748 tests passed, 10 skipped.
- `tsc -b --force`, eslint and prettier on every changed file, `check:locked` and `lint:electron`:
  all OK. The Electron e2e is left to the orchestrator.

## Independent review (2026-09-25) and what was done

An independent reviewer read and tested the lane: verdict **fix first**, one medium finding and
seven low/info ones. It confirmed that racing is closed, that the cap sits where hypercore reads
it, that the in-flight to owed hand-off is synchronous, and that late answers are never paid.
Every finding was first checked against the code. All eight are real. Seven are fixed, each with
a test that fails without the fix. One (IR4, low) is deferred, with the reason.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| IR1 | Medium | `host.ts` `close()` ran `payer.close()` before the connections closed. `OnePeerRouter.close()` then restored hypercore's scheduler (its cap, at least 16, and its racing hotswap) on cores still replicating. The next block to land sent every held-back request to one seeder, which cut and banned the viewer. `gateway.close()` had the same order. | **Fixed**, twice. (1) The router fails closed. A released core (the last detach, or `close()`) is PARKED. Every peer, and every peer that joins through an attached session, is capped at 0 new requests (`one-peer.ts` `park()`). The no-race queue stays, serving nobody. The next `attachCore` of that core takes the core over, keeping its queue. (2) Shutdown order: the desktop closes the payer only after `node.destroy()` (`host.ts` `close()`, in a `finally`). The gateway releases routes and disposes `SeederCredit` only after `seeder.close()` (`gateway.ts` `close()`, in a `finally`). The router logs once, with the core key, when it parks a core. |
| IR2 | Low | `SeederCredit.byPubkey` grew without bound when one Noise key kept announcing new HELLO pubkeys. | **Fixed.** `setHello()` moves the Noise key from its previous pubkey's set to the new one's, and deletes empty sets. A seeder record now keeps `pubkey`, the last HELLO pubkey. `hello` is the current connection's, and stays `null` (budget 0) until it arrives. So `byPubkey` holds at most one entry per seeder record (≤ 4096 + live), and a reconnect that drops before its HELLO keeps what the pubkey inherits. `stats().pubkeys` exposes the size. |
| IR3 | Low | A request failed over by its age alone, even while its peer was delivering. Honest seeders on slow links took permanent debt (a cancel after sending) and the one-request limit, and playback could stop. | **Fixed.** A request is stalled only when it is at least `stallMs` old AND its peer has delivered no block on that core for `stallMs`, counted from the later of the request and the peer's last `download` (per replication peer, in a `WeakMap`). A request `STALL_HARD_FACTOR × stallMs` old (4 × 4 s = 16 s) is stalled whatever its peer delivers. That keeps a peer from trickling other blocks while holding one back for ever. |
| IR4 | Low | Debts live in memory only. After a viewer restart, a seeder that is still running counts k unpaid blocks from the previous run, the viewer gives it its full window, overshoots by k, and is cut and banned. | **Deferred** (low; it predates the lane, since the old global pool forgot too). Persisting the debts would make things worse. They are permanent, conservative estimates, and the seeder's own counts reset when it restarts. A persisted estimate would therefore make an honest seeder unusable across every later run. Only the seeder knows what it counts. Recorded in the residuals below, in ADR 0018, and in `docs/contract-requests/S3-f33.md`. That request now names the restart case, and asks for the window report once the seeder binds the viewer's HELLO, before the first request. |
| IR5 | Info | `PeerBudget` used `null` for "no cap", while the APIs next to it (`windowOf`, `seederBatch`, `policyFor`) use `null` for "unknown". | **Fixed.** The only uncapped value is the exported `UNCAPPED` symbol. `null`, `undefined`, strings, other symbols and every non-finite or sub-1 number ask nothing. The type (`number \| typeof UNCAPPED`) rejects `null` at compile time. |
| IR6 | Info | A replication peer without the pinned fields kept hypercore's cap (fail open). | **Fixed.** `attachCore` throws `RoutingUnsupported` when any peer already on the replicator lacks a pinned field, and installs nothing. A peer that joins later without them is asked for nothing: an own `getMaxInflight() → 0`, which hypercore gates every request on. |
| IR7 | Info | `attachCore` reference-counted routes by core key without checking the replicator. A core closed and reopened was left unrouted. The reachable path was ADR 0015's image path closing a core a playback had attached. | **Fixed**, twice. (1) Routes are keyed by replicator. A reopened core (a new replicator) is routed anew, and several sessions of one replicator share its route, with per-session listeners and reference counts. (2) `host.ts` `releaseImageCore` never closes a core a playback attached (`coresAttached`). It still clears the free flag. |
| IR8 | Info | `readUpstreamBlob`'s default lookahead followed the pool, which any connected `pay/1` peer's HELLO (downstream browsers included) can grow to 1024. The gateway would then buy up to 1023 blocks ahead of a reader that may stop. | **Fixed.** The default is fixed at `upstream.creditBlocks − 1`, the pre-lane value, and is independent of the pool. An explicit `opts.lookahead` is unchanged. |

### Tests added (10)

- **Seeder `one-peer-router.test.ts`** (+5):
  - `close()` parks a core that is still replicating (IR1). This is the reviewer's probe: budget
    1, five `get`s held back, `close()`, then the in-flight block let through. Uploads stay at 1.
    A seeder that rejoins the parked core is asked for nothing.
  - A seeder still delivering on a slow link is not failed over: four requests released one
    message every 400 ms with `stallMs` 1 s (IR3).
  - The 4 × `stallMs` hard limit (IR3).
  - A peer without the pinned fields: refused at attach, asked for nothing when it joins (IR6).
  - A reopened core (a new replicator under the same key) is routed anew (IR7).
- **Gateway `seeder-credit.test.ts`** (+1): 50 fresh pubkeys under one Noise key leave one index
  entry, and a reconnect that drops before its HELLO keeps the inheritance (IR2).
- **Gateway `one-peer.integration.test.ts`** (+2): `close()` releases routes only after the seeder
  closed (IR1), and the lookahead stays at 3 with the pool at 1024 (IR8).
- **Desktop `host.test.ts`** (+2): the image path does not close a core a playback attached
  (IR7), and shutdown closes the payer only after `node.destroy()` (IR1).

### Tests updated

- **The router's refusal test.** It asserted that the last detach restores hypercore
  (`getMaxInflight` no longer an own property). That is the behaviour IR1 removes. It now asserts
  that the core is parked (cap 0), that another router takes it over, and that its `close()`
  parks it again. The comment in the file cites the review.
- **The router's cap test.** It adds `null`, `undefined`, a string and a foreign symbol to the
  fail-closed values (IR5).
- **`unlimited`.** It returns `UNCAPPED`.

### Mutation checks (each broken on purpose, at least one test failed, then restored)

| # | Mutation | Failing test |
|---|---|---|
| M29 | `release()` does not park (hypercore's cap back) | `close()` parks: failed, the four held-back requests went out with the landing block (5 downloads, never exactly 1); refusal test "expected 48 to be 0" |
| M30 | Park without the `peer-add` listener | `close()` parks: "requests to a peer that joined after close(): expected [1, 4] to equal [1, 0]" |
| M31 | Stall by request age alone (the old rule) | Slow-link test ("expected 1 failover to be 0"); hard-limit test |
| M32 | Hard limit removed | Hard-limit test ("expected false to be true") |
| M33 | `null` budget uncaps again | Cap test ("null: expected 48 to be 0") |
| M34 | Attach-time peer check removed | Pinned-fields test ("expected [Function] to throw") |
| M35 | Joining non-routable peer not capped | Pinned-fields test ("expected 16 to be 0") |
| M36 | Routes looked up by core key | Reopened-core test ("expected 1 to be 2") |
| M37 | `setHello` does not unindex the old pubkey | IR2 test (`pubkeys` 51, not 1) |
| M38 | Inheritance keyed on the current HELLO, not the last pubkey | IR2 test ("expected 4 to be 3") |
| M39 | Lookahead follows the pool again | Lookahead test ("expected 39 to be 3") |
| M40 | Gateway disposes `SeederCredit` before `seeder.close()` | Gateway close-order test |
| M41 | Desktop `payer.close()` before `node.destroy()` | Host shutdown-order test |
| M42 | `releaseImageCore` closes an attached core | Host image test ("expected undefined to be defined") |

### Real-mint lane, now routed (orchestrator request)

`real-mint-swarm.integration.test.ts` pays through the production stack (`viewerStack`, built as
`gateway.ts` and `viewer-payer.ts` build it): `CreditPool`, `CreditSettler`, `SeederCredit` (so
`OnePeerRouter`), and `UpstreamPayer` with `seederBatch`. The viewer reads unpaced, so the
per-seeder caps alone must hold the windows.

- **The routed test.** Three seeders with windows 6/3/2. Paid deliveries must equal blocks, each
  seeder must be paid exactly what it sent, each seeder's peak outstanding (read inside its own
  `recordUpload`) must stay within its window, and nothing may race.
- **The BASELINE.** A clearly labelled test that keeps the pre-F33 rig: a bare `UpstreamPayer`,
  windows of 64. It measures what the routing changes.
- **Setup change.** The mirrors copy the core while the origin marks it free (ADR 0015). Otherwise
  the origin's small window would be spent on the mirrors' unpaid warm-up.
- **Output.** The counts are reported as test annotations, since the package allows no console.
- **The other real-mint tests** (network drop, double spend) run on the routed stack too.

Results (`NUTFLIX_REAL_MINT_URL`, `--reporter=verbose` shows the annotations):

| Mint | Baseline (unrouted) paid / blocks | Routed paid / blocks | Routed per seeder (sent = paid, peak ≤ window) |
|---|---|---|---|
| Nutshell `:3399`, 5 runs | 26, 25, 25, 26, 26 / 24 | 24 / 24 every run | e.g. 10 / 8 / 6 sent, peaks 6 / 3 / 2 |
| cdk-mintd `:3397`, 1 run | 27 / 24 | 24 / 24 | peaks at the windows |

All four real-mint tests pass on both mints. No rejected ACK, no ban, and every seeder redeemed
at the mint.

### Self-review of the fixes (differential-review and sharp-edges, inline)

- **Parking is one-way per router.** A caller that detaches the router and then reads the core
  waits until its timeout. That is the fail-closed direction, and the router now logs it once
  (core key only). Production detaches only at shutdown.
- **A detach followed by a re-attach double-counts in-flight load as debt.** It is conservative,
  and no production caller does it.
- **IR3 trades delay for withholders.** A trickling withholder delays one block per batch by up to
  16 s (was 4 s per block). A silent one still delays each block by 4 s.
- **The fixed gateway lookahead (3 by default)** gives up the growing lookahead the lane had
  added. That is the pre-lane behaviour.
- **Nothing new logs a peer key.** No locked path is touched, and no IPC changed.

### Residuals, updated

- **IR4 (deferred).** Debts are per process: after a viewer restart, a seeder that is still
  running can be overrun by what it counted from the previous run, and bans the viewer. This
  predates the lane. Needs the seeder's own count (contract request `S3-f33`, v7).
- **Trickling withholders** delay one block per batch by up to 16 s (`STALL_HARD_FACTOR`).
- **A core session closed under the router** while other, unattached sessions keep its replicator
  alive stops delivering `peer-add` to the router. A new peer there would keep hypercore's cap.
  Nothing in the desktop or gateway does this: one session per core, and the image path no longer
  closes a playback core.
- The other residuals above stand: pinned internals (fail closed at runtime now in every case),
  conservative debts, wall-clock steps, unpaid-after-drop, pre-HELLO wait, seeder policy mismatch.

### Commands

- `npx vitest run packages/seeder packages/gateway packages/app-desktop/src/worker`, plus the
  suites above one by one.
- `npx vitest run --maxWorkers=2`: 174 files passed, 2 skipped; 2758 tests passed, 11 skipped.
  `runtime-units.test.ts` timed out once under load in a package run and passed alone (31/31).
- `NUTFLIX_REAL_MINT_URL=http://127.0.0.1:3399 npx vitest run
  packages/gateway/src/__tests__/real-mint-swarm.integration.test.ts`: 4 passed (×5, and ×1 on
  `:3397`).
- `npx tsc -b --force`, eslint and prettier on every changed file, `npm run check:locked`,
  `npm run lint:electron`: clean.
