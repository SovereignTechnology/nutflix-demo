/**
 * The daemon entry behind `deploy/systemd/nutflix-seeder.service` (`cli/main.ts`):
 * argument parsing, config refusal (redacted, exit 78), `--check`, `--keygen`, the real
 * providers' refusals (no key file, no credential — exit 78 before anything is created), a real
 * start through the `providers` test seam (`runDaemon()` with the parsed config, `attach` before
 * start, READY, graceful close on a signal, then the runtime's `close`), and a runtime failure
 * (exit 1).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mocks } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { DAEMON_ENV } from '../cli/config-file.js';
import type { DaemonConfig } from '../cli/config-file.js';
import { EXIT_CONFIG, USAGE, main, parseCliArgs } from '../cli/main.js';
import { MISSING_PROVIDERS_REASON } from '../cli/providers.js';
import type { RuntimeDeps } from '../cli/providers.js';
import type { Seeder } from '../seeder.js';
import { FakeProcess, until } from './fake-process.js';
import { tmpDir } from './helpers.js';

const P2PK = `02${'ab'.repeat(32)}`;
const CREATOR = 'c1'.repeat(32);
const RELAY = 'wss://relay.example';
const MINT = 'https://mint.example';
/** 32 bytes of test passphrase (a fixture, never a real credential). */
const PASS = 'test-passphrase-0123456789abcdef';

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
    relays: [RELAY],
    policy: { satsPerBlock: 3, mints: [MINT], creatorP2pk: P2PK, creatorPubkey: CREATOR },
    ...extra,
  });
}

const fakeDeps = (): RuntimeDeps => ({
  engine: new mocks.MockPaymentEngine({ mode: 'honest' }),
});

describe('parseCliArgs', () => {
  it('accepts --config/--check/--keygen/--help; errors are fixed strings that never quote the token', () => {
    expect(parseCliArgs(['--config', '/etc/nutflix/seeder.json'])).toEqual({
      config: '/etc/nutflix/seeder.json',
      check: false,
      keygen: false,
      help: false,
    });
    expect(parseCliArgs(['--check', '--config=x'])).toEqual({
      config: 'x',
      check: true,
      keygen: false,
      help: false,
    });
    expect(parseCliArgs(['--keygen', '--config', 'x'])).toMatchObject({ keygen: true });
    expect(parseCliArgs(['--keygen', '--check'])).toEqual({
      error: '--check and --keygen are exclusive',
    });
    // No flag takes the passphrase: it comes from stdin (keygen) or the credential (start).
    expect(parseCliArgs(['--passphrase', 'x'])).toEqual({ error: 'unknown option' });
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

  it('a provider seam that returns nothing → 78 and the reason is logged', async () => {
    const dir = await scratch();
    const proc = new FakeProcess();
    const code = await main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(goodConfig(path.join(dir, 'data'))),
      providers: () => undefined,
    });
    expect(code).toBe(EXIT_CONFIG);
    const line = proc.out.find((l) => l.includes('refusing to start'));
    expect(line).toContain(MISSING_PROVIDERS_REASON);
    expect(proc.runs).toEqual([]);
  });

  it('the real providers: no key file → 78, the reason names it, and nothing is created on disk', async () => {
    const dir = await scratch();
    const data = path.join(dir, 'data');
    const proc = new FakeProcess();
    const code = await main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(goodConfig(data)),
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(proc.text()).toContain('runtime providers failed');
    expect(proc.text()).toContain('no key file at');
    expect(proc.text()).toContain('--keygen');
    expect(existsSync(data)).toBe(false);
    expect(proc.runs).toEqual([]);
  });

  it('the real providers: a key file but no systemd credential → 78; the passphrase is never taken from the environment', async () => {
    const dir = await scratch();
    const data = path.join(dir, 'data');
    await mkdir(data, { mode: 0o700 });
    const kg = new FakeProcess();
    kg.stdin = `${PASS}\n`;
    const made = await main(['--keygen', '--config', 'c.json'], {
      proc: kg,
      readFile: () => Promise.resolve(goodConfig(data)),
    });
    expect(made).toBe(0);
    const proc = new FakeProcess();
    // A passphrase in the environment is not a credential: still refused.
    proc.vars.set('NUTFLIX_SEEDER_PASSPHRASE', PASS);
    proc.vars.set('SEEDER_KEY_PASSPHRASE', PASS);
    const code = await main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(goodConfig(data)),
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(proc.text()).toContain('no systemd credentials');
    expect(proc.text()).not.toContain(PASS);
    expect(existsSync(path.join(data, 'wallet'))).toBe(false);
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
      relays: [RELAY],
      policy: {
        satsPerBlock: 3,
        mints: [MINT],
        creatorP2pk: P2PK,
        creatorPubkey: CREATOR,
        split: { seeder: 60 },
      },
      flushEveryBlocks: 8,
    });
    let seeder: Seeder | null = null;
    let providerSaw: DaemonConfig | null = null;
    const order: string[] = [];
    void main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(cfg),
      providers: (c, ctx) => {
        providerSaw = c;
        expect(ctx.env(DAEMON_ENV.maxStreams)).toBe('7');
        return {
          ...fakeDeps(),
          attach: () => {
            // Before start(): `Seeder.start()` logs "seeder started".
            const started = proc.out.some((l) => l.includes('seeder started'));
            order.push(started ? 'attach-after-start' : 'attach');
          },
          close: () => {
            order.push('runtime-close');
            return Promise.resolve();
          },
        };
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
    // The Stage 1 warning is gone: the runtime attaches pay/1.
    expect(proc.out.some((l) => l.includes('pay/1 is not attached'))).toBe(false);
    expect(order).toEqual(['attach']);
    expect(proc.out.some((l) => l.includes('seeder started'))).toBe(true);

    // Count closes through the instance the hooks call.
    let closes = 0;
    const realClose = s.close.bind(s);
    s.close = () => {
      closes++;
      order.push('seeder-close');
      return realClose();
    };
    proc.signal('SIGTERM');
    proc.signal('SIGINT'); // while closing: ignored
    await until(() => proc.exits.length > 0, 'the shutdown hooks to exit');
    expect(proc.exits).toEqual([0]);
    expect(closes).toBe(1);
    // The runtime closes after the seeder: its final flush still had relays and the key.
    expect(order).toEqual(['attach', 'seeder-close', 'runtime-close']);
    expect(proc.out.some((l) => l.includes('closed cleanly'))).toBe(true);
    expect(proc.runs.at(-1)).toEqual({ cmd: 'systemd-notify', args: ['STOPPING=1'] });
  });

  it('a start that fails at runtime → exit 1 (not 78), reported through the logger', async () => {
    const dir = await scratch();
    const file = path.join(dir, 'not-a-dir');
    await writeFile(file, 'x');
    const proc = new FakeProcess();
    let runtimeClosed = 0;
    const code = await main(['--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(goodConfig(path.join(file, 'data'))),
      providers: () => ({
        ...fakeDeps(),
        close: () => {
          runtimeClosed++;
          return Promise.resolve();
        },
      }),
    });
    expect(code).toBe(1);
    expect(proc.text()).toContain('seeder failed to start');
    expect(proc.runs).toEqual([]);
    // The runtime is released on a failed start too (key locked, state lock freed).
    expect(runtimeClosed).toBe(1);
  });
});

