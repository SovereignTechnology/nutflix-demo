# Security review — Stage 2 (PART B)

Date: 2026-09-23. Reviewer: the Stage 2 session (`stage-2/2026-09-23`, on top of `stage-1`).
Scope: the seams listed in `docs/prompts/stage-2-security.md` PART B, plus the residual risks of
the five modules Stage 2 implemented (signer, `wallet/spend.ts`, payment, pay-protocol,
gateway auth). There is no web portal; only the gateway's web-facing responses were reviewed.

Method: every claim below was checked against the source at `f398f9f` (file:line references are
to that tree), and against measurements where a number is given. Findings are ranked by what an
attacker gains and how cheaply. Each finding carries a concrete fix and a test. PART B forbade
fixes outside the five Stage 2 directories; on 2026-09-24 Cameron asked for the fixes, and **§0
records what was fixed and what is still open** (filed as `stage-3` issues, §6).

**Exposure today is nil for the money findings.** No runtime provider is wired: the desktop
worker, the seeder and the gateway CLIs all refuse to start without `--dev-mocks`
(`*/providers.ts` return `undefined`), so no real ecash moves until Stage 3 wires the Stage 2
modules in. F1–F4 and F30 were the **Stage 3 blockers**; all five are fixed (§0).

## 0. Status after the review fixes (2026-09-24, branch `stage-2/review-fixes`)

Cameron asked for the fixes on 2026-09-24, which lifts PART B's "do not fix outside the five
directories" for this list. Each fix carries a test that fails without it, except where noted.

