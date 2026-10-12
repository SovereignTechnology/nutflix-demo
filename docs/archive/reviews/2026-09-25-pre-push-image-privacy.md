# Pre-push review — image privacy (2026-09-25)

Diff: `stage-3/pear-only` (`bbd8740`) → `stage-3/image-privacy`. Method: `differential-review` and
`sharp-edges`, inline. Security review F18; issue #5, part a.

## Scope

- MEDIUM (privacy):
  - `app-desktop/src/host/images/images.ts` (refuse unsigned images unless allowed);
  - `host/host.ts` (wiring);
  - `host/settings/settings.ts` (default off);
  - `ipc/guards.ts` (the patch key);
  - `core/src/contracts/network-adapter.ts` (`Settings.loadRemoteImages`, v6).
- LOW: `ui/src/screens/Settings/AppearanceSection.tsx` (the switch), the mock default, tests,
  docs.

## Adversarial questions

- **Fail closed.**
  - The image service's own default is "never" (`remoteImages` absent → refuse), so a caller
    that forgets the option leaks nothing.
  - The host default setting is off. A settings file from before this change lacks the key and
    takes the default: off.
- **Refused before any request.** The check runs before the cache lookup and before the
  transport (tested: no request recorded).
- **Toggling off after on.** A later request for the same URL is refused even though its bytes
  are cached. Bytes already on screen stay: the page has them.
- **Bypass through a hash.** A caller that invents a sha256 gets `hash-mismatch` after the
  fetch, so the request still leaves.
  - Only the host's own callers pass hashes: thumbnails carry the publisher-signed `image-x`, and
    avatars pass none.
  - A publisher who signs a hash for a tracking URL can still learn the fetcher's IP. The option
    removes arbitrary URLs, not signed ones; signed ones move to Pear in #5b.
- **Renderer.** The renderer cannot change the rule except through `updateSettings`, which goes
  through the IPC patch guard (boolean only).

## Found and fixed before commit

None.

## Residual (tracked in issue #5)

A malicious publisher controls both the URL and the signed hash in their own event, so they can
still make a viewer's machine request a tracking URL once (the fetch then fails on the hash). This
option blocks unsigned images (most profile pictures, unsigned thumbnails), not a hostile signer.
The full fix lands with #5b/#5c: once thumbnails and avatars come from Pear, "off" becomes "no
`https:` image fetches at all".

## Tests

- `images.test.ts` (2 new):
  - off by default, refused before any request, a hashed image loads;
  - the setting is followed live, including a cached URL.
- `conformance.test.ts`: the fixture image is hash-addressed; an unsigned one is refused by the
  desktop.
- UI `settings.test.ts`: the switch starts off and saves `{ loadRemoteImages: true }`.
