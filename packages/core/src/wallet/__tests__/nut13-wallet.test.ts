/**
 * ADR 0016 §2–§4 (issue #3) against the in-process `TestMint`: a wallet over connections given
 * this device's recovery seed.
 *
 *   explicit outputs     top-up, a send's change, receive and melt change are NUT-13
 *                        deterministic; a send's locked outputs stay P2PK; unseeded connections
 *                        and a mint without NUT-09 make random outputs;
 *   counters             never repeat — across a restart, a crash (the lease), a lost counters
 *                        file (probe), and two mints announcing one keyset id; the mint never
 *                        answers "already signed" to any of it;
 *   collision guard      another wallet on this phrase signed our counters first: a fresh mint,
 *                        send, receive or melt answered 10002 advances past it and runs once
 *                        more — journaled or not; a second collision is reported and loses
 *                        nothing; a journaled operation whose outputs were signed by someone else
 *                        is NOT counted as executed while its inputs are unspent (NUT-07);
 *   close                refuses new work, waits for the running operation, then wipes the seed;
 *   watermark            `published` moves only when nothing is in flight.
 */
import { MintOperationError } from '@cashu/cashu-ts';
import { describe, expect, it, vi } from 'vitest';

import { MemoryCounterStore } from '../../mocks/counter-store.js';
import { TestMint } from '../../mocks/test-mint.js';
import { MemoryProofStore, proofTotal, type ProofStore } from '../store.js';
import { recoveryPhrases } from '../seed.js';
import {
  INVOICE_20,
  MINT_A,
  MINT_B,
  TO,
  blindedCounter,
  counterOf,
  derivedSecrets,
  device,
  fund,
  hold,
  knownCounters,
  newSeed,
  sats,
  unjournaled,
} from './nut13-rig.js';

// Each test runs a real in-process mint (a hash-to-curve per output, NUT-09 probes of 100 derived
// outputs); under the whole suite on a shared box that overruns vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const mintA = (o: Partial<ConstructorParameters<typeof TestMint>[0]> = {}): TestMint =>
  new TestMint({ url: MINT_A, seed: new Uint8Array(32).fill(0x31), feeReserve: 4, ...o });

async function secrets(store: ProofStore, mint = MINT_A): Promise<string[]> {
  return (await store.proofs(mint)).map((p) => p.secret);
}

describe('ADR 0016 §4: output types are explicit per operation', () => {
  it('a top-up mints deterministic outputs from counter 0; the counters file leases ahead', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    await fund(d, mint, 7); // 4 + 2 + 1
    const mine = derivedSecrets(seed, mint.keysetId);
    const got = await secrets(d.store);
    expect(got).toHaveLength(3);
    for (const s of got) expect(mine.has(s)).toBe(true);
    expect(got.map((s) => counterOf(seed, mint.keysetId, s)).sort()).toEqual([0, 1, 2]);
    expect(d.counters.state?.next[mint.keysetId]).toBeGreaterThanOrEqual(3 + 32);
    expect(d.wallet.seeded).toBeDefined();
  });

  it('a send: the change is deterministic, the locked outputs stay P2PK (NUT-13 derives no NUT-10 secret)', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    await fund(d, mint, 64);
    const set = await d.wallet.send(sats(5), { p2pk: TO, mint: MINT_A });
    const mine = derivedSecrets(seed, mint.keysetId);
    for (const p of set.proofs) {
      expect(p.secret.startsWith('["P2PK"')).toBe(true);
      expect(mine.has(p.secret)).toBe(false);
    }
    const change = await secrets(d.store);
    expect(proofTotal(await d.store.proofs(MINT_A))).toBe(59);
    for (const s of change) expect(mine.has(s)).toBe(true);
  });

  it('receive and melt change are deterministic', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    expect(await d.wallet.receive({ mint: MINT_A, proofs: mint.issue(40) })).toBe(40);
    const q = await d.wallet.meltQuote(MINT_A, INVOICE_20);
    const r = await d.wallet.melt(q);
    expect(r.paid).toBe(true);
    expect(r.change).toBeGreaterThan(0);
    const mine = derivedSecrets(seed, mint.keysetId);
    const held = await secrets(d.store);
    expect(held.length).toBeGreaterThan(0);
    for (const s of held) expect(mine.has(s)).toBe(true);
    expect(proofTotal(await d.store.proofs(MINT_A))).toBe(20);
  });

  it('unseeded connections make random outputs and expose no `seeded`', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint] });
    await fund(d, mint, 7);
    expect(d.wallet.seeded).toBeUndefined();
    const mine = derivedSecrets(seed, mint.keysetId);
    for (const s of await secrets(d.store)) expect(mine.has(s)).toBe(false);
    expect(d.conns.seeding).toBeUndefined();
  });

  it('a mint without NUT-09 cannot restore: outputs there stay random and no counter is used', async () => {
    const mint = mintA({ nut09: false });
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    await fund(d, mint, 7);
    const mine = derivedSecrets(seed, mint.keysetId);
    for (const s of await secrets(d.store)) expect(mine.has(s)).toBe(false);
    expect(d.counters.saved).toEqual([]);
  });
});

