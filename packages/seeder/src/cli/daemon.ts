/**
 * Daemon runner: create + start a Seeder, install signal hooks, tell systemd we are READY.
 *
 * The self-executing entry is `cli/main.ts` (behind `index.ts`'s main-module guard), which
 * the canonical unit runs as `node --jitless …/dist/index.js --config /etc/nutflix/seeder.json`.
 * It parses the config file (`cli/config-file.ts`), asks `cli/providers.ts` for the runtime
 * deps and calls `runDaemon()` with them. In Stage 1 there are no providers (the real
 * `PaymentEngineSeeder` is `core/src/payment/`, locked until Stage 2), so `main()` refuses to
 * start with exit 78. Other shells that own an engine (the L6 desktop worker, the gateway)
 * keep calling `runDaemon()` / `Seeder.create()` directly.
 *
 * This module stays runtime-portable (it is exported from `portable.ts`, the `bare`
 * condition): no `node:` imports here — `main.ts` holds those.
 *
 * `parseDaemonEnv()` is the env-only config builder for embedders. `main()` does not use it:
 * it reads the same `NUTFLIX_SEEDER_*` variables as OVERRIDES on top of the config file,
 * with the same parsing rules (`cli/env.ts`; env wins over the file).
 */
import type { SeederProcess } from '../adapters/process.js';
import type { SeederConfig } from '../config.js';
import { installShutdownHooks, sdNotify } from '../host/systemd.js';
import type { Logger } from '../log/logger.js';
import { Seeder } from '../seeder.js';
import type { SeederDeps } from '../seeder.js';
import {
  DEFAULT_DISK_CAP_BYTES,
  ENV_DATA_DIR,
  ENV_DISK_CAP,
  ENV_MAX_STREAMS,
  envValue,
  parseDecimal,
} from './env.js';

export { ENV_DATA_DIR, ENV_DISK_CAP, ENV_MAX_STREAMS };

export type DaemonEnv =
  | { readonly ok: true; readonly config: SeederConfig }
  | { readonly ok: false; readonly error: string };

/**
 * Env-only config: `NUTFLIX_SEEDER_DATA_DIR` (required), `NUTFLIX_SEEDER_DISK_CAP_BYTES`
 * (default 50 GiB), `NUTFLIX_SEEDER_MAX_STREAMS`; swarm on. Numbers are decimal digits only
 * and an empty assignment counts as unset (`cli/env.ts`) — the same rules the daemon's
 * config-file overrides use.
 */
export function parseDaemonEnv(proc: Pick<SeederProcess, 'env'>): DaemonEnv {
  const env = (name: string): string | undefined => proc.env(name);
  const dataDir = envValue(env, ENV_DATA_DIR);
  if (dataDir === undefined) return { ok: false, error: `${ENV_DATA_DIR} is required` };
  const capRaw = envValue(env, ENV_DISK_CAP);
  const cap = capRaw === undefined ? DEFAULT_DISK_CAP_BYTES : parseDecimal(capRaw);
  if (cap === undefined || !Number.isSafeInteger(cap))
    return { ok: false, error: `${ENV_DISK_CAP} must be a byte count` };
  const maxRaw = envValue(env, ENV_MAX_STREAMS);
  const maxStreams = maxRaw === undefined ? undefined : parseDecimal(maxRaw);
  if (
    maxRaw !== undefined &&
    (maxStreams === undefined || !Number.isSafeInteger(maxStreams) || maxStreams < 1)
  )
    return { ok: false, error: `${ENV_MAX_STREAMS} must be a positive integer` };
  return {
    ok: true,
    config: {
      dataDir,
      diskCapBytes: cap,
      swarm: {},
      ...(maxStreams !== undefined ? { rateLimits: { maxStreams } } : {}),
    },
  };
}

export interface RunDaemonOptions {
  readonly config: SeederConfig;
  readonly deps: SeederDeps;
  readonly proc: SeederProcess;
  readonly logger: Logger;
  /** Cores to open on boot (default: the `blobs` core). */
  readonly cores?: readonly string[];
  /** With the created seeder, before `start()` — e.g. attach `pay/1` to its sessions. */
  readonly beforeStart?: (seeder: Seeder) => void;
  /** After `seeder.close()` on shutdown — e.g. close relays, lock the key. */
  readonly afterClose?: () => Promise<void>;
}

/** Resolves with the running seeder; the process exits through the signal hooks. */
export async function runDaemon(o: RunDaemonOptions): Promise<Seeder> {
  // Like every seeder this repository builds, the daemon's seeder announces each core's terms
  // (`PRICE`, priced or free) before its first block to a pay/1 peer — always, with no switch
  // (contracts v6 amendment): a viewer reading an image learns the core is sold before our window
  // would cut it.
  const seeder = await Seeder.create(o.config, { ...o.deps, logger: o.logger });
  try {
    for (const name of o.cores ?? ['blobs']) await seeder.openCore(name);
    o.beforeStart?.(seeder);
  } catch (err) {
    await seeder.close().catch(() => undefined);
    throw err;
  }
  seeder.start();
  installShutdownHooks({
    proc: o.proc,
    logger: o.logger,
    close: async () => {
      try {
        await seeder.close();
      } finally {
        await o.afterClose?.();
      }
    },
  });
  await sdNotify(o.proc, 'READY=1', o.logger);
  o.logger.info('daemon ready', { ...seeder.stats() });
  return seeder;
}
