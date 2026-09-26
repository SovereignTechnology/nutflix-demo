import { EventEmitter } from 'node:events';

import type {
  AckMessage,
  CoreKeyHex,
  HelloMessage,
  MuxLike,
  PayMessage,
  PayProtocol,
  PayProtocolEvents,
  PayProtocolState,
  PriceMessage,
  PricePolicy,
} from '@sovit/core';
import { mocks } from '@sovit/core';
import type Hypercore from 'hypercore';
import { silentLogger, toHex } from '@sovit/seeder';
import { describe, expect, it } from 'vitest';

import type { PaidEvent } from '../pay/viewer-payer.js';
import { ViewerPayer } from '../pay/viewer-payer.js';
import { CreditPool } from '../playback/credit.js';

type Listeners = { [K in keyof PayProtocolEvents]: Set<PayProtocolEvents[K]> };

/** Structural `PayProtocol` (the contract; Stage 2 implements it) with remote-side hooks. */
class FakeProto implements PayProtocol {
  state: PayProtocolState = 'idle';
  peer: HelloMessage | null = null;
  readonly sent: PayMessage[] = [];
  private readonly l: Listeners = {
    open: new Set(),
    pay: new Set(),
    ack: new Set(),
    price: new Set(),
    close: new Set(),
  };
  attach(_m: MuxLike): void {
    // nothing on a wire
  }
  sendHello(): void {
    // the remote side is scripted below
  }
  sendPay(m: PayMessage): void {
    this.sent.push(m);
  }
  sendAck(_a: Omit<AckMessage, 'type'>): void {
    // viewer never acks
  }
  sendPrice(_p: Omit<PriceMessage, 'type'>): void {
    // viewer never prices
  }
  cut(): void {
    // not exercised
  }
  on<K extends keyof PayProtocolEvents>(e: K, cb: PayProtocolEvents[K]): () => void {
    const s = this.l[e] as Set<PayProtocolEvents[K]>;
    s.add(cb);
    return () => s.delete(cb);
  }
  hello(h: Partial<HelloMessage> = {}): void {
    const m: HelloMessage = {
      type: 'HELLO',
      version: 1,
      pubkey: mocks.asPubkey('seeder'),
      challenge: 'c',
      createdAt: 0 as HelloMessage['createdAt'],
      signature: 's',
      acceptedMints: [mocks.MINTS.a],
      satsPerBlock: mocks.sats(2),
      split: { seeder: 50, creator: 50 },
      p2pk: mocks.asP2pk('seeder'),
      // Issue #8: PAYs batch to half the SEEDER's window now (was: half the pool). A window of 2
      // (with the policy's 2-sat minimum PAY at 2 sats/block) keeps these tests at one block per
      // PAY; the F5 batching tests below announce 8.
      windowBlocks: 2,
      ...h,
    };
    this.peer = m;
    for (const cb of this.l.open) cb(m);
  }
  ack(from: number, to: number, ok = true, core: CoreKeyHex = CORE_1): void {
    const a: AckMessage = ok
      ? { type: 'ACK', core, fromBlock: from, toBlock: to, ok }
      : { type: 'ACK', core, fromBlock: from, toBlock: to, ok, reason: 'wrong-amount' };
    for (const cb of this.l.ack) cb(a);
  }
  close(): void {
    for (const cb of this.l.close) cb('remote');
  }
}

const NOISE = 'aa'.repeat(32);
/** The key of `fakeCore(1)` (the rig's core). */
const CORE_1 = '01'.repeat(32) as CoreKeyHex;
const peerKey = Uint8Array.from(Buffer.from(NOISE, 'hex'));

/**
 * Just enough of hypercore's replicator for `OnePeerRouter` (F33 / issue #8: `attachCore` routes
 * the core and refuses one without these internals). No replication peers: these tests drive
 * `download` events by hand.
 */
class FakeReplicator {
  static Peer = class {
    getMaxInflight(): number {
      return 16;
    }
    getMaxHotswapInflight(): number {
      return 16;
    }
    _cancelRequest(): void {
      // no wire
    }
    _requestBlock(): boolean {
      return false;
    }
  };
  hotswaps = {
    add: (): void => undefined,
    remove: (): void => undefined,
    pick: (): unknown[] => [],
  };
  peers: unknown[] = [];
  updateAll(): void {
    // nothing to schedule
  }
  updatePeer(): void {
    // nothing to schedule
  }
  _updateHotswap(): void {
    // nothing to race
  }
}

