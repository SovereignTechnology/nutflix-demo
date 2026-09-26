/**
 * Gateway — `@sovit/seeder` plus a WS bridge, Blossom HTTP and upstream paying
 * (build-plan §5). This is the façade the CLI entry (`cli/main.ts`), the L7 web-shell's
 * dev harness and the tests drive. See docs/lanes/L3.md for the public surface.
 *
 * To a browser the gateway IS a seeder: every session (WS-bridged or swarm) gets a `pay/1`
 * instance from the injected factory, the seeder's pay bridge (HELLO → bind, PAY → verify
 * → ACK) and a `HELLO` disclosing the gateway's OWN price = base policy marked up by
 * `markupPercent` (build-plan §9 Q4, resolved by ADR 0005; default 0). Toward upstream
 * seeders it is a viewer: `UpstreamPayer` pays per verified block with `range.core` set.
 *
 * One `PaymentEngine` interface, two roles (contracts/payment.ts): `seederEngine` accounts
 * downstream peers, `viewerEngine` mints upstream payments. Pass the same object for both
 * or one per side. Stage 1 wires `MockPaymentEngine('honest')`; Stage 2 drops the real
 * engine behind the same interfaces.
 */
import { mkdir } from 'node:fs/promises';
import type * as NodeHttp from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Duplex as NodeDuplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type {
  CoreKeyHex,
  HyperblobId,
  MuxLike,
  PaymentEngineSeeder,
  PaymentEngineViewer,
  PayProtocol,
  PricePolicy,
  Sats,
  Signer,
  UnixSeconds,
} from '@sovit/core';
import { DEFAULT_WINDOW_BLOCKS, payProtocol } from '@sovit/core';
import type {
  Logger,
  PeerSession,
  PeerSessionInfo,
  SeedCore,
  SeederCrypto,
  SeederEvent,
  SeederFs,
} from '@sovit/seeder';
import { RateLimiter, Seeder, fromHex, nodeAdapters, silentLogger } from '@sovit/seeder';

import type { BlossomAuth } from './auth/index.js';
import { BlossomHandler, UPLOAD_SPOOL_DIR } from './blossom/handler.js';
import type { MirrorFetch } from './blossom/handler.js';
import { OwnerIndex, ReportStore } from './blossom/store.js';
import type { GatewayConfig } from './config.js';
import { gatewayPolicy, gatewayPrice } from './config.js';
import { CreditPool } from './upstream/credit.js';
import { UpstreamPayer, manifestPolicyResolver } from './upstream/payer.js';
import type { UpstreamPolicyResolver } from './upstream/payer.js';
import { SeederCredit } from './upstream/seeder-credit.js';
import { CreditSettler } from './upstream/settle.js';
import { WsBridge } from './ws/bridge.js';

/**
 * `node:http` through CommonJS, on purpose (security review F16; deploy/systemd/MDWE-RESULTS.md
 * §6): an ESM `import … from 'node:http'` builds the builtin's facade by reading EVERY export,
 * Node 22's lazy `http.WebSocket` getter included, which loads undici and so WebAssembly — absent
 * under `--jitless`, the flag the systemd unit pairs with MemoryDenyWriteExecute. The process then
 * died one tick after start. `require` builds no facade.
 */
const { createServer } = createRequire(import.meta.url)('node:http') as typeof NodeHttp;

/**
 * The gateway's `pay/1` identity. Signing is NOT this package's — inject the node's `Signer`
 * (it must sign as `config.identity.pubkey`). v5 (ADR 0010): the HELLO is a NIP-01 event bound
 * to the connection's Noise handshake (`payProtocol.buildHello`).
 */
export interface GatewayIdentity {
  readonly signEvent: Signer['signEvent'];
}

/**
 * Builds a NOT-yet-attached `PayProtocol` for one session; the gateway calls
 * `attach(mux)` itself. Stage 2 supplies the real one (`core/src/pay-protocol/`, locked).
 */
export type PayProtocolFactory = (session: PeerSessionInfo) => PayProtocol;