| ID | Status | What changed |
|---|---|---|
| F1 | **Fixed** | `UpstreamPayer`: the seeder's asking price (HELLO or `PRICE`) may only lower the manifest price; above it nothing is paid (`skippedOverpriced`) |
| F2 | **Fixed** | `manifestPolicyResolver` replaces `helloPolicyResolver`: per-core manifest policy or no payment; split from the manifest; mint ∈ seeder ∩ wallet ∩ manifest |
| F3 | **Fixed** | Every Blossom response: `nosniff` + `CSP: sandbox`; only inert types inline (`servedAs`), everything else an `octet-stream` attachment; upload MIME allowlist by default (explicit `null` = any) |
| F4 | **Fixed (policy)** | `autoTopUpDue` tops up only mints in `defaultMints`, and now follows the v5 direction (it had it backwards); contract text says so. Executing top-ups (with caps) is Stage 3 |
| F5 | **Partly fixed** | Proofs per set capped at `bitLength(amount) + 6` (`maxProofsFor`); one unacknowledged PAY per core batches PAYs naturally (F30); DLEQ checks off the event loop for the seeder daemon and the gateway — a `worker_threads` pool behind `PaymentEngineDeps.dleq`, failure falls back to the synchronous check (`stage-3/dleq-batching`, ADR 0011 §10). Explicit batching tied to the credit pool: PAYs cover half the pool per seeder, all pending paid under pressure, short tails after 2 s (`stage-3/upstream-credit`, ADR 0011 §11). Open: the desktop's Bare worker still checks DLEQ inline; the credit pool stays at the minimum window (a per-seeder window would batch more) |
| F6 | **Verified on Nutshell 0.21.0 and cdk-mintd 0.18.1** (2026-09-24, `stage-3/real-mint`) | Both mints accept the `pay1` tag and still refuse the set without the creator's witness; the whole pay/1 path, three seeders, double-spends and a network drop pass against both (§0a) |
| F7 | **Fixed** | `studio.upload` asks with a native dialog naming the file main resolved from the token |
| F8 | **Fixed** | The money gate is a native dialog (`dialog.showMessageBox`, Cancel default) built from guarded args; `seeder.melt` cross-checks the invoice amount; settings patches that add mints or turn on auto top-up are asked about too |
| F9 | **Fixed** | The seeder records each `PRICE` boundary per session × core and verifies a PAY at the price in force for its blocks; `setCorePolicy` now announces per-core `PRICE` |
| F10 | **Fixed (seeder daemon)** (`stage-3/seeder-runtime`) | F12's `restorePending` puts the unflushed secrets back in the seen set; the daemon appends every accepted secret to `wallet/seen.jsonl` and restores the newest 250 000 at start (ADR 0011 §3). Gateway and desktop: with their runtimes |
| F11 | **Fixed (engine)**; wired in the seeder daemon | `checkSpent` dep: a spent creator set is a double-spend (ban, no nutzap) — checked once, before the first nutzap; `CashuWallet.checkSpent` provides it |
| F12 | **Fixed (seeder daemon)** (`stage-3/seeder-runtime`) | `persistPending` (synchronous, before the ACK) + `restorePending`; the daemon writes `wallet/pending.json` synchronously and atomically (fsync) and a new runtime redeems it — integration-tested with a crash before the flush. Gateway and desktop: with their runtimes |
| F13 | **Fixed** | Peer identifiers in log fields become a per-process alias (`peer#17`) |
| F14 | **Fixed** | `trustProxy` reads the rightmost `X-Forwarded-For` entry |
| F15 | **Fixed** | Uploads over 8 MiB must send `X-SHA-256` (no unauthenticated spooling of large bodies); default MIME allowlist (F3); a per-pubkey byte quota (`blossom.maxBytesPerPubkey`, default 2 GiB since 2026-09-25, `null` = none) on upload, mirror and authenticated `HEAD`, checked before a declared body is spooled, with in-flight bytes held (`stage-3/upload-quota`). Open: whether uploads should default to allow-list-only (decision) |
| F16 | **Fixed** | The gateway loads `node:http` via `createRequire`; the unit gains `--no-experimental-websocket`; a spawn test runs the built entry with the unit's flags (verified on Node 22.22.0) |
| F17 | **Fixed** (`stage-3/nut20-quotes`) | Where the mint advertises NUT-20 and the wallet key is held in the process (the NIP-60 wallet key; the seeder's is signer-held and stays unlocked), `mintQuote` locks the quote to that key and refuses an answer locked to anything else; `pollQuote` signs the mint request (cashu-ts: the amended NUT-20 message, the legacy one as fallback) and refuses a quote locked to a key it cannot sign with. Verified on Nutshell 0.21.0 and cdk-mintd 0.18.1 (one `POST /v1/mint/bolt11`, i.e. the amended signature accepted first try). The desktop hands the renderer an opaque handle (`h…`) in place of every quote id — replies and `wallet.change` events — polls by the stored quote, and forgets every handle when the signer changes |
| F18 | **Partly fixed** | The distinctive user agent is gone. Open: hash-addressed images only by default (decision) |
| F19 | **Fixed** | Watch refuses a session whose policy charges more than the quote (play and quality switch) |
| F20 | **Fixed** | `StoredReport.signatureVerified` is `true` after the auth boundary verified the report |
| F21 | **Partly fixed** (`stage-3/f21-dev-flags`) | A packaged build (`app.isPackaged`) refuses `--dev-mocks`, `--dev-fixtures` and `--e2e-hooks` and exits 78 before anything is registered, like a sandbox bypass (tested). Open, with the packaging lane: the Electron fuses (`RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments` off; `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar` on). They can only be flipped on a packaged binary, and nothing packages yet: forge/pear makers, targets and signing are decisions. No runtime check can replace them, since `NODE_OPTIONS`, `--inspect` and `ELECTRON_RUN_AS_NODE` act before main's code runs |
| F22 | **Fixed** | `app.requestSingleInstanceLock()`; a second launch focuses the first window |
| F23 | **Fixed** | `Nip60ProofStore` verifies every event itself |
| F24 | **Fixed** — seeder daemon (`stage-3/seeder-runtime`) and desktop (`stage-3/desktop-signer`) | Daemon: key file 0600 (`--keygen`, `O_EXCL`, refused when group/other can read it), headless unlock from the `seeder-key-passphrase` systemd credential (ADR 0011 §1). Desktop (ADR 0013): the file `KeyStore` writes 0600 in a 0700 dir through an `O_EXCL` temp file, reads with `O_NOFOLLOW` and refuses a symlink, another owner or a loose mode before any passphrase is asked; unlock is the user's choice — a passphrase in main's trusted prompt window, the OS keychain (`safeStorage`, never Linux `basic_text`), or a NIP-46 bunker |
| F25 | **Fixed** (`stage-3/desktop-signer`, `stage-3/external-links`) | NIP-46 approval links (ADR 0013 §7) and now every link the user clicks in the app (Markdown `target="_blank"`): main denies the window-open, then asks in its trusted prompt window, which shows the link's real host (ASCII/IDNA, so no look-alike Unicode) and warns that link text may not match its target. The browser opens main's own copy, only on "Open in browser". `https:` only (no user-info, controls or bidi characters, bounded), only from the app's own webContents, one question at a time, at most 5 a minute. Electron e2e: a clicked link shows `example.com` and Cancel opens nothing |
| F26 | **Partly fixed** | Natural batching (F30) cuts dust PAYs; explicit batching open (F5) |
| F27 | **Fixed** (real-mint lane) | Hit by the network-drop test: a new session binding a pubkey now cuts any older live session of it (no ban) — one pay/1 channel per pubkey, so the per-pubkey carry is unambiguous |
| F28, F29, F32 | Info | Recorded, no change |
| F33 | **Open (new)** | See §0a |
| F34 | **Fixed (new)** | See §0a |
| F35 | **Fixed (new)** | See §0a |
| F36 | **Fixed (new)** — seeder daemon and gateway | See §0b |
| F37 | **Fixed** (`stage-3/upstream-credit`) | `Gateway.readUpstreamBlob` fetches upstream blocks on a shared `CreditPool` settled by ACKs (`CreditSettler`); the full-speed swarm test stays inside the window, and fails with pacing disabled (ADR 0011 §11) |
| F38 | **Fixed (new)** | See §0b |
| F39 | **Fixed (new)** — desktop signer lane | See §0c |
| F30 | **Fixed** | `UpstreamPayer` keeps the carry per channel, commits it on `ACK ok`, one PAY per core in flight |
| F31 | **Fixed** (`stage-3/wallet-journal`, ADR 0014) | `spentByUs` dep: a "spent" answer to a RETRIED redeem whose witness is our own signature is our lost swap — no ban, creator still paid. A first attempt answered "spent" is a double-spend even with our witness (a set we redeemed before a restart carries it too — found by the real-mint lane); the attempt is persisted before it is made. The swapped proofs are now recovered too: a send / receive / mint journals its outputs in the store before the request, and a lost answer is restored with NUT-09 (instead of NUT-13 deterministic secrets — ADR 0014 says why). Verified on Nutshell 0.21.0 and cdk-mintd 0.18.1. Residual: the desktop's journal is in memory (a crash mid-recovery), melt change is not journaled |

## 0a. Found by the real-mint lane (2026-09-24, `stage-3/real-mint`)

Nutshell 0.21.0 and cdk-mintd 0.18.1, both with a FakeWallet backend, a real 100 ppk input fee
and v2 keyset ids — every scenario passes on both (`scripts/real-mint/README.md`); three
seeders, a viewer and real `pay/1` over Hypercore (`packages/gateway/src/__tests__/
real-mint-swarm.integration.test.ts`). Both real-mint suites are opt-in
(`NUTFLIX_REAL_MINT_URL`); `scripts/real-mint/nutshell.sh` starts the mint.

- **F33 — Medium — open: duplicate deliveries cost the viewer more than the price shown.**
  Hypercore can fetch one block from two seeders (a raced request); each seeder counts what it
  sent, and the payer pays each for it (not paying would window-cut the seeder). Measured: 29
  deliveries paid for a 24-block video when three seeders raced unpaced. The desktop credit pool
  and pacing make races rarer but not impossible. Fix options for Stage 3: cap a session's total
  at the quoted price and absorb the rare duplicate as seeder loss (their window tolerates it),
  or request each range from one peer. Needs a product decision (price shown vs. seeder fairness).
- **F34 — High — fixed: dust could never be redeemed.** At a real input fee (100 ppk → ≥ 1 sat
  per swap) a 1-sat seeder set alone cannot pay its fee (Nutshell: "no outputs provided"); the
  engine redeemed per PAY, so such a PAY sat in the retry queue forever and its creator share was
  never forwarded. The engine now redeems every accepted seeder set of a mint in ONE swap per
  flush (dust waits until the batch is worth more than its fee); a "spent" batch is attributed per
  PAY with `checkSpent`. TestMint now refuses a swap with no outputs, like Nutshell. Creator side:
  the engine now publishes ONE nutzap per creator × mint × core per flush (the F11 check runs per
  group and still bans only the PAY whose set was spent); a NIP-61 wallet should still redeem the
  nutzaps it holds together.
- **F27 — was Low, hit in practice — fixed: a reconnect while the old connection lingers.** The
  seeder briefly held two live sessions for one pubkey; the new session's rebind reset the shared
  carry and every PAY still arriving on the old channel failed `carryIn` (one run in four of the
  network-drop test). A session binding a pubkey now cuts any other live session of it without a
  ban (`SessionRegistry.supersede`; the registry tracks every live session, since a same-key
  reconnect replaces its map entry). 8/8 runs pass since.
- **F35 — Medium — fixed: a PAY from a replaced channel could break the new channel's carry.**
  A PAY sent just before a connection dropped can still be verifying (keyset fetch) when the
  viewer reconnects and the new channel's HELLO rebinds the account, restarting the carry at 0. If
  that late PAY's `carryIn` happened to match, it committed and moved the carry, and every PAY on
  the new channel then failed `carryIn` until the window cut the viewer. Seen once in the
  network-drop test. The engine now keeps a channel epoch per account (`rebind` advances it) and
  refuses a PAY queued under an older epoch (engine test fails without the fix).

## 0b. Found by the seeder-runtime lane (2026-09-24, `stage-3/seeder-runtime`)

- **F36 — High — fixed for the seeder daemon: the global `fetch` crashes a `--jitless` daemon.**
  Node 22's `fetch` is undici, whose parser is WebAssembly; the units run `--jitless`, so the
  first mint request through cashu-ts's default transport kills the process (reproduced on Node
  22.22.0; deploy/systemd/MDWE-RESULTS.md §7). Every money-path test ran in vitest, never under
  the unit's flags, so nothing had caught it. The daemon now sends mint requests over
  `node:http(s)` (`wallet.cashuRequestFn` keeps cashu-ts's error contract, which `spend.ts` needs
  to tell a double-spend); the built-entry test loads a mint over real HTTP under the unit's
  flags. The gateway's runtime uses the same transport (`stage-3/gateway-runtime`), with the same
  built-entry guard.
