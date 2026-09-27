/**
 * The creator carry across PAYs (ADR 0010, contracts v5/v6), end to end on the desktop: the worker
 * (`WorkerHost` under Node, through the real framed wire and guards) with REAL payment providers,
 * every PAY built by the host's money plane (the user's NIP-60 wallet over a FakeRelayPool, a real
 * LocalSigner, the in-process TestMint), against a seeder DAEMON (its real runtime and engine, real
 * `pay/1` over real hyperswarm) on a local `hyperdht` testnet.
 *
 * Independent review (lane P2-owed-viewer, HIGH): the worker's payer dropped the carry its chain
 * holds, so the host split every fresh PAY with `carryIn` 0; the seeder refuses a PAY whose carry
 * differs from its own (`malformed`), after the proofs were spent, and the stream stalls. Every
 * other desktop test pays 2 sats/block at 50/50, where the carry is always 0 — here it is 3 sats
 * per block at 90/10, so no PAY of fewer than 10 blocks leaves a carry of 0, and a PAY of 1 to 3
 * blocks from a carry of 0 gives the creator 0 sats: an EMPTY creator set, which the contract
 * allows and the worker's guard refused (found building this test: the host had already built
 * the PAY, its proofs spent):
 *
 *   A. fresh PAYs across a whole video: each is split with the carry the last accepted one left,
 *      empty creator sets included — every block paid, no PAY refused, no ban;
 *   B. an owed PAY (the tail of an earlier run, ADR 0018 amendment) and then this connection's
 *      fresh PAYs of the same core share ONE chain: the owed PAY moves the carry, the fresh ones
 *      are split with it — every block paid, no PAY refused, no ban.
 *
 * TestMint only (the worker's IPC guard admits only `https` mint URLs; the local real mints are
 * plain `http`).
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
import { mocks, nostr, payment, signer as signerMod } from '@sovit/core';
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

import { hostError } from '../errors.js';
import type { SessionId } from '../../ipc/protocol.js';
import type { WorkerEvent } from '../../ipc/worker-protocol.js';
import type { DevTestnet } from '../../worker/dev/fixtures-net.js';
import { startDevTestnet } from '../../worker/dev/fixtures-net.js';
import type { WorkerClient } from '../../worker/__tests__/helpers/harness.js';
import { httpGet, startWorker, tempDir } from '../../worker/__tests__/helpers/harness.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import { TAIL_DIR } from '../tails.js';

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const never = (): Promise<never> => new Promise<never>(() => undefined);

const BLOCK = 65_536;
const MINT = 'https://mint.carry-it.test' as MintUrl;
const RELAY = 'wss://relay.carry-it.test' as RelayUrl;
const PASS = 'desktop-carry-integration-passphrase';
const CREATOR_P2PK = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x3f))).toString(
  'hex',
) as CashuP2pkPubkey;
const CREATOR = 'c3'.repeat(32) as NostrPubkey;
/** 3 sats at 90/10: a PAY of 1 to 9 blocks leaves a creator carry (never 0). */
const POLICY: PricePolicy = {
  satsPerBlock: 3 as Sats,
  blockSize: BLOCK,
  mints: [MINT],
  split: { seeder: 90, creator: 10 },
  creatorP2pk: CREATOR_P2PK,
};
const FUND = 400;

interface Video {
  readonly blob: {
    readonly blockOffset: number;
    readonly blockLength: number;
    readonly byteOffset: number;
    readonly byteLength: number;
  };
  readonly data: Uint8Array;
}

