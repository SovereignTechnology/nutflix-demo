/**
 * Runtime provider seam for the gateway entry (`cli/main.ts`). Stage 3 fills it with the node
 * runtime `@sovit/seeder` builds for its own daemon (ADR 0011), plus what only a gateway has:
 *
 *   - identity: the encrypted key file (`GatewayConfig.keyFile`), unlocked with the systemd
 *     credential `gateway-key-passphrase` from `$CREDENTIALS_DIRECTORY`. `identity.pubkey` and
 *     `identity.p2pk` in the config must be the key file's — the HELLO names `identity.p2pk`, so
 *     a mismatch would have viewers lock their payment to a key this gateway cannot redeem with;
 *   - `seederEngine`: the real engine over the gateway's own wallet (NIP-44 sealed proof file,
 *     durable pending PAYs and seen set, nutzaps, payout);
 *   - `viewerEngine`: the same wallet paying UPSTREAM seeders (`UpstreamPayer`);
 *   - `auth`: `BlossomAuthImpl` bound to `blossom.publicUrl`'s host;
 *   - `payProtocol`: a `PayChannel` per session (the gateway attaches it and sends its HELLO).
 *
 * Anything missing (key file, credential, a mismatched identity, another process on the data
 * directory) throws a `RuntimeSetupError`: `main()` logs it and exits 78 before listening.
 * `--dev-mocks` (`cli/dev-mocks.ts`) remains the loudly logged, loopback-only development path.
 */
import { DEFAULT_WINDOW_BLOCKS, payProtocol, payment } from '@sovit/core';
import type { NostrPubkey, nostr, wallet as walletTypes } from '@sovit/core';
import type { Logger, Seeder } from '@sovit/seeder';
import { RuntimeSetupError, createNodeRuntime } from '@sovit/seeder';

import { BlossomAuthImpl } from '../auth/index.js';
import type { GatewayConfig } from '../config.js';
import type { GatewayDeps } from '../gateway.js';

export type RuntimeDeps = Pick<
  GatewayDeps,
  'seederEngine' | 'viewerEngine' | 'auth' | 'payProtocol' | 'identity' | 'accepting'
> & {
  /** With the gateway's seeder, before it starts: payout and the kind 10019. */
  readonly attach?: (seeder: Seeder) => void;
  /** After the gateway closed: relays closed, key locked, state lock freed. */
  readonly close?: () => Promise<void>;
};

export interface ProviderContext {
  readonly env: (name: string) => string | undefined;
  readonly logger: Logger;
  /** Tests: the in-process `TestMint` transport. Default: `node:http(s)`. */
  readonly mintRequest?: Parameters<typeof createNodeRuntime>[0]['mintRequest'];
  /** Tests: a `FakeRelayPool`. Default: a real relay pool over `ws`. */
  readonly pool?: nostr.PoolLike;
}

/** The systemd credential id the gateway unit loads its key passphrase under. */
export const GATEWAY_CREDENTIAL = 'gateway-key-passphrase';
export const CREDENTIALS_DIRECTORY_ENV = 'CREDENTIALS_DIRECTORY';

/** The real providers, plus the wallet (tests fund it; an operator tool could read it). */
export async function getRuntimeDeps(
  config: GatewayConfig,
  ctx: ProviderContext,
): Promise<RuntimeDeps & { readonly wallet: walletTypes.CashuWallet }> {
  const rt = await createNodeRuntime({
    credentialsDirectory: ctx.env(CREDENTIALS_DIRECTORY_ENV),
    logger: ctx.logger,
    ...(ctx.mintRequest === undefined ? {} : { mintRequest: ctx.mintRequest }),
    ...(ctx.pool === undefined ? {} : { pool: ctx.pool }),
    dataDir: config.dataDir,
    keyFile: config.keyFile,
    credential: GATEWAY_CREDENTIAL,
    acceptedMints: config.acceptedMints,
    windowBlocks: DEFAULT_WINDOW_BLOCKS,
    flushEveryBlocks: config.flushEveryBlocks,
    flushEveryMs: config.flushEveryMs,
    relays: config.relays,
    recipientFor: (lockedTo): NostrPubkey | undefined =>
      lockedTo.toLowerCase() === config.policy.creatorP2pk.toLowerCase()
        ? config.creatorPubkey
        : undefined,
    videoEventFor: (core) => config.videoEvents.get(core),
    payout: config.payout,
    // The gateway attaches pay/1 and sends its own HELLO (marked-up price) in gateway.ts.
    wirePay: false,
  });
  if (rt.pubkey !== config.identity.pubkey || rt.p2pk !== config.identity.p2pk) {
    await rt.close();
    throw new RuntimeSetupError(
      'identity.pubkey / identity.p2pk are not the key file’s: the HELLO would name a key this gateway cannot redeem with — copy them from --keygen’s output',
    );
  }
  const log = ctx.logger.child({ component: 'pay/1' });
  const viewerEngine = new payment.RealPaymentEngine({
    config: {
      windowBlocks: DEFAULT_WINDOW_BLOCKS,
      acceptedMints: [],
      ownP2pk: rt.p2pk,
      ownPubkey: rt.pubkey,
      flushEveryBlocks: config.flushEveryBlocks,
      flushEveryMs: config.flushEveryMs,
    },
    wallet: rt.wallet,
  });
  ctx.logger.info('runtime ready', { publicKey: rt.pubkey });
  return {
    seederEngine: rt.engine,
    viewerEngine,
    auth: new BlossomAuthImpl({ serverHost: new URL(config.blossom.publicUrl).hostname }),
    payProtocol: (info) =>
      new payProtocol.PayChannel({
        onProtocolError: (why) => {
          log.info('pay/1 protocol error', { noiseKey: info.noiseKeyHex, why });
        },
      }),
    identity: { signEvent: rt.signEvent },
    wallet: rt.wallet,
    attach: (seeder) => {
      rt.attach(seeder);
    },
    close: () => rt.close(),
    accepting: rt.accepting,
  };
}

/** What `main()` logs when a (test) provider seam returns nothing. */
export const MISSING_PROVIDERS_REASON =
  'no runtime providers: the provider returned nothing (see packages/gateway/src/cli/providers.ts)';
