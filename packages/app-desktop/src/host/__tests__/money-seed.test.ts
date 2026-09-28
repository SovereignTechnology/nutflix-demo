/**
 * ADR 0016: the money plane with this device's recovery phrase, on CORE's real NUT-13 code (lane
 * N1, wired at `recovery/core.ts` `recoveryCore()`). The seed option is spread into the plane's ONE
 * connections constructor, the wallet is handed that connections instance itself (so
 * `CashuWallet.seeded` reads the seed there, and every output derives from it and draws its
 * counters from `seed.counters`) and still reaches the mint as before; the plane owns the seed —
 * wiped on close and on a failed open — and closes the wallet's counter source with it; a seed
 * the wallet did not take is logged, wiped at once and never reported as in use; a wiped seed is
 * never derived from.
 *
 * Integration fix 2: these tests used to hand the real connections a fake seed from test support,
 * which core refuses (it did not make it) — so the plane never opened. Core's own phrases and
 * seeds are used now; the only stand-in left is a core whose seed option gets lost (a renamed
 * key), where losing it is the point.
 */
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';

import type { CashuP2pkPubkey, MintUrl, RelayUrl, Sats, UnixSeconds } from '@sovit/core';
import { mocks, nostr, signer as signerMod, wallet as walletMod } from '@sovit/core';

import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import type { RecoveryCore } from '../recovery/core.js';
import { recoveryCore } from '../recovery/core.js';
import type { PlaneSeed } from '../recovery/service.js';

const MINT = 'https://mint.money-seed.test' as MintUrl;
const RELAY = 'wss://relay.money-seed.test' as RelayUrl;
const PHRASE = '7f'.repeat(16);
const OTHER_PHRASE = '3c'.repeat(16);
const TO = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x4d))).toString(
  'hex',
) as CashuP2pkPubkey;

/** Core's real seed for a phrase given as entropy hex (what `RecoveryService.seedFor` makes). */
function seedOf(hex: string): Promise<walletMod.RecoverySeed> {
  return walletMod.recoveryPhrases.toSeed(walletMod.entropyFromHex(hex));
}

/**
 * Core's real recovery code, recording what the plane handed it — a spy that passes every call
 * through, not a fake. `loseOption`: the seed option comes back empty, as a core whose option key
 * was renamed would leave it (the one stand-in: the lost option is the point).
 */
function spyCore(o: { loseOption?: boolean } = {}) {
  const real = recoveryCore();
  if (real === undefined) throw new Error('recoveryCore() is not wired');
  const materials: walletMod.SeedMaterial[] = [];
  const asked: walletMod.CashuWallet[] = [];
  const core: RecoveryCore = {
    phrases: real.phrases,
    seedOption: (m) => {
      materials.push(m);
      return o.loseOption === true ? {} : real.seedOption(m);
    },
    seeded: (w) => {
      asked.push(w);
      return real.seeded(w);
    },
    phraseTag: (seed) => real.phraseTag(seed),
  };
  return { core, materials, asked };
}

