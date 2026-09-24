/**
 * Private files for the signer (ADR 0013; security review F24, desktop half): the encrypted key
 * file lives in `<userData>/signer/`, a 0700 directory, as a 0600 file owned by this user.
 *
 *   read   refuses a symlink, anything but a regular file, and (POSIX) a file another user owns
 *          or that group/others may read — a key file someone else can read is reported, not
 *          silently used. Opened with O_NOFOLLOW and re-checked on the open handle.
 *   write  a random temp name opened exclusively (`wx`, so a planted symlink is never followed),
 *          0600, fsync, rename over the target, best-effort fsync of the directory.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { hostError } from '../errors.js';

const POSIX = process.platform !== 'win32';

/** Create `dir` (0700) if needed; refuse a symlink or non-directory; tighten a loose mode. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw hostError('forbidden', 'the signer directory is not a plain directory');
  if (POSIX) {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid())
      throw hostError('forbidden', 'the signer directory belongs to another user');
    if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);
  }
}

/** The file's bytes, or `null` when it does not exist. Throws `forbidden` when it is not private. */
export async function readPrivateFile(path: string, maxBytes: number): Promise<Uint8Array | null> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return null;
    throw e;
  }
  const name = basename(path);
  if (st.isSymbolicLink() || !st.isFile())
    throw hostError('forbidden', `${name} is not a regular file`);
  const flags = constants.O_RDONLY | (POSIX ? constants.O_NOFOLLOW : 0);
  const fh = await open(path, flags);
  try {
    const fst = await fh.stat();
    if (!fst.isFile() || fst.ino !== st.ino) throw hostError('forbidden', `${name} changed`);
    if (POSIX) {
      if (typeof process.getuid === 'function' && fst.uid !== process.getuid())
        throw hostError('forbidden', `${name} belongs to another user`);
      if ((fst.mode & 0o077) !== 0)
        throw hostError('forbidden', `${name} is readable by other users (it must be 0600)`);
    }
    if (fst.size > maxBytes) throw hostError('forbidden', `${name} is too large`);
    const buf = await fh.readFile();
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } finally {
    await fh.close();
  }
}

/** Atomically replace `path` with `data` (0600). The directory must already be private. */
export async function writePrivateFile(path: string, data: Uint8Array): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
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
    // Directory fsync is not supported everywhere (Windows); the rename already landed.
  }
}