describe('ADR 0016 §3: counters never repeat', () => {
  it('across a restart and a crash: the next process starts at the lease; the mint never saw a repeat', async () => {
    const mint = mintA();
    const entropy = recoveryPhrases.generate();
    const seed = await recoveryPhrases.toSeed(entropy);
    const counters = new MemoryCounterStore(null);
    const store = new MemoryProofStore();
    const a = device({ mints: [mint], seed, counters, store });
    await fund(a, mint, 7);
    await a.wallet.send(sats(2), { p2pk: TO, mint: MINT_A });
    const lease = counters.state?.next[mint.keysetId] ?? 0;
    // Crash: `a` is dropped without close. A new process over the same files.
    const b = device({ mints: [mint], seed, counters, store });
    await fund(b, mint, 3);
    const later = (await secrets(store)).map((s) => counterOf(seed, mint.keysetId, s));
    expect(Math.max(...later)).toBeGreaterThanOrEqual(lease);
    expect([...a.net.codes, ...b.net.codes]).not.toContain(10002);
    // A clean restart after close continues past everything too.
    await b.wallet.close();
    const c = device({
      mints: [mint],
      seed: await recoveryPhrases.toSeed(entropy),
      counters,
      store,
    });
    await fund(c, mint, 1);
    expect(c.net.codes).not.toContain(10002);
    expect(new Set(await secrets(store)).size).toBe((await secrets(store)).length);
  });

  it('a lost counters file: the probe skips what this seed already signed', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const a = device({ mints: [mint], seed });
    await fund(a, mint, 7); // counters 0..2
    // The file is gone; the same phrase on a new process (the proofs are still in NIP-60).
    const b = device({ mints: [mint], seed, counters: new MemoryCounterStore(null) });
    await fund(b, mint, 3);
    expect(b.net.codes).not.toContain(10002);
    const bs = (await secrets(b.store)).map((s) => counterOf(seed, mint.keysetId, s));
    expect(Math.min(...bs)).toBeGreaterThanOrEqual(3);
    expect(b.net.restores()).toBeGreaterThanOrEqual(1);
  });

  it('two mints announcing one keyset id share one counter: no secret repeats across them', async () => {
    // The same key seed gives both mints the same keyset id.
    const m1 = new TestMint({ url: MINT_A, seed: new Uint8Array(32).fill(0x44) });
    const m2 = new TestMint({ url: MINT_B, seed: new Uint8Array(32).fill(0x44) });
    expect(m1.keysetId).toBe(m2.keysetId);
    const seed = await newSeed();
    const d = device({ mints: [m1, m2], seed });
    await fund(d, m1, 7);
    await fund(d, m2, 7);
    await fund(d, m1, 3);
    await fund(d, m2, 3);
    const all = [...(await secrets(d.store, MINT_A)), ...(await secrets(d.store, MINT_B))];
    expect(new Set(all).size).toBe(all.length);
    const counters = all.map((s) => counterOf(seed, m1.keysetId, s));
    expect(counters.every((c) => c >= 0)).toBe(true);
    expect(new Set(counters).size).toBe(counters.length);
    expect(Object.keys(d.counters.state?.next ?? {})).toEqual([m1.keysetId]);
  });

  it('a keyset rotation starts the new keyset at its own counter 0 (after a probe)', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    await fund(d, mint, 3);
    const old = mint.keysetId;
    const fresh = mint.rotateKeyset();
    // A new wallet process sees the rotation (the cashu-ts wallet loaded once per process).
    const e = device({ mints: [mint], seed, counters: d.counters, store: d.store });
    await fund(e, mint, 3);
    const newOnes = (await e.store.proofs(MINT_A)).filter((p) => p.id === fresh);
    expect(newOnes.map((p) => counterOf(seed, fresh, p.secret)).sort()).toEqual([0, 1]);
    expect(Object.keys(e.counters.state?.next ?? {}).sort()).toEqual([fresh, old].sort());
  });
});

