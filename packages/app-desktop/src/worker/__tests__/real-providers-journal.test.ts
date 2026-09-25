/**
 * The worker's accepted-but-unflushed PAYs (ADR 0011 §12 in the desktop): the daemon's
 * append-only journal in `<storage>/payments/pending.jsonl`, an old `pending.json` migrated, an
 * unreadable journal refusing payments, and the serving cap.
 */
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CashuP2pkPubkey, MintUrl, NostrPubkey } from '@sovit/core';
import { silentLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import { WORKER_MAX_PENDING_PAYS, realProviders } from '../pay/real-providers.js';
import { nodeStateFs } from './helpers/harness.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function start(setup?: (dir: string) => Promise<void>, maxPendingPays?: number) {
  const root = await mkdtemp(join(tmpdir(), 'nf-worker-journal-'));
  dirs.push(root);
  const dir = join(root, 'payments');
  if (setup !== undefined) {
    nodeStateFs.mkdirp(dir);
    await setup(dir);
  }
  const p = realProviders({
    payments: {
      pubkey: 'ab'.repeat(32) as NostrPubkey,
      p2pk: `02${'cd'.repeat(32)}` as CashuP2pkPubkey,
      mints: ['https://mint.example' as MintUrl],
    },
    dir,
    join,
    state: nodeStateFs,
    request: () => Promise.reject(new Error('no host in this test')),
    sidFor: () => undefined,
    priceCeiling: () => 0 as never,
    logger: silentLogger,
    ...(maxPendingPays === undefined ? {} : { maxPendingPays }),
  });
  return { p, dir };
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

describe('worker pending-PAY journal', () => {
  it('the serving cap reaches the seeder: a full queue is not accepting', async () => {
    const { p } = await start(undefined, 0);
    expect(p.accepting?.()).toBe(false);
  });

  it('starts a fresh journal (header only) and serves below the cap', async () => {
    const { p, dir } = await start();
    const text = await readFile(join(dir, 'pending.jsonl'), 'utf8');
    expect(text).toBe('{"format":"nutflix-seeder-pending-journal","v":1}\n');
    expect(p.accepting?.()).toBe(true);
    expect(WORKER_MAX_PENDING_PAYS).toBeGreaterThan(0);
  });

  it('migrates an old pending.json and removes it', async () => {
    const { dir } = await start(async (d) => {
      await writeFile(join(d, 'pending.json'), JSON.stringify({ v: 1, items: [] }), {
        mode: 0o600,
      });
    });
    expect(await exists(join(dir, 'pending.json'))).toBe(false);
    expect(await exists(join(dir, 'pending.jsonl'))).toBe(true);
  });

  it('an unreadable journal keeps payments off rather than drop what it held', async () => {
    await expect(
      start(async (d) => {
        await writeFile(join(d, 'pending.jsonl'), 'not a journal\n{}\n', { mode: 0o600 });
      }),
    ).rejects.toThrow(/payments stay off/);
  });
});
