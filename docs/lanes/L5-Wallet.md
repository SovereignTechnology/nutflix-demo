# Lane L5-Wallet — the Wallet screen (`packages/ui/src/screens/Wallet/`)

**Issued against `CONTRACTS_VERSION = 3`.** Branch `lane/L5-Wallet`, based on main @ `684faa4`
(which pinned `uqr@0.1.3` in `@sovit/ui` for this lane). Contract **notes** (no blockers):
`docs/contract-requests/L5-Wallet.md` — switching auto top-up off, resumable mint quotes,
a history cursor, mint reachability, and the paramless `wallet` route.

Scope: build-plan §6.1 row **Wallet** (balance per mint, fund via LN invoice QR, auto-top-up
threshold, melt-out, history 7376, persistent header chip), §3 "Funding" and "NIP-60 P2PK key",
§6.3 designed empties, SECURITY.md T8 (one-click melt-out, mint shown) and "price shown vs
price charged". Backed by `adapter.wallet` (the `Wallet` contract, read in full) and
`adapter.settings()` / `updateSettings()`. Route `{ name: 'wallet' }`.

## What was built

```
packages/ui/src/screens/Wallet/
  index.ts                  export surface (below)
  Wallet.tsx                the screen: head + actions · Balance card (total + MintChip rows) ·
                            History card (7376, mint filter) · Auto top-up card · "How your
                            wallet is kept" card · sheets · toasts
  FundSheet.tsx             "Add funds" sheet: mint + amount → mintQuote → QR / text / link →
                            pollQuote with back-off → paid / expired / unreachable / error
  WithdrawSheet.tsx         "Withdraw" sheet: mint + invoice → meltQuote → fee shown → confirm
                            → melt → sent / not paid / failed
  InvoiceQr.tsx             uqr `encode()` matrix → React SVG `<rect>`s (no HTML anywhere)
  WalletChip.tsx            the shell's header chip (presentational)
  invoice.ts                pure helpers: bolt11 shape, QR payload + runs, poll back-off,
                            countdown, sats parsing, auto-top-up predicate, error copy
  hooks.ts                  useAlive, useNow (1 s tick while a countdown shows)
  Wallet.css                `nf-wallet` + `nf-walletchip`, L4 tokens only
  Wallet.stories.tsx        'Screens/Wallet', 27 stories (one per state)
  __tests__/wallet.test.ts  55 vitest tests (jsdom, components/testing/render.ts)
```

### Export lines wanted in `packages/ui/src/screens/index.ts`

```ts
export { Wallet, WalletChip } from './Wallet/index.js';
export type { WalletChipProps, WalletIntent, WalletProps } from './Wallet/index.js';
```

`./Wallet/index.js` also exports `walletChipLabel`, `historyLabel`, `describeWalletError`
(deliberately not `describeError` — Home owns that name), `isLikelyBolt11`, `normalizeInvoice`,
`invoiceQrPayload`, `nextPollDelay`, `isAutoTopUpOn`, `BOLT11_SHAPE`, `WALLET_HISTORY_LIMIT`,
`AUTO_TOP_UP_DEFAULT_BELOW`. None collides with Home's or Channel's names, so `export *` is
also safe.

### CSS wiring (orchestrator)

Add to `packages/ui/src/screens/screens.css`, after the Channel line:

```css
@import './Wallet/Wallet.css';
```

`Wallet.css` also carries the `WalletChip` styles, so the shell's header gets them from the same
file. The screen never imports its CSS (CSP `style-src 'self'`); only the story does.

## `WalletChip` — for the shell header (build-plan "persistent header chip")

```tsx
<WalletChip balance={total} satsPerMin={playing ? rate : undefined} onClick={() => navigate({ name: 'wallet' })} />
```

| Prop | Type | Meaning |
|---|---|---|
| `balance` | `Sats \| number \| undefined` | total across mints; `undefined` → skeleton |
| `satsPerMin?` | `Sats \| number` | shown as a green "streaming N sats/min" badge only while `> 0` |
| `onClick?` | `() => void` | makes it a button; without it the chip is static |
| `className?` | `string` | |

