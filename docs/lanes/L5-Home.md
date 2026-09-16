# Lane L5-Home — the Home screen (`packages/ui/src/screens/Home/`)

**Issued against `CONTRACTS_VERSION = 3`.** Branch `lane/L5-Home`, based on main @ `ccafa90`.
No contract change requested (`docs/contract-requests/L5-Home.md` does not exist on purpose —
see "Things I was unsure about" for the one place a future method might help).

Scope: build-plan §6.1 row **Home** + §6.2, design brief `docs/design/README.md`
(YouTube first, Rumble second, clean), L4 component API (`docs/lanes/L4.md`), BRIEFS L5 row.

## What was built

```
packages/ui/src/screens/Home/
  index.ts                 export surface (below)
  Home.tsx                 the screen: tabs · grid · infinite scroll · skeletons · hover preview ·
                           empty/error states · suggested channels · shorts shelf
  Home.css                 screen-scoped `nf-home` stylesheet, L4 tokens only
  Home.stories.tsx         title 'Screens/Home', 19 stories (one per state), MockNetworkAdapter
  __tests__/home.test.ts   24 vitest tests (jsdom, components/testing/render.ts, no testing-library)
```

### Export line wanted in `packages/ui/src/screens/index.ts`

```ts
export { Home } from './Home/index.js';
```

`./Home/index.js` also exports (re-export them too if the shells want them): `HomeProps`,
`HomeTab` (types), `HOME_TABS`, `HOME_PAGE_SIZE`, `PREVIEW_SECONDS`, `describeError`,
`previewCostSats`. The orchestrator can use `export * from './Home/index.js';` if the barrel
policy allows it — nothing in there collides with another screen's names.

### CSS wiring (orchestrator)

`Home.css` is not `@import`ed by anything under `components/` (L4-owned) and the screen never
imports it (CSP `style-src 'self'`). The shells need it as a file: please add a
`src/screens/screens.css` barrel (`@import './Home/Home.css';` …) and have
`scripts/build-css.ts` flatten it into `dist/ui.css` after `components.css`. The story imports
`./Home.css` directly (Vite), which is what the PNGs were rendered with.

## Props (`HomeProps extends ScreenProps`)

| Prop | Type | Meaning |
|---|---|---|
| `adapter`, `navigate`, `miniPlayer` | from `ScreenProps` | `miniPlayer` renders in a `nf-home__mini` slot, `position: fixed` bottom-right at `--nf-z-mini-player` |
| `tab?` | `'subscriptions' \| 'trending' \| 'tags'` (= `Route['tab']` for `home`) | initial/controlled feed; a change of the prop is followed |
| `hoverPreview?` | `boolean`, default **false** | `Settings.hoverPreview` resolved by the shell (on for desktop, off for web) |
| `followedTags?` | `readonly string[]` | the viewer's followed tags → `adapter.feed({ source: 'tags', tags })`; omitted = the adapter decides |
| `now?` | `UnixSeconds \| number` | pinned in stories/tests for diffable timestamps |
| `pageSize?` | `number`, default 12 | `FeedQuery.limit` |
| `className?` | `string` | |

## Behaviour

- **Tabs**: `role=tablist/tab/tabpanel`, roving `tabIndex`, ←/→/Home/End with wrap
  (automatic activation, YouTube chip idiom via `Button` primary/secondary). Selecting a tab
  calls `navigate({ name: 'home', tab })` so the URL follows; local state switches immediately
  so a shell that does not re-render still works. Loaded tabs are cached per session — switching
  back is instant; an interrupted load is re-run when the tab is shown again.
- **Identity**: `adapter.me()` once. Subscriptions and Tags need a pubkey; Trending does not
  (it loads without waiting). A signed-out visitor with no `tab` prop lands on Trending
  (local fallback, not a navigation). Signed-out Subscriptions/Tags show the
  `signer-not-detected` preset with the screen's own title ("Sign in to see your
  subscriptions") and "Connect signer" → `navigate({ name: 'settings' })`.
