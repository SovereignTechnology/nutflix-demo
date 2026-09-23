/**
 * `--dev-fixtures`: an in-process seeder network for the desktop shell to play from before
 * there is a real catalogue (design §5(a)/(b)), and the rig the Stage 1 exit test uses.
 *
 *   - a local `hyperdht` testnet bound to 127.0.0.1 (`startDevTestnet`) unless the caller has
 *     one;
 *   - two `@sovit/seeder` nodes, S1 and S2, each with `MockPaymentEngine('honest')`, a
 *     `PeerNode` on that testnet (DHT bound to loopback) and `pay/1` through the shared
 *     `LoopbackPayHub` (D1);
 *   - S1 writes every fixture blob; S2 MIRRORS the second half of each blob as a PAYING viewer
 *     of S1 (credit-gated like any viewer, so S1 never cuts it); then S1 CLEARS that half.
 *     S1 now holds exactly the first half and S2 exactly the second: a viewer MUST fetch
 *     from both, deterministically (design §5(a) has S1 clear `[16, 32)`; S2 mirroring only
 *     that half makes the split disjoint, which is what makes "attributed to both seeders"
 *     deterministic — see docs/lanes/L6-C.md);
 *   - `videos`: live manifests of those blobs — UNSIGNED (`sig` = zeros, id = NIP-01 hash of
 *     the unsigned event), loudly logged, for the host's fixture catalogue only.
 *
 * Dev and test only: the worker imports this module dynamically behind `--dev-fixtures`.
 */
import type {
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  PricePolicy,
  ProcessRunner,
  Rendition,
  UnixSeconds,
  VideoManifest,
} from '@sovit/core';
import { DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_BLOCKS, mocks } from '@sovit/core';
import createTestnet from 'hyperdht/testnet.js';
import type { CasEntry, Logger, SeederCrypto, SeederFs } from '@sovit/seeder';
import { Seeder, fromHex, toHex } from '@sovit/seeder';

import { utf8 } from '../../ipc/codec.js';
import { sha256Hex } from '../crypto.js';
import type { BootstrapNode } from '../net/peer-node.js';
import { PeerNode } from '../net/peer-node.js';
import { ViewerPayer } from '../pay/viewer-payer.js';
import { CreditPool } from '../playback/credit.js';
import type { DevEngine } from './dev-engine.js';
import { DEV_PRICE, devEngine, devHello, devIdentity } from './dev-mocks.js';
import type { LoopbackPayHub } from './loopback-pay.js';

export interface DevTestnet {
  readonly bootstrap: readonly BootstrapNode[];
  destroy(): Promise<void>;
}

/** A 3-node hyperdht testnet on 127.0.0.1 (nothing leaves loopback). */
export async function startDevTestnet(size = 3): Promise<DevTestnet> {
  const t = await createTestnet(size, { host: '127.0.0.1' });
  return { bootstrap: t.bootstrap, destroy: () => t.destroy() };
}

/** The price every dev fixture carries: 2 sats/block so a 1-block PAY splits into 1 + 1. */
export function devFixturePolicy(): PricePolicy {
  return {
    satsPerBlock: DEV_PRICE,
    blockSize: DEFAULT_BLOCK_SIZE,
    mints: [mocks.MINTS.a],
    split: { seeder: 50, creator: 50 },
    creatorP2pk: devIdentity('creator').p2pk,
  };
}

export interface FixtureInput {
  readonly title: string;
  readonly bytes: Uint8Array;
  readonly durationSec: number;
  /** Rendition label (default `360p`). */
  readonly label?: string;
}

export interface FixtureSeeder {
  readonly name: string;
  readonly seeder: Seeder;
  readonly engine: DevEngine;
  readonly node: PeerNode;
  readonly payer: ViewerPayer;
  readonly credit: CreditPool;
  /** Swarm Noise key (hex) — what a viewer's `download` events carry. */
  noiseKeyHex(): string;
  close(): Promise<void>;
}

export interface FixtureSeederOptions {
  readonly name: string;
  readonly dataDir: string;
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly hub: LoopbackPayHub;
  readonly bootstrap: readonly BootstrapNode[];
  readonly logger: Logger;
  readonly policy: PricePolicy;
}

