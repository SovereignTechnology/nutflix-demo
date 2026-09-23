# Contract requests — lane L6-C (desktop worker)

Issued against `CONTRACTS_VERSION = 4` and the frozen L6-0 IPC surface (`packages/app-desktop/src/ipc/`).
Nothing below blocks Stage 1: each item has a local work-around in `src/worker/`, named with it.
Items 1–3 are core (`packages/core`), 4 is L6-0's `src/ipc/`, 5–6 are `@sovit/seeder`.

## 1. `range-not-uploaded` cannot be decided per block with v4 (core, payment contract + mock)

`PaymentEngineSeeder.recordUpload(peer, blocks, core?)` carries **no block index**, so an engine
only knows HOW MANY blocks of a core it sent a peer, never WHICH. `MockPaymentEngine.verify` then
decides `range-not-uploaded` as `range.toBlock >= uploadedCount(peer, core)` — it reads a block
INDEX as a COUNT, i.e. it assumes every viewer downloads a core from ONE seeder as a prefix
`[0, n)`. Two things any real viewer does break that:

- **seeking** — a viewer that jumps to block 500 and receives 11 blocks can never pay for them
  (`500 >= 11`);
- **several seeders** — design §5(a): S2 holds `[16, 32)`, sends 16 blocks, and the viewer's
  `PAY` for block 16 is refused (`16 >= 16`); the viewer is then cut at the window. (Found by the
  §5(a) test; `__tests__/dev.test.ts` shows the plain mock refusing and `DevEngine` accepting.)

**Request (v5):** either add the index to the upload record —
`recordUpload(peer, blocks, core?, index?: BlockIndex)` (the seeder's `PeerSession.onUpload`
already has it) — so `range-not-uploaded` means "not all of these blocks were sent to you"; or
specify the count rule the contract CAN express today and make the mock implement it:
_per core, a peer may pay for at most `uploaded − paid` blocks, never for the same block twice_.

**Work-around:** `src/worker/dev/dev-engine.ts` (`DevEngine`, `--dev-mocks` and the §5(a) rig
only) wraps `MockPaymentEngine('honest')` and enforces exactly that count rule: replay is checked
on the real indexes, and the mock is handed the next `blocks` ordinals of the peer's paid
sequence (`[paid, paid + blocks − 1]`). Every other rule is the mock's own code.

## 2. Mock proof secrets collide across wallets (core, mocks)

`MockPaymentEngine` mints secrets `mock:<counter>:<target>` from a per-INSTANCE counter, so two
mock wallets paying the same seeder mint IDENTICAL secrets and the seeder's swap batch bans the
second payer for a double-spend it did not commit. Any rig with two viewers (the worker + a
mirroring seeder in §5(a)) hits it. **Request:** put an instance id in mock secrets (e.g.
`mock:<id>.<counter>:…`). **Work-around:** `DevEngine.pay` namespaces its secrets the same way.

## 3. `pay/1`: ACK has no core, HELLO has no window (core, pay-protocol contract, Stage 2 codec)

- `AckMessage` carries `fromBlock`/`toBlock` but not `range.core`. A viewer paying two cores over
  one connection cannot tell which PAY an ACK answers when the ranges coincide. **Request:**
  `core?: CoreKeyHex` on `ACK` (and on `PRICE`, which L2/L3 already noted). **Work-around:** the
  worker's `ViewerPayer` matches ACKs to its own PAYs FIFO by `(fromBlock, toBlock)` per peer.
- The viewer must stay under each seeder's unpaid window or it is cut and banned, but `HELLO`
  does not say what the window is. **Request:** `windowBlocks` in `HELLO`. **Work-around:** the
  worker's `CreditPool` uses the contract default `DEFAULT_WINDOW_BLOCKS` (4) for every seeder.

## 4. Worker protocol: a graceful `shutdown` request (L6-0, `src/ipc/worker-protocol.ts`)

The host can stop the worker only by killing it: `bare-sidecar`'s Duplex has no `_final`, so
`sidecar.end()` never reaches the child's fd 3, and `destroy()` is `SIGTERM`. The worker exits
cleanly (closes sessions, pays tails, closes the swarm and Corestore, exit 0) when its fd 3
ENDS or CLOSES — i.e. when the host process dies — but a live host has no way to ask for that.
**Request:** a host → worker `shutdown` request (`{}` → `undefined`; the worker answers, then
exits 0). **Work-around:** none needed for correctness (RocksDB is crash-safe, the seeder's JSON
stores are atomic) — L6-B kills; the tests end the child's socket directly.

## 5. `@sovit/seeder`: swarm hooks (L2)

`SwarmManager` cannot bind its DHT to loopback and never hands out the connection, so a shell
cannot attach `pay/1` to swarm sessions or fence dev mode to 127.0.0.1. **Request:** a
`SwarmConfig.host` (DHT bind address) and an `onSession(session, conn)` hook (or a
`session-open` event carrying the connection). **Work-around:** the worker creates its seeder
with `swarm: null` and runs its own `PeerNode` (Hyperswarm with `firewall =
seeder.banList.firewall`, admission through `seeder.sessions.admit`, replication through
`seeder.blobs.store`) — the same calls `SwarmManager` makes.

## 6. `@sovit/seeder`: runtime disk cap (L2)

`DiskCap.capBytes` is fixed at construction, so `Settings.seeding.diskCapBytes` changes
(`seeder.configure`) apply only at the next worker start. **Request:** `Seeder.setDiskCap(bytes)`.
