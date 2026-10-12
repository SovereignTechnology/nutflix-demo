# Pre-push review — integration fix 2 (2026-09-27)

Diff: `30e4aea` (the fully merged Stage 3 integration head: auto top-up, F33, residuals,
packaging, the integration fixes, pay/1 OWED + PRICE.free on both sides, the payer reconcile,
NUT-13 core and desktop, with lane N1's core wired into lane N2's seam at
`packages/app-desktop/src/host/recovery/core.ts` `recoveryCore()`) → `stage-3/int-fix-2` (lane
I4-intfix). The lane takes the five test failures that appeared when N1's real core replaced N2's
fakes, and the low finding and the info note from N2's round-7 verifier. Method: the
`differential-review` and `sharp-edges` skills, run inline on the whole diff.

- Nothing changed under `packages/core/src/contracts/`, the locked audit paths
  (`npm run check:locked`: OK), `docs/status.md` or `docs/security-review.md`. Core is not
  touched at all: every change is in `packages/app-desktop/`.
- No contract request.
- Nothing outward: no push, MR or issue edit.

## The failures, re-run first at `30e4aea`

`npx vitest run` on the four files: 5 failed, 70 passed. All five reproduced as reported.

| Test | Failure at `30e4aea` | Cause | Outcome |
|---|---|---|---|
| `log.test` › no constant log message is swallowed | two P2 messages read `<redacted>` | 8 lower-case words in a row: the phrase rule's own threshold | **fixed**: the two messages reworded, the rule kept |
| `mint-transport.test` › one `CashuMintConnections` … no cashu-ts elsewhere | `host/recovery/core.ts` in the hits | the pin matched TEXT: core.ts's comment `// CashuMintConnections({ request, seed })` (not the `ConstructorParameters<typeof …>` type) | **fixed**: the pin parses the source; a type or a comment is not a construction |
| `money-seed.test` › seeded | `the recovery seed is wiped` at `new CashuMintConnections` | a `FakeSeed` from test support handed to core's real connections, which refuse a seed core did not make | **fixed**: core's real phrases and seeds |
| `money-seed.test` › a seed the wallet did not take | same | same | **fixed**: same; the only stand-in left is the lost option itself |
| `recovery-host.test` › setup → covered … | status `unavailable`, nothing reissued | (a) the fake seed refused at the plane's reopen; then, with a real seed, (b) the desktop's counters file refused core's phrase binding, so no lease was saved and the reissue failed | **fixed** at both causes (below) |

## What changed