/** One dev seeder: a Seeder + loopback PeerNode + hub `pay/1`, able to pay (mirror) and be paid. */
export async function createFixtureSeeder(o: FixtureSeederOptions): Promise<FixtureSeeder> {
  const engine = devEngine(`fixture:${o.name}`);
  const logger = o.logger.child({ fixture: o.name });
  const seeder = await Seeder.create(
    { dataDir: o.dataDir, diskCapBytes: 4 * 1024 ** 3, swarm: null, policy: o.policy },
    { engine, fs: o.fs, crypto: o.crypto, logger },
  );
  const credit = new CreditPool(DEFAULT_WINDOW_BLOCKS);
  const payer = new ViewerPayer({
    pay: (range, s, policy) => engine.pay(range, s, policy),
    ownMints: engine.config.acceptedMints,
    credit,
    logger,
    policyFor: (core) => seeder.corePolicyMap().get(core) ?? null,
  });
  const node = new PeerNode({
    seeder,
    logger,
    bootstrap: o.bootstrap,
    loopbackOnly: true,
    pay: {
      protocol: (link) => o.hub.endpoint(link),
      hello: () => devHello(engine, o.policy),
    },
    payer,
  });
  seeder.start();
  node.start();
  return {
    name: o.name,
    seeder,
    engine,
    node,
    payer,
    credit,
    noiseKeyHex: () => toHex(node.publicKey),
    close: async () => {
      await node.destroy();
      await seeder.close();
    },
  };
}

export interface FixtureNetOptions {
  readonly baseDir: string;
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly hub: LoopbackPayHub;
  readonly bootstrap: readonly BootstrapNode[];
  readonly logger: Logger;
  readonly fixtures: readonly FixtureInput[];
  readonly now?: () => number;
  /** Bound on every wait during setup (ms). */
  readonly timeoutMs?: number;
}

export interface FixtureNet {
  readonly s1: FixtureSeeder;
  readonly s2: FixtureSeeder;
  readonly policy: PricePolicy;
  readonly entries: readonly CasEntry[];
  readonly videos: readonly VideoManifest[];
  close(): Promise<void>;
}

/** Start S1 + S2, split every fixture blob between them (see the module comment). */
export async function startFixtureNet(o: FixtureNetOptions): Promise<FixtureNet> {
  if (o.bootstrap.length === 0 || o.bootstrap.some((b) => b.host !== '127.0.0.1'))
    throw new Error('invalid-argument: the fixture network needs a 127.0.0.1 bootstrap');
  const timeoutMs = o.timeoutMs ?? 30_000;
  const policy = devFixturePolicy();
  const common = {
    fs: o.fs,
    crypto: o.crypto,
    hub: o.hub,
    bootstrap: o.bootstrap,
    logger: o.logger,
    policy,
  };
  const s1 = await createFixtureSeeder({
    ...common,
    name: 's1',
    dataDir: o.fs.join(o.baseDir, 's1'),
  });
  const s2 = await createFixtureSeeder({
    ...common,
    name: 's2',
    dataDir: o.fs.join(o.baseDir, 's2'),
  });
  const close = async (): Promise<void> => {
    await s2.close();
    await s1.close();
  };
  try {
    const entries: CasEntry[] = [];
    for (const f of o.fixtures) {
      const put = await s1.seeder.putBytes(f.bytes, { mime: 'video/mp4' });
      if (!put.ok) throw new Error(`internal: fixture write failed (${put.error.code})`);
      entries.push(put.entry);
    }
    for (const e of entries) {
      s1.seeder.setCorePolicy(e.coreKey, policy);
      s2.seeder.setCorePolicy(e.coreKey, policy);
    }
    for (const key of new Set(entries.map((e) => e.coreKey))) {
      const sc = s1.seeder.blobs.coreByKey(key);
      if (sc === undefined) throw new Error('internal: fixture core not open');
      s1.node.join(sc.core.discoveryKey, { server: true, client: false });
      await within(s1.node.flushed(sc.core.discoveryKey), timeoutMs, 'S1 announce');
    }

    // S2 mirrors the second half of every blob as a paying, credit-gated viewer of S1.
    const waits: Promise<void>[] = [];
    for (const key of new Set(entries.map((e) => e.coreKey))) {
      const sc = await s2.seeder.blobs.openCoreByKey(fromHex(key));
      s2.payer.attachCore(sc.core);
      s2.node.join(sc.core.discoveryKey, { server: true, client: true });
    }
    for (const e of entries) {
      const sc = s2.seeder.blobs.coreByKey(e.coreKey);
      if (sc === undefined) throw new Error('internal: mirror core not open');
      const { from, to } = secondHalf(e);
      for (let i = from; i < to; i++) {
        await within(s2.credit.acquire(e.coreKey, i).promise, timeoutMs, 'S2 mirror credit');
        waits.push(sc.core.download({ start: i, end: i + 1 }).done());
      }
    }
    await within(Promise.all(waits), timeoutMs, 'S2 mirror download');
    await s2.payer.flush();
    await within(drained(s2.credit), timeoutMs, 'S2 mirror payments acknowledged');

    // S1 drops what S2 now serves.
    for (const e of entries) {
      const sc = s1.seeder.blobs.coreByKey(e.coreKey);
      if (sc === undefined) throw new Error('internal: fixture core not open');
      const { from, to } = secondHalf(e);
      if (to > from) await sc.core.clear(from, to);
    }

    const now = o.now ?? Date.now;
    const author = devIdentity('creator').pubkey;
    const videos = entries.map((e, i) =>
      fixtureManifest(
        e,
        o.fixtures[i] ?? { title: 'fixture', bytes: new Uint8Array(), durationSec: 1 },
        policy,
        author,
        now(),
      ),
    );
    o.logger.warn('DEV FIXTURES: in-process seeders with mock payments and UNSIGNED manifests', {
      videos: videos.length,
    });
    return { s1, s2, policy, entries, videos, close };
  } catch (err) {
    await close().catch(() => undefined);
    throw err;
  }
}

