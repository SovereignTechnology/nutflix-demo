/**
 * BlobStore — Corestore + one Hyperblobs per named core, sha256 CAS index, disk cap.
 *
 * Put flow (`putBytes` / `putStream`): hash → dedupe against the index → reserve disk cap
 * → chunk into `blockSize` blocks through `Hyperblobs.createWriteStream()` → commit index.
 * For files the hash pass streams the file once before the write pass (two reads, zero
 * risk of writing a duplicate or overshooting the cap). The second `source()` is opened
 * LAZILY, only once the write pass actually starts: on the dedupe / disk-cap early returns
 * no second read stream exists, so a caller that unlinks the file right after the result
 * cannot leave an orphaned `createReadStream` behind to raise an uncaught ENOENT (found by
 * L3, docs/lanes/L3.md).
 *
 * Lane W8b-p2p (round-8 review, LOW): opens of one core share ONE Hypercore session. Two callers
 * opening the same core at once (two thumbnails of one profile core) used to get two sessions:
 * the seeder's upload gate moved to the second, `closeCoreByKey` closed only the second, and the
 * first stayed open and replicating with no gate — served, uncounted, unannounced. Now a caller
 * joins the open in flight (by name, or by key), and an open that finds the core registered under
 * the other form meanwhile closes its own session and returns the registered one.
 *
 * Lane W8b-p2p, round 9 (F57): only a core this store has OPEN replicates to a remote that asks
 * for it — see `GatedCorestore`.
 */
import type { CoreKeyHex, HyperblobId, Sha256Hex } from '@sovit/core';
import Corestore from 'corestore';
import Hyperblobs from 'hyperblobs';
import type { BlobReadStream, BlobWriteStream } from 'hyperblobs';
import type Hypercore from 'hypercore';
import type { ProtocolMuxer, ReplicationStream, ReplicationStreamOptions } from 'hypercore';

import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';
import type { Logger } from '../log/logger.js';
import type { CasEntry, CasIndex } from '../store/cas-index.js';
import type { DiskCap } from '../store/disk-cap.js';
import { bytesEqual, toHex } from '../util/hex.js';

export const DEFAULT_CORE_NAME = 'blobs' as const;

/** The Protomux protocol Hypercore replicates on (hypercore 11.35.3 `lib/replicator.js`). */
const HYPERCORE_PROTOCOL = 'hypercore/alpha';

/**
 * Lane W8b-p2p, round 9 (F57): the Corestore every seeder replicates — the desktop worker's
 * `PeerNode`, the daemon's swarm and the gateway (WS bridge and swarm) all call `replicate` on it.
 *
 * Corestore 7.12.2's `replicate` pairs a catch-all `hypercore/alpha` handler on the connection's
 * Protomux (`ondiscoverykey` → `_attachMaybe`): when a remote opens a channel for a discovery key
 * no local core is attached for, it opens ANY core in storage under that key
 * (`storage.hasCore`, `_openCore`) and attaches that core's replicator to the connection. Such a
 * core has no Hypercore session, so no `upload` listener: `BlobStore.onCoreOpened` never ran, the
 * seeder's upload gate never sees its blocks, no `PRICE` precedes them and nothing is counted —
 * and Hypercore serves them anyway (`Peer.isActive()` checks only paused / removed / frozen, and a
 * core with a peer attached is never idle). After a restart every sold core in storage was served
 * that way, free, to any connected peer that knew its key.
 *
 * Here that catch-all is replaced on every stream, right after Corestore installs it (`pair` under
 * the same key replaces the handler, protomux 3.11.0): a remote may open only a core this store
 * has open through `BlobStore` — its session carries the gate — and gets it through Hypercore's
 * public `replicate(muxer)`. Anything else is refused: the handler attaches nothing and Protomux
 * rejects the channel. Opening that core later (a play, an upload) attaches it to every live
 * stream through Corestore's own `ondownloading` path, gated.
 *
 * A core that is already open reached through the old path was never the problem: it is the same
 * Hypercore `Core` object, and `upload` / `peer-add` are emitted to every session of it that
 * listens (`core.monitors`) — the gate's session among them.
 */
class GatedCorestore extends Corestore {
  constructor(
    storage: string,
    private readonly servedCore: (discoveryKey: Uint8Array) => Hypercore | null,
  ) {
    super(storage);
  }

