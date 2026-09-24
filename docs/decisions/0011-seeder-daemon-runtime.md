# 11. The seeder daemon's runtime: key delivery, wallet storage, nutzaps, pay/1 on swarm sessions

Date: 2026-09-24

## Status

Proposed (Stage 3, lane "seeder runtime", branch `stage-3/seeder-runtime`). Implemented and
tested; §8 records Cameron's answers (2026-09-24). Nothing here changes a core contract.

## Context

Until now the seeder daemon (`nutflix-seeder.service`, `packages/seeder/src/cli/main.ts`) refused
to start on purpose: `cli/providers.ts` returned no runtime, so there was no engine, no wallet, no
identity and no `pay/1` on swarm sessions (docs/lanes/Seeder-entry.md §3). Build-plan Phase 3
needs a seeder that runs on a server unattended, is paid over `pay/1`, keeps its share in its own
wallet, forwards the creator's share as NIP-61 nutzaps and survives restarts without losing money.

The Stage 2 engine already has every hook this needs (`keyset`, `redeem`, `checkSpent`,
`spentByUs`, `persistPending` / `restorePending`, the seen set's `persist`, `nutzap`). What was
missing is the host: where the key comes from, where proofs live, how the hooks reach disk and
relays, and how `pay/1` attaches to a swarm connection.

## 1. Identity: one encrypted key file, the passphrase as a systemd credential

- **Key file.** The Stage 2 `LocalSigner` format (argon2id13 + XChaCha20-Poly1305, header as
  associated data). It holds the node's Nostr key (HELLO, nutzaps, kind 10019) **and** a separate
  wallet key (redeems what viewers lock to the seeder). A file without a wallet key is refused.
  Default path `<dataDir>/identity.key` (the unit's 0700 `StateDirectory`); `identity.keyFile`
  overrides it. The daemon refuses a key file readable by group or others.
- **Passphrase.** Read from `$CREDENTIALS_DIRECTORY/seeder-key-passphrase`, i.e. the unit's
  `LoadCredentialEncrypted=seeder-key-passphrase:/etc/credstore.encrypted/…`. PID 1 decrypts it
  (TPM2 and/or the host key) into a private ramfs only this service sees. Never the environment,
  the config file or argv (build-plan §7): the config parser refuses `identity.passphrase`,
  `identity.nsec` and `identity.secretKey` with a pointer to the credential.
- **Creation.** `--keygen` creates the file (0600, `O_EXCL`, never overwrites) from a passphrase on
  **stdin** — piped from `systemd-creds decrypt`, so the key file and the credential hold the same
  bytes and the passphrase never touches disk in clear. A terminal on stdin is refused (it would
  echo). Only the public key is logged.
- **Order.** The runtime unlocks the identity before it creates anything, so a daemon without its
  key or credential exits 78 and leaves no state behind.

Rejected: a passphrase in `Environment=`/`EnvironmentFile=` (readable via `/proc/<pid>/environ`
and `systemctl show`); an unencrypted key file (a stolen disk or backup is a stolen wallet key);
prompting at boot (a server must restart unattended).

## 2. The wallet: a local 0600 file, sealed to the node key; not NIP-60 on relays

`FileProofStore` (`runtime/proof-file.ts`) implements the core `ProofStore`: unspent proofs per
mint plus a bounded history (100 lines) in `<dataDir>/wallet/proofs.json`. Every `commit()`
builds the next state, writes it to `proofs.json.tmp` (0600), fsyncs, renames over the file and
fsyncs the directory, and only then makes it live — before the wallet returns the operation's
result, as the contract requires. Commits are serialised.

**Encrypted at rest** (Cameron, 2026-09-24): the JSON is NIP-44 encrypted to the node's own Nostr
key through the signer (`nip44Encrypt(ownPubkey, …)`, the scheme NIP-60 uses for wallet events),
so no key leaves the signer and no cryptography is written here. NIP-44 takes at most 64 KiB per
message, so the document is cut into 60 000-character chunks, each carrying `index/count` inside
its ciphertext: a chunk flipped, dropped, swapped or reordered does not open, and the daemon
refuses to start. An unencrypted file from before is read and resealed at open. This protects a
stolen disk, a copied data directory and a leaked backup; it cannot protect a live compromise of
the process, which holds the unlocked key — keeping little on the server does that (§7).

Cost: every commit reseals the whole file, and under the unit's `--jitless` NIP-44 runs at ~3.3 ms
per KB on the event loop (measured on Node 22: 200 ms per 60 KB chunk; 26 ms with the JIT). A
typical file — tens of proofs, since payout keeps the balance small, and 100 history lines — is
~40 KB, so ~130 ms per flush. That is why the history is short; moving crypto off the event loop
belongs with F5.

A file that exists but does not open is **not** treated as empty: the first commit would
overwrite it and destroy whatever it still held. The daemon refuses to start and says to recover
the proofs first.

`pending.json` (§3) stays plaintext: it is written synchronously before each ACK and the signer
is asynchronous, and its proofs are still P2PK-locked — the seeder's share to the wallet key in the
key file, the creator's to the creator — so a copy of it spends nothing.

Not done, and why:

- **NIP-60 on relays** (what build-plan §6 says for the seeder). Confidentiality would be the same
  NIP-44, but relays can lose, withhold or replay stale wallet events — money loss for a server —
  every flush would become relay writes, and the timing of those writes shows when the seeder
  earns. Possible later as an encrypted backup mirror, never as the source of truth.
- **Re-locking swapped proofs to the node's own P2PK key.** Strong at rest, but every spend then
  needs a witness and it changes `spend.ts` (the audit surface). Worth doing with NUT-13.

## 3. The engine's durable state

- **Pending PAYs (F12).** `persistPending` is synchronous and runs before the ACK, so the hook
  writes `<dataDir>/wallet/pending.json` with a synchronous atomic write (tmp + fsync + rename +
  directory fsync). Once a viewer is told "paid", its proofs are on disk. `restorePending` reloads
  them at start. A damaged file stops the daemon rather than dropping accepted payments. The
  engine swallows a hook's exception, so the hook also logs a failed write.
- **Seen secrets (F10).** `SeenSecrets.persist` appends each accepted batch to
  `<dataDir>/wallet/seen.jsonl`, one JSON string per line (a newline inside a secret cannot split
  it), rotated to `seen.jsonl.1` every 250 000 lines, so the disk holds two generations at most.
  A failed append is logged, never thrown (it runs inside `verify`). At start the newest 250 000
  secrets (~300 B each, ~75 MB in memory) are restored. Older replays are still caught at the mint
  (the F31 first-attempt rule).
- **Cost.** One synchronous fsync per accepted PAY. With batching (one unacknowledged PAY per core
  per viewer, F30) that is a few writes per second per busy seeder; measure on target hardware
  with F5. **Known limit:** the file is the whole queue, and while a mint is down nothing leaves
  the queue, so each write grows — quadratic until the daemon stalls. An append-only journal and
  an engine cap on queued PAYs are the follow-up (security review §6).
- **One daemon per data directory.** `<dataDir>/wallet/lock` (created `O_EXCL`, holds the pid).
  A second daemon on the same directory would redeem the same PAYs and rewrite the wallet file
  over the first one's commits; it is refused. A lock whose process is gone is taken over.

## 4. Keysets: the lookup is rate-limited

The engine asks for a keyset by the id a peer names. The wallet answers a loaded keyset from
memory but reloads the whole mint for an unknown id, so without a limit each PAY with a random id
is a request to the mint on a peer's behalf. Ids that resolved once are free; a lookup of an id not
yet seen spends a token from a per-mint bucket (4, one back every 15 s). With the bucket empty the
PAY is refused as `bad-dleq` "unknown keyset", which the engine never bans for, so an honest viewer
that meets an empty bucket pays again.

## 5. Nostr: NIP-61 nutzaps and the kind 10019

- **Nutzap (kind 9321), one per creator × mint × core per flush** (the engine batches, F34):
  `p` = the creator's Nostr pubkey, `u` = the mint, `e` = the video event when configured, one
  `proof` tag per proof (NUT-00 fields + DLEQ, never a witness), empty content. The proofs are
  P2PK-locked to the creator, so a relay or reader cannot spend them. **The viewers whose PAYs it
  forwards are never named.** The publish succeeds when at least one relay accepts; otherwise it
  rejects and the engine keeps the PAYs queued (and on disk) for the next flush.
- **Config.** `relays` (1–8, `wss://`, plain `ws://` only to loopback) and
  `policy.creatorPubkey` are required, so `--check` catches a daemon that could not forward the
  creator's share. `creatorPubkey` may not be the key `creatorP2pk` names (NIP-61). `videoEvents`
  (core key → video event id) is optional.
- **Kind 10019** at start: the node's relays, mints (`sat`) and wallet P2PK key. Best effort
  (logged).
- **Transport.** nostr-tools' `AbstractSimplePool` with the `ws` package passed per pool: the unit
  runs Node with `--no-experimental-websocket` (MDWE-RESULTS.md §6), and this mutates nothing
  global. New exact-pinned dependencies of `@sovit/seeder`: `nostr-tools` 2.25.2 and `ws` 8.21.3
  (both already in the lockfile via core and the gateway).

## 5a. Mint requests over `node:http(s)`, never the global `fetch`

cashu-ts sends mint requests through the global `fetch`, which on Node 22 is undici with a
WebAssembly parser; under the unit's `--jitless` the first request crashes the process (security
review F36, MDWE-RESULTS.md §7). `@sovit/core` gains `wallet.cashuRequestFn(raw)`: cashu-ts's
`RequestFn` error contract (400 `{ code, detail }` → `MintOperationError`, 429 →
`RateLimitError`, other → `HttpResponseError`, no answer → `NetworkError`, `JSONInt` bodies,
redirects never followed) over an injected raw call; the daemon supplies `node:http(s)` loaded
through `createRequire`, with one timer per exchange and a 4 MiB response cap. At start the
daemon loads every accepted mint, so the first PAY verifies against keysets already in memory and
an unreachable mint is logged at boot.

## 6. pay/1 on swarm sessions: `Seeder.onSessionReady`

`session-open` fires at admission, before `store.replicate(conn)` creates a swarm connection's
Protomux, so `session.mux` is null there (the trap in Seeder-entry.md §3). `Seeder` gains
`onSessionReady(cb)`: called with every admitted session once replication runs on it (swarm: after
`replicate(conn)`; direct streams: right after admission). The daemon's `wirePay` attaches a
`PayChannel` bound to the connection's handshake, bridges it with `attachPayProtocol`, and sends a
HELLO signed by the key file's identity with the default policy's price, mints and split, the
wallet P2PK and `DEFAULT_WINDOW_BLOCKS`. A listener that throws is logged and contained. The
gateway and the desktop worker keep their own wiring.

`runDaemon` gains `beforeStart` (attach before `start()`, so no session is admitted unwired) and
`afterClose` (relays closed, key locked and the lock freed only after the seeder's final flush,
which still needs them). A failed start releases the runtime too. The Stage 1 start-up warning is
gone.

## 7. Payout: earnings leave for the owner's own wallet (Cameron, 2026-09-24)

`runtime/payout.ts`, configured by `payout: { pubkey, p2pk, thresholdSats = 1000, relays }`.
When a mint's balance reaches the threshold (checked at start and after every flush that swapped
sats in), the whole balance less the swap fee is sent as P2PK proofs locked to the owner's wallet
key and published as a NIP-61 nutzap to the owner's pubkey; their NIP-60/61 wallet picks it up and
melts to Lightning when they choose. This replaces melting on the server:

