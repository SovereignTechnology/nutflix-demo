/**
 * The gateway as a viewer toward upstream seeders (build-plan §5 "pays upstream").
 *
 * Unit part: `UpstreamPayer` + `FakePayProtocol` + `MockPaymentEngine('honest')`.
 * Integration part: a `Gateway` replicates a blob from a real upstream `Seeder` over a
 * directly piped stream pair, pays per verified block, and the upstream seeder's own
 * engine VERIFIES and ACKs every `PAY` the gateway built — with `range.core` set on all
 * of them (contracts v3, ADR 0004).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mocks } from '@sovit/core';
import type { CoreKeyHex, PayMessage, PricePolicy, Sats } from '@sovit/core';
import { Seeder, nodeCrypto, nodeFs, toHex } from '@sovit/seeder';

import {
  MAX_CLOCK_STEP_MS,
  MAX_FREE_CORES_PER_SEEDER,
  MAX_PAY_FAILURES,
  MAX_PRICED_CORES_PER_SEEDER,
  PAY_GIVE_UP_MS,
  PAY_RETRY_BASE_MS,
  PAY_RETRY_LATER_MAX_MS,
  PAY_RETRY_LATER_MS,
  PAY_RETRY_MAX_MS,
  UpstreamPayer,
  manifestPolicyResolver,
  monotonicClock,
  payFailureClass,
} from '../upstream/payer.js';
import type { UpstreamPayerOptions } from '../upstream/payer.js';
import { FakePayProtocol, helloFrom } from './fake-pay-protocol.js';
import {
  BLOCK,
  CREATOR_P2PK,
  GW_PUBKEY,
  MINT_A,
  MINT_B,
  basePolicy,
  capturedLogger,
  cleanupRigs,
  fixtureBytes,
  pubkey,
  rig,
  settle,
  tmpDir,
  until,
} from './helpers.js';

afterEach(cleanupRigs);

const CORE_A = 'aa'.repeat(32) as CoreKeyHex;
const CORE_B = 'bb'.repeat(32) as CoreKeyHex;
const UP_PUBKEY = pubkey('upstream');
const UP_P2PK = ('02' + '11'.repeat(32)) as PricePolicy['creatorP2pk'];
const NOISE = 'ee'.repeat(32);

/** The manifest price of CORE_A / CORE_B in the unit rig (the seeder's HELLO asks 3). */
const MANIFEST_PRICE = 5;

function unit(
  payEveryBlocks = 2,
  opts: { policy?: PricePolicy | null; autoAck?: boolean; tailMs?: number } = {},
) {
  const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
  const log = capturedLogger();
  const perCore = new Map<CoreKeyHex, PricePolicy>([
    [CORE_A, basePolicy(MANIFEST_PRICE)],
    [CORE_B, basePolicy(MANIFEST_PRICE)],
  ]);
  const payer = new UpstreamPayer({
    engine,
    logger: log.logger,
    payEveryBlocks,
    ...(opts.tailMs === undefined ? {} : { tailMs: opts.tailMs }),
    ownMints: [MINT_A, MINT_B],
    policyFor:
      opts.policy === null
        ? () => null
        : opts.policy
          ? () => opts.policy!
          : manifestPolicyResolver(() => perCore),
  });
  const protocol = new FakePayProtocol({ autoAck: opts.autoAck ?? true });
  const detach = payer.attachPeer(NOISE, protocol);
  return { engine, payer, protocol, detach, log, perCore };
}

const hello = () =>
  helloFrom(UP_PUBKEY, { acceptedMints: [MINT_B, MINT_A], satsPerBlock: 3 as Sats, p2pk: UP_P2PK });

