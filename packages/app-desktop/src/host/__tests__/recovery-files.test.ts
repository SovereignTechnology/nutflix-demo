/**
 * ADR 0016 on disk: the sealed phrase envelope and the counters file are the signer key file's
 * kind (0600, this user's, no symlink, atomic + fsynced), and a file that exists but is refused
 * or damaged FAILS LOUDLY and is kept — it may be the only record of a phrase, or of counters
 * that must never be reused.
 */
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { NostrPubkey } from '@sovit/core';
import type { wallet as walletMod } from '@sovit/core';

import {
  FileCounterStore,
  MAX_COUNTER,
  countersPath,
  listRetired,
  parseCounterState,
  parseEnvelope,
  readEnvelope,
  recoveryPath,
  retireCounters,
  retiredPath,
  unretireCounters,
  writeEnvelope,
  type RecoveryEnvelope,
} from '../recovery/files.js';

const PK = 'a1'.repeat(32) as NostrPubkey;
const V1 = '00ad268c4d1f5826';
const V2 = `01${'ab'.repeat(32)}`;
const POSIX = process.platform !== 'win32';

const roots: string[] = [];
async function dir(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'nf-n2-files-'));
  roots.push(r);
  return join(r, 'wallet');
}
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const ENV: RecoveryEnvelope = {
  v: 1,
  device: 'cd'.repeat(16),
  created: 1_760_000_000,
  confirmed: false,
  reissued: false,
  relayCopy: true,
  replaces: null,
  sealed: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

describe('the sealed phrase envelope', () => {
  it('written 0600 in a 0700 directory, atomically (no temp file left), read back exactly', async () => {
    const d = await dir();
    const p = recoveryPath(d, PK);
    expect(p.endsWith(`recovery-${PK}.sealed`)).toBe(true);
    await writeEnvelope(d, p, ENV);
    if (POSIX) {
      expect((await stat(p)).mode & 0o777).toBe(0o600);
      expect((await stat(d)).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(d)).toEqual([`recovery-${PK}.sealed`]);
    expect(await readEnvelope(p)).toEqual(ENV);
    await writeEnvelope(d, p, { ...ENV, confirmed: true });
    expect(await readEnvelope(p)).toMatchObject({ confirmed: true });
    expect(await readdir(d)).toEqual([`recovery-${PK}.sealed`]);
  });

  it('none → null; damaged, extra keys, wrong types → `recovery-unreadable`, and the file is kept', async () => {
    const d = await dir();
    const p = recoveryPath(d, PK);
    expect(await readEnvelope(p)).toBeNull();
    await mkdir(d, { recursive: true, mode: 0o700 });
    for (const bad of [
      'not json',
      '[]',
      JSON.stringify({ ...ENV, extra: 1 }),
      JSON.stringify({ ...ENV, v: 2 }),
      JSON.stringify({ ...ENV, device: 'XYZ' }),
      JSON.stringify({ ...ENV, sealed: 'has spaces in it' }),
      JSON.stringify({ ...ENV, replaces: ENV.device }),
      JSON.stringify({ ...ENV, replaces: 'short' }),
      JSON.stringify({ ...ENV, created: -1 }),
      JSON.stringify(Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== 'replaces'))),
    ]) {
      await writeFile(p, bad, { mode: 0o600 });
      await expect(readEnvelope(p)).rejects.toThrow(/^recovery-unreadable: /);
      expect(await readFile(p, 'utf8')).toBe(bad);
    }
  });

  it.skipIf(!POSIX)(
    'a file other users may read, or a symlink, is refused (never followed)',
    async () => {
      const d = await dir();
      const p = recoveryPath(d, PK);
      await writeEnvelope(d, p, ENV);
      await chmod(p, 0o644);
      await expect(readEnvelope(p)).rejects.toThrow(/recovery-unreadable: .*0600/);
      await rm(p);
      const target = join(d, 'elsewhere.json');
      await writeFile(target, JSON.stringify(ENV), { mode: 0o600 });
      await symlink(target, p);
      await expect(readEnvelope(p)).rejects.toThrow(/recovery-unreadable/);
    },
  );

  it('writeEnvelope refuses a malformed envelope; errors never name the path (it holds the pubkey)', async () => {
    const d = await dir();
    await expect(writeEnvelope(d, recoveryPath(d, PK), { ...ENV, device: 'nope' })).rejects.toThrow(
      /invalid-argument/,
    );
    await mkdir(d, { recursive: true, mode: 0o700 });
    await writeFile(recoveryPath(d, PK), 'x', { mode: 0o600 });
    const err = (await readEnvelope(recoveryPath(d, PK)).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(PK);
    expect(err.message).not.toContain(d);
  });

  it('paths refuse anything but a hex pubkey and device id', () => {
    expect(() => recoveryPath('/x', '../../etc' as NostrPubkey)).toThrow(/invalid-argument/);
    expect(() => retiredPath('/x', PK, '../x')).toThrow(/invalid-argument/);
    expect(() => countersPath('/x', 'A1'.repeat(32) as NostrPubkey)).toThrow(/invalid-argument/);
  });

  it('parseEnvelope accepts exactly the shape', () => {
    expect(parseEnvelope(ENV)).toEqual(ENV);
    expect(parseEnvelope({ ...ENV, replaces: 'ef'.repeat(16) })).toMatchObject({
      replaces: 'ef'.repeat(16),
    });
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope({ ...ENV, confirmed: 'yes' })).toBeNull();
  });

  it('retired phrases are listed (sorted, this identity only)', async () => {
    const d = await dir();
    expect(await listRetired(d, PK)).toEqual([]);
    await writeEnvelope(d, retiredPath(d, PK, 'bb'.repeat(16)), ENV);
    await writeEnvelope(d, retiredPath(d, PK, 'aa'.repeat(16)), ENV);
    await writeEnvelope(d, retiredPath(d, 'b2'.repeat(32) as NostrPubkey, 'aa'.repeat(16)), ENV);
    await writeFile(join(d, `recovery-${PK}.zz.retired`), 'x', { mode: 0o600 });
    expect(await listRetired(d, PK)).toEqual([
      retiredPath(d, PK, 'aa'.repeat(16)),
      retiredPath(d, PK, 'bb'.repeat(16)),
    ]);
  });
});

