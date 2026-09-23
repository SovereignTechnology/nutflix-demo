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
      signature: 's',
      acceptedMints: [mocks.MINTS.a],
      satsPerBlock: mocks.sats(2),
      split: { seeder: 50, creator: 50 },
      p2pk: mocks.asP2pk('seeder'),
      ...h,
    };
    this.peer = m;
    for (const cb of this.l.open) cb(m);
  }
  ack(from: number, to: number, ok = true): void {
    const a: AckMessage = ok
      ? { type: 'ACK', fromBlock: from, toBlock: to, ok }
      : { type: 'ACK', fromBlock: from, toBlock: to, ok, reason: 'wrong-amount' };
    for (const cb of this.l.ack) cb(a);
  }
  close(): void {
    for (const cb of this.l.close) cb('remote');
  }
}

const NOISE = 'aa'.repeat(32);
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

function rig(policyFor?: (c: CoreKeyHex) => PricePolicy | null) {
  const engine = new mocks.MockPaymentEngine();
  const credit = new CreditPool(8);
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

  it('an ACK settles exactly the blocks of the PAY it answers (matched FIFO without a core)', async () => {
    const r = rig();
    r.proto.hello();
    r.download(0);
    await settle();
    r.download(1);
    await settle();
    expect(r.proto.sent.map((m) => [m.range.fromBlock, m.range.toBlock])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    r.proto.ack(1, 1);
    expect(r.credit.holds(r.key, 1)).toBe(false);
    expect(r.credit.holds(r.key, 0)).toBe(true);
    r.proto.ack(7, 7); // answers nothing we sent
    expect(r.payer.stats().unmatchedAcks).toBe(1);
    r.proto.ack(0, 0, false); // refused: still settled (the seeder decides what that means)
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
});