- **F37 — High once wired, latent today — open: the gateway does not pace upstream fetches to the
  unpaid window.** Found by the gateway runtime's swarm integration test. Latent: nothing in the
  shipped gateway fetches upstream on its own — `Gateway.openUpstreamCore` has no production
  caller (Blossom `GET` serves only blobs the gateway holds), so today it bites only an embedder
  that calls the API. With real engines a PAY takes longer to make
  (P2PK outputs, DLEQ) than blocks take to arrive on a fast link, so a client reading a blob the
  gateway does not hold at full speed has the upstream seeder send more unpaid blocks than its
  window: the seeder cuts AND BANS the gateway (measured: 6 outstanding against a window of 5,
  every run). The desktop already paces with a credit pool settled by ACKs
  (`app-desktop/src/worker/playback/credit.ts`); the gateway has no equivalent. Fix: move the
  credit pool and ACK settlement into the shared `UpstreamPayer` and gate the gateway's upstream
  reads on it — required before anything wires upstream fetching (e.g. a Blossom miss that falls
  through to the swarm).
- **F38 — High — fixed: the gateway could never pay an upstream swarm peer.** It attached pay/1
  on `session-open`, which fires before a swarm connection's Protomux exists, so every upstream
  swarm session ran without pay/1 (and the seeder cut it after its window). It now attaches on
  `Seeder.onSessionReady`; the swarm integration test fails without the fix.

## 0c. Found by the desktop-signer lane's review (2026-09-24, `stage-3/desktop-signer`)

- **F39 — Medium — fixed: a NIP-46 bunker's `auth_url` would reach the console.** nostr-tools'
  `BunkerSigner` `console.warn`s the URL of an `auth_url` challenge when no `onauth` is set, and
  such URLs often carry a session token. The desktop host's stdio is inherited by main, so it would
  have reached the terminal / journal past the redacting logger. `core` `connectBunker` /
  `resumeBunker` now default `onauth` to a no-op (a caller that supports the flow passes its own);
  a test spies on `console.warn`. The rest of that review (the prompt throttle, the keychain-record
  ordering, pool disposal): docs/reviews/2026-09-24-pre-push-desktop-signer.md.

## 1. Summary

| ID | Sev | Finding | Where |
|---|---|---|---|
| F1 | **Critical** | A seeder's `PRICE` raises what a viewer pays above the manifest price the user was shown | `gateway/src/upstream/payer.ts:154-158, 303-319` (used by the desktop `ViewerPayer`) |
| F2 | High | The gateway's default upstream policy trusts the seeder's HELLO for price, split and mints | `gateway/src/upstream/payer.ts:326-340`, `gateway.ts:157` |
| F3 | High | Blossom serves the uploader's `Content-Type` on the gateway origin (HTML/SVG → stored XSS), CORS `*`, no `nosniff`/CSP | `gateway/src/blossom/handler.ts:90-92, 146-151, 289-293`; `config.ts:144-154` |
| F4 | High | Auto top-up (v5 normative) funds whatever mint a manifest names, automatically | `core/src/contracts/network-adapter.ts:188-193`; `app-desktop/src/host/adapter.ts:818` |
| F5 | High | DLEQ verification costs 11 ms/proof (20 ms under `--jitless`) on the event loop; per-block PAYs cap a seeder at ~5 HD viewers per core | `core/src/payment/engine.ts:762`; `app-desktop/src/worker/pay/viewer-payer.ts` (`payEveryBlocks: 1`) |
| F6 | High | The `pay1` creator-set binding (NUT-10 tag) is unverified against a real mint | `core/src/payment/engine.ts:297`, ADR 0010 §6 |
| F30 | High | The viewer's carry is never scoped per channel or committed on ACK: after a reconnect (or any rejected PAY) an honest viewer's PAYs all fail and it is window-cut and banned | `gateway/src/upstream/payer.ts` (no `carryIn`), contract `PaymentEngineViewer.pay` |
| F7 | Medium | SE-1 residual: a compromised renderer process can get a token for any path and publish the file | `app-desktop/src/main/file-tokens.ts`, `ipc-gate.ts` |
| F8 | Medium | The money gate is still a stub (fails closed); settings that move money are not gated at all | `app-desktop/src/main/money-gate.ts:33-35`, `ipc/protocol.ts` (`updateSettings`) |
| F9 | Medium | The seeder verifies every PAY against its CURRENT policy, so a price change rejects honest PAYs | `seeder/src/payment/pay-bridge.ts`, `core/src/payment/engine.ts:418` |
| F10 | Medium | The seen-secret set is memory-only with FIFO eviction; a restart re-opens replay until flush | `core/src/payment/seen.ts:11-51` |
| F11 | Medium | A viewer can double-spend the CREATOR set undetected (the seeder never checks it) | `core/src/payment/engine.ts` flush (~l. 620-660) |
| F12 | Medium | Accepted-but-unflushed proofs and failed nutzaps live only in memory: a crash loses that income | `core/src/payment/engine.ts:228, 513, 620-666` |
| F31 | Medium | A redeem whose response is lost is retried, the mint answers "spent", and the engine bans the honest viewer as a double-spender, drops the creator set and the swapped proofs are gone | `core/src/payment/engine.ts:630-641`, `core/src/wallet/spend.ts:300-306` |
| F13 | Medium | Full peer identifiers (Nostr pubkeys, Noise keys) are logged at info level | `seeder/src/net/peer-session.ts:206,212,232,266`; `seeder/src/seeder.ts:306,472`; `gateway/src/blossom/handler.ts:540-545,718`; `seeder/src/log/redact.ts` (by design) |
| F14 | Medium | `trustProxy` takes the FIRST `X-Forwarded-For` hop: clients pick their rate-limit bucket behind an appending proxy | `gateway/src/gateway.ts:447-454` |
| F15 | Medium | Gateway defaults: open uploads (any key, any MIME, 2 GiB, no quota); body spooled before auth without `X-SHA-256` | `gateway/src/config.ts:123-154`; `blossom/handler.ts:462-494` |
| F16 | Medium | The gateway unit dies at start on Node 22 (`--jitless` + undici) — known, still open | `deploy/systemd/nutflix-gateway.service`; `deploy/systemd/MDWE-RESULTS.md` §6 |
| F17 | Medium | Mint quotes are not NUT-20-locked: a quote id is a bearer claim on the minted ecash | `core/src/wallet/wallet.ts:154` |
| F18 | Medium | Host image fetches reveal the viewer's IP to any thumbnail/avatar host a Nostr event names | `app-desktop/src/host/images/*` |
| F19 | Low | Watch does not compare the session's policy with the quoted price (Shorts does) | `ui/src/screens/Watch/Watch.tsx:456` vs `Shorts/Shorts.tsx:744` |
| F20 | Low | `StoredReport.signatureVerified: false` is now stale (the auth boundary verifies it) | `gateway/src/blossom/store.ts:125`, `handler.ts:712` |
| F21 | Low | Dev flags ship in the production binary; Electron fuses / asar integrity not set | `app-desktop/src/main/args.ts`; packaging |
| F22 | Low | No single-instance lock on the desktop app (two processes on one `userData`) | `app-desktop/src/main/main.ts` |
| F23 | Low | The NIP-60 store trusts its injected relay layer to have verified signatures | `core/src/wallet/nip60.ts:101-105` |
| F24 | Low | Key files: the `KeyStore` adapter (Stage 3) must write 0600 atomically; headless unlock undefined | `core/src/signer/control.ts` (`KeyStore`), systemd units |
| F25 | Low | Markdown link text may differ from its target (matters once Stage 3 opens links) | `ui/src/components/Markdown/parse.ts:166-204` |
| F26 | Low | Advisory minimum PAY: dust PAYs cost seeders mint input fees | ADR 0010 §3.3 |
| F27 | Low | Two concurrent channels from one pubkey collide on the carry (rebind resets it) | `core/src/payment/engine.ts` (rebind) |
| F28 | Info | Bans are keyed on free identities; the window, not the ban, bounds loss | `seeder/src/store/ban-list.ts` |
| F29 | Info | BlossomAuth's `server`-tag rule follows nostr-tools, not BUD-11 text (not vendored) | `gateway/src/auth/blossom-auth.ts`, ADR 0010 §8 |
| F32 | Info | A DLEQ without `r`, or with non-hex fields, is treated as a forgery and banned — a third-party wallet that strips `r` gets banned | `core/src/payment/engine.ts` `dleqOk` |

