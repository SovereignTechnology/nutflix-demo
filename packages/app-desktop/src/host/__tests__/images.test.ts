/**
 * `image(url, sha256?)` rules (design §3 images row, T16): https only, no credentials, 5 MiB
 * cap, image MIME only (and the bytes must BE an image), ≤ 3 re-validated redirects,
 * loopback/private/link-local literals refused — and DNS answers too — sha256 enforced.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { LookupAddress } from 'node:dns';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Sha256Hex } from '@sovit/core';

import type { IpcError } from '../../ipc/errors.js';
import { ImageService, MAX_IMAGE_BYTES, sniffImage } from '../images/images.js';
import type { ImageResponse, ImageTransport } from '../images/net.js';
import { checkImageUrl, httpsTransport, isNonPublicAddress, safeLookup } from '../images/net.js';
import { silentLogger } from '../log.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const ascii = (t: string): number[] => Array.from(Buffer.from(t, 'latin1'));
const WEBP = Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8 ')]);

/** An async iterable over `next()` results (no generator, so no lint about `await`). */
function asyncOf(next: () => Uint8Array | undefined): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const value = next();
        return Promise.resolve(
          value === undefined ? { value: undefined, done: true as const } : { value, done: false },
        );
      },
    }),
  };
}
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
);
const sha = (b: Uint8Array): Sha256Hex => createHash('sha256').update(b).digest('hex') as Sha256Hex;

interface Route {
  readonly status?: number;
  readonly location?: string;
  readonly type?: string;
  readonly length?: number;
  readonly body?: Uint8Array | (() => AsyncIterable<Uint8Array>);
}

/** A transport serving `routes` by exact URL; records every request. */
function fakeTransport(
  routes: Record<string, Route>,
): ImageTransport & { requested: string[]; cancelled: number } {
  const requested: string[] = [];
  const t = Object.assign(
    (url: URL): Promise<ImageResponse> => {
      requested.push(url.href);
      const r = routes[url.href];
      if (!r) return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      const body = r.body ?? new Uint8Array();
      return Promise.resolve({
        status: r.status ?? 200,
        location: r.location,
        contentType: r.type ?? 'image/png',
        contentLength: r.length ?? (body instanceof Uint8Array ? body.byteLength : undefined),
        body: typeof body === 'function' ? body() : asyncOf(once(body)),
        cancel: () => {
          t.cancelled++;
        },
      });
    },
    { requested, cancelled: 0 },
  );
  return t;
}

function once(b: Uint8Array): () => Uint8Array | undefined {
  let done = false;
  return () => {
    if (done) return undefined;
    done = true;
    return b;
  };
}

let seq = 0;
const service = (t: ImageTransport, fileRoot?: string): ImageService =>
  new ImageService({
    transport: t,
    log: silentLogger,
    ...(fileRoot === undefined ? {} : { fileRoot }),
    random: (n) => {
      seq++;
      return Uint8Array.from({ length: n }, (_, i) => (seq * 31 + i) & 0xff);
    },
  });

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    const err = e as IpcError;
    expect(err.message.startsWith(`${err.code}: `)).toBe(true);
    return err.code;
  }
}

describe('isNonPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.0.9',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.77.10',
    '100.100.7.8',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '::',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:c0a8:0101::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '2001:db8::1',
    'not-an-ip',
  ])('%s is not public', (a) => {
    expect(isNonPublicAddress(a)).toBe(true);
  });
  it.each([
    '1.1.1.1',
    '93.184.216.34',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700::1111',
    '::ffff:1.1.1.1',
  ])('%s is public', (a) => {
    expect(isNonPublicAddress(a)).toBe(false);
  });
});

describe('checkImageUrl', () => {
  it.each([
    'http://img.example/a.png',
    'ftp://img.example/a.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'https://user:pw@img.example/a.png',
    'https://user@img.example/a.png',
    'https://127.0.0.1/a.png',
    'https://2130706433/a.png',
    'https://0x7f.1/a.png',
    'https://[::1]/a.png',
    'https://[::ffff:127.0.0.1]/a.png',
    'https://10.0.0.5/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[fe80::1]/a.png',
    'https://localhost/a.png',
    'https://evil.localhost/a.png',
    'not a url',
  ])('refuses %s', (u) => {
    expect(() => checkImageUrl(u)).toThrow();
  });
  it('accepts a public https URL with a query', () => {
    expect(checkImageUrl('https://img.example/a.png?w=3').hostname).toBe('img.example');
    expect(checkImageUrl('https://1.1.1.1/a.png').hostname).toBe('1.1.1.1');
  });
});

