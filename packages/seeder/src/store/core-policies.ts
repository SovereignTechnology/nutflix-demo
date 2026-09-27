/**
 * The per-core price policies a seeder sells at, kept across restarts (lane W8b-p2p, round-8
 * review, MEDIUM).
 *
 * `Seeder.setCorePolicy` held them in memory only, so after a restart nothing priced a core this
 * node had sold before — a video it uploaded or played, whose blocks are still in its store. The
 * desktop's image path then took such a core for an image core: a thumbnail URL naming it (an
 * attacker's) marked it free on our own seeder (`setFreeCore` refuses only a core with a policy),
 * and every viewer downloaded the whole video from us without paying. Loaded back at start, the
 * policies keep the core sold: `setFreeCore` refuses it, the worker's sold-core check sees it, and
 * the seeder prices it as it did before the restart.
 *
 * File: `<dataDir>/core-policies.json`, `{ version: 1, cores: [{ core, policy }] }`, least
 * recently set first. Loaded once at start (`Seeder.create`); every change is written in the
 * background, serialised and atomic (`JsonStore`: a temp file, then a rename), and `Seeder.close`
 * waits for the writes. The file is local state, still checked entry by entry on load: a
 * malformed entry is dropped (counted), and a file that does not parse starts empty (the caller
 * logs it). At most `MAX_REMEMBERED_CORE_POLICIES` are kept; beyond it the least recently set go
 * first (those cores are then unpriced after a restart, as every core was before this file).
 *
 * Nothing here logs.
 */
import type { CoreKeyHex, PricePolicy } from '@sovit/core';
import { payment } from '@sovit/core';

import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';
import { JsonStore } from './json-store.js';

export const CORE_POLICY_FILE = 'core-policies.json' as const;
/** Cores whose policy is kept across restarts (the least recently set go first). */
export const MAX_REMEMBERED_CORE_POLICIES = 16_384;

interface CorePolicyEntry {
  readonly core: CoreKeyHex;
  readonly policy: PricePolicy;
}

interface CorePolicyFile {
  readonly version: 1;
  readonly cores: readonly CorePolicyEntry[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A safe integer ≥ `min`. */
function isCount(v: unknown, min = 0): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
}

/** A policy as `setCorePolicy` is given one: the fields and their types, no more. */
export function isStoredPolicy(p: unknown): p is PricePolicy {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  const mints = o['mints'];
  const p2pk = o['creatorP2pk'];
  const minPay = o['minPaySats'];
  return (
    isCount(o['satsPerBlock']) &&
    isCount(o['blockSize'], 1) &&
    Array.isArray(mints) &&
    mints.length <= 64 &&
    mints.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 2048) &&
    payment.isValidSplit(o['split']) &&
    typeof p2pk === 'string' &&
    p2pk.length > 0 &&
    p2pk.length <= 256 &&
    (minPay === undefined || isCount(minPay, 1))
  );
}

/** Only the fields a policy has (a stored copy carries nothing else). */
function copyPolicy(p: PricePolicy): PricePolicy {
  return {
    satsPerBlock: p.satsPerBlock,
    blockSize: p.blockSize,
    mints: [...p.mints],
    split: { seeder: p.split.seeder, creator: p.split.creator },
    creatorP2pk: p.creatorP2pk,
    ...(p.minPaySats === undefined ? {} : { minPaySats: p.minPaySats }),
  };
}

export interface CorePolicyStoreOptions {
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly dataDir: string;
}

export class CorePolicyStore {
  private readonly store: JsonStore<CorePolicyFile>;
  /** core → policy, least recently set first. */
  private readonly policies = new Map<CoreKeyHex, PricePolicy>();
  private writeChain: Promise<void> = Promise.resolve();
  /** A write is queued and not started: it takes the snapshot when it starts (coalesced). */
  private queued = false;
  /** The most recently set core (the map's last key), `null` when unknown. */
  private newest: CoreKeyHex | null = null;
  private loaded = false;
  private droppedEntries = 0;
  /** True if the file on disk was unparseable and has been ignored (the caller logs it). */
  corruptOnLoad = false;
  /** Last write failure, if any (the policies stay in force in memory). */
  lastPersistError: Error | null = null;

