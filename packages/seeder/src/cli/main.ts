/**
 * Entry point behind the canonical unit's
 *   `ExecStart=/usr/bin/node --jitless /opt/nutflix/packages/seeder/dist/index.js --config /etc/nutflix/seeder.json`
 * (deploy/systemd/nutflix-seeder.service, `Type=simple`). Modelled on the gateway's
 * `cli/main.ts`.
 *
 *   --config <path>   JSON config (`config-file.ts`); `NUTFLIX_SEEDER_CONFIG` is the fallback
 *   --check           validate the config and exit 0/78 without starting anything
 *   --keygen          create the node's key file at `keyFile` (never overwrites), sealed under
 *                     the passphrase read from STDIN — pipe it from `systemd-creds decrypt` so it
 *                     is the same bytes as the unit's credential (deploy/systemd/README.md)
 *
 * No `--dev-mocks`: nothing consumes it, and the desktop worker has its own.
 *
 * Exit codes: 0 clean, 1 runtime failure, 78 (EX_CONFIG) bad/missing config or providers —
 * so a misconfigured unit fails fast under `Restart=on-failure` + `StartLimitBurst`.
 * Every line of output goes through the redacting logger to stdout (journald under
 * systemd); argument and config errors are fixed strings and JSON paths, never values.
 * SIGTERM/SIGINT/SIGHUP → one graceful `Seeder.close()` through `runDaemon()`'s shutdown
 * hooks; `sdNotify` is a no-op without `NOTIFY_SOCKET` and harmless under `Type=simple`.
 *
 * Node only (file I/O, `node:util`): reachable from `index.ts`, never from `portable.ts`.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import type { SeederProcess } from '../adapters/process.js';
import { nodeAdapters } from '../adapters/node/index.js';
import { createLogger } from '../log/logger.js';
import type { Logger } from '../log/logger.js';
import type { Seeder } from '../seeder.js';
import type { DaemonConfig, DaemonConfigResult } from './config-file.js';
import { DAEMON_ENV, parseDaemonConfigText } from './config-file.js';
import { runDaemon } from './daemon.js';
import { envValue } from './env.js';
import { RuntimeSetupError } from '../runtime/files.js';
import { MIN_PASSPHRASE_BYTES, createKeyFile } from '../runtime/identity.js';
import type { ProviderContext, RuntimeDeps } from './providers.js';
import { MISSING_PROVIDERS_REASON, getRuntimeDeps } from './providers.js';

export const EXIT_CONFIG = 78;

export interface MainOptions {
  readonly proc?: SeederProcess;
  readonly readFile?: (path: string) => Promise<string>;
  /** Test seam: replaces `getRuntimeDeps`. */
  readonly providers?: (
    config: DaemonConfig,
    ctx: ProviderContext,
  ) => RuntimeDeps | undefined | Promise<RuntimeDeps | undefined>;
  /** Called with the running seeder (tests keep a handle to it). */
  readonly onStarted?: (seeder: Seeder) => void;
}

export interface ParsedArgs {
  readonly config: string | undefined;
  readonly check: boolean;
  readonly keygen: boolean;
  readonly help: boolean;
}

export const USAGE =
  'usage: nutflix-seeder --config <seeder.json> [--check | --keygen]\n' +
  `  env: ${DAEMON_ENV.configPath}, ${DAEMON_ENV.dataDir}, ${DAEMON_ENV.diskCapBytes}, ${DAEMON_ENV.maxStreams}, ${DAEMON_ENV.logLevel}, ${DAEMON_ENV.stateDirectory}`;

/** `node:util` parseArgs error codes → fixed text. The raw message quotes the offending token. */
const ARG_ERRORS: Readonly<Record<string, string>> = {
  ERR_PARSE_ARGS_UNKNOWN_OPTION: 'unknown option',
  ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: 'unexpected positional argument',
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: 'invalid option value (--config takes a path)',
};

export function parseCliArgs(argv: readonly string[]): ParsedArgs | { readonly error: string } {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        config: { type: 'string' },
        check: { type: 'boolean', default: false },
        keygen: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.check && values.keygen) return { error: '--check and --keygen are exclusive' };
    return {
      config: values.config,
      check: values.check,
      keygen: values.keygen,
      help: values.help,
    };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return {
      error: (typeof code === 'string' ? ARG_ERRORS[code] : undefined) ?? 'invalid arguments',
    };
  }
}

