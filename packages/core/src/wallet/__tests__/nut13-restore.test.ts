/**
 * ADR 0016 §3, §5 and D5 (issue #3) against the in-process `TestMint`: restoring from a recovery
 * phrase, reissuing today's balance into seeded outputs, and the startup restore of what a crash
 * may have kept from NIP-60.
 *
 *   restoreFromSeed    what is unspent and not held comes back, spent proofs are filtered, one
 *                      history line per mint; a second run adds nothing; three empty batches of
 *                      100 end the scan (not cashu-ts's default single batch); a NUT-12 mint must
 *                      send a DLEQ and an amount lie fails it; at a mint without NUT-12 the proofs
 *                      are swapped before they count; inactive and v1 keysets are scanned, within
 *                      the keyset and batch caps; unsupported and unreachable mints are reported;
 *   another phrase     restores without being adopted: nothing is derived from it afterwards;
 *   own phrase         restored on a lost counters file moves the counters past it;
 *   reissue            plan (the fee shown) → confirm; refused when the holdings changed, for a
 *                      stale or forged plan, and where outputs could not be restored;
 *   startup restore    `[published, next)` brings back change the store never recorded.
 */
import { describe, expect, it, vi } from 'vitest';

import { MemoryCounterStore } from '../../mocks/counter-store.js';
import { TestMint } from '../../mocks/test-mint.js';
import {
  RESTORE_BATCH,
  RESTORE_EMPTY_BATCHES,
  RESTORE_MAX_BATCHES,
  RESTORE_MAX_KEYSETS,
} from '../spend.js';
import { recoveryPhrases } from '../seed.js';
import { MemoryProofStore, proofTotal } from '../store.js';
import {
  MINT_A,
  MINT_B,
  TO,
  derivedSecrets,
  device,
  fund,
  hold,
  knownCounters,
  newSeed,
  sats,
} from './nut13-rig.js';

// Each test runs a real in-process mint: a hash-to-curve per output and a NUT-09 scan of hundreds
// of derived outputs; under the whole suite on a shared box that overruns vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const MINT_C = 'https://mint.nut13-c.example' as typeof MINT_A;

const mintAt = (url: typeof MINT_A, o: Partial<ConstructorParameters<typeof TestMint>[0]> = {}) =>
  new TestMint({ url, seed: new Uint8Array(32).fill(url === MINT_A ? 0x51 : 0x52), ...o });

interface Sig {
  amount: number;
  dleq?: unknown;
}

