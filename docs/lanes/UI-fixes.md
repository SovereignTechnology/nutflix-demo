# Lane UI-fixes — L4 component fixes + L5 screen follow-ups (ADR 0007)

**Issued against `CONTRACTS_VERSION = 4`.** Branch `lane/UI-fixes`, based on
`orch/2026-09-23-l5` @ `1fa4c59`. No contract change requested
(`docs/contract-requests/UI-fixes.md` does not exist on purpose).

Scope: ADR 0007 (b) reactions, (c) card price, (d) Library copy, the Studio line for (a);
`docs/status.md` "Follow-ups owed by the orchestrator" items 3, 6 and 7.

## What changed, per item

### A. Components (`packages/ui/src/components/`)

1. **Card price = default rendition** (ADR 0007 c). New helper `defaultRenditionSats(renditions,
   policy)` in `shared/format.ts` = the price of `renditions[0]` (what `play(id)` streams and
   Watch/Shorts charge). `VideoCard` shows it with **no "from"**. `cheapestRenditionSats` stays
   (doc comment now says what it is for); nothing in a card uses it any more. Story
   "Multiple renditions" renamed "(default rendition price)".
2. **A11y — price in the thumbnail's name.** The thumbnail button's `aria-label` is now
   `"<title>, <N sats>"` (`formatSats`, e.g. "Raku firing at night — full session, 53,598 sats"),
   or just the title when there are no renditions. The `<article>`'s own label is still the title
   (screens' tests key on it).
3. **Skeleton / list layout.** `VideoCard.css`: `.nf-card__text { flex: 1 1 auto }` and
   `.nf-card--list .nf-card__body { flex: 1 1 auto }`. `VideoCardSkeleton` gains
   `hideChannel` (no avatar circle; same three lines). **Per-screen workarounds removed:**
   `Home.css` (`.nf-home__item .nf-card__text`), `Channel.css` (`.nf-channelpage__item
   .nf-card__text` and `.nf-card--skeleton .nf-card__avatar { display: none }` → Channel now
   renders `<VideoCardSkeleton hideChannel />` in both of its video grids), `Library.css` (text +
   list body), `Watch.css` (list body + text), and `Search.css` (the grow/min-width part; its
   4 px text gap is a real Search style and stays). Confirmed by PNG against the pre-change PNGs
   in the `L5-*` worktrees: Channel loading, Library loading-watch-later, Watch loading and
   populated, and Search narrow have the same layout (only card prices and, on Watch, the new
   reaction row differ — by design).
4. **`Sheet` initial focus.** New optional prop `initialFocus?: string | RefObject<HTMLElement |
   null>`: `'first-field'` = first enabled, non-hidden `input` / `select` / `textarea`; any other
   string = a CSS selector inside the panel; a ref = that element. Falls back to the old
   behaviour (first focusable = Close) when nothing matches or the selector is invalid (caught,
   never throws). Read once per open. Library passes `initialFocus="first-field"` and
   `PlaylistForm`'s zero-delay `setTimeout` refocus (and its now-unused ref) is gone.
5. **Icons.** `thumbUp`, `thumbDown`, `comment`, `share`, `clock`, `lock`, `playlist` — Material
   shapes like the rest, 24 × 24, `currentColor`, `aria-hidden` unless labelled. New story
   `Components/Icon` → Gallery shows the whole set (checked in both themes).

New component (so Watch and Shorts cannot drift on the one rule that matters):

- **`ReactionButtons`** (`ReactionButtons/ReactionButtons.tsx` + `.css` + stories): Like and
  Dislike `Button`s with thumbs icons and both counts, `aria-pressed` from the viewer's
  reaction, accessible names "Like, 1,284 likes" / "Dislike, 1 dislike" (just "Like" /
  "Dislike" while counts are unknown), `title` "Remove your like" when pressed. `layout`
  `segmented` (one split pill, Watch — YouTube) or `stacked` (two pills, inherits the parent's
  gap and alignment — Shorts rail). `busy` ignores presses and sets `aria-busy` but does **not**
  disable the buttons (a disabled focused button drops keyboard focus). Presentational:
  `onReact('like' | 'dislike')` out, no adapter.
- **`reactionStep(state, pressed)`** (`ReactionButtons/reaction.ts`, pure): returns the ONE
  adapter call and the optimistic next state — neutral → like `react('+')`, neutral → dislike
  `react('-')`, like ↔ dislike a single `react` with the new content, pressing the active one
  `unreact()`. Counts never go negative; unknown counts stay unknown. **`reactionStateOf(stats,
  signedIn)`** reads `VideoStats` v4 and drops `myReaction` when signed out.

### B. Screens

6. **Watch + Shorts — likes and dislikes, always shown** (ADR 0007 b).
   - **Watch:** the single "Liked · N" button is replaced by a segmented `ReactionButtons`
     (`.nf-watch__reactions`) between Subscribe and Nutzap. `VideoData.liked: boolean` is
     replaced by `VideoData.reaction: ReactionState`, filled from `stats()` at load — the
     `library.liked()` read is dropped from the load (it only fed the old flag). `pressReaction`
     runs `reactionStep`, patches the counts at once, calls `react` / `unreact`, and on failure
     rolls back (only if still on that video) with a toast ("Could not remove your like" /
     "Could not register your dislike"). One in-flight reaction per video. Signed out → the
     existing "Sign in to do that" toast with Connect signer. Stats failing → both buttons
     still shown, without numbers.
   - **Shorts:** the "Like · N" and "Comments · N" text pills are now icon pills with the count
     beside each: stacked `ReactionButtons` (like, dislike) + a `comment`-icon Button
     (`aria-label` "Comments, N comments") + Nutzap. The `liked` set, `likeDelta` and the
     `library.liked()` read are gone; state is `stats[id]` (v4) with a per-short optimistic
     override that fresh stats clear unless a reaction is in flight. Same rollback/toast and
     signer flow as Watch.
   - **No code sends `-` for un-like any more** (grep: the only `react(` calls left in either
     screen go through `reactionStep`).
7. **Library copy** (ADR 0007 d). Tab hints: History "Only you can see your history — it is
   encrypted to your key" (lock); **Watch later "Watch later is private — encrypted to your key.
   Saving is free; you pay only for what you play"** (lock, was a bolt + the saving line only);
   **Playlists "Playlists can be public or private — private ones are encrypted to your key"**
   (playlist icon; the tab had no hint); Liked unchanged ("Likes are public Nostr reactions",
   people). The Private chip on playlist tiles uses `lock` instead of `key`. The `key` icons in
   Wallet ("wallet key") and Watch comments (signer CTA) mean a key, so they stay.
8. **Card-like prices.** Channel "Play all" (badge + `aria-label` "First video N sats") and its
   title-link gate now use `defaultRenditionSats`, no "from". **Studio** Videos table "Price"
   column and the Analytics header badge are the price a viewer pays to watch → default
   rendition, no "from". Studio's "Sats by rendition" bars are *earnings*, not a price — left.
   Home's hover-preview cost is Home's own `previewCostSats` (cheapest rendition) — left, as the
   brief says. No other `cheapestRenditionSats` or "from" price remains in screens.
9. **Studio split copy.** Under the per-payment table (unchanged: today's ADR 0005 rule, so the
   table stays accurate) a new line: "Coming in the next payments update: the fraction of a sat
   you are owed carries over to the next payment, and payments have a minimum size — so over a
   whole video you get your full share, less under 1 sat." The code comment and `splitPayment`'s
   doc point at ADR 0007 (a) / Stage 2 / contracts v5.

### C. Tooling (`packages/ui/scripts/screenshots.ts`)

10. **Chromium:** `NUTFLIX_CHROMIUM` (fails loudly if set to a missing path) → the
    ungoogled-chromium path → the newest `~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/
    chrome` by revision, with a log line saying which. Still `chromium.launch()` with
    Playwright's throwaway profile; nothing downloaded.
11. **Prune per file:** a PNG in a directory this run wrote to is deleted only if **no story in
    the whole index** produces it for any theme (light, dark, plus `--themes`). Verified: a
    `--filter components-reactionbuttons --themes light` run rewrote 7 PNGs, kept all 77 dark
    ones and the other components, and pruned a planted stale `Gone--stale-story--light.png`.
12. **Bounded image wait:** lazy images are switched to eager, and fonts + images get at most
    `IMAGE_WAIT_MS` = 10 s per story; then the PNG is taken anyway with
    `warning: <file>: N image(s) still loading after 10000 ms`. (The full run hit none.)

## Component API changes (all backward compatible)

| API | Change |
|---|---|
| `VideoCard` | no prop change; price = default rendition, no "from"; thumbnail `aria-label` includes the price |
| `VideoCardSkeleton` | + `hideChannel?: boolean`; props type now exported as `VideoCardSkeletonProps` |
| `Sheet` | + `initialFocus?: string \| RefObject<HTMLElement \| null>` (`'first-field'` special value) |
| `Icon` / `IconName` | + `thumbUp`, `thumbDown`, `comment`, `share`, `clock`, `lock`, `playlist` |
| new | `ReactionButtons`, `ReactionButtonsProps`; `reactionStep`, `reactionStateOf`; types `MyReaction`, `ReactionState`, `ReactionCall`, `ReactionStep` |
| new | `defaultRenditionSats` (format helper) |

**Barrel lines:** none owed. I edited `components/index.ts` (in my allowlist) and
`components/components.css` (`@import './ReactionButtons/ReactionButtons.css';`).
`src/index.ts` is `export *` of the components barrel, so everything above is public already;
`tsc -b` shows no name clash with the screens barrel. `screens/index.ts` and `screens.css` are
untouched.

## Tests (ui project)

Before **17 files / 456 tests** → after **17 files / 472 tests**, all passing.

| File | Before → after | New coverage |
|---|---|---|
| `components/__tests__/components.test.ts` | 21 → 28 | `defaultRenditionSats` (first ≠ cheapest in the fixture); card badge = default price, no "from"; thumbnail name = title + price; skeleton `hideChannel` / list; `reactionStep` all six transitions + unknown counts + floor at 0; `reactionStateOf`; `ReactionButtons` counts, names, pressed, busy-ignores-but-focusable; the 7 icons; `Sheet` `initialFocus` first-field / selector / ref / missing / invalid selector / default |
| `screens/Watch/__tests__/watch.test.ts` | 58 → 64 | both buttons + counts + pressed from `myReaction`; every transition's adapter call and counts, incl. **un-like calls `unreact` and never `react('-')`**; optimistic counts while in flight, second press ignored, rollback + toast on a failed `unreact` and a failed `react`; signed-out → no call, sign-in toast → settings; stats failing → buttons without counts |
| `screens/Shorts/__tests__/shorts.test.ts` | 33 → 35 | icon pills with counts (no "Like ·"/"Comments ·" text), pressed from `myReaction`; every transition incl. un-like = `unreact`; rollback + toast; signed-out presses call nothing |
| `screens/Library/__tests__/library.test.ts` | 30 → 31 | per-tab hint copy (Watch later private + encrypted, Playlists public or private), lock icon on History / Watch later / Private chip; the existing create test now proves focus lands in Title via `Sheet` |
| `screens/Channel/__tests__/channel.test.ts` | 46 → 46 | Play-all label = exact default price, no "from"; loading skeletons have no avatar |
| `screens/Studio/__tests__/studio.test.ts` | 41 → 41 | Videos + Analytics price = default rendition; the carry / minimum-size line |

## PNGs

Full run (`--static`, both themes): **534 PNGs = 267 stories × 2**, 0 page errors, 0 image
wait warnings. Per folder: components 154 (was 132 at L4: +Icon gallery, +7 ReactionButtons,
+2 VideoCard skeletons, +Sheet form), channel 46, home 38, library 56, search 32, settings 32,
shorts 36, studio 50, wallet 54, watch 36. Looked at: Icon gallery; ReactionButtons liked /
disliked / stacked; VideoCard multiple-prices, list, skeleton-list, skeleton-no-channel; Sheet
form-first-field; Watch populated (light + dark) and loading; Shorts populated (light + dark)
and phone; Library watch-later, playlists (dark), history, new-playlist, loading-watch-later;
Channel loading and playlists; Home loading, loading-more, trending; Search loading and narrow;
Studio upload-details and videos.

## Could not do inside the allowlist — for the orchestrator

The brief asks to delete the "un-like sends a dislike" notes from the Watch/Shorts lane docs,
but `docs/lanes/L5-*.md` are outside this lane's `.lane` allowlist (the pre-commit hook would
refuse them), so they are **not** edited. Exact text to change:

