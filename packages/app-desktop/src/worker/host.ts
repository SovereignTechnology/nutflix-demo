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
  UploadProgress,
  VideoManifest,
} from '@sovit/core';
import { media } from '@sovit/core';
import type { LogLevel, Logger } from '@sovit/seeder';
import { Seeder, fromHex } from '@sovit/seeder';

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
import type { DevTestnet, FixtureNet } from './dev/fixtures-net.js';
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
    const tmpDir = fs.join(a.storage, 'tmp');
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
    } else {
      providers = (this.o.providers ?? getWorkerProviders)(ctx);
    }
    if (providers === undefined) {
      log.warn(MISSING_PROVIDERS_REASON);
      return;
    }

    let bootstrap: readonly BootstrapNode[] | null = dev?.bootstrap ?? null;
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
      },
      { engine: providers.seederEngine, fs, crypto: sodiumCrypto, logger: log },
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
    log.info('worker initialised', { seeding: a.seeding.enabled, port: server.port });

    if (dev?.fixtures === true && bootstrap !== null) void this.startFixtures(bootstrap);
  }

  private async startFixtures(bootstrap: readonly BootstrapNode[]): Promise<void> {
    const live = this.live;
    if (live === null) return;
    const log = live.log;
    try {
      const { generateDevClip, startFixtureNet, syntheticBytes } =
        await import('./dev/fixtures-net.js');
      const hub = this.hub;
      if (hub === null) throw new Error('internal: fixtures without the dev pay hub');
      const fs = this.o.runtime.seederFs;
      const dir = fs.join(live.storage, 'dev-fixtures', randomHex(8));
      await fs.mkdir(dir, { recursive: true });
      let bytes: Uint8Array | null = null;
      if (this.ffmpeg === null) await this.probe(false);
      const paths = this.ffmpeg;
      if (paths !== null) {
        const clip = fs.join(dir, 'testsrc.mp4');
        if (await generateDevClip(this.o.runtime.runner, paths.ffmpeg, clip))
          bytes = await fs.readFile(clip);
      }
      if (bytes === null) {
        log.warn('DEV FIXTURES: no ffmpeg — serving synthetic, unplayable bytes');
        bytes = syntheticBytes(8 * 65536);
      }
      this.fixtures = await startFixtureNet({
        baseDir: dir,
        fs,
        crypto: sodiumCrypto,
        hub,
        bootstrap,
        logger: log,
        fixtures: [{ title: 'Dev fixture: test pattern (6 s)', bytes, durationSec: 6 }],
        now: this.now,
      });
      this.o.emit({ op: 'ev', e: 'dev.fixtures', videos: this.fixtures.videos });
    } catch (err) {
      log.error('dev fixtures failed to start', { error: err });
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

  private configureSeeding(a: WorkerInit['seeding']): void {
    const prevCap = this.seeding.diskCapBytes;
    this.seeding = a;
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