- **Data**: `adapter.feed({ source, limit, cursor?, tags? })`. Per card, `adapter.image(url,
  sha256)` for the thumbnail (T16 — the card shows its blur-up placeholder until the verified
  URL arrives; a rejected hash simply leaves the placeholder), `adapter.profile(author)` once
  per pubkey then `adapter.image(picture)` for the avatar, `adapter.stats(id)` for "N paid
  views". All guarded by an `alive` ref; effects cancel with `AbortController` on unmount or
  tab switch, and the subscriptions follow-up (`adapter.subscriptions()`) never runs after a
  cancel — tested.
- **Price before play**: every card carries L4's `SatsBadge` price. The only play-shaped
  thing this screen adds is the hover-preview affordance, rendered AFTER the card in DOM
  order; the test asserts `price.compareDocumentPosition(preview)` is FOLLOWING for every card.
  Playback (and payment) only starts on Watch. Kind 22 cards go to `shorts`.
- **Hover preview**: when `hoverPreview` is on, hovering (pointer) or focusing (keyboard) a
  card renders `.nf-home__preview` on the thumbnail's top-left: play glyph, "Preview", and a
  `SatsBadge` with `previewCostSats(video)` = whole blocks of ~3 s at the cheapest rendition
  (`bitrateKbps × 125 × 3 / blockSize`, min 1 block, × `satsPerBlock`). `pointer-events: none`
  and `aria-hidden` — it is a hint, not a control, and **no blob bytes are fetched**. When the
  setting is off nothing is rendered (tested).
- **Infinite scroll**: a 1 px sentinel observed with `IntersectionObserver` (`rootMargin
  600px`) while `Page.next` exists; while the next page loads, 4 `VideoCardSkeleton`s are
  appended; a failed page shows a compact `ErrorState` "Could not load more" with Retry and
  keeps the loaded cards. Where `IntersectionObserver` is missing (jsdom, very old
  runtimes) a "Load more" `Button` appears instead. Items are de-duplicated by id across
  pages. The sentinel is re-observed after each page (it re-mounts) — a bug the tests caught.
- **Shorts shelf**: kind 22 items in a feed page are pulled out of the grid into a horizontal
  "Shorts" `<section>` under it (9:16 cards, `flex: 0 0 210px`) — mixing aspect ratios in the
  grid broke the row rhythm (seen in the first PNG). Opening one navigates
  `{ name: 'shorts', videoId }`; kind 21 → `{ name: 'watch', videoId }`; channel name/avatar
  → `{ name: 'channel', pubkey }`.
- **Suggested channels** ("no subscriptions yet → suggested channels"): when the
  subscriptions page is empty AND `adapter.subscriptions()` is empty, the
  `no-subscriptions` preset renders with "Explore trending" plus a "Suggested channels"
  section: up to 5 distinct authors from `feed({ source: 'trending', limit: 24 })` (never the
  viewer), profiles via `adapter.profile`, shown as `ChannelRow`s. Subscribe →
  `adapter.subscribe(pk)` → the subscriptions feed reloads (and the suggestions with it, if
  still needed). If the viewer follows someone who has not published, the copy is "Nothing
  new from your subscriptions" instead, with no suggestions.

## States (Storybook `Screens/Home`, 19 stories × 2 themes = **38 PNGs** in `artifacts/screens/home/`)

