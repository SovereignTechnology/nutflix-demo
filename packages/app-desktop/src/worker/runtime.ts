/**
 * What the runtime-neutral `WorkerHost` needs from its runtime (design §6 L6-C: "runtime-
 * neutral, adapters injected — runs under Node in tests and Bare in production"). Bare's
 * implementation is `adapters/bare.ts` (bare-fs, bare-os, bare-subprocess); tests build a
 * Node one from `@sovit/seeder`'s and `@sovit/core/media/node`'s adapters. Hashing and
 * randomness are NOT here: `./crypto.ts` (libsodium) loads under both runtimes.
 */
import type { FsAdapter, ProcessRunner } from '@sovit/core';
import type { SeederFs } from '@sovit/seeder';

import type { OsName } from './ffmpeg.js';

/**
 * Small durable state files, SYNCHRONOUS — the payment engine's pending PAYs are written before
 * the ACK goes out (its `persistPending` hook is synchronous) and its seen secrets as they are
 * accepted (ADR 0012). Every write is 0600.
 */
export interface StateFs {
  /** The file's text, or `null` when it does not exist (other errors throw). */
  readText(path: string): string | null;
  /** `<path>.tmp` (created exclusively, a leftover removed first) + fsync + rename. */
  writeAtomic(path: string, data: string): void;
  append(path: string, data: string): void;
  /** Append, then fsync, before returning (the pending-PAY journal: written before the ACK). */
  appendDurable(path: string, data: string): void;
  /** Delete the file; a missing one is fine. */
  remove(path: string): void;
  rename(from: string, to: string): void;
  mkdirp(path: string): void;
}

export interface WorkerRuntime {
  /** `@sovit/seeder`'s filesystem (Corestore dir, CAS index, ban list, fixture dirs). */
  readonly seederFs: SeederFs;
  /** `@sovit/core/media`'s filesystem; `mkdtemp(prefix)` creates under `tmpDir`. */
  mediaFs(tmpDir: string): FsAdapter;
  /** ffmpeg / ffprobe (argv only, never a shell). */
  readonly runner: ProcessRunner;
  /** An environment variable (only `PATH` is read). */
  env(name: string): string | undefined;
  /** Exists, is a regular file, and is executable by us. */
  isExecutable(path: string): Promise<boolean>;
  readonly os: OsName;
  readonly stateFs: StateFs;
}
