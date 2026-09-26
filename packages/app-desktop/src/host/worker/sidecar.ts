/**
 * The production `SpawnWorker`: `bare-sidecar` (pinned 0.5.4) directly — D2 as amended after
 * L6-0. `PearRuntime.run(entry, args)` is literally `new Sidecar(entry, args)` under Node, but
 * importing `pear-runtime` would load corestore, hyperswarm and three native addons into the
 * host; `bare-sidecar` loads none. `new PearRuntime()` (public-DHT OTA) is never used.
 *
 * Kept in its own module so tests that do not spawn a real worker never load it.
 *
 * Packaging (issue #6, ADR 0017). `bare-sidecar`'s `lib/bare.js` resolves its prebuilt `bare`
 * next to ITS OWN file and, when that binary is not executable, `chmod`s it at require time.
 * In a packaged build that goes wrong twice: this module sits inside `app.asar`, and a binary
 * path inside an archive cannot be spawned; and the install is read-only (a `.deb` under
 * `/usr/lib`, an AppImage's squashfs, a signed macOS bundle), where the `chmod` throws — or,
 * worse, would modify a signed bundle. So in a packaged build `bare-sidecar` is loaded from
 * `app.asar.unpacked/node_modules` (the binary it resolves is then a real, spawnable file), and
 * the binary must ALREADY be executable: when it is not, the worker fails closed with a clear
 * error and nothing is `chmod`ed. A dev build keeps upstream behaviour (its `node_modules` is
 * writable, and npm may drop the mode bit).
 */
import { accessSync, constants, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appArchive, asarUnpacked } from '../../ipc/asar-path.js';
import { WorkerRuntimeError, type SpawnWorker, type WorkerProcess } from './supervisor.js';

// Defined beside the supervisor (which logs its message when a spawn fails); re-exported here,
// where it is thrown.
export { WorkerRuntimeError };

type SidecarCtor = new (entry: string, args?: string[]) => WorkerProcess;

export interface SidecarLoader {
  /** The URL of the module doing the loading (`import.meta.url`: the host bundle when packaged). */
  readonly moduleUrl: string;
  /**
   * The app's own archive, `<process.resourcesPath>/app.asar` (`appArchive`); `undefined`
   * outside Electron. Only a `moduleUrl` inside THIS archive counts as packaged.
   */
  readonly appArchive: string | undefined;
  /**
   * Throws when `path` is not executable by this process. Defaults to `fs.accessSync(path,
   * X_OK)`; only tests replace it.
   */
  readonly checkExecutable?: (path: string) => void;
}

function isExecutable(path: string): void {
  accessSync(path, constants.X_OK);
}

/**
 * Resolves `bare-sidecar` for this install and returns its constructor. In a packaged build
 * (`moduleUrl` inside the app's archive) it resolves from the unpacked tree and REFUSES a Bare
 * binary that is not executable, before `bare-sidecar` itself is loaded (so its `chmod` never
 * runs); the path checked is the one `bare-sidecar` resolves (same `require-asset` call).
 */
export function loadSidecar(o: SidecarLoader): SidecarCtor {
  const here = fileURLToPath(o.moduleUrl);
  const unpacked = asarUnpacked(here, o.appArchive);
  const req = createRequire(unpacked ?? here);
  if (unpacked !== undefined) {
    const pkgDir = dirname(req.resolve('bare-sidecar/package'));
    const fromPkg = createRequire(join(pkgDir, 'index.js'));
    const asset = fromPkg('require-asset') as (specifier: string, parent: string) => string;
    const binary = asset('#bare', join(pkgDir, 'lib', 'bare.js'));
    try {
      (o.checkExecutable ?? isExecutable)(binary);
    } catch {
      throw new WorkerRuntimeError(
        'the bundled Bare runtime is not executable; reinstall the app (it is never repaired in place)',
      );
    }
  }
  // CJS package (`module.exports = class Sidecar`); its bundled .d.ts pulls in bare-pipe and
  // bare-stream types we do not need, so it is required and typed structurally here.
  return req('bare-sidecar') as SidecarCtor;
}

let ctor: SidecarCtor | undefined;

function sidecar(): SidecarCtor {
  ctor ??= loadSidecar({
    moduleUrl: import.meta.url,
    // Electron gives the utilityProcess `process.resourcesPath` too; plain Node does not.
    appArchive: appArchive((process as { resourcesPath?: unknown }).resourcesPath, realpathSync),
  });
  return ctor;
}

/** Spawns `entry` under bare-sidecar's prebuilt `bare`; the worker sees `args` at `Bare.argv[2…]`. */
export const spawnBareSidecar: SpawnWorker = (entry, args) => {
  const Sidecar = sidecar();
  return new Sidecar(entry, [...args]);
};
