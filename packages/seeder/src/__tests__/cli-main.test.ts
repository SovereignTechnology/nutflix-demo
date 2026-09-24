/**
 * The daemon entry behind `deploy/systemd/nutflix-seeder.service` (`cli/main.ts`):
 * argument parsing, config refusal (redacted, exit 78), `--check`, the Stage 1 provider
 * refusal, a real start through the `providers` test seam (`runDaemon()` with the parsed
 * config, READY, graceful close on a signal), and a runtime failure (exit 1).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mocks } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { DAEMON_ENV } from '../cli/config-file.js';
import type { DaemonConfig } from '../cli/config-file.js';
import { EXIT_CONFIG, USAGE, main, parseCliArgs } from '../cli/main.js';
import { MISSING_PROVIDERS_REASON, getRuntimeDeps } from '../cli/providers.js';
import type { RuntimeDeps } from '../cli/providers.js';
import type { Seeder } from '../seeder.js';
import { FakeProcess, until } from './fake-process.js';
import { tmpDir } from './helpers.js';

const P2PK = `02${'ab'.repeat(32)}`;
const MINT = 'https://mint.example';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function scratch(): Promise<string> {
  const t = await tmpDir('nutflix-seeder-cli-');
  cleanups.push(t.rm);
  return t.dir;
}

/** A config that never touches the network: no swarm. */
function goodConfig(dataDir: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dataDir,
    swarm: null,
    policy: { satsPerBlock: 3, mints: [MINT], creatorP2pk: P2PK },
    ...extra,
  });
}

const fakeDeps = (): RuntimeDeps => ({
  engine: new mocks.MockPaymentEngine({ mode: 'honest' }),
});

describe('parseCliArgs', () => {
  it('accepts --config/--check/--help; errors are fixed strings that never quote the token', () => {
    expect(parseCliArgs(['--config', '/etc/nutflix/seeder.json'])).toEqual({
      config: '/etc/nutflix/seeder.json',
      check: false,
      help: false,
    });
    expect(parseCliArgs(['--check', '--config=x'])).toEqual({
      config: 'x',
      check: true,
      help: false,
    });
    expect(parseCliArgs(['-h'])).toMatchObject({ help: true });
    expect(parseCliArgs(['--nsec1sentinel'])).toEqual({ error: 'unknown option' });
    expect(parseCliArgs(['nsec1sentinel'])).toEqual({ error: 'unexpected positional argument' });
    expect(parseCliArgs(['--config'])).toEqual({
      error: 'invalid option value (--config takes a path)',
    });
    // A --dev-mocks flag does not exist here (the gateway's is its own).
    expect(parseCliArgs(['--dev-mocks'])).toEqual({ error: 'unknown option' });
  });
});

