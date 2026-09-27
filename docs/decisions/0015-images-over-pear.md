# 15. Thumbnails and avatars over Pear: the creator's profile core

Date: 2026-09-25

## Status

Accepted for Stage 3 (issue #5, parts b and c). Cameron's decisions, 2026-09-24/25:
- media on Pear only;
- thumbnails and avatars fetched P2P;
- thumbnails and avatars live in the creator's **profile core**, not in each video's core;
- each seeder chooses whether to serve them (serve free, or not at all), on by default;
- browsing never spends sats.

Implementation (2026-09-25): part a on `stage-3/image-privacy`, part b on
`stage-3/images-over-pear`, part c on `stage-3/profile-picture`.

## Context

Studio publishes no thumbnail today. Profile pictures and any thumbnail in another publisher's
event are `https:` URLs: fetching them tells their host the viewer's IP (F18). Part a made
unsigned ones opt-in. The rest has to come from Pear.

A thumbnail inside the video's own core would share that core's payment window with paid
playback. The seeder engine counts every block it serves against the peer's window whatever the
price, so free image blocks would read as unpaid debt and could get a viewer cut mid-video. It
would also need a HELLO wire change to say whether images are free. A separate core with no
price keeps images out of the payment path entirely.

## Decision

1. **The profile core.** Each creator has one Hyperblobs core, opened from their own corestore
   under the name `nutflix-profile`. It holds their avatar and banner, and every published video's
   thumbnail and storyboard. It has no price and no pay/1 policy.
2. **Addressing.** A NIP-71 rendition's `image` is `hyper://<profile core>/<blockOffset>-
   <blockLength>[+<byteOffset>]` (the rendition URL grammar), with `image-x` (sha256,
   **required** for `hyper://` images) and a new imeta key `image-size` (bytes, required, at most
   5 MiB). A kind 0 profile's `picture` / `banner` may be such a URL, with `picture_sha256` /
   `picture_size` (and `banner_*`) beside it; any other `picture` stays an `https:` URL under
   part a's rule.
3. **Fetching** (desktop): `image(url, sha256)` for a `hyper://` URL goes to the worker, which:
   - opens the core by key and joins its topic as a client;
   - reads exactly that blob, with a deadline;
   - checks size ≤ cap and the sha256, and hands the bytes to the host.
   The host then sniffs the type as for any image. No `https:` request is made, and no
   `loadRemoteImages` opt-in is needed.
4. **Serving free.** A seeder serves a profile core's blocks **outside payment**: the session's
   upload hook skips `recordUpload` and the window check for cores it marked free
   (`Seeder.setFreeCore`).
   - A worker marks a profile core free, and joins its topic as a server, only while seeding is
     on and the new setting `Settings.seeding.serveImages` (default **true**) allows it.
   - Its own profile core is always free while seeding is on.
   - The viewer's payer never pays for a core with no policy, so neither side accounts these
     blocks.
   - A node holds only the blocks it downloaded (sparse), so what it gives away is bounded by the
     thumbnails it showed.
5. **Serving "not at all".** With `serveImages` off, the worker reads the image and then closes
   the profile core, so the corestore stops replicating it: it is never served, and never
   counted against a viewer's window.
6. **Publishing** (Studio): the worker writes the chosen thumbnail into the creator's profile
   core after the renditions, and the host puts `{ url: hyper://…, sha256, size }` on the first
   rendition. The worker seeds its own profile core like its uploads.
7. **Avatars** (part c): Settings › Account gets "Profile picture". The worker writes the image
   into the profile core, and the host re-publishes the user's kind 0 with the other fields kept
   (read first, then merged) and `picture` = the `hyper://` URL with its sha256 and size.

## Consequences

- Thumbnails and avatars load with no `https:` request and no payment, from the creator and from
  anyone who has shown them, unless those nodes turned serving off.
- Contracts v6 gains:
  - `Rendition.image.size?`;
  - `Profile.pictureSha256?` / `pictureSize?` (and banner);
  - `Settings.seeding.serveImages`.
- The payment engine and pay/1 are untouched. The seeder package gains `setFreeCore` and a
  free-core skip in `PeerSession.onUpload`.
- Residual: a profile core is publicly readable by anyone who knows its key, which is by
  design. The daemon and gateway serve free cores only if something opens them (they seed only
  local content today).

## Amendment 2026-09-26 — seeders say "free" (Cameron)

The cross-lane review found that a thumbnail URL naming a paid video's core made `image.fetch`
download it unpaid, so that video's honest seeders banned the viewer; the interim probe (one
block per seeder, stop on `PRICE`) still left one unpaid block per seeder, which a restart turned
into a ban. Cameron's answer: **seeders say "free" per core, and viewers fetch image blocks only
from seeders that said so.**