  constructor(opts: CorePolicyStoreOptions) {
    this.store = new JsonStore<CorePolicyFile>(
      opts.fs,
      opts.crypto,
      opts.fs.join(opts.dataDir, CORE_POLICY_FILE),
      (raw) => this.validate(raw),
      () => ({ version: 1, cores: [] }),
    );
  }

  /** Entries of the file that were malformed and dropped at load. */
  get dropped(): number {
    return this.droppedEntries;
  }

  async load(): Promise<void> {
    const { value, corrupt } = await this.store.load();
    this.corruptOnLoad = corrupt;
    this.policies.clear();
    for (const e of value.cores) this.remember(e.core, e.policy);
    this.loaded = true;
  }

  /** The policies kept, least recently set first. */
  entries(): ReadonlyMap<CoreKeyHex, PricePolicy> {
    return this.policies;
  }

  /**
   * Keep `policy` for `core` (or with `null` forget it) and write the file in the background —
   * unless nothing changed. A policy of the wrong shape is not kept (`false`).
   */
  set(core: CoreKeyHex, policy: PricePolicy | null): boolean {
    // Never clobber a file we have not read yet.
    if (!this.loaded) throw new Error('CorePolicyStore: call load() before mutating');
    if (!HEX64.test(core)) return false;
    if (policy === null) {
      if (this.policies.delete(core)) {
        if (this.newest === core) this.newest = null;
        this.persist();
      }
      return true;
    }
    if (!isStoredPolicy(policy)) return false;
    const copy = copyPolicy(policy);
    const had = this.policies.get(core);
    // Unchanged and already the most recent: nothing to write (a replay of the same video).
    if (this.newest === core && had !== undefined && JSON.stringify(had) === JSON.stringify(copy))
      return true;
    this.remember(core, copy);
    this.persist();
    return true;
  }

  /** Resolves once every change made so far has hit the disk (or failed: `lastPersistError`). */
  flushed(): Promise<void> {
    return this.writeChain;
  }

  private remember(core: CoreKeyHex, policy: PricePolicy): void {
    this.policies.delete(core);
    this.policies.set(core, policy);
    this.newest = core;
    while (this.policies.size > MAX_REMEMBERED_CORE_POLICIES) {
      const oldest = this.policies.keys().next();
      if (oldest.done === true) break;
      this.policies.delete(oldest.value);
    }
  }

  /** Write the file after the writes before it; a burst of changes is one write. */
  private persist(): void {
    if (this.queued) return;
    this.queued = true;
    this.writeChain = this.writeChain
      .then(() => {
        this.queued = false;
        const snapshot: CorePolicyFile = {
          version: 1,
          cores: [...this.policies].map(([core, policy]) => ({ core, policy })),
        };
        return this.store.save(snapshot);
      })
      .then(() => {
        this.lastPersistError = null;
      })
      .catch((err: unknown) => {
        this.lastPersistError = err instanceof Error ? err : new Error(String(err));
      });
  }

  /** The file's shape (`null`: not a file this build reads); malformed entries are dropped. */
  private validate(raw: unknown): CorePolicyFile | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (o['version'] !== 1 || !Array.isArray(o['cores'])) return null;
    const cores: CorePolicyEntry[] = [];
    let dropped = 0;
    for (const e of o['cores'] as unknown[]) {
      const x = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : null;
      const core = x?.['core'];
      const policy = x?.['policy'];
      if (typeof core !== 'string' || !HEX64.test(core) || !isStoredPolicy(policy)) {
        dropped++;
        continue;
      }
      cores.push({ core: core as CoreKeyHex, policy: copyPolicy(policy) });
    }
    this.droppedEntries = dropped;
    return { version: 1, cores };
  }
}
