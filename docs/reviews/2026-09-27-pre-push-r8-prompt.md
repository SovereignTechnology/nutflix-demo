# Pre-push review — round 8, prompt window and packaging (2026-09-27)

Diff: `aca2d6a` (the merged Stage 3 head after integration fix 2) → `stage-3/r8-prompt` (lane
W8c-prompt). The lane takes the five round-8 findings from the final cross-lane panel's packaging
review: one medium, two lows and two info items. Method: the `differential-review` and
`sharp-edges` skills, run inline on the whole diff.

- Nothing changed under `packages/core/src/contracts/`, the locked audit paths
  (`npm run check:locked`: OK), `docs/status.md` or `docs/security-review.md`. Core is not touched.
  Every code change is in `packages/app-desktop/`.
- No contract request. `HostOut` is the desktop's own main ↔ host protocol
  (`packages/app-desktop/src/ipc/protocol.ts`), not a core contract.
- Nothing outward: no push, MR or issue edit.
- No new dependency and no lockfile edit.

## The findings, verified first

| # | Finding | Verified how | Verdict |
|---|---|---|---|
| 1 | [medium] `<datalist>` suggestions drawn outside content protection on macOS | Code read: each word field carried `list="nf-words"` (`prompt.ts:158`), and the datalist was appended at lines 709 and 792. Chromium draws datalist suggestions in its own popup widget, and `setContentProtection` is set per window. **Not reproduced**: this box is Linux, where there is no content protection at all. | Fixed by construction: the page no longer uses a datalist, so the macOS behaviour no longer matters. |
| 2 | [low] a timed-out host confirm leaves main's dialog up and main busy | Code read: `MainBridge.confirm`'s timer resolved `false` and posted nothing, and `HostConfirms` had no cancel path (`hostGone` only bumped a generation, and `open` stayed `true` until the dialog settled). Reproduced by the new tests: 8 failed at the base. | Real. Fixed. |
| 3 | [low] the stage's freshness rule ignores the prompt page's npm code | Code read: `bundleInputDirs` and `bundleConfigFiles` never reach `node_modules`. The stage tests filter `node_modules` out of the pin on purpose. Measured: npm writes installed files with install-time mtimes here (`node_modules/@scure/bip39/index.js`: 2026-09-25 20:58), so mtimes do move on a bump. Reproduced: the new synthetic-repo cases staged the stale bundle at the base (6 failed: "promise resolved instead of rejecting"). | Real. Fixed. |
| 4 | [info] `PROMPT_NPM` admits paths nested under the allowed packages | Probed: both of the finding's paths passed the old regex. With the predicate swapped back to the old regex, 7 of the new tests fail. Today's real inputs are exactly bip39, its nested `@noble/hashes` and `@scure/base`, and `english.js`. | Real (latent). Fixed. |
| 5 | [info] `.words { display: grid }` overrides `[hidden]` | CSS cascade: an author `display` beats the user-agent `[hidden] { display: none }`. jsdom reports `none` either way (probed), so jsdom cannot show it. | Real (cosmetic). Fixed. |

## What changed

- **Finding 1 — `src/renderer/prompt/prompt.ts`, `prompt.css`.**
  - `wordDatalist` is gone.
  - `wordSuggestions(fields)` draws up to `SUGGESTIONS` (6) words from `suggestWords(typed)`: the
    page's own `wordlist`, prefix-matched after the same normalisation as `wordIndex`, in list
    order.
  - They go in ONE in-page `<ul role="listbox">`, moved into the wrapper of the field being typed
    in (the wrapper is `position: relative`; the list is absolute under it).
  - The fields are WAI-ARIA comboboxes: `aria-autocomplete=list`, `aria-controls`,
    `aria-expanded`, and `aria-activedescendant` on the chosen option.
  - Keyboard: ↓ opens or moves, ↑ moves (both wrap), Enter takes the word (`preventDefault`, so
    no submit), and Escape closes the list only (`stopPropagation`); the next Escape cancels as
    before. Mouse: a primary-button `mousedown` takes the word (`preventDefault` keeps the focus).
  - The list closes on field blur and window blur, and the view's `onMount` cleanup empties it
    when the answer is sent.
- **Finding 5 — `prompt.css`.** A global `[hidden] { display: none !important; }`. An important
  author declaration beats every normal one whatever its specificity, and no other rule in the
  file sets an important `display`.
