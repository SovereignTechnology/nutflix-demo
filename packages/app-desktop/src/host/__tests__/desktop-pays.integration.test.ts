/**
 * The desktop app PAYING for real (Stage 3, ADR 0012): the worker (`WorkerHost` under Node, driven
 * through the real framed wire and guards) with REAL payment providers streams a video from a
 * seeder DAEMON (its real runtime) over real hyperswarm on a local `hyperdht` testnet, and every
 * money step goes through the host's money plane — the user's NIP-60 wallet (FakeRelayPool, a real
 * LocalSigner) funded from the in-process TestMint.
 *
 * Pins: the worker's HELLO is signed by the host and binds the user's pubkey at the seeder; PAYs
 * are built by the host only for the authorised session; the video arrives byte-exact over the
 * playback link; the seeder is paid for every block it sent (no cut, no ban); the user's wallet
 * pays exactly blocks × price; the seeder redeems and forwards the creator's share as a nutzap.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  PricePolicy,
  RelayUrl,
  Sats,
} from '@sovit/core';
import { NostrKind, mocks, nostr, signer as signerMod } from '@sovit/core';
import {
  PASSPHRASE_CREDENTIAL,
  Seeder,
  createKeyFile,
  createLogger,
  createSeederRuntime,
  nodeAdapters,
  validateDaemonConfig,
} from '@sovit/seeder';
import type { SeederRuntime } from '@sovit/seeder';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SessionId } from '../../ipc/protocol.js';
import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import type { DevTestnet } from '../../worker/dev/fixtures-net.js';
import { startDevTestnet } from '../../worker/dev/fixtures-net.js';
import type { WorkerClient } from '../../worker/__tests__/helpers/harness.js';
import { httpGet, startWorker, tempDir } from '../../worker/__tests__/helpers/harness.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';

/** Poll `cond` (bounded; no fixed sleeps). */
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const BLOCK = 65_536;
const BLOCKS = 8;
const MINT = 'https://mint.desk-it.test' as MintUrl;
const RELAY = 'wss://relay.desk-it.test' as RelayUrl;
const PASS = 'desktop-pays-integration-passphrase';
const CREATOR_P2PK = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x3d))).toString(
  'hex',
) as CashuP2pkPubkey;
const CREATOR = 'c1'.repeat(32) as NostrPubkey;
const POLICY: PricePolicy = {
  satsPerBlock: 2 as Sats,
  blockSize: BLOCK,
  mints: [MINT],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
};
const FUND = 200;

