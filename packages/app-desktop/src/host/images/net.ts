/**
 * Network rules for `image()` (design §3 "images" row, T16): which URLs and addresses the host
 * may fetch, and the one real transport (Node `https`) with a DNS lookup that refuses private
 * answers — so a public-looking hostname that resolves to a loopback/LAN address is refused
 * too, not only a literal.
 */
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

/** Why a URL or address was refused. */
export class RefusedError extends Error {
  override readonly name = 'RefusedError' as const;
}

// ---- address classification ------------------------------------------------------------

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** [network, prefix] pairs of IPv4 space that is not the public internet. */
const V4_BLOCKED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT (tailnets live here)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function v4Blocked(n: number): boolean {
  for (const [net, prefix] of V4_BLOCKED) {
    const base = v4ToInt(net) ?? 0;
    const size = 2 ** (32 - prefix);
    if (n >= base && n < base + size) return true;
  }
  return false;
}

/** An IPv6 literal (no brackets, optional `%zone`) → its 8 groups, or `null`. */
function v6Groups(ip: string): number[] | null {
  let s = ip.split('%')[0] ?? '';
  // Trailing dotted IPv4 (e.g. ::ffff:1.2.3.4) → two hex groups.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[2] ?? '');
    if (n === null) return null;
    s = `${dotted[1] ?? ''}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function v6Blocked(g: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g6 = 0, h = 0] = g;
  const embeddedV4 = (hi: number, lo: number): boolean => v4Blocked(hi * 65536 + lo);
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) {
    if (f === 0 && g6 === 0 && (h === 0 || h === 1)) return true; // :: and ::1
    if (f === 0xffff) return embeddedV4(g6, h); // IPv4-mapped
    if (f === 0) return embeddedV4(g6, h); // IPv4-compatible (deprecated)
  }
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
    return embeddedV4(g6, h); // NAT64 well-known prefix
  if (a === 0x2002) return embeddedV4(b, c); // 6to4
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return true; // discard-only
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2001 && b < 0x200) return true; // IETF protocol assignments (Teredo, ORCHID…)
  if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true; // site-local (deprecated) fec0::/10
  if ((a & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/**
 * True for any address that is not a public unicast internet address: loopback, private,
 * CGNAT, link-local, unique-local, multicast, reserved, documentation, and IPv4 embedded in
 * IPv6 (mapped, NAT64, 6to4) when the embedded address is one of those. Unparsable → true.
 */
export function isNonPublicAddress(address: string): boolean {
  const a = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(a.split('%')[0] ?? '');
  if (family === 4) {
    const n = v4ToInt(a);
    return n === null || v4Blocked(n);
  }
  if (family === 6) {
    const g = v6Groups(a);
    return g === null || v6Blocked(g);
  }
  return true;
}

// ---- URL rules ---------------------------------------------------------------------------

/**
 * Parses and checks an image URL: `https:` only, no user-info, not an IP literal outside the
 * public internet, not `localhost`. Returns the parsed URL (WHATWG normalises `0x7f.1`,
 * `2130706433` and friends to dotted IPv4 first, so those are caught as literals).
 */
export function checkImageUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RefusedError('not a URL');
  }
  if (u.protocol !== 'https:') throw new RefusedError('only https: images are fetched');
  if (u.username !== '' || u.password !== '') throw new RefusedError('credentials in URL');
  const host = u.hostname.toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost'))
    throw new RefusedError('loopback host');
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0 && isNonPublicAddress(bare))
    throw new RefusedError('private or loopback address');
  return u;
}

// ---- the real transport ------------------------------------------------------------------

export interface ImageResponse {
  readonly status: number;
  /** `Location` header (redirects), raw. */
  readonly location: string | undefined;
  /** `Content-Type` header, raw. */
  readonly contentType: string | undefined;
  /** `Content-Length` header when present and numeric. */
  readonly contentLength: number | undefined;
  readonly body: AsyncIterable<Uint8Array>;
  /** Stops the transfer (called on every early exit). */
  cancel(): void;
}

/** One GET, no redirects followed, no cookies, no credentials. */
export type ImageTransport = (url: URL) => Promise<ImageResponse>;

type LookupFn = (
  hostname: string,
  options: LookupOptions & { all: true },
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` for `https.request` that resolves every address and refuses the connection if
 * ANY answer is non-public (a mixed answer is a rebinding attempt as far as we care).
 */
export function safeLookup(resolve: LookupFn = dnsLookup) {
  return (
    hostname: string,
    options: LookupOptions,
    cb: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        cb(err, '', 0);
        return;
      }
      const list = addresses.filter((a) => a.family === 4 || a.family === 6);
      if (list.length === 0 || list.some((a) => isNonPublicAddress(a.address))) {
        const e = new RefusedError('host resolves to a private or loopback address');
        cb(Object.assign(e, { code: 'ENONPUBLIC' }), '', 0);
        return;
      }
      if (options.all === true) cb(null, list);
      else cb(null, list[0]?.address ?? '', list[0]?.family ?? 4);
    });
  };
}

export interface HttpsTransportOptions {
  /** Whole-request budget (connect + headers + body), ms. */
  readonly timeoutMs?: number;
  /** Injected resolver (tests). */
  readonly resolve?: LookupFn;
}

/** The production transport: `node:https` with `safeLookup`, `identity` encoding, a timeout. */
export function httpsTransport(opts: HttpsTransportOptions = {}): ImageTransport {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const lookup = safeLookup(opts.resolve);
  return (url) =>
    new Promise<ImageResponse>((resolve, reject) => {
      const req = request(url, {
        method: 'GET',
        agent: false,
        lookup: lookup,
        headers: {
          accept: 'image/jpeg,image/png,image/webp',
          'accept-encoding': 'identity',
          'user-agent': 'nutflix-desktop',
        },
        timeout: timeoutMs,
      });
      const timer = setTimeout(() => {
        req.destroy(new RefusedError('image request timed out'));
      }, timeoutMs);
      req.on('timeout', () => {
        req.destroy(new RefusedError('image request timed out'));
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.on('response', (res: IncomingMessage) => {
        const len = Number(res.headers['content-length']);
        const location = res.headers.location;
        const contentType = res.headers['content-type'];
        res.on('close', () => {
          clearTimeout(timer);
        });
        resolve({
          status: res.statusCode ?? 0,
          location,
          contentType,
          contentLength: Number.isSafeInteger(len) && len >= 0 ? len : undefined,
          body: res,
          cancel: () => {
            clearTimeout(timer);
            res.destroy();
            req.destroy();
          },
        });
      });
      req.end();
    });
}