- **Finding 2 — `src/ipc/protocol.ts`, `src/ipc/guards.ts`, `src/host/signer/main-bridge.ts`,
  `src/main/host-confirm.ts`, `src/main/main.ts`.**
  - `HostOut` gains `{ kind: 'confirm-cancel', req }`, exact in `isHostOut`.
  - `MainBridge` posts it when a confirm's deadline passes (only if the confirm was still waiting)
    and for every waiting confirm in `cancelAll`.
  - `HostConfirms` keeps the open dialog as `{ req, abort: AbortController }` and hands
    `abort.signal` to `ask`. `cancel(req)`, for the open request only, and `hostGone()` both
    abort it and free the slot at once.
  - A dialog whose signal aborted never answers. The `gen` counter is gone: the abort flag now
    drops an old host's answer.
  - `main.ts` passes the signal into `dialog.showMessageBox` (Electron: "the message box will
    behave as if it was cancelled by the user") and routes `confirm-cancel` to
    `hostConfirms.cancel`.
- **Finding 4 — `packaging/prompt-npm.ts` (new), `scripts/bundle.ts`, `scripts/tsconfig.json`.**
  - `isPromptNpmInput(path, roots)` parses the path by segments. It must start with
    `<root>/node_modules/`, where the root is this package or the repo root. Then come one or
    more `node_modules/<pkg>` pairs, each `<pkg>` one of `PROMPT_NPM`, then a file path with no
    `node_modules`. `.`, `..` and empty segments are refused.
  - `bundle.ts` calls it with `[pkg, repo]`, and its error message now names all three packages.
  - `scripts/tsconfig.json` gets `allowImportingTsExtensions`, so that standalone config accepts
    the `.ts` import. It is not part of `tsc -b`; only `bare-probe.ts`'s old errors remain in it.
- **Finding 3 — `packaging/stage.ts`.**
  - `promptNpmDirs(lock, workspace)` resolves `PROMPT_NPM_IMPORTS` (`@scure/bip39`) from this
    package through the lockfile, then its dependencies transitively, each from its own install
    location (optional ones skipped when absent). It refuses one the lockfile does not list.
  - `assertCurrentBuild` takes `npm` (required). For each directory it refuses a path that is
    missing or not a directory, and it counts the directory's own mtime and its newest installed
    file.
  - `BUNDLE_CONFIG` adds `packaging/prompt-npm.ts`.

## Tests, and what each fails without

- `src/renderer/__tests__/prompt-recovery-page.test.ts`:
  - `suggestWords`;
  - both words windows: no `datalist`, `select` or `[list]` anywhere in the document; every field
    a combobox over the page's listbox;
  - typing shows the page list's prefix matches, in the field's own wrapper;
  - keyboard (↓/↑ with wrap, Enter not submitting, Escape twice);
  - click (and not with another button), field blur, window blur, and the list emptied on send.
  - The old `datalist option` × 2048 pin is replaced by `expect(root.querySelector('datalist')).toBeNull()`,
    with a comment citing the finding. That assertion pinned the defect.
  - Against the base page, with stub exports so the file loads: 8 failed.
- `src/main/__tests__/bundle.test.ts`: the `[hidden]` rule on the shipped `dist/prompt/prompt.css`
  (equal to the source). No other important `display` in the file, and `.words` / `.suggest` do
  set a display.
- `src/main/__tests__/recovery-main.test.ts`: `HostConfirms` cancel; a dialog that ignores its
  signal (late answer dropped, next confirm not busy); a cancel for another request; host gone,
  then a restarted host's confirm asked before the old dialog settles.
- `src/main/__tests__/main-wiring.test.ts`: through main.ts and the fake Electron dialog (now able
  to hold a dialog open until its `signal` aborts):
  - a malformed cancel or a cancel for another request closes nothing;
  - `confirm-cancel` aborts the dialog and posts no `confirm-result`;
  - the next confirm gets a dialog and its answer;
  - a host exit aborts an open dialog.
- `src/main/__tests__/confirm-cancel.test.ts` (new): the host's `MainBridge` (deadline → `false` +
  `confirm-cancel`, a late answer ignored; an answered confirm not cancelled; `cancelAll`), and
  both halves wired together (deadline → dialog closed → next confirm answered).
  - The bridge is loaded with a runtime `import()`. The lane allowlist covers `main-bridge.ts`
    but not `src/host/__tests__/`, and a static import of host code from a main test puts that
    file in the main tsc project, which the composite build refuses (TS6307).
  - Its natural home is `src/host/__tests__/main-bridge.test.ts`, where the orchestrator may move
    it.
- `src/ipc/__tests__/recovery-guards.test.ts`: `confirm-cancel` exact (no extra keys, integer id,
  host → main only).
