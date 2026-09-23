/**
 * The supervisor over the REAL runtime (D2 amended): `spawnBareSidecar` → bare-sidecar 0.5.4 →
 * its prebuilt `bare` 1.31.0, running a small worker bundled here with esbuild that speaks the
 * host ⇄ worker protocol with `src/ipc/`'s framing and guards. Proves spawn + init/ready,
 * requests both ways of the pipe, draining a noisy stdout/stderr (the worker writes far more
 * than a pipe buffer holds BEFORE it answers init), and crash → backend-down → restart → ready.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IpcError } from '../../ipc/errors.js';
import type { SessionId } from '../../ipc/protocol.js';
import { WORKER_V } from '../../ipc/worker-protocol.js';
import { memoryLogger } from '../log.js';
import { spawnBareSidecar } from '../worker/sidecar.js';
import { WorkerSupervisor } from '../worker/supervisor.js';
import { eventually } from './support/rig.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRASH_SID = 'dead'.repeat(8);

/** The worker: bundled from this source (esbuild resolves the src/ipc imports). */
const WORKER_SOURCE = `
import { toWireError, wireError } from '../../ipc/errors.js';
import { FrameDecoder, encodeFrame } from '../../ipc/framing.js';
import { isHostToWorker } from '../../ipc/worker-guards.js';
import { WORKER_V } from '../../ipc/worker-protocol.js';
const B = globalThis.Bare;
const ipc = B.IPC;
const send = (m) => ipc.write(encodeFrame(m));
// Far more output than a pipe buffer (~64 KiB) holds, before anything else happens.
const line = 'x'.repeat(1023);
for (let i = 0; i < 300; i++) console.log(line);
for (let i = 0; i < 20; i++) console.error('stderr ' + 'ab'.repeat(32));
const decoder = new FrameDecoder((msg) => {
  if (!isHostToWorker(msg)) {
    send({ op: 'res', id: typeof msg.id === 'number' ? msg.id : 0, ok: false, e: wireError('invalid-argument', 'bad') });
    return;
  }
  if (msg.op !== 'req') return;
  try {
    if (msg.m === 'init') {
      send({ op: 'res', id: msg.id, ok: true });
      send({ op: 'ev', e: 'ready', v: WORKER_V, port: 4242 });
    } else if (msg.m === 'seeder.unban') {
      send({ op: 'res', id: msg.id, ok: true });
    } else if (msg.m === 'play.close' && msg.a.sid === '${CRASH_SID}') {
      B.exit(7);
    } else {
      throw new Error('not-found: ' + msg.m + ' is not implemented here');
    }
  } catch (e) {
    send({ op: 'res', id: msg.id, ok: false, e: toWireError(e) });
  }
});
ipc.on('data', (c) => {
  try { decoder.push(c); } catch { B.exit(3); }
});
`;

let dir = '';
let entry = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nf-l6b-sidecar-'));
  entry = join(dir, 'worker.cjs');
  await build({
    stdin: { contents: WORKER_SOURCE, resolveDir: HERE, loader: 'ts', sourcefile: 'worker.ts' },
    outfile: entry,
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  });
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as IpcError).code;
  }
};

describe('WorkerSupervisor over bare-sidecar (real bare)', () => {
  it(
    'starts, drains output, answers, and restarts after a crash',
    { timeout: 60_000 },
    async () => {
      const log = memoryLogger('debug');
      const sup = new WorkerSupervisor({
        spawn: spawnBareSidecar,
        entry,
        init: () => ({
          v: WORKER_V,
          storage: dir,
          seeding: { enabled: false, diskCapBytes: 0 },
          prefetchSeconds: 30,
        }),
        log,
        onEvent: () => undefined,
        handlers: { 'studio.publish': () => Promise.reject(new Error('no-signer: none')) },
        restart: { baseMs: 20, maxMs: 100, maxRestarts: 5, windowMs: 60_000 },
        startTimeoutMs: 20_000,
      });
      try {
        sup.start();
        await eventually(() => sup.state === 'ready', 'the real worker to become ready', 20_000);
        expect(sup.readyPort).toBe(4242);
        await sup.request('seeder.unban', { pubkey: 'ab'.repeat(32) as never });
        expect(await codeOf(sup.request('studio.ffmpeg', { recheck: false }))).toBe('not-found');

        // stdout/stderr were drained (the worker could only answer init after writing ~300 KiB).
        const stdout = log.lines.filter((l) => l.msg === 'worker stdout');
        const stderr = log.lines.filter((l) => l.msg === 'worker stderr');
        expect(stdout.length).toBeGreaterThan(0);
        expect(stderr.length).toBeGreaterThan(0);
        expect(JSON.stringify(log.lines)).not.toContain('ab'.repeat(32));

        // Crash mid-call → backend-down → restart → ready → serving again.
        expect(await codeOf(sup.request('play.close', { sid: CRASH_SID as SessionId }))).toBe(
          'backend-down',
        );
        await eventually(() => sup.state === 'ready', 'the restarted worker', 20_000);
        await sup.request('seeder.unban', { pubkey: 'cd'.repeat(32) as never });
        expect(log.lines.some((l) => l.msg === 'media worker exited' && l['code'] === 7)).toBe(
          true,
        );
      } finally {
        sup.stop();
      }
      expect(sup.state).toBe('stopped');
    },
  );
});
