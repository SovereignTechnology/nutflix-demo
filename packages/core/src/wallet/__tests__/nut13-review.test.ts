/**
 * The independent review of lane N1-nut13-core (2026-09-27): one test per finding, each written
 * against the reviewed code first (it failed there) and passing with the fix. In-process `TestMint`.
 *
 *   finding 1 (high)    a restore the batch cap cut short read as complete: this device's own phrase
 *                       now scans to its counters file's `next`, the startup restore scans all of
 *                       `[published, next)` newest first, and a scan the cap stops says where to
 *                       resume (and is never reported `nothing`);
 *   finding 2           another mint announcing the same keyset id moved the cursor ~20 000 ahead:
 *                       only the mint the operation runs at is probed, one batch, verified
 *                       signatures only (the collision guard's skip-ahead too);
 *   finding 3           a rotated phrase continued the old phrase's counters: the counters file is
 *                       bound to its phrase;
 *   finding 4 (low)     an unseeded wallet's lost answer needed NUT-07 to be recovered: only seeded
 *                       journal entries do;
 *   findings 6–8        a stale connection's probe blocked a new keyset; one failing keyset threw
 *                       away the mint's restore; a restore and a settle wrote one operation twice
 *                       into the history;
 *   (found in review)   a startup restore that did not finish still let the watermark move.
 */
import { describe, expect, it, vi } from 'vitest';

import { MemoryCounterStore } from '../../mocks/counter-store.js';
import { TestMint } from '../../mocks/test-mint.js';
import { MemoryProofStore, isPendingOp, proofTotal, type ProofStore } from '../store.js';
import {
  MINT_A,
  MINT_B,
  TO,
  blindedCounter,
  derivedSecrets,
  device,
  fund,
  hold,
  knownCounters,
  newSeed,
  sats,
} from './nut13-rig.js';

// Real in-process mints and NUT-09 scans of hundreds of derived outputs (see nut13-restore.test.ts).
vi.setConfig({ testTimeout: 60_000 });

const mintAt = (url: typeof MINT_A, o: Partial<ConstructorParameters<typeof TestMint>[0]> = {}) =>
  new TestMint({ url, seed: new Uint8Array(32).fill(url === MINT_A ? 0x61 : 0x62), ...o });

const refuse = (): Promise<never> => Promise.reject(new Error('connect ECONNREFUSED'));

/** A store whose relay outbox never drains: the `published` watermark cannot move. */
function neverPublished(inner: MemoryProofStore): ProofStore {
  return {
    mints: () => inner.mints(),
    proofs: (m) => inner.proofs(m),
    commit: (tx) => inner.commit(tx),
    history: (o) => inner.history(o),
    pending: (m) => inner.pending(m),
    unsynced: () => 1,
  };
}