describe('safeLookup (DNS answers are checked, not only literals)', () => {
  const resolver =
    (answers: LookupAddress[]) =>
    (
      _h: string,
      _o: unknown,
      cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void,
    ): void => {
      cb(null, answers);
    };
  const run = (answers: LookupAddress[], all: boolean) =>
    new Promise<{ err: Error | null; address: unknown }>((resolve) => {
      safeLookup(resolver(answers))('img.example', { all }, (err, address) => {
        resolve({ err, address });
      });
    });

  it('refuses a hostname that resolves to loopback/private — even mixed with a public one', async () => {
    for (const answers of [
      [{ address: '127.0.0.1', family: 4 }],
      [{ address: '10.0.0.8', family: 4 }],
      [{ address: '::1', family: 6 }],
      [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ],
      [],
    ]) {
      const r = await run(answers, false);
      expect(r.err, JSON.stringify(answers)).not.toBeNull();
    }
  });

  it('passes public answers through in both callback shapes', async () => {
    const pub = [{ address: '93.184.216.34', family: 4 }];
    expect((await run(pub, false)).address).toBe('93.184.216.34');
    expect((await run(pub, true)).address).toEqual(pub);
  });

  it('the real https transport never connects when DNS says private', async () => {
    const t = httpsTransport({
      timeoutMs: 2000,
      resolve: resolver([{ address: '127.0.0.1', family: 4 }]),
    });
    await expect(t(new URL('https://rebind.example/a.png'))).rejects.toMatchObject({
      code: 'ENONPUBLIC',
    });
    const s = service(t);
    expect(await code(s.image('https://rebind.example/a.png'))).toBe('forbidden');
  });
});