  override replicate(
    isInitiator: boolean | ReplicationStream,
    opts?: ReplicationStreamOptions,
  ): ReplicationStream {
    const stream = super.replicate(isInitiator, opts);
    const mux: unknown = stream.noiseStream.userData;
    if (!isProtocolMuxer(mux)) {
      // Fail closed: without the connection's muxer the catch-all cannot be replaced.
      stream.destroy(new Error('replication stream without a protocol muxer'));
      return stream;
    }
    mux.pair({ protocol: HYPERCORE_PROTOCOL }, (discoveryKey) => {
      if (!(discoveryKey instanceof Uint8Array) || discoveryKey.byteLength !== 32) return;
      const core = this.servedCore(discoveryKey);
      if (core !== null) core.replicate(mux);
    });
    return stream;
  }
}

function isProtocolMuxer(m: unknown): m is ProtocolMuxer {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as { isProtomux?: unknown; pair?: unknown };
  return x.isProtomux === true && typeof x.pair === 'function';
}

export interface SeedCore {
  readonly name: string;
  readonly core: Hypercore;
  readonly blobs: Hyperblobs;
  readonly keyHex: CoreKeyHex;
}

export type PutError =
  | { readonly code: 'disk-cap'; readonly needed: number; readonly free: number }
  | { readonly code: 'size-mismatch'; readonly declared: number; readonly actual: number }
  | { readonly code: 'not-a-file'; readonly path: string }
  | { readonly code: 'write-failed'; readonly message: string };

export type PutResult =
  | { readonly ok: true; readonly entry: CasEntry; readonly deduplicated: boolean }
  | { readonly ok: false; readonly error: PutError };

export interface PutOptions {
  readonly core?: string;
  readonly mime?: string;
}

/** Options of one `openCore` call. */
export interface OpenCoreOptions {
  /**
   * Called once, when THIS call opened the core: after it is ready and registered, before
   * `onCoreOpened` (the seeder's upload gate, and the terms it says to peers already paired) —
   * e.g. to mark it served free first. A caller that joins an open in flight gets that open's
   * core without its own hook running.
   */
  readonly beforeOpened?: (c: SeedCore) => void;
}

export interface BlobStoreOptions {
  readonly storageDir: string;
  readonly blockSize: number;
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly index: CasIndex;
  readonly diskCap: DiskCap;
  readonly logger: Logger;
  /** Called for every core the store opens (the seeder attaches the upload gate + swarm join). */
  readonly onCoreOpened?: (c: SeedCore) => void;
  /**
   * Called when `closeCoreByKey` closes a core, before its session closes (the seeder detaches
   * that session's upload gate; a reopen gets a new session and a new gate — fix round 4).
   */
  readonly onCoreClosed?: (c: SeedCore) => void;
}

export class BlobStore {
  /** Gated (F57): a remote is served only the cores this store has open — `GatedCorestore`. */
  readonly store: Corestore;
  private readonly cores = new Map<string, SeedCore>();
  private readonly byKey = new Map<string, SeedCore>();
  /** Opens in flight, by name (`key:<hex>` for a key): concurrent callers share one (W8b-p2p). */
  private readonly opening = new Map<string, Promise<SeedCore>>();
  private readonly log: Logger;
  private closed = false;

  constructor(private readonly opts: BlobStoreOptions) {
    this.store = new GatedCorestore(opts.storageDir, (discoveryKey) =>
      this.servedCore(discoveryKey),
    );
    this.log = opts.logger.child({ component: 'blobs' });
  }

  /**
   * F57: the session of the core a remote names by `discoveryKey`, when this store has it open
   * (`openCore` / `openCoreByKey`, which hand it to `onCoreOpened` — the seeder's upload gate — in
   * the same tick they register it), else `null`: that core is not served.
   */
  private servedCore(discoveryKey: Uint8Array): Hypercore | null {
    if (this.closed) return null;
    for (const sc of this.byKey.values())
      if (!sc.core.closed && bytesEqual(sc.core.discoveryKey, discoveryKey)) return sc.core;
    return null;
  }

  get blockSize(): number {
    return this.opts.blockSize;
  }

  async ready(): Promise<void> {
    await this.store.ready();
  }

  /**
   * Open (or create) a named core and its Hyperblobs. Idempotent; concurrent calls share one open
   * (and one session). A core already open by key under that key takes the name (a core this
   * store writes to is never closed as a replica).
   */
  openCore(name: string = DEFAULT_CORE_NAME, opts: OpenCoreOptions = {}): Promise<SeedCore> {
    const existing = this.cores.get(name);
    if (existing) return Promise.resolve(existing);
    return this.shared(name, async () => {
      const core = await this.whenReady(this.store.get({ name }));
      const keyHex = toHex(core.key) as CoreKeyHex;
      const raced = this.byKey.get(keyHex);
      const sc: SeedCore =
        raced === undefined
          ? { name, core, blobs: new Hyperblobs(core, { blockSize: this.opts.blockSize }), keyHex }
          : { ...raced, name };
      if (raced !== undefined) {
        // Opened by key meanwhile: that session stays the only one, now under its name.
        await core.close().catch(() => undefined);
        this.cores.delete(raced.name);
        this.cores.set(name, sc);
        this.byKey.set(keyHex, sc);
        return sc;
      }
      this.cores.set(name, sc);
      this.byKey.set(keyHex, sc);
      this.log.info('core opened', { name, core: keyHex, length: core.length });
      opts.beforeOpened?.(sc);
      this.opts.onCoreOpened?.(sc);
      return sc;
    });
  }

