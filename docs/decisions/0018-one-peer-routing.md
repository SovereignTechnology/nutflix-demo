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

## Amendment 2026-09-26 — the seeder's count, and paying an old tail (Cameron)

The cross-lane review showed the "per-process debts" residual is routine, not rare: blocks
delivered but unpaid when a session closes, the app quits or crashes (or, before the image
fix, one probe block) stay counted by the seeder for good, and the viewer's next run, starting
from zero, overruns that seeder and is banned. Cameron's answers:

- **The seeder reports; the viewer pays.** pay/1 gains, additively in contracts v6:
  - `OWED` (seeder → viewer), sent once both HELLOs verify, one per core where the seeder
    still counts unpaid blocks for this viewer's HELLO pubkey: the core and its unpaid block
    ranges (bounded in count and total);
  - `ACK.outstanding`: after applying a PAY, the blocks of that core the seeder still counts
    for this viewer.
  The viewer's per-seeder credit starts from what the seeder reports (it never asks beyond
  window minus the reported count), and on reconnect it pays the reported old blocks — but only
  those its own durable record says it received from that seeder (by HELLO pubkey) on that core,
  at the terms it recorded when it played them, within a budget the host authorised for that
  session's tail. A seeder that claims more than the viewer's record is respected (no request
  beyond its window) and never paid for the difference.
- **Failover delay stays 4 s.**

Implemented on `stage-3/owed-seeder` (seeder side: codec, engine, announcements) and
`stage-3/owed-viewer` (viewer side: credit, payer, the worker's record, the host's tail
authorisations).

### Seeder side as built (2026-09-27, lane P1-owed-seeder)

The normative text is in `packages/core/src/contracts/pay-protocol.ts`; the choices it fixes:

- **When and what.** The report goes out when the seeder's channel opens and the viewer's pubkey
  binds (a banned pubkey is cut instead). It names what the engine counts unpaid for that pubkey:
  earlier connections under any Noise key, and this one's blocks sent before the HELLO (merged by
  the bind). Cores in first-counted order, ranges ascending, the whole report capped at 256
  ranges / 1024 blocks (`MAX_OWED_RANGES` / `MAX_OWED_BLOCKS`); what the caps leave out is still
  in `ACK.outstanding`.
- **Order.** The seeder handles the opening HELLO — bind and the whole report — before any frame
  after it on the stream, and when its own HELLO goes out last the report follows it directly. A
  viewer that asks nothing before its channel is `open` therefore has the whole report before the
  first block it asks for, so "a block arrived, no `OWED`" means nothing is owed. Tested on real
  streams for both HELLO orders.
