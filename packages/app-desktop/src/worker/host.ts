/**
 * WorkerHost — the desktop data plane (design §1 Worker row, §6 L6-C). Runtime-neutral: the
 * runtime is injected (`WorkerRuntime`), so the same object runs under Node in tests and
 * under Bare in production (`./entry.ts` wires it to `Bare.IPC` through `./rpc.ts`).
 *
 * It owns, per worker process:
 *   - ONE `@sovit/seeder` (its Corestore is the worker's only Corestore) created with
 *     `swarm: null`, and ONE `PeerNode` (Hyperswarm, firewall = the seeder's ban list);
 *   - the `CreditPool` + `ViewerPayer` (viewer side: pay what we download, stay under the
 *     seeders' unpaid window);
 *   - the `PlaybackServer` and one `PlaybackGate` per play session;
 *   - the ffmpeg probe and Studio uploads (L8's runner, `studio.publish` asked of the host).
 *
 * Every request arrives already validated by `validateWorkerArgs` (the rpc layer runs the
 * L6-0 guards); failures are thrown as `<code>: …` errors that the rpc layer turns into
 * `WireError`s with `toWireError`.
 */
import type {
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  PeerSpend,
  PricePolicy,
  Sats,
  Sha256Hex,
  UploadProgress,
  VideoManifest,
} from '@sovit/core';
import { MAX_IMAGE_BYTES, manifest, media } from '@sovit/core';
import type { LogLevel, Logger, SeedCore } from '@sovit/seeder';
import { Seeder, fromHex, toHex } from '@sovit/seeder';

import { IpcError } from '../ipc/errors.js';
import type { ErrorCode, FfmpegStatus, SeederStatusWire, SessionId } from '../ipc/protocol.js';
import { LIMITS } from '../ipc/protocol.js';
import type {
  HostMethod,
  HostMethodTable,
  PlayOpenArgs,
  Req,
  StudioUploadArgs,
  WorkerEvent,
  WorkerInit,
  WorkerMethodTable,
} from '../ipc/worker-protocol.js';
import { WORKER_V } from '../ipc/worker-protocol.js';
import { randomHex, sodiumCrypto, sodiumSha256 } from './crypto.js';
import type { LoopbackPayHub } from './dev/loopback-pay.js';
import type { DevTestnet, FixtureInput, FixtureNet } from './dev/fixtures-net.js';
import { probeFfmpeg } from './ffmpeg.js';
import { createWorkerLogger } from './log.js';
import type { LogEvent } from './log.js';
import { PeerNode } from './net/peer-node.js';
import type { BootstrapNode } from './net/peer-node.js';
import type { PaidEvent } from './pay/viewer-payer.js';
import { ViewerPayer } from './pay/viewer-payer.js';
import { CreditPool } from './playback/credit.js';
import type { GateClock } from './playback/gate.js';
import { PlaybackGate, bytesPerSecondOf } from './playback/gate.js';
import { PlaybackServer } from './playback/server.js';
import type { ProviderContext, WorkerProviders } from './providers.js';
import {
  MISSING_PROVIDERS_DETAIL,
  MISSING_PROVIDERS_REASON,
  getWorkerProviders,
} from './providers.js';
import type { WorkerRuntime } from './runtime.js';
import { runWorkerUpload } from './studio/upload.js';

/** Live play sessions per worker (the host backstop keeps ≤ 1 unpaused per window). */
export const MAX_SESSIONS = 16;
/** Trailing window for `ratePerMin`. */
const RATE_WINDOW_MS = 60_000;
/** At most one `seeder.status` push per this many ms. */
const STATUS_THROTTLE_MS = 1000;
/** ADR 0015: the corestore name of this node's own profile core (avatar, thumbnails). */
export const PROFILE_CORE_NAME = 'nutflix-profile';
/** How long one image read may take over the swarm. */
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const ZERO_PUBKEY = '00'.repeat(32) as NostrPubkey;

export type HostRequester = <M extends HostMethod>(
  m: M,
  a: HostMethodTable[M][0],
) => Promise<HostMethodTable[M][1]>;

export type WorkerRequest = Req<WorkerMethodTable>;