export interface GatewayDeps {
  readonly seederEngine: PaymentEngineSeeder & {
    readonly config?: {
      readonly flushEveryBlocks: number;
      readonly flushEveryMs: number;
      /** v5: advertised in HELLO (`DEFAULT_WINDOW_BLOCKS` when absent). */
      readonly windowBlocks?: number;
    };
  };
  readonly viewerEngine: PaymentEngineViewer;
  /** `null` = no provider yet (Stage 1 runtime): authenticated Blossom verbs answer 503. */
  readonly auth: BlossomAuth | null;
  /** `null` = no `pay/1` implementation yet: sessions run without it and non-payers are cut. */
  readonly payProtocol: PayProtocolFactory | null;
  readonly identity: GatewayIdentity;
  readonly fs?: SeederFs;
  readonly crypto?: SeederCrypto;
  readonly logger?: Logger;
  /** Milliseconds since epoch. */
  readonly now?: () => number;
  /** `SeederDeps.accepting`: the runtime's pending-PAY cap (sessions stop being served at it). */
  readonly accepting?: () => boolean;
  readonly mirrorFetch?: MirrorFetch;
  readonly upstreamPolicy?: UpstreamPolicyResolver;
}

export interface GatewayAddress {
  readonly host: string;
  readonly port: number;
}

export interface GatewayStats {
  readonly listening: GatewayAddress | null;
  readonly seeder: ReturnType<Seeder['stats']>;
  readonly wsConnections: number;
  readonly httpActive: number;
  readonly upstream: ReturnType<UpstreamPayer['stats']>;
  readonly satsPerBlock: Sats;
}

function isMuxLike(x: unknown): x is MuxLike {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { createChannel?: unknown }).createChannel === 'function'
  );
}

export class Gateway {
  readonly config: GatewayConfig;
  readonly seeder: Seeder;
  readonly log: Logger;
  readonly payer: UpstreamPayer;
  /** Upstream blocks requested or unpaid, across every upstream seeder (F37). */
  readonly credit: CreditPool;
  /** Per-seeder credit and one-seeder-per-block routing of upstream cores (F33, issue #8). */
  readonly seeders: SeederCredit;
  private readonly settler: CreditSettler;
  readonly bridge: WsBridge;
  readonly blossom: BlossomHandler;
  readonly owners: OwnerIndex;
  readonly reports: ReportStore;
  private readonly server: Server;
  private readonly httpLimiter: RateLimiter;
  private readonly deps: GatewayDeps;
  private readonly detachers = new Map<string, () => void>();
  private readonly coreDetachers = new Map<string, () => void>();
  private readonly upstreamPolicies = new Map<CoreKeyHex, PricePolicy>();
  private readonly unsubs: (() => void)[] = [];
  private address: GatewayAddress | null = null;
  private closed = false;

