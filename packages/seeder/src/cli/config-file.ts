/**
 * The seeder daemon's config file: `--config <path>` (the canonical unit passes
 * `/etc/nutflix/seeder.json`) plus `NUTFLIX_SEEDER_*` environment overrides, validated on
 * load into a `SeederConfig` (+ the log level). Shape and example: deploy/systemd/README.md.
 *
 * Modelled on the gateway's `config.ts` (`parseConfigText`): hand-written validation, no
 * `any`, and every error names a JSON PATH plus the expected shape — NEVER the offending
 * value — so the list can be logged verbatim (SECURITY.md invariant 7). The seeder must not
 * import `@sovit/gateway` (the dependency runs gateway → seeder), so this mirrors the
 * gateway's rules for the fields they share rather than sharing code. It is stricter in
 * places (docs/lanes/Seeder-entry.md lists them; the two should converge):
 *   - unknown keys are rejected at EVERY level, not only the top one;
 *   - `policy` is required, and so are its `satsPerBlock`, `mints` (≥ 1, normalised form,
 *     no duplicates) and `creatorP2pk` (`0[23]` + 64 hex, the form `@sovit/core` uses);
 *   - `swarm.keyPair` / `swarm.seed` are refused: key material is not configuration;
 *   - an absent `swarm` means ON (`{}`, as `parseDaemonEnv()` does) — a standalone seeder
 *     has no other transport; the gateway defaults it off because it has the WS bridge.
 *
 * Precedence, per value: `NUTFLIX_SEEDER_*` env  >  file  >  `STATE_DIRECTORY` (fills
 * `dataDir` only)  >  default. An empty env assignment counts as unset. The config PATH:
 * `--config`  >  `NUTFLIX_SEEDER_CONFIG`.
 *
 * Pure (no `node:` import); `main.ts` does the file I/O.
 */
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrEventId,
  NostrPubkey,
  PricePolicy,
  RelayUrl,
  Sats,
} from '@sovit/core';
import { DEFAULT_BLOCK_SIZE, nostr } from '@sovit/core';

import type { SeederConfig } from '../config.js';
import type { LogLevel } from '../log/logger.js';
import type { RateLimitConfig } from '../net/rate-limit.js';
import type { SwarmConfig } from '../net/swarm.js';
import {
  DEFAULT_DISK_CAP_BYTES,
  ENV_DATA_DIR,
  ENV_DISK_CAP,
  ENV_MAX_STREAMS,
  envValue,
  parseDecimal,
} from './env.js';

/** What the daemon runs with: the seeder's own config plus daemon-only settings. */
export interface DaemonConfig {
  readonly seeder: SeederConfig;
  readonly logLevel: LogLevel;
  /**
   * The node's encrypted key file (Nostr identity + wallet P2PK key, `LocalSigner`). Default
   * `<dataDir>/identity.key`. Its passphrase is a systemd credential, never config or env
   * (`runtime/identity.ts`).
   */
  readonly keyFile: string;
  /** Where creator nutzaps (kind 9321) and the node's kind 10019 are published. */
  readonly relays: readonly RelayUrl[];
  /** The creator's Nostr pubkey: the `p` of every nutzap carrying `policy.creatorP2pk` proofs. */
  readonly creatorPubkey: NostrPubkey;
  /** Core key → the video's event id: the nutzap's `e` tag, so paid views count per video. */
  readonly videoEvents: ReadonlyMap<CoreKeyHex, NostrEventId>;
}

