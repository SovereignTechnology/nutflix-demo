# Contract requests — lane N2-nut13-desktop (issue #3, ADR 0016, against the frozen seam `packages/core/src/wallet/recovery-api.ts`)

No item blocks the lane: each is worked around in the desktop as described, and the desktop
takes lane N1's code only through `RecoveryCore` (`packages/app-desktop/src/host/recovery/core.ts`,
the WIRING POINT the orchestrator fills at merge).

## 1. No "entropy from bytes" on `RecoveryPhrases`

**Need.** The sealed file and the relay copy hold the entropy as 32 hex characters
(`RecoveryRelayCopy.entropy`), and the seam brands a `RecoveryEntropy` only through `generate`,
`fromIndices` and `fromWords`. Reading a copy back therefore has no seam method.

**Workaround.** `entropyFromHex` (`recovery/core.ts`) checks exactly 16 bytes and brands them — the
ONE place the desktop does so; core still validates what it is handed (`toSeed`, `toIndices`).

**Proposal.** `RecoveryPhrases.fromEntropy(bytes: Uint8Array): RecoveryEntropy` (throws
`RecoveryPhraseError('length')`), or `fromRelayCopy(copy: RecoveryRelayCopy)`.

## 2. A restore needs this device's own phrase first

**Need.** ADR 0016 §5: a new or reinstalled device restores from the relay copies or typed words.
The seam's `restoreFromSeed` lives on `SeededWallet`, which exists only over connections that
carry THIS device's `SeedMaterial`. So a device without its own phrase cannot restore.

**Workaround.** The desktop refuses restore until the device's phrase is set up (`invalid-argument:
set up this device’s recovery phrase first`); the Settings section disables Restore and says so.
Setting up on a new device costs nothing (no balance to reissue) and matches D3 (a device always
makes its own phrase).

**Proposal.** A restore entry that does not need the wallet to be seeded — e.g. `restoreFromSeed`
on every `CashuWallet` (core then writes restored proofs as it does today; nothing is derived from
`seed` afterwards, as the seam already says).

## 3. The connections' seed option and where `CashuWallet.seeded` looks for it

**Need.** The seam says "`new CashuMintConnections({ request, seed })` takes it, and every
`CashuWallet` over those connections then exposes `seeded`". The desktop keeps ONE connections
constructor (money.ts, pinned by `mint-transport.test.ts`: the money plane is the only way the
desktop reaches a mint), so it cannot take a factory from N1.

**Workaround.** `RecoveryCore.seedOption(material)` returns the option object spread into that one
constructor call (the wiring point returns `{ seed }`), and the plane now hands `CashuWallet` the
connections INSTANCE itself (its `wallet()` wrapped in place for the plane's `loaded` set), so a
`seeded` getter that reads the seed through the wallet's `mints` finds it. A seed the wallet did
not take (a renamed option) is caught at open: logged as an error, wiped, status `unreadable` —
never a silent "covered".

**Proposal.** Export the option type (`CashuMintConnectionsOptions` with `seed?: SeedMaterial`) so
the wiring point is type-checked, and confirm `CashuWallet.seeded` reads the seed from
`options.mints` when it is a `CashuMintConnections`.

## 4. Closing waits before the seed is wiped

**Need.** ADR 0016 §2: "Closing marks the counter source closed, waits until the Spender's
per-mint locks are idle, and only then wipes the seed." The desktop's `MoneyPlane.close()` is
synchronous (it is called from the signer's plane swap, as today) and wipes the seed there.

**Workaround.** The seam's `RecoverySeed.wipe` contract: "core refuses to derive from it
afterwards" — an operation in flight then fails instead of deriving from zeros. The worker is
stopped around every plane swap (`host.ts` `swap` → `worker.restart`), so no PAY is being built by
then; a host-side operation on the old plane (the user's melt, an auto top-up) can still be in
flight, and it is what item 4 protects (its journal entry is settled at the next open, as for any
interrupted operation — ADR 0014).

**Proposal.** N1 checks `seed.wiped` at DERIVATION time (not only at construction), and offers an
`idle(): Promise<void>` (or `close(): Promise<void>`) on the seeded wallet so a later desktop
change can await it before wiping.

## 5. `RecoveryPhraseError` is only a type

**Need.** The seam names `RecoveryPhraseError` ("names the problem only") but exports only
`RecoveryPhraseProblem`. The desktop reports the problem of a typed phrase that core refused.

**Workaround.** It reads `.problem` structurally and allow-lists `length` / `word` / `checksum`,
else `invalid` — never the message.

**Proposal.** Export the class (with `readonly problem: RecoveryPhraseProblem`).

## 6. (Not a contract — for the orchestrator) `@scure/bip39` in app-desktop's package.json

The prompt page bundles `@scure/bip39`'s English wordlist and `validateMnemonic`
(`scripts/bundle.ts`, allow-listed there), and tests import it. It resolves today through core's
exact, hoisted `2.0.1` (one deduped copy, `npm ls`). Declaring it in
`packages/app-desktop/package.json` needs a `package-lock.json` update, which is outside this
lane's allowlist. Proposal: add `"@scure/bip39": "2.0.1"` to app-desktop's dependencies at merge
(same tarball and integrity; `npm run check:native` unaffected — it is pure JS).
