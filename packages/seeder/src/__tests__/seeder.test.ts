import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mocks } from '@sovit/core';
import type { PricePolicy } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { Seeder } from '../seeder.js';
import type { SeederEvent } from '../seeder.js';
import { toHex } from '../util/hex.js';
import { FakePayProtocol, hello } from './fake-pay-protocol.js';
import { FakeStream, adapters, capturedLogger, noiseKey, pubkey, tmpDir } from './helpers.js';

const BLOCK = 1024;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function make(
  opts: {
    windowBlocks?: number;
    maxStreams?: number;
    maxStreamsPerKey?: number;
    diskCapBytes?: number;
    dataDir?: string;
    mode?: mocks.MockPaymentMode;
  } = {},
) {
  const t = opts.dataDir ? null : await tmpDir();
  const engine = new mocks.MockPaymentEngine({
    mode: 'honest',
    config: { windowBlocks: opts.windowBlocks ?? 4 },
  });
  const log = capturedLogger();
  const events: SeederEvent[] = [];
  const seeder = await Seeder.create(
    {
      dataDir: opts.dataDir ?? t!.dir,
      diskCapBytes: opts.diskCapBytes ?? 64 * BLOCK,
      blockSize: BLOCK,
      swarm: null,
      rateLimits: {
        maxStreams: opts.maxStreams ?? 8,
        maxStreamsPerKey: opts.maxStreamsPerKey ?? 2,
        connectsPerWindow: 100,
        windowMs: 1000,
      },
      flushEveryBlocks: 1000,
      flushEveryMs: 60_000,
    },
    { engine, logger: log.logger, ...adapters },
  );
  seeder.on((e) => events.push(e));
  cleanups.push(async () => {
    await seeder.close();
    if (t) await t.rm();
  });
  return { seeder, engine, log, events };
}

