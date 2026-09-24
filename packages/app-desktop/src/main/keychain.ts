/**
 * The OS keychain for the signer (ADR 0013): main seals what the host asks it to keep — the
 * local key's passphrase (unlock method `keychain`) or a remembered NIP-46 session — with
 * Electron's `safeStorage` (macOS Keychain, Windows DPAPI, the Secret Service / KWallet on Linux)
 * and keeps the ciphertext in `<userData>/keychain/<slot>.sealed`, 0600 in a 0700 directory.
 *
 * Refused where there is no real keychain: `safeStorage` unavailable, or Linux's `basic_text`
 * backend (a hard-coded key — plaintext with extra steps) or `unknown`. `setUsePlainTextEncryption`
 * is never called. The host learns the answer once (`--keychain`) and offers the method only then.
 *
 * `safeStorage` takes and returns JS strings, which cannot be wiped; the bytes main receives and
 * the ones it reads back are wiped once used. Electron-free: `main.ts` passes `safeStorage` and
 * `node:fs/promises`; the tests pass fakes.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import type { KeychainSlot } from '../ipc/protocol.js';
import { KEYCHAIN_SLOTS, MAX_SECRET_BYTES } from '../ipc/protocol.js';

/** The part of Electron's `safeStorage` used here. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptStringAsync(plainText: string): Promise<Uint8Array>;
  decryptStringAsync(encrypted: Uint8Array): Promise<{ readonly result: string }>;
}

/** The part of `node:fs/promises` used here. */
export interface KeychainFs {
  mkdir(path: string, opts: { recursive: true; mode: number }): Promise<unknown>;
  lstat(path: string): Promise<{
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    readonly size: number;
    readonly mode: number;
  }>;
  readFile(path: string): Promise<Uint8Array>;
  open(
    path: string,
    flags: string | number,
    mode?: number,
  ): Promise<{
    writeFile(data: Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, opts: { force: true }): Promise<void>;
}

/** Largest sealed file main will read (a sealed `MAX_SECRET_BYTES` plus the OS's overhead). */
const MAX_SEALED_BYTES = 16 * 1024;

/** Is there a real keychain behind `safeStorage` here? Call after `app.ready`. Never throws. */
export function keychainUsable(ss: SafeStorageLike, platform: string): boolean {
  try {
    if (!ss.isEncryptionAvailable()) return false;
    if (platform !== 'linux') return true;
    const backend = ss.getSelectedStorageBackend?.();
    return backend !== undefined && backend !== 'basic_text' && backend !== 'unknown';
  } catch {
    return false;
  }
}

export interface KeychainStoreDeps {
  /** `<userData>/keychain` (absolute). */
  readonly dir: string;
  readonly safeStorage: SafeStorageLike;
  /** `keychainUsable(…)` — when false every op fails without touching anything. */
  readonly usable: boolean;
  readonly fs: KeychainFs;
  readonly join: (...p: string[]) => string;
  readonly posix: boolean;
}

function wipe(b: Uint8Array | null | undefined): void {
  b?.fill(0);
}

export class KeychainStore {
  private readonly d: KeychainStoreDeps;
  /** Serialised: a put and a forget of one slot never interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: KeychainStoreDeps) {
    this.d = deps;
  }

  get usable(): boolean {
    return this.d.usable;
  }

  private path(slot: KeychainSlot): string {
    if (!(KEYCHAIN_SLOTS as readonly string[]).includes(slot)) throw new Error('bad slot');
    return this.d.join(this.d.dir, `${slot}.sealed`);
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async privateDir(): Promise<void> {
    const { fs, dir } = this.d;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new Error('keychain dir is not a directory');
    if (this.d.posix && (st.mode & 0o077) !== 0) throw new Error('keychain dir is not private');
  }

  /** The unsealed bytes (the caller wipes them), or `null`: none stored, or it cannot be read. */
  get(slot: KeychainSlot): Promise<Uint8Array | null> {
    return this.serial(async () => {
      if (!this.d.usable) return null;
      const p = this.path(slot);
      let sealed: Uint8Array;
      try {
        const st = await this.d.fs.lstat(p);
        if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SEALED_BYTES) return null;
        if (this.d.posix && (st.mode & 0o077) !== 0) return null;
        sealed = await this.d.fs.readFile(p);
      } catch {
        return null;
      }
      try {
        const { result } = await this.d.safeStorage.decryptStringAsync(sealed);
        const out = new TextEncoder().encode(result);
        if (out.byteLength === 0 || out.byteLength > MAX_SECRET_BYTES) {
          wipe(out);
          return null;
        }
        return out;
      } catch {
        // Sealed under another OS user / keyring: useless here.
        return null;
      } finally {
        wipe(sealed);
      }
    });
  }

  /** Seal and store `value` (wiped by this call either way). `false` on any failure. */
  put(slot: KeychainSlot, value: Uint8Array): Promise<boolean> {
    return this.serial(async () => {
      try {
        if (!this.d.usable || value.byteLength === 0 || value.byteLength > MAX_SECRET_BYTES)
          return false;
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(value);
        } catch {
          return false;
        }
        const sealed = await this.d.safeStorage.encryptStringAsync(text);
        await this.privateDir();
        await this.write(this.path(slot), sealed);
        return true;
      } catch {
        return false;
      } finally {
        wipe(value);
      }
    });
  }

  /** Remove `slot` (true when it is gone, also when it never existed). */
  forget(slot: KeychainSlot): Promise<boolean> {
    return this.serial(async () => {
      try {
        await this.d.fs.rm(this.path(slot), { force: true });
        return true;
      } catch {
        return false;
      }
    });
  }

  private async write(path: string, data: Uint8Array): Promise<void> {
    const { fs } = this.d;
    const tmp = this.d.join(this.d.dir, `.${randomBytes(6).toString('hex')}.tmp`);
    try {
      // O_EXCL: a planted file or symlink at the temp name fails the open, never followed.
      const fh = await fs.open(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, path);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
}
