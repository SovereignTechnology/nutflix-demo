/**
 * The worker's playback HTTP server (design §1 "Pause/prefetch", §3 "Worker playback server"):
 * `hypercore-blob-server` (RFC 7233 single ranges, `Accept-Ranges`, 206/416, `bare-http1`
 * under Bare via its `imports` map, `node:http` under Node) wrapped so that it can only ever
 * serve the blobs of LIVE play sessions, through their gates:
 *
 *   - bound to `127.0.0.1` only, random port;
 *   - two secrets per link: the server's 256-bit `token` (checked by the blob server) and a
 *     128-bit per-session path token (checked here) — closing a session kills its link even
 *     while another session plays the same blob;
 *   - `resolve()` admits a request only when the path token names a live session AND the
 *     URL's core key, blob id and `type` equal that session's exactly (`type` must be the
 *     fixed `video/mp4` — the blob server copies `type=` into `Content-Type`); anything else
 *     is `null` → 404 WITHOUT the store being asked for a core, so an unknown key is never
 *     opened, let alone replicated or paid for (design §3, risk 6);
 *   - `resolve()` returns an opaque per-session handle as `key`; the blob server hands it
 *     verbatim to `store.get({ key })`, and the wrapper store answers with that session's
 *     gated adapter (no `.core` → no ByteStream bulk prefetch). The store never opens a core;
 *   - `CSP: sandbox` (the blob server's default `sandbox: true`), no CORS headers.
 *
 * The link goes to the host, which gives it to main — never to the renderer (design §1).
 */
import type { CoreKeyHex, HyperblobId } from '@sovit/core';
import type { Logger } from '@sovit/seeder';
import { fromHex } from '@sovit/seeder';
import HypercoreBlobServer from 'hypercore-blob-server';
import type {
  BlobServerRequestInfo,
  BlobServerResolved,
  BlobServerStore,
} from 'hypercore-blob-server';

import type { LoopbackLink } from '../../ipc/worker-protocol.js';
import type { GatedCoreAdapter, PlaybackGate } from './gate.js';

export const PLAYBACK_MIME = 'video/mp4' as const;
const HOST = '127.0.0.1';

interface Entry {
  readonly sid: string;
  readonly pathToken: string;
  readonly key: Uint8Array;
  readonly blob: HyperblobId;
  readonly gate: PlaybackGate;
  /** Opaque value `resolve()` returns as `key`; identity-compared by the wrapper store. */
  readonly handle: object;
}

export interface PlaybackServerOptions {
  readonly logger: Logger;
  /** `n` random bytes as hex (libsodium in production). */
  readonly randomHex: (n: number) => string;
}

export interface PlaybackServerStats {
  /** Requests `resolve()` admitted (the store was asked for an adapter). */
  readonly admitted: number;
  /** Requests refused by `resolve()` (404 without any store access). */
  readonly refused: number;
}

function sameBlob(a: BlobServerRequestInfo['blob'], b: HyperblobId): boolean {
  return (
    a !== null &&
    a.blockOffset === b.blockOffset &&
    a.blockLength === b.blockLength &&
    a.byteOffset === b.byteOffset &&
    a.byteLength === b.byteLength
  );
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a?.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < b.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export class PlaybackServer {
  private readonly log: Logger;
  private readonly randomHex: (n: number) => string;
  private readonly server: HypercoreBlobServer;
  private readonly byToken = new Map<string, Entry>();
  private readonly bySid = new Map<string, Entry>();
  private readonly byHandle = new Map<object, Entry>();
  private listening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private admitted = 0;
  private refused = 0;

  constructor(o: PlaybackServerOptions) {
    this.log = o.logger.child({ component: 'playback-server' });
    this.randomHex = o.randomHex;
    const store: BlobServerStore = {
      get: ({ key }) => {
        const e = typeof key === 'object' && key !== null ? this.byHandle.get(key) : undefined;
        // Never reached for an unknown session (resolve returned null first); defensive.
        if (e === undefined || e.gate.isClosed) throw new Error('not-found: no such session');
        return e.gate.adapter() satisfies GatedCoreAdapter;
      },
      close: () => Promise.resolve(),
    };
    this.server = new HypercoreBlobServer(store, {
      host: HOST,
      address: HOST,
      port: 0,
      anyPort: true,
      token: this.randomHex(32),
      sandbox: true,
      resolve: (key, info) => this.resolve(key, info),
    });
  }

  get port(): number {
    return this.server.port;
  }

  stats(): PlaybackServerStats {
    return { admitted: this.admitted, refused: this.refused };
  }

  async listen(): Promise<number> {
    this.listening ??= this.server.listen();
    await this.listening;
    this.log.info('playback server listening', { port: this.server.port });
    return this.server.port;
  }

  /** Admit a session's blob; returns the only link that can read it. */
  register(sid: string, core: CoreKeyHex, blob: HyperblobId, gate: PlaybackGate): LoopbackLink {
    if (this.listening === null) throw new Error('playback server is not listening');
    if (this.bySid.has(sid)) throw new Error('invalid-argument: session already registered');
    const key = fromHex(core);
    const e: Entry = {
      sid,
      pathToken: this.randomHex(16),
      key,
      blob: { ...blob },
      gate,
      handle: Object.freeze({}),
    };
    this.byToken.set(e.pathToken, e);
    this.bySid.set(sid, e);
    this.byHandle.set(e.handle, e);
    return this.server.getLink(key, {
      blob: e.blob,
      filename: e.pathToken,
      type: PLAYBACK_MIME,
    }) as LoopbackLink;
  }

  /** Revoke a session's link (idempotent). */
  unregister(sid: string): void {
    const e = this.bySid.get(sid);
    if (e === undefined) return;
    this.bySid.delete(sid);
    this.byToken.delete(e.pathToken);
    this.byHandle.delete(e.handle);
  }

  get sessions(): number {
    return this.bySid.size;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const sid of [...this.bySid.keys()]) this.unregister(sid);
      if (this.listening !== null) await this.server.close();
    })();
    return this.closing;
  }

  private resolve(key: Uint8Array, info: BlobServerRequestInfo): BlobServerResolved {
    const e = this.admit(key, info);
    if (e === null) {
      this.refused++;
      return null;
    }
    this.admitted++;
    return { key: e.handle, encryptionKey: null };
  }

  private admit(key: Uint8Array, info: BlobServerRequestInfo): Entry | null {
    if (info.blob === null || !info.filename?.startsWith('/')) return null;
    const e = this.byToken.get(info.filename.slice(1));
    if (e === undefined || e.gate.isClosed) return null;
    if (info.type !== PLAYBACK_MIME) return null;
    if (!sameBytes(info.key ?? key, e.key)) return null;
    if (!sameBlob(info.blob, e.blob)) return null;
    return e;
  }
}
