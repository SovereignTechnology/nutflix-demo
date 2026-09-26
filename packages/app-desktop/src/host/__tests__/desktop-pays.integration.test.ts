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
  /** Fix round 4: two 7-block videos (a tail of one block below the seeder's batch of 2)… */
  let tailA: { blob: typeof blob; data: Uint8Array };
  let tailB: { blob: typeof blob; data: Uint8Array };
  /** …and one more played by a fresh worker after a quit. */
  let fresh: { blob: typeof blob; data: Uint8Array };
  let wdirRoot: string;

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
    const more = async (blocks: number, salt: number) => {
      const d = new Uint8Array(BLOCK * blocks).map((_, i) => (i * 31 + salt) % 256);
      const r = await upSeeder.putBytes(d, { mime: 'video/mp4' });
      if (!r.ok || r.entry.coreKey !== core) throw new Error('put failed');
      return { blob: r.entry.blob, data: d };
    };
    tailA = await more(7, 3);
    tailB = await more(7, 5);
    fresh = await more(8, 7);
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
    wdirRoot = wdir.dir;
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

  // ---- fix round 4 (cross-lane review, HIGH): owed blocks at play.close and at quit ----------
  // `closeSession` deleted the worker's session before its flush, `close()` closed every session
  // before its own, and the host revoked the session before the worker even heard `play.close` —
  // so every PAY for a session's tail (blocks below a batch, behind an unACKed PAY, in flight)
  // was refused 'session-closed'. The seeder kept counting them; after a restart (IR4) the viewer
  // started from zero and the seeder's stuck count plus a fresh window cut and banned it.

  const play = async (w: WorkerClient, v: { blob: typeof blob; data: Uint8Array }) => {
    const sid = randomBytes(16).toString('hex') as SessionId;
    plane.authorizeSession(sid, { core, blob: v.blob, policy: POLICY }, CREATOR);
    const { link } = await w.call('play.open', {
      sid,
      videoId: 'ee'.repeat(32) as never,
      rendition: {
        label: '720p',
        hyper: { core, blob: v.blob },
        size: v.blob.byteLength,
        bitrateKbps: 100_000,
      },
      policy: POLICY,
      prefetchSeconds: 30,
    });
    const got = await httpGet(link);
    expect(got.status).toBe(200);
    expect(Buffer.compare(Buffer.from(got.body), Buffer.from(v.data))).toBe(0);
    return sid;
  };
  const counted = () => upRt.engine.window(plane.pubkey)!;

  it('a tail pending at play.close is paid before play.close answers — while the session still authorises it', async () => {
    const sid = await play(worker, tailA);
    // Straight away (the tail timer is 2 s): the last block is still below a batch of 2.
    await worker.call('play.close', { sid });
    // play.close answered: the tail was paid AND acknowledged — now the host may revoke.
    expect(counted()).toMatchObject({ outstanding: 0, banned: false });
    expect(counted().paid).toBe(counted().uploaded);
    plane.revokeSession(sid);
  }, 60_000);

  it('a quit mid-video pays its tail before the node is destroyed', async () => {
    await play(worker, tailB);
    // No play.close: the worker shuts down with the session open (the host still answering).
    await worker.close();
    expect(counted()).toMatchObject({ outstanding: 0, banned: false });
    expect(counted().paid).toBe(counted().uploaded);
  }, 60_000);

  it('the next start does not overrun the seeder: a fresh worker streams from it at a full window, unbanned, every block paid', async () => {
    const dir = path.join(wdirRoot, 'second-start');
    await mkdir(dir, { recursive: true });
    const second = startWorker({
      handlers: {
        ...plane.handlers(),
        'studio.publish': () => Promise.reject(new Error('not in this test')),
      },
      testBootstrap: testnet.bootstrap,
      logLevel: 'error',
    });
    teardown.push(() => second.close());
    await second.call('init', {
      v: 1,
      storage: dir,
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      payments: plane.payments(),
    });
    await second.event(
      (e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready',
      10_000,
      'ready',
    );
    const sid = await play(second, fresh);
    await second.call('play.close', { sid });
    plane.revokeSession(sid);
    expect(upRt.engine.isBanned(plane.pubkey)).toBe(false);
    expect(upSeeder.bans()).toEqual([]);
    expect(counted()).toMatchObject({ outstanding: 0, banned: false });
  }, 90_000);
});
