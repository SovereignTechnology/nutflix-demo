/**
 * Atomic JSON file persistence for the host's small state files (`settings.json`,
 * `desktop.json`) in Electron's userData (design §1 "Settings").
 *
 * Write = temp file in the same directory (mode 0600, exclusive create) → fsync → rename over
 * the target → best-effort fsync of the directory, so a crash leaves either the old or the new
 * file, never a torn one. Saves are serialised. A missing file is a first run; an unreadable,
 * unparsable or invalid one is moved aside to `<name>.corrupt` and reported to the caller,
 * which falls back to defaults — it never crashes the host.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Logger } from '../log.js';

export type LoadResult<T> =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'corrupt'; readonly reason: string };

/** Largest file the host will parse (these files are a few KiB). */
export const MAX_STATE_FILE_BYTES = 1024 * 1024;

export class JsonFile<T> {
  readonly path: string;
  private readonly parse: (raw: unknown) => T | null;
  private readonly log: Logger;
  private chain: Promise<void> = Promise.resolve();

  /** `parse` returns `null` for anything that is not a valid `T` (it must not throw). */
  constructor(path: string, parse: (raw: unknown) => T | null, log: Logger) {
    this.path = path;
    this.parse = parse;
    this.log = log;
  }

  async load(): Promise<LoadResult<T>> {
    let text: string;
    try {
      const buf = await readFile(this.path);
      if (buf.byteLength > MAX_STATE_FILE_BYTES) return await this.corrupt('file too large');
      text = buf.toString('utf8');
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ENOENT') return { kind: 'missing' };
      return this.corrupt('unreadable');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.corrupt('not JSON');
    }
    let value: T | null;
    try {
      value = this.parse(raw);
    } catch {
      value = null;
    }
    return value === null ? this.corrupt('invalid contents') : { kind: 'ok', value };
  }

  /** Atomically replaces the file with `value` (serialised after any save in flight). */
  save(value: T): Promise<void> {
    const run = this.chain.then(() => this.write(value));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async write(value: T): Promise<void> {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`);
    const data = `${JSON.stringify(value, null, 2)}\n`;
    try {
      const fh = await open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(data, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.path);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    try {
      const dh = await open(dir, 'r');
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // Directory fsync is not supported everywhere (e.g. Windows); the rename already landed.
    }
  }

  private async corrupt(reason: string): Promise<LoadResult<T>> {
    this.log.warn('state file is corrupt; using defaults', { file: basename(this.path), reason });
    try {
      await rename(this.path, `${this.path}.corrupt`);
    } catch {
      // Could not move it aside; the next save replaces it anyway.
    }
    return { kind: 'corrupt', reason };
  }
}
