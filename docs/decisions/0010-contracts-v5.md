# 10. Contracts v5: per-block uploads, the per-PAY split, connection-bound HELLO, local double-spend

Date: 2026-09-23

## Status

Accepted (Stage 2 security session, PART 0). Amends ADR 0007 (a) in one respect: the minimum PAY
is a batching target, not a seeder-side rejection (§3.3). Everything else in ADR 0007 (a) stands.

## Context

Stage 1 closed with nine open contract-change requests (`docs/status.md` → "Open contract-change
requests", full text in `docs/contract-requests/*.md`), two money-path bugs in
`MockPaymentEngine` found by L6-C, and ADR 0007's per-PAY split waiting for its contract text.
The Stage 2 prompt makes the v5 bump the first deliverable: accept, amend or defer each item in
writing, fix the mock, re-run L10's adversary suite and say which expectations changed and why.

v5 is **breaking for the money path** — `BlockRange.core` becomes required and `recordUpload`
changes shape — and additive elsewhere. Every consumer (`@sovit/seeder`, `@sovit/gateway`, the
desktop worker, the Studio and Watch screens) was adapted in the same change, so `main` never
carries a red tip.

## 1. The v5 list, item by item

| # | Request | Decision |
|---|---|---|
| 1 | `BlockRange.core` and `recordUpload`'s `core` required (ADR 0004) | **Accepted**, and `recordUpload` also carries the block index (item 7). §2 |
| 2 | `PRICE` carries a core (L3) | **Accepted**: `PriceMessage.core`. The seeder sends one PRICE per core on the default policy; `UpstreamPayer` applies a PRICE to its core only |
| 3 | Per-PAY split as contract text (ADR 0007) | **Accepted with one amendment** (§3.3): carry normative, minimum PAY a batching target |
| 4 | BUD-09 reports reach `BlossomAuth` as a synthetic header under verb `report` | **Accepted in PART A step 5** (`gateway/src/auth/` is not a core contract): no second method; `report` verifies the NIP-56 event itself. §8 |
| 5 | L5 screen requests (signer surface, `autoTopUp` clearing, `unreact`, `seederAnnouncement`, `searchChannels`, upload abort, `chooseThumbnail`, thumbnail hashes, progress error code, `studio.ffmpeg()`, `firstPaidAt`, `pendingMintQuotes`, resume lookup, `nostr:` resolution, throughput, session-closed flag) | **Signer surface accepted core-side** (`SignerConnectRequest`, `SignerControl`; the `NetworkAdapter`/IPC bridge is Stage 3 because the L6-0 wire table is exhaustive and frozen). **`autoTopUp` semantics made normative** (`belowSats <= 0` = disabled; compared with the balance at the paying mint, funded from `fromMint`). `unreact` was v4. **Everything else deferred to Stage 3** — none is money-path, each has a working screen-side workaround, and each needs adapter + IPC work that belongs with integration |
| 6 | L6-B: `NostrKind.Deletion`, `seedersOnline` "unknown", `SignerStatus` "none", which balance `autoTopUp` compares, `satsByRendition` source, `studio.cancel` | **`Deletion = 5` accepted. `seedersOnline?` accepted** (absent = unknown; screens gate only on a known 0; Watch hides the count, Studio shows "Unknown"). **`autoTopUp` answered** (item 5). **`SignerStatus` "none" deferred** — `pubkey: null` already means "no signer" and a new kind widens every Settings switch; it lands with the Stage 3 signer bridge. `satsByRendition`, `studio.cancel`, the L1 items: **deferred** |
| 7 | L6-C: mock bugs; `recordUpload` block index; `core` in ACK/PRICE; `windowBlocks` in HELLO; worker `shutdown`; seeder swarm hooks; runtime disk cap; boot module | **Mock fixed** (§4). **Index accepted** (§2). **`AckMessage.core`, `PriceMessage.core`, `HelloMessage.windowBlocks` accepted.** `shutdown` (L6-0 IPC), swarm hooks and disk cap (L2), boot module (packaging): **deferred to Stage 3** — not contracts |
| 8 | `UploadInput.file` doc (desktop passes a main-minted file token, SE-1) | **Accepted** (doc) |
| 9 | `Route` changes | **Deferred** — orchestrator-owned `screens/shared/route.ts`, not a contract; Stage 3 UI |

`DevEngine` (`packages/app-desktop/src/worker/dev/dev-engine.ts`), the Stage 1 wrapper that
worked around both mock bugs, is deleted: the dev worker uses the plain v5 mock.

## 2. Uploads are recorded per block (items 1 and 7)

`recordUpload(peer, blocks: BlockRange, policy: Pick<PricePolicy, 'satsPerBlock' | 'minPaySats'>)`.
The seeder's `upload` handler already knows the index; the engine now keeps, per (peer, core),
the SET of block indexes sent and the set paid.

- **`range-not-uploaded` = not every block of this PAY was sent to this peer.** A viewer that
  seeks, or fetches one core from two seeders (the §5(a) rig), pays each seeder for exactly the
  blocks it sent. The v4 count rule (`toBlock >= uploaded count`) made both impossible.
- **`PeerWindow.uploaded` counts DISTINCT blocks.** A re-sent block is one block of the window
  and can be paid once. So `rebind` merges are unions, not sums, when two sessions sent the
  same block (tests that meant "n + m" now send distinct blocks).
- **`policy` sets the effective window** (§3.2). A core served without a price passes
  `{ satsPerBlock: 0 }` and gets the configured window.
- **`core` is required everywhere** — a PAY without a well-formed 64-hex `core` is `malformed`
  whatever the stream carries. The v3 "core-less PAY on a multi-core stream" branch in the
  seeder's pay bridge (and `Seeder.replicatedCores()`, which only fed it) is gone.

## 3. The per-PAY split (item 3; ADR 0007 a)

### 3.1 The carry — normative, exactly as ADR 0007 wrote it

`units = amount × c + carryIn; creatorSats = floor(units / 100); carryOut = units mod 100;
seederSats = amount − creatorSats`, implemented once in `packages/core/src/payment/split.ts`
(`splitPay`) and used by both the payer and the verifier. ADR 0007's open points, specified:

- **Scope = one `pay/1` channel × one core**, keyed in the engine by (account id, core).
- **`carryIn` is on the wire** (`PayMessage.carryIn`, integer 0–99); a PAY whose `carryIn`
  differs from the seeder's carry for (peer, core) is **`malformed`**.
- **The carry advances only on an ACCEPTED PAY.** PAYs from one peer are verified in arrival
  order, because the carry chains them.
- **`rebind(from, to)` = a new channel for `to`**: `to`'s carries are replaced by `from`'s (0
  where `from` never paid) — also when `from` is unknown, since a session that sent HELLO before
  any upload has no provisional entry. ADR 0007 offered "sum mod 100" or "keep `to`'s carry";
  neither matches what the payer holds: the payer's carry is per connection and starts at 0 on
  a new one, so the seeder's must too. Consequence: **a pubkey with two live channels to one
  seeder is not supported** (the second bind resets the first's carries, and its next PAY is
  `malformed`). hyperswarm dedups connections per Noise key, so this needs two app instances
  with one identity.
- **No end-of-stream flush** (the creator loses < 1 sat per stream).
- A share that is 0 sats by the formula is an **empty set** (`proofs: []`, still addressed to
  its recipient) and is accepted; an empty set whose share is > 0 is `missing-*-set`.
- With `carryIn = 0` the rule IS ADR 0005's (`seederSats = ceil(amount × s / 100)`). The v4
  mock floored the SEEDER share — the opposite of ADR 0005 — which is now fixed.

**Viewer side (§viewer).** `pay(range, seeder, policy, opts?: { carryIn })` uses the engine's
running carry for (seeder pubkey, core) unless `carryIn` is given; the running carry advances
on every PAY it produces, which is right whenever every PAY is accepted in order. A transport
that sees a rejected ACK, or opens a new connection to the same seeder, passes the carry it
reconstructed: the seeder's carry is the `carryOut` of the last PAY it accepted on that
channel × core. The carry only moves sats between seeder and creator — the viewer pays
`amount` either way — so a payer-side mistake costs liveness (rejections), never money.

### 3.2 The effective window — normative

`effectiveWindowBlocks(windowBlocks, policy) = max(windowBlocks, ceil(minPaySats /
satsPerBlock))`, so a viewer CAN batch to the minimum. Per peer the engine uses the maximum over
the cores it has recorded for that peer; `PeerWindow.windowBlocks` reports it. `HELLO` carries
the seeder's configured `windowBlocks`; the payer computes the same effective window from the
manifest policy.

### 3.3 The minimum PAY — AMENDED: a batching target, not a rejection

ADR 0007 said "a PAY's amount must be ≥ `minPaySats`, except the final PAY that settles the last
blocks of a core". Making the seeder REFUSE smaller PAYs deadlocks honest viewers:

- The desktop worker's `CreditPool` is **one budget for all seeders** — it must be, because
  Hypercore picks which peer serves a request, so the only way to keep EVERY seeder under its
  window is to keep the sum under one window.
- With two seeders the budget splits between them (say 3 + 2 of a 5-block effective window at
  2 sat/block). Neither seeder is owed a minimum PAY, the budget is exhausted, and nothing can
  be downloaded until something is paid.
- Every "except the final PAY" rule the seeder can check fails somewhere: "the first PAY on a
  channel × core or one after a full PAY" is race-free but runs out after one tail per seeder;
  "a PAY that settles everything owed on the core" races blocks still in flight (the seeder
  counts them, the payer has not received them) and rejects honest payers; an average-size
  rule has the same budget-splitting failure.

The seeder cannot tell a viewer that could not reach the minimum from one that chose not to, so
**`minPaySats` is what a viewer SHOULD batch to, the effective window guarantees it CAN, and a
seeder does not refuse a smaller PAY.** ADR 0007's two goals are still met: the carry makes the
creator whole however small the PAYs are (the fairness problem), and honest viewers batch to
the minimum whenever one seeder is owed that much (the overhead problem). What is given up: a
viewer that throttles itself to one block per PAY imposes mint input fees on the seeder (≤ ~2
proofs per PAY). Default `DEFAULT_MIN_PAY_SATS = 10` (ADR 0007's proposal, confirmed).
**Cameron may want to revisit this** — the alternative is a per-seeder credit design in the
worker, which needs peer selection Hypercore does not expose.

## 4. The mock (item 7) and what changed in L10's suite

`MockPaymentEngine` now models v5: per-block upload sets, the carry, the effective window,
the P2PK lock inside the secret (`mock:<ns>.<n>:<target8>`), the creator binding
(`:pay1=<seeder8>`), empty sets, the local double-spend check, and a `markSpentAtMint()` test
hook for the swap path. **Bug 1** (block index read as a count) and **bug 2** (identical secrets
across mock wallets — every engine now has a random namespace) are fixed. Reason precedence is
the contract's (cheap checks first, DLEQ last).

L10 expectations that changed, and why:

| Test | Old expectation | New | Why |
|---|---|---|---|
| T4 core-less PAY (v3) | contract text says core-less is malformed on multi-core streams; mock accepts core-less | v5 contract text (core required); core-less refused as `malformed` with ONE core and with TWO | item 1 |
| T4 core-less on a multi-core stream (`skipIf(usingMock())`) | skipped | merged into the test above, runs against the mock | the mock can express it now |
| T5 double-spend | 2nd PAY accepted offline, caught at flush | 2nd PAY refused at verify (`double-spend`), peer banned at once; a proof spent where the seeder cannot see is still caught at flush (`spendAtMint`) | §5 — the old residual was up to a whole swap batch, not the window |
| T6 relabelled PAY (`skipIf(usingMock())`) | skipped | runs against the mock | the mock models the lock inside the secret |
| INV1 per core (property) | skipped cores with no uploads | asserts them (`range-not-uploaded`) | every upload is per core |
| INV1 no recorded uploads (`skipIf(usingMock())`) | skipped | runs | same |
| INV1 per block (new) | — | seeks, two seeders on one core, a re-sent block counts once, property over arbitrary sent sets | item 7, L6-C request 1 |
| INV2 across cores (property) | `pay()` on a shared viewer | passes `carryIn: 0` (each run is a fresh channel to a fresh seeder); precondition checks both shares ≥ 1 | the running carry would chain across runs; v5 rounds the CREATOR share down, so it is the one that can be 0 |
| INV5 rebind | two sessions send overlapping indexes, expect n + m | the two sessions send distinct blocks (`from:`) | `uploaded` counts distinct blocks |
| INV6 / INV6 rebind | double-spend caught at flush after the replay was accepted | reused proofs refused at verify; the flush path is tested with proofs spent at the mint; a replay under a provisional id bans it and `rebind` carries the ban | §5 |
| cheating modes | `double-spend` offline reason `null` | `double-spend`, first PAY honest; property builds the 2nd PAY with the carry the seeder holds | §5, §3.1 |
| `expectedShares` | floor to the seeder | `splitPay` (carry-aware); `expectedSequence` for PAY sequences | §3.1 |
| `POLICY` | — | `minPaySats: 1` | keeps the effective window equal to the configured one so window tests keep their meaning; the effective window has its own tests |
| gateway WS "non-paying client is cut" | cut at `windowBlocks + 1` = 5 | cut at effective window + 1 = 6 (2 sat/block, default minimum) | §3.2 |
| seeder `setPolicy` PRICE | one core-less PRICE | one PRICE per core on the default policy | item 2 |

## 5. Double-spends are refused at `verify` (new `RejectReason` `double-spend`)

Before v5 the engine credited a PAY whose proofs it had already accepted and caught the reuse at
the next swap batch (every 64 blocks or 60 s). Proofs in a PAY are P2PK-locked to this seeder or
bound to it (§6), so re-presenting the same proofs to this seeder is the only offline-invisible
double-spend — and it is not invisible: the seeder has seen the secrets. `verify` now refuses a
secret it has accepted before (or one repeated inside the PAY), bans the peer and fires
`onDoubleSpend`. The swap batch still catches proofs spent elsewhere (another instance with the
same key, a restart that lost the seen set). SECURITY.md T5's "≤ window" residual was only true
with this check; without it the bound was a whole batch.

The seen set must survive restarts for this to hold across them — the real engine takes an
injectable store (PART A step 3); wiring it to disk is Stage 3.

## 6. The creator set is bound to its seeder (`['pay1', <seeder P2PK>]`)

Creator shares are published by the seeder as NIP-61 nutzaps — PUBLIC events carrying the
proofs. Without a binding, anyone could lift creator proofs from any seeder's nutzap and present
them to ANOTHER seeder as the creator share of a new PAY: P2PK target right, DLEQ right, and the
creator receives proofs it already has — stiffed, while the viewer paid only the seeder share
(T4 residual > 0). NUT-10 allows extension tags ("tags hold additional data committed to and can
be used for feature extensions", `docs/vendor/NUT-10.md`), so every proof in the creator set
carries `['pay1', <seeder P2PK pubkey>]` in its secret, and the seeder refuses a creator proof
bound to anyone else (`wrong-p2pk-target`). Replays of this seeder's own nutzaps are caught by
the seen set (§5). `Wallet.send` gains `tags` (and `memo`) for this.

**Not verified against a real mint:** that Nutshell/CDK accept an unknown NUT-10 tag when the
creator redeems. The spec says they must ignore it; Stage 3's integration run against a regtest
mint must confirm it before real money flows, because a mint that rejects the tag would make
every creator share unredeemable.

**Verified 2026-09-24 against Nutshell 0.21.0** (`packages/core/src/__tests__/
real-mint.integration.test.ts`, opt-in): the mint accepts a P2PK secret carrying the `pay1` tag,
refuses to spend it without the creator's witness, and the creator redeems it with one. **Same
result on cdk-mintd 0.18.1**, the second implementation (security review F6, §0a).

## 7. HELLO is bound to the connection

`HelloMessage.challenge = pay/1:<Noise handshake hash hex>:<sender Noise static key hex>`,
`createdAt`, and `signature` = BIP-340 over the NIP-01 id of `{ kind: PAY_HELLO_KIND (21071,
NostrKind.PayHello), pubkey, created_at: createdAt, tags: [['challenge', challenge]], content:
'' }` — an ordinary event any `Signer.signEvent` can sign and `nostr-tools` can verify. The
receiver refuses a HELLO whose hash is not its own connection's (a HELLO replayed onto another
connection) or whose key is not the remote's (a HELLO reflected back to its sender). The v4
HELLO signed an arbitrary random challenge the receiver had no way to check. Implemented in
PART A step 4; until then the gateway and the dev worker send placeholders, as in Stage 1.

## 8. Blossom authorisation (item 4, PART A step 5)

`BlossomAuthImpl` (`packages/gateway/src/auth/blossom-auth.ts`) verifies through core's T9
boundary (`nostr.classifyIncoming`), then applies policy to the authentic event:

- **`report` (item 4).** The handler keeps passing the BUD-09 body as `Nostr <base64 event>`
  under verb `report`; no second interface method. For that verb the event must be kind 1984
  (NIP-56), carry the reported hash in an `x` tag, have `created_at` no more than 60 s ahead and
  within `maxAgeSec`, and honour a NIP-40 `expiration` if present. It needs no `t` tag and no
  `expiration`. A report is accepted once (replay by id), a denied pubkey cannot report, and
  allow-list mode does not gate reports — anyone not denied may report a blob.
- **Allow list.** `allow()` on any pubkey switches to allow-list mode: only allowed pubkeys pass
  (403 `denied`). The gateway config names the field `allowPubkeys`, and an allow list that
  restricted nothing would be a silent open door. `allow()` lifts a deny and `deny()` drops an
  allow; the later call wins.
- **Time.** `created_at` may be at most 60 s in the future (clock skew). A token is honoured for
  at most `maxAgeSec` (default 3600 s, nostr-tools' default lifetime) whatever its `expiration`
  says. `expiration` must be exactly one canonical decimal tag, and `expiration <= now` is
  expired.
- **Ambiguity is malformed.** Two `expiration` or two `t` tags are refused rather than read
  first-or-last, and `1e10`, hex, padded or signed numbers are refused rather than coerced.
- **`server` tags.** A token that names servers must name this gateway's host when one is
  configured (new reason `wrong-server`). BUD-11 is not vendored: this follows nostr-tools'
  Blossom client (`createAuthEvent` writes lower-cased hostnames as `server` tags) and is
  **unverified against the spec text**.
- **Bounded replay memory.** Accepted ids are kept until the token could no longer pass the
  time checks (plus 300 s). When the memory is full of live tokens the answer is 503 `busy`
  (new reason); evicting a live token would re-open it to replay.

`BlossomAuthResult`'s failure `status` widens to `401 | 403 | 503`, and the reason set gains
`wrong-server` and `busy`. The handler already forwards whatever status and reason it gets.

## Consequences

- `CONTRACTS_VERSION = 5`. Consumers adapted: seeder (`PeerSession.onUpload` records indexes
  with the core's pricing; `PRICE` per core; the pay bridge ACKs with the core and cuts on
  `double-spend`), gateway (`UpstreamPayer` per-core PRICE, v5 HELLO fields), desktop worker
  (plain mock, ACKs matched by core, v5 HELLO fields), Studio/Watch (`seedersOnline` unknown).
- **Owed to Stage 3** (recorded in `docs/status.md`): payers batching to `minPaySats`;
  persisting the seen-secret set (the `persist` hook exists); the `NetworkAdapter`/IPC signer
  bridge and `SignerStatus` "none"; the deferred L5/L6-B/L6-C items above; a regtest-mint check
  of the `pay1` tag; wiring the runtime providers (`cli/providers.ts`: `BlossomAuthImpl` with
  `serverHost` from `blossom.publicUrl`, the real engines with `checkSpent` / `spentByUs` /
  `persistPending`, the HELLO signer).
- **Done in the review fixes (2026-09-24, `docs/security-review.md` §0):** the seeder honours
  the OLD price for blocks below a `PRICE`'s `effectiveFromBlock` (per session × core), and
  per-core policy changes announce a per-core `PRICE`; the report store records
  `signatureVerified: true`; the viewer transport (`UpstreamPayer`) keeps the carry per channel
  and advances it only on `ACK ok`, as `PaymentEngineViewer.pay` requires; a seeder's price may
  only lower the manifest's; auto top-up targets only the user's own mints (contract text).
- The manifest parser does not read the NIP-71 `minpay` tag yet, so every video uses the default
  minimum until it does.