  /**
   * Open a core by key (read-only replica, e.g. a gateway fetching upstream). Concurrent calls
   * share one open (and one session); a core open by name already is returned as it is.
   */
  openCoreByKey(key: Uint8Array): Promise<SeedCore> {
    const hex = toHex(key);
    const existing = this.byKey.get(hex);
    if (existing) return Promise.resolve(existing);
    return this.shared(`key:${hex}`, async () => {
      const core = await this.whenReady(this.store.get({ key }));
      const raced = this.byKey.get(hex);
      if (raced !== undefined) {
        // Opened by name meanwhile: that session stays the only one.
        await core.close().catch(() => undefined);
        return raced;
      }
      const blobs = new Hyperblobs(core, { blockSize: this.opts.blockSize });
      const sc: SeedCore = { name: `key:${hex}`, core, blobs, keyHex: hex as CoreKeyHex };
      this.cores.set(sc.name, sc);
      this.byKey.set(hex, sc);
      this.opts.onCoreOpened?.(sc);
      return sc;
    });
  }

  /** The open of `id` in flight, or `open()` started as it (lane W8b-p2p). */
  private shared(id: string, open: () => Promise<SeedCore>): Promise<SeedCore> {
    const pending = this.opening.get(id);
    if (pending !== undefined) return pending;
    const p = open().finally(() => {
      if (this.opening.get(id) === p) this.opening.delete(id);
    });
    this.opening.set(id, p);
    return p;
  }

  /** `core` once ready; a session that fails to open is closed (a retry opens a fresh one). */
  private async whenReady(core: Hypercore): Promise<Hypercore> {
    try {
      await core.ready();
    } catch (err) {
      await core.close().catch(() => undefined);
      throw err;
    }
    return core;
  }

  coreByKey(keyHex: string): SeedCore | undefined {
    return this.byKey.get(keyHex);
  }

  /**
   * ADR 0015: close a replica opened with `openCoreByKey` (a profile core read only for display),
   * so the corestore stops replicating — and serving — it. Refuses a core this store writes to.
   */
  async closeCoreByKey(keyHex: string): Promise<void> {
    const sc = this.byKey.get(keyHex);
    if (sc === undefined) return;
    if (sc.name !== `key:${keyHex}`) throw new Error('refusing to close a core opened by name');
    this.byKey.delete(keyHex);
    this.cores.delete(sc.name);
    this.opts.onCoreClosed?.(sc);
    await sc.core.close();
  }

  openCores(): readonly SeedCore[] {
    return [...this.cores.values()];
  }

  async putBytes(bytes: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
    const h = this.opts.crypto.createSha256();
    h.update(bytes);
    const sha = h.digestHex() as Sha256Hex;
    return this.writeHashed(sha, bytes.byteLength, () => [bytes], opts);
  }

  /** `source` must be re-iterable if it is a file; `size` is enforced. */
  async putStream(
    source: () => AsyncIterable<Uint8Array>,
    size: number,
    opts: PutOptions = {},
  ): Promise<PutResult> {
    const h = this.opts.crypto.createSha256();
    let seen = 0;
    for await (const chunk of source()) {
      h.update(chunk);
      seen += chunk.byteLength;
    }
    if (seen !== size)
      return { ok: false, error: { code: 'size-mismatch', declared: size, actual: seen } };
    const sha = h.digestHex() as Sha256Hex;
    return this.writeHashed(sha, size, source, opts);
  }

  async putFile(path: string, opts: PutOptions = {}): Promise<PutResult> {
    const st = await this.opts.fs.stat(path);
    if (!st?.isFile) return { ok: false, error: { code: 'not-a-file', path } };
    return this.putStream(() => this.opts.fs.readStream(path), st.size, opts);
  }

  has(sha256: string): boolean {
    return this.opts.index.has(sha256);
  }

  entry(sha256: string): CasEntry | undefined {
    return this.opts.index.get(sha256);
  }

