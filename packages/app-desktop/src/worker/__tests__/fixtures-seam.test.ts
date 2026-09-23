/**
 * The §5(b) dev fixture seam: `NUTFLIX_DEV_FIXTURES_JSON` (what L6-A's `e2e/stage1.e2e.ts`
 * passes) makes `--dev-fixtures` publish exactly those files — titles, descriptions, bytes —
 * through the in-process fixture seeders, playable over the worker's playback server.
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import { DEV_FIXTURES_ENV, parseDevFixturesEnv } from '../dev/fixtures-net.js';
import { httpGet, nodeRuntime, startWorker, tempDir } from './helpers/harness.js';

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

describe('parseDevFixturesEnv', () => {
  it('accepts the e2e shape and ignores unknown keys', () => {
    expect(
      parseDevFixturesEnv(
        JSON.stringify([
          { path: '/tmp/a.mp4', title: 'A', description: 'See [docs](https://x.example).', x: 1 },
          { path: 'C:\\v\\b.mp4', title: 'B' },
        ]),
      ),
    ).toEqual([
      { path: '/tmp/a.mp4', title: 'A', description: 'See [docs](https://x.example).' },
      { path: 'C:\\v\\b.mp4', title: 'B' },
    ]);
  });
  it.each([
    undefined,
    '',
    'not json',
    '{}',
    '[]',
    JSON.stringify([{ path: 'relative.mp4', title: 'A' }]),
    JSON.stringify([{ path: '/a\u0000b', title: 'A' }]),
    JSON.stringify([{ path: '/a.mp4', title: '' }]),
    JSON.stringify([{ path: '/a.mp4', title: 'bell\u0007' }]),
    JSON.stringify([{ path: '/a.mp4', title: 'A', description: 7 }]),
    JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ path: `/f${String(i)}`, title: 'x' }))),
  ])('refuses %j', (raw) => {
    expect(parseDevFixturesEnv(raw)).toBeNull();
  });
});

describe('--dev-fixtures with NUTFLIX_DEV_FIXTURES_JSON', () => {
  it('publishes exactly the listed files, playable', { timeout: 60_000 }, async () => {
    const d = await tempDir('nf-l6c-seam-');
    cleanups.push(() => d.rm());
    const files = [
      {
        path: join(d.dir, 'a.mp4'),
        title: 'E2E fixture A',
        description: 'first',
        bytes: randomBytes(150_000),
      },
      { path: join(d.dir, 'b.mp4'), title: 'E2E fixture B', bytes: randomBytes(70_000) },
    ];
    for (const f of files) await writeFile(f.path, f.bytes);
    const json = JSON.stringify(
      files.map((f) =>
        f.description
          ? { path: f.path, title: f.title, description: f.description }
          : { path: f.path, title: f.title },
      ),
    );
    const base = nodeRuntime();
    const runtime = { ...base, env: (n: string) => (n === DEV_FIXTURES_ENV ? json : base.env(n)) };
    const w = startWorker({ runtime, logLevel: 'error' });
    cleanups.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: join(d.dir, 'worker'),
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 600,
      dev: { mocks: true, fixtures: true },
    });
    const ev = await w.event(
      (e): e is Extract<WorkerEvent, { e: 'dev.fixtures' }> => e.e === 'dev.fixtures',
      45_000,
      'dev.fixtures',
    );
    expect(ev.videos.map((v) => v.title)).toEqual(['E2E fixture A', 'E2E fixture B']);
    expect(ev.videos[0]!.description).toBe('first');
    for (const [i, v] of ev.videos.entries()) {
      const r = v.renditions[0]!;
      const want = createHash('sha256').update(files[i]!.bytes).digest('hex');
      expect(r.sha256).toBe(want);
      expect(v.price.mints.length).toBeGreaterThan(0);
      const sid = randomBytes(16).toString('hex') as never;
      const { link } = await w.call('play.open', {
        sid,
        videoId: v.id,
        rendition: { label: r.label, hyper: r.hyper, size: r.size },
        policy: v.price,
        prefetchSeconds: 600,
      });
      const got = await httpGet(link);
      expect(got.status).toBe(200);
      expect(createHash('sha256').update(got.body).digest('hex')).toBe(want);
      await w.call('play.close', { sid });
    }
    expect(w.invalid).toEqual([]);
  });
});
