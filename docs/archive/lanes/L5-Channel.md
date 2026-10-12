# Lane L5-Channel — the Channel screen (`packages/ui/src/screens/Channel/`)

**Issued against `CONTRACTS_VERSION = 3`.** Branch `lane/L5-Channel`, based on main @ `e259115`.
One contract **note** (not a blocker): `docs/contract-requests/L5-Channel.md` (there is no
author-scoped kind-10019 seeder lookup; worked around with a screen prop).

Scope: build-plan §6.1 row **Channel** (banner, avatar, NIP-05 verification badge, tabs Videos /
Shorts / Playlists / About, "Seeding N videos" if the channel runs a seeder; kind 0, 21/22,
30005, 10019) + §6.2 where it applies, design brief `docs/design/README.md` (YouTube first,
Rumble second), L4 component API (`docs/lanes/L4.md`), BRIEFS L5 row. Worked example:
`docs/lanes/L5-Home.md`.

## What was built

```
packages/ui/src/screens/Channel/
  index.ts                     export surface (below)
  Channel.tsx                  the screen: header (banner · avatar · title · NIP-05 · teaser ·
                               seeding · Subscribe) · tablist · Videos/Shorts grids with paging ·
                               Playlists grid · About · empty/error/not-found states
  Channel.css                  screen-scoped `nf-channelpage` stylesheet, L4 tokens only
  Channel.stories.tsx          title 'Screens/Channel', 23 stories (one per state), MockNetworkAdapter
  __tests__/channel.test.ts    46 vitest tests (jsdom, components/testing/render.ts, no testing-library)
```

### Export line wanted in `packages/ui/src/screens/index.ts`

```ts
export { Channel } from './Channel/index.js';
export type { ChannelProps, ChannelTab } from './Channel/index.js';
```

`./Channel/index.js` also exports `CHANNEL_TABS`, `CHANNEL_PAGE_SIZE`, `describeChannelError`,
`describeNip05`, `nip05State`, `seedingLabel` and the type `Nip05State`. The helper is named
`describeChannelError` (not `describeError`), so `export * from './Channel/index.js'` does not
collide with Home's `describeError` if the barrel policy ever allows `export *`.

### CSS wiring (orchestrator)

Add to `packages/ui/src/screens/screens.css`, after the Home line:

```css
@import './Channel/Channel.css';
```

The screen never imports its CSS (CSP `style-src 'self'`); only the story does, which is what the
PNGs were rendered with.

## Props (`ChannelProps extends ScreenProps`)

| Prop | Type | Meaning |
|---|---|---|
| `adapter`, `navigate`, `miniPlayer` | from `ScreenProps` | `miniPlayer` renders in a `nf-channelpage__mini` slot, `position: fixed` bottom-right (same as Home) |
| `pubkey` | `NostrPubkey` (**required**, = `Route['pubkey']` for `channel`) | the channel; a changed prop refetches everything |
| `tab?` | `'videos' \| 'shorts' \| 'playlists' \| 'about'` (= `Route['tab']`) | initial/controlled tab, default `videos`; a changed prop is followed |
| `seedingVideos?` | `number` | "Seeding N videos" when the **shell** knows the channel runs a seeder (its kind-10019 announcement). See "Seeding" below |
| `now?` | `UnixSeconds \| number` | pinned in stories/tests for diffable timestamps |
| `pageSize?` | `number`, default 24 | author-feed `FeedQuery.limit` |
| `className?` | `string` | |

## Behaviour

- **Data**: `adapter.profile(pubkey)` (kind 0), `adapter.feed({ source: 'author', author,
  limit })` once (kind 21 and 22 arrive together and are split client-side per tab), per card
  `adapter.image(url, sha256)` + `adapter.stats(id)` (paid views), and `adapter.me()` then
  `adapter.subscriptions()` for the Subscribe state. Playlists (`adapter.library.playlists(pubkey)`,
  NIP-51 kind 30005) are fetched lazily the first time the tab opens; each playlist's first video
  is resolved with `adapter.video(id)` (for its price and thumbnail). Everything is guarded:
  effects cancel with `AbortController` on unmount or pubkey change, and late image/stat/page
  resolutions check an `alive` ref (tested: nothing is called or set after unmount).
- **Images (T16)**: banner, avatar, card thumbnails and playlist thumbnails all go through
  `adapter.image` with a `Skeleton` while pending: banner block, 80 px avatar circle, the
  card's blur-up placeholder, a playlist block. Kind-0 `banner`/`picture` carry no `x` hash, so
  they are resolved as `image(url)`; NIP-71 thumbnails as `image(url, sha256)`. A rejected image
  never reaches an `<img>`: the avatar falls back to initials, the banner to a plain block, and
  cards keep their placeholder. A profile with **no** banner renders no banner block at all
  (as YouTube does).