export interface WorkerHostOptions {
  readonly runtime: WorkerRuntime;
  /** Events to the host (the rpc layer validates and frames them). */
  readonly emit: (ev: WorkerEvent) => void;
  /** Worker → host requests (`studio.publish`). */
  readonly request: HostRequester;
  /** Dev (D1): the in-process `pay/1` hub, shared with in-process fixture seeders. */
  readonly hub?: LoopbackPayHub;
  readonly logLevel?: LogLevel;
  /** Stage 2 seam; default `getWorkerProviders` (undefined in Stage 1). */
  readonly providers?: (ctx: ProviderContext) => WorkerProviders | undefined;
  readonly clock?: GateClock;
  /** x264 preset for Studio transcodes (tests: `ultrafast`). */
  readonly uploadPreset?: string;
  /**
   * TESTS ONLY: a local DHT for a worker with REAL payments (`init.dev.bootstrap` is fenced to
   * mock payments). Programmatic only — never reachable over IPC, never set by `entry.ts`.
   */
  readonly testBootstrap?: readonly BootstrapNode[];
  readonly now?: () => number;
}

interface Net {
  readonly providers: WorkerProviders;
  readonly seeder: Seeder;
  readonly node: PeerNode;
  readonly payer: ViewerPayer;
  readonly credit: CreditPool;
}

interface PeerTally {
  sats: number;
  blocks: number;
  readonly recent: { at: number; amount: number }[];
}

interface Session {
  readonly sid: SessionId;
  readonly core: CoreKeyHex;
  readonly gate: PlaybackGate;
  readonly openedAt: number;
  total: number;
  readonly recent: { at: number; amount: number }[];
  readonly peers: Map<NostrPubkey, PeerTally>;
  closed: boolean;
}

function fail(code: ErrorCode, detail: string): never {
  throw new IpcError(code, `${code}: ${detail}`);
}

