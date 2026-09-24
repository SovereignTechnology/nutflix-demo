/**
 * The daemon entry behind `deploy/systemd/nutflix-gateway.service`:
 *   `node --jitless …/dist/index.js --config /etc/nutflix/gateway.json`
 * Argument parsing, config refusal (redacted), `--check`, provider refusal (Stage 1),
 * a real start via the test seam, SIGTERM → graceful close, and the canonical unit's
 * ExecStart contract (read-only assertion against deploy/).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { mocks } from '@sovit/core';
import type { SeederProcess, SignalName } from '@sovit/seeder';

import { EXIT_CONFIG, main, parseCliArgs } from '../cli/main.js';
import { isLoopbackHost } from '../config.js';
import type { RuntimeDeps } from '../cli/providers.js';
import { MISSING_PROVIDERS_REASON, getRuntimeDeps } from '../cli/providers.js';
import type { Gateway } from '../gateway.js';
import { isMainModule } from '../index.js';
import { FakeBlossomAuth } from './fake-blossom-auth.js';
import { FakePayProtocol } from './fake-pay-protocol.js';
import {
  CREATOR_P2PK,
  GW_IDENTITY,
  GW_P2PK,
  GW_PUBKEY,
  MINT_A,
  request,
  testConfig,
  tmpDir,
  until,
} from './helpers.js';

class FakeProc implements SeederProcess {
  readonly argv: readonly string[] = [];
  readonly out: string[] = [];
  readonly err: string[] = [];
  readonly exits: number[] = [];
  readonly signals = new Map<SignalName, (() => void)[]>();
  readonly envMap: Record<string, string> = {};
  env(name: string): string | undefined {
    return this.envMap[name];
  }
  writeStdout(line: string): void {
    this.out.push(line);
  }
  writeStderr(line: string): void {
    this.err.push(line);
  }
  onSignal(signal: SignalName, cb: () => void): () => void {
    const list = this.signals.get(signal) ?? [];
    list.push(cb);
    this.signals.set(signal, list);
    return () => undefined;
  }
  exit(code: number): void {
    this.exits.push(code);
  }
  run(): Promise<{ code: number }> {
    return Promise.resolve({ code: 0 });
  }
  send(signal: SignalName): void {
    for (const cb of this.signals.get(signal) ?? []) cb();
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function mockDeps(): RuntimeDeps {
  const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
  return {
    seederEngine: engine,
    viewerEngine: engine,
    auth: new FakeBlossomAuth(),
    payProtocol: () => new FakePayProtocol(),
    identity: GW_IDENTITY,
  };
}

describe('parseCliArgs', () => {
  it('accepts --config/--check/--dev-mocks/--help and rejects unknown flags and positionals', () => {
    expect(parseCliArgs(['--config', '/etc/nutflix/gateway.json'])).toEqual({
      config: '/etc/nutflix/gateway.json',
      devMocks: false,
      check: false,
      help: false,
    });
    expect(parseCliArgs(['--check', '--dev-mocks', '--config', 'x'])).toMatchObject({
      check: true,
      devMocks: true,
    });
    expect(parseCliArgs(['-h'])).toMatchObject({ help: true });
    expect(parseCliArgs(['--bogus'])).toHaveProperty('error');
    expect(parseCliArgs(['stray'])).toHaveProperty('error');
  });
});

describe('main()', () => {
  it('no config → EXIT_CONFIG; unreadable file → EXIT_CONFIG; invalid config → EXIT_CONFIG with paths only', async () => {
    const proc = new FakeProc();
    expect(await main([], { proc })).toBe(EXIT_CONFIG);
    expect(proc.out.join('\n')).toContain('no config');
    expect(await main(['--config', '/nonexistent/gateway.json'], { proc })).toBe(EXIT_CONFIG);
    expect(proc.out.join('\n')).toContain('could not be read');
    const secret = 'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const bad = JSON.stringify({
      dataDir: '/tmp/x',
      identity: { pubkey: secret, p2pk: 'zz' },
      listen: { port: 99999 },
    });
    const code = await main(['--config', 'bad.json'], {
      proc,
      readFile: () => Promise.resolve(bad),
    });
    expect(code).toBe(EXIT_CONFIG);
    const text = proc.out.join('\n');
    expect(text).toContain('invalid config');
    expect(text).toContain('$.identity.pubkey');
    expect(text).toContain('$.listen.port');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('99999');
    expect(await main(['--nope'], { proc })).toBe(EXIT_CONFIG);
    expect(await main(['--help'], { proc })).toBe(0);
  });

  it('--check validates and exits 0 without starting; NUTFLIX_GATEWAY_CONFIG is the --config fallback', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const cfg = path.join(t.dir, 'gateway.json');
    await writeFile(
      cfg,
      JSON.stringify({
        dataDir: t.dir,
        identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
        policy: { satsPerBlock: 1, mints: [MINT_A], creatorP2pk: CREATOR_P2PK },
      }),
    );
    const proc = new FakeProc();
    proc.envMap['NUTFLIX_GATEWAY_CONFIG'] = cfg;
    expect(await main(['--check'], { proc })).toBe(0);
    expect(proc.out.join('\n')).toContain('config ok');
  });

  it('Stage 1: with no providers wired it refuses to start (EXIT_CONFIG) and says why', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    expect(getRuntimeDeps(testConfig(t.dir))).toBeUndefined();
    const proc = new FakeProc();
    const code = await main(['--config', 'c.json'], {
      proc,
      readFile: () =>
        Promise.resolve(
          JSON.stringify({
            dataDir: t.dir,
            identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
            policy: { satsPerBlock: 1, mints: [MINT_A], creatorP2pk: CREATOR_P2PK },
          }),
        ),
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(proc.out.join('\n')).toContain(MISSING_PROVIDERS_REASON);
  });

  it('starts, listens on the configured loopback port, serves Blossom, and SIGTERM closes it cleanly (exit 0)', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const proc = new FakeProc();
    proc.envMap['NUTFLIX_GATEWAY_LISTEN_PORT'] = '0';
    proc.envMap['STATE_DIRECTORY'] = t.dir;
    let started: Gateway | null = null;
    const cfg = JSON.stringify({
      identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
      policy: { satsPerBlock: 1, mints: [MINT_A], creatorP2pk: CREATOR_P2PK },
      blossom: { publicUrl: 'http://gw.test' },
    });
    const running = main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(cfg),
      providers: () => mockDeps(),
      onStarted: (gw) => {
        started = gw;
      },
    });
    await until(() => started !== null);
    const gw = started!;
    const addr = gw.stats().listening!;
    expect(addr.host).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);
    expect(gw.config.dataDir).toBe(t.dir);
    expect((await request(`http://127.0.0.1:${addr.port}/${'ab'.repeat(32)}`)).status).toBe(404);
    expect(proc.out.some((l) => l.includes('gateway up'))).toBe(true);
    proc.send('SIGTERM');
    await until(() => proc.exits.length === 1);
    expect(proc.exits).toEqual([0]);
    expect(proc.out.some((l) => l.includes('closed cleanly'))).toBe(true);
    expect(gw.stats().listening).toBeNull();
    void running; // never resolves by design; the process exits through the hooks
  });

  it('--dev-mocks is loud: a warn line on every start', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const proc = new FakeProc();
    proc.envMap['NUTFLIX_GATEWAY_LISTEN_PORT'] = '0';
    let started: Gateway | null = null;
    const cfg = JSON.stringify({
      dataDir: t.dir,
      identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
      policy: { satsPerBlock: 1, mints: [MINT_A], creatorP2pk: CREATOR_P2PK },
    });
    void main(['--config', 'c.json', '--dev-mocks'], {
      proc,
      readFile: () => Promise.resolve(cfg),
      onStarted: (gw) => {
        started = gw;
      },
    });
    await until(() => started !== null);
    expect(proc.out.some((l) => l.includes('DEV MOCKS ENABLED') && l.includes('"warn"'))).toBe(
      true,
    );
    proc.send('SIGINT');
    await until(() => proc.exits.length === 1);
  });
});

describe('--dev-mocks loopback fence', () => {
  it('isLoopbackHost: 127/8, ::1, [::1], localhost are loopback; 0.0.0.0, ::, LAN, junk are not', () => {
    for (const h of [
      '127.0.0.1',
      '127.1.2.3',
      '127.255.255.255',
      '::1',
      '[::1]',
      'localhost',
      'LOCALHOST',
      ' 127.0.0.1 ',
    ])
      expect(isLoopbackHost(h), h).toBe(true);
    for (const h of [
      '0.0.0.0',
      '::',
      '192.168.1.5',
      '10.0.0.1',
      '128.0.0.1',
      '127.0.0.256',
      '127.0.0',
      '',
      'localhost.example',
      '::ffff:127.0.0.1',
    ])
      expect(isLoopbackHost(h), h).toBe(false);
  });

  it('--dev-mocks on a non-loopback listen.host → EXIT_CONFIG before the mocks are even loaded', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const proc = new FakeProc();
    let loaderCalls = 0;
    const cfg = JSON.stringify({
      listen: { host: '0.0.0.0', port: 0 },
      dataDir: t.dir,
      identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
      policy: { satsPerBlock: 1, mints: [MINT_A], creatorP2pk: CREATOR_P2PK },
    });
    const code = await main(['--config', 'c.json', '--dev-mocks'], {
      proc,
      readFile: () => Promise.resolve(cfg),
      devMocks: () => {
        loaderCalls++;
        return Promise.resolve(mockDeps());
      },
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(loaderCalls).toBe(0);
    const line = proc.out.find((l) => l.includes('dev-mocks-requires-loopback'));
    expect(line).toBeDefined();
    expect(line).toContain('"host":"0.0.0.0"');
    expect(proc.out.some((l) => l.includes('DEV MOCKS ENABLED'))).toBe(false);
    // The env override is part of the "effective" host: a loopback file + 0.0.0.0 env is refused too.
    proc.envMap['NUTFLIX_GATEWAY_LISTEN_HOST'] = '0.0.0.0';
    const viaEnv = await main(['--config', 'c.json', '--dev-mocks'], {
      proc,
      readFile: () => Promise.resolve(cfg.replace('0.0.0.0', '127.0.0.1')),
      devMocks: () => {
        loaderCalls++;
        return Promise.resolve(mockDeps());
      },
    });
    expect(viaEnv).toBe(EXIT_CONFIG);
    expect(loaderCalls).toBe(0);
  });

  it('--dev-mocks on 127.0.0.1 starts as before (loader called once)', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const proc = new FakeProc();
    let loaderCalls = 0;
    let started: Gateway | null = null;
    const cfg = JSON.stringify({
      listen: { host: '127.0.0.1', port: 0 },
      dataDir: t.dir,
      identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
      policy: { satsPerBlock: 1, mints: [MINT_A], creatorP2pk: CREATOR_P2PK },
    });
    void main(['--config', 'c.json', '--dev-mocks'], {
      proc,
      readFile: () => Promise.resolve(cfg),
      devMocks: () => {
        loaderCalls++;
        return Promise.resolve(mockDeps());
      },
      onStarted: (gw) => {
        started = gw;
      },
    });
    await until(() => started !== null);
    expect(loaderCalls).toBe(1);
    expect(started!.stats().listening?.host).toBe('127.0.0.1');
    proc.send('SIGTERM');
    await until(() => proc.exits.length === 1);
    expect(proc.exits).toEqual([0]);
  });
});

describe('canonical systemd unit (deploy/systemd/nutflix-gateway.service, read-only)', () => {
  it('ExecStart points at this package main with --config; the entry only self-runs as the main module', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const unit = await readFile(path.join(root, 'deploy/systemd/nutflix-gateway.service'), 'utf8');
    const exec = unit.split('\n').find((l) => l.startsWith('ExecStart='));
    expect(exec).toBe(
      'ExecStart=/usr/bin/node --jitless --no-experimental-websocket /opt/nutflix/packages/gateway/dist/index.js --config /etc/nutflix/gateway.json',
    );
    expect(unit).toContain('Type=simple');
    const pkg = JSON.parse(
      await readFile(path.join(root, 'packages/gateway/package.json'), 'utf8'),
    ) as { main: string };
    expect(pkg.main).toBe('./dist/index.js');
    // The flags the unit passes parse; the entry guard is false when imported (as here).
    expect(parseCliArgs(['--config', '/etc/nutflix/gateway.json'])).toMatchObject({
      config: '/etc/nutflix/gateway.json',
    });
    expect(isMainModule(import.meta.url, process.argv[1])).toBe(false);
    expect(isMainModule(import.meta.url, undefined)).toBe(false);
    expect(isMainModule(import.meta.url, fileURLToPath(import.meta.url))).toBe(true);
  });
});

// Security review F16 (deploy/systemd/MDWE-RESULTS.md §6): the gateway died one tick after start
// on Node 22 under the unit's `--jitless` (undici needs WebAssembly). Run the BUILT entry with the
// node flags read from the unit, so dropping a flag or going back to an ESM `node:http` import
// fails here, not on a host.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DIST_ENTRY = path.join(ROOT, 'packages/gateway/dist/index.js');
const builtEntry = existsSync(DIST_ENTRY);

describe.skipIf(!builtEntry)('built entry (dist/index.js) with the unit node flags', () => {
  it('--check stays up and exits 0 (no WebAssembly crash)', async () => {
    const unit = await readFile(path.join(ROOT, 'deploy/systemd/nutflix-gateway.service'), 'utf8');
    const argv = (unit.split('\n').find((l) => l.startsWith('ExecStart=')) ?? '')
      .slice('ExecStart='.length)
      .split(/\s+/);
    const nodeFlags = argv.slice(
      1,
      argv.findIndex((a) => a.endsWith('/dist/index.js')),
    );
    expect(nodeFlags).toEqual(['--jitless', '--no-experimental-websocket']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nutflix-gw-entry-'));
    try {
      const config = path.join(dir, 'gateway.json');
      await writeFile(
        config,
        JSON.stringify({
          listen: { host: '127.0.0.1', port: 0 },
          dataDir: path.join(dir, 'data'),
          identity: { pubkey: 'ab'.repeat(32), p2pk: `02${'cd'.repeat(32)}` },
          policy: {
            satsPerBlock: 2,
            mints: ['https://mint.example'],
            split: { seeder: 50, creator: 50 },
            creatorP2pk: `02${'ef'.repeat(32)}`,
          },
          acceptedMints: ['https://mint.example'],
          blossom: { publicUrl: 'http://gw.test' },
        }),
      );
      const run = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [...nodeFlags, DIST_ENTRY, '--check', '--config', config],
          {
            cwd: ROOT,
            env: {},
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
        child.stderr.on('data', (b: Buffer) => (out += b.toString('utf8')));
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`gateway --check did not exit; output:\n${out}`));
        }, 30_000);
        child.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve({ code, out });
        });
      });
      expect(run.out).not.toContain('WebAssembly');
      expect(run.out).toContain('"config ok"');
      expect(run.code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
