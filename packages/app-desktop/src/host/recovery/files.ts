/**
 * ADR 0016 on disk, per identity, in `<userData>/wallet/` (0700; the journal's directory):
 *
 *   recovery-<pubkey>.sealed   this device's phrase: a small JSON envelope whose `sealed` field
 *                              is the 16-byte entropy NIP-44-encrypted to self through the signer
 *                              (the relay copy's plaintext, `RecoveryRelayCopy`) — useless without
 *                              the nsec. The envelope's other fields hold no secret: the random
 *                              device id (public anyway, as the relay copy's `d`), when it was
 *                              made, whether the backup was confirmed, the old balance
 *                              reissued (and at which mints it already was: a retry never
 *                              moves those again) and the relay copy published, and which
 *                              replaced phrase's relay copy is still to be retired — so the
 *                              status needs no signer round trip.
 *   recovery-<pubkey>.<device>.retired
 *                              a phrase this device replaced (rotation): kept, never derived from
 *                              again, read only by a restore ("phrases from this device").
 *   counters-<pubkey>.json     core's `CounterState` (no secret): which NUT-13 counters of the
 *                              CURRENT phrase are used. A new phrase derives from counter 0, so
 *                              saving one first moves any existing file aside as
 *                              `counters-<pubkey>.<tag>.retired` (`retireCounters`), after every
 *                              save already started has landed and while no plane is open.
 *
 * Every file is the signer key file's kind (`signer/private-file.ts`): 0600, owned by this user,
 * no symlink, a regular file, written to a fresh exclusive temp file, fsynced, renamed, the
 * directory fsynced — so a write that resolved is on disk and a crash leaves the old file whole.
 * A file that exists but is refused or damaged FAILS LOUDLY (`recovery-unreadable:` /
 * `counters-unreadable:`) and is left where it is: it may be the only record of a phrase, or of
 * counters that must never be reused. Nothing here logs; errors carry no path (it names the
 * user's pubkey).
 */
