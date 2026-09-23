# Lane L5-Search — the Search screen (`packages/ui/src/screens/Search/`)

**Issued against `CONTRACTS_VERSION = 3`.** Branch `lane/L5-Search`, based on main @ `e259115`.
Contract/route requests: `docs/contract-requests/L5-Search.md` (filters in the search route,
channel search, optional `AbortSignal`/`limit`) — every one has a working workaround here.

Scope: build-plan §6.1 row **Search** ("Results with filters (date, duration, tags,
creator) — NIP-50 + local index") + §6.2/§6.3, design brief `docs/design/README.md`
(YouTube first, Rumble second, clean), L4 component API (`docs/lanes/L4.md`), BRIEFS L5 row.

This lane was resumed from an interrupted session's uncommitted draft (screen, 21 tests,
stories, CSS). The draft typechecked and its tests passed, but it had real bugs, fixed here:

- **Re-search every second.** With no `now` prop the render-time clock was a dependency of
  the search effect, so any re-render in a new second (every profile/stats answer) fired
  `adapter.search` again, forever. The clock is now read once per mount for display and at
  request time for `since`; it never feeds an effect (tested).
- **A search per keystroke in the tags box** (no debounce) — now debounced like the query,
  and a filter change that normalises to the same state (`"space,"` vs `"space"`) is a no-op.
- **Inconsistent pages.** Load-more rebuilt the filters with a fresh clock, so page 2 could
  use a different `since` than page 1. The first page's exact request is now stored and
  reused (plus `cursor`) for every page (tested).
- **Load-more staleness.** An older query's page 2 could be appended to a newer query's
  results if both were loading. Now dropped by sequence number and request identity (tested,
  and both staleness guards were mutation-checked: removing either makes a test fail).
- **Shorts rows 640 px tall** (9:16 thumbnails in a 360 px list column) — which also made
  the screenshot capture hang (see "L4/tooling findings").
- Missing: description snippet, channel results, Shorts shelf, removable filter chips,
  Search-prefixed exports (the draft exported `DURATION_OPTIONS`, `hasActiveFilters`, …
  into an `export *` barrel).

## What was built

```
packages/ui/src/screens/Search/
  index.ts                   export surface (Search-prefixed names only)
  Search.tsx                 search box · filter chips + panel · channel results · result rows
                             with snippets · Shorts shelf · infinite scroll · skeleton/empty/error
  Search.css                 screen-scoped `nf-search`, L4 tokens only, container queries
  Search.stories.tsx         title 'Screens/Search', 16 stories (one per state), MockNetworkAdapter
  __tests__/search.test.ts   36 vitest tests (jsdom, components/testing/render.ts)
```

### Wiring the orchestrator must add

`packages/ui/src/screens/index.ts`:

```ts
export { Search } from './Search/index.js';
export type { SearchProps, SearchFilterState } from './Search/index.js';
```

(`export * from './Search/index.js';` is also safe: every name in there is Search-prefixed —
`Search`, `SEARCH_DEBOUNCE_MS`, `SEARCH_UPLOAD_DATES`, `SEARCH_DURATIONS`,
`DEFAULT_SEARCH_FILTERS`, `buildSearchFilters`, `normalizeSearchFilters`,
`describeSearchError`, types `SearchProps`, `SearchFilterState`, `SearchUploadDate`,
`SearchDuration`. No `describeError` collision with Home.)

`packages/ui/src/screens/screens.css`:

```css
@import './Search/Search.css';
```

## Props (`SearchProps extends ScreenProps`)

