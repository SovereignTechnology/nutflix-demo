# Lane L5-Library — the Library screen (`packages/ui/src/screens/Library/`)

**Issued against `CONTRACTS_VERSION = 3`.** Branch `lane/L5-Library`, based on main @ `e259115`.
One non-blocking request filed: `docs/contract-requests/L5-Library.md` (a `playlist` field on
the `library` route, plus two contract-comment clarifications). Everything works within v3.

Scope: build-plan §6.1 row **Library** + §6.2 ("Resume from NIP-51 private history"), design
brief `docs/design/README.md` (YouTube first, Rumble second, clean), L4 component API
(`docs/lanes/L4.md`), BRIEFS L5 row, `docs/lanes/L5-Home.md` as the worked example.

## What was built

```
packages/ui/src/screens/Library/
  index.ts                  export surface (below) — Library-prefixed names only
  Library.tsx               the screen: tabs · identity · per-tab loading/caching · History day
                            groups + resume · Watch later (optimistic remove, Undo, rollback) ·
                            Playlists grid + detail + create · Liked grid · empty/error states
  PlaylistForm.tsx          "New playlist" form (title, description, private toggle) in L4's Sheet
  libraryFormat.ts          pure helpers: day labels/grouping, resume position, counts, error copy
  Library.css               screen-scoped `nf-library` stylesheet, L4 tokens only
  Library.stories.tsx       title 'Screens/Library', 28 stories (one per state), MockNetworkAdapter
  __tests__/library.test.ts 30 vitest tests (jsdom, components/testing/render.ts)
  __tests__/format.test.ts   7 vitest tests for libraryFormat.ts
```

### Export line wanted in `packages/ui/src/screens/index.ts`

```ts
export { Library } from './Library/index.js';
export type { LibraryProps, LibraryTab } from './Library/index.js';
```

`./Library/index.js` also exports `LIBRARY_TABS`, `describeLibraryError` and the type
`LibraryHistoryEntry`. Every exported name is Library-prefixed, so `export * from
'./Library/index.js'` is safe next to Home's `describeError` — the pure helpers
(`groupHistoryByDay`, `historyProgress`, `countLabel`, …) stay internal on purpose.

### CSS wiring (orchestrator) — add to `packages/ui/src/screens/screens.css`

```css
@import './Library/Library.css';
```

The screen never imports its CSS (CSP `style-src 'self'`); the story imports `./Library.css`
directly (Vite), which is what the PNGs were rendered with.

## Props (`LibraryProps extends ScreenProps`)

| Prop | Type | Meaning |
|---|---|---|
| `adapter`, `navigate`, `miniPlayer` | from `ScreenProps` | `miniPlayer` renders in a `nf-library__mini` slot, fixed bottom-right at `--nf-z-mini-player` (same as Home) |
| `tab?` | `'history' \| 'watch-later' \| 'playlists' \| 'liked'` (= `Route['tab']` for `library`) | initial/controlled tab; a changed prop is followed. Default History (Playlists when `playlistId` is set) |
| `playlistId?` | `string` (NIP-51 `d` tag) | opens that playlist on the Playlists tab — the workaround for `Route` having no playlist field (contract request §1) |
| `now?` | `UnixSeconds \| number` | pinned in stories/tests for diffable day groups and timestamps |
| `timeZone?` | IANA zone string | the zone History days are cut in; default = the viewer's own; stories/tests pin `'UTC'`; an unknown zone falls back to the runtime's instead of throwing |
| `className?` | `string` | |

## Behaviour

- **Tabs**: identical idiom to Home — `role=tablist/tab/tabpanel`, chip `Button`s (primary =
  selected), roving `tabIndex`, ←/→/Home/End with wrap, automatic activation. **Every tab change
  calls `navigate({ name: 'library', tab })`** so the route stays the source of truth; local
  state switches immediately too, so a shell that does not re-render still works. A visible
  `h1` "Library" (YouTube shows page titles on its library pages). Each loaded list is cached
  for the session (switching back is instant, no refetch — tested); an interrupted load re-runs
  when its tab is shown again (tested). One muted line under the chip bar per tab: History "Only
  you can see your history — it is encrypted to your key", Watch later "Saving is free — you pay
  only for what you play", Liked "Likes are public Nostr reactions".