| Story | How it is produced | What you see |
|---|---|---|
| Loading (skeletons) | `latencyMs: 5000` | 12 `VideoCardSkeleton`s, panel `aria-busy` |
| Subscriptions (populated) | default mock | grid of the 2 followed channels' kind-21 videos |
| Trending (populated, sats/hour) | default mock | 9 cards ranked by the mock's sats/hour score, "Ranked by sats paid per hour" hint |
| Tags you follow (populated) | `followedTags: ['ceramics','space','music']` | grid + Shorts shelf |
| Hover preview off (web default) | `hoverPreview={false}` | identical to Trending; the affordance never renders (test covers it) |
| Loading more (infinite scroll) | `pageSize: 4`, second page never resolves | 4 cards + 4 skeletons (the IO fired in headless Chromium) |
| Empty — no subscriptions yet | mock with every channel unsubscribed | `no-subscriptions` preset + 5 suggested `ChannelRow`s |
| Empty — subscriptions have no videos | follows a pubkey that never published | "Nothing new from your subscriptions" + Explore trending |
| Empty — no videos for your tags | `followedTags: ['woodworking','sailing']` | "No videos for your tags" naming `#woodworking, #sailing` |
| Empty — no tags followed | `followedTags: []` | "You are not following any tags yet…" |
| Empty — nothing trending | `feed` proxied to `{ items: [] }` | "Nothing trending yet" |
| Error — relay down | `failWith: 'relay-down'` | `ErrorState` "Relay down", detail `relay-down: no relays reachable`, Retry |
| Error — could not load more | second page rejects | 4 cards + compact inline error with Retry |
| Error — no signer | `failWith: 'no-signer'`, tab subscriptions | signed-out empty state ("Sign in to see your subscriptions") |
| Error — no seeders | `failWith: 'no-seeders'` | feed unaffected (seeders matter on Watch, not Home) |
| Error — no balance | `failWith: 'no-balance'` | feed unaffected (balance matters at play time) |
| Signed out (lands on Trending) | `signedIn: false`, no `tab` | Trending selected automatically |
| Signed out — tags tab | `signedIn: false`, `tab: 'tags'` | "Sign in to see videos for your tags" |
| With mini-player slot | a placeholder node as `miniPlayer` | floats bottom-right over the grid |

Stories use `MockNetworkAdapter` wrapped so `image()` answers with the `.storybook/fixtures`
inline SVGs (the fixture URLs point at `fixture.example`); everything else is the stock mock.

## Tests (`__tests__/home.test.ts`, 24 tests, all green; `npm run ci` = 61 files / 651 passed / 27 skipped)

- structure: landmark + `h1`, three tabs with one selected, skeletons + `aria-busy` while loading
- signed-out: auto-Trending without a navigation; subscriptions tab → sign-in copy → settings route
- populated: card count = mock page, `adapter.image(url, sha256)` called and its result is the
  `<img src>`, channel name resolved, paid views shown
- **price before play**: for every card the `.nf-sats--price` badge precedes the hover
  affordance in DOM order; affordance is `aria-hidden` and labels the preview cost;
  disappears on pointer-out; never renders when `hoverPreview` is off; appears on keyboard focus
- navigation: thumb/title → `watch`, channel → `channel`, shorts shelf → `shorts`
- tags: `feed` called with `{ source: 'tags', limit, tags }`; shorts shelved separately
- tabs: roving tabindex, ←/→/Home/End with wrap, `navigate({ name: 'home', tab })`, panel
  labelled by the active tab, a changed `tab` prop is followed
- infinite scroll: "Load more" fallback without `IntersectionObserver` appends page 2 with no
  duplicate ids; with a stubbed observer the sentinel is observed, intersection loads
  `cursor: '4'`, observer disconnected; a failed page → inline error, Retry recovers
- empty: no-subscriptions preset + 3–5 suggestions, Explore trending switches tab, Subscribe
  calls `adapter.subscribe` and the reloaded feed shows only that channel; "Nothing new";
  tags copy names the tags; no-tags copy; nothing trending
- errors: relay-down → `role=alert` with copy + detail, Retry refetches, nothing thrown, no
  `console.error`; relay-down on `me()`; no-signer/no-seeders/no-balance behave as documented;
  `describeError` mapping
- cancellation: unmount while `feed` is pending → the follow-up `subscriptions()` and every
  `image()` are never called (no setState after unmount), container empty, no console errors;
  switching tabs mid-load abandons the request and re-fetches on return
