/**
 * A `RawHttp` (`transport.ts`) over the platform's `fetch` — what `CashuMintConnections` sends
 * through for a mint it is given no request function for (issue #8 fix round 3). It works in Node
 * and in browsers. Under `cashuRequestFn` it is SINGLE-ATTEMPT, like `httpModuleRawHttp`: one
 * request, one answer or one error, never a retry. The wallet depends on that (`spend.ts`
 * `isDefinitive`: a coded answer is the mint's answer to our one request). cashu-ts's own fetch
 * transport, the default before, retries swaps, melts and mints at a NUT-19 mint, and a coded
 * answer to a retry dropped the journal entry of a request that had executed.
 *
 * Not for the Node daemons: on Node 22 `fetch` is undici, whose HTTP parser is WebAssembly, and
 * under `--jitless` the first request crashes the process (`transport.ts`). They, and the desktop
 * host, pass `httpModuleRawHttp`.
 *
 * Bounded like `httpModuleRawHttp`:
 *
 *   one timer   for the whole exchange, connect to last byte (`timeoutMs`);
 *   size        the body is read incrementally and refused past `maxBytes` (a larger
 *               `Content-Length` is refused before reading);
 *   redirects   never followed (`redirect: 'manual'`): Node's fetch hands back the 3xx, a browser
 *               an opaque redirect with status 0 — either is an `HttpResponseError` under
 *               `cashuRequestFn`, so a mint cannot point the wallet at another host;
 *   schemes     http(s) only, checked before anything is sent;
 *   privacy     no cookies, cache or referrer. `fetch` may add its own `User-Agent`.
 *
 * Portable: no `node:` import. `fetch` is looked up when a request is made, unless one is injected.
 * Nothing here logs.
 */
import type { RawHttp } from './transport.js';

/** What this needs of `fetch`. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The body as text, refused past `maxBytes`; a byte-order mark is kept (the answer is exact). */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const tooLarge = (): Error => new Error(`the response is larger than ${String(maxBytes)} bytes`);
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body !== null) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) {
        reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(next.value);
    }
  }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(concat(chunks, size));
}

/** `RawHttp` over `fetchFn` (default: the global `fetch`, looked up per request). */
export function fetchRawHttp(fetchFn?: FetchFn): RawHttp {
  return async (r) => {
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      throw new Error('not a URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('a mint URL must be http(s)');
    const send: FetchFn = fetchFn ?? ((u, init) => globalThis.fetch(u, init));
    const ctl = new AbortController();
    const st = { timedOut: false };
    const timer = setTimeout(() => {
      st.timedOut = true;
      ctl.abort();
    }, r.timeoutMs);
    const onAbort = (): void => {
      ctl.abort();
    };
    r.signal?.addEventListener('abort', onAbort, { once: true });
    if (r.signal?.aborted === true) ctl.abort();
    try {
      const res = await send(url.href, {
        method: r.method,
        headers: r.headers,
        ...(r.body === undefined ? {} : { body: r.body }),
        redirect: 'manual',
        cache: 'no-store',
        credentials: 'omit',
        referrer: '',
        referrerPolicy: 'no-referrer',
        signal: ctl.signal,
      });
      const body = await readCapped(res, r.maxBytes);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: res.status, headers, body };
    } catch (e) {
      ctl.abort(); // an oversize body or a failed read: the connection is torn down
      if (st.timedOut) throw new Error(`timed out after ${String(r.timeoutMs)} ms`, { cause: e });
      throw e;
    } finally {
      clearTimeout(timer);
      r.signal?.removeEventListener('abort', onAbort);
    }
  };
}
