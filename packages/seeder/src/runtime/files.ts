/**
 * Atomic, durable writes for the daemon's money state (the wallet's proofs, accepted-but-unflushed
 * PAYs): write `<path>.tmp` with mode 0600, fsync it, rename it over `<path>`, fsync the
 * directory. A crash at any point leaves either the old file or the new one, never a torn one.
 *
 * Node only (`node:fs`); reachable from `cli/providers.ts`, never from `portable.ts`
 * (entry-hygiene.test.ts). `SeederFs` has no fsync, which is why this is not an adapter call.
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Group or other may not read, write or execute a file holding money or a key. */
export const PRIVATE_MODE_MASK = 0o077;

function fsyncDirSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Some filesystems refuse fsync on a directory; the file itself is already durable.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Synchronous: for hooks that must complete before the caller's next step (`persistPending`).
 * A leftover `.tmp` (a crash mid-write) is removed and the file created exclusively, so the new
 * one always gets mode 0600 and a planted symlink is never followed.
 */
export function writeFileAtomicSync(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  try {
    unlinkSync(tmp);
  } catch {
    // none left over
  }
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    const bytes = Buffer.from(data, 'utf8');
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
  fsyncDirSync(dirname(path));
}

/** The async twin, for `ProofStore.commit()`. Callers serialise their writes. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await unlink(tmp).catch(() => undefined);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  try {
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // see fsyncDirSync
  }
}

/** `null` when the file does not exist; any other read error throws. */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw err;
  }
}

export function readTextIfExistsSync(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Throws when `path` exists and group or other has any permission on it. */
export async function assertPrivate(path: string, what: string): Promise<void> {
  const st = await stat(path).catch((err: unknown) => {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw err;
  });
  if (st !== null && (st.mode & PRIVATE_MODE_MASK) !== 0)
    throw new RuntimeSetupError(`${what} ${path} is accessible to group or others: chmod 600 it`);
}

export function assertPrivateSync(path: string, what: string): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return;
    throw err;
  }
  if ((mode & PRIVATE_MODE_MASK) !== 0)
    throw new RuntimeSetupError(`${what} ${path} is accessible to group or others: chmod 600 it`);
}

/**
 * A reason the daemon refuses to start. The message is written for the operator and is safe to
 * log: it names paths and problems, never a key, a passphrase or a proof.
 */
export class RuntimeSetupError extends Error {
  override readonly name = 'RuntimeSetupError';
}
