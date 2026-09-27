/**
 * Contracts v6 amendment (Cameron 2026-09-26; ADRs 0015 and 0018 amendments), the seeder side:
 *
 *   rule 1 — a core's PRICE (priced, or `{ free: true }`) before its first block to a pay/1 peer,
 *            again when it turns free or sold, never twice for the same terms;
 *   rules 2–3 — OWED once the channel opens, per core with unpaid blocks for the HELLO pubkey,
 *            oldest first within the caps, each after that core's priced PRICE; a PAY for owed
 *            blocks on the new connection is accepted at the core's terms and clears them;
 *   rule 4 — `outstanding` in every ACK.
 *
 * The seeder here runs the mock engine (the reference model); the same paths run against the real
 * engine and a real replication stream in `pay1.integration.test.ts`.
 */
import { MAX_OWED_BLOCKS, MAX_OWED_RANGES, mocks, payProtocol } from '@sovit/core';
import type { NostrPubkey, PricePolicy } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { Seeder } from '../seeder.js';
import { FakePayProtocol, hello } from './fake-pay-protocol.js';
import { FakeStream, adapters, capturedLogger, noiseKey, pubkey, tmpDir } from './helpers.js';

const BLOCK = 1024;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const CORE_A = mocks.asCoreKey('owed-A');
const CORE_B = mocks.asCoreKey('owed-B');
const CORE_C = mocks.asCoreKey('owed-C');

async function make(o: { windowBlocks?: number; withDefault?: boolean } = {}) {
  const t = await tmpDir();
  const engine = new mocks.MockPaymentEngine({
    mode: 'honest',
    config: { windowBlocks: o.windowBlocks ?? 16 },
  });
  const log = capturedLogger();
  const seeder = await Seeder.create(
    {
      dataDir: t.dir,
      diskCapBytes: 64 * BLOCK,
      blockSize: BLOCK,
      swarm: null,
      rateLimits: { maxStreams: 16, maxStreamsPerKey: 4, connectsPerWindow: 100, windowMs: 1000 },
      flushEveryBlocks: 1000,
      flushEveryMs: 60_000,
    },
    { engine, logger: log.logger, ...adapters },
  );
  cleanups.push(async () => {
    await seeder.close();
    await t.rm();
  });
  const policy = (sats: number, who = 'creator'): PricePolicy => ({
    satsPerBlock: sats as never,
    blockSize: BLOCK,
    mints: engine.config.acceptedMints,
    split: { seeder: 50, creator: 50 },
    creatorP2pk: mocks.asP2pk(who),
    minPaySats: 1 as never,
  });
  if (o.withDefault !== false) seeder.setPolicy(policy(2));
  const ref = {
    pubkey: engine.config.ownPubkey,
    p2pk: engine.config.ownP2pk,
    mint: engine.config.acceptedMints[0]!,
  };
  let nextNoise = 40;
  /** A new connection with pay/1 attached (no HELLO yet). */
  const connect = () => {
    const stream = new FakeStream(noiseKey(nextNoise++));
    const session = seeder.sessions.admit(stream)!;
    const protocol = new FakePayProtocol();
    seeder.attachPayProtocol(session, protocol);
    return { stream, session, protocol };
  };
  return { seeder, engine, log, policy, ref, connect, viewer: new mocks.MockPaymentEngine() };
}