/** Blocks `[from, to)` of the blob's second half (S2's share). */
export function secondHalf(e: Pick<CasEntry, 'blob'>): {
  readonly from: number;
  readonly to: number;
} {
  const start = e.blob.blockOffset;
  const end = e.blob.blockOffset + e.blob.blockLength;
  return { from: start + Math.floor(e.blob.blockLength / 2), to: end };
}

/** An UNSIGNED kind-21 manifest for a fixture blob (dev catalogue only). */
export function fixtureManifest(
  e: CasEntry,
  f: FixtureInput,
  policy: PricePolicy,
  author: NostrPubkey,
  nowMs: number,
): VideoManifest {
  const { blob } = e;
  const hyperUrl =
    `hyper://${e.coreKey}/${String(blob.blockOffset)}-${String(blob.blockLength)}` +
    (blob.byteOffset > 0 ? `+${String(blob.byteOffset)}` : '');
  const durationSec = Math.max(1, Math.round(f.durationSec));
  const rendition: Rendition = {
    label: f.label ?? '360p',
    mime: 'video/mp4',
    sha256: e.sha256,
    size: e.size,
    bitrateKbps: Math.max(1, Math.round((e.size * 8) / f.durationSec / 1000)),
    hyper: { core: e.coreKey, blob: { ...blob } },
    hyperUrl,
    fallbacks: [],
  };
  const createdAt = Math.floor(nowMs / 1000) as UnixSeconds;
  const content = 'Development fixture served by in-process seeders (--dev-fixtures). UNSIGNED.';
  const tags: string[][] = [
    ['title', f.title],
    ['published_at', String(createdAt)],
    ['imeta', `url ${hyperUrl}`, 'm video/mp4', `x ${e.sha256}`, `size ${String(e.size)}`],
    ...policy.mints.map((m) => ['mint', m]),
    ['price', String(policy.satsPerBlock), 'sat'],
    ['split', `seeder:${String(policy.split.seeder)}`, `creator:${String(policy.split.creator)}`],
    ['p2pk', policy.creatorP2pk],
    ['t', 'dev-fixture'],
    ['duration', String(durationSec)],
  ];
  // NIP-01 id of the UNSIGNED event (a library sha256; nothing is signed — `sig` is zeros).
  const id = sha256Hex(
    utf8.encode(JSON.stringify([0, author, createdAt, 21, tags, content])),
  ) as NostrEventId;
  const event: NostrEvent = {
    id,
    pubkey: author,
    kind: 21,
    created_at: createdAt,
    tags,
    content,
    sig: '0'.repeat(128),
  };
  return {
    id,
    kind: 21,
    author,
    title: f.title,
    description: content,
    publishedAt: createdAt,
    durationSec,
    tags: ['dev-fixture'],
    renditions: [rendition],
    price: policy,
    blossomServers: [],
    event,
  };
}

/** Deterministic, NOT playable bytes (tests; the dev app falls back to these without ffmpeg). */
export function syntheticBytes(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

/** argv for a 6 s `testsrc` + tone H.264/AAC faststart MP4 (the §5(b) e2e fixture shape). */
export function devClipArgv(outPath: string): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=6:size=640x360:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=6',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '50',
    '-c:a',
    'aac',
    '-shortest',
    '-movflags',
    '+faststart',
    '-y',
    outPath,
  ];
}

/** Generates the dev clip with the system ffmpeg; `false` when that fails. */
export async function generateDevClip(
  runner: ProcessRunner,
  ffmpeg: string,
  outPath: string,
): Promise<boolean> {
  try {
    const r = await runner.run(ffmpeg, devClipArgv(outPath));
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** Resolves once every unit of the pool is settled. */
function drained(pool: CreditPool): Promise<void> {
  if (pool.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const off = pool.onAvailable(() => {
      if (pool.size !== 0) return;
      off();
      resolve();
    });
  });
}

/** `p`, or a clear failure after `ms`. */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`backend-down: timed out after ${String(ms)} ms waiting for ${what}`));
    }, ms);
  });
  return Promise.race([p, t]).finally(() => {
    clearTimeout(timer);
  });
}
