# Lane L5-Watch — the Watch screen (`packages/ui/src/screens/Watch/`)

**Issued against `CONTRACTS_VERSION = 3`.** Branch `lane/L5-Watch`, based on main @ `e259115`.
Contract requests (none blocking — every one is worked around in v3):
`docs/contract-requests/L5-Watch.md`.

Scope: build-plan §6.1 row **Watch** + all of §6.2, design brief `docs/design/README.md`
(YouTube first, Rumble second, clean), L4 component API (`docs/lanes/L4.md`), BRIEFS L5 row,
execution plan Stage-2 audit item "any UI path where the price shown can differ from the price
charged".

## State on arrival (resumed lane)

A previous session left uncommitted work: a 2 376-line `Watch.tsx` that type-checked and passed
its 35 tests, but `index.ts` exported four names that did not exist (so `tsc -b` failed) and
`Watch.css` belonged to a different, abandoned draft (wrong token names such as
`--nf-type-xl` / `--nf-bg-subtle`, and class names the component never used). Reviewing the
working component against the money rules found real defects, fixed here:

- **Price shown ≠ price charged.** The poster showed the *cheapest* rendition ("from 8,576
  sats") while `adapter.play(id)` defaulted to the first — here the most expensive (53,598 sats).
  The autoplay countdown had the same gap.
- **The `<video>` element was never told to `play()`/`pause()`**, so a real shell would have
  shown a paying session with a frozen picture.
- **Unmount recorded progress `0`** for a video that was opened but never played, wiping the
  viewer's resume point.
- A play started just before a thumbnail resolved was treated as stale and **left the stage
  spinning forever**, because a stale check compared object identity against data that
  `patchData` replaces.
- `buildThreads` dropped a reply under its parent only when the parent came first in page
  order; sort "new" lists newer replies first, which made them roots.

## What was built

```
packages/ui/src/screens/Watch/
  index.ts            export surface (below)
  Watch.tsx           the screen: load, PlaySession lifecycle, stage, keyboard, hand-off, actions
  model.ts            pure: constants, WatchHandoff, quoteFor/pickRendition, paidThroughSec,
                      buildCommentThreads, nextUp, resumePositionSec, stageGate, safePlaceholder…
  useResolvers.ts     per-item profile / avatar / thumbnail (T16) / stats resolution, once per key
  WatchParts.tsx      PricePanel (+ pre-play quality picker), UpNextOverlay, PeerOverlay, StageNote
  WatchComments.tsx   NIP-22 comments: Newest/Top, one reply level, composer, paging
  WatchSheets.tsx     NutzapSheet (amount + MintChip + note), ReportSheet, ShortcutsSheet
  WatchRelated.tsx    rail: playlist panel, "Up next" + Autoplay switch, Shorts shelf
  Watch.css           screen-scoped `nf-watch` stylesheet, L4 tokens only
  Watch.stories.tsx   title 'Screens/Watch', 18 stories (one per state)
  __tests__/watch.test.ts   58 vitest tests (jsdom, components/testing/render.ts)
```

### Wiring the orchestrator must add

`packages/ui/src/screens/index.ts`:

```ts
export { Watch } from './Watch/index.js';
export type { WatchProps, WatchHandoff, WatchPlaylist } from './Watch/index.js';
```

(`./Watch/index.js` also exports `describeWatchError` and the `WATCH_*` constants. Every name is
`Watch`-prefixed or unique, so `export * from './Watch/index.js'` is also collision-free —
Home's `describeError` is not shadowed.)

`packages/ui/src/screens/screens.css`:

```css
@import './Watch/Watch.css';
```

## Props (`WatchProps extends ScreenProps`)

| Prop | Type | Meaning |
|---|---|---|
| `adapter`, `navigate`, `miniPlayer` | `ScreenProps` | `miniPlayer` (the shell's node) floats in `.nf-watch__mini`, fixed bottom-right at `--nf-z-mini-player` |
| `videoId` | `NostrEventId` | `Route.watch.videoId`; a change reloads the screen |
| `startAtSec?` | `number` | `Route.watch.t`; beats library-history resume, applies only to that video |
| `onMiniPlayer?` | `(session, videoId, handoff: WatchHandoff) => void` | mini-player handshake, Watch → shell (below) |
| `resumeSession?` | `WatchHandoff` | handshake, shell → Watch (below) |
| `playlist?` | `{ title, videoIds, id? }` (`WatchPlaylist`, a `Playlist` subset) | playlist panel; autoplay-next follows it |
| `autoplayNext?` | `boolean`, default `true` | initial state of the rail's Autoplay switch |
| `prefetchSeconds?` | `number` | overrides `Settings.prefetchSeconds` (fallback 30) |
| `now?`, `className?` | | pinned "now" for stories/tests |

## Mini-player handshake (for L6 / L7)

**Watch → shell.** `onMiniPlayer(session, videoId, handoff)` is called exactly once per
hand-off. `handoff` = `{ session, videoId, title, positionSec, paused, volume, muted,
playbackRate }`. From that call on **the shell owns the session**: Watch unsubscribes its
`onPeers`/`onSpend` listeners, never touches it again, and does not close it on unmount. The
shell renders its own `<video>` from `session.source` at `positionSec`, and **must `close()`
the session when its mini-player is dismissed** — otherwise it keeps paying. Watch hands off:

1. when the viewer presses the mini-player control or `i`;
2. on in-screen navigation to a non-watch route (channel, tag search, settings, wallet…) while
   a session is live;
3. **on unmount while a session is live and not ended** — i.e. shell-initiated navigation
   ("mini-player on navigate").

In-screen navigation to another *video* (a related card, a playlist item, a short) closes the
session instead of handing it off. A shell that remounts Watch on watch → watch navigation of
its own (URL bar, history) will receive a hand-off for the old video during that unmount; it
should `close()` it (or not pass `onMiniPlayer` for that transition). The stage shows
"Playing in the mini-player" over the dimmed poster while the shell has the session.

**Shell → Watch.** When the viewer expands the mini-player, the shell navigates to the video
and passes the same `WatchHandoff` (updated `positionSec`/`paused`) as `resumeSession`. Watch
adopts it once the video has loaded — no new `play()`, no new price (it was shown when the
session started) — and owns it again (closes it on unmount or hands it off again). Adoption is keyed on the
session object: a session Watch has closed is never adopted again, however often the shell
re-renders with a new `WatchHandoff` around it; a hand-off makes it adoptable again.

**Without `onMiniPlayer`** the Player's `mini` mode floats in place (`.nf-watch__mini`) with
Expand/Close, the stage shows "Playing in the mini-player / Bring it back", and unmount closes
the session. `ScreenProps.miniPlayer` alone is only a slot for the shell's node — it cannot
carry the session back into the screen, which is why the callback exists.

## Behaviour (§6.1 + §6.2)

- **Price before play, exactly what is charged.** The stage's first DOM child is the price
  panel: `SatsBadge` with the whole-video price **of the rendition that will play**, its label
  (a menu before playback listing every rendition, its size, price and `+N / −N`), `≈ N
  sats/min`, and the creator's `MintChip`s. `quoteFor(video, preferredLabel)` produces both the
  shown price and the label passed to `adapter.play(id, label)`; a session that comes back at a
  different rendition or video is closed unplayed ("nothing was played") — tested. Default
  rendition = the manifest's first (what `play(id)` would pick); the preference persists across
  videos in the screen like YouTube's. The big play button is labelled "Play — costs N sats
  (label)". **Nothing autoplays on mount** (tested: no `play()`, no `<video>`).
- **PlaySession.** `setPrefetchSeconds` = prop → `Settings.prefetchSeconds` → 30. `onPeers` →
  the peer panel + the seek bar's "paid so far" (`paidThroughSec`: blocks × blockSize ÷ bytes/s).
  `onSpend` → the green "streaming N sats/min" chip in the actions row and the Player's chip.
  `pause()` = stop paying and **show it**: "Paused — not paying · N sats so far" in the actions
  row, 0 sats/min in the chip and the peer panel. An element pause from outside (PiP window,
  media keys) pauses the session too; a media error stops paying and shows the Player's error
  card with Retry ("Payment is paused — nothing more is being paid"). `switchRendition` via the
  Player's quality menu (which shows the price difference first); the old session is closed,
  a paused viewer stays paused, and a toast states the new price and the delta. `close()` on
  unmount (unless handed off), on "close", on another video.
- **Media element.** A plain `<video>` in `Player.media` for `url`/`service-worker` sources (an
  MSE source renders without `src`; attaching MSE is the web shell's job). State drives it:
  `play()`/`pause()`, volume, mute, rate, captions (`<track>` from a T16-verified caption blob),
  `currentTime` on every (re)mount (mini ↔ stage) and session switch. When the element cannot
  drive the clock (jsdom; a dead source), a 1 Hz clock advances the position at the playback rate.
- **Resume**: `library.history()` first page → `resumePositionSec` (< 5 s or within 10 s of the
  end ⇒ 0), "Resume from 21:00" + a watched bar on the poster; `recordProgress` every ~5 s while
  playing, and on pause/end/close/hand-off — **only for a video that was actually played**.
- **Autoplay-next** from the playlist (item after the current one) or else the first kind-21
  related video: a countdown overlay (5 s, progress bar) with the next video, **its price at
  the rendition that will play**, Cancel and Play now. When it completes, Watch closes the
  session, announces `navigate({ name: 'watch', videoId })`, and starts the next video only if
  the freshly loaded manifest still prices it at or below what was shown — otherwise a toast
  "Autoplay stopped — the price changed" and the priced poster (tested). A shell that remounts
  Watch on navigation gets the safe path: price first, no autoplay. The rail's Autoplay switch
  turns the countdown off.
- **Theater** (`t` or the Player button): the stage spans both columns on a black band capped
  to the viewport height. **Fullscreen** (`f`) requests it on the stage (price panel and
  overlays included) and follows `fullscreenchange`. **PiP** (`p`) via
  `requestPictureInPicture`, synced from `enter/leavepictureinpicture`; unavailable → toast.
- **Keyboard**: the focused Player handles L4's full map. Page-wide, while a session is live:
  space/k, j/l ±10 s, f, m, t, i, `<`/`>` speed, 0–9 seek N×10 %, c, p. Ignored while typing,
  inside sheets/menus, with modifiers, and for Space/Enter on a focused control; arrows/Home/End
  stay with the page (scrolling). **Before playback only `t` works — a stray key never starts
  paying.** The overflow menu opens a "Keyboard shortcuts" sheet (L4's `KEYBOARD_MAP`).
- **Peer panel** (people button): L4's `PeerMeter` overlay with the seeders' **names and
  avatars resolved** through `adapter.profile`/`adapter.image`, ranked bars, latency dots,
  per-seeder sats/min and total, a skeleton until the first report, "Paused · not paying" when
  paused, and a footer that states the tariff in words ("2 sats per 64 KiB block at 1080p ·
  50% to seeders, 50% to the creator"). The Player's own (profile-less) overlay is not used.
- **Channel row + actions**: `ChannelRow` (NIP-05, Subscribe via `adapter.subscribe`/
  `unsubscribe`, "N sats to creator" from `VideoStats.satsToCreator`), Like (`adapter.react
  '+'/'-'`, pressed state + count), Nutzap (accent) → `Sheet` with 21/100/1 000/custom, the
  creator's mints as selectable `MintChip`s with balances (default: first funded), an optional
  public note, a `SatsBadge` before "Send nutzap", and the no-balance preset + Top up when the
  mint cannot cover it. Overflow menu: Save to / Remove from Watch later
  (`library.setWatchLater`), Keyboard shortcuts, Report video (→ sheet → `adapter.report`).
- **Description**: meta line (paid views · age · seeders online · tags → search), body through
  `Markdown`, clamped to three lines with "…more / Show less".
- **Comments** (NIP-22): count heading, Newest/Top (`adapter.comments(id, sort)`), one reply
  level (`buildCommentThreads`, two-pass, cycle-safe, drops nothing), composer for signed-in
  viewers (own avatar resolved), inline reply composer, "More comments" paging, compact
  loading/error/empty states, a sign-in row when signed out. Bodies only through `Markdown`.
- **Related rail**: `adapter.related(id, 8)`; kind-21 as list cards (each with its price),
  kind-22 in a three-across Shorts shelf; only metadata + T16-verified thumbnails load — **no
  `play()` for anything but the video on screen** (tested). Optional playlist panel (N / M,
  current item highlighted; manifests via `adapter.video`, capped at 50, metadata only).
- **Gates on the stage** (theme-coloured, the price still first): signed out →
  `signer-not-detected` ("Everything else on this page works without one"); `seedersOnline ===
  0` → `no-seeders-online` + Retry; no balance at any of the video's mints →
  `no-balance-at-mint` naming the mints + Top up; a `play()` rejection maps to the same presets
  or an `ErrorState` ("Nothing was played and nothing more was paid").
- **Cancellation**: every effect aborts on unmount/video change; late answers are dropped by
  load tokens and alive refs; a session that resolves after unmount or a video change is closed
  immediately.

## States (Storybook `Screens/Watch`, 18 stories × 2 themes = **36 PNGs** in `artifacts/screens/watch/`)

| Story | How | What you see |
|---|---|---|
| Loading (skeletons) | `latencyMs: 5000` | stage block, title/channel/description skeletons, six list-card skeletons |
| Populated (price before play) | default mock | 53,598 sats · 1080p ▾ · ≈ 1,145 sats/min · mints, big play, full page |
| Resume from history | `recordProgress(…, 1260)` first | "Resume from 21:00" + watched bar |
| Quality picker before play | clicks the quality chip | menu: 1080p / 720p −26,798 / 360p −45,022 |
| Playing | presses Play | Player chrome, "streaming 960 sats/min", paid-to marker |
| Paused — not paying | Play, then Pause | amber "Paused — not paying" chip |
| Peer panel | Play, then Seeders; ranked fixture peers | four seeders with names/avatars, bars, tariff footer |
| Ended — up next countdown | Play, then `ended` | next video, 13,495 sats · 1080p, countdown bar, Cancel / Play now |
| Theater mode | Play, then `t` | full-width stage on a black band, rail below |
| Mini-player (hand-off) | Play, then `i`; a stand-in shell renders its mini Player | stage note over the dimmed poster; mini-player bottom-right |
| Playlist panel | `playlist` prop | "Ceramics binge 1 / 3", current item highlighted |
| Nutzap sheet | clicks Nutzap (frame 1280 so the fixed sheet is whole) | amounts, mint chooser with balances, note, 21 sats before Send |
| Empty — video not found | unknown id | "Video not found" + Back to Home |
| Error — no seeders / no balance / no signer / relay down | `failWith` | stage gate presets with the price above; relay-down page `ErrorState` with detail + Retry |
| Signed out | `signedIn: false` | signer gate on the stage; page readable; comment sign-in row |

Playing states are reached by a story wrapper that clicks the priced Play button like a viewer
(the screen itself never autoplays). The story adapter hands out an MSE-style source (the
mock's `fixture://` URLs make a real browser fire `error`, and the screen then — correctly —
stops paying) and delivers twelve session ticks at once so spend and peers are stable in PNGs.

## Tests (`__tests__/watch.test.ts`, 58 tests)

- structure/loading: landmark + one `h1`, skeletons, `aria-busy`; populated page; description
  expands, links `rel="noopener noreferrer"`.
- **money**: price badge precedes the play affordance (poster and live); every gate shows the
  price and no play affordance; **no autoplay on mount**; **poster price = `play()` rendition**,
  the pre-play picker changes both (menu shows prices + deltas); a session at another rendition
  is refused and closed; related never prefetched (`play` calls = exactly the one video);
  **no progress recorded for an unplayed video**; mid-play switch toasts price + delta.
- PlaySession: prefetch/peers/spend wiring, `recordProgress` at 5 s and 10 s, 960 sats/min chip;
  pause stops paying + says so (0 sats/min), resume; `switchRendition` + old session closed;
  close on unmount; element `play()`/`pause()` follow state; an outside element pause pauses
  the session; a media error stops paying, shows the error card, Retry resumes.
- keyboard: page-wide `l`, `5`, `>`, `t`, `k` drive the live player; typing is ignored; a
  stray `k`/space before playback never calls `play()`; `t` works pre-play.
- peer panel: skeleton before the first report, one row per seeder with resolved names,
  sats/min, tariff footer, "Paused · not paying".
- mini-player: `onMiniPlayer` hand-off (session, id, position); unmount while playing hands off
  instead of closing; opening another video closes instead; channel navigation hands off first;
  `resumeSession` adoption without `play()` at the handed-off rendition/position, closed on unmount;
  a session Watch already closed is never re-adopted, even from a fresh hand-off object.
- autoplay-next: countdown with price, Cancel; completion navigates and plays the next at the
  **same rendition the countdown priced**; refused when the loaded manifest is pricier; playlist
  panel + "Next in playlist"; the Autoplay switch.
- errors/empty: not-found → Home; relay-down `ErrorState` detail + Retry refetches, no
  `console.error`; signer / seeders / balance gates and their CTAs (`settings`, `wallet`).
- actions: related → `watch`/`shorts`, channel → `channel`; like/subscribe; nutzap (mints,
  badge before Send, preset + custom amount, no-balance disables Send + Top up); report from
  the overflow menu; Watch later + shortcuts sheet.
- comments: sort new/top, post lands through `Markdown`, reply with the root as parent,
  signed-out sign-in row.
- cancellation: unmount mid-load → no `image()`/`balances()` calls, no console errors.
- pure: `buildCommentThreads` (one level, drops nothing), `resumePositionSec`, `playErrorKind`,
  `describeWatchError`, `safePlaceholder`.

## Assumptions / judgement calls

- **Default rendition = the manifest's first**, priced and passed explicitly. Home cards say
  "from N sats" (cheapest); Watch shows the exact price of what will play and a one-click
  picker. "Auto" (throughput-based) is not offered: `PlaySession` exposes no throughput
  (contract request).
- **Hand-off on unmount** when `onMiniPlayer` is given (see the handshake). This is what makes
  "mini-player on navigate" work for shell-initiated navigation; the cost is the documented
  watch → watch remount case the shell must close.
- **Page-wide keys only while a session is live** (plus `t`); arrows/Home/End are left to page
  scrolling at page level.
- **Paused/ended/error all read "… — not paying"**; "sats so far" is the session total.
- **Rendition switch keeps the old session until the new one is confirmed**, then closes it;
  a new session at a label other than the one asked for is closed and the old one kept.
- The nutzap sheet says the zap is public and goes to the creator in full (NIP-61 P2PK to the
  creator) — no seeder split. The optional note is passed as `nutzap(…, comment)` only when
  non-empty.
- Related shorts go to a Shorts shelf (as Home does); a short inside a list row is cropped
  16:9. Autoplay never goes into a short.
- `Settings.theme`/`hoverPreview` are not Watch's business; the shell owns them.

## Things I was unsure about

- **`nostr:` references in descriptions/comments render as L4's neutral chip**, not profile
  chips: `NostrRef` carries only the bech32 string and `adapter.profile` takes hex; decoding
  bech32 in the UI would mean importing core runtime code (forbidden). Contract request.
- **Resume reads only the first `library.history()` page** (20 entries in the mock) — a video
  watched longer ago starts at 0. Contract request for a per-video lookup.
- **Route has no playlist context** (`Route.watch` = `videoId`, `t`), so the shell must pass
  `playlist`. Suggested `list` param in the contract-request file (Route is orchestrator-owned).
- **Chromium fires `pause` then `error` for an unplayable source**; the screen treats both as
  "stop paying". A real shell whose `url` source briefly errors during start-up would show the
  error card with Retry.
- The **L4 `VideoCardSkeleton` list layout** collapses its text lines (the Home bug, one level
  up: `.nf-card__body` also needs `flex: 1 1 auto` in list rows). Worked around in `Watch.css`;
  suggested L4 fix: `.nf-card--list .nf-card__body, .nf-card__text { flex: 1 1 auto; }`.
- The mock streams at a fixed 8 blocks/s, so its "streaming 960 sats/min" differs from the
  bitrate-derived "≈ 1,145 sats/min" estimate on the poster; the estimate is hidden once a
  session is live so the two never sit side by side.
- `adapter` identity is assumed stable for the life of the screen (per-key resolution caches).

## Verification

`npm run ci` in the worktree: see the commit message for the exit code and counts. Screen
suite: 58 tests. `storybook:build` ok; `screenshots --filter screens-watch` wrote 36 PNGs
(run with `NUTFLIX_CHROMIUM` pointing at the local Playwright Chromium — the script's default
path does not exist on this box). Runtime source greps clean for `console.`, `mocks`,
`dangerouslySetInnerHTML`, `innerHTML`, `window.location`, storage APIs, crypto libraries.