- **`host/log.ts`** — the phrase rule (ADR 0016, finding 3):
  - a backslash escape is a separator unit, like a percent escape: `\` — or `%5C`, a JSON string
    inside a URL — and one of `n r t b f v`, `x` + two hex digits or `u` + four. It is forced
    (a `\` is an escape exactly when one of those forms follows, a `%5C` only then), so the parse
    stays unique; `\` left the one-punctuation-character class for its own unit;
  - a word or a key may start right after an escape that ends in a letter (`\n`, `%2C`, `\u000b`);
  - right after such an escape, a REMAINDER of one or two lower-case letters counts as a word,
    never as a key: `fade` joined by a lone `%` is `%fa` + `de`, `bag` joined by a lone `\` is
    `\b` + `ag`, numbered or not;
  - the doc comment: units, remainders, the linearity argument, and residual 17 narrowed.
- **`host/tails.ts:227`, `worker/pay/unpaid-record.ts:412`** — the two messages now read
  `the tail file is not valid JSON: starting empty` and `the unpaid record is not valid JSON:
  starting empty`.
- **`host/money.ts`**:
  - `MoneyPlane.open` is a wrapper over `openWith`: whatever fails, the seed it was given is wiped
    (before, a signer or NIP-60 failure — `no-wallet`, relays down — left that to the caller);
  - `close()` closes the wallet's NUT-13 counter source (`conns.seeding.counters.close()`, as core's
    contract request 4 says to reach it), before the key, the journal and the seed.
- **`host/recovery/files.ts`** — `parseCounterState` takes core's phrase binding: exactly one
  `published` entry `ff` + 32 lower-case hex → 0, with no `next` entry. Everything else stays as
  strict as before.
- **`host/recovery/core.ts`** — the wiring box describes the wired state (the old box still showed
  the pre-merge template), and says which tests run real code and which run fakes.
- **Tests**:
  - `mint-transport.test.ts`: `mintReach` (TypeScript compiler API, as `packaging/stage.ts`
    uses it) and a canary test of 18 ways in and 11 mentions;
  - `money-seed.test.ts`: rewritten on core's real code, 6 tests (3 new);
  - `recovery-host.test.ts`: on core's real code, plus a second device restoring from the relay
    copy;
  - `recovery-real-mint.integration.test.ts` (new, opt-in on `NUTFLIX_REAL_MINT_URL`);
  - `recovery-files.test.ts`: 3 new tests for the binding;
  - `log.test.ts`: 11 canaries, one fixed-list test, 7 property forms, 13 hostile inputs;
  - `support/real-recovery.ts` (new): `spyRecoveryCore()` — core's real `recoveryCore()`
    recording what the plane hands it, passing every call through — and `recoveryProfile()`, a
    host rig whose "main" answers the prompts like a user who writes the words down;
    `support/fake-recovery.ts` and `support/rig.ts`: header comments only.

## 1. The swallowed messages: the messages change, not the rule

The two messages are 8 lower-case words of 3 to 8 letters in a row (`the tail file does not parse`
+ `starting empty`), which is exactly the rule's threshold. Two options:

- **Relax the rule** (9 words, or exempt constant messages). Rejected. The threshold exists
  because part of a phrase is a head start: 8 known words of 12 leave 4 unknown, 2^44 candidates,
  2^40 after the checksum — within reach. And an exemption for our own strings would pass a
  phrase that a caller interpolates into one.
- **Reword the messages.** Chosen, as the test's own comment prescribes ("a message that does is
  reworded, not the rule relaxed"). `is` (2 letters) breaks the chain and `JSON` is upper case.
  Both new messages are also more precise: the failure is a parse, and invalid UTF-8 is not valid
  JSON either.

Both guarantees hold: the rule still redacts 8 words, and the test still fails for any constant
message it swallows. No test pins the old wording.

## 2. The pin: a construction, not a mention

The hit in `recovery/core.ts` was its comment. `ConstructorParameters<typeof
walletMod.CashuMintConnections>` never contained `CashuMintConnections(`. A text pin cannot tell a
comment, a string or a type from code, and it missed an alias outright
(`const C = walletMod.CashuMintConnections; new C()`).

`mintReach` parses each file. A file reaches a mint when it:

- imports `@cashu/cashu-ts` in any form: static (`import type` too, as the old pin had it), a
  re-export, `require`, `import()`, or an `import()` type;
- constructs `Mint` or `…CashuMintConnections`;
- uses `CashuMintConnections` as a value anywhere else: an alias, a destructuring,
  `obj['CashuMintConnections']`, a class `extends`, a value import or export, `Reflect.construct`.

These are not reaches:

- a reference inside a type: `typeof …`, a field's type, `implements`, an interface's
  `extends`, `import type`, `export type`, `{ type … }`;
- comments and strings.

The pin now asserts:

- `host/money.ts` is the only file that reaches a mint;
- money.ts's only use of the class is its one construction (no alias);
- the old text checks on money.ts are kept unchanged;
- `host/recovery/core.ts` is seen, as type-only.

The type check stays, and so does the pin's intent: a second construction site (P8), an alias
(P9) and a cashu-ts type import (P10) planted in `recovery/core.ts` are each caught. P9 would have
passed the old pin.

## 3. The desktop on core's real NUT-13 code

### 3a. The tests used fakes where the real core runs (the reported cause)

N2's host tests and money-plane tests handed `FakeRecoveryCore`'s `FakeSeed` to the real
`CashuMintConnections`. That worked while the connections ignored the key. N1's connections refuse
a seed they did not make: `counterBinding` throws `foreign`, reported as "the recovery seed is
wiped". So the plane's reopen failed with `invalid-argument`. `DesktopSigner` logged "payments stay
unavailable" (`reason: invalid-argument`, seen in the host log at `30e4aea`), `plane()` became
`undefined`, and `status()` returned `unavailable`.

- **money-seed** now runs core's `recoveryPhrases`, core's seeds and core's `recoveryCore()`
  through a pass-through spy. The only stand-in is `loseOption`, a core whose seed option comes back
  empty — a renamed key, which is exactly what that test is about.
- **recovery-host** now runs the host's default `recoveryCore()` (through the spy, to read which
  counters file the plane got). The phrase is core's random one: the canary takes its indices from
  what main was shown. The TestMint charges 100 ppk. So the reissue is core's real swap: 2 000 sats
  in six proofs, a 1 sat fee, the same `1 999 / 1` the fake had scripted.
- **The service's unit tests** (`recovery-service`, `recovery-save-undo`) keep the fakes. Their
  money plane is a stub, and the fake's scripted plans, reports and failures are the point there.
  `fake-recovery.ts` now says it must never meet a real `MoneyPlane`.

### 3b. The counters file refused core's phrase binding (found here: the cause behind 3a)

With real seeds the host reached `covered` and still reissued nothing (`reissueFailed: 1`). Core's
message was `mint-error: reissue failed (Error)`. Instrumenting core's `dist` for one run showed
`invalid-argument: not a counter state (not saved)` from `FileCounterStore.save`
(`files.ts:360` at the base).

- Since N1's independent review, core binds each counters file to its phrase: `save` writes
  `published[ff<32 hex>] = 0`, with no `next` entry (`seed.ts` `counterBinding`; core's contract
  request 4). N2's `parseCounterState` admitted keyset ids only, and a watermark only with its
  `next`.
- **Impact on the merged build:** once a device had a phrase, every seeded operation that needed a
  lease failed before it reached the mint — the reissue, a top-up's mint, a send's change, a PAY's
  change. No money was lost (nothing was sent), but "covered" meant "cannot spend".
- **Fix:** exactly core's binding is admitted: one entry, in `published` only, value 0, `ff` + 32
  lower-case hex. A watermark without its keyset's `next` is still refused (the existing
  damaged-file case), and so are two bindings, a non-zero one, one in `next`, and a wrong length or
  case.
- **Proof:** a test runs core's real `DurableCounterSource` over the real `FileCounterStore` (a
  seeded mint writes its lease with the binding, and a new store reads it back). The real-mint test
  fails without the fix on Nutshell (mutation F1-real).

### 3c. A failed open left the seed to the caller (found here)

`MoneyPlane.open` wiped the seed only for failures inside its `try`. `getPublicKey` and
`openNip60Wallet` ran before it, and the plane's own documentation says "wiped when the plane closes
(or fails to open)". The host's `openMoney` happened to wipe it too; the old test accepted
`seed.wiped || core.materials.length === 0` for that reason. The plane now wipes on every failure,
and the test asserts `seed.wiped` outright.

### 3d. The plane's close left the NUT-13 counter source open (found here)

Core's contract request 4: "`CashuWallet.close()` closes that shared source … Reopen only after
`close()` resolved". The plane never closed its wallet; it only wiped the seed.

- Core's `save` lets an OPEN source take over a file another phrase wrote.
- After a rotation (`saveNew` moves the counters file aside; the next plane binds a fresh file to
  the new phrase), any operation still running or queued in the old wallet that saved a lease would
  write the OLD phrase's state over the new phrase's file. Examples: the journal settle moving
  counters past a collision (`advanceToAtLeast`), or a PAY queued at a mint.
- Core's layered defences keep that from losing money — the probe and the collision guard — but
  it is the lifecycle core asks the shell to avoid.
- **Fix:** `close()` closes the source synchronously. Every later reservation or advance is refused
  (`the NUT-13 counters cannot be used (CounterStateError)`, before any request).
- **Why not `CashuWallet.close()`:** its watermark flush lands whenever the running operations end.
  The first draft called it without awaiting, and the host test's teardown then hit `ENOTEMPTY`:
  the flush wrote into `<userData>/wallet` after the host had stopped, while the directory was being
  deleted. In production that is a write after a quit's `flushTails` (which is bounded by the disk,
  not the network), or one racing the next plane's counters-file rotation. Awaiting it would hold a
  signer swap for as long as a melt in flight (up to 300 s).
- Without the flush, the `published` watermark only lags. That matters only for
  `restoreUnpublished`, which the desktop does not call (residual 1).

### Confirmed with tests

- **`CashuWallet.seeded` reads the seed through the plane's one connections instance:**
  - the spy saw `seedOption` called once, with the plane's material and counters store;
  - `seeded` was asked about the plane's wallet only, and returned that wallet's own `seeded`;
  - the counters store got a lease for the mint's keyset;
  - the words alone bring the plane's 64 sats back on a separate wallet (core's restore at the
    TestMint);
  - mutations MS3 (option not spread), MS4 (the wallet given a wrapper without `seeding`), MS6 and
    MS7 (`recoveryCore()` broken) all fail.
- **A wiped seed is refused at derivation time:**
  - wiped under an open plane: the next mint request and the next send (its change) are refused
    with `RecoverySeedError` before any `POST /v1/mint/bolt11` or `/v1/swap`, and the balance is
    intact;
  - wiped before a mint loaded: the load is refused (`the recovery seed is wiped`);
  - handed wiped to `open`: the plane does not open. Core refuses it at the connections, and
    payments stay off rather than running on random outputs under a phrase.
- **End to end, in-process** (`recovery-host.test.ts`, TestMint at 100 ppk):
  - device A: setup, native fee confirm, 1 999 reissued (fee 1), `covered`, a restore reporting
    `nothing` (A holds its own proofs), show again, the canary;
  - device B: the same identity imported on a fresh profile, relays that kept the wallet event
    and the relay copy but lost the token, history and deletion events. B sets up its own phrase
    (nothing to reissue, no dialog). The restore reads 2 phrases (B's, and A's relay copy) and
    reports `restored 1 999`; the balance is 1 999; a second restore adds nothing.
- **End to end against real mints** (`recovery-real-mint.integration.test.ts`, the same two
  devices):
  - the wallet names the mint by an https alias (the fee dialog shows https mints only), and the
    host's own `node:http` transport carries each request to the local mint;
  - the fee main's dialog showed equals `ceil(inputs × input_fee_ppk / 1000)` from the mint's
    `/v1/keysets`, and is the fee paid;
  - B's restore returns exactly what A reissued, and a send swaps part of it at the mint;
  - passed on **Nutshell 0.21.0** (`http://127.0.0.1:3399`) and **cdk-mintd 0.18.1**
    (`http://127.0.0.1:3397`).
  - On the merged build, the other real-mint suites also passed on both, with
    `NUTFLIX_REAL_MINT_URL_2=http://127.0.0.1:3398`:
    - core `nut13-real-mint` + `journal-real-mint`: 17/17 on each;
    - app-desktop `topup-real-mint`, `desktop-owed.integration` and the new test: 6/6 on each.

## 4. The N2 round-7 verifier's notes

### [low] JSON-encoded phrases joined by `\n`, `\t` or `\r\n` → **fixed**

Reproduced on the base with the verifier's method: 2 000 random 12-word phrases, counting phrase
words still present in the output.

| Form | Base: 8+ words present | Now: 2+ words present |
|---|---|---|
| `JSON.stringify(words.join('\r\n'))` | 2000 / 2000 | 0 / 2000 |
| `JSON.stringify(words.join('\n'))` | 341 / 2000 | 0 / 2000 |
| `JSON.stringify(words.join('\t'))` | 341 / 2000 | 0 / 2000 |
| `JSON.stringify(words.join('\v'))` (`\u000b`) | 349 / 2000 | 0 / 2000 |
| `encodeURIComponent(JSON.stringify(words.join('\n')))` (`%5Cn`) | 345 / 2000 with the backslash unit alone | 0 / 2000 |
| `words.join('%')` | 168 / 2000 | 0 / 2000 |
| `words.join('\\')` | 0 / 2000 | 0 / 2000 |

The `%5Cn` row was found while measuring. It is the same gap one encoding down, closed by reading
`%5C` before an escape form as the backslash.

### [info] the lone-`%` regression from fix round 7 → **fixed** (cheap)

`fade` joined by a bare `%` read as the escape `%fa` + `de`, which broke the chain; so did `face`,
`add` and `deaf`. The remainder rule makes `de` a word. The verifier's vector now comes back as
`<redacted>`.

The backslash unit brings the same risk to a bare `\` (`bag` read as `\b` + `ag`), and the rule
covers it the same way.

### Found in this review: the first draft dropped numbered words

The first draft made a remainder a KEY when a digit or `=` followed (to keep keys and remainders
disjoint). Then `bag0\tag1\net2…` lost every 3-letter word that starts with an escape letter, each
read as a key. The base had counted those words: a regression. The fix inverts it: a remainder
is always a word, and a key never starts where a remainder does. The numbered forms (`%`, `\`,
`%5C`) have a canary, and mutation L11 is the draft.

### No regression against the base: differential check

Both rules (`30e4aea`'s and this one) were run on 40 000 generated strings: 8 to 13 words (a third
of them starting like an escape), separators drawn from 35 forms (escapes, lone `\` and `%`, keys,
punctuation, white space), and stray letters glued on.

- **Result:** 22 905 strings matched at the base. **No character the base redacted is left
  unredacted now.** 8 469 strings are redacted more widely.
- An earlier run with more chain-breaking separators: 312 base matches, 0 lost, 1 251 wider.

### Linearity

The hostile-input test gained 13 inputs: runs of `\n`, `\`, `%5C` and `%5Cn`, chains of seven
words broken at the eighth by escapes, remainders and keys. Each still stays under its 250 ms bound
with room to spare; the file's 76 tests run in about 1 s.

The uniqueness argument in the doc comment was extended:

- a `\` is an escape exactly when one of its forms follows, a `%5C` only then;
- a remainder is at most 2 letters (never a word) and a key never starts where one does;
- anything else that follows a letter still needs an escape before it.

## Sharp edges checked

- **Seed ownership (`MoneyPlane`).** The plane wipes its seed on every way out: a failed open (any
  step), close. The host's own wipe after a failed open stays; a second wipe is idempotent. No
  caller reuses a seed after a failed open: `seedFor` makes a fresh one per open.
- **Counter source close.** It is synchronous and idempotent (`DurableCounterSource.close()`). A
  later plane builds new connections over a new `FileCounterStore` object, so core's `SOURCES` map
  never hands it the closed source. A closed source never writes: no `flush` is called, and
  `save` refuses after `close`.
- **`parseCounterState`: zero, empty, confusion.**
  - An empty `published` and a file that is only a binding are admitted; they hold no counter.
  - Refused: two bindings, a non-zero binding, a binding in `next`, `ff` + 30 or 34 hex, upper
    case, `fe…`.
  - The binding holds no secret (it confirms a guessed phrase only). A local attacker who can write
    the 0600 file gains nothing they did not have: writing another phrase's binding makes core read
    the file as no state and probe one batch at the mint — the same as deleting the file.
- **The seam's option type.** `SeedConnectionsOption` is `Pick<…, 'seed'>` with `seed` optional,
  so an implementation returning `{}` type-checks. That is exactly the lost-option case, and it is
  caught at run time: the plane logs an error, wipes the seed, status `unreadable` (test "a seed
  the wallet did not take").
- **A seed core refuses fails closed.** A wiped or foreign seed stops the plane from opening
  (payments unavailable, status `unavailable`). The alternative — an unseeded plane under a phrase
  — would make ecash the phrase does not cover while the user believes it does. Only a bug can
  cause it (`seedFor` always hands a fresh core seed); stated in `core.ts`'s box.
- **The fake stays fenced.** `fake-recovery.ts` and `core.ts` say a fake seed must never meet a
  real plane. It would not be silent anyway: the plane would not open, and every host test would
  fail.
- **The phrase rule's input.** Unchanged: control characters are replaced first, and at most
  8 × 512 characters are read.
- **Test-only network.** The real-mint test reaches only the URL in `NUTFLIX_REAL_MINT_URL` (any
  other mint is refused by its transport), and only when the variable is set.

## Differential review notes

- **Blast radius.**
  - `redact`: 7 production call sites (every log field and worker line). The rule only widens
    (differential check), so what it can cost is over-redaction. The constant-message test still
    passes: 143 `log.*` call sites, none swallowed.
  - `MoneyPlane.open`: one caller (`host.ts:375`).
  - `MoneyPlane.close`: one caller (`DesktopSigner.retire`, `desktop-signer.ts:733`).
  - `parseCounterState`: `FileCounterStore.load/save` only.
- **Removed code, from history.**
  - The `\` in the punctuation class came from IR3 (`2d02d6b`); it is replaced, not dropped: a lone
    `\` is still a unit.
  - The keyset-id-only key test in `counterMap` came from `2d02d6b`, before N1's binding
    (`0150563`). It still applies to `next`; `published` admits the binding only.
- **Tests changed, never weakened.**
  - money-seed's "failed open" now asserts `seed.wiped` outright (was `|| materials.length === 0`).
  - recovery-host's same-device restore now expects core's real `nothing, 0`: A holds every proof
    the restore finds. The old `restored, 5` was a fake's script.
  - The `restored` path is asserted by the second-device test (1 999) and the real-mint test. The
    progress events, the per-mint row, the canary, the 0600 file, the relay copy, the counters path
    and the fee confirm are all kept.
- **No new dependency.** `typescript` 6.0.3 (root devDependency, already imported by
  `packaging/`) is imported by one test file.

## Mutation checks

Each mutation was applied alone to the final code; the named test files were run, then the file
was restored (checked by digest).

| # | Mutation | Result | Killed by |
|---|---|---|---|
| L1 | no backslash units (`\` one punctuation character again) | killed | CRLF / pretty JSON canaries, property, fixed lists |
| L2 | no remainder word | killed | property, fixed lists |
| L3 | nothing may start after a backslash escape's letter | killed | property, fixed lists |
| L4 | a backslash escape not forced | survived — equivalent | parse uniqueness only (below) |
| L5 | a key may start where a remainder does | survived — equivalent | parse uniqueness only |
| L6 | no `\u` form | killed | property, fixed lists (8-letter words) |
| L7 | no `\x` form | killed | fixed lists |
| L8 | no `%5C` backslash unit | killed | URL canaries, property, fixed lists |
| L9 | `%5C` + escape not exclusive of the percent unit | survived — equivalent | parse uniqueness only |
| L10 | nothing starts after a `%5C` escape's letter | killed | fixed lists (`encodeURIComponent(words.join('\\'))`) |
| L11 | a remainder before a digit or `=` is a key again (the first draft) | killed | numbered fixed lists |
| M-msg1/2 | either message reverted | killed | the constant-message test |
| P1 | the pin back to the text regex | killed | the pin |
| P2 / P3 | every reference a value / a type | killed | the pin / the canaries |
| P4–P7 | class `extends` as a type; `obj['…']` unseen; a construction's callee counted twice; `require`/`import()` unseen | killed | canaries / the pin |
| P8–P10 | a second construction, an alias, a cashu-ts type import planted in `recovery/core.ts` | killed | the pin |
| P11 / P12 | `import { type … }` / `export type { … }` read as values | killed | canaries |
| MS2 | a failed open does not wipe the seed | killed | money-seed |
| MS3 | the seed option not spread into the connections | killed | money-seed (4 tests) |
| MS4 | the wallet given a wrapper that drops `seeding` | killed | money-seed |
| MS5 | close does not wipe synchronously | killed | money-seed |
| MS6 / MS7 | `recoveryCore()` reads no `seeded` / drops the seed | killed | money-seed |
| MC1 | close leaves the counter source open | killed | money-seed |
| F1 | the binding refused again | killed | recovery-files (2), recovery-host (2); real-mint on Nutshell |
| F2–F5 | a binding with any value; several; in `next`; a looser key | killed | recovery-files |

L4, L5 and L9 are equivalent in output. Each lets one span be parsed two ways that redact the same
characters. The parse count they add is bounded: a failing chain has at most seven words, each with
at most two parses, so no input length makes them slow, and no timing test can kill them. They
exist to keep the linearity argument's "exactly one way", as N2's M7n did.

## Gates

- Tests of the touched package (`app-desktop`, `--maxWorkers=2`): 107 files, 2 022 passed,
  2 skipped (the opt-in real-mint files).
- The whole suite, once (`npx vitest run --maxWorkers=2`), after a fresh `npm run build`: 235 files
  passed, 5 skipped; 3 829 tests passed, 30 skipped; 972.6 s; no timing failure to rerun. See the
  lane report.
- `npx tsc -b --force`: clean (test files are compiled too). `npm run build`: clean.
- eslint and `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK.
- `npm run lint:electron`: OK, 263 files, 0 violations.
- No Electron e2e (as briefed).

## Residuals

1. **The desktop never calls `CashuWallet.restoreUnpublished()`** (core's contract request 4, and
   N1's residual). A keyset whose `[published, next)` range was not empty at load keeps its
   watermark. Ecash a crash left off NIP-60 comes back only through an explicit restore: the own
   phrase scans through the counters file's `next`, so it is covered there. Not wired here:
   scanning each mint at every start (privacy: each mint sees this device's range at each start;
   start-up latency) is its own decision.
2. **The watermark is not flushed at plane close** (no `CashuWallet.close()`; §3d). The on-disk
   `published` lags. That only matters once 1 is wired (a larger first range).
3. **Core names a foreign seed "wiped".** `CashuMintConnections` maps every `counterBinding`
   failure to "the recovery seed is wiped", which misled the diagnosis here. N1's code.
4. **The seam's `CounterState` comment** still says "keyset id →" for both maps, while core stores
   the binding in `published`. N1's contract request 7 proposes saying so. The desktop admits
   exactly that entry now.
5. **The phrase log rule (N2 residual 17, narrowed)** still misses:
   - double-encoded escapes (`%252C`, `%255Cn`);
   - white-space runs over 256 characters;
   - keys over 16 letters;
   - Title Case and UPPER CASE words (N2 residual 15).
6. **The real-mint host test is opt-in** (`NUTFLIX_REAL_MINT_URL`); CI stays offline. The
   in-process host test covers the same flow on the TestMint.
