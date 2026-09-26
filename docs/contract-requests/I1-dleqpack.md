# Contract request — I1-dleqpack, fix round 4 (against `CONTRACTS_VERSION = 6`)

**Status: a note, not a blocker.** Fix round 4 ships against v6 with the interim below; nothing
here needs to land before the merge. It makes normative what every seeder in this repository now
does, and asks for an explicit signal in its place.

## What is missing: the seeder saying that it serves a core free

ADR 0015 puts thumbnails and avatars in a creator's profile core, served outside payment: a
seeder that marked the core free (`Seeder.setFreeCore`) records nothing for it. But a `hyper://`
image URL can name ANY core. If it names a paid video's core, every honest seeder of that video
counts each block it sends against the viewer's unpaid window, and cuts and bans the viewer past
it (cross-lane review, fix round 4: two fixture seeders banned the viewer after one `image.fetch`,
`{ uploaded: 6, paid: 0, windowBlocks: 5, banned: true }`). Browsing never spends sats, so the
viewer will not pay for those blocks. It has to know, per seeder, whether the seeder counts them.

v6 has no field that says a core is free. The interim uses the absence of a `PRICE` instead.

## The interim (implemented in fix round 4)

1. **Every seeder announces a counted core's price before its first block.**
   `announceCorePrices` (ADR 0012) sends `PRICE { core, satsPerBlock, effectiveFromBlock: 0 }` on
   the first block of a core sent to a `pay/1` peer. It precedes the block on the wire: it is sent
   in the synchronous `upload` handler, before the block is written. A free core's block returns
   before the hook, so it never gets one. The option is now on for the desktop worker (dev mocks
   included), the dev fixture seeders, the gateway and the daemon (`runDaemon`, unless its config
   says otherwise). The `Seeder` default stays off, as its own test pins.
2. **The viewer routes image cores and reads that signal** (`SeederCredit.attachImageCore`). Per
   `pay/1` seeder:
   - it asks at most the seeder's BARE window, less what the seeder may already count (owed,
     unpaid, and in flight on any core), so even a seeder that counts every image block stays
     within its window;
   - it asks one block at a time until the seeder has delivered one with no `PRICE` before it.
     From then on the seeder serves the core free, and nothing is counted against its credit;
   - a seeder that sent a `PRICE` for the core is never asked for it again (remembered across
     reconnects), and blocks it delivered after that `PRICE` are unpaid for good.

   The desktop host then refuses the core as an image: it is sold somewhere and served free
   nowhere. So an attacker's thumbnail costs at most one block per seeder of the paid core, and
   the viewer counts that block.

**Where the interim is weak.**

- It relies on seeders built from this repository. A seeder that counts a core without announcing
  it breaks the rule: one with `announceCorePrices` off, an older build, or a third-party
  implementation. The viewer would take its silence for "free", pipeline requests, and be cut
  past that seeder's window.
- A seeder with NO policy at all for a core (neither a per-core policy nor a default) counts its
  blocks at the unpriced window but announces nothing, since `announceFirstUpload` has no price to
  send. No serving path in this repository reaches that state after fix round 4:
  - desktop image replicas are marked free while open;
  - played and uploaded cores have a policy;
  - the gateway and the daemon run with a policy.

  The contract should still say what such a seeder does.

## Suggested addition (v7, whenever convenient)

Make the signal explicit, so the viewer never has to infer "free" from silence:

```ts
// contracts/pay-protocol.ts
export interface PriceMessage {
  readonly type: 'PRICE';
  readonly core: CoreKeyHex;
  readonly satsPerBlock: Sats;
  readonly effectiveFromBlock: number;
  /**
   * v7: `true` = this core is served OUTSIDE payment (ADR 0015): its blocks are never recorded
   * against the viewer's window, and `satsPerBlock` is 0. Sent before the first block of a free
   * core, as a priced core's PRICE is. A viewer reads a core as an image only from seeders that
   * said so. It treats silence as "counted", and asks such a seeder no more than its window.
   */
  readonly free?: boolean;
}
```

Normative text to go with it:

- (a) A seeder that records a core's blocks against a peer's window MUST send that core's `PRICE`
  before the first such block on each `pay/1` channel. A core with no policy is announced with
  `satsPerBlock: 0` or served free, never counted in silence.
- (b) A seeder MUST NOT mark free a core it prices. `setFreeCore` already refuses one (fix round
  4).

The codec (`core/src/pay-protocol/codec.ts`, locked) would carry one flag. With (a) and the flag,
the viewer's rule flips to fail-closed: it takes an image core only from seeders that said `free`,
and silence means "counted".

## Related: the seeder's own count (S3-f33's request)

The one-block probe above still costs one unpaid block per seeder when the core is sold. A
seeder's debts to the viewer also outlive a viewer restart (IR4 in the F33 lane). Both are
estimates only the seeder can correct. S3-f33's request, the seeder's `PeerWindow` in `ACK` (or
reported once after HELLO), covers them, and this lane's residuals point to it.
