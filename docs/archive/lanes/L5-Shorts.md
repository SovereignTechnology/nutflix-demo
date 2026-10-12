# Lane L5-Shorts — the Shorts screen (`packages/ui/src/screens/Shorts/`)

**Issued against `CONTRACTS_VERSION = 3`.** Branch `lane/L5-Shorts`, based on main @ `e259115`.
One non-blocking contract request: `docs/contract-requests/L5-Shorts.md` (no way to take a
like back — see "Things I was unsure about").

Scope: build-plan §6.1 row **Shorts** ("vertical swipe feed of kind 22") + §6.2 ("buffer =
money"), design brief `docs/design/README.md` (YouTube first, Rumble second, clean), L4
component API (`docs/lanes/L4.md`), BRIEFS L5 row, SECURITY.md T16 and "price shown vs price
charged". Worked example followed: `docs/lanes/L5-Home.md`.

## What was built

```
packages/ui/src/screens/Shorts/
  index.ts                  export surface (below)
  Shorts.tsx                the screen: 9:16 feed · scroll-snap/wheel/keys/buttons · price gate ·
                            PlaySession lifetime · side rail · nutzap sheet · empty/error states
  Shorts.css                screen-scoped `nf-shorts` stylesheet, L4 tokens only
  Shorts.stories.tsx        title 'Screens/Shorts', 18 stories (one per state), MockNetworkAdapter
  __tests__/shorts.test.ts  33 vitest tests (jsdom, components/testing/render.ts, no testing-library)
```

### Export line wanted in `packages/ui/src/screens/index.ts`

```ts
export { Shorts } from './Shorts/index.js';
export type { ShortsProps } from './Shorts/index.js';
```

`./Shorts/index.js` also exports `SHORTS_PAGE_SIZE`, `SHORTS_DEFAULT_PREFETCH_SEC`,
`SHORTS_NUTZAP_AMOUNTS`, `shortPrice`, `shortsPlayErrorKind`, `describeShortsError` and the type
`ShortsPlayErrorKind`. Every name is `Shorts`-prefixed on purpose, so `export * from
'./Shorts/index.js'` cannot collide with Home's `describeError` or Watch's helpers.

### CSS wiring (orchestrator)

Add to `packages/ui/src/screens/screens.css`, after Home's line:

```css
@import './Shorts/Shorts.css';
```

The screen never imports its CSS (CSP `style-src 'self'`); the story imports `./Shorts.css`
directly (Vite), which is what the PNGs were rendered with.

## Props (`ShortsProps extends ScreenProps`)

| Prop | Type | Meaning |
|---|---|---|
| `adapter`, `navigate`, `miniPlayer` | from `ScreenProps` | `miniPlayer` renders in a `nf-shorts__mini` slot, `position: fixed` bottom-right (same as Home) |
| `videoId?` | `NostrEventId` (= `Route['videoId']` for `shorts`) | start the feed at this short; later changes are followed (below) |
| `prefetchSeconds?` | `number` | override for `PlaySession.setPrefetchSeconds`; default `Settings.prefetchSeconds` from `adapter.settings()`, then 30 |
| `onPlaybackStart?` | `(videoId) => void` | called once a short's paid session has started — **the shell should pause the mini-player's session here** so two streams are never billed at once |
| `pageSize?` | `number`, default 10 | `FeedQuery.limit` for `feed({ source: 'shorts' })` |
| `className?` | `string` | |

The screen fills the height its container gives it (`.nf-shorts { height: 100% }`) — the
shell must give it a definite height (viewport minus header). Slides are exactly that tall.

## Behaviour

### Layout (YouTube Shorts desktop; phone below)

- One short per "slide" in a vertical scroller (`scroll-snap-type: y mandatory`, slides
  `scroll-snap-stop: always`, scrollbar hidden). The 9:16 frame is centred, as tall as the
  slide; the action rail sits to its right, bottom-aligned; round up/down buttons float at the
  right edge, vertically centred.
- Inside the frame: poster (or the `<video>` once playing), a bottom scrim, then the channel
  row (avatar + name → Channel route, white "Subscribe" pill), the title (2-line clamp) and a
  1-line description with a "More/Less" toggle that expands it in place (scrollable).
- Phone-width container (`@container (max-width: 640px)`): the frame is full-bleed, the rail
  floats over its right side above the title, up/down buttons are hidden (swipe instead).
  Story "Phone width" shows it.

### Moving between shorts

| Input | How |
|---|---|
| Touch swipe, scrollbar, trackpad momentum | native scrolling with mandatory snap; once scrolling has settled for 120 ms the snapped index becomes active |
| Mouse wheel / trackpad | native `wheel` listener (`passive: false`, React's is passive): 40 px of travel = one short, and one gesture moves **at most one** short (a gesture ends after 250 ms of quiet). Ctrl+wheel (zoom) and horizontal wheels are left alone; an expanded, scrollable description keeps its own wheel |
| Keys (document-level while mounted) | `ArrowDown` / `j` / `PageDown` next, `ArrowUp` / `k` / `PageUp` previous, `Space` play/pause the active short (only when focus is not on a control), `m` mute. Ignored in text fields, with Ctrl/Alt/Meta, and while the nutzap sheet is open |
| Buttons | "Previous short (k)" / "Next short (j)" (chevrons rotated 90° in CSS), disabled at the ends |

Note: in Shorts `j`/`k` are next/previous (as the task asks), not the Player's ±10 s /
play-pause — Shorts does not use the L4 `Player` keyboard map (see judgement calls).

Every move goes through one `activate(index)`: **close the previous short's session**, make the
new one active, scroll it into view (smooth unless `prefers-reduced-motion`), and
`navigate({ name: 'shorts', videoId })`. Non-active slides are `inert` (no focus, no clicks,
out of the a11y tree), so only the active short can ever be played.

After the last short there is a **tail slide**: a skeleton while more pages exist (the next
page is fetched when the viewer is two shorts from the end), "Could not load more shorts" +
Retry if that page failed, or "You're all caught up" + "Back to the first short" at the real
end. Landing on the tail closes the previous short's session like any other move.

### Route sync

- `videoId` on mount: if it is in the first page, the feed starts there (instant jump, **no**
  `navigate`); if not, `adapter.video(videoId)` is fetched and put first; if it does not exist,
  the feed starts at the latest short with a dismissible notice "That short is not available
  any more — here are the latest shorts".
- Moving calls `navigate({ name: 'shorts', videoId })` for the short now shown. When the shell
  echoes that back as the `videoId` prop it is a no-op (no reload, no jump). Any *other*
  `videoId` (back/forward, a link) activates that short if loaded, otherwise reloads the feed
  starting there. **Shells should not remount Shorts on `shorts → shorts` navigations** (a
  remount works — it closes the session and reloads — but loses the scroll position).
- Landing on the tail does not navigate (there is no short to name).

### Price, consent and payment (build-plan §6.2, SECURITY "price shown vs price charged")

- Every short shows its price through `SatsBadge` (variant `price`, overlay) centred **above**
  and **before** its play button in DOM order — the play button's accessible name repeats it
  ("Play — 196 sats"), and a hint under it says "0:41 · you pay per block as it streams".
  The price is `shortPrice(video)`: the manifest's first rendition, `ceil(size / blockSize) ×
  satsPerBlock` — the full cost of watching once.
- **No autoplay, ever.** Arriving on the screen, deep-linking, moving to the next short, a page
  arriving under the tail — none of these starts anything. A session starts only on an explicit
  action on *that* short: its play button, or Space while it is the active short (its price is
  on screen at that moment). **Moving to the next short is not consent to pay for it**: the
  previous session is closed and the new short waits behind its own price and play button.
- `adapter.play(videoId, rendition)` is called with **the rendition whose price was shown**. When
  the session comes back, its charge is recomputed from `session.rendition` + `session.policy`;
  if that is **more** than the price shown, the session is closed unused, the new price replaces
  the old one in the badge with a note "The price changed since it was shown. Check it and press
  play again", and the viewer must press play again (tested; story "Price changed at start").
- `PlaySession` lifetime: only the active short can hold one; it is closed on every move, on
  unmount, on a media error, and when a `play()` resolves after the viewer has moved on or the
  screen unmounted (a stale `play()` is closed on arrival, never bound — tested both ways).
  **No sessions, `<video>` elements or blob bytes for neighbours**; posters are images, fetched
  through `adapter.image` like Home's thumbnails.
- `setPrefetchSeconds(prefetch)` right after the session binds (Settings default 30; a short is
  ≤ 60 s, so this is at most the short itself).
- Pause = `session.pause()` (stop paying) + element pause, and the frame says "Paused — not
  paying" next to the price. Resume = `session.resume()`. The end of the short also calls
  `session.pause()` ("never pay past the end") and offers Replay (resume from 0 on the same
  session). No auto-advance and no loop — both would keep a paid stream running unasked.
- While playing, the frame's top bar shows the price chip, a live `rate` badge from
  `onSpend` ("streaming 480 sats/min", with the running total in its label), and pause/mute
  controls; a thin progress line runs along the bottom edge.

### Gates (shown in place of the play button, price still first)

Evaluated per short, like Watch's stage gate, so the designed state is visible without a
failed payment attempt:

| Gate | When | Card |
|---|---|---|
| signer | `me()` is `null` (signed out / `failWith: 'no-signer'`) | `signer-not-detected`, "…to pay for and play shorts", Connect signer → `settings` |
| seeders | `stats(id).seedersOnline === 0` | `no-seeders-online`, Retry re-fetches that short's stats |
| balance | wallet holds 0 at every mint the short is priced at | `no-balance-at-mint` naming the mint host(s), Top up → `wallet` |
| unplayable | the manifest lists no rendition | "Not playable" |

`play()` rejections map the same way (`shortsPlayErrorKind`): `no-seeders` / `no-balance` /
`signer` to the presets, `relay` to "Relay down" + Retry, anything else to "Could not start this
short" + the message as detail + Retry. Every copy says "Nothing was paid" where that is true.
A media-element error closes the session and shows "This short could not be played — the
stream stopped and nothing more is being paid for" + Retry.

### Side rail and actions

> **Superseded 2026-09-23 (lane UI-fixes, contracts v4, ADR 0007):** like and dislike are two
> icon buttons with both counts from `stats().likes`/`.dislikes`, pressed state from
> `stats().myReaction`; pressing the active one calls `unreact(id)` — **never** `react(id, '-')`.
> See `docs/lanes/UI-fixes.md`.

- **Like · N** (`Button`, `pressed` when liked): `react(id, '+')` / `react(id, '-')` (see the
  contract request), count = `stats.reactions` ± the viewer's own toggles; liked state from
  `library.liked()`.
- **Comments · N** → `navigate({ name: 'watch', videoId })` (comments live on Watch).
- **Nutzap** (accent, bolt icon) → a right `Sheet`: amounts 21 / 100 / 500 / 1,000, the creator's
  mints as `MintChip`s with the viewer's balance (the first mint holding enough is preselected),
  an optional message, and a footer with `SatsBadge` "You send N sats" **before** "Send
  nutzap". Sends `adapter.nutzap(id, amount, mint[, message])`, closes, toasts "Nutzap sent" and
  refreshes balances. No balance at any creator mint → `no-balance-at-mint` card + Top up,
  Send disabled; not enough at the chosen mint → inline warning, Send disabled.
- **Channel**: avatar + name in the overlay → `navigate({ name: 'channel', pubkey })`;
  **Subscribe/Subscribed** → `subscribe` / `unsubscribe` (initial state from `subscriptions()`;
  hidden on the viewer's own shorts).
- Signed out: Like / Subscribe / Nutzap push a toast "Sign in to do that" with "Connect signer"
  → `settings`, instead of failing.
- Share-as-copy (optional in the task) is **not** built — see judgement calls.

### Data and cancellation

`feed({ source: 'shorts', limit })` (+ `cursor` for later pages, de-duplicated by id);
`video(id)` only for a deep link outside the first page; per short `image(url, sha256)` (T16 —
`Skeleton` while pending, a rejected hash leaves the dark frame, never a broken image),
`profile(author)` once per pubkey then `image(picture)`, `stats(id)`; once per adapter `me()`,
then `subscriptions()` + `library.liked()` when signed in, `wallet.balances()`, `settings()`.
All results are guarded by an `alive` ref / `AbortController`; an unmount mid-load stops the
chain (tested: no `video()`, `image()`, `profile()`, `stats()` after unmount, no console errors).

### Accessibility

`<section>` landmark labelled by a visually hidden `h1` "Shorts"; the scroller is
`role="feed"` (`aria-busy` while loading) of `<article>`s with `aria-posinset` /
`aria-setsize` (−1 while more pages exist), each labelled by its title (`role="heading"
aria-level=2`, rendered through `Markdown`); the active one carries `aria-current`, the others
are `inert`. A polite live region announces "Short 2 of 3: <title>" on every move. Every icon
control has a name ("Next short (j)", "Pause (space)", "Mute (m)"); the rail is a labelled
`group`; the description toggle has `aria-expanded`/`aria-controls`.

## States (Storybook `Screens/Shorts`, 18 stories × 2 themes = **36 PNGs** in `artifacts/screens/shorts/`)

| Story | How it is produced | What you see |
|---|---|---|
| Loading (skeleton) | `latencyMs: 5000` | frame-shaped skeleton + rail pills, feed `aria-busy` |
| Populated | default mock | first short: price chip above the big play button, hint, overlay, rail, up/down |
| Deep link | `videoId` = second short | starts on the second short, no navigation |
| Playing (after an explicit tap) | `play` fn clicks Play; sessions re-sourced to `mediasource` so the `<video>` has no `src` to fail on | price chip + live "streaming 480 sats/min" + pause/mute, progress line |
| Paused (not paying) | Play then Pause | "Paused — not paying" beside the price, Resume in the centre |
| Nutzap sheet | `play` fn clicks Nutzap (frame = viewport, the sheet is fixed) | amounts, mint chip with balance, message, "You send 21 sats" before Send |
| End of feed | deep link to the last short, then `ArrowDown` | "You're all caught up" + Back to the first short |
| Empty — no shorts yet | `feed` → `{ items: [] }` | `videoOff` empty state, Browse Home |
| Deep link to a missing short | `videoId` not in the catalog | notice pill at the top, feed from the latest short |
| Error — relay down | `failWith: 'relay-down'` | full `ErrorState` with detail + Retry |
| Error — no seeders online | `failWith: 'no-seeders'` | `no-seeders-online` card under the price |
| Error — no balance at this mint | `failWith: 'no-balance'` | `no-balance-at-mint` card naming `mint.fixture-a.example` |
| Error — no signer | `failWith: 'no-signer'` | `signer-not-detected` card |
| Signed out | `signedIn: false` | same card (the mock treats both alike) |
| Error — could not start | `play` rejects, `play` fn clicks | "Could not start this short · Nothing was paid" + detail + Retry |
| Price changed at start | `play` returns a session at 2× `satsPerBlock` | badge now 392 sats, the warning note, Play again |
| Error — could not load more | `pageSize: 1`, page 2 rejects, then `j` | tail `ErrorState` "Could not load more shorts" + Retry |
| Phone width | story frame 390 px | full-bleed frame, rail over the video, no up/down buttons |

Stories use `MockNetworkAdapter` wrapped so `image()` answers with the `.storybook/fixtures`
inline SVGs (9:16 for shorts), and with an injected `setInterval` that ticks spend **once** at
40 ms so the "Playing" PNG is deterministic. States that need a viewer action use a story `play`
function that clicks/keys like a viewer — the screen has no prop that starts playback.

## Tests (`__tests__/shorts.test.ts`, 33 tests, all green)

- structure/loading: landmark + hidden `h1`, busy skeleton, no articles, no `<video>`, no `play()`
- populated: `feed({ source: 'shorts', limit: 10 })`, one article per short in `role=feed`,
  first active and the rest `inert`, posinset/setsize, title heading via `Markdown`, labelled
  article; posters through `image(url, sha256)` and used as `src`; a rejected hash → no image
- **price before play**: in every article the `.nf-sats--price` badge precedes `.nf-shorts__play`
  (`compareDocumentPosition` FOLLOWING), matches `renditionPriceSats`, the play label names the
  price; `play()` never called and no `<video>` on arrival
- playback: `play(id, '720p')` (the shown rendition), `setPrefetchSeconds(12)` from Settings,
  `onPlaybackStart`, exactly one `<video>`, price precedes the controls while playing, Pause →
  `session.pause()` + "Paused — not paying", Resume → `session.resume()`; live spend badge
- **moving on**: Next closes the session, navigates `{ name: 'shorts', videoId }`, the next short
  is idle behind its price and `play()` was called once; unmount closes; a late `play()` after
  moving on / after unmount is closed on arrival and never bound
- **price shown vs charged**: a 2× session is closed unused, the badge shows 2×, the note
  renders, pressing play again (now at the shown price) binds
- end of a short → `session.pause()` + Replay → `resume()`; media error → `close()` + Retry
- movement: ArrowDown/j/k/ArrowUp with bounds, ignored in an `<input>` and with Ctrl, Space
  plays; wheel: `preventDefault`, one short per gesture, next gesture after 250 ms; native
  scroll settles → the snapped short activates, session closed, route navigated; buttons
  disabled at the ends; tail end-cap + Back to the first short
- paging: second page requested with `cursor: '1'` near the end; failure → tail error, Retry
  appends, the tail becomes an idle short
- route: deep link without navigating, followed `videoId` changes, own navigation echoed back is
  a no-op (no refetch); out-of-page short fetched and put first; missing short → notice,
  dismissible
- gates: no-signer + signed-out (card, Connect signer → settings, Space does not play, Like →
  sign-in toast → settings), no-seeders (Retry re-fetches stats, no `play()`), no-balance (Top up
  → wallet); `play()` rejections → the four designed copies; `shortsPlayErrorKind` mapping
- errors: relay down → `role=alert` copy + detail, Retry refetches, no `console.error`;
  `describeShortsError`; empty → "No shorts yet", Browse Home → home
- actions: Like → `react('+')`, count +1, `aria-pressed`; again → `react('-')`; Subscribe →
  `subscribe`; channel → channel route (profile name shown); Comments → watch route; nutzap
  sheet: 100 chosen, "You send 100 sats" precedes Send, `j` does nothing behind the sheet,
  `nutzap(id, 100, mint)`, sheet closes, toast; no balance → card + Send disabled
- hostile title/description render as text (no `<img>`, no `<script>`, no `javascript:` link)
- cancellation: unmount mid-load (fake timers) → no follow-up calls, empty container, no errors

`npm run ci` exit 0 in this worktree: 62 files / 684 passed / 27 skipped (first run hit the known gateway WS-bridge timeout flake; the re-run was clean).

## Design choices (react to the PNGs)

- **Price centred above the play button**, not in a thumbnail corner: on a short the price and
  the one control that spends it belong together. While playing the price moves to a small chip
  top-left, next to the live rate.
- **Text pills in the rail** ("Like · 58", "Comments · 5", accent "Nutzap") rather than YouTube's
  round icon buttons: L4's `Icon` set has no thumbs-up, comment or share glyph, and a wrong
  icon is worse than a word. It also matches the Watch lane's action row. If L4 adds
  `thumbUp`/`comment`/`share` icons, the rail can switch to round `IconButton`s + captions with
  no behavioural change.
- Up/down use `chevronLeft`/`chevronRight` rotated 90° in screen CSS (L4 has no up/down
  chevrons) — visually identical to YouTube's.
- The in-frame gate/error cards are themed surfaces (`bg-elevated`, shadow) floating over the
  always-dark video frame, so `EmptyState`/`ErrorState` keep their normal colours.
- The overlay Subscribe is YouTube's white pill in both themes (overlay tokens), translucent
  once subscribed.
- The title is clamped to 2 lines and the description to 1 with an in-place "More".

## Things I was unsure about / judgement calls

- ~~**Un-like sends `react(id, '-')`**~~ — **resolved 2026-09-23:** contracts v4 added
  `unreact(videoId)` and lane UI-fixes switched Shorts and Watch to it (ADR 0007).
- **Space starts a paid session from the keyboard.** It is an explicit action on the active
  short whose price is on screen; the alternative (mouse/touch only) would make Shorts
  unplayable from a keyboard. `j`/`k` never start anything.
- **No loop, no auto-advance.** YouTube loops shorts; here a loop is a paid stream nobody asked
  for (a transport may or may not re-serve cached blocks for free), so the end pauses the
  session and offers Replay.
- **Which rendition.** `shortPrice` uses the manifest's first rendition (the publisher's
  default) and passes its label to `play()`, so the badge is the charge. Home's card shows the
  *cheapest* rendition ("from N sats"); for multi-rendition shorts the Shorts price can be higher
  than the Home card's — the fixtures have one rendition per short, so they agree. If the
  orchestrator prefers "always the cheapest" for shorts, change `shortPrice` only.
- **Signed-out viewers cannot play.** Paying needs a wallet, a wallet needs a signer; the mock's
  `play()` would succeed signed-out, a real adapter would not. The signer gate shows the
  designed card instead of letting the viewer hit a failed payment (matches Watch).
- **Deep link to a kind 21** (a normal video): shown as the first slide, letterboxed in the 9:16
  frame (`object-fit: contain` while playing). Not redirected to Watch — an automatic navigation
  on load felt worse; one line to change if wanted.
- **Page arriving under the tail**: if the viewer is on the skeleton tail when the next page
  arrives, the tail becomes the next short (idle, behind its price). The route is not updated
  for that (the viewer did not move); it is on their next move.
- **`me()` failing** is treated as signed out (the relay-down feed error covers that case).
- **Share-as-copy not built** (optional): the screen does not know the shell's URL scheme, and
  `navigator.clipboard` is a shell concern. A `shareUrl?(videoId)` prop could add it later.
- **Mini-player + Shorts both paying**: the screen renders the `miniPlayer` slot like Home and
  exposes `onPlaybackStart` so the shell can pause the mini-player's session when a short
  starts. Without the shell doing that, two streams can bill at once.
- **Media source**: `url` / `service-worker` sessions set `<video src>`; a `mediasource` session
  renders the element with no `src` (MSE wiring is the web shell's job — same as Watch). The
  element is created only after an explicit play, so there is no `autoPlay` attribute anywhere;
  playback starts with an explicit `el.play()` once the session is bound.
- `stats(id)` is fetched for every loaded short (like Home's paid-views line) because the gate
  needs `seedersOnline` before the viewer presses play.
- Fixture note (not my lane): fixture shorts' renditions are 16:9 (`width = height × 16/9`) — a
  real short is 9:16; the stories render 9:16 SVG posters so the PNGs look right.

## Deviations from the task text

- None of substance. Extras beyond the brief: the price-changed guard, the tail slide (end /
  loading / load-more error), a missing-deep-link notice, the phone-width layout, and the
  `onPlaybackStart` / `prefetchSeconds` props.