function fakeCore(fill: number): Hypercore & EventEmitter {
  const e = new EventEmitter() as Hypercore & EventEmitter;
  Object.assign(e, {
    key: new Uint8Array(32).fill(fill),
    opened: true,
    replicator: new FakeReplicator(),
  });
  return e;
}

const policy: PricePolicy = {
  satsPerBlock: mocks.sats(2),
  blockSize: 65_536,
  mints: [mocks.MINTS.a],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: mocks.asP2pk('creator'),
  // Issue #8: the window a viewer stays under widens to fit one minimum PAY (ADR 0007); 2 sats
  // at 2 sats/block keeps each seeder's window at its HELLO's `windowBlocks`.
  minPaySats: mocks.sats(2),
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function rig(policyFor?: (c: CoreKeyHex) => PricePolicy | null, creditBlocks = 2) {
  const engine = new mocks.MockPaymentEngine();
  // A seeder window of 2 (the HELLO below) batches ONE block per PAY (half the seeder's window,
  // issue #8; it was half this pool of 2): these tests are about settlement, matching and policy,
  // one PAY at a time. Batching has its own tests below (F5).
  const credit = new CreditPool(creditBlocks);
  const paid: PaidEvent[] = [];
  const payer = new ViewerPayer({
    pay: (r, s, p) => engine.pay(r, s, p),
    ownMints: [mocks.MINTS.a],
    credit,
    logger: silentLogger,
    policyFor: policyFor ?? (() => policy),
    onPaid: (e) => paid.push(e),
  });
  const core = fakeCore(1);
  const key = toHex(core.key);
  payer.attachCore(core);
  const proto = new FakeProto();
  payer.attachPeer(NOISE, proto);
  const download = (i: number, from = peerKey): void => {
    credit.tryAcquire(key, i);
    core.emit('download', i, 65_536, { remotePublicKey: from });
  };
  return { engine, credit, payer, core, key, proto, paid, download };
}

describe('ViewerPayer', () => {
  it('pays verified downloads after HELLO, with range.core and the MANIFEST split', async () => {
    const r = rig();
    r.download(0);
    r.download(1);
    await settle();
    expect(r.proto.sent).toHaveLength(0); // no HELLO yet: nothing to lock proofs to
    r.proto.hello({ split: { seeder: 100, creator: 0 } }); // a seeder cannot re-route the creator share
    await settle();
    expect(r.proto.sent).toHaveLength(1);
    const pay = r.proto.sent[0]!;
    expect(pay.range).toEqual({ core: r.key, fromBlock: 0, toBlock: 1 });
    expect(pay.creatorProofs.lockedTo).toBe(policy.creatorP2pk);
    expect(pay.creatorProofs.proofs.reduce((n, p) => n + p.amount, 0)).toBe(2);
    expect(r.paid).toEqual([
      { core: r.key, seeder: mocks.asPubkey('seeder'), mint: mocks.MINTS.a, amount: 4, blocks: 2 },
    ]);
  });

  it('an ACK settles exactly the blocks of the PAY it answers — matched by core and range (v5 ACK names its core)', async () => {
    const r = rig();
    r.proto.hello();
    r.download(0);
    await settle();
    r.download(1);
    await settle();
    // Security review F30: one unacknowledged PAY per core — block 1 waits for [0,0]'s ACK
    // (the creator carry chains PAYs; pipelining them would desynchronise it on a rejection).
    expect(r.proto.sent.map((m) => [m.range.fromBlock, m.range.toBlock])).toEqual([[0, 0]]);
    // Same range, another core: answers nothing we sent on this core.
    r.proto.ack(0, 0, true, 'ee'.repeat(32) as CoreKeyHex);
    expect(r.credit.holds(r.key, 0)).toBe(true);
    expect(r.payer.stats().unmatchedAcks).toBe(1);
    await settle();
    expect(r.proto.sent).toHaveLength(1);
    r.proto.ack(0, 0);
    expect(r.credit.holds(r.key, 0)).toBe(false);
    expect(r.credit.holds(r.key, 1)).toBe(true);
    await settle();
    expect(r.proto.sent.map((m) => [m.range.fromBlock, m.range.toBlock])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    r.proto.ack(7, 7); // answers nothing we sent
    expect(r.payer.stats().unmatchedAcks).toBe(2);
    r.proto.ack(1, 1, false); // refused: still settled (the seeder decides what that means)
    expect(r.credit.size).toBe(0);
    expect(r.payer.stats()).toMatchObject({ acksRejected: 1, owed: 0 });
  });

  it('blocks from a peer without pay/1, or of a core nobody watches, owe nothing', async () => {
    const r = rig((c) => (c === toHex(new Uint8Array(32).fill(1)) ? policy : null));
    r.download(3, Uint8Array.from(Buffer.from('bb'.repeat(32), 'hex')));
    expect(r.credit.holds(r.key, 3)).toBe(false);
    const other = fakeCore(2);
    r.payer.attachCore(other);
    r.credit.tryAcquire(toHex(other.key), 0);
    other.emit('download', 0, 1, { remotePublicKey: peerKey });
    expect(r.credit.holds(toHex(other.key), 0)).toBe(false);
    r.proto.hello();
    await settle();
    expect(r.proto.sent).toHaveLength(0);
  });

  it('a seeder asking more than the manifest price is not paid; its peer closing releases the credit', async () => {
    const r = rig();
    r.proto.hello({ satsPerBlock: mocks.sats(3) });
    r.download(0);
    await settle();
    expect(r.proto.sent).toHaveLength(0);
    expect(r.credit.holds(r.key, 0)).toBe(true);
    r.proto.close();
    expect(r.credit.holds(r.key, 0)).toBe(false);
    expect(r.payer.stats().owed).toBe(0);
  });

  it('never pays at a mint the video does not accept (the host debits its wallet there)', async () => {
    // Our wallet has a: the seeder's first mint we share is a, which the video lists.
    const r = rig();
    r.proto.hello({ acceptedMints: [mocks.MINTS.b, mocks.MINTS.a] });
    r.download(0);
    await settle();
    expect(r.proto.sent[0]?.seederProofs.mint).toBe(mocks.MINTS.a);
    const onlyB = new ViewerPayer({
      pay: (range, s, p) => new mocks.MockPaymentEngine().pay(range, s, p),
      ownMints: [mocks.MINTS.b],
      credit: new CreditPool(4),
      logger: silentLogger,
      policyFor: () => policy,
    });
    // A wallet with only b: the shared mint is b, which the video (mints: [a]) does not accept.
    const core = fakeCore(9);
    onlyB.attachCore(core);
    const proto = new FakeProto();
    onlyB.attachPeer(NOISE, proto);
    proto.hello({ acceptedMints: [mocks.MINTS.b, mocks.MINTS.a] });
    core.emit('download', 0, 65_536, { remotePublicKey: peerKey });
    await settle();
    expect(proto.sent).toHaveLength(0);
  });

  it('never pays a block twice', async () => {
    const r = rig();
    r.proto.hello();
    r.download(0);
    await settle();
    r.download(0);
    await r.payer.flush();
    expect(r.proto.sent).toHaveLength(1);
  });

  // Fix round 4 (test lens): the title said "half the credit pool"; since issue #8 a PAY batches
  // half the SEEDER's window (the body and its comment already said so).
  it("F5 batching: PAYs cover half the seeder's window, not one block each", async () => {
    const r = rig(undefined, 8);
    // Issue #8: the batch is half the SEEDER's window (8 here), no longer half the pool.
    r.proto.hello({ windowBlocks: 8 });
    for (const i of [0, 1, 2]) r.download(i);
    await settle();
    expect(r.proto.sent).toHaveLength(0); // 3 < ⌊8 / 2⌋: waiting for a batch
    r.download(3);
    await settle();
    expect(r.proto.sent.map((m) => [m.range.fromBlock, m.range.toBlock])).toEqual([[0, 3]]);
    r.proto.ack(0, 3);
    expect(r.credit.size).toBe(0);
  });

  it('F5 batching never stalls a download: under pressure every held block is paid', async () => {
    const r = rig(undefined, 8);
    r.proto.hello({ windowBlocks: 8 }); // issue #8: a seeder batch of 4, as the pool's was
    r.download(0);
    await settle();
    expect(r.proto.sent).toHaveLength(0);
    // The player needs a block and the pool has none free (six units held elsewhere).
    for (let i = 100; i < 107; i++) r.credit.tryAcquire('ff'.repeat(32), i);
    const w = r.credit.acquire(r.key, 1); // queues: pressure
    await settle();
    expect(r.proto.sent.map((m) => [m.range.fromBlock, m.range.toBlock])).toEqual([[0, 0]]);
    r.proto.ack(0, 0);
    await w.promise; // block 0's unit came back and went to the waiter
    expect(r.credit.holds(r.key, 1)).toBe(true);
  });

  // Fix round 4 (cross-lane review, gateway payer): a core whose play session is gone could
  // never be paid, and its blocks stayed owed for ever — holding pool units and the seeder's
  // credit — while the PAY failure also stopped every other core of that seeder.
  it("a core whose session is gone: its blocks settle as UNPAID, explicitly (the seeder's credit keeps them), and the seeder's other cores are still paid", async () => {
    const engine = new mocks.MockPaymentEngine();
    const credit = new CreditPool(8);
    const gone = fakeCore(1);
    const live = fakeCore(2);
    const goneKey = toHex(gone.key);
    const liveKey = toHex(live.key);
    const payer = new ViewerPayer({
      pay: (r, s, p) =>
        r.core === goneKey
          ? Promise.reject(new Error('session-closed: no open play session for this core'))
          : engine.pay(r, s, p),
      ownMints: [mocks.MINTS.a],
      credit,
      logger: silentLogger,
      policyFor: () => policy,
    });
    payer.attachCore(gone);
    payer.attachCore(live);
    const proto = new FakeProto();
    payer.attachPeer(NOISE, proto);
    proto.hello({ windowBlocks: 8 });
    credit.tryAcquire(goneKey, 0);
    gone.emit('download', 0, 65_536, { remotePublicKey: peerKey });
    await payer.flush();
    // Settled (the pool unit is back), counted unpaid against that seeder for good.
    expect(credit.holds(goneKey, 0)).toBe(false);
    expect(payer.stats().owed).toBe(0);
    expect(payer.seeders.stats().unpaid).toBe(1);
    expect(payer.seeders.budget(NOISE, liveKey)).toBe(8 - 1);
    for (const i of [0, 1, 2, 3]) {
      credit.tryAcquire(liveKey, i);
      live.emit('download', i, 65_536, { remotePublicKey: peerKey });
    }
    await payer.flush();
    expect(proto.sent.map((m) => [m.range.core, m.range.fromBlock, m.range.toBlock])).toEqual([
      [liveKey, 0, 3],
    ]);
  });

  it("F5 batching counts a seeder's blocks across cores (its window does)", async () => {
    const r = rig(undefined, 8);
    const other = fakeCore(2);
    r.payer.attachCore(other);
    const otherKey = toHex(other.key);
    r.proto.hello({ windowBlocks: 8 }); // issue #8: a seeder batch of 4, as the pool's was
    r.download(0);
    r.download(1);
    r.credit.tryAcquire(otherKey, 0);
    other.emit('download', 0, 65_536, { remotePublicKey: peerKey });
    await settle();
    expect(r.proto.sent).toHaveLength(0); // 3 held across two cores
    r.credit.tryAcquire(otherKey, 1);
    other.emit('download', 1, 65_536, { remotePublicKey: peerKey });
    await settle();
    // 4 across cores: both cores' short runs are paid.
    expect(
      r.proto.sent.map((m) => [m.range.core === r.key, m.range.fromBlock, m.range.toBlock]).sort(),
    ).toEqual([
      [false, 0, 1],
      [true, 0, 1],
    ]);
  });
});

// Fix round 5 (the verifier of fix round 4, MEDIUM): `drain` waited until NOTHING of the core was
// owed or in flight. Every rendition of an upload lives in one core, so after a switch the new
// session streams the same core, and the old session's `play.close` (and with it the switch) ran
// to CLOSE_DRAIN_MS. It also flushed every tail of every core, unbatching the new session.
describe('ViewerPayer.drain(ms, range) — a closing session drains its own blocks (fix round 5)', () => {
  /** The seeder ACKs every PAY ok on a microtask, like an honest one. */
  class AckingProto extends FakeProto {
    override sendPay(m: PayMessage): void {
      super.sendPay(m);
      queueMicrotask(() => {
        this.ack(m.range.fromBlock, m.range.toBlock, true, m.range.core);
      });
    }
  }
  function rig5(
    fail: () => Error | null = () => null,
    boundRange?: ConstructorParameters<typeof ViewerPayer>[0]['boundRange'],
  ) {
    const engine = new mocks.MockPaymentEngine();
    const credit = new CreditPool(16);
    const payer = new ViewerPayer({
      pay: (r, s, p) => {
        const err = fail();
        return err === null ? engine.pay(r, s, p) : Promise.reject(err);
      },
      ownMints: [mocks.MINTS.a],
      credit,
      logger: silentLogger,
      policyFor: () => policy,
      ...(boundRange !== undefined ? { boundRange } : {}),
    });
    const core = fakeCore(1);
    const key = toHex(core.key);
    payer.attachCore(core);
    const proto = new AckingProto();
    payer.attachPeer(NOISE, proto);
    // A window of 8: PAYs batch 4 blocks, so a short tail waits unless something hurries it.
    proto.hello({ windowBlocks: 8 });
    const download = (i: number): void => {
      credit.tryAcquire(key, i);
      core.emit('download', i, 65_536, { remotePublicKey: peerKey });
    };
    const paidRanges = (): [number, number][] =>
      proto.sent.map((m) => [m.range.fromBlock, m.range.toBlock]);
    return { payer, credit, key, proto, download, paidRanges };
  }

  it("returns as soon as ITS tail is paid while another session of the same core has blocks owed — and leaves that session's batching alone", async () => {
    const r = rig5();
    r.download(3); // session A (blocks 0..3): its tail, below a batch
    r.download(5); // session B (blocks 4..9, the new rendition): below a batch too
    await settle();
    expect(r.paidRanges()).toEqual([]);
    const t0 = Date.now();
    const ok = await r.payer.drain(3000, { core: CORE_1, fromBlock: 0, toBlock: 3 });
    expect(ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.paidRanges()).toEqual([[3, 3]]); // A's tail; B's block still batching
    expect(r.payer.stats().owed).toBe(1); // B's, owed — it did not hold A's close up
    expect(r.credit.holds(r.key, 5)).toBe(true);
  });

  it('a block of the closing range that lands during the drain is paid too, then the drain returns', async () => {
    const r = rig5();
    r.download(2);
    const draining = r.payer.drain(3000, { core: CORE_1, fromBlock: 0, toBlock: 3 });
    await settle();
    r.download(3); // was in flight when the session closed
    expect(await draining).toBe(true);
    expect(r.paidRanges()).toEqual([
      [2, 2],
      [3, 3],
    ]);
  });

  it('boundRange reaches the payer: a run across a rendition end is paid as two PAYs (the worker ends one where a session’s blob ends)', async () => {
    const r = rig5(undefined, (range) =>
      range.fromBlock <= 3 ? { ...range, toBlock: Math.min(range.toBlock, 3) } : range,
    );
    for (const i of [2, 3, 4, 5]) r.download(i);
    await r.payer.flush();
    await settle();
    expect(r.paidRanges()).toEqual([
      [2, 3],
      [4, 5],
    ]);
  });

  // The verifier (MEDIUM): the drain's 25 ms flush loop used MAX_PAY_FAILURES up in ~75 ms and
  // wrote a transient failure off as unpaid — a next-start ban at the seeder.
  it('a PAY refused for ~1 s (a mint blip, a top-up in flight) is retried within the drain and paid — never written off', async () => {
    const t0 = Date.now();
    const r = rig5(() =>
      Date.now() - t0 < 1000
        ? new Error('no-balance: not enough sats at this mint to keep streaming')
        : null,
    );
    r.download(3);
    await settle();
    const ok = await r.payer.drain(5000, { core: CORE_1, fromBlock: 0, toBlock: 3 });
    expect(ok).toBe(true);
    expect(r.paidRanges()).toEqual([[3, 3]]);
    expect(r.payer.stats()).toMatchObject({ unpayableBlocks: 0, owed: 0 });
    expect(r.payer.seeders.stats().unpaid).toBe(0);
  });
});