import { open, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import type { MintUrl, NostrPubkey } from '@sovit/core';
import type { wallet as walletMod } from '@sovit/core';

import { isMintUrl } from '../../ipc/guards.js';
import { ensurePrivateDir, readPrivateFile, writePrivateFile } from '../signer/private-file.js';
import { KEYSET_ID } from './core.js';

const HEX64 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;
/** A NIP-44 v2 payload as base64 (a small plaintext: well under this). */
const SEALED = /^[A-Za-z0-9+/]{16,4096}={0,2}$/;
/**
 * Mints one phrase's envelope records as reissued at most (`reissuedMints`). Only the dialog's
 * https mints are ever reissued, 32 per question; the service asks no more than there is room
 * to record, so a mint is never moved twice (fix round 7).
 */
export const MAX_REISSUED_MINTS = 64;
/** Room for `MAX_REISSUED_MINTS` mint URLs of the longest kind (512) beside the sealed phrase. */
const MAX_RECOVERY_FILE_BYTES = 64 * 1024;
const MAX_COUNTERS_FILE_BYTES = 1024 * 1024;
/** Keysets one counters file may track (every keyset of every mint the wallet ever used). */
export const MAX_KEYSETS = 4096;
/** NUT-13 v1 keysets derive at a hardened BIP-32 index: a counter stays below 2^31. */
export const MAX_COUNTER = 2 ** 31;
/** Retired phrases a restore reads at most (a rotation per reissue: plenty). */
export const MAX_RETIRED = 64;

export class RecoveryFileError extends Error {
  override readonly name = 'RecoveryFileError' as const;
}

function refuse(prefix: 'recovery-unreadable' | 'counters-unreadable', why: string): never {
  throw new RecoveryFileError(`${prefix}: ${why}`);
}

function checkPubkey(pubkey: string): void {
  if (!HEX64.test(pubkey)) throw new Error('invalid-argument: not a pubkey');
}

// ---- the sealed phrase ------------------------------------------------------------------

/** The phrase file's envelope (see the module comment); `sealed` is the only secret-bearing field. */
export interface RecoveryEnvelope {
  readonly v: 1;
  /** A random id per phrase (the relay copy's `d` suffix). */
  readonly device: string;
  readonly created: number;
  /** The user typed back three words (`recovery-confirm`). */
  readonly confirmed: boolean;
  /** The balance held before this phrase was reissued under it (ADR 0016 D5). */
  readonly reissued: boolean;
  /**
   * The mints whose balance was already reissued under THIS phrase (distinct, https, at most
   * `MAX_REISSUED_MINTS`): a later "Finish backup" plans only the others, so it never moves a
   * covered mint again or charges its fee twice (fix round 7). A new phrase starts empty. A file
   * written before this field existed reads as `[]` (the conservative default: plan every mint).
   */
  readonly reissuedMints: readonly MintUrl[];
  /** The encrypted copy reached at least one write relay (ADR 0016 D2). */
  readonly relayCopy: boolean;
  /**
   * The device id of the phrase this one replaced, while that phrase's relay copy is still to be
   * retired (once this phrase's reissue completed); `null` otherwise.
   */
  readonly replaces: string | null;
  /** NIP-44 to self of the `RecoveryRelayCopy` JSON: the only secret-bearing field. */
  readonly sealed: string;
}

export function recoveryPath(dir: string, pubkey: NostrPubkey): string {
  checkPubkey(pubkey);
  return join(dir, `recovery-${pubkey}.sealed`);
}

export function retiredPath(dir: string, pubkey: NostrPubkey, device: string): string {
  checkPubkey(pubkey);
  if (!DEVICE_ID.test(device)) throw new Error('invalid-argument: not a device id');
  return join(dir, `recovery-${pubkey}.${device}.retired`);
}

export function countersPath(dir: string, pubkey: NostrPubkey): string {
  checkPubkey(pubkey);
  return join(dir, `counters-${pubkey}.json`);
}

const ENVELOPE_KEYS = 'confirmed,created,device,reissued,relayCopy,replaces,sealed,v';
/** The same with `reissuedMints` (sorted: it falls between `reissued` and `relayCopy`). */
const ENVELOPE_KEYS_R7 =
  'confirmed,created,device,reissued,reissuedMints,relayCopy,replaces,sealed,v';

/** Distinct https mint URLs, at most `MAX_REISSUED_MINTS`, or `null`. */
function mintList(x: unknown): MintUrl[] | null {
  if (!Array.isArray(x) || x.length > MAX_REISSUED_MINTS) return null;
  const out: MintUrl[] = [];
  for (const m of x as unknown[]) {
    if (!isMintUrl(m) || out.includes(m)) return null;
    out.push(m);
  }
  return out;
}

/** Exactly an envelope, or `null`. Pure; never throws. */
export function parseEnvelope(raw: unknown): RecoveryEnvelope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  // Exact keys: the current shape, or one written before `reissuedMints` existed.
  if (keys !== ENVELOPE_KEYS_R7 && keys !== ENVELOPE_KEYS) return null;
  if (o['v'] !== 1) return null;
  const { device, created, confirmed, reissued, relayCopy, replaces, sealed } = o;
  const reissuedMints = keys === ENVELOPE_KEYS ? [] : mintList(o['reissuedMints']);
  if (reissuedMints === null) return null;
  if (typeof device !== 'string' || !DEVICE_ID.test(device)) return null;
  if (typeof created !== 'number' || !Number.isSafeInteger(created) || created < 0) return null;
  if (typeof confirmed !== 'boolean' || typeof reissued !== 'boolean') return null;
  if (typeof relayCopy !== 'boolean') return null;
  if (replaces !== null && (typeof replaces !== 'string' || !DEVICE_ID.test(replaces))) return null;
  if (replaces === device) return null;
  if (typeof sealed !== 'string' || !SEALED.test(sealed)) return null;
  return { v: 1, device, created, confirmed, reissued, reissuedMints, relayCopy, replaces, sealed };
}

async function readJson(
  path: string,
  max: number,
  prefix: 'recovery-unreadable' | 'counters-unreadable',
  what: string,
): Promise<unknown> {
  let bytes: Uint8Array | null;
  try {
    bytes = await readPrivateFile(path, max);
  } catch {
    refuse(prefix, `${what} is refused: it must be a regular 0600 file of this user`);
  }
  if (bytes === null) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    refuse(prefix, `${what} is damaged (not JSON); it is kept`);
  }
}

/** The envelope at `path`, `null` when there is none; throws `recovery-unreadable:` otherwise. */
export async function readEnvelope(path: string): Promise<RecoveryEnvelope | null> {
  const raw = await readJson(
    path,
    MAX_RECOVERY_FILE_BYTES,
    'recovery-unreadable',
    'the recovery phrase file',
  );
  if (raw === undefined) return null;
  const env = parseEnvelope(raw);
  if (env === null)
    refuse('recovery-unreadable', 'the recovery phrase file is damaged; it is kept');
  return env;
}

/** Atomically write `env` at `path` (its directory created 0700). */
export async function writeEnvelope(
  dir: string,
  path: string,
  env: RecoveryEnvelope,
): Promise<void> {
  if (parseEnvelope(env) === null) throw new Error('invalid-argument: not a recovery envelope');
  await ensurePrivateDir(dir, 'the wallet directory');
  await writePrivateFile(path, new TextEncoder().encode(JSON.stringify(env)));
}

/** The retired phrase files of `pubkey` in `dir` (paths), at most `MAX_RETIRED`, sorted. */
export async function listRetired(dir: string, pubkey: NostrPubkey): Promise<string[]> {
  checkPubkey(pubkey);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return [];
    throw e;
  }
  const re = new RegExp(`^recovery-${pubkey}\\.[0-9a-f]{32}\\.retired$`);
  return names
    .filter((n) => re.test(n))
    .sort()
    .slice(0, MAX_RETIRED)
    .map((n) => join(dir, n));
}

