/**
 * Issue #8 — the viewer's credit per seeder window (`SeederCredit`), the settler's report of
 * blocks settled without a payment, the pool that follows the seeders' windows, and the payer's
 * per-seeder batch. Units with fakes; `one-peer.integration.test.ts` runs them on real streams.
 */
import { EventEmitter } from 'node:events';

import { mocks, payment } from '@sovit/core';
import type { CoreKeyHex, PricePolicy, Sats } from '@sovit/core';
import type Hypercore from 'hypercore';
import { silentLogger } from '@sovit/seeder';
import { describe, expect, it } from 'vitest';

import { CreditPool } from '../upstream/credit.js';
import { UpstreamPayer } from '../upstream/payer.js';
import {
  MAX_POOL_CREDIT,
  MAX_SEEDER_CREDIT,
  NO_PAY_INFLIGHT,
  SeederCredit,
} from '../upstream/seeder-credit.js';
import type { SeederBatch } from '../upstream/seeder-credit.js';
import { CreditSettler } from '../upstream/settle.js';
import { FakePayProtocol, helloFrom } from './fake-pay-protocol.js';
import { MINT_A, basePolicy, pubkey } from './helpers.js';

const CORE = 'c0'.repeat(32) as CoreKeyHex;
const OTHER = 'c1'.repeat(32) as CoreKeyHex;
const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const hexBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

/** 2 sats/block and a 2-sat minimum PAY: a seeder's window is exactly its HELLO's. */
const tight: PricePolicy = { ...basePolicy(2), minPaySats: 2 as Sats };

