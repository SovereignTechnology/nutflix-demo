/**
 * `image(url, sha256?)` (design §3 images row, T16). The renderer has no network
 * (`connect-src 'none'`) and never sees a remote URL: the host fetches the image under the
 * rules below, keeps the bytes, and hands back `nf-media://img/<id>`; main's `nf-media:`
 * handler then asks the host for the bytes (`HostIn` `image` → `HostOut` `image`).
 *
 * Rules: `https:` only; no user-info; loopback/private/link-local literals refused, and the
 * DNS answer is checked too (`./net.ts`); at most 3 redirects, each re-validated; body capped
 * at 5 MiB (declared length checked first, then counted); `Content-Type` must be `image/*` AND
 * the bytes must sniff as JPEG, PNG or WebP (SVG and friends are refused — the sniffed type is
 * what main serves); `sha256` enforced when given. No cookies, no credentials, no referrer.
 *
 * Studio's thumbnail candidates are worker files: `registerFile` maps a path (which must live
 * under the worker's storage directory) to an id; it is read, capped and sniffed when served.
 */
import { createHash, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

import type { Sha256Hex } from '@sovit/core';

import type { ImageMime, NfMediaImgUrl } from '../../ipc/protocol.js';
import { LIMITS } from '../../ipc/protocol.js';
import { fail } from '../errors.js';
import type { Logger } from '../log.js';
import type { ImageTransport } from './net.js';
import { RefusedError, checkImageUrl } from './net.js';

export const MAX_IMAGE_BYTES = LIMITS.maxThumbnailBytes;
export const MAX_REDIRECTS = 3;
const NF_IMG_PREFIX = 'nf-media://img/';

export interface ImageBytes {
  readonly bytes: Uint8Array;
  readonly type: ImageMime;
}

/** The image type the bytes actually are (magic numbers), or `null`. */
export function sniffImage(b: Uint8Array): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return 'image/png';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && // R
    b[1] === 0x49 && // I
    b[2] === 0x46 && // F
    b[3] === 0x46 && // F
    b[8] === 0x57 && // W
    b[9] === 0x45 && // E
    b[10] === 0x42 && // B
    b[11] === 0x50 // P
  )
    return 'image/webp';
  return null;
}

