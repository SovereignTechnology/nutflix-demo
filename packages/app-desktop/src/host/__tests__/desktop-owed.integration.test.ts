/**
 * The unpaid tail (ADR 0018 amendment 2026-09-26, Cameron; lane P2-owed-viewer), end to end: the
 * desktop worker (`WorkerHost` under Node, through the real framed wire and guards) with REAL
 * payment providers, every money step through the host's money plane (the user's NIP-60 wallet
 * over a FakeRelayPool, a real LocalSigner, the in-process TestMint), against a seeder DAEMON (its
 * real runtime and engine, real `pay/1` over real hyperswarm) on a local `hyperdht` testnet.
 *
 * A tail is made by refusing the session's PAYs "for now" (`rate-limited`, as during a melt:
 * nothing spent, never given up) until the session closes; blocks are paced with Range requests
 * (a 1 kbit/s rendition, no prefetch) where a scenario needs an exact count. Each scenario is its
 * own identity (the daemon counts per viewer pubkey), and a restart of the worker reuses its
 * storage — so the seeder's later `OWED` meets the worker's durable record.
 *
 *   A. graceful close with an unpaid tail → the host keeps a tail authorisation (persisted, the
 *      money plane re-opened from disk) → restart → OWED → paid under it, no ban; the ledger's
 *      "may count its whole window" word holds the first ask until the report is in;
 *   B. a crash (the worker's disk stops, its connections drop, no close): what the last write of
 *      the record holds is paid, the rest the seeder reports is respected, never paid, no ban;
 *   C. a seeder claiming more than the record: only the record's blocks are paid, the claim is
 *      respected — the viewer never asks beyond window minus the claim;
 *   D. an expired tail authorisation: the host refuses it, nothing is paid, the seeder's count is
 *      respected, no ban.
 *
 * TestMint only: the worker's IPC guard admits only `https` mint URLs (by design), and the local
 * real mints (`scripts/real-mint/`) are plain `http`. The owed PAY at a real mint is exercised by
 * the seeder lane (`seeder/src/__tests__/owed.integration.test.ts`) and the gateway's real-mint
 * swarm lane, with `NUTFLIX_REAL_MINT_URL` set.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  OwedRange,
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
import {
  httpGet,
  nodeRuntime,
  nodeStateFs,
  startWorker,
  tempDir,
} from '../../worker/__tests__/helpers/harness.js';
import { UNPAID_DIR } from '../../worker/host.js';
import type { StateFs } from '../../worker/runtime.js';
import { memoryLogger } from '../log.js';
import { MoneyPlane } from '../money.js';
import { TAIL_DIR, TAIL_TTL_MS } from '../tails.js';

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
const MINT = 'https://mint.owed-it.test' as MintUrl;
const RELAY = 'wss://relay.owed-it.test' as RelayUrl;
const PASS = 'desktop-owed-integration-passphrase';
const CREATOR_P2PK = Buffer.from(getPubKeyFromPrivKey(new Uint8Array(32).fill(0x3e))).toString(
  'hex',
) as CashuP2pkPubkey;
const CREATOR = 'c2'.repeat(32) as NostrPubkey;
const POLICY: PricePolicy = {
  satsPerBlock: 2 as Sats,
  blockSize: BLOCK,
  mints: [MINT],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
};
const FUND = 400;
/** The daemon's window toward us, widened for the policy's minimum PAY (the viewer's too). */
const WINDOW = payment.effectiveWindowBlocks(4, POLICY);
/** Fake blocks a lying seeder adds to what it reports (scenario C): past the core's end. */
const LIE: OwedRange = [5000, 5001];

interface Video {
  readonly blob: {
    readonly blockOffset: number;
    readonly blockLength: number;
    readonly byteOffset: number;
    readonly byteLength: number;
  };
  readonly data: Uint8Array;
}