describe('ADR 0016 §4: the collision guard', () => {
  /** Device `a` signs counters 0.. first; `b` (same phrase) believes its counters start at 0. */
  async function collidingPair(o: { journaled?: boolean } = {}) {
    const mint = mintA();
    const seed = await newSeed();
    const a = device({ mints: [mint], seed });
    await fund(a, mint, 7); // a signs counters 0, 1, 2 (4, 2, 1)
    const bStore = o.journaled === false ? unjournaled() : new MemoryProofStore();
    const b = device({
      mints: [mint],
      seed,
      counters: knownCounters(mint.keysetId, 0),
      store: bStore,
    });
    return { mint, seed, a, b };
  }

  it('a fresh top-up answered "already signed" moves past the collision and mints once more', async () => {
    const { mint, seed, a, b } = await collidingPair();
    await fund(b, mint, 5);
    expect(b.net.codes.filter((c) => c === 10002)).toHaveLength(1);
    expect(await b.wallet.balance(MINT_A)).toBe(5);
    const bs = (await secrets(b.store)).map((s) => counterOf(seed, mint.keysetId, s));
    expect(Math.min(...bs)).toBeGreaterThanOrEqual(3); // past everything `a` signed
    // `a`'s proofs are untouched and were not adopted by `b`.
    const as = new Set(await secrets(a.store));
    for (const s of await secrets(b.store)) expect(as.has(s)).toBe(false);
    for (const s of as) expect(mint.isSpent(s)).toBe(false);
    expect(await b.store.pending!(MINT_A)).toEqual([]);
  });

  it('a fresh send whose change collides: inputs unspent, so it is NOT the send executing — retried once', async () => {
    const { mint, a, b } = await collidingPair();
    const issued = mint.issue(64);
    await hold(b.store, MINT_A, issued);
    const set = await b.wallet.send(sats(5), { p2pk: TO, mint: MINT_A });
    expect(proofTotal(set.proofs)).toBe(5);
    expect(b.net.codes.filter((c) => c === 10002)).toHaveLength(1);
    expect(await b.wallet.balance(MINT_A)).toBe(59);
    expect(mint.isSpent(issued[0]!.secret)).toBe(true); // spent exactly once, by the retry
    expect(await b.store.pending!(MINT_A)).toEqual([]);
    for (const s of await secrets(a.store)) expect(mint.isSpent(s)).toBe(false);
  });

  it('a fresh receive and a fresh melt collide and are retried once', async () => {
    const { mint, seed, b } = await collidingPair();
    expect(await b.wallet.receive({ mint: MINT_A, proofs: mint.issue(40) })).toBe(40);
    expect(b.net.codes.filter((c) => c === 10002)).toHaveLength(1);
    // Another process on this phrase that believes its counters start at 0 melts: its NUT-08
    // blanks were signed already (the mint refuses before it spends or pays).
    const b2 = device({
      mints: [mint],
      seed,
      counters: knownCounters(mint.keysetId, 0),
      store: b.store,
    });
    const q = await b2.wallet.meltQuote(MINT_A, INVOICE_20);
    const r = await b2.wallet.melt(q);
    expect(r.paid).toBe(true);
    expect(b2.net.codes.filter((c) => c === 10002)).toHaveLength(1);
    expect(b2.net.calls.filter((c) => c === 'POST /v1/melt/bolt11')).toHaveLength(2);
    expect(await b2.wallet.balance(MINT_A)).toBe(20); // 40 − 20, the unused reserve back
    expect(await b2.store.pending!(MINT_A)).toEqual([]);
  });

  it('the mint’s code is not trusted: cdk-mintd’s 20006 on a top-up and 11008 on a swap are still collisions', async () => {
    const { mint, seed, b } = await collidingPair();
    // cdk-mintd 0.18.1 (real-mint lane): a mint or melt on signed outputs → 20006 "Invoice already
    // paid or pending"; a swap → 11008 "Duplicate outputs".
    const asCdk = (path: string, e: unknown): unknown =>
      (e as { code?: unknown }).code !== 10002
        ? e
        : path.endsWith('/v1/swap')
          ? new MintOperationError(11008, 'Duplicate outputs')
          : new MintOperationError(20006, 'Invoice already paid or pending');
    b.net.mapError = asCdk;
    await fund(b, mint, 5);
    expect(b.net.codes.filter((c) => c === 10002)).toHaveLength(1);
    expect(await b.wallet.balance(MINT_A)).toBe(5);
    await hold(b.store, MINT_A, mint.issue(32));
    const b2 = device({
      mints: [mint],
      seed,
      counters: knownCounters(mint.keysetId, 0),
      store: b.store,
    });
    b2.net.mapError = asCdk;
    const set = await b2.wallet.send(sats(3), { p2pk: TO, mint: MINT_A });
    expect(proofTotal(set.proofs)).toBe(3);
    expect(b2.net.codes.filter((c) => c === 10002)).toHaveLength(1);
    expect(await b2.store.pending!(MINT_A)).toEqual([]);
  });

  it('a plain refusal of a seeded operation stays a refusal: no signatures on its outputs, the entry goes, no retry', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    const issued = mint.issue(64);
    await hold(d.store, MINT_A, issued);
    mint.markSpent(issued); // spent behind our back
    await expect(d.wallet.send(sats(5), { p2pk: TO, mint: MINT_A })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(d.net.codes).toEqual([11001]);
    expect(d.net.calls.filter((c) => c === 'POST /v1/swap')).toHaveLength(1);
    expect(await d.store.pending!(MINT_A)).toEqual([]);
    expect(await d.wallet.balance(MINT_A)).toBe(0); // reconciled: the spent proof left
  });

  it('without a journal (a store that keeps none): a 10002 on seeded outputs is still a collision, retried once', async () => {
    const { mint, b } = await collidingPair({ journaled: false });
    await fund(b, mint, 5);
    expect(b.net.codes.filter((c) => c === 10002)).toHaveLength(1);
    expect(await b.wallet.balance(MINT_A)).toBe(5);
    await hold(b.store, MINT_A, mint.issue(32));
    const b2 = device({
      mints: [mint],
      seed: b.seed!,
      counters: knownCounters(mint.keysetId, 0),
      store: b.store,
    });
    const set = await b2.wallet.send(sats(3), { p2pk: TO, mint: MINT_A });
    expect(proofTotal(set.proofs)).toBe(3);
    expect(b2.net.codes.filter((c) => c === 10002)).toHaveLength(1);
    expect(await b2.wallet.balance(MINT_A)).toBe(34);
  });

  it('a second collision in a row is reported (another wallet is using this phrase now) and loses nothing', async () => {
    const { mint, seed, b } = await collidingPair();
    const issued = mint.issue(64);
    await hold(b.store, MINT_A, issued);
    // Just before b's retry reaches the mint, another wallet on the phrase signs the very
    // counter the retry starts at.
    let swaps = 0;
    b.net.before = async (path, body) => {
      if (!path.endsWith('/v1/swap')) return;
      swaps++;
      if (swaps !== 2) return;
      const outs = (body?.['outputs'] ?? []) as { B_: string }[];
      const at = outs.map((o) => blindedCounter(seed, mint.keysetId, o.B_)).filter((c) => c >= 0);
      const first = Math.min(...at);
      const other = device({ mints: [mint], seed, counters: knownCounters(mint.keysetId, first) });
      await fund(other, mint, 1);
    };
    await expect(b.wallet.send(sats(5), { p2pk: TO, mint: MINT_A })).rejects.toMatchObject({
      code: 'mint-error',
      message: expect.stringContaining('counter collision'),
    });
    expect(b.net.codes.filter((c) => c === 10002)).toHaveLength(2);
    expect(await b.wallet.balance(MINT_A)).toBe(64);
    expect(mint.isSpent(issued[0]!.secret)).toBe(false);
    expect(await b.store.pending!(MINT_A)).toEqual([]);
  });

  it('a journaled send whose change another wallet signed meanwhile is dropped at settle, its inputs kept', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const b = device({ mints: [mint], seed, counters: knownCounters(mint.keysetId, 0) });
    const issued = mint.issue(64);
    await hold(b.store, MINT_A, issued);
    // b's send never reaches the mint: the entry stays, its inputs held.
    b.net.before = (path) =>
      path.endsWith('/v1/swap')
        ? Promise.reject(new Error('connect ECONNREFUSED'))
        : Promise.resolve();
    await expect(b.wallet.send(sats(5), { p2pk: TO, mint: MINT_A })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await b.store.pending!(MINT_A)).toHaveLength(1);
    expect(await b.wallet.balance(MINT_A)).toBe(0);
    b.net.before = null;
    // Another wallet on the phrase signs counter 0.. (b's journaled change outputs).
    const a = device({ mints: [mint], seed });
    await fund(a, mint, 7);
    // The settle finds signatures on b's outputs — but b's inputs are unspent: not executed.
    expect(await b.wallet.recoverPending()).toEqual({ recovered: 0, left: 0 });
    expect(await b.store.pending!(MINT_A)).toEqual([]);
    expect(await b.wallet.balance(MINT_A)).toBe(64);
    expect(mint.isSpent(issued[0]!.secret)).toBe(false);
    const as = new Set(await secrets(a.store));
    for (const s of await secrets(b.store)) expect(as.has(s)).toBe(false);
    // And b's counters moved past what `a` signed, so its next send does not collide.
    const set = await b.wallet.send(sats(5), { p2pk: TO, mint: MINT_A });
    expect(proofTotal(set.proofs)).toBe(5);
    expect(b.net.codes).not.toContain(10002);
  });

  it('a journaled send that DID execute (answer lost) is still recovered: inputs SPENT, change restored', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    await fund(d, mint, 64);
    mint.dropNextResponse();
    const set = await d.wallet.send(sats(5), { p2pk: TO, mint: MINT_A });
    expect(proofTotal(set.proofs)).toBe(5);
    expect(await d.wallet.balance(MINT_A)).toBe(59);
    expect(await d.store.pending!(MINT_A)).toEqual([]);
  });
});