describe('restoreFromSeed (ADR 0016 §5)', () => {
  it('restores what is unspent and not held; spent proofs are filtered; one history line', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const a = device({ mints: [mint], seed: phrase });
    await fund(a, mint, 64);
    await a.wallet.send(sats(5), { p2pk: TO, mint: MINT_A }); // spends the 64
    expect(await a.wallet.receive({ mint: MINT_A, proofs: mint.issue(16) })).toBe(16);
    expect(await a.wallet.balance(MINT_A)).toBe(75);

    const c = device({ mints: [mint], seed: await newSeed() });
    const progress: unknown[] = [];
    const reports = await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A], (p) =>
      progress.push(p),
    );
    expect(reports).toEqual([{ mint: MINT_A, outcome: 'restored', restoredSats: 75 }]);
    expect(await c.wallet.balance(MINT_A)).toBe(75);
    expect(progress).toEqual([{ mint: MINT_A, keysetsDone: 1, keysets: 1 }]);
    const hist = await c.wallet.history();
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({
      direction: 'in',
      amount: 75,
      memo: 'restored from recovery phrase',
    });
    // What came back is the phrase's own, and nothing spent came back.
    const mine = derivedSecrets(phrase, mint.keysetId);
    for (const p of await c.store.proofs(MINT_A)) {
      expect(mine.has(p.secret)).toBe(true);
      expect(mint.isSpent(p.secret)).toBe(false);
    }
  });

  it('a second run adds nothing (deduped by secret); proofs spent since leave the store', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const a = device({ mints: [mint], seed: phrase });
    await fund(a, mint, 40);
    const c = device({ mints: [mint], seed: await newSeed() });
    await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    expect(await c.wallet.balance(MINT_A)).toBe(40);
    expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'nothing', restoredSats: 0 },
    ]);
    // The phrase's other holder spends some of them: the next restore drops those, adds the change.
    await a.wallet.send(sats(3), { p2pk: TO, mint: MINT_A });
    const [r] = await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    expect(r?.outcome).toBe('restored');
    expect(await c.wallet.balance(MINT_A)).toBe(await a.wallet.balance(MINT_A));
    for (const p of await c.store.proofs(MINT_A)) expect(mint.isSpent(p.secret)).toBe(false);
  });

  it('three empty batches of 100 end the scan (a gap of 300), not one', async () => {
    expect([RESTORE_BATCH, RESTORE_EMPTY_BATCHES]).toEqual([100, 3]);
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const k = mint.keysetId;
    await fund(device({ mints: [mint], seed: phrase, counters: knownCounters(k, 0) }), mint, 7);
    // 250: inside the gap (batch 2 of 0..), so the scan must still find it.
    await fund(device({ mints: [mint], seed: phrase, counters: knownCounters(k, 250) }), mint, 8);
    // 650: after three empty batches (300..599), so the scan has ended before it.
    await fund(device({ mints: [mint], seed: phrase, counters: knownCounters(k, 650) }), mint, 16);
    const c = device({ mints: [mint], seed: await newSeed() });
    const [r] = await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    expect(r).toEqual({ mint: MINT_A, outcome: 'restored', restoredSats: 15 });
    // Batches [0,100) hit, [100,200) empty, [200,300) hit, then three empty: six requests.
    expect(c.net.restores()).toBe(6);
  });

  it('a NUT-12 mint must send a DLEQ with every restored signature', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    await fund(device({ mints: [mint], seed: phrase }), mint, 7);
    const c = device({ mints: [mint], seed: await newSeed() });
    c.net.rewrite = (path, res) => {
      if (path.endsWith('/v1/restore'))
        for (const sig of res['signatures'] as Sig[]) delete sig.dleq;
    };
    expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'refused', restoredSats: 0 },
    ]);
    expect(await c.wallet.balance(MINT_A)).toBe(0);
    expect(await c.wallet.history()).toEqual([]);
  });

  it('an amount lie fails the DLEQ (checked against the CLAIMED amount’s key) and nothing counts', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    await fund(device({ mints: [mint], seed: phrase }), mint, 7);
    const c = device({ mints: [mint], seed: await newSeed() });
    c.net.rewrite = (path, res) => {
      if (path.endsWith('/v1/restore'))
        for (const sig of res['signatures'] as Sig[]) sig.amount = sig.amount * 2;
    };
    expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'refused', restoredSats: 0 },
    ]);
    expect(await c.wallet.balance(MINT_A)).toBe(0);
  });

  it('an answer naming outputs we never asked for, or one twice, is refused', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    await fund(device({ mints: [mint], seed: phrase }), mint, 7);
    for (const lie of ['foreign', 'twice'] as const) {
      const c = device({ mints: [mint], seed: await newSeed() });
      c.net.rewrite = (path, res) => {
        if (!path.endsWith('/v1/restore')) return;
        const outs = res['outputs'] as { B_: string }[];
        const sigs = res['signatures'] as unknown[];
        if (outs.length === 0) return;
        if (lie === 'foreign') outs[0] = { ...outs[0]!, B_: '02' + '11'.repeat(32) };
        else {
          outs.push({ ...outs[0]! });
          sigs.push(sigs[0]);
        }
      };
      expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
        { mint: MINT_A, outcome: 'refused', restoredSats: 0 },
      ]);
    }
  });

  it('at a mint without NUT-12 the restored proofs are swapped into fresh outputs before they count', async () => {
    const mint = mintAt(MINT_A, { nut12: false });
    const phrase = await newSeed();
    const a = device({ mints: [mint], seed: phrase });
    await fund(a, mint, 7);
    const own = await newSeed();
    const c = device({ mints: [mint], seed: own });
    expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 7 },
    ]);
    // c holds its OWN outputs (the swap's), and the phrase's proofs are spent by that swap.
    const ownSecrets = derivedSecrets(own, mint.keysetId);
    for (const p of await c.store.proofs(MINT_A)) expect(ownSecrets.has(p.secret)).toBe(true);
    for (const p of await a.store.proofs(MINT_A)) expect(mint.isSpent(p.secret)).toBe(true);
    expect(await c.wallet.history()).toHaveLength(1);
  });

  it('at a mint without NUT-12 an amount lie is refused by the mint at that swap', async () => {
    const mint = mintAt(MINT_A, { nut12: false });
    const phrase = await newSeed();
    await fund(device({ mints: [mint], seed: phrase }), mint, 7);
    const c = device({ mints: [mint], seed: await newSeed() });
    c.net.rewrite = (path, res) => {
      if (path.endsWith('/v1/restore'))
        for (const sig of res['signatures'] as Sig[]) sig.amount = sig.amount * 2;
    };
    expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'refused', restoredSats: 0 },
    ]);
    expect(await c.wallet.balance(MINT_A)).toBe(0);
  });

  it('inactive keysets are scanned too, active first, within the keyset cap', async () => {
    expect([RESTORE_MAX_KEYSETS, RESTORE_MAX_BATCHES]).toEqual([32, 200]);
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    await fund(device({ mints: [mint], seed: phrase }), mint, 3);
    mint.rotateKeyset();
    await fund(device({ mints: [mint], seed: phrase }), mint, 4);
    const c = device({ mints: [mint], seed: await newSeed() });
    const progress: { keysets: number }[] = [];
    const [r] = await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A], (p) => progress.push(p));
    expect(r).toEqual({ mint: MINT_A, outcome: 'restored', restoredSats: 7 });
    expect(progress.at(-1)).toMatchObject({ keysetsDone: 2, keysets: 2 });
    // A cap of one keyset scans only the active one.
    const d = device({ mints: [mint], seed: await newSeed(), restoreLimits: { maxKeysets: 1 } });
    const [r1] = await d.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    expect(r1).toEqual({ mint: MINT_A, outcome: 'restored', restoredSats: 4 });
  });

  it('a v1 (00…) keyset restores through the BIP-32 path', async () => {
    const mint = mintAt(MINT_A, { keysetVersion: 0 });
    expect(mint.keysetId.startsWith('00')).toBe(true);
    const phrase = await newSeed();
    await fund(device({ mints: [mint], seed: phrase }), mint, 7);
    const c = device({ mints: [mint], seed: await newSeed() });
    expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 7 },
    ]);
  });

  it('a hostile mint that signs everything is held to the batch cap per keyset', async () => {
    const mint = mintAt(MINT_A);
    mint.hostileRestore();
    const phrase = await newSeed();
    const c = device({ mints: [mint], seed: await newSeed(), restoreLimits: { maxBatches: 4 } });
    await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    expect(c.net.restores()).toBe(4);
  });

  it('mints that cannot restore (no NUT-09) or cannot be reached are reported; the others restore', async () => {
    const a1 = mintAt(MINT_A);
    const b1 = mintAt(MINT_B, { nut09: false });
    const c1 = new TestMint({ url: MINT_C, seed: new Uint8Array(32).fill(0x53) });
    const phrase = await newSeed();
    await fund(device({ mints: [a1], seed: phrase }), a1, 7);
    const c = device({ mints: [a1, b1, c1], seed: await newSeed() });
    c.net.down.add(MINT_C);
    expect(
      await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A, MINT_B, MINT_C, MINT_A]),
    ).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 7 },
      { mint: MINT_B, outcome: 'unsupported', restoredSats: 0 },
      { mint: MINT_C, outcome: 'unreachable', restoredSats: 0 },
    ]);
  });

  it('a wiped seed is refused before anything is asked', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const c = device({ mints: [mint], seed: await newSeed() });
    phrase.wipe();
    await expect(c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(c.net.restores()).toBe(0);
  });
});

