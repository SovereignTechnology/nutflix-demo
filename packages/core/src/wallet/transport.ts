/**
 * A cashu-ts `RequestFn` over an injected raw HTTP call — for hosts where the global `fetch` must
 * not be used. On Node 22 `fetch` is undici, whose HTTP parser is WebAssembly; under `--jitless`
 * (the daemons' systemd units, deploy/systemd/MDWE-RESULTS.md) WebAssembly does not exist and the
 * first mint request CRASHES the process. A Node daemon passes a `node:https` call instead
 * (`@sovit/seeder` `runtime/mint-http.ts`), which uses Node's native parser.
 *
 * This keeps cashu-ts's `RequestFn` error contract, which the wallet depends on — `spend.ts` tells
 * a double-spend by the mint's NUT error code:
 *
 *   400 with a JSON `{ code: number, detail: string }`  → `MintOperationError(code, detail)`
 *   429                                                → `RateLimitError`
 *   any other non-2xx                                  → `HttpResponseError(error | detail, status)`
 *   2xx                                                → the body, parsed by cashu-ts's `JSONInt`
 *   no answer (refused, reset, timeout, oversize)      → `NetworkError`
 *
 * Redirects are never followed (a 3xx is an `HttpResponseError`): a mint URL is exact, and
 * following one would let a mint point this node at any other host.
 *
 * Timeouts, when cashu-ts passes no `requestTimeout` (it passes none for any NUT-03/04/05 call):
 * 30 s for the whole exchange, connect to last byte — except `POST …/v1/melt/{method}` (NUT-05),
 * where the mint PAYS the invoice before it answers: a Lightning payment can take a minute or more
 * (Nutshell's LND backends allow 60 s), so that request gets 300 s, what undici's header and body
 * timeouts gave cashu-ts's fetch transport (issue #8 fix round 3). Cut off early, a melt that is
 * about to succeed reads as unknown and holds its inputs until the settle loop decides it — or,
 * with no change blanks, tells the user it failed for an invoice that then gets paid. Quotes
 * (`…/v1/melt/quote/…`), swaps and mints keep 30 s.
 *
 * Portable: no `node:` import. Nothing here logs.
 */
import {
  HttpResponseError,
  JSONInt,
  MintOperationError,
  NetworkError,
  RateLimitError,
} from '@cashu/cashu-ts';
import type { RequestFn } from '@cashu/cashu-ts';

export interface RawHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  /** A response body longer than this is refused (the call rejects). */
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface RawHttpResponse {
  readonly status: number;
  /** Lower-case header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

/** Rejects when no complete response arrived (network error, timeout, abort, oversize). */
export type RawHttp = (req: RawHttpRequest) => Promise<RawHttpResponse>;

export interface CashuRequestOptions {
  /** Default per-request timeout when cashu-ts gives none. Default 30 s. */
  readonly timeoutMs?: number;
  /**
   * The timeout of a melt (`POST …/v1/melt/{method}`, the mint pays before it answers) when
   * cashu-ts gives none. Default 300 s.
   */
  readonly meltTimeoutMs?: number;
  /** Largest response body accepted. Default 4 MiB (a mint's keysets are tens of KiB). */
  readonly maxBytes?: number;
}

/** `Retry-After` (seconds or an HTTP date) in ms; `undefined` when absent or unparseable. */
function retryAfterMs(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * `POST …/v1/melt/{method}` (NUT-05 `bolt11`, NUT-25 `bolt12`, …): the request on which the mint
 * pays the invoice before it answers. A melt quote (`…/v1/melt/quote/{method}[/{id}]`) has more
 * path segments and does not match. The mint URL may carry a path prefix, so only the tail of the
 * path is matched.
 */
function isMeltPayment(endpoint: string, method: string): boolean {
  if (method !== 'POST') return false;
  try {
    return /\/v1\/melt\/[^/]+$/.test(new URL(endpoint).pathname);
  } catch {
    return false;
  }
}

function parseErrorBody(body: string): Record<string, unknown> {
  if (body === '') return { detail: 'bad response' };
  try {
    const v = JSONInt.parse(body);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { detail: body };
  } catch {
    return { detail: body };
  }
}

export function cashuRequestFn(http: RawHttp, o: CashuRequestOptions = {}): RequestFn {
  const defaultTimeout = o.timeoutMs ?? 30_000;
  const meltTimeout = o.meltTimeoutMs ?? 300_000;
  const maxBytes = o.maxBytes ?? 4 * 1024 * 1024;
  const request = async (args: Parameters<RequestFn>[0]): Promise<unknown> => {
    const body = args.requestBody === undefined ? undefined : JSONInt.stringify(args.requestBody);
    const method = (args.method ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
    if (method !== 'GET' && method !== 'POST')
      throw new NetworkError(`unsupported method ${method}`);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...args.headers,
    };
    let res: RawHttpResponse;
    try {
      res = await http({
        url: args.endpoint,
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        timeoutMs:
          args.requestTimeout ??
          (isMeltPayment(args.endpoint, method) ? meltTimeout : defaultTimeout),
        maxBytes,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    } catch (e) {
      throw new NetworkError(e instanceof Error ? e.message : 'network request failed', {
        cause: e,
      });
    }
    const retry = retryAfterMs(res.headers['retry-after']);
    if (args.onResponseMeta) {
      try {
        args.onResponseMeta({
          endpoint: args.endpoint,
          status: res.status,
          ...(retry === undefined ? {} : { retryAfterMs: retry }),
          ...(res.headers['ratelimit'] === undefined
            ? {}
            : { rateLimit: res.headers['ratelimit'] }),
          ...(res.headers['ratelimit-policy'] === undefined
            ? {}
            : { rateLimitPolicy: res.headers['ratelimit-policy'] }),
          headers: {
            get: (name: string) => res.headers[name.toLowerCase()] ?? null,
          } as unknown as Headers,
        });
      } catch {
        // a metadata observer never fails the request
      }
    }
    if (res.status < 200 || res.status > 299) {
      const t = parseErrorBody(res.body);
      if (res.status === 429) throw new RateLimitError('429 Too Many Requests', retry);
      if (res.status === 400 && typeof t['code'] === 'number' && typeof t['detail'] === 'string')
        throw new MintOperationError(t['code'], t['detail']);
      const message =
        typeof t['error'] === 'string'
          ? t['error']
          : typeof t['detail'] === 'string'
            ? t['detail']
            : 'HTTP request failed';
      throw new HttpResponseError(message, res.status);
    }
    if (res.body === '') throw new HttpResponseError('bad response', res.status);
    try {
      return JSONInt.parse(res.body);
    } catch (e) {
      throw new HttpResponseError('bad response', res.status, { cause: e });
    }
  };
  return request as RequestFn;
}
