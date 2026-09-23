# Contract requests — lane L6-B (against `CONTRACTS_VERSION = 4`, L6-0 IPC frozen)

None of these blocks the lane: each is worked around in the host as described. Items 1–3 are
things L1 (the Nostr data layer) could not express; 4–8 are contract (v5) gaps; 9–11 are
L6-0 protocol (`src/ipc/`) gaps. Ordered by impact within each group.

## L1 (packages/core/src/nostr)

### 1. NIP-09 deletions are invisible to L1's reaction counts

**Need.** SE-5: `unreact` is a kind-5 deletion of the viewer's own kind-7 ids. L1's
`fetchReactions` / `summarizeReactions` / `countLikesByTarget` (and so `fetchComments`' like
counts) ignore kind 5, so a withdrawn like keeps counting on relays that do not delete it (NIP-09
relays only SHOULD).

**Workaround.** `packages/app-desktop/src/host/social/reactions.ts`: `buildUnreactDeletion`,
`ownReactionIds`, `deletedReactionIds` (honours a deletion only when it is signed by the
reaction's author — the vendored NIP-09 MUST), `fetchReactionSummary` (L1's fetch minus deleted
ids). `stats()` uses it. Comment like counts (L1 `fetchComments`) still do not honour deletions.

**Proposal.** Move these into L1 (`nostr/deletions.ts`), use them inside `fetchReactions` and
`countLikesByTarget`, and add `NostrKind.Deletion = 5` (item 4).

### 2. No kinds filter on `trendingFeed`

**Need.** Home's trending row is normal videos (the mock filters `kind === 21`); L1 ranks kinds
21 and 22 together.

**Workaround.** The host filters `kind === 21` after L1 pages, so a trending page can be shorter
than `limit` (never wrong, occasionally short).

**Proposal.** `trendingFeed(client, { kinds?: readonly number[] })`.

### 3. NIP-05 lookups need a fetch policy

**Need.** `Profile.nip05Status: 'verified'` needs a live lookup (`lookupNip05` takes a
`FetchLike`). In the desktop shell that means the host fetching a URL named by a relay event.

**Workaround.** No lookup in Stage 1; profiles with a `nip05` read `unverified`.

**Proposal.** Decide whether NIP-05 goes through the same rules as `image()` (https only, no
private addresses — `host/images/net.ts` has the transport and the DNS check) and wire it then.

## Contracts (v5)

### 4. `NostrKind` has no deletion kind

**Workaround.** `DELETION_KIND = 5` in `host/social/reactions.ts`. **Proposal.** `Deletion: 5`.

### 5. `VideoStats.seedersOnline` cannot say "unknown"

**Need.** The Stage 1 host has no swarm lookup and the worker protocol has no "how many seeders
announce this core" request. Watch and Shorts gate playback on `seedersOnline === 0`.

**Workaround.** Fail closed: 0, except live `--dev-fixtures` manifests (the worker seeds them
itself) → 1. `play()` reports the truth anyway (`no-seeders:` from the worker). On a real relay
catalogue in Stage 1 every video therefore reads "no seeders" — acceptable only because Stage 1
has no real payments either.

**Proposal.** `seedersOnline?: number` (absent = unknown, the screens do not gate), plus item 10.

### 6. `SignerStatus.kind` has no "none"

**Workaround.** No signer is reported as `{ kind: 'local', pubkey: null, locked: true,
supportsSignSecret: false, detail }` (the Settings screen shows "signer not detected" for
`pubkey === null`; the mock uses `kind: 'nip07'` for the same state).
**Proposal.** `kind: … | 'none'`, or `SignerStatus | null`.

### 7. Watch/Shorts refuse to play when signed out — Stage 1 has no signer

**Need.** `Watch/model.ts stageGate` returns `'signer'` when `me() === null` (Shorts too), but
Stage 1 has no `Signer` at all, and paying needs the wallet, not a Nostr identity.

**Workaround.** Behind `--dev-mocks` only, `DevViewerIdentity` (`host/identity.ts`): `me()` is
the fixtures' `ME` pubkey (a public key, no private key anywhere), `signer()` reports it
`locked: true`, and every write still rejects `no-signer:`. Without `--dev-mocks`, `me()` is
`null`. **Decision needed** (see docs/lanes/L6-B.md): keep this dev identity for the Stage 1
exit test, or let the screens play signed out.

### 8. Smaller ones

- `Settings.autoTopUp` should say whose balance is compared; the host reads it as the balance at
  `fromMint`, and treats `belowSats <= 0` as off (SE-4) — v5 making it nullable removes the
  sentinel.
- `studio.analytics().satsByRendition` has no Stage 1 source; the host returns an empty Map
  (the mock invents a 60/30/10 split).
- `studio.upload`: no `AbortSignal`; closing the window cannot stop a transcode (item 9).
- `UploadInput.file` "Desktop: absolute path" — in the shell it is main's resolution of a
  `FileToken` (already in docs/status.md, v5 item 6).

## L6-0 protocol (`src/ipc/`, frozen)

### 9. No way to cancel an upload

**Need.** `wc-gone` closes sessions and subscriptions, but a running `studio.upload` keeps
transcoding in the worker with nobody listening.
**Proposal.** host → worker `studio.cancel { uploadId }` → `aborted`.

### 10. No seeder count per core

**Proposal.** host → worker `swarm.seeders { core }` → `{ count }` (feeds item 5).

### 11. `isHostIn` accepts `file` on any call

**Workaround.** The host refuses a `file` on anything but `studio.upload`
(`invalid-argument`). **Proposal.** Tighten `isHostIn` so only `studio.upload` calls may carry
`file` (main never sends it elsewhere, so nothing breaks).
