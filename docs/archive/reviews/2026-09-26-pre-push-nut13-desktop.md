# Pre-push review — NUT-13 recovery phrase, desktop side (2026-09-26)

Diff: `54f49bb` (the NUT-13 seam, `@scure/bip39` pinned and locked) → `stage-3/nut13-desktop`
(`e00272f` the interrupted agent's unreviewed WIP, `2d02d6b` host fixes, `9e703e2` bridge, UI,
prompt page, tests; `db7a86e` two tests from the mutation run; this record in the last commit). Issue #3, ADR 0016
(Accepted with Cameron's answers: a new 12-word phrase per device, sealed here AND copied to the
user's relays NIP-44 to self, the old balance reissued once, fee shown first).

Method: `differential-review` (triage, blast radius, test coverage, adversarial modelling) and
`sharp-edges` (the new APIs), run inline by the session that finished the lane. It is a
self-review of code partly written by an earlier agent; the WIP commit was read line by line
first and treated as untrusted. The mutation checks below are the only independent evidence.

Lane N1 (core: `RecoveryPhrases`, `DurableCounterSource`, the seeded connections,
`CashuWallet.seeded`) is built in parallel and is NOT in this diff. Everything here that touches
derivation, restore or reissue is tested against a fake of the frozen seam
(`host/__tests__/support/fake-recovery.ts`, real `@scure/bip39` conversions), so what this review
can say about N1's side is limited to the seam's contract (see Residuals).

## Scope and risk

HIGH (secrets, value, trust boundaries):

- `app-desktop/src/host/recovery/service.ts` (new): the flows, re-authentication, the reissue
  with its native fee confirm, the restore, error and log hygiene;
- `app-desktop/src/host/recovery/files.ts` (new): the sealed phrase envelope and core's counters
  file (reuse of a NUT-13 counter repeats a secret);
- `app-desktop/src/host/recovery/relay-copy.ts` (new): the kind-30078 copy, restore-only read;
- `app-desktop/src/host/money.ts`: the seed option in the plane's one connections constructor,
  the wallet handed the connections instance, the seed owned (wiped) by the plane;
- `app-desktop/src/main/prompt.ts`, `main/host-confirm.ts` (new), `main/main.ts`: content
  protection, answers as indices, main's checksum re-check, native dialogs asked by the host;
- `app-desktop/src/renderer/prompt/prompt.ts`: the trusted page showing and taking words;
- `app-desktop/src/ipc/{protocol,guards}.ts`, `ipc/recovery-checksum.ts` (new): the wire shapes.

MEDIUM: `host/host.ts` (wiring, passphrase re-check), `host/signer/desktop-signer.ts`
(`reopenMoney`, `swapPlane` refactor of `changed`), `host/log.ts` (the phrase rule),
`preload/bridge.ts`, `renderer/adapter/rehydrate.ts`, `scripts/bundle.ts` (the prompt bundle's
allowlist), `host/{adapter,dispatch,topics}.ts`.

LOW: `ui` (the Settings section; it never sees a word), renderer shell wiring, reworded log
messages (`topup/ledger.ts`, `worker/supervisor.ts`, `signer/desktop-signer.ts`), tests, docs.

Blast radius of changed existing code:

- `redact()` (`host/log.ts:71`): every host log line, the worker's forwarded lines
  (`worker/supervisor.ts:548`) and the upload error text (`adapter.ts:966`). The new rule runs
  first; it can only replace text with `<redacted>` (over-redaction, never under-redaction).
  Four constant messages it swallowed were reworded, and `log.test.ts` now fails if any constant
  host/worker message trips it again.
- `MoneyPlane.open` (`money.ts:297`): every wallet operation. The pinned constructor text is
  unchanged (`mint-transport.test.ts` still pins ONE `CashuMintConnections(` in `host/money.ts`,
  given the host's single-attempt `request`); the seed option is a spread into it. The wallet now
  gets the connections instance with `wallet()` wrapped in place (same `loaded` bookkeeping; the
  whole money suite passes on it).
- `DesktopSigner.changed` → `swapPlane` (`desktop-signer.ts`): every connect / unlock / lock /
  sign-out; identical except the optional `between` step (only `reopenMoney` passes one).
- `PromptService.pump` (`main/prompt.ts:370`): every prompt; the new branch runs for the three
  words forms only. `toPromptAnswer` gained an options argument (default `{}`), one caller.
- `main.ts` `askUser` → `showConfirm`: the confirm gate's dialog (nutzap, settings); same box.

## Pre-existing WIP, read critically — what was kept, fixed or replaced

1. **A second way to reach a mint.** The WIP injected a connections FACTORY from core
   (`RecoveryCore.connections`), so the wiring point would have held a second
   `CashuMintConnections(` and broken `mint-transport.test.ts` (the money plane is the only way the
   desktop reaches a mint). Replaced by `RecoveryCore.seedOption` spread into money.ts's one
   constructor (`core.ts:40`, `money.ts:302`).
2. **A seed the wallet silently ignores.** With the option untyped until N1 lands, a renamed key
   would open an UNSEEDED wallet while the desktop believed otherwise. Now: `seeded === undefined`
   with a seed given is logged as an error, the seed wiped at once, status `unreadable`
   (`money.ts:238`).
3. **Where `CashuWallet.seeded` finds the seed.** The WIP handed the wallet a wrapper object, not
   the connections, so a `seeded` getter reading `options.mints` would never see the seed. The
   wallet now gets the instance itself (`money.ts:308`).
4. **Raw errors to the renderer.** Any error thrown by core or a library inside a flow went to
   `toWireError`, which keeps a message whose prefix is an error code — a core message carrying
   words would have crossed. Now `guarded()` (`service.ts:791`) passes only our own `IpcError`s
   (fixed sentences) and turns everything else into `internal`.
5. **Log reasons.** `prefix()` logged the first `word:` of any error message. Replaced by
   `reasonOf()` (`service.ts:156`): an allow-list of error codes and `*Error` names, else `error`.
6. **Entropy as strings.** The restore deduped phrases by their hex (a string that cannot be
   wiped). Now by bytes (`sameEntropy`, `service.ts:593`).
7. **A lost relay-copy retirement.** A rotation whose reissue was declined never retired the old
   copy later (the "finish" path passed no rotation). The envelope now carries `replaces` until
   the reissue completes; retirement and the record happen then, in one write (`service.ts:426`).
8. **Counters lost on a failed save.** The WIP moved the counters file aside and then wrote the
   new phrase; if that write failed the OLD phrase stayed current without its counters (a probe
   at best, a repeated secret at worst). `saveNew()` puts them back (`service.ts:403`,
   `files.ts:260`).
9. **Content protection could fail open.** `setContentProtection` was optional and called with
   `?.`: a window without it showed words unprotected. Now missing = closed, no words
   (`main/prompt.ts:388`).
10. The rest was kept after reading: the data-only forms and exact-key guards, main's native
    confirm service, the page's wordlist mapping and hiding, the private-file reuse, the relay
    copy's shape and read rules, the throttle and exclusivity.

## Adversarial analysis

**A compromised renderer** (it renders relay and peer content).

- *Read the phrase?* It can only name four actions (`validateArgs`: exact `[]`; the preload now
  sends `[]` whatever the page passes, `bridge.ts:291`). Results are a state, counts, amounts
  and the user's own mint URLs; progress the same; errors fixed sentences. The host test
  (`recovery-host.test.ts`) asserts no word pair, index list, entropy or passphrase in any reply
  or event, and that the indices reached main only inside the two `recovery-show` prompts.
- *Put text in the trusted window?* No: forms are data only (indices, positions, booleans),
  checked by `isPromptForm` in main and again by the page's `isForm` (`prompt.ts:761`); the
  page's words come from its own bundled list.
- *Spam windows / phish?* Every flow opens only in main's window; dismissals are throttled like
  connect (3 in a minute → paused a minute), one flow at a time. A rotation or a reveal needs the
  passphrase (or, for NIP-46, a native confirm the renderer cannot click). Restore asks for a
  typed phrase only inside the trusted window and uses it only to scan (never stored).
- *Trigger scans for linking?* A full restore needs the user's click in the restore window.
  Exploitability: none found beyond what ADR 0016 accepts (a restore links outputs at a mint).

**A compromised worker.** Never holds the seed, the phrase or the counters; nothing in its
protocol changed.

**A malicious relay.** Copies are signature-checked, author-pinned, newest per `d`, at most 64
decrypted, read only on restore (`relay-copy.ts:98-135`; the "read ONLY by an explicit restore"
test counts pool queries through setup, status, show and a plane open). It can withhold or replay
a copy (a replayed retired copy is the user's own phrase: harmless) and it sees that the identity
has N nutflix/nut13 copies (accepted in ADR 0016 D2).

**A malicious mint.** The reissue's fee comes from core's plan (the mint's `input_fee_ppk`); it is
shown in main's native dialog before anything moves; the guard refuses a fee ≥ the amount,
duplicate mints or more than 32; dust whose fee eats it is skipped (`service.ts:497`). Restore
answers are N1's to check (DLEQ, NUT-07).

**Another local user / a planted file.** Envelope, retired copies and counters are read with
`readPrivateFile` (lstat + O_NOFOLLOW + same inode, owner, no group/other bits); written 0600 via
exclusive temp + fsync + rename in a 0700 directory. A refused or damaged file fails loudly and is
kept (tested per case, `recovery-files.test.ts`).

**An onlooker / screen capture.** Content protection is ON for the show, confirm and restore
windows before the question can be fetched (macOS/Windows; the page warns on Linux); the words
hide after two minutes and on blur, leave the DOM once answered, cannot be copied (events
blocked, no copy button).

## Findings of this review (and fixes)

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| R1 | Medium | WIP items 1–3 (second mint path; silent unseeded wallet; seed not findable) | `2d02d6b` |
| R2 | Medium | WIP item 4: core/library error text reached the renderer | `guarded()`, `2d02d6b` |
| R3 | Medium | WIP item 8: counters lost when the new phrase's write fails | `saveNew` + `unretireCounters`, `2d02d6b`; `recovery-save-undo.test.ts` |
| R4 | Medium | WIP item 9: content protection failed open | `2d02d6b`; `recovery-main.test.ts` |
| R5 | Low | WIP item 7: the old relay copy was never retired after a declined reissue | `replaces`, `2d02d6b` |
| R6 | Low | WIP items 5–6: log reasons and dedupe keys carried free text / entropy strings | `2d02d6b` |
| R7 | Low | The prompt bundle refused `@scure/bip39`: the page could not build (the WIP never ran the bundle) | `scripts/bundle.ts:111` allow-list (exactly the English list), `9e703e2`; `bundle.test.ts` |
| R8 | Low | The phrase rule swallowed four constant host messages (e.g. `the local key was removed from this device`) | reworded; a test keeps every constant host/worker message intact, `9e703e2` |
| R9 | Low | Main's and the host's copies of shown indices lingered until GC | zeroed after hand-over (`main/prompt.ts:114`, `service.ts:340,557`), `9e703e2` |
| R10 | Info | The preload forwarded whatever the page passed to the four actions (main's gate refused it) | the preload sends `[]`, `9e703e2` |
| R11 | Info | A restore log field was named `phrase` (it is the pass number) | renamed `pass`, `9e703e2` |
| R12 | Low | Two guards had no test (mutation survivors M19, M20: the status of a seed the wallet did not take; a relay ignoring the author filter) | tests added, `db7a86e` |

## Sharp edges (new APIs)

- `RecoveryCore.seedOption(): object` (`core.ts:40`) is untyped until N1 exports the option type:
  a wrong key is ignored by the constructor. Mitigated at runtime (R1/item 2) and in the wiring
  comment; contract request item 3 asks for the type.
- `retireCounters` requires "no plane open"; the API cannot enforce it. Its only caller runs inside
  `reopenMoney`'s `beforeOpen`. A live-plane misuse would only lose restore reach (the next save
  recreates the file from core's memory), never repeat a counter.
- `PromptWindowLike.setContentProtection?` is optional in the type (fakes), but its absence now
  fails closed (R4). `toPromptAnswer`'s `checksumOk` absent = every typed phrase refused.
- `phraseChecksumOk(words, sha256)` takes the hash from the caller: a wrong hash fails closed.
  It is a bit-layout check around `node:crypto`'s SHA-256 (main's bundle may hold only src/main +
  src/ipc, so no BIP-39 library there); `recovery-guards.test.ts` checks it agrees with
  `@scure/bip39`'s `validateMnemonic` on 2 000 random index lists and 200 generated phrases. The
  host's decode (core's `fromIndices`) stays authoritative.
- `HostOptions.recoveryCore`: `undefined` = the wiring point, `null` = none, a value = injected.
- `redact`'s rule is lower-case only by spec: an UPPER-CASE phrase is not caught (residual).
- `MainBridge.confirm` with `confirmTimeoutMs: 0` resolves `false` (fail closed).
- `seedFor` failing leaves payments on with random outputs (status `unreadable`, an error line):
  a coverage lapse the user sees only in Settings (residual 5).

## Mutation checks (each: break the guard, a named test must fail, restore)

| # | Mutation (file) | Killed by |
| --- | --- | --- |
| M1 | isWordIndex accepts any value (`src/ipc/guards.ts`) | KILLED: ipc/recovery-guards — “recovery-show: exactly 12 integer indices in range and `again`” |
| M2 | confirm positions need not ascend (`src/ipc/guards.ts`) | KILLED: ipc/recovery-guards — “recovery-confirm: three distinct ascending positions 0..11 and `retry`” |
| M3 | reissue fee may reach the amount (`src/ipc/guards.ts`) | KILLED: ipc/recovery-guards — “recovery-reissue: 1..32 plans, distinct https mints, a fee below the amount; recovery-reveal exact” |
| M4 | reissue plans may repeat a mint (`src/ipc/guards.ts`) | KILLED: ipc/recovery-guards — “recovery-reissue: 1..32 plans, distinct https mints, a fee below the amount; recovery-reveal exact” |
| M5 | setup takes any arguments (`src/ipc/guards.ts`) | KILLED: ipc/recovery-guards, ipc/guards — “desktop.wallet.recovery.setup takes no argument” |
| M6 | main skips the typed phrase's checksum (`src/main/prompt.ts`) | KILLED: main/recovery-main — “restore: a typed phrase must pass main’s checksum; none ([]) is fine; words as text are refused” |
| M7 | a window without content protection still gets the words (`src/main/prompt.ts`) | KILLED: main/recovery-main — “protection missing: the window closes, the question is never served, the host hears a cancel” |
| M8 | restore window not protected (`src/main/prompt.ts`) | KILLED: main/recovery-main — “recovery-restore: protection on before the page can fetch the question” |
| M9 | main keeps its copy of the shown indices (`src/main/prompt.ts`) | KILLED: main/recovery-main — “main zeroes its copy of a shown phrase once the window is gone (answered, closed or dropped)” |
| M10 | page shows words given as anything (`src/renderer/prompt/prompt.ts`) | KILLED: renderer/prompt-recovery-page — “words as text” |
| M11 | words stay on blur (`src/renderer/prompt/prompt.ts`) | KILLED: renderer/prompt-recovery-page — “hide when the window loses focus” |
| M12 | words never time out (`src/renderer/prompt/prompt.ts`) | KILLED: renderer/prompt-recovery-page — “hide after two minutes (out of the DOM, not just out of sight); "Show the words" brings them back” |
| M13 | preload forwards the page's arguments (`src/preload/bridge.ts`) | KILLED: preload/bridge — “ADR 0016: desktop.wallet.recovery.* name an action only (no arguments cross), progress is a topic” |
| M14 | raw errors reach the renderer (`src/host/recovery/service.ts`) | KILLED: host/recovery-service — “a core error whose message carries words is `internal` to the renderer and only its code is logged” |
| M15 | log reasons not allow-listed (`src/host/recovery/service.ts`) | KILLED: host/recovery-service — “reasonOf passes only allow-listed codes and error names” |
| M16 | no re-authentication for a local key (`src/host/recovery/service.ts`) | KILLED: host/recovery-service — “a finished phrase is replaced only after the passphrase; the old one is kept as .retired and its relay copy retired once the reissue completed” |
| M17 | relay copies read at status time (`src/host/recovery/service.ts`) | KILLED: host/recovery-service — “the relay copies are read ONLY by an explicit restore: never at startup, setup or show” |
| M18 | counters not put back after a failed save (`src/host/recovery/service.ts`) | KILLED: host/recovery-save-undo — “the new phrase write fails → the old counters file is where it was, nothing is left retired” |
| M19 | status 'covered' although the wallet did not take the seed (`src/host/recovery/service.ts`) | KILLED (after a new test; survived the first run): host/recovery-service — “a seed the wallet did not take: the phrase is on this device but the status says unreadable, never covered” |
| M20 | relay copy of another author accepted (`src/host/recovery/relay-copy.ts`) | KILLED (after a new test; survived the first run): host/recovery-relay-copy — “a relay that ignores the filter: another author re-publishing our ciphertext is not a copy” |
| M21 | a refused (loose-mode) file reads as absent (`src/host/recovery/files.ts`) | KILLED: host/recovery-files — “a file other users may read, or a symlink, is refused (never followed)” |
| M22 | a damaged counters file reads as none (`src/host/recovery/files.ts`) | KILLED: host/recovery-files — “a damaged file FAILS LOUDLY (`counters-unreadable`) and is kept — never read as empty” |
| M23 | published may pass next (`src/host/recovery/files.ts`) | KILLED: host/recovery-files — “a damaged file FAILS LOUDLY (`counters-unreadable`) and is kept — never read as empty” |
| M24 | no phrase redaction (`src/host/log.ts`) | KILLED: host/log — “spaces” |
| M25 | a seed the wallet did not take is kept (`src/host/money.ts`) | KILLED: host/money-seed — “a seed the wallet did not take: never "in use" — logged as an error and wiped at once” |
| M26 | two native dialogs at once (`src/main/host-confirm.ts`) | KILLED: main/recovery-main — “true only for the confirm button; one dialog at a time; a failed dialog is no” |
| M27 | fee-eating reissue plans asked (`src/host/recovery/service.ts`) | KILLED: host/recovery-service — “a reissue plan for another mint, or one whose fee eats the amount, is never asked” |
| M28 | a constant message trips the phrase rule again (`src/host/topup/ledger.ts`) | KILLED: host/log — “no constant log message of the host (or the worker) is swallowed by the rule” |
| M29 | page takes unsorted confirm positions (`src/renderer/prompt/prompt.ts`) | KILLED: renderer/prompt-recovery-page — “unsorted positions” |
| M30 | two recovery flows at once (`src/host/recovery/service.ts`) | KILLED: host/recovery-service — “dismissed windows are throttled like connect; one flow at a time” |
| M31 | any words confirm the backup (`src/host/recovery/service.ts`) | KILLED: host/recovery-service — “three wrong confirmations: kept, not confirmed” |
| M32 | the relay copy carries an identifying tag (`src/host/recovery/relay-copy.ts`) | KILLED: host/recovery-relay-copy, host/recovery-service — “publish: kind 30078 to the write relays, exactly one tag (the d), the sealed content as given” |

All 32 killed. M19 and M20 survived the first run: no test covered the status of a phrase the wallet did not take, and the fake relay applied the author filter itself; both tests were added (`recovery-service.test.ts`, `recovery-relay-copy.test.ts`) and the mutations re-run. Each mutation was applied to the committed tree, the named suite run, the file restored with `git checkout`.

## Residuals

1. **N1 is not here.** Derivation, counters leasing and probing, NUT-09 restore checks, the
   collision guard and the reissue are N1's; the desktop is tested against a fake. Real-mint
   restore/reissue tests (Nutshell :3399, cdk-mintd :3397) belong to the merged build. Contract
   request items 3–4: the option type, `seeded` reading `options.mints`, `wiped` checked at
   derivation, an `idle()` to await before wiping.
2. **A new device must set up its own phrase before it can restore** (the seam's restore lives on
   the seeded wallet; contract request item 2).
3. **JS strings cannot be wiped:** the NIP-44 plaintext (JSON with the entropy hex), the relay
   copy plaintext, a pasted phrase in the page's fields until cleared (ADR 0016 §2 residual).
4. **With a NIP-46 signer** the entropy is NIP-44-encrypted BY the bunker (it transits the NIP-46
   channel, encrypted), and re-authentication is a native confirm (user presence, not a secret).
5. **An unreadable phrase file** (bunker offline at unlock, damaged file) leaves payments on with
   random outputs: new ecash is uncovered until it opens; Settings says `unreadable` and the log
   has an error — no banner elsewhere.
6. **Linux** has no screen-capture block (the window says so). Upper-case phrases pass the log rule.
7. **Plane close wipes the seed synchronously**; a host-side operation in flight on the old plane
   (a melt, an auto top-up) then fails by the seam's contract and is settled from its journal
   (contract request item 4). Setup reopens the plane: a playing video's session restarts.
8. **Restored ecash from another phrase stays under that phrase** until spent (it is recoverable
   from that phrase and its relay copy); no second reissue is offered after a restore.
9. **The phrase rule over-redacts prose** in forwarded worker lines: three constant messages in
   `packages/seeder` (another lane's) would read `<redacted>` if they reach the desktop's log
   (e.g. `payout skipped: the balance does not cover the swap fee`).
10. `app-desktop/package.json` does not declare `@scure/bip39` (hoisted from core; contract
    request item 6, a lockfile change outside the lane).

## Independent review (2026-09-27)

An independent reviewer read the lane at `134cdea`. It found no critical or high defects: 1
medium, 3 low, 7 info. It re-ran 14 mutations (12 killed, 2 survived) and 3 probes. Each finding
was verified first. The six reproducible ones got a test that failed on `134cdea` (IR1, IR2,
IR3, IR4, IR7, IR8: the failing run is quoted below). The two test gaps (IR5, IR6) got the test
that kills the reviewer's surviving mutation. The three that are code-reading findings (IR9,
IR10, IR11) got a test written with the fix, and reverting the fix makes it fail (the mutation
table). Fixes are in `dd7addd`; the page's length pin and these docs are in the next commit.

| # | Sev | Finding (reviewer's anchor) | Verified | Fix (file:line at `dd7addd`) | Test |
| --- | --- | --- | --- | --- | --- |
| IR1 | Medium | One reissue plan that fails the dialog's wire guard (an `http://` dev mint, inputs > 100 000) made the whole `recovery-reissue` form fail, so no mint was asked; the log blamed the user (`service.ts:503`) | Reproduced: https 1 000 + http 500 + an https plan with 100 001 inputs gave `confirms = []`, nothing reissued | Each plan is checked with `isReissuePlanWire` (now exported, `guards.ts:652`). A failing plan is left out, counted in `reissueFailed` and logged with its own reason. The rest are asked (`service.ts:520`). The dialog's guard is not loosened: `recovery-guards.test.ts` pins http refused there. | `recovery-service` “IR1” |
| IR2 | Low | A declined native fee dialog was not counted by the throttle, so a renderer could reopen it on every close (`service.ts:515`) | Reproduced: 3 declines, then a 4th `setup()` resolved instead of `rate-limited` | A declined `recovery-reissue` confirm calls `dismissed()`, the same counter a closed window feeds (`service.ts:548`, `:865`). The result is still returned. | `recovery-service` “IR2” (3 declines, then `setup` and `show` rate-limited, then fine after the cooldown) |
| IR3 | Low | The phrase log rule missed JSON arrays, per-word quotes, `&`, `%20`, `[n]` and `k=` (`log.ts:53`) | Reproduced: 13 new canary forms and a property all failed on the old rule | The separator is 1–12 characters of white space, digits or ASCII punctuation, or a one- or two-letter key before a digit or `=` (`log.ts:59-60`). `(` and non-ASCII punctuation are not separators. With them, four constant host/worker messages were swallowed; the constant-message test caught that, and the set was narrowed rather than the messages reworded in other lanes' files. The rule stays linear: letters and separators never overlap. | `log` 13 forms, a property (JSON / quotes / `%20` / `w0=`), a hostile-input timing test, the constant-message test |
| IR4 | Low | The restore could not take mint URLs typed in the window (ADR 0016 §5.1), yet the page invites another wallet's phrase (`service.ts:632`) | Reproduced: an answer's mints were never scanned | `recovery-restore` answers may carry 1–8 `mints` (optional key; `protocol.ts` `MAX_RESTORE_MINTS`). The page normalises them (`prompt.ts:101`, explicit `https://` only, no bare words, the typed text never echoed). Main re-checks with `isMintUrl` into its own array (`main/prompt.ts:149`, `:216`). The IPC guard is exact-key (`guards.ts:719`). The host checks again, normalises, dedupes and scans them beside the wallet's mints (`service.ts:669`). | `recovery-service` “IR4”, `recovery-main` “typed mint addresses”, `recovery-guards` “1..8 … mint addresses”, `prompt-recovery-page` “typed mint addresses” (3) |
| IR5 | Info | Test gap: the refusal to replace a phrase that did not open survived `if (false)` (`service.ts:322`) | Confirmed a gap: the guard is right, and the new test passed on `134cdea` | none needed | `recovery-service` “IR5”: a finished envelope sealed to another key → `forbidden`, nothing asked, the file byte-identical, no `.retired` |
| IR6 | Info | Test gap: newest-per-`d` survived a reversed comparator (`relay-copy.ts:120`); the fake pool replaces events itself | Confirmed a gap | none needed | `recovery-relay-copy` “newest per d, whatever order”: a pool answering both versions in every order; a newer blank retires the copy, a newer copy wins |
| IR7 | Info | `replaces` was cleared even when retiring the old relay copy failed, so it was never retried (`service.ts:455`) | Reproduced: relays refusing the blank and deletion left `replaces: null` | `replaces` is kept until a relay took both (`service.ts:454`). The next setup retries before anything else (`service.ts:332`, `retireReplaced`). | `recovery-service` “IR7” (the retry lands even though the user then closes the passphrase window) |
| IR8 | Info | A NIP-46 rotation re-authenticated with the “Show your recovery phrase?” dialog (`service.ts:736`) | Reproduced: the rotation asked `recovery-reveal` | A new data-free `ConfirmForm` `recovery-rotate` (`protocol.ts`, `guards.ts:671`), worded by main as a replacement with the fee to come (`host-confirm.ts:60`). `reauth(…, purpose)`. | `recovery-service` “IR8”, `recovery-main` “the rotate dialog”, `recovery-guards` “recovery-rotate” |
| IR9 | Info | The 5-minute prompt deadline discarded a phrase the user was still writing down (`main-bridge.ts`, `service.ts:341`) | By reading: `recovery-show` used `PROMPT_TIMEOUT_MS` | `recovery-show` waits `RECOVERY_SHOW_TIMEOUT_MS` = 30 min (`main-bridge.ts:30`). The page still hides the words after 2 min or on blur. Every other question keeps 5 min. The Settings note (“the phrase was not saved”) was not added: see residual 13. | `main-bridge` “a shown phrase gets its own, longer deadline” |
| IR10 | Info | Restore reach was capped silently: the 64-copy cap was applied before blanks were skipped (`relay-copy.ts:124`) | By reading, then a test | Blanks are dropped before the cap (`relay-copy.ts:127`). Copies left out are counted (`omitted`, `:140`) and logged by the restore (`relayOmitted`, `service.ts:661`). Paging the query with `until` and the 64 local retired files are deferred (residual 12). | `recovery-relay-copy` “blanks never crowd out a live copy…” |
| IR11 | Info | `wipeAnswer` did not zero the index arrays of a stray or misfitting `recovery-confirm` / `recovery-restore` answer (`main-bridge.ts:67`) | By reading | Both kinds are zeroed (`main-bridge.ts:80`), like main's own `wipe()` | `main-bridge` “a stray or misfitting answer carrying word indices is zeroed” |

Failing runs on `134cdea` (before the fixes): the service tests IR1, IR2, IR4, IR7, IR8 (5
failed, IR5 passed). `log.test.ts`: 14 failed (13 forms and the property).

### Mutation checks for the fixes (applied to `dd7addd`, named suite run, file restored with `git checkout`)

| # | Mutation (file) | Result |
| --- | --- | --- |
| MIR1 | every plan asked, no per-plan wire check (`host/recovery/service.ts`) | KILLED: recovery-service “IR1” |
| MIR2 | declined fee dialog not counted (`service.ts`) | KILLED: recovery-service “IR2” |
| MIR3a | phrase separator back to the old set (`host/log.ts`) | KILLED: log, 13 forms and the property |
| MIR3b | no short-key separator (`w1=`, `k=`) (`log.ts`) | KILLED: log “short keys, numbered”, “one-letter keys”, the property |
| MIR3c | quotes and backticks not separators (`log.ts`) | KILLED: log, 6 forms and the property |
| MIR4a | main takes any string as a typed mint (`main/prompt.ts`) | KILLED: recovery-main “typed mint addresses” |
| MIR4b | the host takes typed mints unchecked (`service.ts`) | KILLED: recovery-service “IR4” |
| MIR4c | the page's `https://` prefix check loosened to `https?` (`renderer/prompt/prompt.ts`) | SURVIVED, as designed: the `u.protocol` check and the copied grammar each refuse http again. Removing all three layers together is KILLED (prompt-recovery-page, 2 tests). The page is a convenience layer; main (MIR4a) and the host (MIR4b) enforce. |
| MIR4d | the answer guard takes any array as `mints` (`ipc/guards.ts`) | KILLED: recovery-guards “1..8 … mint addresses” |
| MIR5 | `if (false)` for the unreadable-phrase replace guard (`service.ts`) | KILLED: recovery-service “IR5” (the reviewer's survivor) |
| MIR6 | newest per `d` reversed (`host/recovery/relay-copy.ts`) | KILLED: recovery-relay-copy “newest per d” (the reviewer's survivor) |
| MIR7a | `replaces` cleared although the retirement failed (`service.ts`) | KILLED: recovery-service “IR7” |
| MIR7b | no retry of a pending retirement (`service.ts`) | KILLED: recovery-service “IR7” |
| MIR8 | rotation asks the reveal question (`service.ts`) | KILLED: recovery-service “IR8” |
| MIR8b | main words the rotate dialog as a reveal (`main/host-confirm.ts`) | KILLED: recovery-main “the rotate dialog” |
| MIR9 | `recovery-show` on the usual deadline (`host/signer/main-bridge.ts`) | KILLED: main-bridge “a shown phrase gets its own, longer deadline” |
| MIR10a | cap applied before blanks are dropped (`relay-copy.ts`) | KILLED: recovery-relay-copy “blanks never crowd out…” |
| MIR10b | the cap silent (`omitted: 0`) (`relay-copy.ts`) | KILLED: recovery-relay-copy “blanks never crowd out…” |
| MIR11 | `wipeAnswer` leaves the indices (`main-bridge.ts`) | KILLED: main-bridge “… word indices is zeroed” |

19 mutations: 18 killed. The one survivor is a redundant layer, and removing all its layers is
killed.

### Differential review and sharp edges of the fix commit (`134cdea..dd7addd`, 17 files)

Risk: HIGH `service.ts` (value: which mints are asked and reissued; which mints a restore
contacts), `main/prompt.ts` and `ipc/guards.ts` (a new optional key at the page → main → host
boundary), `log.ts` (the redaction every log line passes). MEDIUM `relay-copy.ts`,
`main-bridge.ts`, `host-confirm.ts`, the page. LOW tests and css. No validation was removed:
the dialog's guard is unchanged apart from the new `recovery-rotate` shape, and the answer guard
gained an optional, exact-key, capped field.

Blast radius: `redact()` covers every host log line, forwarded worker lines and upload error
text. It is broader, so it over-redacts more prose; the constant-message test holds.
`wipeAnswer` has 5 callers: 4 in `desktop-signer.ts`, which never receive a recovery answer, and
1 in the service. `MainBridge.ask`: only `recovery-show` changes deadline. `toPromptAnswer` has 1
caller (`PromptService.submit`). A refused answer there becomes a cancel ('prompt.bad-answer'),
so it fails closed. `readRelayCopies` has 1 caller.

Adversarial notes and sharp edges (none needed a code change):

- **D1 (info): the retirement retry runs before re-authentication** (`service.ts:332`). A
  renderer calling `setup` while a retirement is pending makes the signer sign a blank and a
  NIP-09 deletion of an already-replaced copy, and publishes them to the user's write relays
  (with NIP-46, two bunker requests). The step is idempotent, reveals nothing a first attempt did
  not, and ends once one lands. It is throttled, because the re-auth window that follows counts
  when dismissed. `finishReissue` already retired without a prompt when no plan was left to ask.
  Accepted.
- **D2 (info): the 30-minute show deadline.** Main shows one window at a time, and the host's
  deadline for a queued question starts when it is asked. A bunker-auth, top-up-first or unlock
  question queued behind an open phrase window can therefore time out to its safe answer.
  Residual 14.
- **D3 (info): typed mints are scanned for every phrase.** ADR §5.1 defines one mint set, so a
  typed mint receives restore requests (blinded outputs, nothing derivable) for each phrase the
  identity reaches, as the wallet's own mints do. This is the linkage ADR 0016 accepts. Residual
  15.
- **D4 (sharp edge, low): the page's copy of the mint grammar** could drift from `isMintUrl`
  (the page bundle imports no ipc code). A drift fails closed: main turns the answer into a
  cancel. It is pinned by a cross-check on 17 inputs and by the `RESTORE_MINTS` /
  `MAX_MINT_URL` pins (`prompt-recovery-page.test.ts`).
- **D5 (sharp edge): `mints: []` is refused** (guard minimum 1; main too). The page omits the
  key when the box is empty (tested: “twelve empty fields” sends exactly `{kind, words: []}`).
- **D6 (sharp edge): `recoveryShowTimeoutMs` 0, NaN or Infinity** fires at once (Node clamps an
  overflow to 1 ms). That fails closed: the phrase is discarded.
- `isReissuePlanWire` is exported inside `safe`. The whole form is still checked by
  `isConfirmForm` before it is posted (distinct mints, 1–32 plans), so an individual check can
  never bypass the form check. `RelayCopies.omitted` is a required field, so a caller cannot
  miss it silently. `reauth(purpose)` is a required union.

### Residuals added by this round

11. **An older relay-copy retirement is not retried after a further rotation.** If a phrase
    whose replaced copy X is still pending is itself rotated and the retry fails, `replaces`
    now names the newer phrase. X's retirement is kept only in the retired envelope. Deletion
    is best effort (ADR 0016).
12. **Restore reach:** the relay query is one page (`limit: 500` of the identity's kind-30078
    events, other apps' NIP-78 data included). Copies beyond the 64 cap are counted in the log,
    not paged in; paging across merged multi-relay answers with `until` is imprecise, so it is
    deferred. `listRetired` still reads at most 64 retired phrases per identity (64 rotations
    on one device, each re-authenticated).
13. **A phrase window closed or timed out** (now after 30 min) discards a new phrase. Settings
    stays silent on `cancelled`, and its status line reads “Not on this device”.
14. D2: prompts queued behind an open phrase window can time out to their safe answer.
15. D3: a typed mint sees restore requests of every scanned phrase. The phrase log rule still
    passes Title Case / UPPER CASE words and words separated by `(` or non-ASCII punctuation.

## Round 7 (2026-09-27)

The lane's independent verifier read the fix round at `51db26a` and raised three low findings.
Each was verified on `51db26a` first. The fixes and their tests are in `1c3f875`. The failing
runs quoted below were taken on `51db26a` code with this round's tests. The orchestrator
decided the approach for each: per-mint completion recorded in the envelope (R7-1), percent
escapes with hex letters and every other form the verifier listed, with canaries (R7-2), and an
explicit timeout with a stated reason, or a faster test (R7-3).

| # | Sev | Finding (verifier's anchor) | Verified | Fix (file:line at `1c3f875`) | Test |
| --- | --- | --- | --- | --- | --- |
| R7-1 | Low | The IR1 fix made a paying loop reachable. A plan the dialog cannot show (an http dev mint, over 100 000 inputs) keeps `complete` false, so every “Finish backup” planned every balance again and swapped, and charged, the mints already moved (`service.ts:520`) | Reproduced with the verifier's scenario (https mint-a 1 000 at fee 2, `http://127.0.0.1:3399` 500, three setups confirmed): `confirms = 3`, `reissued = [mint-a, mint-a, mint-a]`, fees `[2, 2, 2]`, `reissueFailed = 1` each time (a probe, since removed). After the fix, the same probe gives `confirms = 1`, `reissued = [mint-a]` and fees `[2, 0, 0]`. The five new service tests fail on `51db26a`'s `service.ts` | The envelope records `reissuedMints`: distinct https mint URLs, at most `MAX_REISSUED_MINTS` = 64 (`files.ts:50`, `:91`, parsed exact-key at `:140-145`). A file without the field is still read, as `[]`. The service writes each mint as soon as it moved (`service.ts:451-455`, `:596`). A retry skips the recorded mints without asking the mint for a plan (`:533`). It asks no more mints than the envelope can still record (`:559`). A new phrase, a rotation included, starts empty (`:364`). The completion write keeps the record (`...cur`). The file cap went from 16 to 64 KiB so 64 URLs of the longest kind fit | `recovery-service` “fix round 7” (5): the verifier's http scenario, run three times, and the envelope on disk as the record; a failed mint retried alone; more than 32 mints; the 64-mint room; rotation. `recovery-files` “reissuedMints …” |
| R7-2 | Low | The IR3 phrase rule caught only digit-only escapes (`%20`). `%2C`, `%2F`, `%3A`, `%5B` carry a hex letter that broke the run. `Word1=` keys and indentation over 12 characters passed too (`log.ts:59`) | Reproduced: 12 new canary forms and the property failed on the old rule. Two more new forms, lower-case escapes (read as mangled words such as `cwinner`) and one-letter upper-case keys, were already caught | A separator is 1–12 units (`log.ts:73-85`): a whole white-space run of up to 256 characters; one ASCII digit or punctuation character; a percent escape (`%` and two hex digits) or a lone `%`; or a key a phrase word cannot be (1–16 letters before a digit or `=`, not 3–8 lower-case letters). A word or key may start after a letter only when that letter ends a percent escape (`seedPhrase%3Dlegal…`). The parse stays unique: a white-space run is maximal, `%` is an escape exactly when two hex digits follow, a key ends where its letters end and is never word-shaped, and a word never ends in an escape. Residual 15's Title Case gap stays. Double-encoded escapes are residual 17 | `log`: 14 new forms (URL-encoded comma list, JSON array and JSON object, `%2F`, `%3A%20`, `%2c`, a form body `seedPhrase%3D…`, `Word1=`, `seedWord1=`, `recoveryword1=`, `W0=`, pretty-printed at 20, 14 (tabs) and 104 characters of indent), 4 more property formats, 7 hostile timing inputs |
| R7-3 | Low | The IR10 test timed out at the 5 s default in full app-desktop runs (5 238 ms, 6 789 ms) (`recovery-relay-copy.test.ts:286`) | Measured alone on this box (load 13): IR10 3.9 s, and the older “at most 64 copies” test 2.7 s. Per event, a `LocalSigner` sign (sign plus re-verify) costs about 32 ms, a verify about 11 ms and a NIP-44 decrypt about 13 ms. With `--testTimeout=1500` standing in for a loaded box, both tests time out on `51db26a` and pass after | Both real-crypto cap tests get an explicit `{ timeout: 30_000 }` (`recovery-relay-copy.test.ts:28`). The comment states why: about 130 real signatures and 200 verifications, the exercised cost, so no fakes. Nothing else changed in the tests. | the two tests themselves |

### Mutation checks (applied to this round's code, named suite run, file restored from a saved copy)

| # | Mutation (file) | Result |
| --- | --- | --- |
| M7a | a retry plans recorded mints again: `if (done.includes(mint))` → `if (false)` (`service.ts`) | KILLED: recovery-service fix round 7: the http scenario, the failed mint, more than 32 mints |
| M7b | the per-mint record never written (`service.ts`) | KILLED: the same three and the 64-mint room |
| M7c | no room check: asks beyond what the envelope can record (`service.ts`) | KILLED: “never asks more mints than the envelope can record” |
| M7d | a new phrase inherits the replaced phrase's record (`service.ts`) | KILLED: “a rotation starts a new record” |
| M7e | the completion write drops the record (`...env` for `...cur`) (`service.ts`) | KILLED: the failed mint retried alone, the rotation |
| M7f | an envelope from before the field refused (`files.ts`) | KILLED: recovery-files “reissuedMints …” |
| M7g | the file cap back to 16 KiB (`files.ts`) | KILLED: recovery-files “reissuedMints …” (64 longest URLs) |
| M7h | duplicate mints accepted (`files.ts`) | KILLED: recovery-files “reissuedMints …” |
| M7i | no bound on the list (`files.ts`) | KILLED: recovery-files “reissuedMints …” |
| M7j | no percent-escape unit (`%` back to a plain separator character) (`log.ts`) | KILLED: log, 6 escape forms and the property |
| M7k | no start after an escape's hex letter (`log.ts`) | KILLED: log “a form body whose key ends in an escape letter” |
| M7l | white space back to one character per unit (`log.ts`) | KILLED: log, the three pretty-printed forms and the property |
| M7m | keys back to 1–2 letters (`log.ts`) | KILLED: log `Word1=`, `seedWord1=`, `recoveryword1=`, the property |
| M7n | keys may be word-shaped (the exclusion dropped) (`log.ts`) | SURVIVED, as designed. The exclusion only keeps the split unique: a word-shaped key is read as a word, which redacts the same span. Without it the ambiguity is bounded, because a failing attempt has fewer than 8 words. Three ambiguous 4 KiB inputs took 0.05–0.68 ms either way |

14 mutations: 13 killed. The survivor guards the parse's uniqueness, not what is redacted.

### Differential review and sharp edges of this round (`51db26a..1c3f875`)

Risk: HIGH `service.ts` (which mints are asked and moved, and so which fees are paid). MEDIUM
`files.ts` (a new field in the phrase file that must never be refused wrongly: a refused file
is kept, and the phrase then covers nothing) and `log.ts` (every log line). LOW the tests and
the fake. No validation was removed. The envelope parse gained one exact-key shape. The old
shape still parses, as “nothing recorded”, which plans every mint as before.

Blast radius: `parseEnvelope` has 2 callers (`readEnvelope`, `writeEnvelope`). Envelopes are
read by `seedFor`, `status`, `setupNow`, `showNow` and `restoreNow`, and only
`finishReissue`/`reissueAll` use the new field. `redact()` covers every host line, forwarded
worker line and upload error. It is broader again. The constant-message test still passes over
every host and worker message. A fuzz of 3 000 random repeating 4 KiB inputs over the separator
alphabet (escapes, lone `%`, long runs, keys) took 8.2 ms at worst. That fuzz was a probe and
was removed.

- **S1 (sharp edge): a record write that fails after a successful swap** is logged (`a reissued
  mint could not be recorded`) and not counted as failed. The balance is under the phrase
  either way. A later retry may move that one mint once more, which is one extra fee (residual
  18).
- **S2: the record is keyed by the wallet's own mint string.** `balances()` keys and
  `plan.mint` are compared equal before a plan is used, so the recorded string is the one the
  next `balances()` returns.
- **S3: the mint list sits beside the sealed phrase.** It is not secret: the wallet journal
  holds the same URLs. It is never published, because the relay copy carries `sealed` only. It
  is never logged: the log line counts `covered` mints.
- **S4: the 64-mint room.** A mint beyond it is never asked and is counted failed. It is never
  moved twice. With 32 plans per question, that is two dialogs' worth.
- **S5: the unit-based separator** lets words 12 white-space runs apart (up to 256 characters
  each) read as a phrase. That is more over-redaction of padded text, which is accepted. The
  constant messages hold.

### Residuals added by this round

16. **A balance that can never be asked keeps “Finish backup” showing:** an http dev mint, or a
    mint beyond the 64-mint record. Rotation (“Replace phrase”) stays out of reach while it
    does. Each click now asks nothing and costs nothing, but Settings does not say why. A
    “cannot be covered from this app” state needs a status-wire change.
17. **The phrase log rule** does not catch double-encoded escapes (`%252C`), white-space runs
    over 256 characters, or keys over 16 letters. Residual 15's Title Case / UPPER CASE gap
    stands.
18. S1: a record write that fails after a swap can make a later retry move that mint once more.

### Gates (round 7)

- `npx tsc -b --force` clean. `npm run build` OK.
- eslint and prettier `--check` clean on the 8 changed ts files.
- `npm run check:locked` OK. `npm run lint:electron` OK (253 files, 0 violations). No
  dependency change, so `check:native` was not needed.
- Touched suites, run alone: `recovery-service` 34/34, `recovery-files` + `recovery-save-undo`
  + `recovery-host` 17/17, `recovery-relay-copy` 11/11 (also with `--testTimeout=1500`),
  `log` 64/64.
- The whole suite once with `--maxWorkers=2`, at load 15–18, took 829 s: 3499 passed, 43
  skipped, 2 failed.
  - The 2 failures are the known viewer-payer “I2-paygate rate-limited” base failures, owned by
    lane R6.
  - Two files, `stage.test` and `packaged-worker.integration`, refused to stage. The
    `tsc -b --force` gate had made ui's `dist` newer than the renderer bundle, and the stage's
    own freshness guard refuses that. Their 22 tests account for the extra skips.
  - After `npm run build`, run alone: `packaged-worker` 2/2; `stage` 19/20, the known R6
    failure (`QUIT_FLUSH_MS`); `viewer-payer` the same 2 known failures.
- No test timed out. No timeout was raised except R7-3's stated one.