describe('main(): --keygen', () => {
  it('creates a 0600 key file with a wallet key at keyFile, logs only the public key, and never overwrites', async () => {
    const dir = await scratch();
    const data = path.join(dir, 'data');
    await mkdir(data, { mode: 0o700 });
    const proc = new FakeProcess();
    proc.stdin = `${PASS}\n`;
    let consulted = 0;
    const code = await main(['--keygen', '--config', 'c.json'], {
      proc,
      readFile: () => Promise.resolve(goodConfig(data)),
      providers: () => {
        consulted++;
        return fakeDeps();
      },
    });
    expect(code).toBe(0);
    expect(consulted).toBe(0); // keygen starts nothing
    const keyFile = path.join(data, 'identity.key');
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    const header = JSON.parse(await readFile(keyFile, 'utf8')) as {
      pubkey: string;
      walletKey: boolean;
    };
    expect(header.walletKey).toBe(true);
    expect(proc.text()).toContain('key file created');
    expect(proc.text()).toContain(header.pubkey); // the public key, for the operator
    expect(proc.text()).not.toContain(PASS);

    const again = new FakeProcess();
    again.stdin = PASS;
    expect(
      await main(['--keygen', '--config', 'c.json'], {
        proc: again,
        readFile: () => Promise.resolve(goodConfig(data)),
      }),
    ).toBe(EXIT_CONFIG);
    expect(again.text()).toContain('never overwrites');
    expect(JSON.parse(await readFile(keyFile, 'utf8'))).toMatchObject({ pubkey: header.pubkey });
  });

  it('refuses a short passphrase and a terminal on stdin, and never prints the input', async () => {
    const dir = await scratch();
    const proc = new FakeProcess();
    proc.stdin = 'short-SENTINEL\n';
    expect(
      await main(['--keygen', '--config', 'c.json'], {
        proc,
        readFile: () => Promise.resolve(goodConfig(dir)),
      }),
    ).toBe(EXIT_CONFIG);
    expect(proc.text()).toContain('at least 16 bytes');
    expect(proc.text()).not.toContain('SENTINEL');
    const tty = new FakeProcess(); // stdin null = a terminal
    expect(
      await main(['--keygen', '--config', 'c.json'], {
        proc: tty,
        readFile: () => Promise.resolve(goodConfig(dir)),
      }),
    ).toBe(1);
    expect(tty.text()).toContain('keygen failed');
    expect(existsSync(path.join(dir, 'identity.key'))).toBe(false);
  });
});
