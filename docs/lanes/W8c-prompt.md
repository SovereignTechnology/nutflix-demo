# Lane W8c-prompt — round 8: prompt window and packaging

Branch `stage-3/r8-prompt`, off `aca2d6a` (the merged Stage 3 head after integration fix 2).
Scope: the five round-8 findings of the final cross-lane review panel (packaging review) on
main's trusted prompt window and the packaging stage. Date: 2026-09-27.

- Commits:
  - `d56007a` (host confirm: `confirm-cancel`);
  - `be1e370` (prompt page: in-page suggestions, `[hidden]`);
  - `a90ef09` (packaging: the allow-list and the freshness rule);
  - then this report, the review record and the ADR 0016 notes.
- Review record: `docs/reviews/2026-09-27-pre-push-r8-prompt.md`. It has the verification of each
  finding, the differential review, the sharp edges, the 35 mutation checks and the residuals.
- No contract request. `HostOut` is the desktop's own main ↔ host protocol, not a core contract.
- Nothing changed under `packages/core/src/contracts/`, the locked paths, `docs/status.md` or
  `docs/security-review.md`. Core is not touched; every code change is in `packages/app-desktop/`.
- No new dependency and no lockfile edit. Nothing outward: no push, MR or issue edit.

## Outcomes

| Finding | Outcome |
|---|---|
| [medium] `<datalist>` suggestions outside content protection on macOS (`prompt.ts:148`) | **fixed**: no datalist. The page draws up to 6 matches from its own list, inside the protected window, as a keyboard-accessible combobox. Not reproducible on this Linux box; the fix removes the mechanism. |
| [low] a timed-out host confirm leaves main's dialog up, and main refuses every other confirm (`main-bridge.ts:132`) | **fixed**: `HostOut` `confirm-cancel`, posted by the host on the deadline and at shutdown. Main aborts the dialog (Electron `signal`), also when the host goes away, frees the slot at once and drops the late answer. |
| [low] staging ignores the npm code bundled into the prompt page (`stage.ts:378`) | **fixed**: `promptNpmDirs` reads bip39 and its dependencies' install directories from the lockfile. Rule 3 compares the bundle outputs with every installed file there and with each package directory's mtime. A package that is unlisted or not installed is refused. |
| [info] the prompt allow-list regex admits nested paths (`bundle.ts:111`) | **fixed**: `packaging/prompt-npm.ts` `isPromptNpmInput`. Every package from this package's or the repo's `node_modules` down to the file must be one of the three. |
| [info] `.words { display: grid }` overrides `[hidden]` (`prompt.css:166`) | **fixed**: a global `[hidden] { display: none !important; }`, pinned on the shipped stylesheet. |

## How each was decided

- **Suggestions in the page, not a completion indicator.** The orchestrator chose an in-page
  list.
  - One listbox moves under the field being typed in. There are not 12 lists, and at most one is
    open at a time.
  - Words come only from the page's bundled list (`suggestWords`), prefix-matched with the same
    normalisation as `wordIndex`.
  - Escape closes an open list before it cancels: the WAI-ARIA combobox pattern. It is safe
    here because these views' cancel is "Later", not a destructive answer.
  - The list is emptied when the answer is sent, like the fields.
- **Close the dialog and also drop the answer.** Aborting closes the dialog on Linux and Windows,
  and on macOS whenever it has a parent window. Where it cannot close (a parentless macOS box,
  which blocks main anyway), the answer is still dropped and the slot is free. The late answer is
  dropped either way. The next confirm is not refused, including a restarted host's. The old
  `gen` counter became unnecessary: the abort flag carries it.
- **Watch the installed files, by mtime, from the lockfile.** Measured: npm writes installed
  files with install-time mtimes here, so a bump moves them. The package directory's own mtime
  also counts, so a reinstall that only removes a nested dependency is caught too. Watching
  `package-lock.json` instead would refuse after any unrelated lockfile change. Resolving from
  the lockfile uses the same `resolveFrom` the closure uses, so it follows npm's placement,
  nested or hoisted.