describe('finding 1: a restore cut short by the batch cap is never read as complete', () => {
  it('this device’s own phrase restores through its counters file’s high-water mark, past any gap or cap', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const counters = new MemoryCounterStore(null);
    const x = device({ mints: [mint], seed: phrase, counters });
    await fund(x, mint, 7); // counters 0..2
    // Hundreds of unused counters (restarts burn leases; failed operations burn outputs)…
    await x.conns.seeding!.counters.advanceToAtLeast(mint.keysetId, 450);
    await fund(x, mint, 8); // …then counter 450: past a gap of 300 AND past a cap of 3 batches
    // The relays dropped the 7375 events: the same device and counters file, an empty store.
    const y = device({ mints: [mint], seed: phrase, counters, restoreLimits: { maxBatches: 3 } });
    expect(await y.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 15 },
    ]);
  });

  it('the startup restore scans all of [published, next), newest first, whatever the batch cap', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const k = mint.keysetId;
    const counters = new MemoryCounterStore(null);
    const live = new MemoryProofStore();
    const a = device({ mints: [mint], seed: phrase, counters, store: neverPublished(live) });
    await fund(a, mint, 64); // counter 0
    const durable = new MemoryProofStore();
    await hold(durable, MINT_A, await live.proofs(MINT_A));
    await a.conns.seeding!.counters.advanceToAtLeast(k, 650);
    await a.wallet.send(sats(5), { p2pk: TO, mint: MINT_A }); // change at 650..: never durable
    expect(counters.state?.published[k] ?? 0).toBe(0);
    // Crash; the next start over what was durable, with a cap of 2 batches.
    const b = device({
      mints: [mint],
      seed: phrase,
      counters: new MemoryCounterStore(counters.state),
      store: durable,
      restoreLimits: { maxBatches: 2 },
    });
    const first: number[] = [];
    b.net.before = (path, body) => {
      if (path.endsWith('/v1/restore') && first.length === 0)
        for (const o of (body?.['outputs'] ?? []) as { B_: string }[])
          first.push(blindedCounter(phrase, k, o.B_, 700));
      return Promise.resolve();
    };
    expect(await b.wallet.restoreUnpublished()).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 59 },
    ]);
    expect(await b.wallet.balance(MINT_A)).toBe(59);
    // The newest batch was asked first (the change at 650.. is in it; counter 0 is not).
    expect(first).toContain(650);
    expect(Math.min(...first)).toBeGreaterThan(500);
  });

  it('a scan the cap stops carries where to resume, and resuming there finishes it', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const k = mint.keysetId;
    // An honest history denser than the cap: gaps under 300 all the way.
    for (const [at, amount] of [
      [0, 7],
      [150, 8],
      [250, 16],
      [350, 32],
      [450, 64],
    ] as const)
      await fund(
        device({ mints: [mint], seed: phrase, counters: knownCounters(k, at) }),
        mint,
        amount,
      );
    const c = device({ mints: [mint], seed: await newSeed(), restoreLimits: { maxBatches: 4 } });
    const [r] = await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    expect(r).toEqual({
      mint: MINT_A,
      outcome: 'restored',
      restoredSats: 63,
      resume: { [k]: 400 },
    });
    const before = c.net.restores();
    const [r2] = await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A], undefined, {
      resume: new Map([[MINT_A, r!.resume!]]),
    });
    expect(r2).toEqual({ mint: MINT_A, outcome: 'restored', restoredSats: 64 });
    expect(c.net.restores() - before).toBe(4); // from 400: one hit, three empty
    expect(await c.wallet.balance(MINT_A)).toBe(127);
  });

  it('a capped scan that restored nothing is not `nothing`: refused, with where to resume', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const k = mint.keysetId;
    const early = device({ mints: [mint], seed: phrase, counters: knownCounters(k, 0) });
    await fund(early, mint, 7);
    mint.markSpent(await early.store.proofs(MINT_A)); // the first batch holds only spent proofs
    await fund(device({ mints: [mint], seed: phrase, counters: knownCounters(k, 150) }), mint, 8);
    const c = device({ mints: [mint], seed: await newSeed(), restoreLimits: { maxBatches: 1 } });
    const [r] = await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    expect(r).toEqual({ mint: MINT_A, outcome: 'refused', restoredSats: 0, resume: { [k]: 100 } });
    const [r2] = await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A], undefined, {
      resume: new Map([[MINT_A, r!.resume!]]),
    });
    expect(r2).toMatchObject({ outcome: 'restored', restoredSats: 8 });
    // A resume that is not one is refused before anything is asked.
    await expect(
      c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A], undefined, {
        resume: new Map([[MINT_A, { [k]: -1 }]]),
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('finding 2: only the mint an operation runs at can move its counters, and only a little', () => {
  it('another mint announcing the same keyset id is never asked; the restore at the real mint finds the balance', async () => {
    const a = mintAt(MINT_A);
    // The same key seed: B announces A's keyset id (a real hostile mint would copy A's public keys).
    const b = new TestMint({ url: MINT_B, seed: new Uint8Array(32).fill(0x61) });
    expect(b.keysetId).toBe(a.keysetId);
    b.hostileRestore({ perRequest: 1 });
    const phrase = await newSeed();
    const v = device({ mints: [a, b], seed: phrase });
    await v.wallet.mintQuote(MINT_B, sats(1)); // B's wallet is loaded in this session
    await fund(v, a, 7);
    expect(b.calls).not.toContain('POST /v1/restore');
    expect((await v.conns.seeding!.counters.snapshot())[a.keysetId]).toBeLessThan(100);
    const c = device({ mints: [a], seed: await newSeed() });
    expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 7 },
    ]);
  });

  it('a probe moves the cursor by at most one batch, however many counters the mint claims', async () => {
    const a = mintAt(MINT_A);
    a.hostileRestore({ perRequest: 1 }); // "signs" one output of every batch it is asked about
    const phrase = await newSeed();
    const v = device({ mints: [a], seed: phrase });
    await fund(v, a, 7);
    expect(a.calls.filter((c) => c === 'POST /v1/restore')).toHaveLength(1);
    expect((await v.conns.seeding!.counters.snapshot())[a.keysetId]).toBeLessThan(100);
  });

  it('a probe counts a signature only when its DLEQ verifies (a NUT-12 mint)', async () => {
    const a = mintAt(MINT_A);
    const phrase = await newSeed();
    const v = device({ mints: [a], seed: phrase });
    let asked: { B_: string; id: string }[] = [];
    v.net.before = (path, body) => {
      if (path.endsWith('/v1/restore')) asked = (body?.['outputs'] ?? []) as typeof asked;
      return Promise.resolve();
    };
    v.net.rewrite = (path, res) => {
      const o = asked[50];
      if (!path.endsWith('/v1/restore') || o === undefined) return;
      // A "signature" on counter 50 that no key made: C_ is just a point, the DLEQ garbage.
      (res['outputs'] as unknown[]).push({ ...o, amount: 1 });
      (res['signatures'] as unknown[]).push({
        id: o.id,
        amount: 1,
        C_: o.B_,
        dleq: { e: '01'.padStart(64, '0'), s: '01'.padStart(64, '0') },
      });
    };
    await fund(v, a, 7);
    expect((await v.conns.seeding!.counters.snapshot())[a.keysetId]).toBe(3); // 0..2, nothing skipped
  });

  it('the collision guard skips ahead past verified signatures only', async () => {
    const mint = mintAt(MINT_A);
    const seed = await newSeed();
    await fund(device({ mints: [mint], seed }), mint, 7); // another wallet signs 0..2
    const b = device({ mints: [mint], seed, counters: knownCounters(mint.keysetId, 0) });
    let asked: { B_: string; id: string }[] = [];
    b.net.before = (path, body) => {
      if (path.endsWith('/v1/restore')) asked = (body?.['outputs'] ?? []) as typeof asked;
      return Promise.resolve();
    };
    b.net.rewrite = (path, res) => {
      const o = asked[50];
      if (!path.endsWith('/v1/restore') || asked.length < 100 || o === undefined) return;
      (res['outputs'] as unknown[]).push({ ...o, amount: 1 });
      (res['signatures'] as unknown[]).push({
        id: o.id,
        amount: 1,
        C_: o.B_,
        dleq: { e: '01'.padStart(64, '0'), s: '01'.padStart(64, '0') },
      });
    };
    await fund(b, mint, 5);
    expect(b.net.codes.filter((c) => c === 10002)).toHaveLength(1); // one collision, retried
    expect((await b.conns.seeding!.counters.snapshot())[mint.keysetId]).toBeLessThan(100);
  });
});

