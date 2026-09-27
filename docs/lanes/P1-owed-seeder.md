# Lane P1-owed-seeder — the seeder reports what it counts, and says "free" per core

Branch `stage-3/owed-seeder`, off `54f49bb`. Date: 2026-09-26/27. Commits:

- `2305f83`: the interrupted agent's unreviewed wip, kept as committed;
- `e06eee8`, `551adbf`, `214a2a7`, `776ab04`: this lane's work;
- then this record and the review record.

Review record: `docs/reviews/2026-09-26-pre-push-owed-seeder.md`. Decisions: Cameron 2026-09-26,
the amendments at the end of ADR 0018 (the seeder's count; paying an old tail) and ADR 0015
(seeders say "free"). Lane P2 builds the viewer side on top of this branch.

`docs/status.md` and `docs/security-review.md` were not edited. The text proposed for each is at
the end.

## What changed, and why

A seeder counts every block it sends a viewer until the viewer's PAY arrives. Blocks left unpaid
when a session closes, or when the app quits or crashes, stayed counted by the seeder for good.
The viewer's next run started from zero, overran that seeder's window, and was banned.

Separately, a desktop image read of a core could not tell a seeder that serves the core free from
one that sells it. So the viewer probed with one unpaid block per seeder, and a restart turned
that block into a ban. Cameron's answer covers both: the seeder reports, the viewer pays, and
seeders say "free" per core.

### The contract (additive in v6; `PAY_PROTOCOL_VERSION` stays 1)

`packages/core/src/contracts/pay-protocol.ts`, with the amendment noted in `version.ts`:

- **`PriceMessage.free?: boolean`.**
  - `true` means the seeder serves the core outside payment from now on: nothing counted, never
    cut for, `satsPerBlock` and `effectiveFromBlock` 0.
  - Only `true` means free. `{ satsPerBlock: 0 }` without it is still a sold core.
- **`OwedMessage { type: 'OWED'; core; ranges }`** (seeder → viewer, codec tag 5).
  - `ranges` holds the blocks of that core the seeder still counts unpaid for the viewer's HELLO
    pubkey.
  - The ranges are canonical: 1 … `MAX_OWED_RANGES` (256), ascending, disjoint, not adjacent, at
    most `MAX_OWED_BLOCKS` (1024) blocks.
- **`AckMessage.outstanding?: number`:** after the PAY was applied, the blocks of the ACK's core
  still counted for this account.
- **`PayProtocolEvents.owed`** (delivered only on an open channel; earlier it is a protocol error)
  and **`PayProtocol.sendOwed`**.
- **The normative rules**, in the contract's header, for every seeder this repository builds:
  1. A core's PRICE (priced, or `free`) comes before the core's first block on a pay/1
     connection, and again whenever that changes. The same terms are never said twice.
  2. One OWED per owed core is sent when the channel opens. It is bounded, oldest first, and
     includes pre-HELLO blocks. **The order rule:** the seeder handles the opening HELLO — the
     bind and the whole report — before any later frame. A viewer that asks nothing before
     `open` has the report before its first block, so silence after that block means nothing is
     owed.
  3. A sold core's priced PRICE goes before its OWED. Owed ranges are ordinary PAYs, verified at
     this connection's terms with a new channel's carry (`carryIn` 0), and an accepted PAY
     clears them. An OWED with no priced PRICE is counted and not payable.
  4. `outstanding` goes in every ACK. It also states the viewer's side as claims:
     - pay only what your own record says you received;
     - respect a larger claim, and never pay the difference.

**The wire.** A priced PRICE is byte-for-byte the v5 frame: the flags byte is written only with
`free`. An older build still reads priced PRICEs; it refuses OWED, a free PRICE and an ACK that
carries `outstanding`. The interrupted wip had made the flags byte mandatory, which changed every
PRICE. That is review finding M1, now fixed.

### The seeder side

- **Codec** (`core/src/pay-protocol/codec.ts`, locked).
  - Decode never throws, and encode refuses anything outside the grammar, bounds included.
  - OWED: the range count is checked before any range is read, and the running total while they
    are read.
  - PRICE: flags must be 1 or 3, and `free: true` requires 0/0.
  - ACK: bit 2 means `outstanding` follows.
- **Channel** (`channel.ts`, locked).
  - An OWED is delivered only when the channel is `open`; earlier it is a protocol error.
  - `sendOwed` throws before `open` (a local bug) and drops the message once closed.
- **Engine** (`payment/`, locked). `RealPaymentEngine` and `MockPaymentEngine` implement
  `UnpaidLedger`:
  - `outstandingOn(peer, core)`;
  - `unpaid(peer, limits)`: cores in first-counted order, ranges ascending, bounded by
    `boundOwed`, walked lazily so it stops at the caps;
  - `RangeSet.difference`. A junk limit falls back to the cap, because a short report is the
    unsafe direction.
- **`Seeder`** (`packages/seeder`):
  - `PeerSession.onUpload` calls `beforeBlock` before every block: free blocks before the free
    early return, counted blocks before `recordUpload` and the window check.
  - `Seeder.announceTerms` sends the PRICE and remembers per session what was said: once, and
    again on free ⇄ sold. The priced form records the F9 price history, so owed ranges verify at
    the PRICE just sent.
  - If the hook throws, the session is cut (`local`, no ban) before the block is written. A block
    never goes out without its terms.
  - `announceOwed` runs from the pay bridge's `open` handler, only after a successful
    `bindPubkey`, once per connection, with the priced PRICE before each sold core's OWED.
  - The bridge puts `outstanding` (a safe count, else nothing) in every ACK.
  - `Seeder.create` refuses an engine that is not an `UnpaidLedger`.
  - The `announceCorePrices` option is gone: always on, no switch.
- **Every composition.**
  - The daemon (`cli/daemon.ts`, `runtime/pay-wiring.ts`), the gateway (`gateway.ts`), the desktop
    worker (`worker/host.ts`, `net/peer-node.ts`) and the dev fixtures (`dev/fixtures-net.ts`) all
    build a `Seeder`.
  - They no longer pass the removed option.
  - Their `seederEngine` types now require `UnpaidLedger` (`GatewayDeps`, `WorkerProviders`).
- **Dev loopback pay/1** (`dev/loopback-pay.ts`): carries OWED, and keeps the real channel's
  order rules — `open` once, after both HELLOs.

### Compile-only edits outside the seeder side

`PayProtocol` gained a required `sendOwed` and an `owed` event, so every implementer changed.
Each edit is a one-line pass-through or no-op, with no behaviour:

- `gateway/src/upstream/settle.ts` (the wrapper passes `sendOwed` through). This is viewer code:
  the one line the interface forces;
- `gateway/src/cli/dev-mocks.ts`;
- the test fakes in `gateway/src/__tests__/fake-pay-protocol.ts` (which also gained
  `remoteOwed`) and `app-desktop/src/worker/__tests__/viewer-payer.test.ts`.

`gateway/src/upstream/seeder-credit.ts` was not touched: see residual R1.

## Files

- **Contract:** `packages/core/src/contracts/{pay-protocol,version}.ts`.
- **Locked:**
  - `packages/core/src/pay-protocol/{codec,channel,index}.ts`;
  - `packages/core/src/payment/{engine,owed,range-set,index}.ts`.
- **Mocks:** `packages/core/src/mocks/mock-payment-engine.ts`.
- **Seeder:**
  - `packages/seeder/src/{seeder,config}.ts`;
  - `net/{peer-session,session-registry}.ts`;
  - `payment/pay-bridge.ts`;
  - `cli/daemon.ts`.
- **Gateway:** `packages/gateway/src/gateway.ts`, `cli/dev-mocks.ts`, `upstream/settle.ts`
  (pass-through).
- **Desktop worker:**
  - `packages/app-desktop/src/worker/{host,providers}.ts`;
  - `pay/real-providers.ts` (comment);
  - `dev/{fixtures-net,loopback-pay}.ts`.
- **Docs:**
  - ADRs 0012 (§4 superseded note), 0015 and 0018 (the seeder side as built);
  - this record and the review record.

## Tests

New test files:

- `core/src/payment/__tests__/owed.test.ts`:
  - `RangeSet.difference` against a `Set<number>` model;
  - `boundOwed` caps and junk limits;
  - the real engine's ledger equal to the mock's (property test, with a rebind);
  - an owed range paid on a new connection at carry 0 and cleared; a stale carry is refused;
  - a PAY past what was sent is refused.
- `seeder/src/__tests__/owed-terms.test.ts`:
  - rule 1 (free / sold / back; dedupe; no terms; no pay/1);
  - rules 2–3 (order and caps; carry 0; a price change after the report; banned; pre-HELLO
    blocks; no terms);
  - rule 4;
  - the bridge alone;
  - fail closed (the hook, a throwing `sendPrice`, an engine with no ledger).
- `seeder/src/__tests__/owed.integration.test.ts`. Two `Seeder`s over piped Noise streams, the
  real `PayChannel`, `LocalSigner` HELLOs, the real engine and TestMint ecash:
  - the viewer receives the PRICE before each core's first block (priced and free);
  - a dropped connection's unpaid blocks come back as OWED after the PRICE; the PAY clears them;
    playback continues within the window;
  - the order rule for both HELLO orders.
  - Opt-in at a real mint: the owed range is paid in real ecash and redeemed there.
- `gateway/src/__tests__/terms-before-blocks.integration.test.ts`: the gateway's own seeder, with
  its real `PayChannel` factory, over a real stream:
  - PRICE before the first block for a sold and a free core;
  - `outstanding`;
  - OWED and the clearing PAY for a returning viewer;
  - reads start at `open`, so a late seeder-side attach is caught.
- `app-desktop/src/worker/__tests__/terms-before-blocks.integration.test.ts`:
  - the desktop's `PeerNode` with the production pay/1 shape on a loopback hyperdht testnet;
  - the dev fixtures over the loopback hub;
  - both: PRICE (priced and free) before each core's first block.

Extended:

- `codec.fuzz.test.ts`:
  - arbitraries for OWED, free PRICEs and `outstanding`;
  - the grammar at its edges both ways;
  - an OWED-tagged fuzz run;
  - priced PRICE bytes equal the v5 layout;
  - `isPayProtocolMessage` refusals.
- `channel.test.ts`: OWED when open, a protocol error before; `sendOwed` guarded.
- `seeder-runtime.integration.test.ts`: the daemon runtime over hyperswarm sends PRICE (priced and
  free) before each core's first block, and `outstanding` in every ACK.
- `dev.test.ts`: the loopback's order rules.

Two existing assertions were wrong under the new rules. Each was corrected with a comment citing
why; neither was deleted or weakened:

- `seeder.test.ts`: "off by default: a one-price seeder sends none" was corrected in the wip
  commit, with the reason stated;
- `dev.test.ts`: the loopback used to fire `open` on the remote HELLO alone.

`replication.integration.test.ts`'s exact ACK now carries `outstanding: 0`.

**Mutation checks:** 32, all caught. The table is in the review record.

**Real mints** (`NUTFLIX_REAL_MINT_URL`): `owed.integration.test.ts` at Nutshell 0.21.0 (`:3399`,
`:3398`) and cdk-mintd 0.18.1 (`:3397`), all green. The flush after the owed PAY: swapped 4,
nutzapped 4, no dust.

## Gates

- `npx tsc -b --force`: clean. `npm run build`: clean.
- eslint and prettier on every changed file: clean.
- `npm run check:locked`: OK.
- `npm run lint:electron`: OK (238 files, 0 violations).
- `npm run check:native`: OK. No dependency changed.
- **Whole suite**, `npx vitest run --maxWorkers=2` on a shared box at load 24–28 on 8 cores:
  3317 passed, 20 failed, 22 skipped (218 files). The 20:
  - **3 known base failures, owned by lane R6:** packaging `stage.test` "host bundle…" (for
    `QUIT_FLUSH_MS`) and two viewer-payer "I2-paygate rate-limited" tests. The stage test's
    test-double assertions, which come before its failing export check, pass. This lane adds
    nothing to the host bundle.
  - **6 from R1:** `images-over-pear.integration` (3) and `images-paid-core.integration` (3).
  - **11 timeouts at the default 5 s**, all in files this lane did not touch. Rerun alone:
    - `stage.test` "is deterministic" and `auto-topup.test` (5): green alone.
    - `money.test` (2 of its 4) and `ipc/guards.test` (1) still pass 5 s alone at load 14–17.
      With a diagnostic `--testTimeout=60000` on the command line (no timeout changed in the
      repo), they pass: the guards case spends 3.5 s on one `setProfilePicture` sample.
- **Real mints:** see Tests. The gateway real-mint swarm lane (`:3399`, `:3397`) and core's
  real-mint integration (`:3399`) are green too.

## Residuals

- **R1 — cross-lane, must land with P2.** The current viewer code reads any PRICE for an image
  core as "sold": `SeederCredit`'s `price` listener, `gateway/src/upstream/seeder-credit.ts:196`.
  - A seeder that now correctly says `{ free: true }` therefore stops the desktop's image read,
    and 6 tests fail on this branch alone: `images-over-pear.integration` (3) and
    `images-paid-core.integration` (3).
  - A one-line guard (`if (p.free === true) return;`) makes all 10 of those tests pass. It was
    verified and reverted, not committed, since it is viewer code in P2's paths.
  - P2's task rewrites that listener: "ask only after `{ free: true }`".
- **R2 — no end marker.** A viewer learns the report is complete through the order rule only (the
  first block it asked for after `open`). A viewer that asks earlier is counted provisionally, and
  the bind may cut it.
- **R3 — truncation.** Past 256 ranges or 1024 blocks (heavily fragmented debts), the report is
  short until the first ACK's `outstanding`.
- **R4 — terms at delivery.** Owed ranges are verified at this connection's terms: the core's
  current policy, announced just before the OWED. A price change between two connections of one
  seeder process moves old blocks to the new price. A viewer that pays only at its recorded terms
  leaves them unpaid until that seeder restarts, and the engine's counts live only for the process.
- **R5 — no terms.** A core with no terms at all (no policy of its own, no default, not free) gets
  no PRICE, and its blocks are still counted. No production composition serves one, except a
  sub-second window in the desktop's Studio upload between `studio.publish` and `setCorePolicy`.
  The core is not yet joined to its topic, but corestore replicates it to any connected peer that
  asks for its key.
- **R6 — free after sold.** Blocks counted before a core turned free stay counted and are not
  payable (rule 3). The seeder does not forgive them.
- **R7 — PRICE and the block on different transports in dev.** For the dev fixtures only, the
  PRICE travels the in-process loopback hub and the block travels UDX. The seeder sends the PRICE
  first, and the microtask hop wins in practice (tested), but the order is not guaranteed there as
  it is on one Protomux stream.
- **Stale comment:** the module comment of `seeder-credit.ts:38` still names `announceCorePrices`.
  That is P2's file, left for them.

## Questions for Cameron

1. **R4.** Should a seeder honour, for owed blocks, the price they were delivered at? That needs a
   per-account, per-range price record in the engine. Or is "current terms, the viewer may
   decline" enough, given that prices change rarely and a restart forgets the debts?
2. **R2.** Is an explicit end-of-report signal worth a v7 wire change? For example, an OWED with
   zero ranges meaning "nothing (more) owed". Or is the order rule enough?

## Proposed `docs/status.md` row

```
| Seeder's count + "free" per core (ADRs 0015/0018 amendments 2026-09-26) | `stage-3/owed-seeder` (off `54f49bb`) | **done (seeder side; lands with P2's viewer side)** — pay/1 gains, additively in v6, `PRICE.free`, `OWED` (tag 5; ≤ 256 ranges / 1024 blocks, canonical) and `ACK.outstanding`; a priced PRICE is byte-for-byte v5. Every seeder the repo builds (daemon, gateway, desktop worker, dev fixtures) sends a core's PRICE — priced, or `{ free: true }` — before its first block (`announceCorePrices` removed; a block whose PRICE cannot be sent is not sent), reports each returning viewer's unpaid blocks per core once the HELLOs verify (priced PRICE first; the whole report before any later frame, so a viewer that waits for `open` knows when it is complete), accepts a PAY for them at the core's terms with carry 0 (clears them), and puts `outstanding` in every ACK. Tested on real streams for each composition, at two real mints, 32 mutation checks. Open: R1 (the current viewer reads `free` as sold — P2), R4 (owed blocks at current, not delivery-time, terms) |
```

## Proposed `docs/security-review.md` text (§5 or §6)

> **pay/1 v6 amendment — the seeder's count and "free" (lane P1-owed-seeder, 2026-09-26).**
>
> **Holds:**
> - The OWED grammar is enforced both ways in the codec: canonical, and at most 256 ranges /
>   1024 blocks. Decode never throws (fuzzed).
> - An OWED is accepted only on an open channel, and names only the blocks counted for the pubkey
>   whose connection-bound HELLO signature verified. No viewer learns another's history.
> - PAYs for owed ranges go through the unchanged offline `verify`: exact amounts,
>   `range-not-uploaded`, `range-already-paid`, and the epoch refusal of a replaced channel.
> - `free` is local (`setFreeCore`), and it refuses a priced core.
> - Every seeder sends a core's terms before its first block, from the synchronous upload gate. A
>   block whose terms cannot be sent is not sent (a `local` cut, no ban).
> - OWED, `outstanding` and `free` are the seeder's claims. A viewer pays only for blocks its own
>   record says it received, and never the difference a larger claim adds.
> - Logs carry counts only.
>
> **Residual:**
> - [Low] Owed blocks are priced at the current terms, not the delivery-time terms (R4).
> - [Low] No end-of-report marker; the order rule stands in for it (R2).
> - [Info] A core with no terms is counted without a PRICE (R5).
