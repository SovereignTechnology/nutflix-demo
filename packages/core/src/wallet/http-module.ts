/**
 * A `RawHttp` (`transport.ts`) over a Node-style `http` / `https` module pair that the caller
 * hands in — the one implementation behind every Node mint transport: the seeder daemon and the
 * gateway (`@sovit/seeder` `runtime/mint-http.ts`) and the desktop host's money plane
 * (`app-desktop` `host/mint-transport.ts`). It moved here from the seeder in issue #8 fix round 2,
 * so the desktop host reuses it without loading the seeder's whole Node entry (and its native
 * modules) into the process that spends.
 *
 * Under `cashuRequestFn` it is a SINGLE-ATTEMPT transport: one request, one answer or one error,
 * never a retry. The wallet depends on that (`spend.ts` `isDefinitive`: a coded answer is the
 * mint's answer to our one request). cashu-ts's own fetch transport retries NUT-19 cached
 * endpoints after a network error or a 5xx; a retry's answer says nothing about the first attempt.
 *
 * Bounded: one timer for the whole exchange (connect to last byte), a response size cap, no
 * redirects (a 3xx comes back as a status for `cashuRequestFn` to refuse), http(s) URLs only.
 *
 * Portable: no `node:` import (the caller loads the modules; nothing runs at import). Nothing here
 * logs.
 */
import type { RawHttp } from './transport.js';

/** What this needs of `http.IncomingMessage`. */
export interface HttpModuleResponse {
  readonly statusCode?: number | undefined;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** What this needs of `http.ClientRequest`. */
export interface HttpModuleRequest {
  on(event: 'error', listener: (err: Error) => void): unknown;
  write(chunk: Uint8Array): unknown;
  end(): unknown;
  destroy(): unknown;
}

/** What this needs of `node:http` / `node:https`: `request(url, options, callback)`. */
export interface HttpModule {
  request(
    url: URL,
    options: {
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly signal?: AbortSignal;
    },
    callback: (res: HttpModuleResponse) => void,
  ): HttpModuleRequest;
}

export interface HttpModules {
  readonly http: HttpModule;
  readonly https: HttpModule;
}

function flatten(h: HttpModuleResponse['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h))
    out[k.toLowerCase()] = typeof v === 'string' || v === undefined ? v : v.join(', ');
  return out;
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** `RawHttp` over `mods` (`node:http` for `http:` URLs, `node:https` for `https:`). */
export function httpModuleRawHttp(mods: HttpModules): RawHttp {
  return (r) =>
    new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(r.url);
      } catch {
        reject(new Error('not a URL'));
        return;
      }
      const mod =
        url.protocol === 'https:' ? mods.https : url.protocol === 'http:' ? mods.http : null;
      if (mod === null) {
        reject(new Error('a mint URL must be http(s)'));
        return;
      }
      // The exact bytes sent, and their count as Content-Length.
      const body = r.body === undefined ? undefined : new TextEncoder().encode(r.body);
      let settled = false;
      // Settle FIRST, then tear the socket down without an error argument: once the response has
      // started, `destroy(err)` does not reach these handlers (the error is unhandled and `end`
      // still fires, with a truncated body). Only ever called back, after `req` and `timer` exist
      // (a `request` that throws rejects the promise from this executor).
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
        req.destroy();
      };
      const req = mod.request(
        url,
        {
          method: r.method,
          headers: {
            ...r.headers,
            ...(body === undefined ? {} : { 'Content-Length': String(body.length) }),
          },
          ...(r.signal ? { signal: r.signal } : {}),
        },
        (res) => {
          const chunks: Uint8Array[] = [];
          let size = 0;
          res.on('data', (c: Uint8Array) => {
            if (settled) return;
            size += c.length;
            if (size > r.maxBytes) {
              fail(new Error(`the response is larger than ${String(r.maxBytes)} bytes`));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
              status: res.statusCode ?? 0,
              headers: flatten(res.headers),
              // A byte-order mark is kept, as `Buffer#toString` did (the answer is exact).
              body: new TextDecoder('utf-8', { ignoreBOM: true }).decode(concat(chunks, size)),
            });
          });
          res.on('error', fail);
        },
      );
      const timer = setTimeout(() => {
        fail(new Error(`timed out after ${String(r.timeoutMs)} ms`));
      }, r.timeoutMs);
      req.on('error', fail);
      if (body !== undefined) req.write(body);
      req.end();
    });
}