describe('found fixing finding 2: without NUT-12 a mint cannot move the counters far', () => {
  it('a restore of this device’s own phrase advances its counters only past DLEQ-verified signatures', async () => {
    // A mint without NUT-12 "signs" one output of every batch: nothing it answers is proven, so a
    // restore there must not push this device's counters (it could announce another mint's id).
    const mint = mintAt(MINT_A, { nut12: false });
    mint.hostileRestore({ perRequest: 1 });
    const phrase = await newSeed();
    const x = device({
      mints: [mint],
      seed: phrase,
      counters: knownCounters(mint.keysetId, 0),
      restoreLimits: { maxBatches: 10 },
    });
    await x.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    // Unproven "signatures" at 0, 100, …, 900 must not move the cursor to 901. (The swap that counts
    // them then meets the mint's own claim on counter 0 — a collision — and the guard, without
    // NUT-12, skips at most one batch: ~103.)
    expect((await x.conns.seeding!.counters.snapshot())[mint.keysetId]).toBeLessThan(200);
  });

  it('the collision guard at a mint without NUT-12 skips at most one batch', async () => {
    const mint = mintAt(MINT_A, { nut12: false });
    const seed = await newSeed();
    await fund(device({ mints: [mint], seed }), mint, 7); // another wallet signs 0..2
    mint.hostileRestore({ perRequest: 1 }); // and every restore batch "shows" one more
    const b = device({ mints: [mint], seed, counters: knownCounters(mint.keysetId, 0) });
    await fund(b, mint, 5);
    expect(b.net.codes.filter((c) => c === 10002)).toHaveLength(1);
    expect((await b.conns.seeding!.counters.snapshot())[mint.keysetId]).toBeLessThan(200);
  });
});