F30–F32 were added by the pre-push differential review (`docs/reviews/2026-09-23-pre-push-stage-2.md`); their rows sit at their severity.

## 2. Findings

### F1 — Critical — `PRICE` can raise the price above the manifest

**What.** `UpstreamPayer` stores every `PRICE` a peer sends (`payer.ts:154-158`) and
`resolvePolicy` applies it unconditionally: `{ ...base, satsPerBlock: p.satsPerBlock }`
(`payer.ts:315-317`). The desktop `ViewerPayer` wraps `UpstreamPayer` and only checks the
HELLO's price against the manifest (`viewer-payer.ts:229`). A `PRICE` sent *after* the HELLO
bypasses that check.

**Impact.** A malicious seeder sends a HELLO at the manifest price, then
`PRICE { satsPerBlock: 10^6, effectiveFromBlock: next }`. The viewer's engine computes
`amount = blocks × satsPerBlock` and `wallet.send`s it: the balance at that mint drains, up to
`MAX_PAY_SATS`, with no user interaction beyond pressing Play. It breaks the product's core
promise ("never pay more than the price shown", ADR 0007 c) for the desktop viewer and for the
gateway (F2).

**Fix.** A `PRICE` may only LOWER the price: `min(p.satsPerBlock, base.satsPerBlock)`. A
PRICE above the manifest price stops payment to that peer for that core and logs it (the peer
then window-cuts us, which is the correct outcome). Put the clamp in `UpstreamPayer` so both
consumers get it. Also clamp in `ViewerPayer.resolvePolicy`. Defence in depth: have the
viewer engine's `pay()` refuse `amount > blocks × policy.satsPerBlock` for the policy it was
handed.

**Test.** An upstream peer sends HELLO at the manifest price, then PRICE ×1000 → the next PAY
is at the manifest price or absent, never above it. The same test runs against `ViewerPayer`.

### F2 — High — gateway pays upstream on the seeder's own terms

**What.** `helloPolicyResolver` (the gateway default, `gateway.ts:157`) builds the upstream
policy from the HELLO: `satsPerBlock: hello.satsPerBlock`, `mints: hello.acceptedMints`,
`split: hello.split` (`payer.ts:326-340`). Only `creatorP2pk` and `blockSize` come from
configuration.

**Impact.** Any upstream seeder names its price (drains the gateway's wallet at a mint it
holds) and its split (`{seeder: 100, creator: 0}` diverts the creator's share). Combined with
F1, the seeder can also change the price mid-stream.

**Fix.** Pay upstream only on the MANIFEST policy of the core (price, split, mints, creator
P2PK). The gateway already reads manifests for its own markup, and `config.upstream.policies`
is the per-core source. No manifest policy for a core → do not pay (the resolver already
supports `null`). HELLO values may only narrow: mints ∩ manifest mints, price ≤ manifest.
Never take the split from a HELLO (the desktop `ViewerPayer` already ignores it).

**Test.** HELLO asking 10× the manifest price → not paid. A HELLO split of 100/0 → PAY split
per the manifest. A core with no manifest policy → no PAY.

### F3 — High — stored XSS / content confusion on the gateway origin

**What.** `PUT /upload` stores the uploader's `Content-Type` (`mimeOf`, `handler.ts:146-151`;
the default `allowedMimeTypes: null` accepts any). `GET /<sha256>` serves it back verbatim
(`handler.ts:291`) with `Access-Control-Allow-Origin: *`, and without `X-Content-Type-Options`,
`Content-Security-Policy` or `Content-Disposition`.

**Impact.** Anyone who can upload (by default anyone with a fresh key, F15) can host
`text/html` or `image/svg+xml` with script on the gateway's origin: phishing under the
operator's domain, and any same-origin surface is exposed. The sharpest edge is NIP-07
extensions, which grant signing permission per origin. A user who let the gateway origin sign
upload tokens would have an attacker page sign whatever it asks.

**Fix.** On every blob response send `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox; default-src 'none'`. Default `allowedMimeTypes` to a
media allowlist (`video/*`, `audio/*`, `image/jpeg|png|webp|gif`, `text/vtt`), and never serve
`text/html`, `application/xhtml+xml`, `image/svg+xml`, `text/xml` or `application/javascript`
inline: send `application/octet-stream` with `Content-Disposition: attachment` instead.
Better still, serve blobs from a separate cookieless origin from anything a browser trusts.

**Test.** Upload with `Content-Type: text/html` → refused by default. With a permissive
allowlist, GET returns `application/octet-stream` + `attachment` + `nosniff` + CSP sandbox.

### F4 — High — auto top-up moves money into manifest-named mints

**What.** v5 made auto top-up normative (ADR 0010 item 5): when the balance at "the mint a
payment is about to draw from" falls below `belowSats`, melt at `fromMint` and mint there
(`network-adapter.ts:188-193`). The paying mint comes from the video's manifest. Stage 1 only
logs "would be due" (`host/adapter.ts:818-823`); Stage 3 executes it.

**Impact.** A creator who lists a mint they run makes every auto-top-up viewer pay Lightning
invoices from that mint, unattended. The creator's mint receives real sats and issues ecash
it can later refuse to honour. The trigger repeats per payment, bounded only by the
user's balance at `fromMint`.

**Fix.** Top up only into mints on the user's own trusted list (Settings → mints), never a
mint first seen in a manifest. Cap each top-up and each day (a new setting). Require the money
gate's native confirm the first time a mint is funded. Log each top-up in wallet history.

**Test.** A manifest naming an unknown mint → no top-up, and play fails `no-balance`. A
trusted mint → a top-up within the cap. The second top-up in a day beyond the cap is refused.

### F5 — High — DLEQ CPU cost and per-block PAYs

