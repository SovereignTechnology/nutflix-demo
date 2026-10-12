# Lane UI-followups — one shell toast stack; Shorts stops paying when its element pauses

**Issued against `CONTRACTS_VERSION = 4`** (frozen, ADR 0007). Branch `lane/UI-followups`, based
on `main` @ `607abcc`. No contract change requested (`docs/contract-requests/UI-followups.md`
does not exist on purpose). No `package.json` / lockfile edit, no new dependency, nothing
outside the allowlist.

Scope: `docs/status.md` follow-up 9 (from L6-A) = `docs/lanes/L6-A.md` deviations 5 and 13 and
open questions 3 and 4.

## What changed

### 1. Library takes `onToast` (Settings' pattern)

`packages/ui/src/screens/Library/Library.tsx`

- New optional prop `onToast?: ((toast: ToastItem) => void) | undefined`, read through a ref to
  the latest callback (exactly as `Settings`). With it, **every** toast the screen raises goes
  to the shell and the screen renders **no** `ToastStack` of its own; without it, the old inline
  stack (`nf-library__toasts`, max 3) is rendered as before.
- The toasts: "Removed from Watch later" + **Undo**, "Could not remove from Watch later" +
  **Retry** (sticky error), "Could not put it back" (a failed Undo), "(Private) playlist
  created".
