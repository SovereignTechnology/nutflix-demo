/**
 * Issue #6 (ADR 0017): `loadSidecar` in a packaged build. The host bundle sits inside
 * `resources/app.asar`; `bare-sidecar` must be loaded from `app.asar.unpacked/node_modules`
 * (so the `bare` binary it resolves is a real, spawnable file), and a binary that is not
 * executable must fail closed WITHOUT `bare-sidecar`'s require-time `chmod` (a read-only
 * install cannot be repaired, and a signed bundle must not be modified).
 *
 * The packaged tree is simulated in a temp dir: a real copy of bare-sidecar's JS with a fake
 * `prebuilds/<platform>-<arch>/bare` (a shell script), and symlinks to the real packages it
 * requires.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkerProcess } from '../worker/supervisor.js';
import { WorkerRuntimeError, loadSidecar } from '../worker/sidecar.js';

const req = createRequire(import.meta.url);
/** The installed directory of `name` as bare-sidecar resolves it (walk up to its package.json). */
function realPkg(name: string): string {
  const from = createRequire(req.resolve('bare-sidecar'));
  let dir = dirname(from.resolve(name));
  while (!existsSync(join(dir, 'package.json')) || !dir.endsWith(name)) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`cannot find ${name}`);
    dir = up;
  }
  return dir;
}
const binName = process.platform === 'win32' ? 'bare.exe' : 'bare';
const posix = process.platform !== 'win32';

let root = '';
let resources = '';
let fakeBinary = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nf-sidecar-loader-'));
  resources = join(root, 'resources');
  const nm = join(resources, 'app.asar.unpacked', 'node_modules');
  const pkg = join(nm, 'bare-sidecar');
  const src = dirname(req.resolve('bare-sidecar/package'));
  mkdirSync(pkg, { recursive: true });
  for (const f of ['package.json', 'index.js', 'lib'])
    cpSync(join(src, f), join(pkg, f), { recursive: true });
  const bin = join(pkg, 'prebuilds', `${process.platform}-${process.arch}`);
  mkdirSync(bin, { recursive: true });
  fakeBinary = join(bin, binName);
  writeFileSync(fakeBinary, '#!/bin/sh\nexit 7\n');
  chmodSync(fakeBinary, 0o644);
  // bare-sidecar's own runtime requires (under Node): bare-stream and require-asset.
  for (const dep of ['bare-stream', 'require-asset'])
    symlinkSync(realPkg(dep), join(nm, dep), 'dir');
});

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/** The host bundle's URL inside the (simulated) archive. */
const hostUrl = (): string => pathToFileURL(join(resources, 'app.asar', 'host', 'main.js')).href;

describe('loadSidecar — packaged (inside app.asar)', () => {
  it.runIf(posix)('refuses a Bare binary that is not executable, and never chmods it', () => {
    const checked: string[] = [];
    expect(() =>
      loadSidecar({
        moduleUrl: hostUrl(),
        checkExecutable: (p) => {
          checked.push(p);
          const r = spawnSync('test', ['-x', p]);
          if (r.status !== 0) throw new Error('EACCES');
        },
      }),
    ).toThrow(WorkerRuntimeError);
    // It checked the binary bare-sidecar would spawn: the one in the UNPACKED tree.
    expect(checked).toEqual([fakeBinary]);
    // bare-sidecar's lib/bare.js (which would chmod 0755) never ran.
    expect(statSync(fakeBinary).mode & 0o777).toBe(0o644);
  });

  it.runIf(posix)(
    'an executable binary: returns bare-sidecar from the unpacked tree, which spawns that binary',
    async () => {
      chmodSync(fakeBinary, 0o755);
      const Sidecar = loadSidecar({
        moduleUrl: hostUrl(),
        checkExecutable: (p) => {
          const r = spawnSync('test', ['-x', p]);
          if (r.status !== 0) throw new Error('EACCES');
        },
      });
      const proc: WorkerProcess = new Sidecar(join(root, 'no-entry.js'));
      proc.on('error', () => undefined);
      const code = await new Promise<number | null>((done) => {
        proc.on('exit', (c) => {
          done(c);
        });
      });
      // Exit 7 is the fake binary's: the unpacked copy was the one spawned.
      expect(code).toBe(7);
    },
  );
});

describe('loadSidecar — dev build (not in an archive)', () => {
  it('loads the workspace bare-sidecar and leaves the executable check to it (upstream behaviour)', () => {
    let called = 0;
    const Sidecar = loadSidecar({
      moduleUrl: import.meta.url,
      checkExecutable: () => {
        called++;
        throw new Error('must not be asked in a dev build');
      },
    });
    expect(Sidecar).toBe(req('bare-sidecar'));
    expect(called).toBe(0);
  });
});
