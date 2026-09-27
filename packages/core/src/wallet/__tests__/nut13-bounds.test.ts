/**
 * Lane W8a (final cross-lane review, money plane / NUT-13) against the in-process `TestMint`:
 *
 *   holdMint        every NUT-13 restore (per mint), every reissue and its plan, and each mint's
 *                   journal settle run inside the shell's per-mint gate; a gate that refuses a
 *                   mint before the scan leaves that mint unreachable (the resume it was given
 *                   kept) and the others scanned;
 *   bounded sends   a PAY build's sends (`SendBound`): the caller is asked at the send's turn —
 *                   after what was queued ahead of it at the mint — and a refusal there spends
 *                   and journals nothing; a counter collision is reported, never run again, and
 *                   the skip-ahead past it asks ONE batch even at a NUT-12 mint;
 *   prepare         the mint loaded and its keyset probed before the bound starts;
 *   close           the watermark write at close can be skipped by the shell (a late write must
 *                   not land after the next wallet's);
 *   journal         a `begin` whose id is still journaled is refused, never a silent replace.
 */
import { describe, expect, it, vi } from 'vitest';

import type { MintUrl, UnixSeconds } from '../../contracts/index.js';
import { MemoryCounterStore } from '../../mocks/counter-store.js';
import { TestMint } from '../../mocks/test-mint.js';
import { minimumCost } from '../../signer/keyfile.js';
import { LocalSigner } from '../../signer/local.js';
import { Nip60ProofStore } from '../nip60.js';
import { JournalConflictError, MemoryProofStore, proofTotal, type PendingOp } from '../store.js';
import { CashuWallet } from '../wallet.js';
import {
  MINT_A,
  MINT_B,
  TO,
  device,
  fund,
  hold,
  knownCounters,
  newSeed,
  sats,
  type Device,
} from './nut13-rig.js';

// Real in-process mints (a hash-to-curve per output, NUT-09 batches of 100 derived outputs): under
// the whole suite on a shared box that overruns vitest's 5 s default (as in nut13-wallet.test.ts).
vi.setConfig({ testTimeout: 60_000 });

const mintA = (): TestMint =>
  new TestMint({ url: MINT_A, seed: new Uint8Array(32).fill(0x41), feeReserve: 4 });
const mintB = (): TestMint => new TestMint({ url: MINT_B, seed: new Uint8Array(32).fill(0x42) });

/** A wallet over `d`'s connections and store, with a recording `holdMint`. */
function gated(
  d: Device,
  refuse: ReadonlySet<MintUrl> = new Set(),
): { wallet: CashuWallet; held: MintUrl[] } {
  const held: MintUrl[] = [];
  const wallet = new CashuWallet({
    mints: d.conns,
    store: d.store,
    holdMint: <T>(mint: MintUrl, run: () => Promise<T>): Promise<T> => {
      held.push(mint);
      return refuse.has(mint) ? Promise.reject(new Error('rate-limited: gate')) : run();
    },
  });
  return { wallet, held };
}

