/**
 * The `--dev-mocks` pieces: the fence (D1: never mock payments on a public DHT), the loopback
 * `pay/1` hub, and the dev engine — since contracts v5 the plain `MockPaymentEngine`.
 */
import { EventEmitter } from 'node:events';

import type { HelloMessage, PricePolicy } from '@sovit/core';
import { mocks } from '@sovit/core';
import type { ReplicationStream } from 'hypercore';
import { describe, expect, it } from 'vitest';

import type { WorkerInit } from '../../ipc/worker-protocol.js';
import { DEV_PRICE, checkDevFence, devEngine, devHello, devIdentity } from '../dev/dev-mocks.js';
import { LoopbackPayHub } from '../dev/loopback-pay.js';

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('the --dev-mocks fence', () => {
  const ok: NonNullable<WorkerInit['dev']>[] = [
    { mocks: true, fixtures: true },
    { mocks: true, fixtures: false, bootstrap: [{ host: '127.0.0.1', port: 49737 }] },
    { mocks: false, fixtures: false },
  ];
  it.each(ok)('accepts %o', (dev) => {
    expect(() => {
      checkDevFence(dev);
    }).not.toThrow();
  });
  const refused: [string, unknown][] = [
    ['mocks on the public DHT', { mocks: true, fixtures: false }],
    ['fixtures without mocks', { mocks: false, fixtures: true }],
    [
      'a bootstrap without mocks',
      { mocks: false, fixtures: false, bootstrap: [{ host: '127.0.0.1', port: 1 }] },
    ],
    [
      'a LAN bootstrap',
      { mocks: true, fixtures: false, bootstrap: [{ host: '192.168.1.2', port: 1 }] },
    ],
    [
      'localhost by name',
      { mocks: true, fixtures: false, bootstrap: [{ host: 'localhost', port: 1 }] },
    ],
    ['a bad port', { mocks: true, fixtures: false, bootstrap: [{ host: '127.0.0.1', port: 0 }] }],
  ];
  it.each(refused)('refuses %s', (_name, dev) => {
    expect(() => {
      checkDevFence(dev as WorkerInit['dev']);
    }).toThrow(/^invalid-argument: /);
  });
});

describe('dev identities', () => {
  it('are deterministic, distinct and correctly shaped (never keys: nothing signs with them)', () => {
    const a = devIdentity('s1');
    expect(devIdentity('s1')).toEqual(a);
    expect(devIdentity('s2').pubkey).not.toBe(a.pubkey);
    expect(a.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.p2pk).toMatch(/^02[0-9a-f]{64}$/);
    const h = devHello(devEngine('x'), {
      satsPerBlock: DEV_PRICE,
      split: { seeder: 50, creator: 50 },
    });
    expect(h.signature).toBe('dev-unsigned');
    expect(DEV_PRICE).toBe(2);
  });
});

function stream(): ReplicationStream & EventEmitter {
  return new EventEmitter() as ReplicationStream & EventEmitter;
}

describe('LoopbackPayHub (D1)', () => {
  const A = 'aa'.repeat(32);
  const B = 'bb'.repeat(32);

  it('pairs the two ends of ONE connection (by handshake hash) and delivers in order, cloned', async () => {
    const hub = new LoopbackPayHub();
    const sa = stream();
    const sb = stream();
    const a = hub.endpoint({ connectionId: 'c1', localNoise: A, remoteNoise: B, stream: sa });
    const hello: Omit<HelloMessage, 'type'> = devHello(devEngine('a'), {
      satsPerBlock: DEV_PRICE,
      split: { seeder: 50, creator: 50 },
    });
    a.sendHello(hello); // queued: B has not registered yet
    const b = hub.endpoint({ connectionId: 'c1', localNoise: B, remoteNoise: A, stream: sb });
    const got: string[] = [];
    b.on('open', (h) => got.push(`hello:${h.pubkey.slice(0, 4)}`));
    b.on('ack', (x) => got.push(`ack:${String(x.fromBlock)}`));
    const core = mocks.asCoreKey('c');
    a.sendAck({ core, fromBlock: 1, toBlock: 1, ok: true });
    a.sendAck({ core, fromBlock: 2, toBlock: 2, ok: true });
    await tick();
    expect(got).toEqual([`hello:${hello.pubkey.slice(0, 4)}`, 'ack:1', 'ack:2']);
    expect(b.peer).not.toBe(hello); // structured clone, not a shared object
    b.sendHello(hello);
    await tick();
    expect(a.state).toBe('open');
    expect(hub.size).toBe(2);
  });

  it('never pairs ends of different connections, and a closed connection closes its partner', async () => {
    const hub = new LoopbackPayHub();
    const s1 = stream();
    const a1 = hub.endpoint({ connectionId: 'c1', localNoise: A, remoteNoise: B, stream: s1 });
    const b2 = hub.endpoint({
      connectionId: 'c2',
      localNoise: B,
      remoteNoise: A,
      stream: stream(),
    });
    expect(a1.other).toBeNull();
    expect(b2.other).toBeNull();
    const b1 = hub.endpoint({
      connectionId: 'c1',
      localNoise: B,
      remoteNoise: A,
      stream: stream(),
    });
    const closed: string[] = [];
    b1.on('close', (r) => closed.push(r));
    s1.emit('close');
    await tick();
    expect(a1.state).toBe('closed');
    expect(closed).toEqual(['remote']);
    a1.sendPay({} as never); // after close: dropped
    expect(hub.size).toBe(2);
  });
});