async function open(o: {
  core: RecoveryCore;
  seed?: walletMod.RecoverySeed;
  create?: boolean;
  counters?: walletMod.CounterStore;
}) {
  const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x62) });
  const { signer } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from('money seed test passphrase'),
    cost: signerMod.minimumCost(),
  });
  const seed = o.seed ?? (await seedOf(PHRASE));
  const counters = o.counters ?? new mocks.MemoryCounterStore();
  const planeSeed: PlaneSeed = { material: { seed, counters }, core: o.core };
  const log = memoryLogger('debug');
  let t = 1_757_000_000;
  const opening = MoneyPlane.open({
    signer,
    journalDir: null,
    tailDir: null, // in memory: not about tail authorisations (merge of P2 and N2)
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

async function fund(plane: MoneyPlane, mint: mocks.TestMint, sats: number): Promise<void> {
  const q = await plane.wallet.mintQuote(MINT, sats as Sats);
  mint.payQuote(q.quoteId);
  await plane.wallet.pollQuote(q);
}

describe('MoneyPlane with a recovery phrase (ADR 0016, core’s real NUT-13 code)', () => {
  it('seeded: the option reached the one connections, the wallet derives from the seed and its counters, close closes the counter source and wipes the seed', async () => {
    const spy = spyCore();
    const counters = new mocks.MemoryCounterStore();
    const { mint, seed, opening } = await open({ core: spy.core, counters });
    const plane = await opening;
    expect(spy.materials).toHaveLength(1);
    expect(spy.materials[0]?.seed).toBe(seed);
    expect(spy.materials[0]?.counters).toBe(counters);
    // `seeded` was asked about the plane's wallet — the one over those connections — and is
    // core's own `CashuWallet.seeded`.
    expect(spy.asked).toEqual([plane.wallet]);
    expect(plane.seeded).toBeDefined();
    expect(plane.seeded).toBe(plane.wallet.seeded);

    // The wallet reaches the mint through the same connections (the in-place `wallet` wrapper).
    await fund(plane, mint, 64);
    expect(await plane.wallet.balance(MINT)).toBe(64);
    // Its outputs drew their counters from `seed.counters` (a lease for the mint's keyset)…
    expect(counters.state?.next[mint.keysetId]).toBeGreaterThan(0);
    // …and derive from the seed: the words alone bring the 64 back, on another wallet.
    const again = await seedOf(PHRASE);
    const other = new walletMod.CashuWallet({
      mints: new walletMod.CashuMintConnections({
        request: () => mint.request,
        seed: { seed: again, counters: new mocks.MemoryCounterStore() },
      }),
      store: new walletMod.MemoryProofStore(),
    });
    const reports = await other.seeded?.restoreFromSeed(again, [MINT]);
    expect(reports?.map((r) => [r.mint, r.outcome, r.restoredSats])).toEqual([
      [MINT, 'restored', 64],
    ]);
    await other.close();

    // A paid quote, left for after the close.
    const late = await plane.wallet.mintQuote(MINT, 8 as Sats);
    mint.payQuote(late.quoteId);
    expect(seed.wiped).toBe(false);
    plane.close();
    expect(seed.wiped).toBe(true);
    // Integration fix 2: the wallet's counter source was closed with the plane — nothing is
    // reserved through it any more (and nothing reaches the mint)… W8a: the plane's close now
    // also runs the wallet's own close (core's contract request 4), so the operation is refused
    // one step earlier — by the closed wallet, before it asks the counter source (the message this
    // line pinned before, `the NUT-13 counters cannot be used`, came from that later refusal).
    const sent = mint.calls.length;
    await expect(plane.wallet.pollQuote(late)).rejects.toThrow(/the wallet is closed/);
    expect(mint.calls.slice(sent)).not.toContain('POST /v1/mint/bolt11');
    // …so another phrase may use the same counters store object (core refuses that while a
    // source of this phrase is still open over it).
    const rotated = await seedOf(OTHER_PHRASE);
    expect(
      () => new walletMod.CashuMintConnections({ seed: { seed: rotated, counters } }),
    ).not.toThrow();
    rotated.wipe();
  });

  it('a seed wiped under an open plane is never derived from: the operation is refused before it reaches the mint, and nothing is lost', async () => {
    const spy = spyCore();
    const { mint, seed, opening } = await open({ core: spy.core });
    const plane = await opening;
    await fund(plane, mint, 64);
    const before = mint.calls.length;
    // As a premature wipe would leave it (the seam: core refuses a wiped seed).
    seed.wipe();
    // A mint request: its outputs are derived — refused at derivation, before the request.
    const q = await plane.wallet.mintQuote(MINT, 32 as Sats);
    mint.payQuote(q.quoteId);
    await expect(plane.wallet.pollQuote(q)).rejects.toThrow(/RecoverySeedError|seed is wiped/);
    // A send whose change is derived: refused the same way.
    await expect(plane.wallet.send(10 as Sats, { p2pk: TO, mint: MINT })).rejects.toThrow(
      /RecoverySeedError|seed is wiped/,
    );
    const after = mint.calls.slice(before);
    expect(after.filter((c) => c === 'POST /v1/mint/bolt11' || c === 'POST /v1/swap')).toEqual([]);
    expect(await plane.wallet.balance(MINT)).toBe(64);
    plane.close();
  });

  it('a seed wiped before its mint was reached: that mint is refused at load, nothing derived', async () => {
    const spy = spyCore();
    const { mint, seed, opening } = await open({ core: spy.core });
    const plane = await opening;
    seed.wipe();
    await expect(plane.wallet.mintQuote(MINT, 32 as Sats)).rejects.toThrow(/seed is wiped/);
    expect(mint.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    plane.close();
  });

  it('a plane handed an already-wiped seed does not open (core refuses it at the connections)', async () => {
    const spy = spyCore();
    const seed = await seedOf(PHRASE);
    seed.wipe();
    const { opening } = await open({ core: spy.core, seed });
    await expect(opening).rejects.toThrow(/recovery seed is wiped/);
    expect(spy.materials).toHaveLength(1);
  });

  it('a seed the wallet did not take: never "in use" — logged as an error and wiped at once', async () => {
    const spy = spyCore({ loseOption: true });
    const { seed, log, opening } = await open({ core: spy.core });
    const plane = await opening;
    expect(plane.seeded).toBeUndefined();
    expect(plane.wallet.seeded).toBeUndefined();
    expect(seed.wiped).toBe(true);
    expect(
      log.lines.some(
        (l) => l.level === 'error' && l.msg.includes('recovery phrase not taken by the wallet'),
      ),
    ).toBe(true);
    plane.close();
  });

  it('a plane that fails to open wipes the seed it was given', async () => {
    const spy = spyCore();
    const { seed, opening } = await open({ core: spy.core, create: false });
    await expect(opening).rejects.toThrow(/no-wallet/);
    // It failed before the connections were built (no NIP-60 wallet): the plane wiped it anyway.
    expect(spy.materials).toHaveLength(0);
    expect(seed.wiped).toBe(true);
  });
});