- `previewCostSats`: whole blocks, at least one, undefined without renditions

## Design choices (react to the PNGs)

- Chip bar (`Button` primary = selected, secondary = others), sticky at the top of the screen,
  16 px column gap / 40 px row gap grid, cards ≥ 280 px (4 across at 1248 px) — YouTube.
- The `h1` "Home" is visually hidden (`.nf-home__sr`) so the landmark has a name without a
  title YouTube does not show.
- Tab labels: "Subscriptions", "Trending", "Your tags". A one-line muted hint "Ranked by
  sats paid per hour" appears only on Trending — the one Nutflix-specific fact worth a line.
- Empty-state copy (all sentence case, says what to do next): "Nothing new from your
  subscriptions", "No videos for your tags" (names the tags), "Nothing trending yet",
  "Sign in to see your subscriptions / videos for your tags", "Relay down", "Could not load more".
- `pageSize` 12 (3 rows of 4). The mock defaults to 8; the screen always passes `limit`.

## Assumptions / things I was unsure about

- **Where "tags you follow" come from.** `NetworkAdapter` has no method for the viewer's
  interest list (NIP-51 kind 10015/30015), so the screen takes `followedTags?` from the shell
  and forwards it as `FeedQuery.tags`. With it omitted the query is `{ source: 'tags' }` and
  the adapter is expected to apply the viewer's own list (the mock returns nothing, which is
  the "no tags followed" state). If the orchestrator would rather the adapter own this, a
  `followedTags(): Promise<readonly string[]>` method would replace the prop — not requested,
  because the prop works within v3.
- **`hoverPreview` defaults to `false`** at the screen level; the shell passes
  `Settings.hoverPreview` (the mock's default is `true`). The brief's "default on for
  desktop, off for web" is the shell's decision, per the task text.
- **Suggested channels are derived from Trending authors** (no "suggested channels"
  adapter method exists). Good enough for the empty state; a dedicated source can swap in
  behind the same UI.
- **Tab click navigates.** `navigate({ name: 'home', tab })` on every tab change so deep
  links work; a shell that remounts `Home` on navigation will refetch (state is local). If
  the shells would rather own the tab entirely, drop the `navigate` call in `selectTab`.
- **`adapter.stats(id)` per card** for "paid views" — 12 calls per page. Fine for the mock;
  if the real adapter finds this heavy, the card renders without `stats` (meta line shows
  only the timestamp) and the effect is one `if` away from being disabled.
- **Mini-player slot is `position: fixed`** bottom-right. L4 said the shell decides where it
  floats; the shell can override `.nf-home__mini` or wrap its node in its own container.
- **L4 bug found, worked around in `Home.css`, NOT fixed in L4 (locked for this lane):**
  `VideoCardSkeleton`'s three text lines render at 0 px width because `.nf-card__text` is a
  flex item with no `flex-grow` and the lines are percentage widths of an empty column
  (visible in `Components/VideoCard/Skeleton` — only a thumbnail and a circle). Home.css adds
  `.nf-home__item .nf-card__text { flex: 1 1 auto; }`. Suggested L4 fix: the same rule on
  `.nf-card__text` in `VideoCard.css`.
- Stories/tests wrap the mock in a `Proxy` to override `feed` (empty trending, stuck or
  failing second page) — the mock has no option for those; the Proxy binds methods so the
  mock's private state keeps working.
- `adapter` identity is assumed stable for the life of the screen (the fetch cache is keyed
  per tab, not per adapter). Shells create one adapter, so this should hold.

## Deviations from the task text

- Kind 22 (shorts) in a feed page render in a separate "Shorts" shelf rather than inside the
  grid — the mixed-aspect grid looked wrong (documented above; it is what YouTube does).
- One extra story ("With mini-player slot") beyond the listed states, to show the slot's
  placement. "Hover preview on" cannot be screenshotted (the script does not hover); the
  affordance is covered by tests instead.
