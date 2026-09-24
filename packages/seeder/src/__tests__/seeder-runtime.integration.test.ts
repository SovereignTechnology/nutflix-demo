/**
 * The seeder DAEMON's runtime (`runtime/index.ts`, what `cli/main.ts` starts) end to end, over
 * REAL hyperswarm on a local `hyperdht` testnet (nothing leaves loopback), paid with real ecash
 * from the in-process `TestMint`, nutzaps published to a `FakeRelayPool`:
 *
 *   - a swarm session gets `pay/1` and a HELLO signed by the key file's identity, naming the key
 *     file's wallet P2PK (the `Seeder.onSessionReady` hook: `session.mux` is null at
 *     `session-open` on a swarm connection);
 *   - the viewer's PAYs are ACKed by the real engine; a flush swaps the seeder share into the
 *     0600 wallet file with the key file's wallet key, and publishes the creator share as one
 *     kind 9321 that the creator redeems;
 *   - F12 on disk: PAYs accepted but not flushed when the process dies are in `pending.json`,
 *     and a new runtime on the same data directory redeems them.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  NostrKind,
  mocks,
  nostr,
  payment,
  payProtocol,
  signer as signerMod,
  wallet as walletMod,
} from '@sovit/core';
import type {
  AckMessage,
  CashuP2pkPubkey,
  CoreKeyHex,
  HelloMessage,
  MintUrl,
  NostrEventId,
  NostrPubkey,
  PricePolicy,
  RelayUrl,
  Sats,
} from '@sovit/core';
import { getPubKeyFromPrivKey } from '@cashu/cashu-ts';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateDaemonConfig } from '../cli/config-file.js';
import type { DaemonConfig } from '../cli/config-file.js';
import type { PeerSession } from '../net/peer-session.js';
import { PASSPHRASE_CREDENTIAL, createKeyFile } from '../runtime/identity.js';
import { createSeederRuntime } from '../runtime/index.js';
import type { SeederRuntime } from '../runtime/index.js';
import { Seeder } from '../seeder.js';
import { toHex } from '../util/hex.js';
import { adapters, capturedLogger, tmpDir } from './helpers.js';
import { until } from './fake-process.js';

vi.setConfig({ testTimeout: 120_000 });

const BLOCK = 1024;
const MINT = 'https://mint.runtime-it.example' as MintUrl;
const RELAY = 'wss://relay.runtime-it.example' as RelayUrl;
const PASS = 'integration-passphrase-0123456789';
const CREATOR_SK = new Uint8Array(32).fill(0x3c);
const CREATOR_P2PK = Buffer.from(getPubKeyFromPrivKey(CREATOR_SK)).toString(
  'hex',
) as CashuP2pkPubkey;
const CREATOR = 'c1'.repeat(32) as NostrPubkey;
const VIDEO = 'ef'.repeat(32) as NostrEventId;
const VIEWER_KEYS = DHT.keyPair(new Uint8Array(32).fill(0x42));

const cleanups: (() => Promise<void>)[] = [];
let testnet: Testnet;
beforeEach(async () => {
  testnet = await createTestnet(3);
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await testnet.destroy();
});

interface DaemonNode {
  readonly seeder: Seeder;
  readonly rt: SeederRuntime;
  readonly config: DaemonConfig;
  readonly log: string[];
  readonly stop: () => Promise<void>;
}

/** The daemon's composition, as `main()` does it: runtime → Seeder.create → attach → start. */
async function daemon(
  dataDir: string,
  creds: string,
  mint: mocks.TestMint,
  pool: nostr.PoolLike,
  videoEvents: Map<CoreKeyHex, NostrEventId>,
): Promise<DaemonNode> {
  const r = validateDaemonConfig({
    dataDir,
    blockSize: BLOCK,
    diskCapBytes: 1 << 22,
    swarm: { bootstrap: testnet.bootstrap, server: true, client: false },
    relays: [RELAY],
    policy: {
      satsPerBlock: 2,
      blockSize: BLOCK,
      mints: [MINT],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: CREATOR_P2PK,
      creatorPubkey: CREATOR,
    },
    flushEveryBlocks: 100_000,
    flushEveryMs: 3_600_000,
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  // The integration adds the video id once the blob exists (the map is read at nutzap time).
  const config: DaemonConfig = { ...r.config, videoEvents };
  const log = capturedLogger('debug');
  const rt = await createSeederRuntime(config, {
    credentialsDirectory: creds,
    logger: log.logger,
    mintRequest: (m) => (m === MINT ? mint.request : undefined),
    pool,
  });
  const seeder = await Seeder.create(config.seeder, {
    engine: rt.engine,
    logger: log.logger,
    ...adapters,
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await seeder.close();
    await rt.close();
  };
  cleanups.push(stop);
  return { seeder, rt, config, log: log.lines, stop };
}

interface ViewerNode {
  readonly seeder: Seeder;
  readonly engine: payment.RealPaymentEngine;
  readonly pubkey: NostrPubkey;
  readonly channel: () => payProtocol.PayChannel | null;
  readonly hello: () => HelloMessage | null;
  readonly acks: AckMessage[];
}

/** A viewer: a Seeder as a swarm client, pay/1 + its own HELLO, a real viewer engine. */
async function viewer(mint: mocks.TestMint): Promise<ViewerNode> {
  const t = await tmpDir('nutflix-runtime-viewer-');
  const log = capturedLogger('warn');
  const node = await Seeder.create(
    {
      dataDir: t.dir,
      diskCapBytes: 1 << 22,
      blockSize: BLOCK,
      swarm: { bootstrap: testnet.bootstrap, server: false, client: true, keyPair: VIEWER_KEYS },
      flushEveryMs: 3_600_000,
    },
    { engine: new mocks.MockPaymentEngine(), logger: log.logger, ...adapters },
  );
  const { signer: s } = await signerMod.LocalSigner.create({
    passphrase: Buffer.from(PASS),
    cost: signerMod.minimumCost(),
  });
  const pubkey = await s.getPublicKey();
  let chan: payProtocol.PayChannel | null = null;
  let seen: HelloMessage | null = null;
  const acks: AckMessage[] = [];
  node.onSessionReady((session: PeerSession) => {
    const mux = session.mux!;
    const binding = payProtocol.bindingFromMux(mux)!;
    const c = new payProtocol.PayChannel({ binding });
    c.attach(mux);
    c.on('open', (h) => {
      seen = h;
    });
    c.on('ack', (a) => acks.push(a));
    chan = c;
    void payProtocol
      .buildHello(s, binding, {
        acceptedMints: [],
        satsPerBlock: 0 as Sats,
        split: { seeder: 50, creator: 50 },
        p2pk: `02${'aa'.repeat(32)}` as CashuP2pkPubkey,
        windowBlocks: 0,
      })
      .then((h) => {
        c.sendHello(h);
      });
  });
  const engine = new payment.RealPaymentEngine({
    config: {
      windowBlocks: 4,
      acceptedMints: [],
      ownP2pk: `02${'aa'.repeat(32)}` as CashuP2pkPubkey,
      ownPubkey: pubkey,
      flushEveryBlocks: 64,
      flushEveryMs: 60_000,
    },
    wallet: {
      send: (amount, o) =>
        Promise.resolve({
          mint: o.mint,
          unit: 'sat',
          lockedTo: o.p2pk,
          proofs: mint.issue(amount, { p2pk: o.p2pk, ...(o.tags ? { tags: o.tags } : {}) }),
        }),
    },
  });
  cleanups.push(async () => {
    await node.close();
    await t.rm();
  });
  return { seeder: node, engine, pubkey, channel: () => chan, hello: () => seen, acks };
}

async function setup(): Promise<{ dataDir: string; creds: string }> {
  const t = await tmpDir('nutflix-runtime-it-');
  cleanups.push(t.rm);
  const dataDir = path.join(t.dir, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  await createKeyFile({
    keyFile: path.join(dataDir, 'identity.key'),
    passphrase: Buffer.from(PASS),
    cost: signerMod.minimumCost(),
  });
  const creds = path.join(t.dir, 'creds');
  await mkdir(creds, { mode: 0o700 });
  await writeFile(path.join(creds, PASSPHRASE_CREDENTIAL), `${PASS}\n`, { mode: 0o400 });
  return { dataDir, creds };
}

const POLICY: PricePolicy = {
  satsPerBlock: 2 as Sats,
  blockSize: BLOCK,
  mints: [MINT],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
  minPaySats: 1 as Sats,
};

/** Put a blob on the daemon, connect the viewer over the swarm, wait for both HELLOs. */
async function connect(
  d: DaemonNode,
  v: ViewerNode,
  blocks: number,
): Promise<{ core: CoreKeyHex; vcore: Awaited<ReturnType<Seeder['blobs']['openCoreByKey']>> }> {
  const data = new Uint8Array(BLOCK * blocks).map((_, i) => (i * 7 + 3) % 256);
  const put = await d.seeder.putBytes(data, { mime: 'video/mp4' });
  if (!put.ok) throw new Error('put failed');
  d.rt.attach(d.seeder);
  d.seeder.start();
  await d.seeder.swarm!.flushedAll();
  const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(put.entry.coreKey, 'hex'));
  v.seeder.start();
  await v.seeder.swarm!.flush();
  await until(
    () => v.channel()?.state === 'open' && v.hello() !== null,
    'pay/1 open with the daemon HELLO',
    20_000,
  );
  return { core: put.entry.coreKey, vcore };
}

async function payRange(
  v: ViewerNode,
  vcore: Awaited<ReturnType<Seeder['blobs']['openCoreByKey']>>,
  core: CoreKeyHex,
  from: number,
  to: number,
): Promise<void> {
  for (let i = from; i <= to; i++)
    expect(await vcore.core.get(i, { wait: true, timeout: 5000 })).not.toBeNull();
  const h = v.hello()!;
  const before = v.acks.length;
  const msg = await v.engine.pay(
    { core, fromBlock: from, toBlock: to },
    { pubkey: h.pubkey, p2pk: h.p2pk, mint: MINT },
    POLICY,
  );
  v.channel()!.sendPay(msg);
  await until(() => v.acks.length > before, `ACK for ${String(from)}-${String(to)}`, 10_000);
}

describe('the seeder daemon runtime over hyperswarm', () => {
  it('HELLO from the key file identity on a swarm session; PAYs ACKed; the flush fills the 0600 wallet file and publishes one kind 9321 the creator redeems', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x51) });
    const pool = new nostr.FakeRelayPool();
    const { dataDir, creds } = await setup();
    const videos = new Map<CoreKeyHex, NostrEventId>();
    const d = await daemon(dataDir, creds, mint, pool, videos);
    const v = await viewer(mint);
    const { core, vcore } = await connect(d, v, 8);
    videos.set(core, VIDEO);

    // The HELLO the viewer got is the daemon's: key file pubkey, its wallet P2PK, the policy.
    const h = v.hello()!;
    expect(h.pubkey).toBe(d.rt.pubkey);
    expect(h.p2pk).toBe(d.rt.p2pk);
    expect(h.acceptedMints).toEqual([MINT]);
    expect(h.satsPerBlock).toBe(2);
    const session = d.seeder.session(toHex(VIEWER_KEYS.publicKey))!;
    expect(session.pubkey).toBe(v.pubkey); // the viewer's HELLO bound its pubkey

    await payRange(v, vcore, core, 0, 3);
    await payRange(v, vcore, core, 4, 7);
    expect(v.acks.map((a) => [a.fromBlock, a.toBlock, a.ok])).toEqual([
      [0, 3, true],
      [4, 7, true],
    ]);
    // Accepted PAYs are on disk before the flush (F12), 0600.
    const pendingFile = path.join(dataDir, 'wallet', 'pending.json');
    expect((await stat(pendingFile)).mode & 0o777).toBe(0o600);
    const queued = JSON.parse(await readFile(pendingFile, 'utf8')) as { items: unknown[] };
    expect(queued.items).toHaveLength(2);

    expect(await d.seeder.flushNow()).toEqual({ swapped: 8, nutzapped: 8, failed: 0 });
    // The seeder share is in the wallet file, redeemed with the key file's wallet key.
    expect(await d.rt.wallet.balance(MINT)).toBe(8);
    const walletFile = path.join(dataDir, 'wallet', 'proofs.json');
    expect((await stat(walletFile)).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(await readFile(walletFile, 'utf8')) as {
      mints: Record<string, { amount: number }[]>;
    };
    expect(onDisk.mints[MINT]!.reduce((a, p) => a + p.amount, 0)).toBe(8);
    expect((JSON.parse(await readFile(pendingFile, 'utf8')) as { items: unknown[] }).items).toEqual(
      [],
    );

    // One nutzap for both PAYs, signed by the daemon, to the creator, naming the video.
    const zaps = pool.published.filter((p) => p.event.kind === NostrKind.NutzapPayout);
    expect(zaps).toHaveLength(1);
    const ev = zaps[0]!.event;
    expect(ev.pubkey).toBe(d.rt.pubkey);
    expect(nostr.parseNutzap(ev)).toMatchObject({
      recipient: CREATOR,
      mint: MINT,
      videoId: VIDEO,
      claimedAmount: 8,
    });
    expect(JSON.stringify(ev)).not.toContain(v.pubkey); // viewers are never named
    // The creator redeems exactly what the event carries.
    const creatorWallet = new walletMod.CashuWallet({
      mints: new walletMod.CashuMintConnections({ request: () => mint.request }),
      store: new walletMod.MemoryProofStore(),
      key: walletMod.memoryWalletKey(CREATOR_SK),
    });
    const proofs = ev.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]!) as never);
    expect(await creatorWallet.receive({ mint: MINT, proofs })).toBe(8);

    // The daemon announced where it takes nutzaps: its relays, mints and wallet P2PK.
    await until(
      () => pool.published.some((p) => p.event.kind === NostrKind.NutzapInfo),
      'the kind 10019',
    );
    const info = pool.published.find((p) => p.event.kind === NostrKind.NutzapInfo)!.event;
    expect(nostr.parseNutzapInfo(info)).toMatchObject({
      pubkey: d.rt.pubkey,
      p2pk: d.rt.p2pk,
      mints: [{ url: MINT, units: ['sat'] }],
      relays: [RELAY],
    });
    // Nothing the viewer paid with, and no passphrase, reached the log.
    const text = d.log.join('\n');
    expect(text).not.toContain(PASS);
    expect(text).not.toContain('"secret"');
  });

  it('F12 on disk: PAYs ACKed but not flushed when the process dies are redeemed by the next runtime on the same data directory', async () => {
    const mint = new mocks.TestMint({ url: MINT, seed: new Uint8Array(32).fill(0x52) });
    const pool = new nostr.FakeRelayPool();
    const { dataDir, creds } = await setup();
    const d = await daemon(dataDir, creds, mint, pool, new Map());
    const v = await viewer(mint);
    const { core, vcore } = await connect(d, v, 8);
    await payRange(v, vcore, core, 0, 3);
    await payRange(v, vcore, core, 4, 7);
    expect(v.acks.every((a) => a.ok)).toBe(true);
    expect(d.rt.engine.pendingCount()).toBe(2);

    // The process dies before any flush: its in-memory queue is gone (stand-in for kill -9 —
    // the engine's final flush in close() is what a crash never gets to run).
    d.rt.engine.flush = () =>
      Promise.resolve({ swapped: 0 as Sats, nutzapped: 0 as Sats, failed: 0 });
    await d.stop();
    expect(await d.rt.wallet.balance(MINT)).toBe(0);

    const again = await daemon(dataDir, creds, mint, pool, new Map());
    expect(again.rt.engine.pendingCount()).toBe(2);
    expect(await again.rt.engine.flush()).toEqual({ swapped: 8, nutzapped: 8, failed: 0 });
    expect(await again.rt.wallet.balance(MINT)).toBe(8);
    expect(pool.published.filter((p) => p.event.kind === NostrKind.NutzapPayout)).toHaveLength(1);
  });
});
