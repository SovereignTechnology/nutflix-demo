/**
 * Lane W8b-p2p (round-8 review, MEDIUM): `CorePolicyStore`, the per-core price policies a seeder
 * keeps across restarts — bounded, coalesced writes, a write that fails is reported.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { mocks } from '@sovit/core';
import type { CoreKeyHex, PricePolicy } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import type { SeederFs } from '../adapters/fs.js';
import {
  CORE_POLICY_FILE,
  CorePolicyStore,
  MAX_REMEMBERED_CORE_POLICIES,
} from '../store/core-policies.js';
import { adapters, tmpDir } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const policy = (sats: number): PricePolicy => ({
  satsPerBlock: sats as never,
  blockSize: 1024,
  mints: [mocks.MINTS.a],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: mocks.asP2pk('creator'),
});
const coreN = (n: number): CoreKeyHex => n.toString(16).padStart(64, '0') as CoreKeyHex;

async function store(fs: SeederFs = adapters.fs) {
  const t = await tmpDir();
  cleanups.push(t.rm);
  const s = new CorePolicyStore({ fs, crypto: adapters.crypto, dataDir: t.dir });
  await s.load();
  return { s, dir: t.dir };
}

describe('CorePolicyStore', () => {
  it('refuses to be written before it was read, and keeps only policies of the right shape', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const s = new CorePolicyStore({ ...adapters, dataDir: t.dir });
    expect(() => s.set(coreN(1), policy(1))).toThrow(/load\(\)/);
    await s.load();
    expect(s.set('nope' as CoreKeyHex, policy(1))).toBe(false);
    expect(s.set(coreN(1), { ...policy(1), blockSize: 0 })).toBe(false);
    expect(s.set(coreN(1), { ...policy(1), extra: 'x' } as PricePolicy)).toBe(true);
    await s.flushed();
    // Only a policy's own fields are kept.
    expect(s.entries().get(coreN(1))).toEqual(policy(1));
  });

  it('keeps at most MAX_REMEMBERED_CORE_POLICIES, the least recently set going first; a burst is one write', async () => {
    let writes = 0;
    const fs: SeederFs = {
      ...adapters.fs,
      writeFile: (p, data) => {
        writes++;
        return adapters.fs.writeFile(p, data);
      },
    };
    const { s, dir } = await store(fs);
    for (let i = 0; i <= MAX_REMEMBERED_CORE_POLICIES; i++) s.set(coreN(i), policy(1));
    s.set(coreN(1), policy(2)); // set again: the most recent now
    await s.flushed();
    expect(writes).toBe(1);
    expect(s.entries().size).toBe(MAX_REMEMBERED_CORE_POLICIES);
    expect(s.entries().has(coreN(0))).toBe(false);
    expect([...s.entries().keys()].at(-1)).toBe(coreN(1));
    const again = new CorePolicyStore({ ...adapters, dataDir: dir });
    await again.load();
    expect(again.entries().size).toBe(MAX_REMEMBERED_CORE_POLICIES);
    expect(again.entries().get(coreN(1))).toEqual(policy(2));
    expect(again.entries().has(coreN(0))).toBe(false);
    // Setting the same policy again for the most recent core writes nothing.
    again.set(coreN(1), policy(2));
    await again.flushed();
    const file = JSON.parse(await readFile(path.join(dir, CORE_POLICY_FILE), 'utf8')) as {
      cores: unknown[];
    };
    expect(file.cores).toHaveLength(MAX_REMEMBERED_CORE_POLICIES);
  });

  it('a write that fails is reported (lastPersistError), and the next one clears it', async () => {
    let fail = true;
    const fs: SeederFs = {
      ...adapters.fs,
      writeFile: (p, data) =>
        fail ? Promise.reject(new Error('disk full')) : adapters.fs.writeFile(p, data),
    };
    const { s } = await store(fs);
    s.set(coreN(1), policy(1));
    await s.flushed();
    expect(s.lastPersistError?.message).toBe('disk full');
    fail = false;
    s.set(coreN(2), policy(1));
    await s.flushed();
    expect(s.lastPersistError).toBeNull();
  });
});