describe('rule 1 — a core’s PRICE before its first block (always on)', () => {
  it('a free core gets PRICE { free: true } before its first block, once; turning sold, the next block is priced first; turning free again, free first', async () => {
    const s = await make();
    const { session, protocol } = s.connect();
    // The PRICE goes out BEFORE the engine counts the block (inside the upload gate).
    const seenAtPrice: number[] = [];
    const send = protocol.sendPrice.bind(protocol);
    protocol.sendPrice = (p): void => {
      seenAtPrice.push(s.engine.window(session.accountId())?.uploaded ?? 0);
      send(p);
    };
    expect(s.seeder.setFreeCore(CORE_A, true)).toBe(true);
    session.onUpload(CORE_A, 0, BLOCK);
    session.onUpload(CORE_A, 1, BLOCK);
    expect(protocol.prices).toEqual([
      { type: 'PRICE', core: CORE_A, satsPerBlock: 0, effectiveFromBlock: 0, free: true },
    ]);
    expect(s.engine.window(session.accountId())).toBeUndefined(); // nothing counted
    // Sold now (a per-core policy clears the free mark): priced, from block 0 (nothing counted).
    s.seeder.setCorePolicy(CORE_A, s.policy(3));
    session.onUpload(CORE_A, 2, BLOCK);
    session.onUpload(CORE_A, 3, BLOCK);
    expect(protocol.prices.slice(1)).toEqual([
      { type: 'PRICE', core: CORE_A, satsPerBlock: 3, effectiveFromBlock: 0 },
    ]);
    expect(seenAtPrice).toEqual([0, 0]);
    expect(s.engine.window(session.accountId())).toMatchObject({ uploaded: 2 });
    // A default-priced core turned free, then back: free first, then priced from one past the
    // highest block counted on this connection (F9: the earlier blocks keep their terms).
    session.onUpload(CORE_B, 0, BLOCK);
    expect(s.seeder.setFreeCore(CORE_B, true)).toBe(true);
    session.onUpload(CORE_B, 1, BLOCK);
    s.seeder.setFreeCore(CORE_B, false);
    session.onUpload(CORE_B, 2, BLOCK);
    expect(protocol.prices.filter((p) => p.core === CORE_B)).toEqual([
      { type: 'PRICE', core: CORE_B, satsPerBlock: 2, effectiveFromBlock: 0 },
      { type: 'PRICE', core: CORE_B, satsPerBlock: 0, effectiveFromBlock: 0, free: true },
      { type: 'PRICE', core: CORE_B, satsPerBlock: 2, effectiveFromBlock: 1 },
    ]);
    expect(seenAtPrice).toEqual([0, 0, 2, 3, 3]);
  });

  it('a price change reaches a peer that was told the price but sent no block (the OWED case); a free core gets no priced PRICE on a change; no pay/1 and no terms: nothing is sent, nothing throws', async () => {
    const s = await make({ withDefault: false });
    const { session, protocol } = s.connect();
    // No terms at all (no policy, no default, not free): nothing to announce.
    session.onUpload(CORE_C, 0, BLOCK);
    expect(protocol.prices).toEqual([]);
    // A session without pay/1 is served without a PRICE (there is no channel to say it on).
    const bare = s.seeder.sessions.admit(new FakeStream(noiseKey(90)))!;
    s.seeder.setFreeCore(CORE_B, true);
    expect(() => bare.onUpload(CORE_B, 0, BLOCK)).not.toThrow();
    // A free core: a default price change sends no priced PRICE for it.
    session.onUpload(CORE_B, 0, BLOCK);
    s.seeder.setPolicy(s.policy(2));
    s.seeder.setPolicy(s.policy(5));
    expect(protocol.prices.filter((p) => p.core === CORE_B)).toEqual([
      { type: 'PRICE', core: CORE_B, satsPerBlock: 0, effectiveFromBlock: 0, free: true },
    ]);
  });
});

