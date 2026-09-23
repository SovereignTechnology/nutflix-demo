/**
 * The package entry as the canonical unit runs it:
 *   `ExecStart=/usr/bin/node --jitless --no-experimental-websocket …/dist/index.js --config …`
 * - `isMainModule` (the self-exec guard, symlinks resolved);
 * - the unit's ExecStart / Type and `package.json` main + export conditions (read-only);
 * - the BUILT `dist/index.js`, spawned with the node flags taken FROM the unit file: `--check`
 *   → 0, no providers → 78 + reason, bad config → 78 without the value, and the same through
 *   a symlink. This is the test that caught the `--jitless` crash (MDWE-RESULTS.md §6): an
 *   in-process test cannot see it, because vitest does not run under `--jitless`.
 *
 * The built-entry block needs `npm run build` first (`npm run ci` builds before testing) and
 * is skipped when `dist/` predates the daemon entry.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parseCliArgs } from '../cli/main.js';
import { MISSING_PROVIDERS_REASON } from '../cli/providers.js';
import { isMainModule } from '../index.js';
import { tmpDir } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '../..');
const ROOT = path.resolve(PKG, '../..');
const UNIT = path.join(ROOT, 'deploy/systemd/nutflix-seeder.service');
const DIST_ENTRY = path.join(PKG, 'dist/index.js');
const DIST_MAIN = path.join(PKG, 'dist/cli/main.js');
const P2PK = `02${'ab'.repeat(32)}`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function execStart(): Promise<string[]> {
  const unit = await readFile(UNIT, 'utf8');
  const line = unit.split('\n').find((l) => l.startsWith('ExecStart='));
  if (line === undefined) throw new Error('nutflix-seeder.service has no ExecStart=');
  return line.slice('ExecStart='.length).split(/\s+/);
}

describe('isMainModule', () => {
  it('true only for the script node was started with, symlinks resolved', async () => {
    const self = fileURLToPath(import.meta.url);
    expect(isMainModule(import.meta.url, undefined)).toBe(false);
    expect(isMainModule(import.meta.url, process.argv[1])).toBe(false); // vitest is main here
    expect(isMainModule(import.meta.url, self)).toBe(true);
    expect(isMainModule(import.meta.url, path.join(HERE, 'no-such-file.js'))).toBe(false);
    expect(isMainModule('file:///no/such/module.js', self)).toBe(false);
    const t = await tmpDir('nutflix-seeder-entry-');
    cleanups.push(t.rm);
    const link = path.join(t.dir, 'nutflix-seeder');
    await symlink(self, link);
    expect(isMainModule(import.meta.url, link)).toBe(true);
  });
});

describe('canonical systemd unit (deploy/systemd/nutflix-seeder.service, read-only)', () => {
  it('ExecStart runs this package main with --config under --jitless + --no-experimental-websocket', async () => {
    expect(await execStart()).toEqual([
      '/usr/bin/node',
      '--jitless',
      '--no-experimental-websocket',
      '/opt/nutflix/packages/seeder/dist/index.js',
      '--config',
      '/etc/nutflix/seeder.json',
    ]);
    const unit = await readFile(UNIT, 'utf8');
    expect(unit).toContain('\nType=simple\n');
    expect(unit).toContain('\nMemoryDenyWriteExecute=yes\n');
    expect(unit).toContain('\nStateDirectory=nutflix-seeder\n');
    const pkg = JSON.parse(await readFile(path.join(PKG, 'package.json'), 'utf8')) as {
      main: string;
      exports: { '.': { bare: string; default: string } };
    };
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.exports['.'].default).toBe('./dist/index.js');
    expect(pkg.exports['.'].bare).toBe('./dist/portable.js');
    expect(parseCliArgs(['--config', '/etc/nutflix/seeder.json'])).toEqual({
      config: '/etc/nutflix/seeder.json',
      check: false,
      help: false,
    });
  });
});

const built = existsSync(DIST_MAIN) && readFileSync(DIST_ENTRY, 'utf8').includes('isMainModule');

interface Run {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly out: string;
}

/** Spawn node with the unit's flags on `script`; bounded, with a clear failure message. */
async function runEntry(script: string, args: readonly string[], ms = 30_000): Promise<Run> {
  const argv = await execStart();
  const nodeFlags = argv.slice(
    1,
    argv.findIndex((a) => a.endsWith('/dist/index.js')),
  );
  const child = spawn(process.execPath, [...nodeFlags, script, ...args], {
    cwd: ROOT,
    // A clean environment: nothing from the test runner (NUTFLIX_SEEDER_*, NODE_OPTIONS).
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
  child.stderr.on('data', (b: Buffer) => (out += b.toString('utf8')));
  return new Promise<Run>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`${script} ${args.join(' ')} did not exit within ${ms} ms; output:\n${out}`),
      );
    }, ms);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

describe.skipIf(!built)('built entry (dist/index.js) with the unit node flags', () => {
  it('--check → 0; no providers → 78 + reason; bad config → 78 without the value; same via a symlink', async () => {
    const t = await tmpDir('nutflix-seeder-dist-');
    cleanups.push(t.rm);
    const good = path.join(t.dir, 'seeder.json');
    await writeFile(
      good,
      JSON.stringify({
        dataDir: path.join(t.dir, 'data'),
        swarm: null,
        policy: { satsPerBlock: 1, mints: ['https://mint.example'], creatorP2pk: P2PK },
      }),
    );
    const bad = path.join(t.dir, 'bad.json');
    await writeFile(
      bad,
      JSON.stringify({ dataDir: 'SENTINEL-dir', policy: { mints: 'SENTINEL' } }),
    );

    const check = await runEntry(DIST_ENTRY, ['--check', '--config', good]);
    expect(check.out).toContain('"config ok"');
    expect(check.out).not.toContain('WebAssembly');
    expect({ code: check.code, signal: check.signal }).toEqual({ code: 0, signal: null });

    const start = await runEntry(DIST_ENTRY, ['--config', good]);
    expect(start.out).toContain(MISSING_PROVIDERS_REASON);
    expect(start.code).toBe(78);
    expect(existsSync(path.join(t.dir, 'data'))).toBe(false); // refused before touching state

    const invalid = await runEntry(DIST_ENTRY, ['--config', bad]);
    expect(invalid.code).toBe(78);
    expect(invalid.out).toContain('$.policy.mints');
    expect(invalid.out).not.toContain('SENTINEL');

    const link = path.join(t.dir, 'nutflix-seeder');
    await symlink(DIST_ENTRY, link);
    const viaLink = await runEntry(link, ['--check', '--config', good]);
    expect({ code: viaLink.code, ok: viaLink.out.includes('"config ok"') }).toEqual({
      code: 0,
      ok: true,
    });
  }, 120_000);
});
