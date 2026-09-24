/**
 * Main's OS-keychain store (ADR 0013) with a fake `safeStorage` and real files: only a real
 * keychain counts (never Linux's `basic_text`), sealed files are 0600 in a 0700 directory, a
 * symlink or a loose file is not read, a failure is `null` / `false`, never a throw, and the
 * bytes handed to `put` are wiped.
 */
import * as fsp from 'node:fs/promises';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SafeStorageLike } from '../keychain.js';
import { KeychainStore, keychainUsable } from '../keychain.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null): string | null =>
  b === null ? null : new TextDecoder().decode(b);

/** Reversible, and visibly not plaintext: the test can tell sealed bytes from the secret. */
function fakeSafeStorage(over: Partial<SafeStorageLike> = {}): SafeStorageLike & { seals: number } {
  const ss = {
    seals: 0,
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: (t: string) => {
      ss.seals++;
      return Promise.resolve(Uint8Array.from(enc(t), (b) => b ^ 0x5a));
    },
    decryptStringAsync: (b: Uint8Array) =>
      Promise.resolve({ result: new TextDecoder().decode(Uint8Array.from(b, (x) => x ^ 0x5a)) }),
    ...over,
  };
  return ss;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nf-keychain-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store(ss: SafeStorageLike = fakeSafeStorage(), usable = true): KeychainStore {
  return new KeychainStore({
    dir: join(root, 'keychain'),
    safeStorage: ss,
    usable,
    fs: fsp,
    join,
    posix: process.platform !== 'win32',
  });
}

describe('keychainUsable', () => {
  it('a real keychain only', () => {
    expect(keychainUsable(fakeSafeStorage(), 'linux')).toBe(true);
    expect(keychainUsable(fakeSafeStorage(), 'darwin')).toBe(true);
    expect(
      keychainUsable(fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }), 'linux'),
    ).toBe(false);
    expect(
      keychainUsable(fakeSafeStorage({ getSelectedStorageBackend: () => 'unknown' }), 'linux'),
    ).toBe(false);
    expect(keychainUsable(fakeSafeStorage({ isEncryptionAvailable: () => false }), 'darwin')).toBe(
      false,
    );
    const broken = fakeSafeStorage({
      isEncryptionAvailable: () => {
        throw new Error('not ready');
      },
    });
    expect(keychainUsable(broken, 'win32')).toBe(false);
    expect(keychainUsable(undefined as unknown as SafeStorageLike, 'linux')).toBe(false);
  });
});

describe('KeychainStore', () => {
  it('seals, reads back, forgets; 0600 file in a 0700 dir; never plaintext on disk', async () => {
    const k = store();
    const secret = enc('my passphrase 123');
    expect(await k.put('passphrase', secret)).toBe(true);
    expect(secret.every((b) => b === 0)).toBe(true); // wiped by put
    const file = join(root, 'keychain', 'passphrase.sealed');
    const onDisk = await readFile(file);
    expect(onDisk.toString('latin1')).not.toContain('my passphrase');
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'keychain'))).mode & 0o777).toBe(0o700);
    }
    expect(dec(await k.get('passphrase'))).toBe('my passphrase 123');
    expect(await k.get('nip46')).toBeNull();
    expect(await k.forget('passphrase')).toBe(true);
    expect(await k.get('passphrase')).toBeNull();
    expect(await k.forget('passphrase')).toBe(true); // already gone is fine
  });

  it('unusable: nothing is sealed or read, but forget still removes', async () => {
    const ss = fakeSafeStorage();
    const on = store(ss);
    await on.put('nip46', enc('session'));
    const off = store(ss, false);
    const v = enc('x');
    expect(await off.put('passphrase', v)).toBe(false);
    expect(v[0]).toBe(0);
    expect(await off.get('nip46')).toBeNull();
    expect(await off.forget('nip46')).toBe(true);
    expect(await on.get('nip46')).toBeNull();
  });

  it('refuses to read a symlink, a loose file, or bytes it cannot unseal', async () => {
    if (process.platform === 'win32') return;
    const k = store();
    await k.put('passphrase', enc('secret'));
    const file = join(root, 'keychain', 'passphrase.sealed');
    await chmod(file, 0o644);
    expect(await k.get('passphrase')).toBeNull();
    await chmod(file, 0o600);
    const target = join(root, 'elsewhere');
    await writeFile(target, 'x', { mode: 0o600 });
    await rm(join(root, 'keychain', 'nip46.sealed'), { force: true });
    await symlink(target, join(root, 'keychain', 'nip46.sealed'));
    expect(await k.get('nip46')).toBeNull();
    const failing = store(
      fakeSafeStorage({ decryptStringAsync: () => Promise.reject(new Error('other keyring')) }),
    );
    expect(await failing.get('passphrase')).toBeNull();
  });

  it('refuses a loose keychain directory, empty or oversized values, and non-UTF-8 bytes', async () => {
    const k = store();
    expect(await k.put('passphrase', new Uint8Array(0))).toBe(false);
    expect(await k.put('passphrase', new Uint8Array(4096).fill(97))).toBe(false);
    expect(await k.put('passphrase', new Uint8Array([0xff, 0xfe]))).toBe(false);
    if (process.platform === 'win32') return;
    await fsp.mkdir(join(root, 'keychain'), { mode: 0o755 });
    await chmod(join(root, 'keychain'), 0o755);
    expect(await k.put('passphrase', enc('fine'))).toBe(false);
  });

  it('a failing seal is false, not a throw, and leaves no file', async () => {
    const k = store(
      fakeSafeStorage({ encryptStringAsync: () => Promise.reject(new Error('locked')) }),
    );
    expect(await k.put('passphrase', enc('x'))).toBe(false);
    await expect(stat(join(root, 'keychain', 'passphrase.sealed'))).rejects.toThrow();
  });
});