function sha256Hex(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

type Entry =
  | { readonly kind: 'bytes'; readonly img: ImageBytes }
  | { readonly kind: 'file'; readonly path: string };

export interface ImageServiceOptions {
  readonly transport: ImageTransport;
  readonly log: Logger;
  /** Directory under which `registerFile` paths must live (the worker's storage). */
  readonly fileRoot?: string;
  /** Bytes of fetched images kept for serving; least recently used are dropped. */
  readonly cacheBytes?: number;
  readonly random?: (n: number) => Uint8Array;
}

export class ImageService {
  private readonly transport: ImageTransport;
  private readonly log: Logger;
  private readonly fileRoot: string | undefined;
  private readonly cacheBytes: number;
  private readonly random: (n: number) => Uint8Array;
  /** id → entry, in least-recently-used order (Map iteration order). */
  private readonly entries = new Map<string, Entry>();
  /** `url|sha` → id, so a repeated `image()` call does not refetch. */
  private readonly byKey = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<NfMediaImgUrl>>();
  private cached = 0;

  constructor(opts: ImageServiceOptions) {
    this.transport = opts.transport;
    this.log = opts.log.child('images');
    this.fileRoot = opts.fileRoot === undefined ? undefined : resolvePath(opts.fileRoot);
    this.cacheBytes = opts.cacheBytes ?? 64 * 1024 * 1024;
    this.random = opts.random ?? ((n) => randomBytes(n));
  }

  /** `NetworkAdapter.image`: fetch + check, or pass back an `nf-media://img/` id we issued. */
  async image(url: string, sha256?: Sha256Hex): Promise<NfMediaImgUrl> {
    if (url.startsWith(NF_IMG_PREFIX)) {
      const id = url.slice(NF_IMG_PREFIX.length);
      if (!this.entries.has(id)) fail('not-found', 'unknown image id');
      if (sha256 !== undefined) {
        const img = await this.serve(id);
        if (img === null) fail('not-found', 'image is no longer available');
        if (sha256Hex(img.bytes) !== sha256) fail('hash-mismatch', 'image hash mismatch');
      }
      return url as NfMediaImgUrl;
    }
    const key = `${url}|${sha256 ?? ''}`;
    const known = this.byKey.get(key);
    if (known !== undefined && this.entries.has(known)) {
      this.touch(known);
      return `${NF_IMG_PREFIX}${known}`;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.fetchAndStore(url, sha256, key).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /** Maps a worker file (thumbnail candidate) to an `nf-media://img/` URL. */
  registerFile(path: string): NfMediaImgUrl {
    if (!isAbsolute(path)) fail('forbidden', 'image file path must be absolute');
    const abs = resolvePath(path);
    if (this.fileRoot === undefined) fail('forbidden', 'no image file root configured');
    const rel = relative(this.fileRoot, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
      fail('forbidden', 'image file is outside the worker storage');
    const id = this.newId();
    this.entries.set(id, { kind: 'file', path: abs });
    return `${NF_IMG_PREFIX}${id}`;
  }

  /** Bytes for main's `nf-media://img/<id>` handler, or `null` (unknown, evicted, unreadable). */
  async serve(id: string): Promise<ImageBytes | null> {
    const e = this.entries.get(id);
    if (e === undefined) return null;
    this.touch(id);
    if (e.kind === 'bytes') return e.img;
    try {
      return await readImageFile(e.path);
    } catch {
      this.log.warn('thumbnail file could not be served');
      return null;
    }
  }

  private async fetchAndStore(
    url: string,
    sha256: Sha256Hex | undefined,
    key: string,
  ): Promise<NfMediaImgUrl> {
    const img = await this.fetch(url);
    if (sha256 !== undefined && sha256Hex(img.bytes) !== sha256)
      fail('hash-mismatch', 'image hash mismatch');
    const id = this.newId();
    this.entries.set(id, { kind: 'bytes', img });
    this.byKey.set(key, id);
    this.cached += img.bytes.byteLength;
    this.evict();
    return `${NF_IMG_PREFIX}${id}`;
  }

  /** One image, following at most `MAX_REDIRECTS` re-validated redirects. */
  private async fetch(raw: string): Promise<ImageBytes> {
    let url = this.check(raw);
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await this.transport(url);
      } catch (e) {
        if (e instanceof RefusedError) fail('forbidden', e.message);
        const code = (e as { code?: unknown }).code;
        if (code === 'ENONPUBLIC') fail('forbidden', 'host resolves to a private address');
        fail('not-found', 'image could not be fetched');
      }
      try {
        if (res.status >= 300 && res.status < 400 && res.status !== 304) {
          if (hop >= MAX_REDIRECTS) fail('forbidden', 'too many redirects');
          if (res.location === undefined) fail('not-found', 'redirect without a location');
          let next: string;
          try {
            next = new URL(res.location, url).href;
          } catch {
            fail('forbidden', 'bad redirect location');
          }
          url = this.check(next);
          continue;
        }
        if (res.status !== 200) fail('not-found', `image request failed (${res.status})`);
        const ct = (res.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (!ct.startsWith('image/')) fail('forbidden', 'not an image');
        if (res.contentLength !== undefined && res.contentLength > MAX_IMAGE_BYTES)
          fail('forbidden', 'image larger than 5 MiB');
        const bytes = await readCapped(res.body, MAX_IMAGE_BYTES);
        const type = sniffImage(bytes);
        if (type === null) fail('forbidden', 'image is not JPEG, PNG or WebP');
        return { bytes, type };
      } finally {
        res.cancel();
      }
    }
  }

  private check(raw: string): URL {
    try {
      return checkImageUrl(raw);
    } catch (e) {
      const msg = e instanceof RefusedError ? e.message : 'bad URL';
      return fail(/https|URL|credentials/.test(msg) ? 'invalid-argument' : 'forbidden', msg);
    }
  }

  private newId(): string {
    return Buffer.from(this.random(16)).toString('hex');
  }

  private touch(id: string): void {
    const e = this.entries.get(id);
    if (e === undefined) return;
    this.entries.delete(id);
    this.entries.set(id, e);
  }

  private evict(): void {
    for (const [id, e] of this.entries) {
      if (this.cached <= this.cacheBytes) return;
      if (e.kind !== 'bytes') continue;
      this.entries.delete(id);
      this.cached -= e.img.bytes.byteLength;
      for (const [k, v] of this.byKey) if (v === id) this.byKey.delete(k);
    }
  }
}

/** Collects `body` into one buffer; refuses (and stops reading) past `max` bytes. */
async function readCapped(body: AsyncIterable<Uint8Array>, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of body) {
    n += c.byteLength;
    if (n > max) fail('forbidden', 'image larger than 5 MiB');
    chunks.push(c);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

async function readImageFile(path: string): Promise<ImageBytes | null> {
  const fh = await open(path, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES || st.size === 0) return null;
    const buf = new Uint8Array(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    const bytes = buf.subarray(0, bytesRead);
    const type = sniffImage(bytes);
    return type === null ? null : { bytes, type };
  } finally {
    await fh.close();
  }
}