describe('holdMint: the long operations at a mint run inside the shell’s gate (W8a)', () => {
  it('a restore asks the gate once per mint; a mint the gate refuses is unreachable (its resume kept) and never asked, the others are scanned', async () => {
    const a = mintA();
    const b = mintB();
    const seed = await newSeed();
    const d = device({ mints: [a, b], seed });
    await fund(d, a, 7);
    await fund(d, b, 5);
    const other = new MemoryProofStore();
    const fresh = device({
      mints: [a, b],
      seed: await newSeed(),
      store: other,
    });
    const { wallet, held } = gated(fresh, new Set([MINT_A]));
    const atA = a.calls.length;
    const reports = await wallet.seeded!.restoreFromSeed(seed, [MINT_A, MINT_B], undefined, {
      resume: new Map([[MINT_A, { [a.keysetId]: 300 }]]),
    });
    expect(held).toEqual([MINT_A, MINT_B]);
    expect(reports).toEqual([
      { mint: MINT_A, outcome: 'unreachable', restoredSats: 0, resume: { [a.keysetId]: 300 } },
      { mint: MINT_B, outcome: 'restored', restoredSats: 5 },
    ]);
    // Nothing reached mint A; mint B's balance came back.
    expect(a.calls.length).toBe(atA);
    expect(await other.proofs(MINT_A)).toEqual([]);
    expect(proofTotal(await other.proofs(MINT_B))).toBe(5);
  });

  it('a reissue and its plan, the startup restore and the journal settle each pass through the gate at their mint', async () => {
    const a = mintA();
    const seed = await newSeed();
    const d = device({ mints: [a], seed, counters: knownCounters(a.keysetId, 0) });
    await hold(d.store, MINT_A, a.issue(64));
    const { wallet, held } = gated(d);
    const plan = await wallet.seeded!.reissuePlan(MINT_A);
    expect(held).toEqual([MINT_A]);
    await wallet.seeded!.reissue(plan);
    expect(held).toEqual([MINT_A, MINT_A]);
    await wallet.recoverPending();
    expect(held).toEqual([MINT_A, MINT_A, MINT_A]);
    // A reopened wallet over the same counters file: its range since the last watermark is
    // restored at startup — inside the gate too.
    const again = device({ mints: [a], seed, counters: d.counters, store: d.store });
    const g2 = gated(again);
    await g2.wallet.restoreUnpublished();
    expect(g2.held).toEqual([MINT_A]);
  });

  it('a startup restore at a mint the gate refuses reports it unreachable and keeps its range held', async () => {
    const a = mintA();
    const seed = await newSeed();
    const d = device({ mints: [a], seed });
    await fund(d, a, 7);
    const again = device({ mints: [a], seed, counters: d.counters, store: d.store });
    const g = gated(again, new Set([MINT_A]));
    const r = await g.wallet.restoreUnpublished();
    expect(r).toEqual([{ mint: MINT_A, outcome: 'unreachable', restoredSats: 0 }]);
    expect(again.net.restores()).toBe(0);
    // Still unpublished: the next call scans it.
    expect((await again.conns.seeding!.counters.unpublished()).length).toBe(1);
  });
});