describe('ADR 0016 §2: close waits before it wipes the seed', () => {
  it('a running send finishes, queued work is refused, then the seed is wiped and the counters closed', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    await fund(d, mint, 64);
    const release = d.net.hold('/v1/swap');
    const sending = d.wallet.send(sats(5), { p2pk: TO, mint: MINT_A });
    // Let the send reach the held request (its outputs are derived, the request in flight).
    for (let i = 0; i < 50 && !d.net.calls.some((c) => c.endsWith('/v1/swap')); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(d.net.calls.some((c) => c.endsWith('/v1/swap'))).toBe(true);
    const queued = d.wallet.send(sats(1), { p2pk: TO, mint: MINT_A });
    const closing = d.wallet.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(seed.wiped).toBe(false); // the send still runs
    release();
    const set = await sending;
    expect(proofTotal(set.proofs)).toBe(5);
    await expect(queued).rejects.toMatchObject({ code: 'invalid-argument' });
    await closing;
    expect(seed.wiped).toBe(true);
    expect(d.conns.seeding?.counters.closed).toBe(true);
    await expect(d.wallet.send(sats(1), { p2pk: TO, mint: MINT_A })).rejects.toMatchObject({
      message: expect.stringContaining('closed'),
    });
    // The watermark reached the counters file before the wipe.
    expect(d.counters.state?.published[mint.keysetId]).toBeGreaterThan(0);
  });

  it('an operation that reaches for counters after close began is refused, not derived from a wiped seed', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    await fund(d, mint, 64);
    const q = await d.wallet.meltQuote(MINT_A, INVOICE_20);
    // The melt re-reads its quote first (held), and only then reserves its blanks' counters.
    const release = d.net.hold(`/quote/bolt11/${q.quoteId}`);
    const melting = d.wallet.melt(q);
    for (let i = 0; i < 50 && !d.net.calls.some((c) => c.endsWith(q.quoteId)); i++)
      await new Promise((r) => setTimeout(r, 5));
    const closing = d.wallet.close();
    release();
    await expect(melting).rejects.toMatchObject({ code: 'mint-error' });
    await closing;
    expect(seed.wiped).toBe(true);
    expect(d.net.calls).not.toContain('POST /v1/melt/bolt11');
    expect(await d.wallet.balance(MINT_A)).toBe(64);
  });

  it('close is idempotent and an unseeded wallet closes too', async () => {
    const mint = mintA();
    const d = device({ mints: [mint] });
    await d.wallet.close();
    await d.wallet.close();
    await expect(d.wallet.send(sats(1), { p2pk: TO, mint: MINT_A })).rejects.toBeInstanceOf(Error);
  });
});

