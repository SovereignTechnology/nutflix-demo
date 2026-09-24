/**
 * The seeder daemon's config file (`cli/config-file.ts`): every `SeederConfig` field, strict
 * unknown-key rejection at every level, env precedence, and — the security property —
 * errors that name JSON paths and NEVER echo a value (SECURITY.md invariant 7).
 */
import { describe, expect, it } from 'vitest';

import {
  DAEMON_ENV,
  applyDaemonEnvOverrides,
  parseDaemonConfigText,
  validateDaemonConfig,
} from '../cli/config-file.js';
import type { DaemonConfigResult } from '../cli/config-file.js';

const P2PK = `02${'ab'.repeat(32)}`;
const CREATOR = 'c1'.repeat(32);
const RELAY = 'wss://relay.example';
const MINT = 'https://mint.example';
const MINT_B = 'https://mint-b.example/Bitcoin';
const GIB = 1024 ** 3;

function minimal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataDir: '/var/lib/nutflix-seeder',
    relays: [RELAY],
    policy: { satsPerBlock: 2, mints: [MINT], creatorP2pk: P2PK, creatorPubkey: CREATOR },
    ...extra,
  };
}

function parse(doc: unknown, env: Record<string, string> = {}): DaemonConfigResult {
  return parseDaemonConfigText(JSON.stringify(doc), (n) => env[n]);
}

function errorsOf(r: DaemonConfigResult): readonly string[] {
  if (r.ok) throw new Error('expected the config to be rejected');
  return r.errors;
}

describe('daemon config file: accepted shapes', () => {
  it('a minimal file gets the documented defaults (swarm ON, 50 GiB cap, 50/50 split, info, key file in dataDir)', () => {
    const r = parse(minimal());
    expect(r).toEqual({
      ok: true,
      config: {
        logLevel: 'info',
        keyFile: '/var/lib/nutflix-seeder/identity.key',
        relays: [RELAY],
        creatorPubkey: CREATOR,
        videoEvents: new Map(),
        payout: null,
        seeder: {
          dataDir: '/var/lib/nutflix-seeder',
          diskCapBytes: 50 * GIB,
          swarm: {},
          policy: {
            satsPerBlock: 2,
            blockSize: 65_536,
            mints: [MINT],
            split: { seeder: 50, creator: 50 },
            creatorP2pk: P2PK,
          },
        },
      },
    });
  });

  it('covers every SeederConfig field (plus the daemon fields) exactly', () => {
    const core = 'e0'.repeat(32);
    const video = 'f0'.repeat(32);
    const r = parse({
      dataDir: '/srv/seed',
      identity: { keyFile: '/etc/nutflix/seeder.key' },
      relays: [RELAY, 'wss://relay-b.example/nostr', 'ws://127.0.0.1:7777'],
      videoEvents: { [core]: video },
      storageDir: '/srv/seed/store',
      blockSize: 16_384,
      diskCapBytes: 1234,
      rateLimits: { maxStreams: 9, maxStreamsPerKey: 3, connectsPerWindow: 5, windowMs: 1000 },
      swarm: {
        bootstrap: [{ host: '127.0.0.1', port: 49_737 }],
        maxPeers: 12,
        server: true,
        client: true,
      },
      policy: {
        satsPerBlock: 0,
        blockSize: 16_384,
        mints: [MINT, MINT_B],
        split: { seeder: 70, creator: 30 },
        creatorP2pk: `03${'cd'.repeat(32)}`,
        creatorPubkey: CREATOR,
      },
      flushEveryBlocks: 32,
      flushEveryMs: 5000,
      logLevel: 'debug',
    });
    expect(r).toEqual({
      ok: true,
      config: {
        logLevel: 'debug',
        keyFile: '/etc/nutflix/seeder.key',
        relays: [RELAY, 'wss://relay-b.example/nostr', 'ws://127.0.0.1:7777'],
        creatorPubkey: CREATOR,
        videoEvents: new Map([[core, video]]),
        payout: null,
        seeder: {
          dataDir: '/srv/seed',
          storageDir: '/srv/seed/store',
          blockSize: 16_384,
          diskCapBytes: 1234,
          rateLimits: { maxStreams: 9, maxStreamsPerKey: 3, connectsPerWindow: 5, windowMs: 1000 },
          swarm: {
            bootstrap: [{ host: '127.0.0.1', port: 49_737 }],
            maxPeers: 12,
            server: true,
            client: true,
          },
          policy: {
            satsPerBlock: 0,
            blockSize: 16_384,
            mints: [MINT, MINT_B],
            split: { seeder: 70, creator: 30 },
            creatorP2pk: `03${'cd'.repeat(32)}`,
          },
          flushEveryBlocks: 32,
          flushEveryMs: 5000,
        },
      },
    });
  });

  it('swarm: null disables it; a partial rateLimits stays partial; policy.blockSize follows $.blockSize', () => {
    const r = parse(minimal({ swarm: null, rateLimits: { maxStreams: 3 }, blockSize: 4096 }));
    expect(r.ok && r.config.seeder.swarm).toBeNull();
    expect(r.ok && r.config.seeder.rateLimits).toEqual({ maxStreams: 3 });
    expect(r.ok && r.config.seeder.policy?.blockSize).toBe(4096);
    // one split side given → the other is its complement
    const s = parse(
      minimal({ policy: { ...(minimal()['policy'] as object), split: { creator: 20 } } }),
    );
    expect(s.ok && s.config.seeder.policy?.split).toEqual({ seeder: 80, creator: 20 });
    // client-only swarm is fine (server defaults true in SwarmManager; only both-false is refused)
    expect(parse(minimal({ swarm: { server: false, client: true } })).ok).toBe(true);
  });
});

