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
 *   - Journal entries left at the mint lengthen that worst time (cross-lane review round 4, from
 *     the I2 verifier): each of a PAY's two P2PK sends settles every entry there first — a NUT-09
 *     restore, then a NUT-07 check — `PAY_BUILD_SETTLE_ROUND_TRIPS_PER_ENTRY` more round trips an
 *     entry. The gated melt is exactly what leaves one: a melt that timed out, lost its answer or
 *     was answered PENDING stays journaled until the mint can say (hours, for a stuck payment).
 *     So the belt is per PAY (`payBuildStartByMs`), from the entries at its mint when its turn
 *     comes and whether that mint has loaded (then a PAY needs no load round trip): one entry at a
 *     loaded mint leaves 15.6 s to start; one at a mint not loaded, or two, leave none — every PAY
 *     there is refused (`rate-limited:`, retried) until the settle loop clears them.
 *
 * `payBuildWorstMs` is a model of what the host bounds, not a proof over every path. It counts
 * mint round trips at the host transport's timeout and relay publishes at nostr-tools' timeouts,
 * for a PAY alone at its mint. A journal entry the PAY's own settle resolves costs no more (its
 * restore, its check and one commit's three publishes, 82.2 s, is under the four round trips the
 * two sends would otherwise spend on it). It leaves out a NIP-46 bunker's own latency when the
 * wallet's events are signed (a key in memory takes microseconds), and wallet operations that are
 * not PAYs or melts running at the same mint (a redeem, a NUT-07 check, the journal's settle loop:
 * each a few mint round trips of `MINT_REQUEST_TIMEOUT_MS`), and the entries they may add while
 * the PAY runs.
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

/** Loading a mint once (info, keysets and keys go out together); none once it has loaded. */
export const MINT_LOAD_ROUND_TRIPS = 1;

/** The P2PK sends of one PAY build: the seeder's share and the creator's. */
export const PAY_BUILD_SENDS = 2;

/**
 * Round trips of one send's own request: the swap and at most one follow-up (a NUT-09 restore
 * after a lost answer, or a NUT-07 check after a refusal).
 */
export const SEND_ROUND_TRIPS = 2;

/**
 * Mint round trips, one after another, of one PAY build with no journal entries at its mint: the
 * mint load, then each send's swap and follow-up: 1 + 2 × 2.
 */
export const PAY_BUILD_MINT_ROUND_TRIPS =
  MINT_LOAD_ROUND_TRIPS + PAY_BUILD_SENDS * SEND_ROUND_TRIPS;

/**
 * Round trips each journal entry left at the mint adds to EACH send: core settles every entry
 * there before it selects proofs (`Spender.settle`: a NUT-09 restore; with nothing restored, a
 * NUT-07 check — for a melt always, for another kind once it is old enough to drop).
 */
export const PAY_BUILD_SETTLE_ROUND_TRIPS_PER_ENTRY = 2;

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

/**
 * The host's side of one PAY build at its worst, outside a melt, with no journal entries at its
 * mint and the mint not loaded yet (the model above).
 */
export const PAY_BUILD_WORST_MS =
  PAY_BUILD_MINT_ROUND_TRIPS * MINT_REQUEST_TIMEOUT_MS +
  PAY_BUILD_RELAY_PUBLISHES * RELAY_PUBLISH_WORST_MS;

/**
 * The belt's ceiling: a PAY build must reach the wallet this soon after its request arrived, or
 * it is refused with nothing spent. What is left of the worker's deadline covers its worst time.
 */
export const PAY_BUILD_START_BY_MS = WORKER_HOST_REQUEST_TIMEOUT_MS - PAY_BUILD_WORST_MS;

/** A count the model takes: a whole number ≥ 0, or it is read as more than any mint holds. */
function entries(n: number): number {
  return Number.isSafeInteger(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
}

/**
 * One PAY build's worst host-side time with `pending` journal entries at its mint, `loaded`
 * when that mint has loaded (no load round trip). `payBuildWorstMs(0, false)` is
 * `PAY_BUILD_WORST_MS`.
 */
export function payBuildWorstMs(pending: number, loaded: boolean): number {
  const trips =
    (loaded ? 0 : MINT_LOAD_ROUND_TRIPS) +
    PAY_BUILD_SENDS *
      (SEND_ROUND_TRIPS + entries(pending) * PAY_BUILD_SETTLE_ROUND_TRIPS_PER_ENTRY);
  return trips * MINT_REQUEST_TIMEOUT_MS + PAY_BUILD_RELAY_PUBLISHES * RELAY_PUBLISH_WORST_MS;
}

/**
 * The belt of ONE PAY (cross-lane review round 4): how soon after its request arrived it must
 * reach the wallet, with `pending` journal entries at its mint and `loaded` as above — what is
 * left of the worker's deadline after that PAY's worst time, never more than
 * `PAY_BUILD_START_BY_MS`. Negative when no start is early enough: the PAY is refused.
 */
export function payBuildStartByMs(pending: number, loaded: boolean): number {
  return Math.min(
    PAY_BUILD_START_BY_MS,
    WORKER_HOST_REQUEST_TIMEOUT_MS - payBuildWorstMs(pending, loaded),
  );
}