describe('ADR 0016 §3: the published watermark moves only when nothing is in flight', () => {
  it('a store with an outbox not yet published holds the watermark back', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const inner = new MemoryProofStore();
    let outbox = 1;
    const store: ProofStore = {
      mints: () => inner.mints(),
      proofs: (m) => inner.proofs(m),
      commit: (tx) => inner.commit(tx),
      history: (o) => inner.history(o),
      pending: (m) => inner.pending(m),
      unsynced: () => outbox,
    };
    const d = device({ mints: [mint], seed, store });
    await fund(d, mint, 7);
    await d.conns.seeding!.counters.flush();
    expect(d.counters.state?.published[mint.keysetId] ?? 0).toBe(0);
    outbox = 0;
    await d.wallet.notePublished();
    await d.conns.seeding!.counters.flush();
    expect(d.counters.state?.published[mint.keysetId]).toBe(3);
  });

  it('an unresolved journaled operation holds the watermark back', async () => {
    const mint = mintA();
    const seed = await newSeed();
    const d = device({ mints: [mint], seed });
    await fund(d, mint, 64);
    await d.conns.seeding!.counters.flush();
    const before = d.counters.state?.published[mint.keysetId] ?? 0;
    d.net.before = (path) =>
      path.endsWith('/v1/swap')
        ? Promise.reject(new Error('connect ECONNREFUSED'))
        : Promise.resolve();
    await expect(d.wallet.send(sats(5), { p2pk: TO, mint: MINT_A })).rejects.toBeInstanceOf(Error);
    d.net.before = null;
    expect(await d.store.pending!(MINT_A)).toHaveLength(1);
    await d.wallet.notePublished();
    await d.conns.seeding!.counters.flush();
    expect(d.counters.state?.published[mint.keysetId] ?? 0).toBe(before);
  });
});
