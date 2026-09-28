/**
 * F54 (the round-8 verifier of lane W8b-p2p): the desktop HELLO's price ceiling after a restart.
 *
 * The worker's HELLO states a ceiling — the highest price among the cores it serves — and each
 * core's own price follows as `PRICE` before its first block (ADR 0012 §4). The ceiling was the
 * highest price in `Seeder.corePolicyMap()`, which round 8 made persistent (`core-policies.json`,
 * up to 16 384 cores, so a core sold before a restart is never marked free). From then on it never
 * came down: a node that had once sold a 5-sat video said 5 in every HELLO after every restart,
 * and a desktop viewer (which also compared the HELLO: `viewer-payer.test.ts`) refused to pay it
 * for a 2-sat video. Now it counts the cores open in THIS run, each at its own price, while the
 * kept policies still refuse free — the rule round 8 keeps them for.
 */
import type { CashuP2pkPubkey, PricePolicy, Sats } from '@sovit/core';
import { mocks } from '@sovit/core';
import { Seeder, nodeFs, silentLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import { sodiumCrypto } from '../crypto.js';
import { servedPriceCeiling } from '../pay/real-providers.js';
import { tempDir } from './helpers/harness.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const at = (sats: number): PricePolicy => ({
  satsPerBlock: sats as Sats,
  blockSize: 65_536,
  mints: [mocks.MINTS.a],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: `02${'c7'.repeat(32)}` as CashuP2pkPubkey,
});

/** A seeder as the worker creates one (`host.ts`); the same `dataDir` again is a restart. */
function seederOn(dataDir: string): Promise<Seeder> {
  return Seeder.create(
    { dataDir, diskCapBytes: 1 << 24, swarm: null },
    {
      engine: new mocks.MockPaymentEngine(),
      fs: nodeFs,
      crypto: sodiumCrypto,
      logger: silentLogger,
    },
  );
}

describe('the HELLO price ceiling (F54): the cores open in this run, never a policy kept from an earlier one', () => {
  it('after a restart the kept policies neither raise the ceiling nor stop refusing free; a core open again counts at its price', async () => {
    const t = await tempDir('nf-f54-ceiling-');
    cleanups.push(t.rm);
    expect(servedPriceCeiling(null)).toBe(0); // before the seeder exists

    // Run 1: a 5-sat video and a 2-sat one, open and priced (as `upload()` and `playOpen` leave
    // them).
    const first = await seederOn(t.dir);
    cleanups.push(() => first.close()); // idempotent: closed below, and here if a check fails first
    const dear = (await first.openCore('video-dear')).keyHex;
    const cheap = (await first.openCore('video-cheap')).keyHex;
    first.setCorePolicy(dear, at(5));
    first.setCorePolicy(cheap, at(2));
    expect(servedPriceCeiling(first)).toBe(5); // within one run, as before
    await first.close(); // waits for the policy file

    // Run 2: both policies are back (round 8)…
    const second = await seederOn(t.dir);
    cleanups.push(() => second.close());
    expect(second.corePolicyMap().get(dear)?.satsPerBlock).toBe(5);
    expect(second.corePolicyMap().get(cheap)?.satsPerBlock).toBe(2);
    // …but neither core is open: nothing is served at a price yet. Before the fix: 5, read from
    // the file — and it stayed 5 until 16 384 newer policies pushed it out.
    expect(servedPriceCeiling(second)).toBe(0);
    // The rule the file is kept for stands (round 8): a thumbnail URL naming either video cannot
    // make it free on our seeder.
    for (const core of [dear, cheap]) {
      expect(second.setFreeCore(core, true)).toBe(false);
      expect(second.isFreeCore(core)).toBe(false);
    }
    // The 2-sat video played again (`playOpen`: its manifest policy, then the open).
    second.setCorePolicy(cheap, at(2));
    expect((await second.openCore('video-cheap')).keyHex).toBe(cheap);
    expect(servedPriceCeiling(second)).toBe(2); // before the fix: 5, the dear video's kept price
    // The dear video's policy is still kept, and still refuses free.
    expect(second.corePolicyMap().get(dear)?.satsPerBlock).toBe(5);
    expect(second.setFreeCore(dear, true)).toBe(false);
    expect(second.isFreeCore(dear)).toBe(false);
    // Open again, a core is served at its price (kept or set in this run), so it counts again.
    await second.openCore('video-dear');
    expect(servedPriceCeiling(second)).toBe(5);
  });
});