export async function loadConfig(
  path: string,
  proc: Pick<SeederProcess, 'env'>,
  read: (p: string) => Promise<string>,
): Promise<DaemonConfigResult> {
  let text: string;
  try {
    text = await read(path);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const errno = typeof code === 'string' && /^E[A-Z]{2,15}$/.test(code) ? ` (${code})` : '';
    return { ok: false, errors: [`$: config file could not be read${errno}`] };
  }
  return parseDaemonConfigText(text, (n) => proc.env(n));
}

/**
 * Run the daemon. Resolves with the exit code when it exits WITHOUT (fully) starting;
 * otherwise never — the process exits through the signal hooks.
 */
export async function main(argv: readonly string[], o: MainOptions = {}): Promise<number> {
  const proc = o.proc ?? nodeAdapters.process;
  const read = o.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const sink = (line: string): void => {
    proc.writeStdout(line);
  };
  const bootLog: Logger = createLogger({
    sink,
    level: 'info',
    bindings: { component: 'seeder-cli' },
  });

  const args = parseCliArgs(argv);
  if ('error' in args) {
    bootLog.error('bad arguments', { error: args.error });
    proc.writeStdout(USAGE);
    return EXIT_CONFIG;
  }
  if (args.help) {
    proc.writeStdout(USAGE);
    return 0;
  }
  const configPath =
    args.config !== undefined && args.config !== ''
      ? args.config
      : envValue((n) => proc.env(n), DAEMON_ENV.configPath);
  if (configPath === undefined) {
    bootLog.error(`no config: pass --config <path> or set ${DAEMON_ENV.configPath}`);
    return EXIT_CONFIG;
  }
  const loaded = await loadConfig(configPath, proc, read);
  if (!loaded.ok) {
    // Errors name JSON paths and expected shapes only — never values (config-file.ts).
    bootLog.error('invalid config — refusing to start', { errors: loaded.errors });
    return EXIT_CONFIG;
  }
  const config = loaded.config;
  if (args.check) {
    bootLog.info('config ok', {
      dataDir: config.seeder.dataDir,
      swarm: config.seeder.swarm !== null,
    });
    return 0;
  }

  const logger = createLogger({ sink, level: config.logLevel });

  if (args.keygen) return keygen(config, logger, proc);

  let deps: RuntimeDeps | undefined;
  try {
    deps = await (o.providers ?? getRuntimeDeps)(config, { env: (n) => proc.env(n), logger });
  } catch (err) {
    logger.error('runtime providers failed — refusing to start', { error: err });
    return EXIT_CONFIG;
  }
  if (deps === undefined) {
    logger.error('refusing to start', { reason: MISSING_PROVIDERS_REASON });
    return EXIT_CONFIG;
  }

  let seeder: Seeder;
  try {
    seeder = await runDaemon({
      config: config.seeder,
      deps: { engine: deps.engine, fs: nodeAdapters.fs, crypto: nodeAdapters.crypto },
      proc,
      logger,
      ...(deps.attach === undefined ? {} : { beforeStart: deps.attach }),
      ...(deps.close === undefined ? {} : { afterClose: deps.close }),
    });
  } catch (err) {
    logger.error('seeder failed to start', { error: err });
    await deps.close?.().catch(() => undefined);
    return 1;
  }
  o.onStarted?.(seeder);
  return new Promise<number>(() => undefined);
}

/** Longest `--keygen` stdin read: a passphrase, not a file. */
const MAX_STDIN_BYTES = 8192;

/** `--keygen`: create the key file; the passphrase comes from stdin, never argv or env. */
async function keygen(config: DaemonConfig, logger: Logger, proc: SeederProcess): Promise<number> {
  let input: Uint8Array | null = null;
  try {
    if (proc.readStdin === undefined)
      throw new RuntimeSetupError('this host cannot read a passphrase from stdin');
    input = await proc.readStdin(MAX_STDIN_BYTES);
    let n = input.length;
    if (n > 0 && input[n - 1] === 0x0a) n--;
    if (n > 0 && input[n - 1] === 0x0d) n--;
    const passphrase = input.subarray(0, n);
    if (passphrase.length < MIN_PASSPHRASE_BYTES)
      throw new RuntimeSetupError(
        `the passphrase on stdin must be at least ${String(MIN_PASSPHRASE_BYTES)} bytes`,
      );
    const { pubkey, p2pk } = await createKeyFile({ keyFile: config.keyFile, passphrase });
    logger.info('key file created', { keyFile: config.keyFile, publicKey: pubkey, ownP2pk: p2pk });
    return 0;
  } catch (err) {
    logger.error('keygen failed', { error: err });
    return err instanceof RuntimeSetupError ? EXIT_CONFIG : 1;
  } finally {
    input?.fill(0);
  }
}