// ---- counters -------------------------------------------------------------------------------

function isCounter(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= MAX_COUNTER;
}

function counterMap(x: unknown): Record<string, number> | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const proto: unknown = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) return null;
  const entries = Object.entries(x as Record<string, unknown>);
  if (entries.length > MAX_KEYSETS) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (!KEYSET_ID.test(k) || !isCounter(v)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * Exactly a `CounterState` — every keyset id hex (v1 or v2), every counter an integer in
 * `[0, 2^31]`, every `published` watermark at or below its keyset's `next` — or `null`.
 */
export function parseCounterState(raw: unknown): walletMod.CounterState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'next,published,v' || o['v'] !== 1) return null;
  const next = counterMap(o['next']);
  const published = counterMap(o['published']);
  if (next === null || published === null) return null;
  for (const [k, p] of Object.entries(published)) {
    const n = next[k];
    if (n === undefined || p > n) return null;
  }
  return { v: 1, next, published };
}

/** The last write started on each counters path (any instance): writes apply in order. */
const writing = new Map<string, Promise<void>>();

function settled(path: string): Promise<void> {
  return (writing.get(path) ?? Promise.resolve()).catch(() => undefined);
}

/**
 * Move `counters-<pubkey>.json` aside (as `counters-<pubkey>.<tag>.retired`) once every save
 * already started on it has landed: the next phrase starts from counter 0 (a phrase's restore
 * scans from 0, so an old phrase's high counters would hide the new one's outputs behind a gap).
 * Only while no money plane holds the wallet. `false` when there was no file. The rename moves
 * the directory entry itself (a symlink is never followed).
 */
export async function retireCounters(
  dir: string,
  pubkey: NostrPubkey,
  tag: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(tag)) throw new Error('invalid-argument: not a tag');
  const path = countersPath(dir, pubkey);
  await settled(path);
  try {
    await rename(path, retiredCountersPath(dir, pubkey, tag));
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return false;
    throw e;
  }
  await syncDir(dir);
  return true;
}

/**
 * Undo `retireCounters(dir, pubkey, tag)` when the new phrase could not be saved after all: the
 * old phrase stays current, so its counters must come back (a missing file would make core
 * probe, a reused counter repeat a secret). Only while no plane is open.
 */
export async function unretireCounters(
  dir: string,
  pubkey: NostrPubkey,
  tag: string,
): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(tag)) throw new Error('invalid-argument: not a tag');
  await rename(retiredCountersPath(dir, pubkey, tag), countersPath(dir, pubkey));
  await syncDir(dir);
}

function retiredCountersPath(dir: string, pubkey: NostrPubkey, tag: string): string {
  checkPubkey(pubkey);
  return join(dir, `counters-${pubkey}.${tag}.retired`);
}

async function syncDir(dir: string): Promise<void> {
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

/**
 * Core's durable `CounterStore` over `counters-<pubkey>.json`. `save` resolves once the state is
 * on disk (fsynced and renamed); saves apply in the order they were made, across instances, and a
 * `load` waits for them. `load` answers `null` only when there is no file; a file that is refused
 * or does not parse as a `CounterState` throws `counters-unreadable:` and is kept — core must
 * then derive nothing (reusing a NUT-13 counter repeats a secret).
 */
export class FileCounterStore implements walletMod.CounterStore {
  readonly path: string;
  private readonly dir: string;

  constructor(dir: string, pubkey: NostrPubkey) {
    this.dir = dir;
    this.path = countersPath(dir, pubkey);
  }

  async load(): Promise<walletMod.CounterState | null> {
    await settled(this.path);
    const raw = await readJson(
      this.path,
      MAX_COUNTERS_FILE_BYTES,
      'counters-unreadable',
      'the counters file',
    );
    if (raw === undefined) return null;
    const state = parseCounterState(raw);
    if (state === null)
      refuse(
        'counters-unreadable',
        'the counters file is damaged; it is kept, and nothing is derived from the phrase until it is repaired',
      );
    return state;
  }

  save(state: walletMod.CounterState): Promise<void> {
    const clean = parseCounterState(state);
    if (clean === null)
      return Promise.reject(new Error('invalid-argument: not a counter state (not saved)'));
    const text = JSON.stringify(clean);
    const path = this.path;
    const run = settled(path).then(async () => {
      await ensurePrivateDir(this.dir, 'the wallet directory');
      await writePrivateFile(path, new TextEncoder().encode(text));
    });
    writing.set(path, run);
    void run
      .catch(() => undefined)
      .then(() => {
        if (writing.get(path) === run) writing.delete(path);
      });
    return run;
  }
}
