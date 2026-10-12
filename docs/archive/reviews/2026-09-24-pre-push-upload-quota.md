# Pre-push review — per-pubkey upload quota (2026-09-24)

Diff: `stage-3/pending-journal` (`fc95da3`) → `stage-3/upload-quota`. Method: `differential-review`
and `sharp-edges`, inline.

## Scope

- MEDIUM (an abuse control on a public endpoint):
  - `gateway/src/blossom/handler.ts` (quota checks, in-flight reservations, the mirror path
    split into `storeMirror`, the upload path into `storeUpload`);
  - `blossom/store.ts` (`OwnerIndex.owns`);
  - `config.ts` (`blossom.maxBytesPerPubkey`).
- LOW: tests, docs.

## Adversarial questions

- **Bypass by concurrency.** Checks and reservations run in the same tick after `authorize`
  (single-threaded), so two concurrent uploads by one pubkey see each other's held bytes (tested;
  the mutation that drops the hold fails the test). Holds are released in `finally` on every
  exit path.
- **Bypass without `X-SHA-256`.** Such uploads are capped at `MAX_UNHASHED_UPLOAD_BYTES` (8 MiB),
  already spooled before authorisation (F15's earlier fix). The quota is checked right after
  authorisation, before `putFile` (tested).
- **Bypass by claiming.** Re-uploading or mirroring a blob someone else stored makes the pubkey
  an owner, and it is charged for it (tested). A blob it already owns costs nothing (it would
  otherwise be locked out of re-confirming its own uploads).
- **Mirror.**
  - Checked right after authorisation for an existing blob, and before the fetch body is spooled
    when the origin declares a length (tested: refused with nothing stored).
  - Without a declared length it is checked once spooled, before storing; `maxUploadBytes` still
    bounds that spool.
- **Denial of service to others.** The quota is per pubkey and the global disk cap is unchanged.
  Evicted blobs stop counting (usage is computed against blobs still stored).
- **Config sharp edge.** `null` means unlimited, explicitly (the same convention as
  `allowedMimeTypes: null`); `0` is refused (min 1). An absent key is the default, not "none".
- **Cost.** Usage is O(blobs owned by that pubkey) per upload, bounded in practice by the quota
  itself.

## Found and fixed before commit

None beyond the design.

## Residual

- Whether uploads default to allow-list-only (Cameron's pending decision). The 8 GiB default is
  also his to change.
- `DELETE` is not supported (405), so a pubkey cannot free its own quota except through
  eviction.

## Tests

- New: `blossom` F15 (6):
  - refused before spooling;
  - owned blobs are free;
  - per pubkey;
  - small unhashed uploads are counted;
  - claiming counts;
  - concurrency;
  - `null` / default;
  - mirror refused before spooling.
- `npm run ci` green: 162 files passed, 2 skipped; 2610 tests passed, 7 skipped; all gates OK.
