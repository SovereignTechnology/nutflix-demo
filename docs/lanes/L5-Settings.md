# Lane L5-Settings: the Settings screen (`packages/ui/src/screens/Settings/`)

**Issued against `CONTRACTS_VERSION = 3`.** Branch `lane/L5-Settings`, based on main @ `e259115`.
The contract request is in `docs/contract-requests/L5-Settings.md`. It asks for a way to
change signer, a way to clear `autoTopUp`, and a clarification of the two seeding switches.
Nothing is blocked: each gap has a v3 workaround, described below.

Scope: build-plan §6.1 row **Settings** ("Signer (NIP-07/46/local), relays, default mints,
seeding on/off + disk cap, data-saver (prefetch depth), theme"), §6.2 "buffer = money", ADR
0005 (light + dark, follow the system, toggle in Settings), design brief (YouTube first,
Rumble second), L4 component API.

## What was built

```
packages/ui/src/screens/Settings/
  index.ts                 export surface (below). Deliberately small, because the barrel uses `export *`
  Settings.tsx             the screen: header + save status, section nav, the six sections, toasts, mini slot
  useSettingsStore.ts      load + optimistic, serialised, per-operation-rollback save queue
  SignerSection.tsx        Account: identity, signer capabilities, signer-type choice (+ useSigner)
  AppearanceSection.tsx    theme: device / dark / light
  PlaybackSection.tsx      buffer-ahead ("data saver") presets + slider, hover-preview switch
  RelaysSection.tsx        relay table (read / write / remove) + "Add a relay" (wss:// only)
  WalletSection.tsx        default mints (MintChip + balance, add / remove, add-from-wallet) + auto top-up
  SeedingSection.tsx       seeding switch, live usage meter, disk cap (GB field + slider), Studio link
  controls.tsx             screen-local form scaffolding: SectionFrame, SwitchRow, FieldError, Note, useAlive
  model.ts                 pure helpers: URL validation/normalisation, GB units, bounds, signer + error copy
  Settings.css             `nf-settings` namespace, L4 tokens only
  Settings.stories.tsx     title 'Screens/Settings', 16 stories (one per state)
  __tests__/settings.test.ts   31 tests (jsdom, components/testing/render.ts)
  __tests__/model.test.ts      13 tests (pure)
```

### Wiring the orchestrator must add

`packages/ui/src/screens/index.ts`:

```ts
export { SETTINGS_SECTIONS, Settings } from './Settings/index.js';
export type { SettingsProps, SettingsSectionId } from './Settings/index.js';
```

(`export * from './Settings/index.js';` is equivalent. The index exports only those four names,
so no generic helper can collide with another screen's.)

`packages/ui/src/screens/screens.css`:

```css
@import './Settings/Settings.css';
```

Naming note: the component is `Settings`, the brief's `<Screen>` name, and `@sovit/core` also
exports a `Settings` **type**. They live in different packages, so nothing collides inside
`@sovit/ui`. A shell that imports both needs an alias, e.g.
`import type { Settings as SettingsData } from '@sovit/core'`, as the stories and tests do.

## Props (`SettingsProps extends ScreenProps`)

| Prop | Type | Meaning |
|---|---|---|
| `adapter`, `navigate`, `miniPlayer` | from `ScreenProps` | `miniPlayer` floats bottom-right (`nf-settings__mini`), as on Home |
| `onChangeSigner?` | `(kind: 'nip07' \| 'nip46' \| 'local') => void \| Promise<void>` | Shell-owned connect/switch flow. Omitted: the signer-type choice is read-only. A returned promise makes the screen re-read `adapter.signer()` after it settles. This is the v3 stand-in for the requested `connectSigner` |
| `onSettingsChange?` | `(s: Settings) => void` | Called with the **adapter-confirmed** settings after every successful save. It is also called for saves that finish after the screen unmounted. **The shell applies the theme here** |
| `onToast?` | `(t: ToastItem) => void` | Hands failure toasts to the shell's `ToastStack`. Recommended, because a save that fails after the viewer navigated away still reaches them. Omitted: the screen renders its own `ToastStack` (fixed, bottom-left) |
| `inlineToasts?` | `boolean` | Screen-owned stack in flow instead of fixed (Storybook) |
| `className?` | `string` | |

### Theme contract the shell must honour (ADR 0005)

The screen **never touches `document` or root attributes**. A test asserts that
`data-theme` on `<html>` is unchanged after two theme saves. The shell:

1. at boot: `applyTheme((await adapter.settings()).theme)` (L4 `tokens/theme.ts`);
2. on every `onSettingsChange(s)`: `applyTheme(s.theme)`.

`'system'` removes the attribute, so `prefers-color-scheme` decides. ADR 0005 makes system
the default, but the mock's default is `'dark'`, so the stories set `'system'` explicitly. The
"Use device theme" option shows which theme the device currently resolves to, using L4's
read-only `useResolvedTheme('system')`, which only queries `matchMedia`.

## Behaviour

- **Layout.** A single page of six `<section aria-labelledby>` blocks, each named by its `<h2>`,
  in this order: Account, Appearance, Playback and performance, Relays, Mints and top-up,
  Seeding. Groups of controls are `<fieldset>` + `<legend>`, and every input has a `<label>`
  or an `aria-label` (tested).
  - **Wide (≥ 880 px of container width):** a sticky left section nav in YouTube's settings
    style, with plain rows and the current item on a tinted pill. Content is capped at 760 px.
  - **Narrow:** the nav becomes a horizontally scrolling chip row, the same idiom as Home's
    tabs.
  - The breakpoint is a **container query**, so the layout follows the width the shell gives
    the screen, not the viewport.
  - Nav items are buttons. They scroll to the section and move focus to its `h2`
    (`tabIndex=-1`) and set `aria-current`. An `IntersectionObserver` scroll-spy updates the
    highlight when the user scrolls. They are not `#hash` links, because shells may hash-route.
- **Save model** (`useSettingsStore`). Every control saves on its own, with no Save button.
  - Each change is a `SaveSpec` whose `patch` is a *function of the settings it applies to*.
  - On screen, `view` is the last confirmed settings with each queued patch applied on top,
    so a click shows immediately. This is the optimistic UI.
  - The queue sends one `updateSettings(patch)` at a time. Each patch is recomputed against
    the **confirmed** settings at send time.
  - **A failure rolls back only that operation.** If relay A fails, relay B's later write
    neither fails with it nor resurrects A (tested).
  - A failure raises an error `Toast` ("Could not save hover preview", "…the change was
    undone") with **Retry**, which re-queues the same operation. The header status line
    moves from "Changes save automatically" through "Saving…" to "All changes saved" or
    "Last change not saved".
  - **Typed input is never lost:** text drafts (relay/mint address, disk cap, top-up
    threshold, slider position) stay in the field with an inline "Not saved — …" error. They
    are cleared only when their own save succeeds, and only if the user has not typed
    something else since.
  - Writes already queued **keep going after unmount**, because they are the user's intent.
    Only React state updates stop.
- **Account.**
  - `adapter.signer()` supplies the kind, pubkey, locked flag, `supportsSignSecret` and
    `detail`. The viewer's name and avatar come from `adapter.profile` + `adapter.image(picture)`
    (T16). The pubkey is shown shortened (`shortPubkey`).
  - A status pill shows Connected or Locked.
  - A facts list covers signing readiness and the **wallet key mode**. signer.ts says the UI
    MUST say which: "Held by your signer — the wallet's spending key never enters this app"
    (success tint), or "the wallet key is decrypted into this app's memory (NIP-44) while you
    pay" (warning tint). `detail` appears under "Details" as monospace text.
  - When signed out (`pubkey === null`), the section shows the `signer-not-detected` preset in
    a card. The "Connect signer" action appears only if `onChangeSigner` is given; there are
    no dead buttons.
  - If the signer is unreachable (`signer()` rejects), only this section shows a compact
    error with Retry, and the other sections are **not** treated as signed out.
- **Appearance.** Three radio cards: "Use device theme" (with "Follows your device —
  currently dark/light"), "Dark theme" and "Light theme". These are YouTube's wording.
- **Playback and performance.**
  - A **"Buffer = money"** callout (sats tint) explains that seeders are paid per block, so
    buffering spends sats before you watch, deeper buffering means smoother playback, pausing
    stops paying, and related videos are never prefetched.
  - Presets: "Data saver · 10 s", "Balanced · 30 s" (the build-plan default) and
    "Smooth · 60 s", as `Button pressed`.
  - A 5–120 s slider (step 5) with an `<output>`. It commits on release (pointer-up, key-up,
    blur), not while dragging.
  - A "Preview videos on hover" switch, whose copy says each preview costs a few sats.
- **Relays.**
  - A table (`caption` / `th scope`) with Read and Write checkboxes and a remove `IconButton`.
    Every control is labelled with the relay URL.
  - **Guards:** the last reader's Read box, the last writer's Write box, and the remove button
    of a relay that is the last reader or writer are disabled, with "Keep at least one relay
    for reading and one for writing" attached via `aria-describedby`. If adapter data
    arrives with no reader or no writer, a warning note appears.
  - **"Add a relay" accepts `wss://` only.** Anything else is rejected inline with a specific
    message ("Use wss:// — unencrypted ws:// relays are not allowed.", "Relays use wss://,
    not https://", …), `aria-invalid`, and `role=alert`, and nothing is saved.
  - Addresses are normalised through WHATWG `URL`: host lower-cased and **IDNA-encoded** (so a
    Cyrillic look-alike appears as `xn--…`), default port dropped, trailing slash dropped.
    Credentials, `#` fragments, whitespace, over-long input and duplicates are rejected.
  - A new relay is read + write. With no relays, a designed empty state is shown.
  - The copy says the list is published as kind 10002, or, when signed out, that a signer is
    needed to publish it.
- **Mints and top-up.**
  - Default mints show as `MintChip`s with the wallet's balance at each
    (`wallet.balances()`) and a remove button. The last mint cannot be removed.
  - "Add a mint" accepts **`https://` only** ("a mint over plain http:// would expose your
    ecash") and normalises to the contract's `MintUrl` form (no trailing slash). A query or
    fragment, credentials and duplicates are rejected.
  - "Add from your wallet" offers the wallet's own mints that are not yet defaults as one-tap
    `MintChip` buttons.
  - **Auto top-up** has a switch; when on, a whole-sats threshold field (commit on Enter or
    blur; "2,500" accepted) and a mint `<select>`. A summary line renders the threshold
    through `SatsBadge`.
  - Switching auto top-up on writes `{ belowSats: 1000, fromMint: <first mint> }`. Switching
    it off writes `belowSats: 0` (see contract request §2).
  - The switch is disabled when signed out ("Connect a signer to use your wallet"), or when
    the signer is unreachable ("Available once your signer is reachable — see Account
    above").
  - A ghost link goes to `navigate({ name: 'wallet' })`.
- **Seeding.**
  - The switch calls **`adapter.seeder.setEnabled(on)`**, not `updateSettings`, which is
    tested (see contract request §3).
  - The live usage line comes from `seeder.status()` + `seeder.onStatus`. The subscription is
    removed on unmount (tested). It shows a `<meter>`, "1.6 GB of 50 GB used · 3 videos ·
    2 peers connected" (or "paused"), and a `SatsBadge variant="earned"`.
  - The disk cap has a GB number field (1–10,000, one decimal) plus a 1–500 GB slider. It is
    written through `updateSettings({ seeding: { enabled, diskCapBytes } })`. A value below
    what is already stored shows a warning note.
  - If `seeder.status()` fails, a warning note is shown and the controls keep working.
  - The "Earnings, peers and melt-out in Studio" link calls
    `navigate({ name: 'studio', tab: 'seeder' })`.
- **Prices before playback.** This screen has no playback affordance at all (tested). Every
  sats figure is rendered by `SatsBadge` or `MintChip` (tested by walking the text nodes).
- **Errors.**
  - If `settings()` fails, the whole screen shows a designed `ErrorState`: "Relay down" /
    "None of your relays answered, so your settings could not be loaded… nothing was
    changed", with the monospace detail and Retry, and no nav.
  - Everything else degrades per section, as described above. Nothing is thrown to the
    shell, and there is no `console.*`.
- **Cancellation.** Every load effect is cancelled on unmount, whether it uses an
  `AbortController` or a cancelled flag. The signer → profile → image chain never
  continues after unmount (tested with no follow-up calls and no `console.error`).

## States (Storybook `Screens/Settings`, 16 stories × 2 themes = **32 PNGs** in `artifacts/screens/settings/`)

| Story | How it is produced | What you see |
|---|---|---|
| Loading (skeletons) | `latencyMs: 5000` | nav (disabled) + six skeleton sections, body `aria-busy` |
| Populated (local key, follows device theme) | stock mock, `theme: 'system'` | everything filled; wallet key "held by your signer" |
| Auto top-up on, dark theme chosen | `autoTopUp: { 2500, mint a }`, `theme: 'dark'` | threshold + mint select + summary badge |
| Seeding off, data saver buffer | `seeding: false`, `prefetchSeconds: 10`, hover off | switches off, "Data saver · 10 s" pressed |
| Empty — no relays, no default mints | `relays: []`, `defaultMints: []` | "No relays yet" card; mint warning; both wallet mints offered |
| Signer — remote (NIP-46), wallet key fallback | `signer()` → nip46, no `signSecret`, detail | warning-tinted NIP-44 fallback copy, Details row |
| Signer — local key, locked | `locked: true` | "Locked" pill, "unlock your signer…" |
| Signer — switchable | `onChangeSigner` given | signer-type radios enabled |
| Signed out | `signedIn: false` | signer-not-detected card, radios read-only, relay/wallet copy asks for a signer |
| Error — no signer | `failWith: 'no-signer'` + `onChangeSigner` | same, with "Connect signer" button and enabled radios |
| Error — no balance | `failWith: 'no-balance'` + auto top-up | MintChips at 0 sats; settings otherwise normal |
| Error — relay down | `failWith: 'relay-down'` | full-width `ErrorState` "Relay down" + detail + Retry |
| Error — signer and seeder unreachable | `signer()` and `seeder.status()` reject | compact error card in Account; seeding warning note; the rest works |
| Error — save failed (rolled back, input kept, toast) | `updateSettings` rejects; story clicks hover + submits cap 20 | switch back on, cap field still "20" + inline "Not saved", two error toasts with Retry, header "Last change not saved" |
| Invalid relay address | story types `ws://relay.example` + submits | red field + "Use wss:// — unencrypted ws:// relays are not allowed." |
| Narrow (mobile width) | frame 400 px | chip-row nav, stacked content |

`failWith: 'no-seeders'` has **no story**: seeders matter per video, and nothing on Settings
depends on them. The two interaction stories drive the DOM from a story-only `Drive`
wrapper after mount, because Storybook has no play step pinned here.

**Screenshots:** the script's default Chromium path (`/home/gateway/…`) does not exist on
this box. I ran it with `NUTFLIX_CHROMIUM=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`:
a plain `chromium.launch` with a throwaway profile. I looked at the populated (light and
dark), auto-top-up, save-failed, signed-out, no-signer, signer-unreachable, empty, loading,
relay-down, narrow, invalid-relay and remote-signer PNGs. From those I fixed:

- the relay-down error squashed into the nav column;
- a stray space before the full stop in the top-up summary;
- the signed-out detail wrapping mid-phrase;
- the nav jumping mid-page in the save-failed story, where `focus()` scrolled it;
- signer-unreachable being worded as "signed out".

## Tests (44 in this lane: `settings.test.ts` 31 + `model.test.ts` 13; all green)

- **structure:** a landmark named by its `h1`; nav items match `SETTINGS_SECTIONS`; skeletons
  + `aria-busy` while loading; six sections, each named by its `h2`; every fieldset has a
  legend; every input/select has an accessible name; adapter values rendered (relay flags,
  mint chip + balance, wallet suggestion, seeding, cap "50", "30 s", hover, theme).
- **price/play:** no Play/Watch affordance; every "N sats" text node is inside
  `.nf-sats`/`.nf-mint`; the top-up summary badge reads "2,500 sats".
- **account:** local signer copy, short pubkey, Connected, "never enters this app", read-only
  choice without the shell prop. NIP-46 locked, with the fallback warning and detail.
  Signed-out preset, no dead button, relay/wallet copy, top-up disabled, local settings still
  enabled. The shell flow is called with `nip07`/`nip46`, shows "Connecting…", and
  `signer()` is re-read after each flow settles. An unreachable signer degrades only its own
  section, is not treated as signed out, and Retry recovers.
- **relays:** ws/https/empty/duplicate each rejected inline (`aria-invalid`, `role=alert`,
  no save; editing clears the error). A valid add is normalised, shows optimistically, sends
  the exact patch, clears the field and fires `onSettingsChange`. Toggle, remove and the
  last-reader/writer guards work. The empty state renders.
- **mints / top-up:** `http://` rejected; normalised add; add from wallet; remove; the last
  mint is guarded. Top-up on → `{1000, a}`; threshold "2,500" → 2500 and the badge;
  "1.5" rejected; mint b selected; off → `{0, b}`.
- **seeding / playback / appearance:** the switch uses `seeder.setEnabled` and never
  `updateSettings`, and `onStatus` updates the usage line. The cap rejects "abc"/"0" and
  saves 20 GiB. The below-stored warning appears. The preset sends 10, the slider does not
  save while dragging and commits 45 on key-up. Theme `light`/`system` go through the
  adapter, `onSettingsChange` sees both, and `<html data-theme>` is untouched. Studio/Wallet
  routes are correct. The nav moves focus to the heading and sets `aria-current`.
- **save model:**
  - A failed toggle rolls back, shows an error toast, and the header reads "Last change not
    saved"; Retry re-sends and dismisses the toast.
  - Typed cap and relay input survive a failure.
  - Per-operation rollback: the first op fails, the second is kept, and the writes go out in
    order.
  - A failed add is not resurrected by a later list write.
  - `onToast` receives the toast even after unmount, and nothing is logged.
- **errors / cancellation:** relay-down shows the full error with detail, and Retry calls
  `settings()` again. A seeder-status failure becomes a note. Unmounting mid-load means no
  `profile`/`image` calls and no `console.error`. The `onStatus` unsubscribe runs.
- **model:** relay/mint validation and normalisation (including IDNA and `javascript:`),
  bytes ↔ GB, cap and threshold parsing, prefetch clamping, top-up "off" reading, signer
  titles, error copy.

Whole suite (`npm run ci`, exit 0): **63 files / 695 passed / 27 skipped**. The first run hit the known
gateway WS-bridge timeout flake (`sessions without a pay/1 factory … are still cut`, 20 s); the re-run
was green.

## Judgement calls (react to the PNGs)

- **One scrolling page with a scroll-spy nav**, not YouTube's one-page-per-section. Every
  setting is visible in one PNG, the `settings` route has no section parameter, and the nav
  still reads as YouTube's list at wide widths.
- **Auto-save per control**, with a quiet header status, instead of a Save button. The toast
  appears only on failure. This matches the "optimistic UI + rollback" brief and YouTube's
  settings, which also save immediately.
- **Blue on-state** for switches and checks (`--nf-color-text-link`), as in YouTube. The
  orange accent is reserved for money, which is why the "Buffer = money" callout uses the
  sats tint.
- **The switch is a native checkbox with `role="switch"`,** drawn in `Settings.css`. This
  is not a new L4 primitive: it is plain semantic HTML. If other screens need one, L4 could
  adopt it.
- **Guards over warnings** for relays and mints: the UI will not let the viewer remove the
  last reader, writer or default mint (secure by default). Warnings appear only when the
  adapter delivers such a state.
- **GB means 2^30 bytes,** to match the mock's `50 * 1024 ** 3` = "50 GB".
- **Prefetch range 5–120 s, presets 10/30/60.** The build plan only fixes "default ~30 s".
- **The auto top-up default threshold is 1,000 sats.** Turning it off loses the previous
  threshold, because of the `belowSats: 0` convention.
- The signer-type descriptions deliberately name no extension brands.

## Assumptions / things I was unsure about

- **Signer change:** no v3 method. See the contract request §1, and the `onChangeSigner`
  stand-in.
- **Seeding switch authority:** `seeder.setEnabled` versus `Settings.seeding.enabled`. See
  §3. If the orchestrator prefers `updateSettings` for both, the switch's `write` override in
  `SeedingSection.tsx` is the only thing to delete.
- **"Off" for auto top-up = `belowSats: 0`.** See §2. A real adapter must not treat 0 as
  "top up whenever".
- **"Local + kind 10002"** is the build plan's statement. The relay copy says the list is
  published as kind 10002, and the screen assumes `updateSettings({ relays })` is what
  publishes it.
- **The hover-preview default** (on for desktop, off for web) is the adapter's or shell's
  choice. The screen shows whatever `settings()` returns.
- **`useResolvedTheme`** is imported from `../../tokens/index.js`. It is a hook, not a
  visual primitive, and only reads `matchMedia`.
- `Settings.css` targets two L4 inner classes (`.nf-state__icon` inside the card-style
  states) to tint the icon well on a subtle background. This follows the precedent of
  L5-Home's `.nf-card__text` rule.
- `adapter` identity is assumed stable for the life of the screen.

## Deviations from the task text

- **Signer choice:** read-only unless the shell passes `onChangeSigner`. No adapter method
  was invented.
- **Extra stories beyond the listed states:** remote signer, locked, switchable, signer and
  seeder unreachable, save failed, invalid relay, and narrow. The `no-seeders` story is
  omitted because it does not apply here.