/**
 * Just enough of hypercore's replicator for `OnePeerRouter.attachCore` (no replication peers:
 * these tests drive `download` events by hand).
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
  hotswaps = { add: (): void => undefined, remove: (): void => undefined, pick: (): [] => [] };
  peers: unknown[] = [];
  refreshes = 0;
  updateAll(): void {
    this.refreshes++;
  }
  updatePeer(): void {
    // nothing to schedule
  }
  _updateHotswap(): void {
    // nothing to race
  }
}

function fakeCore(key: CoreKeyHex): Hypercore & EventEmitter & { replicator: FakeReplicator } {
  const e = new EventEmitter();
  Object.assign(e, { key: hexBytes(key), opened: true, replicator: new FakeReplicator() });
  return e as unknown as Hypercore & EventEmitter & { replicator: FakeReplicator };
}

function rig(opts: { floor?: number; policies?: Map<string, PricePolicy> } = {}) {
  const pool = new CreditPool(opts.floor ?? 4);
  const policies = opts.policies ?? new Map<string, PricePolicy>([[CORE, tight]]);
  // The settler owns CORE's blocks only (what the gateway / worker configure per core).
  const settler = new CreditSettler({
    credit: pool,
    logger: silentLogger,
    payable: (c) => c === CORE,
  });
  const credit = new SeederCredit({
    settler,
    pool,
    policyFor: (c) => policies.get(c) ?? null,
    logger: silentLogger,
  });
  const core = fakeCore(CORE);
  settler.attachCore(core);
  credit.attachCore(core);
  const link = (noise: string) => {
    const proto = new FakePayProtocol();
    const settled = settler.attachPeer(noise, proto);
    const detach = credit.attachPeer(noise, proto);
    return { proto, settled, detach };
  };
  const download = (i: number, from: string): void => {
    pool.tryAcquire(CORE, i);
    core.emit('download', i, 1024, { remotePublicKey: hexBytes(from) });
  };
  /** Our PAY for [from, to] went out to `noise` and its ACK came back. */
  const paid = (
    l: ReturnType<typeof link>,
    from: number,
    to: number,
    ok = true,
    core2: CoreKeyHex = CORE,
  ) => {
    l.settled.protocol.sendPay({ range: { core: core2, fromBlock: from, toBlock: to } } as never);
    l.proto.remoteAck(
      ok
        ? { type: 'ACK', core: core2, fromBlock: from, toBlock: to, ok }
        : { type: 'ACK', core: core2, fromBlock: from, toBlock: to, ok, reason: 'wrong-amount' },
    );
  };
  return { pool, settler, credit, core, link, download, paid, policies };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('SeederCredit — the budget per seeder (issue #8)', () => {
  it('no HELLO: nothing may be asked; after it: its window for the core (effectiveWindowBlocks)', () => {
    const r = rig();
    const a = r.link(A);
    expect(r.credit.budget(A, CORE)).toBe(0);
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 3 }));
    expect(r.credit.budget(A, CORE)).toBe(3);
    expect(r.credit.windowOf(A, CORE)).toBe(3);
    // The default minimum PAY (10 sats at 2 sats/block) widens it, as the seeder's engine does.
    r.policies.set(CORE, basePolicy(2));
    expect(r.credit.budget(A, CORE)).toBe(payment.effectiveWindowBlocks(3, basePolicy(2)));
    expect(r.credit.budget(A, CORE)).toBe(5);
  });

  it('a peer without pay/1, or a core nobody pays for: a bounded burst in flight, never unlimited', () => {
    const r = rig();
    expect(r.credit.budget(B, CORE)).toBe(NO_PAY_INFLIGHT);
    const a = r.link(A);
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 100 }));
    expect(r.credit.budget(A, OTHER)).toBe(NO_PAY_INFLIGHT);
    expect(Number.isFinite(r.credit.budget(A, OTHER))).toBe(true);
  });

  it('a HELLO claiming a huge window is clamped', () => {
    const r = rig();
    const a = r.link(A);
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 65_535 }));
    expect(r.credit.budget(A, CORE)).toBe(MAX_SEEDER_CREDIT);
  });

  it('blocks it delivered come off its budget until their PAY is ACKed', () => {
    const r = rig();
    const a = r.link(A);
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 3 }));
    r.download(0, A);
    r.download(1, A);
    expect(r.settler.owedBy(A)).toBe(2);
    expect(r.credit.budget(A, CORE)).toBe(1);
    r.paid(a, 0, 1);
    expect(r.settler.owedBy(A)).toBe(0);
    expect(r.credit.budget(A, CORE)).toBe(3);
  });

  it('a REJECTED PAY frees the pool but its blocks stay off that seeder’s budget for good', () => {
    const r = rig();
    const a = r.link(A);
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 3 }));
    r.download(0, A);
    r.paid(a, 0, 0, false);
    expect(r.pool.holds(CORE, 0)).toBe(false);
    expect(r.credit.budget(A, CORE)).toBe(2);
    expect(r.credit.stats().unpaid).toBe(1);
  });

  it('a pay/1 that goes away: budget 0 (we could never pay), and what it was owed stays counted when it comes back', () => {
    const r = rig();
    const first = r.link(A);
    first.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 4 }));
    r.download(0, A);
    r.download(1, A);
    first.proto.remoteClose('remote');
    expect(r.credit.budget(A, CORE)).toBe(0);
    expect(r.pool.size).toBe(0);
    // It reconnects (same Noise key): no budget before its HELLO, then its window less the two.
    const second = r.link(A);
    expect(r.credit.budget(A, CORE)).toBe(0);
    second.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 4 }));
    expect(r.credit.budget(A, CORE)).toBe(2);
    // The OLD connection's late close does not end the new one.
    first.proto.remoteClose('remote');
    first.detach();
    expect(r.credit.budget(A, CORE)).toBe(2);
    second.detach();
    expect(r.credit.budget(A, CORE)).toBe(0);
  });

  it('a seeder back under a NEW Noise key but the same HELLO pubkey inherits what its old link left unpaid', () => {
    const r = rig();
    const old = r.link(A);
    old.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 4 }));
    r.download(0, A);
    r.download(1, A);
    old.proto.remoteClose('remote');
    const renamed = r.link(B);
    renamed.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 4 }));
    expect(r.credit.budget(B, CORE)).toBe(2);
    // Someone else's pubkey owes nothing of it.
    const other = r.link('c3'.repeat(32));
    other.proto.remoteHello(helloFrom(pubkey('c'), { windowBlocks: 4 }));
    expect(r.credit.budget('c3'.repeat(32), CORE)).toBe(4);
  });

  it('one Noise key re-announcing fresh HELLO pubkeys does not grow the pubkey index; a reconnect before its HELLO keeps what it inherits', () => {
    const r = rig();
    // Independent review 2026-09-25: each reconnect with a new (validly signed) pubkey left an
    // entry behind for the life of the process.
    for (let i = 0; i < 50; i++) {
      const l = r.link(A);
      l.proto.remoteHello(helloFrom(pubkey(`fresh-${String(i)}`), { windowBlocks: 2 }));
      l.proto.remoteClose('remote');
    }
    expect(r.credit.stats()).toMatchObject({ seeders: 1, pubkeys: 1 });
    // A's last pubkey still carries what A left unpaid to a NEW Noise key announcing it, even
    // after A reconnected and dropped again before sending its HELLO.
    const a = r.link(A);
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 4 }));
    r.download(0, A);
    a.proto.remoteClose('remote'); // owed at the drop: unpaid for good
    r.link(A).proto.remoteClose('remote'); // back without a HELLO, and gone again
    const b = r.link(B);
    b.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 4 }));
    expect(r.credit.budget(B, CORE)).toBe(3);
    expect(r.credit.stats().pubkeys).toBe(1);
  });

  it('the pool follows the sum of the seeders’ windows, never below its floor nor above the cap', () => {
    const r = rig({ floor: 4 });
    expect(r.pool.limit).toBe(4);
    const a = r.link(A);
    const b = r.link(B);
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 8 }));
    expect(r.pool.limit).toBe(8);
    b.proto.remoteHello(helloFrom(pubkey('b'), { windowBlocks: 1 }));
    expect(r.pool.limit).toBe(9);
    b.proto.remoteClose('remote');
    expect(r.pool.limit).toBe(8);
    a.proto.remoteClose('remote');
    expect(r.pool.limit).toBe(4);
    const c = r.link('c3'.repeat(32));
    const d = r.link('d4'.repeat(32));
    c.proto.remoteHello(helloFrom(pubkey('c'), { windowBlocks: 1000 }));
    d.proto.remoteHello(helloFrom(pubkey('d'), { windowBlocks: 1000 }));
    expect(r.pool.limit).toBe(MAX_POOL_CREDIT);
  });

  it('every budget change re-runs hypercore’s scheduler on the routed cores', async () => {
    const r = rig();
    const before = r.core.replicator.refreshes;
    const a = r.link(A);
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 2 }));
    await flush();
    expect(r.core.replicator.refreshes).toBeGreaterThan(before);
  });

  it('the payer’s batch: half its credit, at once when what it delivered fills it', () => {
    const r = rig();
    const a = r.link(A);
    expect(r.credit.seederBatch(A)).toBeNull();
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 6 }));
    expect(r.credit.seederBatch(A)).toEqual({ batch: 3, atCap: false });
    for (let i = 0; i < 5; i++) r.download(i, A);
    expect(r.credit.seederBatch(A)).toEqual({ batch: 3, atCap: false });
    r.download(5, A);
    expect(r.credit.seederBatch(A)).toEqual({ batch: 3, atCap: true });
    const tiny = rig();
    const t = tiny.link(B);
    t.proto.remoteHello(helloFrom(pubkey('b'), { windowBlocks: 1 }));
    expect(tiny.credit.seederBatch(B)).toEqual({ batch: 1, atCap: false });
  });

  it('dispose stops routing and listening', () => {
    const r = rig();
    r.credit.dispose();
    expect(r.credit.router.stats().cores).toBe(0);
    r.link(A).proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 50 }));
    expect(r.pool.limit).toBe(4);
  });

  it('one pool, one SeederCredit: a second would resize it against the first', () => {
    const r = rig();
    const again = () =>
      new SeederCredit({
        settler: r.settler,
        pool: r.pool,
        policyFor: () => tight,
        logger: silentLogger,
      });
    expect(again).toThrow(/already has a SeederCredit/);
    r.credit.dispose();
    expect(again).not.toThrow();
  });

  it('whether a core is paid for is the settler’s rule, so budget and settlement cannot disagree', () => {
    const r = rig();
    const a = r.link(A);
    a.proto.remoteHello(helloFrom(pubkey('a'), { windowBlocks: 3 }));
    // A policy for OTHER exists here, but the settler does not own OTHER's blocks: a bounded
    // burst, never the window (the blocks would not come off it as they land).
    r.policies.set(OTHER, tight);
    expect(r.settler.isPayable(OTHER)).toBe(false);
    expect(r.credit.budget(A, OTHER)).toBe(NO_PAY_INFLIGHT);
    expect(r.settler.isPayable(CORE)).toBe(true);
    expect(r.credit.budget(A, CORE)).toBe(3);
  });
});

