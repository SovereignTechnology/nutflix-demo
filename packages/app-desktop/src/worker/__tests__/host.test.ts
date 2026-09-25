/**
 * `WorkerHost` request handling through the real wire (`WorkerRpc` + L6-0 guards): the
 * not-initialised and no-providers (Stage 1 production) paths, the `--dev-mocks` fence at
 * `init`, session bookkeeping errors and the seeder status shape.
 */
import { randomBytes } from 'node:crypto';

import { mocks } from '@sovit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Guard } from '../../ipc/protocol.js';
import { validateWorkerResult } from '../../ipc/worker-guards.js';
import type { PlayOpenArgs, WorkerEvent } from '../../ipc/worker-protocol.js';
import type { DevTestnet } from '../dev/fixtures-net.js';
import { startDevTestnet } from '../dev/fixtures-net.js';
import { MAX_SESSIONS } from '../host.js';
import type { WorkerClient } from './helpers/harness.js';
import { startWorker, tempDir } from './helpers/harness.js';

const isStatus = validateWorkerResult['seeder.status'] as Guard<unknown>;
const sid = (): PlayOpenArgs['sid'] => randomBytes(16).toString('hex') as PlayOpenArgs['sid'];
const V = mocks.VIDEOS[0]!;
const R = V.renditions[0]!;

