/**
 * The host process glue (design §1 Host row, §2, §4): `HostIn` from main → re-validate →
 * dispatch → `HostOut`. Runs unchanged under Electron's `utilityProcess` (`./main.ts` binds it to
 * `process.parentPort`) and under plain Node in tests.
 *
 * Defense in depth: main already checked the sender frame and ran the guards; the host runs
 * `isHostIn` (which re-validates every call's arguments and every sub) again and answers
 * anything malformed with `invalid-argument` instead of acting on it. Every call gets exactly
 * one reply; errors travel as `WireError`s (`toWireError`), never thrown across the hop.
 */
import { join } from 'node:path';

import type { UnixSeconds } from '@sovit/core';
import { mocks, nostr } from '@sovit/core';

import { toWireError, wireError } from '../ipc/errors.js';
import { isHostIn, isMsgId, isWcId } from '../ipc/guards.js';
import type { AnyCallMsg, HostIn, HostOut, ReplyMsg } from '../ipc/protocol.js';
import { IPC_V, LIMITS } from '../ipc/protocol.js';
import { dehydrate } from '../ipc/wiremap.js';
import type { WorkerInit } from '../ipc/worker-protocol.js';
import { WORKER_V } from '../ipc/worker-protocol.js';
import { DesktopNetworkAdapter } from './adapter.js';
import { FixtureCatalog } from './catalog/fixture-catalog.js';
import type { HandlerTable } from './dispatch.js';
import { handlers } from './dispatch.js';
import type { HostFlags } from './flags.js';
import { HostArgsError } from './flags.js';
import type { IdentityProvider } from './identity.js';
import { DevViewerIdentity, NoIdentity } from './identity.js';
import { ImageService } from './images/images.js';
import type { ImageTransport } from './images/net.js';
import { httpsTransport } from './images/net.js';
import type { Logger } from './log.js';
import { SettingsStore, loadDesktopConfig } from './settings/settings.js';
import type { RestartPolicy, SpawnWorker, Timers, WorkerState } from './worker/supervisor.js';
import { WorkerSupervisor } from './worker/supervisor.js';
import { createWalletProvider } from './wallet.js';
import { TopicRegistry } from './topics.js';

export interface HostOptions {
  /** Electron's userData directory (absolute). */
  readonly userData: string;
  readonly flags: HostFlags;
  /** Delivers `HostOut` to main (`parentPort.postMessage`). */
  readonly post: (out: HostOut) => void;
  readonly log: Logger;
  /** The worker's entry script (absolute) and how to spawn it (`spawnBareSidecar`). */
  readonly workerEntry: string;
  readonly spawn: SpawnWorker;
  /** Relay port; default `SimplePoolAdapter` (or an offline `FakeRelayPool` with fixtures). */
  readonly pool?: nostr.PoolLike;
  readonly imageTransport?: ImageTransport;
  /** Signer seam; default `NoIdentity` (`DevViewerIdentity` with `--dev-mocks`). */
  readonly identity?: IdentityProvider;
  readonly timers?: Timers;
  readonly restart?: RestartPolicy;
  readonly random?: (n: number) => Uint8Array;
  readonly now?: () => UnixSeconds;
  readonly workerStartTimeoutMs?: number;
}

export class Host {
  readonly adapter: DesktopNetworkAdapter;
  readonly worker: WorkerSupervisor;
  readonly topics: TopicRegistry;
  private readonly images: ImageService;
  /** Posts to main (dropped once stopped; a throwing transport is logged, never rethrown). */
  readonly post: (out: HostOut) => void;
  private readonly log: Logger;
  private readonly table: HandlerTable;
  private readonly inflight = new Map<number, number>();
  private stopped = false;

  constructor(parts: {
    readonly adapter: DesktopNetworkAdapter;
    readonly worker: WorkerSupervisor;
    readonly images: ImageService;
    readonly post: (out: HostOut) => void;
    readonly log: Logger;
  }) {
    this.adapter = parts.adapter;
    this.worker = parts.worker;
    this.images = parts.images;
    this.post = (out) => {
      if (this.stopped) return;
      try {
        parts.post(out);
      } catch {
        this.log.error('could not post to main');
      }
    };
    this.log = parts.log;
    this.table = handlers(this.adapter);
    this.topics = new TopicRegistry(this.adapter, this.post, this.log);
  }

