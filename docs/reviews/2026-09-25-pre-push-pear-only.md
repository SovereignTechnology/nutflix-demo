# Pre-push review — Pear-only media (2026-09-25)

Diff: `stage-3/manifest-minpay` (`e332857`) → `stage-3/pear-only`. Method: `differential-review`
and `sharp-edges`, inline. Issue #4.

## Decision

Cameron chose "Pear only" on 2026-09-24. On 2026-09-25 it was re-asked with corrected facts: the
gateway has no separate disk store, and its Blossom endpoints are an HTTP face over its own Pear
seeder. The refined answer: drop third-party mirroring only.

## Scope

- MEDIUM (a contract change, v6):
  - `core/src/contracts/network-adapter.ts` (`UploadInput.mirrorTo` and the `mirroring` stage
    removed);
  - `core/src/media/upload.ts` (no `mirror` dependency);
  - `app-desktop/src/ipc/{guards,worker-guards,worker-protocol}.ts`, `preload/bridge.ts`,
    `host/adapter.ts` (no mirror list crosses; the host names no Blossom server);
  - `ui/src/screens/Studio/*` (the Mirrors field, step and published-notice removed).
- LOW: `gateway/src/config.ts` (quota default 2 GiB), the mock, tests, docs.

## Adversarial questions

- **Can a mirror list come back through a side door?**
  - Both IPC boundaries are exact-key, and both now refuse `mirrorTo`, well-formed or not
    (tested renderer → host and host → worker).
  - The host sets `blossomServers: []` itself, so nothing the renderer sends reaches the tags.
- **Did anything fetch Blossom URLs?** No: `fallbacks` and `blossomServers` had no reader in the
  player, the host or the worker. They stay in the parsed type (other publishers' events) and
  are documented as never fetched.
- **What the old code really did.** Studio's mirror was never wired on the desktop (no `mirror`
  dependency), so a "mirror" only wrote the servers into the signed manifest, which then claimed
  copies that did not exist. Removing it removes a false claim, not a working backup.
- **Gateway.** Unchanged except the quota default. Its endpoints still require Nostr-signed
  auth; uploads land in its Pear seeder; the web MSE fallback still reads `GET /<sha256>` from
  Pear.

## Found and fixed before commit

- The quota comment claimed "four full-size uploads"; at 2 GiB it is one.

## Tests

- Core `upload.test.ts`: the mirroring test became a Pear-only test. Drafts carry no https
  fallbacks and every rendition is `hyper://`; nothing sits between publishing and done. Its
  work-dir and per-rendition-sink assertions are kept.
- Desktop guards: `mirrorTo` refused on both boundaries.
- UI Studio: no Mirrors field; the upload input has no `mirrorTo`; five steps; the draft errors
  no longer include `mirrors`.
- Gateway: the default is 2 GiB.