describe('main(): refusals before anything starts', () => {
  it('bad argv → 78 + usage, the offending token is not printed; --help → 0', async () => {
    const proc = new FakeProcess();
    expect(await main(['--config', 'x', 'nsec1sentinelstray'], { proc })).toBe(EXIT_CONFIG);
    expect(await main(['--nsec1sentinelflag'], { proc })).toBe(EXIT_CONFIG);
    expect(proc.text()).toContain('bad arguments');
    expect(proc.text()).toContain(USAGE);
    expect(proc.text()).not.toContain('sentinel');
    const help = new FakeProcess();
    expect(await main(['--help'], { proc: help })).toBe(0);
    expect(help.out).toEqual([USAGE]);
  });

  it('no config path (flag absent, env absent or empty) → 78', async () => {
    const proc = new FakeProcess();
    expect(await main([], { proc })).toBe(EXIT_CONFIG);
    proc.vars.set(DAEMON_ENV.configPath, '');
    expect(await main(['--config='], { proc })).toBe(EXIT_CONFIG);
    expect(
      proc.out.filter((l) =>
        l.includes('no config: pass --config <path> or set NUTFLIX_SEEDER_CONFIG'),
      ),
    ).toHaveLength(2);
  });

  it('missing / unreadable file → 78; only the errno code is reported, never the error message', async () => {
    const dir = await scratch();
    const proc = new FakeProcess();
    expect(await main(['--config', path.join(dir, 'absent.json')], { proc })).toBe(EXIT_CONFIG);
    expect(proc.text()).toContain('$: config file could not be read (ENOENT)');

    const denied = new FakeProcess();
    const code = await main(['--config', '/etc/nutflix/seeder.json'], {
      proc: denied,
      readFile: () =>
        Promise.reject(
          Object.assign(new Error('EACCES: permission denied, SENTINEL-in-message'), {
            code: 'EACCES',
          }),
        ),
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(denied.text()).toContain('$: config file could not be read (EACCES)');
    expect(denied.text()).not.toContain('SENTINEL');

    const odd = new FakeProcess();
    await main(['--config', 'c.json'], {
      proc: odd,
      readFile: () => Promise.reject(Object.assign(new Error('x'), { code: 'SENTINEL code' })),
    });
    expect(odd.text()).toContain('$: config file could not be read"');
    expect(odd.text()).not.toContain('SENTINEL');
  });

  it('invalid config → 78 with JSON paths only; no offending value reaches the output', async () => {
    const proc = new FakeProcess();
    const secret = 'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const bad = JSON.stringify({
      dataDir: 424_242_424,
      swarm: { seed: secret, maxPeers: 'SENTINEL-peers' },
      policy: { satsPerBlock: 1, mints: ['https://SENTINEL.example/'], creatorP2pk: secret },
      mystery: secret,
    });
    const code = await main(['--config', 'bad.json'], {
      proc,
      readFile: () => Promise.resolve(bad),
      providers: () => {
        throw new Error('providers must not be consulted for an invalid config');
      },
    });
    expect(code).toBe(EXIT_CONFIG);
    const text = proc.text();
    expect(text).toContain('invalid config');
    for (const p of [
      '$.dataDir',
      '$.swarm.seed',
      '$.swarm.maxPeers',
      '$.policy.mints[0]',
      '$.policy.creatorP2pk',
      '$.mystery',
    ])
      expect(text).toContain(p);
    expect(text).not.toContain('qqqqqqqq');
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain('424242424');
    // Not JSON at all: the parser's own message (which quotes the text) is not forwarded.
    const nj = new FakeProcess();
    expect(
      await main(['--config', 'x'], { proc: nj, readFile: () => Promise.resolve(`{${secret}`) }),
    ).toBe(EXIT_CONFIG);
    expect(nj.text()).toContain('$: config file is not valid JSON');
    expect(nj.text()).not.toContain('qqqqqqqq');
  });
});

describe('main(): --check and providers', () => {
  it('--check → 0 on a good config and starts nothing; NUTFLIX_SEEDER_CONFIG is the fallback, --config wins', async () => {
    const dir = await scratch();
    const good = path.join(dir, 'seeder.json');
    const bad = path.join(dir, 'bad.json');
    await writeFile(good, goodConfig(path.join(dir, 'data')));
    await writeFile(bad, '{"dataDir": 1}');
    let consulted = 0;
    const providers = (): RuntimeDeps => {
      consulted++;
      return fakeDeps();
    };
    const viaEnv = new FakeProcess();
    viaEnv.vars.set(DAEMON_ENV.configPath, good);
    expect(await main(['--check'], { proc: viaEnv, providers })).toBe(0);
    expect(viaEnv.text()).toContain('config ok');
    const flagWins = new FakeProcess();
    flagWins.vars.set(DAEMON_ENV.configPath, bad);
    expect(await main(['--check', '--config', good], { proc: flagWins, providers })).toBe(0);
    const badCheck = new FakeProcess();
    expect(await main(['--check', '--config', bad], { proc: badCheck, providers })).toBe(
      EXIT_CONFIG,
    );
    expect(consulted).toBe(0);
    expect([...viaEnv.runs, ...flagWins.runs]).toEqual([]); // no READY: nothing started
  });

  it('Stage 1: no providers wired → 78 and the reason is logged', async () => {
    const dir = await scratch();
    const proc = new FakeProcess();
    const cfg = goodConfig(path.join(dir, 'data'));
    const parsed = { seeder: { dataDir: dir, diskCapBytes: 0 }, logLevel: 'info' } as DaemonConfig;
    expect(getRuntimeDeps(parsed)).toBeUndefined();
    const code = await main(['--config', 'c.json'], { proc, readFile: () => Promise.resolve(cfg) });
    expect(code).toBe(EXIT_CONFIG);
    const line = proc.out.find((l) => l.includes('refusing to start'));
    expect(line).toBeDefined();
    expect(line).toContain(MISSING_PROVIDERS_REASON);
    expect(proc.runs).toEqual([]);
  });

  it('a provider that throws → 78, and the logger redacts what it said', async () => {
    const proc = new FakeProcess();
    const secret = 'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const code = await main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(goodConfig('/nonexistent/never-created')),
      providers: () => Promise.reject(new Error(`wallet locked: ${secret}`)),
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(proc.text()).toContain('runtime providers failed');
    expect(proc.text()).not.toContain('qqqqqqqq');
  });
});