describe('rules 2–3 — OWED when the channel opens, and paying it', () => {
  async function leaveUnpaid(s: Awaited<ReturnType<typeof make>>, who: NostrPubkey) {
    const first = s.connect();
    first.protocol.remoteHello(hello(who));
    s.seeder.setCorePolicy(CORE_A, s.policy(3, 'creator-A'));
    // Cores in first-counted order: A (own price 3), B (default 2), C (default, turned free).
    first.session.onUpload(CORE_A, 0, BLOCK);
    first.session.onUpload(CORE_A, 1, BLOCK);
    first.session.onUpload(CORE_B, 5, BLOCK);
    first.session.onUpload(CORE_B, 6, BLOCK);
    first.session.onUpload(CORE_C, 0, BLOCK);
    first.protocol.remotePay(
      await s.viewer.pay(
        { core: CORE_A, fromBlock: 0, toBlock: 0 },
        s.ref,
        s.policy(3, 'creator-A'),
        {
          carryIn: 0,
        },
      ),
    );
    await tick();
    expect(first.protocol.acks).toEqual([
      { type: 'ACK', core: CORE_A, fromBlock: 0, toBlock: 0, ok: true, outstanding: 1 },
    ]);
    first.stream.destroy();
    await first.stream.closed();
    s.seeder.setFreeCore(CORE_C, true);
    return first;
  }

  it('a reconnect under a new Noise key gets, per owed core in first-counted order, the priced PRICE then the OWED (a core free now: OWED only); paying the owed ranges at the core’s terms with carry 0 clears them', async () => {
    const s = await make();
    const who = pubkey('owed-viewer');
    await leaveUnpaid(s, who);
    const again = s.connect();
    expect(again.protocol.sent).toEqual([]); // nothing before the HELLOs
    again.protocol.remoteHello(hello(who));
    expect(again.protocol.sent).toEqual([
      { type: 'PRICE', core: CORE_A, satsPerBlock: 3, effectiveFromBlock: 0 },
      { type: 'OWED', core: CORE_A, ranges: [[1, 1]] },
      { type: 'PRICE', core: CORE_B, satsPerBlock: 2, effectiveFromBlock: 0 },
      { type: 'OWED', core: CORE_B, ranges: [[5, 6]] },
      { type: 'OWED', core: CORE_C, ranges: [[0, 0]] },
    ]);
    // The owed ranges, paid on this connection at the terms just announced, from carry 0.
    again.protocol.remotePay(
      await s.viewer.pay(
        { core: CORE_A, fromBlock: 1, toBlock: 1 },
        s.ref,
        s.policy(3, 'creator-A'),
        {
          carryIn: 0,
        },
      ),
    );
    await tick();
    again.protocol.remotePay(
      await s.viewer.pay({ core: CORE_B, fromBlock: 5, toBlock: 6 }, s.ref, s.policy(2), {
        carryIn: 0,
      }),
    );
    await tick();
    expect(again.protocol.acks).toEqual([
      { type: 'ACK', core: CORE_A, fromBlock: 1, toBlock: 1, ok: true, outstanding: 0 },
      { type: 'ACK', core: CORE_B, fromBlock: 5, toBlock: 6, ok: true, outstanding: 0 },
    ]);
    expect(s.engine.unpaid(who)).toEqual([{ core: CORE_C, ranges: [[0, 0]] }]);
    // Once per connection: a second `open` (a re-sent HELLO) reports nothing more, and the first
    // block of an announced core is not re-announced.
    const before = again.protocol.sent.length;
    again.protocol.remoteHello(hello(who));
    again.session.onUpload(CORE_A, 2, BLOCK);
    expect(again.protocol.sent.slice(before)).toEqual([]);
    // The next connection reports what is left: A's block 2 (sent above, unpaid) and C's block.
    const third = s.connect();
    third.protocol.remoteHello(hello(who));
    expect(third.protocol.sent).toEqual([
      { type: 'PRICE', core: CORE_A, satsPerBlock: 3, effectiveFromBlock: 0 },
      { type: 'OWED', core: CORE_A, ranges: [[2, 2]] },
      { type: 'OWED', core: CORE_C, ranges: [[0, 0]] },
    ]);
  });

  it('a price change after the OWED reaches that peer, and its owed ranges are verified at the new terms', async () => {
    const s = await make();
    const who = pubkey('owed-reprice');
    await leaveUnpaid(s, who);
    const again = s.connect();
    again.protocol.remoteHello(hello(who));
    s.seeder.setCorePolicy(CORE_A, s.policy(4, 'creator-A'));
    expect(again.protocol.prices.filter((p) => p.core === CORE_A)).toEqual([
      { type: 'PRICE', core: CORE_A, satsPerBlock: 3, effectiveFromBlock: 0 },
      { type: 'PRICE', core: CORE_A, satsPerBlock: 4, effectiveFromBlock: 0 },
    ]);
    again.protocol.remotePay(
      await s.viewer.pay(
        { core: CORE_A, fromBlock: 1, toBlock: 1 },
        s.ref,
        s.policy(3, 'creator-A'),
        {
          carryIn: 0,
        },
      ),
    );
    await tick();
    again.protocol.remotePay(
      await s.viewer.pay(
        { core: CORE_A, fromBlock: 1, toBlock: 1 },
        s.ref,
        s.policy(4, 'creator-A'),
        {
          carryIn: 0,
        },
      ),
    );
    await tick();
    expect(again.protocol.acks.map((a) => [a.ok, a.reason, a.outstanding])).toEqual([
      [false, 'wrong-amount', 1],
      [true, undefined, 0],
    ]);
  });

  it('nothing owed: no OWED and no PRICE; a banned pubkey is cut at HELLO and gets no report; blocks sent before this HELLO are part of it', async () => {
    const s = await make();
    const clean = s.connect();
    clean.protocol.remoteHello(hello(pubkey('never-downloaded')));
    expect(clean.protocol.sent).toEqual([]);
    // Banned (a window cut on an earlier connection): the HELLO is refused, nothing is reported.
    const who = pubkey('owed-banned');
    await leaveUnpaid(s, who);
    s.seeder.ban({ pubkey: who }, 'operator');
    const banned = s.connect();
    banned.protocol.remoteHello(hello(who));
    expect(banned.session.cutReason).toBe('banned');
    expect(banned.protocol.owed).toEqual([]);
    // Pre-HELLO blocks (counted under the provisional id) are merged at the bind and reported.
    const pre = s.connect();
    pre.session.onUpload(CORE_B, 9, BLOCK);
    const sentBefore = pre.protocol.sent.length;
    pre.protocol.remoteHello(hello(pubkey('pre-hello')));
    expect(pre.protocol.sent.slice(sentBefore)).toEqual([
      { type: 'OWED', core: CORE_B, ranges: [[9, 9]] },
    ]);
  });

  it('a core with no terms is reported with no PRICE (counted, not payable here now)', async () => {
    const s = await make({ withDefault: false });
    const who = pubkey('owed-no-terms');
    const first = s.connect();
    first.protocol.remoteHello(hello(who));
    first.session.onUpload(CORE_C, 3, BLOCK);
    expect(first.protocol.prices).toEqual([]);
    first.stream.destroy();
    await first.stream.closed();
    const again = s.connect();
    again.protocol.remoteHello(hello(who));
    expect(again.protocol.sent).toEqual([{ type: 'OWED', core: CORE_C, ranges: [[3, 3]] }]);
  });

  it('the report is bounded by the OWED caps, oldest first, and every OWED it sends fits the wire grammar', async () => {
    const s = await make({ windowBlocks: 100_000 });
    const who = pubkey('owed-many');
    const first = s.connect();
    first.protocol.remoteHello(hello(who));
    // 200 one-block ranges on A, 200 on B: 400 ranges, more than MAX_OWED_RANGES.
    for (let i = 0; i < 200; i++) first.session.onUpload(CORE_A, 2 * i, BLOCK);
    for (let i = 0; i < 200; i++) first.session.onUpload(CORE_B, 2 * i, BLOCK);
    // And one long run on C, past MAX_OWED_BLOCKS on its own.
    for (let i = 0; i < MAX_OWED_BLOCKS + 10; i++) first.session.onUpload(CORE_C, i, BLOCK);
    first.stream.destroy();
    await first.stream.closed();
    const again = s.connect();
    again.protocol.remoteHello(hello(who));
    const owed = again.protocol.owed;
    expect(owed.map((o) => o.core)).toEqual([CORE_A, CORE_B]);
    expect(owed[0]!.ranges).toHaveLength(200);
    expect(owed[1]!.ranges).toHaveLength(MAX_OWED_RANGES - 200);
    expect(owed[1]!.ranges[0]).toEqual([0, 0]);
    for (const o of owed) expect(() => payProtocol.payCodec.encode(o)).not.toThrow();
    // The block cap: a fresh viewer owing only C gets C cut at MAX_OWED_BLOCKS.
    const who2 = pubkey('owed-long');
    const one = s.connect();
    one.protocol.remoteHello(hello(who2));
    for (let i = 0; i < MAX_OWED_BLOCKS + 10; i++) one.session.onUpload(CORE_C, i, BLOCK);
    one.stream.destroy();
    await one.stream.closed();
    const two = s.connect();
    two.protocol.remoteHello(hello(who2));
    expect(two.protocol.owed).toEqual([
      { type: 'OWED', core: CORE_C, ranges: [[0, MAX_OWED_BLOCKS - 1]] },
    ]);
    expect(() => payProtocol.payCodec.encode(two.protocol.owed[0]!)).not.toThrow();
  });
});