describe('the counters file (core’s CounterStore)', () => {
  const STATE: walletMod.CounterState = {
    v: 1,
    next: { [V1]: 64, [V2]: 32 },
    published: { [V1]: 40 },
  };

  it('save resolves once on disk (0600, atomic); load reads it back; no file → null', async () => {
    const d = await dir();
    const s = new FileCounterStore(d, PK);
    expect(await s.load()).toBeNull();
    await s.save(STATE);
    if (POSIX) expect((await stat(s.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(d)).toEqual([`counters-${PK}.json`]);
    expect(await new FileCounterStore(d, PK).load()).toEqual(STATE);
  });

  it('saves apply in order across instances, and a load waits for them', async () => {
    const d = await dir();
    const a = new FileCounterStore(d, PK);
    const b = new FileCounterStore(d, PK);
    const saves = [];
    for (let i = 1; i <= 20; i++)
      saves.push((i % 2 ? a : b).save({ v: 1, next: { [V1]: i * 32 }, published: {} }));
    const loaded = await a.load();
    expect(loaded?.next[V1]).toBe(640);
    await Promise.all(saves);
    expect(await b.load()).toMatchObject({ next: { [V1]: 640 } });
  });

  it('a damaged file FAILS LOUDLY (`counters-unreadable`) and is kept — never read as empty', async () => {
    const d = await dir();
    const s = new FileCounterStore(d, PK);
    await mkdir(d, { recursive: true, mode: 0o700 });
    for (const bad of [
      '',
      '{',
      '{"v":1,"next":{},"published":{},"x":1}',
      JSON.stringify({ v: 1, next: { [V1]: -1 }, published: {} }),
      JSON.stringify({ v: 1, next: { [V1]: 1.5 }, published: {} }),
      JSON.stringify({ v: 1, next: { [V1]: MAX_COUNTER + 1 }, published: {} }),
      JSON.stringify({ v: 1, next: { nothex: 1 }, published: {} }),
      JSON.stringify({ v: 1, next: { [V1]: 5 }, published: { [V1]: 6 } }),
      JSON.stringify({ v: 1, next: {}, published: { [V1]: 0 } }),
    ]) {
      await writeFile(s.path, bad, { mode: 0o600 });
      await expect(s.load()).rejects.toThrow(/^counters-unreadable: /);
      expect(await readFile(s.path, 'utf8')).toBe(bad);
    }
  });

  it.skipIf(!POSIX)('a counters file other users may read is refused', async () => {
    const d = await dir();
    const s = new FileCounterStore(d, PK);
    await s.save(STATE);
    await chmod(s.path, 0o640);
    await expect(s.load()).rejects.toThrow(/counters-unreadable/);
  });

  it('save refuses a state that is not one (nothing written)', async () => {
    const d = await dir();
    const s = new FileCounterStore(d, PK);
    await expect(s.save({ v: 1, next: { [V1]: 1 }, published: { [V1]: 2 } })).rejects.toThrow(
      /invalid-argument/,
    );
    await expect(s.save({ v: 1, next: { [V1]: Number.NaN }, published: {} })).rejects.toThrow(
      /invalid-argument/,
    );
    expect(await readdir(d).catch(() => [])).toEqual([]);
  });

  it('parseCounterState rejects prototype tricks and too many keysets', () => {
    expect(parseCounterState(STATE)).toEqual(STATE);
    // An object with another prototype is not a plain map: refused whole.
    expect(
      parseCounterState({ v: 1, next: Object.create({ [V1]: 1 }) as object, published: {} }),
    ).toBeNull();
    expect(
      parseCounterState(JSON.parse('{"v":1,"next":{"__proto__":1},"published":{}}')),
    ).toBeNull();
    const many = Object.fromEntries(
      Array.from({ length: 4097 }, (_, i) => [`00${i.toString(16).padStart(14, '0')}`, 1]),
    );
    expect(parseCounterState({ v: 1, next: many, published: {} })).toBeNull();
    expect(parseCounterState({ v: 1, next: [], published: {} })).toBeNull();
  });

  it('retire moves the file aside once pending saves landed; unretire brings it back', async () => {
    const d = await dir();
    const s = new FileCounterStore(d, PK);
    const pending = s.save(STATE);
    const tag = 'ee'.repeat(16);
    expect(await retireCounters(d, PK, tag)).toBe(true);
    await pending;
    expect(await readdir(d)).toEqual([`counters-${PK}.${tag}.retired`]);
    expect(await s.load()).toBeNull();
    await unretireCounters(d, PK, tag);
    expect(await s.load()).toEqual(STATE);
    expect(await retireCounters(d, 'b2'.repeat(32) as NostrPubkey, tag)).toBe(false);
    await expect(retireCounters(d, PK, '../x')).rejects.toThrow(/invalid-argument/);
  });
});