describe('the creator carry across PAYs on the desktop (ADR 0010; independent review, lane P2-owed-viewer)', () => {
  const teardown: (() => Promise<void>)[] = [];
  let testnet: DevTestnet;
  let mint: mocks.TestMint;
  let pool: nostr.FakeRelayPool;
  let upRt: SeederRuntime;
  let upSeeder: Seeder;
  let core: CoreKeyHex;
  const videos: Video[] = [];
  let root: string;

  beforeAll(async () => {
    // The chosen split must leave a carry for the PAY sizes these scenarios make.
    for (let blocks = 1; blocks < 10; blocks++)
      expect(payment.splitPay(blocks * 3, POLICY.split, 0).carryOut).not.toBe(0);
    expect(payment.splitPay(6, POLICY.split, 0).creatorSats).toBe(0); // an empty creator set
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x7c) });
    pool = new nostr.FakeRelayPool();
    const r = await tempDir('nf-carry-it-');
    root = r.dir;
    teardown.push(r.rm);

    const dataDir = path.join(root, 'daemon');
    await mkdir(dataDir, { mode: 0o700 });
    await createKeyFile({
      keyFile: path.join(dataDir, 'identity.key'),
      passphrase: Buffer.from(PASS),
      cost: signerMod.minimumCost(),
    });
    const creds = path.join(root, 'creds');
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
    for (let v = 0; v < 3; v++) {
      const data = new Uint8Array(BLOCK * 8).map((_, i) => (i * 41 + v * 13 + 7) % 256);
      const put = await upSeeder.putBytes(data, { mime: 'video/mp4' });
      if (!put.ok) throw new Error('put failed');
      if (v === 0) core = put.entry.coreKey;
      else if (put.entry.coreKey !== core) throw new Error('one core expected');
      videos.push({ blob: put.entry.blob, data });
    }
    upRt.attach(upSeeder);
    upSeeder.start();
    await upSeeder.swarm!.flushedAll();
  }, 120_000);

  afterAll(async () => {
    for (const close of teardown.reverse()) await close();
  }, 60_000);

  interface Viewer {
    readonly plane: MoneyPlane;
    readonly dir: string;
    /** Refuse PAYs "for now" (nothing spent), as during a melt. */
    refuse: boolean;
    /** The `carryIn` of every PAY the host built. */
    readonly carries: number[];
  }

  async function viewer(name: string): Promise<Viewer> {
    const { signer } = await signerMod.LocalSigner.create({
      passphrase: Buffer.from(`${PASS}-${name}`),
      cost: signerMod.minimumCost(),
    });
    const dir = path.join(root, `viewer-${name}`);
    await mkdir(path.join(dir, 'worker'), { recursive: true });
    const plane = await MoneyPlane.open({
      signer,
      journalDir: null,
      tailDir: path.join(dir, TAIL_DIR),
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
    return { plane, dir, refuse: false, carries: [] };
  }

  async function startFor(v: Viewer): Promise<WorkerClient> {
    const handlers = v.plane.handlers();
    const build = handlers['pay.build'];
    if (build === undefined) throw new Error('the money plane has no pay.build handler');
    const w = startWorker({
      handlers: {
        ...handlers,
        'pay.build': (a) =>
          v.refuse
            ? Promise.reject(hostError('rate-limited', 'a melt is in flight at this mint'))
            : build(a).then((m) => {
                v.carries.push(a.carryIn);
                return m;
              }),
        'studio.publish': () => Promise.reject(new Error('not in this test')),
      },
      testBootstrap: testnet.bootstrap,
      logLevel: 'error',
      unpaidFlushMs: 50,
      reportWaitMs: 1500,
    });
    teardown.push(() => w.close());
    await w.call('init', {
      v: 1,
      storage: path.join(v.dir, 'worker'),
      seeding: { enabled: false, diskCapBytes: 1024 ** 3 },
      prefetchSeconds: 30,
      payments: v.plane.payments(),
    });
    await w.event(
      (e): e is Extract<WorkerEvent, { e: 'ready' }> => e.e === 'ready',
      10_000,
      'ready',
    );
    return w;
  }

  /** The host authorises, the worker opens (paced: a 1 kbit/s rendition and no prefetch). */
  async function open(v: Viewer, w: WorkerClient, video: Video, paced: boolean) {
    const sid = randomBytes(16).toString('hex') as SessionId;
    v.plane.authorizeSession(sid, { core, blob: video.blob, policy: POLICY }, CREATOR);
    const { link } = await w.call('play.open', {
      sid,
      videoId: 'ee'.repeat(32) as never,
      rendition: {
        label: '720p',
        hyper: { core, blob: video.blob },
        size: video.blob.byteLength,
        bitrateKbps: paced ? 1 : 100_000,
      },
      policy: POLICY,
      prefetchSeconds: paced ? 0 : 30,
    });
    return { sid, link };
  }

  const counted = (v: Viewer) =>
    upRt.engine.window(v.plane.pubkey) ?? { uploaded: 0, paid: 0, outstanding: 0, banned: false };

  /**
   * The whole blob over the playback link — failing at once, and saying which, when the seeder
   * refuses a PAY (a carry that is not its own) or bans the viewer, instead of stalling.
   */
  async function streamWatched(v: Viewer, w: WorkerClient, link: string) {
    const flag = { stop: false };
    const watch = (async () => {
      while (!flag.stop) {
        if (w.host.internals.payer!.stats().acksRejected > 0)
          throw new Error('the seeder refused a PAY (its carry is not the chain’s)');
        if (counted(v).banned || upRt.engine.isBanned(v.plane.pubkey))
          throw new Error('the seeder banned the viewer');
        await sleep(20);
      }
    })();
    try {
      return await Promise.race([httpGet(link), watch.then(() => never())]);
    } finally {
      flag.stop = true;
      await watch.catch(() => undefined);
    }
  }

  it('A: fresh PAYs across a whole video at 3 sats, 90/10 — each split with the carry of its chain: every block paid, none refused, no ban', async () => {
    const v = await viewer('a');
    const w = await startFor(v);
    const before = await v.plane.wallet.balance(MINT);
    const { sid, link } = await open(v, w, videos[0]!, false);
    const got = await streamWatched(v, w, link);
    expect(got.status).toBe(200);
    expect(Buffer.compare(Buffer.from(got.body), Buffer.from(videos[0]!.data))).toBe(0);
    await until(
      () => counted(v).outstanding === 0 && counted(v).paid >= videos[0]!.blob.blockLength,
      20_000,
      'every block paid',
    );
    const { unpaid } = await w.call('play.close', { sid });
    expect(unpaid).toBe(0);
    await v.plane.revokeSession(sid, unpaid);
    const s = w.host.internals.payer!.stats();
    // Every PAY the host built went on the wire (none thrown away after its proofs were spent)…
    expect(v.carries).toHaveLength(s.pays);
    // …and every one after the first was split with the carry its chain held — never 0 here.
    expect(s.pays).toBeGreaterThan(1);
    expect(v.carries[0]).toBe(0);
    expect(v.carries.slice(1).every((c) => c > 0)).toBe(true);
    expect(s.acksRejected).toBe(0);
    expect(counted(v)).toMatchObject({ outstanding: 0, banned: false });
    expect(upSeeder.bans()).toEqual([]);
    expect(before - (await v.plane.wallet.balance(MINT))).toBe(
      counted(v).paid * POLICY.satsPerBlock,
    );
  }, 120_000);

  it('B: an owed PAY, then fresh PAYs of the same core at 3 sats, 90/10 — one chain: every block paid, none refused, no ban', async () => {
    const v = await viewer('b');
    let w = await startFor(v);
    v.refuse = true;
    const first = await open(v, w, videos[1]!, true);
    const r0 = await httpGet(first.link, { Range: `bytes=0-99` });
    expect(r0.status).toBe(206);
    await until(() => counted(v).outstanding === 1, 20_000, 'block 0 unpaid');
    // A graceful close with a tail of 1 block (a PAY of 1 block leaves a carry of 30).
    const { unpaid } = await w.call('play.close', { sid: first.sid });
    expect(unpaid).toBe(1);
    await v.plane.revokeSession(first.sid, unpaid);
    await w.close();
    v.refuse = false;
    w = await startFor(v);
    const next = await open(v, w, videos[2]!, false);
    const got = await streamWatched(v, w, next.link);
    expect(got.status).toBe(200);
    expect(Buffer.compare(Buffer.from(got.body), Buffer.from(videos[2]!.data))).toBe(0);
    await until(() => counted(v).outstanding === 0, 20_000, 'every block paid');
    const closed = await w.call('play.close', { sid: next.sid });
    await v.plane.revokeSession(next.sid, closed.unpaid);
    const s = w.host.internals.payer!.stats();
    expect(s).toMatchObject({ owedRecorded: 1, owedPaid: 1, acksRejected: 0 });
    expect(v.carries).toHaveLength(s.pays);
    expect(s.pays).toBeGreaterThan(1);
    // The owed PAY (1 block) opened the chain at 0 and left 30; every fresh PAY after it carried on.
    expect(v.carries[0]).toBe(0);
    expect(v.carries[1]).toBe(payment.splitPay(3, POLICY.split, 0).carryOut);
    expect(v.carries.slice(1).every((c) => c > 0)).toBe(true);
    expect(counted(v)).toMatchObject({ outstanding: 0, banned: false });
    expect(upSeeder.bans()).toEqual([]);
  }, 120_000);
});