describe('daemon config file: rejections name a path and never a value', () => {
  it('not JSON / not an object', () => {
    const secret = 'nsec1sentinelsentinelsentinelsentinelsentinelsentinelsentinel';
    const bad = parseDaemonConfigText(`{"dataDir": "${secret}", oops}`);
    expect(errorsOf(bad)).toEqual(['$: config file is not valid JSON']);
    expect(JSON.stringify(bad)).not.toContain('sentinel');
    for (const doc of ['[]', 'null', '"x"', '7'])
      expect(errorsOf(parseDaemonConfigText(doc))).toEqual(['$: expected a JSON object']);
  });

  it('required fields', () => {
    expect(errorsOf(parse({}))).toEqual([
      '$.dataDir: required (or NUTFLIX_SEEDER_DATA_DIR, or a single-directory STATE_DIRECTORY)',
      '$.policy: required (the price PAY messages are verified against)',
      '$.relays: required (at least one relay for nutzaps and the kind 10019)',
    ]);
    expect(errorsOf(parse(minimal({ policy: {} })))).toEqual([
      '$.policy.satsPerBlock: required (integer sats per block)',
      '$.policy.mints: required (at least one mint URL)',
      "$.policy.creatorP2pk: required (the creator's Cashu P2PK pubkey)",
      "$.policy.creatorPubkey: required (the creator's Nostr pubkey, the recipient of its nutzaps)",
    ]);
  });

  it('unknown keys at EVERY level (odd key names are not echoed); __proto__ is just an unknown key', () => {
    const doc = JSON.parse(
      JSON.stringify(
        minimal({
          extra: 1,
          'nsec1sentinelkey sentinel': 1,
          rateLimits: { maxStream: 1 },
          swarm: { bootstrap: [{ host: 'h', port: 1, tls: true }], firewall: 1 },
          policy: {
            satsPerBlock: 1,
            mints: [MINT],
            creatorP2pk: P2PK,
            split: { seeders: 50 },
            price: 3,
          },
        }),
      ).replace('{', '{"__proto__": {"dataDir": "/polluted"},'),
    ) as unknown;
    const errs = errorsOf(validateDaemonConfig(doc));
    expect(errs).toEqual(
      expect.arrayContaining([
        '$.extra: unknown key',
        '$[…]: unknown key',
        '$.__proto__: unknown key',
        '$.rateLimits.maxStream: unknown key',
        '$.swarm.firewall: unknown key',
        '$.swarm.bootstrap[0].tls: unknown key',
        '$.policy.price: unknown key',
        '$.policy.split.seeders: unknown key',
      ]),
    );
    expect(JSON.stringify(errs)).not.toContain('sentinel');
    expect(({} as Record<string, unknown>)['dataDir']).toBeUndefined();
  });

  it('wrong types and shapes: path + expected shape only, the offending values never appear', () => {
    const S = (tag: string): string => `SENTINEL-${tag}-${'9'.repeat(8)}`;
    const r = parse({
      dataDir: 777_000_111,
      storageDir: '',
      blockSize: 777_000_222,
      diskCapBytes: S('cap'),
      rateLimits: { maxStreams: 0, windowMs: 1.5 },
      swarm: {
        bootstrap: [{ host: S('host'), port: 777_000_333 }, S('entry')],
        maxPeers: -777_000_444,
        server: S('bool'),
      },
      policy: {
        satsPerBlock: -777_000_555,
        mints: [`${MINT}/`, 'https://MINT.example', S('mint'), MINT, MINT],
        split: { seeder: 777_000_666, creator: 40 },
        creatorP2pk: `04${'ab'.repeat(32)}`,
      },
      flushEveryBlocks: 0,
      logLevel: S('level'),
    });
    const errs = errorsOf(r);
    expect(errs).toEqual(
      expect.arrayContaining([
        '$.dataDir: expected non-empty string',
        '$.storageDir: expected non-empty string',
        '$.blockSize: expected integer in [1024, 16777216]',
        `$.diskCapBytes: expected integer in [0, ${Number.MAX_SAFE_INTEGER}]`,
        `$.rateLimits.maxStreams: expected integer in [1, ${Number.MAX_SAFE_INTEGER}]`,
        `$.rateLimits.windowMs: expected integer in [1, ${Number.MAX_SAFE_INTEGER}]`,
        '$.swarm.bootstrap[0].port: expected integer in [1, 65535]',
        '$.swarm.bootstrap[1]: expected { host, port }',
        `$.swarm.maxPeers: expected integer in [1, ${Number.MAX_SAFE_INTEGER}]`,
        '$.swarm.server: expected boolean',
        `$.policy.satsPerBlock: expected integer in [0, ${Number.MAX_SAFE_INTEGER}]`,
        '$.policy.mints[0]: expected http(s) mint URL in normalised form (lower-case host, no trailing slash)',
        '$.policy.mints[1]: expected http(s) mint URL in normalised form (lower-case host, no trailing slash)',
        '$.policy.mints[2]: expected http(s) mint URL in normalised form (lower-case host, no trailing slash)',
        '$.policy.mints[4]: duplicate mint URL',
        '$.policy.split.seeder: expected integer in [0, 100]',
        '$.policy.creatorP2pk: expected 33-byte compressed pubkey: 02 or 03 then 64 lower-case hex chars',
        `$.flushEveryBlocks: expected integer in [1, ${Number.MAX_SAFE_INTEGER}]`,
        '$.logLevel: expected debug | info | warn | error',
      ]),
    );
    const text = JSON.stringify(errs);
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain('777000');
    expect(text).not.toContain('MINT.example');
    expect(text).not.toContain(`04${'ab'.repeat(32)}`);
  });

  it('policy rules: split must sum to 100, ≥ 1 mint, policy.blockSize must match the store', () => {
    const pol = minimal()['policy'] as Record<string, unknown>;
    expect(
      errorsOf(parse(minimal({ policy: { ...pol, split: { seeder: 60, creator: 60 } } }))),
    ).toEqual(['$.policy.split: seeder + creator must equal 100']);
    expect(errorsOf(parse(minimal({ policy: { ...pol, mints: [] } })))).toEqual([
      '$.policy.mints: expected at least one mint URL',
    ]);
    expect(errorsOf(parse(minimal({ policy: { ...pol, mints: MINT } })))).toEqual([
      '$.policy.mints: expected array of mint URLs',
    ]);
    expect(errorsOf(parse(minimal({ policy: { ...pol, blockSize: 4096 } })))).toEqual([
      '$.policy.blockSize: must equal the seeder block size ($.blockSize, default 65536)',
    ]);
    expect(parse(minimal({ blockSize: 4096, policy: { ...pol, blockSize: 4096 } })).ok).toBe(true);
    expect(errorsOf(parse(minimal({ policy: null })))).toEqual(['$.policy: expected object']);
  });

  it('swarm: key material is refused outright; both roles off is refused; junk is refused', () => {
    const errs = errorsOf(
      parse(minimal({ swarm: { keyPair: { secretKey: 'SENTINEL-sk' }, seed: 'SENTINEL-seed' } })),
    );
    expect(errs).toEqual([
      '$.swarm.keyPair: refused: key material is never read from the config file (the encrypted key file, deploy/systemd/README.md)',
      '$.swarm.seed: refused: key material is never read from the config file (the encrypted key file, deploy/systemd/README.md)',
    ]);
    expect(JSON.stringify(errs)).not.toContain('SENTINEL');
    expect(errorsOf(parse(minimal({ swarm: { server: false } })))).toEqual([
      '$.swarm: server and client are both false, so the swarm would join nothing (use null to disable it)',
    ]);
    expect(errorsOf(parse(minimal({ swarm: 'on' })))).toEqual(['$.swarm: expected object or null']);
    expect(errorsOf(parse(minimal({ swarm: { bootstrap: {} } })))).toEqual([
      '$.swarm.bootstrap: expected array of { host, port }',
    ]);
    expect(errorsOf(parse(minimal({ swarm: { bootstrap: [{ port: 1 }] } })))).toEqual([
      '$.swarm.bootstrap[0].host: required (non-empty string)',
    ]);
  });
});

