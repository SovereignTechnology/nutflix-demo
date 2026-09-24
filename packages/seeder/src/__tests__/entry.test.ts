/**
 * The package entry as the canonical unit runs it:
 *   `ExecStart=/usr/bin/node --jitless --no-experimental-websocket …/dist/index.js --config …`
 * - `isMainModule` (the self-exec guard, symlinks resolved);
 * - the unit's ExecStart / Type and `package.json` main + export conditions (read-only);
 * - the BUILT `dist/index.js`, spawned with the node flags taken FROM the unit file: `--check`
 *   → 0, no key file → 78 + reason, bad config → 78 without the value, the same through a
 *   symlink; then `--keygen` from a piped passphrase and a real start with the passphrase as a
 *   credential file in `$CREDENTIALS_DIRECTORY` — the whole runtime (argon2id unlock, wallet,
 *   engine, the `ws` relay pool) under `--jitless` — READY, a real mint loaded over HTTP (the
 *   global `fetch` crashes under `--jitless`; the runtime must not use it), and a clean exit on
 *   SIGTERM. This is
 *   the test that caught the `--jitless` crash (MDWE-RESULTS.md §6): an in-process test cannot
 *   see it, because vitest does not run under `--jitless`.
 *
 * The built-entry block needs `npm run build` first (`npm run ci` builds before testing) and
 * is skipped when `dist/` predates the daemon entry.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MintOperationError } from '@cashu/cashu-ts';
import { mocks } from '@sovit/core';
import type { MintUrl } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCliArgs } from '../cli/main.js';
import { isMainModule } from '../index.js';
import { tmpDir } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '../..');
const ROOT = path.resolve(PKG, '../..');
const UNIT = path.join(ROOT, 'deploy/systemd/nutflix-seeder.service');
const DIST_ENTRY = path.join(PKG, 'dist/index.js');
const DIST_MAIN = path.join(PKG, 'dist/cli/main.js');
const P2PK = `02${'ab'.repeat(32)}`;
const CREATOR = 'c1'.repeat(32);
/** A loopback port nothing listens on: the relay pool's connects are refused at once. */
const DEAD_RELAY = 'ws://127.0.0.1:9';
const PASS = 'entry-test-passphrase-0123456789';

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
    // The key passphrase arrives as a credential, under the id the runtime reads.
    expect(unit).toMatch(/\nLoadCredentialEncrypted=seeder-key-passphrase:\S+\n/);
    // …and nothing secret rides the environment.
    for (const line of unit.split('\n').filter((l) => l.startsWith('Environment=')))
      expect(line).not.toMatch(/PASS|NSEC|SECRET|_KEY/i);
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
      keygen: false,
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

interface RunOptions {
  readonly env?: Readonly<Record<string, string>>;
  /** Written to stdin, then stdin is closed (default: stdin ignored). */
  readonly input?: string;
  /** Once the output contains all of these, send SIGTERM (a daemon that started). */
  readonly stopWhen?: string | readonly string[];
  readonly ms?: number;
}

