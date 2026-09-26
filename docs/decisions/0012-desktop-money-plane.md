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
  due top-up is still only logged). When a payment is about to draw from a mint whose balance is
  below `Settings.autoTopUp.belowSats`, the host runs `mintQuote(target, amount)` →
  `meltQuote(fromMint, bolt11)` → `melt` → `pollQuote` at the target. "A payment is about to
  draw" means the payment path only: a play opening (`checkBalance`) and a PAY the money plane
  builds for an open play session (`MoneyPlaneOptions.onPayment`, after the PAY's authorisation).
  A wallet balance event never starts one — it is also the user's own withdrawal, send or nutzap,
  or a seeder melt (independent review, finding 1). The rules, each refusing before anything
  moves:
  - **off by default** (absent, or `belowSats <= 0`); the target is on the user's own list
    (`defaultMints`) and never `fromMint` — a mint first seen in a manifest is never topped up;
  - **one at a time**: a second trigger for the same mint joins the top-up in flight, any other
    is refused; attempts are at least a minute apart, a failure backs off 1 min … 1 h (doubling),
    a declined question backs that mint off for an hour — no retry per payment, no storm;
  - **caps**: `amountSats` (1 … `AUTO_TOP_UP_MAX_SATS` = 10 000, absent = the max) per top-up;
    at most `AUTO_TOP_UP_MAX_SATS_PER_DAY` = 50 000 in any rolling 24 h counting what actually
    left the source (fees included) plus everything in flight (amount + fee reserve + an
    input-fee allowance). Fees above 5 % (10-sat floor), or a melt quote for a different amount
    than the target invoiced, are refused. Input fees past the allowance (a source holding its
    balance in many small proofs) cannot be seen before the melt with the current `Wallet`
    contract (contract request S3-topup 3); they are counted afterwards — from the melt's own
    history line, or else the whole reservation or the source's balance drop, whichever is larger;
  - **still wanted**: right before the reservation and again right before the melt, the run
    re-reads the settings (still on and due, the same source and amount, the target still on the
    list) and requires the same wallet it started with; the host hands it the money plane's
    `liveWallet`, `undefined` once the plane is closed (signed out, locked, another signer), so a
    top-up whose question stayed open while the user signed out moves nothing;
  - **the ledger** (`host/topup/ledger.ts`, userData `auto-topup.json`, atomic, 0600) persists
    the entries and the allowed mints across restarts. It fails CLOSED: a corrupt, unknown or
    out-of-shape file is copied aside and replaced by a marker that counts the whole daily cap
    (top-ups pause 24 h, allowances are forgotten); if even that cannot be written, every top-up
    is refused for the run. A reservation is persisted before the melt; a melt that fails or is
    not paid stays counted;
  - **the first funding of a mint** is asked in main's trusted prompt window (ADR 0013,
    `PromptForm` `top-up-first`: target, source, amount — data only, the page shows hosts and
    states the caps; default "Not now"). Only an explicit yes is remembered, per mint, in the
    ledger; no, a closed window or the prompt's 5-minute deadline moves nothing, and neither does
    a yes the ledger cannot record — each backs that mint off for an hour, so it is not re-asked
    after every failure backoff. The prompt window therefore exists whenever real money can move
    (also with an injected signer), never with `--dev-mocks`;
  - **per install, not per identity**: the allowed mints and the daily cap live in one userData
    ledger, like `settings.json`: after a signer switch another identity's wallet tops up into a
    mint the first identity allowed without a question of its own, and both identities share one
    50 000-sat budget per rolling 24 h. The same model as the settings the top-up reads
    (`defaultMints`, `autoTopUp`), which are per install too;
  - **history**: minting writes `in … "top-up"` at the target and the melt `out … "melt to
    Lightning"` at the source; nothing more is written. Core's melt takes no memo
    (docs/contract-requests/S3-topup.md), so the host shows that melt as "top-up" by the id the
    ledger recorded. Those ids are a list of their own (the newest 256, bounded by the ledger's
    guard), never pruned by the 24-hour window, so this device keeps the label after a day.
  Main's settings gate (F4/F8) now also asks when `amountSats` changes, and its question states
  the amount, the daily cap and the first-time confirm.

