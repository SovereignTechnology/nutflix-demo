# 16. A wallet rebuilt from twelve words: NUT-13 seed backup

Date: 2026-09-25

## Status

Accepted 2026-09-25 with Cameron's answers (below), which differ from the draft's
recommendations on D2 and D3. Core implemented 2026-09-26 (lane N1-nut13-core, see Implementation
notes at the end); the desktop is lane N2. Cameron (2026-09-24, issue #3): NUT-13 seed
backup is in Stage 3, design and ADR first, then his multiple-choice answers before any code.
This builds on ADR 0014 (write-ahead journal + NUT-09 restore) and replaces none of it.

## Decisions (Cameron, 2026-09-25)

- **D1 seed source: a new 12-word BIP-39 phrase** (a), shown once in main's prompt window.
- **D2 storage: this device AND an encrypted relay copy** (a + b). The phrase is sealed on this
  device as in D2a, and the same entropy goes to the user's relays in a kind 30078 event,
  NIP-44-encrypted to self. Accepted with its cost: an nsec compromise (or a future NIP-44
  break) exposes every future seeded output of that phrase until it is rotated (D5's reissue
  under a new phrase; a NIP-09 deletion of the old copy is best effort).
- **D3 devices: one phrase per device** (b). Each device generates its own phrase and derives
  from counter 0 in the whole counter space: no slots, no slot registry, no allocation probe.
  With D2's relay copies, the nsec plus the relays recover every device's phrase; without
  relays, each device's words are needed.
- **D4 library: pin `@scure/bip39` 2.0.1** (a), added to the locked allowlist.
- **D5 existing balance: reissue once into seeded outputs** (a).
- **D6 scope:** not asked; as recommended (desktop only; the NIP-60 wallet key is not derived
  from the seed).

What this changes in the proposed design below (the rest stands):

- §3 Counters: one device, one phrase, so counters start at 0 and run to the v1 hardened limit
  (2^31); the lease-ahead file, the `published` watermark and the collision guard stay; the slot
  registry and the per-slot probe go (a probe remains only when the counters file is missing).
- The relay copy: kind 30078, `d` = `nutflix/nut13/<device id>` (a random id per phrase, no
  other identifier), content NIP-44 to self holding `{ v, entropy, created }`. Written when the
  phrase is created or rotated, read only by an explicit restore, never at startup.
- A device never adopts another device's phrase for new outputs. A new or reinstalled device
  generates its own phrase; phrases found on relays or typed in are used only to restore.
- §5 Restore: the phrases are this device's, every relay copy the signed-in identity can
  decrypt, and any typed phrase; each is scanned from counter 0 per keyset.
- Threat table: "the phrase or seed in backups" now includes the relay copy, protected only by
  the nsec (accepted, above).

## Context

ADR 0014 fixed F31 without a seed: a lost mint answer is restored from the journaled outputs.
What is still lost today, and what a seed would change:

| Loss | Today | With a seed |
| --- | --- | --- |
| Relays drop the 7375 token events (retention, deletion, all relays gone) | proofs gone | restored from the words |
| Desktop crash while relays are unreachable: swapped proofs wait in `Nip60ProofStore`'s **in-memory** outbox (see Related findings 1) | proofs gone | restored |
| Desktop crash between a lost mint answer and its recovery (ADR 0014 residual: the desktop journal is in memory) | outputs gone | restored |
| Melt change whose answer is lost (ADR 0014 residual: not journaled) | change gone | restored |
| Device lost together with the nsec | whole wallet gone | ecash restored; the 17375 wallet key, the 7376 history and unredeemed nutzaps are not |
| Nostr key lost, device kept | wallet unreadable (17375 and 7375 are NIP-44 to that key) | ecash restored into a new wallet |

**NUT-13** (not vendored; read from `cashubtc/nuts` `13.md` on 2026-09-25):

- A 12-word BIP-39 mnemonic gives the `seed`.
- `secret` and blinding factor `r` come from (seed, keyset id, counter):
  - keyset v2 (`01…` ids): `HMAC-SHA256(seed, "Cashu_KDF_HMAC_SHA256" ‖ id ‖ u64be(counter) ‖
    0x00 | 0x01)`, `r` reduced mod n;
  - keyset v1 (`00…` ids, deprecated but still common): BIP-32
    `m/129372'/0'/{id mod 2^31−1}'/{counter}'/{0|1}`. The counter is a hardened index, so it
    must stay below 2^31.
- The wallet MUST keep one counter per keyset and never reuse one.
- Restore: batches of 100 blinded messages to NUT-09 `/v1/restore`, stop after three consecutive
  empty batches, check NUT-07 states and drop spent proofs.
- It warns that wallets sharing a seed produce identical secrets.
- It also defines a P2PK key path, `m/129373'/10'/0'/0'/{counter}` (optional).

**`@cashu/cashu-ts` 4.10.0** (read from `lib/types/index.d.ts`, `lib/cashu-ts.es.js` and
`docs-src/deterministic_counters.md`):

- What it has:
  - `new Wallet(mint, { bip39seed, secretsPolicy, counterSource, counterInit })`;
  - `CounterSource` `{ reserve, reserveAt?, advanceToAtLeast, snapshot?, setNext? }` (`reserveAt`
    optional in v4, required in v5), `createEphemeralCounterSource`, `wallet.counters`,
    `wallet.on.countersReserved`;
  - `OutputType` `{ type: 'deterministic', counter }` (counter 0 = reserve from the source);
  - `OutputData.createDeterministicData`, `deriveSecretAndBlindingFactor` (v1 and v2 keysets);
  - `wallet.restore(start, count, { keysetId })`,
    `wallet.batchRestore(gapLimit = 300, batchSize, counter = 0, keysetId)`, `checkProofsStates`.
- Sharp edges found in the code:
  - **Seeding half-switches the wallet.** With a seed and the default `secretsPolicy: 'auto'`,
    every call that relies on the default output type turns deterministic. In `spend.ts` that is
    receive, mint and melt. A send's change stays random, because `spend.ts` passes
    `keep: { type: 'random' }`. Passing a seed to `CashuMintConnections` alone is not enough.
  - **`restore` trusts the mint's amounts.** It takes each output's amount from the mint's
    answer, checks a DLEQ only when the mint sends one (it ignores `requireSigDleq`), and returns
    spent proofs too (no NUT-07).
  - **`batchRestore`'s defaults do not match the spec.** The batch size is the mint's
    `max_array_length` or 500, and `ceil(300 / 500) = 1`, so ONE empty batch ends the scan.
    Call it with `(300, 100)` to get three empty batches of 100.
  - **The seed is held by reference** (`this._seed = bip39seed`). Wiping it while an operation
    runs makes the next outputs derive from zeros: ecash that anyone can restore.
  - It has no BIP-39 code (generating, checking or turning a mnemonic into a seed) and no NUT-13
    P2PK path.

**BIP-39:**

- `@scure/bip39` 2.0.1 is already installed and in `package-lock.json` as an exact dependency of
  nostr-tools 2.25.2. It is hoisted to `node_modules/@scure/bip39`, with its own
  `@noble/hashes` 2.0.1 nested. No workspace package depends on it directly.
- Its README states an independent audit (Cure53, at v1.0.0, January 2022).
- `nostr-tools/nip06` wraps it (`generateSeedWords`, `validateWords`), but it never returns the
  BIP-39 seed, only Nostr keys at `m/44'/1237'`.
- The locked files may import only cashu-ts, nostr-tools, sodium-universal, compact-encoding and
  `@sovit/core` (SECURITY.md §locked, `scripts/check-locked-dirs.sh`).

**Constraints:**

- Libraries only, no crypto of our own.
- `spend.ts` and `signer/` are locked.
- The renderer never sees a secret, and the prompt window's questions are data-only (ADR 0013).
- A NIP-60 wallet is multi-device.
- The web shell persists nothing (SECURITY.md invariant 8).

## Decisions to make

### D1. Where the seed comes from

- **a. A new 12-word BIP-39 phrase, shown once.**
  - For: standard and interoperable (other Cashu wallets restore it, at least slot 0, see D3);
    independent of the relays and of the nsec.
  - Against: one more thing to write down; a leaked phrase is a leaked balance.
- **b. Derived from the Nostr key.**
  - For: nothing new to keep.
  - Against:
    - impossible with a NIP-46 key: a bunker offers no key derivation, and its signatures and
      NIP-44 output are randomised;
    - needs a derivation scheme we would invent, which ADR 0014 already refused;
    - losing the nsec loses both;
    - it is not "words alone" unless the nsec itself came from NIP-06 words, and ours do not
      (`generateSecretKey`).
- **c. From the NIP-60 wallet event** (a new row in kind 17375, or its `privkey` used as the seed).
  - For: travels with the wallet to every device.
  - Against:
    - it cannot be recovered when the relays or the nsec are lost, the two losses a backup
      exists for;
    - 17375 is replaceable, and other NIP-60 clients rewrite it without our unknown row;
    - using the P2PK key as an HMAC key gives one key two jobs.

**Recommendation: a.** English wordlist, 128 bits (12 words, as NUT-13 says), empty BIP-39
passphrase (other Cashu wallets do not ask for one).

### D2. Where it lives at rest, and how a second device gets it

- **a. This device only.**
  - `<userData>/wallet/recovery-<pubkey>.sealed` holds the 16-byte entropy (so the words can be
    shown again). It is NIP-44-encrypted to self through the signer, as the daemon's
    `selfCipher` does, and written 0600 in a 0700 directory (`private-file.ts`).
  - This works the same for passphrase, keychain and NIP-46 unlocks.
  - A second device gets the seed only when the user types the phrase there.
  - For: the seed never touches a relay. Against: 12 words to type on each extra device.
- **b. Also a relay copy.** The same ciphertext goes into a kind 30078 event (NIP-78 app data,
  `d` = `nutflix/nut13`), so every device of the identity picks it up.
  - For: multi-device with no effort.
  - Against: the ciphertext is public and permanent. An nsec compromise, or a future break of
    NIP-44, exposes every FUTURE seeded output (not only today's balance) until the phrase is
    rotated.
- **c. In the key file** (key-file v2 with a third slot, under argon2id).
  - Against: local signer only, so NIP-46 users need (a) anyway; it also needs a new key-file
    version in the locked signer.

**Recommendation: a.**

### D3. Counters across devices

- **a. One phrase, a counter slot per device.**
  - The counter space is 16 slots of 2^27 counters: `16 × 2^27 = 2^31`, which fits the v1
    hardened limit.
  - The first device takes slot 0. Any Cashu wallet restoring the phrase scans from 0, so a
    single-device user keeps full interoperability.
  - Allocation checks two things before claiming a slot:
    - a slot registry: kind 30078, `d` = `nutflix/nut13-slots`, NIP-44 to self, holding no
      secret: a random device id, its slot and its high-water marks;
    - a probe: the slot's first 100 counters restored at each known mint.
  - A device restored from the phrase always takes a fresh slot.
  - Restore scans all 16 slot starts.
  - For: one phrase covers every device, with no relay write per payment.
  - Against: registry and probe code; other wallets find slot 0 only.
- **b. One phrase per device.**
  - For: no coordination at all.
  - Against: a phrase per device to write down, and rebuilding everything needs all of them.
- **c. One phrase, counters synced over Nostr** (publish before each reservation, or lease blocks).
  - Against:
    - relays have no compare-and-swap, so two devices still race;
    - a relay round trip per PAY is exactly what ADR 0014 refused;
    - leases longer than the gap limit break restores in other wallets.
- **d. Only one device holds the phrase; the others use random outputs.**
  - For: simplest. Against: nothing made on another device is covered.

**Recommendation: a.** A device without the phrase uses random outputs, and the UI says that
device is not covered. That includes a device where it was not typed yet, and the web shell,
which may not persist counters.

### D4. The BIP-39 library

- **a. Pin `@scure/bip39` 2.0.1** as a direct dependency of `@sovit/core` and add it to the
  locked allowlist (SECURITY.md, `check-locked-dirs.sh`). The phrase code goes in a new locked
  file, `packages/core/src/wallet/seed.ts`.
  - For: no new code enters the tree (the same tarball and integrity hash are already locked),
    and the library is audited.
  - Against: the allowlist grows by one, and a nostr-tools bump could later split it into two
    copies.
- **b. Phrase code outside the locked files.**
  - Against: the most sensitive new code would sit outside owner review.
- **c. No phrase: a 64-hex seed.**
  - Against: other wallets cannot restore it, and it is easy to copy by hand wrongly.

**Recommendation: a.** Only `generateMnemonic(english, 128)`, `validateMnemonic`,
`entropyToMnemonic` / `mnemonicToEntropy` and `mnemonicToSeed` are used.

### D5. The balance held today

- **a. Reissue once.** Right after setup, swap every held proof at each mint into seeded outputs.
  This is a new `Spender` operation, and the mint's input fee is shown before it runs.
  - For: the whole balance is covered from day one.
- **b. Only new outputs.**
  - For: no fee.
  - Against: today's proofs cannot be recovered from the words until they are spent, and a large
    idle balance may never be.

**Recommendation: a.** The same operation rotates a leaked phrase (reissue under a new one).

### D6. Scope

- **The seeder daemon and the gateway: not now.**
  - Each is a single device with a sealed wallet file and a durable journal, and payouts sweep
    earnings off the server.
  - Adding it later is small: the seed in its key file, and the counters in the sealed file,
    in the same fsynced write as the journal.
- **The NIP-60 wallet key from the seed (NUT-13's P2PK path): not now.**
  - cashu-ts does not implement it, so it would need `@scure/bip32` in a locked file.
  - It would also change the user's nutzap key (kind 10019).
  - So the phrase recovers ecash, not the 17375 key: nutzaps locked to that key and not yet
    redeemed still need the nsec.

**Recommendation: as stated.** Cameron can widen either.

## Proposed design (with the recommendations)

### 1. The phrase

- **Created** with the NIP-60 wallet (ADR 0013 §5, "a brand-new key"), or later from
  Settings › Wallet › Recovery phrase for an existing wallet, which then runs D5.
- **Generated** in the host (`seed.ts`), never in main or the renderer.
- **Shown once** in main's prompt window:
  - a new form, `recovery-show { words: number[12] }`, carries word indices 0–2047, not text;
  - the page maps them through its own bundled English wordlist, so the window stays data-only
    and nothing upstream can put prose in it;
  - a confirmation, `recovery-confirm { positions }`, asks for three random words, checked like
    passphrases;
  - "Later" is allowed, and the wallet then shows "backup not confirmed".
- **Shown again** only through the prompt window after re-authentication (the passphrase for a
  local key, main's native confirm otherwise), so a compromised renderer cannot reveal it.
- **Restored** by typing it in the prompt window (`recovery-restore`):
  - 12 fields autocomplete from the page's wordlist, the matches drawn inside the page (never a
    native `<datalist>` popup, which is its own window and outside content protection; round 8);
  - the checksum is checked in the page, in main and in the host;
  - the renderer can only name the action, throttled like connect (ADR 0013 §7).

### 2. The seed in the host

- `mnemonicToSeed` gives 64 bytes. They are copied into a secure buffer and the library's copy
  is wiped. The phrase strings (in main, the prompt page and the NIP-44 plaintext) cannot be
  wiped: a documented residual, as in ADR 0013 §3.
- `CashuMintConnections` takes `{ seed, counters }` and builds every cashu-ts `Wallet` with:
  - `bip39seed`;
  - one shared `counterSource`;
  - an explicit `secretsPolicy`: `'deterministic'` when seeded, `'random'` otherwise, never
    `'auto'`.
- Only the host holds the seed. The worker and the renderer never do.
- **Closing** marks the counter source closed (`reserve` then throws), waits until the Spender's
  per-mint locks are idle, and only then wipes the seed.

### 3. Counters

- `DurableCounterSource` (`seed.ts`) implements cashu-ts `CounterSource`, including `reserveAt`.
  - It is keyed by keyset id across all mints, so two mints announcing the same id still cannot
    make a secret repeat.
  - It is confined to this device's slot.
- **Lease ahead.** Before handing out a range, it persists `next + 32` in
  `<userData>/wallet/counters-<pubkey>.json` (0600; temp file, fsync, rename).
  - A crash burns at most 32 counters, well under the gap limit.
  - That is one fsync per ~32 outputs, not one per PAY.
- **A `published` watermark per keyset** is set to `next` whenever `Nip60ProofStore.unsynced()`
  reaches 0.
  - At startup, `[published, next)` is restored: one small NUT-09 call per keyset.
  - This recovers what died with the in-memory outbox or the in-memory journal.
- **Probe** `restore(next, 100)` per active keyset, and advance past anything signed, when:
  - the counters file is missing;
  - the slot is new;
  - the registry shows another device on this slot.
- **Registry updates.** The high-water marks are published at enrollment, and at most hourly
  while they grow. A restore scans to the high-water mark or the last signature, whichever is
  higher, plus the gap.

### 4. `spend.ts` (locked; CODEOWNERS review)

- **Output types are explicit per operation.**
  - When seeded, these outputs are deterministic (counter 0, reserved from the source): a send's
    change, and the outputs of receive, mint and melt.
  - A send's P2PK outputs stay `p2pk`: NUT-13 derives no NUT-10 secret.
- **Collision guard:**
  - A **fresh** operation answered "already signed" (10002) hit a counter collision; it is not
    our own earlier attempt. The entry is dropped, the counter advanced past it (probe), and the
    operation retried once with new counters. ADR 0014 §3's "already signed ⇒ restore" now
    applies only to a retry of a journaled operation.
  - A restore is committed as executed only when the mint also shows the operation ran:
    - a swap's inputs are SPENT (NUT-07; a receive's input secrets are in `PendingOp.key`);
    - a mint's quote is ISSUED.
    Otherwise the signatures belong to another use of those counters. Without this check, a
    collision could make the wallet drop inputs that are still unspent.
- **`restoreFromSeed(mint, plan)`** runs the scan in §5 under the mint's lock, after settling its
  journal.
- `PendingOp.id` (the first `B_`) stays unique only while counters never repeat. Its comment,
  "(random, so unique)", changes.

### 5. The restore flow

1. **Mints.** 17375's list, Settings' mints, and URLs typed into the restore window (https,
   `normalizeMintUrl`). The words alone do not say which mints were used.
2. **Per mint.**
   - It must advertise NUT-09; otherwise it is reported as "cannot restore here".
   - Its keysets: every hex-id keyset of unit `sat`, active or inactive, at most 32.
3. **Per keyset and slot** (the registry's slots, or all 16 starts):
   - `batchRestore(300, 100, slotStart, keysetId)`: three empty batches of 100, as in the spec;
   - it continues past the registry's high-water mark when that is known;
   - at most 200 batches per keyset.
4. **Check** every restored signature:
   - its id and amount match what was asked;
   - a NUT-12 mint must include a DLEQ. cashu-ts checks it against the key of the CLAIMED amount,
     so an amount lie fails;
   - at a mint without NUT-12, restored proofs are swapped into fresh outputs before they count.
5. **NUT-07.** Keep UNSPENT proofs (and PENDING ones, marked) and drop SPENT ones.
6. **Commit** one `WalletTx` per mint:
   - `added` = restored minus held (matched by secret);
   - `spent` = held proofs that NUT-07 reports spent;
   - history: in, "restored from recovery phrase".
   `Nip60ProofStore` writes it as a 7375 and a 7376 like any other transition.
7. **Counters.** This device's slot advances to the last signature + 1. A device restored from the
   phrase takes a fresh slot (D3).
8. **Report** per mint: the sats restored, and mints that were unreachable or unsupported.

### 6. Relation to NIP-60 and to ADR 0014

- The 7375 events stay the live record, and the phrase is the disaster path. Restore dedupes by
  secret, so nothing counts twice.
- The 7376 history cannot be rebuilt, since the mint has no memos. A restore adds one line.
- The journal stays the fast, exact path: no scan, same session.
  - Its entries now hold seeded outputs, in the same format.
  - Retries still reuse journaled outputs, so no counter is burned twice.
  - The desktop journal's in-memory residual and the melt-change residual are covered by the
    `[published, next)` restore.
- Nothing about the seed or the counters goes into 17375 or 7375.

### 7. UI and IPC

- **Shell methods** `desktop.wallet.recovery.{status, setup, show, restore}`. The renderer names
  an action only.
- **Prompt forms** `recovery-show`, `recovery-confirm`, `recovery-restore`, `recovery-reauth`.
- **Status:** covered, not confirmed, or not on this device.
- No change to the `Wallet` contract. `CashuWallet` gains host-only `restoreFromSeed` and
  `reissue`.

## Threats

| Threat | Mitigation |
| --- | --- |
| The renderer sees the phrase or the seed | Never sent there. Shown and typed only in main's prompt window (own origin, devTools off). Words travel as indices, mapped by the page's own wordlist. The renderer only names an action, throttled. |
| The phrase in logs | Nothing on the phrase path logs a value; errors are codes. The desktop `redact()` misses word phrases (Related findings 3): add a rule and a canary test. |
| The phrase or seed in backups | The sealed file is NIP-44 to self: useless without the nsec. The counters file holds no secret. No relay copy (D2a). |
| Screenshots, screen sharing | `setContentProtection(true)` on the prompt window while the words show (macOS/Windows; Linux has none, and the window says so). No copy button. Words hide after 2 minutes or on blur. Typed-word suggestions are the page's own DOM: protection is per window, and Chromium draws a `<datalist>` popup as a window of its own (round 8). |
| Clipboard | No copy in "show". Paste is allowed in "restore" (password managers). |
| Memory | The seed is in a secure buffer. The phrase strings cannot be wiped (residual). |
| Wiping the seed under a running operation | Close waits for the Spender's locks before wiping; `reserve` throws after close. |
| Counter reuse after a crash | Lease ahead, fsynced before use. Probe when the counters file is missing. |
| Counter reuse between two devices | Slots, the registry, the probe, and the collision guard. |
| The same phrase restored elsewhere while this device runs (another wallet, or ours) | A device restored by us takes a fresh slot. Another wallet on slot 0 collides: the guard advances and retries, and nothing is lost. |
| Two mints with one keyset id | Counters are keyed by keyset id across all mints. |
| Gaps that end a restore early | Leases of 32; failed operations burn few counters; our own restore scans to the registry's high-water mark. |
| Hostile mint: fake amounts | DLEQ required on NUT-12 mints, checked against the claimed amount's key. Otherwise the proofs are swapped before they count. |
| Hostile mint: claims spent, refuses restore | Cannot be defended (the mint holds the money anyway). Reported per mint. |
| Hostile mint: linking | A restore shows the mint every scanned `B_` and which ones it signed, so it can link all of them to one wallet. Full scans run only on an explicit restore; startup checks are small ranges. |
| Hostile mint: amplification | At most 32 keysets and 200 batches per keyset, with the transport's `maxBytes` response cap. |
| A hostile mint URL typed at restore | https only, `normalizeMintUrl`, no redirects (transport). |
| Phishing for the phrase | The app asks for it only in a prompt-window flow the user started. The renderer cannot open that window with its own text. |
| A leaked phrase | Equals theft of the balance at every mint used. D5's reissue under a new phrase rotates it. |

## Consequences (if accepted as recommended)

- **Tests:**
  - the NUT-13 test vectors through our wiring (v1 and v2 keysets);
  - counters never repeat: across a restart and a crash (lease), across two devices (slots),
    across two mints sharing an id;
  - the collision guard: a fresh 10002 is retried; a restore whose inputs are unspent is not
    counted as executed;
  - restore against the test mint, Nutshell and cdk: spent proofs filtered, DLEQ required, an
    amount lie refused, three empty batches end the scan;
  - the outbox-crash case is recovered;
  - close waits before it wipes;
  - the logger canary;
  - the prompt window never shows upstream text.
- Every PAY's change becomes seeded, and there is one fsync per 32 counters.
- **Residuals:**
  - the phrase strings cannot be wiped;
  - Linux has no screen-capture block;
  - mints without NUT-09 cannot be restored;
  - other wallets restore slot 0 only;
  - a full restore links the restored outputs at that mint;
  - a leaked phrase is a leaked balance until reissued.

## Related findings (not decided here)

1. **The desktop can lose proofs to a relay outage.** `Nip60ProofStore`'s outbox is in memory. A
   relay outage followed by a crash or quit loses proofs the mint already swapped. ADR 0014's
   residuals do not list this. §3's watermark restore covers it; sealing the outbox to disk
   would fix it independently.
2. **The payout note names the wrong fix.** `packages/seeder/src/runtime/payout.ts` names NUT-13
   as the fix for a crash between a payout's swap and its append. NUT-13 derives no P2PK secrets,
   so it would recover the change, not the payout.
   - The durable journal already holds the payout's locked outputs (`send`).
   - The real gap: a startup sweep restores them "only to account for them" and never hands them
     to `payouts.jsonl`.
3. **The desktop logger misses word phrases.** Its `redact()` catches hex, bech32 and base64
   runs, but not a space-separated word phrase. Proposed rule: 8 or more consecutive lowercase
   words of 3–8 letters become `<redacted>`.
4. **Specs not vendored.** NUT-07, NUT-09 and NUT-13, with its test vectors, are not in
   `docs/vendor`. Vendor them before any code.

## Questions for Cameron (answered 2026-09-25, see Decisions)

1. **Seed source:** new 12 words kept on this device (recommended), new 12 words plus an encrypted
   relay copy, derived from the Nostr key, or kept in the NIP-60 wallet event.
2. **Devices:** one phrase with a counter slot per device (recommended), one phrase per device, or
   only one device uses the phrase.
3. **Old balance:** swap it into backed-up proofs once (recommended), or cover only new payments.
4. **BIP-39 library:** pin `@scure/bip39` 2.0.1 and add it to the audited list (recommended), keep
   the phrase code outside the locked files, or no words (a 64-hex seed).

## Implementation notes (lane N1-nut13-core, core, 2026-09-26)

The decisions stand. Where the core implementation sharpens or departs from the design text, and
what the real-mint lane measured (details: `docs/lanes/N1-nut13-core.md`,
`docs/reviews/2026-09-26-pre-push-nut13-core.md`):

- **§4, the code of a collision.** Real mints do not answer "outputs already signed" with 10002:
  Nutshell 0.21.0 says 11003 "outputs already signed" (mint, swap, melt); cdk-mintd 0.18.1 says
  20006 "Invoice already paid or pending" on a mint or melt and 11008 "Duplicate outputs" on a swap.
  Core therefore does not trust the code: after any coded refusal of a seeded operation it asks
  NUT-09 once whether the operation's outputs are signed, and signatures send it through the
  NUT-07 check below. Both mints refuse a melt whose blanks are signed BEFORE they spend or pay.
- **§4, signatures that are not ours.** A restored signature for another amount or keyset under one
  of our outputs is another wallet's (a collision) when NUT-07 says the operation never ran, and a
  lie (the entry kept, as in ADR 0014) when it did.
- **§4, without a journal** (a store without `pending`; none in production) the guard falls back to
  the code/message ("already signed").
- **§3, probe.** Every keyset the counters file does not know is probed before its first
  derivation, not only when the file is missing (a keyset rotation too): ONE NUT-09 batch of 100
  from the cursor, at the mint the operation runs at and nowhere else, counting only signatures
  whose DLEQ verifies (at a NUT-12 mint); the cursor moves by at most 100. A seed that signed
  further meets a collision, and the guard moves past it. Cost: one request per keyset per device,
  which shows that mint the next 100 unsigned outputs of this device. (Independent review
  2026-09-27, finding 2: the first build asked every loaded mint, up to 200 batches, and took the
  furthest answer, so a mint announcing another mint's keyset id could push the cursor ~20 000
  ahead and break restores at the real mint.)
- **§3/§4, what may move the counters.** Only signatures a mint proves: the probe (one batch), the
  collision guard's skip-ahead (multi-batch at a NUT-12 mint, one batch without NUT-12), and a
  restore of this device's own phrase (DLEQ-verified signatures only).
- **§3, one source per store, one phrase per file.** `CashuMintConnections` keeps one live counter
  source per `CounterStore` object, and a stored lease never moves back (the store is re-read before
  each write; a lease another writer took moves the cursor past it). The counters file carries its
  phrase's binding (a `published` entry `ff…`: keyed BLAKE2b of the seed, libsodium); a file another
  phrase wrote reads as no state, so a rotated phrase (D5) starts at its own counter 0 (finding 3).
  The shell keeps one `CounterStore` object per identity, and should keep one file per phrase.
- **§3, startup restore.** `[published, next)` is scanned whole and newest first (the range is this
  device's file, so no cap is needed). A keyset whose range no mint finished keeps its watermark
  until a later startup restore finishes it (per keyset: one dead mint holds back only its own).
  The hold starts at the counters file's load, in the counter source, so it fails closed: an
  operation that finishes before the startup restore runs cannot mark the earlier range published
  (fix round 7). An unfinished startup restore reports the range's low end as `resume`, where an
  upward restore of this device's phrase covers it.
- **§2, wrappers.** A `MintConnections` wrapper must forward `seeding`; core refuses to operate on a
  seeded cashu-ts wallet whose context lost it (the desktop's money plane wraps its connections).
- **§5 step 4.** At a mint without NUT-12 everything unspent is swapped before it counts (one
  history line); dust the input fee would eat is left.
- **§5 step 5.** PENDING proofs are left out (the store has no "marked" state); a later restore
  adds them if the melt failed. Contract request `docs/contract-requests/N1-nut13-core.md` item 2.
- **§5 step 3, the batch cap (open for Cameron).** This device's own phrase is scanned at least to
  its counters file's `next`, whatever the gaps or the cap. Any other scan the 200-batch cap stops
  is reported, with where to resume (`RestoreDetail.resume`, never outcome `nothing`), because a
  hostile mint and an honest long history look the same from counter 0. The 32-keyset cap is
  reported the same way: each keyset it leaves out is named in `resume` at 0, and a resumed call
  scans only the keysets its resume names (fix round 7). Whether to keep the cap per
  call, raise it, or add checkpoints to the relay copy is contract request item 7 (independent
  review 2026-09-27, finding 1: a heavy viewer passes 20 000 counters in about an hour).
- **§4, journal entries.** A journaled operation records whether its outputs were seeded
  (`PendingOp.seeded`). Only those need NUT-07 to count as executed; an unseeded entry is decided on
  its signatures alone, as in ADR 0014 (finding 4).
- **Wiped entropy** (16 zero bytes, phrase "abandon … about") is refused before it is shown or
  turned into a seed.
- **Related findings.** 2: the payout comment now names the real gap. 4: NUT-07, NUT-09, NUT-13 and
  its test vectors vendored from `cashubtc/nuts@8bde3c0` (fetched 2026-09-26).

## Implementation notes (lane W8a-money, final cross-lane review, 2026-09-27)

The decisions stand. What the desktop now does (details: `docs/lanes/W8a-money.md`,
`docs/reviews/2026-09-27-pre-push-w8a-money.md`):

- **§3, startup restore wired.** After the journal's startup settle, a seeded money plane calls
  `CashuWallet.restoreUnpublished()` (contract request N1-4), each mint inside the PAY/melt gate.
- **§2, closing.** The plane runs `CashuWallet.close()`; the swap waits for its drain (bounded,
  2 s) and a watermark write after that is skipped (`close({ flush })`), so it never lands after
  the next plane's counters or a rotation's. The desktop keeps one counters store object per
  identity.
- **§3, the counters file** takes core's `published` 0 for a keyset with no `next` (a probe moved
  its cursor, no lease yet) — refused before, which then refused every later save.
- **§5 step 3, the batch cap.** The host follows core's `resume`: up to 10 calls per phrase and
  mint per restore, only while a call moves the scan on; an unfinished scan keeps its cursor in the
  host and reads "could not be reached" until the Settings screen has a "not finished" outcome
  (`docs/contract-requests/W8a-money.md`). Cameron's open decision on the bound (N1 item 7) stands:
  this is option 1 with the host doing the continuing.
- **D5, a reissue is complete** only when no journal entry and no dust is left outside the phrase
  at a mint; the replaced phrase's relay copy is retired only then.
- **D2, the relay copy** is retried with a bounded backoff (30 s doubling to 1 h) until a relay
  takes it; the envelope's `relayCopy` is the persisted pending flag.
- **§4, journal ids.** A `begin` whose id is still journaled (a counter handed out twice) is
  refused before anything changes, never a silent replace.
- **§5, a typed all-zero phrase** ("abandon … about") is refused by name at restore.

## Implementation notes (lane W8c-prompt, desktop, 2026-09-27)

From the round-8 cross-lane panel (packaging review):

- **§1, restore and confirm.** The word fields no longer use a `<datalist>`. The page draws up to
  six matches from its own list under the field being typed in (a keyboard-accessible combobox);
  the list empties when the answer is sent. Content protection covers only the prompt window
  itself, and on macOS Chromium draws datalist suggestions in a separate popup window.
- **§7, main's native confirm.** `HostOut` gains `confirm-cancel { req }`. The host sends it when
  its confirm deadline passes (5 minutes) and at shutdown. Main then closes the dialog (Electron's
  `signal`), and also closes it when the host goes away. No answer follows, and the next question
  is not refused as busy. On macOS a dialog with no parent window runs synchronously and cannot be
  closed that way; its late answer is dropped by the host (an unknown request).
- **Packaging.** Staging refuses a prompt bundle older than the installed `@scure/bip39` and the
  packages it resolves (`packaging/stage.ts` `promptNpmDirs`). The bundle's allow-list admits a
  file only when every package on its `node_modules` path is one of the three
  (`packaging/prompt-npm.ts`).
