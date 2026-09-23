# Lane L5-Studio — the Studio screen (`packages/ui/src/screens/Studio/`)

**Issued against `CONTRACTS_VERSION = 3`.** Branch `lane/L5-Studio`, based on main @ `684faa4`.
Contract requests for v4 (none blocking): `docs/contract-requests/L5-Studio.md`.

Scope: build-plan §6.1 row **Studio** (Upload / Analytics / Seeder status) + §6.4 (upload
pipeline), ADR 0005 (split rounding, no bundled ffmpeg, web uploads stored as-is), design
brief `docs/design/README.md` (YouTube Studio first), L4 component API (`docs/lanes/L4.md`),
BRIEFS L5 row. Worked examples: `docs/lanes/L5-Home.md`, `docs/lanes/L5-Channel.md`.

## What was built

```
packages/ui/src/screens/Studio/
  index.ts               export surface (below)
  Studio.tsx             the screen: identity gate · chip tabs · upload form + run state (kept
                         across tab switches) · shared myVideos state · panel routing
  UploadPanel.tsx        drop zone / picker → details form (live Markdown preview) → per-stage
                         progress → Published / failed / ffmpeg-not-found
  VideosPanel.tsx        myVideos content table with paging
  AnalyticsPanel.tsx     per-video analytics: tiles + sats-by-rendition bar list
  SeederPanel.tsx        seeder status + live onStatus, on/off, storage, earnings, melt-out
                         (quote → confirm Sheet → result), peers, banned peers + Unban
  parts.tsx              StudioImage (adapter.image + Skeleton), FfmpegMissing, WebUploadNotice
  model.ts               pure: progress reducer + step statuses, draft validation →
                         UploadInput, split/price arithmetic for display, error classification
  Studio.css             screen-scoped `nf-studio` stylesheet, L4 tokens only
  Studio.stories.tsx     title 'Screens/Studio', 25 stories (one per state), MockNetworkAdapter
  __tests__/studio.test.ts        41 tests (jsdom, components/testing/render.ts)
  __tests__/studio-model.test.ts  13 tests (pure model)
```

### Export lines wanted in `packages/ui/src/screens/index.ts`

```ts
export { Studio } from './Studio/index.js';
export type { StudioProps, StudioTab } from './Studio/index.js';
```

`./Studio/index.js` also exports `STUDIO_TABS`, `TYPICAL_RENDITIONS`, `classifyStudioError`,
`describeStudioError` (NOT `describeError` — Home owns that name), `reduceUploadProgress`,
`satsPerMinute`, `splitPayment`, `toUploadInput`, `validateDraft` and the types
`FfmpegStatus`, `HostOs`, `ResolveUploadFile`, `StudioDraft`, `StudioErrorKind`, `StudioFile`,
`StudioFileSource`, `UploadProgressView`. The shells need at least `FfmpegStatus`,
`ResolveUploadFile` and `StudioFile` to fill the props; nothing collides with Home or Channel,
so `export * from './Studio/index.js'` is also safe.

### CSS wiring

Add to `packages/ui/src/screens/screens.css`, after the Channel line:

```css
@import './Studio/Studio.css';
```

The screen never imports its CSS (CSP `style-src 'self'`); only the story does.

## Props (`StudioProps extends ScreenProps`)

