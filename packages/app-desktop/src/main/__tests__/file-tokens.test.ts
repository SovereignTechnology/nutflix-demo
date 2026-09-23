/**
 * SE-1 registry against the REAL filesystem (`fs.promises.lstat`): regular files only — not a
 * symlink (even to a regular file), a directory, a device or a FIFO; single use; bound to the
 * webContents; 10-minute TTL; bounded per webContents.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FILE_TOKEN_TTL_MS,
  FileTokenRegistry,
  MAX_TOKENS_PER_WC,
  type GrantResult,
} from '../file-tokens.js';

let dir = '';
const clock = { now: 0 };

function registry(): FileTokenRegistry {
  return new FileTokenRegistry({
    lstat: (p) => lstat(p),
    now: () => clock.now,
    randomHex: (n) => randomBytes(n).toString('hex'),
    basename: (p) => basename(p),
  });
}

function tokenOf(r: GrantResult): string {
  if (!r.ok) throw new Error(`expected a token, got ${r.error.message}`);
  return r.token;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nf-l6a-tokens-'));
  writeFileSync(join(dir, 'clip.mp4'), Buffer.alloc(4096));
  symlinkSync(join(dir, 'clip.mp4'), join(dir, 'link.mp4'));
  symlinkSync('/etc/passwd', join(dir, 'passwd.mp4'));
  try {
    execFileSync('mkfifo', [join(dir, 'fifo.mp4')]);
  } catch {
    // no mkfifo: the FIFO case is skipped below
  }
});

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

describe('FileTokenRegistry (SE-1)', () => {
  it('mints nf-file:<32 hex> for a regular file, with its name and size', async () => {
    const r = registry();
    const t = tokenOf(await r.grant(1, join(dir, 'clip.mp4')));
    expect(t).toMatch(/^nf-file:[0-9a-f]{32}$/);
    expect(r.consume(1, t)).toEqual({ path: join(dir, 'clip.mp4'), name: 'clip.mp4', size: 4096 });
  });

  it('is single use', async () => {
    const r = registry();
    const t = tokenOf(await r.grant(1, join(dir, 'clip.mp4')));
    expect(r.consume(1, t)).toBeDefined();
    expect(r.consume(1, t)).toBeUndefined();
  });

  it('is bound to the webContents that asked, and burnt when another presents it', async () => {
    const r = registry();
    const t = tokenOf(await r.grant(1, join(dir, 'clip.mp4')));
    expect(r.consume(2, t)).toBeUndefined();
    expect(r.consume(1, t)).toBeUndefined();
  });

  it('expires after 10 minutes', async () => {
    const r = registry();
    clock.now = 5_000;
    const t = tokenOf(await r.grant(1, join(dir, 'clip.mp4')));
    const u = tokenOf(await r.grant(1, join(dir, 'clip.mp4')));
    clock.now = 5_000 + FILE_TOKEN_TTL_MS - 1;
    expect(r.consume(1, t)).toBeDefined();
    clock.now = 5_000 + FILE_TOKEN_TTL_MS;
    expect(r.consume(1, u)).toBeUndefined();
    expect(r.count()).toBe(0);
  });

  it.each([
    ['a symlink to a regular file', 'link.mp4'],
    ['a symlink to a system file', 'passwd.mp4'],
    ['a directory', '.'],
    ['a missing file', 'nope.mp4'],
  ])('refuses %s', async (_n, name) => {
    const r = registry();
    const g = await r.grant(1, join(dir, name));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error.code).toBe('unsupported-input');
    expect(r.count()).toBe(0);
  });

  it('refuses a character device (/dev/null)', async () => {
    const g = await registry().grant(1, '/dev/null');
    expect(g.ok).toBe(false);
  });

  it('refuses a FIFO', async (ctx) => {
    let isFifo: boolean;
    try {
      isFifo = (await lstat(join(dir, 'fifo.mp4'))).isFIFO();
    } catch {
      isFifo = false;
    }
    if (!isFifo) ctx.skip();
    const g = await registry().grant(1, join(dir, 'fifo.mp4'));
    expect(g.ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['relative', 'clip.mp4'],
    ['not a string', 7],
    ['undefined', undefined],
  ])('refuses a %s path with invalid-argument (no lstat)', async (_n, p) => {
    const g = await registry().grant(1, p);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.error.code).toBe('invalid-argument');
  });

  it(`keeps at most ${String(MAX_TOKENS_PER_WC)} per webContents (oldest evicted)`, async () => {
    const r = registry();
    clock.now = 0;
    const first = tokenOf(await r.grant(1, join(dir, 'clip.mp4')));
    for (let i = 1; i < MAX_TOKENS_PER_WC; i++) {
      clock.now = i;
      await r.grant(1, join(dir, 'clip.mp4'));
    }
    clock.now = MAX_TOKENS_PER_WC;
    await r.grant(1, join(dir, 'clip.mp4'));
    expect(r.count(1)).toBe(MAX_TOKENS_PER_WC);
    expect(r.consume(1, first)).toBeUndefined();
    await r.grant(2, join(dir, 'clip.mp4'));
    expect(r.count(2)).toBe(1);
  });

  it('dropWebContents forgets only that webContents', async () => {
    const r = registry();
    await r.grant(1, join(dir, 'clip.mp4'));
    const t2 = tokenOf(await r.grant(2, join(dir, 'clip.mp4')));
    r.dropWebContents(1);
    expect(r.count(1)).toBe(0);
    expect(r.consume(2, t2)).toBeDefined();
  });

  it('consume ignores non-strings and unknown tokens', () => {
    const r = registry();
    expect(r.consume(1, undefined)).toBeUndefined();
    expect(r.consume(1, `nf-file:${'0'.repeat(32)}`)).toBeUndefined();
  });
});