| Prop                               | Type                                 | Meaning                                                                                                                                                              |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`, `navigate`, `miniPlayer` | from `ScreenProps`                   | `miniPlayer` renders in `.nf-search__mini`, `position: fixed` bottom-right at `--nf-z-mini-player` (same as Home)                                                     |
| `q?`                               | `string`                             | `Route['q']` for `search`. Shown in the box and searched; a changed value is followed, a re-applied one is a no-op                                                   |
| `filters?`                         | `Partial<SearchFilterState>`         | Filters from the shell (e.g. its URL). Followed **by content**, so a fresh object per render is fine. Sanitised by `normalizeSearchFilters`                          |
| `onFiltersChange?`                 | `(f: SearchFilterState) => void`     | Every filter change the viewer makes — the bridge until `Route` carries filters (request 1)                                                                          |
| `now?`                             | `UnixSeconds \| number`              | Pinned in stories/tests. Absent → read once per mount for relative timestamps; `since` is computed from the real clock at request time                               |
| `className?`                       | `string`                             |                                                                                                                                                                      |

`SearchFilterState` = `{ uploaded: 'any'|'hour'|'day'|'week'|'month'|'year'; duration:
'any'|'short'|'medium'|'long'; tags: readonly string[]; author: NostrPubkey | '' }`.

## Behaviour

- **Query**: `<form role="search">` with a real `type="search"` input and a submit
  `IconButton`. Typing commits after **300 ms** of quiet (`SEARCH_DEBOUNCE_MS`); Enter (or
  the button) commits at once **and** calls `navigate({ name: 'search', q })` so the URL
  follows. Debounced typing does not navigate (no history entry per pause). `/` anywhere
  focuses and selects the box unless the viewer is typing in another field
  (`isTextEntryTarget`). Clearing the box returns to the idle state without a search.
- **Adapter**: `adapter.search({ text, filters? })` — `filters` omitted entirely when none
  are set. Pages: `{ ...firstRequest, cursor }`. Signed-out / no-signer / no-seeders /
  no-balance never gate search (tested).
- **Staleness**: every search bumps a sequence number and its effect has a cancellation
  flag; a response (or failure) for anything but the current query is dropped, including a
  late page 2 of a previous query. The contract has no `AbortSignal`, so the request itself
  runs to completion (request 3). A synchronous throw from `adapter.search` becomes a
  rejection → `ErrorState`, never a React error.
- **Filters**: a **Filters** toggle (`aria-expanded`, "Filters (N)" when active), one
  removable chip per active filter ("Last 7 days ✕", "#music ✕", creator name ✕) and
  **Clear filters**. The panel is YouTube's column layout: _Upload date_ and _Duration_ are
  `<fieldset>` radio groups (native radios, visually hidden, focus ring on the label via
  `:has(:focus-visible)`; selected option bold with a check), _Tags_ is a text box
  (comma/space separated, `#` optional, lower-cased, ≤ 10, debounced, Enter commits) with
  up to 8 "tags in these results" suggestions, _Creator_ is a `<select>` with optgroups
  **Your subscriptions** (`adapter.subscriptions()`) and **Seen in results**. Any change
  re-runs the search immediately with the current query. The panel starts open when filters
  arrive via props.
  - `since` = now − preset (rolling windows: last hour / 24 h / 7 d / 30 d / year).
  - Duration: under 4 min (≤ 239 s), 4–20 min (240–1200 s), over 20 min (≥ 1201 s).
  - Tags are "any of" (as the mock implements `filters.tags`; the contract does not say); author is one pubkey.
- **Result rows**: `VideoCard layout="list"` made a CSS **subgrid** of the row so the
  description snippet (a sibling `Markdown`, ≤ 280 chars parsed, clamped to 2 lines) sits
  in the text column under title · channel · "N paid views · 3 hours ago" —
  `[thumbnail 360 px | text]`, 246 px under a 900 px column, stacked (snippet dropped) under
  600 px. Responsive by **container query** on the results column, not the viewport, since
  the shells put the screen beside a sidebar.
- **Price before play**: every card's `SatsBadge` ("from 1.2k sats") is on its thumbnail,
  which is the card's first control; the test asserts for every row and shelf card that the
  badge is inside the thumbnail button and precedes the title button in DOM order. Nothing
  on this screen plays or pays; playback starts on Watch/Shorts.
