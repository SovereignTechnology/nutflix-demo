/**
 * `fetchRawHttp` — the raw HTTP behind `CashuMintConnections`' default since issue #8 fix round 3
 * (Node's real `fetch`, undici, against a local server): exact bytes both ways, no redirects, a
 * size cap, one timer for the whole exchange, the caller's abort, http(s) only, no cookies, cache
 * or referrer. Under `cashuRequestFn` it is single-attempt: a request whose connection drops is
 * sent ONCE, even when cashu-ts passes the mint's NUT-19 ttl and cached endpoints (its own fetch
 * transport, the default before, would retry).
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpResponseError, NetworkError } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchRawHttp, type FetchFn } from '../fetch-http.js';
import { cashuRequestFn } from '../transport.js';

const raw = fetchRawHttp();
const base = { headers: {}, timeoutMs: 5000, maxBytes: 1024 };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

async function server(handle: http.RequestListener): Promise<string> {
  const srv = http.createServer(handle);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => {
          r();
        });
      }),
  );
  return `http://127.0.0.1:${String((srv.address() as AddressInfo).port)}`;
}

describe('fetchRawHttp over the real fetch', () => {
  it('sends the exact bytes; status, lower-case headers and the body (a BOM kept) come back', async () => {
    const url = await server((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.setHeader('X-Echo', req.method ?? '');
        res.statusCode = 201;
        res.end(
          `\uFEFF${JSON.stringify({
            hex: body.toString('hex'),
            type: req.headers['content-type'] ?? null,
            cookie: req.headers.cookie ?? null,
            referer: req.headers.referer ?? null,
          })}`,
        );
      });
    });
    const body = '{"é":"✓"}';
    const r = await raw({
      ...base,
      url: `${url}/v1/swap`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(r.status).toBe(201);
    expect(r.headers['x-echo']).toBe('POST');
    expect(r.body.startsWith('\uFEFF')).toBe(true);
    expect(JSON.parse(r.body.slice(1))).toEqual({
      hex: Buffer.from(body, 'utf8').toString('hex'),
      type: 'application/json',
      cookie: null,
      referer: null,
    });
    const g = await raw({ ...base, url: `${url}/v1/info`, method: 'GET' });
    expect(JSON.parse(g.body.slice(1))).toMatchObject({ hex: '', type: null });
  });

  it('never follows a redirect, refuses an oversize body (streamed or declared), times out a stalled answer, refuses other schemes and a closed port', async () => {
    const hits: string[] = [];
    const url = await server((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.statusCode = 307;
        res.setHeader('Location', '/elsewhere');
        res.end();
      } else if (req.url === '/big') {
        res.write('x'.repeat(800));
        res.end('x'.repeat(800)); // chunked: no Content-Length, refused while reading
      } else if (req.url === '/declared') {
        res.setHeader('Content-Length', '4096');
        res.write('x'.repeat(16)); // the rest never comes; refused on the header alone
      } else if (req.url === '/stall')
        res.write('{'); // never ends
      else res.end('{}');
    });
    const redirect = await raw({ ...base, url: `${url}/redirect`, method: 'POST', body: '{}' });
    expect(redirect.status).toBe(307);
    expect(hits).not.toContain('/elsewhere');
    await expect(
      cashuRequestFn(raw)({ endpoint: `${url}/redirect`, method: 'POST', requestBody: {} }),
    ).rejects.toBeInstanceOf(HttpResponseError);
    await expect(raw({ ...base, url: `${url}/big`, method: 'GET' })).rejects.toThrow(
      /larger than 1024 bytes/,
    );
    await expect(raw({ ...base, url: `${url}/declared`, method: 'GET' })).rejects.toThrow(
      /larger than 1024 bytes/,
    );
    const t0 = Date.now();
    await expect(
      raw({ ...base, url: `${url}/stall`, method: 'GET', timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200 ms/); // the body stalled: one timer to the last byte
    expect(Date.now() - t0).toBeLessThan(2000);
    const ctl = new AbortController();
    const aborted = raw({ ...base, url: `${url}/stall`, method: 'GET', signal: ctl.signal });
    ctl.abort();
    await expect(aborted).rejects.toThrow();
    await expect(raw({ ...base, url: 'data:text/plain,{}', method: 'GET' })).rejects.toThrow(
      /http\(s\)/,
    );
    await expect(raw({ ...base, url: 'not a url', method: 'GET' })).rejects.toThrow(/not a URL/);
    await expect(raw({ ...base, url: 'http://127.0.0.1:1/', method: 'GET' })).rejects.toThrow();
  });

  it('asks fetch for no redirects, no cookies, no cache and no referrer; an injected fetch is used, and a bad scheme never reaches it', async () => {
    const inits: RequestInit[] = [];
    const spy: FetchFn = (_url, init) => {
      inits.push(init);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const r = await fetchRawHttp(spy)({
      ...base,
      url: 'https://mint.example/v1/info',
      method: 'GET',
    });
    expect(r.body).toBe('{}');
    expect(inits[0]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrer: '',
      referrerPolicy: 'no-referrer',
    });
    await expect(
      fetchRawHttp(spy)({ ...base, url: 'file:///etc/passwd', method: 'GET' }),
    ).rejects.toThrow(/http\(s\)/);
    expect(inits).toHaveLength(1);
  });

  it('under cashuRequestFn: a dropped connection is a NetworkError after ONE request, NUT-19 ttl and cached endpoints notwithstanding', async () => {
    let posts = 0;
    const url = await server((req) => {
      posts++;
      req.socket.destroy(); // the mint may have run it; the answer never arrives
    });
    const err = await cashuRequestFn(raw)({
      endpoint: `${url}/v1/swap`,
      method: 'POST',
      requestBody: { inputs: [], outputs: [] },
      ttl: 60_000,
      cached_endpoints: [{ method: 'POST', path: '/v1/swap' }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    await new Promise((r) => setTimeout(r, 300)); // a retry would have arrived by now
    expect(posts).toBe(1);
  });
});
