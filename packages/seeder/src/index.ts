/**
 * @sovit/seeder — Corestore + Hyperblobs seeder daemon (build-plan §2.1, §2.3, §7).
 * Issued against CONTRACTS_VERSION = 2, re-issued at CONTRACTS_VERSION = 3 (ADR 0004).
 * Public API documented in docs/lanes/L2.md; the daemon entry in docs/lanes/Seeder-entry.md.
 *
 * Node entry = the runtime-portable API (`./portable.ts`, also the `bare` export condition)
 * plus the Node adapters plus the daemon CLI.
 *
 * This module is BOTH the library entry and the daemon entry: the canonical systemd unit
 * runs `node --jitless …/dist/index.js --config /etc/nutflix/seeder.json`, so when this file
 * is the process's main module it hands `argv` to `cli/main.ts`. Importing it from code has
 * no side effects (the gateway imports it; its own entry is the main module then).
 */
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { main } from './cli/main.js';

export * from './portable.js';

// Node adapters (Node only — never reachable from the `bare` condition)
export { nodeAdapters, nodeFs, nodeCrypto, nodeProcess } from './adapters/node/index.js';
export type { SeederAdapters } from './adapters/node/index.js';

// Daemon CLI (Node only — `portable.ts` must never reach these; see entry-hygiene.test.ts)
export { main, parseCliArgs, loadConfig, EXIT_CONFIG, USAGE } from './cli/main.js';
export type { MainOptions, ParsedArgs } from './cli/main.js';
export {
  DAEMON_ENV,
  applyDaemonEnvOverrides,
  parseDaemonConfigText,
  validateDaemonConfig,
} from './cli/config-file.js';
export type { DaemonConfig, DaemonConfigResult } from './cli/config-file.js';
export { getRuntimeDeps, MISSING_PROVIDERS_REASON } from './cli/providers.js';
export type { RuntimeDeps } from './cli/providers.js';
export { DEFAULT_PAYOUT_THRESHOLD_SATS, MAX_RELAYS } from './cli/config-file.js';
export type { PayoutConfig } from './cli/config-file.js';

// The node runtime (Node only; ADR 0011): what a shell needs to run paid — the gateway uses it.
export { createNodeRuntime, createSeederRuntime, SEEN_CAPACITY } from './runtime/index.js';
export type { NodeRuntimeOptions, SeederRuntime, SeederRuntimeOptions } from './runtime/index.js';
export { RuntimeSetupError } from './runtime/files.js';
export {
  MIN_PASSPHRASE_BYTES,
  PASSPHRASE_CREDENTIAL,
  createKeyFile,
  readPassphrase,
  unlockIdentity,
} from './runtime/identity.js';
export type { NodeIdentity } from './runtime/identity.js';
export { nodeMintRequest, nodeRawHttp } from './runtime/mint-http.js';
export { Payout } from './runtime/payout.js';
export type { OwnerCheck, PayoutResult } from './runtime/payout.js';

/** True when `moduleUrl` is the script Node was started with (symlinks resolved). */
export function isMainModule(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  // `main` resolves only when the daemon did NOT start (or failed to): exit with its code
  // straight away, so a half-opened store or swarm socket cannot keep a failed daemon alive
  // under systemd. While running it never resolves; the signal hooks exit.
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    () => {
      process.exit(1);
    },
  );
}