- **NIP-05, four looks** (`data-nip05` on the header):
  - `verified`: check mark (`Icon verified`, "NIP-05 verified") by the name, and the identifier
    in secondary text.
  - `unverified` (identifier claimed, not confirmed): no check; the identifier is muted, with an
    outlined **"Unverified"** flag (info icon).
  - `failed` (lookup ran, the domain does not list this key): no check; the identifier is
    **struck through** (`<s>`), with a warning-tinted **"Verification failed"** flag.
  - `none`: no identifier and no flag; the short pubkey in mono (`8…4`, never the whole key).
  About → Details repeats it in words ("… — verified / not verified / verification failed / Not set").
- **Header**: `h1` channel name, "identifier · N videos" line ("24+ videos" while more pages
  exist), a one-line description teaser (the first paragraph only, rendered by
  `MarkdownTreeView`, so user text still goes through the Markdown subset) with **more** → About
  tab, "Seeding N videos" (success colour, `seed` icon), and the action: Subscribe / Subscribed
  (`aria-pressed`). Signed out or no signer: the button reads Subscribe and routes to
  `{ name: 'settings' }`. On your own channel it is **Manage videos** → `{ name: 'studio',
  tab: 'videos' }`. A failed (un)subscribe leaves the previous state; nothing is thrown.
- **Tabs**: `role=tablist/tab/tabpanel`, roving `tabIndex`, ←/→/Home/End with wrap
  (automatic activation), `aria-controls`/`aria-labelledby`, Home's chip idiom (`Button`
  primary/secondary), sticky bar. Selecting a tab calls `navigate({ name: 'channel', pubkey,
  tab })`; local state switches immediately. The panel carries `aria-busy` while its data loads.
- **Videos / Shorts**: the L4 `VideoCard` with `hideChannel` (we are on the channel); the price
  is L4's `SatsBadge` on the thumbnail. Kind 21 → `{ name: 'watch', videoId }`; kind 22 (9:16 cards
  in a narrower grid) → `{ name: 'shorts', videoId }`. **Paging**: when the author feed has a
  `next` cursor, a **Show more** button fetches the next page (`cursor`), appending de-duplicated
  items with 4 skeletons while it loads. A failed page shows a compact `ErrorState` "Could not
  load more" with Retry and keeps the loaded cards. If the loaded page holds nothing of this tab's
  kind but more pages exist, the empty state says so ("No shorts in the latest uploads") and
  offers **Load older uploads**.
- **Playlists**: a YouTube-style grid of stacked-thumbnail cards: first video's thumbnail, its
  price (`SatsBadge`, "from N sats") bottom-left, "N videos" bottom-right, title, "Private" tag
  for encrypted sets, and a 2-line `Markdown` description. The thumbnail becomes a **"Play all"**
  button (→ Watch on the first video) **only once the first video is resolved**. The price badge
  precedes the play glyph in DOM order, and the button's accessible name includes the price
  ("Play all: <title>. First video from 1,240 sats"). An empty set, or one whose first video no
  longer resolves ("The first video in this playlist is no longer available."), has no button,
  no price and nothing play-shaped.
- **About**: Description via `Markdown` (hostile input stays text, tested), Details: NIP-05,
  public key (short), Lightning address (`lud16`, when set), Seeder (when known), Availability
  (below).
- **Missing kind 0**: a pubkey with videos but no profile is still a channel. It renders under its
  short pubkey, "No profile published", initials avatar, no banner. **Channel not found** needs
  no profile **and** no videos. A profile failure, or no profile plus a failed feed, is a
  page-level `ErrorState` with Retry (refetches profile, feed and identity).

### "Seeding N videos": what the adapter actually exposes (judgement call, please confirm)

- There is **no author-scoped kind-10019 lookup** in v3. `VideoStats.seedersOnline` counts
  **any** seeder announcing a video's core, so it cannot say that the **channel** runs one. In
  the mock every video reports ≥ 1, which would badge every channel, including fixture channels
  whose ground truth is `seeds: false` (Kilnfire, matrixops, Green Room). The previous draft of
  this lane did exactly that; I removed it as a false trust signal.
- So the header indicator comes from: **(a)** your own channel → `adapter.seeder.status()` +
  `onStatus` (live; `enabled && status.pubkey === pubkey` → `status.videos`; disabled → no
  indicator, and About says "Seeding is off on this device"). Other channels are never asked
  (tested). Or **(b)** the `seedingVideos` prop from the shell. Stories derive it from
  `FixtureChannel.seeds`, as a shell with a 10019 lookup would.
- `seedersOnline` is still used, honestly, as **Availability** on About: "Seeders online for N of
  M videos" / "No seeders online for these videos right now" (the `no-seeders` state).