| Prop | Type | Meaning |
|---|---|---|
| `adapter`, `navigate`, `miniPlayer` | `ScreenProps` | `miniPlayer` floats bottom-right like Home/Channel |
| `tab?` | `'upload' \| 'videos' \| 'analytics' \| 'seeder'` (= `Route['tab']`) | initial/controlled tab, default **upload**; a changed prop is followed |
| `ffmpeg?` | `{ found: boolean; path?; version?; os?: 'macos'\|'windows'\|'linux' }` | the shell's system-ffmpeg probe (ADR 0005, L6). `found: false` shows the ffmpeg state **instead of the drop zone, before anything is filled in**; `found: true` adds "Transcoding with ffmpeg 8.1.2 at /usr/bin/ffmpeg" under the drop zone; `os` puts that system's install steps first. Omitted = learned only from a failed upload |
| `onRecheckFfmpeg?` | `() => void` | "Check again" on the pre-probe state (the shell re-probes and passes a new `ffmpeg`) |
| `resolveFile?` | `(file: File) => string \| FileLike \| Promise<…>` | **how the shell hands the screen a file** — see below |
| `pendingFile?` | `{ source: string \| FileLike; name; size?; type? }` | a file the shell already resolved (dropped on the window, "Open with…"); opens the form directly |
| `mirrorServers?` | `readonly string[]` | pre-fills "Mirrors" (e.g. the user's gateway Blossom URL) |
| `now?` | `UnixSeconds \| number` | pinned in stories/tests |
| `inlineSheet?` | `boolean` | melt-out confirm Sheet in flow instead of fixed (embedding) |
| `className?` | `string` | |

### How the shell must hand the screen a file

`UploadInput.file` is `string | FileLike`. The screen **never assumes a DOM `File` has a
path**: it takes the `File` from the picker or a drop and passes it through `resolveFile`.

- **Desktop (L6) MUST pass `resolveFile`.** Under `sandbox: true` + `contextIsolation` a `File`
  has no `.path` (removed in Electron 32); the preload should expose
  `webUtils.getPathForFile(file)` and the shell passes `resolveFile={(f) => api.pathForFile(f)}`
  returning the absolute path. Without it the `File` reaches `runStudioUpload`, which rejects
  with `MediaError('unsupported-input')` — the screen shows "Could not open that file". A
  resolver that throws or returns `''` leaves the drop zone with "The app could not open that
  file".
- **Web (L7) omits it**: the DOM `File` is structurally a `FileLike` and is uploaded as-is.
- The display name/size always come from the `File`, never from parsing the path.
- A custom thumbnail is passed as the image `File` (a `BlobLike`); the desktop adapter reads it
  with `arrayBuffer()` in the renderer before crossing IPC.
- Thumbnail candidates (`thumbnails` stage) are rendered through `adapter.image(candidate)` —
  on desktop they are **local work-dir paths**, so the desktop adapter's `image()` must be
  able to serve them (contract request 2 asks for `{ url, sha256 }`).

## Behaviour

- **Identity**: `adapter.me()` once. Signed out / no signer → the `signer-not-detected` preset,
  "Sign in to use Studio", Connect signer → `{ name: 'settings' }`; no tabs, nothing else is
  called. `me()` failing → `ErrorState` "Relay down" + Retry.
- **Tabs**: Home's chip idiom (`Button` primary/secondary), `role=tablist/tab/tabpanel`, roving
  `tabIndex`, ←/→/Home/End with wrap; every change calls `navigate({ name: 'studio', tab })`.
  While an upload runs and another tab is showing, a ghost chip ("Transcoding 720p · 62%",
  "Published", "Upload failed") returns to Upload.
- **Upload — form**: drop zone (dashed, 360 px, "Select file" button driving a hidden file
  input; `.mkv`/`.ts` with an empty MIME are accepted by extension; non-video files get copy).
  Then a two-column form, YouTube-Studio style:
  - Details: title (required, default = file name without extension, 100-char counter),
    description (5,000 chars; **rendered live through `Markdown` in the preview card on the
    right** — hostile HTML stays text, tested), tags (comma separated → lower-case, `#`
    stripped, spaces → `-`, de-duplicated, max 10), format radio Video (kind 21) / Short (kind 22).
  - Price: mint chips (`MintChip` toggles; `Settings.defaultMints` pre-selected, wallet mints
    offered, "Add mint" accepts `https://` only, normalised); price per block (whole sats,
    1–1,000) with a `SatsBadge`; **"Typical cost to watch"** (below); split as two linked
    percentage inputs (typing one sets the other to 100 − n) with ADR 0005's rule in words
    ("their share is rounded up and you get the rest") and a worked table for 1 and 10 blocks;
    a warning at 0 % for seeders.
  - Thumbnail: "A frame from the video" (candidate 0) or "Your own image" (JPEG/PNG/WebP → 
    `thumbnailChoice: BlobLike`).
  - Mirrors (collapsed): one https URL per line → `mirrorTo`.
  - Publish (`accent`) validates on submit: fields get `aria-invalid` + `aria-describedby`
    errors, the first invalid control is focused, "Fix N things before publishing" is an alert.
- **Upload — progress**: an ordered step list (Checking the file → Transcoding → Thumbnails →
  Writing to your seeder → Publishing → Mirroring, the last only when `mirrorTo` is set), each
  pending / active / done / failed, with per-rendition `<progress>` bars for transcoding and
  writing (labels arrive with the events; the count is not known in advance), the candidate
  frames with the used one marked, per-server mirror results, a polite live region naming the
  current step, and a summary card (title, price, split, mints, tags). `reduceUploadProgress`
  is pure and tested. **Not cancellable** — v3 has no signal; the screen says so (contract
  request 1).
- **Upload — done**: "Published" card: thumbnail (via `adapter.image`), and per rendition the
  real cost to watch (≈ sats/min from the rendition's bitrate, total for the whole video via
  L4's `renditionPriceSats`) **before** "View video"/"View in Shorts"; "Go to your videos",
  "Upload another". The Videos list is invalidated so the new video appears.
- **Upload — failed**: `describeStudioError(err, 'upload')` → `ErrorState` with Try again (same
  input) and Edit details (back to the form, values kept). `ffmpeg-not-found` gets the ffmpeg
  state instead (below). A relay failure at publish time is worded "Could not publish".
- **Videos**: `myVideos(cursor)` as a table: thumbnail (`image(url, sha256)`, Skeleton),
  title (→ Analytics for it), kind · duration · tags, published (relative), price (`SatsBadge`
  "from N sats"), paid views and sats to you (`adapter.stats`, Skeleton while pending),
  Analytics / View. **Show more** pages with the cursor; a failed page is an inline compact
  error. Empty: "Upload your first video" → Upload tab.
- **Analytics**: a native `<select>` over the loaded videos (default: the one clicked in Videos,
  else the first), header with price before "View video", five tiles (Paid views, Sats to you,
  Seeders online, Reactions, Comments), and **Sats by rendition** as a bar list: rendition
  order (1080p → 360p), bar length relative to the largest, value as `SatsBadge`, share in %.
  One series, accent token, 4 px rounded ends, text in text tokens (dataviz rules). 0 seeders →
  the `no-seeders-online` preset with "Open Seeder".
- **Seeder**: `seeder.status()` + `seeder.onStatus` (unsubscribed on unmount, tested). On/off
  (`setEnabled`, then a status refresh), storage `<meter>` (bytes of cap) + link to Settings,
  earnings (total `earned`, unswapped, by mint), **melt-out**: pick a mint with earnings
  (default: the largest), paste an invoice (shape check only; `lightning:` stripped), "Review
  melt-out" asks `adapter.wallet.meltQuote` → a `Sheet` states invoice amount, max fee and the
  max total **before** "Melt out N sats"; then `seeder.melt(mint, bolt11)` → Paid / Not paid /
  error. The sheet cannot be closed while paying, and a late answer cannot reopen it. Connected
  peers table (blocks sent/paid, unpaid of window, last active) and banned peers with reason
  copy (`describeBanReason`) + Unban.
- **Web**: when `adapter.platform === 'web'` a note "Your gateway stores web uploads as-is"
  sits above the drop zone, and the drop-zone line says MP4 (H.264) plays everywhere. Copy only.
- Everything is guarded: effects cancel on unmount (tested for upload progress/settle and
  analytics); no `console.*`, no `window.location`, no `dangerouslySetInnerHTML`.

### "Typical cost to watch" — what is derivable (judgement call)

Before the file is transcoded **no rendition bitrate is known** through the contract (probing
happens inside `upload()`), so an exact per-minute price is not derivable. The form shows:

- exactly: sats per GB streamed (`ceil(10⁹ / 65,536) × price`);
- as an estimate, labelled so: sats per minute at the standard encode rates of core's ladder
  (`TYPICAL_RENDITIONS` = `media.LADDER_TIERS` video+audio: 5,128 / 2,628 / 896 kbps; a test
  keeps them in sync) — at 1 sat/block ≈ 587 / 301 / 103 sats/min — with the sentence "Your
  real renditions are measured after transcoding, and a rendition taller than your source is
  never made";
- after publishing, the real figures from the manifest's renditions.

On web the ladder does not apply (the file is stored as-is); the web notice says the cost
follows the file's own bitrate.

### ffmpeg not found (ADR 0005)

Two routes to one design (`FfmpegMissing`):

1. **Pre-probe** (`ffmpeg={{ found: false, … }}`): an `EmptyState` replaces the drop zone
   before anything is filled in — "ffmpeg not found", why it is needed, "Looked for it at
   `<path>`", install steps (macOS `brew install ffmpeg`; Windows `winget install Gyan.FFmpeg`
   + restart; Debian/Ubuntu `sudo apt install ffmpeg`, Fedora with RPM Fusion `sudo dnf install
   ffmpeg` — Fedora's own `ffmpeg-free` lacks the libx264 encoder core's argv uses — Arch
   `sudo pacman -S ffmpeg`), "needs both ffmpeg and ffprobe", **Set ffmpeg path in Settings**
   (→ `{ name: 'settings' }`) and **Check again** (`onRecheckFfmpeg`). With `os` set, that
   system is shown and the rest fold into "Other systems".
2. **Failed upload**: core's `runStudioUpload` emits `{ stage: 'error', message }` and rejects
   with `MediaError('ffmpeg-not-found')` (from a `ProcessRunnerError` spawn failure, message
   "`<step>: could not spawn <file> (ENOENT)`"). `classifyStudioError` checks `code` on the
   error and its `cause`, then falls back to that message pattern because an Electron IPC hop
   drops custom properties (tested with a code-less `Error('Error invoking remote method: …')`).
   The same guidance renders as an alert, with the raw message as detail and **Try again**.

## States (Storybook `Screens/Studio`, 25 stories × 2 themes = **50 PNGs** in `artifacts/screens/studio/`)

| Story | How | What you see |
|---|---|---|
| Loading | `latencyMs: 5000` | tabs + block/line skeletons, panel `aria-busy` |
| Signed out | `signedIn: false` | "Sign in to use Studio" + Connect signer, no tabs |
| Error — no signer | `failWith: 'no-signer'` | same as signed out |
| Error — relay down | `failWith: 'relay-down'` | "Relay down" + detail + Retry |
| Upload — choose a file | default, `ffmpeg` found | drop zone + "Transcoding with ffmpeg 8.1.2 at /usr/bin/ffmpeg" |
| Upload — details and preview | `pendingFile` + description/tags filled | the form; Markdown preview with bold/italic/link, tags as `#space #physics #orbital-mechanics` |
| Upload — validation errors | title cleared, price 0, seeder 120, Publish | three inline errors, "Fix 3 things", title focused |
| Upload — web platform notice | `platform: 'web'` | the gateway note above the drop zone |
| Upload — ffmpeg not found | `ffmpeg: { found: false, path, os: 'linux' }` | the pre-probe state, Linux first |
| Upload — ffmpeg not found during upload | upload rejects `MediaError('ffmpeg-not-found')` | alert with all three systems + Try again; "Checking the file" failed |
| Upload — in progress (transcoding) | scripted: 1080p 100 %, 720p 62 %, hangs | **mid-transcode snapshot**: step 1 done, step 2 active with two bars |
| Upload — thumbnails ready, writing | scripted through `thumbnails`, 720p writing 35 % | three candidate frames, first marked Thumbnail |
| Upload — published | stock mock + two mirrors | Published card with real per-rendition prices, all steps done, 2 mirrors |
| Upload — error (transcoding failed) | `MediaError('process-failed', 'transcode 1080p: exit 1')` | "Transcoding failed" + Try again / Edit details; step 2 failed at 41 % |
| Videos (populated) | stock mock | 3 rows: thumbnail, title, kind/duration/tags, price, paid views, sats |
| Videos — empty | `myVideos` → `[]` | "Upload your first video" |
| Analytics (populated) | stock mock | tiles + 60/30/10 % rendition bars |
| Analytics — no seeders online | `failWith: 'no-seeders'` | warning tile + `no-seeders-online` state + Open Seeder |
| Analytics — no videos yet | `myVideos` → `[]` | empty state |
| Seeder (banned peers) | mock + two extra bans | all cards; three banned peers with reason copy |
| Seeder — seeding off | `seeding: false` | "Off —" + Turn on seeding (accent) |
| Seeder — melt-out confirm | invoice pasted, Review | Sheet: 1,500 sats + ≤ 15 fee = ≤ 1,515 sats, "Melt out 1,500 sats" |
| Seeder — melt-out paid | … + confirm | Sheet: Paid |
| Error — no balance (melt-out not paid) | `failWith: 'no-balance'` + confirm | Sheet: Not paid, with what to do |
| With mini-player slot | placeholder node | floats bottom-right |

Stories that need clicks use `<Auto>` (story-only): it fills inputs / presses buttons as soon as
they exist (Publish waits until settings pre-selected a mint). The three melt stories use a
1,280 px frame so the fixed Sheet is fully in the PNG.

## Tests (54, all green)

`__tests__/studio.test.ts` (41): structure/landmark/tabs/aria-busy; signed out (no tabs, no
upload call) and no-signer; relay-down + Retry; tabs (navigate, roving, keys, prop follow);
file choice (desktop `resolveFile` → path in `UploadInput.file`; web → the `File` itself; drop;
non-video copy; failing resolver); form (default mints, Markdown preview with hostile input,
linked split + ADR table + 0 % warning, per-minute estimates at 1 and 2 sats, validation with
focus and no upload call, add mint); publishing (**exact `UploadInput`**, Published view,
**every price precedes View in DOM order**, navigate to `shorts` for kind 22, mirrors, Upload
another; custom thumbnail as `thumbnailChoice`; mid-transcode steps/bars/live text + tab chip;
candidates via `adapter.image`, first marked; failed transcode → Try again re-calls, Edit
details keeps values; relay at publish; **unmount mid-upload → late progress/settle update
nothing**); ffmpeg (pre-probe state, Linux first, Settings route, Check again; rejection →
alert + Try again; code-less IPC message still recognised); web notice only on web; Videos
(verified thumbnails, stats, price precedes View per row, View → watch/shorts, Analytics →
tab + `analytics(id)`, empty, paging with cursor + failed page + retry, first-load error);
Analytics (tiles, rendition order and shares, price before View, select → new id, no seeders →
Seeder, unmount mid-load); Seeder (onStatus subscribed, live update after `setEnabled(false)`,
**unsubscribed on unmount**, earnings/peers, unban, melt validate → quote → confirm → Paid,
no-balance → Not paid, other mint + failed quote + Try again, status error + Retry); mini
slot. Every test asserts no `console.error` (act warnings included).

`__tests__/studio-model.test.ts` (13): block size and ladder in sync with core; ADR 0005 split
(incl. the counter-example below); per-minute / per-GB; rendition bitrate fallback; parsers
(tags, https URLs, servers, invoices, file types, bytes, split); draft → exact `UploadInput`
and every validation error; progress reducer (clamping, upsert, mirrors), step statuses,
failure marking; error classification (codes, `cause`, message fallback) and context copy.

`npm run ci` → exit 0 (see the report for counts).

## Assumptions / judgement calls / unsure

- **Thumbnail pick (not possible in v3).** `thumbnailChoice` must be set before `upload()`, and
  core resolves it right after emitting `thumbnails`, so a pick from the candidates cannot reach
  the pipeline. Shipped: pre-publish choice "A frame from the video" (candidate 0) / "Your own
  image"; candidates shown read-only, the used one marked, with a sentence saying a later pick
  is not supported yet. Contract request 2 (`chooseThumbnail` callback) would make the strip
  interactive.
- **Not cancellable** (no signal in v3). No Cancel button, and copy saying so. Contract request 1.
- **Melt-out amount from `adapter.wallet.meltQuote`.** `seeder.melt` answers only `{ paid }`;
  to show amount + fee before confirming I quote through the wallet, assuming seeder earnings
  are in `adapter.wallet` (true for the mock and per `PaymentEngineSeeder.flush`). A failed
  quote blocks the confirm. If the orchestrator prefers not to touch `wallet` here, drop the
  quote step and the Sheet would only restate mint + invoice. Contract request 7.
- **Invoice check is shape-only** (`ln(bc|tb|tbs|bcrt)…`) — no bech32 decoding; the mint's
  quote is the amount shown.
- **Price is 1–1,000 sats per block.** The manifest parser accepts 0, but a free video's
  behaviour on the pay path is unspecified, so there is no Free option. Say if one is wanted.
- **The split rule is displayed, not enforced here** — `splitPayment` mirrors ADR 0005 Q1 for
  the table only.
- **ADR 0005 inaccuracy (for the orchestrator).** Its consequences paragraph says that with
  `amount ≥ 2` and both percentages > 0 "both shares are ≥ 1 sat". That holds only for
  `seeder ≤ 50`: 2 sats at 99/1 gives `ceil(1.98) = 2` to the seeder and **0 to the creator**,
  so the creator set is legitimately empty for more PAYs than the ADR (and L10's planned
  expectation "creator set may be empty only when creatorSats = 0 by this formula" — which is
  still right) suggests. Tested in `studio-model.test.ts`.
- **Default tab is Upload** (the §6.1 row lists it first). YouTube Studio lands on a dashboard;
  `videos` would be the other sensible default — one line in `Studio.tsx`.
- **Shell must keep Studio mounted across `studio` routes** (same tree position, not keyed by
  tab), or the progress view of a running upload is lost (the upload itself continues). Tab
  clicks call `navigate`, like Home/Channel.
- **Byte units are binary with familiar labels** (a 50 × 1024³ cap reads "50 GB", a
  734,003,200-byte file "700 MB"), matching how the mock/settings define sizes.
- **Mock quirks visible in stories**: the mock's melt quote reads `lnbc1500…` as 1,500 sats
  (real bolt11 would be 150); seeder earnings do not drop after a melt; `myVideos` returns
  Orbital's three videos re-authored as you.
- **Route**: `{ name: 'studio' }` has no `videoId`, so the Analytics selection is local state
  (not deep-linkable). Suggested in the contract-request file (it is orchestrator-owned
  `route.ts`, not a contract).

## Deviations from the task text

- "thumbnail pick from the `thumbnails` progress stage candidates" — read-only for the reason
  above; the pick moved to before publishing.
- "cancellable if the contract allows" — it does not; stated in the UI and requested.
- Extra: a validation story, a "thumbnails ready, writing" story, an ffmpeg-during-upload
  story, "Analytics — no videos yet", "Seeder — seeding off", the melt confirm/paid stories and
  the mini-player slot, beyond the required states.
