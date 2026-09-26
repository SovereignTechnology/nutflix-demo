/**
 * The money plane's deadlines, shared by the host and the worker (ADR 0012 amendment 2026-09-25,
 * lane I2-paygate). Plain numbers: the worker's Bare bundle imports this module too.
 *
 * How they fit together:
 *
 *   - The worker waits `WORKER_HOST_REQUEST_TIMEOUT_MS` for the host's answer to a `pay.build`
 *     (`worker/rpc.ts`), and the host cannot cancel a build once it started
 *     (`host/worker/supervisor.ts` runs every request to completion). A PAY the host finishes
 *     after that is lost: its proofs are already P2PK-locked to the seeder and the creator, the
 *     worker never delivers them, and the viewer cannot take them back.
 *   - Core runs a wallet's operations at one mint one at a time (`Spender.exclusive`). A melt
 *     holds that turn until the mint has paid the invoice, up to `MELT_REQUEST_TIMEOUT_MS`. A PAY
 *     queued behind it could not finish in time, so PAYs never queue behind a melt: the money
 *     plane's per-mint gate (`host/pay-melt-gate.ts`) refuses a PAY at once while a melt is
 *     pending or in flight at its mint, and a melt waits for the PAY in flight there.
 *   - Outside a melt, a PAY build's own worst time is `PAY_BUILD_WORST_MS`, which is shorter than
 *     the worker's deadline (pinned by `ipc/__tests__/deadlines.test.ts`). PAY builds at one mint
 *     take turns in the host, so the wait for a turn is visible there. A PAY that has not reached
 *     the wallet `PAY_BUILD_START_BY_MS` after its request arrived is refused (the belt): what is
 *     left of the worker's deadline would not cover its worst time.
 *
 * `PAY_BUILD_WORST_MS` is a model of what the host bounds, not a proof over every path. It counts
 * mint round trips at the host transport's timeout and relay publishes at nostr-tools' timeouts,
 * for a PAY alone at its mint with no journal entries left there. It leaves out a NIP-46 bunker's
 * own latency when the wallet's events are signed (a key in memory takes microseconds), and wallet
 * operations that are not PAYs or melts running at the same mint (a redeem, a NUT-07 check, the
 * journal's settle loop: each a few mint round trips of `MINT_REQUEST_TIMEOUT_MS`).
 */

/** Every mint request but a melt: the host transport's whole-exchange timeout. */
export const MINT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A melt request (`POST …/v1/melt/{method}`): the mint pays the invoice before it answers, and a
 * Lightning payment can take a minute or more (issue #8 fix round 3).
 */
export const MELT_REQUEST_TIMEOUT_MS = 300_000;

/** How long the worker waits for the host's answer to a worker → host request, `pay.build` too. */
export const WORKER_HOST_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Mint round trips, one after another, of one PAY build: loading the mint once (info, keysets and
 * keys go out together: 1), then two P2PK sends (the seeder's share and the creator's), each a
 * swap and at most one follow-up (a NUT-09 restore after a lost answer, or a NUT-07 check after a
 * refusal): 2 × 2.
 */
export const PAY_BUILD_MINT_ROUND_TRIPS = 5;

/**
 * One relay publish at its worst: nostr-tools waits up to 3 s for a connection
 * (`maxWaitForConnection`) and 4.4 s for the relay's answer (`publishTimeout`). The pool publishes
 * to every relay at once.
 */
export const RELAY_PUBLISH_WORST_MS = 7_400;

/**
 * Relay publishes, one after another, of one PAY build: each send commits the wallet's new token
 * event, the deletion of the old one and a history line (NIP-60), published in order.
 */
export const PAY_BUILD_RELAY_PUBLISHES = 6;

/** The host's side of one PAY build at its worst, outside a melt (the model above). */
export const PAY_BUILD_WORST_MS =
  PAY_BUILD_MINT_ROUND_TRIPS * MINT_REQUEST_TIMEOUT_MS +
  PAY_BUILD_RELAY_PUBLISHES * RELAY_PUBLISH_WORST_MS;

/**
 * The belt: a PAY build must reach the wallet this soon after its request arrived, or it is
 * refused with nothing spent. What is left of the worker's deadline covers its worst time.
 */
export const PAY_BUILD_START_BY_MS = WORKER_HOST_REQUEST_TIMEOUT_MS - PAY_BUILD_WORST_MS;