describe('daemon config file: the runtime fields (identity, relays, creator, videos)', () => {
  it('identity.keyFile: absolute path only; the default follows dataDir, from the file or the environment', () => {
    const own = parse(minimal({ identity: { keyFile: '/srv/k/seeder.key' } }));
    expect(own.ok && own.config.keyFile).toBe('/srv/k/seeder.key');
    expect(errorsOf(parse(minimal({ identity: { keyFile: 'seeder.key' } })))).toEqual([
      '$.identity.keyFile: expected an absolute path',
    ]);
    const slash = parse(minimal({ dataDir: '/srv/data/' }));
    expect(slash.ok && slash.config.keyFile).toBe('/srv/data/identity.key');
    const { dataDir: _d, ...noDir } = minimal();
    const st = parse(noDir, { [DAEMON_ENV.stateDirectory]: '/var/lib/nutflix-seeder' });
    expect(st.ok && st.config.keyFile).toBe('/var/lib/nutflix-seeder/identity.key');
    const env = parse(minimal(), { [DAEMON_ENV.dataDir]: '/env/data' });
    expect(env.ok && env.config.keyFile).toBe('/env/data/identity.key');
  });

  it('identity: a passphrase or a key in the file is refused outright and never echoed', () => {
    const errs = errorsOf(
      parse(
        minimal({
          identity: {
            passphrase: 'SENTINEL-pass',
            nsec: 'nsec1SENTINEL',
            secretKey: 'SENTINEL-sk',
            other: 1,
          },
        }),
      ),
    );
    expect(errs).toEqual([
      '$.identity.passphrase: refused: the key passphrase is never read from the config file — it is the systemd credential seeder-key-passphrase (deploy/systemd/README.md)',
      '$.identity.nsec: refused: key material is never read from the config file (the encrypted key file, deploy/systemd/README.md)',
      '$.identity.secretKey: refused: key material is never read from the config file (the encrypted key file, deploy/systemd/README.md)',
      '$.identity.other: unknown key',
    ]);
    expect(JSON.stringify(errs)).not.toContain('SENTINEL');
    expect(errorsOf(parse(minimal({ identity: 'x' })))).toEqual(['$.identity: expected object']);
  });

  it('relays: 1 to MAX_RELAYS, normalised, wss (ws only to loopback), no duplicates — values never echoed', () => {
    const errs = errorsOf(
      parse(
        minimal({
          relays: [
            'wss://SENTINEL.example',
            'wss://relay.example/',
            'ws://sentinel-host.example',
            'https://sentinel.example',
            7,
            RELAY,
            RELAY,
          ],
        }),
      ),
    );
    expect(errs).toEqual([
      '$.relays[0]: expected a relay URL in normalised form (wss://host[/path], no trailing slash)',
      '$.relays[1]: expected a relay URL in normalised form (wss://host[/path], no trailing slash)',
      '$.relays[2]: plain ws:// is accepted only to a loopback relay; use wss://',
      '$.relays[3]: expected a relay URL in normalised form (wss://host[/path], no trailing slash)',
      '$.relays[4]: expected a relay URL in normalised form (wss://host[/path], no trailing slash)',
      '$.relays[6]: duplicate relay URL',
    ]);
    expect(JSON.stringify(errs).toLowerCase()).not.toContain('sentinel');
    expect(errorsOf(parse(minimal({ relays: [] })))).toEqual([
      '$.relays: expected 1 to 8 relay URLs',
    ]);
    const nine = Array.from({ length: 9 }, (_, i) => `wss://r${String(i)}.example`);
    expect(errorsOf(parse(minimal({ relays: nine })))).toEqual([
      '$.relays: expected 1 to 8 relay URLs',
    ]);
    expect(errorsOf(parse(minimal({ relays: RELAY })))).toEqual([
      '$.relays: expected array of relay URLs',
    ]);
    for (const loop of ['ws://localhost:7000', 'ws://127.0.0.1', 'ws://[::1]:7000'])
      expect(parse(minimal({ relays: [loop] })).ok, loop).toBe(true);
  });

  it('policy.creatorPubkey: 64 lower-case hex, and never the key creatorP2pk names (NIP-61)', () => {
    const pol = minimal()['policy'] as Record<string, unknown>;
    expect(
      errorsOf(parse(minimal({ policy: { ...pol, creatorPubkey: 'C1'.repeat(32) } }))),
    ).toEqual(['$.policy.creatorPubkey: expected 64 lower-case hex chars (x-only Nostr pubkey)']);
    expect(errorsOf(parse(minimal({ policy: { ...pol, creatorPubkey: P2PK.slice(2) } })))).toEqual([
      '$.policy.creatorPubkey: must not be the key creatorP2pk names (NIP-61)',
    ]);
  });

  it('videoEvents: core key → event id, both 64 lower-case hex; odd keys are not echoed', () => {
    const core = 'e0'.repeat(32);
    const ok = parse(minimal({ videoEvents: { [core]: 'f0'.repeat(32) } }));
    expect(ok.ok && [...ok.config.videoEvents]).toEqual([[core, 'f0'.repeat(32)]]);
    const errs = errorsOf(
      parse(minimal({ videoEvents: { 'SENTINEL-core': 'f0'.repeat(32), [core]: 'SENTINEL' } })),
    );
    expect(errs).toEqual([
      '$.videoEvents[…]: expected keys to be 64 lower-case hex chars (core key)',
      `$.videoEvents.${core}: expected 64 lower-case hex chars (video event id)`,
    ]);
    expect(JSON.stringify(errs)).not.toContain('SENTINEL');
  });
});

