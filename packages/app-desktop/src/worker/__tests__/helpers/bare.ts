/**
 * Test harness (not a suite): run worker code under the REAL Bare runtime the desktop ships —
 * `bare-sidecar`'s prebuilt `bare`, spawned the way the host spawns the worker (D2).
 *
 * `bundleForBare` bundles OUR sources with esbuild and leaves every npm package as an import,
 * so Bare resolves them itself (export conditions, native addons). The bundle is written
 * under `node_modules/.cache/` because Bare resolves packages from the importing file's
 * location upwards (a tmpdir bundle could not find them).
 *
 * D6 and bundling: a bundle hoists EVERY external `import` to the top level of one module,
 * in an order that follows esbuild's module layout, not our entry's import order (modules
 * reached through a dynamic `import()` are laid out first) — so an inlined `bare-globals.ts`
 * runs after `@sovit/core`, which builds a `TextDecoder` at load, and the worker dies. The
 * bundle is therefore started by a tiny UNBUNDLED boot module: `import 'bare-encoding/global'`
 * first, then `import('./worker.mjs')`. (Unbundled — the `tsc` output the host runs —
 * `bare-globals.js` is its own module and evaluates first anyway; a future packaging step
 * that bundles the worker must keep the same two-step boot.)
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import Sidecar from 'bare-sidecar';
import { build } from 'esbuild';
import type { Plugin } from 'esbuild';

import { FrameDecoder, encodeFrame } from '../../../ipc/framing.js';
import { isWorkerToHost } from '../../../ipc/worker-guards.js';
import type { WorkerToHost } from '../../../ipc/worker-protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKER_SRC = resolve(HERE, '..', '..');
const ROOT = resolve(WORKER_SRC, '..', '..', '..', '..');

/** Inside the bundle, `bare-globals.js` becomes the (idempotent) external global module. */
const d6FirstImport: Plugin = {
  name: 'd6-first-import',
  setup(b) {
    b.onResolve({ filter: /\/bare-globals\.js$/ }, () => ({
      path: 'bare-encoding/global',
      external: true,
    }));
  },
};

export async function bundleForBare(
  entry: string,
): Promise<{ readonly file: string; cleanup(): Promise<void> }> {
  const dir = join(ROOT, 'node_modules', '.cache', `nutflix-l6c-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'boot.mjs');
  await writeFile(
    file,
    "import 'bare-encoding/global'\nimport('./worker.mjs').catch((e) => { throw e })\n",
  );
  await build({
    entryPoints: [entry],
    outfile: join(dir, 'worker.mjs'),
    bundle: true,
    packages: 'external',
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [d6FirstImport],
  });
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface BareWorker {
  readonly messages: WorkerToHost[];
  readonly invalid: unknown[];
  readonly stderr: string[];
  send(msg: object): void;
  next<T extends WorkerToHost>(
    pred: (m: WorkerToHost) => m is T,
    ms?: number,
    what?: string,
  ): Promise<T>;
  /** EOF on the worker's pipe (the host going away). */
  end(): void;
  kill(): void;
  readonly exited: Promise<number | null>;
}

export function spawnBare(file: string, args: readonly string[] = []): BareWorker {
  const sidecar = new Sidecar(file, [...args]);
  const messages: WorkerToHost[] = [];
  const invalid: unknown[] = [];
  const stderr: string[] = [];
  const waiters: { pred: (m: WorkerToHost) => boolean; resolve: (m: WorkerToHost) => void }[] = [];
  sidecar.stdout?.resume();
  sidecar.stderr?.on('data', (d: unknown) => {
    if (d instanceof Uint8Array) stderr.push(Buffer.from(d).toString('utf8'));
  });
  const decoder = new FrameDecoder((m) => {
    if (!isWorkerToHost(m)) {
      invalid.push(m);
      return;
    }
    messages.push(m);
    for (const w of [...waiters])
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
  });
  sidecar.on('data', (c: unknown) => {
    if (c instanceof Uint8Array) decoder.push(c);
  });
  sidecar.on('error', () => undefined);
  const exited = new Promise<number | null>((done) => {
    sidecar.once('exit', (code: number | null) => {
      done(code);
    });
  });
  return {
    messages,
    invalid,
    stderr,
    send: (msg) => {
      sidecar.write(encodeFrame(msg));
    },
    next: <T extends WorkerToHost>(
      pred: (m: WorkerToHost) => m is T,
      ms = 20_000,
      what = 'message',
    ) => {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        new Promise<T>((resolve) => {
          waiters.push({ pred, resolve: resolve as (m: WorkerToHost) => void });
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `bare worker: timed out after ${String(ms)} ms waiting for ${what}; stderr: ${stderr.join('').slice(0, 2000)}`,
              ),
            );
          }, ms);
        }),
      ]).finally(() => {
        clearTimeout(timer);
      });
    },
    end: () => {
      // bare-sidecar's Duplex has no `_final`, so `sidecar.end()` never reaches the child: end
      // the child's fd-3 socket itself (what the worker sees when the host process dies).
      (sidecar as unknown as { readonly _ipc: { end(): void } })._ipc.end();
    },
    kill: () => {
      sidecar.destroy();
    },
    exited,
  };
}
