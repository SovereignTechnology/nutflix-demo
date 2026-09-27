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
 *   - A wallet with a recovery phrase (ADR 0016; lane W8a, final cross-lane review) costs more per
 *     send: an answer lost after its swap is decided by a NUT-09 restore AND a NUT-07 check
 *     (signatures on seeded outputs may be another wallet's on the same phrase), a refusal is
 *     checked by a restore before the reconcile, each send may save a counters-file lease, a keyset
 *     the counters file does not know is probed (one NUT-09 batch), and a counter collision costs a
 *     skip-ahead batch and a save. Core bounds a PAY's sends for this (`SendBound`): a collision is
 *     reported, never run again, its skip-ahead asks one batch — so it ends the PAY, at most once.
 *     The money plane loads the mint and probes its active keyset BEFORE the PAY takes its turn
 *     (`CashuWallet.prepare`), so a seeded PAY is modelled at a loaded mint with one probe left in
 *     it (a keyset rotated in meanwhile). A seeded PAY with no entries at its mint has 12.6 s to
 *     start; with any entry there, none.
 *   - Each send of a PAY is asked again when its own turn at the mint comes (`SendBound.onTurn`,
 *     `sendStartByMs`): an operation the gate does not see (a redeem, the settle loop) may hold the
 *     mint when a PAY build reaches core, and core's queue is FIFO — a send that would start too
 *     late for what is left of the PAY is refused there with nothing spent.
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
 * What a send adds with a recovery phrase (ADR 0016; W8a): after a lost answer, the NUT-09 restore
 * is followed by a NUT-07 check (does the mint show the send ran, or are the signatures another
 * wallet's on this phrase?); after a refusal, a restore comes before the reconcile's NUT-07.
 */
export const SEEDED_SEND_EXTRA_ROUND_TRIPS = 1;

/**
 * A probe inside a seeded PAY build: one NUT-09 batch for a keyset the counters file does not
 * know. The money plane probes the mint's active keyset before the PAY takes its turn
 * (`CashuWallet.prepare`), so one is due inside a build only for a keyset rotated in since: once.
 */
export const PAY_BUILD_SEEDED_PROBE_ROUND_TRIPS = 1;

/**
 * A NUT-13 counter collision inside a PAY build: one skip-ahead batch (core caps it for a bounded
 * send, `SendBound`) and no second attempt — the collision ends the PAY with nothing spent, so it
 * is counted once per PAY.
 */
export const PAY_BUILD_COLLISION_ROUND_TRIPS = 1;

/**
 * Each journal entry at the mint, with a recovery phrase: its settle may find a collision and skip
 * ahead one batch (once: the entry is gone after it).
 */
export const SEEDED_SETTLE_EXTRA_ROUND_TRIPS_PER_ENTRY = 1;

/**
 * One save of the NUT-13 counters file (`host/recovery/files.ts`: read, a fresh temp file written
 * and fsynced, renamed, the directory fsynced). An allowance for a local disk, not a bound the code
 * enforces — like the wallet journal's own writes, which the model does not count either (a disk
 * that stalls for seconds stalls every write).
 */
export const COUNTER_SAVE_WORST_MS = 1_000;

/**
 * Counters-file saves of a seeded PAY build: each send's lease (a reservation past the leased range
 * saves the next lease first), the collision skip-ahead's, and one per journal entry (a collision
 * its settle finds).
 */
export const SEEDED_SEND_COUNTER_SAVES = 1;
export const PAY_BUILD_COLLISION_COUNTER_SAVES = 1;
export const SEEDED_SETTLE_COUNTER_SAVES_PER_ENTRY = 1;

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
 * Relay publishes of one send: it commits the wallet's new token event, the deletion of the old one
 * and a history line (NIP-60), published in order.
 */
export const SEND_RELAY_PUBLISHES = 3;

/** Relay publishes, one after another, of one PAY build: each of its sends'. */
export const PAY_BUILD_RELAY_PUBLISHES = PAY_BUILD_SENDS * SEND_RELAY_PUBLISHES;

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
 * One PAY build's worst host-side time — or, with `sends`, the worst of its last `sends` sends —
 * with `pending` journal entries at its mint, `loaded` when that mint has loaded (no load round
 * trip), `seeded` when the wallet derives from a recovery phrase (W8a: the extra round trips and
 * counters-file saves above). `seeded` is required: leaving it out must not pick the looser
 * belt. `payBuildWorstMs(0, false, false)` is `PAY_BUILD_WORST_MS`.
 */
export function payBuildWorstMs(
  pending: number,
  loaded: boolean,
  seeded: boolean,
  sends: number = PAY_BUILD_SENDS,
): number {
  const n = entries(pending);
  const k = Number.isSafeInteger(sends) && sends >= 1 ? sends : PAY_BUILD_SENDS;
  const perSend =
    SEND_ROUND_TRIPS +
    (seeded ? SEEDED_SEND_EXTRA_ROUND_TRIPS : 0) +
    n * PAY_BUILD_SETTLE_ROUND_TRIPS_PER_ENTRY;
  const trips =
    (loaded ? 0 : MINT_LOAD_ROUND_TRIPS) +
    k * perSend +
    (seeded
      ? PAY_BUILD_SEEDED_PROBE_ROUND_TRIPS +
        PAY_BUILD_COLLISION_ROUND_TRIPS +
        n * SEEDED_SETTLE_EXTRA_ROUND_TRIPS_PER_ENTRY
      : 0);
  const saves = seeded
    ? k * SEEDED_SEND_COUNTER_SAVES +
      PAY_BUILD_COLLISION_COUNTER_SAVES +
      n * SEEDED_SETTLE_COUNTER_SAVES_PER_ENTRY
    : 0;
  return (
    trips * MINT_REQUEST_TIMEOUT_MS +
    k * SEND_RELAY_PUBLISHES * RELAY_PUBLISH_WORST_MS +
    saves * COUNTER_SAVE_WORST_MS
  );
}

/**
 * The belt of ONE PAY (cross-lane review round 4): how soon after its request arrived it must
 * reach the wallet, with `pending` journal entries at its mint and `loaded` / `seeded` as above —
 * what is left of the worker's deadline after that PAY's worst time, never more than
 * `PAY_BUILD_START_BY_MS`. Negative when no start is early enough: the PAY is refused.
 */
export function payBuildStartByMs(pending: number, loaded: boolean, seeded: boolean): number {
  return Math.min(
    PAY_BUILD_START_BY_MS,
    WORKER_HOST_REQUEST_TIMEOUT_MS - payBuildWorstMs(pending, loaded, seeded),
  );
}

/**
 * The bound of ONE SEND of a PAY at its turn at the mint (W8a, `SendBound.onTurn`): how soon after
 * the PAY's request arrived that send must start, with `sendsLeft` sends of the PAY still to run
 * (itself included) — what is left of the worker's deadline after their worst time. A send that
 * starts later is refused with nothing spent: an operation queued ahead of it at the mint (one the
 * gate does not see) ran too long, or the send before it did.
 */
export function sendStartByMs(
  pending: number,
  loaded: boolean,
  seeded: boolean,
  sendsLeft: number,
): number {
  return WORKER_HOST_REQUEST_TIMEOUT_MS - payBuildWorstMs(pending, loaded, seeded, sendsLeft);
}

/** A seeded PAY's worst at a loaded mint with no journal entries (W8a; the belt below). */
export const PAY_BUILD_SEEDED_WORST_MS = payBuildWorstMs(0, true, true);

/** A seeded PAY's belt at a loaded mint with no journal entries: 12.6 s. */
export const PAY_BUILD_SEEDED_START_BY_MS = payBuildStartByMs(0, true, true);
