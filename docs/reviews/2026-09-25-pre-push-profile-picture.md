# Pre-push review — profile picture over Pear (2026-09-25)

Diff: `stage-3/images-over-pear` (`9d5aafa`) → `stage-3/profile-picture`. Method:
`differential-review` and `sharp-edges`, inline. ADR 0015 part c; issue #5.

## Scope

- MEDIUM (a new renderer → host → worker write, and a re-publish of the user's kind 0):
  - `app-desktop/src/host/adapter.ts` (`setProfilePicture`);
  - `worker/host.ts` (`profile.putImage`);
  - `core/src/nostr/profiles.ts` (`mergeProfileEvent`);
  - contracts v6 (`NetworkAdapter.setProfilePicture`);
  - the IPC table, guards, bridge, renderer adapter and coordinator.
- LOW: `ui/src/screens/Settings/SignerSection.tsx` ("Change picture"), `Settings.tsx`, the
  mock, tests, docs.

## Adversarial questions

- **What the renderer controls.**
  - Only the bytes, at most 5 MiB (exact-key guard: `{ bytes: Uint8Array, type }`).
  - The host ignores the claimed type and sniffs the bytes: SVG or anything else is refused
    before the worker is involved (tested).
  - Where the picture goes (our own profile core) and what is published (our kind 0) are the
    host's decisions.
- **Clobbering the profile.** The new kind 0 starts from our newest verified kind 0, queried by
  author, and keeps every field, including ones this client does not know (tested with
  `website`). A kind 0 whose content is not a JSON object contributes nothing; the result is
  still a valid profile.
- **Signer.** No signer means `no-signer`, before any write (tested). The event is signed by the
  host's signer and verified before its parsed form is returned.
- **Worker trust.** The host places whatever `url`/`sha256`/`size` the worker answers, but only
  after the worker-hop guard accepted the shape (`hyper://` grammar, hex hash, size within the
  cap). It is the user's own worker; a compromised one could already publish arbitrary thumbnails.
- **Viewers.** A `hyper://` picture is only used with a valid hash and size (the parser drops it
  otherwise), and it is read over Pear under part b's rules.

## Found and fixed before commit

- The IPC method count is pinned by a test; it now reads 55, with the reason in a comment.

## Tests

- Core `profiles.test.ts`: `mergeProfileEvent` keeps previous fields; no previous; non-object
  content.
- Desktop:
  - `profile-picture.test.ts` (3): writes over the worker and re-publishes, keeping every field;
    refuses non-images and oversize before the worker; needs a signer;
  - guard samples (valid and four invalid);
  - `images-over-pear.integration.test.ts`: `profile.putImage` lands in our own profile core,
    reads back, and is never released.
- UI `settings.test.ts`: "Change picture" refuses a wrong type without calling, sends the bytes,
  and re-reads the profile.