describe('finding 3: the counters file belongs to one phrase', () => {
  it('a rotated phrase over the same counters store starts at its own counter 0, and its words bring the reissue back', async () => {
    const mint = mintAt(MINT_A);
    const counters = new MemoryCounterStore(null);
    const store = new MemoryProofStore();
    const old = device({ mints: [mint], seed: await newSeed(), counters, store });
    await fund(old, mint, 7);
    await old.conns.seeding!.counters.advanceToAtLeast(mint.keysetId, 450);
    await fund(old, mint, 64);
    await old.wallet.close();
    // ADR 0016 D5: the leaked phrase is rotated — everything reissued under a new one.
    const fresh = await newSeed();
    const rotated = device({ mints: [mint], seed: fresh, counters, store });
    const plan = await rotated.wallet.seeded!.reissuePlan(MINT_A);
    expect(await rotated.wallet.seeded!.reissue(plan)).toMatchObject({ reissued: 71 });
    const mine = derivedSecrets(fresh, mint.keysetId, 16);
    for (const p of await store.proofs(MINT_A)) expect(mine.has(p.secret)).toBe(true);
    const c = device({ mints: [mint], seed: await newSeed() });
    expect(await c.wallet.seeded!.restoreFromSeed(fresh, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 71 },
    ]);
  });

  it('after a restart too: the file on disk carries the old phrase, the new one does not continue it', async () => {
    const mint = mintAt(MINT_A);
    const counters = new MemoryCounterStore(null);
    const old = device({ mints: [mint], seed: await newSeed(), counters });
    await old.conns.seeding!.counters.advanceToAtLeast(mint.keysetId, 450);
    await fund(old, mint, 7);
    // A new process, a new phrase, the same file (the shell kept one file per identity).
    const fresh = await newSeed();
    const next = device({
      mints: [mint],
      seed: fresh,
      counters: new MemoryCounterStore(counters.state),
    });
    await fund(next, mint, 3);
    const mine = derivedSecrets(fresh, mint.keysetId, 8);
    for (const p of await next.store.proofs(MINT_A)) expect(mine.has(p.secret)).toBe(true);
  });

  it('a counters store a live wallet of another phrase is using is refused, not shared', async () => {
    const mint = mintAt(MINT_A);
    const counters = new MemoryCounterStore(null);
    const x = device({ mints: [mint], seed: await newSeed(), counters });
    const second = await newSeed();
    expect(() => device({ mints: [mint], seed: second, counters })).toThrow(
      /another recovery phrase/,
    );
    await x.wallet.close();
    // Closed: the store is free for the next phrase.
    expect(() => device({ mints: [mint], seed: second, counters })).not.toThrow();
  });
});

