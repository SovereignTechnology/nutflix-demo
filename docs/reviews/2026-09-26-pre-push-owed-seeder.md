# Pre-push review — the seeder's count and "free" per core (2026-09-26)

Diff: `54f49bb` → `stage-3/owed-seeder` (`2305f83` wip, `e06eee8`, `551adbf`, `214a2a7`,
`776ab04`, and this record). Method: `differential-review` and `sharp-edges`, inline, on the whole
diff including the interrupted agent's unreviewed wip commit. Decisions: Cameron 2026-09-26, the
amendments to ADRs 0015 and 0018. Lane record: `docs/lanes/P1-owed-seeder.md`.

## Executive summary

| Severity | Found | Fixed in the lane | Open |
| -------- | ----- | ----------------- | ---- |
| HIGH     | 0     | 0                 | 0    |
| MEDIUM   | 4     | 3                 | 1 (R1, cross-lane: the viewer lane owns it) |
| LOW      | 6     | 5                 | 1 (R4) |

- **Overall risk:** MEDIUM. A new message a seeder sends every returning viewer, a new meaning on
  PRICE, and a change to the upload gate that every block passes through.
- **Recommendation:** CONDITIONAL. The seeder side is complete and tested, including at two real
  mints. The branch alone turns 6 desktop image tests red: the current viewer code
  (`gateway/src/upstream/seeder-credit.ts`, lane P2's) reads any PRICE, including
  `{ free: true }`, as "sold". That is finding R1, and lane P2 owns the fix. The branch should be
  merged together with P2's viewer change, never alone.
- **Files:** 44 changed, all read: 24 source (7 of them in locked paths, plus the 2 contract
  files), 15 tests, 3 ADRs, 2 records.
- **Mutation checks:** 32. Every one was caught.
- **Blast radius:**
  - `PeerSession.onUpload` runs on every block every seeder sends (1 caller: the session
    registry's upload gate).
  - `Seeder.create` has about 20 call sites.
  - `PayProtocol` has 7 implementers.

## Scope and risk

- **HIGH** (money, the window, untrusted input):
  - `core/src/pay-protocol/codec.ts` (locked). The first code untrusted bytes reach: the OWED
    grammar, PRICE `free`, ACK `outstanding`.
  - `core/src/pay-protocol/channel.ts` (locked). OWED is accepted only on an open channel;
    `sendOwed` is guarded.
  - `core/src/payment/{engine,owed,range-set}.ts` (locked). `outstandingOn`, `unpaid`,
    `RangeSet.difference`, `boundOwed`.
  - `seeder/src/net/peer-session.ts`. The synchronous upload gate now says each core's terms
    before the core's first block, and it fails closed.
  - `seeder/src/seeder.ts`. `announceTerms`, `announceOwed`, and the price-history interplay
    (F9).
  - `seeder/src/payment/pay-bridge.ts`. `outstanding` in every ACK, and `onOpen` runs only after
    a successful bind.
- **MEDIUM:**
  - contracts (`pay-protocol.ts`, `version.ts`);
  - the removed option (`seeder/src/config.ts`, `cli/daemon.ts`, `gateway.ts`, the worker's
    `host.ts`, `dev/fixtures-net.ts`);
  - the dev loopback `pay/1` (`dev/loopback-pay.ts`);
  - the engine types (`providers.ts`, `GatewayDeps`);
  - `mocks/mock-payment-engine.ts`.
- **LOW:** `upstream/settle.ts` and `cli/dev-mocks.ts` (compile-only `sendOwed` pass-throughs),
  the test fakes, and the ADR text.

## Removed or changed code (history)

- **`announceCorePrices`** (added in `8b703db`, ADR 0012; turned on everywhere in `dde4f2d`, fix
  round 4) is removed.
  - The behaviour it switched is now unconditional in `Seeder`. It was already on in every
    production composition, so nothing a user runs changes, except that free cores now get a
    `PRICE` too.
  - The type change turns any leftover caller into a compile error.
  - JavaScript callers that pass the key have it ignored. The safe direction: it can no longer
    switch the rule off.
- **`onFirstUpload`** (`8b703db`) became `beforeBlock`, which is called before every block and
  deduplicated by the seeder.
  - The old hook was "contained": a throw was logged and the block still went out.
  - The new one fails closed (L1 below).
- **ACK flag mask `~3` → `~7`** (`39cdaeb`). Bit 2 now means "`outstanding` follows". Unknown
  bits are still refused (M6).
- **PRICE layout** (`39cdaeb`). The wip commit made the trailing flags byte mandatory, which
  changed every PRICE on the wire. It is optional again, written only with `free` (M1 below).

## Findings

### MEDIUM

**M1 — the wip commit changed the wire format of every PRICE (fixed).**
`codec.ts:318` (was `out.push(w(c.uint8, free === undefined ? 0 : …))`).
- **Scenario:** every priced PRICE grew a byte. A peer on an older build rejects every one of
  them as trailing garbage, and a new peer rejects an older seeder's PRICE as truncated. Either
  way pay/1 closes as a protocol error. The contract calls this change additive.
- **Fix:** the flags byte is written only when `free` is present. It must be 1 or 3; 0, 2,
  unknown bits and trailing bytes are refused, so each message still has one encoding. A priced
  PRICE is byte-for-byte the v5 frame.
- **Tests:** `codec.fuzz.test.ts` "PRICE.free…", which compares against hand-built v5 bytes.
- **Mutations:** M5, M8.

**M2 — no signal that the OWED report is complete (made exact in the contract; tested).**
`contracts/pay-protocol.ts` rule 2.
- **Scenario:** there is no end-of-report marker, so a viewer cannot tell "nothing owed" from
  "the OWED is still on its way". A returning viewer that asks for its full window at `open`
  could then overrun a seeder that still counts old blocks, and be banned: the very failure the
  amendment exists to remove.
- **Analysis:** the seeder handles the opening HELLO synchronously. `verifyHello` is synchronous;
  the bind and `announceOwed` run inside the `open` listener. It does this before any later frame
  on the same Protomux stream. When its own HELLO goes out last, `open` fires inside `sendHello`,
  and the report follows directly.
- **Fix:** the contract now states the order rule, normative for seeders. A viewer that asks
  nothing before its channel is `open` receives the whole report before the first block it asks
  for, so silence after that block means nothing is owed.
- **Tests:** `owed.integration.test.ts` "the whole OWED report arrives before the first block…",
  for both HELLO orders, with the request made in the same tick as the viewer's `open`.
- **Mutation:** M19 (the report deferred 150 ms) is caught.
- **Residual:** a viewer that asks before `open` is counted provisionally, and the bind can cut
  it. That is documented, and it is the viewer lane's rule to keep.

**M3 — a failing terms hook sent the block anyway (fixed).** `peer-session.ts:208–263`.
- **Scenario:** in the wip, `announce()` logged a throw from `beforeBlock` and let the block go.
  A local fault, such as a PRICE that fails to encode, would then serve a block with no PRICE
  before it, which breaks rule 1 silently. The core is marked "told", so every later block of it
  goes unannounced too.
- **Fix:**
  - a throwing hook cuts the session (`local`, no ban) in the same tick, and nothing is
    recorded;
  - the destroy inside the `upload` handler keeps the block off the wire (spike S-A);
  - `Seeder.announceTerms` marks a core as told only after `sendPrice` returned.
- **Tests:** `owed-terms.test.ts` "fail closed" (a free and a counted block; no ban; nothing
  recorded; a seeder-level PRICE that throws).
- **Mutation:** M25.

**R1 — the current viewer code reads `PRICE { free: true }` as "sold" (open: lane P2).**
`gateway/src/upstream/seeder-credit.ts:196–203` (not in this lane's paths).
- **Scenario:** a desktop image read from a seeder that now correctly says `free` is stopped as
  "a seeder sells it".
- **Failing on this branch alone:**
  - `images-over-pear.integration.test.ts`: 3 tests;
  - `images-paid-core.integration.test.ts`: 3 tests.
- **Verified:** a one-line guard in that listener (`if (p.free === true) return;`) makes all 10
  of those tests pass. It was applied, run and reverted; nothing of it is committed.
- **Owner:** P2's task ("viewers fetch image blocks only from seeders that said free") rewrites
  exactly this listener. The branch must not reach `main` without it.

### LOW

**L1 — the engine type is only a compile-time requirement (fixed).**
- **Scenario:** a JS caller, or a cast, passes an engine without `outstandingOn` / `unpaid`.
  Every PAY then throws inside the bridge (session cut `protocol-error`), and every `open` fails
  its report with only a log line.
- **Fix:** `Seeder.create` throws a `TypeError` naming `UnpaidLedger`.
- **Mutation:** M26.

**L2 — `boundOwed` turned junk limits into an empty report (fixed).** `payment/owed.ts:44`.
- **Scenario:** a caller passes `{ maxRanges: 0 }` or `NaN` and gets `[]`. A short report is the
  unsafe direction: the viewer believes it owes less and overruns the window.
- **Fix:** a limit that is not a positive safe integer now means the cap. The caps already keep
  every report inside the codec's grammar. The wip test that asserted "junk limits report
  nothing" was rewritten with its reason.
- **Mutation:** M27.

**L3 — `satsPerBlock: 0` without `free` is confusable with free (documented).**
`PriceMessage.free` doc.
- **Scenario:** the gateway config, the daemon config and the manifest all accept a price of 0.
  Such a seeder still counts blocks, and the window is cleared only by empty-set PAYs. A viewer
  that reads "0 sats" as free stops paying and is cut.
- **Fix:** the contract now says that only `free: true` means free. Nothing on the wire changes;
  the semantics were already this way before the amendment.

**L4 — the dev loopback `pay/1` fired `open` on the remote HELLO alone (fixed).**
`dev/loopback-pay.ts`.
- **Scenario:** with `--dev-mocks`, a seeder's `open`, and so its OWED, could go out before its
  own HELLO had been sent. The viewer would receive an OWED before it knew the seeder.
- **Fix:** `open` fires once, after both HELLOs, as on the real channel. An OWED is sent only on
  an open end; one that arrives early closes the end as `protocol-error`.
- **Tests:** the existing loopback test asserted the old order. It was corrected, with a comment
  that cites the channel's rule, and a new test covers the order rules.
- **Mutations:** M23, M24.

**L5 — `sendOwed` on a channel that is not open would cost the connection (fixed).**
- **Scenario:** the remote closes pay/1 on an early OWED.
- **Fix:** `PayChannel.sendOwed` throws before both HELLOs are done, since it would be a local
  bug, and drops the message on a closed channel.
- **Mutation:** M10.

**L6 — `RealPaymentEngine.unpaid` walked every core before bounding (fixed).**
- **Fix:** cores are yielded lazily; `boundOwed` stops at the caps.
- **What is left:** cores with nothing unpaid still pass through the walk. The cost is bounded
  by the spans of blocks that viewer downloaded, and it runs once per connection.

**R4 — owed blocks are verified at the current terms, not the terms at delivery (open,
documented).**
- **Scenario:** a price change between two connections of one seeder process moves the owed
  blocks to the new price. The viewer pays only at the terms it recorded (ADR 0018 amendment), so
  it leaves them unpaid, and they stay counted until the seeder restarts.
- **Why not fixed here:** fixing it needs a per-account, per-range price record in the engine or
  the seeder. That is a design choice for Cameron (see the lane record's question). Prices here
  change rarely: a manifest edit, or a gateway config change, which takes a restart that also
  forgets the debts.

## Adversarial analysis

**A malicious viewer** (holds any Nostr key, connects to a seeder):
- **Another viewer's history?** No. OWED names only the pubkey whose HELLO signature was verified
  on this connection. `ACK.outstanding` before the HELLO covers only this connection's
  provisional account.
- **Content for free?** No. `free` is a local set (`setFreeCore`), and it refuses a core with a
  policy. PAYs for owed ranges go through the unchanged `verify`: exact amounts,
  `range-not-uploaded` for any block not sent, `range-already-paid` on replay, and the epoch
  refusal for a PAY from a replaced channel.
- **CPU at connect?**
  - The report is at most 256 ranges / 1024 blocks.
  - It is computed lazily per core. `difference` is linear in the spans of blocks that viewer
    downloaded.
  - It runs once per connection, and connections are rate-limited.
- **Force the report early?** It is sent only from the bridge's `open` handler, after a
  successful `bindPubkey` (M16), and once per connection (M17).

**A malicious seeder** (the viewer is the victim):
- **Inflated OWED or `outstanding`:** the viewer asks less, which hurts only the seeder's own
  sales. The contract says both are claims, and that a viewer pays only for blocks its own record
  says it received.
- **Bounded input:** a single OWED is bounded by the codec, and decode never throws (fuzz,
  2000 runs over OWED-tagged frames). Many OWED frames are possible. An honest seeder sends one
  per core per connection, and the contract lets the viewer ignore later ones.
- **A false `free`:** the seeder counts anyway and bans the viewer. A seeder can ban anyone from
  itself at will, so there is no new harm beyond that seeder.

**A network attacker:** nothing new. Frames travel inside the Noise stream, and the HELLO is
bound to the handshake.

**Logs:** one new line, `OWED sent { cores, blocks }` (counts only), and one error, `before-block
hook threw — not sending the block` (the error object from our own code). No keys, pubkeys,
proofs or ranges are logged. The locked paths log nothing (`check:locked` OK).

## Sharp edges (API surface)

- **`PriceMessage.free?`:** only `true` means free (L3). `free: false` is legal but never sent.
  Encoding keeps absent and `false` distinct, and each has one encoding.
- **`OwedMessage`:** the grammar is exported as bounds (`MAX_OWED_RANGES`, `MAX_OWED_BLOCKS`) and
  enforced in both directions. A swapped `[to, from]`, overlapping, adjacent or unsorted ranges,
  and a sum past the cap are all refused.
- **`AckMessage.outstanding?`:** absent means "the seeder did not say" (an older seeder). The
  bridge omits any value that is not a safe count, rather than letting encode throw (M22).
- **`PayProtocol.sendOwed`:** throws before `open` (L5). It is required on the interface, so
  every implementer states what it does. Each dev mock and test fake does, one line each.
- **`UnpaidLedger`:** required on `SeederDeps.engine`, `GatewayDeps.seederEngine` and
  `WorkerProviders.seederEngine`, and checked at `Seeder.create` (L1). Limits cannot raise the
  caps, and junk limits fall back to them (L2).
- **Always-on PRICE:** no switch is left. A core with no terms at all gets no PRICE, and its
  blocks are counted (see the lane record's residual). No production composition serves one,
  except for a sub-second window in the desktop's upload, between `studio.publish` and
  `setCorePolicy`.

## Mutation checks

Each one broke the guard, ran the named tests (at least one failed), and was restored with
`git checkout`. The tree was clean after every batch. The script is in the lane's scratch
directory.

| # | Broken guard | Caught by |
|---|--------------|-----------|
| M1 | codec: OWED range count cap +1 on decode | codec.fuzz |
| M2 | codec: adjacent OWED ranges accepted | codec.fuzz |
| M3 | codec: OWED block cap per range, not in total | codec.fuzz |
| M4 | codec: a free PRICE with a price decoded | codec.fuzz (2) |
| M5 | codec: PRICE flags 0 / 2 accepted | codec.fuzz |
| M6 | codec: unknown ACK flag bits accepted | codec.fuzz |
| M7 | codec: encode skips the OWED grammar | codec.fuzz |
| M8 | codec: PRICE flags byte always written (not additive) | codec.fuzz (4) |
| M9 | channel: OWED before both HELLOs delivered | channel |
| M10 | channel: `sendOwed` before both HELLOs sent | channel |
| M11 | engine: `outstandingOn` ignores paid | owed |
| M12 | range-set: `difference` off by one at a hole | owed (2, incl. the model property) |
| M13 | owed: report block cap not applied | owed (2) |
| M14 / M14b | session: free block without its PRICE (wip and final forms) | owed-terms, owed.integration |
| M15 / M15b | session: block recorded before its PRICE (wip and final forms) | owed-terms, seeder |
| M16 | bridge: `onOpen` after a refused bind | owed-terms (bridge alone) |
| M17 | seeder: report more than once per connection | owed-terms |
| M18 | seeder: OWED without the core's priced PRICE first | owed-terms, owed.integration (5) |
| M19 | seeder: report deferred past the HELLO | owed.integration (3, incl. the order tests) |
| M20 | seeder: same terms said twice | owed-terms, owed.integration (4) |
| M21 | seeder: report caps shrunk to 1 | owed-terms (2) |
| M22 | bridge: a non-count `outstanding` put in the ACK | owed-terms |
| M23 | loopback: OWED before open delivered | dev |
| M24 | loopback: `open` on the remote HELLO alone | dev |
| M25 | session: a throwing terms hook does not cut | owed-terms (2) |
| M26 | seeder: engine without the ledger accepted | owed-terms |
| M27 | owed: junk limit gives an empty report | owed |
| M28 | desktop `PeerNode`: pay/1 attached late (blocks first) | desktop terms-before-blocks (2) |
| M29 | gateway: seeder side attached late | gateway terms-before-blocks (2) |
| M30 | daemon runtime: pay/1 attached late | seeder-runtime (5) |

## Tests

- **Codec:** OWED, PRICE `free` and ACK `outstanding` round-trip, including the inclusive caps.
  Refusals in both directions (hand-built frames). A fuzz run over OWED-tagged frames checks that
  every decoded OWED is canonical. Priced PRICE bytes equal the v5 layout.
- **Channel:** OWED is delivered when open, and is a protocol error before both HELLOs (idle and
  half-open). `sendOwed` throws before `open` and drops when closed.
- **Engine:**
  - `RangeSet.difference` against a `Set<number>` model;
  - `boundOwed` at its caps and with junk limits;
  - the real engine's ledger against the mock's (property test, with a rebind);
  - an owed range paid on a new connection at carry 0 and cleared; a stale carry is refused;
  - a PAY past what was sent is refused.
- **Seeder (fakes):**
  - rule 1: free, sold, and back again; dedupe; no terms; no pay/1;
  - rules 2–3: order, carry 0, a price change after the report, banned, pre-HELLO blocks, no
    terms, the caps;
  - rule 4;
  - the bridge alone;
  - fail closed.
- **Real streams:**
  - seeder: PRICE before the first block for both kinds; OWED → PAY → cleared, and playback
    continues; the order rule for both HELLO orders;
  - the daemon runtime over hyperswarm;
  - the gateway's seeder (PRICE for both kinds, `outstanding`, OWED and clearing);
  - the desktop `PeerNode` with the production pay/1 shape;
  - the dev fixtures over the loopback hub.
- **Real mints** (`NUTFLIX_REAL_MINT_URL`), measured on the final code:
  - the owed range is paid in real ecash and redeemed at the mint: swapped 4, nutzapped 4, no
    dust, at Nutshell 0.21.0 (`:3399`, `:3398`) and cdk-mintd 0.18.1 (`:3397`);
  - the gateway's real-mint swarm lane (three seeders, a double-spend, a network drop, all now
    sending PRICE always and OWED on reconnect) is green at `:3399` and `:3397`;
  - core's real-mint integration is green at `:3399`.