describe('main(): starting with (fake) providers', () => {
  it('runDaemon gets the parsed config (env applied), READY is notified, one signal closes the seeder once', async () => {
    const dir = await scratch();
    const proc = new FakeProcess();
    proc.vars.set('NOTIFY_SOCKET', '/run/systemd/notify');
    proc.vars.set(DAEMON_ENV.stateDirectory, path.join(dir, 'state'));
    proc.vars.set(DAEMON_ENV.maxStreams, '7');
    const cfg = JSON.stringify({
      swarm: null,
      diskCapBytes: 1_048_576,
      blockSize: 4096,
      rateLimits: { maxStreamsPerKey: 1 },
      policy: { satsPerBlock: 3, mints: [MINT], creatorP2pk: P2PK, split: { seeder: 60 } },
      flushEveryBlocks: 8,
    });
    let seeder: Seeder | null = null;
    let providerSaw: DaemonConfig | null = null;
    void main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(cfg),
      providers: (c) => {
        providerSaw = c;
        return fakeDeps();
      },
      onStarted: (s) => {
        seeder = s;
      },
    });
    await until(() => seeder !== null, 'main() to start the seeder');
    const s = seeder as unknown as Seeder;
    expect(providerSaw).not.toBeNull();
    expect(s.config).toMatchObject({
      dataDir: path.join(dir, 'state'),
      storageDir: path.join(dir, 'state', 'corestore'),
      blockSize: 4096,
      diskCapBytes: 1_048_576,
      rateLimits: { maxStreams: 7, maxStreamsPerKey: 1 },
      swarm: null,
      policy: {
        satsPerBlock: 3,
        blockSize: 4096,
        mints: [MINT],
        split: { seeder: 60, creator: 40 },
        creatorP2pk: P2PK,
      },
      flushEveryBlocks: 8,
    });
    expect(s.stats().cores).toBe(1); // runDaemon's default `blobs` core
    expect(proc.runs).toEqual([{ cmd: 'systemd-notify', args: ['--ready'] }]);
    expect(proc.out.some((l) => l.includes('daemon ready'))).toBe(true);
    expect(proc.out.some((l) => l.includes('"warn"') && l.includes('pay/1 is not attached'))).toBe(
      true,
    );

    // Count closes through the instance the hooks call.
    let closes = 0;
    const realClose = s.close.bind(s);
    s.close = () => {
      closes++;
      return realClose();
    };
    proc.signal('SIGTERM');
    proc.signal('SIGINT'); // while closing: ignored
    await until(() => proc.exits.length > 0, 'the shutdown hooks to exit');
    expect(proc.exits).toEqual([0]);
    expect(closes).toBe(1);
    expect(proc.out.some((l) => l.includes('closed cleanly'))).toBe(true);
    expect(proc.runs.at(-1)).toEqual({ cmd: 'systemd-notify', args: ['STOPPING=1'] });
  });

  it('a start that fails at runtime → exit 1 (not 78), reported through the logger', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'not-a-dir');
    await writeFile(file, 'x');
    const proc = new FakeProcess();
    const code = await main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(goodConfig(path.join(file, 'data'))),
      providers: fakeDeps,
    });
    expect(code).toBe(1);
    expect(proc.text()).toContain('seeder failed to start');
    expect(proc.runs).toEqual([]);
  });
});
