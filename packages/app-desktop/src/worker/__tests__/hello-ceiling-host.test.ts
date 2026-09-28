/**
 * F54, the host's own wiring (lane W8b-p2p, round 9): the `priceCeiling` closure `host.ts` hands
 * to `realProviders` — the ONLY thing that feeds the worker's HELLO price — is exercised itself,
 * not only the `servedPriceCeiling` helper (`hello-ceiling.test.ts`). Putting the closure back as
 * it was at `86826a0` (the highest price in `seeder.corePolicyMap()`, kept policies included) fails
 * this file; so does any closure that stops reading the worker's live seeder.
 *
 * `realProviders` is wrapped (vi.mock, hoisted above the imports) to capture the options the host
 * passes, then called for real: the worker runs its real money plane (`init.payments`), on a local
 * testnet (`testBootstrap`). No peer connects, so no HELLO is signed and the host is asked nothing.
 *
 * WRITTEN, NOT RUN: Cameron's rule of 2026-09-27 allows no test runner on this machine. This runs
 * in CI; what it catches is reasoned in the review record (round 9).
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { CashuP2pkPubkey, CoreKeyHex, NostrPubkey, PricePolicy, Sats } from '@sovit/core';
import { mocks } from '@sovit/core';
import { Seeder, nodeFs, silentLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlayOpenArgs } from '../../ipc/worker-protocol.js';
import { sodiumCrypto } from '../crypto.js';
import { startDevTestnet } from '../dev/fixtures-net.js';
import type * as RealProvidersModule from '../pay/real-providers.js';
import { startWorker, tempDir } from './helpers/harness.js';

const captured = vi.hoisted(() => ({ priceCeiling: null as (() => number) | null }));
vi.mock('../pay/real-providers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RealProvidersModule>();
  return {
    ...actual,
    realProviders: (o: RealProvidersModule.RealProviderOptions) => {
      captured.priceCeiling = o.priceCeiling;
      return actual.realProviders(o);
    },
  };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const V = mocks.VIDEOS[0]!;
const R = V.renditions[0]!;
const at = (sats: number): PricePolicy => ({ ...V.price, satsPerBlock: sats as Sats });

function playOpen(core: CoreKeyHex, policy: PricePolicy): PlayOpenArgs {
  return {
    sid: randomBytes(16).toString('hex') as PlayOpenArgs['sid'],
    videoId: V.id,
    rendition: { label: R.label, hyper: { ...R.hyper, core }, size: R.size, bitrateKbps: 2500 },
    policy,
    prefetchSeconds: 30,
  };
}

describe('the HELLO price ceiling as host.ts wires it (F54, round 9)', () => {
  it('after a restart, the closure host.ts passes says 0 for policies kept from an earlier run, then the price of each core opened in this run', async () => {
    const t = await tempDir('nf-r9-ceiling-host-');
    cleanups.push(t.rm);

    // An earlier run of the worker's seeder (`<storage>/seeder`, as `host.ts` creates it) sold a
    // 5-sat and a 2-sat video; their policies are kept on disk (round 8).
    const earlier = await Seeder.create(
      { dataDir: join(t.dir, 'seeder'), diskCapBytes: 1 << 30, swarm: null },
      {
        engine: new mocks.MockPaymentEngine(),
        fs: nodeFs,
        crypto: sodiumCrypto,
        logger: silentLogger,
      },
    );
    cleanups.push(() => earlier.close()); // idempotent: closed below
    const dear = (await earlier.openCore('video-dear')).keyHex;
    const cheap = (await earlier.openCore('video-cheap')).keyHex;
    earlier.setCorePolicy(dear, at(5));
    earlier.setCorePolicy(cheap, at(2));
    await earlier.close(); // waits for the policy file

    // This run: the worker with its real money plane, on a local testnet.
    const testnet = await startDevTestnet();
    cleanups.push(() => testnet.destroy());
    const w = startWorker({ logLevel: 'error', testBootstrap: testnet.bootstrap });
    cleanups.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: t.dir,
      seeding: { enabled: true, diskCapBytes: 1 << 30 },
      prefetchSeconds: 30,
      payments: {
        pubkey: 'ab'.repeat(32) as NostrPubkey,
        p2pk: `02${'cd'.repeat(32)}` as CashuP2pkPubkey,
        mints: [mocks.MINTS.a],
      },
    });
    const ceiling = captured.priceCeiling;
    if (ceiling === null) throw new Error('host.ts did not start its real providers');

    // Nothing is open at a price yet. The closure as at `86826a0` said 5 here — read from the
    // policy file, and it stayed 5 in every HELLO of every later run.
    expect(ceiling()).toBe(0);

    // The 2-sat video played again: open in this run at its price. Before the fix: 5.
    const a = playOpen(cheap, at(2));
    await w.call('play.open', a);
    expect(ceiling()).toBe(2);

    // The 5-sat video played again as well: the closure follows the live seeder up.
    const b = playOpen(dear, at(5));
    await w.call('play.open', b);
    expect(ceiling()).toBe(5);

    await w.call('play.close', { sid: a.sid });
    await w.call('play.close', { sid: b.sid });
  }, 60_000);
});