- **After unmount, shell mode keeps working** (Settings' stated reason for `onToast`: the
  shell's stack outlives the screen). A relay answer that lands after the viewer navigated
  away still reaches the shell, and its action still does the right thing:
  - the list updates (optimistic removal, rollback, restore) are applied only while mounted;
    the toast push is no longer behind the `alive` early-return — `pushToast` itself drops it
    when there is no shell and the screen is gone, so **without the prop nothing changes**;
  - **Undo** after unmount re-sends `setWatchLater(id, true)`; if that fails the shell hears
    "Could not put it back";
  - **Retry** after unmount re-sends the removal at the original index (`sendRemoval`) instead
    of looking the video up in a list that no longer renders (that lookup would find nothing and
    make Retry a silent no-op when the failure landed after unmount — mutation-checked).
- Refactor for the above only: the body of `removeFromWatchLater` moved into
  `sendRemoval(video, index)`; `removeFromWatchLater` still refuses a video that is not in the
  list while mounted (double click, stale Retry).

### 2. Studio — unchanged, on purpose

Studio raises **no toasts**: no `ToastStack`, no transient or dismissable notice anywhere in
`packages/ui/src/screens/Studio/`. Every notice it shows is in-place state that belongs where it
is: drop-zone / form validation errors (`role="alert"` next to the field), the upload step list
and its polite live region, the Published / failed cards, the per-row Unban error, the seeding
toggle error under the toggle, and the melt-out result (Paid / Not paid) inside the confirm
Sheet. None of them is transient; moving any of them into a toast would invent a notice and lose
its context. So Studio gets no `onToast` prop, and the shell passes none (asserted in
`shell-props.test.tsx`).

### 3. Shorts listens to its `<video>` element (L6-A deviation 13 / open question 4)

`packages/ui/src/screens/Shorts/Shorts.tsx`

- `onPause` on the bound element → `pausePlayback()` = `session.pause()` (stop paying) + the
  frame says "Paused — not paying", the control reads "Play (space)". This covers PiP, media
  keys, the OS, and the desktop coordinator pausing page media when the mini-player resumes.
- `onPlay` on the bound element while the screen has it **paused** → `resumePlayback()` (pay
  again). Same rule as Watch (`status === 'paused'` only).
- **Not** triggered by:
  - **the end of a short** — a browser fires `pause` with `el.ended === true` and then
    `ended`; the `pause` is ignored and `ended` pauses the session itself (once). A `play` after
    the end (media keys) does not resume: Replay is an explicit action (Watch behaves the same);
  - **moving on** (Next / Previous buttons, j/k/arrows, wheel, a swipe) or **unmount** — both
    release the session (`bindingRef = null`) *before* pausing the element, so its echo finds no
    binding; the handler also checks that the event's element is the bound one and the binding
    is for that short;
  - **a rendition switch** — Shorts never switches rendition (it plays the one rendition whose
    price it showed), so there is nothing to guard; the binding/element checks would cover a
    future session swap the same way;
  - **the echo of the screen's own pause/resume** — a new `payRef` (`'paying' | 'paused' |
    'ended'`) records what the screen last told the session, written **before** the element is
    told, so even a synchronously dispatched `pause`/`play` is recognised as an echo. No double
    `session.pause()`, no pause → resume loop (mutation-checked: moving the write after the
    element call fails the echo test).
- `endPlayback` pauses the session only if it was paying (it is idempotent either way).

Money-path summary: the change only ever **stops** paying on an element event, except `play`
from `paused`, which resumes a session the viewer already started behind its shown price (the
same consent rule Watch applies). An element exists only after an explicit play, so nothing can
start a session this way.

### 4. Shell wiring (`packages/app-desktop/src/renderer/`)

- `App.tsx`: Library gets `onToast={pushToast}` (the same callback Settings gets). The header
  comment table now says so, says Studio has no `onToast` and why, and describes the
  Shorts-over-mini element pause.
- **Toast actions now close their toast** (`pushToast` wraps `action.onClick`: dismiss, then
  run, at most once). The shell re-mints toast ids (`shell-N`), so a screen's own
  `dismiss(id)` inside its action (Library's Undo/Retry, Settings' Retry) can never reach the
  shell's stack — before this, a clicked Undo stayed on screen for its 5 s and could be clicked
  again, and a clicked Retry left its sticky error up forever. This also fixes **Settings'**
  Retry toast in the shell (the Settings screen itself is unchanged).
- `coordinator.ts`: doc comment only (`pauseScreenMedia` now also drives Shorts' paused state).
  No behaviour change: the coordinator already paused the short's session and page elements when
  the mini resumes; what is new is that Shorts hears the element pause, calls its (already
  paused, so no-op at the coordinator) `session.pause()` and shows the paused state.

### 5. Stories

Unchanged. No story broke (Library's and Shorts' stories pass no `onToast` and dispatch no media
events), and the shell-owned mode renders nothing inside the screen to show. No PNGs regenerated.

## Tests

| File | Change |
|---|---|
| `packages/ui/src/screens/Library/__tests__/library.test.ts` | +5: own inline stack without `onToast`; with it every toast (Undo, rollback + Retry, playlist created) goes to the shell, no stack rendered, actions work; an outcome after unmount still reaches the shell and Undo / a failed Undo / Retry work (4 relay answers resolved after unmount); without it nothing is raised after unmount (no console error); the latest `onToast` is used after a re-render |
| `packages/ui/src/screens/Shorts/__tests__/shorts.test.ts` | +4: an outside `pause` pauses the session exactly once, shows "Paused — not paying", a second one is a no-op, `play` resumes once, same session and element; with a media mock that fires `pause`/`play` **synchronously** on a state change, the screen's own pause/resume (buttons and Space) never pause or resume twice (and the element really echoed: 2 pause + 3 play events); `pause` with `ended` true then `ended` → one pause, Replay, later `pause`/`play` events do nothing, only Replay resumes; Next, `k`, a swipe (fake timers for the scroll settle) and unmount with the echoing mock → each session closed once, never paused or resumed (3 element pauses fired) |
| `packages/app-desktop/src/renderer/__tests__/shell.test.tsx` | media mock is now browser-like (a `play`/`pause` event is **queued** on a state change; all 14 existing tests still pass on it); the mock's sessions are recorded with pause/resume spies. "Resuming the mini-player pauses the short" now also asserts: the short's element was paused, its session paused **once** at the mock and never resumed (also after the echoes settle), the short shows "Paused — not paying" / "Play (space)", the mini stays unpaused; then the short's own Resume pauses the mini (≤ 1 paying). New: a Library toast lands in `.nf-shell__toasts` (no `.nf-library__toasts`), Undo restores the video at the mock and closes the toast — also after navigating to Home |
| `packages/app-desktop/src/renderer/__tests__/shell-props.test.tsx` | +2: Library's `onToast` is the shell's (identical to Settings'), a pushed toast shows in the shell stack, a double-clicked action runs once and closes the toast; Studio gets no `onToast` |
| `packages/app-desktop/src/renderer/__tests__/coordinator.test.ts` | "Shorts over the mini-player" extended: after `resumeMini()` the short's inner session was paused once; the short's own `pause()` (what its element handler does) is a no-op — still one unpaused, mini unpaused, no inner resume, no extra page-media pause |

Mutation checks (each made one new test fail, then reverted): Shorts `payRef` written after the
element call (echo test), Library Retry-after-unmount going through the list lookup (after-unmount
test), Shorts `onPause` handler removed (the shell's mini-resume test, against a rebuilt
`@sovit/ui` dist).

Counts and `npm run ci`: see "CI" below.

## Deviations from the task text

1. **Library shell-mode toasts are delivered after unmount** (and their actions work then). The
   task said "exactly the pattern Settings uses"; Settings' `pushToast` checks the shell before
   `alive`, but Library's call sites returned early on `!alive` before ever reaching it, so
   copying `pushToast` alone would have made the shell mode drop exactly the late outcomes the
   pattern exists for. Behaviour without the prop is unchanged (tested).
2. **The shell's `pushToast` wraps toast actions** (dismiss + once). Not asked for, but without
   it Library's Undo/Retry toasts misbehave in the shell (stay up, can run twice), and Settings'
   Retry already did.
3. Shorts' `endPlayback` now skips `session.pause()` when the session is already paused (the
   ended-after-outside-pause order). The existing "end pauses once" test is unchanged.

## Open questions / for the orchestrator

1. **Other screens still own a `ToastStack`: Watch, Wallet and Shorts.** "One shell toast stack"
   needs `onToast` on those three too (same pattern; Shorts is in this lane's allowlist, the
   others are not). Their stacks and the shell's are both fixed bottom-left, so a Shorts / Watch
   / Wallet toast and a late Library/Settings toast can overlap.
2. **L6-A deviation 13's wording** ("its element plays out its buffer") does not match the code
   for the mini-resume case: `pauseScreenMedia` already paused the short's element; what was
   wrong there was Shorts' UI (still "playing", stale rate chip). The money gap this lane closes
   is the **other** case: an outside pause (PiP, media keys, OS) paused the element while the
   session kept paying (and prefetching). Both are now covered.
3. **Element `play` after the end** does not resume (Replay is explicit), same as Watch; the
   element then shows buffered frames while the screen says "ended" and nothing is paid. If a
   media-key play after the end should count as Replay, it is one line in `elementPlayed`, in
   Watch and Shorts alike.
4. Settings dedupes its own toasts by id; the shell re-mints ids, so repeated failures of the
   same Settings field stack up (max 3) in the shell instead of replacing each other. Unchanged
   here; a `replaceKey` on `ToastItem` (components, not this lane) would fix it for every screen.

## CI

`npm run ci` in the worktree (after `npx prettier --write` on the touched files): **exit 0** —
lint, build (incl. the renderer bundle), **123 test files, 2082 passed / 27 skipped** repo-wide
(`main` @ `607abcc`: 2070 / 27 → +12), check:locked OK, check:native OK (42), lint:electron OK
(0 violations). Per project: `@sovit/ui` **17 files, 481 passed** (+9: Library 38 → 43, Shorts
35 → 39); `@sovit/app-desktop` **51 files, 1043 passed** (+3: shell 14 → 15, shell-props 11 → 13;
coordinator extended in place). The load-sensitive seeder test did not trip.