- **Terms.** Before a sold core's `OWED` the seeder sends its priced `PRICE`; owed ranges are
  verified at the terms this connection was told (the core's current policy), inside this
  connection's carry chain for the core: it restarts at 0 on the new channel and moves with every
  accepted PAY of the core, so an owed range carries 0 only if it is the core's first PAY here. The seeder keeps no per-block record of the price a block was delivered at, so
  a price change between two connections moves the owed blocks to the new price — the viewer,
  which pays only at the terms it recorded, then leaves them unpaid (a residual, below). An `OWED`
  with no priced `PRICE` (a core served free since, or with no terms) is counted and not payable.
- **In memory.** The engine's counts live for the seeder process; a restarted seeder counts
  nothing old and reports nothing.
- **Residuals.** A report past the caps (heavily fragmented debts) is short until the first
  `ACK.outstanding`. Owed blocks are priced at the current terms, not the delivery-time terms.
  `OWED` has no end marker; the order rule above is what tells a viewer the report is complete.

### Viewer side as built (2026-09-27, lane P2-owed-viewer)

- **Credit from the report** (`SeederCredit`, shared by the desktop worker and the gateway).
  - Per connection, a seeder's report is complete once anything it sent in answer to a frame we
    sent after our HELLO arrives: a block we asked for after `open`, or an ACK. Replies to
    requests made before the channel opened do not count: those in flight when its `pay/1`
    attached (a gateway session may replicate before `pay/1` attaches), and, counted again when
    the channel opens, those asked since on a core nobody pays for (independent review: such a
    reply could land before the OWED and complete the report without it). Otherwise the report is
    complete `REPORT_WAIT_MS` (10 s) after the channel opened, which bounds a report that never
    arrives.
  - Before the report, `old` is what this process knows of: blocks left unpaid on earlier
    connections, and requests lost with them. It is the report so far instead, if that is
    larger. The seeder is asked ONE block at a time (the router's new `single` option).
  - At the report, what the seeder says it counts replaces our estimate of everything before this
    connection: requests remembered as lost (`OnePeerRouter.forgive`), blocks settled unpaid,
    what other Noise keys of its pubkey left, and the ledger's word for an earlier run.
  - After the report, `old` is what it reported, plus what this connection left unpaid since.
    Each ACK of a core re-bases that core to `outstanding` less the blocks of it still owed on the
    link. That is an upper bound: blocks in flight count twice.
  - A report that hit the contract's caps, or a malformed one, may be short. Nothing more is asked
    of that seeder on that connection.
- **The durable ledger** (desktop only). After a crash, the worker's record keeps, per seeder
  pubkey, whether that seeder may count its whole window against us. The word is written
  synchronously before anything is asked that could bring the seeder there, and cleared at a
  flush once it is below. A seeder with that word is asked nothing before its report: not even
  the one block, which would overrun a seeder left exactly at its window. Liveness is bounded by
  `REPORT_WAIT_MS`. The word outlives the record's 7-day age-out, and the record's seeder bound
  drops seeders holding only blocks first (independent review): the seeder keeps counting what we
  forget.
- **Paying the old tail** (desktop only).
  - The worker's `UnpaidRecord` holds, per seeder pubkey and core, the blocks received and not
    paid, each with its session's id, blob range and manifest policy. It is rewritten atomically
    in batches (1 s) and at close.
  - A block leaves the record when a PAY is built for it. So a seeder that takes a PAY and drops
    before its ACK is never paid twice for reporting the same blocks again, just as a refused PAY
    is never re-sent.
  - On `OWED`, only the reported blocks the record also holds are handed to the payer
    (`UpstreamPayer.addOwed`), and only after the core's priced PRICE on this connection. They
    are paid at once, apart from this connection's blocks and on its carry chain, at the recorded
    terms: the asked price may only lower them. They are paid under the recorded session's id.
    Owed and fresh PAYs of a core share that one chain, and the worker hands the host the carry
    of every PAY; a PAY without one is refused before the host is asked (independent review: the
    fresh path dropped it, and a PAY split with 0 against another carry is refused `malformed`
    after its proofs were spent). A PAY whose creator share is 0 sats carries an empty creator set
    (contracts v5), which the worker's guard now admits.
  - An owed range with no mint shared on this connection is dropped from this connection only
    and stays in the record for a later one. A range the host refuses for good leaves it.
  - The host checks that id as an open session. If the session is closed, it checks its tail
    authorisation: the same core, blob range and terms, and a block budget taken off on disk
    before the PAY is built.
- **Tail authorisations** (`host/tails.ts`).
  - `play.close` answers `{ unpaid }`, the session's blocks still in the record. The host keeps
    `min(unpaid, what the session had left, MAX_TAIL_BLOCKS = 1024)` for 7 days, per identity, in
    `<userData>/tails/<pubkey>.json` (private file).
  - When the worker could not say (it was gone, a quit past its bound, a sign-out with sessions
    open), the host keeps the session's remaining budget, with the same cap.
  - The quit waits for these writes, including those the signer flow's plane starts as it closes;
    and a new plane for an identity opens only after the closed plane's writes landed.
  - One tail book owns the file at a time (fix round 7): a closed plane's book writes nothing
    more, so a tail PAY still waiting for its turn at a mint when the plane closed (a sign-out or
    lock, then a quick sign-in) cannot overwrite the next plane's book at its turn. The blocks it
    would have given back stay off the budget: respected, never paid.
  - An expired tail is refused `forbidden`. The worker drops those blocks from its record:
    respected, never paid.
- **The gateway** gets the credit-from-report part, including the one-block rule before the
  report. It pays no old tail: it has no durable record of what it received and no host to
  authorise a closed session's tail. What its previous run left unpaid stays counted at the
  seeder, and the gateway stays under it, until that seeder forgets it (its own restart).
- **Residuals** (lane record): a report delayed past `REPORT_WAIT_MS` for a seeder left at its
  window. A full-app crash leaves no tail authorisation, since the task creates them at close or
  quit, so that tail is respected and not paid. A compromised worker keeps its closed sessions'
  capped budgets as spending authority for 7 days. The gateway has no durable ledger, so it keeps
  the one-block risk after its own crash at a seeder's cap.