/** Spawn node with the unit's flags on `script`; bounded, with a clear failure message. */
async function runEntry(script: string, args: readonly string[], o: RunOptions = {}): Promise<Run> {
  const ms = o.ms ?? 30_000;
  const argv = await execStart();
  const nodeFlags = argv.slice(
    1,
    argv.findIndex((a) => a.endsWith('/dist/index.js')),
  );
  const child = spawn(process.execPath, [...nodeFlags, script, ...args], {
    cwd: ROOT,
    // A clean environment: nothing from the test runner (NUTFLIX_SEEDER_*, NODE_OPTIONS).
    env: { ...o.env },
    stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (o.input !== undefined) child.stdin?.end(o.input);
  let out = '';
  let stopped = false;
  const onData = (b: Buffer): void => {
    out += b.toString('utf8');
    const want = o.stopWhen === undefined ? [] : [o.stopWhen].flat();
    if (want.length > 0 && !stopped && want.every((w) => out.includes(w))) {
      stopped = true;
      child.kill('SIGTERM');
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
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
  it('--check → 0; no key file → 78 + reason; bad config → 78 without the value; same via a symlink', async () => {
    const t = await tmpDir('nutflix-seeder-dist-');
    cleanups.push(t.rm);
    const good = path.join(t.dir, 'seeder.json');
    await writeFile(
      good,
      JSON.stringify({
        dataDir: path.join(t.dir, 'data'),
        swarm: null,
        relays: [DEAD_RELAY],
        policy: {
          satsPerBlock: 1,
          mints: ['https://mint.example'],
          creatorP2pk: P2PK,
          creatorPubkey: CREATOR,
        },
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
    expect(start.out).toContain('refusing to start');
    expect(start.out).toContain('no key file at');
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

  it('--keygen from a piped passphrase, then a real start with it as a systemd credential: READY under --jitless, clean exit on SIGTERM', async () => {
    const t = await tmpDir('nutflix-seeder-dist-run-');
    cleanups.push(t.rm);
    const data = path.join(t.dir, 'data');
    await mkdir(data, { mode: 0o700 });
    const cfg = path.join(t.dir, 'seeder.json');
    await writeFile(
      cfg,
      JSON.stringify({
        dataDir: data,
        swarm: null,
        relays: [DEAD_RELAY],
        policy: {
          satsPerBlock: 1,
          mints: ['https://mint.example'],
          creatorP2pk: P2PK,
          creatorPubkey: CREATOR,
        },
      }),
    );
    const keygen = await runEntry(DIST_ENTRY, ['--keygen', '--config', cfg], {
      input: `${PASS}\n`,
    });
    expect({ code: keygen.code, out: keygen.out.includes('key file created') }).toEqual({
      code: 0,
      out: true,
    });
    expect(keygen.out).not.toContain(PASS);
    expect((await stat(path.join(data, 'identity.key'))).mode & 0o777).toBe(0o600);

    // A mint over real HTTP: the in-process TestMint behind a loopback server (JSON both ways,
    // mint errors as 400 { code, detail }). The daemon loads every accepted mint at start.
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        mintHits++;
        mint
          .request({
            endpoint: `${mintUrl}${req.url ?? '/'}`,
            method: req.method ?? 'GET',
            ...(body === '' ? {} : { requestBody: JSON.parse(body) as Record<string, unknown> }),
          })
          .then(
            (out) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(out));
            },
            (e: unknown) => {
              res.statusCode = e instanceof MintOperationError ? 400 : 500;
              res.end(
                JSON.stringify(
                  e instanceof MintOperationError ? { code: e.code, detail: e.message } : {},
                ),
              );
            },
          );
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          srv.closeAllConnections();
          srv.close(() => {
            r();
          });
        }),
    );
    const mintUrl = `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}` as MintUrl;
    const mint = new mocks.TestMint({ url: mintUrl, seed: new Uint8Array(32).fill(0x2e) });
    let mintHits = 0;
    const cfgWithMint = path.join(t.dir, 'seeder-mint.json');
    await writeFile(
      cfgWithMint,
      JSON.stringify({
        dataDir: data,
        swarm: null,
        relays: [DEAD_RELAY],
        policy: { satsPerBlock: 1, mints: [mintUrl], creatorP2pk: P2PK, creatorPubkey: CREATOR },
        // Payout looks up the owner's kind 10019 over the ws relay pool at start (dead relay here).
        payout: { pubkey: '0e'.repeat(32), p2pk: `02${'0d'.repeat(32)}` },
      }),
    );

    // What systemd's LoadCredentialEncrypted= leaves behind: a private directory, one file.
    const creds = path.join(t.dir, 'credentials');
    await mkdir(creds, { mode: 0o700 });
    await writeFile(path.join(creds, 'seeder-key-passphrase'), `${PASS}\n`, { mode: 0o400 });
    const run = await runEntry(DIST_ENTRY, ['--config', cfgWithMint], {
      env: { CREDENTIALS_DIRECTORY: creds },
      stopWhen: ['"mint loaded"', 'payout waits'],
      ms: 60_000,
    });
    expect(run.out).toContain('"runtime ready"');
    expect(run.out).toContain('"daemon ready"');
    // The mint was reached over HTTP under --jitless, and its keyset loaded.
    expect(run.out).toMatch(/"mint loaded".*"keysets":1/);
    expect(mintHits).toBeGreaterThan(0);
    // No confirmation from the owner's kind 10019: nothing is paid out, the daemon keeps running.
    expect(run.out).toContain('payout waits');
    expect(run.out).not.toContain('WebAssembly');
    expect(run.out).not.toContain(PASS);
    expect(run.out).toContain('closed cleanly');
    expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
    // The state lock is released at exit, and the wallet directory is private.
    expect(existsSync(path.join(data, 'wallet', 'lock'))).toBe(false);
    expect((await stat(path.join(data, 'wallet'))).mode & 0o777).toBe(0o700);
  }, 120_000);
});