- no Lightning invoices, LNURL client or control socket on the daemon;
- the server holds only a small balance, and what it paid out is locked to a key it does not
  hold, so a later compromise cannot take it back.

Safety:

- **The owner's kind 10019 must confirm `payout.p2pk`** before anything leaves (a payout is
  irreversible and the key is typed into a config file). Signed by `payout.pubkey`, fetched from
  the payout relays, verified. Another key named there stops payouts until restart; none found
  keeps the money on the server and asks again next run. A relay can withhold or serve a stale
  10019 — both stop payouts, neither misdirects them.
- The runtime refuses a payout that names the node's own keys.
- Each locked set is appended to `<dataDir>/wallet/payouts.jsonl` (0600, fsynced) before it is
  published; a set no relay accepted is published again on the next run, also after a restart.
  The proofs in it are locked to the owner, so the file is safe at rest.
- Residual (F31 class): a crash between the mint's swap and that append loses the payout. NUT-13
  deterministic outputs close it.

Privacy: a payout is a public nutzap, so it links the seeder's pubkey to the owner's and shows
amounts. Operators who mind use a dedicated wallet pubkey for `payout.pubkey`.

## 8. For Cameron — answered 2026-09-24

1. **Melt-out** → payout to the owner's wallet instead (§7); the owner melts from their wallet.
   Melting on the daemon stays possible later (a control socket), not planned.