- One-line alternative if the orchestrator prefers the looser reading: set `seedingCount` to
  "videos with `seedersOnline > 0`" when neither (a) nor (b) applies. Contract note with a
  proposed `seederAnnouncement(pubkey)` method: `docs/contract-requests/L5-Channel.md`.

## States (Storybook `Screens/Channel`, 23 stories × 2 themes = **46 PNGs** in `artifacts/screens/channel/`)

| Story | How | What you see |
|---|---|---|
| Loading (skeletons) | `latencyMs: 5000` | banner block, avatar circle, title lines, 8 card skeletons (no avatar circle, matching `hideChannel` cards) |
| Loading — images still verifying (T16) | `image()` never resolves | real header text, banner + avatar Skeletons, cards on their placeholders |
| Videos (populated, seeding, NIP-05 verified) | default mock (Orbital) | check mark, "orbital@fixture.example · 3 videos", teaser, "Seeding 3 videos", Subscribed, 2 priced cards |
| Shorts (populated) | `tab: 'shorts'` | 9:16 priced short |
| Playlists (price before Play all) | 4 sets | priced "start here" set, 1-video set, private empty draft, set with a deleted first video |
| About (populated) | rich Markdown about + `lud16` | description with bold, link, `nostr:` chip; Details incl. Seeder + Availability |
| NIP-05 unverified (not seeding) | Kilnfire, `nip05Status: 'unverified'` | muted identifier + "Unverified" flag; no seeding line |
| NIP-05 verification failed | Kilnfire, `failed` | struck-through identifier + warning "Verification failed" flag |
| NIP-05 absent (pubkey shown) | Low Tide (no nip05) | mono short pubkey, no flag |
| Your channel (local seeder, nothing published) | `pubkey: ME` | "Seeding 3 videos" from `seeder.status()`, **Manage videos**, "You have not published any videos" + **Upload a video** |
| More pages (Show more) | `pageSize: 2` | "2+ videos", 1 card, **Show more** |
| No kind-0 profile (videos only) | `profile()` → null | short-pubkey title, "No profile published", no banner, videos |
| Empty channel (nothing published) | author feed + playlists empty | `no-videos` preset |
| Empty — no shorts | Low Tide, shorts tab | "No shorts yet" |
| Empty — no playlists | Orbital, playlists tab (mock has none for it) | "No playlists yet" |
| Empty — no description | Kilnfire without `about`, About tab | compact "No description yet"; no teaser |
| Channel not found | unknown pubkey | `ErrorState` "Channel not found" + short pubkey + Retry |
| Error — relay down | `failWith: 'relay-down'` | `ErrorState` "Relay down", detail `relay-down: no relays reachable`, Retry |
| Error — no seeders online (About availability) | `failWith: 'no-seeders'`, About | "No seeders online for these videos right now" |
| Error — no signer (Subscribe → settings) | `failWith: 'no-signer'` | page renders; Subscribe routes to Settings |
| Error — no balance (channel unaffected) | `failWith: 'no-balance'` | identical to populated (balance matters on Watch, not here) |
| Signed out (Subscribe → settings) | `signedIn: false` | page renders; Subscribe routes to Settings |
| With mini-player slot | placeholder node | floats bottom-right |

Stories wrap the mock so `image()` answers with `.storybook/fixtures` inline SVGs (plus a
story-local wide banner SVG); overrides use a `Proxy` that binds methods to the mock so its private
state keeps working.

## Tests (`__tests__/channel.test.ts`, 46 tests, all green; `npm run ci` exit 0 = 62 files / 697 passed / 27 skipped)

- structure/loading: landmark + `h1`, 4 tabs one selected, banner/avatar/action/card skeletons,
  `aria-busy`; one author-feed call split into Videos/Shorts, cached across tab switches
- header: title, identifier + upload count; `image(url)` for kind-0 images and only the
  resolved URL in `<img>`; **Skeletons stay until `image()` resolves** (controlled promises), then
  swap; a **rejected image** → initials + plain banner, no `<img>`; no banner → no block; teaser
  renders the first paragraph via Markdown (`rel="noopener noreferrer"`), "more" → About
- NIP-05: verified / unverified / failed / absent each asserted by structure (check mark, flag
  text, `<s>`, mono pubkey, `data-nip05`); `nip05State`/`describeNip05` for every status
- seeding: **not** inferred from swarm counts (Orbital with all videos seeded shows nothing
  without a source); the prop shows it (and About "Runs a seeder"); 0 hides it; own channel reads
  `seeder.status()` and follows `onStatus` live (disabling hides it, About says off); other
  channels never call `seeder.*`; About availability for normal and `no-seeders`
- cards: `image(url, sha256)`, verified `src`, paid views, no channel row, a price badge on every
  card, thumb/title → `watch`, shorts are 9:16 with a price → `shorts`