/** `p`, or a rejection after `ms` (a read that never finishes is a failed read). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('deadline'));
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

function trailingSum(recent: { at: number; amount: number }[], now: number): number {
  while (recent.length > 0 && (recent[0]?.at ?? now) < now - RATE_WINDOW_MS) recent.shift();
  let s = 0;
  for (const r of recent) s += r.amount;
  return s;
}

export class WorkerHost {
  private readonly o: WorkerHostOptions;
  private readonly now: () => number;
  private initialising: Promise<void> | null = null;
  private live: {
    readonly init: WorkerInit;
    readonly log: Logger;
    readonly server: PlaybackServer;
    readonly storage: string;
    readonly tmpDir: string;
  } | null = null;
  private net: Net | null = null;
  private hub: LoopbackPayHub | null = null;
  private fixtures: FixtureNet | null = null;
  private testnet: DevTestnet | null = null;
  private seeding: WorkerInit['seeding'] = { enabled: false, diskCapBytes: 0 };
  private readonly sessions = new Map<string, Session>();
  private readonly corePolicies = new Map<CoreKeyHex, PricePolicy>();
  /**
   * ADR 0015: profile cores the image path uses — `opened` when that path opened them (a replica
   * read for display, closed again when this node may not serve it), `refs` = reads in flight.
   */
  private readonly imageCores = new Map<CoreKeyHex, { refs: number; opened: boolean }>();
  private readonly coresAttached = new Set<string>();
  private readonly lastSidForCore = new Map<string, Session>();
  private readonly uploads = new Set<string>();
  private ffmpeg: media.FfmpegPaths | null = null;
  private ffmpegStatus: { readonly key: string; readonly status: FfmpegStatus } | null = null;
  private earnedTotal = 0;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<void> | null = null;

  constructor(o: WorkerHostOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /** The playback server's port (0 before `init`). */
  get port(): number {
    return this.live?.server.port ?? 0;
  }

  /** Test / diagnostics hooks (read-only views). */
  get internals(): {
    readonly seeder: Seeder | null;
    readonly node: PeerNode | null;
    readonly payer: ViewerPayer | null;
    readonly credit: CreditPool | null;
    readonly server: PlaybackServer | null;
    readonly providers: WorkerProviders | null;
    readonly fixtures: FixtureNet | null;
    gate(sid: string): PlaybackGate | null;
  } {
    return {
      seeder: this.net?.seeder ?? null,
      node: this.net?.node ?? null,
      payer: this.net?.payer ?? null,
      credit: this.net?.credit ?? null,
      server: this.live?.server ?? null,
      providers: this.net?.providers ?? null,
      fixtures: this.fixtures,
      gate: (sid) => this.sessions.get(sid)?.gate ?? null,
    };
  }

  /** The `ready` event that follows a successful `init` (sent by the rpc layer). */
  readyEvent(): WorkerEvent {
    return { op: 'ev', e: 'ready', v: WORKER_V, port: this.port };
  }

  /** Dispatch one validated host request. Throws `<code>: …` errors. */
  async handle(req: WorkerRequest): Promise<unknown> {
    if (this.closing !== null) fail('backend-down', 'worker is shutting down');
    if (req.m === 'init') {
      await this.init(req.a);
      return undefined;
    }
    if (this.live === null) fail('backend-down', 'worker is not initialised');
    switch (req.m) {
      case 'play.open':
        return this.playOpen(req.a);
      case 'play.pause':
        this.session(req.a.sid).gate.pause();
        return undefined;
      case 'play.resume':
        this.session(req.a.sid).gate.resume();
        return undefined;
      case 'play.prefetch':
        this.session(req.a.sid).gate.setPrefetchSeconds(req.a.seconds);
        return undefined;
      case 'play.close':
        this.closeSession(req.a.sid);
        return undefined;
      case 'seeder.status':
        return this.seederStatus();
      case 'seeder.configure':
        this.configureSeeding(req.a);
        return undefined;
      case 'seeder.melt':
        return fail(
          'payments-unavailable',
          'melting seeder earnings lands with the Stage 2 wallet',
        );
      case 'seeder.unban':
        this.net?.seeder.unban({ pubkey: req.a.pubkey });
        this.pushStatusSoon();
        return undefined;
      case 'studio.ffmpeg':
        return this.probe(req.a.recheck, req.a.path);
      case 'studio.upload':
        return this.upload(req.a);
      case 'image.fetch':
        return this.imageFetch(req.a);
    }
  }

  // ------------------------------------------------------------------ init

  private init(a: WorkerInit): Promise<void> {
    if (this.initialising !== null) fail('invalid-argument', 'worker already initialised');
    this.initialising = this.doInit(a);
    return this.initialising;
  }

  private async doInit(a: WorkerInit): Promise<void> {
    const { runtime } = this.o;
    const log = createWorkerLogger({
      emit: (ev: LogEvent) => {
        this.o.emit(ev);
      },
      level: this.o.logLevel ?? 'info',
    });
    const dev = a.dev;
    if (dev !== undefined) {
      const { checkDevFence } = await import('./dev/dev-mocks.js');
      checkDevFence(dev);
    }
    const fs = runtime.seederFs;
    await fs.mkdir(a.storage, { recursive: true });
    // Studio work dirs (transcodes, thumbnail candidates) live here; a previous run's are dead.
    const tmpDir = fs.join(a.storage, 'tmp');
    await runtime.mediaFs(a.storage).rm(tmpDir, { recursive: true });
    await fs.mkdir(tmpDir, { recursive: true });
    this.seeding = a.seeding;
    if (a.ffmpeg !== undefined) this.ffmpeg = a.ffmpeg;

    const server = new PlaybackServer({ logger: log, randomHex });
    await server.listen();
    this.live = { init: a, log, server, storage: a.storage, tmpDir };

    let providers: WorkerProviders | undefined;
    const ctx: ProviderContext = { storage: a.storage };
    if (dev?.mocks === true) {
      const { devMockProviders } = await import('./dev/dev-mocks.js');
      const { LoopbackPayHub } = await import('./dev/loopback-pay.js');
      this.hub = this.o.hub ?? new LoopbackPayHub();
      providers = devMockProviders({ hub: this.hub, label: randomHex(8) });
      log.warn('DEV MOCKS: MockPaymentEngine + in-process pay/1; swarm fenced to loopback');
    } else if (a.payments !== undefined) {
      // Stage 3 (ADR 0012): the host's money plane is live — real engines, every money step
      // asked of the host.
      const { realProviders } = await import('./pay/real-providers.js');
      try {
        providers = realProviders({
          payments: a.payments,
          dir: fs.join(a.storage, 'payments'),
          join: (...p) => fs.join(...p),
          state: runtime.stateFs,
          request: this.o.request,
          sidFor: (core) => {
            let sid: SessionId | undefined;
            for (const [id, s] of this.sessions) if (s.core === core) sid = id as SessionId;
            return sid;
          },
          priceCeiling: () => {
            let max = 0;
            for (const p of this.net?.seeder.corePolicyMap().values() ?? [])
              max = Math.max(max, p.satsPerBlock);
            return max as Sats;
          },
          logger: log,
        });
      } catch (err) {
        log.error('payments could not start', { error: err });
        providers = undefined;
      }
    } else {
      providers = (this.o.providers ?? getWorkerProviders)(ctx);
    }
    if (providers === undefined) {
      log.warn(MISSING_PROVIDERS_REASON);
      return;
    }

    let bootstrap: readonly BootstrapNode[] | null = dev?.bootstrap ?? this.o.testBootstrap ?? null;
    if (dev?.fixtures === true && bootstrap === null) {
      const { startDevTestnet } = await import('./dev/fixtures-net.js');
      this.testnet = await startDevTestnet();
      bootstrap = this.testnet.bootstrap;
    }
    if (providers.loopbackOnly && bootstrap === null)
      fail('invalid-argument', 'dev providers need a loopback bootstrap');

    const seeder = await Seeder.create(
      {
        dataDir: fs.join(a.storage, 'seeder'),
        diskCapBytes: a.seeding.diskCapBytes,
        swarm: null,
        // Several videos at their own manifest prices: each core's PRICE precedes its first block.
        announceCorePrices: a.payments !== undefined,
      },
      {
        engine: providers.seederEngine,
        fs,
        crypto: sodiumCrypto,
        logger: log,
        ...(providers.accepting === undefined ? {} : { accepting: providers.accepting }),
      },
    );
    const keyPair = await seeder.blobs.store.createKeyPair('nutflix-desktop-swarm');
    const credit = new CreditPool(providers.creditBlocks);
    const payer = new ViewerPayer({
      pay: providers.pay,
      ownMints: providers.viewerMints,
      credit,
      logger: log,
      policyFor: (core) => this.corePolicies.get(core) ?? null,
      onPaid: (e) => {
        this.onPaid(e);
      },
    });
    const node = new PeerNode({
      seeder,
      logger: log,
      bootstrap,
      loopbackOnly: providers.loopbackOnly,
      keyPair,
      pay: providers.payWiring,
      payer,
    });
    seeder.on((e) => {
      if (e.type === 'flush') this.earnedTotal += e.result.swapped;
      if (e.type !== 'blob-added' && e.type !== 'blob-removed') this.pushStatusSoon();
    });
    seeder.start();
    node.start();
    this.net = { providers, seeder, node, payer, credit };
    // ADR 0015: our own profile core (avatar, thumbnails) is served free while seeding.
    this.ownProfile().catch(() => {
      log.warn('the profile core could not be opened');
    });
    log.info('worker initialised', { seeding: a.seeding.enabled, port: server.port });

    if (dev?.fixtures === true && bootstrap !== null) void this.startFixtures(bootstrap);
  }

  private async startFixtures(bootstrap: readonly BootstrapNode[]): Promise<void> {
    const live = this.live;
    if (live === null) return;
    const log = live.log;
    try {
      const {
        DEV_FIXTURES_ENV,
        MAX_DEV_FIXTURE_BYTES,
        generateDevClip,
        parseDevFixturesEnv,
        startFixtureNet,
        syntheticBytes,
      } = await import('./dev/fixtures-net.js');
      const hub = this.hub;
      if (hub === null) throw new Error('internal: fixtures without the dev pay hub');
      const fs = this.o.runtime.seederFs;
      // Fixture seeders are rebuilt every run: drop the previous runs' stores first.
      const root = fs.join(live.storage, 'dev-fixtures');
      await this.o.runtime.mediaFs(live.storage).rm(root, { recursive: true });
      const dir = fs.join(root, randomHex(8));
      await fs.mkdir(dir, { recursive: true });
      if (this.ffmpeg === null) await this.probe(false);
      const paths = this.ffmpeg;
      const fixtures: FixtureInput[] = [];
      // The §5(b) seam: files named by the environment (L6-A's e2e), else our own clip.
      const raw = this.o.runtime.env(DEV_FIXTURES_ENV);
      const specs = parseDevFixturesEnv(raw);
      if (raw !== undefined && specs === null)
        log.warn('DEV FIXTURES: ignoring a malformed fixture list', { variable: DEV_FIXTURES_ENV });
      for (const spec of specs ?? []) {
        const st = await fs.stat(spec.path);
        if (st === null || !st.isFile || st.size < 1 || st.size > MAX_DEV_FIXTURE_BYTES) {
          log.warn('DEV FIXTURES: skipping an unreadable fixture file', { title: spec.title });
          continue;
        }
        fixtures.push({
          title: spec.title,
          ...(spec.description !== undefined ? { description: spec.description } : {}),
          bytes: await fs.readFile(spec.path),
          durationSec: await this.durationOf(spec.path, paths),
        });
      }
      if (fixtures.length === 0) {
        let bytes: Uint8Array | null = null;
        if (paths !== null) {
          const clip = fs.join(dir, 'testsrc.mp4');
          if (await generateDevClip(this.o.runtime.runner, paths.ffmpeg, clip))
            bytes = await fs.readFile(clip);
        }
        if (bytes === null) {
          log.warn('DEV FIXTURES: no ffmpeg — serving synthetic, unplayable bytes');
          bytes = syntheticBytes(8 * 65536);
        }
        fixtures.push({ title: 'Dev fixture: test pattern (6 s)', bytes, durationSec: 6 });
      }
      this.fixtures = await startFixtureNet({
        baseDir: dir,
        fs,
        crypto: sodiumCrypto,
        hub,
        bootstrap,
        logger: log,
        fixtures,
        now: this.now,
      });
      this.o.emit({ op: 'ev', e: 'dev.fixtures', videos: this.fixtures.videos });
    } catch (err) {
      log.error('dev fixtures failed to start', { error: err });
    }
  }

  /** A fixture file's duration by ffprobe (L8's probe), 6 s when that is not possible. */
  private async durationOf(path: string, binaries: media.FfmpegPaths | null): Promise<number> {
    if (binaries === null || this.live === null) return 6;
    try {
      const probe = await media
        .createMediaPipeline({
          runner: this.o.runtime.runner,
          fs: this.o.runtime.mediaFs(this.live.tmpDir),
          sha256: sodiumSha256,
          binaries,
        })
        .probe(path);
      return probe.durationSec > 0 ? probe.durationSec : 6;
    } catch {
      return 6;
    }
  }

  // ------------------------------------------------------------------ playback

  private requireNet(): Net {
    if (this.net === null) fail('payments-unavailable', MISSING_PROVIDERS_DETAIL);
    return this.net;
  }

  private session(sid: string): Session {
    const s = this.sessions.get(sid);
    if (s === undefined) fail('session-closed', 'no such play session');
    return s;
  }

  private async playOpen(a: PlayOpenArgs): Promise<WorkerMethodTable['play.open'][1]> {
    const live = this.live;
    if (live === null) fail('backend-down', 'worker is not initialised');
    const net = this.requireNet();
    if (this.sessions.has(a.sid)) fail('invalid-argument', 'duplicate session id');
    if (this.sessions.size >= MAX_SESSIONS) fail('rate-limited', 'too many open play sessions');
    const { hyper, size } = a.rendition;
    if (hyper.blob.blockLength < 1 || hyper.blob.byteLength !== size)
      fail('invalid-argument', 'rendition size does not match its blob');
    const core = hyper.core;
    this.corePolicies.set(core, a.policy);
    net.seeder.setCorePolicy(core, a.policy);
    const sc = await net.seeder.blobs.openCoreByKey(fromHex(core));
    if (this.sessions.has(a.sid)) fail('invalid-argument', 'duplicate session id');
    if (!this.coresAttached.has(core)) {
      this.coresAttached.add(core);
      net.payer.attachCore(sc.core);
    }
    net.node.join(sc.core.discoveryKey, { server: this.seeding.enabled, client: true });
    const gate = new PlaybackGate({
      core: sc.core,
      blob: hyper.blob,
      blockSize: a.policy.blockSize,
      bytesPerSec: bytesPerSecondOf({
        bitrateKbps: a.rendition.bitrateKbps,
        size,
        durationSec: a.durationSec,
      }),
      prefetchSeconds: a.prefetchSeconds,
      credit: net.credit,
      logger: live.log,
      ...(this.o.clock ? { clock: this.o.clock } : {}),
    });
    const link = live.server.register(a.sid, core, hyper.blob, gate);
    const s: Session = {
      sid: a.sid,
      core,
      gate,
      openedAt: this.now(),
      total: 0,
      recent: [],
      peers: new Map(),
      closed: false,
    };
    this.sessions.set(a.sid, s);
    this.lastSidForCore.set(core, s);
    live.log.info('play session opened', { core, prefetchBlocks: gate.prefetchBlocks });
    return { key: core, link };
  }

  private closeSession(sid: string): void {
    const s = this.sessions.get(sid);
    if (s === undefined) return;
    this.sessions.delete(sid);
    s.closed = true;
    s.gate.close();
    this.live?.server.unregister(sid);
    // Pay whatever tail is pending now rather than at the next block.
    void this.net?.payer.flush();
  }

  /** One PAY went out: attribute it to the session playing that core (or the last one did). */
  private onPaid(e: PaidEvent): void {
    let s: Session | undefined;
    for (const x of this.sessions.values()) if (x.core === e.core) s = x;
    s ??= this.lastSidForCore.get(e.core);
    if (s === undefined) return;
    const now = this.now();
    s.total += e.amount;
    s.recent.push({ at: now, amount: e.amount });
    let t = s.peers.get(e.seeder);
    if (t === undefined) {
      t = { sats: 0, blocks: 0, recent: [] };
      s.peers.set(e.seeder, t);
    }
    t.sats += e.amount;
    t.blocks += e.blocks;
    t.recent.push({ at: now, amount: e.amount });
    this.o.emit({
      op: 'ev',
      e: 'spend',
      sid: s.sid,
      mint: e.mint,
      amount: e.amount,
      total: s.total as Sats,
      ratePerMin: trailingSum(s.recent, now) as Sats,
    });
    const peers: PeerSpend[] = [];
    for (const [pubkey, p] of s.peers) {
      if (peers.length >= LIMITS.maxArray) break;
      peers.push({
        pubkey,
        sats: p.sats as Sats,
        blocks: p.blocks,
        ratePerMin: trailingSum(p.recent, now) as Sats,
      });
    }
    this.o.emit({ op: 'ev', e: 'peers', sid: s.sid, peers });
  }

  // ------------------------------------------------------------------ seeder

  private seederStatus(): SeederStatusWire {
    const net = this.net;
    if (net === null)
      return {
        enabled: false,
        pubkey: ZERO_PUBKEY,
        videos: 0,
        bytesStored: 0,
        diskCapBytes: this.seeding.diskCapBytes,
        peers: [],
        earned: { total: 0 as Sats, unswapped: 0 as Sats, byMint: { $map: [] } },
        banned: [],
      };
    const stats = net.seeder.stats();
    const banned: SeederStatusWire['banned'][number][] = [];
    for (const b of net.seeder.bans()) {
      if (b.pubkey === null || !/^[0-9a-f]{64}$/.test(b.pubkey)) continue;
      banned.push({
        pubkey: b.pubkey as NostrPubkey,
        reason: b.reason.slice(0, LIMITS.maxLabel),
        at: b.at as SeederStatusWire['banned'][number]['at'],
      });
    }
    return {
      enabled: this.seeding.enabled,
      pubkey: net.providers.pubkey,
      videos: stats.cores,
      bytesStored: stats.usedBytes,
      diskCapBytes: this.seeding.diskCapBytes,
      peers: net.providers.seederEngine.windows().slice(0, 4096),
      earned: {
        total: this.earnedTotal as Sats,
        unswapped: 0 as Sats,
        byMint: { $map: [] as (readonly [MintUrl, Sats])[] },
      },
      banned: banned.slice(0, 4096),
    };
  }

  // ------------------------------------------------------------------ images (ADR 0015)

  /** Whether this node serves creators' profile cores (thumbnails, avatars): free, while seeding. */
  private servesImages(): boolean {
    return this.seeding.enabled && this.seeding.serveImages !== false;
  }

  /** Our own profile core: our avatar and our videos' thumbnails, always free while seeding. */
  private async ownProfile(): Promise<SeedCore> {
    const net = this.requireNet();
    const sc = await net.seeder.blobs.openCore(PROFILE_CORE_NAME);
    net.seeder.setFreeCore(sc.keyHex, true);
    net.node.join(sc.core.discoveryKey, { server: this.seeding.enabled, client: true });
    return sc;
  }

  /** Studio: write a thumbnail into our profile core; the host names it in the manifest. */
  private async putThumbnail(
    bytes: Uint8Array,
  ): Promise<{ url: string; sha256: Sha256Hex; size: number }> {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES)
      fail('invalid-argument', 'thumbnail is empty or larger than the image cap');
    const sc = await this.ownProfile();
    const blob = await sc.blobs.put(bytes);
    const h = sodiumSha256();
    h.update(bytes);
    return {
      url: manifest.encodeHyperUrl({ core: sc.keyHex, blob }),
      sha256: h.digest(),
      size: bytes.byteLength,
    };
  }

  /**
   * `image.fetch`: one image from a creator's profile core, over Pear. Served on (free) only while
   * this node serves images; otherwise a replica opened here is closed once no read needs it, so
   * it is neither announced nor replicated.
   */
  private async imageFetch(a: {
    readonly url: string;
    readonly sha256: Sha256Hex;
    readonly size: number;
  }): Promise<{ hex: string }> {
    const net = this.requireNet();
    const ref = manifest.decodeHyperUrl(a.url, a.size);
    if (ref === null) fail('invalid-argument', 'not a hyper:// image');
    if (!Number.isSafeInteger(a.size) || a.size < 1 || a.size > MAX_IMAGE_BYTES)
      fail('invalid-argument', 'image size out of range');
    const core = ref.core;
    let entry = this.imageCores.get(core);
    if (entry === undefined) {
      entry = { refs: 0, opened: net.seeder.blobs.coreByKey(core) === undefined };
      this.imageCores.set(core, entry);
    }
    entry.refs++;
    try {
      const sc = await net.seeder.blobs.openCoreByKey(fromHex(core));
      const serve = this.servesImages();
      // Free before it can be served: no block of a profile core is ever sold.
      if (serve) net.seeder.setFreeCore(core, true);
      net.node.join(sc.core.discoveryKey, { server: serve, client: true });
      const bytes = await withDeadline(
        sc.blobs.get(ref.blob, { timeout: IMAGE_FETCH_TIMEOUT_MS }),
        IMAGE_FETCH_TIMEOUT_MS,
      );
      if (bytes === null) fail('not-found', 'image not found on the swarm');
      const h = sodiumSha256();
      h.update(bytes);
      if (bytes.byteLength !== a.size || h.digest() !== a.sha256)
        fail('hash-mismatch', 'image does not match its hash');
      return { hex: toHex(bytes) };
    } catch (err) {
      if (err instanceof IpcError) throw err;
      return fail('not-found', 'image could not be read from the swarm');
    } finally {
      entry.refs--;
      if (entry.refs === 0 && !this.servesImages()) void this.releaseImageCore(core);
    }
  }

  /** Stop serving and close every idle profile-core replica the image path opened. */
  private async releaseImageCores(): Promise<void> {
    for (const [core, e] of [...this.imageCores])
      if (e.refs === 0) await this.releaseImageCore(core);
  }

  private async releaseImageCore(core: CoreKeyHex): Promise<void> {
    const e = this.imageCores.get(core);
    const net = this.net;
    if (e === undefined || e.refs > 0 || net === null) return;
    this.imageCores.delete(core);
    if (!e.opened) return; // a core we write to, or one a playback opened: not ours to close
    net.seeder.setFreeCore(core, false);
    const sc = net.seeder.blobs.coreByKey(core);
    if (sc !== undefined) net.node.leave(sc.core.discoveryKey);
    try {
      await net.seeder.blobs.closeCoreByKey(core);
    } catch {
      // already closed, or re-opened as a named core since: leave it
    }
  }

  private configureSeeding(a: WorkerInit['seeding']): void {
    const prevCap = this.seeding.diskCapBytes;
    this.seeding = a;
    // ADR 0015: stop serving other creators' images first, so `setServing` cannot re-announce them.
    if (!this.servesImages()) void this.releaseImageCores();
    this.net?.node.setServing(a.enabled);
    if (a.diskCapBytes !== prevCap)
      this.live?.log.info('disk cap change applies at the next worker start', {
        diskCapBytes: a.diskCapBytes,
      });
    this.pushStatusSoon();
  }

  private pushStatusSoon(): void {
    if (this.statusTimer !== null || this.closing !== null || this.live === null) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (this.closing !== null) return;
      this.o.emit({ op: 'ev', e: 'seeder.status', status: this.seederStatus() });
    }, STATUS_THROTTLE_MS);
  }

  // ------------------------------------------------------------------ studio

  private async probe(recheck: boolean, path?: string): Promise<FfmpegStatus> {
    const key = path ?? '';
    if (!recheck && this.ffmpegStatus?.key === key) return this.ffmpegStatus.status;
    const r = await probeFfmpeg(
      {
        runner: this.o.runtime.runner,
        pathEnv: this.o.runtime.env('PATH'),
        isExecutable: (p) => this.o.runtime.isExecutable(p),
        os: this.o.runtime.os,
      },
      path,
    );
    this.ffmpegStatus = { key, status: r.status };
    if (r.paths !== null) this.ffmpeg = r.paths;
    return r.status;
  }

  private async upload(a: StudioUploadArgs): Promise<VideoManifest> {
    const live = this.live;
    if (live === null) fail('backend-down', 'worker is not initialised');
    const net = this.requireNet();
    if (this.uploads.has(a.uploadId)) fail('invalid-argument', 'duplicate upload id');
    if (this.ffmpeg === null) await this.probe(false);
    const binaries = this.ffmpeg;
    if (binaries === null)
      throw new media.MediaError('ffmpeg-not-found', 'ffmpeg/ffprobe not found on this computer');
    this.uploads.add(a.uploadId);
    try {
      const video = await runWorkerUpload(a, {
        seeder: net.seeder,
        binaries,
        runner: this.o.runtime.runner,
        fs: this.o.runtime.mediaFs(live.tmpDir),
        sha256: sodiumSha256,
        logger: live.log,
        publish: (draft) => this.o.request('studio.publish', draft),
        putThumbnail: (bytes) => this.putThumbnail(bytes),
        progress: (p: UploadProgress) => {
          this.o.emit({ op: 'ev', e: 'upload.progress', uploadId: a.uploadId, progress: p });
        },
        ...(this.o.uploadPreset !== undefined ? { preset: this.o.uploadPreset } : {}),
      });
      for (const r of video.renditions) {
        net.seeder.setCorePolicy(r.hyper.core, video.price);
        const sc = net.seeder.blobs.coreByKey(r.hyper.core);
        if (sc !== undefined)
          net.node.join(sc.core.discoveryKey, { server: this.seeding.enabled, client: true });
      }
      return video;
    } finally {
      this.uploads.delete(a.uploadId);
    }
  }

  // ------------------------------------------------------------------ shutdown

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.statusTimer !== null) clearTimeout(this.statusTimer);
      this.statusTimer = null;
      await this.initialising?.catch(() => undefined);
      for (const sid of [...this.sessions.keys()]) this.closeSession(sid);
      await this.net?.payer.flush().catch(() => undefined);
      await this.live?.server.close();
      await this.net?.node.destroy();
      await this.fixtures?.close().catch(() => undefined);
      await this.net?.seeder.close();
      await this.testnet?.destroy().catch(() => undefined);
    })();
    return this.closing;
  }
}