describe('ADR 0016 D3: another device’s phrase restores without being adopted', () => {
  it('nothing is derived from it afterwards: counters untouched, new outputs from this device’s own phrase', async () => {
    const mint = mintAt(MINT_A);
    const theirs = await newSeed();
    const ours = await newSeed();
    const y = device({ mints: [mint], seed: theirs });
    await fund(y, mint, 20);
    const x = device({ mints: [mint], seed: ours });
    await fund(x, mint, 3);
    const before = { ...x.counters.state?.next };
    const [r] = await x.wallet.seeded!.restoreFromSeed(theirs, [MINT_A]);
    expect(r).toEqual({ mint: MINT_A, outcome: 'restored', restoredSats: 20 });
    expect(x.counters.state?.next).toEqual(before);
    await fund(x, mint, 5);
    const oursSet = derivedSecrets(ours, mint.keysetId);
    const theirsSet = derivedSecrets(theirs, mint.keysetId);
    const fresh = (await x.store.proofs(MINT_A)).filter((p) => !theirsSet.has(p.secret));
    expect(proofTotal(fresh)).toBe(8);
    for (const p of fresh) expect(oursSet.has(p.secret)).toBe(true);
    // The other device keeps deriving where it was: no collision with anything x made.
    await fund(y, mint, 2);
    expect(y.net.codes).not.toContain(10002);
  });

  it('this device’s own phrase, restored over a lost counters file, moves the counters past it', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    await fund(device({ mints: [mint], seed: phrase }), mint, 7);
    const again = device({
      mints: [mint],
      seed: phrase,
      counters: knownCounters(mint.keysetId, 0),
    });
    await again.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    expect((await again.conns.seeding!.counters.snapshot())[mint.keysetId]).toBeGreaterThanOrEqual(
      3,
    );
    await fund(again, mint, 1);
    expect(again.net.codes).not.toContain(10002);
    expect(await again.wallet.balance(MINT_A)).toBe(8);
  });
});