describe('the desktop app pays a seeder daemon for real (ADR 0012)', () => {
  const teardown: (() => Promise<void>)[] = [];
  let testnet: DevTestnet;
  let mint: mocks.TestMint;
  let pool: nostr.FakeRelayPool;
  let upRt: SeederRuntime;
  let upSeeder: Seeder;
  let plane: MoneyPlane;
  let worker: WorkerClient;
  let core: CoreKeyHex;
  let blob: { blockOffset: number; blockLength: number; byteOffset: number; byteLength: number };
  let data: Uint8Array;

  beforeAll(async () => {
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x7a) });
    pool = new nostr.FakeRelayPool();

    // --- the seeder daemon (swarm server) with its real runtime
    const up = await tempDir('nf-desk-up-');
    teardown.push(up.rm);
    const dataDir = path.join(up.dir, 'data');
    await mkdir(dataDir, { mode: 0o700 });
    await createKeyFile({
      keyFile: path.join(dataDir, 'identity.key'),
      passphrase: Buffer.from(PASS),
      cost: signerMod.minimumCost(),
    });
    const creds = path.join(up.dir, 'creds');
    await mkdir(creds, { mode: 0o700 });
    await writeFile(path.join(creds, PASSPHRASE_CREDENTIAL), PASS, { mode: 0o400 });
    const cfg = validateDaemonConfig({
      dataDir,
      diskCapBytes: 64 << 20,
      swarm: { bootstrap: testnet.bootstrap, server: true, client: false },
      relays: [RELAY],
      policy: { ...POLICY, creatorPubkey: CREATOR },
      flushEveryBlocks: 100_000,
      flushEveryMs: 3_600_000,
    });
    if (!cfg.ok) throw new Error(cfg.errors.join('; '));
    const quiet = createLogger({ level: 'error', sink: () => undefined });
    upRt = await createSeederRuntime(cfg.config, {
      credentialsDirectory: creds,
      logger: quiet,
      mintRequest: () => mint.request,
      pool,
    });
    upSeeder = await Seeder.create(cfg.config.seeder, {
      engine: upRt.engine,
      logger: quiet,
      fs: nodeAdapters.fs,
      crypto: nodeAdapters.crypto,
    });
    teardown.push(async () => {
      await upSeeder.close();
      await upRt.close();
    });
    data = new Uint8Array(BLOCK * BLOCKS).map((_, i) => (i * 29 + 11) % 256);
    const put = await upSeeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error('put failed');
    core = put.entry.coreKey;
    blob = put.entry.blob;
    upRt.attach(upSeeder);
    upSeeder.start();
    await upSeeder.swarm!.flushedAll();

    // --- the desktop: the host's money plane (the user's NIP-60 wallet), funded
    const { signer } = await signerMod.LocalSigner.create({
      passphrase: Buffer.from(PASS),
      cost: signerMod.minimumCost(),
    });
    plane = await MoneyPlane.open({
      signer,
      journalDir: null, // in memory: these tests are not about the journal
      pool,
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [MINT],
      log: memoryLogger('warn'),
      mintRequest: () => mint.request,
      createWallet: true,
    });
    teardown.push(() => {
      plane.close();
      return Promise.resolve();
    });
    const q = await plane.wallet.mintQuote(MINT, FUND as Sats);
    mint.payQuote(q.quoteId);
    await plane.wallet.pollQuote(q);

    // --- the desktop worker, real providers, every money step asked of the host above
    const wdir = await tempDir('nf-desk-worker-');
    teardown.push(wdir.rm);
    worker = startWorker({
      handlers: {
        ...plane.handlers(),
        'studio.publish': () => Promise.reject(new Error('not in this test')),
      },
      testBootstrap: testnet.bootstrap,
      logLevel: 'error',
    });
    teardown.push(() => worker.close());
    await worker.call('init', {
      v: 1,
      storage: wdir.dir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      payments: plane.payments(),
    });
    await worker.event(
      (e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready',
      10_000,
      'ready',
    );
  }, 120_000);

  afterAll(async () => {
    for (const close of teardown.reverse()) await close();
  }, 60_000);

  it("streams the video byte-exact and pays the seeder for every block from the user's NIP-60 wallet", async () => {
    const sid = randomBytes(16).toString('hex') as SessionId;
    // The host authorises the session before the worker opens it (as the adapter does).
    plane.authorizeSession(sid, { core, blob, policy: POLICY }, CREATOR);
    const { link } = await worker.call('play.open', {
      sid,
      videoId: 'ee'.repeat(32) as never,
      rendition: {
        label: '720p',
        hyper: { core, blob },
        size: blob.byteLength,
        bitrateKbps: 100_000,
      },
      policy: POLICY,
      prefetchSeconds: 30,
    });
    const got = await httpGet(link);
    expect(got.status).toBe(200);
    expect(Buffer.compare(Buffer.from(got.body), Buffer.from(data))).toBe(0);

    // The seeder bound the USER's pubkey (a HELLO signed by the host) and is paid in full.
    await until(
      () => {
        const w = upRt.engine.window(plane.pubkey);
        return w !== undefined && w.uploaded >= BLOCKS && w.outstanding === 0;
      },
      20_000,
      'every block paid',
    );
    const w = upRt.engine.window(plane.pubkey)!;
    expect(w.paid).toBe(w.uploaded);
    expect(
      upSeeder.sessionInfos().some((s) => s.pubkey === plane.pubkey && s.cutReason === null),
    ).toBe(true);
    expect(upRt.engine.isBanned(plane.pubkey)).toBe(false);

    // The user's wallet paid exactly the blocks it was sent, at the manifest price.
    expect(FUND - (await plane.wallet.balance(MINT))).toBe(w.paid * POLICY.satsPerBlock);
    const spends = worker.events.filter(
      (e): e is Extract<WorkerEvent, { e: 'spend' }> => e.e === 'spend',
    );
    expect(spends.at(-1)?.total).toBe(w.paid * POLICY.satsPerBlock);

    // The seeder redeems its share and nutzaps the creator's.
    const flushed = await upSeeder.flushNow();
    expect(flushed).toMatchObject({ failed: 0 });
    expect(flushed.swapped).toBeGreaterThan(0);
    const zaps = pool.published
      .filter((p) => p.event.kind === NostrKind.NutzapPayout)
      .map((p) => nostr.parseNutzap(p.event));
    expect(zaps.some((z) => z?.recipient === CREATOR)).toBe(true);
    await worker.call('play.close', { sid });
    plane.revokeSession(sid);
  }, 120_000);
});
