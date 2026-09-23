/**
 * WS bridge (build-plan §5.1): one WebSocket = one Hypercore replication stream + `pay/1`.
 *
 * On upgrade the socket is wrapped as a streamx Duplex (`ws-duplex.ts`) and piped into the
 * raw side of `seeder.replicate(false)` — the browser is the Noise initiator, exactly as
 * in spike S-B. From there the seeder does what it does for a hyperswarm connection: the
 * session is admitted after the Noise handshake (ban list → rate limits), every seeded
 * core's synchronous `upload` gate accounts blocks against the peer, and a non-payer is
 * cut at `windowBlocks + 1` inside the `upload` handler (S-A). The `pay/1` protocol is
 * attached by the `Gateway` on `session-open`, like any other session.
 *
 * Hardening (SECURITY.md T11), all config-driven (`ws` block):
 *   - connection cap counted from the upgrade, i.e. BEFORE the Noise handshake — the
 *     seeder's stream cap only sees admitted sessions;
 *   - Noise handshake deadline: a socket that has not completed the handshake in time is
 *     dropped (a pre-handshake socket costs the seeder nothing but a file descriptor);
 *   - ping/pong liveness: a peer that misses a pong is terminated;
 *   - `maxPayload` on frames; `perMessageDeflate` off (CRIME-class + CPU);
 *   - after its replication stream ends (a cut, a handshake timeout, a remote Noise close) a
 *     socket stays TRACKED — counted against `maxConnections`, terminated by `close()` —
 *     until the WebSocket's own `close`. Destroying the duplex starts the closing handshake
 *     (`WsDuplex._predestroy`, even mid-write); a peer that has not completed it within
 *     `WS_CLOSE_GRACE_MS` (it never reads, or never answers the close frame) is terminated.
 *     Before this (docs/lanes/L3-flake.md F1/F2) the socket left the set at the stream's end,
 *     uncounted and unpinged, and could stay open for 30 s — or indefinitely, if the peer had
 *     stopped reading mid-write.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex as NodeDuplex } from 'node:stream';

import type { Logger, Seeder } from '@sovit/seeder';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import type { WsLimits } from '../config.js';
import { WsDuplex } from './ws-duplex.js';

/**
 * How long a WebSocket may take to finish its closing handshake once its replication stream has
 * ended, before it is terminated. Honest peers answer in one round trip; this only bounds a
 * peer that never reads or never answers.
 */
export const WS_CLOSE_GRACE_MS = 5_000;

export interface WsBridgeOptions {
  readonly seeder: Seeder;
  readonly limits: WsLimits;
  readonly logger: Logger;
  /** Override `WS_CLOSE_GRACE_MS` (tests). */
  readonly closeGraceMs?: number;
}

export type UpgradeRefusal = 'wrong-path' | 'connection-cap';

export class WsBridge {
  private readonly wss: WebSocketServer;
  private readonly seeder: Seeder;
  private readonly limits: WsLimits;
  private readonly log: Logger;
  private readonly closeGraceMs: number;
  private readonly sockets = new Set<WebSocket>();
  private closed = false;
  private readonly counters = {
    accepted: 0,
    refused: 0,
    handshakeTimeouts: 0,
    pingTimeouts: 0,
    /** Sockets terminated because they had not closed `closeGraceMs` after their stream ended. */
    graceTerminations: 0,
  };

  constructor(o: WsBridgeOptions) {
    this.seeder = o.seeder;
    this.limits = o.limits;
    this.closeGraceMs = o.closeGraceMs ?? WS_CLOSE_GRACE_MS;
    this.log = o.logger.child({ component: 'ws-bridge' });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: o.limits.maxFrameBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
  }

  get connections(): number {
    return this.sockets.size;
  }

  stats(): Readonly<typeof this.counters> {
    return { ...this.counters };
  }

  /**
   * Handle an HTTP `upgrade`. Returns the refusal reason when the socket was NOT taken
   * (the response has been written and the socket destroyed), or `null` on success.
   */
  handleUpgrade(req: IncomingMessage, socket: NodeDuplex, head: Buffer): UpgradeRefusal | null {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== this.limits.path) {
      this.refuse(socket, 404, 'Not Found');
      return 'wrong-path';
    }
    if (this.closed || this.sockets.size >= this.limits.maxConnections) {
      this.counters.refused++;
      this.refuse(socket, 503, 'Service Unavailable');
      return 'connection-cap';
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws);
    });
    return null;
  }

  private refuse(socket: NodeDuplex, status: number, text: string): void {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      () => {
        socket.destroy();
      },
    );
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    this.counters.accepted++;
    const duplex = new WsDuplex(ws);
    const raw = this.seeder.replicate(false);
    const noise = raw.noiseStream;

    raw.on('error', () => undefined);
    duplex.on('error', () => undefined);
    raw.pipe(duplex).pipe(raw);

    // Noise handshake deadline.
    const handshakeTimer = setTimeout(() => {
      if (noise.remotePublicKey === null) {
        this.counters.handshakeTimeouts++;
        this.log.info('ws: noise handshake timeout — dropping');
        raw.destroy(new Error('handshake timeout'));
      }
    }, this.limits.handshakeTimeoutMs);

    // Liveness: ping; a missed pong terminates.
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const pinger = setInterval(() => {
      if (!alive) {
        this.counters.pingTimeouts++;
        this.log.info('ws: pong missed — terminating');
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, this.limits.pingIntervalMs);

    // The stream ending is NOT the socket closing: the socket stays in `sockets` until its own
    // `close`, and gets `closeGraceMs` to finish the closing handshake the duplex starts.
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const stopTimers = (): void => {
      clearTimeout(handshakeTimer);
      clearInterval(pinger);
    };
    ws.once('close', () => {
      stopTimers();
      if (graceTimer !== null) clearTimeout(graceTimer);
      this.sockets.delete(ws);
    });
    noise.once('close', () => {
      stopTimers();
      if (!duplex.destroyed) duplex.destroy();
      if (ws.readyState === ws.CLOSED) return;
      graceTimer = setTimeout(() => {
        this.counters.graceTerminations++;
        this.log.info('ws: closing handshake not completed within grace — terminating', {
          graceMs: this.closeGraceMs,
        });
        ws.terminate();
      }, this.closeGraceMs);
    });
    this.log.debug('ws: connection accepted', { connections: this.sockets.size });
  }

  /** Drop every socket. Sessions close through the seeder as their streams die. */
  close(): Promise<void> {
    this.closed = true;
    for (const ws of this.sockets) ws.terminate();
    return new Promise((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
  }
}
