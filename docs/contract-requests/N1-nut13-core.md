# Contract requests — lane N1-nut13-core (issue #3, ADR 0016, against the frozen `packages/core/src/wallet/recovery-api.ts`)

No item blocks the lane: each is worked around in core as described. Lane N2 (desktop) builds
against the same seam and should read items 1, 3, 4, 5 and 7. Item 7 (added after the independent
review, 2026-09-27) also asks Cameron for a decision.

## 1. `RecoveryPhrases` has no way back from stored entropy

**Need.** ADR 0016 D2: the shell seals the 16-byte entropy on disk and writes it, as 32 hex
characters, into the relay copy (`RecoveryRelayCopy.entropy`). Reading either back needs a
`RecoveryEntropy`, and the seam says "Only core's `seed.ts` makes one" — but `RecoveryPhrases`
makes one only from a CSPRNG (`generate`), from word indices or from typed words. The shell would
have to cast (`bytes as RecoveryEntropy`), skipping the length check and the copy into secure
memory.

**Workaround.** `seed.ts` exports three functions next to `recoveryPhrases` (re-exported by the
package's `wallet` namespace):

- `entropyFromBytes(bytes)` — exactly 16 bytes, copied into `sodium_malloc` memory; the caller's
  buffer is left alone (it zeroes its own plaintext); anything else throws
  `RecoveryPhraseError('length')`;
- `entropyFromHex(hex)` — exactly 32 lower-case hex characters (the relay copy's form), into
  secure memory; anything else throws `RecoveryPhraseError('length')`;
- `entropyToHex(entropy)` — for writing the relay copy.

**Proposal.** Add them to the interface: `fromEntropy(bytes: Uint8Array): RecoveryEntropy`,
`fromHex(hex: string): RecoveryEntropy`, `toHex(entropy: RecoveryEntropy): string`.

## 2. `RestoreOutcome` cannot say "some proofs are PENDING"

**Need.** ADR 0016 §5 step 5: "Keep UNSPENT proofs (and PENDING ones, marked)". The seam's
`RestoreReport` has no field for them, and `ProofStore` has no "marked" state.

**Decision taken.** PENDING proofs are left out of the restore (a melt in flight decides them: if
it fails they read UNSPENT again and the next restore adds them; if it pays they are gone). The
report counts only what was added.

**Proposal.** `RestoreReport.pendingSats?: Sats` if the UI should say "n sats are still in flight
at this mint; restore again later".

## 3. `CounterStore` — what `load()` returns for a file that does not parse

**Need.** The seam says `null` means "no state (first use, or lost — core then probes before
deriving)". It does not say what a corrupt file should be.

**Decision taken (fail closed in core).** A value that is not a `CounterState` (version 1, hex
keyset ids, counters in `[0, 2^31]`) makes every seeded reservation throw
`CounterStateError('malformed')`: the wallet can still receive nothing into seeded outputs until
the shell fixes it. `isCounterState` is exported for the shell's parser.

**Proposal (for the shell).** Move an unparseable counters file aside and answer `null`: core then
probes every keyset before deriving from it (NUT-09, from the stored cursor or 0), which is safe;
and one `CounterStore` OBJECT per identity per process (see 4).

## 4. `SeedMaterial` lifecycle is not stated

**Need / what core does.**

- `CashuMintConnections` keeps ONE live counter source per `CounterStore` object: connections
  built twice from the same `SeedMaterial` (a reconnect) share it, so they never hand out one
  counter twice. Two different `CounterStore` objects over the same file would each get their own
  source and could hand out the same counters: the shell must keep one per identity.
- `CashuWallet.close()` closes that shared source and wipes `SeedMaterial.seed` — for every wallet
  over the same material. A wallet reopened afterwards needs a fresh `toSeed(entropy)`; over the
  same `CounterStore` object it gets a fresh source that starts from disk. Reopen only after
  `close()` resolved.
- `DurableCounterSource` is exported as a type only; reach it as `connections.seeding.counters`.

- (Independent review 2026-09-27, finding 3.) The counters file is BOUND to its phrase: core writes
  a `published` entry `ff<32 hex>` → 0 (a keyed BLAKE2b tag of the seed, libsodium). A file bound to
  another phrase reads as no state (every keyset probed from 0) and is taken over by the first save;
  a closed source never writes over a file another phrase took over. A `CounterStore` object whose
  live source belongs to another phrase is refused: `new CashuMintConnections({ seed })` throws
  `invalid-argument` ("…in use by a wallet of another recovery phrase: close it first"). So a
  rotation (D5) must close the old wallet before building the new connections, or use a new
  counters file.
- Probing is per operation: the counter source asks only the mint an operation runs at, one batch
  (finding 2). Nothing registers probes at wallet load any more.
- (Fix round 7.) **Call `CashuWallet.restoreUnpublished()` at every start.** The startup hold is
  the counter source's own, from the counters file's first load: a keyset whose stored
  `[published, next)` was not empty keeps its `published` watermark until a startup restore scans
  that range whole. Operations may run before it (in this wallet object or another over the same
  connections) without losing the range; nothing has to be ordered. But a shell that never calls
  it never moves those watermarks, and the next start's range only grows.

**Proposal.** Say so in the seam's `SeedMaterial` comment, and keep one counters file per phrase
(for example `counters-<pubkey>-<device id>.json`, the relay copy's random id) — core's binding
then never has to take a file over.

## 5. `MintConnections.seeding` must be forwarded by a wrapper (not a seam type — for N2)

`packages/app-desktop/src/host/money.ts` wraps its `CashuMintConnections` in
`{ wallet: (mint) => conns.wallet(mint).then(…) }`. Once N2 passes `seed`, that wrapper must also
forward `seeding: conns.seeding`. Core refuses to operate on a seeded cashu-ts wallet whose
context lost its seeding (`invalid-argument`, "a MintConnections wrapper must forward it"), so the
omission fails the first top-up loudly instead of making random outputs; `GatedCashuWallet` then
exposes `seeded`, and `close()` wipes the seed.

## 6. `scripts/vendor-docs.sh` does not know NUT-07, NUT-09, NUT-13 (outside this lane)

The three specs and `tests/13-tests.md` are vendored from `cashubtc/nuts@8bde3c0` (fetched
2026-09-26) with their rows in `docs/vendor/MANIFEST.txt`. The script rewrites the manifest from
its own list, so its next run would drop those rows (the files would stay). **Proposal:** add
`07 09 13` to its NUT loop and fetch `tests/13-tests.md` as `NUT-13-tests.md`.

## 7. Restores need a "not finished" outcome, a resume cursor, and a decision on the bound (independent review 2026-09-27)

**Need.** The review found (high) that a restore stopped by the batch cap (ADR 0016 §5: 200 batches
of 100 per keyset) read as complete: `RestoreOutcome` has no "partial". A viewer who streams a lot
passes 20 000 counters on a keyset quickly (the reviewer measured about 1.1 counters per seeded
send, two sends per PAY, a PAY every 4 blocks: roughly 17 000 counters per hour of 5 Mbit/s video
with the default window). Past that, a restore from the words stopped short and said `restored` or
`nothing`.

**What core does now (no seam edit).**

- **This device's own phrase** is scanned at least to its counters file's `next` for each keyset,
  whatever the gaps or the cap; the cap and the three-empty-batches rule apply only past it. That is
  ADR 0016's first loss case (the relays dropped the 7375 events), fixed without any decision.
- **The startup restore** scans all of `[published, next)` newest first, with no cap (the range is
  this device's own file, not a mint's answer).
- **Any other scan the cap stops** is reported: `CashuWallet.seeded.restoreFromSeed` returns
  `RestoreDetail` (a `RestoreReport` plus `resume?: Record<keysetId, counter>`), and takes
  `{ resume: Map<MintUrl, Record<keysetId, counter>> }` as a fourth argument to continue where it
  stopped. `CashuWallet.seeded` is typed `CoreSeededWallet` (extends `SeededWallet`). With nothing
  restored, an unfinished scan is never reported `nothing`: `refused` when only the cap stopped it
  (ADR 0016 treats hitting the cap as a hostile mint), `unreachable` when a keyset or batch could
  not be asked.
- **(Fix round 7) What `resume` means, precisely.** Each entry is a counter a restore continues
  UPWARD from. At a mint with an entry, a resumed call scans only the keysets the entry names; a
  mint without one is scanned from the start; an empty entry is refused. The 32-keyset cap is
  reported the same way as the batch cap: each keyset it leaves out is named at 0 (or at the
  counter a resumed call was given for it), and a resumed call reaches it even when it sorts past
  the cap, at most 32 keysets per call. On a report of `CashuWallet.restoreUnpublished()` (the
  startup restore), `resume` names the LOW end of each `[published, next)` range left unfinished,
  so `restoreFromSeed(<this device's own phrase>, …, { resume })` covers the whole range. Calling
  `restoreUnpublished()` again covers it too, and only that call releases the watermark hold
  (item 4).

**Proposal (seam).** Add `'partial'` to `RestoreOutcome` and `resume?: Readonly<Record<string,
number>>` to `RestoreReport`, and an optional `resume` to `SeededWallet.restoreFromSeed`. N2 should
offer "continue restoring" when `resume` is present, keeping the cursor in the host (the renderer
only names the action). For a startup-restore report, "continue" means `restoreFromSeed` of this
device's own phrase with that `resume`, or `restoreUnpublished()` again. It must not use any other
phrase.

**Decision for Cameron.** A hostile mint and an honest long history look the same to a scan from
counter 0 (both keep returning signed outputs; a hostile mint can sign anything under its own keys,
DLEQ included, and call it spent). So no rule can bound the first without bounding the second; the
reviewer's "stop after N batches with nothing verified and unspent" would stop an honest heavy
history too (its old batches are all spent). What each option costs:

1. **Keep 200 batches per call, resumable (what core does now).** A heavy user's restore from the
   words is many calls, each one explicit.
2. **Raise the per-call cap** (for example 2 000 batches, 200 000 counters: about 10 hours of heavy
   streaming). This makes a hostile mint's slow restore ten times slower too.
3. **Checkpoints in the relay copy.** After a reissue (D5), every held proof sits at or above a
   known counter. A `from` per keyset in the relay copy (kind 30078, NIP-44 to self, D2) would let a
   restore start there instead of at 0, so its length is the history since the last reissue. This
   needs a `RecoveryRelayCopy` change and a periodic, fee-paying reissue.

