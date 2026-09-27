# Lane N2-nut13-desktop — NUT-13 recovery phrase, desktop side (issue #3, ADR 0016)

Branch `stage-3/nut13-desktop` off `54f49bb` (the frozen seam
`packages/core/src/wallet/recovery-api.ts`, `@scure/bip39` 2.0.1 pinned and locked). ADR 0016
as Accepted by Cameron (2026-09-25): a **new 12-word phrase per device**, sealed on the device
AND copied to the user's relays NIP-44-encrypted to self (kind 30078, `d` =
`nutflix/nut13/<random device id>`); a device derives only from its own phrase; the balance held
before it is reissued once, the fee shown first.

Lane N1 (core: `RecoveryPhrases`, `DurableCounterSource`, the seeded connections,
`CashuWallet.seeded`, restore, reissue) runs in parallel. This lane does **not** depend on it:
N1's code comes in only through `RecoveryCore` (`host/recovery/core.ts`), typed by the seam, and
the ONE wiring point `recoveryCore()` returns `undefined` until the orchestrator fills it at
merge (the box comment there gives the three lines). Until then the desktop says `unavailable`
and derives nothing. Every test uses a fake of the seam (`host/__tests__/support/fake-recovery.ts`,
the real `@scure/bip39` conversions).

The lane resumed a previous agent's interrupted, unreviewed work (`e00272f`, kept as is); the
review record lists what was kept, fixed and replaced. No contract change
(`docs/contract-requests/N2-nut13-desktop.md`: six items, all worked around). No core mock was
needed: the seam's fakes live in app-desktop's test support, so they cannot collide with N1. No dependency,
lockfile or `package.json` change; nothing outside the allowlist; `packaging/` read, not changed.

## What changed and why

### Storage (host) — `host/recovery/files.ts`

- `<userData>/wallet/recovery-<pubkey>.sealed`: a JSON envelope whose only secret field, `sealed`,
  is the phrase's `RecoveryRelayCopy` (`{ v, entropy (32 hex), created }`) NIP-44-encrypted to
  self through the signer. The other fields hold no secret — the random device id, when, and
  `confirmed` / `reissued` / `relayCopy` / `replaces` — so the status needs no signer round trip.
- `recovery-<pubkey>.<device>.retired`: a replaced phrase, kept for restores, never derived from.
- `counters-<pubkey>.json`: core's `CounterStore` (`FileCounterStore`): exact `CounterState`
  (hex keyset ids v1/v2, integer counters ≤ 2^31, `published` ≤ `next`), saves applied in order
  across instances and awaited by `load`, `null` only when there is no file.
- All of them through `signer/private-file.ts`: 0600 in 0700, O_NOFOLLOW + inode + owner checks,
  exclusive temp + fsync + rename + directory fsync. A refused or damaged file **fails loudly**
  (`recovery-unreadable:` / `counters-unreadable:`) and is **kept**. Errors never carry a path
  (it names the pubkey).
- A new phrase moves the counters file aside (it derives from counter 0), and puts it back if the
  new phrase's own write fails (`unretireCounters`), so the old phrase never loses its counters.

### The relay copy — `host/recovery/relay-copy.ts`

Published on create and rotate (never at startup): kind 30078, exactly one tag
`["d","nutflix/nut13/<device>"]`, content = the sealed file's ciphertext. Read ONLY by an
explicit restore: the identity's own events (signature and author checked), newest per `d`,
blanks skipped, at most 64 decrypted; undecryptable copies counted, never used. After a rotation
whose reissue completed, the old copy is blanked and NIP-09-deleted (best effort).

### The flows — `host/recovery/service.ts`

The renderer names an ACTION (`desktop.wallet.recovery.{status,setup,show,restore}`), throttled
like connect (3 dismissed windows in a minute → paused a minute), one flow at a time. Every word
is shown or typed in main's prompt window; the fee is confirmed in main's native dialog.

- **setup**: generate → `recovery-show { words: indices, again: false }` → nothing is kept unless
  "I wrote them down" or "Later" (a closed window or Escape discards it) → sealed while no money
  plane holds the wallet (`DesktopSigner.reopenMoney`, the worker restarted around it), and the
  new plane derives from it → relay copy → `recovery-confirm` at three random positions (three
  tries; "Later" = not confirmed) → reissue plan per mint (dust whose fee eats it is left) →
  native dialog with every mint's amount and fee (Cancel the default) → reissue. A phrase whose
  reissue did not finish: setup only finishes the reissue. A finished phrase: **rotation**, after
  re-authentication.
- **show**: re-authentication (the local key's passphrase in the prompt window, checked against
  the key file; a native confirm for NIP-46), then the same indices; an unconfirmed backup can be
  confirmed then.