describe('Seeder façade', () => {
  it('persists blobs + CAS index + disk usage across a restart and enforces the cap after reload', async () => {
    const first = await make({ diskCapBytes: 5 * BLOCK });
    const dataDir = first.seeder.config.dataDir;
    const a = await first.seeder.putBytes(new Uint8Array(3 * BLOCK).fill(1));
    expect(a.ok).toBe(true);
    expect(first.events.filter((e) => e.type === 'blob-added')).toHaveLength(1);
    expect(first.seeder.stats()).toMatchObject({
      blobs: 1,
      usedBytes: 3 * BLOCK,
      capBytes: 5 * BLOCK,
      cores: 1,
    });
    await first.seeder.index.flushed();
    await first.seeder.close();

    const second = await make({ diskCapBytes: 5 * BLOCK, dataDir });
    expect(second.seeder.stats()).toMatchObject({ blobs: 1, usedBytes: 3 * BLOCK });
    if (!a.ok) return;
    expect(second.seeder.blob(a.entry.sha256)?.blob).toEqual(a.entry.blob);
    await second.seeder.openCore();
    const back = await second.seeder.getBlob(a.entry.sha256);
    expect(back?.byteLength).toBe(3 * BLOCK);
    const tooBig = await second.seeder.putBytes(new Uint8Array(3 * BLOCK).fill(2));
    expect(tooBig).toMatchObject({ ok: false, error: { code: 'disk-cap' } });
    const fits = await second.seeder.putBytes(new Uint8Array(2 * BLOCK).fill(2));
    expect(fits.ok).toBe(true);
    expect(await second.seeder.removeBlob(a.entry.sha256)).toBe(true);
    expect(second.events.at(-1)).toMatchObject({ type: 'blob-removed', sha256: a.entry.sha256 });
    expect(second.seeder.stats().usedBytes).toBe(2 * BLOCK);
    expect(second.seeder.listBlobs()).toHaveLength(1);
  });

  it('logs (redacted) and survives corrupt state files', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    await writeFile(path.join(t.dir, 'bans.json'), 'garbage');
    await writeFile(path.join(t.dir, 'cas-index.json'), '[]');
    const s = await make({ dataDir: t.dir });
    expect(s.log.records.filter((r) => r.level === 'error').map((r) => r.msg)).toEqual([
      'ban list on disk was unreadable; starting with an empty list',
      'CAS index on disk was unreadable; starting with an empty index',
    ]);
    expect(s.seeder.bans()).toHaveLength(0);
  });

  it('enforces the global stream cap and per-key cap at admission and emits refusals', async () => {
    const s = await make({ maxStreams: 3, maxStreamsPerKey: 1 });
    const streams = [1, 1, 2, 3, 4].map((k) => new FakeStream(noiseKey(k)));
    const admitted = streams.map((st) => s.seeder.sessions.admit(st));
    expect(admitted.map((x) => x !== null)).toEqual([true, false, true, true, false]);
    expect(streams[1]!.destroyed).toBe(true); // per-key cap
    expect(streams[4]!.destroyed).toBe(true); // global cap
    const refused = s.events.filter(
      (e): e is Extract<SeederEvent, { type: 'session-refused' }> => e.type === 'session-refused',
    );
    expect(refused.map((r) => r.reason)).toEqual(['per-key-cap', 'global-cap']);
    expect(s.seeder.stats().sessions).toBe(3);
    // releasing one slot lets the next in
    streams[2]!.destroy();
    await streams[2]!.closed();
    expect(s.seeder.stats().sessions).toBe(2);
    expect(s.seeder.sessions.admit(new FakeStream(noiseKey(4)))).not.toBeNull();
    expect(s.events.filter((e) => e.type === 'session-close')).toHaveLength(1);
  });

  it('manual ban/unban covers the engine, the sessions and disk; banned keys are refused', async () => {
    const s = await make();
    const st = new FakeStream(noiseKey(9));
    const session = s.seeder.sessions.admit(st)!;
    const pk = pubkey('manual');
    session.bindPubkey(pk);
    s.seeder.ban({ pubkey: pk, noiseKey: noiseKey(9) }, 'operator');
    expect(st.destroyed).toBe(true);
    expect(s.engine.isBanned(pk)).toBe(true);
    expect(s.seeder.bans()).toEqual([
      expect.objectContaining({ pubkey: pk, noiseKey: toHex(noiseKey(9)), reason: 'operator' }),
    ]);
    await st.closed();
    expect(s.seeder.sessions.admit(new FakeStream(noiseKey(9)))).toBeNull();
    expect(s.seeder.unban({ pubkey: pk })).toBe(true);
    expect(s.engine.isBanned(pk)).toBe(false);
    expect(s.seeder.sessions.admit(new FakeStream(noiseKey(9)))).not.toBeNull();
  });

  it('a double-spend (v5: refused at verify) bans the peer on both keys and cuts its session', async () => {
    const s = await make({ windowBlocks: 8 });
    const viewer = new mocks.MockPaymentEngine({ mode: 'double-spend' });
    const policy: PricePolicy = {
      satsPerBlock: 1 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    s.seeder.setPolicy(policy);
    const st = new FakeStream(noiseKey(5));
    const session = s.seeder.sessions.admit(st)!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    const pk = pubkey('ds');
    protocol.remoteHello(hello(pk));
    const core = mocks.asCoreKey('c');
    for (let i = 0; i < 8; i++) session.onUpload(core, i, BLOCK);
    const ref = {
      pubkey: s.engine.config.ownPubkey,
      p2pk: s.engine.config.ownP2pk,
      mint: policy.mints[0]!,
    };
    protocol.remotePay(await viewer.pay({ core, fromBlock: 0, toBlock: 3 }, ref, policy));
    await new Promise((r) => setTimeout(r, 0));
    protocol.remotePay(await viewer.pay({ core, fromBlock: 4, toBlock: 7 }, ref, policy));
    await new Promise((r) => setTimeout(r, 0));
    // v5: the replay is refused at verify, the engine bans and fires `onDoubleSpend`, and the
    // seeder cuts the session before the bridge can ACK it (a cut session gets no ACK).
    expect(protocol.acks.map((a) => (a.ok ? 'ok' : a.reason))).toEqual(['ok']);
    expect(st.destroyed).toBe(true);
    expect(session.cutReason).toBe('banned');
    expect(s.seeder.stats().pendingPaidBlocks).toBe(4);

    const res = await s.seeder.flushNow();
    expect(res).toMatchObject({ failed: 0, swapped: 2, nutzapped: 2 }); // 4 blocks × 1 sat, split 50/50
    expect(s.seeder.banList.isPubkeyBanned(pk)).toBe(true);
    expect(s.seeder.banList.isNoiseBanned(noiseKey(5))).toBe(true);
    const ds = s.events.find((e) => e.type === 'double-spend');
    expect(ds).toMatchObject({ peer: pk, amount: 4 });
    expect(s.events.some((e) => e.type === 'flush')).toBe(true);
    const all = s.log.lines.join('\n');
    expect(all).not.toContain('mock:');
    expect(all).toContain('double-spend');
  });

  it('setPolicy announces PRICE to live pay/1 peers — one per core on the default policy (v5: PRICE names its core) — with the old price honoured for uploaded blocks', async () => {
    const s = await make();
    const st = new FakeStream(noiseKey(6));
    const session = s.seeder.sessions.admit(st)!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    for (let i = 0; i < 3; i++) session.onUpload('c', i, BLOCK);
    const base: PricePolicy = {
      satsPerBlock: 1 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    s.seeder.setPolicy(base);
    s.seeder.setPolicy(base); // unchanged price: no announcement
    s.seeder.setPolicy({ ...base, satsPerBlock: 2 as never });
    expect(protocol.prices).toEqual([
      { type: 'PRICE', core: 'c', satsPerBlock: 2, effectiveFromBlock: 3 },
    ]);
    expect(s.seeder.policy().satsPerBlock).toBe(2);
  });

  // Security review F9: the seeder used to verify every PAY at its CURRENT price, so after a
  // price change an honest viewer's PAY for blocks sent earlier (at the old price, as the PRICE
  // promised) was `wrong-amount` — and enough of those window-cut the viewer.
  it('F9: blocks sent before a PRICE are verified at the old price, blocks after it at the new one; setCorePolicy announces per core', async () => {
    const s = await make({ windowBlocks: 16 });
    const viewer = new mocks.MockPaymentEngine({ mode: 'honest' });
    const oldP: PricePolicy = {
      satsPerBlock: 2 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    const newP: PricePolicy = { ...oldP, satsPerBlock: 4 as never };
    const core = mocks.asCoreKey('F9');
    s.seeder.setPolicy(oldP);
    const session = s.seeder.sessions.admit(new FakeStream(noiseKey(9)))!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    protocol.remoteHello(hello(pubkey('f9')));
    for (let i = 0; i < 3; i++) session.onUpload(core, i, BLOCK);
    s.seeder.setPolicy(newP);
    expect(protocol.prices).toEqual([
      { type: 'PRICE', core, satsPerBlock: 4, effectiveFromBlock: 3 },
    ]);
    for (let i = 3; i < 6; i++) session.onUpload(core, i, BLOCK);
    const ref = {
      pubkey: s.engine.config.ownPubkey,
      p2pk: s.engine.config.ownP2pk,
      mint: oldP.mints[0]!,
    };
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    // Old blocks at the NEW price: refused (the promise was the old price).
    protocol.remotePay(
      await viewer.pay({ core, fromBlock: 0, toBlock: 2 }, ref, newP, { carryIn: 0 }),
    );
    await tick();
    // Old blocks at the old price, new blocks at the new price: both accepted.
    protocol.remotePay(
      await viewer.pay({ core, fromBlock: 0, toBlock: 2 }, ref, oldP, { carryIn: 0 }),
    );
    await tick();
    protocol.remotePay(
      await viewer.pay({ core, fromBlock: 3, toBlock: 5 }, ref, newP, { carryIn: 0 }),
    );
    await tick();
    expect(protocol.acks.map((a) => (a.ok ? 'ok' : a.reason))).toEqual(['overpay', 'ok', 'ok']);
    expect(s.seeder.policyForRange(session, core, { core, fromBlock: 0, toBlock: 2 })).toBe(oldP);
    expect(s.seeder.policyForRange(session, core, { core, fromBlock: 3, toBlock: 5 })).toBe(newP);

    // A per-core policy change announces a PRICE for that core only.
    const other = mocks.asCoreKey('F9-other');
    session.onUpload(other, 0, BLOCK);
    s.seeder.setCorePolicy(core, { ...newP, satsPerBlock: 6 as never });
    expect(protocol.prices.at(-1)).toEqual({
      type: 'PRICE',
      core,
      satsPerBlock: 6,
      effectiveFromBlock: 6,
    });
    expect(protocol.prices.filter((p) => p.core === other)).toEqual([]);
  });

  it('v3 (c): setCorePolicy adds a per-core policy the pay bridge resolves by range.core; setPolicy stays the default', async () => {
    const s = await make({ windowBlocks: 16 });
    const viewer = new mocks.MockPaymentEngine({ mode: 'honest' });
    const base: PricePolicy = {
      satsPerBlock: 2 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator-A'),
    };
    const forB: PricePolicy = {
      ...base,
      satsPerBlock: 6 as never,
      creatorP2pk: mocks.asP2pk('creator-B'),
    };
    const coreA = mocks.asCoreKey('A');
    const coreB = mocks.asCoreKey('B');
    s.seeder.setPolicy(base);
    s.seeder.setCorePolicy(coreB, forB);
    expect(s.seeder.policyFor(coreA)).toBe(base);
    expect(s.seeder.policyFor(coreB)).toBe(forB);
    expect(s.seeder.policyFor()).toBe(base);
    expect([...s.seeder.corePolicyMap().keys()]).toEqual([coreB]);

    const st = new FakeStream(noiseKey(7));
    const session = s.seeder.sessions.admit(st)!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    protocol.remoteHello(hello(pubkey('pc')));
    for (let i = 0; i < 2; i++) session.onUpload(coreA, i, BLOCK);
    for (let i = 0; i < 2; i++) session.onUpload(coreB, i, BLOCK);
    const ref = {
      pubkey: s.engine.config.ownPubkey,
      p2pk: s.engine.config.ownP2pk,
      mint: base.mints[0]!,
    };
    // B at the default price → refused under B's policy; B at B's price → ok; A at default → ok.
    protocol.remotePay(await viewer.pay({ core: coreB, fromBlock: 0, toBlock: 1 }, ref, base));
    await new Promise((r) => setTimeout(r, 0));
    protocol.remotePay(await viewer.pay({ core: coreB, fromBlock: 0, toBlock: 1 }, ref, forB));
    await new Promise((r) => setTimeout(r, 0));
    protocol.remotePay(await viewer.pay({ core: coreA, fromBlock: 0, toBlock: 1 }, ref, base));
    await new Promise((r) => setTimeout(r, 0));
    // and a core-less PAY is malformed (v5: on any session)
    const named = await viewer.pay({ core: coreA, fromBlock: 0, toBlock: 1 }, ref, base, {
      carryIn: 0,
    });
    const { core: _core, ...coreless } = named.range;
    protocol.remotePay({ ...named, range: coreless } as unknown as typeof named);
    await new Promise((r) => setTimeout(r, 0));
    expect(protocol.acks.map((a) => (a.ok ? 'ok' : a.reason))).toEqual([
      'wrong-p2pk-target',
      'ok',
      'ok',
      'malformed',
    ]);
    expect(s.seeder.stats().pendingPaidBlocks).toBe(4);

    // clearing the override falls back to the default
    s.seeder.setCorePolicy(coreB, null);
    expect(s.seeder.policyFor(coreB)).toBe(base);
    expect(s.seeder.corePolicyMap().size).toBe(0);
  });

  it('policy() throws until configured; close() is idempotent and flushes', async () => {
    const s = await make();
    expect(() => s.seeder.policy()).toThrow(/PricePolicy/);
    await s.seeder.close();
    await s.seeder.close();
    expect(s.engine.log.filter((l) => l.kind === 'flush')).toHaveLength(1);
  });
});
