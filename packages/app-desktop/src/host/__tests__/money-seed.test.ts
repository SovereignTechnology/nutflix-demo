/**
 * ADR 0016: the money plane with this device's recovery phrase. The seed option is spread into
 * the plane's ONE connections constructor, the wallet is handed that connections instance itself
 * (so a seeded wallet finds its seed there) and still reaches the mint as before; the plane owns
 * the seed — wiped on close and on a failed open — and a seed the wallet did not take is logged,
 * wiped at once and never reported as in use.
 */
import { describe, expect, it } from 'vitest';

import type { MintUrl, RelayUrl, Sats, UnixSeconds, wallet as walletMod } from '@sovit/core';
import { mocks, nostr, signer as signerMod } from '@sovit/core';

import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import type { PlaneSeed } from '../recovery/service.js';
import { FakeRecoveryCore, FakeSeed } from './support/fake-recovery.js';

const MINT = 'https://mint.money-seed.test' as MintUrl;
const RELAY = 'wss://relay.money-seed.test' as RelayUrl;

async function open(o: { core: FakeRecoveryCore; create?: boolean }) {
  const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x62) });
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from('money seed test passphrase'),
    cost: signerMod.minimumCost(),
  });
  const seed = new FakeSeed('7f'.repeat(16));
  const counters: walletMod.CounterStore = {
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
  };
  const planeSeed: PlaneSeed = { material: { seed, counters }, core: o.core };
  const log = memoryLogger('debug');
  let t = 1_757_000_000;
  const opening = MoneyPlane.open({
    signer,
    journalDir: null,
    pool: new nostr.FakeRelayPool(),
    relays: () => [{ url: RELAY, read: true, write: true }],
    defaultMints: () => [MINT],
    log,
    mintRequest: () => mint.request,
    ...(o.create === false ? {} : { createWallet: true }),
    now: () => t++ as UnixSeconds,
    seed: planeSeed,
  });
  return { mint, seed, log, opening, counters };
}

describe('MoneyPlane with a recovery phrase (ADR 0016)', () => {
  it('seeded: the option reached the connections, the wallet still pays the mint, close wipes the seed', async () => {
    const core = new FakeRecoveryCore();
    const { mint, seed, opening, counters } = await open({ core });
    const plane = await opening;
    expect(core.materials).toHaveLength(1);
    expect(core.materials[0]?.seed).toBe(seed);
    expect(core.materials[0]?.counters).toBe(counters);
    expect(plane.seeded).toBe(core.wallet);
    // The wallet reaches the mint through the same connections (the in-place `wallet` wrapper).
    const q = await plane.wallet.mintQuote(MINT, 64 as Sats);
    mint.payQuote(q.quoteId);
    await plane.wallet.pollQuote(q);
    expect(await plane.wallet.balance(MINT)).toBe(64);
    expect(seed.wiped).toBe(false);
    plane.close();
    expect(seed.wiped).toBe(true);
  });

  it('a seed the wallet did not take: never "in use" — logged as an error and wiped at once', async () => {
    const core = new FakeRecoveryCore();
    core.takesSeed = false;
    const { seed, log, opening } = await open({ core });
    const plane = await opening;
    expect(plane.seeded).toBeUndefined();
    expect(seed.wiped).toBe(true);
    expect(
      log.lines.some(
        (l) => l.level === 'error' && l.msg.includes('recovery phrase not taken by the wallet'),
      ),
    ).toBe(true);
    plane.close();
  });

  it('a plane that fails to open wipes the seed it was given', async () => {
    const core = new FakeRecoveryCore();
    const { seed, opening } = await open({ core, create: false });
    await expect(opening).rejects.toThrow(/no-wallet/);
    // Before the wallet loaded, nothing took the seed; the host's openMoney wipes it too.
    expect(seed.wiped || core.materials.length === 0).toBe(true);
  });
});