export type DaemonConfigResult =
  | { readonly ok: true; readonly config: DaemonConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Environment variables `main()` honours. */
export const DAEMON_ENV = {
  /** Fallback for `--config`. */
  configPath: 'NUTFLIX_SEEDER_CONFIG',
  dataDir: ENV_DATA_DIR,
  diskCapBytes: ENV_DISK_CAP,
  /** Overrides `rateLimits.maxStreams`. */
  maxStreams: ENV_MAX_STREAMS,
  logLevel: 'NUTFLIX_SEEDER_LOG_LEVEL',
  /** systemd `StateDirectory=` → `dataDir` when neither the file nor the env sets one. */
  stateDirectory: 'STATE_DIRECTORY',
} as const;

// --------------------------------------------------------------------------- helpers

type Obj = Readonly<Record<string, unknown>>;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const P2PK = /^0[23][0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Relays a daemon publishes to; each is a socket the node keeps open. */
export const MAX_RELAYS = 8;
/** Plain `ws://` is accepted only to a loopback relay (a local test relay). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Key names safe to print in a path; anything else is shown as `[…]`. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX = Number.MAX_SAFE_INTEGER;

function isRecord(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Own properties only: a key inherited from `Object.prototype` is never a config value. */
function get(o: Obj, k: string): unknown {
  return Object.hasOwn(o, k) ? o[k] : undefined;
}

/** `$.a.b` for a printable key, `$.a[…]` otherwise — a key is never echoed if it looks odd. */
function at(path: string, key: string): string {
  return SAFE_KEY.test(key) ? `${path}.${key}` : `${path}[…]`;
}

class Checker {
  readonly errors: string[] = [];
  constructor(private readonly origins: ReadonlyMap<string, string>) {}

  add(path: string, expected: string): void {
    const from = this.origins.get(path);
    this.errors.push(`${path}${from === undefined ? '' : ` (from ${from})`}: ${expected}`);
  }

  /** Report every own key not in `known`; `refused` keys get their own message. */
  keys(
    o: Obj,
    path: string,
    known: readonly string[],
    refused?: ReadonlyMap<string, string>,
  ): void {
    for (const k of Object.keys(o)) {
      const why = refused?.get(k);
      if (why !== undefined) this.add(at(path, k), why);
      else if (!known.includes(k)) this.add(at(path, k), 'unknown key');
    }
  }

  str(o: Obj, k: string, path: string): string | undefined {
    const v = get(o, k);
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length === 0) {
      this.add(at(path, k), 'expected non-empty string');
      return undefined;
    }
    return v;
  }

  int(o: Obj, k: string, path: string, min: number, max = MAX): number | undefined {
    const v = get(o, k);
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
      this.add(at(path, k), `expected integer in [${min}, ${max}]`);
      return undefined;
    }
    return v;
  }

  bool(o: Obj, k: string, path: string): boolean | undefined {
    const v = get(o, k);
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') {
      this.add(at(path, k), 'expected boolean');
      return undefined;
    }
    return v;
  }

  obj(o: Obj, k: string, path: string): Obj | undefined {
    const v = get(o, k);
    if (v === undefined) return undefined;
    if (!isRecord(v)) {
      this.add(at(path, k), 'expected object');
      return undefined;
    }
    return v;
  }

  required(o: Obj, k: string, path: string, what: string): boolean {
    if (get(o, k) !== undefined) return true;
    this.add(at(path, k), `required (${what})`);
    return false;
  }
}

// --------------------------------------------------------------------------- sections

const TOP_KEYS = [
  'dataDir',
  'storageDir',
  'blockSize',
  'diskCapBytes',
  'rateLimits',
  'swarm',
  'policy',
  'flushEveryBlocks',
  'flushEveryMs',
  'logLevel',
  'identity',
  'relays',
  'videoEvents',
] as const;
const POLICY_KEYS = [
  'satsPerBlock',
  'blockSize',
  'mints',
  'split',
  'creatorP2pk',
  'creatorPubkey',
] as const;
const IDENTITY_KEYS = ['keyFile'] as const;
const SPLIT_KEYS = ['seeder', 'creator'] as const;
const RATE_KEYS = ['maxStreams', 'maxStreamsPerKey', 'connectsPerWindow', 'windowMs'] as const;
const SWARM_KEYS = ['bootstrap', 'maxPeers', 'server', 'client'] as const;
const BOOTSTRAP_KEYS = ['host', 'port'] as const;
const KEY_MATERIAL =
  'refused: key material is never read from the config file (the encrypted key file, deploy/systemd/README.md)';
