/**
 * The production `SpawnWorker`: `bare-sidecar` (pinned 0.5.4) directly — D2 as amended after
 * L6-0. `PearRuntime.run(entry, args)` is literally `new Sidecar(entry, args)` under Node, but
 * importing `pear-runtime` would load corestore, hyperswarm and three native addons into the
 * host; `bare-sidecar` loads none. `new PearRuntime()` (public-DHT OTA) is never used.
 *
 * Kept in its own module so tests that do not spawn a real worker never load it (its
 * `lib/bare.js` chmods the prebuilt binary at require time).
 */
import { createRequire } from 'node:module';

import type { SpawnWorker, WorkerProcess } from './supervisor.js';

type SidecarCtor = new (entry: string, args?: string[]) => WorkerProcess;

let ctor: SidecarCtor | undefined;

function sidecar(): SidecarCtor {
  // CJS package (`module.exports = class Sidecar`); its bundled .d.ts pulls in bare-pipe and
  // bare-stream types we do not need, so it is required and typed structurally here.
  ctor ??= createRequire(import.meta.url)('bare-sidecar') as SidecarCtor;
  return ctor;
}

/** Spawns `entry` under bare-sidecar's prebuilt `bare`; the worker sees `args` at `Bare.argv[2…]`. */
export const spawnBareSidecar: SpawnWorker = (entry, args) => {
  const Sidecar = sidecar();
  return new Sidecar(entry, [...args]);
};
