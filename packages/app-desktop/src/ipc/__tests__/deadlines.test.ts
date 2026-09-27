/**
 * The money plane's deadlines (ADR 0012 amendment 2026-09-25, lane I2-paygate): the worker's
 * `pay.build` deadline must exceed the worst the host's side of a PAY takes outside a melt, and
 * the belt must leave a PAY that starts in time its whole worst time. `ipc/deadlines.ts` has the
 * model; this pins it, and pins its relay numbers to the nostr-tools the host publishes with.
 * (Why a PAY is never queued behind a melt at all: a melt may run `MELT_REQUEST_TIMEOUT_MS`, far
 * past the belt — `host/__tests__/pay-melt-gate.test.ts` and `money.test.ts` test the gate.)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SimplePool } from 'nostr-tools/pool';
import { Relay } from 'nostr-tools/relay';
import { describe, expect, it } from 'vitest';

import {
  COUNTER_SAVE_WORST_MS,
  MINT_REQUEST_TIMEOUT_MS,
  PAY_BUILD_MINT_ROUND_TRIPS,
  PAY_BUILD_RELAY_PUBLISHES,
  PAY_BUILD_SEEDED_START_BY_MS,
  PAY_BUILD_SEEDED_WORST_MS,
  PAY_BUILD_SENDS,
  PAY_BUILD_SETTLE_ROUND_TRIPS_PER_ENTRY,
  PAY_BUILD_START_BY_MS,
  PAY_BUILD_WORST_MS,
  RELAY_PUBLISH_WORST_MS,
  SEND_ROUND_TRIPS,
  WORKER_HOST_REQUEST_TIMEOUT_MS,
  payBuildStartByMs,
  payBuildWorstMs,
  sendStartByMs,
} from '../deadlines.js';

describe('money plane deadlines', () => {
  it("the worker's pay.build deadline exceeds the worst host-side PAY time outside a melt", () => {
    expect(PAY_BUILD_WORST_MS).toBe(
      PAY_BUILD_MINT_ROUND_TRIPS * MINT_REQUEST_TIMEOUT_MS +
        PAY_BUILD_RELAY_PUBLISHES * RELAY_PUBLISH_WORST_MS,
    );
    // Two sends (seeder share, creator share): at least a swap each, a mint load, and each
    // send's three NIP-60 events.
    expect(PAY_BUILD_MINT_ROUND_TRIPS).toBeGreaterThanOrEqual(1 + 2 * 2);
    expect(PAY_BUILD_RELAY_PUBLISHES).toBeGreaterThanOrEqual(2 * 3);
    expect(WORKER_HOST_REQUEST_TIMEOUT_MS).toBeGreaterThan(PAY_BUILD_WORST_MS);
  });

  it('the belt: a PAY that reaches the wallet in time finishes before the worker gives up, and a queued one gets a real wait', () => {
    expect(PAY_BUILD_START_BY_MS).toBe(WORKER_HOST_REQUEST_TIMEOUT_MS - PAY_BUILD_WORST_MS);
    expect(PAY_BUILD_START_BY_MS + PAY_BUILD_WORST_MS).toBeLessThanOrEqual(
      WORKER_HOST_REQUEST_TIMEOUT_MS,
    );
    // Room for at least one PAY ahead of it at the same mint taking a slow mint round trip.
    expect(PAY_BUILD_START_BY_MS).toBeGreaterThanOrEqual(MINT_REQUEST_TIMEOUT_MS);
  });

  it('round 4 (I2 verifier): the belt is per PAY — each journal entry at its mint costs each send a restore and a check; a loaded mint skips the load', () => {
    expect(payBuildWorstMs(0, false)).toBe(PAY_BUILD_WORST_MS);
    expect(PAY_BUILD_SENDS).toBe(2);
    expect(PAY_BUILD_SETTLE_ROUND_TRIPS_PER_ENTRY).toBeGreaterThanOrEqual(2); // restore + check
    expect(payBuildWorstMs(1, false) - payBuildWorstMs(0, false)).toBe(
      PAY_BUILD_SENDS * PAY_BUILD_SETTLE_ROUND_TRIPS_PER_ENTRY * MINT_REQUEST_TIMEOUT_MS,
    );
    expect(payBuildWorstMs(0, false) - payBuildWorstMs(0, true)).toBe(MINT_REQUEST_TIMEOUT_MS);
    // The verifier's count: 2 × (restore + check + swap + follow-up) round trips + 6 publishes.
    expect(payBuildWorstMs(1, true)).toBe(8 * MINT_REQUEST_TIMEOUT_MS + 6 * RELAY_PUBLISH_WORST_MS);
    // Never looser than the fixed belt; one entry at a loaded mint leaves 15.6 s; one at a mint
    // not loaded, or two, leave none (every PAY there is refused).
    expect(payBuildStartByMs(0, false)).toBe(PAY_BUILD_START_BY_MS);
    expect(payBuildStartByMs(0, true)).toBe(PAY_BUILD_START_BY_MS);
    expect(payBuildStartByMs(1, true)).toBe(15_600);
    expect(payBuildStartByMs(1, false)).toBeLessThan(0);
    expect(payBuildStartByMs(2, true)).toBeLessThan(0);
    for (const n of [0, 1, 2, 3])
      for (const loaded of [false, true]) {
        const startBy = payBuildStartByMs(n, loaded);
        if (startBy >= 0)
          expect(startBy + payBuildWorstMs(n, loaded)).toBeLessThanOrEqual(
            WORKER_HOST_REQUEST_TIMEOUT_MS,
          );
      }
    // A count that is not one refuses (read as more entries than any mint holds).
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(payBuildStartByMs(bad, true)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('W8a: a seeded PAY costs what its sends cost — restore AND NUT-07 after a lost answer, a probe, one capped collision batch, the counters-file saves — and its belt shrinks to match', () => {
    const MINT = MINT_REQUEST_TIMEOUT_MS;
    const RELAY = RELAY_PUBLISH_WORST_MS;
    // The reviewer's seeded send: swap, then a NUT-09 restore and the NUT-07 `ran` check.
    expect(SEND_ROUND_TRIPS + 1).toBe(3);
    // 2 × (swap + restore + NUT-07) + one probe + one collision batch = 8 round trips at a loaded
    // mint; 6 publishes; 3 saves (two leases and the skip-ahead's).
    expect(PAY_BUILD_SEEDED_WORST_MS).toBe(8 * MINT + 6 * RELAY + 3 * COUNTER_SAVE_WORST_MS);
    expect(payBuildWorstMs(0, true, true)).toBe(PAY_BUILD_SEEDED_WORST_MS);
    expect(PAY_BUILD_SEEDED_START_BY_MS).toBe(12_600);
    expect(payBuildStartByMs(0, true, true)).toBe(12_600);
    // Every model count is at least the unseeded one; unseeded numbers are unchanged.
    expect(payBuildWorstMs(0, false, false)).toBe(PAY_BUILD_WORST_MS);
    for (const n of [0, 1, 2])
      for (const loaded of [false, true])
        expect(payBuildWorstMs(n, loaded, true)).toBeGreaterThan(payBuildWorstMs(n, loaded));
    // The mint not loaded, or any journal entry at it: no seeded start is early enough (the money
    // plane loads and probes the mint before the turn, so the first case does not stall PAYs).
    expect(payBuildStartByMs(0, false, true)).toBeLessThan(0);
    expect(payBuildStartByMs(1, true, true)).toBeLessThan(0);
    // The reviewer's case: a seeded PAY admitted by the belt now finishes before the deadline.
    for (const n of [0, 1, 2, 3])
      for (const loaded of [false, true])
        for (const seeded of [false, true]) {
          const startBy = payBuildStartByMs(n, loaded, seeded);
          if (startBy >= 0)
            expect(startBy + payBuildWorstMs(n, loaded, seeded)).toBeLessThanOrEqual(
              WORKER_HOST_REQUEST_TIMEOUT_MS,
            );
        }
    // Each send's own bound at its turn: the last send has the worst of one send left (swap,
    // restore, NUT-07, the probe and the collision batch; 3 publishes; 2 saves) — 125.8 s — and
    // the first has the whole PAY's (not capped by the PAY belt's ceiling: its turn may come
    // after an operation the gate did not see).
    expect(sendStartByMs(0, true, true, 1)).toBe(
      WORKER_HOST_REQUEST_TIMEOUT_MS - (5 * MINT + 3 * RELAY + 2 * COUNTER_SAVE_WORST_MS),
    );
    expect(sendStartByMs(0, true, true, 2)).toBe(PAY_BUILD_SEEDED_START_BY_MS);
    expect(sendStartByMs(0, true, false, 2)).toBe(
      WORKER_HOST_REQUEST_TIMEOUT_MS - payBuildWorstMs(0, true),
    );
    for (const n of [0, 1])
      for (const seeded of [false, true])
        for (const left of [1, 2]) {
          const by = sendStartByMs(n, true, seeded, left);
          if (by >= 0)
            expect(by + payBuildWorstMs(n, true, seeded, left)).toBe(
              WORKER_HOST_REQUEST_TIMEOUT_MS,
            );
        }
    // A count that is not one refuses; a send count that is not one reads as the whole PAY.
    expect(sendStartByMs(Number.NaN, true, true, 1)).toBe(Number.NEGATIVE_INFINITY);
    expect(sendStartByMs(0, true, true, 0)).toBe(sendStartByMs(0, true, true, 2));
  });

  it("the relay numbers are the host's nostr-tools defaults (SimplePool, Relay)", () => {
    const pool = new SimplePool();
    const relay = new Relay('wss://relay.deadlines.test');
    try {
      expect(RELAY_PUBLISH_WORST_MS).toBeGreaterThanOrEqual(
        pool.maxWaitForConnection + relay.publishTimeout,
      );
    } finally {
      pool.destroy();
    }
  });

  it('the worker runs on the shared deadline: its entry sets no request timeout of its own', () => {
    // `WorkerRpc`'s `requestTimeoutMs` is for tests; a production value here would move the
    // deadline the host's PAY builds are kept inside.
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const entry = readFileSync(join(src, 'worker', 'entry.ts'), 'utf8');
    expect(entry).toMatch(/new WorkerRpc\(/);
    expect(entry).not.toMatch(/requestTimeoutMs/);
  });
});
