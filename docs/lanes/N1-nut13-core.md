# Lane N1-nut13-core — NUT-13 seed backup, the core side (issue #3, ADR 0016)

**Issued against the frozen seam `packages/core/src/wallet/recovery-api.ts`** (and
`CONTRACTS_VERSION` unchanged: no contract edit). Branch `stage-3/nut13-core` off `54f49bb`.
Cameron's decisions (ADR 0016, 2026-09-25): a new 12-word phrase per device, sealed locally AND a
relay copy; one phrase per device, counters from 0, no slots; the balance held today reissued
once; `@scure/bip39` 2.0.1 (already in the lockfile and the locked allowlist on the base). Lane N2
builds the desktop (storage, relay copy, prompt window, Settings, wiring) against the same seam.

Resumed lane: a first agent stopped at a usage limit; its unreviewed work is the
`wip(N1-nut13-core)` commit (`88fafaf`), kept as is. The commits after it review that work,
fix what was wrong (below, and in the review record), and add every test.

No dependency, lockfile or `package.json` change. `docs/contract-requests/N1-nut13-core.md` lists
six items, none blocking (all worked around). Nothing outside the allowlist; `docs/status.md` and
`docs/security-review.md` untouched (proposed text at the end).

## What changed and why

### (a) Specs vendored — `docs/vendor/NUT-07.md`, `NUT-09.md`, `NUT-13.md`, `NUT-13-tests.md`

From `cashubtc/nuts@8bde3c0c3684430d852ab543ac8ca72913770dc0` (the commit of 2026-09-24),
fetched 2026-09-26, rows in `MANIFEST.txt` with the pinned commit URL and sha256 prefix
(re-checked). `scripts/vendor-docs.sh` (outside this lane) does not list them yet: contract
request 6.

### (b) The phrase and the seed — `packages/core/src/wallet/seed.ts` (NEW, locked)

Imports only `@scure/bip39` (+ its English wordlist), `sodium-universal` and the seam's types.
Nothing logs (`npm run check:locked`).