- `docs/lanes/L5-Shorts.md` "Things I was unsure about / judgement calls": delete the bullet
  "**Un-like sends `react(id, '-')`** (a NIP-25 *dislike*), because v3 has no way to retract a
  reaction — same as the Watch lane. Contract request filed (`unreact(videoId)`, v4)."
- `docs/lanes/L5-Shorts.md` "Side rail and actions": the "**Like · N**" bullet and the tests
  line "Like → `react('+')` … again → `react('-')`" describe the old behaviour; replace with a
  pointer to this file (like/dislike icon pills, `reactionStep`, un-like = `unreact`).
- `docs/lanes/L5-Watch.md` "Channel row + actions": "Like (`adapter.react '+'/'-'`, pressed
  state + count)" → "Like / Dislike (`ReactionButtons`; see `docs/lanes/UI-fixes.md`)".
- `docs/contract-requests/L5-Shorts.md` (the `unreact` request) is satisfied by v4 and can be
  marked done.

## Judgement calls / unsure

- **One shared `ReactionButtons` component** instead of per-screen buttons, because the
  transition rule is safety-relevant (a wrong call publishes a public dislike). Pressed style
  is the design system's existing inverse `Button[aria-pressed]` (what "Liked"/"Subscribed"
  already used), not YouTube's filled-vs-outline thumb — we have no outline icon variants.
- **Signed-out viewers see counts but nothing pressed**, even if the adapter returns a
  `myReaction` (the mock does for its pre-liked fixture).
- **In-flight presses are ignored, not queued**, and the buttons stay enabled (focus safety).
- **Studio copy says "Coming in the next payments update"** rather than "from Stage 2" — Stage 2
  is internal plan vocabulary a creator would not know; the code comment names Stage 2 / ADR 0007.
- **Watch-later hint is two sentences** (privacy + "saving is free") so the old fact is not
  lost; it fits one line at the 1280 px story width and wraps below that.
- Watch no longer calls `library.liked()` on load; if L6 wants the liked list warmed for the
  Library it must do so itself.
- The screenshot script's pre-existing 15 s wait for the story frame timed out once at load
  average ~24 (a re-run was clean). Not changed; raise it if it recurs.
