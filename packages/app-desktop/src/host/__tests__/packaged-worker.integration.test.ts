/**
 * Issue #6 (ADR 0017): the PACKAGED worker path, end to end, minus Electron. The staging step
 * (`packaging/stage.ts`, run as a child process) writes the app tree a packaged build unpacks
 * next to `resources/app.asar`; this test lays it out exactly there and drives it the way the
 * packaged host does:
 *
 *   loadSidecar (host bundle "inside" app.asar) → bare-sidecar from app.asar.unpacked →
 *   its prebuilt `bare` (target-platform prebuild only, mode kept) → worker/boot.mjs
 *   (`bare-encoding/global` first, D6) → worker/worker.mjs (the bundle) → npm packages
 *   resolved by Bare from the staged node_modules (the lockfile closure, pruned prebuilds)
 *
 * through the real `WorkerSupervisor`: init with `--dev-mocks --dev-fixtures` → ready → the
 * fixture rig (a local hyperdht testnet and two seeders inside the Bare process) → play.open →
 * the bytes over the worker's loopback HTTP server equal the manifest's sha256 → stop.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { VideoManifest } from '@sovit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appArchive } from '../../ipc/asar-path.js';
import type { SessionId } from '../../ipc/protocol.js';
import { WORKER_V, type WorkerEvent } from '../../ipc/worker-protocol.js';
import { memoryLogger } from '../log.js';
import { loadSidecar } from '../worker/sidecar.js';
import { WorkerSupervisor } from '../worker/supervisor.js';
import { eventually } from './support/rig.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let root = '';
let resources = '';
let unpacked = '';
let stageOut = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nf-packaged-worker-'));
  resources = join(root, 'resources');
  unpacked = join(resources, 'app.asar.unpacked');
  const r = spawnSync(
    process.execPath,
    [
      join(PKG, 'packaging', 'stage.ts'),
      '--out',
      unpacked,
      '--platform',
      process.platform,
      '--arch',
      process.arch,
    ],
    { cwd: PKG, encoding: 'utf8', timeout: 180_000 },
  );
  stageOut = `${r.stdout}${r.stderr}`;
  expect(r.status, stageOut).toBe(0);
}, 200_000);

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

function get(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

describe('the packaged worker (staged tree, real bare, real supervisor)', () => {
  it('ships an executable bare for this platform only, and the unbundled boot module', () => {
    const prebuilds = join(unpacked, 'node_modules', 'bare-sidecar', 'prebuilds');
    const bin = join(
      prebuilds,
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'bare.exe' : 'bare',
    );
    expect(existsSync(bin)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(bin).mode & 0o111).toBe(0o111);
    expect(existsSync(join(prebuilds, 'win32-x64'))).toBe(
      process.platform === 'win32' && process.arch === 'x64',
    );
    expect(existsSync(join(unpacked, 'worker', 'boot.mjs'))).toBe(true);
    expect(existsSync(join(unpacked, 'worker', 'worker.mjs'))).toBe(true);
    // pear-runtime is not shipped (the host never constructs it; no OTA).
    expect(existsSync(join(unpacked, 'node_modules', 'pear-runtime'))).toBe(false);
  });

  it(
    'boots through loadSidecar from app.asar.unpacked and serves a fixture video',
    { timeout: 120_000 },
    async () => {
      const Sidecar = loadSidecar({
        moduleUrl: pathToFileURL(join(resources, 'app.asar', 'host', 'main.js')).href,
        // What the packaged host computes: appArchive(process.resourcesPath, realpathSync).
        appArchive: appArchive(resources, realpathSync),
        checkExecutable: (p) => {
          accessSync(p, constants.X_OK);
        },
      });
      const storage = await mkdtemp(join(tmpdir(), 'nf-packaged-worker-storage-'));
      const log = memoryLogger('debug');
      let fixtures: VideoManifest[] | undefined;
      const sup = new WorkerSupervisor({
        spawn: (entry, args) => new Sidecar(entry, [...args]),
        // What main hands the host in a packaged build (workerEntryFor, worker-entry.test.ts).
        entry: join(unpacked, 'worker', 'boot.mjs'),
        init: () => ({
          v: WORKER_V,
          storage,
          seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
          prefetchSeconds: 30,
          dev: { mocks: true, fixtures: true },
        }),
        log,
        onEvent: (ev: WorkerEvent) => {
          if (ev.e === 'dev.fixtures') fixtures = [...ev.videos];
        },
        handlers: { 'studio.publish': () => Promise.reject(new Error('no-signer: none')) },
        restart: { baseMs: 50, maxMs: 200, maxRestarts: 1, windowMs: 60_000 },
        startTimeoutMs: 60_000,
      });
      try {
        sup.start();
        await eventually(
          () => sup.state === 'ready',
          `the packaged worker to become ready (log: ${JSON.stringify(log.lines.slice(-8))})`,
          60_000,
        );
        const videos = await eventually(() => fixtures, 'the dev fixtures', 60_000);
        const video = videos[0]!;
        const r = video.renditions[0]!;
        const sid = randomBytes(16).toString('hex') as SessionId;
        const open = await sup.request('play.open', {
          sid,
          videoId: video.id,
          rendition: {
            label: r.label,
            hyper: r.hyper,
            size: r.size,
            ...(r.bitrateKbps ? { bitrateKbps: r.bitrateKbps } : {}),
          },
          policy: video.price,
          prefetchSeconds: 600,
        });
        const full = await get(open.link);
        expect(full.status).toBe(200);
        expect(full.body.byteLength).toBe(r.size);
        expect(createHash('sha256').update(full.body).digest('hex')).toBe(r.sha256);
        await sup.request('play.close', { sid });
        // No restart happened: the first worker served everything.
        expect(log.lines.some((l) => l.msg === 'media worker exited')).toBe(false);
      } finally {
        sup.stop();
        await rm(storage, { recursive: true, force: true });
      }
      expect(sup.state).toBe('stopped');
    },
  );
});