describe('UpstreamPayer — the short tail (F5 batching)', () => {
  it('a run shorter than a batch is paid once the peer has been quiet for tailMs', async () => {
    vi.useFakeTimers();
    try {
      const { payer, protocol } = unit(4, { tailMs: 2000 });
      protocol.remoteHello(hello());
      payer.onDownload(CORE_A, 0, NOISE);
      payer.onDownload(CORE_A, 1, NOISE);
      await vi.advanceTimersByTimeAsync(1500);
      payer.onDownload(CORE_A, 2, NOISE); // resets the quiet period
      await vi.advanceTimersByTimeAsync(1500);
      expect(protocol.sentPays).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(600);
      expect(protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[0, 2]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tailMs 0 leaves a short tail for flush()', async () => {
    vi.useFakeTimers();
    try {
      const { payer, protocol } = unit(4, { tailMs: 0 });
      protocol.remoteHello(hello());
      payer.onDownload(CORE_A, 0, NOISE);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(protocol.sentPays).toHaveLength(0);
      await payer.flush();
      expect(protocol.sentPays).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('UpstreamPayer (unit)', () => {
  it('pays every N contiguous verified blocks with range.core set, at the seeder’s price (≤ the manifest’s), to the HELLO pubkey/p2pk/common mint', async () => {
    const { engine, payer, protocol } = unit(2);
    protocol.remoteHello(hello());
    for (let i = 0; i < 5; i++) payer.onDownload(CORE_A, i, NOISE);
    await payer.flush();
    // Downloads that land in one tick are batched into ONE PAY for the whole contiguous run
    // (the pay is scheduled on a microtask, so `payEveryBlocks` is a lower bound per PAY,
    // not a chunk size). Coverage is what matters: 0..4 exactly once, every PAY ≥ 1 block.
    const covered = protocol.sentPays.flatMap((p) =>
      Array.from(
        { length: p.range.toBlock - p.range.fromBlock + 1 },
        (_, k) => p.range.fromBlock + k,
      ),
    );
    expect(covered.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(protocol.sentPays.length).toBeGreaterThanOrEqual(1);
    expect(protocol.sentPays.length).toBeLessThanOrEqual(3);
    for (const p of protocol.sentPays) {
      expect(p.range.core).toBe(CORE_A);
      expect(p.seederProofs.lockedTo).toBe(UP_P2PK);
      expect(p.creatorProofs.lockedTo).toBe(CREATOR_P2PK);
      expect(p.seederProofs.mint).toBe(MINT_B); // the seeder's FIRST listed mint we can pay with
    }
    // 5 blocks × 3 sats = 15 sats spent on that seeder (invariant 2: never more).
    expect(engine.spent().perPeer.get(UP_PUBKEY)).toBe(15);
    expect(payer.stats()).toMatchObject({
      pays: protocol.sentPays.length,
      blocksPaid: 5,
      skippedNoPolicy: 0,
    });

    // Blocks arriving one tick apart ARE paid every `payEveryBlocks`.
    const paced = unit(2);
    paced.protocol.remoteHello(hello());
    for (let i = 0; i < 4; i++) {
      paced.payer.onDownload(CORE_B, i, NOISE);
      await settle(5);
    }
    expect(paced.protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('never pays a block twice, splits non-contiguous runs, and keeps cores apart', async () => {
    const { payer, protocol } = unit(1);
    protocol.remoteHello(hello());
    for (const i of [0, 1, 3, 0, 1]) payer.onDownload(CORE_A, i, NOISE);
    payer.onDownload(CORE_B, 0, NOISE);
    await payer.flush();
    const ranges = protocol.sentPays.map(
      (p) => `${p.range.core.slice(0, 2)}:${p.range.fromBlock}-${p.range.toBlock}`,
    );
    expect(ranges.sort()).toEqual(['aa:0-1', 'aa:3-3', 'bb:0-0']);
    payer.onDownload(CORE_A, 1, NOISE);
    await payer.flush();
    expect(protocol.sentPays).toHaveLength(3);
    // Every PAY carries a well-formed core (required since v5).
    expect(protocol.sentPays.every((p) => /^[0-9a-f]{64}$/.test(p.range.core))).toBe(true);
  });

  it('blocks from a peer that has not sent HELLO are counted and paid the moment it does', async () => {
    const { payer, protocol } = unit(2);
    for (let i = 0; i < 4; i++) payer.onDownload(CORE_A, i, NOISE);
    await payer.flush();
    expect(protocol.sentPays).toHaveLength(0);
    protocol.remoteHello(hello());
    await payer.flush();
    expect(protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[0, 3]]);
  });

  it('PRICE splits a run at effectiveFromBlock: old price below, new price from it — for the core it names only (v5)', async () => {
    const { engine, payer, protocol } = unit(10);
    protocol.remoteHello(hello());
    for (let i = 0; i < 6; i++) payer.onDownload(CORE_A, i, NOISE);
    for (let i = 0; i < 6; i++) payer.onDownload(CORE_B, i, NOISE);
    protocol.remotePrice({
      type: 'PRICE',
      core: CORE_A,
      satsPerBlock: 5 as Sats,
      effectiveFromBlock: 4,
    });
    await payer.flush();
    const a = protocol.sentPays.filter((p) => p.range.core === CORE_A);
    const b = protocol.sentPays.filter((p) => p.range.core === CORE_B);
    expect(a.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([
      [0, 3],
      [4, 5],
    ]);
    expect(b.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[0, 5]]);
    // A at 3 sat below the boundary and 5 from it; B untouched at 3.
    expect(engine.spent().perPeer.get(UP_PUBKEY)).toBe(4 * 3 + 2 * 5 + 6 * 3);
  });

  it('no policy / no common mint → nothing is paid and it is counted; ACKs are tallied; detach stops paying', async () => {
    const noPolicy = unit(1, { policy: null });
    noPolicy.protocol.remoteHello(hello());
    noPolicy.payer.onDownload(CORE_A, 0, NOISE);
    await noPolicy.payer.flush();
    expect(noPolicy.protocol.sentPays).toHaveLength(0);
    // The block stays pending (payable once a policy appears), so every pay attempt —
    // HELLO, the download, the flush — counts one skip.
    expect(noPolicy.payer.stats().skippedNoPolicy).toBeGreaterThanOrEqual(1);
    expect(noPolicy.payer.stats().blocksPaid).toBe(0);

    const noMint = unit(1);
    noMint.protocol.remoteHello(
      helloFrom(UP_PUBKEY, { acceptedMints: ['https://mint.other.example' as never] }),
    );
    noMint.payer.onDownload(CORE_A, 0, NOISE);
    await noMint.payer.flush();
    expect(noMint.protocol.sentPays).toHaveLength(0);
    expect(noMint.log.records.some((r) => r.msg.includes('no common mint'))).toBe(true);

    const u = unit(1, { autoAck: false });
    u.protocol.remoteHello(hello());
    u.payer.onDownload(CORE_A, 0, NOISE);
    await u.payer.flush();
    u.protocol.remoteAck({ type: 'ACK', core: CORE_A, fromBlock: 0, toBlock: 0, ok: true });
    u.protocol.remoteAck({
      type: 'ACK',
      core: CORE_A,
      fromBlock: 0,
      toBlock: 0,
      ok: false,
      reason: 'wrong-amount',
    });
    expect(u.payer.stats()).toMatchObject({ acksOk: 1, acksRejected: 1 });
    u.detach();
    u.payer.onDownload(CORE_A, 1, NOISE);
    await u.payer.flush();
    expect(u.protocol.sentPays).toHaveLength(1);
  });

  // ---- security review (docs/security-review.md) -------------------------------------

  it('F1: a seeder that asks more than the manifest price — in its HELLO or in a later PRICE — is not paid above it', async () => {
    // HELLO above the manifest: nothing is paid at all.
    const greedy = unit(1);
    greedy.protocol.remoteHello(
      helloFrom(UP_PUBKEY, { acceptedMints: [MINT_A], satsPerBlock: 50 as Sats, p2pk: UP_P2PK }),
    );
    for (let i = 0; i < 3; i++) greedy.payer.onDownload(CORE_A, i, NOISE);
    await greedy.payer.flush();
    expect(greedy.protocol.sentPays).toHaveLength(0);
    expect(greedy.payer.stats().skippedOverpriced).toBeGreaterThanOrEqual(1);
    expect(greedy.engine.spent().total).toBe(0);

    // An honest HELLO, then a PRICE above the manifest from block 4: blocks 0..3 are paid at the
    // HELLO price, blocks from 4 on are not paid at all — never at the raised price.
    const { engine, payer, protocol } = unit(10);
    protocol.remoteHello(hello());
    protocol.remotePrice({
      type: 'PRICE',
      core: CORE_A,
      satsPerBlock: 1_000_000 as Sats,
      effectiveFromBlock: 4,
    });
    for (let i = 0; i < 8; i++) payer.onDownload(CORE_A, i, NOISE);
    await payer.flush();
    expect(protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[0, 3]]);
    expect(engine.spent().total).toBe(4 * 3);
    expect(payer.stats().skippedOverpriced).toBeGreaterThanOrEqual(1);

    // A PRICE that LOWERS it is honoured.
    const cheaper = unit(10);
    cheaper.protocol.remoteHello(hello());
    cheaper.protocol.remotePrice({
      type: 'PRICE',
      core: CORE_A,
      satsPerBlock: 1 as Sats,
      effectiveFromBlock: 0,
    });
    for (let i = 0; i < 4; i++) cheaper.payer.onDownload(CORE_A, i, NOISE);
    await cheaper.payer.flush();
    expect(cheaper.engine.spent().total).toBe(4);
  });

  it('F2: the seeder’s HELLO split and mint list are not trusted — the split is the manifest’s, the mint one the manifest accepts', async () => {
    const { payer, protocol, perCore } = unit(1);
    perCore.set(CORE_A, { ...basePolicy(MANIFEST_PRICE), mints: [MINT_A] });
    // The seeder claims 100/0 (the whole creator share) and lists MINT_B first.
    protocol.remoteHello(
      helloFrom(UP_PUBKEY, {
        acceptedMints: [MINT_B, MINT_A],
        satsPerBlock: 4 as Sats,
        split: { seeder: 100, creator: 0 },
        p2pk: UP_P2PK,
      }),
    );
    for (let i = 0; i < 2; i++) payer.onDownload(CORE_A, i, NOISE);
    await payer.flush();
    expect(protocol.sentPays).toHaveLength(1);
    const pay = protocol.sentPays[0]!;
    const total = (xs: readonly { amount: number }[]): number =>
      xs.reduce((a, p) => a + p.amount, 0);
    // 2 blocks × 4 sat at the manifest's 50/50: 4 to the seeder, 4 to the creator.
    expect(total(pay.seederProofs.proofs)).toBe(4);
    expect(total(pay.creatorProofs.proofs)).toBe(4);
    expect(pay.creatorProofs.lockedTo).toBe(CREATOR_P2PK);
    expect(pay.seederProofs.mint).toBe(MINT_A); // the manifest does not accept MINT_B
  });

  it('F30: the carry is per channel and moves only on ACK ok; one PAY per core waits for its ACK, and blocks that land meanwhile batch into the next', async () => {
    const policy70 = {
      ...basePolicy(MANIFEST_PRICE),
      satsPerBlock: 3 as Sats,
      split: { seeder: 70, creator: 30 },
    };
    const { payer, protocol, perCore, engine } = unit(1, { autoAck: false });
    perCore.set(CORE_A, policy70);
    protocol.remoteHello(hello());
    payer.onDownload(CORE_A, 0, NOISE);
    await settle(5);
    payer.onDownload(CORE_A, 1, NOISE);
    payer.onDownload(CORE_A, 2, NOISE);
    await settle(5);
    // Only the first PAY is out: the next waits for its ACK.
    expect(protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock, p.carryIn])).toEqual([
      [0, 0, 0],
    ]);
    // 1 block × 3 sat at 30 % → 90 units → carry 90 after an accepted PAY.
    protocol.remoteAck({ type: 'ACK', core: CORE_A, fromBlock: 0, toBlock: 0, ok: true });
    await settle(5);
    expect(protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock, p.carryIn])).toEqual([
      [0, 0, 0],
      [1, 2, 90], // batched: both blocks that landed while waiting
    ]);
    // Rejected: the seeder did not move its carry, so neither do we.
    protocol.remoteAck({
      type: 'ACK',
      core: CORE_A,
      fromBlock: 1,
      toBlock: 2,
      ok: false,
      reason: 'wrong-amount',
    });
    payer.onDownload(CORE_A, 3, NOISE);
    await settle(5);
    expect(protocol.sentPays[2]).toMatchObject({
      carryIn: 90,
      range: { fromBlock: 3, toBlock: 3 },
    });
    // A new channel to the same seeder starts from 0, like the seeder's rebind.
    const second = new FakePayProtocol({ autoAck: false });
    payer.attachPeer('dd'.repeat(32), second);
    second.remoteHello(hello());
    payer.onDownload(CORE_A, 9, 'dd'.repeat(32));
    await settle(5);
    expect(second.sentPays.map((p) => p.carryIn)).toEqual([0]);
    expect(engine.spent().total).toBeGreaterThan(0);
  });

  it('logs never carry proofs (redaction layer in front of the payer)', async () => {
    const { payer, protocol, log } = unit(1);
    protocol.remoteHello(hello());
    payer.onDownload(CORE_A, 0, NOISE);
    await payer.flush();
    const secrets = protocol.sentPays.flatMap((p) =>
      [...p.seederProofs.proofs, ...p.creatorProofs.proofs].map((x) => x.secret),
    );
    expect(secrets.length).toBeGreaterThan(0);
    const text = log.lines.join('\n');
    for (const s of secrets) expect(text).not.toContain(s);
  });
});

describe('UpstreamPayer (integration): gateway pulls from a real upstream seeder and pays it', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c();
  });

  async function upstream(windowBlocks = 100) {
    const t = await tmpDir('nutflix-l3-upstream-');
    const engine = new mocks.MockPaymentEngine({
      mode: 'honest',
      config: {
        windowBlocks,
        acceptedMints: [MINT_A, MINT_B],
        ownP2pk: UP_P2PK,
        ownPubkey: UP_PUBKEY,
      },
    });
    const log = capturedLogger();
    const seeder = await Seeder.create(
      {
        dataDir: t.dir,
        diskCapBytes: 1024 * 1024,
        blockSize: BLOCK,
        swarm: null,
        policy: basePolicy(3),
        flushEveryBlocks: 1000,
        flushEveryMs: 60_000,
      },
      { engine, logger: log.logger, fs: nodeFs, crypto: nodeCrypto },
    );
    seeder.start();
    closers.push(async () => {
      await seeder.close();
      await t.rm();
    });
    return { seeder, engine, log };
  }

  it('every PAY names the core, covers every downloaded block once, and verifies OK at the upstream seeder', async () => {
    const BLOCKS = 9;
    const up = await upstream();
    const data = fixtureBytes(BLOCKS, 21);
    const put = await up.seeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error(put.error.code);
    const coreKey = put.entry.coreKey;

    const r = await rig({ windowBlocks: 100, raw: { upstream: { payEveryBlocks: 2 } } });
    // Directly piped replication streams (no swarm): gateway = initiator toward upstream.
    const gwStream = r.gateway.seeder.replicate(true);
    const upStream = up.seeder.replicate(false);
    gwStream.on('error', () => undefined);
    upStream.on('error', () => undefined);
    gwStream.pipe(upStream).pipe(gwStream);

    // The upstream side's pay/1 is the fake too (Stage 2 owns the real wire); we bridge
    // the two fakes by hand: gateway.sendPay → upstream.remotePay, upstream.sendAck → gateway.remoteAck.
    const upProto = new FakePayProtocol();
    await until(() => r.protocols.length === 1);
    const gwProto = r.protocols[0]!;
    const upSession = await (async () => {
      await until(() => up.seeder.sessionInfos().length === 1);
      return up.seeder.session(up.seeder.sessionInfos()[0]!.noiseKeyHex)!;
    })();
    up.seeder.attachPayProtocol(upSession, upProto);
    const forwarded: PayMessage[] = [];
    const origSendPay = gwProto.sendPay.bind(gwProto);
    gwProto.sendPay = (msg) => {
      origSendPay(msg);
      forwarded.push(msg);
      upProto.remotePay(msg);
    };
    const origSendAck = upProto.sendAck.bind(upProto);
    upProto.sendAck = (ack) => {
      origSendAck(ack);
      gwProto.remoteAck({ type: 'ACK', ...ack });
    };
    // Upstream's HELLO reaches the gateway (price 3, its mints, its P2PK).
    gwProto.remoteHello(
      helloFrom(UP_PUBKEY, {
        acceptedMints: [MINT_A, MINT_B],
        satsPerBlock: 3 as Sats,
        p2pk: UP_P2PK,
      }),
    );

    // The gateway pays only under the core's manifest policy (security review F2).
    r.gateway.setUpstreamPolicy(coreKey, basePolicy(3));
    const sc = await r.gateway.openUpstreamCore(coreKey);
    const got = await sc.blobs.get(put.entry.blob, { wait: true, timeout: 8000 });
    expect(got).not.toBeNull();
    expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true);
    await r.gateway.payer.flush();
    await until(
      () => upProto.acks.length === gwProto.sentPays.length && gwProto.sentPays.length > 0,
    );
    await settle(100);

    // Every PAY carries the core and, together, they cover 0..BLOCKS-1 exactly once
    // (how many PAYs depends on how the `download` events batched — see the unit test).
    expect(gwProto.sentPays.length).toBeGreaterThanOrEqual(1);
    const covered: number[] = [];
    for (const p of gwProto.sentPays) {
      expect(p.range.core).toBe(coreKey);
      for (let i = p.range.fromBlock; i <= p.range.toBlock; i++) covered.push(i);
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([...Array(BLOCKS).keys()]);
    // The upstream seeder verified each one offline and ACKed ok (invariant 4).
    expect(upProto.acks.every((a) => a.ok)).toBe(true);
    expect(upProto.acks).toHaveLength(gwProto.sentPays.length);
    expect(r.gateway.payer.stats()).toMatchObject({
      acksOk: upProto.acks.length,
      acksRejected: 0,
      blocksPaid: BLOCKS,
    });
    // Upstream window for the gateway's provisional identity is fully paid.
    const gwNoise = toHex(gwStream.noiseStream.publicKey!);
    expect(up.engine.window(gwNoise as never)).toMatchObject({
      uploaded: BLOCKS,
      paid: BLOCKS,
      outstanding: 0,
    });
    // The gateway spent exactly blocks × upstream price (invariant 2), locked to the upstream P2PK.
    expect(r.engine.spent().perPeer.get(UP_PUBKEY)).toBe(BLOCKS * 3);
    expect(forwarded.every((m) => m.seederProofs.lockedTo === UP_P2PK)).toBe(true);
    // And the blob is now served by the gateway as its own (Blossom index is the seeder's).
    expect(r.gateway.seeder.blobs.coreByKey(coreKey)).toBeDefined();
  });

  // Lane P2-owed-viewer (ADR 0018 amendment): the gateway has no durable record and no host to
  // authorise an old tail, so it pays none — but it must stay under what the upstream seeder says
  // it still counts for it, or a restarted gateway is banned for its previous run's tail.
  it('the gateway stays under what the upstream reports it still counts (OWED, ACK.outstanding), pays none of that old tail, and is never banned', async () => {
    const BLOCKS = 9;
    const WIN = 6;
    const up = await upstream(WIN);
    const data = fixtureBytes(BLOCKS, 23);
    const put = await up.seeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error(put.error.code);
    const coreKey = put.entry.coreKey;
    // What an earlier run of the gateway left unpaid there: two blocks (past this blob).
    up.engine.recordUpload(GW_PUBKEY, { core: coreKey, fromBlock: 50, toBlock: 51 }, basePolicy(3));
    expect(up.engine.window(GW_PUBKEY)).toMatchObject({ outstanding: 2 });

    const r = await rig({ windowBlocks: 100, raw: { upstream: { payEveryBlocks: 2 } } });
    const gwStream = r.gateway.seeder.replicate(true);
    const upStream = up.seeder.replicate(false);
    gwStream.on('error', () => undefined);
    upStream.on('error', () => undefined);
    gwStream.pipe(upStream).pipe(gwStream);
    const upProto = new FakePayProtocol();
    await until(() => r.protocols.length === 1);
    const gwProto = r.protocols[0]!;
    const upSession = await (async () => {
      await until(() => up.seeder.sessionInfos().length === 1);
      return up.seeder.session(up.seeder.sessionInfos()[0]!.noiseKeyHex)!;
    })();
    up.seeder.attachPayProtocol(upSession, upProto);
    // Bridge the two fakes: PAY up; ACK, PRICE and OWED down.
    const origSendPay = gwProto.sendPay.bind(gwProto);
    gwProto.sendPay = (msg) => {
      origSendPay(msg);
      upProto.remotePay(msg);
    };
    upProto.sendAck = (ack) => {
      gwProto.remoteAck({ type: 'ACK', ...ack });
    };
    upProto.sendPrice = (price) => {
      gwProto.remotePrice({ type: 'PRICE', ...price });
    };
    upProto.sendOwed = (owed) => {
      gwProto.remoteOwed({ type: 'OWED', ...owed });
    };
    r.gateway.setUpstreamPolicy(coreKey, basePolicy(3));
    const sc = await r.gateway.openUpstreamCore(coreKey);
    // Both HELLOs: the upstream binds the gateway's pubkey and reports what it still counts.
    gwProto.remoteHello(
      helloFrom(UP_PUBKEY, {
        acceptedMints: [MINT_A, MINT_B],
        satsPerBlock: 3 as Sats,
        p2pk: UP_P2PK,
        windowBlocks: WIN,
      }),
    );
    upProto.remoteHello(helloFrom(GW_PUBKEY, { acceptedMints: [MINT_A], windowBlocks: 0 }));
    let worst = 0;
    const sample = setInterval(() => {
      worst = Math.max(worst, up.engine.window(GW_PUBKEY)?.outstanding ?? 0);
    }, 1);
    try {
      const got = await sc.blobs.get(put.entry.blob, { wait: true, timeout: 15_000 });
      expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true);
      await r.gateway.payer.flush();
      await until(() => up.engine.window(GW_PUBKEY)?.outstanding === 2, 10_000);
    } finally {
      clearInterval(sample);
    }
    const upNoise = toHex(upStream.noiseStream.publicKey!);
    expect(r.gateway.seeders.reportOf(upNoise)).toMatchObject({ done: true, truncated: false });
    // It paid this blob, and none of the old tail (no record, no host: it cannot know it got them).
    const covered = gwProto.sentPays.flatMap((p) =>
      Array.from(
        { length: p.range.toBlock - p.range.fromBlock + 1 },
        (_, i) => p.range.fromBlock + i,
      ),
    );
    expect([...covered].sort((a, b) => a - b)).toEqual([...Array(BLOCKS).keys()]);
    expect(r.gateway.payer.stats()).toMatchObject({ owedAccepted: 0, owedPaid: 0 });
    // Never beyond window minus the reported count: never banned, never past the window.
    expect(worst).toBeLessThanOrEqual(WIN);
    expect(up.engine.window(GW_PUBKEY)).toMatchObject({ outstanding: 2, banned: false });
    expect(up.engine.bans()).toEqual([]);
  });

  it('pays each core under its MANIFEST policy (creator P2PK from the manifest); a core without one is not paid (F2)', async () => {
    const { payer, protocol, perCore } = unit(1);
    const creator = ('03' + '77'.repeat(32)) as PricePolicy['creatorP2pk'];
    perCore.set(CORE_A, { ...basePolicy(MANIFEST_PRICE), creatorP2pk: creator });
    perCore.delete(CORE_B);
    protocol.remoteHello(hello());
    payer.onDownload(CORE_A, 0, NOISE);
    payer.onDownload(CORE_B, 0, NOISE);
    await payer.flush();
    const byCore = new Map(protocol.sentPays.map((p) => [p.range.core, p.creatorProofs.lockedTo]));
    expect(byCore.get(CORE_A)).toBe(creator);
    expect(byCore.has(CORE_B)).toBe(false);
    expect(payer.stats().skippedNoPolicy).toBeGreaterThanOrEqual(1);
  });
});

// Cross-lane review, fix round 4 (HIGH, gateway payer): one core's PAY failure used to abort
// `payPending` for the whole peer — `state.pending` is walked in insertion order and a stuck core
// first in it threw before any later core was reached, so a seeder's other cores (the video
// playing now) were never paid and its window filled for good. The reviewer's probe: an engine
// rejecting CORE_A, one CORE_A block pending, then 4 CORE_B blocks under a per-seeder batch of 2
// → 0 PAYs (the control run without the stuck block paid CORE_B [0..3]).
describe('UpstreamPayer — a PAY that cannot be built (fix round 4)', () => {
  function failing(
    fail: (core: CoreKeyHex, range: { fromBlock: number; toBlock: number }) => Error | null,
    opts: {
      readonly batch?: number;
      readonly atCap?: boolean;
      readonly tailMs?: number;
      readonly credit?: UpstreamPayerOptions['credit'];
      readonly boundRange?: UpstreamPayerOptions['boundRange'];
      readonly autoAck?: boolean;
    } = {},
  ) {
    const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
    const log = capturedLogger();
    const calls: CoreKeyHex[] = [];
    const unpayable: { noise: string; core: CoreKeyHex; from: number; to: number }[] = [];
    const perCore = new Map<CoreKeyHex, PricePolicy>([
      [CORE_A, basePolicy(MANIFEST_PRICE)],
      [CORE_B, basePolicy(MANIFEST_PRICE)],
    ]);
    const payer = new UpstreamPayer({
      engine: {
        pay: (range, seeder, policy, o) => {
          calls.push(range.core);
          const err = fail(range.core, range);
          return err === null ? engine.pay(range, seeder, policy, o) : Promise.reject(err);
        },
        spent: () => engine.spent(),
      },
      logger: log.logger,
      payEveryBlocks: 1,
      tailMs: opts.tailMs ?? 0,
      seederBatch: () => ({ batch: opts.batch ?? 2, atCap: opts.atCap ?? false }),
      ...(opts.credit !== undefined ? { credit: opts.credit } : {}),
      ...(opts.boundRange !== undefined ? { boundRange: opts.boundRange } : {}),
      ownMints: [MINT_A, MINT_B],
      policyFor: manifestPolicyResolver(() => perCore),
      onUnpayable: (noise, range) => {
        unpayable.push({ noise, core: range.core, from: range.fromBlock, to: range.toBlock });
      },
    });
    const protocol = new FakePayProtocol({ autoAck: opts.autoAck ?? true });
    const detach = payer.attachPeer(NOISE, protocol);
    protocol.remoteHello(hello());
    return { payer, protocol, log, calls, unpayable, detach };
  }
  const ranges = (p: FakePayProtocol): [CoreKeyHex, number, number][] =>
    p.sentPays.map((m) => [m.range.core, m.range.fromBlock, m.range.toBlock]);

  it("the reviewer's probe: a core whose session is gone does not keep the seeder's other cores unpaid, and its blocks are settled as unpaid, explicitly", async () => {
    const r = failing((core) =>
      core === CORE_A ? new Error('session-closed: no open play session for this core') : null,
    );
    r.payer.onDownload(CORE_A, 0, NOISE);
    await r.payer.flush();
    for (let i = 0; i < 4; i++) r.payer.onDownload(CORE_B, i, NOISE);
    await r.payer.flush();
    const b = ranges(r.protocol).filter(([c]) => c === CORE_B);
    expect(b.flatMap(([, f, t]) => Array.from({ length: t - f + 1 }, (_, k) => f + k))).toEqual([
      0, 1, 2, 3,
    ]);
    // CORE_A's block: reported once as never to be paid (the settler keeps it off the seeder's
    // credit for good), never retried, never paid.
    expect(r.unpayable).toEqual([{ noise: NOISE, core: CORE_A, from: 0, to: 0 }]);
    expect(r.calls.filter((c) => c === CORE_A)).toHaveLength(1);
    expect(r.payer.stats().unpayableBlocks).toBe(1);
    r.payer.onDownload(CORE_A, 0, NOISE); // a re-download of an abandoned block owes nothing new
    await r.payer.flush();
    expect(r.calls.filter((c) => c === CORE_A)).toHaveLength(1);
  });

  // Fix round 5 changed WHEN a transient failure is retried: round 4 retried it at the very next
  // flush, and a close drain (a flush every 25 ms) then used up MAX_PAY_FAILURES in ~75 ms and
  // wrote a mint blip off for good (verifier, MEDIUM). It is now retried once its backoff is over
  // (PAY_RETRY_BASE_MS, doubling), by any pass. This test used to flush twice back to back and
  // expect the retry at the second; it now advances the clock past the backoff first, and also
  // pins that a flush inside the backoff does NOT retry.
  it('a transient failure keeps the blocks owed and is retried by the next pass once its backoff is over; the other cores are paid meanwhile', async () => {
    vi.useFakeTimers();
    try {
      let down = true;
      const r = failing((core) =>
        core === CORE_A && down ? new Error('backend-down: the host is busy') : null,
      );
      r.payer.onDownload(CORE_A, 0, NOISE);
      r.payer.onDownload(CORE_B, 0, NOISE);
      await r.payer.flush();
      expect(ranges(r.protocol)).toEqual([[CORE_B, 0, 0]]);
      expect(r.unpayable).toEqual([]);
      down = false;
      await r.payer.flush(); // inside the backoff: not tried again yet
      expect(r.calls.filter((c) => c === CORE_A)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(PAY_RETRY_BASE_MS);
      await r.payer.flush();
      expect(ranges(r.protocol)).toEqual([
        [CORE_B, 0, 0],
        [CORE_A, 0, 0],
      ]);
      expect(r.unpayable).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Fix round 5: the give-up is bounded in TIME as well as in attempts (see the test above). This
  // test used to flush MAX_PAY_FAILURES + 2 times back to back and expect the give-up at the
  // third; it now lets the clock run, and pins both halves: attempts alone never give up.
  it('a core that keeps failing is given up only after MAX_PAY_FAILURES attempts over PAY_GIVE_UP_MS (settled as unpaid, not retried for ever)', async () => {
    vi.useFakeTimers();
    try {
      const r = failing((core) => (core === CORE_A ? new Error('internal: boom') : null));
      const t0 = Date.now();
      r.payer.onDownload(CORE_A, 0, NOISE);
      await r.payer.flush();
      // Every attempt the backoff allows, for just under PAY_GIVE_UP_MS: never given up.
      while (Date.now() - t0 < PAY_GIVE_UP_MS - PAY_RETRY_MAX_MS) {
        await vi.advanceTimersByTimeAsync(25);
        await r.payer.flush();
      }
      expect(r.calls.filter((c) => c === CORE_A).length).toBeGreaterThanOrEqual(MAX_PAY_FAILURES);
      expect(r.unpayable).toEqual([]);
      await vi.advanceTimersByTimeAsync(2 * PAY_RETRY_MAX_MS);
      expect(r.unpayable).toEqual([{ noise: NOISE, core: CORE_A, from: 0, to: 0 }]);
      const tries = r.calls.length;
      await vi.advanceTimersByTimeAsync(4 * PAY_RETRY_MAX_MS);
      await r.payer.flush();
      expect(r.calls).toHaveLength(tries); // nothing left to try
    } finally {
      vi.useRealTimers();
    }
  });

  it('the failure is logged by its outcome code only — no core, no peer, no message text', async () => {
    const r = failing((core) =>
      core === CORE_A ? new Error(`forbidden: the PAY covers ${'ab'.repeat(32)}`) : null,
    );
    r.payer.onDownload(CORE_A, 0, NOISE);
    await r.payer.flush();
    const rec = r.log.records.find((x) => x.msg.includes('could not be built'));
    expect(rec).toBeDefined();
    expect(JSON.stringify(rec)).not.toContain('ab'.repeat(32));
    expect(JSON.stringify(rec)).not.toContain(NOISE);
    expect(JSON.stringify(rec)).not.toContain(CORE_A);
    expect(JSON.stringify(rec)).toContain('forbidden');
    expect(r.unpayable).toEqual([{ noise: NOISE, core: CORE_A, from: 0, to: 0 }]);
  });
});

// Fix round 5 (the verifier of fix round 4).
describe('UpstreamPayer — transient failures back off in time; two sessions of one core; hurry (fix round 5)', () => {
  /** A `CreditPool` stand-in whose pressure the test fires by hand. */
  function pool() {
    const listeners = new Set<() => void>();
    return {
      credit: {
        limit: 8,
        pressured: true,
        onPressure: (cb: () => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
      pressure: () => {
        for (const cb of listeners) cb();
      },
    };
  }
  function engineRig(
    fail: (range: { core: CoreKeyHex; fromBlock: number; toBlock: number }) => Error | null,
    opts: Partial<UpstreamPayerOptions> & {
      readonly atCap?: boolean;
      readonly batch?: number;
    } = {},
  ) {
    const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
    const calls: [CoreKeyHex, number, number][] = [];
    const unpayable: [CoreKeyHex, number, number][] = [];
    const perCore = new Map<CoreKeyHex, PricePolicy>([
      [CORE_A, basePolicy(MANIFEST_PRICE)],
      [CORE_B, basePolicy(MANIFEST_PRICE)],
    ]);
    const payer = new UpstreamPayer({
      engine: {
        pay: (range, seeder, policy, o) => {
          calls.push([range.core, range.fromBlock, range.toBlock]);
          const err = fail(range);
          return err === null ? engine.pay(range, seeder, policy, o) : Promise.reject(err);
        },
        spent: () => engine.spent(),
      },
      logger: capturedLogger().logger,
      payEveryBlocks: 1,
      tailMs: 0,
      seederBatch: () => ({ batch: opts.batch ?? 4, atCap: opts.atCap ?? false }),
      ownMints: [MINT_A, MINT_B],
      policyFor: manifestPolicyResolver(() => perCore),
      onUnpayable: (_noise, r) => {
        unpayable.push([r.core, r.fromBlock, r.toBlock]);
      },
      ...opts,
    });
    const protocol = new FakePayProtocol({ autoAck: true });
    payer.attachPeer(NOISE, protocol);
    protocol.remoteHello(hello());
    return { payer, protocol, calls, unpayable };
  }
  const sent = (p: FakePayProtocol): [CoreKeyHex, number, number][] =>
    p.sentPays.map((m) => [m.range.core, m.range.fromBlock, m.range.toBlock]);

  // The verifier's repro (MEDIUM, payer at-cap retry regression): a failed core was retried only
  // by a FORCED pass in a NEW epoch, and the epoch moved only on flush() or the tail timer, which
  // only a new block re-arms. A seeder at its cap sends no new block, so once the tail timer's
  // retry had failed too, nothing ever retried: 2 calls, 0 PAYs, the stream frozen until close.
  it("the verifier's repro: the engine refuses 'no-balance' for ~300 ms while the seeder is at its cap — once it clears the PAY goes out, no close needed", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const p = pool();
      const r = engineRig(
        () =>
          Date.now() - t0 < 300
            ? new Error('no-balance: not enough sats at this mint to keep streaming')
            : null,
        { atCap: true, tailMs: 30, credit: p.credit },
      );
      r.payer.onDownload(CORE_A, 0, NOISE); // at the cap: paid at once — and refused
      await vi.advanceTimersByTimeAsync(0);
      expect(r.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(310); // the tail timer fired; the fault has cleared
      // The player keeps pressuring the pool, as the gate does while it waits for credit.
      for (let i = 0; i < 10; i++) {
        p.pressure();
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(sent(r.protocol)).toEqual([[CORE_A, 0, 0]]);
      expect(r.unpayable).toEqual([]);
      expect(r.payer.stats()).toMatchObject({ pays: 1, unpayableBlocks: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed PAY is retried after its backoff even when nothing else happens (no block, no ACK, no pressure, no tail timer)', async () => {
    vi.useFakeTimers();
    try {
      let down = true;
      const r = engineRig(() => (down ? new Error('backend-down: the host is busy') : null), {
        atCap: true,
      });
      r.payer.onDownload(CORE_A, 0, NOISE);
      await vi.advanceTimersByTimeAsync(0);
      expect(r.calls).toHaveLength(1);
      down = false;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_BASE_MS - 10);
      expect(r.calls).toHaveLength(1); // still backing off
      await vi.advanceTimersByTimeAsync(20);
      expect(sent(r.protocol)).toEqual([[CORE_A, 0, 0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a short tail whose PAY failed is retried as a tail (however short) by its retry timer, not left for a full batch', async () => {
    vi.useFakeTimers();
    try {
      let down = true;
      const r = engineRig(() => (down ? new Error('backend-down: the host is busy') : null), {
        batch: 4,
        tailMs: 30,
      });
      r.payer.onDownload(CORE_A, 0, NOISE); // 1 < a batch of 4: waits for the tail timer
      await vi.advanceTimersByTimeAsync(40);
      expect(r.calls).toHaveLength(1);
      down = false;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_BASE_MS + 10);
      expect(sent(r.protocol)).toEqual([[CORE_A, 0, 0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed run is due by its own streak: another core's block (which ends the peer's quiet spell) does not make its retry wait for a full batch or the next tail", async () => {
    vi.useFakeTimers();
    try {
      let down = true;
      const r = engineRig(
        (range) =>
          range.core === CORE_A && down ? new Error('backend-down: the host is busy') : null,
        { batch: 4, tailMs: 1000 },
      );
      r.payer.onDownload(CORE_A, 0, NOISE);
      await vi.advanceTimersByTimeAsync(1010); // the tail timer: CORE_A's PAY refused
      expect(r.calls).toEqual([[CORE_A, 0, 0]]);
      down = false;
      r.payer.onDownload(CORE_B, 0, NOISE); // the peer is not quiet any more; next tail at +1 s
      await vi.advanceTimersByTimeAsync(PAY_RETRY_BASE_MS + 10);
      expect(sent(r.protocol)).toEqual([[CORE_A, 0, 0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The verifier (MEDIUM): at close the drain's 25 ms flush loop bumped the epoch on every pass, so
  // a fault still there was retried MAX_PAY_FAILURES times in well under a second and written off.
  it('a burst of flushes (a close drain polls every 25 ms) never writes a transient failure off in under a second — it is paid once the fault clears', async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const r = engineRig(() =>
        Date.now() - t0 < 1500 ? new Error('internal: the mint is not answering') : null,
      );
      r.payer.onDownload(CORE_A, 0, NOISE);
      while (Date.now() - t0 < 1200) {
        await r.payer.flush();
        await vi.advanceTimersByTimeAsync(25);
      }
      expect(r.unpayable).toEqual([]);
      expect(r.calls.length).toBeLessThanOrEqual(4); // at 0, 250, 750 ms (the backoff), not per flush
      await vi.advanceTimersByTimeAsync(2000);
      expect(sent(r.protocol)).toEqual([[CORE_A, 0, 0]]);
      expect(r.unpayable).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The verifier (HIGH): after a rendition switch two play sessions share one core. Round 4 gave
  // up EVERY pending block of the core on 'session-closed' — the new session's blocks too.
  it("a range refused for good gives up THAT range only: another session's blocks of the same core are paid in the same pass", async () => {
    // A batch of 8: the downloads below schedule passes that pay nothing, so the ONE forced pass of
    // `flush()` has to give [0, 1] up and still reach [5, 6] (nothing else would run another pass).
    const r = engineRig(
      (range) =>
        range.core === CORE_A && range.toBlock < 5
          ? new Error('session-closed: no play session covers these blocks')
          : null,
      { batch: 8 },
    );
    for (const i of [0, 1, 5, 6]) r.payer.onDownload(CORE_A, i, NOISE);
    await settle();
    expect(r.calls).toEqual([]);
    await r.payer.flush();
    expect(r.unpayable).toEqual([[CORE_A, 0, 1]]);
    expect(sent(r.protocol)).toEqual([[CORE_A, 5, 6]]);
    // A 'forbidden' range the same way.
    const f = engineRig(
      (range) =>
        range.toBlock < 5 ? new Error('forbidden: the PAY covers blocks outside the video') : null,
      { batch: 8 },
    );
    for (const i of [0, 1, 5, 6]) f.payer.onDownload(CORE_A, i, NOISE);
    await settle();
    await f.payer.flush();
    expect(f.unpayable).toEqual([[CORE_A, 0, 1]]);
    expect(sent(f.protocol)).toEqual([[CORE_A, 5, 6]]);
  });

  it('boundRange: one PAY never crosses the bound (two renditions side by side in one core); a bad bound is ignored', async () => {
    const r = engineRig(() => null, {
      boundRange: (range) => (range.fromBlock <= 4 ? { ...range, toBlock: 4 } : range),
    });
    for (let i = 2; i <= 7; i++) r.payer.onDownload(CORE_A, i, NOISE);
    await r.payer.flush();
    expect(sent(r.protocol)).toEqual([
      [CORE_A, 2, 4],
      [CORE_A, 5, 7],
    ]);
    for (const bad of [
      (x: { core: CoreKeyHex; fromBlock: number; toBlock: number }) => ({ ...x, core: CORE_B }),
      (x: { core: CoreKeyHex; fromBlock: number; toBlock: number }) => ({
        ...x,
        toBlock: x.toBlock + 5,
      }),
      (x: { core: CoreKeyHex; fromBlock: number; toBlock: number }) => ({
        ...x,
        fromBlock: x.fromBlock + 1,
      }),
      (x: { core: CoreKeyHex; fromBlock: number; toBlock: number }) => ({
        ...x,
        toBlock: x.fromBlock - 1,
      }),
      () => {
        throw new Error('boom');
      },
    ]) {
      const b = engineRig(() => null, { boundRange: bad });
      for (let i = 2; i <= 4; i++) b.payer.onDownload(CORE_A, i, NOISE);
      await b.payer.flush();
      expect(sent(b.protocol)).toEqual([[CORE_A, 2, 4]]);
    }
  });

  it('hurry(range) pays that range at once however short, and a block of it that lands later; the rest keeps batching; released, it batches again', async () => {
    const r = engineRig(() => null, { batch: 4 });
    r.payer.onDownload(CORE_A, 2, NOISE);
    r.payer.onDownload(CORE_A, 10, NOISE);
    await settle();
    expect(sent(r.protocol)).toEqual([]); // 2 < a batch of 4
    const release = r.payer.hurry({ core: CORE_A, fromBlock: 0, toBlock: 5 });
    await settle();
    expect(sent(r.protocol)).toEqual([[CORE_A, 2, 2]]);
    r.payer.onDownload(CORE_A, 4, NOISE); // in flight when the session closed: lands now
    await settle();
    expect(sent(r.protocol)).toEqual([
      [CORE_A, 2, 2],
      [CORE_A, 4, 4],
    ]);
    release();
    r.payer.onDownload(CORE_A, 3, NOISE);
    await settle();
    expect(sent(r.protocol)).toHaveLength(2); // batching again: 3 and 10 wait
    // The gateway pays every `payEveryBlocks` blocks: a single hurried block that lands is still
    // paid at once (it schedules its own pass).
    const g = engineRig(() => null, { batch: 4, payEveryBlocks: 4 });
    const off = g.payer.hurry({ core: CORE_A, fromBlock: 0, toBlock: 5 });
    await settle();
    g.payer.onDownload(CORE_A, 4, NOISE);
    await settle();
    expect(sent(g.protocol)).toEqual([[CORE_A, 4, 4]]);
    off();
  });
});

// Lane R6-reconcile: one retry mechanism for lane I2-paygate's "rate-limited" and fix round 5's
// transient failures; the round-5 verifier's two payer items (a final give-up ends the streak; a
// monotonic clock).
describe('UpstreamPayer — deferred refusals, streaks and the clock (lane R6-reconcile)', () => {
  function rig6(
    fail: (range: { core: CoreKeyHex; fromBlock: number; toBlock: number }) => Error | null,
    opts: Partial<UpstreamPayerOptions> & { readonly batch?: number } = {},
  ) {
    const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
    const calls: [CoreKeyHex, number, number][] = [];
    const unpayable: [CoreKeyHex, number, number][] = [];
    const log = capturedLogger();
    const perCore = new Map<CoreKeyHex, PricePolicy>([
      [CORE_A, basePolicy(MANIFEST_PRICE)],
      [CORE_B, basePolicy(MANIFEST_PRICE)],
    ]);
    const payer = new UpstreamPayer({
      engine: {
        pay: (range, seeder, policy, o) => {
          calls.push([range.core, range.fromBlock, range.toBlock]);
          const err = fail(range);
          return err === null ? engine.pay(range, seeder, policy, o) : Promise.reject(err);
        },
        spent: () => engine.spent(),
      },
      logger: log.logger,
      payEveryBlocks: 1,
      tailMs: 0,
      seederBatch: () => ({ batch: opts.batch ?? 4, atCap: true }),
      ownMints: [MINT_A, MINT_B],
      policyFor: manifestPolicyResolver(() => perCore),
      onUnpayable: (_noise, r) => {
        unpayable.push([r.core, r.fromBlock, r.toBlock]);
      },
      ...opts,
    });
    const protocol = new FakePayProtocol({ autoAck: true });
    payer.attachPeer(NOISE, protocol);
    protocol.remoteHello(hello());
    const sent = (): [CoreKeyHex, number, number][] =>
      protocol.sentPays.map((m) => [m.range.core, m.range.fromBlock, m.range.toBlock]);
    return { payer, protocol, calls, unpayable, sent, log };
  }
  const limited = (): Error =>
    Object.assign(new Error('rate-limited: a melt is in progress at this mint'), {
      code: 'rate-limited',
    });

  it('classifies outcomes: session-closed and forbidden final, rate-limited deferred, anything else transient', () => {
    expect(payFailureClass('session-closed')).toBe('final');
    expect(payFailureClass('forbidden')).toBe('final');
    expect(payFailureClass('rate-limited')).toBe('deferred');
    for (const c of ['no-balance', 'backend-down', 'internal', 'error', 'rate-limitedx'])
      expect(payFailureClass(c)).toBe('transient');
  });

  it('a 5-minute "rate-limited" (a melt at the mint) is never given up: asked on its own cadence, then paid once the host accepts', async () => {
    vi.useFakeTimers();
    try {
      let melting = true;
      const r = rig6(() => (melting ? limited() : null));
      r.payer.onDownload(CORE_A, 0, NOISE); // at the cap: paid at once — and refused
      await vi.advanceTimersByTimeAsync(0);
      expect(r.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(PAY_RETRY_LATER_MS - 1);
      expect(r.calls).toHaveLength(1); // not the transient cadence (PAY_RETRY_BASE_MS)
      await vi.advanceTimersByTimeAsync(1);
      expect(r.calls).toHaveLength(2);
      // A burst of flushes (a close drain polls every 25 ms) asks nothing inside the backoff.
      for (let i = 0; i < 20; i++) {
        await r.payer.flush();
        await vi.advanceTimersByTimeAsync(25);
      }
      expect(r.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(300_000);
      // 2, 4, 8, 16 s, then every 30 s: about 13 asks in 5 minutes, and never given up.
      expect(r.calls.length).toBeGreaterThanOrEqual(10);
      expect(r.calls.length).toBeLessThanOrEqual(Math.ceil(300_000 / PAY_RETRY_LATER_MAX_MS) + 6);
      expect(r.unpayable).toEqual([]);
      expect(r.sent()).toEqual([]);
      melting = false;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_LATER_MAX_MS);
      expect(r.sent()).toEqual([[CORE_A, 0, 0]]);
      expect(r.payer.stats()).toMatchObject({ pays: 1, unpayableBlocks: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a deferred refusal ends a transient streak: its time never counts toward giving up', async () => {
    vi.useFakeTimers();
    try {
      let mode: 'transient' | 'limited' | 'ok' = 'transient';
      const r = rig6(() =>
        mode === 'transient'
          ? new Error('no-balance: not enough sats at this mint')
          : mode === 'limited'
            ? limited()
            : null,
      );
      r.payer.onDownload(CORE_A, 0, NOISE);
      await vi.advanceTimersByTimeAsync(PAY_GIVE_UP_MS - PAY_RETRY_MAX_MS - 100); // a long streak
      expect(r.calls.length).toBeGreaterThanOrEqual(MAX_PAY_FAILURES);
      expect(r.unpayable).toEqual([]);
      mode = 'limited'; // a melt at the mint: two minutes of "not now"
      await vi.advanceTimersByTimeAsync(120_000);
      expect(r.unpayable).toEqual([]);
      mode = 'transient'; // the melt is over; the mint blips once more
      const before = r.calls.length;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_LATER_MAX_MS);
      expect(r.calls.length).toBeGreaterThan(before);
      // A fresh transient streak: not written off at once (the old streak's age plus the melt's
      // would have been far past PAY_GIVE_UP_MS).
      expect(r.unpayable).toEqual([]);
      mode = 'ok';
      await vi.advanceTimersByTimeAsync(PAY_RETRY_MAX_MS + 10);
      expect(r.sent()).toEqual([[CORE_A, 0, 0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  // The round-5 verifier's sequence: a streak of transient failures on session A's range, then A
  // closes (its range given up with a final code); 40 s later session B's range of the same core
  // fails once, transiently. Round 5 kept the old streak (n ≥ 3, first failure 40 s ago), so B's
  // range was written off at that first failure.
  it("a range given up with a final code ends the core's streak: a later transient failure starts afresh and is paid once it clears", async () => {
    vi.useFakeTimers();
    try {
      let aClosed = false;
      let bDown = false;
      const r = rig6((range) => {
        if (range.toBlock < 5)
          return aClosed
            ? new Error('session-closed: no play session covers these blocks')
            : new Error('backend-down: the host is busy');
        return bDown ? new Error('backend-down: the host is busy') : null;
      });
      r.payer.onDownload(CORE_A, 0, NOISE); // session A
      await vi.advanceTimersByTimeAsync(2 * PAY_RETRY_MAX_MS); // 0, 250, 750, 1750, 3750, 7750 ms
      expect(r.calls.length).toBeGreaterThanOrEqual(MAX_PAY_FAILURES);
      aClosed = true;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_MAX_MS);
      expect(r.unpayable).toEqual([[CORE_A, 0, 0]]);
      await vi.advanceTimersByTimeAsync(40_000);
      bDown = true;
      r.payer.onDownload(CORE_A, 5, NOISE); // session B, a mint blip
      await vi.advanceTimersByTimeAsync(0);
      expect(r.unpayable).toEqual([[CORE_A, 0, 0]]); // B's range NOT written off
      bDown = false;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_BASE_MS);
      expect(r.sent()).toEqual([[CORE_A, 5, 5]]);
      expect(r.unpayable).toEqual([[CORE_A, 0, 0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the final code also frees the core's next run from the old backoff: tried in the same pass", async () => {
    let closed = false;
    const r = rig6(
      (range) =>
        range.toBlock < 5
          ? new Error(closed ? 'forbidden: outside the video' : 'backend-down: busy')
          : null,
      { batch: 8, clock: () => 0 },
    );
    r.payer.onDownload(CORE_A, 0, NOISE);
    await settle();
    expect(r.calls).toEqual([[CORE_A, 0, 0]]); // refused: a backoff that (clock 0) never ends
    closed = true;
    r.payer.onDownload(CORE_A, 6, NOISE);
    // The clock stands still, so only a retry TIMER could end the backoff; wait for it to fire
    // (PAY_RETRY_BASE_MS, real time), when block 0 is given up for good and block 6 is paid in the
    // same pass — not held back by the streak block 0 left behind.
    await until(() => r.sent().length === 1, 2_000);
    expect(r.unpayable).toEqual([[CORE_A, 0, 0]]);
    expect(r.sent()).toEqual([[CORE_A, 6, 6]]);
  });

  it('streaks read the injected monotonic clock, never Date.now(): a wall-clock step writes nothing off; a step of the clock itself does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let mono = 0;
      const r = rig6(() => new Error('no-balance: not enough sats at this mint'), {
        clock: () => mono,
      });
      r.payer.onDownload(CORE_A, 0, NOISE);
      await vi.advanceTimersByTimeAsync(0);
      // Three more tries on the backoff, the monotonic clock moving with the timers.
      for (const d of [PAY_RETRY_BASE_MS, 2 * PAY_RETRY_BASE_MS, 4 * PAY_RETRY_BASE_MS]) {
        mono += d;
        await vi.advanceTimersByTimeAsync(d);
      }
      expect(r.calls).toHaveLength(MAX_PAY_FAILURES + 1);
      // The wall clock jumps a day ahead (NTP, a resume from suspend): nothing is written off.
      vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
      mono += 8 * PAY_RETRY_BASE_MS;
      await vi.advanceTimersByTimeAsync(8 * PAY_RETRY_BASE_MS);
      expect(r.calls).toHaveLength(MAX_PAY_FAILURES + 2);
      expect(r.unpayable).toEqual([]);
      // …and a step back of the wall clock holds no retry back.
      vi.setSystemTime(Date.now() - 48 * 60 * 60_000);
      mono += PAY_RETRY_MAX_MS;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_MAX_MS);
      expect(r.calls).toHaveLength(MAX_PAY_FAILURES + 3);
      expect(r.unpayable).toEqual([]);
      // The monotonic clock itself past PAY_GIVE_UP_MS: the next failure gives the range up.
      mono += PAY_GIVE_UP_MS;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_MAX_MS);
      expect(r.unpayable).toEqual([[CORE_A, 0, 0]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a clock that stands still cannot stall a retry: the retry timer ends the backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let down = true;
      const r = rig6(() => (down ? new Error('backend-down: the host is busy') : null), {
        clock: () => 1_000,
      });
      r.payer.onDownload(CORE_A, 0, NOISE);
      await vi.advanceTimersByTimeAsync(0);
      expect(r.calls).toHaveLength(1);
      down = false;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_BASE_MS - 1);
      expect(r.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(r.sent()).toEqual([[CORE_A, 0, 0]]);
      // …and a frozen clock never gives up either (its streak never ages): fail-safe.
      const f = rig6(() => new Error('internal: boom'), { clock: () => 5 });
      f.payer.onDownload(CORE_B, 0, NOISE);
      await vi.advanceTimersByTimeAsync(3 * PAY_GIVE_UP_MS);
      expect(f.unpayable).toEqual([]);
      expect(f.calls.length).toBeGreaterThan(MAX_PAY_FAILURES);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['is not a number', (): number => Number.NaN],
    [
      'throws',
      (): number => {
        throw new Error('no clock');
      },
    ],
    [
      'runs backwards',
      (
        (t) => (): number =>
          (t -= 1_000)
      )(1e9),
    ],
  ] as const)(
    'a clock that %s stands still: retries come on their timers (never a loop), nothing is given up',
    async (_what, clock) => {
      vi.useFakeTimers();
      try {
        const r = rig6(() => new Error('backend-down: the host is busy'), { clock });
        r.payer.onDownload(CORE_A, 0, NOISE);
        await vi.advanceTimersByTimeAsync(0);
        expect(r.calls).toHaveLength(1);
        // No retry inside the first backoff: a clock read as NaN would have armed a 1 ms timer.
        await vi.advanceTimersByTimeAsync(PAY_RETRY_BASE_MS - 1);
        expect(r.calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(r.calls).toHaveLength(2);
        // Ten minutes on: spaced by the backoff (at most one try per PAY_RETRY_MAX_MS once it is
        // at its longest), and never written off — a streak on a clock that stands still never ages.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(r.calls.length).toBeLessThanOrEqual(8 + Math.ceil((10 * 60_000) / PAY_RETRY_MAX_MS));
        expect(r.calls.length).toBeGreaterThan(MAX_PAY_FAILURES + 10);
        expect(r.unpayable).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('dispose(): a PAY that fails after it arms no retry, and nothing more is built', async () => {
    vi.useFakeTimers();
    try {
      let refuse: (e: Error) => void = () => undefined;
      const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
      let calls = 0;
      const perCore = new Map<CoreKeyHex, PricePolicy>([[CORE_A, basePolicy(MANIFEST_PRICE)]]);
      const payer = new UpstreamPayer({
        engine: {
          pay: () => {
            calls++;
            return new Promise<PayMessage>((_resolve, reject) => {
              refuse = reject;
            });
          },
          spent: () => engine.spent(),
        },
        logger: capturedLogger().logger,
        payEveryBlocks: 1,
        tailMs: 0,
        ownMints: [MINT_A, MINT_B],
        policyFor: manifestPolicyResolver(() => perCore),
      });
      const protocol = new FakePayProtocol({ autoAck: true });
      payer.attachPeer(NOISE, protocol);
      protocol.remoteHello(hello());
      payer.onDownload(CORE_A, 0, NOISE);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      payer.dispose();
      refuse(new Error('backend-down: the host is busy'));
      await vi.advanceTimersByTimeAsync(0);
      // No retry timer armed for it: a disposed payer leaves nothing behind to wake it.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10 * PAY_RETRY_LATER_MAX_MS);
      payer.onDownload(CORE_A, 1, NOISE);
      await payer.flush();
      expect(calls).toBe(1);
      expect(protocol.sentPays).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() while a PAY is being built: that PAY still goes out (its proofs are built), no other core is built after it', async () => {
    const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
    const built: CoreKeyHex[] = [];
    let finishA: () => void = () => undefined;
    const perCore = new Map<CoreKeyHex, PricePolicy>([
      [CORE_A, basePolicy(MANIFEST_PRICE)],
      [CORE_B, basePolicy(MANIFEST_PRICE)],
    ]);
    const payer = new UpstreamPayer({
      engine: {
        pay: async (range, seeder, policy, o) => {
          built.push(range.core);
          if (range.core === CORE_A)
            await new Promise<void>((resolve) => {
              finishA = resolve;
            });
          return engine.pay(range, seeder, policy, o);
        },
        spent: () => engine.spent(),
      },
      logger: capturedLogger().logger,
      payEveryBlocks: 1,
      tailMs: 0,
      ownMints: [MINT_A, MINT_B],
      policyFor: manifestPolicyResolver(() => perCore),
    });
    const protocol = new FakePayProtocol({ autoAck: false });
    payer.attachPeer(NOISE, protocol);
    protocol.remoteHello(hello());
    payer.onDownload(CORE_A, 0, NOISE);
    await settle();
    expect(built).toEqual([CORE_A]); // being built
    payer.onDownload(CORE_B, 0, NOISE); // pending behind it, in the same pass
    payer.dispose();
    finishA();
    await settle();
    await payer.flush();
    expect(built).toEqual([CORE_A]);
    expect(protocol.sentPays.map((m) => m.range.core)).toEqual([CORE_A]);
  });

  describe('monotonicClock', () => {
    it('is performance.now() where the runtime has it (called on performance)', () => {
      const perf = {
        t: 42,
        now(this: { t: number }): number {
          return this.t;
        },
      };
      const c = monotonicClock({ performance: perf, dateNow: () => 1e12 });
      expect(c()).toBe(42);
      perf.t = 50;
      expect(c()).toBe(50);
      // The runtime's own: Node has performance.
      const real = monotonicClock();
      expect(Math.abs(real() - performance.now())).toBeLessThan(1_000);
    });

    it('without performance (Bare): Date.now() made steady — never backwards, a step forward counts at most MAX_CLOCK_STEP_MS, NaN counts nothing', () => {
      let wall = 1_000_000;
      const c = monotonicClock({ performance: undefined, dateNow: () => wall });
      expect(c()).toBe(0);
      wall += 250;
      expect(c()).toBe(250);
      wall -= 60 * 60_000; // an hour back
      expect(c()).toBe(250);
      wall += 1_000; // time goes on from there
      expect(c()).toBe(1_250);
      wall += 24 * 60 * 60_000; // a day ahead (a resume from suspend)
      expect(c()).toBe(1_250 + MAX_CLOCK_STEP_MS);
      wall = Number.NaN;
      expect(c()).toBe(1_250 + MAX_CLOCK_STEP_MS);
      wall = 5_000;
      expect(c()).toBe(1_250 + MAX_CLOCK_STEP_MS);
      wall += 100;
      expect(c()).toBe(1_350 + MAX_CLOCK_STEP_MS);
      // MAX_CLOCK_STEP_MS is past the longest wait between two reads during a transient streak.
      expect(MAX_CLOCK_STEP_MS).toBeGreaterThan(PAY_RETRY_MAX_MS);
      // A performance object without a now() function is not a clock.
      const d = monotonicClock({ performance: { now: 'x' }, dateNow: () => 7 });
      expect(d()).toBe(0);
    });
  });
});

// ---- lane P2-owed-viewer (contracts v6 amendment; ADRs 0015 and 0018 amendments) ------------

describe('UpstreamPayer — PRICE { free: true } is not a price (ADR 0015 amendment)', () => {
  it('blocks of a core the seeder serves free are never pended nor paid (no 0-sat PAY); a later priced PRICE ends it', async () => {
    const { payer, protocol } = unit(1);
    protocol.remoteHello(hello());
    payer.onDownload(CORE_A, 0, NOISE);
    await payer.flush();
    expect(protocol.sentPays).toHaveLength(1);
    // Free from now on: pending blocks of it are dropped, later ones never pended.
    payer.onDownload(CORE_A, 1, NOISE);
    protocol.remotePrice({
      type: 'PRICE',
      core: CORE_A,
      satsPerBlock: 0 as Sats,
      effectiveFromBlock: 0,
      free: true,
    });
    payer.onDownload(CORE_A, 2, NOISE);
    await payer.flush();
    expect(protocol.sentPays).toHaveLength(1);
    // Another core is paid as ever; free is per core.
    payer.onDownload(CORE_B, 0, NOISE);
    await payer.flush();
    expect(protocol.sentPays.map((p) => p.range.core)).toEqual([CORE_A, CORE_B]);
    // Sold again: at its price, never at 0.
    protocol.remotePrice({
      type: 'PRICE',
      core: CORE_A,
      satsPerBlock: 3 as Sats,
      effectiveFromBlock: 3,
    });
    payer.onDownload(CORE_A, 3, NOISE);
    await payer.flush();
    expect(protocol.sentPays).toHaveLength(3);
    const last = protocol.sentPays[2]!;
    expect(last.range).toEqual({ core: CORE_A, fromBlock: 3, toBlock: 3 });
    const total = [...last.seederProofs.proofs, ...last.creatorProofs.proofs].reduce(
      (n, p) => n + p.amount,
      0,
    );
    expect(total).toBe(3);
  });
});

describe('UpstreamPayer — owed blocks from before (ADR 0018 amendment)', () => {
  const RECORDED = basePolicy(MANIFEST_PRICE);
  function owedRig(
    o: {
      owed?: boolean;
      recorded?: PricePolicy | null;
      /** Lane W8b-p2p: an outcome code to refuse an owed PAY with (`null`: built). */
      failOwed?: () => string | null;
      /** Lane W8b-p2p: an outcome code to refuse a fresh PAY with (`null`: built). */
      failFresh?: () => string | null;
      payEveryBlocks?: number;
    } = {},
  ) {
    const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
    const owedCalls: { range: [number, number]; carryIn: number; peer: string }[] = [];
    let owedTries = 0;
    const given: [number, number][] = [];
    const scopes: (string | undefined)[] = [];
    const refuse = (code: string): Error => Object.assign(new Error(`${code}: refused`), { code });
    const payer = new UpstreamPayer({
      engine: {
        pay: (range, seeder, policy, opts) => {
          const code = o.failFresh?.() ?? null;
          return code === null
            ? engine.pay(range, seeder, policy, opts)
            : Promise.reject(refuse(code));
        },
        spent: () => engine.spent(),
      },
      logger: capturedLogger().logger,
      payEveryBlocks: o.payEveryBlocks ?? 4,
      tailMs: 0,
      ownMints: [MINT_A, MINT_B],
      policyFor: () => basePolicy(MANIFEST_PRICE),
      onUnpayable: (_n, r, scope) => {
        given.push([r.fromBlock, r.toBlock]);
        scopes.push(scope);
      },
      ...(o.owed === false
        ? {}
        : {
            owed: {
              policyFor: () => (o.recorded === undefined ? RECORDED : o.recorded),
              pay: (range, seeder, policy, opts, peer) => {
                owedTries++;
                const code = o.failOwed?.() ?? null;
                if (code !== null) return Promise.reject(refuse(code));
                owedCalls.push({
                  range: [range.fromBlock, range.toBlock],
                  carryIn: opts.carryIn,
                  peer,
                });
                return engine.pay(range, seeder, policy, opts);
              },
            },
          }),
    });
    const protocol = new FakePayProtocol({ autoAck: true });
    payer.attachPeer(NOISE, protocol);
    return { payer, protocol, owedCalls, given, scopes, owedTries: () => owedTries };
  }
  const priced = {
    type: 'PRICE',
    core: CORE_A,
    satsPerBlock: 3 as Sats,
    effectiveFromBlock: 0,
  } as const;

  it('taken only on an open connection, after the core’s priced PRICE, with an owed engine; never twice', async () => {
    const r = owedRig();
    expect(r.payer.addOwed(NOISE, CORE_A, [1, 2])).toBe(0); // not open yet
    r.protocol.remoteHello(hello());
    expect(r.payer.addOwed(NOISE, CORE_A, [1, 2])).toBe(0); // no priced PRICE for it here
    r.protocol.remotePrice({ ...priced, satsPerBlock: 0 as Sats, free: true });
    expect(r.payer.addOwed(NOISE, CORE_A, [1, 2])).toBe(0); // free now: rule 3, not payable
    r.protocol.remotePrice(priced);
    expect(r.payer.addOwed('ab'.repeat(32), CORE_A, [1])).toBe(0); // unknown peer
    expect(r.payer.addOwed(NOISE, CORE_A, [1, 2, -1, 1.5])).toBe(2);
    await r.payer.flush();
    expect(r.payer.addOwed(NOISE, CORE_A, [1, 2])).toBe(0); // paid already on this connection
    const gw = owedRig({ owed: false }); // the gateway: no owed engine, no old tail paid
    gw.protocol.remoteHello(hello());
    gw.protocol.remotePrice(priced);
    expect(gw.payer.addOwed(NOISE, CORE_A, [1])).toBe(0);
    expect(gw.payer.stats()).toMatchObject({ owedAccepted: 0, owedPaid: 0 });
  });

  it('paid at once and apart — never in one PAY with this connection’s blocks — on the connection’s carry chain, at the seeder’s asked price', async () => {
    const r = owedRig();
    r.protocol.remoteHello(hello());
    r.protocol.remotePrice(priced);
    // Blocks 4..5 of this connection are pending below a batch; 2..3 and 6 are owed from before.
    r.payer.onDownload(CORE_A, 4, NOISE);
    r.payer.onDownload(CORE_A, 5, NOISE);
    expect(r.payer.addOwed(NOISE, CORE_A, [2, 3, 6])).toBe(3);
    await r.payer.flush();
    const ranges = r.protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock]);
    expect(ranges).toEqual([
      [2, 3],
      [4, 5],
      [6, 6],
    ]);
    // The owed ones through the owed engine (with the peer), the fresh ones through the payer's.
    expect(r.owedCalls.map((c) => c.range)).toEqual([
      [2, 3],
      [6, 6],
    ]);
    expect(r.owedCalls.every((c) => c.peer === NOISE)).toBe(true);
    // One carry chain for the core on this connection: 0 only for its first PAY.
    expect(r.owedCalls[0]!.carryIn).toBe(0);
    for (const p of r.protocol.sentPays) {
      const n = [...p.seederProofs.proofs, ...p.creatorProofs.proofs].reduce(
        (a, b) => a + b.amount,
        0,
      );
      expect(n).toBe((p.range.toBlock - p.range.fromBlock + 1) * 3); // the seeder's asked 3 ≤ 5
    }
    expect(r.payer.stats()).toMatchObject({ owedAccepted: 3, owedPaid: 3 });
  });

  it('a core that turns free after its owed blocks were taken: they are not paid (rule 3: free never covers blocks counted before)', async () => {
    const r = owedRig();
    r.protocol.remoteHello(hello());
    r.protocol.remotePrice(priced);
    // The PAY of block 1 waits for its ACK (one per core in flight), so 7 is still pending when
    // the core turns free.
    const unacked = new FakePayProtocol({ autoAck: false });
    r.payer.attachPeer('cd'.repeat(32), unacked);
    unacked.remoteHello(hello());
    unacked.remotePrice(priced);
    r.payer.onDownload(CORE_A, 1, 'cd'.repeat(32));
    await r.payer.flush('cd'.repeat(32));
    expect(r.payer.addOwed('cd'.repeat(32), CORE_A, [7])).toBe(1);
    unacked.remotePrice({ ...priced, satsPerBlock: 0 as Sats, free: true });
    unacked.remoteAck({ type: 'ACK', core: CORE_A, fromBlock: 1, toBlock: 1, ok: true });
    await r.payer.flush('cd'.repeat(32));
    expect(unacked.sentPays.map((p) => p.range.fromBlock)).toEqual([1]);
    expect(r.owedCalls).toEqual([]);
    expect(r.given).toEqual([[7, 7]]);
  });

  it('not payable at the terms recorded (or asked above them): given up — respected, never paid', async () => {
    const none = owedRig({ recorded: null });
    none.protocol.remoteHello(hello());
    none.protocol.remotePrice(priced);
    none.payer.addOwed(NOISE, CORE_A, [7, 8]);
    await none.payer.flush();
    expect(none.protocol.sentPays).toHaveLength(0);
    expect(none.given).toEqual([[7, 8]]);
    const dear = owedRig({ recorded: basePolicy(2) });
    dear.protocol.remoteHello(hello());
    dear.protocol.remotePrice(priced); // asks 3 > the recorded 2
    dear.payer.addOwed(NOISE, CORE_A, [7]);
    await dear.payer.flush();
    expect(dear.protocol.sentPays).toHaveLength(0);
    expect(dear.given).toEqual([[7, 7]]);
    expect(dear.payer.stats()).toMatchObject({ owedAccepted: 1, owedPaid: 0, unpayableBlocks: 1 });
    // Terms it can never be paid at: out of the record for good (no scope).
    expect(dear.scopes).toEqual([undefined]);
  });

  // Round-8 review (MEDIUM + LOW): an owed range whose PAY kept failing for PAY_GIVE_UP_MS with a
  // failure that may pass (no balance, the mint down, the tail file) was given up with no scope —
  // the downloader then deleted it from its durable record, while the seeder kept counting it.
  it('an owed range the host cannot pay for now is never given up: retried on its backoff, slowing to the deferred cadence, and paid on the same connection once the fault clears', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let broke = true;
      const r = owedRig({ failOwed: () => (broke ? 'no-balance' : null) });
      r.protocol.remoteHello(hello());
      r.protocol.remotePrice(priced);
      expect(r.payer.addOwed(NOISE, CORE_A, [7])).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(r.owedTries()).toBe(1);
      await vi.advanceTimersByTimeAsync(PAY_GIVE_UP_MS);
      await vi.advanceTimersByTimeAsync(0);
      // Asked on the transient backoff until then (≤ 4 s apart), never written off.
      const byGiveUp = r.owedTries();
      expect(byGiveUp).toBeGreaterThanOrEqual(MAX_PAY_FAILURES);
      expect(byGiveUp).toBeLessThanOrEqual(5 + Math.ceil(PAY_GIVE_UP_MS / PAY_RETRY_MAX_MS));
      await vi.advanceTimersByTimeAsync(3 * PAY_RETRY_LATER_MAX_MS);
      await vi.advanceTimersByTimeAsync(0);
      // Past PAY_GIVE_UP_MS: on the deferred cadence — at least one ask per 30 s, never a loop.
      const later = r.owedTries() - byGiveUp;
      expect(later).toBeGreaterThanOrEqual(3);
      expect(later).toBeLessThanOrEqual(6);
      expect(r.given).toEqual([]);
      expect(r.protocol.sentPays).toEqual([]);
      expect(r.payer.stats()).toMatchObject({ unpayableBlocks: 0, owedPaid: 0 });
      expect(r.payer.holds(NOISE, CORE_A, 7)).toBe(true); // still owed on this connection
      broke = false;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_LATER_MAX_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(r.owedCalls.map((c) => c.range)).toEqual([[7, 7]]);
      expect(r.protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([
        [7, 7],
      ]);
      expect(r.payer.stats()).toMatchObject({ unpayableBlocks: 0, owedPaid: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('owed and fresh blocks back off apart: an owed range failing for now never holds this connection’s blocks of the core back, nor the reverse', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let owedBroke = true;
      let freshBroke = false;
      const r = owedRig({
        payEveryBlocks: 1,
        failOwed: () => (owedBroke ? 'no-balance' : null),
        failFresh: () => (freshBroke ? 'mint-error' : null),
      });
      r.protocol.remoteHello(hello());
      r.protocol.remotePrice(priced);
      // Owed block 1 (lower: tried first in a pass) and this connection's block 5.
      r.payer.onDownload(CORE_A, 5, NOISE);
      expect(r.payer.addOwed(NOISE, CORE_A, [1])).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      // The owed PAY failed; block 5 was paid in the same pass.
      expect(r.protocol.sentPays.map((p) => p.range.fromBlock)).toEqual([5]);
      expect(r.payer.holds(NOISE, CORE_A, 1)).toBe(true);
      // Now this connection's PAYs fail and the owed one is built: it goes out regardless.
      freshBroke = true;
      owedBroke = false;
      r.payer.onDownload(CORE_A, 6, NOISE);
      await vi.advanceTimersByTimeAsync(PAY_RETRY_MAX_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(r.protocol.sentPays.map((p) => p.range.fromBlock)).toEqual([5, 1]);
      expect(r.payer.holds(NOISE, CORE_A, 6)).toBe(true); // backing off, still owed
      freshBroke = false;
      await vi.advanceTimersByTimeAsync(PAY_RETRY_MAX_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(r.protocol.sentPays.map((p) => p.range.fromBlock)).toEqual([5, 1, 6]);
      expect(r.given).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an owed range the seeder no longer prices on this connection is dropped from this connection only (scope connection); a final refusal drops it for good', async () => {
    const r = owedRig({ failOwed: () => null });
    const unacked = new FakePayProtocol({ autoAck: false });
    r.payer.attachPeer('cd'.repeat(32), unacked);
    unacked.remoteHello(hello());
    unacked.remotePrice(priced);
    r.payer.onDownload(CORE_A, 1, 'cd'.repeat(32));
    await r.payer.flush('cd'.repeat(32)); // block 1's PAY waits for its ACK: 7 stays pending
    expect(r.payer.addOwed('cd'.repeat(32), CORE_A, [7])).toBe(1);
    unacked.remotePrice({ ...priced, satsPerBlock: 0 as Sats, free: true });
    unacked.remoteAck({ type: 'ACK', core: CORE_A, fromBlock: 1, toBlock: 1, ok: true });
    await r.payer.flush('cd'.repeat(32));
    expect(r.given).toEqual([[7, 7]]);
    expect(r.scopes).toEqual(['connection']); // a later connection that prices it may pay it
    const f = owedRig({ failOwed: () => 'forbidden' });
    f.protocol.remoteHello(hello());
    f.protocol.remotePrice(priced);
    f.payer.addOwed(NOISE, CORE_A, [7]);
    await f.payer.flush();
    expect(f.given).toEqual([[7, 7]]);
    expect(f.scopes).toEqual([undefined]); // refused for good
  });

  it('holds(peer, core, index): pending or in the PAY awaiting its ACK on a live connection, nothing else', async () => {
    const r = owedRig();
    const u = new FakePayProtocol({ autoAck: false });
    const other = 'cd'.repeat(32);
    r.payer.attachPeer(other, u);
    u.remoteHello(hello());
    r.payer.onDownload(CORE_A, 3, other);
    expect(r.payer.holds(other, CORE_A, 3)).toBe(true); // pending
    expect(r.payer.holds(other, CORE_B, 3)).toBe(false);
    expect(r.payer.holds(NOISE, CORE_A, 3)).toBe(false); // another connection
    await r.payer.flush(other);
    expect(u.sentPays.map((p) => p.range.fromBlock)).toEqual([3]);
    expect(r.payer.holds(other, CORE_A, 3)).toBe(true); // in flight, awaiting its ACK
    u.remoteAck({ type: 'ACK', core: CORE_A, fromBlock: 3, toBlock: 3, ok: true });
    expect(r.payer.holds(other, CORE_A, 3)).toBe(false); // settled
    r.payer.onDownload(CORE_A, 4, other);
    u.remoteClose('remote');
    expect(r.payer.holds(other, CORE_A, 4)).toBe(false); // a closed connection pays nothing
  });
});

// Round-8 review (info): the payer kept every core a seeder said free (and every priced core) for
// the whole connection, unbounded, while the settler's answer is bounded at 256 — a seeder that
// said free for more than that made them disagree (blocks the settler owes, never pended).
describe('UpstreamPayer — one bounded answer for free; bounded prices (lane W8b-p2p)', () => {
  const free = (core: CoreKeyHex) =>
    ({ type: 'PRICE', core, satsPerBlock: 0 as Sats, effectiveFromBlock: 0, free: true }) as const;
  const priced = (core: CoreKeyHex) =>
    ({ type: 'PRICE', core, satsPerBlock: 3 as Sats, effectiveFromBlock: 0 }) as const;
  const coreN = (n: number): CoreKeyHex => n.toString(16).padStart(64, '0') as CoreKeyHex;

  it('with servesFree, that is the answer: a core the downloader no longer counts free is pended and paid', async () => {
    let settlerSaysFree = true;
    const { payer, protocol } = unit(1);
    const withOption = new UpstreamPayer({
      engine: new mocks.MockPaymentEngine({ mode: 'honest' }),
      logger: capturedLogger().logger,
      payEveryBlocks: 1,
      tailMs: 0,
      ownMints: [MINT_A, MINT_B],
      policyFor: () => basePolicy(MANIFEST_PRICE),
      servesFree: () => settlerSaysFree,
    });
    const p2 = new FakePayProtocol({ autoAck: true });
    withOption.attachPeer(NOISE, p2);
    for (const pr of [protocol, p2]) {
      pr.remoteHello(hello());
      pr.remotePrice(free(CORE_A));
    }
    payer.onDownload(CORE_A, 0, NOISE);
    withOption.onDownload(CORE_A, 0, NOISE);
    expect(payer.holds(NOISE, CORE_A, 0)).toBe(false);
    expect(withOption.holds(NOISE, CORE_A, 0)).toBe(false);
    // The settler forgot the word (its bound): the payer follows it, not its own set.
    settlerSaysFree = false;
    withOption.onDownload(CORE_A, 1, NOISE);
    expect(withOption.holds(NOISE, CORE_A, 1)).toBe(true);
    await withOption.flush();
    expect(p2.sentPays.map((m) => m.range.fromBlock)).toEqual([1]);
  });

  it('its own set of free words is bounded like the settler’s (oldest first), and so is its price map', () => {
    const { payer, protocol } = unit(1);
    protocol.remoteHello(hello());
    protocol.remotePrice(free(coreN(0)));
    for (let i = 1; i <= MAX_FREE_CORES_PER_SEEDER; i++) protocol.remotePrice(free(coreN(i)));
    // core 0 is the oldest word: forgotten, its blocks are owed again; core 1 is still free.
    payer.onDownload(coreN(0), 0, NOISE);
    payer.onDownload(coreN(1), 0, NOISE);
    expect(payer.holds(NOISE, coreN(0), 0)).toBe(true);
    expect(payer.holds(NOISE, coreN(1), 0)).toBe(false);
    // Prices: the oldest priced core past the bound is forgotten (no owed blocks taken for it).
    const r = owedRigLike();
    r.protocol.remoteHello(hello());
    for (let i = 0; i <= MAX_PRICED_CORES_PER_SEEDER; i++) r.protocol.remotePrice(priced(coreN(i)));
    expect(r.payer.addOwed(NOISE, coreN(0), [1])).toBe(0);
    expect(r.payer.addOwed(NOISE, coreN(1), [1])).toBe(1);
  });

  function owedRigLike() {
    const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
    const payer = new UpstreamPayer({
      engine,
      logger: capturedLogger().logger,
      payEveryBlocks: 4,
      tailMs: 0,
      ownMints: [MINT_A, MINT_B],
      policyFor: () => basePolicy(MANIFEST_PRICE),
      owed: {
        policyFor: () => basePolicy(MANIFEST_PRICE),
        pay: (r, s, p, o) => engine.pay(r, s, p, o),
      },
    });
    const protocol = new FakePayProtocol({ autoAck: false });
    payer.attachPeer(NOISE, protocol);
    return { payer, protocol };
  }
});
