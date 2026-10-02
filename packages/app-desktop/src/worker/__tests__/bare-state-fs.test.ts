/**
 * R9 (owed-viewer review): `bareStateFs` makes a rename, and a file's creation, durable with an
 * fsync of the directory — as the seeder's Node twin does. `bare-fs` cannot load under Node, so
 * the `bare-*` modules are replaced by a recording fake and the order of the calls is checked.
 * That the real `bare-fs` opens and fsyncs a directory on Linux was checked under bare-sidecar's
 * `bare` when this was written.
 */
import { posix } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const files = new Set<string>();
let renameFails = false;
let dirOpenFails = false;
let nextFd = 3;
const fdPath = new Map<number, string>();

vi.mock('bare-fs', () => ({
  default: {
    existsSync: (p: string) => files.has(p),
    unlinkSync: (p: string) => {
      calls.push(`unlink ${p}`);
      if (!files.delete(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    openSync: (p: string, flags: string) => {
      if (flags === 'r' && dirOpenFails)
        throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
      calls.push(`open ${p} ${flags}`);
      if (flags !== 'r') files.add(p);
      const fd = nextFd++;
      fdPath.set(fd, p);
      return fd;
    },
    writeSync: (_fd: number, _b: Uint8Array, _off: number, len: number) => len,
    fsyncSync: (fd: number) => {
      calls.push(`fsync ${fdPath.get(fd) ?? '?'}`);
    },
    closeSync: (fd: number) => {
      calls.push(`close ${fdPath.get(fd) ?? '?'}`);
    },
    renameSync: (from: string, to: string) => {
      calls.push(`rename ${from} ${to}`);
      if (renameFails) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      files.delete(from);
      files.add(to);
    },
  },
}));
vi.mock('bare-path', () => ({ default: posix }));
vi.mock('bare-os', () => ({ default: {} }));
vi.mock('bare-subprocess', () => ({ spawn: () => undefined }));

const { bareStateFs } = await import('../adapters/bare.js');

beforeEach(() => {
  calls.length = 0;
  files.clear();
  fdPath.clear();
  renameFails = false;
  dirOpenFails = false;
});

describe('bareStateFs durability (R9)', () => {
  it('writeAtomic: the tmp file is synced, renamed, and then its directory is synced', () => {
    bareStateFs.writeAtomic('/state/payments/unpaid.json', '{}');
    expect(calls).toEqual([
      'unlink /state/payments/unpaid.json.tmp',
      'open /state/payments/unpaid.json.tmp wx',
      'fsync /state/payments/unpaid.json.tmp',
      'close /state/payments/unpaid.json.tmp',
      'rename /state/payments/unpaid.json.tmp /state/payments/unpaid.json',
      'open /state/payments r',
      'fsync /state/payments',
      'close /state/payments',
    ]);
  });

  it('writeAtomic: a failed rename removes the tmp file, rethrows, and syncs nothing more', () => {
    renameFails = true;
    expect(() => {
      bareStateFs.writeAtomic('/state/a.json', '{}');
    }).toThrow('EXDEV');
    expect(calls.slice(-2)).toEqual([
      'rename /state/a.json.tmp /state/a.json',
      'unlink /state/a.json.tmp',
    ]);
    expect(files.has('/state/a.json.tmp')).toBe(false);
  });

  it('writeAtomic: a filesystem that refuses a directory fsync is not an error', () => {
    dirOpenFails = true;
    bareStateFs.writeAtomic('/state/a.json', '{}');
    expect(files.has('/state/a.json')).toBe(true);
    expect(calls.at(-1)).toBe('rename /state/a.json.tmp /state/a.json');
  });

  it('appendDurable: the append creating the journal syncs its directory; later appends do not', () => {
    bareStateFs.appendDurable('/state/payments/pending.jsonl', 'a\n');
    expect(calls).toEqual([
      'open /state/payments/pending.jsonl a',
      'fsync /state/payments/pending.jsonl',
      'close /state/payments/pending.jsonl',
      'open /state/payments r',
      'fsync /state/payments',
      'close /state/payments',
    ]);
    calls.length = 0;
    bareStateFs.appendDurable('/state/payments/pending.jsonl', 'b\n');
    expect(calls).toEqual([
      'open /state/payments/pending.jsonl a',
      'fsync /state/payments/pending.jsonl',
      'close /state/payments/pending.jsonl',
    ]);
  });
});