2. **Wallet storage** → a local file, now NIP-44 encrypted to the node key (§2); no NIP-60 on the
   server.
3. **Nutzap recipient** → one `policy.creatorPubkey` per daemon for now; a manifest-driven daemon
   (author and `p2pk` from each video's event) is the later step.
4. **Paid views** → counting nutzap senders now counts seeders, deliberately: naming viewers would
   publish who watched what. Recommended: show sats to the creator per video (already in the
   nutzaps and in trending) and drop the view count until a private count exists — a change to the
   `VideoStats` contract, trending and three screens, for the UI polish lane (Cameron reviews it).

## 9. The gateway on the same runtime (`stage-3/gateway-runtime`)

`createNodeRuntime` is the seeder daemon's runtime with its config mapping taken out; the daemon
(`createSeederRuntime`) and the gateway (`packages/gateway/src/cli/providers.ts`) both call it.
What differs for the gateway:

- **Credential** `gateway-key-passphrase` (the unit's `LoadCredentialEncrypted=`).
- **Identity in the config.** The gateway's config names `identity.pubkey` / `identity.p2pk`
  (its HELLO and dev-mocks use them), so the runtime refuses to start when they are not the key
  file's: a HELLO naming another P2PK key would have viewers pay to a key the gateway cannot
  redeem with. `--keygen` parses the config without them and prints both. The redacting logger
  keeps a well-formed compressed key whole under the field `ownP2pk` only (the node's own).
- **Two engines, one wallet.** The seeder-side engine (downstream PAYs, nutzaps, payout) and a
  viewer-side engine paying UPSTREAM seeders (`UpstreamPayer`) share the sealed wallet.
- **Blossom auth** is `BlossomAuthImpl` bound to `blossom.publicUrl`'s host.
- **pay/1** stays the gateway's own (marked-up HELLO); `wirePay: false`.
- **Swarm sessions (security review F38, fixed).** The gateway attached pay/1 on `session-open`,
  when a swarm connection has no Protomux yet, so it never paid an upstream swarm peer; it now
  uses `Seeder.onSessionReady`, like the daemon (a swarm integration test fails without it).
- **Open: upstream pacing (F37).** The gateway does not hold upstream requests to the seeders'
  unpaid window; a fast reader outruns its PAYs and gets it cut and banned. Latent: nothing in the
  shipped gateway fetches upstream on its own (`openUpstreamCore` is API-only). The desktop solved this
  with a credit pool settled by ACKs (`app-desktop/src/worker/playback/credit.ts`); the next lane
  moves that into the shared `UpstreamPayer` so the gateway and the desktop use one implementation.

## Consequences

- `nutflix-seeder.service` can run for real: `--keygen` once, `systemd-creds encrypt` once,
  `systemctl enable --now`, and a `payout` block to get the earnings out. deploy/systemd/README.md
  has the steps.
- F10 and F12 (and the F11 / F31 hooks) are wired for the daemon; F24 is done for the daemon (the
  desktop's `KeyStore` is still open).
- New: `runtime/` (Node only, never reachable from `portable.ts`: entry-hygiene.test.ts),
  `LocalSigner.walletP2pk` (the compressed public half of the wallet key; public data, kept after
  `lock()`), `SeederProcess.readStdin?`.
- Tests: config (every new field and refusal), each runtime part, the built entry under the unit's
  flags (`--keygen` from a pipe, a real start with a credential directory, READY, clean SIGTERM),
  and the runtime over real hyperswarm with the TestMint (HELLO on a swarm session, PAYs ACKed,
  the wallet file filled, one nutzap the creator redeems, and a crash before the flush recovered
  from `pending.json`).