const SWARM_REFUSED: ReadonlyMap<string, string> = new Map([
  ['keyPair', KEY_MATERIAL],
  ['seed', KEY_MATERIAL],
]);
const PASSPHRASE_REFUSED =
  'refused: the key passphrase is never read from the config file — it is the systemd credential seeder-key-passphrase (deploy/systemd/README.md)';
const IDENTITY_REFUSED: ReadonlyMap<string, string> = new Map([
  ['passphrase', PASSPHRASE_REFUSED],
  ['secretKey', KEY_MATERIAL],
  ['nsec', KEY_MATERIAL],
]);

/** A mint URL already in `@sovit/core`'s normalised form (so string comparison works). */
function isNormalisedMint(s: string): boolean {
  return nostr.normalizeMintUrl(s) === s;
}

function policySection(
  c: Checker,
  raw: Obj,
  blockSize: number,
): { readonly policy: PricePolicy; readonly creatorPubkey: NostrPubkey } | undefined {
  const P = '$.policy';
  if (!c.required(raw, 'policy', '$', 'the price PAY messages are verified against')) return;
  const o = c.obj(raw, 'policy', '$');
  if (o === undefined) return;
  c.keys(o, P, POLICY_KEYS);

  const hasSats = c.required(o, 'satsPerBlock', P, 'integer sats per block');
  const satsPerBlock = c.int(o, 'satsPerBlock', P, 0);

  const pbs = c.int(o, 'blockSize', P, 1);
  if (pbs !== undefined && pbs !== blockSize)
    c.add(`${P}.blockSize`, 'must equal the seeder block size ($.blockSize, default 65536)');

  const mints: MintUrl[] = [];
  const seen = new Set<string>();
  if (c.required(o, 'mints', P, 'at least one mint URL')) {
    const m = get(o, 'mints');
    if (!Array.isArray(m)) c.add(`${P}.mints`, 'expected array of mint URLs');
    else if (m.length === 0) c.add(`${P}.mints`, 'expected at least one mint URL');
    else
      m.forEach((u: unknown, i) => {
        if (typeof u !== 'string' || !isNormalisedMint(u))
          c.add(
            `${P}.mints[${i}]`,
            'expected http(s) mint URL in normalised form (lower-case host, no trailing slash)',
          );
        else if (seen.has(u)) c.add(`${P}.mints[${i}]`, 'duplicate mint URL');
        else {
          seen.add(u);
          mints.push(u as MintUrl);
        }
      });
  }

  let split = { seeder: 50, creator: 50 };
  const s = c.obj(o, 'split', P);
  if (s !== undefined) {
    c.keys(s, `${P}.split`, SPLIT_KEYS);
    const seederPct = c.int(s, 'seeder', `${P}.split`, 0, 100);
    const creatorPct = c.int(s, 'creator', `${P}.split`, 0, 100);
    const sv = seederPct ?? (creatorPct === undefined ? 50 : 100 - creatorPct);
    const cv = creatorPct ?? 100 - sv;
    if (sv + cv !== 100) c.add(`${P}.split`, 'seeder + creator must equal 100');
    split = { seeder: sv, creator: cv };
  }

  let creatorP2pk: string | undefined;
  if (c.required(o, 'creatorP2pk', P, "the creator's Cashu P2PK pubkey")) {
    const v = get(o, 'creatorP2pk');
    if (typeof v !== 'string' || !P2PK.test(v))
      c.add(
        `${P}.creatorP2pk`,
        'expected 33-byte compressed pubkey: 02 or 03 then 64 lower-case hex chars',
      );
    else creatorP2pk = v;
  }

  let creatorPubkey: string | undefined;
  if (
    c.required(o, 'creatorPubkey', P, "the creator's Nostr pubkey, the recipient of its nutzaps")
  ) {
    const v = get(o, 'creatorPubkey');
    if (typeof v !== 'string' || !HEX64.test(v))
      c.add(`${P}.creatorPubkey`, 'expected 64 lower-case hex chars (x-only Nostr pubkey)');
    else if (creatorP2pk?.slice(2) === v)
      c.add(`${P}.creatorPubkey`, 'must not be the key creatorP2pk names (NIP-61)');
    else creatorPubkey = v;
  }

  if (
    !hasSats ||
    satsPerBlock === undefined ||
    creatorP2pk === undefined ||
    creatorPubkey === undefined
  )
    return;
  return {
    policy: {
      satsPerBlock: satsPerBlock as Sats,
      blockSize,
      mints,
      split,
      creatorP2pk: creatorP2pk as CashuP2pkPubkey,
    },
    creatorPubkey: creatorPubkey as NostrPubkey,
  };
}

