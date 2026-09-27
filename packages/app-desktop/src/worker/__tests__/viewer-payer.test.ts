import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AckMessage,
  CoreKeyHex,
  HelloMessage,
  MuxLike,
  OwedMessage,
  PayMessage,
  PayProtocol,
  PayProtocolEvents,
  PayProtocolState,
  PriceMessage,
  PricePolicy,
} from '@sovit/core';
import { mocks, payment } from '@sovit/core';
import type Hypercore from 'hypercore';
import { silentLogger, toHex } from '@sovit/seeder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAY_GIVE_UP_MS, PAY_RETRY_BASE_MS, PAY_RETRY_MAX_MS } from '@sovit/gateway/upstream';

import { fromWireError, wireError } from '../../ipc/errors.js';
import type { PaidEvent } from '../pay/viewer-payer.js';
import { PAY_RETRY_LATER_MAX_MS, PAY_RETRY_LATER_MS, ViewerPayer } from '../pay/viewer-payer.js';
import { CreditPool } from '../playback/credit.js';
import type { TailTerms } from '../pay/unpaid-record.js';
import { UnpaidRecord } from '../pay/unpaid-record.js';
import { nodeStateFs } from './helpers/harness.js';

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
    owed: new Set(),
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
  sendOwed(_o: Omit<OwedMessage, 'type'>): void {
    // viewer never reports what it is owed (contracts v6 amendment: seeder → viewer only)
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
  /** Lane P2-owed-viewer: the seeder's terms for a core, and its report of what it counts. */
  price(p: Omit<PriceMessage, 'type'>): void {
    for (const cb of this.l.price) cb({ type: 'PRICE', ...p });
  }
  owed(core: CoreKeyHex, ranges: [number, number][]): void {
    for (const cb of this.l.owed) cb({ type: 'OWED', core, ranges });
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

/** The creator carry after a PAY of `amount` sats at `p`'s split (core's one implementation). */
const mocksSplit = (amount: number, p: PricePolicy, carryIn: number): number =>
  payment.splitPay(amount, p.split, carryIn).carryOut;

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

// Lane R6-reconcile: both tests below fake `performance` beside the timers. UpstreamPayer's
// streaks and backoffs now read a monotonic clock (`performance.now()` by default, the round-5
// verifier), no longer `Date.now()`; with only the timers faked, that clock stood still while the
// fake timers ran. The retry these tests pin is UpstreamPayer's one mechanism now (`rate-limited`
// is deferred there), not a timer of ViewerPayer's own.
describe('ViewerPayer: a PAY the host refuses for now (ADR 0012 amendment, lane I2-paygate)', () => {
  it('a melt at the mint (rate-limited): the blocks stay owed, nothing reaches the seeder, the session stays up; the payer asks again on a backoff — never in a loop — and pays once the host accepts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const engine = new mocks.MockPaymentEngine();
      let melting = true;
      let asked = 0;
      const credit = new CreditPool(2);
      const payer = new ViewerPayer({
        pay: (range, seeder, p) => {
          asked++;
          // What the worker's `pay.build` rejects with while the host's gate is closed.
          if (melting)
            return Promise.reject(
              fromWireError(wireError('rate-limited', 'a melt is in progress at this mint')),
            );
          return engine.pay(range, seeder, p);
        },
        ownMints: [mocks.MINTS.a],
        credit,
        logger: silentLogger,
        policyFor: () => policy,
      });
      const core = fakeCore(1);
      const key = toHex(core.key);
      payer.attachCore(core);
      const proto = new FakeProto();
      payer.attachPeer(NOISE, proto);
      proto.hello();
      // Both credit units are held by blocks nobody has paid for: no download can come.
      for (const i of [0, 1]) {
        credit.tryAcquire(key, i);
        core.emit('download', i, 65_536, { remotePublicKey: peerKey });
      }
      await settle();
      const first = asked; // each download asked (the second after the first was refused)
      expect(first).toBeGreaterThanOrEqual(1);
      // A 5-minute melt: a handful of asks, spaced by the backoff (the 2 s tail timer too) —
      // 2, 4, 8, 16 s, then every 30 s: about 14, never one per event-loop turn.
      for (let s = 0; s < 300; s++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await settle();
      }
      expect(asked - first).toBeGreaterThanOrEqual(5);
      expect(asked - first).toBeLessThanOrEqual(Math.ceil(300_000 / PAY_RETRY_LATER_MAX_MS) + 8);
      expect(proto.sent).toEqual([]); // the seeder never saw a PAY: no window, no ban
      expect(credit.holds(key, 0) && credit.holds(key, 1)).toBe(true); // still owed
      expect(payer.stats().owed).toBe(2);

      // The melt settles: the next ask goes through by itself, with no download to trigger it.
      melting = false;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_LATER_MAX_MS);
      await settle();
      // One PAY for the whole owed run (the retry pays what is owed however short).
      expect(proto.sent.map((m) => [m.range.fromBlock, m.range.toBlock])).toEqual([[0, 1]]);
      proto.ack(0, 1);
      expect(credit.size).toBe(0);
      // Nothing owed any more: no further asks.
      const after = asked;
      await vi.advanceTimersByTimeAsync(10 * PAY_RETRY_LATER_MAX_MS);
      await settle();
      expect(asked).toBe(after);
      payer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // Lane R6-reconcile: this test was "only rate-limited brings the payer back by itself". That
  // premise went with fix round 5, which retries EVERY transient failure by itself (its own
  // backoff, PAY_RETRY_BASE_MS doubling), and gives it up after PAY_GIVE_UP_MS — which would have
  // written a 300 s melt off after 30 s. Reconciled: `rate-limited` is deferred (its own cadence
  // from PAY_RETRY_LATER_MS, never given up) and anything else is transient. What the old test
  // protected still holds and is asserted: the first ask after `rate-limited` waits exactly
  // PAY_RETRY_LATER_MS, the asks are spaced (never a loop), nothing reaches the seeder, the owed
  // block stays owed, and close() cancels.
  it('rate-limited is deferred: asked again after PAY_RETRY_LATER_MS, then on its doubling cadence, never given up; any other failure is transient: retried sooner, given up after PAY_GIVE_UP_MS; close() cancels', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const make = (code: 'rate-limited' | 'no-balance') => {
        let asked = 0;
        const credit = new CreditPool(2);
        const payer = new ViewerPayer({
          pay: () => {
            asked++;
            return Promise.reject(fromWireError(wireError(code, 'refused')));
          },
          ownMints: [mocks.MINTS.a],
          credit,
          logger: silentLogger,
          policyFor: () => policy,
        });
        const core = fakeCore(1);
        payer.attachCore(core);
        const proto = new FakeProto();
        payer.attachPeer(NOISE, proto);
        proto.hello();
        credit.tryAcquire(toHex(core.key), 0);
        core.emit('download', 0, 65_536, { remotePublicKey: peerKey });
        return { payer, proto, asked: () => asked };
      };
      const limited = make('rate-limited');
      const broke = make('no-balance');
      await settle();
      const [l0, b0] = [limited.asked(), broke.asked()];
      expect([l0, b0]).toEqual([1, 1]); // the download's own ask, refused
      // The transient failure comes back after PAY_RETRY_BASE_MS; the deferred one waits longer.
      await vi.advanceTimersByTimeAsync(PAY_RETRY_BASE_MS);
      await settle();
      expect([limited.asked(), broke.asked()]).toEqual([l0, b0 + 1]);
      await vi.advanceTimersByTimeAsync(PAY_RETRY_LATER_MS - PAY_RETRY_BASE_MS - 1);
      await settle();
      expect(limited.asked()).toBe(l0); // (the 2 s tail timer is due at the same moment)
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      const l1 = limited.asked();
      expect(l1).toBe(l0 + 1); // exactly one ask at PAY_RETRY_LATER_MS
      // A minute on: the transient one is given up (settled as unpaid, asked no more); the
      // deferred one is still owed and asked on its cadence (2, 4, 8, 16, then every 30 s).
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(broke.payer.stats()).toMatchObject({ unpayableBlocks: 1, owed: 0 });
      expect(limited.payer.stats()).toMatchObject({ unpayableBlocks: 0, owed: 1 });
      expect(limited.asked() - l1).toBeGreaterThanOrEqual(3);
      expect(limited.asked() - l1).toBeLessThanOrEqual(5);
      // The transient one was asked on its own backoff (≤ 4 s apart) until PAY_GIVE_UP_MS, no more.
      expect(broke.asked()).toBeLessThanOrEqual(
        b0 + 5 + Math.ceil(PAY_GIVE_UP_MS / PAY_RETRY_MAX_MS),
      );
      const b1 = broke.asked();
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(broke.asked()).toBe(b1);
      expect(limited.asked()).toBeGreaterThan(l1 + 3);
      // Neither ever reached the seeder.
      expect(limited.proto.sent).toEqual([]);
      expect(broke.proto.sent).toEqual([]);
      limited.payer.close();
      const closed = limited.asked();
      await vi.advanceTimersByTimeAsync(10 * PAY_RETRY_LATER_MAX_MS);
      await settle();
      expect(limited.asked()).toBe(closed);
      broke.payer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // Lane R6-reconcile: close() used to clear ViewerPayer's own timer; the retry is UpstreamPayer's
  // now, and a PAY refused after close() must arm none.
  it('a PAY refused for now AFTER close() arms no retry (the host answered late)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let asked = 0;
      let refuse: (e: Error) => void = () => undefined;
      const credit = new CreditPool(2);
      const payer = new ViewerPayer({
        pay: () => {
          asked++;
          return new Promise<PayMessage>((_resolve, reject) => {
            refuse = reject;
          });
        },
        ownMints: [mocks.MINTS.a],
        credit,
        logger: silentLogger,
        policyFor: () => policy,
      });
      const core = fakeCore(1);
      payer.attachCore(core);
      const proto = new FakeProto();
      payer.attachPeer(NOISE, proto);
      proto.hello();
      credit.tryAcquire(toHex(core.key), 0);
      core.emit('download', 0, 65_536, { remotePublicKey: peerKey });
      await settle();
      expect(asked).toBe(1); // being built by the host
      payer.close();
      refuse(fromWireError(wireError('rate-limited', 'a melt is in progress at this mint')));
      await settle();
      await vi.advanceTimersByTimeAsync(10 * PAY_RETRY_LATER_MAX_MS);
      await settle();
      expect(asked).toBe(1);
      expect(proto.sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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

// ---- lane P2-owed-viewer (ADR 0018 amendment 2026-09-26): the unpaid tail ------------------

describe('ViewerPayer: the record of what is unpaid, and paying what a seeder reports (ADR 0018 amendment)', () => {
  const SID_A = 'a1'.repeat(16);
  const SID_B = 'b2'.repeat(16);
  const SEEDER_PK = mocks.asPubkey('seeder');
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  async function tailRig(
    o: {
      refuseOwed?: () => string | null;
      refusePay?: () => string | null;
      /** The manifest policy (default: 2 sats/block at 50/50, whose carry is always 0). */
      policy?: PricePolicy;
    } = {},
  ) {
    const terms0 = o.policy ?? policy;
    const dir = await mkdtemp(join(tmpdir(), 'nf-vp-tail-'));
    dirs.push(dir);
    const record = new UnpaidRecord({
      state: nodeStateFs,
      dir,
      join: (...p) => join(...p),
      pubkey: 'ee'.repeat(32),
      logger: silentLogger,
      flushMs: 60_000,
    });
    const engine = new mocks.MockPaymentEngine();
    const credit = new CreditPool(2);
    const owedCalls: { sid: string; range: [number, number]; carryIn: number }[] = [];
    /** What each fresh PAY's function was handed as `opts.carryIn` (`undefined`: nothing). */
    const freshCarry: (number | undefined)[] = [];
    const termsOf = (sid: string): TailTerms => ({
      sid,
      core: CORE_1,
      first: 0,
      last: 99,
      policy: terms0,
    });
    const payer = new ViewerPayer({
      pay: (r, sd, p, opts) => {
        const refusal = o.refusePay?.() ?? null;
        if (refusal !== null)
          return Promise.reject(fromWireError(wireError('session-closed', refusal)));
        freshCarry.push(opts?.carryIn);
        // As the host does (`real-providers.ts`): the split uses the carry it is handed, else 0.
        return engine.pay(r, sd, p, { carryIn: opts?.carryIn ?? 0 });
      },
      ownMints: [mocks.MINTS.a],
      credit,
      logger: silentLogger,
      policyFor: () => terms0,
      record,
      termsFor: () => termsOf(SID_A),
      payOwed: (sid, range, sd, p, carryIn) => {
        const refusal = o.refuseOwed?.() ?? null;
        if (refusal !== null) return Promise.reject(fromWireError(wireError('forbidden', refusal)));
        owedCalls.push({ sid, range: [range.fromBlock, range.toBlock], carryIn });
        return engine.pay(range, sd, p, { carryIn });
      },
    });
    const core = fakeCore(1);
    const key = toHex(core.key);
    payer.attachCore(core);
    const proto = new FakeProto();
    payer.attachPeer(NOISE, proto);
    const download = (i: number): void => {
      credit.tryAcquire(key, i);
      core.emit('download', i, 65_536, { remotePublicKey: peerKey });
    };
    const held = (): number[] => record.recorded(SEEDER_PK, CORE_1, [[0, 99]]).map((b) => b.index);
    return { record, engine, payer, proto, download, owedCalls, freshCarry, termsOf, held };
  }
  const priced = { core: CORE_1, satsPerBlock: mocks.sats(2), effectiveFromBlock: 0 };

  it('records each block received from a seeder with a verified HELLO, with its session; a built PAY takes it out; a block given up stays (the tail)', async () => {
    let refuse: string | null = null;
    const r = await tailRig({ refusePay: () => refuse });
    r.download(0); // no HELLO yet: nothing could pay it, nothing asked it — not recorded
    expect(r.held()).toEqual([]);
    r.proto.hello();
    r.download(1);
    r.download(2);
    expect(r.held()).toEqual([1, 2]);
    expect(r.record.termsOf(SEEDER_PK, CORE_1, 1)?.sid).toBe(SID_A);
    await settle();
    // Built (and sent): out of the record, whatever becomes of its ACK.
    expect(r.proto.sent).toHaveLength(1);
    expect(r.held()).toEqual([]);
    r.proto.ack(r.proto.sent[0]!.range.fromBlock, r.proto.sent[0]!.range.toBlock);
    // Its session gone for good (the host refuses): given up — the tail, kept for a later OWED.
    refuse = 'no play session covers these blocks';
    r.download(3);
    await r.payer.flush();
    await settle();
    expect(r.payer.stats().unpayableBlocks).toBe(1);
    expect(r.held()).toEqual([3]);
    expect(r.record.unpaidFor(SID_A)).toBe(1);
  });

  it('an OWED: only reported blocks the record holds are paid, under the recorded session and terms; the rest of the claim never', async () => {
    const r = await tailRig();
    // What an earlier run left: blocks 5 and 6 of session B.
    r.record.add(SEEDER_PK, CORE_1, 5, r.termsOf(SID_B));
    r.record.add(SEEDER_PK, CORE_1, 6, r.termsOf(SID_B));
    r.proto.hello();
    r.proto.price(priced); // its priced PRICE before its OWED (contract rule 3)
    r.proto.owed(CORE_1, [[5, 8]]);
    await r.payer.flush();
    expect(r.owedCalls).toEqual([{ sid: SID_B, range: [5, 6], carryIn: 0 }]);
    expect(r.proto.sent.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[5, 6]]);
    expect(r.payer.stats()).toMatchObject({ owedReported: 4, owedRecorded: 2, owedPaid: 2 });
    // Not this session's spend: the host's wallet shows it, the session's totals do not.
    r.proto.ack(5, 6);
    expect(r.held()).toEqual([]);
    // 7 and 8 were never asked of the record, never paid: the claim is respected by the credit.
    expect(r.payer.seeders.reportOf(NOISE)).toMatchObject({ done: true });
  });

  it('an OWED before its priced PRICE, or for a core it serves free, pays nothing (contract rule 3)', async () => {
    const r = await tailRig();
    r.record.add(SEEDER_PK, CORE_1, 5, r.termsOf(SID_B));
    r.proto.hello();
    r.proto.owed(CORE_1, [[5, 5]]);
    await r.payer.flush();
    expect(r.owedCalls).toEqual([]);
    expect(r.held()).toEqual([5]); // kept: another connection may be priced
  });

  it('an owed range the host refuses for good leaves the record (respected, never paid again)', async () => {
    const r = await tailRig({
      refuseOwed: () => 'the tail authorisation of that session has expired',
    });
    r.record.add(SEEDER_PK, CORE_1, 5, r.termsOf(SID_B));
    r.proto.hello();
    r.proto.price(priced);
    r.proto.owed(CORE_1, [[5, 5]]);
    await r.payer.flush();
    await settle();
    expect(r.proto.sent).toHaveLength(0);
    expect(r.held()).toEqual([]);
    expect(r.payer.stats()).toMatchObject({ owedRecorded: 1, owedPaid: 0, unpayableBlocks: 1 });
  });

  it('a PAY never mixes owed blocks of two recorded sessions, nor owed blocks with this connection’s', async () => {
    const r = await tailRig();
    for (const i of [3, 4]) r.record.add(SEEDER_PK, CORE_1, i, r.termsOf(SID_B));
    for (const i of [5, 6]) r.record.add(SEEDER_PK, CORE_1, i, r.termsOf('c3'.repeat(16)));
    r.proto.hello({ windowBlocks: 16 });
    r.proto.price(priced);
    r.download(7); // this connection's block, next to the owed ones
    r.proto.owed(CORE_1, [[3, 6]]);
    await r.payer.flush();
    for (let i = 0; i < 6 && r.proto.sent.length < 3; i++) {
      const last = r.proto.sent.at(-1);
      if (last !== undefined) r.proto.ack(last.range.fromBlock, last.range.toBlock);
      await r.payer.flush();
    }
    expect(r.proto.sent.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([
      [3, 4],
      [5, 6],
      [7, 7],
    ]);
    expect(r.owedCalls.map((c) => c.sid)).toEqual([SID_B, 'c3'.repeat(16)]);
  });

  // Review finding (lane P2-owed-viewer, MEDIUM): blocks left the record only on an ACK, so a
  // seeder that took a PAY and dropped before its ACK could report the same blocks on the next
  // connection and be paid again. A built PAY now takes its blocks out at once.
  it('a PAY built for recorded blocks takes them out at once: a seeder that takes it, drops before its ACK and reports them again is not paid twice', async () => {
    const r = await tailRig();
    r.record.add(SEEDER_PK, CORE_1, 5, r.termsOf(SID_B));
    r.proto.hello();
    r.proto.price(priced);
    r.proto.owed(CORE_1, [[5, 5]]);
    await r.payer.flush();
    expect(r.owedCalls.map((c) => c.range)).toEqual([[5, 5]]);
    expect(r.proto.sent.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[5, 5]]);
    // This connection's block 1 waits behind [5,5]'s PAY (one per core): no ACK comes, it drops.
    r.download(1);
    await r.payer.flush();
    expect(r.held()).toEqual([1]);
    r.proto.close();
    const again = new FakeProto();
    r.payer.attachPeer(NOISE, again);
    again.hello();
    again.price(priced);
    again.owed(CORE_1, [
      [1, 1],
      [5, 5],
    ]);
    await r.payer.flush();
    // 5's PAY was built and sent: never again. 1 was never built: paid now, under its session.
    expect(r.owedCalls.map((c) => [c.sid, c.range])).toEqual([
      [SID_B, [5, 5]],
      [SID_A, [1, 1]],
    ]);
    expect(r.held()).toEqual([]);
  });

  // Independent review (lane P2-owed-viewer, HIGH): the engine wrapper dropped `opts`, so every
  // fresh PAY reached the host with `carryIn` 0 while the seeder holds the chain's carry — refused
  // `malformed` (engine.ts), its proofs already spent. Every earlier test paid 2 sats/block at
  // 50/50, whose carry is always 0. At 90/10 one block leaves a carry of 20.
  it('every fresh PAY is split with the carry of its chain: the pay function is handed carryIn', async () => {
    const p90: PricePolicy = { ...policy, split: { seeder: 90, creator: 10 } };
    const r = await tailRig({ policy: p90 });
    r.proto.hello({ split: p90.split });
    r.download(0);
    await r.payer.flush();
    expect(r.proto.sent.map((p) => [p.range.fromBlock, p.carryIn])).toEqual([[0, 0]]);
    r.proto.ack(0, 0);
    r.download(1);
    await r.payer.flush();
    const carry = mocksSplit(2, p90, 0);
    expect(carry).toBe(20);
    expect(r.freshCarry).toEqual([0, carry]);
    expect(r.proto.sent.map((p) => [p.range.fromBlock, p.carryIn])).toEqual([
      [0, 0],
      [1, carry],
    ]);
  });

  it('an owed PAY and the fresh PAYs after it share one carry chain on the core', async () => {
    const p90: PricePolicy = { ...policy, split: { seeder: 90, creator: 10 } };
    const r = await tailRig({ policy: p90 });
    r.record.add(SEEDER_PK, CORE_1, 5, r.termsOf(SID_B));
    r.proto.hello({ split: p90.split });
    r.proto.price(priced);
    r.proto.owed(CORE_1, [[5, 5]]);
    await r.payer.flush();
    expect(r.owedCalls).toEqual([{ sid: SID_B, range: [5, 5], carryIn: 0 }]);
    r.proto.ack(5, 5);
    // The owed PAY moved the carry: the next fresh PAY of the core is split with it.
    r.download(1);
    await r.payer.flush();
    expect(r.freshCarry).toEqual([mocksSplit(2, p90, 0)]);
    expect(r.proto.sent.at(-1)?.carryIn).toBe(20);
  });

  // Independent review (lane P2-owed-viewer, info): every recorded index of an OWED was marked
  // owed, even those `addOwed` skipped (pending on this link). A fresh range of such a block given
  // up later then left the record, when it should have stayed as a tail.
  it('an OWED naming a block pending on this link: only the blocks the payer took are owed; the pending one stays a tail when given up', async () => {
    let refuse: string | null = null;
    const r = await tailRig({ refusePay: () => refuse });
    r.record.add(SEEDER_PK, CORE_1, 5, r.termsOf(SID_B)); // from an earlier run
    r.proto.hello();
    r.proto.price(priced);
    refuse = 'no play session covers these blocks';
    r.download(3); // this link's block, recorded, its PAY about to be refused for good
    r.proto.owed(CORE_1, [[3, 5]]); // reports it too (the report may count it: same pubkey)
    await r.payer.flush();
    await settle();
    // 5 was paid as owed; 3 was not taken as owed — refused as this link's block, it stays.
    expect(r.owedCalls.map((c) => c.range)).toEqual([[5, 5]]);
    expect(r.payer.stats().owedRecorded).toBe(1);
    expect(r.held()).toEqual([3]);
  });

  // Independent review (lane P2-owed-viewer, info): an owed range with no mint shared on this
  // connection was given up like a refused one — out of the record for good — although a later
  // connection listing the mint could pay it. It is now dropped from this connection only.
  it('an owed range with no mint shared on this connection stays in the record; a later connection sharing one pays it', async () => {
    const r = await tailRig();
    r.record.add(SEEDER_PK, CORE_1, 5, r.termsOf(SID_B));
    r.proto.hello({ acceptedMints: [mocks.MINTS.b] }); // not a mint of ours
    r.proto.price(priced);
    r.proto.owed(CORE_1, [[5, 5]]);
    await r.payer.flush();
    await settle();
    expect(r.owedCalls).toEqual([]);
    expect(r.held()).toEqual([5]);
    r.proto.close();
    const again = new FakeProto();
    r.payer.attachPeer(NOISE, again);
    again.hello();
    again.price(priced);
    again.owed(CORE_1, [[5, 5]]);
    await r.payer.flush();
    expect(r.owedCalls).toEqual([{ sid: SID_B, range: [5, 5], carryIn: 0 }]);
    expect(r.held()).toEqual([]);
  });

  it('a core the seeder serves free: its blocks are owed nothing — settled on arrival, not recorded, never paid', async () => {
    const r = await tailRig();
    r.proto.hello();
    r.proto.price({ core: CORE_1, satsPerBlock: mocks.sats(0), effectiveFromBlock: 0, free: true });
    r.download(1);
    await r.payer.flush();
    expect(r.held()).toEqual([]);
    expect(r.proto.sent).toHaveLength(0);
    expect(r.payer.stats().owed).toBe(0);
  });
});
