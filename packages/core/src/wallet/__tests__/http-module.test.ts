/**
 * `httpModuleRawHttp` — the raw HTTP every Node mint transport uses (the daemons' and, since
 * issue #8 fix round 2, the desktop money plane's), over the real `node:http` against a local
 * server: exact bytes both ways, no redirects, a size cap, one timer, http(s) only. Under
 * `cashuRequestFn` it is single-attempt: a request whose connection drops is sent ONCE, even when
 * cashu-ts passes the mint's NUT-19 ttl and cached endpoints (its own fetch transport would retry).
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';

import { NetworkError } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'vitest';

import { httpModuleRawHttp } from '../http-module.js';
import { cashuRequestFn } from '../transport.js';

const raw = httpModuleRawHttp({ http, https });
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

describe('httpModuleRawHttp over node:http', () => {
  it('sends the exact bytes with their Content-Length; status, lower-case headers and the body (a BOM kept) come back', async () => {
    const url = await server((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.setHeader('X-Echo', req.method ?? '');
        res.setHeader('Set-Cookie', ['a=1', 'b=2']);
        res.statusCode = 201;
        res.end(
          `\uFEFF${JSON.stringify({ hex: body.toString('hex'), len: req.headers['content-length'] ?? null })}`,
        );
      });
    });
    const body = '{"é":"✓"}';
    const r = await raw({ ...base, url: `${url}/v1/swap`, method: 'POST', body });
    expect(r.status).toBe(201);
    expect(r.headers['x-echo']).toBe('POST');
    expect(r.headers['set-cookie']).toBe('a=1, b=2');
    expect(r.body.startsWith('\uFEFF')).toBe(true);
    expect(JSON.parse(r.body.slice(1))).toEqual({
      hex: Buffer.from(body, 'utf8').toString('hex'),
      len: String(Buffer.byteLength(body)),
    });
    const g = await raw({ ...base, url: `${url}/v1/info`, method: 'GET' });
    expect(JSON.parse(g.body.slice(1))).toEqual({ hex: '', len: null });
  });

  it('never follows a redirect, refuses an oversize body, times out a stalled answer, refuses other schemes and a closed port', async () => {
    const url = await server((req, res) => {
      if (req.url === '/redirect') {
        res.statusCode = 307;
        res.setHeader('Location', 'http://169.254.169.254/latest');
        res.end();
      } else if (req.url === '/big') res.end('x'.repeat(4096));
      else if (req.url === '/stall') res.write('{'); // never ends
    });
    expect(
      (await raw({ ...base, url: `${url}/redirect`, method: 'POST', body: '{}' })).status,
    ).toBe(307);
    await expect(raw({ ...base, url: `${url}/big`, method: 'GET' })).rejects.toThrow(
      /larger than 1024 bytes/,
    );
    await expect(
      raw({ ...base, url: `${url}/stall`, method: 'GET', timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 200 ms/);
    await expect(raw({ ...base, url: 'data:text/plain,{}', method: 'GET' })).rejects.toThrow(
      /http\(s\)/,
    );
    await expect(raw({ ...base, url: 'not a url', method: 'GET' })).rejects.toThrow(/not a URL/);
    await expect(raw({ ...base, url: 'http://127.0.0.1:1/', method: 'GET' })).rejects.toThrow();
  });

  it('under cashuRequestFn: a dropped connection is a NetworkError after ONE request, NUT-19 ttl and cached endpoints notwithstanding', async () => {
    let posts = 0;
    const url = await server((req) => {
      posts++;
      req.socket.destroy(); // the mint may have run it; the answer never arrives
    });
    const request = cashuRequestFn(raw);
    const err = await request({
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
