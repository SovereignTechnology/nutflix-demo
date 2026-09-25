# 12. The desktop money plane: the host spends, the worker asks

Date: 2026-09-24

## Status

Accepted for Stage 3 (lane "desktop runtime", branch `stage-3/desktop-runtime`). Implemented and
tested end to end. The signer connect flow that opens the money plane for a real user is ADR 0013
(`stage-3/desktop-signer`).

## Context

The desktop app splits into processes (L6 design §1): Electron main, a Node **host** (nostr,
settings, wallet) and a Bare **worker** (swarm, seeder, playback, the viewer payer). In Stage 1
payments were mocks behind `--dev-mocks`. Real payments need the user's wallet (build-plan A6: a
NIP-60 wallet on their relays, NIP-44 to self) and the Stage 2 engines, and they cross that
process boundary: the worker downloads and serves blocks; only the host has the signer, the relays
and fetch. The worker also handles peer data, so it must not be able to spend on its own.

## 1. Where things run

|        | Host (money plane, `host/money.ts`)                                                        | Worker (`worker/pay/real-providers.ts`)                                                                                 |
| ------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Wallet | `CashuWallet` over `Nip60ProofStore`; wallet key from kind 17375 (signer or secure memory) | none                                                                                                                    |
| Viewer | `RealPaymentEngine` (viewer side) builds every PAY                                         | `ViewerPayer` / `UpstreamPayer` decide WHEN to pay and ask `pay.build`                                                  |
| HELLO  | signs a kind-HELLO over a `pay/1` challenge (`pay.hello`)                                  | builds the HELLO around the signature                                                                                   |
| Seeder | redeem, NUT-07 checks, keysets (rate-limited), nutzaps (`seller.*`)                        | `RealPaymentEngine` (seeder side — its upload accounting is synchronous), pending PAYs + seen secrets in worker storage |

The seeder engine stays in the worker because `recordUpload` / the upload gate are synchronous;
every step that moves money is an async host call. The pending-PAY and seen files are written by
the worker (`StateFs`, synchronous, 0600); their proofs are P2PK-locked to the user's wallet key or
the creator's, so a copy spends nothing.

## 2. Authorisation: the host is the money boundary

Everything the worker asks is re-validated by the IPC guards (`ipc/worker-guards.ts`) and then
authorised by the money plane:

- **`pay.build`** only for a play session the host registered itself (`authorizeSession`, called
  by the adapter BEFORE the worker opens the core; revoked when the session closes), only for
  that session's core and blob block range, only on its manifest terms (creator key, split, block
  size, the video's mints; a price at most the manifest's), and only up to a budget of twice the
  blob's blocks plus one window (headroom for duplicate deliveries, security review F33). A
  compromised worker cannot pay a stranger, pay for another video, or drain the wallet.
- **`pay.hello`** signs `{kind: PAY_HELLO, tags: [["challenge", c]], content: ""}` for a `c`
  shaped like `helloChallenge()`'s output (`pay/1:<handshake hash>:<noise key>`) — nothing else.
- **`seller.*`** act only at the wallet's own mints. `redeem` returns `{ok, sats}` or
  `{ok: false, spent}` (a spent proof is data: the IPC error codes are a closed set, and the
  engine needs to tell a double-spend). A nutzap goes to a creator the host has seen in a manifest;
  the creator share of the user's OWN video is redeemed straight into the wallet.
- Missing money plane (no signer, `--dev-mocks`): every money call is answered
  `payments-unavailable` by the supervisor.

## 3. The NIP-60 wallet key is never created by accident

`openNip60Wallet` (core) creates a new wallet key only with `create: true`. An empty relay answer
also means "relays unreachable", and kind 17375 is replaceable: creating on a mere miss would
replace the user's real wallet event and strand every proof locked to the old key. The host never
creates at startup; with no wallet found, payments stay off and the log says so. Creating one is
an explicit user action (the Wallet screen, next lane).

## 4. Per-core prices on the wire

The shared `UpstreamPayer` pays a seeder's asking price (HELLO, or a per-core `PRICE`) when it is
not above the manifest price, and nothing otherwise. A one-price seeder (daemon, gateway) states its
price in HELLO. The desktop serves several videos at their own manifest prices, so its HELLO states
a ceiling and `Seeder` gains `announceCorePrices`: the first block of a core sent to a `pay/1` peer
is preceded by `PRICE { core, satsPerBlock, effectiveFromBlock: 0 }` (sent from the synchronous
upload hook, before the block is written). A payer keeps blocks owed while the asked price is
above the manifest, so no block is ever paid at the wrong price.

## 5. Other changes