**What (measured on this box, TestMint keyset, cashu-ts 4.10.0 `hasValidDleq`):**
**11.2 ms per proof** with the JIT and **19.9 ms under `--jitless`**, which is how both
systemd units run Node. Minting costs 12.9 / 23.3 ms per proof. `verify` checks DLEQ on BOTH
sets, synchronously on the main thread, for up to `MAX_PROOFS_PER_SET = 64` proofs each
(`engine.ts:123`). The desktop viewer pays after every block (`payEveryBlocks: 1`).

**Impact.** At 2.5 Mbit/s and 64 KiB blocks a viewer sends ≈5 PAYs/s × ≥2 proofs, about
200 ms of seeder CPU per second (jitless). **One core saturates at ~5 HD viewers**, and every
other session stalls meanwhile (one event loop). An attacker paying with 1-sat proofs (real
but cheap) buys ~20 ms of CPU per sat. A forged DLEQ against a known keyset is banned on the
first proof (cheap for us). The costly case is valid proofs split fine.

**Fix (in order of leverage).**
1. Batch: pay per ½ window, not per block. This is the "payers batch to `minPaySats`" item
   ADR 0010 already owes Stage 3; it cuts PAY count by 10–30×.
2. Cap proofs per set at `popcount(amount) + 2`. An honest wallet needs no more; a
   fine-split set is `malformed` before any curve operation.
3. Verify DLEQ in a `worker_threads` pool (Node) off the event loop.
4. Optionally, verify DLEQ for a random sample of each set and rely on the flush swap to
   catch the rest. A forgery is then caught one batch later and banned; the loss stays
   bounded by the window. This is an explicit trade, and SECURITY.md invariant 2 would need
   amending.

**Test.** A benchmark in CI at `--jitless` (budget per PAY); a set of 64 × 1-sat proofs for a
64-sat PAY → `malformed` without a DLEQ call (spy).

### F6 — High — the `pay1` binding is unverified against a real mint

**What.** v5 binds the creator set to its seeder with a NUT-10 tag `['pay1', <seeder P2PK>]`
(ADR 0010 §6, `engine.ts:297`). TestMint accepts it. No real mint (nutshell, cdk) was run.

**Impact.** If a production mint rejects unknown tags at swap, or strips them, every creator
share is unredeemable or unbound. Creators would be paid nothing, or the replay protection
the tag buys would vanish silently.

**Fix.** A Stage 3 regtest job against nutshell and cdk-mintd: mint, send with the tag,
swap as the creator. If either mint rejects it, move the binding into the secret's `data`
domain (a per-seeder derived key) and amend ADR 0010 §6.

### F30 — High — the viewer's carry drifts from the seeder's

