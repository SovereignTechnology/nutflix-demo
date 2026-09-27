/**
 * Lane P2-owed-viewer (ADR 0018 amendment): the worker's durable record of blocks received and not
 * paid, per seeder pubkey and core, with the terms needed to pay them later — and the write-ahead
 * "may count its whole window" word `SeederCredit` keeps in it (`SeederLedger`).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CashuP2pkPubkey, CoreKeyHex, MintUrl, PricePolicy, Sats } from '@sovit/core';
import type { LogRecord } from '@sovit/seeder';
import { createLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import type { TailTerms } from '../pay/unpaid-record.js';
import {
  MAX_BLOCKS_PER_SEEDER,
  MAX_SEEDERS,
  UNPAID_TTL_MS,
  UnpaidRecord,
} from '../pay/unpaid-record.js';
import type { StateFs } from '../runtime.js';
import { nodeStateFs } from './helpers/harness.js';

const ME = 'a0'.repeat(32);
const S1 = 'b1'.repeat(32);
const S2 = 'b2'.repeat(32);
const CORE = 'c0'.repeat(32) as CoreKeyHex;
const CORE2 = 'c1'.repeat(32) as CoreKeyHex;
const POLICY: PricePolicy = {
  satsPerBlock: 2 as Sats,
  blockSize: 65_536,
  mints: ['https://mint.unpaid.test' as MintUrl],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: ('02' + '33'.repeat(32)) as CashuP2pkPubkey,
};
const terms = (sid: string, over: Partial<TailTerms> = {}): TailTerms => ({
  sid,
  core: CORE,
  first: 0,
  last: 99,
  policy: POLICY,
  ...over,
});
const SID_A = 'aa'.repeat(16);
const SID_B = 'bb'.repeat(16);

const dirs: string[] = [];
const records: UnpaidRecord[] = [];
afterEach(async () => {
  for (const r of records.splice(0)) r.abandon();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function rig(
  o: { dir?: string; now?: () => number; state?: StateFs; lines?: LogRecord[] } = {},
) {
  const dir = o.dir ?? (await mkdtemp(join(tmpdir(), 'nf-unpaid-')));
  if (o.dir === undefined) dirs.push(dir);
  const lines = o.lines ?? [];
  const logger = createLogger({
    level: 'debug',
    sink: (_line, rec) => {
      lines.push(rec);
    },
  });
  const rec = new UnpaidRecord({
    state: o.state ?? nodeStateFs,
    dir,
    join: (...p) => join(...p),
    pubkey: ME,
    logger,
    flushMs: 60_000, // flushes are explicit here
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  records.push(rec);
  return { rec, dir, lines, file: join(dir, `${ME}.json`) };
}

describe('UnpaidRecord: blocks received and not paid', () => {
  it('records per seeder and core with their session; forgets paid ranges; answers an OWED with the intersection only', async () => {
    const { rec } = await rig();
    for (const i of [3, 4, 5, 9]) rec.add(S1, CORE, i, terms(SID_A));
    rec.add(S1, CORE, 20, terms(SID_B));
    rec.add(S2, CORE, 4, terms(SID_A));
    // The seeder reports 4..6, 9..30 and 50: the record holds 4, 5, 9, 20 of those.
    const got = rec.recorded(S1, CORE, [
      [4, 6],
      [9, 30],
      [50, 50],
    ]);
    expect(got.map((b) => b.index)).toEqual([4, 5, 9, 20]);
    expect(got.map((b) => b.terms.sid)).toEqual([SID_A, SID_A, SID_A, SID_B]);
    expect(rec.recorded(S1, CORE2, [[0, 99]])).toEqual([]);
    expect(rec.recorded('ff'.repeat(32), CORE, [[0, 99]])).toEqual([]);
    expect(rec.termsOf(S1, CORE, 20)).toMatchObject({ sid: SID_B, first: 0, last: 99 });
    expect(rec.termsOf(S1, CORE, 21)).toBeNull();
    expect(rec.unpaidFor(SID_A)).toBe(5);
    rec.remove(S1, CORE, 4, 9);
    expect(rec.recorded(S1, CORE, [[0, 99]]).map((b) => b.index)).toEqual([3, 20]);
    rec.remove(S1, CORE, 0, 1_000_000); // a huge range: walks the record, not the range
    expect(rec.recorded(S1, CORE, [[0, 99]])).toEqual([]);
    expect(rec.unpaidFor(SID_A)).toBe(1); // S2's
  });

  it('refuses what cannot be paid later: a block outside its session’s blob, other terms, junk keys', async () => {
    const { rec } = await rig();
    rec.add(S1, CORE, 5, terms(SID_A, { first: 10, last: 20 }));
    rec.add(S1, CORE2, 12, terms(SID_A, { first: 10, last: 20 })); // terms name another core
    rec.add('nope', CORE, 12, terms(SID_A, { first: 10, last: 20 }));
    rec.add(S1, CORE, 12, terms('xyz'));
    rec.add(S1, CORE, 12, terms(SID_A, { policy: { ...POLICY, satsPerBlock: -1 as Sats } }));
    rec.add(S1, CORE, 1.5, terms(SID_A));
    expect(rec.stats()).toMatchObject({ seeders: 0, blocks: 0 });
    rec.add(S1, CORE, 12, terms(SID_A, { first: 10, last: 20 }));
    expect(rec.stats()).toMatchObject({ seeders: 1, blocks: 1, sessions: 1 });
  });

  it('is durable: a flush writes it, a new record reads it back; entries past UNPAID_TTL_MS are dropped at load', async () => {
    let now = 1_000_000_000;
    const a = await rig({ now: () => now });
    a.rec.add(S1, CORE, 7, terms(SID_A));
    a.rec.add(S1, CORE, 8, terms(SID_A));
    a.rec.add(S2, CORE2, 1, terms(SID_B, { core: CORE2 }));
    expect(a.rec.flush()).toBe(true);
    const b = await rig({ dir: a.dir, now: () => now });
    expect(b.rec.recorded(S1, CORE, [[0, 99]]).map((x) => x.index)).toEqual([7, 8]);
    expect(b.rec.termsOf(S2, CORE2, 1)).toMatchObject({ sid: SID_B, core: CORE2, policy: POLICY });
    // Nothing secret or peer-identifying in the file beyond what paying needs, and it is compact.
    const text = await readFile(a.file, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ v: 1 });
    now += UNPAID_TTL_MS;
    const c = await rig({ dir: a.dir, now: () => now });
    expect(c.rec.stats()).toMatchObject({ seeders: 0, blocks: 0 });
  });

  it('a file that is damaged, of another version or out of shape starts an empty record (logged by count, nothing else)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nf-unpaid-'));
    dirs.push(dir);
    const file = join(dir, `${ME}.json`);
    const lines: LogRecord[] = [];
    await writeFile(file, '{oops', { mode: 0o600 });
    expect((await rig({ dir, lines })).rec.stats().blocks).toBe(0);
    await writeFile(file, JSON.stringify({ v: 9, seeders: {}, terms: {} }), { mode: 0o600 });
    expect((await rig({ dir, lines })).rec.stats().blocks).toBe(0);
    const now = Date.now();
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        terms: {
          [SID_A]: { core: CORE, first: 0, last: 9, policy: POLICY, at: now },
          [SID_B]: { core: 'zz', first: 0, last: 9, policy: POLICY, at: now },
        },
        seeders: {
          [S1]: {
            full: false,
            at: now,
            blocks: {
              [CORE]: [
                [1, 2, SID_A],
                [5, 99, SID_A], // past the session's blob: dropped
                [3, 3, SID_B], // terms dropped: dropped
                [4, 4, 'unknown'],
              ],
            },
          },
          nope: { full: true, at: now, blocks: {} },
        },
      }),
      { mode: 0o600 },
    );
    const r = await rig({ dir, lines });
    expect(r.rec.recorded(S1, CORE, [[0, 99]]).map((x) => x.index)).toEqual([1, 2]);
    expect(r.rec.fullBefore('nope')).toBe(false);
    for (const l of lines) {
      const s = JSON.stringify(l);
      expect(s).not.toContain(S1);
      expect(s).not.toContain(CORE);
      expect(s).not.toContain(ME);
    }
  });

  it('bounded: at most MAX_BLOCKS_PER_SEEDER blocks per seeder, MAX_SEEDERS seeders (the least recently touched go)', async () => {
    let now = 1;
    const { rec } = await rig({ now: () => now });
    const wide = terms(SID_A, { first: 0, last: 10 * MAX_BLOCKS_PER_SEEDER });
    for (let i = 0; i < MAX_BLOCKS_PER_SEEDER + 10; i++) rec.add(S1, CORE, i, wide);
    expect(rec.stats().blocks).toBe(MAX_BLOCKS_PER_SEEDER);
    for (let i = 0; i < MAX_SEEDERS + 5; i++) {
      now++;
      rec.add(i.toString(16).padStart(64, '0'), CORE, 0, wide);
    }
    expect(rec.stats().seeders).toBe(MAX_SEEDERS);
    expect(rec.recorded(S1, CORE, [[0, 5]])).toEqual([]); // S1 was touched first: gone
  });
});

describe('UnpaidRecord as the SeederLedger: the write-ahead "full" word', () => {
  it('markFull is on disk before it returns; the next run reads it as an earlier run’s word (fullBefore), this run’s marks are not', async () => {
    const a = await rig();
    expect(a.rec.full(S1)).toBe(false);
    expect(a.rec.markFull(S1)).toBe(true);
    expect(a.rec.full(S1)).toBe(true);
    expect(a.rec.fullBefore(S1)).toBe(false); // this run's own word
    // On disk already — no flush was asked for.
    const text = await readFile(a.file, 'utf8');
    expect(
      (JSON.parse(text) as { seeders: Record<string, { full: boolean }> }).seeders[S1],
    ).toMatchObject({
      full: true,
    });
    a.rec.abandon();
    const b = await rig({ dir: a.dir });
    expect(b.rec.fullBefore(S1)).toBe(true);
    expect(b.rec.full(S1)).toBe(true);
    expect(b.rec.fullBefore(S2)).toBe(false);
  });

  it('a markFull that cannot be written returns false and leaves the word unset (the credit then stays below the window)', async () => {
    let failing = false;
    const state: StateFs = {
      ...nodeStateFs,
      writeAtomic: (p, d) => {
        if (failing) throw new Error('disk full');
        nodeStateFs.writeAtomic(p, d);
      },
    };
    const { rec, lines } = await rig({ state });
    failing = true;
    expect(rec.markFull(S1)).toBe(false);
    expect(rec.full(S1)).toBe(false);
    expect(rec.stats().failures).toBe(1);
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
    failing = false;
    expect(rec.markFull(S1)).toBe(true);
  });

  it('the flush clears the word where what the seeder may count is below its window, sets it where it is not, leaves the others', async () => {
    const { rec } = await rig();
    rec.markFull(S1);
    rec.markFull(S2);
    let reach = [
      { pubkey: S1, reach: 1, window: 4 },
      { pubkey: 'b3'.repeat(32), reach: 4, window: 4 },
    ];
    rec.attachReach(() => reach);
    rec.flush();
    expect(rec.full(S1)).toBe(false);
    expect(rec.full(S2)).toBe(true); // not reported: left as it is
    expect(rec.full('b3'.repeat(32))).toBe(true);
    reach = [{ pubkey: S1, reach: 5, window: 4 }];
    rec.flush();
    expect(rec.full(S1)).toBe(true);
    rec.attachReach(() => {
      throw new Error('credit gone');
    });
    expect(rec.flush()).toBe(true); // every word kept
    expect(rec.full(S1)).toBe(true);
  });

  it('close writes the last state; nothing is recorded or marked afterwards; abandon writes nothing more', async () => {
    const a = await rig();
    a.rec.add(S1, CORE, 1, terms(SID_A));
    a.rec.close();
    a.rec.add(S1, CORE, 2, terms(SID_A));
    expect(a.rec.markFull(S1)).toBe(false);
    const b = await rig({ dir: a.dir });
    expect(b.rec.recorded(S1, CORE, [[0, 9]]).map((x) => x.index)).toEqual([1]);
    b.rec.add(S1, CORE, 3, terms(SID_A));
    b.rec.abandon();
    const c = await rig({ dir: a.dir });
    expect(c.rec.recorded(S1, CORE, [[0, 9]]).map((x) => x.index)).toEqual([1]);
  });
});