- **restore**: needs this device's phrase in use (the seam's restore lives on the seeded wallet:
  contract request item 2); `recovery-restore` (12 optional fields), then this device's phrases
  (current + retired), every relay copy the identity decrypts and the typed phrase, deduped by
  bytes, each scanned from counter 0 at the wallet's mints (`restoreFromSeed`), progress on the
  `recovery.progress` topic, one report row per mint.
- **status**: `covered` / `not-confirmed` / `not-on-device` / `unreadable` (a file that does not
  open, or a seed the wallet did not take) / `unavailable`, plus `reissuePending`, `relayCopy`.
- Hygiene: entropy bytes and index arrays zeroed after use (also the copy posted to main); only
  our own coded refusals reach the renderer (`guarded()`: anything else is `internal`); log
  fields are allow-listed reason codes and counts.

### The money plane — `host/money.ts`, `host/host.ts`

`seedFor` (before each plane open) gives the plane this device's seed and counters, or nothing.
The seed option is spread into the plane's ONE connections constructor (still the only way the
desktop reaches a mint, pinned by `mint-transport.test.ts`); the wallet is handed that
connections instance (so `CashuWallet.seeded` can find the seed); the plane owns the seed (wiped
on close and on a failed open); a seed the wallet did not take is logged, wiped, never "covered".

### Main — `main/prompt.ts`, `main/host-confirm.ts`, `main/main.ts`, `ipc/recovery-checksum.ts`

- Four data-only prompt forms, exact-key guarded (`ipc/guards.ts`): `recovery-show` (12 indices
  0–2047 + `again`), `recovery-confirm` (3 ascending positions + `retry`), `recovery-restore`
  (nothing), `recovery-reauth` (`retry`; answered by a secret). Answers: indices only.
- Content protection ON for the show, confirm and restore windows before the page can fetch the
  question; a window that cannot be protected is closed without it (fail closed). Main zeroes its
  copy of shown indices once the window is gone.
- A typed phrase's checksum is re-checked in main from the indices (`phraseChecksumOk`: 128 bits +
  4 bits of `node:crypto` SHA-256 — main's bundle holds only src/main + src/ipc; tested to agree
  with `@scure/bip39`); page, main and host (core) each check it.
- `HostOut confirm` / `HostIn confirm-result`: the host asks main for a native dialog
  (`recovery-reissue` with plans, `recovery-reveal`); main builds every word, hosts via `URL`
  (punycode), Cancel the default, one at a time, an old host's answer dropped.

### The prompt page — `renderer/prompt/prompt.ts` (+ css)

Bundles `@scure/bip39`'s English list and `validateMnemonic` (`scripts/bundle.ts` allows exactly
that library, its two audited deps and the English list, inside `prompt.js` — no new runtime
file; staging copies `prompt/` as before). Shows the words from its own list, numbered, not
selectable, copy/cut/context-menu/drag blocked, no copy button; hides them (out of the DOM)
after two minutes or on blur ("Show the words" brings them back); warns on Linux. Confirm and
restore fields autocomplete from a `<datalist>` of the list, accept a unique 4-letter prefix, and
send indices; restore checks all-or-none and the checksum on the page; pasting a phrase spreads
it over the fields. `isForm` refuses any recovery question that is not exactly indices/positions.

### Renderer, preload, UI

- Preload: the four methods send `[]` whatever the page passes; `onProgress` subscribes the topic.
  Bridge types on both sides; `rehydrate.recoveryFromBridge` rebuilds error codes for Settings.
- `ui`: Settings › **Recovery phrase** (`RecoverySection`, after "Mints and top-up"): the state in
  words, the relay-copy note, "Set up recovery phrase" / "Finish backup" / "Replace phrase",
  "Show again", "Restore" (disabled until the device has its phrase), progress, per-mint report,
  errors (a closed window is silent). Without the shell's controls: the **web** shell says "Not
  covered. The web app keeps no recovery phrase…"; desktop dev mocks say "not available".

### The logger — `host/log.ts`

ADR 0016 related finding 3: 8 or more consecutive lower-case words of 3–8 letters (separated by
spaces, punctuation, numbering) become `<redacted>`, before the other rules can split them. It
over-redacts prose on purpose; four constant host messages that it swallowed were reworded, and a
test keeps every constant host/worker message intact.

## Files

- New: `host/recovery/{core,files,relay-copy,service}.ts`, `main/host-confirm.ts`,
  `ipc/recovery-checksum.ts`, `ui/src/screens/Settings/RecoverySection.tsx`, this doc, the review
  record, the contract request.