- `packaging/__tests__/prompt-npm.test.ts` (new):
  - the predicate: accepted layouts, the finding's two probes, and 15 refusals;
  - the page imports only `PROMPT_NPM_IMPORTS`;
  - `bundle.ts` imports and uses the predicate with `[pkg, repo]`, and the loose regex is gone;
  - every input of the real prompt bundle passes, and the packages used are exactly the three.
- `packaging/__tests__/stage-guards.test.ts`: the fixture installs bip39 (hoisted), a nested
  `@noble/hashes` and a hoisted `@scure/base` before the build.
  - Refused after a bump to any watched file, and after the package directory's mtime moves;
    rebundled, it stages.
  - Another installed package touched still stages.
  - Unlisted in the lockfile, or not installed: refused.
- `packaging/__tests__/stage.test.ts`:
  - `promptNpmDirs` against the real prompt bundle: every npm input lies in one watched directory
    with no deeper `node_modules`, and every watched directory is read;
  - the `BUNDLE_CONFIG` pin now follows the script's relative imports, so the watched set still
    equals exactly what the bundle reads.

## Mutation checks

Each mutation was applied alone to the finished code, the named tests run, and the file restored.

| Id | Mutation | Result |
|---|---|---|
| P1 | word field gets `list=` again | killed (2 tests) |
| P2 | suggestions not capped | killed (2) |
| P3 | the lone exact match still offered | killed (2) |
| P4 | suggestions from a reversed list | killed (3) |
| P5 | Enter takes a word without `preventDefault` (form would submit) | killed (1) |
| P6 | Escape on an open list also reaches the window (cancels) | killed (1) |
| P7 | answer sent: list not emptied | killed (1) |
| P8 | field blur does not close | killed (1) |
| P9 | window blur does not close | killed (1) |
| P10 | list not moved under the field | **survived at first**: the test checked `parentElement.contains(field)`, which the form also satisfies. Tightened to the field's own wrapper; then killed (2) |
| P11 | ↑ does not wrap | killed (1) |
| P12 | `mousedown` without `preventDefault` | killed (1) |
| P13 | any mouse button takes a word | killed (1) |
| P14 | no `aria-activedescendant` | killed (1) |
| C1 | no `[hidden]` rule | killed (1) |
| C2 | `[hidden]` rule not important | killed (1) |
| B1 | bridge deadline posts no `confirm-cancel` | killed (2) |
| B2 | `cancelAll` posts no `confirm-cancel` | killed (1) |
| H1 | `close` does not abort the dialog | killed (5) |
| H2 | `close` keeps the slot (busy until the dialog settles) | killed (2) |
| H3 | a closed dialog still answers | killed (5) |
| H4 | `hostGone` closes nothing | killed (3) |
| H5 | `cancel` ignores the request id | killed (2) |
| M1 | main.ts ignores `confirm-cancel` | killed (1) |
| M2 | main.ts does not pass the signal to the dialog | killed (1) |
| G1 | `isHostOut` refuses `confirm-cancel` | killed (2) |
| A1 | allow-list ignores the roots | killed (3) |
| A2 | allow-list checks only the first package in the chain | killed (1) |
| A3 | allow-list admits `node_modules` inside the file path | killed (1) |
| A4 | `bundle.ts` back on the loose regex | killed (1) |
| S1 | stage watches no npm code (`npm: []`) | killed (6) |
| S2 | package directory mtime not counted | killed (1) |
| S3 | dependencies not followed | killed (4) |
| S4 | an uninstalled package skipped | killed (1) |
| S5 | `BUNDLE_CONFIG` without the allow-list module | killed (1) |

35 mutations, all killed once P10's test was tightened. B1 and B2 were rerun after the bridge
tests moved to `src/main/__tests__/confirm-cancel.test.ts`, so they also prove the runtime import
loads the source file, not `dist/`. The stage group ran first on a fresh build: restoring a
mutated bundle input leaves a newer mtime, which the stage's own freshness rule then refuses.

Not mutated: the bridge's `if (!this.confirms.delete(req)) return` guard before posting. An
answer clears the timer, so without the guard the output is the same in every reachable order.

## Gates

- `npx tsc -b --force` and `npm run build`: clean.
- The whole suite (`npx vitest run --maxWorkers=2`): 237 files passed, 5 skipped; 3 874 tests
  passed, 30 skipped; 351.75 s.
- `app-desktop` alone: 2 067 passed, 2 skipped.
- eslint and `prettier --check` on the changed files: clean.
- `check:locked`: OK. `lint:electron`: OK (266 files, 0 violations).
- Real mints: `recovery-real-mint.integration.test.ts` passed on Nutshell `:3399` and cdk-mintd
  `:3397`.

