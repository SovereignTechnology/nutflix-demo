# 18. One seeder per block, credit per seeder window: hypercore's hotswap replaced

Date: 2026-09-25

## Status

Accepted for Stage 3 (issue #1: security review F33; issue #8: "the credit pool is not sized per
seeder window"). Cameron's decision, 2026-09-24: "request each range from a single seeder — no
duplicates, seeders paid fairly". Implemented on `stage-3/f33-one-peer`, with the fixes from the
lane's independent review (2026-09-25).

## Context

A seeder counts every block it sends a viewer until the viewer's `PAY` for it is verified. Once
that count passes the seeder's unpaid window, the seeder cuts the viewer and bans its pubkey, and
the ban is saved to disk. So the viewer must pay for everything a seeder sent, and must never ask
a seeder for more than its window allows.

Two things broke that.

- **Duplicates (F33).** Hypercore can ask two or three seeders for the same block. The source is
  its hotswap (`Replicator._updateHotswap`): whenever a peer has spare capacity, it re-requests
  blocks already in flight elsewhere. The first answer wins, and the others are cancelled, too
  late once they were sent. Each seeder counts what it sent, so a raced block was paid twice.
  Measured: 29 paid for 24 blocks in the real-mint lane, 55–67 deliveries for 48 blocks on piped
  streams.
- **One pool for all seeders (issue #8).** The downloader kept one credit pool (4) for every
  seeder. It overran a seeder with a smaller window and starved one with a larger window. It did
  not even hold at 4: hypercore drops an answer that arrives after its request was cancelled, so
  a raced loser is never paid, yet the seeder still counts it.

Hypercore picks the peer for each request and offers no public way to choose it.

## Decision

1. **`OnePeerRouter` (`packages/seeder/src/net/one-peer.ts`)** reaches into the replicator of each
   routed core, at the two points that decide who is asked:
   - `replicator.hotswaps` is replaced by a queue that never races. It offers a block to another
     peer only when the block's single request has **stalled**. As the replacement request goes
     out, it cancels the stalled one. That is a failover to one other peer, never two at once.
   - Each replication peer's `getMaxInflight()` is capped at
     `inflight + budget(remote, core) − used(remote)`. Hypercore reads this cap before every
     request it makes to that peer. `used` counts what the peer may have sent that nothing will
     pay yet: requests in flight, blocks being verified, and, for good, requests cancelled after
     they went out and requests that died with a connection.
2. **`SeederCredit` (`packages/gateway/src/upstream/seeder-credit.ts`)** supplies the budget, per
   seeder and per core.
   - **The budget.** It is the seeder's window, less the blocks it delivered that are not ACKed,
     less the blocks it delivered that will never be paid. The window is the HELLO's
     `windowBlocks`, widened so one minimum PAY fits: `effectiveWindowBlocks` with the manifest's
     policy, clamped to 1024.
   - **Special budgets.** No HELLO yet: 0. A closed `pay/1`: 0. A peer without `pay/1`, or a core
     nobody pays for: 4 in flight at a time.
   - **The pool.** The downloader's `CreditPool` follows the sum of the seeders' windows. It never
     goes below its construction size or above 1024.
   - **Batches.** PAYs batch to half each seeder's window, and at once when the seeder is at its
     cap.
   The desktop worker (`ViewerPayer`) and the gateway's upstream reads share this module.
3. **The failover delay.** A request has stalled when **both** of these hold:
   - it is at least `stallMs` old (default 4 s);
   - its peer has delivered no block on that core for `stallMs`, counted from the later of the
     request and the peer's last block.
   An honest seeder on a slow link keeps delivering, so its pipelined requests are never failed
   over. A request `STALL_HARD_FACTOR × stallMs` old (16 s) has stalled whatever its peer
   delivers, so a peer cannot trickle other blocks to hold one back for ever. A peer that stalled
   gets one request at a time until it delivers again. `stallMs` is validated finite and at least
   50 ms.
4. **The permanent-debt rule.** The viewer counts some blocks against a seeder for the life of the
   process, because it cannot tell whether the seeder counted them:
   - a request cancelled after it went out;
   - requests in flight when a connection dropped;
   - blocks owed when its `pay/1` went away;
   - rejected PAYs.
   These debts are remembered after the seeder disconnects, bounded to 4096 seeders. A seeder that
   returns under a new Noise key with the same signed HELLO pubkey inherits them. An overrun
   means a persisted ban, so the estimate errs high.
5. **Fail closed, everywhere.**
   - **Refused attach.** `attachCore` throws `RoutingUnsupported` when the replicator, or any peer
     already on it, lacks a pinned internal. The desktop marks a core attached only after the
     router accepted it, so a retry is refused too.
   - **Late peers.** A peer that joins later without the pinned fields is asked for nothing.
   - **Budget values.** Only the `UNCAPPED` symbol keeps hypercore's own cap. `null`,
     `undefined`, `NaN`, `±Infinity`, values below 1 and a throw all ask nothing.
   - **Released cores are parked.** A core released by the last detach or by `close()` is not
     handed back to hypercore's scheduler. Every peer, including any that joins later, is capped
     at 0 new requests, and the no-race queue stays. The next `attachCore` of that core takes it
     over. Shutdown also closes connections before the payer, on the desktop and on the gateway.
6. **The hypercore dependency.** The router is written against **hypercore 11.35.3** (pinned in
   the lockfile and the packages). `packages/seeder/src/__tests__/one-peer-router.test.ts` pins:
   - the version;
   - every member it uses, checked on real objects;
   - the order of the `lib/replicator.js` lines it depends on:
     - `_sendBlockRequest` pushes, then calls `hotswaps.add`, then sends;
     - every request path gates on `inflight >= getMaxInflight()`;
     - `dataProcessing` spans the verify, before the `download` event;
     - `peer-add` fires in `_addPeer`;
     - `_includeLastBlock` is off by default;
   - `PRIORITY.CANCELLED` = 255.
   A hypercore bump fails these tests first. The router must be re-verified against the new
   release before the pin moves.

## Alternatives rejected

- **Pinning requests ourselves** (calling `_requestBlock` on a chosen peer): this reaches deeper
  into the internals and still leaves the hotswap racing.
- **Our own block protocol:** our own Merkle verification, which is ours to get wrong.
- **A smaller global pool:** it starves every larger window, and still leaks through raced losers.

## Optional contract change (v7): the seeder's count in `ACK`

`docs/contract-requests/S3-f33.md` proposes an optional `ACK.window = { outstanding, windowBlocks
}`. With it, the viewer could re-base its estimate on what the seeder actually counted, and shrink
the permanent debts above. That would fix three residuals, each of which lets the viewer fall out
of step with what the seeder counts:

- honest seeders on flaky links losing budget for the session;
- blocks delivered before a drop, which are debited instead of paid;
- a viewer restart, which forgets its debts while the seeder remembers them.

v6 ships without it. The router is correct without it, only conservative.

## Consequences

- **Measurements.** Each block is delivered and paid once:
  - piped streams: 48 of 48;
  - desktop testnet: 48 of 48, with windows 8/4/1 each used to exactly its size and no bans;
  - real mint, Nutshell: 24 of 24 in five runs, against 25–26 for the unrouted baseline;
  - real mint, cdk-mintd: 24 of 24, against 27.
- **Withholding peers.** A silent withholder delays each block it takes by `stallMs`. A trickling
  one delays one block per batch by at most 16 s. Hotswap used to hide both by racing, at the
  price of paying duplicates.
- **A released core does not come back to hypercore's scheduler** in the same process. Reading it
  again means routing it again.
- **Gateway lookahead.** `Gateway.readUpstreamBlob`'s default lookahead is fixed at
  `upstream.creditBlocks − 1`. It does not follow the pool, which any connected `pay/1` peer's
  HELLO can grow.