describe('rule 4 — outstanding in every ACK', () => {
  it('accepted, refused, and with blocks sent after the PAY: the count when the ACK goes out', async () => {
    const s = await make();
    const { session, protocol } = s.connect();
    protocol.remoteHello(hello(pubkey('ack-viewer')));
    for (let i = 0; i < 4; i++) session.onUpload(CORE_B, i, BLOCK);
    // Wrong amount (price 3 for a core at 2): refused, nothing cleared.
    protocol.remotePay(
      await s.viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 1 }, s.ref, s.policy(3), {
        carryIn: 0,
      }),
    );
    await tick();
    const pay = s.viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 1 }, s.ref, s.policy(2), {
      carryIn: 0,
    });
    protocol.remotePay(await pay);
    session.onUpload(CORE_B, 4, BLOCK); // sent while the PAY verifies
    await tick();
    expect(protocol.acks.map((a) => [a.ok, a.reason, a.outstanding])).toEqual([
      [false, 'overpay', 4],
      [true, undefined, 3],
    ]);
  });
});

describe('the bridge’s v6 hooks, alone', () => {
  it('an outstanding that is not a safe count is left out; onOpen runs only after a bind, and a throwing onOpen is contained', async () => {
    const { attachPayBridge } = await import('../payment/pay-bridge.js');
    const { PeerSession } = await import('../net/peer-session.js');
    const { loadedBanList } = await import('./helpers.js');
    const t = await tmpDir();
    cleanups.push(t.rm);
    const engine = new mocks.MockPaymentEngine({ config: { windowBlocks: 8 } });
    const banList = await loadedBanList(t.dir);
    const log = capturedLogger();
    const policy: PricePolicy = {
      satsPerBlock: 1 as never,
      blockSize: BLOCK,
      mints: engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    const viewer = new mocks.MockPaymentEngine();
    const ref = {
      pubkey: engine.config.ownPubkey,
      p2pk: engine.config.ownP2pk,
      mint: engine.config.acceptedMints[0]!,
    };
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const session = new PeerSession({
        noiseKey: noiseKey(7),
        stream: new FakeStream(noiseKey(7)),
        engine,
        banList,
        logger: log.logger,
      });
      const protocol = new FakePayProtocol();
      let opened = 0;
      attachPayBridge({
        session,
        protocol,
        policy: () => policy,
        scheduler: { notePaidBlocks: () => undefined },
        logger: log.logger,
        outstanding: () => bad,
        onOpen: () => {
          opened++;
          throw new Error('hook failure');
        },
      });
      const who = pubkey(`bridge-${String(bad)}`);
      protocol.remoteHello(hello(who));
      expect(opened).toBe(1);
      session.onUpload(CORE_A, 0, BLOCK);
      protocol.remotePay(
        await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 0 }, ref, policy, { carryIn: 0 }),
      );
      await tick();
      expect(protocol.acks).toEqual([
        { type: 'ACK', core: CORE_A, fromBlock: 0, toBlock: 0, ok: true },
      ]);
      expect(session.cutReason).toBeNull();
    }
    expect(log.lines.join('\n')).toContain('open hook failed');
    // A refused bind (a banned pubkey) never reaches onOpen.
    const who = pubkey('bridge-banned');
    engine.ban(who, 'test');
    const session = new PeerSession({
      noiseKey: noiseKey(8),
      stream: new FakeStream(noiseKey(8)),
      engine,
      banList,
      logger: log.logger,
    });
    const protocol = new FakePayProtocol();
    let opened = 0;
    attachPayBridge({
      session,
      protocol,
      policy: () => policy,
      scheduler: { notePaidBlocks: () => undefined },
      logger: log.logger,
      onOpen: () => {
        opened++;
      },
    });
    protocol.remoteHello(hello(who));
    expect(session.cutReason).toBe('banned');
    expect(opened).toBe(0);
  });
});