describe('CreditSettler — what settled without a payment (issue #8)', () => {
  it('reports rejected PAYs and blocks owed to a peer that went away; linked / owedBy per peer', () => {
    const r = rig();
    const seen: [string, number][] = [];
    r.settler.onChange((n, unpaid) => seen.push([n, unpaid]));
    const a = r.link(A);
    expect(r.settler.linked(A)).toBe(true);
    expect(r.settler.linked(B)).toBe(false);
    r.download(0, A);
    r.download(1, A);
    r.download(2, A);
    r.paid(a, 0, 0);
    r.paid(a, 1, 1, false);
    expect(r.settler.owedBy(A)).toBe(1);
    a.proto.remoteClose('remote');
    expect(seen).toEqual([
      [A, 0],
      [A, 1],
      [A, 1],
    ]);
    expect(r.settler.owedBy(A)).toBe(0);
    expect(r.settler.linked(A)).toBe(false);
  });
});

describe('CreditPool.setLimit (issue #8)', () => {
  it('growing serves queued acquirers and wakes lookahead; shrinking never revokes a unit', async () => {
    const pool = new CreditPool(1);
    let woken = 0;
    pool.onAvailable(() => woken++);
    expect(pool.tryAcquire('k', 0)).toBe(true);
    const w = pool.acquire('k', 1);
    pool.setLimit(2);
    await w.promise;
    expect(pool.holds('k', 1)).toBe(true);
    expect(woken).toBe(1);
    pool.setLimit(1);
    expect(pool.size).toBe(2); // held units stay
    expect(pool.tryAcquire('k', 2)).toBe(false);
    pool.settle('k', 0);
    expect(pool.tryAcquire('k', 2)).toBe(false); // still at the new limit
    pool.settle('k', 1);
    expect(pool.tryAcquire('k', 2)).toBe(true);
    pool.setLimit(1); // unchanged: no wake
    expect(woken).toBe(3);
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => {
        pool.setLimit(bad);
      }).toThrow(RangeError);
  });
});

