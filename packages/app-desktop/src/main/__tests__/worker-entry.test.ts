/**
 * Issue #6 (ADR 0017): the worker entry main hands the host. A dev build spawns the `tsc` output
 * next to main; a packaged build (main's `dist/` IS `resources/app.asar`, which Bare cannot
 * read) spawns the unbundled boot module in the unpacked tree beside the archive.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PACKAGED_WORKER_ENTRY, WORKER_ENTRY, hostArgs, workerEntryFor } from '../args.js';

describe('workerEntryFor', () => {
  it('dev: dist/worker/entry.js next to main', () => {
    const dist = '/home/u/nutflix/packages/app-desktop/dist';
    expect(workerEntryFor(dist)).toBe(join(dist, WORKER_ENTRY));
    expect(WORKER_ENTRY).toBe('worker/entry.js');
  });

  it('packaged: the boot module in app.asar.unpacked, never a path inside the archive', () => {
    const entry = workerEntryFor('/opt/Nutflix/resources/app.asar');
    expect(entry).toBe(join('/opt/Nutflix/resources/app.asar.unpacked', PACKAGED_WORKER_ENTRY));
    expect(PACKAGED_WORKER_ENTRY).toBe('worker/boot.mjs');
    expect(entry).not.toMatch(/app\.asar[\\/]/);
  });

  it('the packaged entry passes through hostArgs unchanged (the host parser takes any absolute path)', () => {
    const workerEntry = workerEntryFor('/opt/Nutflix/resources/app.asar');
    expect(
      hostArgs(
        { devMocks: false, devFixtures: false, userDataDir: undefined, e2eHooks: false },
        { userData: '/home/u/.config/Nutflix', workerEntry },
      ),
    ).toEqual(['--user-data-dir=/home/u/.config/Nutflix', `--worker-entry=${workerEntry}`]);
  });
});