function identitySection(c: Checker, raw: Obj, dataDir: string | undefined): string | undefined {
  const P = '$.identity';
  const o = c.obj(raw, 'identity', '$');
  if (o !== undefined) c.keys(o, P, IDENTITY_KEYS, IDENTITY_REFUSED);
  const keyFile = o === undefined ? undefined : c.str(o, 'keyFile', P);
  if (keyFile !== undefined) {
    if (!keyFile.startsWith('/')) c.add(`${P}.keyFile`, 'expected an absolute path');
    return keyFile;
  }
  // The dataDir default: `StateDirectory=` is 0700 and the daemon's own.
  return dataDir === undefined ? undefined : `${dataDir.replace(/\/+$/, '')}/identity.key`;
}

/** A relay URL in normalised form: `wss://`, or `ws://` to a loopback host only. */
function relayError(u: unknown): string | null {
  if (typeof u !== 'string' || nostr.normalizeRelayUrl(u) !== u)
    return 'expected a relay URL in normalised form (wss://host[/path], no trailing slash)';
  const url = new URL(u);
  if (url.protocol === 'ws:' && !LOOPBACK_HOSTS.has(url.hostname))
    return 'plain ws:// is accepted only to a loopback relay; use wss://';
  return null;
}

function relaysSection(c: Checker, raw: Obj): RelayUrl[] {
  const P = '$.relays';
  const out: RelayUrl[] = [];
  if (!c.required(raw, 'relays', '$', 'at least one relay for nutzaps and the kind 10019'))
    return out;
  const v = get(raw, 'relays');
  if (!Array.isArray(v)) {
    c.add(P, 'expected array of relay URLs');
    return out;
  }
  if (v.length === 0 || v.length > MAX_RELAYS) {
    c.add(P, `expected 1 to ${String(MAX_RELAYS)} relay URLs`);
    return out;
  }
  v.forEach((u: unknown, i) => {
    const err = relayError(u);
    if (err !== null) c.add(`${P}[${i}]`, err);
    else if (out.includes(u as RelayUrl)) c.add(`${P}[${i}]`, 'duplicate relay URL');
    else out.push(u as RelayUrl);
  });
  return out;
}

function videoEventsSection(c: Checker, raw: Obj): Map<CoreKeyHex, NostrEventId> {
  const P = '$.videoEvents';
  const out = new Map<CoreKeyHex, NostrEventId>();
  const o = c.obj(raw, 'videoEvents', '$');
  if (o === undefined) return out;
  for (const k of Object.keys(o)) {
    const v = get(o, k);
    if (!HEX64.test(k)) c.add(`${P}[…]`, 'expected keys to be 64 lower-case hex chars (core key)');
    else if (typeof v !== 'string' || !HEX64.test(v))
      c.add(`${P}.${k}`, 'expected 64 lower-case hex chars (video event id)');
    else out.set(k as CoreKeyHex, v as NostrEventId);
  }
  return out;
}