describe('UpstreamPayer — the per-seeder batch (issue #8)', () => {
  function payerRig(
    batch: () => SeederBatch | null,
    payEveryBlocks = 1,
    o: { tailMs?: number; autoAck?: boolean } = {},
  ) {
    const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
    const payer = new UpstreamPayer({
      engine,
      logger: silentLogger,
      payEveryBlocks,
      credit: new CreditPool(100),
      seederBatch: () => batch(),
      tailMs: o.tailMs ?? 0,
      ownMints: [MINT_A],
      policyFor: () => basePolicy(2),
    });
    const proto = new FakePayProtocol({ autoAck: o.autoAck ?? false });
    payer.attachPeer(A, proto);
    proto.remoteHello(helloFrom(pubkey('a'), { acceptedMints: [MINT_A], satsPerBlock: 2 as Sats }));
    return { payer, proto };
  }

  it('pays a seeder’s blocks in batches of half ITS window, not half the pool', async () => {
    const r = payerRig(() => ({ batch: 3, atCap: false }));
    r.payer.onDownload(CORE, 0, A);
    r.payer.onDownload(CORE, 1, A);
    await flush();
    expect(r.proto.sentPays).toHaveLength(0); // the pool of 100 alone would wait for 50
    r.payer.onDownload(CORE, 2, A);
    await flush();
    expect(r.proto.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[0, 2]]);
  });

  it('a seeder at its cap is paid at once, even below payEveryBlocks', async () => {
    let atCap = false;
    const r = payerRig(() => ({ batch: 2, atCap }), 3);
    r.payer.onDownload(CORE, 0, A);
    await flush();
    expect(r.proto.sentPays).toHaveLength(0);
    atCap = true;
    r.payer.onDownload(CORE, 5, A); // 2 pending: below payEveryBlocks (3) and the batch (2 runs of 1)
    await flush();
    expect(r.proto.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[0, 0]]);
  });

  it('a quiet seeder’s SCATTERED short runs are all paid after the tail, one per ACK — not just the first', async () => {
    // hypercore spreads a video over its seeders, so one seeder's blocks are rarely contiguous.
    const r = payerRig(() => ({ batch: 4, atCap: false }), 1, { tailMs: 40, autoAck: true });
    for (const i of [0, 2, 4]) r.payer.onDownload(CORE, i, A);
    await flush();
    expect(r.proto.sentPays).toHaveLength(0);
    await new Promise((res) => setTimeout(res, 200));
    expect(r.proto.sentPays.map((p) => p.range.fromBlock).sort()).toEqual([0, 2, 4]);
    // A new block after the tail: batching resumes (it waits for its batch or the next tail).
    r.payer.onDownload(CORE, 9, A);
    await flush();
    expect(r.proto.sentPays).toHaveLength(3);
    await new Promise((res) => setTimeout(res, 150));
    expect(r.proto.sentPays).toHaveLength(4);
  });

  it('flush() pays scattered runs whose ACKs come back after it returned', async () => {
    const r = payerRig(() => ({ batch: 8, atCap: false }), 1, { autoAck: false });
    for (const i of [1, 3, 5]) r.payer.onDownload(CORE, i, A);
    await r.payer.flush();
    expect(r.proto.sentPays).toHaveLength(1); // one PAY per core in flight
    for (let k = 0; k < 3; k++) {
      const last = r.proto.sentPays.at(-1)!;
      r.proto.remoteAck({ type: 'ACK', ...last.range, ok: true });
      await flush();
    }
    expect(r.proto.sentPays.map((p) => p.range.fromBlock)).toEqual([1, 3, 5]);
  });

  it('a malformed seeder batch does not stop payments (one block per PAY)', async () => {
    const r = payerRig(() => ({ batch: Number.NaN, atCap: false }));
    r.payer.onDownload(CORE, 0, A);
    await flush();
    expect(r.proto.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[0, 0]]);
  });

  it('an unknown seeder window falls back to the pool rule', async () => {
    const r = payerRig(() => null);
    for (let i = 0; i < 49; i++) r.payer.onDownload(CORE, i, A);
    await flush();
    expect(r.proto.sentPays).toHaveLength(0);
    r.payer.onDownload(CORE, 49, A);
    await flush();
    expect(r.proto.sentPays).toHaveLength(1);
  });
});