- paging: Show more sends `cursor: '2'`, appends without duplicates, disappears at the end,
  `aria-busy` while loading; failed page → inline "Could not load more" + Retry recovers;
  "Load older uploads" on a kind-empty first page
- subscribe: Subscribed → unsubscribe; Subscribe → subscribe; failure reverts with no alert and
  no `console.error`; signed-out/no-signer → Settings; no-balance changes nothing; own channel →
  Manage videos (studio/videos) + Upload a video (studio/upload)
- tabs: roving tabindex, ←/→/Home/End with wrap, `navigate({ name: 'channel', pubkey, tab })`,
  `aria-controls`/`aria-labelledby`; changed `tab` prop followed; changed `pubkey` refetches
- playlists: lazy (not queried before the tab opens); empty + own-channel Library prompt
  (library/playlists); **price precedes "Play all" in DOM order**, `aria-hidden` glyph, price in
  the accessible name, thumb + title → watch on the first video; empty set / missing first video /
  first video still resolving → no button and no play glyph; fetch failure → `ErrorState` + Retry
- about: Markdown description, details never contain the whole pubkey; hostile input (`<img
  onerror>`, `javascript:` link) stays text; empty description state
- errors: relay-down → `role=alert`, copy + detail, Retry refetches, no `console.error`; feed
  failure keeps the header; not found → no tabs, Retry; no kind 0 + videos → renders;
  `describeChannelError`
- cancellation: unmount mid-load → `subscriptions()`, `stats()`, `image()` never called, no errors;
  unmounting your own channel releases the `seeder.onStatus` subscription

## Design choices (react to the PNGs)

- YouTube's channel page: rounded 6:1 banner, 80 px avatar (L4's largest size), bold `2xl` name
  with a grey check, "handle · N videos" line, one-line description teaser with "more", Subscribe
  on the right (Rumble/older-YouTube placement; YouTube 2024 puts it under the text, which is a
  one-rule CSS change if preferred), chip tabs, the same 280 px card grid as Home.
- Playlists as a grid of stacked cards (YouTube's Playlists tab), not rows. The first draft used
  rows with an unpriced play glyph, which broke the price-before-play rule.
- "Unverified" is neutral (outlined); "Verification failed" is warning-tinted with the claim
  struck through, because a failed NIP-05 is a possible impersonation, not just missing polish.
- Copy (sentence case, says what to do next): "No shorts yet", "No playlists yet", "No
  description yet", "You have not published any videos" + Upload, "No shorts in the latest
  uploads" + Load older uploads, "Could not load more", "Channel not found", "Relay down", "No
  profile published", "Seeders online for N of M videos".

## Assumptions / things I was unsure about

- **Seeding source** (above): the main judgement call. The header claims "this channel seeds"
  only from an authoritative source.
- **Own channel** = `adapter.me() === pubkey`. Subscribe is replaced by Manage videos, and the
  empty states offer Upload / Open Library. The Studio and Library routes exist in `Route`; their
  screens are other lanes.
- **Playlist price = its first video's price** (what starting "Play all" costs). Later videos'
  prices are shown by Watch before autoplay-next (§6.2). A playlist total was not attempted.
- **No playlist route exists**, so the title and "Play all" both open Watch on the first video.
  A `{ name: 'playlist', id }` route (or a `list` param on `watch`) would let Watch autoplay the
  set. That is the orchestrator's `Route`, not requested here.
- **Paging is a button, not infinite scroll.** Channel pages are shorter than Home's feeds and
  the tab split makes an auto-loading sentinel awkward (a page may hold no items for the open
  tab). Home's IntersectionObserver pattern can replace it.
- **Missing kind 0 ≠ not found**: plenty of Nostr keys publish videos without a profile.
- **`adapter.stats(id)` per card** for paid views and availability, as Home does.
- `adapter` identity is assumed stable for the life of the screen (the image/stats caches are
  per mount).
- **L4 notes (not fixed, locked):** the `.nf-card__text` skeleton-width workaround from L5-Home is
  repeated in `Channel.css`. `VideoCardSkeleton` has no `hideChannel` twin, so `Channel.css`
  hides the skeleton's avatar circle inside channel grids (otherwise the grid jumps when cards
  arrive). A `hideChannel` prop on the skeleton would remove both workarounds.
- **Screenshots**: the script's default Chromium path (`/home/gateway/Applications/…`) does not
  exist on this box. PNGs were taken with
  `NUTFLIX_CHROMIUM=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` (plain
  `chromium.launch`, throwaway profile).

## Deviations from the task text

- The header "Seeding N videos" is **not** shown for other channels unless the shell passes
  `seedingVideos` (see above). The swarm signal moved to About → Availability.
- Extra states beyond the listed ones: images-pending, the three NIP-05 variants, own channel,
  more pages, no kind 0.