describe('daemon config file: environment overrides', () => {
  it('NUTFLIX_SEEDER_* win over the file; STATE_DIRECTORY only fills a missing dataDir', () => {
    const env = {
      [DAEMON_ENV.dataDir]: '/env/data',
      [DAEMON_ENV.diskCapBytes]: '4096',
      [DAEMON_ENV.maxStreams]: '5',
      [DAEMON_ENV.logLevel]: 'warn',
      [DAEMON_ENV.stateDirectory]: '/var/lib/nutflix-seeder',
    };
    const r = parse(
      minimal({ diskCapBytes: 1, rateLimits: { windowMs: 10, maxStreams: 99 } }),
      env,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.seeder.dataDir).toBe('/env/data');
    expect(r.config.seeder.diskCapBytes).toBe(4096);
    expect(r.config.seeder.rateLimits).toEqual({ windowMs: 10, maxStreams: 5 });
    expect(r.config.logLevel).toBe('warn');

    const { dataDir: _dataDir, ...noDir } = minimal();
    const st = parse(noDir, { [DAEMON_ENV.stateDirectory]: '/var/lib/nutflix-seeder' });
    expect(st.ok && st.config.seeder.dataDir).toBe('/var/lib/nutflix-seeder');
    // The file's dataDir beats STATE_DIRECTORY.
    const file = parse(minimal(), { [DAEMON_ENV.stateDirectory]: '/elsewhere' });
    expect(file.ok && file.config.seeder.dataDir).toBe('/var/lib/nutflix-seeder');
    // A ':'-joined list (several StateDirectory= entries) is not guessed at.
    expect(errorsOf(parse(noDir, { [DAEMON_ENV.stateDirectory]: '/a:/b' }))[0]).toMatch(
      /^\$\.dataDir: required/,
    );
  });

  it('empty assignments count as unset; bad env values are named by path AND variable, never echoed', () => {
    const blank = parse(minimal(), {
      [DAEMON_ENV.dataDir]: '',
      [DAEMON_ENV.diskCapBytes]: '',
      [DAEMON_ENV.maxStreams]: '',
      [DAEMON_ENV.logLevel]: '',
    });
    expect(blank.ok && blank.config.seeder).toMatchObject({
      dataDir: '/var/lib/nutflix-seeder',
      diskCapBytes: 50 * GIB,
    });
    expect(blank.ok && blank.config.seeder.rateLimits).toBeUndefined();

    const errs = errorsOf(
      parse(minimal(), {
        [DAEMON_ENV.diskCapBytes]: '1e3sentinel',
        [DAEMON_ENV.maxStreams]: '0',
        [DAEMON_ENV.logLevel]: 'loud-sentinel',
      }),
    );
    expect(errs).toEqual([
      `$.diskCapBytes (from NUTFLIX_SEEDER_DISK_CAP_BYTES): expected integer in [0, ${Number.MAX_SAFE_INTEGER}]`,
      `$.rateLimits.maxStreams (from NUTFLIX_SEEDER_MAX_STREAMS): expected integer in [1, ${Number.MAX_SAFE_INTEGER}]`,
      '$.logLevel (from NUTFLIX_SEEDER_LOG_LEVEL): expected debug | info | warn | error',
    ]);
    expect(JSON.stringify(errs)).not.toContain('sentinel');
  });

  it('applyDaemonEnvOverrides does not mutate its input and leaves a non-object rateLimits for validation', () => {
    const raw = minimal({ rateLimits: 'fast' });
    const before = JSON.stringify(raw);
    const o = applyDaemonEnvOverrides(raw, (n) => (n === DAEMON_ENV.maxStreams ? '4' : undefined));
    expect(JSON.stringify(raw)).toBe(before);
    expect((o.raw as Record<string, unknown>)['rateLimits']).toBe('fast');
    expect(errorsOf(validateDaemonConfig(o.raw, o.origins))).toEqual([
      '$.rateLimits: expected object',
    ]);
  });
});