- Addendum 2026-09-25 (lane I2-paygate; a fund-loss path the residuals lane's round-3 verifier
  found): **PAY builds and melts at one mint never overlap.** Core runs a wallet's operations at
  one mint one at a time (`Spender.exclusive`), and a melt holds that turn until the mint has paid
  the invoice — up to 300 s since issue #8 fix round 3. The worker gives `pay.build` 300 s, and
  the host cannot cancel a request once it started. A PAY queued behind a long melt was built
  after the worker had given up: the viewer's proofs were swapped into P2PK sets locked to the
  seeder and the creator, never delivered, with no refund path. The verifier reproduced the core
  half: a send finishing after a 300 s caller deadline, balance 96 → 61. The money plane now has
  a per-mint gate (`host/pay-melt-gate.ts`):
  - **a melt** marks its mint. PAY builds waiting their turn there are refused, the one in flight
    is waited for, then it melts, and the mark clears however the melt settles (paid, unpaid,
    thrown, timed out). It waits at most the worker's deadline, then is refused without melting;
  - **a PAY** is refused at once while its mint is marked, before any wallet call (`rate-limited:`,
    nothing spent, its blocks returned to the session budget, no `onPayment`);
  - **PAY builds at one mint take turns** in arrival order. Core would run their wallet calls one
    at a time anyway, and the wait for a turn becomes visible in the host. At its turn a PAY
    re-checks the plane (not closed) and its session (still open);
  - **the belt**: a PAY that has not reached the wallet `PAY_BUILD_START_BY_MS` after its request
    arrived is refused (`rate-limited:`), measured on a monotonic clock whose readings have their
    own type (`Arrival`), so a wall-clock time cannot be passed in by mistake.

  Every desktop melt goes through the gate, because the plane's wallet is `GatedCashuWallet`
  (core's `CashuWallet` with `melt` overridden). That covers the renderer's `wallet.melt`
  (dispatch → the adapter's wallet, the plane's own or through `SwitchingWallet`) and an auto
  top-up's funding melt (`liveWallet`). A top-up melt the gate refused moved nothing: its ledger
  entry is `failed`, not `unknown`. The worker's `seeder.melt` stays refused
  (`payments-unavailable`), so the host runs no seeder-earnings melt. A test fails if core's
  `CashuWallet` grows another melt-like method.

  **The numbers** live in `ipc/deadlines.ts`, shared by the host and the worker:
  - the worker's deadline for any host request, `WORKER_HOST_REQUEST_TIMEOUT_MS` = 300 s (the
    `WorkerRpc` default; the worker entry sets none of its own);
  - `MELT_REQUEST_TIMEOUT_MS` = 300 s and `MINT_REQUEST_TIMEOUT_MS` = 30 s, now passed to the host
    transport explicitly (the same values as core's defaults);
  - `PAY_BUILD_WORST_MS` = 5 mint round trips × 30 s + 6 relay publishes × 7.4 s = 194.4 s: the
    host's worst for one PAY build outside a melt, alone at its mint, with no journal entries
    left there (the round-4 addendum below: entries left there lengthen it, so the belt is per
    PAY). The round trips are one mint load, then two sends, each a swap and one follow-up.
    The publishes are each send's token, deletion and history events; 7.4 s is nostr-tools' 3 s
    to connect plus 4.4 s for the relay's answer, pinned against the library;
  - `PAY_BUILD_START_BY_MS` = 300 s − 194.4 s = 105.6 s.

  A test pins that the deadline exceeds the worst time and that the belt leaves a PAY that starts
  in time its whole worst time.

  **The worker** treats every failed PAY as retryable, as before: the blocks stay owed, the
  session stays up, and nothing reaches the seeder, so its window is never exceeded and there is
  no ban. After a `rate-limited:` answer the viewer payer also pays what is owed again by itself,
  on a backoff (2 s, doubling up to 30 s, reset by a PAY that goes through). With every credit
  unit held by owed blocks, no download, ACK or pressure event may come to trigger that retry.
  Streaming at that mint pauses during a melt and resumes after it.

  Left as it was: the model leaves out a NIP-46 bunker's own latency when the wallet's events are
  signed, and wallet operations that are not PAYs or melts at the same mint (a redeem, a NUT-07
  check, a top-up's mint at the target, the settle loop). Each of those is a few 30 s round
  trips, and core's queue does not show them to the host. Closing that fully needs core to check
  a deadline when it grants the turn (a locked path); see `docs/reviews/2026-09-25-pre-push-pay-melt-gate.md`.
  A withdrawal made while a PAY is in flight waits for that PAY, up to 300 s at the worst, with
  nothing on screen to say why.

- Addendum 2026-09-25 (cross-lane review round 4; lanes I2-paygate × issue #2 auto top-up ×
  issue #8 residuals): **the belt is per PAY, and an auto top-up whose melt may have paid keeps
  its quote.**
  - **The belt counts the journal entries at the mint** (the I2 verifier). Each of a PAY's two
    P2PK sends first settles every journal entry at its mint (`Spender.settle`: a NUT-09
    restore, then a NUT-07 check), and the gated melt is exactly what leaves one: a melt that
    timed out, lost its answer or was answered PENDING stays journaled until the mint can say —
    hours, for a stuck payment. Measured: every PAY after such a melt made 6 mint requests where
    the model counted 4. The worst time is now `payBuildWorstMs(entries, loaded)`: the mint load
    (1 round trip, none once the plane has loaded that mint), plus per send its swap and
    follow-up (2) and `PAY_BUILD_SETTLE_ROUND_TRIPS_PER_ENTRY` (2) per entry, × 30 s, plus the
    6 publishes. An entry the PAY's own settle resolves costs no more (restore, check and one
    commit's three publishes, 82.2 s, under the 120 s it would otherwise cost). At its turn a
    PAY reads the entries at its mint (the plane holds the store) and must start within
    `payBuildStartByMs` = min(105.6 s, 300 s − that worst time): 15.6 s with one entry at a
    loaded mint; none — every PAY there refused, `rate-limited:`, retried by the worker — with
    one at a mint not loaded, or two. `payBuildWorstMs(0, false)` is still the pinned 194.4 s,
    and no PAY gets longer than the old belt. `PayMeltGate.pay` takes the per-PAY bound as a
    function read at the turn; a bound that is not a number, or throws, refuses.
  - **An open top-up.** A funding melt that throws ambiguously (a lost answer, the 300 s
    timeout, a 429, a result commit that failed after the mint paid, the plane closing mid-melt)
    or answers PENDING may still pay the target's invoice after the run gave up — and the next
    PAY then started a second top-up (reproduced: Lightning paid twice, one paid quote never
    minted). Now the target's quote is kept BEFORE the melt, on the ledger entry
    (`TopUpLedger.attach`: the entry's `owner` and `open`), and stays whenever the melt may have
    run. The run's retry, every later trigger (also one that is not due, or with the top-up
    turned off), and `AutoTopUp.resume()` — which the host calls when a money plane opens, so a
    restart, an unlock or a signer swap back finishes it — mint it exactly once when the target
    says PAID (core's journaled `pollQuote`), and release it only when the melt is settled as not
    paid (no journal entry at the source, and the source mint's own quote state UNPAID) while the
    quote is still UNPAID. The entry then stays counted: the melt did reach the mint. No new
    top-up runs into a target whose earlier one is open (`unresolved`). When the journal settles
    the melt as paid, its history line — found by an anchor the record keeps — is recorded and
    reads "top-up" (core's settled memos are recognised), and the entry says `done`. A top-up
    minted while its melt is still unresolved stays open (`minted`) only to find that line; it
    no longer holds anything back. Only its own identity finishes an open top-up.
  - **Where it is kept, and why sealed.** A quote id alone is a read handle for a quote the mint
    locked to the wallet key (NUT-20: minting takes a signature by that key), but bearer money
    for one it did not — whoever presents the id first mints the paid amount — and a signer-held
    wallet key (`signSecret`) cannot lock one. So the record (the quote, the source's melt quote
    id, the anchor) is sealed to the identity by the money plane (`MoneyPlane.topUpVault`:
    NIP-44 to self through the signer, how the NIP-60 proofs themselves are kept) before it is
    written. It lives on the ledger entry rather than in the sealed wallet journal: the journal's
    body is core's exact format (every entry a `PendingOp`), so a record there needs a core
    change, and the ledger entry must change together with it (`unknown` → `done`, the label).
    The ledger never prunes an entry with an open top-up (it stops counting after 24 h), keeps at
    most `MAX_OPEN_TOP_UPS` = 16, reads the record back strictly, and a record that does not
    unseal is kept, never minted or released.
  - **Provably nothing sent** is not `unknown`: besides `insufficient-funds` and the gate, core's
    refusals before its melt request (the melt quote could not be read, the mint changed its
    amount or raised its fee reserve, an earlier melt of the quote is unresolved) settle
    `failed`, matched on core's code and message (a changed message reads "may have run"). A
    coded refusal after the request is worded like a melt that may have run, so it stays
    `unknown` — its quote is released once the source says UNPAID.
  - **The startup settle first**: a run, and a trigger's finishing of open top-ups, wait for
    the plane's `recovery` before reading a balance.
  - **A play at zero balance waits a bounded time**: `PLAY_TOP_UP_WAIT_MS` = 15 s for open
    top-ups to finish, then 15 s once past the first-funding question (the user's own, bounded by
    the prompt's 5 minutes). A slower top-up (a melt may take 300 s) finishes in the background
    and the play fails `no-balance` ("a top-up is on its way …"), to be retried.

- Addendum 2026-09-26 (fix round 5, the verifier of round 4): **a play has one bound, a quote is
  never released right after its melt, and an invoice long expired releases its quote.**
  - **One bound for a play** (replaces round 4's "15 s, then 15 s once past the question"):
    `PLAY_TOP_UP_WAIT_MS` = 15 s in all, from the moment the play asks. It covers open top-ups
    finishing, the startup settle the run waits for, the run's own finishing of open top-ups,
    the quotes, the melt and the polls. Only the time the first-funding question is open is set
    aside (the user's own, bounded by the prompt's 5 minutes). Before, the run's wait for the
    settle and its own finishing were not bounded: with the startup settle spending 30 s per
    request at a blackholed mint, a play waited all of that and then 15 s more.
  - **No release right after a melt** (R4-R2's gap): an open top-up is released no sooner than
    `TOP_UP_RELEASE_AFTER_MS` = 600 s (core's `PENDING_SETTLE_AFTER_S`) after its melt returned,
    a time kept in memory. After a restart it counts from the latest the melt can have returned:
    the reservation plus `MELT_REQUEST_TIMEOUT_MS`. A melt request the transport gave up on but
    that reaches the mint within that time is marked PENDING there before the release reads the
    source. Minting a quote the target says PAID never waits. This is not done by pacing the
    trigger (`lastResolve`), because that would also hold back minting a paid quote at the next
    play.
  - **An invoice long expired releases its quote**: an open top-up whose target still says
    UNPAID `TOP_UP_EXPIRED_RELEASE_AFTER_MS` = 24 h after the later of the quote's expiry and the
    reservation is released even when the source cannot say the melt did not pay (still
    journaled, PENDING, or the mint gone for good). An expired invoice can no longer be paid. The
    margin covers clocks that disagree, and a target that reads its stored UNPAID while its own
    Lightning backend cannot be asked. It settles `unknown`, never `failed`. A source that says
    PAID keeps it (the target owes it), and so does a quote without an expiry (0).
  - **Still kept, with no in-app way to clear it**: a target that forgets the quote (not found),
    a target that says UNPAID while the source says PAID, a quote without an expiry, and a record
    that does not unseal (R4-R1). Each holds back auto top-ups into its target for that identity;
    manual top-ups are unaffected.

## Consequences

- With a signer, the desktop pays and is paid for real: tested end to end — the worker (real
  framed wire and guards) streams a video byte-exact from a seeder daemon over hyperswarm, the host
  builds and signs every payment from the user's NIP-60 wallet, the seeder is paid for every block,
  and the creator's share is nutzapped.
- Next: the signer connect flow (trusted passphrase prompt in main, file `KeyStore` at 0600 —
  F24's desktop half, the Settings bridge, `createWallet` from the Wallet screen), and restarting
  the worker when the signer connects, locks or signs out.