describe('a bounded send (SendBound: a PAY build) — W8a', () => {
  it('is asked at its turn, after the operation queued ahead of it at the mint; a refusal there spends and journals nothing', async () => {
    const a = mintA();
    const d = device({ mints: [a], seed: await newSeed(), counters: knownCounters(a.keysetId, 0) });
    await hold(d.store, MINT_A, a.issue(64));
    const turns: number[] = [];
    const release = d.net.hold('/v1/swap');
    const ahead = d.wallet.receive({ mint: MINT_A, proofs: a.issue(8) });
    const sent = d.wallet.send(sats(5), {
      p2pk: TO,
      mint: MINT_A,
      bound: {
        // What the store holds when the turn comes: the receive ahead has committed by then.
        onTurn: async () => {
          turns.push(proofTotal(await d.store.proofs(MINT_A)));
          throw new Error('rate-limited: too late');
        },
      },
    });
    const swaps = (): number => d.net.calls.filter((c) => c === 'POST /v1/swap').length;
    await new Promise((r) => setTimeout(r, 30));
    expect(turns).toEqual([]); // the send waits behind the receive at the mint
    release();
    await expect(ahead).resolves.toBe(8);
    await expect(sent).rejects.toThrow(/rate-limited: too late/);
    expect(turns).toEqual([72]);
    expect(swaps()).toBe(1); // the receive's only
    expect(await d.store.pending!(MINT_A)).toEqual([]);
    expect(await d.wallet.balance(MINT_A)).toBe(72);
  });

  it('a counter collision is reported once, never run again; the skip-ahead asks ONE batch at a NUT-12 mint (an unbounded send asks until it is past)', async () => {
    const a = mintA();
    const seed = await newSeed();
    // Another wallet on this phrase signed counters in three batches: 0–2, 100 and 200.
    const other = device({ mints: [a], seed, counters: knownCounters(a.keysetId, 0) });
    await fund(other, a, 7);
    await other.conns.seeding!.counters.advanceToAtLeast(a.keysetId, 100);
    await fund(other, a, 1);
    await other.conns.seeding!.counters.advanceToAtLeast(a.keysetId, 200);
    await fund(other, a, 1);

    const bounded = device({ mints: [a], seed, counters: knownCounters(a.keysetId, 0) });
    await hold(bounded.store, MINT_A, a.issue(64));
    const r0 = bounded.net.restores();
    await expect(
      bounded.wallet.send(sats(5), { p2pk: TO, mint: MINT_A, bound: { onTurn: () => undefined } }),
    ).rejects.toMatchObject({ code: 'mint-error', message: expect.stringContaining('collision') });
    // One swap; the restore of its outputs, and ONE skip-ahead batch.
    expect(bounded.net.calls.filter((c) => c === 'POST /v1/swap')).toHaveLength(1);
    expect(bounded.net.restores() - r0).toBe(2);
    expect(await bounded.wallet.balance(MINT_A)).toBe(64); // nothing spent
    expect(await bounded.store.pending!(MINT_A)).toEqual([]);
    // Its change drew counters 0–4; one batch from there finds the signature at 100.
    expect((await bounded.conns.seeding!.counters.snapshot())[a.keysetId]).toBe(101);

    // The same send without a bound: past every batch the other wallet signed, then once more.
    const free = device({ mints: [a], seed, counters: knownCounters(a.keysetId, 0) });
    await hold(free.store, MINT_A, a.issue(64));
    const r1 = free.net.restores();
    const set = await free.wallet.send(sats(5), { p2pk: TO, mint: MINT_A });
    expect(proofTotal(set.proofs)).toBe(5);
    expect(free.net.calls.filter((c) => c === 'POST /v1/swap')).toHaveLength(2);
    // The restore of its outputs, then batches from 5, 105 and 205 (empty): past 200.
    expect(free.net.restores() - r1).toBe(1 + 3);
  });

  it('a bound without onTurn is refused before anything', async () => {
    const a = mintA();
    const d = device({ mints: [a], seed: await newSeed(), counters: knownCounters(a.keysetId, 0) });
    await expect(
      d.wallet.send(sats(1), { p2pk: TO, mint: MINT_A, bound: {} as never }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(d.net.calls).toEqual([]);
  });

  it('prepare loads the mint and probes its keyset once: the bounded send after it asks no NUT-09 before its swap', async () => {
    const a = mintA();
    const d = device({ mints: [a], seed: await newSeed() }); // no counters file: a probe is due
    await hold(d.store, MINT_A, a.issue(64));
    await d.wallet.prepare(MINT_A);
    expect(d.net.restores()).toBe(1);
    const before = d.net.calls.length;
    await d.wallet.send(sats(5), { p2pk: TO, mint: MINT_A, bound: { onTurn: () => undefined } });
    const after = d.net.calls.slice(before);
    expect(after.filter((c) => c.endsWith('/v1/restore'))).toEqual([]);
    expect(after).toContain('POST /v1/swap');
    // An unseeded wallet: prepare only loads.
    const u = device({ mints: [a] });
    await u.wallet.prepare(MINT_A);
    expect(u.net.restores()).toBe(0);
    expect(u.net.calls.length).toBeGreaterThan(0);
  });
});

describe('close({ flush }) — W8a', () => {
  it('the watermark write at close is skipped when the shell says so, and made by default', async () => {
    const a = mintA();
    const seed = await newSeed();
    const d = device({ mints: [a], seed });
    await fund(d, a, 7); // the watermark moved after the top-up (written with the next lease)
    const saves = d.counters.saved.length;
    let asked = 0;
    await d.wallet.close({
      flush: () => {
        asked++;
        return false;
      },
    });
    expect(asked).toBe(1);
    expect(d.counters.saved.length).toBe(saves);
    expect(seed.wiped).toBe(true);

    const seed2 = await newSeed();
    const e = device({ mints: [a], seed: seed2 });
    await fund(e, a, 7);
    const n = e.counters.saved.length;
    await e.wallet.close();
    expect(e.counters.saved.length).toBe(n + 1);
    expect(seed2.wiped).toBe(true);
  });
});

describe('a journal begin whose id is still journaled is refused (W8a, info item)', () => {
  const op = (tag: string): PendingOp => ({
    id: `02${'bb'.repeat(32)}`,
    kind: 'send',
    mint: MINT_A,
    key: [`secret-${tag}`],
    keep: [
      {
        blindedMessage: { amount: '2', B_: `02${'bb'.repeat(32)}`, id: '00aa' },
        blindingFactor: '7',
        secret: tag.repeat(32).slice(0, 64),
      },
    ],
    send: [],
    spends: [],
    created: 1_900_000_000 as UnixSeconds,
  });

  it('MemoryProofStore: the second begin rejects and changes nothing; a begin that settles the old id replaces it', async () => {
    const st = new MemoryProofStore();
    await st.commit({ mint: MINT_A, spent: [], added: [], begin: op('a') });
    await expect(
      st.commit({
        mint: MINT_A,
        spent: [],
        added: [{ id: '00aa', amount: 1, secret: 's', C: '02' + '11'.repeat(32) }],
        begin: op('b'),
      }),
    ).rejects.toBeInstanceOf(JournalConflictError);
    expect((await st.pending(MINT_A)).map((o) => o.key)).toEqual([['secret-a']]);
    expect(await st.proofs(MINT_A)).toEqual([]); // the whole transition was refused
    await st.commit({ mint: MINT_A, spent: [], added: [], settle: [op('a').id], begin: op('c') });
    expect((await st.pending(MINT_A)).map((o) => o.key)).toEqual([['secret-c']]);
  });

  it('Nip60ProofStore: the same', async () => {
    const { signer } = await LocalSigner.create({
      passphrase: new TextEncoder().encode('pw pw pw pw'),
      cost: minimumCost(),
    });
    const st = await Nip60ProofStore.load({
      signer,
      relays: { publish: () => Promise.resolve(), query: () => Promise.resolve([]) },
    });
    await st.commit({ mint: MINT_A, spent: [], added: [], begin: op('a') });
    await expect(
      st.commit({ mint: MINT_A, spent: [], added: [], begin: op('b') }),
    ).rejects.toBeInstanceOf(JournalConflictError);
    expect((await st.pending(MINT_A)).map((o) => o.key)).toEqual([['secret-a']]);
    await st.commit({ mint: MINT_A, spent: [], added: [], settle: [op('a').id], begin: op('c') });
    expect((await st.pending(MINT_A)).map((o) => o.key)).toEqual([['secret-c']]);
  });

  it('a wallet whose counters repeat an id still journaled: the new operation fails before its request, the older entry is kept', async () => {
    const a = mintA();
    const seed = await newSeed();
    const store = new MemoryProofStore();
    const d = device({ mints: [a], seed, counters: knownCounters(a.keysetId, 0), store });
    await hold(store, MINT_A, a.issue(64));
    await d.wallet.prepare(MINT_A); // loaded
    // The first send never gets an answer: its entry stays (its inputs held).
    d.net.down.add(MINT_A);
    await expect(d.wallet.send(sats(5), { p2pk: TO, mint: MINT_A })).rejects.toThrow();
    d.net.down.delete(MINT_A);
    const kept = await store.pending(MINT_A);
    expect(kept).toHaveLength(1);
    // A counters file rolled back to 0 (a restored backup) over the same journal.
    const rolled = device({
      mints: [a],
      seed,
      counters: new MemoryCounterStore({ v: 1, next: { [a.keysetId]: 0 }, published: {} }),
      store,
    });
    const swaps = a.calls.filter((c) => c === 'POST /v1/swap').length;
    await expect(rolled.wallet.receive({ mint: MINT_A, proofs: a.issue(8) })).rejects.toThrow();
    expect(a.calls.filter((c) => c === 'POST /v1/swap').length).toBe(swaps);
    expect((await store.pending(MINT_A)).map((o) => o.id)).toEqual(kept.map((o) => o.id));
  });
});