  /** One message from main. Never throws. */
  handle(raw: unknown): void {
    if (this.stopped) return;
    if (!isHostIn(raw)) {
      this.refuse(raw);
      return;
    }
    const msg: HostIn = raw;
    switch (msg.kind) {
      case 'call':
        void this.call(msg.wc, msg.msg, msg.file);
        return;
      case 'sub':
        this.sub(msg.wc, msg.msg);
        return;
      case 'wc-gone':
        void this.wcGone(msg.wc);
        return;
      case 'image':
        void this.serveImage(msg.req, msg.id);
        return;
    }
  }

  stop(): void {
    this.worker.stop();
    this.adapter.onWorkerDown();
    this.stopped = true;
  }

  // ---- calls -----------------------------------------------------------------------------

  private async call(
    wc: number,
    msg: AnyCallMsg,
    file: { readonly path: string; readonly name: string; readonly size: number } | undefined,
  ): Promise<void> {
    const reply = (r: ReplyMsg): void => {
      this.post({ kind: 'reply', wc, msg: r });
    };
    const n = this.inflight.get(wc) ?? 0;
    if (n >= LIMITS.inflightPerWc) {
      reply({
        v: IPC_V,
        id: msg.id,
        ok: false,
        error: wireError('rate-limited', 'too many calls'),
      });
      return;
    }
    if (file !== undefined && msg.method !== 'studio.upload') {
      reply({
        v: IPC_V,
        id: msg.id,
        ok: false,
        error: wireError('invalid-argument', 'a file may only accompany studio.upload'),
      });
      return;
    }
    this.inflight.set(wc, n + 1);
    try {
      const handler = this.table[msg.method] as (
        ctx: { wc: number; file?: typeof file },
        args: unknown,
      ) => Promise<unknown>;
      const result = await handler(file === undefined ? { wc } : { wc, file }, msg.args);
      reply({ v: IPC_V, id: msg.id, ok: true, result: dehydrate(result) });
    } catch (e) {
      reply({ v: IPC_V, id: msg.id, ok: false, error: toWireError(e) });
    } finally {
      const left = (this.inflight.get(wc) ?? 1) - 1;
      if (left <= 0) this.inflight.delete(wc);
      else this.inflight.set(wc, left);
    }
  }

  // ---- subscriptions ---------------------------------------------------------------------

  private sub(wc: number, msg: Extract<HostIn, { kind: 'sub' }>['msg']): void {
    const ack = (r: ReplyMsg): void => {
      this.post({ kind: 'sub-reply', wc, msg: r });
    };
    try {
      if (msg.op === 'sub') this.topics.sub(wc, msg.subId, msg.topic);
      else this.topics.unsub(wc, msg.subId);
      ack({ v: IPC_V, id: msg.subId, ok: true, result: undefined });
    } catch (e) {
      ack({ v: IPC_V, id: msg.subId, ok: false, error: toWireError(e) });
    }
  }

  private async wcGone(wc: number): Promise<void> {
    this.topics.dropWc(wc);
    this.inflight.delete(wc);
    await this.adapter.sessions.closeOwner(wc);
  }

  private async serveImage(req: number, id: string): Promise<void> {
    const img = await this.images.serve(id).catch(() => null);
    this.post({ kind: 'image', req, bytes: img?.bytes ?? null, type: img?.type ?? null });
  }

  /** A message that failed `isHostIn`: answer it if it can be answered, else just log it. */
  private refuse(raw: unknown): void {
    this.log.warn('refused a malformed message from main');
    if (typeof raw !== 'object' || raw === null) return;
    const r = raw as { kind?: unknown; wc?: unknown; msg?: unknown; req?: unknown };
    const inner = (typeof r.msg === 'object' && r.msg !== null ? r.msg : {}) as {
      id?: unknown;
      subId?: unknown;
    };
    const error = wireError('invalid-argument', 'malformed message');
    if (r.kind === 'call' && isWcId(r.wc) && isMsgId(inner.id))
      this.post({ kind: 'reply', wc: r.wc, msg: { v: IPC_V, id: inner.id, ok: false, error } });
    else if (r.kind === 'sub' && isWcId(r.wc) && isMsgId(inner.subId))
      this.post({
        kind: 'sub-reply',
        wc: r.wc,
        msg: { v: IPC_V, id: inner.subId, ok: false, error },
      });
    else if (r.kind === 'image' && isMsgId(r.req))
      this.post({ kind: 'image', req: r.req, bytes: null, type: null });
  }
}

