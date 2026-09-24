/**
 * The gateway with its REAL runtime providers (`cli/providers.ts`: key file + credential, sealed
 * wallet, real engines) fetching a blob from an upstream seeder DAEMON (its real runtime) over
 * REAL hyperswarm on a local `hyperdht` testnet, and paying for it over `pay/1` with ecash from the
 * in-process `TestMint`. Nothing leaves loopback; relays are a `FakeRelayPool`.
 *
 * What it pins: on a swarm connection the gateway attaches `pay/1` once replication runs
 * (`Seeder.onSessionReady`) — hooked to `session-open`, as before, the Protomux did not exist yet
 * and the gateway could never pay an upstream swarm peer; the upstream seeder binds the gateway's
 * key-file identity, is paid for every block, and redeems into its own wallet.
 *
 * The reader here is PACED (two blocks, then wait for the payment): the gateway does not yet gate
 * upstream requests on its unpaid window, so a fast reader gets it cut and banned (F37).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mocks, nostr } from '@sovit/core';
import type { CashuP2pkPubkey, MintUrl, Sats } from '@sovit/core';
import {
  PASSPHRASE_CREDENTIAL,
  Seeder,
  createKeyFile,
  createSeederRuntime,
  nodeAdapters,
  validateDaemonConfig,
} from '@sovit/seeder';
import type { SeederRuntime } from '@sovit/seeder';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GATEWAY_CREDENTIAL, getRuntimeDeps } from '../cli/providers.js';
import { validateConfig } from '../config.js';
import { Gateway } from '../gateway.js';
import { capturedLogger, tmpDir, until } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const BLOCK = 1024;
const BLOCKS = 8;
const MINT = 'https://mint.gw-swarm.example' as MintUrl;
const RELAY = 'wss://relay.gw-swarm.example';
const CREATOR_P2PK = `02${'c7'.repeat(32)}` as CashuP2pkPubkey;
const CREATOR = 'c1'.repeat(32);
const PASS = 'gw-swarm-integration-passphrase-01';

let testnet: Testnet;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  testnet = await createTestnet(3);
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await testnet.destroy();
});

/** A data dir with a fresh key file and a credential directory holding its passphrase. */
async function node(credential: string): Promise<{
  dataDir: string;
  creds: string;
  pubkey: string;
  p2pk: string;
}> {
  const t = await tmpDir('nutflix-gw-swarm-');
  cleanups.push(t.rm);
  const dataDir = path.join(t.dir, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  const { pubkey, p2pk } = await createKeyFile({
    keyFile: path.join(dataDir, 'identity.key'),
    passphrase: Buffer.from(PASS),
    cost: { ops: 2, mem: 64 * 1024 * 1024 },
  });
  const creds = path.join(t.dir, 'creds');
  await mkdir(creds, { mode: 0o700 });
  await writeFile(path.join(creds, credential), PASS, { mode: 0o400 });
  return { dataDir, creds, pubkey, p2pk };
}

describe('gateway runtime over hyperswarm', () => {
  it('the gateway fetches from an upstream seeder daemon over the swarm and pays it over pay/1 with its own wallet', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x71) });
    const pool = new nostr.FakeRelayPool();
    const policy = {
      satsPerBlock: 2,
      blockSize: BLOCK,
      mints: [MINT],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: CREATOR_P2PK,
    };

    // --- the upstream seeder daemon (swarm server)
    const up = await node(PASSPHRASE_CREDENTIAL);
    const upCfg = validateDaemonConfig({
      dataDir: up.dataDir,
      blockSize: BLOCK,
      diskCapBytes: 1 << 22,
      swarm: { bootstrap: testnet.bootstrap, server: true, client: false },
      relays: [RELAY],
      policy: { ...policy, creatorPubkey: CREATOR },
      flushEveryBlocks: 100_000,
      flushEveryMs: 3_600_000,
    });
    if (!upCfg.ok) throw new Error(upCfg.errors.join('; '));
    const upLog = capturedLogger('info');
    const upRt: SeederRuntime = await createSeederRuntime(upCfg.config, {
      credentialsDirectory: up.creds,
      logger: upLog.logger,
      mintRequest: () => mint.request,
      pool,
    });
    const upSeeder = await Seeder.create(upCfg.config.seeder, {
      engine: upRt.engine,
      logger: upLog.logger,
      fs: nodeAdapters.fs,
      crypto: nodeAdapters.crypto,
    });
    cleanups.push(async () => {
      await upSeeder.close();
      await upRt.close();
    });
    const data = new Uint8Array(BLOCK * BLOCKS).map((_, i) => (i * 11 + 5) % 256);
    const put = await upSeeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error('put failed');
    const core = put.entry.coreKey;
    upRt.attach(upSeeder);
    upSeeder.start();
    await upSeeder.swarm!.flushedAll();

    // --- the gateway (swarm client), real providers, the core's manifest policy for upstream
    const gw = await node(GATEWAY_CREDENTIAL);
    const gwCfg = validateConfig({
      listen: { host: '127.0.0.1', port: 0 },
      dataDir: gw.dataDir,
      blockSize: BLOCK,
      diskCapBytes: 1 << 22,
      identity: { pubkey: gw.pubkey, p2pk: gw.p2pk },
      relays: [RELAY],
      policy: { ...policy, creatorPubkey: CREATOR },
      acceptedMints: [MINT],
      swarm: { bootstrap: testnet.bootstrap, server: false, client: true },
      upstream: { payEveryBlocks: 2, policies: { [core]: policy } },
      blossom: { publicUrl: 'http://gw.test' },
    });
    if (!gwCfg.ok) throw new Error(gwCfg.errors.join('; '));
    const gwLog = capturedLogger('info');
    const deps = await getRuntimeDeps(gwCfg.config, {
      env: (n) => (n === 'CREDENTIALS_DIRECTORY' ? gw.creds : undefined),
      logger: gwLog.logger,
      mintRequest: () => mint.request,
      pool,
    });
    // Fund the gateway's wallet: it pays upstream from what it holds.
    const q = await deps.wallet.mintQuote(MINT, 200 as Sats);
    mint.payQuote(q.quoteId);
    await deps.wallet.pollQuote(q);
    const gateway = await Gateway.create(gwCfg.config, { ...deps, logger: gwLog.logger });
    deps.attach?.(gateway.seeder);
    await gateway.listen();
    cleanups.push(async () => {
      await gateway.close();
      await deps.close?.();
    });

    const vcore = await gateway.openUpstreamCore(core);
    await gateway.seeder.swarm!.flush();
    cleanups.push(async () => {
      const out = process.env['GW_SWARM_DUMP'];
      if (out === undefined) return;
      const { writeFile: wf } = await import('node:fs/promises');
      await wf(
        out,
        [...upLog.lines.map((l) => `UP ${l}`), ...gwLog.lines.map((l) => `GW ${l}`)].join('\n'),
      );
    });
    // A PACED reader: two blocks, then wait until the upstream counts them paid. The gateway does
    // not pace upstream fetches itself yet — an unpaced reader outruns its PAYs and the upstream
    // cuts and bans it for exceeding the unpaid window (security review F37; the next lane).
    const paid = (n: number) => (): boolean => {
      const win = upRt.engine.window(gw.pubkey as never);
      return win !== undefined && win.paid >= n && win.outstanding === 0;
    };
    for (let i = 0; i < BLOCKS; i += 2) {
      for (const j of [i, i + 1])
        expect(
          await vcore.core.get(j, { wait: true, timeout: 10_000 }),
          `block ${String(j)}`,
        ).not.toBeNull();
      await until(paid(i + 2), 20_000);
    }

    // The upstream seeder bound the gateway's key-file identity on the swarm session…
    const session = upSeeder.sessionInfos().find((s) => s.pubkey === gw.pubkey);
    expect(session, 'a swarm session bound to the gateway pubkey').toBeDefined();
    // …and every block it uploaded was paid (the gateway pays every 2 blocks, one PAY in flight).
    const w = upRt.engine.window(gw.pubkey as never)!;
    expect(w.uploaded).toBeGreaterThanOrEqual(BLOCKS);
    expect(w.paid).toBe(w.uploaded);
    expect(upSeeder.session(session!.noiseKeyHex)?.cutReason ?? null).toBeNull();

    // The upstream redeems its share into its own wallet; the gateway paid out of its own.
    const flushed = await upSeeder.flushNow();
    expect(flushed.failed).toBe(0);
    expect(flushed.swapped).toBeGreaterThan(0);
    expect(await upRt.wallet.balance(MINT)).toBe(flushed.swapped);
    const spent = 200 - (await deps.wallet.balance(MINT));
    expect(spent).toBe(w.paid * policy.satsPerBlock);
    // Nothing secret reached either log.
    for (const l of [...upLog.lines, ...gwLog.lines]) expect(l).not.toContain(PASS);
  });
});