function open(s = sid(), core = R.hyper.core): PlayOpenArgs {
  return {
    sid: s,
    videoId: V.id,
    rendition: { label: R.label, hyper: { ...R.hyper, core }, size: R.size, bitrateKbps: 2500 },
    policy: V.price,
    prefetchSeconds: 30,
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

async function worker(): Promise<{ w: WorkerClient; storage: string }> {
  const d = await tempDir('nf-l6c-host-');
  const w = startWorker({ logLevel: 'warn' });
  cleanups.push(
    () => d.rm(),
    () => w.close(),
  );
  return { w, storage: d.dir };
}

const seeding = { enabled: false, diskCapBytes: 1024 ** 3 };

describe('before init', () => {
  it('everything but init is backend-down', async () => {
    const { w } = await worker();
    await expect(w.call('seeder.status', {})).rejects.toMatchObject({ code: 'backend-down' });
    await expect(w.call('play.open', open())).rejects.toMatchObject({ code: 'backend-down' });
  });
});

describe('Stage 1 production: no payment providers', () => {
  let w: WorkerClient;
  beforeAll(async () => {
    const r = await worker();
    w = r.w;
    await w.call('init', { v: 1, storage: r.storage, seeding, prefetchSeconds: 30 });
  });

  it('starts, says ready, and logs why it cannot pay', async () => {
    const ready = await w.event((e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready');
    expect(ready.port).toBeGreaterThan(0);
    expect(
      w.events.some(
        (e) => e.e === 'log' && e.level === 'warn' && e.msg.includes('payments-unavailable'),
      ),
    ).toBe(true);
  });

  it('refuses to play or upload (payments-unavailable) and to melt', async () => {
    await expect(w.call('play.open', open())).rejects.toMatchObject({
      code: 'payments-unavailable',
    });
    await expect(
      w.call('studio.upload', {
        uploadId: 'fedcba9876543210fedcba9876543210' as never,
        path: '/tmp/x.mp4',
        name: 'x.mp4',
        meta: {
          title: 't',
          description: '',
          tags: [],
          kind: 21,
          mints: [mocks.MINTS.a],
          satsPerBlock: mocks.sats(2),
          split: { seeder: 50, creator: 50 },
        },
      }),
    ).rejects.toMatchObject({ code: 'payments-unavailable' });
    await expect(
      w.call('seeder.melt', { mint: mocks.MINTS.a, bolt11: 'lnbc1mock' }),
    ).rejects.toMatchObject({ code: 'payments-unavailable' });
  });

  it('still answers status / configure / unban / ffmpeg', async () => {
    const s = await w.call('seeder.status', {});
    expect(isStatus(s)).toBe(true);
    expect(s).toMatchObject({ enabled: false, pubkey: '00'.repeat(32), videos: 0 });
    await w.call('seeder.configure', { enabled: true, diskCapBytes: 5 });
    await w.call('seeder.unban', { pubkey: mocks.asPubkey('x') });
    const ff = await w.call('studio.ffmpeg', { recheck: true, path: '/nonexistent/bin/ffmpeg' });
    expect(ff).toMatchObject({ found: false, path: '/nonexistent/bin/ffmpeg' });
    expect(w.invalid).toEqual([]);
  });

  it('refuses a second init', async () => {
    await expect(
      w.call('init', { v: 1, storage: '/tmp/other', seeding, prefetchSeconds: 30 }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('the --dev-mocks fence at init', () => {
  it.each([
    ['mocks without a loopback bootstrap', { mocks: true, fixtures: false }],
    ['fixtures without mocks', { mocks: false, fixtures: true }],
  ])('refuses %s', async (_n, dev) => {
    const { w, storage } = await worker();
    await expect(
      w.call('init', { v: 1, storage, seeding, prefetchSeconds: 30, dev }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(w.events.some((e) => e.e === 'ready')).toBe(false);
  });

  it('a non-loopback bootstrap never even reaches the worker (the guard refuses it)', async () => {
    const { w, storage } = await worker();
    await expect(
      w.call('init', {
        v: 1,
        storage,
        seeding,
        prefetchSeconds: 30,
        dev: {
          mocks: true,
          fixtures: false,
          bootstrap: [{ host: '10.0.0.1' as '127.0.0.1', port: 1 }],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('play sessions (dev mocks on a local testnet)', () => {
  let testnet: DevTestnet;
  let w: WorkerClient;
  beforeAll(async () => {
    testnet = await startDevTestnet();
    cleanups.push(() => testnet.destroy());
    const r = await worker();
    w = r.w;
    await w.call('init', {
      v: 1,
      storage: r.storage,
      seeding,
      prefetchSeconds: 30,
      dev: {
        mocks: true,
        fixtures: false,
        bootstrap: testnet.bootstrap.map((b) => ({ host: '127.0.0.1' as const, port: b.port })),
      },
    });
  }, 30_000);

  it('opens, refuses duplicates and bad sizes, closes idempotently, unknown sid = session-closed', async () => {
    const s = sid();
    const r = await w.call('play.open', open(s));
    expect(r.key).toBe(R.hyper.core);
    await expect(w.call('play.open', open(s))).rejects.toMatchObject({ code: 'invalid-argument' });
    const bad = open();
    await expect(
      w.call('play.open', {
        ...bad,
        rendition: { ...bad.rendition, size: bad.rendition.size + 1 },
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await w.call('play.pause', { sid: s });
    await w.call('play.prefetch', { sid: s, seconds: 5 });
    await w.call('play.resume', { sid: s });
    await w.call('play.close', { sid: s });
    await w.call('play.close', { sid: s });
    for (const m of ['play.pause', 'play.resume'] as const)
      await expect(w.call(m, { sid: s })).rejects.toMatchObject({ code: 'session-closed' });
    await expect(w.call('play.prefetch', { sid: s, seconds: 1 })).rejects.toMatchObject({
      code: 'session-closed',
    });
  });

  it(`caps live sessions at ${String(MAX_SESSIONS)} (rate-limited) and frees on close`, async () => {
    const sids: PlayOpenArgs['sid'][] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const s = sid();
      sids.push(s);
      await w.call('play.open', open(s, randomBytes(32).toString('hex') as never));
    }
    await expect(w.call('play.open', open())).rejects.toMatchObject({ code: 'rate-limited' });
    await w.call('play.close', { sid: sids[0]! });
    const s = sid();
    await w.call('play.open', open(s));
    for (const x of [...sids.slice(1), s]) await w.call('play.close', { sid: x });
  }, 30_000);

  it('F33: a core the one-peer router refuses is not marked attached — a retry is refused too (fail closed)', async () => {
    const payer = w.host.internals.payer!;
    const attach = payer.attachCore.bind(payer);
    let calls = 0;
    let refuse = true;
    payer.attachCore = (core) => {
      calls++;
      if (refuse) throw new Error('routing-unsupported: not the pinned hypercore');
      return attach(core);
    };
    try {
      const core = randomBytes(32).toString('hex') as never;
      await expect(w.call('play.open', open(sid(), core))).rejects.toMatchObject({
        code: 'internal',
      });
      // Not "already attached": the retry asks the router again, and is refused again.
      await expect(w.call('play.open', open(sid(), core))).rejects.toMatchObject({
        code: 'internal',
      });
      expect(calls).toBe(2);
      refuse = false;
      const s = sid();
      await w.call('play.open', open(s, core));
      expect(calls).toBe(3);
      await w.call('play.close', { sid: s });
    } finally {
      payer.attachCore = attach;
    }
  });

  it('reports a valid seeder status and pushes it after changes', async () => {
    const s = await w.call('seeder.status', {});
    expect(isStatus(s)).toBe(true);
    expect(s.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(s.pubkey).not.toBe('00'.repeat(32));
    await w.call('seeder.configure', { enabled: true, diskCapBytes: 1024 ** 3 });
    const ev = await w.event(
      (e): e is Extract<WorkerEvent, { e: 'seeder.status' }> =>
        e.e === 'seeder.status' && e.status.enabled,
      5000,
      'seeder.status push',
    );
    expect(isStatus(ev.status)).toBe(true);
    expect(w.invalid).toEqual([]);
  });
});