- `WorkerInit.payments` (the user's public pubkey, wallet P2PK and mints) turns the real providers
  on; never together with `dev.mocks` (guarded). The worker's HELLO is async and bound to the
  connection (`PayWiring.hello(binding)`).
- Core gains `wallet.openNip60Wallet` / `publishNutzapInfo` (kind 17375 / 10019),
  `wallet.guardedKeyset` and `nostr.nutzapPublisher` / `announceNutzapInfo` (moved from the seeder
  runtime so the host can use them without loading `@sovit/seeder`, whose entry pulls corestore
  and native addons — design D2's reason not to load `pear-runtime` in the host).
- The host logs only an error's code prefix when the wallet cannot open.
- `WorkerHostOptions.testBootstrap`: a programmatic, test-only local DHT for a worker with real
  payments (never reachable over IPC, never set by `entry.ts`).
- Addendum 2026-09-24 (security review F17): mint quote ids stay in the host. `wallet.mintQuote`
  answers the renderer with an opaque handle (`quoteId: "h…"`, 128 random bits), `wallet.change`
  quote events carry the same handle, and `wallet.pollQuote` resolves it to the quote the host
  stored — the renderer's copy (mint, amount) is never used. Handles are scoped to the wallet that
  issued them: a signer change forgets them all, and a quote still being made when it happens is
  refused. At most 256 are kept. Core locks the quotes themselves with NUT-20 where the mint
  supports it.

- Addendum 2026-09-25 (issue #2, security review F4; Cameron 2026-09-24): **auto top-ups
  execute** — `host/topup/auto-topup.ts`, with the user's real wallet only (with `--dev-mocks` a
  due top-up is still only logged). When a payment is about to draw from a mint (a balance change,
  or a play with nothing to pay with) whose balance is below `Settings.autoTopUp.belowSats`, the
  host runs `mintQuote(target, amount)` → `meltQuote(fromMint, bolt11)` → `melt` → `pollQuote`
  at the target. The rules, each refusing before anything moves:
  - **off by default** (absent, or `belowSats <= 0`); the target is on the user's own list
    (`defaultMints`) and never `fromMint` — a mint first seen in a manifest is never topped up;
  - **one at a time**: a second trigger for the same mint joins the top-up in flight, any other
    is refused; attempts are at least a minute apart, a failure backs off 1 min … 1 h (doubling),
    a declined question backs that mint off for an hour — no retry per payment, no storm;
  - **caps**: `amountSats` (1 … `AUTO_TOP_UP_MAX_SATS` = 10 000, absent = the max) per top-up;
    at most `AUTO_TOP_UP_MAX_SATS_PER_DAY` = 50 000 in any rolling 24 h counting what actually
    left the source (fees included) plus everything in flight (amount + fee reserve + an
    input-fee allowance). Fees above 5 % (10-sat floor), or a melt quote for a different amount
    than the target invoiced, are refused;
  - **the ledger** (`host/topup/ledger.ts`, userData `auto-topup.json`, atomic, 0600) persists
    the entries and the allowed mints across restarts. It fails CLOSED: a corrupt, unknown or
    out-of-shape file is copied aside and replaced by a marker that counts the whole daily cap
    (top-ups pause 24 h, allowances are forgotten); if even that cannot be written, every top-up
    is refused for the run. A reservation is persisted before the melt; a melt that fails or is
    not paid stays counted;
  - **the first funding of a mint** is asked in main's trusted prompt window (ADR 0013,
    `PromptForm` `top-up-first`: target, source, amount — data only, the page shows hosts and
    states the caps; default "Not now"). Only an explicit yes is remembered, per mint, in the
    ledger; no, a closed window or the prompt's 5-minute deadline moves nothing. The prompt
    window therefore exists whenever real money can move (also with an injected signer), never
    with `--dev-mocks`;
  - **history**: minting writes `in … "top-up"` at the target and the melt `out … "melt to
    Lightning"` at the source; nothing more is written. Core's melt takes no memo
    (docs/contract-requests/S3-topup.md), so the host shows that melt as "top-up" by the id the
    ledger recorded.
  Main's settings gate (F4/F8) now also asks when `amountSats` changes, and its question states
  the amount, the daily cap and the first-time confirm.

## Consequences

- With a signer, the desktop pays and is paid for real: tested end to end — the worker (real
  framed wire and guards) streams a video byte-exact from a seeder daemon over hyperswarm, the host
  builds and signs every payment from the user's NIP-60 wallet, the seeder is paid for every block,
  and the creator's share is nutzapped.
- Next: the signer connect flow (trusted passphrase prompt in main, file `KeyStore` at 0600 —
  F24's desktop half, the Settings bridge, `createWallet` from the Wallet screen), and restarting
  the worker when the signer connects, locks or signs out.