function rateSection(c: Checker, raw: Obj): Partial<RateLimitConfig> | undefined {
  const P = '$.rateLimits';
  const o = c.obj(raw, 'rateLimits', '$');
  if (o === undefined) return undefined;
  c.keys(o, P, RATE_KEYS);
  const out: { -readonly [K in keyof RateLimitConfig]?: number } = {};
  for (const k of RATE_KEYS) {
    const v = c.int(o, k, P, 1);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function swarmSection(c: Checker, raw: Obj): SwarmConfig | null {
  const P = '$.swarm';
  const v = get(raw, 'swarm');
  if (v === undefined) return {};
  if (v === null) return null;
  if (!isRecord(v)) {
    c.add(P, 'expected object or null');
    return null;
  }
  c.keys(v, P, SWARM_KEYS, SWARM_REFUSED);

  let bootstrap: { host: string; port: number }[] | undefined;
  const bs = get(v, 'bootstrap');
  if (bs !== undefined) {
    if (!Array.isArray(bs)) c.add(`${P}.bootstrap`, 'expected array of { host, port }');
    else {
      const list: { host: string; port: number }[] = [];
      bootstrap = list;
      bs.forEach((b: unknown, i) => {
        const bp = `${P}.bootstrap[${i}]`;
        if (!isRecord(b)) {
          c.add(bp, 'expected { host, port }');
          return;
        }
        c.keys(b, bp, BOOTSTRAP_KEYS);
        const okHost = c.required(b, 'host', bp, 'non-empty string');
        const host = c.str(b, 'host', bp);
        const okPort = c.required(b, 'port', bp, 'integer in [1, 65535]');
        const port = c.int(b, 'port', bp, 1, 65_535);
        if (okHost && okPort && host !== undefined && port !== undefined) list.push({ host, port });
      });
    }
  }
  const maxPeers = c.int(v, 'maxPeers', P, 1);
  const server = c.bool(v, 'server', P);
  const client = c.bool(v, 'client', P);
  // SwarmManager.join defaults: server true, client false.
  if (!(server ?? true) && !(client ?? false))
    c.add(
      P,
      'server and client are both false, so the swarm would join nothing (use null to disable it)',
    );
  return {
    ...(bootstrap !== undefined ? { bootstrap } : {}),
    ...(maxPeers !== undefined ? { maxPeers } : {}),
    ...(server !== undefined ? { server } : {}),
    ...(client !== undefined ? { client } : {}),
  };
}

// --------------------------------------------------------------------------- API

/**
 * Validate a parsed JSON document (env overrides already applied) into a `DaemonConfig`.
 * Pure. `origins` maps a JSON path to the env variable its value came from, so an error
 * can say where to look without printing the value.
 */
export function validateDaemonConfig(
  raw: unknown,
  origins: ReadonlyMap<string, string> = new Map(),
): DaemonConfigResult {
  if (!isRecord(raw)) return { ok: false, errors: ['$: expected a JSON object'] };
  const c = new Checker(origins);
  c.keys(raw, '$', TOP_KEYS);

  const hasDataDir = c.required(
    raw,
    'dataDir',
    '$',
    `or ${ENV_DATA_DIR}, or a single-directory STATE_DIRECTORY`,
  );
  const dataDir = c.str(raw, 'dataDir', '$');
  const storageDir = c.str(raw, 'storageDir', '$');
  const blockSize = c.int(raw, 'blockSize', '$', 1024, 16 * 1024 * 1024);
  const diskCapBytes = c.int(raw, 'diskCapBytes', '$', 0) ?? DEFAULT_DISK_CAP_BYTES;
  const rateLimits = rateSection(c, raw);
  const swarm = swarmSection(c, raw);
  const priced = policySection(c, raw, blockSize ?? DEFAULT_BLOCK_SIZE);
  const keyFile = identitySection(c, raw, dataDir);
  const relays = relaysSection(c, raw);
  const videoEvents = videoEventsSection(c, raw);
  const flushEveryBlocks = c.int(raw, 'flushEveryBlocks', '$', 1);
  const flushEveryMs = c.int(raw, 'flushEveryMs', '$', 1);

  let logLevel: LogLevel = 'info';
  const lv = get(raw, 'logLevel');
  if (lv !== undefined) {
    if (typeof lv === 'string' && (LOG_LEVELS as readonly string[]).includes(lv))
      logLevel = lv as LogLevel;
    else c.add('$.logLevel', 'expected debug | info | warn | error');
  }

  if (
    c.errors.length > 0 ||
    !hasDataDir ||
    dataDir === undefined ||
    priced === undefined ||
    keyFile === undefined
  )
    return { ok: false, errors: c.errors.length > 0 ? c.errors : ['$: invalid config'] };
  return {
    ok: true,
    config: {
      seeder: {
        dataDir,
        ...(storageDir !== undefined ? { storageDir } : {}),
        ...(blockSize !== undefined ? { blockSize } : {}),
        diskCapBytes,
        ...(rateLimits !== undefined ? { rateLimits } : {}),
        swarm,
        policy: priced.policy,
        ...(flushEveryBlocks !== undefined ? { flushEveryBlocks } : {}),
        ...(flushEveryMs !== undefined ? { flushEveryMs } : {}),
      },
      logLevel,
      keyFile,
      relays,
      creatorPubkey: priced.creatorPubkey,
      videoEvents,
    },
  };
}

/**
 * Apply `NUTFLIX_SEEDER_*` overrides (and `STATE_DIRECTORY`) to a raw, pre-validation
 * document. Returns a new object plus the JSON paths the env supplied; the input is not
 * mutated. Numbers must be decimal digits: anything else is passed through as a string so
 * validation rejects it (by path, never by value).
 */
export function applyDaemonEnvOverrides(
  raw: unknown,
  env: (name: string) => string | undefined,
): { readonly raw: unknown; readonly origins: ReadonlyMap<string, string> } {
  const origins = new Map<string, string>();
  if (!isRecord(raw)) return { raw, origins };
  const out: Record<string, unknown> = { ...raw };

  const dataDir = envValue(env, DAEMON_ENV.dataDir);
  if (dataDir !== undefined) {
    out['dataDir'] = dataDir;
    origins.set('$.dataDir', DAEMON_ENV.dataDir);
  } else if (get(raw, 'dataDir') === undefined) {
    const state = envValue(env, DAEMON_ENV.stateDirectory);
    // systemd joins several `StateDirectory=` entries with ':'; picking one would be a
    // guess, so a list is ignored and `dataDir` stays missing (reported as required).
    if (state !== undefined && !state.includes(':')) {
      out['dataDir'] = state;
      origins.set('$.dataDir', DAEMON_ENV.stateDirectory);
    }
  }

  const cap = envValue(env, DAEMON_ENV.diskCapBytes);
  if (cap !== undefined) {
    out['diskCapBytes'] = parseDecimal(cap) ?? cap;
    origins.set('$.diskCapBytes', DAEMON_ENV.diskCapBytes);
  }

  const maxStreams = envValue(env, DAEMON_ENV.maxStreams);
  const rl = get(raw, 'rateLimits');
  if (maxStreams !== undefined && (rl === undefined || isRecord(rl))) {
    out['rateLimits'] = { ...rl, maxStreams: parseDecimal(maxStreams) ?? maxStreams };
    origins.set('$.rateLimits.maxStreams', DAEMON_ENV.maxStreams);
  }

  const level = envValue(env, DAEMON_ENV.logLevel);
  if (level !== undefined) {
    out['logLevel'] = level;
    origins.set('$.logLevel', DAEMON_ENV.logLevel);
  }
  return { raw: out, origins };
}

/** Parse JSON text, apply env, validate. No error ever includes file content. */
export function parseDaemonConfigText(
  text: string,
  env: (name: string) => string | undefined = () => undefined,
): DaemonConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // JSON.parse messages quote the text around the error: never forward them.
    return { ok: false, errors: ['$: config file is not valid JSON'] };
  }
  const o = applyDaemonEnvOverrides(raw, env);
  return validateDaemonConfig(o.raw, o.origins);
}
