/**
 * Runtime provider seam for the seeder daemon entry (`cli/main.ts`) — the same pattern as the
 * gateway's `cli/providers.ts`. Stage 3 fills it: `getRuntimeDeps()` builds the daemon's runtime
 * (`runtime/index.ts`, decisions in ADR 0011):
 *
 *   - the identity: the encrypted key file (`DaemonConfig.keyFile`), unlocked with the systemd
 *     credential `seeder-key-passphrase` from `$CREDENTIALS_DIRECTORY`;
 *   - the real `PaymentEngineSeeder` over the node's own wallet (a 0600 proof file), with the
 *     durable pending queue and seen set, rate-limited keysets and NIP-61 nutzaps;
 *   - `attach`: `pay/1` + HELLO on every admitted session, and the node's kind 10019.
 *
 * Any missing piece (no key file, no credential, a wallet file it cannot trust, another daemon on
 * the same data directory) throws a `RuntimeSetupError`, which `main()` logs and turns into exit
 * 78 before anything is created on disk.
 */
import type { Logger } from '../log/logger.js';
import { createSeederRuntime } from '../runtime/index.js';
import type { Seeder, SeederDeps } from '../seeder.js';
import type { DaemonConfig } from './config-file.js';

export interface RuntimeDeps {
  /** The `PaymentEngineSeeder`. Tests pass `mocks.MockPaymentEngine`. */
  readonly engine: SeederDeps['engine'];
  /** With the created seeder, before `start()`: where `pay/1` is attached to its sessions. */
  readonly attach?: (seeder: Seeder) => void;
  /** After the seeder has closed (its final flush ran): release relays, lock the key. */
  readonly close?: () => Promise<void>;
  /** `SeederDeps.accepting`: the runtime's pending-PAY cap. */
  readonly accepting?: () => boolean;
}

export interface ProviderContext {
  readonly env: (name: string) => string | undefined;
  readonly logger: Logger;
}

/** systemd sets it when the unit loads a credential (`LoadCredentialEncrypted=`). */
export const CREDENTIALS_DIRECTORY_ENV = 'CREDENTIALS_DIRECTORY';

export async function getRuntimeDeps(
  config: DaemonConfig,
  ctx: ProviderContext,
): Promise<RuntimeDeps> {
  const rt = await createSeederRuntime(config, {
    credentialsDirectory: ctx.env(CREDENTIALS_DIRECTORY_ENV),
    logger: ctx.logger,
  });
  ctx.logger.info('runtime ready', { publicKey: rt.pubkey });
  return {
    engine: rt.engine,
    attach: (seeder) => {
      rt.attach(seeder);
    },
    close: () => rt.close(),
    accepting: rt.accepting,
  };
}

/** What `main()` logs when a (test) provider seam returns nothing. */
export const MISSING_PROVIDERS_REASON =
  'no runtime providers: the provider returned nothing (see packages/seeder/src/cli/providers.ts)';