/** A `StateFs` that can stop writing (the worker's disk at a crash). */
function freezable(): { readonly fs: StateFs; freeze(): void } {
  let frozen = false;
  const guard = (): void => {
    if (frozen) throw new Error('the disk is gone');
  };
  return {
    fs: {
      ...nodeStateFs,
      writeAtomic: (p, d) => {
        guard();
        nodeStateFs.writeAtomic(p, d);
      },
      append: (p, d) => {
        guard();
        nodeStateFs.append(p, d);
      },
      appendDurable: (p, d) => {
        guard();
        nodeStateFs.appendDurable(p, d);
      },
    },
    freeze: () => {
      frozen = true;
    },
  };
}

describe('the unpaid tail: the seeder reports, the viewer pays what its record holds (ADR 0018 amendment)', () => {
  const teardown: (() => Promise<void>)[] = [];
  let testnet: DevTestnet;
  let mint: mocks.TestMint;
  let pool: nostr.FakeRelayPool;
  let upRt: SeederRuntime;
  let upSeeder: Seeder;
  let core: CoreKeyHex;
  const videos: Video[] = [];
  let root: string;
  /** Scenario C's pubkey: the daemon lies about what it counts for it. */
  let liar: NostrPubkey | null = null;

  beforeAll(async () => {
    testnet = await startDevTestnet();
    teardown.push(() => testnet.destroy());
    mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x7b) });
    pool = new nostr.FakeRelayPool();
    const r = await tempDir('nf-owed-it-');
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
    for (let v = 0; v < 12; v++) {
      const data = new Uint8Array(BLOCK * 8).map((_, i) => (i * 37 + v * 11 + 5) % 256);
      const put = await upSeeder.putBytes(data, { mime: 'video/mp4' });
      if (!put.ok) throw new Error('put failed');
      if (v === 0) core = put.entry.coreKey;
      else if (put.entry.coreKey !== core) throw new Error('one core expected');
      videos.push({ blob: put.entry.blob, data });
    }
    // Scenario C: the daemon reports (and ACKs) two blocks more than it counts, for one viewer.
    const engine = upRt.engine;
    const unpaid = engine.unpaid.bind(engine);
    const outstandingOn = engine.outstandingOn.bind(engine);
    engine.unpaid = (peer, limits) => {
      const real = unpaid(peer, limits);
      if (peer !== liar) return real;
      const mine = real.find((c) => c.core === core);
      const ranges: OwedRange[] = [...(mine?.ranges ?? []), LIE];
      return [...real.filter((c) => c.core !== core), { core, ranges }];
    };
    engine.outstandingOn = (peer, c) =>
      outstandingOn(peer, c) + (peer === liar && c === core ? LIE[1] - LIE[0] + 1 : 0);
    upRt.attach(upSeeder);
    upSeeder.start();
    await upSeeder.swarm!.flushedAll();
  }, 120_000);

  afterAll(async () => {
    for (const close of teardown.reverse()) await close();
  }, 60_000);

  // ---------------------------------------------------------------- one viewer identity

  interface Viewer {
    readonly signer: signerMod.LocalSigner;
    plane: MoneyPlane;
    readonly dir: string;
    readonly tailDir: string;
    /** Refuse PAYs "for now" (nothing spent). */
    refuse: boolean;
    /** The tails' clock offset (ms). */
    skew: number;
    worker: WorkerClient | null;
  }

  const openPlane = (v: Pick<Viewer, 'signer' | 'tailDir' | 'skew'>, create: boolean) =>
    MoneyPlane.open({
      signer: v.signer,
      journalDir: null,
      tailDir: v.tailDir,
      tailClock: () => Date.now() + v.skew,
      pool,
      relays: () => [{ url: RELAY, read: true, write: true }],
      defaultMints: () => [MINT],
      log: memoryLogger('warn'),
      mintRequest: () => mint.request,
      ...(create ? { createWallet: true } : {}),
    });

  async function viewer(name: string): Promise<Viewer> {
    const { signer } = await signerMod.LocalSigner.create({
      passphrase: Buffer.from(`${PASS}-${name}`),
      cost: signerMod.minimumCost(),
    });
    const dir = path.join(root, `viewer-${name}`);
    const v: Viewer = {
      signer,
      plane: undefined as unknown as MoneyPlane,
      dir,
      tailDir: path.join(dir, TAIL_DIR),
      refuse: false,
      skew: 0,
      worker: null,
    };
    await mkdir(path.join(dir, 'worker'), { recursive: true });
    v.plane = await openPlane(v, true);
    teardown.push(async () => {
      await v.worker?.close();
      v.plane.close();
    });
    const q = await v.plane.wallet.mintQuote(MINT, FUND as Sats);
    mint.payQuote(q.quoteId);
    await v.plane.wallet.pollQuote(q);
    return v;
  }

  async function startFor(v: Viewer, stateFs: StateFs = nodeStateFs): Promise<WorkerClient> {
    const handlers = v.plane.handlers();
    const build = handlers['pay.build'];
    if (build === undefined) throw new Error('the money plane has no pay.build handler');
    const w = startWorker({
      handlers: {
        ...handlers,
        // What the melt gate answers during a melt: nothing spent, asked again later.
        'pay.build': (a) =>
          v.refuse
            ? Promise.reject(hostError('rate-limited', 'a melt is in flight at this mint'))
            : build(a),
        'studio.publish': () => Promise.reject(new Error('not in this test')),
      },
      runtime: { ...nodeRuntime(), stateFs },
      testBootstrap: testnet.bootstrap,
      logLevel: 'error',
      unpaidFlushMs: 50,
      reportWaitMs: 1500,
    });
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
    v.worker = w;
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

  /** Read block `i` of the session's blob (a Range request: the gate fetches just that block). */
  const readBlock = (link: string, i: number) =>
    httpGet(link, { Range: `bytes=${String(i * BLOCK)}-${String(i * BLOCK + 99)}` });

  /**
   * The whole blob over the playback link — failing at once, and saying so, if the daemon bans the
   * viewer meanwhile (an overrun cuts the stream, which would otherwise just stall).
   */
  async function streamUnbanned(v: Viewer, link: string) {
    const flag = { stop: false };
    const banned = (async () => {
      while (!flag.stop) {
        if (counted(v).banned || upRt.engine.isBanned(v.plane.pubkey))
          throw new Error('the seeder banned the viewer (an overrun of its window)');
        await sleep(20);
      }
    })();
    try {
      return await Promise.race([httpGet(link), banned.then(() => never())]);
    } finally {
      flag.stop = true;
      await banned.catch(() => undefined);
    }
  }

  const counted = (v: Viewer) =>
    upRt.engine.window(v.plane.pubkey) ?? { uploaded: 0, paid: 0, outstanding: 0, banned: false };

  /** Close the session through the worker, then the host revokes it with what it reported. */
  async function close(v: Viewer, w: WorkerClient, sid: SessionId): Promise<number> {
    const { unpaid } = await w.call('play.close', { sid });
    await v.plane.revokeSession(sid, unpaid);
    return unpaid;
  }

  /** Blocks of `core` the worker's record holds ON DISK for the daemon. */
  async function onDisk(v: Viewer): Promise<number> {
    let text: string;
    try {
      text = await readFile(
        path.join(v.dir, 'worker', UNPAID_DIR, `${v.plane.pubkey}.json`),
        'utf8',
      );
    } catch {
      return 0;
    }
    const doc = JSON.parse(text) as {
      seeders: Record<string, { blocks: Record<string, [number, number, string][]> }>;
    };
    let n = 0;
    for (const s of Object.values(doc.seeders))
      for (const [from, to] of s.blocks[core] ?? []) n += to - from + 1;
    return n;
  }

  it('A: graceful close with an unpaid tail → the host keeps its authorisation → restart → OWED → paid, no ban', async () => {
    const v = await viewer('a');
    let w = await startFor(v);
    v.refuse = true;
    const { sid, link } = await open(v, w, videos[0]!, false);
    expect((await readBlock(link, 0)).status).toBe(206);
    // PAYs refused: the viewer asks up to the seeder's window, and stops there.
    await until(() => counted(v).outstanding >= WINDOW, 20_000, 'a full window unpaid');
    await sleep(300);
    expect(counted(v).outstanding).toBe(WINDOW);
    const unpaid = await close(v, w, sid);
    expect(unpaid).toBe(WINDOW);
    // A graceful quit, and the host restarts too: its tail authorisation is read from disk.
    await w.close();
    v.plane.close();
    v.plane = await openPlane(v, false);
    v.refuse = false;
    w = await startFor(v);
    const before = await v.plane.wallet.balance(MINT);
    const next = await open(v, w, videos[1]!, false);
    const got = await streamUnbanned(v, next.link);
    expect(got.status).toBe(200);
    expect(Buffer.compare(Buffer.from(got.body), Buffer.from(videos[1]!.data))).toBe(0);
    await until(() => counted(v).outstanding === 0, 20_000, 'every block paid');
    expect(await close(v, w, next.sid)).toBe(0);
    const s = w.host.internals.payer!.stats();
    expect(s).toMatchObject({ owedRecorded: WINDOW, owedPaid: WINDOW, acksRejected: 0 });
    expect(s.owedReported).toBe(WINDOW);
    expect(counted(v)).toMatchObject({ outstanding: 0, banned: false });
    expect(upSeeder.bans()).toEqual([]);
    // The wallet paid the old tail and the new video, each block once, at the manifest price.
    expect(before - (await v.plane.wallet.balance(MINT))).toBe(
      (WINDOW + videos[1]!.blob.blockLength) * POLICY.satsPerBlock,
    );
    expect(w.host.internals.record!.stats().blocks).toBe(0);
  }, 120_000);

  it('B: a crash — what the last write of the record held is paid, the rest the seeder reports is respected, no ban', async () => {
    const v = await viewer('b');
    const disk = freezable();
    let w = await startFor(v, disk.fs);
    v.refuse = true;
    const { sid, link } = await open(v, w, videos[2]!, true);
    expect((await readBlock(link, 0)).status).toBe(206);
    await until(() => counted(v).outstanding === 1, 20_000, 'block 0 unpaid');
    // The record's batch lands on disk…
    const deadline = Date.now() + 10_000;
    while ((await onDisk(v)) !== 1) {
      if (Date.now() > deadline) throw new Error('block 0 never reached the disk');
      await sleep(25);
    }
    // …then the disk stops, and two more blocks arrive unpaid.
    disk.freeze();
    expect((await readBlock(link, 1)).status).toBe(206);
    expect((await readBlock(link, 2)).status).toBe(206);
    await until(() => counted(v).outstanding === 3, 20_000, 'three blocks unpaid');
    // The crash: connections drop with no drain, nothing more is written. The host sees the worker
    // gone (its sessions are dropped: what they left unpaid is unknown).
    await w.host.internals.node!.destroy();
    await v.plane.revokeSession(sid, null);
    await w.close();
    expect(await onDisk(v)).toBe(1);
    v.refuse = false;
    w = await startFor(v);
    const next = await open(v, w, videos[3]!, false);
    const got = await streamUnbanned(v, next.link);
    expect(got.status).toBe(200);
    expect(Buffer.compare(Buffer.from(got.body), Buffer.from(videos[3]!.data))).toBe(0);
    await until(
      () => w.host.internals.payer!.stats().owedPaid === 1,
      20_000,
      'the recorded block paid',
    );
    await close(v, w, next.sid);
    await until(() => counted(v).outstanding === 2, 20_000, 'the rest counted, never paid');
    const s = w.host.internals.payer!.stats();
    expect(s).toMatchObject({ owedReported: 3, owedRecorded: 1, owedPaid: 1, acksRejected: 0 });
    await sleep(300);
    expect(counted(v)).toMatchObject({ outstanding: 2, banned: false });
    expect(upSeeder.bans()).toEqual([]);
  }, 120_000);

  it('C: a seeder claiming more than the record — only the record is paid, the claim is respected, never overrun', async () => {
    const v = await viewer('c');
    let w = await startFor(v);
    v.refuse = true;
    const { sid, link } = await open(v, w, videos[4]!, true);
    expect((await readBlock(link, 0)).status).toBe(206);
    await until(() => counted(v).outstanding === 1, 20_000, 'block 0 unpaid');
    expect(await close(v, w, sid)).toBe(1);
    await w.close();
    // From now on the daemon reports (and ACKs) two blocks it never sent.
    liar = v.plane.pubkey;
    try {
      v.refuse = false;
      w = await startFor(v);
      let worst = 0;
      const sample = setInterval(() => {
        worst = Math.max(worst, counted(v).outstanding);
      }, 1);
      try {
        const next = await open(v, w, videos[5]!, false);
        const got = await streamUnbanned(v, next.link);
        expect(got.status).toBe(200);
        expect(Buffer.compare(Buffer.from(got.body), Buffer.from(videos[5]!.data))).toBe(0);
        await until(() => counted(v).outstanding === 0, 20_000, 'every real block paid');
        await close(v, w, next.sid);
      } finally {
        clearInterval(sample);
      }
      const s = w.host.internals.payer!.stats();
      // Reported: the real block and the two it never sent; paid: only the one the record held.
      expect(s).toMatchObject({ owedReported: 3, owedRecorded: 1, owedPaid: 1, acksRejected: 0 });
      // Respected: what it really counted never passed its window less its claim.
      expect(worst).toBeLessThanOrEqual(WINDOW - (LIE[1] - LIE[0] + 1));
      expect(worst).toBeGreaterThan(0);
      expect(counted(v)).toMatchObject({ outstanding: 0, banned: false });
      expect(upSeeder.bans()).toEqual([]);
    } finally {
      liar = null;
    }
  }, 120_000);

  it('D: an expired tail authorisation — nothing is paid, the seeder’s count is respected, no ban', async () => {
    const v = await viewer('d');
    let w = await startFor(v);
    v.refuse = true;
    const { sid, link } = await open(v, w, videos[6]!, true);
    expect((await readBlock(link, 0)).status).toBe(206);
    await until(() => counted(v).outstanding === 1, 20_000, 'block 0 unpaid');
    expect(await close(v, w, sid)).toBe(1);
    await w.close();
    // Eight days later: the authorisation has expired (the worker's record has not, yet).
    v.skew = TAIL_TTL_MS + 24 * 60 * 60 * 1000;
    v.refuse = false;
    w = await startFor(v);
    const before = await v.plane.wallet.balance(MINT);
    const next = await open(v, w, videos[7]!, false);
    const got = await streamUnbanned(v, next.link);
    expect(got.status).toBe(200);
    expect(Buffer.compare(Buffer.from(got.body), Buffer.from(videos[7]!.data))).toBe(0);
    await until(
      () => counted(v).outstanding === 1 && counted(v).paid >= videos[7]!.blob.blockLength,
      20_000,
      'the new video paid, the old block not',
    );
    await close(v, w, next.sid);
    const s = w.host.internals.payer!.stats();
    expect(s).toMatchObject({ owedReported: 1, owedRecorded: 1, owedPaid: 0 });
    expect(s.unpayableBlocks).toBeGreaterThanOrEqual(1);
    // Refused for good: out of the record; the wallet paid the new video only.
    expect(w.host.internals.record!.stats().blocks).toBe(0);
    expect(before - (await v.plane.wallet.balance(MINT))).toBe(
      videos[7]!.blob.blockLength * POLICY.satsPerBlock,
    );
    expect(counted(v)).toMatchObject({ outstanding: 1, banned: false });
    expect(upSeeder.bans()).toEqual([]);
  }, 120_000);
});