- `recoveryPhrases: RecoveryPhrases` — `generate()` (the library's CSPRNG, 128 bits), `toIndices`,
  `fromIndices`, `fromWords` (NFKD, trimmed, lower-cased; each word checked against the list
  first, so the library's own error — which quotes a word — is never surfaced), `toSeed`
  (`mnemonicToSeed(words, '')`, copied into `sodium_malloc` memory, the library's copy zeroed).
  `RecoveryPhraseError.problem` is `length` | `word` | `checksum`; the message is
  `recovery-phrase: <problem>`, never a word (tested for every refusal).
- Entropy about to be shown or seeded is refused when it is all zeros (`RecoverySeedError('wiped')`):
  that is a wiped buffer, and its phrase ("abandon … about") is public.
- The seed is lent BY REFERENCE to cashu-ts (`bip39seed`); `seedBytes` refuses a wiped seed or one
  core did not make; `sameSeed` compares two seeds in constant time (`sodium_memcmp`).
- Outside the frozen interface (contract request 1): `entropyFromBytes`, `entropyFromHex`,
  `entropyToHex`, `wipeEntropy` — for the shell's sealed file and relay copy.
- `markSeeded` / `seededWith`: which cashu-ts wallets were built with a seed (see (d)).

### (c) Counters — `DurableCounterSource` (`seed.ts`)

cashu-ts's `CounterSource` (`reserve`, `reserveAt`, `advanceToAtLeast`, `snapshot`), structurally
(seed.ts imports nothing from cashu-ts). Keyed by keyset id across every mint. Every call runs one
at a time in call order.

- **Lease ahead**: before `[start, start + n)` is handed out, `next = start + n + 32` is saved
  through the shell's `CounterStore`; a failed save hands out nothing. A crash burns ≤ 32 + n.
  A save re-reads the store and never writes a lower lease.
- **Probe**: a keyset the stored state does not know (no file, a lost file, a new keyset) is asked
  of every loaded mint that serves it — NUT-09 batches of 100 from the cursor until one is empty
  — and the cursor starts past the last signed counter. No answer (no mint serves it, or its
  answer is nonsense) → nothing is derived (`CounterStateError('unprobed')`); a failed probe
  refuses the reservation.
- **Published watermark**: `markPublished` (the wallet calls it only with nothing in flight),
  `unpublished()` = `[published, next)` per keyset as stored, `flush()`.
- **Closed** refuses every reservation; counters stay below 2^31 (a v1 counter is a hardened
  BIP-32 index), a range past it is refused, never wrapped. A malformed counters file is refused
  (`isCounterState`, exported for the shell).
- `mocks/counter-store.ts` — `MemoryCounterStore` (failNextSave, saved[], reset) for tests and rigs.

### (d) Connections and the wallet — `wallet.ts`

- `new CashuMintConnections({ request, seed?: SeedMaterial })`: seeded cashu-ts wallets get
  `bip39seed`, the shared counter source, `secretsPolicy: 'deterministic'` and a guarded
  `outputDataCreator` (refuses a wiped/foreign seed and counters past 2^31); unseeded ones get an
  explicit `'random'` — never cashu-ts's `'auto'`. Each wallet's probe is registered once loaded.
- ONE live counter source per `CounterStore` object (a reconnect shares it; a source closed with
  its wallet is replaced by one that starts from disk). `DurableCounterSource` is exported as a
  type only.
- A cashu-ts wallet built with a seed is marked; the Spender refuses to operate on it if its
  context carries no (or another) `seeding` — a `MintConnections` wrapper that dropped it (the
  desktop's `host/money.ts` wraps exactly like that; N2 must forward `seeding`).
- `CashuWallet.seeded: SeededWallet` (reissuePlan, reissue, restoreFromSeed) when seeded;
  `restoreUnpublished()` (startup restore of `[published, next)` at every mint the wallet knows);
  `notePublished()` (moves the watermark only when no operation runs or is queued, nothing is
  journaled and the store's outbox is empty — also for the shell to call after its outbox drains);
  `close()`: the counter source refuses, running and queued operations finish (new ones are
  refused), the watermark is written, then the seed is wiped.

### (e) `spend.ts` (locked)

- **Explicit output types** when seeded at a mint that can restore them (NUT-09, a hex v1/v2
  keyset): a send's change, receive, mint, melt blanks and reissue are `deterministic` (counter 0
  = reserved from the source); a send's locked outputs stay `p2pk`. Random elsewhere.
- **Collision guard** (ADR 0016 §4): a journaled restore counts as executed only when NUT-07 shows
  the operation ran (a swap's/melt's inputs SPENT, a receive's key secrets SPENT, a mint quote
  ISSUED). Signatures on our outputs without that are a collision: the entry is dropped (its
  inputs come back), the counters move past what the mint signed (`signedPast`), and the live
  operation runs ONCE more (`twice`); a second collision is reported ("another wallet derives from
  this recovery phrase"), nothing lost. A signature for another amount or keyset under one of our
  outputs counts as foreign: a collision if the operation never ran, a lie (entry kept) if it did.
  **The mint's error code is not trusted**: on a coded refusal of a seeded operation, NUT-09 is
  asked whether our outputs are signed — real mints do not say 10002 (Nutshell 0.21: 11003;
  cdk-mintd 0.18.1: 20006 on mint and melt, 11008 on a swap; measured). Without a journal, "outputs
  already signed" (10002, 11003 or the message) on seeded outputs is a collision too.
- **`restoreFromSeed`** (ADR 0016 §5) under the mint's lock, after its journal settles: NUT-09
  advertised or `unsupported`; every hex `sat` keyset, active first, at most 32; batches of 100
  from counter 0 until three in a row come back empty (not cashu-ts's `batchRestore` default of
  one), at most 200 per keyset; every signature must answer one of OUR messages once, under the
  keyset, for an amount it has a key for, with a DLEQ at a NUT-12 mint that cashu-ts checks
  against the CLAIMED amount's key; anything else refuses the mint's whole answer (`refused`).
  NUT-07 drops SPENT (held ones leave the store), PENDING are left out, held ones (by secret) are
  not added twice; at a NUT-12 mint one `WalletTx` "restored from recovery phrase"; at a mint
  without NUT-12 everything unspent is swapped into fresh outputs first (one history line; dust
  below the input fee left). Another device's phrase is only read; this device's own advances its
  counters past the last signature.
- **`reissuePlan` / `reissue`** (D5): the plan remembers exactly which proofs it covered and the
  fee; `reissue` refuses a plan that is not this wallet's latest for the mint, a forged one, a
  used one, holdings that changed (other proofs, even at the same amount), a changed fee, and a
  mint whose outputs could not be restored. Journaled like a send without locked outputs; the fee
  is one `out` history line.
- **`close`** refuses new operations and waits until every per-mint lock is idle.
- `store.ts`: `PendingOp.id` comment; `ProofStore.unsynced?()`.

### (f) Other

- `mocks/test-mint.ts`: several keysets (`rotateKeyset`; inactive ones still redeem and are served
  by `/v1/keys/{id}`), `keysetVersion: 0` (v1 `00…` ids), `nut12: false`, `hostileRestore(
  { perRequest })`; a melt on already-signed blanks is refused 10002 before it spends or pays, as
  Nutshell and cdk do (measured).
- `packages/seeder/src/runtime/payout.ts`: the residual comment names the real gap (ADR 0016
  related finding 2), not NUT-13.

## Tests

All new, none weakened. `vi.setConfig({ testTimeout: 60_000 })` in the two in-process NUT-13
files (180 s in the opt-in real-mint file): each test runs a real in-process mint with a
hash-to-curve per output and NUT-09 scans of hundreds of derived outputs, and the box this ran on
had a load average of ~25 — the 5 s default fails there on timing alone.

- `wallet/__tests__/seed.test.ts` (36): the phrase (CSPRNG, round trips, NFKD, every refusal names
  its problem and never a word, hex/bytes round trips, wiped entropy refused); **the NUT-13 test
  vectors through our wiring** (`fromWords` → `toSeed` → the guarded output creator: v1
  `009a1f293253e41e` secrets and `r` for counters 0–4 by the BIP-32 path, and counter 3 alone;
  v2 `015ba18a…` by HMAC); wiped/foreign seeds refused; 2^31; `sameSeed`; the counter source
  (lease before hand-out, restart, failed save, concurrency, keysets, peek, reserveAt,
  advanceToAtLeast, bad arguments, exhaustion, malformed file, closed, probe: answered / not
  needed / several mints / nobody / failing / nonsense / closed during / unregistered, watermark,
  flush after close, a late flush never moves a lease back, clamping).
- `wallet/__tests__/nut13-wallet.test.ts` (26, TestMint): explicit outputs per operation (top-up,
  send change vs P2PK, receive, melt change; unseeded random; a mint without NUT-09 random and no
  counter used; a wrapper that drops `seeding` refused); counters never repeat (restart and crash
  from the file on disk, a lost file → probe, a reconnect shares ONE source and a closed one is
  replaced, two mints with one keyset id, a keyset rotation); the collision guard (fresh top-up,
  send, receive, melt; cdk's codes 20006/11008 still a collision; a plain refusal stays a
  refusal; without a journal; a second collision reported, nothing lost; a journaled send whose
  outputs someone else signed is dropped at settle with its inputs kept; one that did execute is
  still recovered); close waits before it wipes (running send finishes, queued refused, counters
  closed, watermark written; an operation reaching for counters after close began is refused
  with nothing spent); the watermark holds back with an outbox or an unresolved operation.
- `wallet/__tests__/nut13-restore.test.ts` (21, TestMint): restore (unspent back, spent filtered,
  one history line, progress); a second run adds nothing and drops what was spent since; three
  empty batches of 100 end the scan (exactly six requests with a gap inside 300 and a far output
  past it); DLEQ required; an amount lie refused; outputs we never asked for / one twice refused;
  a mint without NUT-12 swaps before counting, and there an amount lie is refused by the mint;
  inactive keysets and the keyset cap; a v1 keyset; a hostile mint held to the batch cap;
  unsupported / unreachable reported per mint; a wiped seed refused before any request; another
  device's phrase restores without being adopted (counters untouched, new outputs from this
  device's own phrase, the other device never collides); this device's own phrase on a lost
  counters file moves the counters; reissue plan → confirm → the words bring it back; refused on
  changed holdings, stale/forged/used plan, no NUT-09; the startup restore brings back change a
  crash kept from the store and drops what was spent; after a clean close only the unused lease
  is scanned.
- `wallet/__tests__/nut13-rig.ts`: the shared rig, with its own check.
- `wallet/__tests__/nut13-real-mint.integration.test.ts` (5, opt-in `NUTFLIX_REAL_MINT_URL`, melt
  with `_URL_2`): restore from the words on a real mint (spent filtered; exactly four restore
  requests on the active keyset: one with signatures, three empty; a second run adds nothing); no
  DLEQ / doubled amounts refused; a collision on a mint request and a swap, whatever the code;
  a melt whose blanks collide is refused BEFORE it pays and completes once more; reissue with the
  real fee, recovered by the words. **Green on Nutshell 0.21.0 (:3399, URL_2 :3398) and cdk-mintd
  0.18.1 (:3397, URL_2 :3398).**

Gates (2026-09-27, on a shared box at load average ~25):

- `npx vitest run --maxWorkers=2`, whole suite once: 3354 passed, 8 failed, 48 skipped; 6 of 218
  files failed. The 8 tests: the two viewer-payer "I2-paygate rate-limited" tests (known on the
  base, owned by R6) and 6 app-desktop timing failures under the load — `money` ×3 and `guards`
  `setProfilePicture` (5 s timeouts), `auto-topup` ×2 (one read `cap` for `unresolved`, a
  time-dependent assertion; one timeout). Each of the 6 passes re-run alone; no timeout raised.
  Two suites failed at setup: `stage` and `packaged-worker` refuse a build older than the sources
  (I had not rebuilt after editing core); after `npm run build` both pass except the third known
  R6 failure (`stage.test` "host bundle carries none of core's test doubles": `QUIT_FLUSH_MS`) —
  the assertions before it (no module of core's `mocks/` in the host bundle) pass with the new
  `MemoryCounterStore` mock.
- `npx tsc -b --force`: clean. `npm run build`: clean.
- eslint and `prettier --check` on every changed `.ts`/`.md`: clean. `npm run check:locked`: OK.
- Opt-in real mints: `nut13-real-mint.integration.test.ts` 5/5 on Nutshell 0.21.0 (:3399) and on
  cdk-mintd 0.18.1 (:3397), both with `NUTFLIX_REAL_MINT_URL_2=http://127.0.0.1:3398`.
- No app-desktop change, so no `lint:electron`; no dependency change, so no `check:native`.
- Mutation checks: 35 guards broken one at a time, each caught by a test (two needed a stronger
  test or a fixed filter first; `docs/reviews/2026-09-26-pre-push-nut13-core.md`).

Commits: `fc324fb` (vendored specs, first agent), `88fafaf` (the wip, first agent, unreviewed),
`af7af77` (review fixes and the tests), `aaf39b6` (payout comment), `b2b7195` (one counter source
per store), `fc7c4de` (a wrapper that drops seeding is refused), `441d663` (a stronger
foreign-phrase test), then the docs commit (this file, the review record, the contract requests,
ADR 0016 implementation notes).

## Residuals

1. **Code-based guard without a journal.** A store without `pending` (no production store) relies
   on the "already signed" code or message; cdk's 20006/11008 there fail the operation with
   `mint-error` (its inputs reconciled, nothing lost) instead of retrying.
2. **One counters store per identity per process.** Two `CounterStore` objects over one file, or two
   processes, are not coordinated by core (the shell keeps one; the desktop is single-instance).
3. **A malformed counters file fails closed**: seeded operations refuse until the shell moves it
   aside and answers `null` (contract request 3).
4. **Restore cost.** A restore holds the mint's lock for its whole scan; a hostile mint that signs
   one output per batch can make it run 200 batches × 32 keysets (640 000 derivations) — the ADR's
   caps, not tighter.
5. **PENDING restored proofs are left out** (contract request 2); a later restore adds them if the
   melt failed.
6. **Linking.** A restore shows the mint every scanned `B_`; the startup restore shows it the small
   `[published, next)` ranges (≤ 32 unused counters after a clean close); the first probe of a
   keyset on a device shows it the next 100 unsigned outputs (it probes every keyset the counters
   file does not know, a rotation included — stricter than the ADR's "file missing", for safety).
7. **Library intermediates and strings.** The mnemonic strings core builds (`generate`, `toIndices`,
   `toSeed`), the indices array, cashu-ts's BIP-32 node for v1 keysets, and typed words are JS
   values that cannot be wiped (ADR 0016 residual). Word lookup in `fromWords` is a `Map` (not
   constant-time; local only).
8. **A mint without NUT-12** that restores more than its `max_array_length` of proofs fails the one
   swap (reported `refused`); both real mints advertise NUT-12.
9. **Legacy base64 keyset ids** are never scanned; a mint whose ACTIVE keyset had one would get
   deterministic outputs that no restore finds (real mints' active keysets are hex).
10. **https-only mint URLs at restore** are the prompt window's job (ADR 0016 §5, lane N2): core takes
   any `MintUrl`.
11. **The seeder daemon and gateway** are unseeded (D6); the payout residual is described correctly
    now but not fixed.

## Proposed `docs/status.md` row

| NUT-13 seed backup, core (issue #3, ADR 0016) | `stage-3/nut13-core` | **done (core)** — a 12-word phrase per device (`@scure/bip39`, entropy and seed in secure memory, errors never quote a word); durable counters leased ahead (a crash never repeats one; a lost file is probed; one source per store); deterministic change/receive/mint/melt/reissue outputs, P2PK sends unchanged; the collision guard (NUT-07 decides; the mint's code is not trusted — Nutshell 11003, cdk 20006/11008); restore from any phrase (three empty batches of 100, DLEQ required at NUT-12 mints, amount lies refused, spent filtered, one history line); reissue with the fee shown; startup restore of `[published, next)`; close waits before wiping. Proven on Nutshell 0.21.0 and cdk-mintd 0.18.1. Desktop wiring: lane N2 |

## Proposed `docs/security-review.md` text

> **NUT-13 seed backup (issue #3, ADR 0016), core.** The recovery phrase is generated and turned into
> a seed only in core's locked `seed.ts` (`@scure/bip39`, libsodium secure memory); its errors name
> a problem, never a word; wiped (all-zero) entropy — whose phrase is public — is refused before it
> is shown or seeded, and a wiped seed before any derivation (cashu-ts holds it by reference).
> Counters are leased ahead through the shell's store (written before any counter is handed out;
> a stored lease never moves back; one live source per store), probed by NUT-09 when unknown, and
> never cross 2^31. Seeded outputs are explicit per operation (never cashu-ts's `'auto'`); a
> `MintConnections` wrapper that drops the seeding is refused rather than silently random. A
> counter collision (another wallet on the phrase) is decided by NUT-07 — a journaled restore
> counts only when the inputs are SPENT or the quote ISSUED — and, because real mints answer it
> with different codes (Nutshell 0.21 11003; cdk-mintd 0.18.1 20006 on mint and melt, 11008 on a
> swap), by asking NUT-09 whether our outputs are signed, not by the code; the operation is retried
> once, a second collision is reported, nothing is lost (tested on both real mints). A restore
> requires NUT-12 DLEQs where advertised (checked against the claimed amount's key; an amount lie
> is refused), swaps proofs at mints without NUT-12 before counting them, drops SPENT proofs,
> dedupes by secret, and is bounded (32 keysets × 200 batches of 100). Residuals: phrase strings
> and library intermediates cannot be wiped; a hostile mint can make a restore slow (within the
> caps) and links the scanned outputs; two processes over one counters file are the shell's to
> prevent; a store without a journal falls back to the error code.