describe('finding 4: NUT-07 decides only seeded journal entries', () => {
  it('an unseeded wallet’s lost answer is recovered on its signatures alone, as in ADR 0014, NUT-07 down or not', async () => {
    const mint = mintAt(MINT_A);
    const d = device({ mints: [mint] });
    d.net.before = (path) => (path.endsWith('/v1/checkstate') ? refuse() : Promise.resolve());
    mint.dropNextResponse();
    expect(await d.wallet.receive({ mint: MINT_A, proofs: mint.issue(40) })).toBe(40);
    expect(await d.store.pending!(MINT_A)).toEqual([]);
    expect(await d.wallet.balance(MINT_A)).toBe(40);
  });

  it('a seeded one still waits for NUT-07 (its signatures may be another wallet’s), and settles once it answers', async () => {
    const mint = mintAt(MINT_A);
    // The keyset known already, so the lost answer is the swap's (not the first probe's).
    const d = device({
      mints: [mint],
      seed: await newSeed(),
      counters: knownCounters(mint.keysetId, 0),
    });
    let down = true;
    d.net.before = (path) =>
      path.endsWith('/v1/checkstate') && down ? refuse() : Promise.resolve();
    mint.dropNextResponse();
    await expect(d.wallet.receive({ mint: MINT_A, proofs: mint.issue(40) })).rejects.toMatchObject({
      code: 'mint-error',
    });
    const [op] = await d.store.pending!(MINT_A);
    expect(op?.seeded).toBe(true);
    down = false;
    expect(await d.wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await d.wallet.balance(MINT_A)).toBe(40);
  });

  it('a seeded entry read by an unseeded wallet still waits for NUT-07 (the flag, not the wallet, says so)', async () => {
    const mint = mintAt(MINT_A);
    const store = new MemoryProofStore();
    const d = device({
      mints: [mint],
      seed: await newSeed(),
      counters: knownCounters(mint.keysetId, 0),
      store,
    });
    d.net.before = (path) => (path.endsWith('/v1/checkstate') ? refuse() : Promise.resolve());
    mint.dropNextResponse();
    await expect(d.wallet.receive({ mint: MINT_A, proofs: mint.issue(40) })).rejects.toMatchObject({
      code: 'mint-error',
    });
    // The same store opened without the phrase (it was removed from this device), NUT-07 still down.
    const plain = device({ mints: [mint], store });
    plain.net.before = (path) => (path.endsWith('/v1/checkstate') ? refuse() : Promise.resolve());
    expect(await plain.wallet.recoverPending()).toEqual({ recovered: 0, left: 1 });
    plain.net.before = null;
    expect(await plain.wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
    expect(await plain.wallet.balance(MINT_A)).toBe(40);
  });

  it('a seeded wallet fails closed if a store ever drops the flag: it still waits for NUT-07', async () => {
    const mint = mintAt(MINT_A);
    const inner = new MemoryProofStore();
    // A store that loses `seeded` when it reads entries back (a field allow-list, say).
    const lossy: ProofStore = {
      mints: () => inner.mints(),
      proofs: (m) => inner.proofs(m),
      commit: (tx) => inner.commit(tx),
      history: (o) => inner.history(o),
      pending: async (m) =>
        (await inner.pending(m)).map((op) => {
          const { seeded: _dropped, ...rest } = op;
          return rest;
        }),
    };
    const d = device({
      mints: [mint],
      seed: await newSeed(),
      counters: knownCounters(mint.keysetId, 0),
      store: lossy,
    });
    let down = true;
    d.net.before = (path) =>
      path.endsWith('/v1/checkstate') && down ? refuse() : Promise.resolve();
    mint.dropNextResponse();
    await expect(d.wallet.receive({ mint: MINT_A, proofs: mint.issue(40) })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await d.wallet.recoverPending()).toEqual({ recovered: 0, left: 1 });
    down = false;
    expect(await d.wallet.recoverPending()).toEqual({ recovered: 1, left: 0 });
  });

  it('a journal entry’s `seeded` is `true` or absent; anything else is refused when read back', async () => {
    const mint = mintAt(MINT_A);
    const d = device({ mints: [mint] });
    d.net.before = (path) => (path.endsWith('/v1/swap') ? refuse() : Promise.resolve());
    await hold(d.store, MINT_A, mint.issue(16));
    await expect(d.wallet.send(sats(3), { p2pk: TO, mint: MINT_A })).rejects.toBeInstanceOf(Error);
    const [op] = await d.store.pending!(MINT_A);
    expect(op).toBeDefined();
    expect('seeded' in op!).toBe(false); // an unseeded entry is written exactly as before
    expect(isPendingOp(op)).toBe(true);
    expect(isPendingOp({ ...op, seeded: true })).toBe(true);
    for (const bad of [false, 'yes', 1]) expect(isPendingOp({ ...op, seeded: bad })).toBe(false);
  });
});

describe('findings 6–8: stale probes, one failing keyset, history written twice', () => {
  it('a reconnect over one counters store: the old connection going down cannot block a new keyset (finding 6)', async () => {
    const mint = mintAt(MINT_A);
    const seed = await newSeed();
    const counters = new MemoryCounterStore(null);
    const store = new MemoryProofStore();
    const a = device({ mints: [mint], seed, counters, store });
    await a.wallet.mintQuote(MINT_A, sats(1)); // a's wallet is loaded; its keyset never probed
    a.net.down.add(MINT_A); // the old connection is gone
    const b = device({ mints: [mint], seed, counters, store }); // a reconnect: the same source
    expect(b.conns.seeding!.counters).toBe(a.conns.seeding!.counters);
    await fund(b, mint, 3);
    expect(await b.wallet.balance(MINT_A)).toBe(3);
  });

  it('a keyset whose keys cannot be fetched keeps what the others restored, and says where to resume (finding 7)', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    await fund(device({ mints: [mint], seed: phrase }), mint, 3);
    const old = mint.keysetId;
    mint.rotateKeyset();
    await fund(device({ mints: [mint], seed: phrase }), mint, 4);
    const c = device({ mints: [mint], seed: await newSeed() });
    c.net.before = (path) => (path.endsWith(`/v1/keys/${old}`) ? refuse() : Promise.resolve());
    expect(await c.wallet.seeded!.restoreFromSeed(phrase, [MINT_A])).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 4, resume: { [old]: 0 } },
    ]);
  });

  it('a restore and a later settle of the same operation write its amount into the history once (finding 8)', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const d = device({ mints: [mint], seed: phrase });
    await fund(d, mint, 64);
    // NUT-07 is down for the send's own check and the restore's settle, up for the restore itself.
    let failChecks = 2;
    d.net.before = (path) =>
      path.endsWith('/v1/checkstate') && failChecks-- > 0 ? refuse() : Promise.resolve();
    mint.dropNextResponse();
    await expect(d.wallet.send(sats(5), { p2pk: TO, mint: MINT_A })).rejects.toMatchObject({
      code: 'mint-error',
    });
    expect(await d.store.pending!(MINT_A)).toHaveLength(1);
    const [r] = await d.wallet.seeded!.restoreFromSeed(phrase, [MINT_A]);
    expect(r?.outcome).toBe('restored');
    await d.wallet.recoverPending();
    expect(await d.store.pending!(MINT_A)).toEqual([]);
    expect(await d.wallet.balance(MINT_A)).toBe(59);
    const hist = await d.wallet.history();
    const net = hist.reduce((t, h) => (h.direction === 'in' ? t + h.amount : t - h.amount), 0);
    expect(net).toBe(59);
    expect(proofTotal(await d.store.proofs(MINT_A))).toBe(59);
  });
});