  private constructor(
    config: GatewayConfig,
    deps: GatewayDeps,
    seeder: Seeder,
    loaded: { owners: OwnerIndex; reports: ReportStore },
  ) {
    this.config = config;
    this.deps = deps;
    this.seeder = seeder;
    this.log = (deps.logger ?? silentLogger).child({ component: 'gateway' });
    this.owners = loaded.owners;
    this.reports = loaded.reports;
    for (const [k, v] of Object.entries(config.upstream.policies))
      this.upstreamPolicies.set(k as CoreKeyHex, v);

    // F37: upstream blocks travel only on credit, which comes back when their PAY is ACKed.
    // Issue #8 / F33: each upstream core is routed per seeder — one seeder per block, and a
    // seeder is asked only while its own window has room; the pool (`creditBlocks` is its floor)
    // follows the sum of the upstream seeders' windows.
    this.credit = new CreditPool(config.upstream.creditBlocks);
    const payable = (core: CoreKeyHex): boolean =>
      deps.upstreamPolicy !== undefined || this.upstreamPolicies.has(core);
    this.settler = new CreditSettler({ credit: this.credit, logger: this.log, payable });
    this.seeders = new SeederCredit({
      settler: this.settler,
      pool: this.credit,
      policyFor: (core) => this.upstreamPolicies.get(core) ?? null,
      logger: this.log,
    });
    this.payer = new UpstreamPayer({
      engine: deps.viewerEngine,
      logger: this.log,
      payEveryBlocks: config.upstream.payEveryBlocks,
      credit: this.credit,
      seederBatch: (noiseHex) => this.seeders.seederBatch(noiseHex),
      ownMints: config.acceptedMints,
      policyFor: deps.upstreamPolicy ?? manifestPolicyResolver(() => this.upstreamPolicies),
      // Fix round 4: blocks whose PAY can never be built settle as unpaid (the seeder's credit
      // keeps them), instead of holding pool units for ever.
      onUnpayable: (noiseHex, range) => {
        this.settler.settleUnpaid(noiseHex, range);
      },
    });
    this.bridge = new WsBridge({ seeder, limits: config.ws, logger: this.log });
    this.blossom = new BlossomHandler({
      seeder,
      auth: deps.auth,
      config: config.blossom,
      http: config.http,
      dataDir: config.dataDir,
      owners: loaded.owners,
      reports: loaded.reports,
      logger: this.log,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.mirrorFetch ? { mirrorFetch: deps.mirrorFetch } : {}),
    });
    this.httpLimiter = new RateLimiter(
      {
        maxStreams: config.http.maxConcurrentRequests,
        maxStreamsPerKey: config.http.maxConcurrentPerClient,
        connectsPerWindow: config.http.requestsPerWindow,
        windowMs: config.http.windowMs,
      },
      deps.now ?? Date.now,
    );
    this.server = createServer({
      // Slow-loris: headers must arrive quickly; bodies are bounded by their own idle
      // timeout in http/body.ts (a multi-GB upload legitimately outlives any fixed cap).
      headersTimeout: config.http.headersTimeoutMs,
      requestTimeout: 0,
      keepAliveTimeout: config.http.socketIdleTimeoutMs,
      maxHeaderSize: 16 * 1024,
    });
    this.server.on('connection', (socket) => {
      socket.setTimeout(config.http.socketIdleTimeoutMs, () => {
        socket.destroy();
      });
    });
    this.server.on('request', (req, res) => {
      this.onRequest(req, res);
    });
    this.server.on('upgrade', (req, socket, head) => {
      this.onUpgrade(req, socket, head);
    });
    this.server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
      if (err.code === 'ECONNRESET' || !socket.writable) {
        socket.destroy();
        return;
      }
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
  }

  /** Open storage, load side tables, create the seeder. Does not listen or touch the network. */
  static async create(config: GatewayConfig, deps: GatewayDeps): Promise<Gateway> {
    const logger = deps.logger ?? silentLogger;
    const fs = deps.fs ?? nodeAdapters.fs;
    const crypto = deps.crypto ?? nodeAdapters.crypto;
    const seeder = await Seeder.create(
      {
        dataDir: config.dataDir,
        blockSize: config.blockSize,
        diskCapBytes: config.diskCapBytes,
        rateLimits: config.rateLimits,
        swarm: config.swarm,
        policy: gatewayPolicy(config),
        flushEveryBlocks: config.flushEveryBlocks,
        flushEveryMs: config.flushEveryMs,
        // Fix round 4: a core's PRICE precedes its first counted block, as on every seeder this
        // repository builds — a desktop viewer reading an image learns the core is sold before
        // our window would cut it. Our HELLO price is exact, so it only repeats it per core.
        announceCorePrices: true,
      },
      {
        engine: deps.seederEngine,
        fs,
        crypto,
        logger,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.accepting ? { accepting: deps.accepting } : {}),
      },
    );
    await seeder.openCore('blobs');
    await mkdir(path.join(config.dataDir, UPLOAD_SPOOL_DIR), { recursive: true, mode: 0o700 });
    const owners = new OwnerIndex(config.dataDir, logger);
    const reports = new ReportStore(config.dataDir, logger);
    await Promise.all([owners.load(), reports.load()]);
    if (deps.auth) {
      for (const pk of config.blossom.allowPubkeys) deps.auth.allow(pk);
      for (const pk of config.blossom.denyPubkeys) deps.auth.deny(pk);
    }
    const gw = new Gateway(config, deps, seeder, { owners, reports });
    gw.wireSeeder();
    for (const sc of seeder.blobs.openCores()) gw.watchCore(sc);
    gw.log.info('gateway created', {
      dataDir: config.dataDir,
      satsPerBlock: gw.price(),
      markupPercent: config.markupPercent,
      auth: deps.auth !== null,
      payProtocol: deps.payProtocol !== null,
    });
    return gw;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Start the seeder (swarm if configured) and bind the HTTP/WS listener. */
  async listen(): Promise<GatewayAddress> {
    if (this.closed) throw new Error('gateway is closed');
    if (this.address) return this.address;
    this.seeder.start();
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.listen.port, this.config.listen.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const a = this.server.address() as AddressInfo;
    this.address = { host: a.address, port: a.port };
    this.log.info('gateway listening', {
      host: a.address,
      port: a.port,
      wsPath: this.config.ws.path,
    });
    return this.address;
  }

  /** Graceful stop: pay what is owed upstream, drop sockets, close seeder + listener. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubs) off();
    await this.payer.flush().catch(() => undefined);
    this.payer.dispose();
    await this.bridge.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
    for (const off of this.detachers.values()) off();
    this.detachers.clear();
    try {
      await this.seeder.close();
    } finally {
      // After the connections are gone (F33 independent review): releasing a routed core while it
      // still replicates would hand it back to hypercore's own scheduler. The router parks it
      // either way (fail closed); closing first means there is nothing left to park.
      for (const off of this.coreDetachers.values()) off();
      this.coreDetachers.clear();
      this.seeders.dispose();
    }
    await Promise.all([this.owners.flushed(), this.reports.flushed()]);
    this.address = null;
    this.log.info('gateway closed');
  }

  // ------------------------------------------------------------------ pricing

  /** What `HELLO` discloses: `ceil(policy.satsPerBlock × (100 + markupPercent) / 100)`. */
  price(): Sats {
    return gatewayPrice(this.config);
  }

  /** Per-core policy used when paying upstream (creator P2PK etc. from the manifest). */
  setUpstreamPolicy(core: CoreKeyHex, policy: PricePolicy): void {
    this.upstreamPolicies.set(core, policy);
  }

  // ------------------------------------------------------------------ upstream cores

  /**
   * Replicate a remote core (read-only replica) and pay for what is downloaded from it.
   * Hex or raw key. Idempotent. READ IT THROUGH `readUpstreamBlob`: a plain `core.get()` loop is
   * not paced, outruns its PAYs, and the upstream cuts and bans the gateway (security review F37).
   */
  async openUpstreamCore(key: CoreKeyHex | string | Uint8Array): Promise<SeedCore> {
    const raw = typeof key === 'string' ? fromHex(key) : key;
    const sc = await this.seeder.blobs.openCoreByKey(raw);
    this.watchCore(sc);
    return sc;
  }

  /**
   * A blob from an upstream core, block by block, PACED to the upstream seeders' unpaid window
   * (security review F37): a block that must travel first takes a unit of `credit` (waiting when
   * none is free), and the unit comes back when the PAY covering it is acknowledged. Local blocks
   * cost nothing. Up to `lookahead` blocks are fetched ahead, but only on credit that is free NOW.
   */
  async *readUpstreamBlob(
    key: CoreKeyHex | string | Uint8Array,
    blob: HyperblobId,
    opts: { readonly lookahead?: number; readonly timeoutMs?: number } = {},
  ): AsyncGenerator<Uint8Array, void, undefined> {
    const sc = await this.openUpstreamCore(key);
    const core = sc.core;
    const hex = sc.keyHex;
    const timeout = opts.timeoutMs ?? 30_000;
    // A FIXED default, below the pool's floor: the pool follows the windows every connected
    // `pay/1` peer announces — downstream browsers included — up to 1024, and a lookahead that
    // followed it would buy up to 1023 blocks ahead of a reader that may stop (F33 independent
    // review). Each upstream seeder's own window is enforced where requests are routed.
    const lookahead = Math.max(0, opts.lookahead ?? this.config.upstream.creditBlocks - 1);
    const first = blob.blockOffset;
    const last = blob.blockOffset + blob.blockLength - 1;
    /** `held`: a unit was taken for this block already (lookahead's `tryAcquire`). */
    const fetchBlock = async (i: number, held: boolean): Promise<Uint8Array> => {
      if (await core.has(i)) {
        if (held) this.credit.settle(hex, i);
        const local = await core.get(i);
        if (local === null) throw new Error(`upstream block ${String(i)} vanished`);
        return local;
      }
      if (!held) await this.credit.acquire(hex, i).promise;
      try {
        const b = await core.get(i, { wait: true, timeout });
        if (b === null) throw new Error(`upstream block ${String(i)} did not arrive`);
        return b;
      } catch (e) {
        this.credit.settle(hex, i);
        throw e;
      } finally {
        // Owed → settles on its ACK. Not owed (a peer without pay/1, or it was local after all):
        // nothing will ever settle it, so now.
        if (!this.settler.owes(hex, i)) this.credit.settle(hex, i);
      }
    };
    const ahead = new Map<number, Promise<Uint8Array>>();
    for (let i = first; i <= last; i++) {
      let p = ahead.get(i);
      ahead.delete(i);
      p ??= fetchBlock(i, false);
      for (let j = i + 1; j <= last && ahead.size < lookahead; j++) {
        if (ahead.has(j)) continue;
        if (!this.credit.tryAcquire(hex, j)) break;
        const q = fetchBlock(j, true);
        q.catch(() => undefined); // surfaced when the reader reaches it
        ahead.set(j, q);
      }
      yield await p;
    }
  }

  stats(): GatewayStats {
    return {
      listening: this.address,
      seeder: this.seeder.stats(),
      wsConnections: this.bridge.connections,
      httpActive: this.httpLimiter.activeStreams,
      upstream: this.payer.stats(),
      satsPerBlock: this.price(),
    };
  }

  // ------------------------------------------------------------------ internals

  private watchCore(sc: SeedCore): void {
    if (this.coreDetachers.has(sc.keyHex)) return;
    // Routed first: throws `RoutingUnsupported` (fail closed) if hypercore is not the pinned one.
    const offRoute = this.seeders.attachCore(sc.core);
    const offSettler = this.settler.attachCore(sc.core);
    const offPayer = this.payer.attachCore(sc.core);
    this.coreDetachers.set(sc.keyHex, () => {
      offRoute();
      offSettler();
      offPayer();
    });
  }

  private wireSeeder(): void {
    // pay/1 attaches once replication runs on a session: on a swarm connection the Protomux does not
    // exist yet at `session-open`, so hooking that event left upstream swarm peers without pay/1.
    this.unsubs.push(
      this.seeder.onSessionReady((session) => {
        this.onSessionReady(session);
      }),
    );
    this.unsubs.push(
      this.seeder.on((e: SeederEvent) => {
        switch (e.type) {
          case 'session-open':
            break;
          case 'session-close': {
            const off = this.detachers.get(e.session.noiseKeyHex);
            if (off) {
              this.detachers.delete(e.session.noiseKeyHex);
              off();
            }
            break;
          }
          case 'session-cut':
            this.log.info('session cut', { noiseKey: e.session.noiseKeyHex, reason: e.reason });
            break;
          case 'blob-removed':
            this.owners.remove(e.sha256 as Parameters<OwnerIndex['remove']>[0]);
            break;
          case 'session-refused':
          case 'blob-added':
          case 'flush':
          case 'double-spend':
            break;
        }
      }),
    );
  }

  private onSessionReady(session: PeerSession): void {
    const info = session.info();
    if (this.deps.payProtocol === null) {
      this.log.warn('session without pay/1 (no protocol factory wired)', {
        noiseKey: info.noiseKeyHex,
      });
      return;
    }
    const mux: unknown = session.stream.noiseStream.userData;
    if (!isMuxLike(mux)) {
      this.log.error('session stream carries no protomux — cannot attach pay/1', {
        noiseKey: info.noiseKeyHex,
      });
      return;
    }
    const protocol = this.deps.payProtocol(info);
    protocol.attach(mux);
    const detachBridge = this.seeder.attachPayProtocol(session, protocol);
    // Upstream: the payer's PAYs go through the settler, which gives credit back on their ACKs.
    const settled = this.settler.attachPeer(info.noiseKeyHex, protocol);
    const detachCredit = this.seeders.attachPeer(info.noiseKeyHex, protocol);
    const detachPayer = this.payer.attachPeer(info.noiseKeyHex, settled.protocol);
    this.detachers.set(info.noiseKeyHex, () => {
      detachBridge();
      detachPayer();
      detachCredit();
      settled.detach();
    });
    void this.sendHello(session.noiseKeyHex, protocol, mux);
  }

  /**
   * HELLO: the gateway's own price (base marked up by %), its mints, split and P2PK target,
   * signed as a NIP-01 event bound to THIS connection's Noise handshake (v5).
   */
  private async sendHello(noiseKeyHex: string, protocol: PayProtocol, mux: unknown): Promise<void> {
    const binding = payProtocol.bindingFromMux(mux);
    if (binding === null) {
      this.log.error('no Noise handshake on this session — cannot bind a HELLO', {
        noiseKey: noiseKeyHex,
      });
      return;
    }
    const policy = gatewayPolicy(this.config);
    let hello: Awaited<ReturnType<typeof payProtocol.buildHello>>;
    try {
      hello = await payProtocol.buildHello(
        this.deps.identity,
        binding,
        {
          acceptedMints: this.config.acceptedMints,
          satsPerBlock: policy.satsPerBlock,
          split: policy.split,
          p2pk: this.config.identity.p2pk,
          windowBlocks: this.deps.seederEngine.config?.windowBlocks ?? DEFAULT_WINDOW_BLOCKS,
        },
        () => Math.floor((this.deps.now ?? Date.now)() / 1000) as UnixSeconds,
      );
    } catch (err) {
      this.log.error('HELLO signing failed', { noiseKey: noiseKeyHex, error: err });
      return;
    }
    if (hello.pubkey !== this.config.identity.pubkey)
      this.log.warn('the signer is not config.identity.pubkey — HELLO names the signer', {
        noiseKey: noiseKeyHex,
      });
    if (protocol.state === 'closed') return;
    protocol.sendHello(hello);
    this.log.debug('HELLO sent', { noiseKey: noiseKeyHex, satsPerBlock: policy.satsPerBlock });
  }

  private clientKey(req: IncomingMessage): string {
    if (this.config.http.trustProxy) {
      // The proxy APPENDS the address it saw: the last entry is the proxy's, the earlier ones the
      // client's own claims (F14). Several headers are joined in order.
      const xff = req.headers['x-forwarded-for'];
      const joined = Array.isArray(xff) ? xff.join(',') : xff;
      const last = joined?.split(',').pop()?.trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const admitted = this.httpLimiter.admit(this.clientKey(req));
    if (!admitted.ok) {
      res.statusCode = 429;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Retry-After', String(Math.ceil(this.config.http.windowMs / 1000)));
      res.setHeader('X-Reason', 'rate limited');
      res.end();
      return;
    }
    res.once('close', admitted.release);
    this.blossom.handle(req, res).catch((err: unknown) => {
      this.log.error('request handler threw', { error: err });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('X-Reason', 'internal error');
        res.end();
      } else res.destroy();
    });
  }

  private onUpgrade(req: IncomingMessage, socket: NodeDuplex, head: Buffer): void {
    // The WS bridge has its own liveness (ping/pong); the plain-HTTP idle timer must go.
    (socket as NodeDuplex & { setTimeout?: (ms: number) => void }).setTimeout?.(0);
    const admitted = this.httpLimiter.admit(this.clientKey(req));
    if (!admitted.ok) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n', () => {
        socket.destroy();
      });
      return;
    }
    socket.once('close', admitted.release);
    const refused = this.bridge.handleUpgrade(req, socket, head);
    if (refused !== null) this.log.info('ws upgrade refused', { reason: refused });
  }
}
