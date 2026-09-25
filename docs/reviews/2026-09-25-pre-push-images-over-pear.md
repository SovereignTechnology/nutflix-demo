# Pre-push review — thumbnails over Pear (2026-09-25)

Diff: `stage-3/image-privacy` (`2617fd4`) → `stage-3/images-over-pear`. Method: `differential-review`
and `sharp-edges`, inline. ADR 0015; issue #5, part b.

## Scope

- HIGH (a new path by which peers download data without paying; a new worker capability):
  - `seeder/src/net/peer-session.ts` (free cores skip accounting), `session-registry.ts`,
    `seeder.ts` (`setFreeCore`);
  - `blobs/blob-store.ts` (`closeCoreByKey`);
  - `app-desktop/src/worker/host.ts` (`image.fetch`, the own profile core, releasing
    replicas);
  - `worker/studio/upload.ts` (the thumbnail into the profile core);
  - `worker/net/peer-node.ts` (`leave`).
- MEDIUM:
  - `core/src/manifest/{parse,build}.ts` (`image-size`, `hyper://` image rules);
  - `core/src/nostr/profiles.ts` (picture and banner hashes);
  - contracts v6 (`Rendition.image.size`, `MAX_IMAGE_BYTES`, `Profile.*Sha256/*Size`,
    `Settings.seeding.serveImages`, `image(url, sha256?, size?)`);
  - `app-desktop/src/host/images/images.ts` (`hyper://` via the worker);
  - `host/host.ts`, `host/adapter.ts` (publish);
  - the IPC guards and protocol.
- LOW: the UI helper and screens, the Seeding switch, tests, docs.

## Adversarial questions

- **Can a peer get paid content free?**
  - Only cores the node itself marks free skip accounting: our own profile core, and profile
    cores the image path opened while serving is allowed.
  - A video core is never marked. A peer cannot mark anything: `isFree` is a local set.
  - The payment engine is untouched, and the viewer's payer ignores cores it has no price for.
- **Free serving as a resource drain.** A node holds only the profile-core blocks it
  downloaded (sparse), so it gives away at most the images it showed. Our own profile core holds
  only our thumbnails. Rate limits and the disk cap still apply.
- **"Not at all" must mean not at all.**
  - With serving off, a replica the image path opened is closed once no read needs it, so the
    corestore stops replicating it and it leaves the swarm topic.
  - Switching `serveImages` off releases replicas first, then re-announces topics, so
    `setServing` cannot re-announce a profile core.
  - A core the worker writes to, or one a playback opened, is never closed:
    `closeCoreByKey` refuses a named core, and the worker tracks what it opened.
  - Tested on a testnet.
- **Integrity.** The worker checks length and sha256; the host checks both again where the
  bytes are served, and sniffs the type. A `hyper://` manifest image must name its hash and
  size, and the parser and the builder both refuse otherwise.
- **Privacy.** No `https:` request for a `hyper://` image, and no opt-in needed. The seeders a
  viewer reads from see its IP, as with any P2P read; no third-party host does.
- **Publish failure modes.** A thumbnail that is too large, unreadable or changed since hashing
  is left out, and the video still publishes. The host only places a reference whose shape the
  worker-hop guard accepted.
- **Exact-key guards.** `image.size`, `thumbnailImage`, `serveImages` and the `image()` size
  argument are admitted on every boundary. Refusals are tested: https URLs, size 0, over the
  cap, missing hash, odd hex.

## Found and fixed before commit

- CI's incremental build hid a type error in a test file from the image-privacy commit. The
  test built a `Settings` literal without `loadRemoteImages`, and vitest does not typecheck. A
  clean rebuild of all 10 packages found no other stale error. The literal is fixed here.
  Suggestion: CI should typecheck from clean.
- Making `serveImages: true` explicit in the defaults broke two exact expectations. They were
  updated to the new shape.

## Tests

- Seeder `peer-session.test.ts`: a free core is never recorded or cut and is served under
  back-pressure, while a paid core still is.
- Core: `manifest.test.ts` (`hyper://` thumbnail round-trip, four builder refusals, raw event
  without `image-size`) and `profiles.test.ts` (hashes kept, dropped or partially kept).
- Desktop:
  - `images.test.ts`: over Pear only, re-checked, sniffed, cached; six refusals;
  - `worker-guards.test.ts`: refusals;
  - `conformance.test.ts`: publish places the thumbnail;
  - `upload.test.ts` (real ffmpeg): the thumbnail is in our profile core, hash matches, core is
    free;
  - `images-over-pear.integration.test.ts` (local testnet): read over Pear; served free (bytes,
    no sold blocks); closed with serving off; wrong hash refused; kept free with `serveImages`,
    released when it is switched off.
- UI: the helper passes only known arguments; the Seeding switch saves `serveImages`.
- Mutations (all caught):
  - no free skip;
  - no release;
  - not marked free.