/**
 * Builds and starts the host: settings + desktop config from userData, the relay pool, the
 * wallet provider, images, the adapter, and the supervised worker (spawned immediately).
 */
export async function createHost(o: HostOptions): Promise<Host> {
  const log = o.log;
  const flags = o.flags;
  // The dev fences hold for programmatic callers too, not only for parseHostArgs (design §5a, D1).
  if (flags.devFixtures && !flags.devMocks)
    throw new HostArgsError('--dev-fixtures is refused without --dev-mocks');
  if (flags.devBootstrap !== undefined && !flags.devMocks)
    throw new HostArgsError('--dev-bootstrap is refused without --dev-mocks');
  if (flags.devMocks)
    log.warn('DEV MOCKS ON: fake sats, fixture viewer identity (never in production)');
  const settings = new SettingsStore(o.userData, log);
  await settings.load();
  const desktop = await loadDesktopConfig(o.userData, log.child('desktop'));
  const storage = join(o.userData, 'worker');
  const fixtures = flags.devFixtures
    ? new FixtureCatalog(log, o.timers === undefined ? {} : { timers: o.timers })
    : undefined;
  // --dev-fixtures runs the relay layer OFFLINE (in-memory), so a dev/e2e run never touches the
  // public network; FakeRelayPool is L1's offline pool.
  const pool =
    o.pool ?? (flags.devFixtures ? new nostr.FakeRelayPool() : new nostr.SimplePoolAdapter());
  const identity =
    o.identity ?? (flags.devMocks ? new DevViewerIdentity(mocks.ME) : new NoIdentity());
  const images = new ImageService({
    transport: o.imageTransport ?? httpsTransport(),
    log,
    fileRoot: storage,
    ...(o.random === undefined ? {} : { random: o.random }),
  });

  // The supervisor and the adapter refer to each other; the adapter is bound once built.
  const late: { adapter?: DesktopNetworkAdapter; post?: (out: HostOut) => void } = {};
  const worker = new WorkerSupervisor({
    spawn: o.spawn,
    entry: o.workerEntry,
    log,
    init: (): WorkerInit => {
      const s = settings.get();
      return {
        v: WORKER_V,
        storage,
        seeding: s.seeding,
        prefetchSeconds: s.prefetchSeconds,
        ...(desktop.ffmpeg === undefined ? {} : { ffmpeg: desktop.ffmpeg }),
        ...(flags.devMocks || flags.devFixtures
          ? {
              dev: {
                mocks: flags.devMocks,
                fixtures: flags.devFixtures,
                ...(flags.devBootstrap === undefined ? {} : { bootstrap: flags.devBootstrap }),
              },
            }
          : {}),
      };
    },
    onEvent: (ev) => late.adapter?.onWorkerEvent(ev),
    onState: (s: WorkerState) => {
      log.info('media worker state', { state: s });
      if (s === 'down' || s === 'failed' || s === 'stopped') late.adapter?.onWorkerDown();
      // `down` restarts (and re-announces); `failed`/`stopped` never will: stop the catalogue
      // waiting for fixtures that are not coming.
      if (s === 'failed' || s === 'stopped') fixtures?.workerGone();
    },
    handlers: {
      'studio.publish': (draft) => {
        if (late.adapter === undefined) return Promise.reject(new Error('host not ready'));
        return late.adapter.publishUpload(draft);
      },
    },
    ...(o.timers === undefined ? {} : { timers: o.timers }),
    ...(o.restart === undefined ? {} : { restart: o.restart }),
    ...(o.workerStartTimeoutMs === undefined ? {} : { startTimeoutMs: o.workerStartTimeoutMs }),
  });

  const adapter = new DesktopNetworkAdapter({
    settings,
    desktop,
    pool,
    identity,
    wallet: createWalletProvider(flags.devMocks),
    images,
    worker: (m, a) => worker.request(m, a),
    mediaLink: (token, url) => {
      late.post?.({ kind: 'media-link', token, url });
    },
    log,
    ...(fixtures === undefined ? {} : { fixtures }),
    ...(o.random === undefined ? {} : { random: o.random }),
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  const host = new Host({ adapter, worker, images, post: o.post, log });
  late.adapter = adapter;
  late.post = host.post;
  worker.start();
  return host;
}