- **The allow-list as a segment parser.** It replaces the regex. The finding's suggested regex
  (the last package segment) would still admit `evil/node_modules/@noble/hashes/…`. The parser
  checks the whole chain and anchors it at this package or the repo root.
- **`[hidden]` globally.** One rule covers the words panel and the new suggestion list, and any
  later element with an author `display`.
- **The bridge tests' location.** The lane allowlist has `src/host/signer/main-bridge.ts` but not
  `src/host/__tests__/`. Those tests are in `src/main/__tests__/confirm-cancel.test.ts` with a
  runtime import (a static import breaks the composite tsc build: TS6307), next to a test of both
  halves wired together.

## Confirmed with tests

- Before each fix, the new tests fail:
  - page: 8, against the base page with stub exports;
  - confirm: 8;
  - allow-list: 7, with the old regex;
  - stage: 6, which staged the stale bundle.
- 35 mutation checks, all killed once one weak assertion was tightened (P10: the list's placement
  had been checked against the form, not the field's wrapper). The table is in the review record.
- A real-browser check of the CSS was not run. Playwright's Chromium has no usable sandbox on this
  box, `--no-sandbox` is not allowed, and Electron e2e is out of scope. jsdom does not apply the
  cascade, so the `[hidden]` rule is pinned statically on the shipped file.

## Gates

- Baseline at `aca2d6a`: the ten files this lane touches, 581 tests, all passed.
- `app-desktop` tests (`--maxWorkers=2`): 109 files passed, 2 skipped (the opt-in real-mint
  files); 2 067 tests passed, 2 skipped.
- The whole suite, once, after `npx tsc -b --force` and `npm run build`
  (`npx vitest run --maxWorkers=2`): 237 files passed, 5 skipped; 3 874 tests passed, 30 skipped;
  351.75 s; no timing failure to rerun, and no timeout changed.
- `npx tsc -b --force`: clean. `npm run build`: clean.
- eslint + `prettier --check` on every changed file: clean.
- `npm run check:locked`: OK. `npm run lint:electron`: OK (266 files, 0 violations).
- Real mints (opt-in; the reissue confirm is on a money path):
  `recovery-real-mint.integration.test.ts` passed on Nutshell (`:3399`) and cdk-mintd 0.18.1
  (`:3397`).
- No Electron e2e (as briefed).

## Residuals

See the review record's Residuals; in short:

1. macOS, no app window: a parentless host confirm cannot be closed by `signal` (Electron runs it
   synchronously). Its late answer is dropped by the host. This predates the lane.
2. The renderer's npm code (React, `@sovit/ui`'s dependencies) is still not watched by the stage's
   rule 3. It is outside this lane's prompt-page scope, and the renderer is not the trusted window.
3. Finding 1 was not reproduced on macOS; the fix removes the datalist.
4. No real-browser CSS check (sandbox), as above.
5. The bridge tests belong in `src/host/__tests__/main-bridge.test.ts` once an allowlist covers
   it.

## Proposed row for `docs/status.md`

| Round 8 — prompt window and packaging (final panel) | `stage-3/r8-prompt` | DONE. Five findings fixed:<br>• the recovery word fields draw their own suggestions in the page (no `<datalist>`, whose popup is its own window, outside content protection on macOS);<br>• a host confirm nobody waits for is closed: `HostOut` `confirm-cancel` on the host's deadline and at shutdown, main aborts the dialog (also when the host goes away), drops the late answer and refuses nothing after;<br>• staging refuses a prompt bundle older than the installed `@scure/bip39` and its dependencies (resolved from the lockfile);<br>• the prompt bundle's npm allow-list checks the whole package chain from this package's or the repo's `node_modules`;<br>• `[hidden]` always hides in the prompt window.<br>Review `docs/reviews/2026-09-27-pre-push-r8-prompt.md` (35 mutation checks) |
