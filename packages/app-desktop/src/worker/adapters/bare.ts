/**
 * The Bare runtime for `WorkerHost` (design §1: "`@sovit/seeder` with Bare adapters
 * (`bare-fs`, `sodium-native` sha256)"). The ONLY worker module that imports `bare-*` addons,
 * which cannot load under Node (S-C finding 8) — it is imported by `../entry.ts` alone, and
 * exercised under the real `bare` by `__tests__/bare-worker.test.ts` and
 * `scripts/bare-probe.ts`.
 */
import type { FsAdapter } from '@sovit/core';
import type { FileStat, SeederFs } from '@sovit/seeder';
import fs from 'bare-fs';
import os from 'bare-os';
import path from 'bare-path';
import { spawn } from 'bare-subprocess';

import type { OsName } from '../ffmpeg.js';
import { utf8 } from '../../ipc/codec.js';
import type { StateFs, WorkerRuntime } from '../runtime.js';
import type { BareSpawn } from '../transcode/index.js';
import { createBareProcessRunner } from '../transcode/index.js';

function errno(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** bare-fs types `readFile` as `string | Buffer`; without an encoding it is always a Buffer. */
function bytes(b: unknown): Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError('readFile returned text');
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

export const bareSeederFs: SeederFs = {
  readFile: async (p) => bytes(await fs.promises.readFile(p)),
  writeFile: (p, data) => fs.promises.writeFile(p, data),
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (p) => fs.promises.unlink(p),
  mkdir: async (p, opts) => {
    await fs.promises.mkdir(p, { recursive: opts?.recursive ?? false });
  },
  stat: async (p): Promise<FileStat | null> => {
    try {
      const s = await fs.promises.stat(p);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (err) {
      if (errno(err) === 'ENOENT') return null;
      throw err;
    }
  },
  readStream: (p) => fs.createReadStream(p) as AsyncIterable<Uint8Array>,
  join: (...parts) => path.join(...parts),
};

/** `@sovit/core/media`'s filesystem; temp dirs under `tmpDir` (the worker's storage). */
export function bareMediaFs(tmpDir: string): FsAdapter {
  return {
    readFile: async (p) => bytes(await fs.promises.readFile(p)),
    writeFile: (p, data) => fs.promises.writeFile(p, data),
    stat: async (p) => ({ size: (await fs.promises.stat(p)).size }),
    mkdtemp: (prefix) => fs.promises.mkdtemp(path.join(tmpDir, prefix)),
    rm: (p, opts) => fs.promises.rm(p, { recursive: opts?.recursive ?? false, force: true }),
    // Chunk size is only a hint (hashing and the seeder's re-chunking do not depend on it).
    readChunks: (p) => fs.createReadStream(p) as AsyncIterable<Uint8Array>,
  };
}

function osName(): OsName {
  const p = os.platform();
  if (p === 'darwin' || p === 'ios') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p, fs.constants.X_OK);
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** `StateFs` on bare-fs's synchronous calls (see `../runtime.ts`). */
export const bareStateFs: StateFs = {
  readText: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (err) {
      if (errno(err) === 'ENOENT') return null;
      throw err;
    }
  },
  writeAtomic: (p, data) => {
    const tmp = `${p}.tmp`;
    try {
      fs.unlinkSync(tmp);
    } catch {
      // none left over
    }
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      // No global Buffer in Bare: the shared codec (TextEncoder under Bare, see bare-globals).
      const bytes = utf8.encode(data);
      let off = 0;
      while (off < bytes.byteLength) off += fs.writeSync(fd, bytes, off, bytes.byteLength - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  },
  append: (p, data) => {
    fs.appendFileSync(p, data, { mode: 0o600 });
  },
  appendDurable: (p, data) => {
    const fd = fs.openSync(p, 'a', 0o600);
    try {
      const bytes = utf8.encode(data);
      let off = 0;
      while (off < bytes.byteLength) off += fs.writeSync(fd, bytes, off, bytes.byteLength - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
  remove: (p) => {
    try {
      fs.unlinkSync(p);
    } catch (err) {
      if (errno(err) !== 'ENOENT') throw err;
    }
  },
  rename: (from, to) => {
    fs.renameSync(from, to);
  },
  mkdirp: (p) => {
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  },
};

export function bareRuntime(): WorkerRuntime {
  return {
    stateFs: bareStateFs,
    seederFs: bareSeederFs,
    mediaFs: bareMediaFs,
    runner: createBareProcessRunner(spawn as unknown as BareSpawn),
    env: (name) => os.getEnv(name),
    isExecutable,
    os: osName(),
  };
}