  /** Read a whole blob by sha256 (null if unknown or not locally available). */
  async get(sha256: string, opts?: { readonly wait?: boolean }): Promise<Uint8Array | null> {
    const e = this.opts.index.get(sha256);
    if (!e) return null;
    const sc = this.byKey.get(e.coreKey);
    if (!sc) return null;
    return sc.blobs.get(e.blob, { wait: opts?.wait ?? false });
  }

  /** Range read as a stream (what the Blossom `GET /<sha256>` with `Range` needs). `end` is INCLUSIVE (Hyperblobs semantics). */
  createReadStream(
    sha256: string,
    opts?: { readonly start?: number; readonly end?: number; readonly wait?: boolean },
  ): BlobReadStream | null {
    const e = this.opts.index.get(sha256);
    if (!e) return null;
    const sc = this.byKey.get(e.coreKey);
    if (!sc) return null;
    return sc.blobs.createReadStream(e.blob, {
      wait: opts?.wait ?? false,
      ...(opts?.start !== undefined ? { start: opts.start } : {}),
      ...(opts?.end !== undefined ? { end: opts.end } : {}),
    });
  }

  /** Clear the blob's blocks locally, drop the index entry, free the cap. */
  async remove(sha256: string): Promise<boolean> {
    const e = this.opts.index.get(sha256);
    if (!e) return false;
    const sc = this.byKey.get(e.coreKey);
    if (sc) await sc.blobs.clear(e.blob);
    this.opts.index.remove(sha256);
    this.opts.diskCap.free(e.size);
    this.log.info('blob removed', { sha256: e.sha256, size: e.size });
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sc of this.cores.values()) await sc.core.close();
    this.cores.clear();
    this.byKey.clear();
    await this.store.close();
  }

  /** `open` is called at most once, and only when the write pass really starts. */
  private async writeHashed(
    sha: Sha256Hex,
    size: number,
    open: () => Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    opts: PutOptions,
  ): Promise<PutResult> {
    const dup = this.opts.index.get(sha);
    if (dup) return { ok: true, entry: dup, deduplicated: true };

    const reservation = this.opts.diskCap.reserve(size);
    if (reservation === null) {
      this.log.warn('disk cap reached — refusing blob', {
        sha256: sha,
        needed: size,
        free: this.opts.diskCap.freeBytes,
      });
      return {
        ok: false,
        error: { code: 'disk-cap', needed: size, free: this.opts.diskCap.freeBytes },
      };
    }

    try {
      const sc = await this.openCore(opts.core ?? DEFAULT_CORE_NAME);
      const id = await this.writeBlocks(sc, open());
      if (id.byteLength !== size) {
        await sc.blobs.clear(id);
        reservation.release();
        return {
          ok: false,
          error: { code: 'size-mismatch', declared: size, actual: id.byteLength },
        };
      }
      reservation.commit();
      const entry = this.opts.index.add({
        sha256: sha,
        coreKey: sc.keyHex,
        blob: id,
        size,
        ...(opts.mime !== undefined ? { mime: opts.mime } : {}),
      });
      this.log.info('blob stored', {
        sha256: sha,
        core: sc.keyHex,
        blocks: id.blockLength,
        size,
      });
      return { ok: true, entry, deduplicated: false };
    } catch (err) {
      reservation.release();
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('blob write failed', { sha256: sha, error: err });
      return { ok: false, error: { code: 'write-failed', message } };
    }
  }

  /** Chunk arbitrary input into exactly `blockSize` blocks (Hyperblobs writes 1 block per write). */
  private async writeBlocks(
    sc: SeedCore,
    source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<HyperblobId> {
    const ws: BlobWriteStream = sc.blobs.createWriteStream();
    const done = new Promise<HyperblobId>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('close', () => {
        resolve(ws.id);
      });
    });
    const blockSize = this.opts.blockSize;
    let pending: Uint8Array | null = null;

    const write = async (block: Uint8Array): Promise<void> => {
      if (!ws.write(block)) await new Promise<void>((r) => ws.once('drain', r));
    };

    try {
      for await (const chunk of source) {
        let buf: Uint8Array = chunk;
        if (pending !== null) {
          const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
          merged.set(pending, 0);
          merged.set(chunk, pending.byteLength);
          buf = merged;
          pending = null;
        }
        let off = 0;
        while (buf.byteLength - off >= blockSize) {
          await write(buf.subarray(off, off + blockSize));
          off += blockSize;
        }
        if (off < buf.byteLength) pending = buf.slice(off);
      }
      if (pending !== null) await write(pending);
      ws.end();
    } catch (err) {
      ws.destroy(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    return done;
  }
}