- pay/1 `PRICE` gains `free` (contracts v6, additive): `free: true` means the seeder serves that
  core outside payment — it counts nothing for it and never cuts for it (`satsPerBlock` 0).
- Normative for every seeder: before the first block of a core to a peer, send that core's
  `PRICE` — priced, or `free` for a core it serves outside payment.
- A viewer's image read asks a peer for blocks only after that peer's `PRICE { free: true }` for
  the core; silence or a price means the peer is never asked. No probe, nothing counted.
  Images held only by older or third-party seeders show the placeholder.

Seeder side as built (2026-09-27, lane P1-owed-seeder): `Seeder` says a core's terms —
`{ free: true }` (`satsPerBlock` and `effectiveFromBlock` 0) for a core marked with `setFreeCore`,
else the core's price — **unprompted, as soon as the peer has the core open** on a connection with
pay/1 attached (Hypercore's `peer-add`; for a core paired before pay/1 was attached, at the attach;
for a core paired before the `Seeder` opened it, at that open), so a viewer that asks for nothing
still learns the terms (the independent review of 2026-09-27 found the first build said them only
in reply to a block request, which left this decision's viewer with silence). The synchronous
upload hook stays the backstop: before any block is written, the terms go out if they have not
been said, and a seeder that cannot send them cuts the connection (`local`, no ban) instead of
sending the block. Said once per connection, and again whenever they change — a free core turned
sold, or back, reaches every peer that has the core open at once (`setFreeCore`,
`setCorePolicy`). The option that switched this off (`announceCorePrices`) is gone, so every
seeder the repository builds (the daemon, the gateway, the desktop worker, the dev fixtures) does
it; tests on each composition show the reader receives the `PRICE` before the core's first block,
for both kinds, and with nothing asked at all. `free` covers the blocks served while it holds;
blocks counted before a core turned free stay counted (they appear in `OWED`, with no priced
`PRICE`, and are not payable).

Viewer side as built (2026-09-27, lane P2-owed-viewer):

- **Free only.** `SeederCredit.attachImageCore` routes an image read. A seeder is asked for the
  core's blocks only while it is on an open channel (both HELLOs) and its last word for that core
  on this connection is `PRICE { free: true }`. It is then asked up to `NO_PAY_INFLIGHT` in
  flight, from its own cap. Silence, a priced PRICE, no `pay/1`, or no HELLO: never asked.
- **No debt.** The router's new `free` option keeps a free core's requests out of `used`,
  `inflight` and `debt`, and out of what a released peer leaves as lost. So a free read that
  times out or is stopped leaves nothing owed, and never erodes that seeder's paid credit.
- **Free, then sold.** A core that turns sold is not asked again there. A block of it that still
  lands afterwards is counted unpaid for good (browsing never pays).
- **The probe is removed**, with what it needed:
  - the router's `probe` option, `SeederCredit.probing`, `onImageVerdict` and its per-seeder
    "priced" memory;
  - the worker's `imageSold` / `imageFree` sets and its early stop of a read at a seeder's price.
    That early stop also stopped an honest free image whenever a gateway that prices it answered
    first; that no longer happens.
  - The worker still refuses cores it knows are sold: a policy here, a routed core, one our
    seeder prices.
- **R9 closed.** The worker marks a replica it opens for an image free, by key, before the open.
  A peer pairing on it hears `free`, never silence first.
- **Free for a paid core.** `UpstreamPayer` never reads `{ free: true }` as a 0-sat price. The
  settler and the payer owe nothing for a core a seeder serves free.

Round-8 fixes (2026-09-27, lane W8b-p2p):

- **Sold survives a restart.** `Seeder` keeps its per-core policies in
  `<dataDir>/core-policies.json` and loads them back at start (at most 16 384, least recently set
  first out). After a restart, a core this node sold — an upload, a played video still in its
  store — is still priced, `setFreeCore` still refuses it, and the worker's sold-core check still
  sees it. Before, an attacker's thumbnail naming such a core marked it free on our own seeder.
- **One session per core.** Opens of one core at once share one Hypercore session
  (`BlobStore.openCore` / `openCoreByKey`), so two thumbnails of one profile core read together
  leave no ungated session replicating once the read is over.
- **Our own profile core is free before it can be served** (`Seeder.openCore(name, { free: true
  })`): marked when it is ready, before its upload gate and its unprompted terms.
- **Free requests share the window while in flight.** With the router's `room` option
  (`SeederCredit.roomOf`: the seeder's bare window less what it counts), free image requests fit
  under what the seeder may still count, and counted requests leave room for the free ones out. A
  seeder that turns an image core sold mid-flight then counts them within its window, never past
  it (a ban). Landed or not, free requests still leave no debt. The cost: while a seeder's window
  is full of video, image requests to it wait for room.
- **One answer for free.** `UpstreamPayer` asks the downloader's bounded `servesFree` (the
  settler's answer); its own set, and its per-connection price map, are bounded too.