describe('ADR 0016 D5: reissue the balance held today into seeded outputs', () => {
  it('the plan shows the mint’s fee; confirming swaps every held proof into outputs the words recover', async () => {
    const mint = mintAt(MINT_A, { inputFeePpk: 100 });
    const phrase = await newSeed();
    const d = device({ mints: [mint], seed: phrase });
    await hold(d.store, MINT_A, [...mint.issue(64), ...mint.issue(7)]); // 64, 4, 2, 1: random
    const plan = await d.wallet.seeded!.reissuePlan(MINT_A);
    expect(plan).toEqual({ mint: MINT_A, amount: 71, inputs: 4, feeSats: 1 });
    expect(await d.wallet.seeded!.reissue(plan)).toEqual({
      mint: MINT_A,
      reissued: 70,
      feeSats: 1,
    });
    const mine = derivedSecrets(phrase, mint.keysetId);
    for (const p of await d.store.proofs(MINT_A)) expect(mine.has(p.secret)).toBe(true);
    expect(await d.wallet.balance(MINT_A)).toBe(70);
    expect((await d.wallet.history())[0]).toMatchObject({
      direction: 'out',
      amount: 1,
      memo: 'reissued under the recovery phrase',
    });
    // The words alone bring it back.
    const c = device({ mints: [mint], seed: await newSeed() });
    expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 70 },
    ]);
  });

  it('refused when the holdings changed since the plan (the user confirmed that fee for those proofs)', async () => {
    const mint = mintAt(MINT_A);
    const d = device({ mints: [mint], seed: await newSeed() });
    await hold(d.store, MINT_A, mint.issue(16));
    const plan = await d.wallet.seeded!.reissuePlan(MINT_A);
    await hold(d.store, MINT_A, mint.issue(8));
    await expect(d.wallet.seeded!.reissue(plan)).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('changed'),
    });
    expect(mint.calls).not.toContain('POST /v1/swap');
    // Spent behind our back (same amount, other proofs) is a change too.
    const p2 = await d.wallet.seeded!.reissuePlan(MINT_A);
    const held = await d.store.proofs(MINT_A);
    await d.store.commit({ mint: MINT_A, spent: [held[0]!], added: mint.issue(held[0]!.amount) });
    await expect(d.wallet.seeded!.reissue(p2)).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('a plan is used once, must be this wallet’s latest, and cannot be forged', async () => {
    const mint = mintAt(MINT_A);
    const d = device({ mints: [mint], seed: await newSeed() });
    await hold(d.store, MINT_A, mint.issue(16));
    const plan = await d.wallet.seeded!.reissuePlan(MINT_A);
    expect(plan.feeSats).toBe(0);
    await expect(d.wallet.seeded!.reissue({ ...plan, feeSats: sats(5) })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(d.wallet.seeded!.reissue({ ...plan, amount: sats(15) })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    const other = device({ mints: [mint], seed: await newSeed(), store: d.store });
    await expect(other.wallet.seeded!.reissue(plan)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(await d.wallet.seeded!.reissue(plan)).toMatchObject({ reissued: 16 });
    await expect(d.wallet.seeded!.reissue(plan)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('refused where seeded outputs could not be restored (no NUT-09), and absent without a seed', async () => {
    const mint = mintAt(MINT_A, { nut09: false });
    const d = device({ mints: [mint], seed: await newSeed() });
    await hold(d.store, MINT_A, mint.issue(16));
    const plan = await d.wallet.seeded!.reissuePlan(MINT_A);
    await expect(d.wallet.seeded!.reissue(plan)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(await d.wallet.balance(MINT_A)).toBe(16);
    expect(device({ mints: [mint] }).wallet.seeded).toBeUndefined();
  });
});

describe('ADR 0016 §3: the startup restore of [published, next)', () => {
  it('change the store never recorded (a crash before it was published) comes back; spent proofs leave', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const counters = new MemoryCounterStore(null);
    const live = new MemoryProofStore();
    const a = device({ mints: [mint], seed: phrase, counters, store: live });
    await fund(a, mint, 64);
    // What reached durable storage: the state right after the top-up.
    const durable = new MemoryProofStore();
    await hold(durable, MINT_A, await live.proofs(MINT_A));
    await a.wallet.send(sats(5), { p2pk: TO, mint: MINT_A }); // its change never reached `durable`
    // Crash; the next start over what was durable.
    const b = device({ mints: [mint], seed: phrase, counters, store: durable });
    expect(await b.wallet.balance(MINT_A)).toBe(64); // stale: that proof is spent
    expect(await b.wallet.restoreUnpublished()).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 59 },
    ]);
    expect(await b.wallet.balance(MINT_A)).toBe(59);
    for (const p of await b.store.proofs(MINT_A)) expect(mint.isSpent(p.secret)).toBe(false);
  });

  it('after a clean close only the unused lease is scanned, and it holds nothing', async () => {
    const mint = mintAt(MINT_A);
    const entropy = recoveryPhrases.generate();
    const counters = new MemoryCounterStore(null);
    const store = new MemoryProofStore();
    const a = device({
      mints: [mint],
      seed: await recoveryPhrases.toSeed(entropy),
      counters,
      store,
    });
    await fund(a, mint, 64);
    await a.wallet.close(); // wipes a's seed: the next process makes its own from the same words
    const next = counters.state?.next[mint.keysetId] ?? 0;
    expect(counters.state?.published[mint.keysetId]).toBe(1);
    const b = device({
      mints: [mint],
      seed: await recoveryPhrases.toSeed(entropy),
      counters,
      store,
    });
    expect(await b.conns.seeding!.counters.unpublished()).toEqual([
      { keysetId: mint.keysetId, from: 1, to: next },
    ]);
    expect(await b.wallet.restoreUnpublished()).toEqual([]);
    expect(await device({ mints: [mint], store }).wallet.restoreUnpublished()).toEqual([]);
  });
});