## Differential review

- **Blast radius.**
  - `HostConfirms` has one caller (`main.ts`), and `MainBridge.confirm` one (the recovery service
    in the host).
  - The new `HostOut` kind is consumed only by `onHostOut` in `main.ts`, after `isHostOut` in
    `host-link.ts`. That `switch` has no `default`, so an unhandled kind would have been silently
    ignored. M1 pins the new case.
  - `assertCurrentBuild` has one caller (`stageApp`). `npm` is a required option, so no caller
    can leave it out by accident.
  - The prompt page's change is confined to the two recovery word views; no other view uses
    `wordField`.
- **Removed code, and where it came from.**
  - `wordDatalist` and the loose `PROMPT_NPM` regex came from lane N2 (`9e703e2`, `e00272f`).
  - `HostConfirms.gen` came from `e00272f`.
  - None came from a security-fix commit. The "an answer for a host that went away is dropped"
    behaviour `gen` gave is kept (its test passes unchanged) and is now also enforced by the abort
    flag.
- **Trust boundaries.**
  - `confirm-cancel` comes from the host, which main already treats as less privileged. It can
    close only the dialog for its own request: `cancel` matches `req`, and `HostConfirms` never
    holds the renderer's money-gate dialogs, which go through `askUser`.
  - A host could open, cancel and reopen its own dialogs, where before a second question was
    refused while one was up. That is no gain to a host, which already holds the signer and the
    seed.
  - On Linux and Windows the abort closes the dialog. On macOS a parentless box blocks main until
    it is answered, so two host dialogs cannot be on screen at once.
- **The trusted window.**
  - Suggestions are text nodes (`el()` appends strings) built from the constant list. No new IPC,
    storage or network.
  - Typed words were already visible in the plain-text fields. The list adds nothing a capture of
    the (protected) window would not show, and it leaves the DOM when the answer is sent.
- **Escape.** In the two word views, Escape with an open list now closes the list first. Those
  views' cancel is "Later" (`null`), not a `safeNo` answer, and the second Escape still cancels.

## Sharp edges

- **`HostConfirmsDeps.ask(prompt, signal)`.** A dependency that ignores the signal leaves the
  dialog on screen, but its answer is still dropped and the slot freed, so the result stays
  consistent. The one real dependency passes the signal (M2).
- **`showConfirm(win, p, signal?)`.** The signal is optional because the money gate's dialogs
  have no cancel path. Only the host path passes one.
- **`isPromptNpmInput(path, roots)`.** An empty `roots` refuses everything, so the build fails
  closed. A trailing slash on a root is ignored. A root that is only a prefix of the path
  (`/r` vs `/rr/…`) is refused. Windows separators are normalised.
- **`promptNpmDirs`.** An empty `PROMPT_NPM_IMPORTS` would watch nothing. It is pinned against
  the page's own npm imports, so adding an import to the page fails that pin until the list is
  updated. A required peer missing from the lockfile is refused.
- **`assertCurrentBuild({ npm })`.** Passing `[]` disables the new check. Only `stageApp` calls
  it, and S1 pins that it passes the real list.
- **False alarms.** Any `npm ci` or reinstall after the build refuses staging until
  `npm run build`, the same remedy as the rule's other false alarms (documented in `stage.ts`).
- **`npm link`.** A symlinked package directory is refused as "not a directory", and the
  allow-list refuses a package outside the two roots. Both fail closed.

## Residuals

1. **macOS, no app window.** A host confirm asked while no app window exists is a parentless
   message box, which Electron runs synchronously on macOS. The `signal` cannot close it, and
   main handles nothing until it is answered. Its late answer is dropped by the host, which no
   longer knows the request. This behaviour predates the lane.
2. **The renderer's npm code** (React, and what `@sovit/ui` pulls in) is still not watched by
   rule 3, as the finding noted. The orchestrator scoped this lane to the prompt page. The
   renderer is not the trusted window. Deferred.
3. **Finding 1 was not reproduced on macOS** (this box is Linux). The fix removes the mechanism.
4. **No real-browser check of the CSS.** Playwright's Chromium has no usable sandbox here (the
   AppArmor user-namespace restriction), `--no-sandbox` is not allowed, and Electron e2e is out
   of scope. The fix rests on the cascade rule plus the static pin (C1, C2).
5. **The bridge tests' home.** They are in `src/main/__tests__/confirm-cancel.test.ts` with a
   runtime import, because of the lane allowlist. They belong in
   `src/host/__tests__/main-bridge.test.ts`.
