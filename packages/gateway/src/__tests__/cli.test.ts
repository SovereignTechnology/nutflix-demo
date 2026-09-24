/**
 * The daemon entry behind `deploy/systemd/nutflix-gateway.service`:
 *   `node --jitless …/dist/index.js --config /etc/nutflix/gateway.json`
 * Argument parsing, config refusal (redacted), `--check`, `--keygen`, the real providers'
 * refusals (no key file, an identity that is not the key file's) and a real start with them, a
 * start via the test seam, SIGTERM → graceful close, and the canonical unit's ExecStart
 * contract (read-only assertion against deploy/).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { MintOperationError } from '@cashu/cashu-ts';
import { mocks } from '@sovit/core';
import type { MintUrl } from '@sovit/core';
import type { SeederProcess, SignalName } from '@sovit/seeder';

import { EXIT_CONFIG, main, parseCliArgs } from '../cli/main.js';
import { isLoopbackHost } from '../config.js';
import type { RuntimeDeps } from '../cli/providers.js';
import { MISSING_PROVIDERS_REASON } from '../cli/providers.js';
import type { Gateway } from '../gateway.js';
import { isMainModule } from '../index.js';
import { FakeBlossomAuth } from './fake-blossom-auth.js';
import { FakePayProtocol } from './fake-pay-protocol.js';
import {
  CREATOR_P2PK,
  CREATOR_PUBKEY,
  GW_IDENTITY,
  GW_P2PK,
  GW_PUBKEY,
  MINT_A,
  RELAY,
  request,
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
  /** What `readStdin` returns; `null` = a terminal (refused, like the Node adapter). */
  stdinText: string | null = null;
  readStdin(maxBytes: number): Promise<Uint8Array> {
    if (this.stdinText === null) return Promise.reject(new Error('stdin is a terminal'));
    const b = Buffer.from(this.stdinText);
    return b.length > maxBytes
      ? Promise.reject(new Error('stdin is longer than expected'))
      : Promise.resolve(b);
  }
}

/** A key-file passphrase fixture (never a real credential). */
const PASS = 'gateway-cli-test-passphrase-0123';

