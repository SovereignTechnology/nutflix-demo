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