- Changed (app-desktop): `host/{adapter,dispatch,host,log,money,topics}.ts`,
  `host/signer/{desktop-signer,main-bridge}.ts`, `host/topup/ledger.ts` and
  `host/worker/supervisor.ts` (one log message each), `ipc/{guards,index,protocol}.ts`,
  `main/{log,main,prompt}.ts`, `preload/{bridge,types}.ts`, `renderer/{App,main}.tsx`,
  `renderer/{adapter/rehydrate,bridge-types}.ts`, `renderer/prompt/{prompt.ts,prompt.css}`,
  `scripts/bundle.ts`.
- Changed (ui): `screens/Settings/{Settings.tsx,Settings.css,index.ts}`, `screens/index.ts`.

## Tests

New suites (all against the fake seam; jsdom where marked):

- `host/__tests__/recovery-service.test.ts` — setup (indices shown, sealed 0600/0700 NIP-44 to self
  while no plane is open, relay copy shape, three-word confirm, fee confirm then reissue), cancel
  discards everything, "Later", declined fee → finish-only setup, three wrong confirmations,
  relays refusing, an unreadable or foreign-sealed file never replaced; rotation after the
  passphrase (retired file, old copy blanked + NIP-09 once the reissue completed; kept pending when
  declined), wrong passphrase ×3, show again (+ confirm), NIP-46 native reveal; restore needs the
  phrase, relay copies read ONLY by restore, every source once (current, retired, relay, typed)
  with progress and per-mint ranks, a bad typed checksum, a failing pass; unavailable without N1,
  throttle + one-at-a-time, a core error with words → `internal`, `reasonOf`, dust plans. Every
  test ends with the canary (no word run, index list or entropy in logs, results, progress).
- `host/__tests__/recovery-files.test.ts` — modes, atomicity, damage/extra keys/types → loud and
  kept, loose mode and symlink refused, paths validated, counters ordering, counters damage (9
  forms), prototype tricks, retire/unretire.
- `host/__tests__/recovery-relay-copy.test.ts` — publish shape and self-encryption, refusals,
  author/signature/newest/blank/undecryptable rules, the 64 cap, retire.
- `host/__tests__/recovery-save-undo.test.ts` — the counters come back when the new phrase's write
  fails.
- `host/__tests__/recovery-host.test.ts` — the whole host (rig + TestMint): refusals before a
  signer and with arguments, connect, fund, setup → covered with the real balance reissued after
  the native confirm, the worker restarted, seed material with the counters file, file mode, relay
  copy on the write relay, restore with progress to a subscriber, show again; canary over every
  reply/event and log line, indices only inside the two prompts, the host's copies zeroed, every
  HostOut valid and clonable.
- `host/__tests__/money-seed.test.ts` — the seed option reaches the connections, the wallet still
  pays the mint, close wipes; a seed not taken is wiped + logged; a failed open.
- `ipc/__tests__/recovery-guards.test.ts` — forms, answers, fits, ConfirmForm, HostIn/HostOut,
  the four methods take no argument, the topic; main's checksum agrees with `@scure/bip39`.
- `main/__tests__/recovery-main.test.ts` — protection before fetch, fail closed (throws/missing),
  main's copies zeroed, answers as indices, main's checksum, `describeHostConfirm`, one dialog at
  a time, old host dropped.
- `renderer/__tests__/prompt-recovery-page.test.ts` (jsdom) — list pins, words from indices, no
  copy, hide at 2 min and on blur, Later/Cancel/Escape, Linux note, confirm/restore/reauth
  collection, paste spreading, `isForm` refusals.
- `ui/.../Settings/__tests__/recovery.test.ts` (jsdom) — placement, web/dev copy, every state's
  actions, setup/restore results, busy, cancel silent, rate limit, progress unsubscribed.

Extended: `main-wiring.test.ts` (protection through real main wiring with `node:crypto`'s
checksum; native confirm dialog), `bundle.test.ts` (English list inside `prompt.js`, no other
list, no network API), `bridge.test.ts` (no argument crosses), `desktop-signer.test.ts`
(`reopenMoney`), `log.test.ts` (phrase canary + property test + constant messages).
Pins updated with a comment: `protocol.test.ts` topics 7 → 8, `boundaries.test.ts` src/ipc
modules, `guards.test.ts` method count 56 → 60 (in the WIP).

