/**
 * `nf-media:` (design §1 "PlaySession across processes", §3): the play proxy forwards ONE
 * range to the host-registered loopback link through the injected `net.fetch` and streams the
 * 206 back with a fixed type; image ids are answered from the host. Fakes only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostIn } from '../../ipc/protocol.js';
import {
  ImageRequests,
  MAX_MEDIA_LINKS,
  MediaLinks,
  createMediaProtocolHandler,
  parseMediaUrl,
  type MediaFetch,
} from '../media.js';

const TOKEN = 'tok0123456789abcdef';
const LINK = 'http://127.0.0.1:47000/aabbcc?token=worker';

interface FetchCall {
  url: string;
  init: Parameters<MediaFetch>[1];
}

function setup(respond: (c: FetchCall) => Response | Promise<Response>): {
  handle: (req: Request) => Promise<Response>;
  calls: FetchCall[];
  links: MediaLinks;
  posted: HostIn[];
  images: ImageRequests;
} {
  const calls: FetchCall[] = [];
  const links = new MediaLinks();
  links.set(TOKEN, LINK);
  const posted: HostIn[] = [];
  const images = new ImageRequests((m) => {
    posted.push(m);
    return true;
  }, 1000);
  const handle = createMediaProtocolHandler({
    links,
    images,
    fetch: (url, init) => {
      const c = { url, init };
      calls.push(c);
      return Promise.resolve(respond(c));
    },
  });
  return { handle, calls, links, posted, images };
}

const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_x, i) => i % 256);

afterEach(() => {
  vi.useRealTimers();
});

describe('MediaLinks', () => {
  it('accepts only loopback http links and well-formed tokens', () => {
    const l = new MediaLinks();
    expect(l.set('tok0123456789abcdef', 'http://127.0.0.1:1/x')).toBe(true);
    for (const bad of [
      'https://127.0.0.1:1/x',
      'http://localhost:1/x',
      'http://127.0.0.2:1/x',
      'http://127.0.0.1/x',
      'http://127.0.0.1:0/x',
      'http://127.0.0.1:1@evil/x',
      'file:///etc/passwd',
    ]) {
      expect(l.set('tok0123456789abcdef', bad)).toBe(false);
    }
    expect(l.set('bad token!', 'http://127.0.0.1:1/x')).toBe(false);
    expect(l.set('tok0123456789abcdef', null)).toBe(true);
    expect(l.size).toBe(0);
  });

  it(`holds at most ${String(MAX_MEDIA_LINKS)} links`, () => {
    const l = new MediaLinks();
    for (let i = 0; i < MAX_MEDIA_LINKS; i++)
      l.set(`token-${String(i).padStart(12, '0')}`, 'http://127.0.0.1:1/x');
    expect(l.set('one-too-many-token', 'http://127.0.0.1:1/x')).toBe(false);
    expect(l.size).toBe(MAX_MEDIA_LINKS);
  });
});

describe('nf-media://play/<token> proxy', () => {
  it('forwards exactly the Range header to the registered link and streams the 206 back', async () => {
    const s = setup(
      () =>
        new Response(bytes(100), {
          status: 206,
          headers: {
            'content-type': 'text/html',
            'content-range': 'bytes 100-199/5000',
            'content-length': '100',
            'set-cookie': 'a=b',
            'access-control-allow-origin': '*',
          },
        }),
    );
    const res = await s.handle(
      new Request(`nf-media://play/${TOKEN}`, {
        headers: { range: 'bytes=100-199', cookie: 'x=y', authorization: 'Bearer z' },
      }),
    );
    expect(s.calls).toEqual([
      {
        url: LINK,
        init: { method: 'GET', headers: { range: 'bytes=100-199' }, redirect: 'error' },
      },
    ]);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(100));
  });

  it('a request without Range is forwarded without one (200)', async () => {
    const s = setup(
      () => new Response(bytes(10), { status: 200, headers: { 'content-length': '10' } }),
    );
    const res = await s.handle(new Request(`nf-media://play/${TOKEN}`));
    expect(s.calls[0]?.init.headers).toEqual({});
    expect(res.status).toBe(200);
  });

  it.each(['bytes=0-10,20-30', 'bytes=abc', 'items=0-1', 'bytes=0-1; x'])(
    'refuses Range %s with 416 (never widened to the whole rendition)',
    async (range) => {
      const s = setup(() => new Response(null, { status: 200 }));
      const res = await s.handle(new Request(`nf-media://play/${TOKEN}`, { headers: { range } }));
      expect(res.status).toBe(416);
      expect(s.calls).toHaveLength(0);
    },
  );

  it('passes a 416 from the worker through with its content-range', async () => {
    const s = setup(
      () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */5000' } }),
    );
    const res = await s.handle(
      new Request(`nf-media://play/${TOKEN}`, { headers: { range: 'bytes=9000-' } }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */5000');
  });

  it('unknown or revoked token → 404 without dialling anything', async () => {
    const s = setup(() => new Response(null));
    expect((await s.handle(new Request('nf-media://play/unknown-token-000'))).status).toBe(404);
    s.links.set(TOKEN, null);
    expect((await s.handle(new Request(`nf-media://play/${TOKEN}`))).status).toBe(404);
    expect(s.calls).toHaveLength(0);
  });

  it('a closed session (worker 404) is 404; any other upstream status is 502', async () => {
    let status = 404;
    const s = setup(() => new Response(null, { status }));
    expect((await s.handle(new Request(`nf-media://play/${TOKEN}`))).status).toBe(404);
    for (status of [301, 403, 500]) {
      expect((await s.handle(new Request(`nf-media://play/${TOKEN}`))).status).toBe(502);
    }
  });

  it('a fetch failure (redirect refused, connection reset) is 502, never a throw', async () => {
    const s = setup(() => Promise.reject(new TypeError('redirect mode is set to error')));
    expect((await s.handle(new Request(`nf-media://play/${TOKEN}`))).status).toBe(502);
  });

  it('HEAD is forwarded as HEAD with no body; other methods are 405', async () => {
    const s = setup(
      () => new Response(null, { status: 200, headers: { 'content-length': '5000' } }),
    );
    const head = await s.handle(new Request(`nf-media://play/${TOKEN}`, { method: 'HEAD' }));
    expect(s.calls[0]?.init.method).toBe('HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('5000');
    const post = await s.handle(
      new Request(`nf-media://play/${TOKEN}`, { method: 'POST', body: 'x' }),
    );
    expect(post.status).toBe(405);
  });

  it('malformed upstream content-range / content-length are not copied', async () => {
    const s = setup(
      () =>
        new Response(bytes(1), {
          status: 206,
          headers: { 'content-range': 'bytes 0-0/5000, 1-1/5000', 'content-length': '-1' },
        }),
    );
    const res = await s.handle(
      new Request(`nf-media://play/${TOKEN}`, { headers: { range: 'bytes=0-0' } }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
  });
});

describe('nf-media://img/<id>', () => {
  it('asks the host and answers its bytes with the host-checked type', async () => {
    const s = setup(() => new Response(null));
    const p = s.handle(new Request('nf-media://img/thumb1'));
    await Promise.resolve();
    expect(s.posted).toEqual([{ kind: 'image', req: 1, id: 'thumb1' }]);
    s.images.resolve(1, bytes(4), 'image/png');
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(4));
    expect(s.calls).toHaveLength(0);
  });

  it('null bytes, a non-image type, host down or a timeout → 404', async () => {
    vi.useFakeTimers();
    const s = setup(() => new Response(null));
    const a = s.handle(new Request('nf-media://img/a'));
    const b = s.handle(new Request('nf-media://img/b'));
    const c = s.handle(new Request('nf-media://img/c'));
    const d = s.handle(new Request('nf-media://img/d'));
    await Promise.resolve();
    s.images.resolve(1, null, null);
    s.images.resolve(2, bytes(3), 'text/html' as never);
    s.images.failAll();
    expect((await a).status).toBe(404);
    expect((await b).status).toBe(404);
    expect((await c).status).toBe(404);
    expect((await d).status).toBe(404);
    const e = s.handle(new Request('nf-media://img/e'));
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    expect((await e).status).toBe(404);
    expect(s.images.size).toBe(0);
  });

  it('a host that cannot be posted to answers 404 at once', async () => {
    const images = new ImageRequests(() => false, 1000);
    expect(await images.request('x')).toBeNull();
    expect(images.size).toBe(0);
  });
});

describe('parseMediaUrl', () => {
  it.each([
    'nf-media://play/',
    'nf-media://play/a/b',
    'nf-media://play/../x',
    'nf-media://video/abc',
    'nf-media://img/a?b',
    'nf-media://img/a%2f',
    'app://nutflix/index.html',
  ])('refuses %s', (url) => {
    expect(parseMediaUrl(url)).toBeNull();
  });

  it('parses play and img', () => {
    expect(parseMediaUrl('nf-media://play/abc_DEF-1')).toEqual({ kind: 'play', id: 'abc_DEF-1' });
    expect(parseMediaUrl('nf-media://img/x')).toEqual({ kind: 'img', id: 'x' });
  });
});