describe('the dev engine is the plain v5 MockPaymentEngine (the Stage 1 DevEngine workarounds are no longer needed)', () => {
  const core = mocks.asCoreKey('c');
  const id = devIdentity('seeder');
  // A wide window so the setup can record 16 unpaid uploads without the peer being cut.
  const seeder = new mocks.MockPaymentEngine({
    config: { windowBlocks: 64, ownPubkey: id.pubkey, ownP2pk: id.p2pk },
  });
  const policy: PricePolicy = {
    satsPerBlock: mocks.sats(2),
    blockSize: 65_536,
    mints: [mocks.MINTS.a],
    split: { seeder: 50, creator: 50 },
    creatorP2pk: devIdentity('creator').p2pk,
  };
  const to = { pubkey: seeder.config.ownPubkey, p2pk: seeder.config.ownP2pk, mint: mocks.MINTS.a };
  const sent = (
    s: mocks.MockPaymentEngine,
    peer: typeof id.pubkey,
    from: number,
    to_: number,
  ): void => {
    for (let i = from; i <= to_; i++)
      s.recordUpload(peer, { core, fromBlock: i, toBlock: i }, policy);
  };

  it('pays a peer for blocks [16, 32) it received (the v4 mock refused: 16 >= 16) — per block, never more than was sent', async () => {
    const viewer = devEngine('viewer');
    const v = viewer.config.ownPubkey;
    sent(seeder, v, 16, 31);
    const msg = await viewer.pay({ core, fromBlock: 16, toBlock: 17 }, to, policy);
    expect(await seeder.verify(v, msg, policy)).toMatchObject({ ok: true, blocks: 2, credited: 4 });
    // Replay on the real indexes.
    const again = await viewer.pay({ core, fromBlock: 17, toBlock: 17 }, to, policy, {
      carryIn: 0,
    });
    expect(await seeder.verify(v, again, policy)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
    // Block 32 was never sent.
    const tooMany = await viewer.pay({ core, fromBlock: 18, toBlock: 32 }, to, policy, {
      carryIn: 0,
    });
    expect(await seeder.verify(v, tooMany, policy)).toMatchObject({
      ok: false,
      reason: 'range-not-uploaded',
    });
    const rest = await viewer.pay({ core, fromBlock: 18, toBlock: 31 }, to, policy, { carryIn: 0 });
    expect(await seeder.verify(v, rest, policy)).toMatchObject({ ok: true, blocks: 14 });
    expect(seeder.window(v)).toMatchObject({ uploaded: 16, paid: 16, outstanding: 0 });
  });

  it('keeps the money rules (amount, targets) and moves state on rebind', async () => {
    const viewer = devEngine('viewer-2');
    const noise = mocks.asPubkey('noise');
    sent(seeder, noise, 0, 1);
    const under = { ...(await viewer.pay({ core, fromBlock: 0, toBlock: 1 }, to, policy)) };
    expect(
      await seeder.verify(noise, under, { ...policy, satsPerBlock: mocks.sats(4) }),
    ).toMatchObject({
      ok: false,
      reason: 'wrong-amount',
    });
    const real = viewer.config.ownPubkey;
    seeder.rebind(noise, real);
    expect(await seeder.verify(real, under, policy)).toMatchObject({ ok: true });
    expect(await seeder.verify(real, under, policy)).toMatchObject({
      reason: 'range-already-paid',
    });
  });

  it('two wallets never mint colliding secrets (no false double-spend); a real replay is caught at verify', async () => {
    const s = devEngine('seeder-3');
    const dest = { pubkey: s.config.ownPubkey, p2pk: s.config.ownP2pk, mint: mocks.MINTS.a };
    const w1 = devEngine('w1');
    const w2 = devEngine('w2');
    for (const w of [w1, w2]) {
      sent(s, w.config.ownPubkey, 0, 0);
      expect(
        await s.verify(
          w.config.ownPubkey,
          await w.pay({ core, fromBlock: 0, toBlock: 0 }, dest, policy),
          policy,
        ),
      ).toMatchObject({ ok: true });
    }
    expect((await s.flush()).failed).toBe(0);
    const cheat = devEngine('cheat');
    cheat.mode = 'double-spend';
    const c = cheat.config.ownPubkey;
    sent(s, c, 0, 1);
    await s.verify(c, await cheat.pay({ core, fromBlock: 0, toBlock: 0 }, dest, policy), policy);
    expect(
      await s.verify(c, await cheat.pay({ core, fromBlock: 1, toBlock: 1 }, dest, policy), policy),
    ).toMatchObject({ ok: false, reason: 'double-spend' });
    expect(s.isBanned(c)).toBe(true);
  });
});