describe('found in review: an unfinished startup restore holds the watermark', () => {
  it('the mint was unreachable at startup: operations do not move `published` until a restore finishes', async () => {
    const mint = mintAt(MINT_A);
    const phrase = await newSeed();
    const k = mint.keysetId;
    const counters = new MemoryCounterStore(null);
    const live = new MemoryProofStore();
    const a = device({ mints: [mint], seed: phrase, counters, store: neverPublished(live) });
    await fund(a, mint, 64);
    const durable = new MemoryProofStore();
    await hold(durable, MINT_A, await live.proofs(MINT_A));
    await a.wallet.send(sats(5), { p2pk: TO, mint: MINT_A }); // change never durable
    // Crash; the next start cannot reach the mint's restore endpoint.
    const onDisk = new MemoryCounterStore(counters.state);
    const b = device({ mints: [mint], seed: phrase, counters: onDisk, store: durable });
    b.net.before = (path) => (path.endsWith('/v1/restore') ? refuse() : Promise.resolve());
    expect(await b.wallet.restoreUnpublished()).toEqual([
      { mint: MINT_A, outcome: 'unreachable', restoredSats: 0, resume: expect.any(Object) },
    ]);
    b.net.before = null;
    // An operation finishes with nothing in flight: the watermark still does not move…
    await hold(durable, MINT_A, mint.issue(8));
    await b.wallet.notePublished();
    await b.conns.seeding!.counters.flush();
    expect(onDisk.state?.published[k] ?? 0).toBe(0);
    // …until a startup restore finishes (it brings the change back, then the watermark moves).
    expect(await b.wallet.restoreUnpublished()).toEqual([
      { mint: MINT_A, outcome: 'restored', restoredSats: 59 },
    ]);
    await b.conns.seeding!.counters.flush();
    expect(onDisk.state?.published[k]).toBeGreaterThan(0);
  });

  it('per keyset: a mint that stays down holds back only its own keysets’ watermark', async () => {
    const A = mintAt(MINT_A);
    const B = mintAt(MINT_B);
    const phrase = await newSeed();
    const counters = new MemoryCounterStore(null);
    const live = new MemoryProofStore();
    const a = device({ mints: [A, B], seed: phrase, counters, store: neverPublished(live) });
    await fund(a, A, 7);
    await fund(a, B, 7);
    // Next start (everything was durable after all): B cannot be reached at all.
    const onDisk = new MemoryCounterStore(counters.state);
    const b = device({ mints: [A, B], seed: phrase, counters: onDisk, store: live });
    b.net.down.add(MINT_B);
    const reports = await b.wallet.restoreUnpublished();
    expect(reports).toEqual([{ mint: MINT_B, outcome: 'unreachable', restoredSats: 0 }]);
    await b.conns.seeding!.counters.flush();
    expect(onDisk.state?.published[A.keysetId]).toBeGreaterThan(0); // A's moved
    expect(onDisk.state?.published[B.keysetId] ?? 0).toBe(0); // B's is held
    b.net.down.delete(MINT_B);
    await b.wallet.restoreUnpublished();
    await b.conns.seeding!.counters.flush();
    expect(onDisk.state?.published[B.keysetId]).toBeGreaterThan(0);
  });
});