- **Identity**: `adapter.me()` once. A pubkey → load lists. `null` → `adapter.signer()` is asked
  *why*, and the panel shows a designed signed-out state (L4 `signer-not-detected` preset) with a
  per-tab title ("Sign in to see your history / Watch later list / playlists / the videos you
  liked"), copy explaining that the library is NIP-51 lists tied to your key with private ones
  encrypted, and **Connect signer → `navigate({ name: 'settings' })`**. A signer that reports a
  pubkey but `locked: true` gets "Your signer is locked … Unlock in Settings" instead. No
  `library.*` call is made while signed out (tested). `me()` failing → `ErrorState` with Retry.
- **History**: `library.history(cursor)`, grouped by calendar day in the viewer's zone:
  **Today / Yesterday / weekday (within the week) / "Aug 28" / "Jul 31, 2024"**, groups and rows
  in the adapter's order (appending a page never reshuffles). Each row is a wide `VideoCard`
  (list layout, 246 px thumbnail) with the **resume-progress bar** (`positionSec / durationSec`,
  L4's `progress` prop) and a trailing button **after the card in DOM order**:
  - `positionSec ≥ 5 s` and `< 95 %` → "Resume at 5:12" → `navigate({ name: 'watch', videoId, t: 312 })`
  - `≥ 95 %` → full bar, "Watch again" → `{ name: 'watch', videoId }` (starts over, like YouTube)
  - `< 5 s` → "Watch" → `{ name: 'watch', videoId }`
  - kind 22 → "Watch again" → `{ name: 'shorts', videoId }` (the shorts route has no `t`)
  Clicking the thumbnail/title does the same as the button. Pagination exactly like Home:
  `IntersectionObserver` sentinel (`rootMargin 600px`), 3 list skeletons while a page loads, a
  compact "Could not load more" `ErrorState` with Retry that keeps what is loaded, and a "Load
  more" button where `IntersectionObserver` is missing (jsdom). De-duplicated by `id:at`.
- **Watch later**: YouTube's playlist-page layout — a sticky hero panel (cover = the first
  video's verified thumbnail, "Watch later", count, "Saved videos cost nothing until you press
  play.") beside a numbered list of list-layout cards, each with an "×" `IconButton` labelled
  `Remove “<title>” from Watch later`. **Remove is optimistic**: the row disappears at once and
  `setWatchLater(id, false)` is called; on success a toast "Removed from Watch later" offers
  **Undo** (re-inserts at the original index and calls `setWatchLater(id, true)`; if *that*
  fails the row is removed again with an error toast); on failure the row is **rolled back to
  its original index** and a sticky error toast says `“<title>” is back in your list. Relay
  down.` with **Retry**. Toasts are L4's `ToastStack` (see "Toasts" below).
- **Playlists**: `library.playlists()` → a tile grid (≥ 240 px). Each tile: a 16:9 cover (first
  video resolved via `adapter.video(id)` → `adapter.image(url, sha256)`, `Skeleton` while
  pending, a `videoOff` placeholder for an empty or unresolvable playlist) with a "stack of
  sheets" edge and a "3 videos" overlay chip, the title (plain text), and a meta line with the
  **visibility indicator** — `Private` (key icon, tinted pill, tooltip "encrypted to your key,
  only you can see it") when `Playlist.isPrivate`, otherwise `Public` (people icon) — then "View
  full playlist". A toolbar shows the count and a **New playlist** button.
  - **Open** (title button; the cover is a mouse target with `tabIndex=-1` so there is one tab
    stop per tile): the hero shows "All playlists" back, cover, title, visibility · count, and
    the description **through `Markdown`**; the list resolves every id with `adapter.video`
    (cached per id across the screen), `VideoCardSkeleton` per row while pending, "Video
    unavailable" for `null`, "Could not load this video" + Retry for a rejected lookup. Focus
    moves to the playlist heading on open and back to the tile on close (ids come from relays,
    so the tile is found by comparing `data-playlist-id`, never by building a selector).
    Unknown `playlistId` → "Playlist not found" with "All playlists".
  - **Create**: L4 `Sheet` titled "New playlist" with Title (required, trimmed, 150 max, live
    counter), Description (optional, 5000 max, hint that bold/italic/links render), and a
    **Private playlist** checkbox, **on by default** (help text flips between "Encrypted to your
    key — only you can see it." and "Public — anyone can see it on your channel."). Create is
    disabled until the title has text. → `library.savePlaylist({ title, description?,
    videoIds: [], isPrivate })`; success closes the sheet, puts the playlist first in the grid
    and toasts "Private playlist created" / "Playlist created"; failure keeps the sheet open
    with what was typed and a compact `ErrorState` inside it. The title field takes focus when
    the sheet opens (see "L4 notes").
- **Liked**: `library.liked()` → count + Home's grid (grid-layout `VideoCard`s with channel
  avatars); kind 22 videos go to a "Shorts" shelf under the grid, as on Home.
- **Price before play**: every video on this screen is a `VideoCard`, whose thumbnail carries
  L4's `SatsBadge` price. The only play-shaped control the screen adds is the History
  resume/watch button, rendered **after** the card; the test asserts
  `price.compareDocumentPosition(button)` is FOLLOWING for every row. Nothing on this screen
  plays or pays — every affordance navigates to Watch/Shorts, which show the price before
  playback. No per-remaining-time price estimate is shown on "Resume" (what a resume actually
  costs depends on what is cached, so an estimate could differ from the charge).
- **Media (T16)**: thumbnails, playlist covers and avatars only ever come from
  `adapter.image(url, sha256)`; a rejected hash leaves the card's blur-up placeholder (or the
  cover `Skeleton`). Profiles resolved once per pubkey (tested).
- **Cancellation**: every load is guarded (an `AbortController` flag in effects, an `alive` ref
  for follow-ups); unmounting mid-load stops the chain — no `image`/`profile` call, no state
  update, no console error (tested with fake timers).
- **Toasts**: the screen renders its own `ToastStack` (`inline`, class `nf-library__toasts`),
  anchored at the end of the screen with `position: sticky; bottom: 16px; height: 0` so toasts
  grow upward from the viewport's bottom-left edge (YouTube's snackbar) and render the same in
  Storybook and both shells. Max 3; info toasts auto-dismiss (L4's 5 s), errors are sticky.

## States (Storybook `Screens/Library`, 28 stories × 2 themes = **56 PNGs** in `artifacts/screens/library/`)

| Story | How it is produced | What you see |
|---|---|---|
| Loading — History | `latencyMs: 5000` | a day-title skeleton + 5 list-row skeletons, panel `aria-busy` |
| Loading — Watch later | same, `tab: watch-later` | hero skeleton + 4 numbered row skeletons |
| Loading — Playlists | same, `tab: playlists` | 4 tile skeletons |
| Loading — Liked | same, `tab: liked` | 8 grid card skeletons |
| History (populated, grouped by day) | mock clock pinned, `recordProgress` at chosen times | Today / Yesterday / Monday / Aug 28 / Jul 31, 2024; resume, watched, barely-started and a short |
| History — loading more | history proxied to 4 per page, page 2 never resolves | 4 rows + 3 skeleton rows (the IO fired in headless Chromium) |
| Error — history could not load more | page 2 rejects | 4 rows + compact inline error with Retry |
| Watch later (populated) | seeded `setWatchLater` | hero + numbered list with "×" |
| Watch later — removed (Undo) | play function clicks the first "×" | row gone, "Removed from Watch later · Undo" toast |
| Error — Watch later remove failed (rolled back) | `setWatchLater` rejects; play function clicks "×" | row back in place, error toast "… is back in your list. Relay down." + Retry |
| Playlists (populated, private + public) | seeded `savePlaylist` | 4 tiles: Public / Private / Public / Private (empty draft) |
| Playlists — new playlist form | play function opens the sheet and types a title | the Sheet, 1280 × 900 frame so the fixed sheet is not cut |
| Playlist opened (private, with description) | `playlistId: 'space-deep-dives'` | hero with Private pill + Markdown description; 3 rows incl. a short |
| Playlist — unavailable videos | playlist with a missing id and an id whose lookup rejects | "Video unavailable" row, "Could not load this video" row with Retry |
| Liked (populated) | seeded `react('+')` | 4-card grid + Shorts shelf |
| Empty — history | stock mock (no progress recorded) | L4 `no-history` preset + "Explore trending" |
| Empty — watch later | stock mock minus its one entry | "Nothing saved for later" |
| Empty — playlists | `playlists` proxied to `[]` | "No playlists yet" + "New playlist" |
| Empty — playlist has no videos | `playlistId: 'empty-draft'` | hero + "This playlist is empty" |
| Empty — liked | stock mock minus its one like | "No liked videos yet" |
| Error — relay down | `failWith: 'relay-down'` | `ErrorState` "Relay down", detail, Retry |
| Error — playlists failed to load | `playlists` rejects with a decrypt/signer error | "Could not unlock your library" + detail + Retry |
| Error — no signer (sign-in state) | `failWith: 'no-signer'` | "Sign in to see your history" + Connect signer |
| Error — no seeders (library unaffected) | `failWith: 'no-seeders'` | Watch later populated (seeders matter on Watch) |
| Error — no balance (library unaffected) | `failWith: 'no-balance'` | Liked populated (balance matters at play time) |
| Signed out — playlists tab | `signedIn: false` | "Sign in to see your playlists" |
| Signed out — signer locked | `me()` → null, `signer()` → `{ pubkey, locked: true }` | "Your signer is locked" + "Unlock in Settings" |
| With mini-player slot | a placeholder node as `miniPlayer` | floats bottom-right over History |

Stories use `MockNetworkAdapter` with a settable `now` clock (so history lands on chosen days)
and `image()` mapped to the `.storybook/fixtures` inline SVGs; a small `Proxy` (`patched`)
replaces single members (`library.*`, `video`, `me`, `signer`) for the error/empty variants.
Three stories use a `play` function (plain DOM, no `storybook/test`) to reach post-interaction
states; the screenshot script captured them after the click (verified in the PNGs).

## Tests (37, all green)

`__tests__/library.test.ts` (30) and `__tests__/format.test.ts` (7):

- structure: landmark + `h1`, four tabs with History selected, skeletons + `aria-busy` while loading
- signed-out: per-tab sign-in copy, Connect signer → settings, **no `library.*` call**; locked
  signer → unlock copy; `failWith: 'no-signer'` → sign-in state
- tabs: roving tabindex, ←/→/Home/End with wrap, every change → `navigate({ name: 'library',
  tab })`, panel labelled by the active tab; a changed `tab` prop is followed; lists cached
- History: day headings in order, row count, `adapter.image(url, sha256)` → `<img src>`,
  progress-bar widths, button labels; **price precedes the resume control in every row**;
  resume → `watch` with `t`, watched/barely-started → `watch` without `t`, short → `shorts`,
  channel → `channel`; Load more fallback + cursor, failed page inline + Retry recovers;
  sentinel observed with a stubbed `IntersectionObserver`
- Watch later: hero + order + prices + open → watch; optimistic removal before the adapter
  answers, Undo restores at the same index with `setWatchLater(id, true)`; rejection rolls back
  to the same index, `role=alert` toast, Retry succeeds, no `console.error`
- Playlists: titles, Private/Public indicators, counts, cover via `adapter.video` + image,
  empty cover; open → heading focused, Markdown `<strong>` + `rel="noopener noreferrer"` link,
  videos resolved by id with prices, open → watch, back → grid with focus on the tile;
  unavailable/failed rows + Retry; unknown id → not found → back; create with trimmed title,
  description and private off → exact `savePlaylist` payload, sheet closes, tile first,
  toast; failed create keeps the sheet, the typed title and shows the error inside
- Liked: grid + shorts shelf, prices, routes by kind
- empty: every tab's copy; "Explore trending" → `home`/`trending`; empty playlists' action
  opens the sheet; empty playlist detail
- errors: relay-down → alert + detail, Retry re-asks `me()`, nothing thrown; one list failing →
  its own error, Retry recovers; no-seeders/no-balance leave the library intact
- cancellation: unmount while `history()` is pending → no `image`/`profile`, no errors;
  switching tabs mid-load abandons and reloads on return
- helpers: day labels incl. a zone where the day differs from UTC and an unknown zone,
  grouping order, resume/watched/start thresholds, counts, error mapping

`npm run ci` in the worktree: **exit 0 — 63 files / 688 passed / 27 skipped** (Home's 61 / 651
plus this lane's 2 / 37). The two earlier runs at load average 6–8 (other lanes' screenshot
jobs) hit the known `ws-bridge` cut-test timeout in `packages/gateway` (docs/status.md "Known
flake"); that file passes alone (7/7) and the full run passed at load 1.7.

## Design choices (react to the PNGs)

- YouTube's Library pages: visible page title, chip bar (Home's), History as wide rows under
  day headings, Watch later and an open playlist as **hero panel + numbered list**, playlists
  as a tile grid with a stacked edge and a count chip, Liked as Home's grid.
- Resume thresholds: < 5 s = start over ("Watch"), ≥ 95 % = watched ("Watch again", full bar).
- Shorts in list rows are **cropped to 16:9** (YouTube's playlist lists do the same): a narrow
  9:16 frame at row height clipped the price badge — seen in the first PNG pass and fixed.
- New playlists default to **Private** (privacy-first; YouTube defaults to Private too).
- Copy is sentence case and says what to do next: "Nothing saved for later", "No playlists
  yet", "This playlist is empty", "No liked videos yet", "Playlist not found", "Could not
  unlock your library", "Could not remove from Watch later", "Could not put it back".

## Assumptions / things I was unsure about

- **`library.playlists()` with no author = the viewer's own**, private ones decrypted
  (contract request §2). The Channel screen should pass an `author`.
- **Privacy copy**: History is described as private/encrypted (build-plan §6.2 "private
  history", L4's `no-history` preset says the same); likes as public Nostr reactions (kind 7,
  build-plan §6.1 Watch row). Watch later's privacy is not in the contract, so it gets no
  indicator — its hint is about money ("Saving is free"). Each is one line in `TAB_HINT`.
- **Open playlist is local state** + the `playlistId` prop until `Route` gains a field (request §1).
- **Undo order**: Undo re-inserts at the original index locally; a real NIP-51 list may append
  the id at the end, so a later reload could show it last. Harmless; noted.
- **Toasts live in the screen** (sticky inside it). If the shells own one global `ToastStack`,
  the screen could take an `onToast` prop instead — a small change.
- **Day grouping zone**: the viewer's runtime zone unless `timeZone` is passed. Stories/tests
  pin UTC so PNGs and assertions do not depend on the machine.
- `adapter` identity is assumed stable for the screen's life (caches are per-screen, as Home).

## L4 notes (not fixed — `components/` is locked for this lane)

- **List-layout skeleton collapses**: besides Home's `.nf-card__text` gap, in `layout="list"`
  `.nf-card__body` does not grow either, so `VideoCardSkeleton layout="list"` shows only its
  thumbnail. `Library.css` adds `.nf-library .nf-card--list .nf-card__body { flex: 1 1 auto;
  min-width: 0 }`. Suggested L4 fix: the same on `.nf-card--list .nf-card__body`.
- **`Sheet` focuses its first focusable (Close)** on open; forms want their first field. The
  form re-focuses its title in a `setTimeout(0)` after the Sheet's effect. An `initialFocus`
  ref prop on `Sheet` would be cleaner.
- **Icons the screen had to approximate** (none exist in `Icon`): lock (Private → `key`),
  clock (Watch later empty → `play`), thumbs-up (Liked empty → `check`), playlist/add (Playlists
  → `videoOff`, no icon on "New playlist").
- A shared `PlaylistCard` would dedupe this screen's tile with the Channel screen's Playlists tab.

## Other findings for the orchestrator

- **`packages/core/src/mocks/fixtures.ts`**: the `FIXTURE_NOW` comment says
  `2025-09-04T14:13:20Z`; `1_757_000_000` is actually **15:33:20Z**. Cosmetic, but any lane
  reasoning about day boundaries from the comment will be off by 80 minutes (this one was,
  briefly, in its tests).
- **Screenshots on this box**: the script's default Chromium
  (`/home/gateway/Applications/ungoogled-chromium/current/chrome`) does not exist here; PNGs
  were taken with `NUTFLIX_CHROMIUM=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`
  (already cached, nothing downloaded, fresh throwaway profile).
- Story files are excluded from `tsc`; type-checking them ad hoc shows the same `args`-missing
  errors for `StoryObj<typeof meta>` + `render` in Home's stories (20) and this lane's — the
  house pattern, harmless at runtime.

## Deviations from the task text

- Liked shows kind 22 in a "Shorts" shelf under the grid rather than in it (Home's decision).
- The signer check is `me()` first and `signer()` only when signed out (to tell "locked" from
  "no signer"), rather than calling both every time.
- Three extra stories beyond the listed states (loading per tab, Undo/rollback and the create
  form via `play` functions, mini-player slot).