- **Shorts shelf**: kind-22 hits are pulled out of the rows into a horizontal "Shorts"
  section after the third video row (YouTube's placement; Home does the same for feeds).
  Opening one → `{ name: 'shorts', videoId }`; kind 21 → `{ name: 'watch', videoId }`;
  channel → `{ name: 'channel', pubkey }`.
- **Channel results (derived)**: the contract returns videos only (request 2), so when the
  query starts a word of a hit's author name/handle, or the start of their NIP-05 name (≥ 2
  characters), that author is shown on top as a `ChannelRow size="lg"` (avatar centred in
  the thumbnail column, YouTube's channel card), max two, hidden while a creator filter is
  set. Subscribe/Unsubscribe → `adapter.subscribe/unsubscribe`, state from
  `adapter.subscriptions()`; signed out → `navigate({ name: 'settings' })` (connect a signer).
- **Resolution per hit**: `adapter.image(url, sha256)` for thumbnails (T16 — the blur-up
  placeholder stays if the hash check fails), `adapter.profile` once per author,
  `adapter.image(picture)` for channel-card avatars only, `adapter.stats(id)` for paid views.
  All guarded by an `alive` ref; nothing runs after unmount (tested: no `image`, `profile`,
  `stats` or `subscriptions` call after an unmount mid-search).
- **Infinite scroll**: 1 px sentinel under an `IntersectionObserver` (`rootMargin 600px`),
  re-observed after every page; 2 list skeletons while a page loads; "Could not load more"
  compact `ErrorState` with Retry that keeps loaded rows; "Load more" `Button` where
  `IntersectionObserver` is missing; items de-duplicated by id. Same pattern as Home.
- **States**: idle ("Search Nutflix" + how-to), loading ("Searching for “q”…" + 6 list
  skeletons, `aria-busy`), results ("N results for “q”", "N+" while more pages exist),
  **no results** (`no-results` preset; echoes the query, says whether filters were involved,
  explains that search depends on relays that support it, offers **Clear filters** only when
  filters are set), **error** (`ErrorState`: "Relay down" / "Search failed", detail line,
  Retry re-runs the same query).
- **A11y**: `section` landmark named by a visually hidden `h1` "Search"; hidden `h2`s
  "Channels" / "Videos", visible `h2` "Shorts"; result lists are `ol` (numbering continues
  after the shelf via `start`); results region `role="region"` + `aria-busy`; counts are
  `role="status"`; filter chips say "Remove filter: …"; tag suggestions say "Add tag …".

## States (Storybook `Screens/Search`, 16 stories × 2 themes = **32 PNGs** in `artifacts/screens/search/`)

| Story                                   | How                                              | What you see                                                                 |
| --------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Initial (no query)                      | no `q`                                           | search box + "Search Nutflix" idle state                                     |
| Loading (skeleton rows)                 | `latencyMs: 5000`                                | "Searching for “ceramics”…" + 6 list skeletons                               |
| Results (channel match + Shorts shelf)  | `q="ceramics"`                                   | Kilnfire Ceramics channel card (Subscribe), 2 rows with snippets, Shorts shelf |
| Results (many, infinite scroll)         | `q="a"`, 6 per page                              | "6+ results", 3 rows, Shorts shelf (2), more rows                            |
| Results filtered (panel open, chips)    | `filters={{ uploaded: 'year', duration: 'long', tags: ['music'] }}` | chips, open panel (checked options), `#live` suggestion, Low Tide channel (Subscribed) |
| Loading more (second page)              | 3 per page, page 2 never resolves                | 3 rows + 2 skeletons (the observer fired in headless Chromium)               |
| Error — could not load more             | 3 per page, page 2 rejects                       | 3 rows + compact "Could not load more" with Retry                            |
| Empty — no results                      | `q="woodworking"`                                | `no-results` preset echoing the query, no action                             |
| Empty — filters too strict              | `ceramics` + under 4 min + last hour             | same, "with these filters" + **Clear filters**                               |
| Error — relay down                      | `failWith: 'relay-down'`                         | "Relay down", detail `relay-down: no relays reachable`, Retry                |
| Error — no signer                       | `failWith: 'no-signer'`                          | results as normal; Subscribe on the channel card goes to Settings            |
| Error — no seeders                      | `failWith: 'no-seeders'`                         | unaffected (seeders matter on Watch)                                         |
| Error — no balance                      | `failWith: 'no-balance'`                         | unaffected (balance matters at play time)                                    |
| Signed out (search still works)         | `signedIn: false`                                | results as normal                                                            |
| Narrow column (phone width)             | story width 390                                  | stacked rows (container query), no snippet, compact channel card             |
| With mini-player slot                   | placeholder node as `miniPlayer`                 | floats bottom-right over the results                                         |

## Tests (`__tests__/search.test.ts`, 36 tests, all green)

- structure/keyboard: landmark + `h1`, search box, idle hint; route `q` shown, followed,
  re-applied `q` is a no-op; Enter commits without the debounce and navigates; `/` focuses
  the box but not while typing in the tags field
- debounce/staleness/contract: 3 keystrokes → one call after exactly 300 ms, trimmed;
  clearing → idle with no call; **older query answering last never overwrites the newer
  one**; a late failure of an older query shows no error; **an older query's page 2 is
  dropped while the newer query's page 2 is loading**; no `now` prop → a later re-render
  does not re-search; synchronous throw → ErrorState
- rows: one list-layout row per kind-21 hit, `adapter.image(url, sha256)` result is the
  `<img src>`, channel name, paid views; **snippet through Markdown only** — `**bold**` →
  `<strong>`, `<img onerror>`/`<script>` render as text; **price before play** on every row
  and shelf card; Shorts shelf after row 3 with kind-22 only; watch/shorts/channel routes
- channel results: `ceramics` → Kilnfire card on top, avatar via `adapter.image`, name →
  channel route, Subscribe → `adapter.subscribe` → "Subscribed"; followed channel →
  Unsubscribe → `adapter.unsubscribe`; signed out → settings route, no adapter call; none
  for one-letter or non-matching queries; `matchesChannelQuery` unit cases
- filters: radios → `since` / `maxDurationSec`; tags debounced (2 keystrokes → 1 call,
  normalised, trailing comma → no call); creator optgroups, author filter; filters never
  navigate but `onFiltersChange` gets the full state; chip labels, "Filters (5)", removing a
  chip, Clear filters; tag suggestion adds a tag; `filters` prop initial + followed by
  content not identity; `buildSearchFilters` / `parseSearchTags` / `normalizeSearchFilters`
- pagination: "Load more" fallback appends with no duplicate ids and disappears at the end;
  pages reuse the first request (`since`) after `now` moves and a new `now` alone never
  re-searches; stubbed `IntersectionObserver` observes the sentinel, intersection loads
  `cursor: '10'`, observer disconnected; failed page → inline error → Retry recovers
- states: skeletons + `aria-busy`; no-results copy (no action without filters); with
  filters → Clear filters restores results; relay-down alert + detail + Retry refetches, no
  `console.error`; signed out / no-signer / no-seeders / no-balance all still return results;
  `describeSearchError` (search and load-more copy)
- cancellation: unmount mid-search → no `image`/`profile`/`stats`/`subscriptions` call, no
  console errors, container empty

## Design choices (react to the PNGs)

- YouTube search layout: pill search field, then a chip row (Filters · active-filter chips ·
  Clear), filter panel in labelled columns with uppercase headings, results as rows with a
  360 px thumbnail, 18 px regular-weight title, channel line, meta line, 2-line snippet.
- Channel card: `ChannelRow` large variant with the avatar centred in the thumbnail column
  and the name brought down to the row-title size (the L4 `lg` name is 2xl bold, channel-page
  header sized).
- Shorts shelf has a hairline above and below so it reads as an interruption of the list,
  as on YouTube; cards 200 px wide (Home uses 210 px in its wider grid).
- No-results copy says what to do next and is honest about NIP-50 coverage: "Search runs on
  relays that support it plus the channels you follow, so some videos may not be found."
- The results column is capped at 1096 px (YouTube's), the search bar at 720 px.

## L4 / tooling findings (not fixed — outside this lane's allowlist)

- **Price is invisible to screen readers on every `VideoCard`.** The thumbnail `<button>`
  carries `aria-label={video.title}`, which replaces its content as the accessible name, so
  the `SatsBadge` inside it (and its own `aria-label`) is never announced; the price appears
  nowhere else on the card. Visually the price precedes every control, but a screen-reader
  user reaches Watch without hearing it. Suggested L4 fix: include the price in the thumb's
  name (`aria-label={`${title}, from ${n} sats`}`) or point `aria-describedby` at the badge.
  Affects Home, Channel, Watch's sidebar and Search alike.
- **`scripts/screenshots.ts` hangs forever on long pages.** `VideoCard` thumbnails are
  `loading="lazy"`; headless Chromium never loads those more than ~1,250 px below the
  900 px viewport, and the script awaits every `<img>` load/error with no timeout (the
  first run here sat until `timeout` killed it). The long-list stories therefore re-page
  the mock at 6 (and 3 for the two load-more stories, so the sentinel is in view and the
  next-page request actually fires). Suggested fix: scroll the story frame to the bottom
  before the wait, or cap the wait.
- **`scripts/screenshots.ts` default Chromium path** (`/home/gateway/...`) does not exist on
  this box; captured with `NUTFLIX_CHROMIUM=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`
  (plain `chromium.launch`, throwaway profile).
- A `--filter` run prunes every PNG in the directories it wrote to that the _filtered_ run
  did not produce, i.e. re-shooting two stories deletes the other 30. Re-run the whole
  screen's filter after a partial run.
- Same `VideoCardSkeleton` 0-px text-lines quirk as Home; `Search.css` carries the same
  `.nf-card__text { flex: 1 1 auto }` workaround.
- `Button` puts its icon before the label; the filter chips reverse it in `Search.css`
  (`flex-direction: row-reverse`) so the ✕ trails the label as on YouTube.

## Assumptions / judgement calls / unsure

- **Filters are not in the route** (the v3 `Route` cannot hold them). Local state plus the
  `filters` / `onFiltersChange` bridge; request 1 makes them navigations. Until then Back
  does not restore filters — the orchestrator/shells decide whether to wire the bridge.
- **Debounced typing does not navigate**; only Enter/submit does. If the shells want the URL
  to track typing, call `navigate` with a replace-style history entry — a shell concern, as
  `navigate` has no replace flag.
- **Channel results are derived** from video authors (request 2). They can miss a channel
  that has no matching video, and show no subscriber count.
- **Rolling date windows** ("Last 24 hours") rather than YouTube's calendar "Today / This
  week"; rolling windows are what `since` expresses without a timezone.
- **Tags split on commas and spaces** (Nostr `t` tags are single words); "any of" semantics,
  as the mock implements `filters.tags`.
- **Snippet links are live** (`Markdown` renders http links with `rel="noopener
  noreferrer"`), adding tab stops per row. YouTube snippets are plain text; if the
  orchestrator prefers that, `toPlainText(parseMarkdown(...))` rendered as a text node is a
  one-line change — kept on `Markdown` because the brief says user text goes through it.
- **Channel-card Subscribe while identity is still loading** is ignored (no-op) rather than
  queued; signed out it navigates to Settings.
- `adapter` identity is assumed stable for the life of the screen (the per-hit resolution
  caches are keyed by id/pubkey, not by adapter), as on Home.
- Stories/tests override `search` through a `Proxy` (stuck/failing pages, re-paging, hostile
  descriptions); a `vi.spyOn` on such a proxy records nothing, so those tests pass a
  `vi.fn` in directly.

## Counts

- Screen tests: **36** (`npx vitest run packages/ui/src/screens/Search`).
- Whole suite (`npm test`): **62 files, 687 passed, 27 skipped**; `npm run ci` exit 0.
- PNGs: **32** (16 stories × light/dark), inspected by eye: results, many, filtered (dark),
  loading (dark), no-results-filtered, load-more stuck/failed, relay-down (dark), no-signer
  (dark), narrow.
