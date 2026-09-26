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
  MINT_REQUEST_TIMEOUT_MS,
  PAY_BUILD_MINT_ROUND_TRIPS,
  PAY_BUILD_RELAY_PUBLISHES,
  PAY_BUILD_START_BY_MS,
  PAY_BUILD_WORST_MS,
  RELAY_PUBLISH_WORST_MS,
  WORKER_HOST_REQUEST_TIMEOUT_MS,
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