Gates (2026-09-27, shared box at load 15–28): `npx tsc -b --force` clean; eslint + prettier
`--check` clean on the 57 changed ts/tsx/css files; `npm run check:locked` OK; `npm run
lint:electron` OK (253 files, 0 violations); `check:native` not needed (no dependency change);
`npm run build` OK. The whole suite once with `--maxWorkers=2`: 3459 passed, 21 skipped, 11
failed — the 3 known base failures owned by lane R6 (stage.test "host bundle carries none of
core's test doubles": `QUIT_FLUSH_MS`; two viewer-payer "I2-paygate rate-limited") and 8 test
timeouts at 5 s under load (money.test ×5, auto-topup.test ×2, guards.test setProfilePicture ×1),
all of which pass rerun alone with the default timeouts (483/483); no timeout was raised. The
three money.test timings were also compared against the base `money.ts` (same range, 1.8–4.5 s,
order-dependent). Opt-in real mints: `topup-real-mint.integration.test.ts` (the money plane with
this lane's connections handling, moving real sats) passes against Nutshell :3399 → :3398 and
cdk-mintd :3397 → Nutshell :3398. No Electron e2e (the orchestrator's). Restore and reissue are
N1's code: their real-mint runs belong to the merged build.

## Mutation checks

See `docs/reviews/2026-09-26-pre-push-nut13-desktop.md`: 32 mutations of security-relevant
guards (wire shapes, main's checksum and content protection, the page's form check and hiding,
the preload, error and log hygiene, re-authentication, restore-only relay reads, counters and
file refusals, the seed ownership, the native-dialog exclusivity, the reissue filter), each killed
by a named suite; two survived the first run and got the tests they lacked.

## Residuals

See the review record's Residuals (10 items); the ones that need someone else:

- **N1 / orchestrator:** fill `recoveryCore()`; give `seedOption` N1's real option type; confirm
  `CashuWallet.seeded` reads the seed from `options.mints`; `wiped` checked at derivation time;
  run the real-mint restore/reissue tests on the merged build; add `@scure/bip39` 2.0.1 to
  app-desktop's `package.json` (lockfile).
- **Cameron (UX):** a new device sets up its own phrase before it can restore (seam); an
  `unreadable` phrase shows only in Settings; setup restarts a playing video's session.

## Proposed row for `docs/status.md`

| Issue #3 — NUT-13 recovery phrase, desktop side (ADR 0016) | `stage-3/nut13-desktop` | DONE (desktop half; lane N1's core wired at merge through `host/recovery/core.ts` `recoveryCore()`): one 12-word phrase per device, sealed in `<userData>/wallet/recovery-<pubkey>.sealed` (NIP-44 to self, 0600/0700, fails loudly and is kept when damaged) and copied to the user's relays (kind 30078, `d` = `nutflix/nut13/<device id>`, read only by an explicit restore); counters file for core (atomic, fsynced, fails loudly); main's prompt window shows the words from its own bundled BIP-39 list (indices on the wire), content protection on, hidden after 2 min or on blur, no copy; confirm three words; the old balance reissued after main's native fee dialog; show again after the passphrase (native confirm for NIP-46); restore from this device's phrases, every relay copy and a typed phrase with progress and a per-mint report; Settings › Recovery phrase (web: "not covered"); log rule for word phrases with a canary. Review `docs/reviews/2026-09-26-pre-push-nut13-desktop.md` (self-review of resumed WIP: 12 findings fixed, 32 mutation checks); contract request `N2-nut13-desktop.md` (6 items, worked around) |

## Proposed text for `docs/security-review.md`

- Open items, the NUT-13 row (`[Medium] NUT-13 seed backup in Stage 3`) → `[In progress] NUT-13
  seed backup (ADR 0016): desktop half done (`stage-3/nut13-desktop`) — per-device phrase sealed
  NIP-44 to self and copied to the user's relays (kind 30078, restore-only read), shown and typed
  only in main's prompt window as word indices (content protection, auto-hide, no copy; checksum
  checked in page, main and host), reissue after a native fee confirm, re-authentication before
  reveal or rotation, logger rule for word phrases; core half (lane N1) wired at merge. Residuals
  [Low]: JS strings holding the NIP-44 plaintext cannot be wiped; Linux has no capture block; a
  NIP-46 bunker encrypts the entropy itself and reveal re-auth is a native confirm there; an
  unreadable phrase leaves new ecash uncovered (shown in Settings only); a new device sets up its
  own phrase before restoring; upper-case phrases pass the log rule`
- New paragraph under the F31 section: **NUT-13 (2026-09-26, desktop).** The relay copy is
  protected only by the nsec (Cameron's D2 choice): an nsec compromise exposes every future seeded
  output of that phrase until it is rotated (Settings › Replace phrase: re-authentication, reissue
  under the new phrase, the old copy blanked and NIP-09-deleted, best effort). The renderer can
  only name an action; a compromised renderer can open the prompt window (throttled) but never
  read or write a word.
