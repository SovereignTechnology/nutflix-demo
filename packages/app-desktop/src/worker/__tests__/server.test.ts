/**
 * The playback server's allowlist (design §3 "Worker playback server"): only a live session's
 * exact `(path token, core, blob, video/mp4)` is served; everything else is a 404 decided by
 * `resolve()` BEFORE the store is asked for anything (so no core is ever opened for it). Plus
 * the day-1 probe's checks run under Node (`bare-probe.test.ts` runs them under Bare).
 */
import http from 'node:http';

import { mocks } from '@sovit/core';
import { Seeder, nodeFs, silentLogger } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Guard } from '../../ipc/protocol.js';
import { validateWorkerResult } from '../../ipc/worker-guards.js';
import { randomHex, sodiumCrypto } from '../crypto.js';
import { CreditPool } from '../playback/credit.js';
import { PlaybackGate } from '../playback/gate.js';
import { PlaybackServer } from '../playback/server.js';
import { runProbe } from '../probe.js';
import type { ProbeHttpResponse } from '../probe.js';
import { httpGet, nodeRuntime, tempDir } from './helpers/harness.js';

function request(url: string, method: string): Promise<number | 'reset'> {
  return new Promise((resolve) => {
    const req = http.request(url, { method, agent: false }, (res) => {
      res.resume();
      res.on('end', () => {
        resolve(res.statusCode ?? 0);
      });
    });
    req.on('error', () => {
      resolve('reset');
    });
    req.end();
  });
}

describe('playback server allowlist', () => {
  let dir: { dir: string; rm: () => Promise<void> };
  let seeder: Seeder;
  let server: PlaybackServer;
  let gate: PlaybackGate;
  let link = '';
  const SID = randomHex(16);
  const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) & 0xff);

  beforeAll(async () => {
    dir = await tempDir('nf-l6c-server-');
    seeder = await Seeder.create(
      { dataDir: dir.dir, diskCapBytes: 1 << 24, swarm: null },
      {
        engine: new mocks.MockPaymentEngine(),
        fs: nodeFs,
        crypto: sodiumCrypto,
        logger: silentLogger,
      },
    );
    const put = await seeder.putBytes(bytes);
    if (!put.ok) throw new Error('put');
    const sc = seeder.blobs.coreByKey(put.entry.coreKey)!;
    gate = new PlaybackGate({
      core: sc.core,
      blob: put.entry.blob,
      blockSize: 65_536,
      bytesPerSec: 1e6,
      prefetchSeconds: 5,
      credit: new CreditPool(4),
      logger: silentLogger,
    });
    server = new PlaybackServer({ logger: silentLogger, randomHex });
    expect(() => server.register(SID, put.entry.coreKey, put.entry.blob, gate)).toThrow(
      /not listening/,
    );
    await server.listen();
    link = server.register(SID, put.entry.coreKey, put.entry.blob, gate);
    expect(() => server.register(SID, put.entry.coreKey, put.entry.blob, gate)).toThrow(
      /^invalid-argument/,
    );
  });
  afterAll(async () => {
    await server.close();
    await server.close();
    await seeder.close();
    await dir.rm();
  });

  it('hands out a loopback link the host guard accepts', () => {
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\?key=/);
    expect(link).toContain('type=video%2Fmp4');
    const ok = validateWorkerResult['play.open'] as Guard<unknown>;
    expect(ok({ key: 'ab'.repeat(32), link })).toBe(true);
  });

  it('serves the session: GET 200, HEAD, ranges', async () => {
    const full = await httpGet(link);
    expect(full.status).toBe(200);
    expect(Buffer.compare(full.body, Buffer.from(bytes))).toBe(0);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(await request(link, 'HEAD')).toBe(200);
    const r = await httpGet(link, { range: 'bytes=65530-65545' });
    expect(r.status).toBe(206);
    expect(Buffer.compare(r.body, Buffer.from(bytes.subarray(65_530, 65_546)))).toBe(0);
  });

  it('refuses everything that is not exactly the live session — without touching the store', async () => {
    const before = server.stats();
    const variants = [
      link.replace('type=video%2Fmp4', 'type=text%2Fhtml'), // content type is fixed
      link.replace(/token=[^&]+/, `token=${randomHex(32)}`), // wrong server token
      link.replace(/&token=[^&]+/, ''), // no token
      link.replace(/blob=[^&]+/, 'blob=yyyyyyy'), // another blob id
      link.replace(/key=[^&]+/, `key=${randomHex(32)}`), // another core
      link.replace(/\/[0-9a-f]{32}\?/, `/${randomHex(16)}?`), // unknown session
      link.replace(/\/[0-9a-f]{32}\?/, '/?'), // no session at all
      link.replace(/\/[0-9a-f]{32}\?.*$/, '/video.mp4'), // drive-style path
      `${link.slice(0, link.indexOf('/', 8))}/?pointer=1&type=video%2Fmp4`, // blob cache pointer
    ];
    for (const v of variants) expect((await httpGet(v)).status, v).toBe(404);
    expect(server.stats().admitted).toBe(before.admitted);
    expect(await request(link, 'POST')).not.toBe(200);
    expect(await request(link, 'DELETE')).not.toBe(200);
  });

  it('a revoked (closed) session is a 404 immediately', async () => {
    const s2 = randomHex(16);
    const entry = seeder.listBlobs()[0]!;
    const g2 = new PlaybackGate({
      core: seeder.blobs.coreByKey(entry.coreKey)!.core,
      blob: entry.blob,
      blockSize: 65_536,
      bytesPerSec: 1e6,
      prefetchSeconds: 5,
      credit: new CreditPool(4),
      logger: silentLogger,
    });
    const l2 = server.register(s2, entry.coreKey, entry.blob, g2);
    expect((await httpGet(l2, { range: 'bytes=0-0' })).status).toBe(206);
    g2.close(); // closed but not yet unregistered: still refused
    expect((await httpGet(l2, { range: 'bytes=0-0' })).status).toBe(404);
    server.unregister(s2);
    server.unregister(s2);
    expect((await httpGet(l2)).status).toBe(404);
    // Another session on the same blob keeps working: links are per session.
    expect((await httpGet(link, { range: 'bytes=0-0' })).status).toBe(206);
  });
});

describe('day-1 probe steps under Node (the Bare run is bare-probe.test.ts)', () => {
  it('passes every step', async () => {
    const dir = await tempDir('nf-l6c-probe-');
    try {
      const report = await runProbe({
        runtime: nodeRuntime(),
        dir: dir.dir,
        httpGet: async (url, headers): Promise<ProbeHttpResponse> => {
          const r = await httpGet(url, { ...headers });
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(r.headers)) if (typeof v === 'string') h[k] = v;
          return { status: r.status, headers: h, body: new Uint8Array(r.body) };
        },
      });
      expect(report.steps.filter((s) => !s.ok)).toEqual([]);
      expect(report.steps.find((s) => s.name === 'imports: @sovit/seeder')?.detail).toBe(
        'node entry',
      );
    } finally {
      await dir.rm();
    }
  });
});
