/**
 * The daemon's mint transport: `node:http(s)` under `@sovit/core`'s `cashuRequestFn`, never the
 * global `fetch`. On Node 22 `fetch` is undici, whose HTTP parser is WebAssembly, and the unit runs
 * Node `--jitless` (no WebAssembly): the first mint request through `fetch` crashes the process
 * (verified on Node 22.22.0). `node:http` uses Node's native parser.
 *
 * Loaded through `createRequire`, like the gateway's `node:http` (security review F16): an ESM
 * import builds the builtin's facade by reading every export, lazy getters included.
 *
 * Bounded: one timer for the whole exchange (connect to last byte), a response size cap, no
 * redirects (a 3xx comes back as a status for `cashuRequestFn` to refuse).
 */
import { createRequire } from 'node:module';
import type * as NodeHttp from 'node:http';
import type * as NodeHttps from 'node:https';

import { wallet as walletMod } from '@sovit/core';

const load = createRequire(import.meta.url);
const http = load('node:http') as typeof NodeHttp;
const https = load('node:https') as typeof NodeHttps;

function flatten(h: NodeHttp.IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h))
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

export const nodeRawHttp: walletMod.RawHttp = (r) =>
  new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      reject(new Error('not a URL'));
      return;
    }
    const mod = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
    if (mod === null) {
      reject(new Error('a mint URL must be http(s)'));
      return;
    }
    let settled = false;
    // Settle FIRST, then tear the socket down without an error argument: once the response has
    // started, `destroy(err)` does not reach these handlers (the error is unhandled and `end`
    // still fires, with a truncated body).
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
          ...(r.body === undefined ? {} : { 'Content-Length': String(Buffer.byteLength(r.body)) }),
        },
        ...(r.signal ? { signal: r.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
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
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', fail);
      },
    );
    const timer = setTimeout(() => {
      fail(new Error(`timed out after ${String(r.timeoutMs)} ms`));
    }, r.timeoutMs);
    req.on('error', fail);
    if (r.body !== undefined) req.write(r.body);
    req.end();
  });

/** The cashu-ts request function every mint of the daemon's wallet uses. */
export function nodeMintRequest(): ReturnType<typeof walletMod.cashuRequestFn> {
  return walletMod.cashuRequestFn(nodeRawHttp);
}
