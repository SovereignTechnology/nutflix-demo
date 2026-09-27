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

Seeder side as built (2026-09-27, lane P1-owed-seeder): `Seeder` sends a core's `PRICE` from the
synchronous upload hook, before the block is written — `{ free: true }` (`satsPerBlock` and
`effectiveFromBlock` 0) for a core marked with `setFreeCore`, else the core's price — once per
connection, and again whenever that changes (a free core turned sold, or back). The option that
switched this off (`announceCorePrices`) is gone, so every seeder the repository builds (the
daemon, the gateway, the desktop worker, the dev fixtures) does it; a test on each composition
shows the reader receives the `PRICE` before the core's first block, for both kinds. `free`
covers the blocks served while it holds; blocks counted before a core turned free stay counted
(they appear in `OWED`, with no priced `PRICE`, and are not payable). A seeder that cannot send
the `PRICE` for a block cuts the connection (`local`, no ban) instead of sending the block.