/** A valid config document for `dataDir` (no swarm, loopback, a dead loopback relay). */
function baseRaw(dataDir: string): Record<string, unknown> {
  return {
    listen: { host: '127.0.0.1', port: 0 },
    dataDir,
    identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
    relays: ['ws://127.0.0.1:9'],
    policy: {
      satsPerBlock: 1,
      mints: [MINT_A],
      creatorP2pk: CREATOR_P2PK,
      creatorPubkey: CREATOR_PUBKEY,
    },
    blossom: { publicUrl: 'http://gw.test' },
  };
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
      keygen: false,
      help: false,
    });
    expect(parseCliArgs(['--keygen', '--check'])).toEqual({
      error: '--check and --keygen are exclusive',
    });
    expect(parseCliArgs(['--check', '--dev-mocks', '--config', 'x'])).toMatchObject({
      check: true,
      devMocks: true,
    });
    expect(parseCliArgs(['-h'])).toMatchObject({ help: true });
    // Fixed strings: the offending token (which could be a pasted secret) is never echoed.
    expect(parseCliArgs(['--nsec1sentinel'])).toEqual({ error: 'unknown option' });
    expect(parseCliArgs(['nsec1sentinel'])).toEqual({ error: 'unexpected positional argument' });
    expect(parseCliArgs(['--config'])).toEqual({
      error: 'invalid option value (--config takes a path)',
    });
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
        relays: [RELAY],
        policy: {
          satsPerBlock: 1,
          mints: [MINT_A],
          creatorP2pk: CREATOR_P2PK,
          creatorPubkey: CREATOR_PUBKEY,
        },
      }),
    );
    const proc = new FakeProc();
    proc.envMap['NUTFLIX_GATEWAY_CONFIG'] = cfg;
    expect(await main(['--check'], { proc })).toBe(0);
    expect(proc.out.join('\n')).toContain('config ok');
  });

  it('a provider seam that returns nothing → EXIT_CONFIG and the reason', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const proc = new FakeProc();
    const code = await main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(JSON.stringify(baseRaw(t.dir))),
      providers: () => undefined,
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(proc.out.join('\n')).toContain(MISSING_PROVIDERS_REASON);
  });

  it('the real providers: no key file → EXIT_CONFIG naming it, nothing created, never listening', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const data = path.join(t.dir, 'data');
    const proc = new FakeProc();
    const code = await main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(JSON.stringify(baseRaw(data))),
    });
    expect(code).toBe(EXIT_CONFIG);
    const text = proc.out.join('\n');
    expect(text).toContain('runtime providers failed');
    expect(text).toContain('no key file at');
    expect(text).not.toContain('gateway up');
    expect(existsSync(data)).toBe(false);
  });

  it('--keygen needs no identity values yet and prints both; a config whose identity is not the key file’s is refused', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const data = path.join(t.dir, 'data');
    await mkdir(data, { mode: 0o700 });
    const { identity: _identity, ...noIdentity } = baseRaw(data);
    const kg = new FakeProc();
    kg.stdinText = `${PASS}\n`;
    expect(
      await main(['--keygen', '--config', 'c.json'], {
        proc: kg,
        readFile: () => Promise.resolve(JSON.stringify(noIdentity)),
      }),
    ).toBe(0);
    const line = kg.out.find((l) => l.includes('key file created'))!;
    const fields = (JSON.parse(line) as { fields: { publicKey: string; ownP2pk: string } }).fields;
    expect(fields.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(fields.ownP2pk).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(kg.out.join('\n')).not.toContain(PASS);
    // Without --keygen the identity values stay required.
    const noId = new FakeProc();
    expect(
      await main(['--config', 'c.json'], {
        proc: noId,
        readFile: () => Promise.resolve(JSON.stringify(noIdentity)),
      }),
    ).toBe(EXIT_CONFIG);
    expect(noId.out.join('\n')).toContain('$.identity.pubkey');

    // The key file and the credential are right, but the config names another identity.
    const creds = path.join(t.dir, 'creds');
    await mkdir(creds, { mode: 0o700 });
    await writeFile(path.join(creds, 'gateway-key-passphrase'), PASS, { mode: 0o400 });
    const wrong = new FakeProc();
    wrong.envMap['CREDENTIALS_DIRECTORY'] = creds;
    expect(
      await main(['--config', 'c.json'], {
        proc: wrong,
        readFile: () => Promise.resolve(JSON.stringify(baseRaw(data))),
      }),
    ).toBe(EXIT_CONFIG);
    expect(wrong.out.join('\n')).toContain('not the key file');
    // The lock was freed: the right identity starts (then stops at once).
    const right = new FakeProc();
    right.envMap['CREDENTIALS_DIRECTORY'] = creds;
    right.envMap['NUTFLIX_GATEWAY_LISTEN_PORT'] = '0';
    let started: Gateway | null = null;
    void main(['--config', 'c.json'], {
      proc: right,
      readFile: () =>
        Promise.resolve(
          JSON.stringify({
            ...baseRaw(data),
            identity: { pubkey: fields.publicKey, p2pk: fields.ownP2pk },
          }),
        ),
      onStarted: (gw) => {
        started = gw;
      },
    });
    await until(() => started !== null, 30_000);
    expect(right.out.some((l) => l.includes('runtime ready'))).toBe(true);
    right.send('SIGTERM');
    await until(() => right.exits.length === 1, 30_000);
    expect(right.exits).toEqual([0]);
    expect(existsSync(path.join(data, 'wallet', 'lock'))).toBe(false);
  }, 60_000);

  it('starts, listens on the configured loopback port, serves Blossom, and SIGTERM closes it cleanly (exit 0)', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    const proc = new FakeProc();
    proc.envMap['NUTFLIX_GATEWAY_LISTEN_PORT'] = '0';
    proc.envMap['STATE_DIRECTORY'] = t.dir;
    let started: Gateway | null = null;
    const cfg = JSON.stringify({
      identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
      relays: [RELAY],
      policy: {
        satsPerBlock: 1,
        mints: [MINT_A],
        creatorP2pk: CREATOR_P2PK,
        creatorPubkey: CREATOR_PUBKEY,
      },
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
      relays: [RELAY],
      policy: {
        satsPerBlock: 1,
        mints: [MINT_A],
        creatorP2pk: CREATOR_P2PK,
        creatorPubkey: CREATOR_PUBKEY,
      },
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
      relays: [RELAY],
      policy: {
        satsPerBlock: 1,
        mints: [MINT_A],
        creatorP2pk: CREATOR_P2PK,
        creatorPubkey: CREATOR_PUBKEY,
      },
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
      relays: [RELAY],
      policy: {
        satsPerBlock: 1,
        mints: [MINT_A],
        creatorP2pk: CREATOR_P2PK,
        creatorPubkey: CREATOR_PUBKEY,
      },
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
    // The key passphrase arrives as a credential under the id the providers read; nothing secret in env.
    expect(unit).toMatch(/\nLoadCredentialEncrypted=gateway-key-passphrase:\S+\n/);
    for (const line of unit.split('\n').filter((l) => l.startsWith('Environment=')))
      expect(line).not.toMatch(/PASS|NSEC|SECRET|_KEY/i);
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
          relays: ['ws://127.0.0.1:9'],
          policy: {
            satsPerBlock: 2,
            mints: ['https://mint.example'],
            split: { seeder: 50, creator: 50 },
            creatorP2pk: `02${'ef'.repeat(32)}`,
            creatorPubkey: 'c1'.repeat(32),
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

  it('--keygen from a piped passphrase, then a real start with the credential: runtime ready, a mint over HTTP, listening, clean SIGTERM — under the unit flags', async () => {
    const unit = await readFile(path.join(ROOT, 'deploy/systemd/nutflix-gateway.service'), 'utf8');
    const argv = (unit.split('\n').find((l) => l.startsWith('ExecStart=')) ?? '')
      .slice('ExecStart='.length)
      .split(/\s+/);
    const nodeFlags = argv.slice(
      1,
      argv.findIndex((a) => a.endsWith('/dist/index.js')),
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nutflix-gw-run-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const data = path.join(dir, 'data');
    await mkdir(data, { mode: 0o700 });

    // A mint over real HTTP: the in-process TestMint behind a loopback server.
    let mintHits = 0;
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
            (out) => res.end(JSON.stringify(out)),
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
    const mint = new mocks.TestMint({ url: mintUrl, seed: new Uint8Array(32).fill(0x3e) });

    const doc = (identity?: { pubkey: string; p2pk: string }): string =>
      JSON.stringify({
        listen: { host: '127.0.0.1', port: 0 },
        dataDir: data,
        ...(identity === undefined ? {} : { identity }),
        relays: ['ws://127.0.0.1:9'],
        policy: {
          satsPerBlock: 2,
          mints: [mintUrl],
          creatorP2pk: `02${'ef'.repeat(32)}`,
          creatorPubkey: 'c1'.repeat(32),
        },
        blossom: { publicUrl: 'http://gw.test' },
      });
    const cfg = path.join(dir, 'gateway.json');
    await writeFile(cfg, doc());
    const keygen = await spawnEntry(nodeFlags, ['--keygen', '--config', cfg], {
      input: `${PASS}\n`,
    });
    expect(keygen.code).toBe(0);
    expect(keygen.out).not.toContain(PASS);
    const line = keygen.out.split('\n').find((l) => l.includes('key file created'))!;
    const f = (JSON.parse(line) as { fields: { publicKey: string; ownP2pk: string } }).fields;

    await writeFile(cfg, doc({ pubkey: f.publicKey, p2pk: f.ownP2pk }));
    const creds = path.join(dir, 'creds');
    await mkdir(creds, { mode: 0o700 });
    await writeFile(path.join(creds, 'gateway-key-passphrase'), `${PASS}\n`, { mode: 0o400 });
    const run = await spawnEntry(nodeFlags, ['--config', cfg], {
      env: { CREDENTIALS_DIRECTORY: creds },
      stopWhen: ['"gateway up"', '"mint loaded"'],
    });
    expect(run.out).not.toContain('WebAssembly');
    expect(run.out).toContain('"runtime ready"');
    expect(run.out).toMatch(/"mint loaded".*"keysets":1/);
    expect(mintHits).toBeGreaterThan(0);
    expect(run.out).toContain('closed cleanly');
    expect(run.out).not.toContain(PASS);
    expect(run.code).toBe(0);
    expect(existsSync(path.join(data, 'wallet', 'lock'))).toBe(false);
  }, 60_000);
});

/** Spawn the built entry with the unit's node flags; optional stdin, env, and a stop condition. */
function spawnEntry(
  nodeFlags: readonly string[],
  args: readonly string[],
  o: { input?: string; env?: Record<string, string>; stopWhen?: readonly string[] } = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeFlags, DIST_ENTRY, ...args], {
      cwd: ROOT,
      env: { ...o.env },
      stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (o.input !== undefined) child.stdin?.end(o.input);
    let out = '';
    let stopped = false;
    const onData = (b: Buffer): void => {
      out += b.toString('utf8');
      if (o.stopWhen && !stopped && o.stopWhen.every((w) => out.includes(w))) {
        stopped = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`gateway ${args.join(' ')} did not exit; output:\n${out}`));
    }, 45_000);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}