Presentational only (L4 `Icon` + `SatsBadge` + `Skeleton`). How the shell feeds it: sum
`adapter.wallet.balances()` once, then apply `wallet.onChange` `{ type: 'balance' }` events
(per-mint balances, re-sum); `satsPerMin` = `PlaySession.onSpend`'s `ratePerMin` while a session
plays, cleared on pause/close. Full figures up to 9,999 sats, compact (`48k sats`) above. The
accessible name is the whole sentence ("Wallet: 2,100 sats, streaming 14 sats/min").

## Props (`WalletProps extends ScreenProps`)

| Prop | Type | Meaning |
|---|---|---|
| `adapter`, `navigate`, `miniPlayer` | from `ScreenProps` | `miniPlayer` in a fixed bottom-right slot, as Home |
| `intent?` | `WalletIntent` | deep link into a flow (below) — the `wallet` route has no params in v3 |
| `clock?` | `() => number` (unix s) | pinned in stories/tests; drives relative times + countdowns |
| `historyLimit?` | `number`, default 50 | `wallet.history({ limit })` |
| `pollIntervalMs?` | `number`, default 2000 | first `pollQuote` delay |
| `maxPollIntervalMs?` | `number`, default 15000 | back-off cap |
| `className?` | `string` | |

`WalletIntent` = `{ action: 'fund', mint?, amount? }` | `{ action: 'withdraw', mint?, invoice? }`.
Fund with mint + amount opens the sheet **and requests the invoice at once** (the choice was made
upstream, e.g. Watch's "No balance at this mint → Top up"; a mint quote moves no money).
Withdraw with an invoice opens the sheet and fetches the **melt quote** — it never pays without
the explicit confirm (tested). Applied once per distinct intent, after identity and balances.

## Behaviour

- **Identity**: `adapter.me()` first. `null` → the `signer-not-detected` preset ("Sign in to use
  your wallet", Connect signer → `{ name: 'settings' }`) and **no wallet call is ever made**
  (tested). A `me()` failure is the page `ErrorState` (relay down) with Retry.
- **Balance per mint**: `wallet.balances()` + `wallet.mints()` + `settings().defaultMints`
  (union, so a configured-but-empty mint still shows). The total is L4's `SatsBadge` scaled to a
  headline; each row is a `MintChip` (host · balance · status dot), "N% of your balance", and
  ghost **Add funds** / **Withdraw**. A zero row is the designed **"No balance at this mint"**
  (warning tint) with **Top up**. Zero everywhere adds "Your wallet is empty" + Add funds; no
  mints at all → "No mints yet" + Open Settings. A T8 tip line: "A mint holds the sats behind your
  ecash. Keep balances small…". Mint status starts `unknown` and becomes `ok`/`unreachable` from
  this session's quote outcomes (v3 has no health call — contract note 4).
- **Live**: `wallet.onChange` updates per-mint balances and prepends history entries (filter
  respected); unsubscribed on unmount (tested).
- **Fund (NUT-04)**, "Add funds" sheet: mint chips (all known mints), amount field (whole sats,
  `5,000` accepted) with quick picks 1,000 / 5,000 / 10,000 / 21,000 → **Create invoice** →
  `wallet.mintQuote(mint, amount)`. Invoice step, in DOM order: the amount (`SatsBadge`) and mint
  → the **QR** → status ("Waiting for payment…" / "Payment received — minting your ecash…") with
  **"Expires in m:ss"** → the bolt11 in a read-only, select-on-focus textarea → **Copy invoice**
  (`navigator.clipboard`, toast; a toast explains when clipboard is unavailable) and **Open in
  wallet** (`<a href="lightning:…">`, L4 button classes) → "Your Lightning wallet shows the amount
  before you pay — it should say 5,000 sats" (the only honest check without decoding).
  - **Polling**: `pollQuote` after `pollIntervalMs`, then ×1.5 per poll (floor 500 ms, cap
    `maxPollIntervalMs`): 2 s, 3, 4.5, 6.75, 10.1, 15, 15… ≈ 45 polls over a 10-minute invoice.
    The wait never overshoots the expiry: the last UNPAID check happens right at it, then
    **"Invoice expired"** ("nothing was charged", **New invoice**). `ISSUED` or a `minted`
    amount → **"Payment received"** + a `sats` toast + balances/history refresh. `PAID` without
    `minted` keeps polling with the minting copy. A `quote` event from `wallet.onChange` for this
    quote with `ISSUED` also completes it. Three consecutive failed polls → "The mint is not
    answering … If you already paid it, do not pay again" + **Check again** (resumes the loop).
  - **Cancellation**: the sheet is only mounted while open; closing it (or unmounting the
    screen) clears the timer and drops any in-flight answer — tested by counting `pollQuote`
    calls after close/unmount. Callbacks from the screen reach the loop through a ref, so a
    re-render upstream never restarts it.
  - A failed `mintQuote` → "Could not create an invoice" + Retry + "Change mint or amount".
- **QR**: `encode('LIGHTNING:' + BOLT11.toUpperCase(), { ecc: 'M', border: 0 })` from `uqr` (only
  `encode`; never `renderSVG`/`renderUnicode`, and no HTML is injected anywhere). **Upper-cased
  with the `lightning:` scheme per the BOLT11/BIP21 QR convention**: an all-caps payload fits the
  QR *alphanumeric* mode (5.5 bits/char vs 8), so the code is smaller and easier to scan; wallets
  accept either case (a test checks the payload is pure alphanumeric-set and the code is no
  bigger than the lower-case one). ECC M for glare/blur. Drawn as one `<rect>` per horizontal run
  of dark modules (a test proves the runs cover exactly the matrix's dark modules), a 4-module
  quiet zone inside the SVG, whole pixels per module (`crispEdges`, ≈ 288 px), `role="img"` +
  "QR code: Lightning invoice for 5,000 sats". **Dark-on-light in both themes**: the backing is
  the theme-independent `--nf-color-overlay-fg` (white) inside a white padded tile, modules
  `--nf-color-overlay-strong` (near-black) — see the dark PNGs. If `encode` throws the QR is
  omitted and the text + link still work.
- **Withdraw (NUT-05 melt)**, "Withdraw" sheet: mint chips (only mints holding sats; none →
  "Nothing to withdraw" + Add funds) and a paste field. **Loose shape check only**
  (`lnbc` / `lntb` / `lnbcrt`, case-insensitive, `[0-9a-z]`, ≥ 20 chars; an optional
  `lightning:` prefix and wrapped whitespace are stripped, then lower-cased) — never decoded.
  Lightning addresses / LNURL get their own message. **Review** → `wallet.meltQuote(mint,
  invoice)` → the confirm step shows **Invoice amount**, **Lightning fee reserve, at most**, and
  **Total, at most** (price `SatsBadge`) with the short invoice and "quote valid for m:ss" —
  **all before** the **"Withdraw up to 1,515 sats"** button (DOM order tested). The button is
  disabled when the mint holds less than amount + reserve ("Not enough at this mint: you hold …")
  or when the quote has expired ("Get a new quote"). Confirm → `wallet.melt(quote)` with **the same
  quote object that rendered the figures** (identity tested). Results: **"Payment sent"** with
  Sent / Lightning fee (reserve − change) / Change returned, never the preimage; `paid: false` →
  "Payment did not go through … check History before you try again" + Try again (same quote —
  melts are idempotent per quote); a throw → "Withdrawal failed" with the same advice. While the
  melt is in flight the sheet ignores Escape/backdrop/close ("keep this open"). Back / Cancel
  never melt (tested).
- **Auto top-up** (`Settings.autoTopUp`): a card with On/Off pill and a summary line ("Below
  500 sats, from mint.fixture-b.example"); **Top up automatically** checkbox reveals the
  threshold field (default 500) and "Move sats from" mint chips (default: the richest mint), plus
  the fee note ("a Lightning payment between two mints, so the sending mint's Lightning fee
  applies. Off unless you turn it on.") and a warning when the source mint is empty. **Save** is
  **optimistic**: the pill/summary switch immediately, `updateSettings({ autoTopUp })` runs, a
  failure **rolls back** (form resets to the previous saved value) and shows a sticky error
  `Toast` ("Your previous setting is back"); success shows a success toast. **Off is written as
  `belowSats: 0`** — v3 cannot clear the optional key (contract note 1).
- **History (kind 7376)**: `wallet.history({ limit: 50 })`, newest first. Each row: a tinted icon
  (in = success, out = sats colour; play glyph for streaming), a title — the wallet's own memos
  get friendly names ("Top-up via Lightning", "Withdrawal to Lightning", "Received ecash"),
  anything else is the memo **through `Markdown`** (hostile text stays text, tested) — mint host ·
  relative time (`<time datetime>`), and a signed `SatsBadge` ("Received 1,100 sats" /
  "Spent 900 sats"). A filter chip row (All mints + one `MintChip` per mint) re-queries with
  `history({ limit, mint })`. Empty → "No transactions yet"; failure → compact error + Retry.
- **"How your wallet is kept"** (build-plan §3: *show the user which mode they're in*):
  `adapter.signer().supportsSignSecret` → "Wallet key held by your signer" vs "Wallet key unlocked
  in this app" (NIP-44 decrypt into memory) — capability copy only, no key is shown; "Synced
  through your relays"; on `platform: 'web'` "Nothing stored in this browser … keep what you hold
  here small" (T13, §5); on `desktop` "Cached encrypted on this device". `p2pkPubkey()` is never
  called (tested) — no user-facing reason to show it.
- Every sats figure on the screen goes through `SatsBadge`; no proofs, secrets, keys or preimages
  are rendered (tested). No `console.*`, no `window.location`, no storage APIs, no mocks, no
  innerHTML-style APIs in the source (a source-grep test enforces it).

## States (Storybook `Screens/Wallet`, 27 stories × 2 themes = **54 PNGs** in `artifacts/screens/wallet/`)

| Story | How | What you see |
|---|---|---|
| Loading (skeletons) | `latencyMs: 5000` | skeleton cards, no actions |
| Populated (balances per mint, history) | seeded `MockWallet` (7 history entries), 3 mints | 3,200 sats across 2 of 3 mints, a "No balance at this mint" row, history with Markdown memo |
| Populated — auto top-up on | + `autoTopUp { 500, mint b }` | On pill, summary line, fields shown |
| Empty — no balance (failWith no-balance) | `failWith: 'no-balance'` | "Your wallet is empty", every row "No balance at this mint", Withdraw disabled, no history |
| Empty — no history yet | stock mock | 2,100 sats, "No transactions yet" |
| Empty — no mints configured | wallet `{}` + no default mints | "No mints yet" → Open Settings |
| Web portal — wallet key unlocked in the page | `platform: 'web'`, no signSecret | the two capability lines differ |
| Fund — pick mint and amount | `intent: fund(mint c)` | form, mint c selected |
| Fund — invoice QR, waiting for payment | `intent: fund(b, 5000)`, full-length bolt11 | QR, countdown 10:00, text, Copy / Open in wallet |
| Fund — paid (ecash minted) | `quotePollsUntilPaid: 1` | "Payment received", +5,000, toast, total 8,200 |
| Fund — invoice expired | quote expiry in the past | "Invoice expired" + New invoice |
| Error — could not create an invoice | `mintQuote` rejects | ErrorState + Retry + Change mint or amount |
| Error — mint unreachable while waiting | `pollQuote` rejects ×3 | "The mint is not answering" + Check again |
| Withdraw — paste an invoice | `intent: withdraw(a)` | form |
| Withdraw — not a Lightning invoice | invoice `me@wallet.example` | inline "Lightning addresses and LNURL are not supported" |
| Withdraw — fee shown before confirm | invoice for 1,500 | amount / reserve / total, "Withdraw up to 1,515 sats" |
| Withdraw — not enough at this mint | invoice for 5,000 at a 2,100 mint | danger notice, confirm disabled |
| Withdraw — sent | `play` clicks confirm | "Payment sent" + Sent / fee / change + toast |
| Withdraw — payment did not go through | `melt` → `paid: false`, `play` clicks | ErrorState + Try again |
| Error — relay down | `failWith: 'relay-down'` | page ErrorState "Relay down" + detail + Retry |
| Error — no signer | `failWith: 'no-signer'` | signed-out state |
| Error — no seeders (wallet unaffected) | `failWith: 'no-seeders'` | identical to populated |
| Error — balance and history unavailable | `balances`/`history` reject | compact errors in both cards |
| Error — auto top-up not saved (rolled back) | `updateSettings` rejects, `play` toggles + saves | Off again + sticky error toast |
| Signed out | `signedIn: false` | "Sign in to use your wallet" + Connect signer |
| Header chip — balance | three `WalletChip`s | 2,100 sats · 48k sats · loading |
| Header chip — streaming while playing | `satsPerMin: 14` | + "streaming 14 sats/min" |

Sheet/toast stories wrap the screen in a `transform: translateZ(0)` frame (story-only) so the
screen's `position: fixed` sheet and toasts are laid out inside the captured frame. Two stories
need a click (confirm, save): their `play` functions use plain DOM calls (no test addon), and the
PNGs show the post-click state.

## Tests (`__tests__/wallet.test.ts`, 55 tests, all green, 3 consecutive runs; `npm run ci` exit 0 = 63 files / 752 passed / 27 skipped)

- structure/identity: landmark + `h1`, `aria-busy` skeletons and no wallet call before identity;
  signed-out + `no-signer` → sign-in state → settings, wallet never read; relay-down alert with
  detail + Retry, no `console.error`; `no-seeders` unaffected; unmount mid-load → nothing called
- balances: total, 3 rows with hosts/balances, "No balance at this mint" → Top up opens the sheet
  on that mint; no-balance empty state + disabled Withdraw; no mints → Settings; live `onChange`
  updates + unsubscribe on unmount; balance failure → compact error → Retry recovers
- history: order, labels, direction labels, relative time; Markdown memo with hostile input
  (no `<img>`, `<strong>` rendered); empty; mint filter → `history({ limit, mint })`; failure
- fund: chips + preset + Create → `mintQuote(b, 5000)`; QR `role=img`, label, viewBox =
  modules + quiet zone, rects; textarea = bolt11; `href` = `lightning:` link; countdown; **amount
  badge precedes the QR**; invalid amount → no quote; polls ×2 → paid, toast, total 8,200,
  balances re-read; PAID-not-issued copy; **close stops polling**; **unmount stops polling**, no
  errors; expiry → exactly one final poll → expired → New invoice; quote failure → Retry + back
  to form with the mint marked unreachable; 3 failed polls → not answering → Check again → paid;
  deep link requests at once
- withdraw: '' / address / LNURL / on-chain / too short refused with the right copy and **no
  `meltQuote`**; `LIGHTNING:` + upper-case + spaces normalised; amount / reserve / total badges
  and **total precedes the confirm** in DOM order, `melt` not called; confirm melts **the same
  quote object**, "Payment sent", change shown, preimage never shown, balances re-read, toast;
  insufficient → disabled + alert; `paid: false`; melt throws; Back/Cancel never melt; deep link
  stops at confirm; expired quote → no confirm, Get a new quote; close ignored while paying
- auto top-up: on + threshold + mint → `updateSettings({ autoTopUp: { belowSats: 800, fromMint } })`,
  **On before the adapter answers**, success toast; **failure rolls back** + `role=alert` toast;
  off → `belowSats: 0`; invalid threshold → no save
- signer mode (signSecret / not), web note, no platform claim on `mock`; `p2pkPubkey` never
  called, nothing proof/secret-like in the DOM
- `WalletChip`: label, rate only while > 0, click, static, compact, skeleton
- helpers: bolt11 shape (lnbc/lntb/lnbcrt, case, prefix, wrap, rejects lnurl/on-chain/injection),
  mint-answer check, QR payload alphanumeric + size, runs = dark modules + finder corners,
  back-off sequence `[2000, 3000, 4500, 6750, 10125, 15000, 15000, 15000]` and no-hammer floor,
  countdown/parse/predicate, error copy, history labels; source-hygiene grep

## Design choices (react to the PNGs)

- YouTube-Studio-like page: title + one-line subtitle, primary actions top-right (**Add funds**
  accent, **Withdraw** secondary), a main column of bordered cards and a 360 px settings column
  that stacks under 960 px. Copy is sentence case and says what to do next.
- The big number is the total; per-mint detail is `MintChip` rows (the mint is always shown —
  T8). "No balance at this mint" is warning-tinted text + a Top up button rather than a full
  `EmptyState` per row (three stacked empties read as broken).
- Money moves happen in right-side `Sheet`s, one decision per step; the QR sits on a white tile
  in both themes.
- History looks like a bank statement: tinted icon, title, "mint · time", signed amount.
- No looping animation on the "waiting" dot (static warning/success colour) — motion stays
  ≤ 200 ms.

## Assumptions / things I was unsure about

- **Auto-request on a fund deep link** (mint + amount → invoice at once). A quote moves no money
  and the user's click happened upstream; if the orchestrator prefers a second click, drop
  `autoRequest` in `openFund` (one line).
- **"Off" = `belowSats: 0`** until the contract can express it (note 1). The auto-top-up
  *engine* must honour that.
- **Polling stops when the sheet closes** (as briefed). A payment made after closing is minted
  only when something polls again — that belongs in the wallet implementation (note 2).
- **Mint-answer check is prefix-only**, user-input check is strict — because `MockWallet`'s
  bolt11 contains a hyphen (see the contract note's mock section).
- **`lightning:` link** is an `<a>` wearing L4's `nf-button` classes (a `Button` is a `<button>`,
  and navigating to a URI scheme from a click handler would need `window.location`). The
  bolt11 is normalised first; the scheme is fixed, and React escapes the attribute.
- **Inputs**: L4 has no text-field component, so the amount/threshold/invoice fields are native
  `<input>` / `<textarea>` / checkbox styled in `Wallet.css` with tokens. An L4 `TextField` would
  replace ~60 lines of CSS here and serve Studio/Settings.
- **Toasts** are rendered by the screen's own `ToastStack` (ScreenProps has no toast channel).
  If the shells mount a global stack, a `toast` callback in `ScreenProps` would replace it.
- **Clock**: `clock` defaults to `Date.now()/1000`; the countdown ticks once a second only while
  a quote is on screen. Expiry is read as unix seconds (NUT-04/05); `expiry <= 0` = no expiry.
- **`adapter` identity** assumed stable for the life of the screen.
- **Screenshots**: taken with `NUTFLIX_CHROMIUM=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`
  (plain launch, throwaway profile) — the script's default path does not exist on this box. No QR
  decoder is installed here, so scannability is argued, not measured: uqr's own `renderSVG`
  uses the same `data[row][col]` mapping, the run test proves the rects equal the matrix, and the
  finder patterns sit at the three expected corners. Worth one phone scan of
  `Wallet--fund-invoice--dark.png` before release.

## Deviations from the task text

- History is not a contract gap (`Wallet.history` exists), so no placeholder: the real list ships.
- Extra states beyond the brief's list: PAID-not-issued, unreachable-while-polling, expired melt
  quote, insufficient-at-mint, signer mode / web platform, save-failed rollback.
