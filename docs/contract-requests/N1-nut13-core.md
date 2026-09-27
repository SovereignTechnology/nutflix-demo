# Contract requests — lane N1-nut13-core (issue #3, ADR 0016, against the frozen `packages/core/src/wallet/recovery-api.ts`)

No item blocks the lane: each is worked around in core as described. Lane N2 (desktop) builds
against the same seam and should read items 1, 3, 4 and 5.

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

**Proposal.** Say so in the seam's `SeedMaterial` comment.

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