**What.** The seeder scopes the creator carry per channel × core. Every new session rebinds
(`peer-session.ts` → `engine.rebind(noiseHex, pubkey)`), and a rebind resets the pubkey's
carries. The viewer engine keeps its carry per (seeder pubkey, core) across channels and
advances it when it BUILDS a PAY (`engine.ts` `pay()`), not when the PAY is accepted. The
contract makes the transport responsible ("a transport that saw a rejected ACK, or opened a
new channel to the same seeder, passes the carry it reconstructed" — `PaymentEngineViewer.pay`),
but `UpstreamPayer` never passes `carryIn`.

**Impact.** A viewer reconnects to a seeder, or has one PAY refused (F9's price race, a lost
frame). From then on every PAY carries a `carryIn` the seeder does not expect, so it is
`malformed`. The unpaid blocks pass the window, and the seeder window-cuts and **bans** the
honest viewer, persistently. Not a money loss, but it makes multi-session viewing fail by
design.

**Fix.** `UpstreamPayer` keeps the carry per channel: 0 at `open`, pass it as `opts.carryIn`,
advance it to the PAY's carry-out only on the matching `ACK ok`, and hold further PAYs to
that seeder × core while one is unacknowledged (the carry chains them). Longer term, put the
seeder's expected carry in a negative `ACK` (v6) so a viewer can resynchronise instead of
guessing.

**Test.** A viewer pays on channel 1, reconnects (channel 2) and pays again → accepted. A PAY
refused with `wrong-amount` → the next PAY is accepted.

### F7 — Medium — SE-1 residual

**What.** SE-1 is implemented (single-use, webContents-bound, 10-minute tokens;
`studio.upload` takes only a token). But main mints a token for whatever absolute path the
`nf:grant-file` message names (`file-tokens.ts` header, "Residual"). Page JavaScript cannot
reach that channel (context isolation, no `ipcRenderer` in the bridge). A compromised renderer
*process* can, and it can then call `studio.upload` itself.

**Impact.** A renderer RCE, which is exactly what the Chromium sandbox assumes can happen,
publishes any user-readable file to the public network (transcoded, but a file is a file).

**Fix.** Have main own the choice. Either `dialog.showOpenDialog` in main, or a main-process
confirm naming the file (basename, size) before relaying `studio.upload`. The drop path then
needs the same confirm.

### F8 — Medium — the money gate is a stub, and settings are ungated

**What.** `createMoneyGate` returns `devMocks` (`money-gate.ts:33-35`). It correctly fails
closed without `--dev-mocks`, but Stage 2 did not replace it with the native dialog the design
calls for. Separately, `updateSettings` is ungated: the renderer can rewrite relays, mints and
`autoTopUp`.

**Fix.** Stage 3 implements `dialog.showMessageBox` in main for `wallet.melt`,
`seeder.melt` and `nutzap`, with amount, mint and destination decoded in main from the
validated args. For melt, decode the bolt11 amount in main, never from renderer text. Add
settings patches touching `mints` or `autoTopUp` to the gated set (see F4).

### F9 — Medium — PRICE change rejects honest PAYs

The seeder verifies each PAY against its current policy. After a `PRICE` with
`effectiveFromBlock = N`, an honest PAY for blocks below N at the old price is `wrong-amount`.
Enough of those window-cut the viewer. Already owed to Stage 3 in ADR 0010 Consequences.
**Fix:** the engine keeps the policy history per core and prices each block by the policy
in force when it was uploaded. **Test:** a PRICE mid-stream, then a PAY for the earlier range
at the old price → accepted.

### F10 — Medium — seen-secret set not persisted

`SeenSecrets` is in memory, capacity 1 000 000, FIFO eviction (`seen.ts:11-51`). After a
restart (or eviction), a replay of already-accepted proofs passes `verify`; the flush swap
then finds them spent and bans the peer. **Loss:** up to one window of blocks per identity
per restart. **Fix:** implement the `persist` hook (append-only file of secret hashes, or
`Y = hash_to_curve(secret)` values, which reveal nothing spendable), pruned by keyset
rotation. **Test:** accept a PAY, restart the engine with the same store, replay → `double-spend`.

### F11 — Medium — creator-set double-spend goes undetected

The seeder redeems only its own set. The creator set is nutzapped to the creator unexamined.
A viewer who double-spends the creator proofs cheats the creator, and the seeder neither
notices nor bans. **Fix:** at flush (and, if cheap enough, at verify), NUT-07
`checkstate` the creator proofs by `Y`. Checkstate needs no ownership. A spent creator
proof → `double-spend` ban, the same as the seeder set. **Test:** spend the creator set at the
mint before flush → the peer is banned, and no nutzap is published.

### F12 — Medium — unflushed proofs are memory-only

A verified PAY is queued (`engine.ts:513`) and redeemed at the next flush; a nutzap that fails
stays queued (`engine.ts:666`). The queue is an in-memory array (`engine.ts:228`). A graceful
stop flushes it (`flush-scheduler.ts:50`); a crash, OOM kill or power loss drops it. The
proofs are P2PK-locked to the seeder (or the creator), so nobody else can spend them, and
nobody can ever recover them. **Loss:** up to `flushEveryBlocks` / `flushEveryMs` of
income, plus every creator share whose nutzap had failed. **Fix:** persist the queue before
ACKing (0600, or the NIP-60 store, which is already encrypted to self), and resume flushing at
start. **Test:** accept a PAY, build a new engine on the same store without flushing, flush →
redeemed and nutzapped.

### F31 — Medium — a lost redeem response becomes a false double-spend

If the mint executes the seeder's redeem swap but the response is lost (timeout, reset),
`Spender.receive` reports `mint-error` and the engine keeps the item. At the next flush the
mint answers `11001 already spent` for proofs *we* spent: the engine bans the honest viewer
(`double-spend`), skips the creator's nutzap, and the new proofs from the first swap are
unrecoverable, because outputs are random rather than NUT-13 deterministic. **Fix:** on
`spent` after an earlier ambiguous failure, NUT-07 `checkstate` the inputs and verify the
returned witness against our own wallet key. Our own signature means our own swap: no ban,
nutzap the creator set. Adopt NUT-13 deterministic secrets with NUT-09 restore so the swapped
outputs can be recovered. **Test:** a transport that drops the first redeem response → no
ban, the creator is nutzapped, and (with NUT-13) the seeder's balance is restored.

### F13 — Medium — peer identifiers in logs

`redact.ts` deliberately keeps full values in public-identifier fields (`pubkey`, `peer`,
`noiseKey`, …), and the seeder logs them at info on bind, rebind, cut and session admission.
The gateway logs uploader and reporter pubkeys (`handler.ts:540-545, 718`). Journald then
holds a durable record of which Nostr identities fetched from, uploaded to or reported via this
host. **Fix:** log a keyed, per-boot hash (e.g. first 8 bytes of
`HMAC(boot_key, value)`), which correlates within a run and not across runs. Keep full
values at debug only. Add a test that `info` output of a full session contains no 64-hex run.

### F14 — Medium — `X-Forwarded-For` first hop

With `trustProxy: true`, `clientKey` takes the first XFF entry (`gateway.ts:447-454`).
Proxies that append (nginx `proxy_add_x_forwarded_for`) leave the client's own header first,
so a client picks any bucket and escapes the per-client limits. (Caddy's default replaces the
header, so the risk depends on the proxy.) **Fix:** take the entry N hops from the right, N =
number of trusted proxies (default 1), or a proxy-set `X-Real-IP`. **Test:** a request with
`X-Forwarded-For: 1.2.3.4, <proxy-added>` is bucketed on the proxy-added value.

### F15 — Medium — open uploads by default

Defaults: `allowUpload: true`, no allow list, `allowedMimeTypes: null`, 2 GiB per upload,
16 concurrent per client, no per-pubkey quota (`config.ts:123-154`). Without `X-SHA-256` the
body is spooled to disk before the token is checked (`handler.ts:462-494`); the spool is
removed afterwards, but disk I/O and space are spent unauthenticated. **Fix:** ship with
uploads off or allow-list-only (BlossomAuth now implements allow-list mode, ADR 0010 §8).
Add a per-pubkey byte quota. Require `X-SHA-256` (or a `Content-Length` below a small
threshold) before spooling.

### F16 — Medium — gateway unit broken on Node 22 (known)

`MDWE-RESULTS.md` §6 already records it: under `--jitless`, touching `node:http` (the
gateway's server) loads undici, which needs WebAssembly, and the process dies one tick after
start on Node 22. The seeder unit is fixed; the gateway unit is not, and it also lacks
`--no-experimental-websocket`. **Fix:** require Node ≥ 24 on gateway hosts (works there) and
add the flag. Or load `http` through `createRequire` as the note suggests.

### F17 — Medium — mint quotes are bearer

`mintQuote` uses `createMintQuoteBolt11` (`wallet.ts:154`) without NUT-20. Whoever learns the
quote id after the invoice is paid can mint the ecash first. Quote ids cross IPC to the
renderer (`wallet.mintQuote` / `pollQuote`). **Fix:** use NUT-20 locked quotes (sign the mint
request with the wallet key) when the mint advertises NUT-20; keep quote ids out of the
renderer (hand it an opaque handle).

### F18 — Medium — image fetches leak the viewer's IP

The host fetch is well guarded: https only, DNS-level private-address refusal (no rebinding
window), 3 re-validated redirects, 5 MiB, magic-byte sniffing, sha256 when given. But every
thumbnail and avatar URL in a Nostr event makes the viewer's machine contact that host, with
a distinctive `user-agent: nutflix-desktop` (`net.ts:231`). That is a tracking pixel for any
publisher. **Fix:** prefer Blossom URLs with an `x` hash, fetched through a gateway or over
the swarm. Drop the distinctive user agent. Offer a "load remote images" setting (default: only
hash-addressed images).

### F19–F29 — Low / Info

- **F19.** Watch refuses a session whose rendition differs from the quote, but does not
  compare `session.policy`, as Shorts does (`renditionPriceSats(rendition, session.policy) >
  shown`). Event ids are content hashes, so the host cannot hand back a different price for
  the same id today. Add the check anyway, before any addressable-event resolution lands.
- **F20.** `StoredReport.signatureVerified` is typed `false`. Since A.5 the auth boundary
  verifies the report's signature under verb `report`. Record `true` (type `boolean`) when
  `authorize` succeeded against a real `BlossomAuth`.
- **F21.** `--dev-mocks`, `--dev-fixtures` and `--e2e-hooks` are parsed in every build. None
  moves real money (mocks only; counters only), but production builds should compile them
  out. Packaging must also set Electron fuses (`RunAsNode` off, `EnableNodeOptionsEnvironmentVariable`
  off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on,
  `OnlyLoadAppFromAsar` on).
- **F22.** No `app.requestSingleInstanceLock()`: two app instances on one `userData` share the
  settings file and the worker's storage. Corestore's lock stops the second worker, but the
  host's settings writes race.
- **F23.** `Nip60ProofStore` filters `authors: [me]` and re-checks `ev.pubkey`. It relies on
  the injected `relays.query` to have verified signatures. Forged token events fail NIP-44
  decryption (the self-conversation key needs our secret), but a forged kind-5 would hide
  proofs. Call `verifyIncoming` on every event in `reload()` (defence in depth, about 1 ms per
  event).
- **F24.** The signer's key file is sound (argon2id13 + XChaCha20-Poly1305, header as AD,
  bounded KDF cost), but *writing* it is the injected `KeyStore`'s job: Stage 3's adapter must
  write atomically at 0600 under a 0700 directory. Headless daemons (seeder, gateway) need an
  unlock story, e.g. `LoadCredentialEncrypted=` with a systemd-creds or TPM-sealed passphrase.
  Never an env var.
- **F25.** Markdown links render `[text](href)` with the text shown. Links open nothing today
  (window-open denied), but Stage 3's external-link confirm must show the real host.
- **F26.** ADR 0010 §3.3 made the minimum PAY advisory (an enforced minimum deadlocks
  multi-seeder viewers). Dust PAYs then cost seeders the mint's `input_fee_ppk` at swap. This
  is the same fix as F5 (1).
- **F27.** Carry is per channel × core, and a rebind resets `to`'s carry to `from`'s. Two
  simultaneous channels from one pubkey to one seeder fight over it, and the loser's PAYs
  become `wrong-amount`. Either key carry by channel id rather than pubkey, or refuse a second
  concurrent channel per pubkey.
- **F28.** Bans persist (Noise + Nostr, `BanList`), but identities are free. The per-identity
  loss bound is the window (`windowBlocks × satsPerBlock`), plus the session rate limits.
  Inherent; recorded so nobody relies on bans alone.
- **F29.** BUD-11 is not vendored. The `server` scoping rule (ADR 0010 §8) mirrors nostr-tools'
  Blossom client and only ever *refuses* tokens that name other servers. Vendor BUD-11 and
  re-check.
- **F32.** `dleqOk` treats a DLEQ without `r` (or with non-hex fields) as a forgery against
  a known keyset and bans. Our wallet always sends `r` (its post-check requires it), and L10's
  forge fixture relies on the ban. But a third-party wallet that forwards proofs with `r`
  stripped would be banned rather than told `missing-dleq`. Revisit when non-Nutflix payers
  exist: classify a missing `r` as `missing-dleq` and amend the fixture.

## 3. Checklist coverage

| Item | Result |
|---|---|
| webPreferences | `contextIsolation`, `sandbox`, `nodeIntegration*` false as literals, `webviewTag`/`webSecurity` at secure defaults (`main/window.ts`); `app.enableSandbox()`; `--no-sandbox`/`--disable-gpu-sandbox`/`--no-zygote` refused at start (exit 78). **Pass** |
| Preload surface, `EXCLUDED_METHODS` | One key `window.nutflix`; no `ipcRenderer`/generic invoke; `wallet.send/receive/p2pkPubkey/keyset` stubs reject `forbidden` (D3). **Pass**; ungated settings → F8 |
| IPC gate | Top-frame + `app://nutflix` origin + app-webContents checks, method allowlist + per-method guards, inflight/sub/grant caps, SE-1 swap, money gate before relay, replies matched per (webContents, id). **Pass** |
| File tokens (SE-1) | Single use, webContents-bound, TTL, `lstat` regular file (no symlink/device). **Pass**; residual → F7 |
| CSP | Response header from `app:`; `default-src 'none'`, `connect-src 'none'`, no inline, `frame-ancestors 'none'`; `nf-media:` responses `sandbox`. **Pass** |
| Navigation / permissions | `setWindowOpenHandler` deny; `will-navigate`/`-frame-navigate`/`-redirect`/`-attach-webview` prevented; only `fullscreen` + `clipboard-sanitized-write` for the top app frame; device permissions false; downloads and spell-check dictionaries off. **Pass** |
| `app:` handler | GET/HEAD, fixed file list, encoded-separator and dot-segment refusal before decode, realpath containment. **Pass** |
| `nf-media:` proxy | Loopback-only link regex re-checked per fetch, single-range regex (malformed → 416, never widened), `redirect: 'error'`, fixed `video/mp4`. **Pass** |
| Worker playback server | 127.0.0.1, 256-bit server token + 128-bit per-session path token, `resolve` allowlist (live session AND exact core/blob/type) before any store access, per-request gated adapter without `.core` (no bulk prefetch). **Pass** |
| Pacing / credit pool | Paused → no requests; allowance = prefetch + paced × 1.25; global `CreditPool` ≤ window, settled on ACK. **Pass**; scaling → F5 |
| Money gate | Stub, fails closed → F8 |
| Host image fetch (T16) | https, DNS-level private refusal, redirects, size, sniffing, hash. **Pass**; privacy → F18 |
| Seeder / gateway rate limits | Seeder: per-noise-key streams + connects per window (`RateLimiter`); gateway: per-client HTTP concurrency/rate, WS connection cap, header/body idle timeouts. **Pass**; XFF → F14; CPU → F5 |
| Ban persistence | `BanList` persisted (Noise + Nostr); engine bans and mint-reported double-spends reach it. **Pass**; F28 |
| Log redaction | Cashu tokens, nsec, proof-shaped objects, secret-named fields scrubbed; 64-hex in free text truncated. All 171 logger calls in `packages/*/src` were grepped and those with identifier/URL/key fields read: no secret found; peer identifiers → F13. The five Stage 2 directories log nothing. |
| Key file permissions | Gateway spool 0700, spool/report/owner files 0600; desktop settings 0700/0600 atomic; systemd `UMask=0077`, `StateDirectoryMode=0700`. Key-file writing → F24 |
| systemd units | Full hardening set (`ProtectSystem=strict`, empty capability set, `@system-service` filter, MDWE + `--jitless`, `NODE_OPTIONS=` pinned, resource caps). **Pass**; gateway Node 22 → F16 |
| Dependencies | `.npmrc`: `ignore-scripts`, `save-exact`, lockfile mandatory. Lockfile: 611 entries, all with integrity, all from registry.npmjs.org, 2 with install scripts (esbuild, fsevents — never run). `npm audit --omit=dev`: 0 vulnerabilities. `npm audit signatures`: 499/499 registry-signed, 205 attested. `scripts/provenance-report.mjs`: 594 signed, 282 attested; **9 direct deps without provenance** (bare-encoding, hyperswarm, nostr-tools, sodium-javascript, sodium-native, sodium-universal, streamx, uqr, ws), to re-read on every bump. Stage 2 added `@cashu/cashu-ts` 4.10.0, `sodium-universal` 5.0.1, `compact-encoding` 3.4.0 to core (nostr-tools was already there). **Pass** |
| Nostr read paths | Exactly one signature check in the repo: `core/src/nostr/event.ts` `classifyIncoming` (fresh object → `verifyEvent`, defeating the spread pitfall). Every read goes through `NostrClient`; Stage 2's remote signer, HELLO and BlossomAuth reuse it. **Pass**; F23 |
| Markdown | Fixed subset rendered as React elements; http(s) links only; `nostr:` as chips; no raw-HTML sink anywhere in `packages/ui`, `app-desktop`, `app-web`. **Pass**; F25 |
| Thumbnail hash checks | `sha256` enforced when the manifest carries it; bytes sniffed (JPEG/PNG/WebP only, no SVG). **Pass** |
| Price shown vs charged | Card and Watch quote the default rendition (`quoteFor` = `play(id)`'s rendition); Watch refuses a session at another rendition; a quality switch keeps the old session unless the new one matches, then toasts the delta; autoplay-next shows the price through the countdown and refuses a higher re-quote; Shorts refuses `charged > shown`; the mini-player carries the same session (no re-price). Host charges `video.price` of the same content-addressed event. **Pass** in the UI; **F1 breaks it below the UI**; F19 |
| SE-1 … SE-5 | §4 |
| Gateway web responses | F3, F14, F15; CORS `*` on everything is Blossom-conformant but only safe once F3 lands; `OPTIONS` fine; error bodies are fixed strings (`X-Reason`), no reflection. |

## 4. SE-1 … SE-5 (docs/reviews/2026-09-23-pre-push-l5-v4.md)

| | Status |
|---|---|
| SE-1 | **Fixed** by file tokens (L6-A); residual F7 |
| SE-2 | **Fixed**: `renderer/coordinator.ts` owns every session; host backstop ≤ 1 unpaused per webContents; `wc-gone` closes all; e2e asserts one open session after Watch→Watch |
| SE-3 | **Fixed**: Shorts `onPlaybackStart` wired to the coordinator |
| SE-4 | **Fixed** for Stage 1 (`autoTopUpDue` false for `belowSats <= 0`, tested; v5 normative); executing top-ups is Stage 3, see F4 |
| SE-5 | **Fixed**: `unreact` publishes a kind-5 naming only the viewer's own kind-7 ids, never `-` (tested) |

## 5. Stage 2 modules — what holds, what is residual

- **Signer.** Keys live in `sodium_malloc` buffers, compared with `sodium_memcmp` and wiped on
  lock. The key file is argon2id13 + XChaCha20-Poly1305 with the header as AD and KDF cost
  bounds on read. The wallet P2PK key is separate from the Nostr key (NIP-60/61 require it).
  Remote signers (NIP-46 bunker over wss only, NIP-07) have every reply re-verified.
  Residual: F24.
- **Wallet / `spend.ts`.** Per-mint lock; `send` post-checks sum, DLEQ (with `r`) and the lock
  policy of every produced proof; melt commits spent only on PAID, else reconciles via NUT-07.
  Residual: F23. (F17 fixed: NUT-20 locked mint quotes.)
- **Payment engine.** Pay-after-verify, exact amounts, both sets P2PK-checked
  (`checkPayLock`: no locktime/refund/extra keys), DLEQ offline against the cached keyset
  (forged → ban), window accounting on distinct blocks, local double-spend check at verify, ban
  on a mint-reported double-spend. Residual: F5, F6, F9, F10, F11, F12, F27, F30 (consumer), F32.
  (F31 fixed: a lost mint answer is restored by NUT-09 from a write-ahead journal, ADR 0014.)
- **pay/1.** Strict codec (exact consumption, caps on every length), and the HELLO is bound to
  the Noise handshake hash and sender key. PAY/ACK/PRICE are delivered as they arrive, even
  before the HELLO, on purpose (ADR 0004 d: a PAY may race its sender's HELLO). The seeder
  counts those blocks as provisional until the pubkey binds, and a bad HELLO closes the
  channel. Residual: F1 is in the consumer, not the protocol.
- **Gateway auth.** ADR 0010 §8. Residual: F29; the handler-side F3, F15 and F20.

**Fixed in the pre-push review** (inside the five directories, or in a consumer adapting to a
Stage 2 change; details and which ones carry a new test in
`docs/reviews/2026-09-23-pre-push-stage-2.md`): `signSecret` signs only NUT-10 P2PK secrets (was a
general signing oracle for the wallet key); a second HELLO that changes the terms is a
protocol error (was silently adopted as `peer`); a proof set naming more than 3 keyset ids is
`malformed` before any lookup; `checkPayLock` never throws; `SeenSecrets` refuses a capacity
that disables it; `verifyHello` returns a verdict object instead of `null`-means-valid; and
any rejected PAY that leaves the peer engine-banned (the forged-DLEQ `bad-dleq` ban included)
is ACKed, then cut, with the ban persisted.

## 6. Stage 3 issues

To be filed on GitLab, labelled `stage-3` and `security`, severity in the title, body = the
finding's section above plus its row in §0. **Filing waits for Cameron's go-ahead**
(outward-facing). Only what §0 leaves open:

| Issue title |
|---|
| [Medium] F33: duplicate block deliveries — request each range from one peer (Cameron, 2026-09-24) |
| [Done] F5: DLEQ off the event loop (Node) and batching on the credit pool (ADR 0011 §10–§11). Residual [Low]: DLEQ in the desktop's Bare worker; a credit pool sized per seeder window |
| [Done] Seeder: an append-only pending-PAY journal and a cap that stops serving at `maxPendingPays` (daemon + gateway, ADR 0011 §12; the desktop worker too, cap 1024, `stage-3/worker-journal`) |
| [Done] F37: the gateway's upstream fetches are paced (ADR 0011 §11) |
| [Done] F10/F11/F12/F31 hooks in the desktop runtime — the worker's seeder engine persists seen secrets and pending PAYs and asks the host for `checkSpent` / `spentByUs` (ADR 0012) |
| [Done] F31: a lost mint answer is restored (write-ahead journal + NUT-09, ADR 0014). Residual [Low]: the desktop's journal is in memory; melt change is not journaled |
| [Medium] NUT-13 seed backup in Stage 3 (Cameron, 2026-09-24): design + ADR first |
| [Done] Pear only (Cameron, 2026-09-24/25): Studio's third-party Blossom mirroring removed, our manifests name no Blossom server (contracts v6); the gateway's Blossom endpoints stay as a Nostr-signed HTTP face over its Pear seeder; per-pubkey quota default 2 GiB (`stage-3/pear-only`) |
| [Medium] F18: images hash-addressed only by default; thumbnails in the video's core (seeder's choice, default free, placeholder if paid); avatars from a per-creator Pear core (Cameron, 2026-09-24) |
| [Done] F15: per-pubkey upload quota (`blossom.maxBytesPerPubkey`) |
| [Done] F17: NUT-20 locked mint quotes; opaque quote handles over IPC. Residual [Low]: a signer-held wallet key (the seeder daemon) takes unlocked quotes — cashu-ts signs NUT-20 itself and needs the key as a string |
| [Medium] F4: execute auto top-ups — off by default, 10 000 sat per top-up, 50 000 sat per day, own mints only, first-time confirm (Cameron, 2026-09-24) |
| [Low] F21: packaging with Electron Forge + Pear makers (exe, dmg, deb, AppImage, `pear://`), fuses set, releases signed with the SovTech Nostr key (Cameron, 2026-09-24) |
| [Done] F24: the desktop's file `KeyStore` (ADR 0013) |
| [Done] Desktop signer: remove the key from this device; NIP-46 `auth_url` approval links (ADR 0013 §7) |
| [Done] F25: external links open only after main's prompt window showed the real host |

## 7. Not verified

- Real mints (nutshell, cdk): NUT-07 behaviour beyond the real-mint suite, fee handling. (The `pay1` tag, F6, and NUT-20 locked quotes, F17, were verified on Nutshell 0.21.0 and cdk-mintd 0.18.1.)
- Electron at runtime beyond the Stage 1 e2e (webPreferences, key allowlist, one session):
  this review read the code and its unit tests; it did not attack a running app.
- The web build's served headers (`scripts/csp-sri.mjs`): out of scope (no web portal).
- Remote-signer interop against real bunkers and NIP-07 extensions.
- BUD-11 text (F29).
- Performance numbers are from one laptop (the dev laptop, Node 22); F5's budget needs a
  measurement on target hardware.
