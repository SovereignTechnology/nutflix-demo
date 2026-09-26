/**
 * Issue #6 (ADR 0017): the worker entry main hands the host. A dev build spawns the `tsc` output
 * next to main; a packaged build (main's `dist/` IS `resources/app.asar`, which Bare cannot
 * read) spawns the unbundled boot module in the unpacked tree beside the archive.
 *
 * Independent review of the packaging lane: the archive is now named by the caller
 * (`appArchive(process.resourcesPath)` in main.ts) instead of being guessed from the first
 * `*.asar` segment, so each case passes it.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { appArchive } from '../../ipc/asar-path.js';
import { PACKAGED_WORKER_ENTRY, WORKER_ENTRY, hostArgs, workerEntryFor } from '../args.js';

const ARCHIVE = '/opt/Nutflix/resources/app.asar';

describe('workerEntryFor', () => {
  it('dev: dist/worker/entry.js next to main', () => {
    const dist = '/home/u/nutflix/packages/app-desktop/dist';
    // The dev Electron has a resources directory of its own; main is not inside its archive.
    const devArchive = appArchive('/home/u/nutflix/node_modules/electron/dist/resources');
    expect(workerEntryFor(dist, devArchive)).toBe(join(dist, WORKER_ENTRY));
    expect(workerEntryFor(dist, undefined)).toBe(join(dist, WORKER_ENTRY));
    expect(WORKER_ENTRY).toBe('worker/entry.js');
  });

  it('packaged: the boot module in app.asar.unpacked, never a path inside the archive', () => {
    const entry = workerEntryFor(ARCHIVE, appArchive('/opt/Nutflix/resources'));
    expect(entry).toBe(join('/opt/Nutflix/resources/app.asar.unpacked', PACKAGED_WORKER_ENTRY));
    expect(PACKAGED_WORKER_ENTRY).toBe('worker/boot.mjs');
    expect(entry).not.toMatch(/app\.asar[\\/]/);
  });

  it('an app.asar that is not the app’s own archive is not treated as one', () => {
    const elsewhere = '/tmp/copy/resources/app.asar';
    expect(workerEntryFor(elsewhere, ARCHIVE)).toBe(join(elsewhere, WORKER_ENTRY));
  });

  it('the packaged entry passes through hostArgs unchanged (the host parser takes any absolute path)', () => {
    const workerEntry = workerEntryFor(ARCHIVE, ARCHIVE);
    expect(
      hostArgs(
        { devMocks: false, devFixtures: false, userDataDir: undefined, e2eHooks: false },
        { userData: '/home/u/.config/Nutflix', workerEntry },
      ),
    ).toEqual(['--user-data-dir=/home/u/.config/Nutflix', `--worker-entry=${workerEntry}`]);
  });
});
