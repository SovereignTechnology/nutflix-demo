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

**Independent review, 2026-09-27** (last section): one HIGH (the terms went out only in reply to
a block request, so ADR 0015's viewer got silence) and one LOW (a failed OWED report failed open),
both fixed in `6abd292` with ten more mutation checks (M31–M40); three INFO items (one wording fix,
two notes). It also turned up R10, a pre-existing gap outside this lane: a stored core the
`Seeder` has not opened is served with no upload gate.

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

## Independent review (2026-09-27)

An independent reviewer examined `54f49bb..dcc49dc` and reported one HIGH, one LOW and three
INFO findings. Each was verified before anything changed. The fixes are in `6abd292`; this
section and the lane record were updated after it. Method, as above: `differential-review` and
`sharp-edges` on the new diff (`dcc49dc..6abd292`), plus mutation checks M31–M40.

| # | Severity | Finding | Outcome |
|---|----------|---------|---------|
| IR1 | HIGH | PRICE `{ free: true }` only in reply to a block request | fixed |
| IR2 | LOW | a failed OWED report is logged and the session carries on | fixed |
| IR3 | INFO | merge gate: this branch alone breaks desktop image reads | not a defect of P1; gate updated |
| IR4 | INFO | rule 3 reads "carryIn 0", but the engine chains the carry | fixed (wording) |
| IR5 | INFO | `gateway/src/upstream/settle.ts` edited (viewer code) | no change; noted for P2 |

### IR1 — the terms went out only in reply to a block request (HIGH, fixed)

`seeder/src/seeder.ts:179` (at `dcc49dc`).

- **Scenario (reproduced).** ADR 0015's amendment: a viewer's image read asks a peer for blocks
  only after that peer's `PRICE { free: true }`; no probe. At `dcc49dc` the only paths that sent a
  PRICE were `beforeBlock` (inside Hypercore's `upload` event), the OWED report (priced only) and
  price changes. A viewer that opened a free core and asked for nothing received no PRICE, so
  every image showed the placeholder. Getting round that meant asking for a block first, which on
  a sold core counts one unpaid block per seeder: the failure the amendment removed.
- **Reproduced by** `owed.integration.test.ts` "a viewer that opens a core and asks for NOTHING
  receives its terms…" (real streams, pay/1 open on both ends, the viewer opens a free and a sold
  core and asks for nothing). With the source files of `6abd292` reverted to `dcc49dc` it fails
  (no PRICE within 3 s), and so do the six other new tests (7 of 22 in the two files).
- **Fix.** A core's terms go out unprompted as soon as the peer has the core open on a session
  with pay/1 attached. `beforeBlock` stays the fail-closed backstop.
  - `SessionRegistry.attachUploadGate` also listens to Hypercore's `peer-add` (both ends of the
    core's replication channel open) and calls the new `onPeerAdd` hook with the session on the
    SAME stream (`sessionOf`: looked up, never admitted; a second connection from the same Noise
    key is another session). The hook runs inside Hypercore's channel-open handler, so the
    registry catches and logs whatever it throws: an exception there would reach Protomux.
  - `Seeder.attachPayProtocol` tells the terms of every core already paired on that stream (the
    peer opened it before pay/1 was attached, so its `peer-add` found nothing to say them on).
  - `Seeder.onCoreOpened` tells them to every session a newly gated core is already paired on
    (Corestore can pair a core, for example on a remote's discovery-key request, before the
    `Seeder` opens its own session of it; that `peer-add` came before the gate).
  - `setFreeCore` (on a change) and `setCorePolicy` (unless `announce: false`) tell every session
    the core is paired on now. A core that turns sold is announced at once, so an image read
    stops asking before its next request is counted.
  - Those three passes go through `tellTerms`, which never throws (a failure is logged, and the
    core's next block to that peer says the terms first or is not sent).
- **Contract.** Rule 1 now says it: the terms as soon as the peer has the core open, unprompted,
  and in any case before its first block (`contracts/pay-protocol.ts`, `version.ts`, ADR 0015's
  as-built note).
- **Tests.**
  - `owed-terms.test.ts` "rule 1, unprompted" (4 tests): peer-add for a free, a sold and an
    untermed core; said once; a second stream of the same Noise key; an unadmitted stream is not
    admitted; a peer-add whose PRICE throws is contained and cuts nothing, and the next block
    fails closed; the attach pass for the cores paired on this stream only; free ⇄ sold
    re-announced at once to paired peers only, unchanged terms not repeated, and `announce:
    false` left to the next block.
  - `owed.integration.test.ts` (real streams): nothing asked, both kinds; a core paired before
    pay/1 was attached and a core paired before the `Seeder` opened it.
  - Nothing-asked cases on every other composition: the gateway's seeder
    (`gateway/.../terms-before-blocks`), the desktop `PeerNode` over a hyperdht testnet and the
    dev fixtures over the loopback hub (`app-desktop/.../terms-before-blocks`).
- **A test changed with the behaviour.** `seeder-runtime.integration.test.ts` (the daemon over
  hyperswarm) added its PRICE listener after `connect`, which only worked while PRICEs waited for
  a request: the video's PRICE now arrives during `connect`. The listener is now hooked when the
  channel is created, with a comment citing why. Its assertions are unchanged (PRICE before the
  first download of each core, once each, both kinds).

### IR2 — a failed OWED report failed open (LOW, fixed)

`seeder/src/payment/pay-bridge.ts:57` (at `dcc49dc`).

- **Scenario.** `announceOwed` marks the session reported, then sends each core's PRICE and OWED.
  If one throws on core k (a local fault, such as a policy the codec refuses), cores k..n are
  never reported and the bridge only logged `open hook failed`. Under the order rule the viewer
  reads "a block arrived and no OWED" as nothing owed, asks its full window, and is cut for
  `window-exceeded`: a persisted ban. The bridge test pinned it (`cutReason` null after a
  throwing `onOpen`).
- **Fix.** A throwing `onOpen` cuts the session (`local`, no ban) in the same tick, like a
  throwing `beforeBlock`. Nothing is forgiven: the next connection reports every core again.
- **Tests.** The bridge test now asserts the cut (`local`, the stream destroyed in the same tick,
  no ban on either key), with a comment citing this finding; the junk-`outstanding` half of that
  test is unchanged. A new seeder-level test: `sendOwed` throws on the second core, the session is
  cut `local`, nobody is banned, and the next connection reports both cores.

### IR3 — merge gate (INFO; not a P1 defect; gate restated)

- **Re-run on `6abd292` alone:** `images-over-pear.integration` 3 failing and
  `images-paid-core.integration` 4 failing, 7 in all (was 6).
- **With the one-line R1 guard** in `seeder-credit.ts`'s `price` listener (`if (p.free === true)
  return;`), applied, built, run and reverted (nothing of it committed): 9 of the 10 pass. The
  one left is `images-paid-core` "the reviewer's probe…", and only its non-vacuity check
  `expect(sent).toBeGreaterThan(0)` ("the probe did reach a seeder"). That line encodes the
  interim one-block probe. With IR1 fixed, the fixture seeders say the video core is sold before
  anything is asked, so the read is refused with `sent` 0: the amendment's intended outcome ("no
  probe, nothing counted"). Everything else in that test holds (refused, nobody banned, nothing
  paid, the viewer's count ≥ what was sent). The test is the viewer's (P2's paths); its
  replacement check would be "a seeder's priced PRICE was received and `sent` is 0".
- **So:** P1 still merges only together with P2. P2's "ask only after `{ free: true }`" now gets
  that PRICE from every seeder this repository builds, with nothing asked (the nothing-asked
  tests above).

### IR4 — rule 3's carry wording (INFO, fixed)

`RealPaymentEngine.verify` requires `carryIn === cs.carry`; the bind resets the carry to 0 for
the new channel, and every accepted PAY of the core moves it. Rule 3 said "`carryIn` 0 for that
core", which reads as "every owed PAY carries 0". Reworded in the contract and in ADR 0018's
as-built note: an owed range is paid inside this connection's carry chain for the core, so it
carries 0 only when it is the core's first PAY on this connection, else the last accepted PAY's
`carryOut`; any other `carryIn` is refused as `malformed`. No code change; the existing engine
test (`owed.test.ts`, "a stale carry is refused") already covers the seeder side.

### IR5 — `settle.ts` (INFO, no change)

The one-line `sendOwed` pass-through the interface forces. No behaviour. P2 owns the file.

### Differential review of `dcc49dc..6abd292`

- **Blast radius.** `attachUploadGate` runs once per gated core; the new `peer-add` listener runs
  once per (core, connection) pairing, not per block. `pairedSessions` walks `core.peers` (one
  entry per connection the core is paired on) and runs only at pay/1 attach (once per
  connection, over the open cores), at a core's open, and on `setFreeCore` / `setCorePolicy`.
- **New untrusted input:** none. `peer-add` carries Hypercore's own `Peer`; what a remote controls
  is only whether and when it opens a core, which it could already do.
- **Cost a remote can cause.** One PRICE per core it opens per connection (deduplicated per
  session). A remote opening many cores gets many PRICEs; connections are rate-limited and cores
  are the seeder's own. The same PRICEs used to follow its first request of each core.
- **Identity.** `sessionOf` never admits (M34), so a stream that bypassed admission gets nothing
  said on it (it has no pay/1 anyway), and a core paired on an older connection of the same Noise
  key is never attributed to the newer session (M33).
- **Hypercore's handler.** The listener is the only new code that runs inside Hypercore's
  replication state machine (`onopen`, under a Protomux cork). It cannot throw into it (M32): a
  throwing listener there would destroy the connection. The cork also means a PRICE written from
  `peer-add` leaves in the same batch as the seeder's sync for that core.
- **Logs.** Two new lines, `peer-add hook threw` and `terms not said unprompted — the next block
  says them first`, each with only the error object from our own code; no keys, pubkeys or
  ranges. `check:locked` OK (no locked file changed in `6abd292`).

### Sharp edges of the new surface

- `SessionRegistryOptions.onPeerAdd` is optional and contained: forgetting it changes nothing
  that is enforced (the backstop still runs); throwing from it cannot break replication.
- `SessionRegistry.sessionOf` / `pairedSessions` are public and read-only; neither admits.
- `setCorePolicy(…, { announce: false })` now also skips the unprompted re-announcement. It stays
  a composition's own choice of when to say a price change; the next block still says the terms
  first (tested). No production caller passes it.

### New residuals

- **R8 — a request in flight when a core turns sold.** The eager re-announcement cannot overtake
  a request already on the wire: that block goes out after the priced PRICE (the backstop), and is
  counted. At most the requests in flight at that moment.
- **R9 — mark then open, not open then mark.** The desktop worker opens a profile core and marks
  it free after the open resolves (`worker/host.ts` `ownProfile`, the image read). A peer paired
  in between would be told the core's default price first and `free` after. The worker's seeder
  has no default price, so such a peer is told nothing and then `free`; the daemon and the gateway
  serve no free cores in production. Worth closing in the worker (for example, set the mark by key
  before the open) when P2 reworks that path.
- **R10 — pre-existing, found while fixing, not introduced by this lane.** A core in the seeder's
  storage that the `Seeder` has not opened in this process is served by Corestore's
  discovery-key path with no upload gate: nothing counted, no window, no PRICE. Probe (temporary,
  deleted): a `Seeder` restarted on the same data directory, its `blobs` core not reopened, served
  all 6 blocks of a video to a viewer under a 2-block window: 0 counted, no cut, no PRICE. The
  daemon opens its configured cores at start and the gateway its `blobs` core, so the exposure is
  any other core in storage until something opens it (replicas opened by key, other names, the
  desktop worker's cores after a restart). `BlobStore` and its Corestore wiring are unchanged
  here (`git diff 54f49bb` touches neither). It needs its own lane: for example, refuse the
  discovery-key attach for cores the `BlobStore` has not opened, or open and gate on it.
- **R5 extended — free, then no terms.** A core that stops being free while it has no price at all
  gets no PRICE, so a peer told `free` is not told otherwise, and later blocks are counted without
  terms. The worker unmarks a core only after closing it.

### Mutation checks M31–M40

Script: the lane's scratch directory (`mutate-review.py`). Each mutation was applied to the
committed `6abd292`, the named tests were run, and the file was restored with `git checkout`. The
tree was clean afterwards.

| # | Broken guard | Caught by |
|---|--------------|-----------|
| M31 | registry: no `peer-add` listener (terms only in reply to a request) | owed-terms (3), owed.integration (1) |
| M32 | registry: a throwing `peer-add` hook reaches Hypercore | owed-terms |
| M33 | registry: `sessionOf` by Noise key alone (no stream identity) | owed-terms |
| M34 | registry: `sessionOf` admits an unknown stream | owed-terms |
| M35 | seeder: no pass at pay/1 attach | owed-terms, owed.integration |
| M36 | seeder: no pass when the `Seeder` opens an already-paired core | owed.integration |
| M37 | seeder: `setFreeCore` does not re-announce | owed-terms |
| M38 | seeder: `setCorePolicy` does not re-announce | owed-terms |
| M39 | seeder: unprompted terms ignore `free` (always priced) | owed-terms, owed.integration |
| M40 | bridge: a failed OWED report does not cut (fails open) | owed-terms (2) |

### Gates re-run on `6abd292`

- `tsc -b --force`, `npm run build`, eslint, prettier, `check:locked`, `lint:electron`: clean.
- Touched packages (seeder, gateway, core pay-protocol and payment): 582 passed, 0 failed.
- Whole suite: 10 failing tests. 3 are the known R6 base failures, 7 are the R1 merge gate (IR3),
  and one timing failure (`keyfile`) is green alone. Two packaging files failed as whole files on
  a stale renderer bundle (after the forced `tsc -b`), and pass after `npm run build` (the stage
  file down to its known R6 case).
- Real mints: `owed.integration` and the gateway's real-mint swarm lane are green at Nutshell
  (`:3399`, `:3398`) and cdk-mintd (`:3397`).