describe('ImageService.image', () => {
  it('fetches, sniffs, stores and hands back nf-media://img/<id>; serve returns the bytes', async () => {
    const t = fakeTransport({ 'https://img.example/a.png': { body: PNG } });
    const s = service(t);
    const url = await s.image('https://img.example/a.png', sha(PNG));
    expect(url).toMatch(/^nf-media:\/\/img\/[0-9a-f]{32}$/);
    const id = url.slice('nf-media://img/'.length);
    expect(await s.serve(id)).toEqual({ bytes: PNG, type: 'image/png' });
    // Cached: the same url+sha does not refetch.
    expect(await s.image('https://img.example/a.png', sha(PNG))).toBe(url);
    expect(t.requested).toEqual(['https://img.example/a.png']);
    expect(await s.serve('0'.repeat(32))).toBeNull();
  });

  it('serves the SNIFFED type (jpeg/webp), whatever image/* the server claims', async () => {
    const t = fakeTransport({
      'https://img.example/j': { body: JPEG, type: 'image/png' },
      'https://img.example/w': { body: WEBP, type: 'image/webp; charset=binary' },
    });
    const s = service(t);
    const j = (await s.image('https://img.example/j')).slice(15);
    const w = (await s.image('https://img.example/w')).slice(15);
    expect((await s.serve(j))?.type).toBe('image/jpeg');
    expect((await s.serve(w))?.type).toBe('image/webp');
  });

  it('sha256 mismatch → hash-mismatch, and nothing is stored', async () => {
    const s = service(fakeTransport({ 'https://img.example/a.png': { body: PNG } }));
    expect(await code(s.image('https://img.example/a.png', sha(JPEG)))).toBe('hash-mismatch');
  });

  it('refuses http:, credentials and private literals before any request', async () => {
    const t = fakeTransport({});
    const s = service(t);
    expect(await code(s.image('http://img.example/a.png'))).toBe('invalid-argument');
    expect(await code(s.image('https://u:p@img.example/a.png'))).toBe('invalid-argument');
    expect(await code(s.image('https://127.0.0.1/a.png'))).toBe('forbidden');
    expect(await code(s.image('https://[::1]/a.png'))).toBe('forbidden');
    expect(await code(s.image('https://192.168.1.1/a.png'))).toBe('forbidden');
    expect(t.requested).toEqual([]);
  });

  it('refuses non-image content types and bytes that are not JPEG/PNG/WebP (SVG)', async () => {
    const s = service(
      fakeTransport({
        'https://img.example/html': { body: PNG, type: 'text/html' },
        'https://img.example/svg': { body: SVG, type: 'image/svg+xml' },
        'https://img.example/liar': { body: SVG, type: 'image/png' },
        'https://img.example/none': { body: PNG, type: '' },
      }),
    );
    for (const p of ['html', 'svg', 'liar', 'none'])
      expect(await code(s.image(`https://img.example/${p}`)), p).toBe('forbidden');
  });

  it('caps the body at 5 MiB: declared length refused up front, streamed bytes counted', async () => {
    let yielded = 0;
    const t = fakeTransport({
      'https://img.example/declared': { body: PNG, length: MAX_IMAGE_BYTES + 1 },
      'https://img.example/streamed': {
        body: () => {
          let i = -1;
          return asyncOf(() => {
            i++;
            if (i === 0) return PNG;
            if (i > 100) return undefined;
            yielded++;
            return new Uint8Array(256 * 1024);
          });
        },
      },
    });
    const s = service(t);
    expect(await code(s.image('https://img.example/declared'))).toBe('forbidden');
    expect(await code(s.image('https://img.example/streamed'))).toBe('forbidden');
    expect(yielded).toBeLessThanOrEqual(21); // stopped just past 5 MiB, not after 25 MiB
    expect(t.cancelled).toBe(2);
  });

  it('follows ≤ 3 redirects, re-validating each hop', async () => {
    const ok = fakeTransport({
      'https://a.example/1': { status: 302, location: '/2' },
      'https://a.example/2': { status: 301, location: 'https://b.example/3' },
      'https://b.example/3': { status: 307, location: 'https://c.example/final.png' },
      'https://c.example/final.png': { body: PNG },
    });
    expect(await service(ok).image('https://a.example/1')).toMatch(/^nf-media:\/\/img\//);
    expect(ok.requested).toHaveLength(4);

    const tooMany = fakeTransport({
      'https://a.example/1': { status: 302, location: '/2' },
      'https://a.example/2': { status: 302, location: '/3' },
      'https://a.example/3': { status: 302, location: '/4' },
      'https://a.example/4': { status: 302, location: '/5' },
      'https://a.example/5': { body: PNG },
    });
    expect(await code(service(tooMany).image('https://a.example/1'))).toBe('forbidden');
    expect(tooMany.requested).toHaveLength(4);

    for (const target of [
      'http://a.example/x.png',
      'https://127.0.0.1/x.png',
      'https://[::1]/x.png',
      'https://u:p@a.example/x.png',
      'https://169.254.169.254/latest',
    ]) {
      const t = fakeTransport({ 'https://a.example/1': { status: 302, location: target } });
      const c = await code(service(t).image('https://a.example/1'));
      expect(['forbidden', 'invalid-argument'], target).toContain(c);
      expect(t.requested, target).toEqual(['https://a.example/1']);
    }
  });

  it('non-200 and network failures → not-found', async () => {
    const s = service(fakeTransport({ 'https://img.example/404': { status: 404 } }));
    expect(await code(s.image('https://img.example/404'))).toBe('not-found');
    expect(await code(s.image('https://img.example/unreachable'))).toBe('not-found');
  });

  it('passes back an nf-media://img/ id it issued (checking sha256 when given); refuses unknown ids', async () => {
    const s = service(fakeTransport({ 'https://img.example/a.png': { body: PNG } }));
    const url = await s.image('https://img.example/a.png');
    expect(await s.image(url)).toBe(url);
    expect(await s.image(url, sha(PNG))).toBe(url);
    expect(await code(s.image(url, sha(JPEG)))).toBe('hash-mismatch');
    expect(await code(s.image(`nf-media://img/${'9'.repeat(32)}`))).toBe('not-found');
  });

  it('evicts least-recently-used bytes past the cache budget', async () => {
    const big = new Uint8Array(600);
    big.set(PNG);
    const s = new ImageService({
      transport: fakeTransport({
        'https://i.example/1': { body: big },
        'https://i.example/2': { body: big },
      }),
      log: silentLogger,
      cacheBytes: 1000,
    });
    const one = (await s.image('https://i.example/1')).slice(15);
    const two = (await s.image('https://i.example/2')).slice(15);
    expect(await s.serve(one)).toBeNull();
    expect(await s.serve(two)).not.toBeNull();
  });
});

describe('ImageService.registerFile (Studio thumbnail candidates)', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nf-l6b-img-'));
    await mkdir(join(root, 'worker', 'tmp'), { recursive: true });
    await writeFile(join(root, 'worker', 'tmp', 'thumb-1.jpg'), JPEG);
    await writeFile(join(root, 'worker', 'tmp', 'notes.txt'), 'ssh-ed25519 AAAA secret');
    await writeFile(join(root, 'outside.jpg'), JPEG);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serves a sniffed image under the worker storage; refuses paths outside it', async () => {
    const s = service(fakeTransport({}), join(root, 'worker'));
    const url = s.registerFile(join(root, 'worker', 'tmp', 'thumb-1.jpg'));
    expect(await s.serve(url.slice(15))).toEqual({ bytes: JPEG, type: 'image/jpeg' });
    // A non-image under the root is never served as an image.
    const txt = s.registerFile(join(root, 'worker', 'tmp', 'notes.txt'));
    expect(await s.serve(txt.slice(15))).toBeNull();
    for (const p of [
      join(root, 'outside.jpg'),
      join(root, 'worker', '..', 'outside.jpg'),
      'relative/thumb.jpg',
      join(root, 'worker'),
    ])
      expect(() => s.registerFile(p), p).toThrow(/forbidden/);
  });
});

describe('sniffImage', () => {
  it('knows exactly JPEG, PNG and WebP', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull(); // GIF
  });
});
