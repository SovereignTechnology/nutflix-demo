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
      windowBlocks: 4,
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

function fakeCore(fill: number): Hypercore & EventEmitter {
  const e = new EventEmitter() as Hypercore & EventEmitter;
  Object.assign(e, { key: new Uint8Array(32).fill(fill) });
  return e;
}

const policy: PricePolicy = {
  satsPerBlock: mocks.sats(2),
  blockSize: 65_536,
  mints: [mocks.MINTS.a],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: mocks.asP2pk('creator'),
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function rig(policyFor?: (c: CoreKeyHex) => PricePolicy | null, creditBlocks = 2) {
  const engine = new mocks.MockPaymentEngine();
  // A pool of 2 batches ONE block per PAY (half the pool): these tests are about settlement,
  // matching and policy, one PAY at a time. Batching has its own tests below (F5).
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

  it('F5 batching: PAYs cover half the credit pool, not one block each', async () => {
    const r = rig(undefined, 8);
    r.proto.hello();
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
    r.proto.hello();
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

  it("F5 batching counts a seeder's blocks across cores (its window does)", async () => {
    const r = rig(undefined, 8);
    const other = fakeCore(2);
    r.payer.attachCore(other);
    const otherKey = toHex(other.key);
    r.proto.hello();
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
